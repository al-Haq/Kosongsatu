import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  unlink,
  stat,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/db.mjs";
import { createOwner, createSession } from "../server/auth.mjs";
import {
  base32,
  totp,
  verifyTotp,
  beginMfa,
  enableMfa,
  verifySecondFactor,
  mfaStatus,
  disableMfa,
} from "../server/mfa.mjs";
import { BackupManager, restoreBackup } from "../server/recovery.mjs";
import { today } from "../server/domain.mjs";

test("TOTP matches RFC 6238 vectors; window and replay protection are enforced", () => {
  const secret = base32(Buffer.from("12345678901234567890"));
  for (const [t, code] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])
    assert.equal(totp(secret, t, 8), code);
  const code = totp(secret, 3000);
  assert.equal(verifyTotp(secret, code, -1, 3000), 100);
  assert.equal(verifyTotp(secret, code, 100, 3000), null);
  assert.equal(verifyTotp(secret, code, -1, 3090), null);
  assert.equal(verifyTotp(secret, "12345", -1, 3000), null);
});
test("MFA setup encrypts secrets, revokes other sessions and consumes recovery codes once", async () => {
  const s = openDatabase(":memory:");
  try {
    await createOwner(s, "mfa@example.com", "Strong-test-password-123");
    const owner = s.db.prepare("SELECT id FROM owners").get();
    const keep = createSession(s, owner.id);
    createSession(s, owner.id);
    const setup = beginMfa(s, owner.id);
    assert.ok(setup.uri.startsWith("otpauth://"));
    assert.ok(
      !s.db
        .prepare("SELECT mfa_pending FROM owners")
        .get()
        .mfa_pending.includes(setup.secret),
    );
    assert.throws(() => enableMfa(s, owner.id, "bad"), /code/);
    const enabled = enableMfa(
      s,
      owner.id,
      totp(setup.secret),
      s.db.prepare("SELECT hash FROM sessions WHERE csrf=?").get(keep.csrf)
        .hash,
    );
    assert.equal(enabled.codes.length, 10);
    assert.equal(s.db.prepare("SELECT count(*) n FROM sessions").get().n, 1);
    assert.equal(mfaStatus(s, owner.id).enabled, true);
    assert.equal(verifySecondFactor(s, owner.id, totp(setup.secret)), false);
    assert.equal(verifySecondFactor(s, owner.id, enabled.codes[0]), true);
    assert.equal(verifySecondFactor(s, owner.id, enabled.codes[0]), false);
    assert.equal(mfaStatus(s, owner.id).recoveryRemaining, 9);
    assert.throws(() => beginMfa(s, owner.id), /already enabled/);
    const serialized = JSON.stringify(
      s.db.prepare("SELECT * FROM audit").all(),
    );
    assert.ok(!serialized.includes(setup.secret));
    assert.ok(!serialized.includes(enabled.codes[0]));
    disableMfa(s, owner.id);
    assert.equal(mfaStatus(s, owner.id).enabled, false);
    assert.equal(mfaStatus(s, owner.id).recoveryRemaining, 0);
  } finally {
    s.db.close();
  }
});
test("file-backed authenticator survives restart; missing key fails closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nwl-mfa-"));
  const path = join(dir, "db.sqlite");
  let s;
  try {
    s = openDatabase(path);
    await createOwner(s, "mfa@example.com", "Strong-test-password-123");
    const { secret } = beginMfa(s, 1);
    const { codes } = enableMfa(s, 1, totp(secret));
    s.db.close();
    s = null;
    s = openDatabase(path);
    assert.equal(verifySecondFactor(s, 1, codes[0]), true);
    s.db.close();
    s = null;
    await unlink(path + ".mfa-key");
    assert.throws(() => openDatabase(path), /original MFA key/);
  } finally {
    s?.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("encrypted backup restores a consistent new database and revokes sessions and client links", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nwl-backup-"));
  let s, restored;
  try {
    s = openDatabase(join(dir, "source.sqlite"));
    await createOwner(s, "backup@example.com", "Strong-test-password-123");
    createSession(s, 1);
    s.saveSettings({
      registration: "TEST-1",
      address: "Test office",
      email: "test@example.com",
    });
    const c = s.saveClient({ name: "Backup client" });
    const d = s.saveDocument({
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: today(),
      items: [{ description: "Service", quantity: 1, rate: 100 }],
    });
    s.issue(d.id);
    const link = s.share(d.id);
    s.recordPayment(d.id, {
      amount: 40,
      paid_date: today(),
      method: "Bank transfer",
      reference: "Backup-receipt",
    });
    const connector = s.createConnector({
      label: "Restore test",
      scopes: ["business:read"],
    });
    s.setRule("customer_po_invoice", true);
    const opportunity = s.saveOpportunity({
      client_id: c.id,
      title: "Preserved sales",
      expected_amount: 100,
    });
    const key = randomBytes(32).toString("base64"),
      directory = join(dir, "backups");
    const manager = new BackupManager(s, { directory, key, keep: 2 });
    const result = await manager.run();
    const file = join(directory, result.filename);
    const encrypted = await readFile(file);
    assert.equal(encrypted.subarray(0, 4).toString(), "NWL2");
    assert.ok(!encrypted.includes(Buffer.from("Backup client")));
    // Windows has no owner-only file mode (chmod only sets read-only).
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(manager.status().lastError, null);
    assert.equal((await readdir(directory)).length, 1);
    const output = join(dir, "restored.sqlite");
    await assert.rejects(() =>
      restoreBackup(file, output, randomBytes(32).toString("base64")),
    );
    await restoreBackup(file, output, key);
    restored = openDatabase(output);
    assert.equal(restored.document(d.id).balance, 6000);
    assert.equal(restored.receipts().length, 1);
    assert.throws(() => restored.connector(connector.token), /revoked/);
    assert.ok(restored.automationState().rules.every((r) => !r.enabled));
    assert.equal(restored.sales().opportunities[0].id, opportunity.id);
    assert.equal(
      restored.db.prepare("SELECT count(*) n FROM sessions").get().n,
      0,
    );
    assert.throws(
      () => restored.publicDocument(link.token),
      /expired|not found/i,
    );
    const before = await readFile(output);
    await assert.rejects(() => restoreBackup(file, output, key), /EEXIST/);
    assert.deepEqual(await readFile(output), before);
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 1;
    const bad = join(dir, "bad.nwlbackup");
    await writeFile(bad, tampered);
    await assert.rejects(() =>
      restoreBackup(bad, join(dir, "bad.sqlite"), key),
    );
  } finally {
    restored?.db.close();
    s?.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
