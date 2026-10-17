// Tax and compliance: SST-02 worksheet, SST on notes, exemptions, LHDN MyInvois e-Invoice, readiness checks and tax threshold monitor.
// Feature module contract: see docs/PLUGINS.md. Rules and sources: docs/features/tax.md.
import { AppError, check, date, id, money, now, text, today, integer } from "../domain.mjs";
import { qrDataUri, qrSvg } from "../qr.mjs";
import {
  CLASSIFICATION_CODES,
  COMMON_COUNTRIES,
  COMMON_MSIC,
  COUNTRY_CODES,
  EINVOICE_TYPES,
  GENERAL_TINS,
  ID_TYPES,
  MSIC_CODES,
  STATE_CODES,
  validIdNumber,
} from "../tax-codes.mjs";
import {
  TAX_DEFAULTS,
  chosenGross,
  noteTaxLines,
  parseTaxLines,
  recentPeriods,
  sst02,
  taxSettings,
  thresholdMonitor,
  validMonth,
} from "../tax-sst.mjs";
import {
  CANCEL_WINDOW_MS,
  EInvoices,
  MyInvoisApi,
  SECRET_NAMES,
  cleanSeller,
  consolidateMode,
  consolidationCandidates,
  lineClasses,
  readiness,
  supplierGaps,
  validationUrl,
} from "../tax-myinvois.mjs";
import { certificateInfo } from "../tax-ubl.mjs";
import { renderSelfBilledPdf, renderSst02Pdf } from "../tax-pdf.mjs";

const MIGRATIONS = [
  {
    // Client, service and note fields. Client columns are copied into the issued
    // document's client snapshot, so the buyer details are locked at issue.
    name: "tax-001-fields",
    sql: `
ALTER TABLE clients ADD COLUMN tax_exempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN tax_exempt_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN tax_exempt_until TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN tax_id_type TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN tax_addr_lines TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN tax_city TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN tax_postcode TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN tax_state TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN tax_country TEXT NOT NULL DEFAULT 'MYS';
ALTER TABLE clients ADD COLUMN tax_einvoice TEXT NOT NULL DEFAULT 'individual';
ALTER TABLE services ADD COLUMN tax_class TEXT NOT NULL DEFAULT '';
ALTER TABLE adjustments ADD COLUMN tax_lines TEXT;
ALTER TABLE adjustments ADD COLUMN tax_from_lines TEXT NOT NULL DEFAULT '';`,
  },
  {
    name: "tax-002-tables",
    sql: `
CREATE TABLE tax_settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
CREATE TABLE tax_doc_meta(document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE, default_class TEXT NOT NULL DEFAULT '', exempt_ref TEXT NOT NULL DEFAULT '', exempt_until TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL);
CREATE TABLE tax_line_classes(document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, line INTEGER NOT NULL, code TEXT NOT NULL, PRIMARY KEY(document_id,line));
CREATE TABLE tax_einvoices(id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(source IN ('invoice','credit','debit','refund','consolidated','selfbilled')), source_id TEXT NOT NULL, type_code TEXT NOT NULL, code_number TEXT NOT NULL, version TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')), state TEXT NOT NULL CHECK(state IN ('queued','sending','submitted','valid','invalid','rejected','cancelled','failed','unknown')), submission_uid TEXT, uuid TEXT, long_id TEXT, document_hash TEXT, payload TEXT, issued_at TEXT, errors TEXT, total INTEGER NOT NULL DEFAULT 0, submitted_at TEXT, validated_at TEXT, cancelled_at TEXT, cancel_reason TEXT, reject_requested TEXT, checks INTEGER NOT NULL DEFAULT 0, next_check TEXT, dedupe_key TEXT UNIQUE, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE INDEX tax_einvoice_source_idx ON tax_einvoices(source,source_id);
CREATE UNIQUE INDEX tax_einvoice_active_idx ON tax_einvoices(source,source_id) WHERE state IN ('queued','sending','submitted','valid','unknown');
CREATE TABLE tax_consolidated(id TEXT PRIMARY KEY, month TEXT NOT NULL, number TEXT NOT NULL UNIQUE, created TEXT NOT NULL);
CREATE TABLE tax_consolidated_items(consolidated_id TEXT NOT NULL REFERENCES tax_consolidated(id) ON DELETE CASCADE, document_id TEXT NOT NULL UNIQUE REFERENCES documents(id), PRIMARY KEY(consolidated_id,document_id));
CREATE TABLE tax_selfbilled(id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, type_code TEXT NOT NULL CHECK(type_code IN ('11','12','13','14')), ref_id TEXT REFERENCES tax_selfbilled(id), issue_date TEXT NOT NULL, supplier TEXT NOT NULL, lines TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'MYR', fx_rate TEXT NOT NULL DEFAULT '1', subtotal INTEGER NOT NULL, tax INTEGER NOT NULL, total INTEGER NOT NULL, notes TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE TABLE tax_refund_refs(refund_id TEXT PRIMARY KEY REFERENCES refunds(id), reference_id TEXT NOT NULL REFERENCES documents(id));`,
  },
];

const SECRETS = [
  { name: SECRET_NAMES.id, label: "MyInvois client ID", help: "MyInvois portal > Taxpayer profile > ERP system. Start with the sandbox (preprod) ID.", secret: false },
  { name: SECRET_NAMES.secret, label: "MyInvois client secret", help: "Shown once when you register the ERP system in the MyInvois portal.", secret: true },
  { name: SECRET_NAMES.env, label: "MyInvois environment", help: "sandbox (default) or production.", secret: false },
  { name: SECRET_NAMES.key, label: "e-Invoice signing private key (PEM)", help: "Only for signed version 1.1 documents. Convert a .p12 with: openssl pkcs12 -in cert.p12 -nodes -out key.pem", secret: true },
  { name: SECRET_NAMES.cert, label: "e-Invoice signing certificate (PEM)", help: "The certificate issued to your business by a Malaysian certificate authority.", secret: false },
  { name: SECRET_NAMES.passphrase, label: "Signing key passphrase", help: "Leave empty if the key has no passphrase.", secret: true },
];

// The client's SST exemption applies on a day when it is set and not expired.
export const exemptOn = (c, day) =>
  !!c?.tax_exempt && !!c.tax_exempt_ref && (!c.tax_exempt_until || (typeof day === "string" && c.tax_exempt_until >= day));
const flag = (v) => v === true || v === "on" || v === "1" || v === 1;
const field = (b, k, max) => (k in b ? text(String(b[k] ?? ""), max) : undefined);
const csvCell = (v) => {
  let s = String(v ?? "");
  if (/^[\s]*[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
};
const csv = (rows) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
const dec = (sen) => (sen / 100).toFixed(2);

function einvFor(store) {
  if (!store._taxEinv) store._taxEinv = new EInvoices(store, new MyInvoisApi(store));
  return store._taxEinv;
}
function cleanSettings(b, old) {
  const out = { ...old };
  if ("sstPeriodMonths" in b) out.sstPeriodMonths = integer(b.sstPeriodMonths, 1, 6);
  if ("sstPeriodStart" in b) out.sstPeriodStart = integer(b.sstPeriodStart, 1, 12);
  if ("serviceTaxBasis" in b) {
    check(["payment", "invoice"].includes(b.serviceTaxBasis), "Choose payment or invoice basis.");
    out.serviceTaxBasis = b.serviceTaxBasis;
  }
  for (const k of ["sstThreshold", "einvoiceThreshold"])
    if (k in b) {
      out[k] = money(b[k]);
      check(out[k] >= 1000000, "Thresholds must be at least RM10,000.");
    }
  if ("msic" in b) {
    out.msic = text(String(b.msic), 5);
    check(!out.msic || MSIC_CODES.has(out.msic), "Enter a valid 5-digit MSIC code.");
  }
  if ("activity" in b) out.activity = text(String(b.activity), 300);
  if ("idType" in b) {
    check(ID_TYPES[b.idType], "Choose an ID type.");
    out.idType = b.idType;
  }
  if ("addressLines" in b) {
    out.addressLines = text(String(b.addressLines), 450);
    check(out.addressLines.split(/\r?\n/).filter(Boolean).length <= 3, "Use at most 3 address lines.");
  }
  if ("city" in b) out.city = text(String(b.city), 50);
  if ("postcode" in b) out.postcode = text(String(b.postcode), 10);
  if ("state" in b) {
    check(!b.state || STATE_CODES[b.state], "Choose a state.");
    out.state = b.state || "";
  }
  if ("country" in b) {
    check(COUNTRY_CODES.has(b.country), "Choose a country.");
    out.country = b.country;
  }
  if (out.country === "MYS" && out.postcode) check(/^\d{5}$/.test(out.postcode), "Use a 5-digit postcode.");
  if ("defaultClass" in b) {
    check(!b.defaultClass || CLASSIFICATION_CODES[b.defaultClass], "Choose a classification code.");
    out.defaultClass = b.defaultClass || "";
  }
  if ("autoSubmit" in b) out.autoSubmit = flag(b.autoSubmit);
  return out;
}
function clientTaxFields(store, b, c) {
  const has = "tax_fields" in b || Object.keys(b).some((k) => k.startsWith("tax_"));
  if (!has) return null;
  const out = {
    tax_exempt: "tax_exempt" in b ? (flag(b.tax_exempt) ? 1 : 0) : "tax_fields" in b ? 0 : c?.tax_exempt || 0,
    tax_exempt_ref: field(b, "tax_exempt_ref", 60) ?? c?.tax_exempt_ref ?? "",
    tax_exempt_until: field(b, "tax_exempt_until", 10) ?? c?.tax_exempt_until ?? "",
    tax_id_type: field(b, "tax_id_type", 10) ?? c?.tax_id_type ?? "",
    tax_addr_lines: field(b, "tax_addr_lines", 450) ?? c?.tax_addr_lines ?? "",
    tax_city: field(b, "tax_city", 50) ?? c?.tax_city ?? "",
    tax_postcode: field(b, "tax_postcode", 10) ?? c?.tax_postcode ?? "",
    tax_state: field(b, "tax_state", 2) ?? c?.tax_state ?? "",
    tax_country: (field(b, "tax_country", 3) ?? c?.tax_country ?? "MYS").toUpperCase() || "MYS",
    tax_einvoice: field(b, "tax_einvoice", 12) ?? c?.tax_einvoice ?? "individual",
  };
  if (out.tax_exempt) check(out.tax_exempt_ref, "Enter the exemption reference or certificate number.");
  if (out.tax_exempt_until) date(out.tax_exempt_until);
  check(!out.tax_id_type || ID_TYPES[out.tax_id_type], "Choose an ID type: BRN, NRIC, passport or army.");
  const idValue = text(String(b.brn ?? c?.brn ?? ""), 40);
  if (out.tax_id_type && idValue)
    check(validIdNumber(out.tax_id_type, idValue), `The registration / IC number does not look like a ${ID_TYPES[out.tax_id_type]} number.`);
  check(out.tax_addr_lines.split(/\r?\n/).filter(Boolean).length <= 3, "Use at most 3 address lines.");
  check(!out.tax_state || STATE_CODES[out.tax_state], "Choose a state from the list.");
  check(COUNTRY_CODES.has(out.tax_country), "Choose a country from the list.");
  if (out.tax_country === "MYS" && out.tax_postcode) check(/^\d{5}$/.test(out.tax_postcode), "Use a 5-digit postcode.");
  check(["individual", "consolidate"].includes(out.tax_einvoice), "Choose how this client gets e-Invoices.");
  return out;
}

function attach(Store) {
  const originalClient = Store.prototype.saveClient,
    originalDocument = Store.prototype.saveDocument,
    originalIssue = Store.prototype.issue,
    originalAdjustment = Store.prototype.adjustment,
    originalVoid = Store.prototype.void,
    originalReport = Store.prototype.sstReport,
    originalBlocks = Store.prototype.pdfBlocks;
  Object.assign(Store.prototype, {
    saveClient(b, idv) {
      return this.tx(() => {
        const before = idv ? this.db.prepare("SELECT * FROM clients WHERE id=?").get(idv) : null;
        const fields = clientTaxFields(this, b, before);
        const out = originalClient.call(this, b, idv);
        if (!fields) return out;
        this.db
          .prepare(`UPDATE clients SET ${Object.keys(fields).map((k) => `${k}=:${k}`).join(",")} WHERE id=:id`)
          .run({ ...fields, id: out.id });
        const pick = (c) => (c ? Object.fromEntries(Object.keys(fields).map((k) => [k, c[k]])) : null);
        this.audit("client.tax.changed", out.id, "Tax and e-Invoice details", pick(before), fields);
        return this.client(out.id);
      });
    },
    // Exempt clients are charged no SST while the exemption is valid on the issue date.
    saveDocument(b, idv) {
      return this.tx(() => {
        const c = b?.client_id ? this.db.prepare("SELECT * FROM clients WHERE id=?").get(b.client_id) : null;
        const exempt = exemptOn(c, b?.issue_date);
        let body = b;
        if (exempt && Array.isArray(b.items) && b.items.some((i) => Number(i?.tax_rate || 0) > 0))
          body = { ...b, items: b.items.map((i) => ({ ...i, tax_rate: 0 })) };
        let defaultClass;
        if (b && "tax_class" in b) {
          defaultClass = String(b.tax_class || "");
          check(!defaultClass || CLASSIFICATION_CODES[defaultClass], "Choose an e-Invoice classification code.");
        }
        const out = originalDocument.call(this, body, idv);
        const old = this.db.prepare("SELECT * FROM tax_doc_meta WHERE document_id=?").get(out.id);
        if (old || exempt || defaultClass) {
          this.db
            .prepare(
              "INSERT INTO tax_doc_meta(document_id,default_class,exempt_ref,exempt_until,updated) VALUES(?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET default_class=excluded.default_class,exempt_ref=excluded.exempt_ref,exempt_until=excluded.exempt_until,updated=excluded.updated",
            )
            .run(out.id, defaultClass ?? old?.default_class ?? "", exempt ? c.tax_exempt_ref : "", exempt ? c.tax_exempt_until : "", now());
          if (exempt && body !== b) this.audit("document.sst.exempted", out.id, `No SST: customer exemption ${c.tax_exempt_ref}`);
        }
        return out;
      });
    },
    issue(idv) {
      const d = this.document(idv);
      if (d.state === "draft") {
        const c = this.db.prepare("SELECT * FROM clients WHERE id=?").get(d.client_id);
        const meta = this.db.prepare("SELECT exempt_ref FROM tax_doc_meta WHERE document_id=?").get(idv);
        const exempt = exemptOn(c, d.issue_date);
        check(
          !(exempt && d.tax > 0),
          `This client has an SST exemption (${c?.tax_exempt_ref}) on the issue date. Save the draft again to remove SST before issuing.`,
          409,
        );
        check(
          !(meta?.exempt_ref && !exempt),
          `The client's SST exemption (${meta?.exempt_ref}) is no longer valid on the issue date. Edit the draft so SST is charged, or update the exemption.`,
          409,
        );
      }
      return this.tx(() => {
        const out = originalIssue.call(this, idv);
        if (out.kind === "invoice" && !consolidateMode(out.client)) einvFor(this).queue("invoice", out.id);
        return out;
      });
    },
    // Notes carry their own SST split; the amount stays tax-inclusive.
    adjustment(invoiceId, b) {
      return this.tx(() => {
        const d = this.document(invoiceId);
        let lines = null;
        if (b.tax_lines_from !== undefined && b.tax_lines_from !== null && b.tax_lines_from !== "") {
          const raw = Array.isArray(b.tax_lines_from) ? b.tax_lines_from : String(b.tax_lines_from).split(",");
          check(raw.length >= 1 && raw.length <= 50, "Choose the invoice lines for this note.");
          lines = raw.map((n) => Number(n));
          check(lines.every((n) => Number.isInteger(n) && n >= 0 && n < d.items.length), "Choose lines from this invoice.");
          lines = [...new Set(lines)].sort((x, y) => x - y);
          if (b.kind === "credit" && /^\d{1,8}(\.\d{1,2})?$/.test(String(b.amount)))
            check(money(b.amount) <= chosenGross(d, lines), "The credit is larger than the chosen lines.");
        }
        const a = originalAdjustment.call(this, invoiceId, b);
        const rows = noteTaxLines(d, a.amount, lines);
        const from = lines ? lines.map((n) => n + 1).join(",") : "";
        this.db.prepare("UPDATE adjustments SET tax_lines=?,tax_from_lines=? WHERE id=?").run(JSON.stringify(rows), from, a.id);
        const einv = einvFor(this);
        if (einv.reference(invoiceId)) einv.queue(a.kind, a.id);
        return { ...a, tax_lines: JSON.stringify(rows), tax_from_lines: from };
      });
    },
    void(idv, reason) {
      return this.tx(() => {
        const einv = einvFor(this);
        const active = einv.active("invoice", idv);
        if (active?.state === "queued")
          einv.set(active.id, { state: "failed", errors: [{ code: "", message: "Invoice voided before submission." }] });
        else
          check(
            !active,
            active?.state === "valid"
              ? "This invoice has a valid e-Invoice. Cancel the e-Invoice first (within 72 hours of validation) or issue a credit note."
              : "This invoice is being submitted to MyInvois. Wait for the result before voiding.",
            409,
          );
        return originalVoid.call(this, idv, reason);
      });
    },
    // Notes now carry an SST split, so they adjust the SST summary by rate.
    sstReport(b = {}) {
      const r = originalReport.call(this, b);
      const notes = this.db
        .prepare(
          "SELECT a.*,d.number invoice FROM adjustments a JOIN documents d ON d.id=a.invoice_id WHERE a.issue_date BETWEEN ? AND ? ORDER BY a.issue_date",
        )
        .all(r.from, r.to);
      const rates = new Map(r.rates.map((x) => [x.rate, { ...x }]));
      const withLines = new Set();
      for (const a of notes) {
        const lines = parseTaxLines(a);
        if (!lines) continue;
        withLines.add(a.number);
        const sign = a.kind === "credit" ? -1 : 1;
        const d = this.document(a.invoice_id);
        for (const l of lines) {
          const total = rates.get(l.rate) || { rate: l.rate, taxable: 0, tax: 0 };
          total.taxable += sign * l.taxable;
          total.tax += sign * l.tax;
          rates.set(l.rate, total);
          r.rows.push({
            number: a.number,
            issue_date: a.issue_date,
            client: d.client.name,
            client_tin: d.client.tin || "",
            rate: l.rate,
            taxable: sign * l.taxable,
            tax: sign * l.tax,
            note: a.kind,
            invoice: a.invoice,
          });
        }
      }
      r.rates = [...rates.values()].sort((x, y) => x.rate - y.rate);
      r.tax = r.rows.reduce((s, x) => s + x.tax, 0);
      r.notes = r.notes.filter((n) => !withLines.has(n.number));
      return r;
    },
    // Exemption reference and the MyInvois validation QR on the PDF.
    async pdfBlocks(d, ...rest) {
      const blocks = await originalBlocks.call(this, d, ...rest);
      const einv = einvFor(this);
      if (d?.note) {
        const source = d.note.kind === "refund" ? "refund" : d.note.kind;
        const e = this.db.prepare("SELECT * FROM tax_einvoices WHERE source=? AND source_id=? AND state='valid'").get(source, d.note.id);
        if (e) blocks.push(qrBlock(e));
        return blocks;
      }
      if (!d?.id || d.kind !== "invoice") {
        const meta = d?.id ? this.db.prepare("SELECT * FROM tax_doc_meta WHERE document_id=?").get(d.id) : null;
        if (meta?.exempt_ref) blocks.push(exemptBlock(meta));
        return blocks;
      }
      const meta = this.db.prepare("SELECT * FROM tax_doc_meta WHERE document_id=?").get(d.id);
      if (meta?.exempt_ref) blocks.push(exemptBlock(meta));
      const e = this.db.prepare("SELECT * FROM tax_einvoices WHERE source='invoice' AND source_id=? AND state='valid'").get(d.id);
      if (e) blocks.push(qrBlock(e));
      else {
        const con = einv.reference(d.id);
        if (con?.consolidated)
          blocks.push({ heading: "e-Invoice", text: `Reported to LHDN MyInvois in consolidated e-Invoice ${con.code_number} (UUID ${con.uuid}).` });
      }
      return blocks;
    },
  });
}
const exemptBlock = (meta) => ({
  heading: "SST exemption",
  text: `No SST is charged on this document. Customer exemption reference: ${meta.exempt_ref}${meta.exempt_until ? `, valid until ${meta.exempt_until}` : ""}.`,
});
function qrBlock(e) {
  const url = validationUrl(e.environment, e.uuid, e.long_id);
  return {
    heading: "LHDN MyInvois e-Invoice",
    text: `${e.environment === "sandbox" ? "SANDBOX TEST - not a real e-Invoice\n" : ""}Validated: ${String(e.validated_at || "").replace("T", " ").slice(0, 19)}\nUUID: ${e.uuid}${url ? "\nScan the code or open: " + url : "\nThe validation link appears once MyInvois returns the long ID."}`,
    ...(url ? { qr: url, qrSize: 92 } : {}),
    footer: `Validated MyInvois e-Invoice ${e.uuid}`,
  };
}
const einvoiceView = (e) =>
  e && {
    id: e.id,
    source: e.source,
    source_id: e.source_id,
    type_code: e.type_code,
    code_number: e.code_number,
    version: e.version,
    environment: e.environment,
    state: e.state,
    submission_uid: e.submission_uid,
    uuid: e.uuid,
    long_id: e.long_id,
    url: validationUrl(e.environment, e.uuid, e.long_id),
    errors: e.errors ? JSON.parse(e.errors) : [],
    total: e.total,
    issued_at: e.issued_at,
    submitted_at: e.submitted_at,
    validated_at: e.validated_at,
    cancel_until: e.state === "valid" && e.validated_at ? new Date(Date.parse(e.validated_at) + CANCEL_WINDOW_MS).toISOString() : null,
    cancelled_at: e.cancelled_at,
    cancel_reason: e.cancel_reason,
    reject_requested: e.reject_requested,
    created: e.created,
  };

function saveSelfBilled(store, b) {
  return store.tx(() => {
    const type = String(b.type_code || "11");
    check(["11", "12", "13", "14"].includes(type), "Choose a self-billed document type.");
    let ref = null;
    if (type !== "11") {
      ref = store.db.prepare("SELECT * FROM tax_selfbilled WHERE id=?").get(b.ref_id);
      check(ref && ref.type_code === "11", "Choose the original self-billed invoice.");
    }
    const seller = cleanSeller(b.supplier || {});
    const issue_date = date(b.issue_date || today());
    check(issue_date <= today(), "The issue date cannot be in the future.");
    const currency = text(b.currency || "MYR", 3, true).toUpperCase();
    check(/^[A-Z]{3}$/.test(currency), "Use a 3-letter currency code.");
    const fx = currency === "MYR" ? "1" : text(String(b.fx_rate || ""), 20, true);
    check(/^\d{1,9}(\.\d{1,10})?$/.test(fx) && Number(fx) > 0, "Enter the exchange rate to MYR.");
    check(Array.isArray(b.lines) && b.lines.length >= 1 && b.lines.length <= 50, "Add between 1 and 50 lines.");
    const lines = b.lines.map((l) => {
      const q = String(l.quantity ?? "1");
      check(/^\d{1,5}(\.\d{1,2})?$/.test(q) && Number(q) > 0, "Quantity must be positive with at most 2 decimal places.");
      const rate = money(l.rate);
      const amount = Math.round(rate * Number(q));
      const tax_rate = Number(l.tax_rate || 0);
      check([0, 5, 6, 8, 10].includes(tax_rate), "Choose an SST rate of 0, 5, 6, 8 or 10%.");
      const cls = String(l.class || "");
      check(CLASSIFICATION_CODES[cls], "Choose a classification code for each line.");
      return { description: text(l.description, 300, true), quantity: Number(q), rate, amount, tax_rate, tax: Math.round((amount * tax_rate) / 100), class: cls };
    });
    const subtotal = lines.reduce((s, l) => s + l.amount, 0),
      tax = lines.reduce((s, l) => s + l.tax, 0);
    check(subtotal > 0 && subtotal + tax <= 9999999999, "Enter a positive total.");
    const row = {
      id: id(),
      number: store.number("SB", issue_date),
      type_code: type,
      ref_id: ref?.id || null,
      issue_date,
      supplier: JSON.stringify(seller),
      lines: JSON.stringify(lines),
      currency,
      fx_rate: fx,
      subtotal,
      tax,
      total: subtotal + tax,
      notes: text(b.notes || "", 1000),
      created: now(),
    };
    store.db
      .prepare(
        "INSERT INTO tax_selfbilled(id,number,type_code,ref_id,issue_date,supplier,lines,currency,fx_rate,subtotal,tax,total,notes,created) VALUES(:id,:number,:type_code,:ref_id,:issue_date,:supplier,:lines,:currency,:fx_rate,:subtotal,:tax,:total,:notes,:created)",
      )
      .run(row);
    store.audit("selfbilled.created", row.id, `${row.number} (${EINVOICE_TYPES[type]}) for ${seller.name}`, null, { total: row.total });
    return row;
  });
}
function createConsolidation(store, einv, month) {
  return store.tx(() => {
    month = validMonth(month);
    const c = consolidationCandidates(store, month, einv);
    check(c.closed, "A consolidated e-Invoice covers a whole month. Wait until the month has ended.", 409);
    check(c.ready.length, "There are no unreported invoices for consolidation in this month.", 409);
    const seq =
      Math.max(0, ...store.db.prepare("SELECT number FROM tax_consolidated WHERE month=?").all(month).map((x) => Number(x.number.slice(-2)))) + 1;
    const row = { id: id(), month, number: `CON-${month}-${String(seq).padStart(2, "0")}`, created: now() };
    store.db.prepare("INSERT INTO tax_consolidated(id,month,number,created) VALUES(:id,:month,:number,:created)").run(row);
    const add = store.db.prepare("INSERT INTO tax_consolidated_items(consolidated_id,document_id) VALUES(?,?)");
    for (const d of c.ready) add.run(row.id, d.id);
    store.audit("einvoice.consolidated.created", row.id, `${row.number}: ${c.ready.length} invoice(s)`);
    return { ...row, count: c.ready.length };
  });
}
function consolidations(store, einv) {
  return store.db
    .prepare("SELECT c.*,(SELECT count(*) FROM tax_consolidated_items i WHERE i.consolidated_id=c.id) count FROM tax_consolidated c ORDER BY c.created DESC")
    .all()
    .map((c) => ({
      ...c,
      documents: store.db.prepare("SELECT document_id FROM tax_consolidated_items WHERE consolidated_id=?").all(c.id).map((r) => r.document_id),
      einvoice: einvoiceView(einv.latest("consolidated", c.id)),
    }));
}
function exemptions(store) {
  const soon = new Date(Date.parse(today() + "T00:00:00Z") + 30 * 86400000).toISOString().slice(0, 10);
  const rows = store.db
    .prepare("SELECT id,name,tax_exempt_ref ref,tax_exempt_until until FROM clients WHERE tax_exempt=1 AND tax_exempt_until<>'' AND archived=0")
    .all();
  return {
    expired: rows.filter((r) => r.until < today()),
    expiring: rows.filter((r) => r.until >= today() && r.until <= soon),
  };
}
function codes(full = false) {
  return {
    classes: CLASSIFICATION_CODES,
    states: STATE_CODES,
    idTypes: ID_TYPES,
    countries: COMMON_COUNTRIES,
    msic: COMMON_MSIC,
    generalTins: GENERAL_TINS,
    types: EINVOICE_TYPES,
    allCountries: [...COUNTRY_CODES],
    ...(full ? { allMsic: [...MSIC_CODES] } : {}),
  };
}
const qp = (r, k) => r.url.searchParams.get(k) || undefined;

export default {
  name: "tax",
  // Staff submit and check e-Invoices and prepare consolidations; MyInvois keys,
  // settings, cancellations and the connection test stay with the owner.
  access: {
    staff: [
      ["GET", /^\/api\/tax\//],
      ["POST", /^\/api\/tax\/einvoices$/],
      ["POST", /^\/api\/tax\/einvoices\/[\w-]+\/check$/],
      ["PUT", /^\/api\/tax\/documents\/[\w-]+\/classes$/],
      ["POST", /^\/api\/tax\/(validate-tin|consolidated|selfbilled)$/],
    ],
    accountant: [["GET", /^\/api\/tax\//]],
  },
  migrations: MIGRATIONS,
  secrets: SECRETS,
  attach,
  init(ctx) {
    // One e-Invoice service per workspace; tests may swap ctx.services.tax.api.fetch.
    const api = new MyInvoisApi(ctx.store);
    const einvoices = new EInvoices(ctx.store, api);
    ctx.store._taxEinv = einvoices;
    ctx.services.tax = { api, einvoices };
  },
  routes: {
    async owner(r) {
      if (!r.path.startsWith("/api/tax/")) return false;
      const store = r.ctx.store,
        einv = r.ctx.services.tax.einvoices,
        api = r.ctx.services.tax.api;
      const s = () => taxSettings(store);
      const path = r.path.slice("/api/tax".length);
      if (path === "/settings" && r.method === "PUT") {
        const b = await r.body();
        const out = store.tx(() => {
          const old = taxSettings(store);
          const next = cleanSettings(b, old);
          store.db
            .prepare("INSERT INTO tax_settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
            .run(JSON.stringify(next));
          store.audit("tax.settings.changed", null, "Tax and e-Invoice settings", old, next);
          return next;
        });
        return r.send(200, out), true;
      }
      if (path === "/codes" && r.method === "GET") return r.send(200, codes(true)), true;
      if (/^\/sst02(\.csv|\.pdf)?$/.test(path) && r.method === "GET") {
        const ws = sst02(store, s(), { period: qp(r, "period") && validMonth(qp(r, "period")) });
        if (path === "/sst02") return r.send(200, ws), true;
        const name = `sst02-${ws.period.from}-${ws.period.to}`;
        if (path.endsWith(".pdf"))
          return (
            r.send(200, await renderSst02Pdf(ws), {
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename="${name}.pdf"`,
            }),
            true
          );
        const rows = [
          ["SST-02 working paper (not a submission; file on MySST)"],
          ["SST registration", ws.sstNumber],
          ["Business", ws.business],
          ["Taxable period", ws.period.from, ws.period.to],
          ["Return and payment due", ws.period.due],
          ["Service tax basis", ws.basis.service],
          [],
          ["Item", "Description", "Taxable value MYR", "Tax MYR"],
          ["11(a)", "Sales tax 5%", dec(ws.items["11a"].value), dec(ws.items["11a"].tax)],
          ["11(b)", "Sales tax 10%", dec(ws.items["11b"].value), dec(ws.items["11b"].tax)],
          ["11(c)", "Service tax 6%", dec(ws.items["11c"].value), dec(ws.items["11c"].tax)],
          ["11(d)", "Service tax 8%", dec(ws.items["11d"].value), dec(ws.items["11d"].tax)],
          ["11(e)", "Credit/charge card services (not tracked)", "0.00", "0.00"],
          ["12", "Total tax", "", dec(ws.item12)],
          ["13(a)", "Tax deduction from credit notes", "", dec(ws.deductions.a)],
          ["13(b)", "Approved sales tax deduction (enter on MySST)", "", "0.00"],
          ["13(c)", "Approved service tax deduction (enter on MySST)", "", "0.00"],
          ["13(d)", "Bad debt relief (after approval)", "", "0.00"],
          ["14", "Total tax payable before penalty", "", dec(ws.item14)],
          [],
          ["18", "Sales to SST-exempt customers", dec(ws.partD.exempt)],
          ["18", "Other sales without SST", dec(ws.partD.other)],
          [],
          ["Checks"],
          ...ws.warnings.map((w) => ["", w]),
          [],
          ["Item", "Date", "Document", "Kind", "Client", "Rate %", "Value MYR", "Tax MYR"],
          ...ws.rows.map((x) => [x.item, x.date, x.number, x.kind, x.client, x.rate, dec(x.value), dec(x.tax)]),
        ];
        return (
          r.send(200, csv(rows), {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${name}.csv"`,
          }),
          true
        );
      }
      const service = path.match(/^\/services\/([\w-]+)$/);
      if (service && r.method === "PUT") {
        const b = await r.body();
        const code = String(b.tax_class || "");
        check(!code || CLASSIFICATION_CODES[code], "Choose a classification code.");
        const row = store.db.prepare("SELECT id,tax_class FROM services WHERE id=?").get(service[1]);
        check(row, "Service not found.", 404);
        store.db.prepare("UPDATE services SET tax_class=? WHERE id=?").run(code, row.id);
        store.audit("service.tax_class.changed", row.id, code || "none", { tax_class: row.tax_class }, { tax_class: code });
        return r.send(200, { id: row.id, tax_class: code }), true;
      }
      const classes = path.match(/^\/documents\/([\w-]+)\/classes$/);
      if (classes && r.method === "PUT") {
        const b = await r.body();
        const d = store.document(classes[1]);
        check(["draft", "issued"].includes(d.state), "This document cannot be changed.", 409);
        const e = einv.active("invoice", d.id);
        check(!e || ["queued"].includes(e.state), "The e-Invoice was already submitted. Classification can no longer change.", 409);
        check(b.lines && typeof b.lines === "object", "Choose a classification for the lines.");
        store.tx(() => {
          for (const [k, code] of Object.entries(b.lines)) {
            const n = Number(k);
            check(Number.isInteger(n) && n >= 0 && n < d.items.length, "Unknown line.");
            check(!code || CLASSIFICATION_CODES[code], "Choose a classification code.");
            if (code)
              store.db
                .prepare("INSERT INTO tax_line_classes(document_id,line,code) VALUES(?,?,?) ON CONFLICT(document_id,line) DO UPDATE SET code=excluded.code")
                .run(d.id, n, code);
            else store.db.prepare("DELETE FROM tax_line_classes WHERE document_id=? AND line=?").run(d.id, n);
          }
          store.audit("document.tax_class.changed", d.id, "e-Invoice classification", null, b.lines);
        });
        return r.send(200, { lines: lineClasses(store, d) }), true;
      }
      if (path === "/einvoices" && r.method === "POST") {
        r.allow("einvoice:" + r.session.owner_id, 30, 60000);
        const b = await r.body();
        check(["invoice", "credit", "debit", "refund", "consolidated", "selfbilled"].includes(b.source), "Choose what to submit.");
        check(typeof b.id === "string" && /^[\w-]{1,80}$/.test(b.id), "Choose what to submit.");
        const out = await einv.submit(b.source, b.id, { invoice_id: typeof b.invoice_id === "string" ? b.invoice_id : undefined });
        return r.send(201, einvoiceView(out)), true;
      }
      const qr = path.match(/^\/einvoices\/([\w-]+)\/qr\.svg$/);
      if (qr && r.method === "GET") {
        const row = einv.row(qr[1]);
        const url = row.state === "valid" && validationUrl(row.environment, row.uuid, row.long_id);
        check(url, "No validation link yet.", 404);
        return r.send(200, qrSvg(url), { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "private, max-age=3600" }), true;
      }
      const one = path.match(/^\/einvoices\/([\w-]+)(?:\/(check|cancel))?$/);
      if (one) {
        if (!one[2] && r.method === "GET") {
          const row = einv.row(one[1]);
          return r.send(200, { ...einvoiceView(row), payload: row.payload ? JSON.parse(row.payload) : null }), true;
        }
        if (one[2] === "check" && r.method === "POST") {
          r.allow("einvoice-check:" + r.session.owner_id, 30, 60000);
          return r.send(200, einvoiceView(await einv.refresh(one[1]))), true;
        }
        if (one[2] === "cancel" && r.method === "POST") {
          r.allow("einvoice-cancel:" + r.session.owner_id, 12, 60000);
          const b = await r.body();
          return r.send(200, einvoiceView(await einv.cancel(one[1], b.reason))), true;
        }
      }
      if (path === "/consolidated" && r.method === "GET")
        return r.send(200, consolidationCandidates(store, validMonth(qp(r, "month") || ""), einv)), true;
      if (path === "/consolidated" && r.method === "POST") {
        const b = await r.body();
        return r.send(201, r.write("tax.consolidated", b, () => createConsolidation(store, einv, b.month))), true;
      }
      const con = path.match(/^\/consolidated\/([\w-]+)$/);
      if (con && r.method === "DELETE") {
        store.tx(() => {
          const row = store.db.prepare("SELECT * FROM tax_consolidated WHERE id=?").get(con[1]);
          check(row, "Consolidated e-Invoice not found.", 404);
          check(!einv.active("consolidated", row.id), "This consolidated e-Invoice was submitted. Cancel it in MyInvois first.", 409);
          check(
            !store.db.prepare("SELECT 1 FROM tax_einvoices WHERE source='consolidated' AND source_id=? AND state IN ('valid','cancelled')").get(row.id),
            "A validated consolidated e-Invoice is kept for the record.",
            409,
          );
          store.db.prepare("DELETE FROM tax_einvoices WHERE source='consolidated' AND source_id=?").run(row.id);
          store.db.prepare("DELETE FROM tax_consolidated WHERE id=?").run(row.id);
          store.audit("einvoice.consolidated.deleted", row.id, row.number);
        });
        return r.send(200, { ok: true }), true;
      }
      if (path === "/selfbilled" && r.method === "POST") {
        const b = await r.body();
        return r.send(201, r.write("tax.selfbilled", b, () => saveSelfBilled(store, b))), true;
      }
      const sbPdf = path.match(/^\/selfbilled\/([\w-]+)\/pdf$/);
      if (sbPdf && r.method === "GET") {
        const sb = store.db.prepare("SELECT * FROM tax_selfbilled WHERE id=?").get(sbPdf[1]);
        check(sb, "Self-billed document not found.", 404);
        const e = einvoiceView(einv.latest("selfbilled", sb.id));
        return (
          r.send(200, await renderSelfBilledPdf(sb, store.settings(), e), {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${sb.number}.pdf"`,
          }),
          true
        );
      }
      if (path === "/validate-tin" && r.method === "POST") {
        r.allow("tin:" + r.session.owner_id, 20, 60000);
        const b = await r.body();
        const tin = text(String(b.tin || ""), 14, true).toUpperCase();
        check(ID_TYPES[b.id_type], "Choose an ID type.");
        const value = text(String(b.id_value || ""), 30, true);
        return r.send(200, { valid: await api.validateTin(tin, b.id_type, value) }), true;
      }
      if (path === "/test" && r.method === "POST") {
        r.allow("einvoice-test:" + r.session.owner_id, 6, 60000);
        const status = api.status();
        let signing = null;
        if (status.signing) {
          const info = certificateInfo(api.signing().certificate);
          signing = { subject: info.subject, issuer: info.issuer, validTo: info.validTo, expired: Date.parse(info.validTo) < Date.now() };
        }
        await api.token(true);
        store.audit("einvoice.connection.tested", null, `${status.env} sign-in succeeded`);
        return r.send(200, { ok: true, env: status.env, version: status.version, signing }), true;
      }
      return false;
    },
  },
  jobs: [
    {
      name: "einvoice",
      every: 60000,
      delay: 20000,
      async run(ctx) {
        return ctx.services.tax.einvoices.run();
      },
    },
  ],
  workspace(r) {
    const store = r.ctx.store,
      einv = r.ctx.services.tax.einvoices;
    const s = taxSettings(store);
    const gaps = supplierGaps(store, s);
    const ready = {},
      classes = {};
    for (const d of store.documents()) {
      if (d.kind !== "invoice" || d.state === "void") continue;
      ready[d.id] = readiness(store, d, s, gaps);
      classes[d.id] = lineClasses(store, d, s);
    }
    const last = today().slice(0, 7);
    const prev = new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
    return {
      settings: s,
      status: r.ctx.services.tax.api.status(),
      codes: codes(),
      supplierGaps: gaps,
      einvoices: store.db.prepare("SELECT * FROM tax_einvoices ORDER BY created DESC").all().map(einvoiceView),
      ready,
      classes,
      consolidated: consolidations(store, einv),
      candidates: consolidationCandidates(store, prev, einv),
      selfbilled: store.db
        .prepare("SELECT id,number,type_code,ref_id,issue_date,supplier,currency,total,created FROM tax_selfbilled ORDER BY created DESC")
        .all()
        .map((x) => ({ ...x, supplier: JSON.parse(x.supplier).name, einvoice: einvoiceView(einv.latest("selfbilled", x.id)) })),
      refundRefs: Object.fromEntries(store.db.prepare("SELECT refund_id,reference_id FROM tax_refund_refs").all().map((x) => [x.refund_id, x.reference_id])),
      thresholds: thresholdMonitor(store, s),
      exemptions: exemptions(store),
      periods: recentPeriods(s),
    };
  },
  // Client-safe: the validation link is printed on the e-Invoice anyway.
  publicDocument(d, r) {
    const store = r.ctx.store;
    const meta = store.db.prepare("SELECT exempt_ref,exempt_until FROM tax_doc_meta WHERE document_id=?").get(d.id);
    const e = d.kind === "invoice" ? store.db.prepare("SELECT * FROM tax_einvoices WHERE source='invoice' AND source_id=? AND state='valid'").get(d.id) : null;
    const url = e && validationUrl(e.environment, e.uuid, e.long_id);
    return {
      einvoice: e ? { uuid: e.uuid, url, qr: url ? qrDataUri(url) : null, validated_at: e.validated_at, sandbox: e.environment === "sandbox" } : null,
      exemption: meta?.exempt_ref ? { ref: meta.exempt_ref, until: meta.exempt_until } : null,
    };
  },
  exportData(store) {
    return {
      settings: taxSettings(store),
      einvoices: store.db.prepare("SELECT * FROM tax_einvoices ORDER BY created").all().map(({ payload, ...e }) => e),
      consolidated: store.db.prepare("SELECT * FROM tax_consolidated ORDER BY created").all(),
      consolidatedItems: store.db.prepare("SELECT * FROM tax_consolidated_items").all(),
      selfbilled: store.db.prepare("SELECT * FROM tax_selfbilled ORDER BY created").all(),
      documentMeta: store.db.prepare("SELECT * FROM tax_doc_meta").all(),
      lineClasses: store.db.prepare("SELECT * FROM tax_line_classes").all(),
      refundRefs: store.db.prepare("SELECT * FROM tax_refund_refs").all(),
    };
  },
  // A restored copy must never resend: unsent work is checked against MyInvois
  // first and automatic submission is switched off.
  onRestore(db) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='tax_einvoices'").get()) return;
    db.prepare("UPDATE tax_einvoices SET state='unknown',next_check=? WHERE state IN ('queued','sending')").run(new Date().toISOString());
    const row = db.prepare("SELECT data FROM tax_settings WHERE id=1").get();
    if (row) db.prepare("UPDATE tax_settings SET data=? WHERE id=1").run(JSON.stringify({ ...JSON.parse(row.data), autoSubmit: false }));
  },
  seedDemo(store) {
    store.db
      .prepare("INSERT INTO tax_settings(id,data) VALUES(1,?) ON CONFLICT(id) DO NOTHING")
      .run(
        JSON.stringify({
          ...TAX_DEFAULTS,
          msic: "62010",
          activity: "Computer programming activities",
          addressLines: "Level 5, Demo Tower\nJalan Demo 1",
          city: "Kuala Lumpur",
          postcode: "50450",
          state: "14",
          country: "MYS",
        }),
      );
    store.db.prepare("UPDATE services SET tax_class='030' WHERE name='Managed maintenance'").run();
    const c = store.db.prepare("SELECT id FROM clients WHERE name='Meranti Digital (Demo)'").get();
    if (c)
      store.db
        .prepare("UPDATE clients SET tax_id_type='BRN',tax_addr_lines='No. 8, Jalan Demo',tax_city='Petaling Jaya',tax_postcode='46000',tax_state='10',tax_country='MYS' WHERE id=?")
        .run(c.id);
  },
};
