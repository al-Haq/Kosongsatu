import { KINDS } from "./domain.mjs";
// Rebuilds the documents table with a wider kind CHECK. The new table is made
// from the table's own current definition, so every column (including columns
// other modules added), index, trigger and row is kept exactly.
export function rebuildDocuments(db) {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='documents'")
    .get();
  if (!table) throw new Error("documents table is missing.");
  const pattern = /CHECK\s*\(\s*kind\s+IN\s*\([^)]*\)\s*\)/i;
  if (!pattern.test(table.sql)) throw new Error("Unexpected documents table definition.");
  const create = table.sql
    .replace(pattern, `CHECK(kind IN (${KINDS.map((k) => `'${k}'`).join(",")}))`)
    .replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"documents"|`documents`|\[documents\]|documents)/i, "CREATE TABLE documents_rebuild");
  if (!create.startsWith("CREATE TABLE documents_rebuild"))
    throw new Error("Unexpected documents table definition.");
  const dependents = db
    .prepare(
      "SELECT type,name,sql FROM sqlite_master WHERE tbl_name='documents' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name",
    )
    .all();
  const columns = db
    .prepare("PRAGMA table_info(documents)")
    .all()
    .map((c) => `"${c.name.replaceAll('"', '""')}"`)
    .join(",");
  const before = db.prepare("SELECT count(*) n FROM documents").get().n;
  db.exec(create);
  db.exec(`INSERT INTO documents_rebuild(${columns}) SELECT ${columns} FROM documents`);
  db.exec("DROP TABLE documents");
  // Legacy rename leaves other tables' REFERENCES documents(id) clauses as they are.
  db.exec("PRAGMA legacy_alter_table=ON");
  try {
    db.exec("ALTER TABLE documents_rebuild RENAME TO documents");
  } finally {
    db.exec("PRAGMA legacy_alter_table=OFF");
  }
  for (const d of dependents) db.exec(d.sql);
  const after = db.prepare("SELECT count(*) n FROM documents").get().n;
  if (after !== before) throw new Error("Document rebuild lost rows.");
}
export const DOCUMENT_MIGRATIONS = [
  {
    // Proforma invoices, sales orders and delivery orders.
    name: "documents-001-kinds",
    foreignKeysOff: true,
    up: rebuildDocuments,
  },
  {
    // Currency, exchange rate (MYR per 1 unit, decimal text), language, module
    // data (custom field values, deposit terms) and links between documents.
    name: "documents-002-document-fields",
    sql: `ALTER TABLE documents ADD COLUMN currency TEXT NOT NULL DEFAULT 'MYR';
 ALTER TABLE documents ADD COLUMN fx_rate TEXT NOT NULL DEFAULT '1';
 ALTER TABLE documents ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
 ALTER TABLE documents ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';
 ALTER TABLE documents ADD COLUMN source_id TEXT REFERENCES documents(id);
 ALTER TABLE documents ADD COLUMN source_role TEXT;
 CREATE INDEX documents_source_idx ON documents(source_id);`,
  },
  {
    // Item codes on the catalog; default currency and language per client.
    name: "documents-003-catalog-clients",
    sql: `ALTER TABLE services ADD COLUMN sku TEXT;
 CREATE UNIQUE INDEX services_sku_idx ON services(sku) WHERE sku IS NOT NULL;
 ALTER TABLE clients ADD COLUMN currency TEXT NOT NULL DEFAULT 'MYR';
 ALTER TABLE clients ADD COLUMN language TEXT NOT NULL DEFAULT '';`,
  },
  {
    // Money received is recorded in the currency of the invoices it pays.
    name: "documents-004-receipt-currency",
    sql: `ALTER TABLE cash_receipts ADD COLUMN currency TEXT NOT NULL DEFAULT 'MYR';
 ALTER TABLE cash_receipts ADD COLUMN fx_rate TEXT NOT NULL DEFAULT '1';`,
  },
  {
    name: "documents-005-instalments",
    sql: `CREATE TABLE document_instalments(
  invoice_id TEXT NOT NULL REFERENCES documents(id),
  seq INTEGER NOT NULL CHECK(seq>0),
  due_date TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount>0),
  created TEXT NOT NULL,
  PRIMARY KEY(invoice_id,seq)
 );`,
  },
  {
    // A client is a company (or other organisation) or an individual person.
    name: "documents-006-client-kind",
    sql: `ALTER TABLE clients ADD COLUMN kind TEXT NOT NULL DEFAULT 'company';`,
  },
];
