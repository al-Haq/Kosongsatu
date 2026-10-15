import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
export function migrate(db, path) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version >= 2) return;
  // A recoverable, private local snapshot precedes any v1 data migration.
  if (
    path !== ":memory:" &&
    db.prepare("SELECT count(*) n FROM documents").get().n
  ) {
    const snapshot = `${path}.pre-v2-${Date.now()}.sqlite`;
    db.prepare("VACUUM INTO ?").run(snapshot);
    chmodSync(snapshot, 0o600);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
 ALTER TABLE schedules ADD COLUMN anchor_day INTEGER;
 ALTER TABLE schedules ADD COLUMN month_end INTEGER NOT NULL DEFAULT 0;
 ALTER TABLE payments ADD COLUMN receipt_id TEXT;
 ALTER TABLE payments ADD COLUMN proof_id TEXT;
 ALTER TABLE audit ADD COLUMN actor TEXT NOT NULL DEFAULT 'system';
 ALTER TABLE audit ADD COLUMN before_data TEXT;
 ALTER TABLE audit ADD COLUMN after_data TEXT;
 ALTER TABLE owners ADD COLUMN mfa_secret TEXT;
 ALTER TABLE owners ADD COLUMN mfa_pending TEXT;
 ALTER TABLE owners ADD COLUMN mfa_pending_expires INTEGER;
 ALTER TABLE owners ADD COLUMN mfa_step INTEGER NOT NULL DEFAULT -1;
 CREATE TABLE recovery_codes(owner_id INTEGER NOT NULL REFERENCES owners(id),hash TEXT PRIMARY KEY,used INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(scope,key));
 CREATE TABLE cash_receipts(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),number TEXT NOT NULL UNIQUE,amount INTEGER NOT NULL CHECK(amount>0),paid_date TEXT NOT NULL,method TEXT NOT NULL,account TEXT NOT NULL,reference TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',dedupe_key TEXT,business_snapshot TEXT NOT NULL,client_snapshot TEXT NOT NULL,voided INTEGER NOT NULL DEFAULT 0,legacy_review INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL);
 CREATE TABLE allocation_releases(id TEXT PRIMARY KEY,payment_id TEXT NOT NULL REFERENCES payments(id),amount INTEGER NOT NULL CHECK(amount>0),reason TEXT NOT NULL,adjustment_id TEXT,created TEXT NOT NULL);
 CREATE TABLE adjustments(id TEXT PRIMARY KEY,invoice_id TEXT NOT NULL REFERENCES documents(id),kind TEXT NOT NULL CHECK(kind IN ('credit','debit')),number TEXT NOT NULL UNIQUE,amount INTEGER NOT NULL CHECK(amount>0),reason TEXT NOT NULL,issue_date TEXT NOT NULL,created TEXT NOT NULL);
 CREATE TABLE refunds(id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL REFERENCES cash_receipts(id),number TEXT NOT NULL UNIQUE,amount INTEGER NOT NULL CHECK(amount>0),paid_date TEXT NOT NULL,reference TEXT NOT NULL,reason TEXT NOT NULL,created TEXT NOT NULL,UNIQUE(receipt_id,reference));
 CREATE TABLE bank_transactions(id TEXT PRIMARY KEY,account TEXT NOT NULL,txn_date TEXT NOT NULL,reference TEXT NOT NULL,amount INTEGER NOT NULL,description TEXT NOT NULL,dedupe_key TEXT NOT NULL UNIQUE,receipt_id TEXT UNIQUE REFERENCES cash_receipts(id),refund_id TEXT UNIQUE REFERENCES refunds(id),ignored_reason TEXT,created TEXT NOT NULL);
 CREATE UNIQUE INDEX receipt_dedupe_active ON cash_receipts(dedupe_key) WHERE voided=0;
 CREATE INDEX receipt_client_idx ON cash_receipts(client_id);
 CREATE INDEX allocation_receipt_idx ON payments(receipt_id);
 CREATE INDEX adjustment_invoice_idx ON adjustments(invoice_id);
 CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Audit entries cannot be edited'); END;
 CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Audit entries cannot be deleted'); END;
 `);
    for (const s of db.prepare("SELECT id,next_date FROM schedules").all()) {
      const first =
        db
          .prepare(
            "SELECT min(period) first FROM schedule_runs WHERE schedule_id=?",
          )
          .get(s.id).first || s.next_date;
      const d = new Date(first + "T00:00:00Z"),
        end = new Date(
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
        ).getUTCDate();
      db.prepare(
        "UPDATE schedules SET anchor_day=?,month_end=? WHERE id=?",
      ).run(d.getUTCDate(), d.getUTCDate() === end ? 1 : 0, s.id);
    }
    const old = db
      .prepare(
        "SELECT p.*,d.client_id FROM payments p JOIN documents d ON d.id=p.invoice_id ORDER BY p.created,p.id",
      )
      .all();
    const groups = new Map();
    for (const p of old) {
      const key = `${p.method}|${p.paid_date}|${p.reference.trim().toUpperCase().replace(/\s+/g, " ")}`;
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    let n = 0;
    for (const p of old) {
      n++;
      const group = `${p.method}|${p.paid_date}|${p.reference.trim().toUpperCase().replace(/\s+/g, " ")}`;
      const review = groups.get(group) > 1 ? 1 : 0;
      const dedupe = review
        ? null
        : createHash("sha256").update(`MAIN|${group}`).digest("hex");
      const rid = "legacy-" + p.id;
      db.prepare(
        "INSERT INTO cash_receipts(id,client_id,number,amount,paid_date,method,account,reference,note,dedupe_key,business_snapshot,client_snapshot,voided,legacy_review,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        rid,
        p.client_id,
        `RC-LEGACY-${String(n).padStart(6, "0")}`,
        p.amount,
        p.paid_date,
        p.method,
        "MAIN",
        p.reference,
        p.note,
        dedupe,
        db
          .prepare("SELECT business_snapshot FROM documents WHERE id=?")
          .get(p.invoice_id).business_snapshot ||
          db.prepare("SELECT data FROM settings WHERE id=1").get().data,
        db
          .prepare("SELECT client_snapshot FROM documents WHERE id=?")
          .get(p.invoice_id).client_snapshot ||
          JSON.stringify(
            db.prepare("SELECT * FROM clients WHERE id=?").get(p.client_id),
          ),
        p.reversed,
        review,
        p.created,
      );
      db.prepare("UPDATE payments SET receipt_id=? WHERE id=?").run(rid, p.id);
    }
    db.exec("PRAGMA user_version=2; COMMIT");
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(path, 0o600);
    }
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
