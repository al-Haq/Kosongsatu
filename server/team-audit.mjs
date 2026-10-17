// Verifiable audit chain. Each entry stores prev_hash (the hash of the entry
// before it) and hash = SHA-256(prev_hash + "\n" + canonical(entry)). Changing,
// removing or reordering an earlier entry breaks every later hash, so anyone who
// kept an earlier chain head can detect it. Works on a raw node:sqlite handle so
// the CLI can verify a database without the app's keys.
import { createHash } from "node:crypto";

export const GENESIS = "0".repeat(64);
const COLUMNS = ["id", "created", "actor", "action", "entity_id", "detail", "before_data", "after_data"];

// A fixed field order and JSON encoding: strings, integers and nulls only.
export function canonical(row) {
  return JSON.stringify(COLUMNS.map((c) => (row[c] === undefined ? null : row[c])));
}
export function entryHash(prev, row) {
  return createHash("sha256").update(prev + "\n" + canonical(row)).digest("hex");
}

// The no-edit guard. An entry may be updated exactly once, from unsealed to
// sealed, and only its prev_hash/hash; every other change is refused.
const GUARDS = `
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
WHEN OLD.hash IS NOT NULL OR NEW.hash IS NULL OR NEW.prev_hash IS NULL
  OR NEW.id IS NOT OLD.id OR NEW.action IS NOT OLD.action OR NEW.entity_id IS NOT OLD.entity_id
  OR NEW.detail IS NOT OLD.detail OR NEW.created IS NOT OLD.created OR NEW.actor IS NOT OLD.actor
  OR NEW.before_data IS NOT OLD.before_data OR NEW.after_data IS NOT OLD.after_data
BEGIN SELECT RAISE(ABORT,'Audit entries cannot be edited'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit entries cannot be deleted'); END;`;

// Migration: add the columns, back-fill every existing entry in id order and
// put the guards back. Runs inside the migration's transaction.
export function migrateAuditChain(db) {
  db.exec("DROP TRIGGER IF EXISTS audit_no_update; DROP TRIGGER IF EXISTS audit_no_delete;");
  db.exec("ALTER TABLE audit ADD COLUMN prev_hash TEXT; ALTER TABLE audit ADD COLUMN hash TEXT;");
  const update = db.prepare("UPDATE audit SET prev_hash=?, hash=? WHERE id=?");
  let prev = GENESIS;
  for (const row of db.prepare("SELECT * FROM audit ORDER BY id").iterate()) {
    const h = entryHash(prev, row);
    update.run(prev, h, row.id);
    prev = h;
  }
  db.exec("CREATE INDEX audit_unsealed_idx ON audit(id) WHERE hash IS NULL;" + GUARDS);
}

// Seals entries written without a hash (new entries, or raw inserts such as
// console recovery), in id order, after the last sealed entry. Call inside the
// same transaction as the insert.
export function sealAudit(db) {
  const pending = db.prepare("SELECT * FROM audit WHERE hash IS NULL ORDER BY id").all();
  if (!pending.length) return 0;
  let prev =
    db.prepare("SELECT hash FROM audit WHERE hash IS NOT NULL AND id<? ORDER BY id DESC LIMIT 1").get(pending[0].id)
      ?.hash || GENESIS;
  const update = db.prepare("UPDATE audit SET prev_hash=?, hash=? WHERE id=? AND hash IS NULL");
  for (const row of pending) {
    const h = entryHash(prev, row);
    update.run(prev, h, row.id);
    prev = h;
  }
  return pending.length;
}

export function chainHead(db) {
  const row = db.prepare("SELECT id, hash, created FROM audit WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1").get();
  const count = db.prepare("SELECT count(*) n FROM audit").get().n;
  return row ? { id: row.id, hash: row.hash, created: row.created, entries: count } : { id: 0, hash: GENESIS, created: null, entries: count };
}

// Walks the whole chain. Reports the first entry that does not link to the one
// before it or whose content no longer matches its hash. With `expect`
// ({ id, hash }), also confirms that a previously recorded head is still there.
export function verifyAuditChain(db, expect = null) {
  let prev = GENESIS,
    checked = 0,
    last = null,
    unsealed = 0;
  for (const row of db.prepare("SELECT * FROM audit ORDER BY id").iterate()) {
    if (row.hash === null || row.hash === undefined) {
      unsealed++;
      continue;
    }
    if (unsealed)
      return broken(checked, row, "An earlier entry was never sealed into the chain.");
    if (row.prev_hash !== prev)
      return broken(checked, row, "The entry does not link to the entry before it (an entry was removed, added or reordered).");
    if (entryHash(prev, row) !== row.hash)
      return broken(checked, row, "The entry content no longer matches its hash (it was changed after it was written).");
    prev = row.hash;
    last = row;
    checked++;
  }
  const head = last
    ? { id: last.id, hash: last.hash, created: last.created }
    : { id: 0, hash: GENESIS, created: null };
  const result = { ok: true, checked, unsealed, head };
  if (expect) {
    const id = Number(expect.id);
    const row = Number.isInteger(id) && id > 0 ? db.prepare("SELECT id, hash FROM audit WHERE id=?").get(id) : null;
    result.recorded = {
      id,
      hash: String(expect.hash || ""),
      found: !!row,
      matches: !!row && row.hash === String(expect.hash || "").toLowerCase(),
    };
    if (!result.recorded.matches) {
      result.ok = false;
      result.reason = row
        ? "The recorded chain head no longer matches: history up to that entry was rewritten."
        : "The recorded chain head is missing: entries were removed after it was recorded.";
    }
  }
  return result;
  function broken(n, row, reason) {
    return { ok: false, checked: n, broken: { id: row.id, action: row.action, created: row.created }, reason };
  }
}
