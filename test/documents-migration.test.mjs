import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../server/migrations.mjs";
import { migrateAutomation } from "../server/automation-migration.mjs";
import { migrateRecords } from "../server/records.mjs";
import { migrateMail } from "../server/mailer.mjs";
import { migrateTax } from "../server/tax.mjs";
import { migrateGateway } from "../server/gateway.mjs";
import { runMigrations } from "../server/migrate.mjs";
import { FILE_MIGRATIONS } from "../server/files.mjs";
import { SECRET_MIGRATIONS } from "../server/secrets.mjs";
import { openDatabase } from "../server/db.mjs";

// A database exactly as it was before the documents module: core schema and
// core migrations, populated with documents that other tables point to.
function legacyDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL("../server/schema.sql", import.meta.url), "utf8"));
  db.prepare("INSERT INTO settings(id,data) VALUES(1,?)").run(
    JSON.stringify({ company: "Legacy Co", registration: "R-1", address: "KL", email: "a@b.co", invoicePrefix: "INV", quotePrefix: "QT", paymentTerms: "14 days", demo: false }),
  );
  for (const m of [migrate, migrateAutomation, migrateRecords, migrateMail, migrateTax, migrateGateway]) m(db, path);
  runMigrations(db, path, [...FILE_MIGRATIONS, ...SECRET_MIGRATIONS]);
  // Another module's column, index and trigger on documents must survive the rebuild.
  db.exec(`ALTER TABLE documents ADD COLUMN einvoice_uuid TEXT;
    CREATE INDEX documents_issue_idx ON documents(issue_date);
    CREATE TABLE doc_touch(id TEXT);
    CREATE TRIGGER documents_touch AFTER UPDATE OF viewed_at ON documents BEGIN INSERT INTO doc_touch VALUES(new.id); END;`);
  const now = "2026-10-01T00:00:00.000Z";
  const snap = (o) => JSON.stringify(o);
  db.prepare("INSERT INTO clients(id,name,email,terms,created) VALUES('c1','Pelanggan Lama','x@y.co',14,?)").run(now);
  const items = (rate, tax_rate = 0) =>
    JSON.stringify([{ description: "Integrasi sistem", quantity: 1, rate, amount: rate, tax_rate, taxable: rate - 1000, tax: Math.round(((rate - 1000) * tax_rate) / 100) }]);
  const insert = db.prepare(
    "INSERT INTO documents(id,kind,number,client_id,client_snapshot,business_snapshot,state,issue_date,due_date,items,subtotal,discount,tax,total,notes,terms,source_quote,token_hash,token_expires,viewed_at,accepted_name,created,updated,einvoice_uuid) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const client = snap({ id: "c1", name: "Pelanggan Lama", email: "x@y.co", terms: 14 }),
    business = snap({ company: "Legacy Co", bankAccount: "123" });
  insert.run("q1", "quote", "QT-2026-0001", "c1", client, business, "accepted", "2026-09-01", "2026-09-30", items(500000, 8), 500000, 1000, 39920, 538920, "", "t", null, null, null, null, "Aina", now, now, null);
  insert.run("i1", "invoice", "INV-2026-0001", "c1", client, business, "issued", "2026-09-02", "2026-09-16", items(500000, 8), 500000, 1000, 39920, 538920, "n", "t", "q1", "tokenhash1", 9999999999999, now, null, now, now, "uuid-1");
  insert.run("i2", "invoice", null, "c1", null, null, "draft", "2026-10-01", "2026-10-15", items(120000), 120000, 0, 0, 120000, "", "", null, null, null, null, null, now, now, null);
  insert.run("i3", "invoice", "INV-2026-0002", "c1", client, business, "void", "2026-09-03", "2026-09-17", items(30000), 30000, 0, 0, 30000, "", "", null, null, null, null, null, now, now, null);
  db.prepare(
    "INSERT INTO cash_receipts(id,client_id,number,amount,paid_date,method,account,reference,note,dedupe_key,business_snapshot,client_snapshot,created) VALUES('r1','c1','RC-2026-00001',200000,'2026-09-05','Bank transfer','MAIN','BANK-1','','k1',?,?,?)",
  ).run(business, client, now);
  db.prepare(
    "INSERT INTO payments(id,invoice_id,amount,paid_date,method,reference,note,receipt_id,created) VALUES('p1','i1',200000,'2026-09-05','Bank transfer','BANK-1 [x]','', 'r1',?)",
  ).run(now);
  db.prepare("INSERT INTO adjustments VALUES('a1','i1','credit','CN-2026-00001',8920,'Rounding','2026-09-06',?)").run(now);
  db.prepare("INSERT INTO proofs(id,invoice_id,reference,created) VALUES('pr1','i1','REF',?)").run(now);
  db.prepare(
    "INSERT INTO customer_pos VALUES('po1','c1','q1','PO-9','PO-9',538920,'2026-09-01','','i1',?)",
  ).run(now);
  db.prepare("INSERT INTO online_payments(id,invoice_id,provider,bill_id,amount,url,created) VALUES('o1','i1','billplz','b1',1,'https://x',?)").run(now);
  db.prepare(
    "INSERT INTO email_log(id,kind,document_id,client_id,recipients,subject,status,created) VALUES('e1','document','i1','c1','x@y.co','Invoice','sent',?)",
  ).run(now);
  db.prepare("INSERT INTO counters VALUES('invoice-2026',2),('quote-2026',1)").run();
  return db;
}

test("the documents rebuild upgrades a populated database without losing anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "documents-migration-"));
  const path = join(dir, "legacy.sqlite");
  try {
    const db = legacyDatabase(path);
    const columns = db.prepare("PRAGMA table_info(documents)").all().map((c) => c.name);
    const rows = db.prepare("SELECT * FROM documents ORDER BY id").all();
    const indexes = db
      .prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='documents' AND type IN ('index','trigger') ORDER BY name")
      .all();
    db.close();

    const store = openDatabase(path);
    try {
      const done = store.db.prepare("SELECT name FROM schema_migrations WHERE name LIKE 'documents-%' ORDER BY name").all();
      assert.deepEqual(
        done.map((r) => r.name),
        ["documents-001-kinds", "documents-002-document-fields", "documents-003-catalog-clients", "documents-004-receipt-currency", "documents-005-instalments", "documents-006-client-kind"],
      );
      // Every old column and value, in the same rows.
      const after = store.db.prepare(`SELECT ${columns.map((c) => `"${c}"`).join(",")} FROM documents ORDER BY id`).all();
      assert.deepEqual(after.map((r) => ({ ...r })), rows.map((r) => ({ ...r })));
      // Every old index and trigger, including the other module's; plus autoindexes for UNIQUE columns.
      const kept = store.db
        .prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='documents' AND type IN ('index','trigger') ORDER BY name")
        .all();
      for (const i of indexes) assert.ok(kept.some((k) => k.name === i.name && k.sql === i.sql), i.name);
      assert.throws(() => store.db.prepare("UPDATE documents SET source_quote='q1' WHERE id='i2'").run(), /UNIQUE/);
      store.db.prepare("UPDATE documents SET viewed_at='x' WHERE id='i2'").run();
      assert.equal(store.db.prepare("SELECT count(*) n FROM doc_touch").get().n, 1, "trigger still fires");
      // References from other tables still point at documents and are enforced.
      assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(store.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
      assert.throws(
        () => store.db.prepare("INSERT INTO payments(id,invoice_id,amount,paid_date,method,reference,created) VALUES('p9','missing',1,'2026-09-05','Cash','R','x')").run(),
        /FOREIGN KEY/,
      );
      // The new kinds are allowed, unknown kinds still are not.
      assert.throws(() => store.db.prepare("UPDATE documents SET kind='bogus' WHERE id='i2'").run(), /CHECK/);
      store.db.prepare("UPDATE documents SET kind='proforma' WHERE id='i2'").run();
      store.db.prepare("UPDATE documents SET kind='invoice' WHERE id='i2'").run();
      // Old documents read with safe defaults and total exactly as before.
      const d = store.document("i1");
      assert.equal(d.currency, "MYR");
      assert.equal(d.fx_rate, "1");
      assert.equal(d.language, "en");
      assert.deepEqual(d.meta, {});
      assert.equal(d.total, 538920);
      assert.equal(d.tax, 39920);
      assert.equal(d.paid, 200000);
      assert.equal(d.adjusted_total, 530000);
      assert.equal(d.balance, 330000);
      assert.equal(d.status, "Overdue");
      assert.equal(d.einvoice_uuid, "uuid-1");
      assert.equal(d.links.source.number, "QT-2026-0001");
      assert.equal(store.document("q1").links.children[0].id, "i1");
      assert.equal(store.receipt("r1").currency, "MYR");
      assert.equal(store.client("c1").currency, "MYR");
      // A recoverable snapshot was taken before the data migration.
      assert.ok(readdirSync(dir).some((f) => /legacy\.sqlite\.pre-documents-001-kinds-\d+\.sqlite$/.test(f)));
      // The next invoice number continues the old counter.
      store.saveSettings({ registration: "R-1", address: "KL", email: "a@b.co" });
      assert.equal(store.issue("i2").number, "INV-2026-0003");
    } finally {
      store.db.close();
    }
    // Opening again runs nothing twice.
    const again = openDatabase(path);
    assert.equal(again.db.prepare("SELECT count(*) n FROM documents").get().n, 4);
    again.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
