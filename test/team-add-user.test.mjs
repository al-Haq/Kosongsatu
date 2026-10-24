// The add-user console command: an active user with a password, made on the
// server when sharing an invitation link is not practical.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDatabase } from "../server/db.mjs";
import { createOwner, verifyPassword } from "../server/auth.mjs";
import { verifyAuditChain } from "../server/team-audit.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../server/cli.mjs", import.meta.url));

test("add-user creates an active user with a generated password, once, and records it in the audit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nwl-add-user-"));
  const path = join(dir, "db.sqlite");
  try {
    const first = openDatabase(path);
    await createOwner(first, "owner@example.com", "First-owner-password-1");
    first.db.close();
    const env = { ...process.env, DATABASE_PATH: path, ADMIN_PASSWORD: "" };
    const add = (...args) => run(process.execPath, [cli, "add-user", ...args], { env });

    const r = await add("Second.Owner@Example.com", "owner", "Second", "Owner");
    assert.match(r.stdout, /User created: second\.owner@example\.com \(owner\)\./);
    const password = r.stdout.split("\n")[2];
    assert.match(password, /^[\w-]{24}$/, "a generated password is shown once");

    const s = openDatabase(path);
    try {
      const u = s.db.prepare("SELECT * FROM owners WHERE email=?").get("second.owner@example.com");
      assert.equal(u.role, "owner");
      assert.equal(u.name, "Second Owner");
      assert.ok(u.joined, "active at once, not an invitation");
      assert.equal(u.invited, null);
      assert.ok(await verifyPassword(password, u.password), "the shown password signs in");
      const entry = s.db.prepare("SELECT * FROM audit WHERE action='user.created'").get();
      assert.equal(entry.actor, "local-console");
      assert.equal(entry.detail, "second.owner@example.com as owner");
      assert.ok(verifyAuditChain(s.db).ok, "the entry is chained like every other");
    } finally {
      s.db.close();
    }

    // Staff is the default role; a password can be given privately instead.
    const own = await run(process.execPath, [cli, "add-user", "staff@example.com"], { env: { ...env, ADMIN_PASSWORD: "Chosen-elsewhere-123" } });
    assert.match(own.stdout, /\(staff\)/);
    assert.doesNotMatch(own.stdout, /Chosen-elsewhere-123/);
    const t = openDatabase(path);
    try {
      assert.ok(await verifyPassword("Chosen-elsewhere-123", t.db.prepare("SELECT password FROM owners WHERE email='staff@example.com'").get().password));
    } finally {
      t.db.close();
    }

    // Refused, with nothing changed: an existing email, an unknown role, a short password, no email.
    for (const [args, message, extra = {}] of [
      [["second.owner@example.com", "owner"], /already exists/],
      [["x@example.com", "admin"], /Choose owner, staff or accountant/],
      [["y@example.com", "owner"], /12 to 256 characters/, { ADMIN_PASSWORD: "short" }],
      [[], /Use: node server\/cli\.mjs add-user/],
    ])
      await assert.rejects(run(process.execPath, [cli, "add-user", ...args], { env: { ...env, ...extra } }), (e) => {
        assert.equal(e.code, 1);
        assert.match(e.stderr, message);
        return true;
      });
    const after = openDatabase(path);
    try {
      assert.equal(after.db.prepare("SELECT count(*) n FROM owners").get().n, 3);
    } finally {
      after.db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
