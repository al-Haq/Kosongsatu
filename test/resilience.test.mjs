// Backups say how they went even after a restart, upgrade copies don't pile
// up, and a flood of addresses can't lock everyone out.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { BackupManager } from "../server/recovery.mjs";
import { pruneMigrationCopies } from "../server/migrate.mjs";
import { fixture, password } from "./helpers.mjs";

test("the last backup's result survives a restart, failed or not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nwl-backup-status-"));
  const f = await fixture();
  try {
    const key = randomBytes(32).toString("base64");
    const good = { directory: join(dir, "backups"), key };
    await new BackupManager(f.store, good).run();
    const restarted = new BackupManager(f.store, good).status();
    assert.ok(restarted.lastSuccess, "the time of the last backup is still known");
    assert.equal(restarted.lastError, null);

    // A folder that is really a file: the backup fails, and says so after a restart.
    const blocked = join(dir, "not-a-folder");
    await writeFile(blocked, "x");
    const failing = new BackupManager(f.store, { directory: blocked, key });
    await assert.rejects(() => failing.run());
    assert.match(failing.status().lastError, /last backup failed/);
    const afterFailure = new BackupManager(f.store, good).status();
    assert.match(afterFailure.lastError, /last backup failed/);
    assert.equal(afterFailure.lastSuccess, restarted.lastSuccess, "the last good backup is still shown");
    assert.ok(f.store.db.prepare("SELECT 1 FROM audit WHERE action='backup.failed'").get());

    // The next good backup clears the warning, also after a restart.
    await new BackupManager(f.store, good).run();
    assert.equal(new BackupManager(f.store, good).status().lastError, null);
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("copies made before upgrades go after 30 days, but the newest 3 always stay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nwl-copies-"));
  try {
    const db = join(dir, "nawlogic.sqlite");
    const copies = [1000, 2000, 3000, 4000, 5000].map((t, i) => `nawlogic.sqlite.pre-step${i}-${t}.sqlite`);
    for (const name of [...copies, "nawlogic.sqlite", "other.sqlite.pre-x-1.sqlite", "notes.txt"]) await writeFile(join(dir, name), "x");
    pruneMigrationCopies(db);
    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, [...copies.slice(2), "nawlogic.sqlite", "notes.txt", "other.sqlite.pre-x-1.sqlite"].sort());
    // One upgrade can make several copies at once: none of a recent upgrade's go.
    const day = 86400000,
      now = Date.now();
    const recent = [1, 2, 3, 4, 5].map((i) => `nawlogic.sqlite.pre-batch${i}-${now - 10 * day + i}.sqlite`);
    for (const name of recent) await writeFile(join(dir, name), "x");
    pruneMigrationCopies(db, { now });
    assert.deepEqual((await readdir(dir)).filter((x) => x.includes("batch")).sort(), recent.sort());
    assert.equal((await readdir(dir)).filter((x) => x.includes("step")).length, 0, "the old ones now go");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a flood of new addresses never locks everyone out; the oldest counters make room", async () => {
  const f = await fixture({ app: { limitKeys: 20, trustProxy: 1 } });
  try {
    const login = (ip, pw = "Wrong-password-1") =>
      f.request("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
        body: JSON.stringify({ email: "owner@example.com", password: pw }),
      });
    for (let i = 1; i <= 60; i++) {
      const r = await login(`203.0.113.${i}`);
      assert.notEqual(r.status, 429, `address ${i} is not refused for others' traffic`);
    }
    assert.equal((await login("198.51.100.7", password)).status, 200, "a new address can still sign in");
    // Limits per address still hold.
    for (let i = 0; i < 10; i++) await login("198.51.100.9");
    assert.equal((await login("198.51.100.9")).status, 429);
  } finally {
    await f.close();
  }
});
