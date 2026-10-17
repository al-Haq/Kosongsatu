// Data import (roadmap no. 85): clients, services and historical invoices from
// CSV. Every row is checked by running the real save code inside a transaction
// that is rolled back, so the preview shows exactly what the import will do.
// The import itself is all-or-nothing. Nothing is emailed, shared or issued:
// historical invoices keep their original number, dates and status, and paid
// amounts become receipts marked as imported so balances stay consistent.
import { createHash, randomUUID } from "node:crypto";
import { AppError, check, now, today, text } from "./domain.mjs";
import { receiptKey } from "./finance.mjs";
import { requestContext } from "./context.mjs";
import { parseAmount, parseDateText } from "./platform-quick.mjs";

export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_ROWS = 2000;
export const IMPORT_KINDS = ["clients", "services", "invoices"];
export const IMPORT_MIGRATION = `CREATE TABLE platform_imports(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  rows INTEGER NOT NULL,
  created_count INTEGER NOT NULL,
  skipped_count INTEGER NOT NULL,
  actor TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE TABLE platform_import_records(
  import_id TEXT NOT NULL REFERENCES platform_imports(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY(entity_type,entity_id)
);`;

// Templates owners download, fill in a spreadsheet and upload again.
export const TEMPLATES = {
  clients: [
    ["name", "email", "phone", "contact", "address", "tin", "brn", "sst_number", "terms"],
    ["ABC Sdn Bhd", "accounts@abc.example", "+60 3-1234 5678", "Aina", "Lot 1, Jalan Contoh, 50000 Kuala Lumpur", "C1234567890", "202001012345", "", "30"],
    ["Meranti Digital", "billing@meranti.example", "", "", "", "", "", "", "14"],
  ],
  services: [
    ["name", "description", "unit", "rate", "tax_rate"],
    ["Managed maintenance", "Monthly server and network maintenance", "Month", "750.00", "0"],
    ["Technical consulting", "", "Hour", "200.00", "0"],
  ],
  invoices: [
    ["number", "client", "issue_date", "due_date", "description", "quantity", "rate", "tax_rate", "status", "paid_amount", "paid_date", "notes"],
    ["INV-2025-0101", "ABC Sdn Bhd", "2025-09-01", "2025-10-01", "Network setup", "1", "2500.00", "0", "paid", "", "2025-09-20", ""],
    ["INV-2025-0102", "ABC Sdn Bhd", "2025-10-01", "2025-10-31", "Managed maintenance - October 2025", "1", "750.00", "0", "partly paid", "300.00", "2025-10-15", ""],
    ["INV-2025-0102", "", "", "", "On-site support", "2", "200.00", "0", "", "", "", ""],
    ["INV-2025-0103", "Meranti Digital", "05/10/2025", "04/11/2025", "Consulting", "10", "200.00", "0", "unpaid", "", "", "Opening balance"],
  ],
};
const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
};
export const templateCsv = (kind) => "﻿" + TEMPLATES[kind].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

// Column names people use in other systems, mapped to ours.
const ALIASES = {
  name: ["name", "clientname", "customername", "company", "companyname", "nama", "namaklien", "servicename", "item", "itemname", "product"],
  email: ["email", "emailaddress", "e-mail", "emel"],
  phone: ["phone", "phonenumber", "telephone", "tel", "mobile", "telefon"],
  contact: ["contact", "contactperson", "attention", "attn", "pic"],
  address: ["address", "billingaddress", "alamat"],
  tin: ["tin", "taxid", "taxnumber", "taxidentificationnumber"],
  brn: ["brn", "registration", "registrationnumber", "regno", "ssm", "businessregistration", "roc"],
  sst_number: ["sstnumber", "sstno", "sstregistration", "sst"],
  terms: ["terms", "paymentterms", "termsdays", "creditterms", "terma"],
  description: ["description", "details", "keterangan", "itemdescription"],
  unit: ["unit", "uom"],
  rate: ["rate", "price", "unitprice", "harga", "amount", "linetotal"],
  tax_rate: ["taxrate", "sstrate", "tax", "taxpercent", "sstpercent"],
  number: ["number", "invoicenumber", "invoiceno", "invoice", "no", "docno", "documentnumber", "nombor"],
  client: ["client", "customer", "clientname", "customername", "billto", "klien", "pelanggan"],
  issue_date: ["issuedate", "date", "invoicedate", "tarikh"],
  due_date: ["duedate", "due", "tarikhakhir"],
  quantity: ["quantity", "qty", "kuantiti"],
  status: ["status"],
  paid_amount: ["paidamount", "paid", "amountpaid", "bayaran", "dibayar"],
  paid_date: ["paiddate", "paymentdate", "datepaid", "tarikhbayar"],
  notes: ["notes", "note", "remarks", "nota", "catatan"],
};
const COLUMNS = {
  clients: ["name", "email", "phone", "contact", "address", "tin", "brn", "sst_number", "terms"],
  services: ["name", "description", "unit", "rate", "tax_rate"],
  invoices: ["number", "client", "issue_date", "due_date", "description", "quantity", "rate", "tax_rate", "status", "paid_amount", "paid_date", "notes"],
};
const REQUIRED = { clients: ["name"], services: ["name", "rate"], invoices: ["number", "client", "issue_date", "description", "rate"] };

// RFC 4180 CSV with a BOM, CRLF, quoted fields and comma, semicolon or tab separators.
export function parseCsv(input) {
  check(typeof input === "string", "Upload a CSV file.");
  const textIn = input.replace(/^﻿/, "");
  check(textIn.trim().length > 0, "The file is empty.");
  const first = textIn.slice(0, textIn.search(/\r?\n/) === -1 ? undefined : textIn.search(/\r?\n/));
  const sep = [",", ";", "\t"].map((c) => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < textIn.length; i++) {
    const c = textIn[i];
    if (quoted) {
      if (c === '"' && textIn[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && textIn[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  check(!quoted, "A quoted value in the CSV is not closed.");
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim()));
}
function mapHeaders(kind, header) {
  const keys = header.map((h) => {
    const k = h.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/-/g, "");
    return COLUMNS[kind].find((col) => col.replace(/_/g, "") === k || ALIASES[col]?.includes(k)) || null;
  });
  const seen = new Set();
  keys.forEach((k, i) => {
    if (!k) return;
    check(!seen.has(k), `Column "${header[i].trim()}" appears twice.`);
    seen.add(k);
  });
  for (const col of REQUIRED[kind]) check(seen.has(col), `The CSV needs a "${col}" column. Download the template to see the columns.`);
  return keys;
}
function readRows(kind, csv) {
  const rows = parseCsv(csv);
  check(rows.length >= 2, "The CSV needs a header row and at least one data row.");
  check(rows.length - 1 <= MAX_IMPORT_ROWS, `Import up to ${MAX_IMPORT_ROWS} rows at a time.`);
  const keys = mapHeaders(kind, rows[0]);
  return rows.slice(1).map((r, n) => {
    const data = {};
    keys.forEach((k, i) => {
      if (k) data[k] = (r[i] ?? "").trim();
    });
    return { line: n + 2, data, extra: r.length > keys.length };
  });
}
const toDate = (v, label) => {
  const d = parseDateText(v, "2000-01-01");
  check(d && /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$|^\d{1,2}\s+\p{L}+\s+\d{4}$/u.test(v.trim()), `${label} "${v}" is not a date. Use YYYY-MM-DD or DD/MM/YYYY.`);
  return d;
};
const toMoney = (v, label) => {
  const sen = parseAmount(v.replace(/\s+/g, ""));
  check(sen !== null, `${label} "${v}" is not an amount. Use e.g. 1500.00 or RM1,500.`);
  return (sen / 100).toFixed(2);
};
const toRate = (v) => {
  const r = Number(String(v || "0").replace(/%$/, "").trim());
  check(Number.isFinite(r), `SST rate "${v}" is not a number.`);
  return r;
};
const STATUS = [
  [/^(unpaid|issued|open|outstanding|due|overdue|belum\s*bayar|tertunggak)$/i, "unpaid"],
  [/^(partly\s*paid|part[- ]?paid|partial(ly paid)?|separa|bayar\s*separa)$/i, "partial"],
  [/^(paid|settled|closed|dibayar|lunas|selesai)$/i, "paid"],
  [/^(void|voided|cancelled|canceled|batal|dibatalkan)$/i, "void"],
];
const lookupClient = (store, name) =>
  store.db.prepare("SELECT * FROM clients WHERE lower(trim(name))=lower(trim(?)) ORDER BY archived,created LIMIT 1").get(name);

// Groups invoice rows by number: one invoice per number, one line per row.
function invoiceUnits(rows) {
  const groups = new Map();
  for (const r of rows) {
    const n = r.data.number || "";
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(r);
  }
  return [...groups.entries()].map(([number, list]) => {
    const head = { ...list[0].data };
    let error = null;
    for (const r of list.slice(1))
      for (const k of ["client", "issue_date", "due_date", "status", "paid_amount", "paid_date", "notes"])
        if (r.data[k] && head[k] && r.data[k] !== head[k] && !error) error = `Row ${r.line}: ${k.replace("_", " ")} differs from row ${list[0].line} for invoice ${number}.`;
        else if (r.data[k] && !head[k]) head[k] = r.data[k];
    return { lines: list.map((r) => r.line), number, head, rows: list.map((r) => r.data), error };
  });
}
function applyClient(store, b) {
  check(b.name, "Name is required.");
  if (lookupClient(store, b.name)) return { skip: true, message: "A client with this name already exists." };
  const terms = String(b.terms ?? "").replace(/\s*(days?|hari)$/i, "");
  const c = store.saveClient({ ...b, terms: terms === "" ? 14 : terms });
  return { entity: ["client", c.id], summary: c.name };
}
function applyService(store, b) {
  check(b.name, "Name is required.");
  if (store.db.prepare("SELECT 1 FROM services WHERE lower(trim(name))=lower(trim(?))").get(b.name)) return { skip: true, message: "A service with this name already exists." };
  const s = store.saveService({ name: b.name, description: b.description || "", unit: b.unit || "Project", rate: toMoney(b.rate, "Rate"), tax_rate: toRate(b.tax_rate) });
  return { entity: ["service", s.id], summary: `${s.name} / RM${(s.rate / 100).toFixed(2)}` };
}
function applyInvoice(store, u) {
  check(!u.error, u.error);
  const number = text(u.number, 40, true);
  check(/^[\w./#-]+$/.test(number), `Invoice number "${number}" may only use letters, numbers and - / . #.`);
  if (store.db.prepare("SELECT 1 FROM documents WHERE number=?").get(number)) return { skip: true, message: `${number} is already in the workspace.` };
  const h = u.head;
  const client = lookupClient(store, h.client || "");
  check(client, `Client "${h.client}" not found. Import or add the client first (exact name).`);
  const issue_date = toDate(h.issue_date, "Issue date");
  check(issue_date <= today(), "Historical invoices cannot have a future issue date.");
  const due_date = h.due_date ? toDate(h.due_date, "Due date") : issue_date;
  const items = u.rows.map((r) => {
    check(r.description, "Every line needs a description.");
    const quantity = r.quantity ? r.quantity.replace(/,/g, "") : "1";
    return { description: r.description, quantity, rate: toMoney(r.rate, "Rate"), tax_rate: toRate(r.tax_rate) };
  });
  let status = null;
  if (h.status) {
    status = STATUS.find(([re]) => re.test(h.status.trim()))?.[1];
    check(status, `Status "${h.status}" is not one of unpaid, partly paid, paid or void.`);
  }
  // The real draft code checks dates, lines and SST, including other modules' rules.
  const draft = store.saveDocument({ kind: "invoice", client_id: client.id, issue_date, due_date, items, notes: h.notes || "" });
  let paid = h.paid_amount ? Math.round(Number(toMoney(h.paid_amount, "Paid amount")) * 100) : status === "paid" ? draft.total : 0;
  check(paid <= draft.total, `Paid amount is more than the invoice total (RM${(draft.total / 100).toFixed(2)}).`);
  if (status === "paid") check(paid === draft.total, `Status is paid but the paid amount is less than the total (RM${(draft.total / 100).toFixed(2)}).`);
  if (status === "unpaid") check(paid === 0, "Status is unpaid but a paid amount is given.");
  if (status === "partial") check(paid > 0 && paid < draft.total, "Status is partly paid: give a paid amount below the total.");
  if (status === "void") check(paid === 0, "A void invoice cannot have a paid amount.");
  const settings = store.settings();
  store.db
    .prepare("UPDATE documents SET state=?,number=?,client_snapshot=?,business_snapshot=?,updated=? WHERE id=?")
    .run(status === "void" ? "void" : "issued", number, JSON.stringify(client), JSON.stringify(settings), now(), draft.id);
  // Keep future numbering clear of imported numbers in the same series.
  const series = number.match(new RegExp(`^${settings.invoicePrefix.replace(/[-]/g, "\\-")}-(\\d{4})-(\\d+)$`));
  if (series)
    store.db
      .prepare("INSERT INTO counters(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=max(value,excluded.value)")
      .run(`invoice-${series[1]}`, Number(series[2]));
  const records = [["document", draft.id]];
  if (paid > 0) {
    const paid_date = h.paid_date ? toDate(h.paid_date, "Paid date") : issue_date;
    check(paid_date <= today(), "Paid date cannot be in the future.");
    const reference = `IMPORTED ${number}`;
    const receipt = {
      id: randomUUID(),
      client_id: client.id,
      number: store.number("RC", paid_date),
      amount: paid,
      paid_date,
      method: "Other",
      account: "IMPORTED",
      reference,
      note: "Imported opening balance. Recorded in the previous system.",
      dedupe_key: receiptKey({ account: "IMPORTED", method: "Other", paid_date, reference }),
      business_snapshot: JSON.stringify(settings),
      client_snapshot: JSON.stringify(client),
      created: now(),
    };
    store.db
      .prepare(
        "INSERT INTO cash_receipts(id,client_id,number,amount,paid_date,method,account,reference,note,dedupe_key,business_snapshot,client_snapshot,created) VALUES(:id,:client_id,:number,:amount,:paid_date,:method,:account,:reference,:note,:dedupe_key,:business_snapshot,:client_snapshot,:created)",
      )
      .run(receipt);
    store.db
      .prepare("INSERT INTO payments(id,invoice_id,amount,paid_date,method,reference,note,receipt_id,proof_id,created) VALUES(?,?,?,?,?,?,?,?,NULL,?)")
      .run(randomUUID(), draft.id, paid, paid_date, "Other", reference, "Imported opening balance", receipt.id, now());
    store.audit("import.receipt", receipt.id, `${receipt.number}: ${paid} sen for ${number}`, null, { invoice: number, amount: paid, paid_date });
    records.push(["receipt", receipt.id]);
  }
  store.audit("import.invoice", draft.id, number, null, { number, status: status || (paid ? (paid === draft.total ? "paid" : "partial") : "unpaid"), total: draft.total, paid });
  const label = status === "void" ? "Void" : paid === draft.total ? "Paid" : paid ? "Part-paid" : "Unpaid";
  return { entities: records, summary: `${number} / ${client.name} / RM${(draft.total / 100).toFixed(2)} / ${label}` };
}

// Runs the import inside one transaction. With commit=false (preview) or when
// any row fails, everything is rolled back; otherwise it is committed.
export function runImport(store, kind, csv, { commit = false } = {}) {
  check(IMPORT_KINDS.includes(kind), "Choose clients, services or invoices.", 404);
  check(typeof csv === "string" && Buffer.byteLength(csv) <= MAX_IMPORT_BYTES, "The file must be 1 MB or smaller.", 413);
  const sha256 = createHash("sha256").update(csv).digest("hex");
  const rows = readRows(kind, csv);
  const units =
    kind === "invoices"
      ? invoiceUnits(rows)
      : rows.map((r) => ({ lines: [r.line], data: r.data, error: r.extra ? `Row ${r.line} has more values than the header.` : null }));
  // Duplicates inside the file are mistakes, not skips.
  if (kind !== "invoices") {
    const seen = new Map();
    for (const u of units) {
      const k = (u.data.name || "").trim().toLowerCase();
      if (k && seen.has(k)) u.error = u.error || `Same name as row ${seen.get(k)}.`;
      else if (k) seen.set(k, u.lines[0]);
    }
  }
  const actor = requestContext.getStore()?.actor || "system";
  const run = () => {
    const db = store.db;
    check(!store._transaction, "Another change is in progress. Try again.", 409);
    db.exec("BEGIN IMMEDIATE");
    store._transaction = true;
    const results = [];
    let committed = false;
    try {
      for (const u of units) {
        const out = { lines: u.lines, status: "ok", message: "", summary: "" };
        if (u.error && kind !== "invoices") {
          Object.assign(out, { status: "error", message: u.error });
          results.push(out);
          continue;
        }
        db.exec("SAVEPOINT import_row");
        try {
          const r = kind === "clients" ? applyClient(store, u.data) : kind === "services" ? applyService(store, u.data) : applyInvoice(store, u);
          db.exec("RELEASE import_row");
          if (r.skip) Object.assign(out, { status: "skip", message: r.message, summary: u.data?.name || u.number });
          else Object.assign(out, { summary: r.summary, entities: r.entities || [r.entity] });
        } catch (e) {
          db.exec("ROLLBACK TO import_row");
          db.exec("RELEASE import_row");
          Object.assign(out, { status: "error", message: e instanceof AppError ? e.message : "This row could not be imported.", summary: u.data?.name || u.number || "" });
        }
        results.push(out);
      }
      const errors = results.filter((r) => r.status === "error").length;
      const created = results.filter((r) => r.status === "ok").length;
      const skipped = results.filter((r) => r.status === "skip").length;
      let batch = null;
      if (commit && !errors && created) {
        batch = randomUUID();
        db.prepare("INSERT INTO platform_imports(id,kind,file_sha256,rows,created_count,skipped_count,actor,created) VALUES(?,?,?,?,?,?,?,?)").run(
          batch,
          kind,
          sha256,
          rows.length,
          created,
          skipped,
          actor,
          now(),
        );
        for (const r of results) for (const [type, id] of r.entities || []) db.prepare("INSERT INTO platform_import_records(import_id,entity_type,entity_id) VALUES(?,?,?)").run(batch, type, id);
        store.audit("import.completed", batch, `${kind}: ${created} imported, ${skipped} skipped`);
        db.exec("COMMIT");
        committed = true;
      } else db.exec("ROLLBACK");
      return {
        kind,
        sha256,
        rows: rows.length,
        units: results.length,
        created,
        skipped,
        errors,
        imported: committed,
        batch,
        results: results.map(({ entities, ...r }) => r),
      };
    } catch (e) {
      if (!committed) db.exec("ROLLBACK");
      throw e;
    } finally {
      store._transaction = false;
    }
  };
  // Imported records are marked by the actor so webhooks and notifications skip them.
  return requestContext.run({ actor: actor.startsWith("import:") ? actor : "import:" + actor }, run);
}

export function importHistory(store, limit = 10) {
  return store.db.prepare("SELECT id,kind,rows,created_count,skipped_count,actor,created FROM platform_imports ORDER BY created DESC LIMIT ?").all(limit);
}
