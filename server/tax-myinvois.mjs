// LHDN MyInvois e-Invoice: API client (taxpayer system login), document building
// from Kosongsatu records, readiness checks, and the submit → validate → cancel
// lifecycle. Endpoints follow the MyInvois SDK (sdk.myinvois.hasil.gov.my); see
// docs/features/tax.md for sources and the assumptions made.
import { AppError, check, id, now, text, today, addDays } from "./domain.mjs";
import {
  CLASSIFICATION_CODES,
  COUNTRY_CODES,
  GENERAL_TINS,
  ID_TYPES,
  MSIC_CODES,
  STATE_CODES,
  UNIT_CODES,
  normalizePhone,
  validIdNumber,
  validPhone,
  validTin,
} from "./tax-codes.mjs";
import { SALES_RATES, SERVICE_RATES, lineValues, noteLines, rateTotals, taxSettings, toMyr } from "./tax-sst.mjs";
import { buildDocument, issueStamp, signDocument, signingMaterial, submissionEntry } from "./tax-ubl.mjs";

// API and portal hosts. Only these are ever contacted.
export const HOSTS = {
  sandbox: { api: "https://preprod-api.myinvois.hasil.gov.my", portal: "https://preprod.myinvois.hasil.gov.my" },
  production: { api: "https://api.myinvois.hasil.gov.my", portal: "https://myinvois.hasil.gov.my" },
};
export const SECRET_NAMES = {
  id: "MYINVOIS_CLIENT_ID",
  secret: "MYINVOIS_CLIENT_SECRET",
  env: "MYINVOIS_ENV",
  key: "MYINVOIS_SIGNING_KEY",
  cert: "MYINVOIS_SIGNING_CERT",
  passphrase: "MYINVOIS_KEY_PASSPHRASE",
};
// Validation link printed as a QR code: {portal}/{uuid}/share/{longId}.
export const validationUrl = (env, uuid, longId) =>
  uuid && longId ? `${(HOSTS[env] || HOSTS.sandbox).portal}/${uuid}/share/${longId}` : null;
const ACTIVE = ["queued", "sending", "submitted", "valid", "unknown"];
export const CANCEL_WINDOW_MS = 72 * 3600000;
const B2C_LIMIT = 1000000; // RM10,000: larger sales need their own e-Invoice.

export class MyInvoisError extends AppError {
  constructor(message, status, upstream, body, network = false) {
    super(message, status);
    this.upstream = upstream;
    this.body = body;
    this.network = network;
  }
}
// LHDN errors: { error: { code, message, target, details: [{ code, message, target }] } }.
export function lhdnErrors(body) {
  const e = body?.error ?? body;
  if (!e) return [];
  if (typeof e === "string") return [{ code: "", message: e }];
  const out = [];
  const push = (x) =>
    x &&
    out.push({
      code: String(x.code || x.errorCode || ""),
      message: String(x.message || x.error || x.errorMS || "").slice(0, 500),
      target: String(x.target || x.propertyPath || x.propertyName || "").slice(0, 200),
    });
  if (e.message || e.code || e.errorCode || typeof e.error === "string") push(e);
  for (const d of e.details || []) push(d);
  for (const d of e.innerError || []) push(d);
  return out.filter((x) => x.message || x.code).slice(0, 30);
}

export class MyInvoisApi {
  constructor(store, { fetch: fetcher } = {}) {
    this.store = store;
    this.fetch = fetcher || globalThis.fetch;
    this.cache = null;
  }
  settings() {
    const c = (n) => this.store.config(n) || "";
    const env = c(SECRET_NAMES.env).toLowerCase() === "production" ? "production" : "sandbox";
    return {
      clientId: c(SECRET_NAMES.id),
      clientSecret: c(SECRET_NAMES.secret),
      env,
      key: c(SECRET_NAMES.key),
      cert: c(SECRET_NAMES.cert),
      passphrase: c(SECRET_NAMES.passphrase),
    };
  }
  status() {
    const s = this.settings();
    const signing = !!(s.key && (s.cert || /CERTIFICATE/.test(s.key)));
    return { configured: !!(s.clientId && s.clientSecret), env: s.env, signing, version: signing ? "1.1" : "1.0" };
  }
  signing() {
    const s = this.settings();
    return signingMaterial({ key: s.key, cert: s.cert, passphrase: s.passphrase });
  }
  async http(url, init, label) {
    let res, body;
    try {
      res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
      const raw = await res.text();
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = { error: raw.slice(0, 300) };
      }
    } catch {
      throw new MyInvoisError(`MyInvois could not be reached (${label}). Try again shortly.`, 502, 0, null, true);
    }
    return { res, body };
  }
  async token(force = false) {
    const s = this.settings();
    check(s.clientId && s.clientSecret, "Add your MyInvois client ID and client secret in Settings > Integration keys.", 409);
    const key = s.env + ":" + s.clientId;
    if (!force && this.cache?.key === key && this.cache.expires > Date.now()) return this.cache.token;
    const { res, body } = await this.http(
      HOSTS[s.env].api + "/connect/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          client_id: s.clientId,
          client_secret: s.clientSecret,
          grant_type: "client_credentials",
          scope: "InvoicingAPI",
        }).toString(),
      },
      "sign-in",
    );
    if (!res.ok || !body?.access_token)
      throw new MyInvoisError(
        res.status === 429
          ? "MyInvois sign-in is rate limited (12 per minute). Try again shortly."
          : "MyInvois did not accept the client ID and secret. Check the keys and the environment (sandbox or production).",
        res.status === 429 ? 429 : 502,
        res.status,
        body,
      );
    // Tokens last an hour; refresh a minute early.
    this.cache = { key, token: body.access_token, expires: Date.now() + Math.max(60, (body.expires_in || 3600) - 60) * 1000 };
    return this.cache.token;
  }
  async call(method, path, payload, retried = false) {
    const s = this.settings();
    const token = await this.token();
    const { res, body } = await this.http(
      HOSTS[s.env].api + path,
      {
        method,
        headers: {
          Authorization: "Bearer " + token,
          Accept: "application/json",
          ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      },
      path.split("/")[3] || "request",
    );
    if (res.status === 401 && !retried) {
      this.cache = null;
      return this.call(method, path, payload, true);
    }
    if (!res.ok) {
      const first = lhdnErrors(body)[0];
      const status = res.status === 429 ? 429 : res.status === 404 ? 404 : res.status >= 500 ? 502 : 422;
      throw new MyInvoisError(
        res.status === 429
          ? "MyInvois rate limit reached. Try again in a minute."
          : `MyInvois: ${first?.message || first?.code || "request failed (HTTP " + res.status + ")"}`,
        status,
        res.status,
        body,
      );
    }
    return body;
  }
  submit(documents) {
    return this.call("POST", "/api/v1.0/documentsubmissions/", { documents });
  }
  submission(uid) {
    return this.call("GET", `/api/v1.0/documentsubmissions/${encodeURIComponent(uid)}?pageNo=1&pageSize=100`);
  }
  details(uuid) {
    return this.call("GET", `/api/v1.0/documents/${encodeURIComponent(uuid)}/details`);
  }
  cancel(uuid, reason) {
    return this.call("PUT", `/api/v1.0/documents/state/${encodeURIComponent(uuid)}/state`, { status: "cancelled", reason });
  }
  recent(fromIso, toIso) {
    const q = new URLSearchParams({ pageNo: "1", pageSize: "100", submissionDateFrom: fromIso, submissionDateTo: toIso, InvoiceDirection: "Sent" });
    return this.call("GET", `/api/v1.0/documents/recent?${q}`);
  }
  async validateTin(tin, idType, idValue) {
    try {
      await this.call("GET", `/api/v1.0/taxpayer/validate/${encodeURIComponent(tin)}?${new URLSearchParams({ idType, idValue })}`);
      return true;
    } catch (e) {
      if (e instanceof MyInvoisError && e.upstream === 404) return false;
      throw e;
    }
  }
}

// ---- Parties, classification and readiness ----
const lines3 = (v) => String(v || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3);
export function supplierParty(store, s = taxSettings(store)) {
  const b = store.settings();
  return {
    tin: b.tin || "",
    idType: s.idType || "BRN",
    idValue: b.registration || "",
    sst: b.sstNumber || "NA",
    ttx: "NA",
    name: b.company,
    phone: normalizePhone(b.phone),
    email: b.email || "",
    msic: s.msic,
    activity: s.activity,
    address: { lines: lines3(s.addressLines), city: s.city, postcode: s.postcode, state: s.state, country: s.country || "MYS" },
  };
}
export function buyerParty(c) {
  return {
    tin: c.tin || "",
    idType: c.tax_id_type || "BRN",
    idValue: c.brn || "",
    sst: c.sst_number || "NA",
    ttx: "NA",
    name: c.name,
    phone: normalizePhone(c.phone),
    email: c.email || "",
    address: { lines: lines3(c.tax_addr_lines), city: c.tax_city || "", postcode: c.tax_postcode || "", state: c.tax_state || "", country: c.tax_country || "MYS" },
  };
}
export const GENERAL_PUBLIC = {
  tin: "EI00000000010",
  idType: "BRN",
  idValue: "NA",
  sst: "NA",
  ttx: "NA",
  name: "General Public",
  phone: "NA",
  email: "",
  address: { lines: ["NA"], city: "NA", postcode: "", state: "17", country: "MYS" },
};
function addressGaps(a, who) {
  const out = [];
  if (!a.lines.length) out.push(`${who} address lines`);
  if (!a.city) out.push(`${who} city`);
  if (!COUNTRY_CODES.has(a.country)) out.push(`${who} country code`);
  if (a.country === "MYS") {
    if (!/^\d{5}$/.test(a.postcode || "")) out.push(`${who} postcode (5 digits)`);
    if (!STATE_CODES[a.state] || a.state === "17") out.push(`${who} state`);
  } else if (!STATE_CODES[a.state]) out.push(`${who} state (use "Not applicable" outside Malaysia)`);
  return out;
}
export function supplierGaps(store, s = taxSettings(store)) {
  const p = supplierParty(store, s);
  const out = [];
  if (!validTin(p.tin)) out.push("Your business TIN (Settings)");
  if (!validIdNumber(p.idType, p.idValue)) out.push("Your registration number (Settings)");
  if (!MSIC_CODES.has(p.msic)) out.push("Your MSIC code (Tax & e-Invoice settings)");
  if (!p.activity) out.push("Your business activity description (Tax & e-Invoice settings)");
  if (!validPhone(p.phone)) out.push("Your business phone, e.g. +60123456789 (Settings)");
  out.push(...addressGaps(p.address, "Your business").map((x) => x + " (Tax & e-Invoice settings)"));
  return out;
}
export function buyerGaps(c) {
  const p = buyerParty(c);
  const out = [];
  if (!validTin(p.tin)) out.push("Buyer TIN");
  if (!ID_TYPES[p.idType] || !validIdNumber(p.idType, p.idValue)) out.push("Buyer ID type and number (BRN, NRIC, passport or army)");
  if (!validPhone(p.phone)) out.push("Buyer phone");
  out.push(...addressGaps(p.address, "Buyer"));
  return out;
}
// Classification per line: set on the document, else the service's default
// (matched by service id or exact description), else the document default,
// else the business default.
export function lineClasses(store, d, s = taxSettings(store)) {
  const set = Object.fromEntries(
    store.db.prepare("SELECT line,code FROM tax_line_classes WHERE document_id=?").all(d.id).map((r) => [r.line, r.code]),
  );
  const meta = store.db.prepare("SELECT default_class FROM tax_doc_meta WHERE document_id=?").get(d.id);
  const services = store.db.prepare("SELECT id,name,description,tax_class FROM services WHERE tax_class<>''").all();
  return d.items.map((i, n) => {
    if (set[n]) return { code: set[n], source: "line" };
    const svc =
      services.find((x) => i.service_id && x.id === i.service_id) ||
      services.find((x) => x.description === i.description || x.name === i.description);
    if (svc) return { code: svc.tax_class, source: "service" };
    if (meta?.default_class) return { code: meta.default_class, source: "document" };
    if (s.defaultClass) return { code: s.defaultClass, source: "default" };
    return { code: "", source: "" };
  });
}
export const consolidateMode = (c) => c.tax_einvoice === "consolidate";
// Everything an invoice still needs before it can become an e-Invoice.
export function readiness(store, d, s = taxSettings(store), supplier = null) {
  if (d.kind !== "invoice" || d.state === "void") return null;
  const missing = [];
  const myr = toMyr(d.total, d.currency && d.currency !== "MYR" ? d.fx_rate || "1" : "1");
  const consolidated = consolidateMode(d.client) && myr <= B2C_LIMIT;
  missing.push(...(supplier || supplierGaps(store, s)));
  if (!consolidated) {
    missing.push(...buyerGaps(d.client));
    if (consolidateMode(d.client)) missing.push("Over RM10,000: this sale needs its own e-Invoice with full buyer details");
  }
  lineClasses(store, d, s).forEach((c, n) => {
    if (!CLASSIFICATION_CODES[c.code]) missing.push(`Classification for line ${n + 1}`);
  });
  if (d.currency && d.currency !== "MYR" && !/^\d{1,9}(\.\d{1,10})?$/.test(String(d.fx_rate || ""))) missing.push("Exchange rate to MYR");
  return { ready: missing.length === 0, mode: consolidated ? "consolidated" : "individual", missing };
}

// ---- Building documents ----
const category = (rate, exempt) =>
  SALES_RATES.includes(rate) ? "01" : SERVICE_RATES.includes(rate) ? "02" : exempt ? "E" : "06";
const exemptionOf = (store, docId) =>
  store.db.prepare("SELECT exempt_ref FROM tax_doc_meta WHERE document_id=? AND exempt_ref<>''").get(docId)?.exempt_ref || "";
function invoiceLines(store, d, s) {
  const classes = lineClasses(store, d, s);
  const exemptRef = exemptionOf(store, d.id);
  return lineValues(d).map((l, n) => {
    const i = d.items[n];
    const subtotal = Math.max(l.taxable, Math.round(i.rate * Number(i.quantity)));
    return {
      description: i.description,
      quantity: Number(i.quantity),
      unitPrice: i.rate,
      subtotal,
      discount: subtotal - l.taxable,
      net: l.taxable,
      unitCode: UNIT_CODES[i.unit],
      classes: [classes[n].code],
      tax: {
        category: category(l.rate, !!exemptRef),
        rate: l.rate,
        taxable: l.taxable,
        tax: l.tax,
        exemption: exemptRef ? `Customer SST exemption ${exemptRef}` : "",
      },
    };
  });
}
function oneLine(description, sen, rate, classCode, exempt = "") {
  const tax = rate ? Math.round((sen * rate) / (100 + rate)) : 0;
  return {
    description,
    quantity: 1,
    unitPrice: sen - tax,
    subtotal: sen - tax,
    discount: 0,
    net: sen - tax,
    classes: [classCode],
    tax: { category: category(rate, !!exempt), rate, taxable: sen - tax, tax, exemption: exempt },
  };
}

export class EInvoices {
  constructor(store, api, { pollDelay = 2500 } = {}) {
    this.store = store;
    this.api = api;
    this.pollDelay = pollDelay;
  }
  get db() {
    return this.store.db;
  }
  row(eid) {
    const r = this.db.prepare("SELECT * FROM tax_einvoices WHERE id=?").get(eid);
    check(r, "e-Invoice record not found.", 404);
    return r;
  }
  active(source, sourceId) {
    return this.db
      .prepare(`SELECT * FROM tax_einvoices WHERE source=? AND source_id=? AND state IN (${ACTIVE.map(() => "?").join(",")})`)
      .get(source, sourceId, ...ACTIVE);
  }
  latest(source, sourceId) {
    return this.db
      .prepare("SELECT * FROM tax_einvoices WHERE source=? AND source_id=? ORDER BY created DESC, rowid DESC LIMIT 1")
      .get(source, sourceId);
  }
  // The validated e-Invoice an adjustment must reference: the invoice's own, or
  // the consolidated e-Invoice that included it.
  reference(invoiceId) {
    const own = this.db
      .prepare("SELECT * FROM tax_einvoices WHERE source='invoice' AND source_id=? AND state='valid'")
      .get(invoiceId);
    if (own) return { ...own, consolidated: false };
    const con = this.db
      .prepare(
        "SELECT e.* FROM tax_consolidated_items i JOIN tax_einvoices e ON e.source='consolidated' AND e.source_id=i.consolidated_id AND e.state='valid' WHERE i.document_id=?",
      )
      .get(invoiceId);
    return con ? { ...con, consolidated: true } : null;
  }
  // Builds the UBL document for a source record. Throws with what is missing.
  build(source, sourceId, opts = {}) {
    const store = this.store,
      s = taxSettings(store);
    const supplier = supplierParty(store, s);
    const gaps = supplierGaps(store, s);
    const fail = (list) => {
      throw new AppError("Not ready for e-Invoice: " + list.join("; ") + ".", 409);
    };
    if (source === "invoice") {
      const d = store.document(sourceId);
      check(d.kind === "invoice" && d.state === "issued", "Only issued invoices can be submitted as e-Invoices.", 409);
      const r = readiness(store, d, s, gaps);
      if (r.mode === "consolidated")
        fail(["this client is set to the monthly consolidated e-Invoice. Change the client's e-Invoice setting to submit it on its own"]);
      if (!r.ready) fail(r.missing);
      return {
        typeCode: "01",
        number: d.number,
        total: d.total,
        doc: { typeCode: "01", number: d.number, currency: d.currency || "MYR", fxRate: d.fx_rate, supplier, buyer: buyerParty(d.client), lines: invoiceLines(store, d, s) },
      };
    }
    if (source === "credit" || source === "debit") {
      const a = this.db.prepare("SELECT * FROM adjustments WHERE id=?").get(sourceId);
      check(a && a.kind === source, "Note not found.", 404);
      const d = store.document(a.invoice_id);
      const ref = this.reference(d.id);
      if (!ref) fail(["submit the original invoice as an e-Invoice first and wait until it is valid"]);
      if (gaps.length) fail(gaps);
      const classes = lineClasses(store, d, s);
      const classFor = (rate) => classes[d.items.findIndex((i) => (i.tax_rate || 0) === rate)]?.code || s.defaultClass || "022";
      const rows = noteLines(d, a);
      const exempt = exemptionOf(store, d.id);
      const lines = rows.map((l) => {
        const line = oneLine(rows.length > 1 && l.rate ? `${a.reason} (SST ${l.rate}%)` : a.reason, l.taxable + l.tax, l.rate, ref.consolidated ? "004" : classFor(l.rate), exempt ? `Customer SST exemption ${exempt}` : "");
        // Use the stored split exactly instead of recomputing the SST.
        line.unitPrice = line.subtotal = line.net = l.taxable;
        line.tax = { ...line.tax, taxable: l.taxable, tax: l.tax };
        return line;
      });
      const buyer = ref.consolidated ? GENERAL_PUBLIC : buyerParty(d.client);
      if (!ref.consolidated) {
        const b = buyerGaps(d.client);
        if (b.length) fail(b);
      }
      const typeCode = source === "credit" ? "02" : "03";
      return {
        typeCode,
        number: a.number,
        total: a.amount,
        doc: { typeCode, number: a.number, currency: d.currency || "MYR", fxRate: d.fx_rate, supplier, buyer, lines, billing: [{ id: ref.code_number, uuid: ref.uuid }] },
      };
    }
    if (source === "refund") {
      const f = this.db.prepare("SELECT * FROM refunds WHERE id=?").get(sourceId);
      check(f, "Refund not found.", 404);
      const receipt = store.receipt(f.receipt_id);
      const invoiceId = opts.invoice_id || this.db.prepare("SELECT reference_id FROM tax_refund_refs WHERE refund_id=?").get(f.id)?.reference_id;
      check(invoiceId, "Choose the invoice this refund relates to.");
      const d = store.document(invoiceId);
      check(d.client_id === receipt.client_id, "Choose an invoice of the same client.");
      const ref = this.reference(d.id);
      if (!ref) fail(["the related invoice needs a valid e-Invoice first"]);
      if (gaps.length) fail(gaps);
      const buyer = ref.consolidated ? GENERAL_PUBLIC : buyerParty(receipt.client);
      if (!ref.consolidated) {
        const b = buyerGaps(receipt.client);
        if (b.length) fail(b);
      }
      return {
        typeCode: "04",
        number: f.number,
        total: f.amount,
        invoiceId,
        doc: { typeCode: "04", number: f.number, currency: "MYR", supplier, buyer, lines: [oneLine(f.reason, f.amount, 0, s.defaultClass || "022")], billing: [{ id: ref.code_number, uuid: ref.uuid }] },
      };
    }
    if (source === "consolidated") {
      const con = this.db.prepare("SELECT * FROM tax_consolidated WHERE id=?").get(sourceId);
      check(con, "Consolidated e-Invoice not found.", 404);
      if (gaps.length) fail(gaps);
      const docs = this.db
        .prepare("SELECT document_id FROM tax_consolidated_items WHERE consolidated_id=?")
        .all(con.id)
        .map((r) => store.document(r.document_id));
      check(docs.length, "This consolidated e-Invoice has no invoices.", 409);
      const lines = [];
      for (const d of docs)
        for (const r of rateTotals(d))
          lines.push({
            description: `Invoice ${d.number}${rateTotals(d).length > 1 ? ` (SST ${r.rate}%)` : ""}`,
            quantity: 1,
            unitPrice: r.taxable,
            subtotal: r.taxable,
            discount: 0,
            net: r.taxable,
            classes: ["004"],
            tax: { category: category(r.rate, false), rate: r.rate, taxable: r.taxable, tax: r.tax },
          });
      return {
        typeCode: "01",
        number: con.number,
        total: docs.reduce((t, d) => t + d.total, 0),
        doc: { typeCode: "01", number: con.number, currency: "MYR", supplier, buyer: GENERAL_PUBLIC, lines },
      };
    }
    if (source === "selfbilled") {
      const sb = this.db.prepare("SELECT * FROM tax_selfbilled WHERE id=?").get(sourceId);
      check(sb, "Self-billed document not found.", 404);
      if (gaps.length) fail(gaps);
      const seller = JSON.parse(sb.supplier);
      let billing;
      if (sb.ref_id) {
        const ref = this.db
          .prepare("SELECT * FROM tax_einvoices WHERE source='selfbilled' AND source_id=? AND state='valid'")
          .get(sb.ref_id);
        if (!ref) fail(["the original self-billed e-Invoice must be valid first"]);
        billing = [{ id: ref.code_number, uuid: ref.uuid }];
      }
      const lines = JSON.parse(sb.lines).map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.rate,
        subtotal: l.amount,
        discount: 0,
        net: l.amount,
        classes: [l.class],
        tax: { category: category(l.tax_rate, false), rate: l.tax_rate, taxable: l.amount, tax: l.tax },
      }));
      // Self-billed: the seller is the supplier party and this business is the buyer.
      return {
        typeCode: sb.type_code,
        number: sb.number,
        total: sb.total,
        doc: { typeCode: sb.type_code, number: sb.number, currency: sb.currency, fxRate: sb.fx_rate, supplier: seller, buyer: { ...supplier }, lines, billing },
      };
    }
    throw new AppError("Unknown e-Invoice source.", 400);
  }
  set(eid, fields) {
    const keys = Object.keys(fields);
    this.db
      .prepare(`UPDATE tax_einvoices SET ${keys.map((k) => `${k}=?`).join(",")},updated=? WHERE id=?`)
      .run(...keys.map((k) => (fields[k] !== null && typeof fields[k] === "object" ? JSON.stringify(fields[k]) : fields[k])), now(), eid);
    return this.row(eid);
  }
  // Opt-in automatic submission: queue once per document (dedupe key).
  queue(source, sourceId) {
    const status = this.api.status();
    if (!status.configured || !taxSettings(this.store).autoSubmit) return null;
    if (this.active(source, sourceId)) return null;
    const eid = id();
    const r = this.db
      .prepare(
        "INSERT OR IGNORE INTO tax_einvoices(id,source,source_id,type_code,code_number,version,environment,state,dedupe_key,created,updated) VALUES(?,?,?,?,?,?,?,'queued',?,?,?)",
      )
      .run(eid, source, sourceId, "", "", status.version, status.env, `auto:${source}:${sourceId}`, now(), now());
    if (r.changes) this.store.audit("einvoice.queued", sourceId, `${source} queued for automatic e-Invoice submission`);
    return r.changes ? eid : null;
  }
  // Submit now: build, sign when a certificate is set, record, then send.
  async submit(source, sourceId, opts = {}) {
    const status = this.api.status();
    check(status.configured, "Add your MyInvois client ID and client secret in Settings > Integration keys.", 409);
    const prepared = this.store.tx(() => {
      const active = this.active(source, sourceId);
      check(!active || active.state === "queued", `This record already has an e-Invoice (${active?.state}). Check its status instead.`, 409);
      const built = this.build(source, sourceId, opts);
      const stamp = issueStamp(new Date());
      let json = JSON.stringify(buildDocument({ ...built.doc, issuedAt: stamp.iso }));
      let version = "1.0";
      if (status.signing) {
        json = signDocument(JSON.parse(json), this.api.signing()).json;
        version = "1.1";
      }
      check(Buffer.byteLength(json) <= 300000, "This e-Invoice is larger than the 300 KB MyInvois limit.", 409);
      const entry = submissionEntry(json, built.number);
      const fields = {
        type_code: built.typeCode,
        code_number: built.number,
        version,
        environment: status.env,
        state: "sending",
        payload: json,
        document_hash: entry.documentHash,
        issued_at: stamp.iso,
        total: built.total,
        errors: null,
        submitted_at: now(),
      };
      let eid;
      if (active) eid = this.set(active.id, fields).id;
      else {
        eid = id();
        const attempt = this.db.prepare("SELECT count(*) n FROM tax_einvoices WHERE source=? AND source_id=?").get(source, sourceId).n + 1;
        this.db
          .prepare(
            "INSERT INTO tax_einvoices(id,source,source_id,type_code,code_number,version,environment,state,payload,document_hash,issued_at,total,submitted_at,dedupe_key,created,updated) VALUES(?,?,?,?,?,?,?,'sending',?,?,?,?,?,?,?,?)",
          )
          .run(eid, source, sourceId, built.typeCode, built.number, version, status.env, json, entry.documentHash, stamp.iso, built.total, now(), `${source}:${sourceId}:${attempt}`, now(), now());
      }
      if (built.invoiceId)
        this.db
          .prepare("INSERT INTO tax_refund_refs(refund_id,reference_id) VALUES(?,?) ON CONFLICT(refund_id) DO UPDATE SET reference_id=excluded.reference_id")
          .run(sourceId, built.invoiceId);
      this.store.audit("einvoice.submitting", sourceId, `${built.number} as e-Invoice type ${built.typeCode} (v${version}, ${status.env})`);
      return { eid, entry };
    });
    return this.transmit(prepared.eid, prepared.entry);
  }
  async transmit(eid, entry) {
    let res;
    try {
      res = await this.api.submit([entry]);
    } catch (e) {
      const duplicate = lhdnErrors(e.body).some((x) => /duplicate/i.test(x.code + x.message));
      // No answer, a server error or a duplicate: MyInvois may already have it,
      // so look it up before anything is sent again.
      if (e.network || e.upstream >= 500 || duplicate || !(e instanceof MyInvoisError)) {
        this.set(eid, { state: "unknown", errors: [{ code: "", message: e.message }], next_check: new Date(Date.now() + 60000).toISOString() });
        this.store.audit("einvoice.unknown", this.row(eid).source_id, e.message);
        return this.row(eid);
      }
      const errors = lhdnErrors(e.body);
      this.set(eid, { state: "rejected", errors: errors.length ? errors : [{ code: "", message: e.message }] });
      this.store.audit("einvoice.rejected", this.row(eid).source_id, e.message);
      return this.row(eid);
    }
    const r = this.row(eid);
    const accepted = (res?.acceptedDocuments || []).find((x) => x.invoiceCodeNumber === r.code_number) || res?.acceptedDocuments?.[0];
    if (accepted) {
      this.set(eid, {
        state: "submitted",
        submission_uid: res.submissionUid || res.submissionUID,
        uuid: accepted.uuid,
        next_check: new Date(Date.now() + 5000).toISOString(),
      });
      this.store.audit("einvoice.submitted", r.source_id, `${r.code_number}: UUID ${accepted.uuid}`);
      if (this.pollDelay >= 0) {
        if (this.pollDelay) await new Promise((ok) => setTimeout(ok, this.pollDelay));
        try {
          return await this.refresh(eid);
        } catch {
          return this.row(eid);
        }
      }
      return this.row(eid);
    }
    const rejected = (res?.rejectedDocuments || [])[0];
    const errors = lhdnErrors(rejected);
    this.set(eid, { state: "rejected", errors: errors.length ? errors : [{ code: "", message: "MyInvois did not accept the document." }] });
    this.store.audit("einvoice.rejected", r.source_id, errors[0]?.message || "Rejected");
    return this.row(eid);
  }
  // Ask MyInvois for the current status.
  async refresh(eid) {
    let r = this.row(eid);
    const backoff = (n) => new Date(Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(n, 7))).toISOString();
    if (r.state === "unknown") return this.reconcile(r);
    if (!["submitted", "valid"].includes(r.state)) return r;
    let summary = null;
    if (r.state === "submitted") {
      const sub = await this.api.submission(r.submission_uid);
      summary = (sub?.documentSummary || []).find((x) => x.uuid === r.uuid) || null;
    } else summary = await this.api.details(r.uuid);
    if (!summary) return this.set(eid, { checks: r.checks + 1, next_check: backoff(r.checks + 1) });
    const status = String(summary.status || "").toLowerCase();
    if (status === "valid") {
      const fields = {
        state: "valid",
        long_id: summary.longId || summary.longID || r.long_id || null,
        validated_at: summary.dateTimeValidated || r.validated_at || now(),
        checks: r.checks + 1,
        reject_requested: summary.rejectRequestDateTime ? summary.rejectRequestDateTime : r.reject_requested,
      };
      // Keep checking while the long ID is missing or the cancellation window is open.
      const windowOpen = Date.parse(fields.validated_at) + CANCEL_WINDOW_MS > Date.now();
      fields.next_check = !fields.long_id ? backoff(r.checks + 1) : windowOpen ? new Date(Date.now() + 1800000).toISOString() : null;
      const wasValid = r.state === "valid";
      r = this.set(eid, fields);
      if (!wasValid) this.store.audit("einvoice.validated", r.source_id, `${r.code_number}: ${r.uuid}`);
      return r;
    }
    if (status === "invalid") {
      let errors = [];
      try {
        const det = r.state === "submitted" ? await this.api.details(r.uuid) : summary;
        for (const step of det?.validationResults?.validationSteps || [])
          if (String(step.status).toLowerCase() === "invalid") errors.push(...lhdnErrors({ error: step.error }).map((x) => ({ ...x, step: step.name })));
      } catch {
        // Details are best effort; the status is what matters.
      }
      r = this.set(eid, { state: "invalid", errors: errors.length ? errors : [{ code: "", message: "MyInvois marked the document invalid." }], next_check: null, checks: r.checks + 1 });
      this.store.audit("einvoice.invalid", r.source_id, errors[0]?.message || "Invalid");
      return r;
    }
    if (status === "cancelled") {
      r = this.set(eid, { state: "cancelled", cancelled_at: summary.cancelDateTime || now(), next_check: null });
      this.store.audit("einvoice.cancelled", r.source_id, "Cancelled in MyInvois");
      return r;
    }
    return this.set(eid, { checks: r.checks + 1, next_check: backoff(r.checks + 1) });
  }
  // A submission whose answer was lost: find it in MyInvois' recent list, or
  // release it for a new attempt after 15 minutes.
  async reconcile(r) {
    const since = new Date(Date.parse(r.submitted_at || r.created) - 3600000).toISOString().slice(0, 19) + "Z";
    const until = new Date(Date.now() + 60000).toISOString().slice(0, 19) + "Z";
    const list = await this.api.recent(since, until);
    const hit = (list?.result || []).find((x) => x.internalId === r.code_number && (!r.uuid || x.uuid === r.uuid));
    if (hit) {
      this.set(r.id, { state: "submitted", uuid: hit.uuid, submission_uid: hit.submissionUid || hit.submissionUID, errors: null, next_check: now() });
      this.store.audit("einvoice.found", r.source_id, `${r.code_number}: ${hit.uuid}`);
      return this.refresh(r.id);
    }
    if (Date.now() - Date.parse(r.submitted_at || r.created) > 15 * 60000) {
      this.store.audit("einvoice.failed", r.source_id, "Not received by MyInvois");
      return this.set(r.id, { state: "failed", errors: [{ code: "", message: "MyInvois has no record of this submission. You can submit it again." }], next_check: null });
    }
    return this.set(r.id, { checks: r.checks + 1, next_check: new Date(Date.now() + 120000).toISOString() });
  }
  async cancel(eid, reason) {
    const r = this.row(eid);
    check(r.state === "valid", "Only a valid e-Invoice can be cancelled.", 409);
    check(
      Date.parse(r.validated_at) + CANCEL_WINDOW_MS > Date.now(),
      "The 72-hour cancellation window has passed. Issue a credit or debit note instead.",
      409,
    );
    reason = text(reason, 300, true);
    await this.api.cancel(r.uuid, reason);
    const out = this.set(eid, { state: "cancelled", cancelled_at: now(), cancel_reason: reason, next_check: null });
    this.store.audit("einvoice.cancelled", r.source_id, `${r.code_number}: ${reason}`);
    return out;
  }
  // Background job: send queued documents, then poll pending ones.
  async run(limit = 20) {
    if (!this.api.status().configured) return { skipped: true };
    const out = { sent: 0, checked: 0, failed: 0 };
    for (const q of this.db.prepare("SELECT * FROM tax_einvoices WHERE state='queued' ORDER BY created LIMIT ?").all(limit)) {
      try {
        await this.submit(q.source, q.source_id);
        out.sent++;
      } catch (e) {
        out.failed++;
        // A queued record that cannot be built is closed so it is not retried forever.
        if (this.row(q.id).state === "queued") {
          this.set(q.id, { state: "failed", errors: [{ code: "", message: e.message }] });
          this.store.audit("einvoice.failed", q.source_id, e.message);
        }
      }
    }
    const due = this.db
      .prepare("SELECT id FROM tax_einvoices WHERE state IN ('submitted','unknown','valid') AND next_check IS NOT NULL AND next_check<=? ORDER BY next_check LIMIT ?")
      .all(now(), limit);
    for (const r of due) {
      try {
        await this.refresh(r.id);
        out.checked++;
      } catch (e) {
        if (e.status === 429) break;
        this.set(r.id, { next_check: new Date(Date.now() + 300000).toISOString() });
      }
    }
    return out;
  }
}

// ---- Consolidated e-Invoice (B2C) ----
export function monthEnd(month) {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}
// Invoices of a month for buyers who did not ask for an e-Invoice and that are not
// yet covered, plus the ones that are too large to consolidate.
export function consolidationCandidates(store, month, einv) {
  const end = monthEnd(month);
  const taken = new Set(store.db.prepare("SELECT document_id FROM tax_consolidated_items").all().map((r) => r.document_id));
  const ready = [],
    tooLarge = [];
  for (const d of store.documents()) {
    if (d.kind !== "invoice" || d.state !== "issued" || !consolidateMode(d.client)) continue;
    if (d.issue_date < month + "-01" || d.issue_date > end || taken.has(d.id)) continue;
    if (einv.active("invoice", d.id)) continue;
    const myr = toMyr(d.total, d.currency && d.currency !== "MYR" ? d.fx_rate || "1" : "1");
    (myr > B2C_LIMIT ? tooLarge : ready).push({ id: d.id, number: d.number, client: d.client.name, total: d.total, issue_date: d.issue_date });
  }
  // LHDN: submit within 7 calendar days after the month ends.
  return { month, deadline: addDays(end, 7), closed: end < today(), ready, tooLarge };
}

// ---- Self-billed e-Invoices (types 11-14) ----
export function cleanSeller(b) {
  const seller = {
    name: text(b.name || "", 200, true),
    tin: text(b.tin || "", 14, true).toUpperCase(),
    idType: text(b.id_type || "BRN", 10, true),
    idValue: text(b.id_value || "NA", 30, true),
    sst: text(b.sst || "NA", 40) || "NA",
    ttx: "NA",
    phone: normalizePhone(b.phone || ""),
    email: text(b.email || "", 160),
    msic: text(b.msic || "00000", 5, true),
    activity: text(b.activity || "NA", 300, true),
    address: {
      lines: lines3(text(b.address || "", 450, true)),
      city: text(b.city || "", 50, true),
      postcode: text(b.postcode || "", 10),
      state: text(b.state || "17", 2, true),
      country: text(b.country || "MYS", 3, true).toUpperCase(),
    },
  };
  check(validTin(seller.tin), `Enter the seller's TIN, or a general TIN such as EI00000000030 for a foreign seller (${Object.keys(GENERAL_TINS).join(", ")}).`);
  check(ID_TYPES[seller.idType], "Choose the seller's ID type.");
  check(validIdNumber(seller.idType, seller.idValue), "Enter the seller's ID number, or NA for a foreign seller.");
  check(MSIC_CODES.has(seller.msic), "Enter a valid MSIC code (00000 if not applicable).");
  check(validPhone(seller.phone), "Enter the seller's phone with country code, e.g. +6591234567.");
  check(COUNTRY_CODES.has(seller.address.country), "Choose the seller's country.");
  check(STATE_CODES[seller.address.state], "Choose the seller's state (Not applicable outside Malaysia).");
  if (seller.address.country === "MYS") check(/^\d{5}$/.test(seller.address.postcode), "Enter a 5-digit postcode.");
  return seller;
}
