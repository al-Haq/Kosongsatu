import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDatabase } from "../server/db.mjs";
import { requestContext } from "../server/context.mjs";
import { GENESIS, entryHash, verifyAuditChain, chainHead } from "../server/team-audit.mjs";
import { fixture } from "./helpers.mjs";
import { member } from "./team-helpers.mjs";

const run = promisify(execFile);
const cli = new URL("../server/cli.mjs", import.meta.url).pathname;

// Simulates an attacker with direct database access.
const tamper = (db, sql, ...args) => {
  db.exec("DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete;");
  db.prepare(sql).run(...args);
};

test("the migration back-fills a chain over existing audit history and keeps the edit guards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nwl-chain-"));
  const path = join(dir, "old.sqlite");
  try {
    // An older database: core schema with history, before the team module existed.
    const raw = new DatabaseSync(path);
    raw.exec(await readFile(new URL("../server/schema.sql", import.meta.url), "utf8"));
    raw.prepare("INSERT INTO settings VALUES(1,?)").run(JSON.stringify({ company: "Old Co", invoicePrefix: "INV", quotePrefix: "QT" }));
    const ins = raw.prepare("INSERT INTO audit(action,entity_id,detail,created) VALUES(?,?,?,?)");
    for (let i = 1; i <= 5; i++) ins.run("legacy.event", "e" + i, "Detail " + i, `2026-01-0${i}T00:00:00.000Z`);
    raw.close();
    const s = openDatabase(path);
    try {
      const rows = s.db.prepare("SELECT * FROM audit ORDER BY id").all();
      assert.ok(rows.length >= 5);
      assert.equal(rows[0].prev_hash, GENESIS);
      for (let i = 0; i < rows.length; i++) {
        assert.match(rows[i].hash, /^[0-9a-f]{64}$/);
        if (i) assert.equal(rows[i].prev_hash, rows[i - 1].hash);
        assert.equal(rows[i].hash, entryHash(rows[i].prev_hash, rows[i]));
      }
      assert.equal(verifyAuditChain(s.db).ok, true);
      // The guards are back: no edits, no deletes, and a sealed hash is final.
      assert.throws(() => s.db.prepare("UPDATE audit SET detail='x' WHERE id=1").run(), /cannot be edited/);
      assert.throws(() => s.db.prepare("UPDATE audit SET hash=? WHERE id=1").run("0".repeat(64)), /cannot be edited/);
      assert.throws(() => s.db.prepare("DELETE FROM audit WHERE id=1").run(), /cannot be deleted/);
      // New entries continue the chain.
      s.audit("after.migration", "x", "new");
      const last = s.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 1").get();
      assert.equal(last.prev_hash, rows.at(-1).hash);
      assert.equal(verifyAuditChain(s.db).checked, rows.length + 1);
    } finally {
      s.db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new entries are chained inside and outside transactions, with actor and before/after data", () => {
  const s = openDatabase(":memory:");
  try {
    requestContext.run({ actor: "owner:a@example.com" }, () => s.audit("one", "1", "first", { a: 1 }, { a: 2 }));
    s.tx(() => {
      s.audit("two", "2");
      s.audit("three", "3");
    });
    // A failed transaction leaves no half-chained entry behind.
    assert.throws(() =>
      s.tx(() => {
        s.audit("rolled.back", "4");
        throw new Error("boom");
      }),
    );
    const r = verifyAuditChain(s.db);
    assert.equal(r.ok, true);
    assert.equal(r.unsealed, 0);
    const head = chainHead(s.db);
    assert.equal(head.id, r.head.id);
    assert.equal(s.db.prepare("SELECT count(*) n FROM audit WHERE action='rolled.back'").get().n, 0);
    const one = s.db.prepare("SELECT * FROM audit WHERE action='one'").get();
    assert.equal(one.actor, "owner:a@example.com");
    // Raw inserts (like console recovery) are sealed by the next write.
    s.db.prepare("INSERT INTO audit(action,entity_id,detail,created,actor) VALUES('raw',NULL,'',?, 'local-console')").run(new Date().toISOString());
    assert.equal(verifyAuditChain(s.db).unsealed, 1);
    s.audit("next", null);
    assert.deepEqual([verifyAuditChain(s.db).ok, verifyAuditChain(s.db).unsealed], [true, 0]);
  } finally {
    s.db.close();
  }
});

test("verification finds the first changed, removed or reordered entry", () => {
  for (const attack of ["edit", "delete", "insert", "reseal"]) {
    const s = openDatabase(":memory:");
    try {
      for (let i = 1; i <= 6; i++) s.audit("event." + i, String(i), "detail " + i);
      const ids = s.db.prepare("SELECT id FROM audit ORDER BY id").all().map((r) => r.id);
      const target = ids[3];
      const head = chainHead(s.db);
      if (attack === "edit") {
        tamper(s.db, "UPDATE audit SET detail='paid in cash' WHERE id=?", target);
        const r = verifyAuditChain(s.db);
        assert.equal(r.ok, false);
        assert.equal(r.broken.id, target);
        assert.match(r.reason, /content no longer matches/);
      } else if (attack === "delete") {
        tamper(s.db, "DELETE FROM audit WHERE id=?", target);
        const r = verifyAuditChain(s.db);
        assert.equal(r.ok, false);
        assert.equal(r.broken.id, ids[4], "the entry after the gap no longer links");
        assert.match(r.reason, /does not link/);
      } else if (attack === "insert") {
        tamper(s.db, "INSERT INTO audit(id,action,entity_id,detail,created,actor,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?)", ids.at(-1) + 1, "fake", null, "", new Date().toISOString(), "system", GENESIS, "f".repeat(64));
        assert.equal(verifyAuditChain(s.db).broken.id, ids.at(-1) + 1);
      } else {
        // A careful attacker rewrites an entry and recomputes every later hash.
        // The chain then looks valid on its own, but a recorded head exposes it.
        s.db.exec("DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete;");
        s.db.prepare("UPDATE audit SET detail='rewritten' WHERE id=?").run(target);
        let prev = s.db.prepare("SELECT hash FROM audit WHERE id=?").get(ids[2]).hash;
        for (const row of s.db.prepare("SELECT * FROM audit WHERE id>=? ORDER BY id").all(target)) {
          const h = entryHash(prev, row);
          s.db.prepare("UPDATE audit SET prev_hash=?, hash=? WHERE id=?").run(prev, h, row.id);
          prev = h;
        }
        assert.equal(verifyAuditChain(s.db).ok, true, "self-consistent after a full rewrite");
        const r = verifyAuditChain(s.db, { id: head.id, hash: head.hash });
        assert.equal(r.ok, false);
        assert.equal(r.recorded.matches, false);
        assert.match(r.reason, /no longer matches/);
      }
    } finally {
      s.db.close();
    }
  }
  // A recorded head that was cut off the end is reported missing.
  const s = openDatabase(":memory:");
  try {
    s.audit("a", null);
    s.audit("b", null);
    const head = chainHead(s.db);
    tamper(s.db, "DELETE FROM audit WHERE id=?", head.id);
    assert.equal(verifyAuditChain(s.db).ok, true, "truncation alone is invisible");
    assert.match(verifyAuditChain(s.db, head).reason, /missing/);
  } finally {
    s.db.close();
  }
});

test("owner and accountant verify the chain and export its head over HTTP; staff cannot", async () => {
  const f = await fixture();
  try {
    const accountant = await member(f, "accountant");
    const staff = await member(f, "staff");
    const ok = await accountant.json("/api/team/audit/verify");
    assert.equal(ok.ok, true);
    const head = await accountant.json("/api/team/audit/head");
    assert.equal(head.id, ok.head.id);
    assert.match(head.hash, /^[0-9a-f]{64}$/);
    const file = await accountant.auth("/api/team/audit/head?download=1");
    assert.match(file.headers.get("content-disposition"), /attachment; filename="audit-chain-head-\d+\.json"/);
    const checked = await f.json(`/api/team/audit/verify?id=${head.id}&hash=${head.hash}`);
    assert.equal(checked.recorded.matches, true);
    assert.equal((await f.auth("/api/team/audit/verify?id=1&hash=nothex")).status, 400);
    assert.equal((await staff.auth("/api/team/audit/verify")).status, 403);
    // Writes after the head keep the old head valid.
    await f.json("/api/clients", "POST", { name: "After head", email: "a@example.com" });
    assert.equal((await f.json(`/api/team/audit/verify?id=${head.id}&hash=${head.hash}`)).ok, true);
    f.store.db.exec("DROP TRIGGER audit_no_update");
    f.store.db.prepare("UPDATE audit SET actor='someone-else' WHERE id=?").run(head.id - 1);
    const bad = await accountant.json("/api/team/audit/verify");
    assert.equal(bad.ok, false);
    assert.equal(bad.broken.id, head.id - 1);
    // The JSON export carries the chain columns.
    const exp = await accountant.json("/api/backup");
    assert.ok(exp.audit.every((a) => "hash" in a && "prev_hash" in a));
    assert.equal(exp.ext.team.audit_chain_head.id > 0, true);
  } finally {
    await f.close();
  }
});

test("the console command verifies a database read-only and exits non-zero when broken", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nwl-chain-cli-"));
  const path = join(dir, "db.sqlite");
  try {
    const s = openDatabase(path);
    s.audit("cli.one", null);
    s.audit("cli.two", null);
    const head = chainHead(s.db);
    s.db.close();
    const env = { ...process.env, DATABASE_PATH: path };
    const okRun = await run(process.execPath, [cli, "audit-verify", String(head.id), head.hash], { env });
    assert.match(okRun.stdout, /Audit chain OK/);
    assert.match(okRun.stdout, /Recorded head entry \d+ matches/);
    const headRun = await run(process.execPath, [cli, "audit-head"], { env });
    assert.equal(JSON.parse(headRun.stdout).hash, head.hash);
    const db = new DatabaseSync(path);
    tamper(db, "UPDATE audit SET detail='x' WHERE id=?", head.id);
    db.close();
    await assert.rejects(run(process.execPath, [cli, "audit-verify"], { env }), (e) => {
      assert.equal(e.code, 1);
      assert.match(e.stderr, /Audit chain BROKEN/);
      assert.match(e.stderr, new RegExp(`First bad entry: ${head.id}`));
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
