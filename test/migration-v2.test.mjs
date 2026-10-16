import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../server/db.mjs";

test("v1 migration preserves duplicate receipts, old reversals, anchor and rollback snapshot; repeat startup is safe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nwl-migration-")),
    path = join(dir, "v1.sqlite");
  let s;
  let db = new DatabaseSync(path);
  try {
    db.exec(
      await readFile(new URL("../server/schema.sql", import.meta.url), "utf8"),
    );
    db.prepare("INSERT INTO settings VALUES(1,?)").run(
      JSON.stringify({
        company: "Legacy business",
        invoicePrefix: "INV",
        quotePrefix: "QT",
      }),
    );
    db.prepare(
      "INSERT INTO clients(id,name,email,created) VALUES(?,?,?,?)",
    ).run("c", "Legacy client", "", "2026-01-01");
    db.prepare("INSERT INTO services(id,name,rate) VALUES(?,?,?)").run(
      "svc",
      "Service",
      10000,
    );
    const doc = db.prepare(
      "INSERT INTO documents(id,kind,number,client_id,state,issue_date,due_date,items,subtotal,total,created,updated) VALUES(?,'invoice',?,'c','issued','2026-01-01','2026-02-01','[]',10000,10000,'2026-01-01','2026-01-01')",
    );
    for (let i = 1; i <= 3; i++) doc.run("d" + i, "INV-2026-000" + i);
    const pay = db.prepare(
      "INSERT INTO payments(id,invoice_id,amount,paid_date,method,reference,reversed,created) VALUES(?,?,?,'2026-01-02','Bank transfer',?,?,'2026-01-02')",
    );
    pay.run("p1", "d1", 5000, "BANK SAME", 0);
    pay.run("p2", "d2", 5000, "bank  same", 0);
    pay.run("p3", "d3", 2000, "OLD-REVERSED", 1);
    db.exec(
      "INSERT INTO schedules(id,client_id,service_id,next_date,created) VALUES('sch','c','svc','2026-03-28','2026-01-01');INSERT INTO schedule_runs VALUES('sch','2026-01-31','d1')",
    );
    db.close();
    db = null;
    s = openDatabase(path);
    assert.equal(s.db.prepare("PRAGMA user_version").get().user_version, 5);
    assert.equal(s.receipts().length, 3);
    assert.equal(s.receipts().filter((r) => r.legacy_review).length, 2);
    assert.equal(s.document("d1").paid, 5000);
    assert.equal(s.document("d2").paid, 5000);
    assert.equal(s.document("d3").paid, 0);
    assert.equal(s.receipt("legacy-p3").voided, 1);
    assert.equal(
      s.db.prepare("SELECT anchor_day FROM schedules").get().anchor_day,
      31,
    );
    const snap = (await readdir(dir)).find((f) => f.includes(".pre-v2-"));
    assert.ok(snap);
    assert.equal((await stat(join(dir, snap))).mode & 0o777, 0o600);
    const old = new DatabaseSync(join(dir, snap), { readOnly: true });
    assert.equal(old.prepare("PRAGMA user_version").get().user_version, 0);
    assert.equal(old.prepare("SELECT count(*) n FROM payments").get().n, 3);
    old.close();
    const v3snapshot = (await readdir(dir)).find((f) => f.includes(".pre-v3-"));
    assert.ok(v3snapshot);
    const v2 = new DatabaseSync(join(dir, v3snapshot), { readOnly: true });
    assert.equal(v2.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(v2.prepare("SELECT count(*) n FROM cash_receipts").get().n, 3);
    v2.close();
    assert.throws(
      () => s.allocate("legacy-p1", { invoice_id: "d1", amount: 1 }),
      /Review/,
    );
    s.resolveLegacy("legacy-p1", "Bank evidence confirms separate transfer");
    assert.equal(s.receipt("legacy-p1").legacy_review, 0);
    s.db.close();
    s = null;
    s = openDatabase(path);
    assert.equal(s.receipts().length, 3);
    assert.equal(
      (await readdir(dir)).filter((f) => f.includes(".pre-v2-")).length,
      1,
    );
  } finally {
    db?.close();
    s?.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
