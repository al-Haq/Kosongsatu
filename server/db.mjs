import { migrateAutomation } from "./automation-migration.mjs";
import { migrateRecords, attachRecords } from "./records.mjs";
import { migrateMail, attachMail } from "./mailer.mjs";
import { migrateTax, attachTax } from "./tax.mjs";
import { migrateGateway } from "./gateway.mjs";
import { migratePlugins, attachPlugins } from "./plugins.mjs";
import { attachSales } from "./sales.mjs";
import { attachAutomation } from "./automation.mjs";
import { migrate } from "./migrations.mjs";
import { requestContext, readCache } from "./context.mjs";
import { attachFinance } from "./finance.mjs";
import { attachBanking } from "./banking.mjs";
import { loadMfaKey } from "./mfa.mjs";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import {
  id,
  hash,
  now,
  today,
  text,
  date,
  money,
  integer,
  calculate,
  check,
  status,
  addDays,
  nextMonth,
  KINDS,
  CURRENCIES,
  LANGUAGES,
  DEDUCTIONS,
  REVISE,
  LINK,
  META,
  prefixFor,
  itemInput,
  regularItems,
  fxRate,
} from "./domain.mjs";
const defaults = {
  company: "NAWLOGIC SYSTEMS SOLUTION",
  registration: "",
  email: "",
  phone: "",
  address: "",
  bankName: "",
  bankAccount: "",
  bankHolder: "",
  paymentTerms:
    "Payment within 14 days. Please include your invoice number as payment reference.",
  invoicePrefix: "INV",
  quotePrefix: "QT",
  demo: false,
};
export function openDatabase(path) {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  db.prepare("INSERT OR IGNORE INTO settings(id,data) VALUES(1,?)").run(
    JSON.stringify(defaults),
  );
  migrate(db, path);
  migrateAutomation(db, path);
  migrateRecords(db, path);
  migrateMail(db, path);
  migrateTax(db, path);
  migrateGateway(db, path);
  migratePlugins(db, path);
  const store = new Store(db);
  store.path = path;
  try {
    store.mfaKey = loadMfaKey(
      path,
      !!db
        .prepare("SELECT id FROM owners WHERE mfa_secret IS NOT NULL LIMIT 1")
        .get() || !!db.prepare("SELECT 1 FROM secrets LIMIT 1").get(),
    );
    return store;
  } catch (e) {
    db.close();
    throw e;
  }
}
export class Store {
  constructor(db) {
    this.db = db;
  }
  // Builds a read-only answer with repeated reads worked out once (see readCache).
  cachedReads(fn) {
    return readCache.run({}, fn);
  }
  tx(fn) {
    if (this._transaction) return fn();
    const cache = readCache.getStore();
    if (cache) for (const k of Object.keys(cache)) delete cache[k];
    this.db.exec("BEGIN IMMEDIATE");
    this._transaction = true;
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this._transaction = false;
    }
  }
  audit(action, entity, detail = "", before = null, after = null) {
    this.db
      .prepare(
        "INSERT INTO audit(action,entity_id,detail,created,actor,before_data,after_data) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        action,
        entity,
        detail,
        now(),
        requestContext.getStore()?.actor || "system",
        before === null ? null : JSON.stringify(before),
        after === null ? null : JSON.stringify(after),
      );
  }
  settings() {
    return JSON.parse(
      this.db.prepare("SELECT data FROM settings WHERE id=1").get().data,
    );
  }
  saveSettings(b) {
    const current = this.settings();
    const out = { ...current };
    for (const [key, max] of Object.entries({
      company: 180,
      registration: 80,
      email: 160,
      phone: 60,
      address: 600,
      bankName: 100,
      bankAccount: 60,
      bankHolder: 180,
      sstNumber: 40,
      tin: 20,
      paymentTerms: 4000,
      invoicePrefix: 12,
      quotePrefix: 12,
    })) {
      if (key in b) out[key] = text(b[key], max, key === "company");
    }
    for (const key of ["invoicePrefix", "quotePrefix"])
      check(
        /^[A-Z][A-Z0-9-]{0,11}$/.test(out[key]),
        "Use uppercase letters/numbers for document prefixes.",
      );
    this.db
      .prepare("UPDATE settings SET data=? WHERE id=1")
      .run(JSON.stringify(out));
    this.audit("settings.updated", null);
    return out;
  }
  client(idv) {
    const c = this.db.prepare("SELECT * FROM clients WHERE id=?").get(idv);
    check(c, "Client not found.", 404);
    return c;
  }
  saveClient(b, idv = id()) {
    const c = {
      id: idv,
      name: text(b.name, 160, true),
      email: text(b.email || "", 160),
      phone: text(b.phone || "", 60),
      address: text(b.address || "", 600),
      contact: text(b.contact || "", 120),
      tin: text(b.tin || "", 20).toUpperCase(),
      brn: text(b.brn || "", 40),
      sst_number: text(b.sst_number || "", 40).toUpperCase(),
      terms: integer(b.terms ?? 14, 0, 365),
      created: now(),
    };
    check(
      !c.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email),
      "Enter a valid email.",
    );
    this.db
      .prepare(
        "INSERT INTO clients(id,name,email,phone,address,contact,tin,brn,sst_number,terms,created) VALUES(:id,:name,:email,:phone,:address,:contact,:tin,:brn,:sst_number,:terms,:created) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,phone=excluded.phone,address=excluded.address,contact=excluded.contact,tin=excluded.tin,brn=excluded.brn,sst_number=excluded.sst_number,terms=excluded.terms",
      )
      .run(c);
    this.audit("client.saved", idv);
    return this.client(idv);
  }
  saveService(b, idv = id()) {
    const s = {
      id: idv,
      name: text(b.name, 160, true),
      description: text(b.description || "", 240),
      unit: text(b.unit || "Project", 30, true),
      rate: money(b.rate),
      tax_rate: integer(b.tax_rate ?? 0, 0, 10),
      active: b.active === false ? 0 : 1,
    };
    this.db
      .prepare(
        "INSERT INTO services(id,name,description,unit,rate,tax_rate,active) VALUES(:id,:name,:description,:unit,:rate,:tax_rate,:active) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,unit=excluded.unit,rate=excluded.rate,tax_rate=excluded.tax_rate,active=excluded.active",
      )
      .run(s);
    this.audit("service.saved", idv);
    return s;
  }
  document(idv) {
    const kept = readCache.getStore()?.byId?.get(idv);
    if (kept) return kept;
    const row = this.db.prepare("SELECT * FROM documents WHERE id=?").get(idv);
    check(row, "Document not found.", 404);
    return this.hydrate(row);
  }
  // Rows that belong to one document. While documents() works out every
  // document at once, the whole set is read in one query (`all`, ordered as
  // the single query is) and grouped by `key`, instead of one query each.
  rowsOf(name, key, value, single, all) {
    const bulk = this._bulk;
    if (!bulk) return single();
    let map = bulk.get(name);
    if (!map) {
      map = new Map();
      for (const r of this.db.prepare(all).all()) {
        if (!map.has(r[key])) map.set(r[key], []);
        map.get(r[key]).push(r);
      }
      bulk.set(name, map);
    }
    return map.get(value) || [];
  }
  hydrate(row) {
    const payments = this.rowsOf(
      "payments",
      "invoice_id",
      row.id,
      () => this.db.prepare("SELECT * FROM payments WHERE invoice_id=? ORDER BY created DESC, rowid DESC").all(row.id),
      "SELECT * FROM payments ORDER BY created DESC, rowid DESC",
    );
    const paid = payments
      .filter((p) => !p.reversed)
      .reduce((s, p) => s + p.amount, 0);
    return {
      ...row,
      currency: row.currency || "MYR",
      fx_rate: row.fx_rate || "1",
      language: row.language || "en",
      meta: row.meta ? JSON.parse(row.meta) : {},
      items: JSON.parse(row.items),
      client: row.client_snapshot
        ? JSON.parse(row.client_snapshot)
        : this.client(row.client_id),
      business: row.business_snapshot
        ? JSON.parse(row.business_snapshot)
        : this.settings(),
      paid,
      balance: row.total - paid,
      status: status(row, paid),
      payments,
      proofs: this.rowsOf(
        "proofs",
        "invoice_id",
        row.id,
        () => this.db.prepare("SELECT * FROM proofs WHERE invoice_id=? ORDER BY created DESC, rowid DESC").all(row.id),
        "SELECT * FROM proofs ORDER BY created DESC, rowid DESC",
      ),
    };
  }
  documents() {
    const cache = readCache.getStore();
    if (cache?.documents) return cache.documents;
    const rows = this.db.prepare("SELECT * FROM documents ORDER BY created DESC").all();
    // Every document at once: the rows each one needs are read in bulk (rowsOf).
    this._bulk = new Map([["documents", new Map(rows.map((r) => [r.id, r]))]]);
    let out;
    try {
      out = rows.map((d) => this.hydrate(d));
    } finally {
      this._bulk = null;
    }
    if (cache) {
      cache.documents = out;
      cache.byId = new Map(out.map((d) => [d.id, d]));
    }
    return out;
  }
  saveDocument(b, idv = id()) {
    const existing = this.db
      .prepare("SELECT * FROM documents WHERE id=?")
      .get(idv);
    check(
      !existing || existing.state === "draft" || (b[REVISE] && existing.kind === "quote" && existing.state === "issued"),
      "Issued documents are locked. Void and replace if appropriate.",
      409,
    );
    const kind = existing?.kind || b.kind;
    check(KINDS.includes(kind), "Invalid document type.");
    this.client(b.client_id);
    const issued = date(b.issue_date),
      due = date(b.due_date);
    check(due >= issued, "Due date must be on or after issue date.");
    const amounts = calculate(b.items, b.discount ?? "0", {
      kind,
      deductions: b[DEDUCTIONS] || [],
    });
    // An issued quotation being edited keeps the SST registration it was issued under.
    const issuedSst = b[REVISE] && existing?.business_snapshot ? JSON.parse(existing.business_snapshot).sstNumber : "";
    check(
      !amounts.items.some((i) => i.tax > 0) || this.settings().sstNumber || issuedSst,
      "Add your SST registration number in Settings before charging SST.",
    );
    // Amounts are minor units of the document currency; fx_rate converts them to MYR.
    const currency = b.currency ?? existing?.currency ?? "MYR";
    check(CURRENCIES.includes(currency), "Choose a supported currency.");
    const language = b.language ?? existing?.language ?? "en";
    check(LANGUAGES.includes(language), "Choose English, Bahasa Melayu or Chinese.");
    const link = existing ? {} : b[LINK] || {};
    const d = {
      id: idv,
      kind,
      client_id: b.client_id,
      issue_date: issued,
      due_date: due,
      items: JSON.stringify(amounts.items),
      subtotal: amounts.subtotal,
      discount: amounts.discount,
      tax: amounts.tax,
      total: amounts.total,
      notes: text(b.notes || "", 2000),
      // Terms and conditions can be long (quotations); the PDF carries them over pages.
      terms: text(b.terms ?? this.settings().paymentTerms, 4000),
      currency,
      fx_rate:
        currency === "MYR" ? "1" : fxRate(b.fx_rate ?? existing?.fx_rate),
      language,
      meta: JSON.stringify(b[META] ?? (existing ? JSON.parse(existing.meta || "{}") : {})),
      source_quote: link.source_quote ?? null,
      source_id: link.source_id ?? null,
      source_role: link.source_role ?? null,
      created: now(),
      updated: now(),
    };
    this.db
      .prepare(
        "INSERT INTO documents(id,kind,client_id,issue_date,due_date,items,subtotal,discount,tax,total,notes,terms,currency,fx_rate,language,meta,source_quote,source_id,source_role,created,updated) VALUES(:id,:kind,:client_id,:issue_date,:due_date,:items,:subtotal,:discount,:tax,:total,:notes,:terms,:currency,:fx_rate,:language,:meta,:source_quote,:source_id,:source_role,:created,:updated) ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,issue_date=excluded.issue_date,due_date=excluded.due_date,items=excluded.items,subtotal=excluded.subtotal,discount=excluded.discount,tax=excluded.tax,total=excluded.total,notes=excluded.notes,terms=excluded.terms,currency=excluded.currency,fx_rate=excluded.fx_rate,language=excluded.language,meta=excluded.meta,updated=excluded.updated",
      )
      .run(d);
    this.audit("document.draft.saved", idv);
    return this.document(idv);
  }
  // An issued quotation can still be edited until the client accepts or
  // declines it. It keeps its number, client, issue date and currency (the
  // client details were frozen when it was issued); lines, discount, validity,
  // terms and notes can change. Each edit is audited with what changed.
  reviseQuote(idv, b) {
    return this.tx(() => {
      const e = this.db.prepare("SELECT * FROM documents WHERE id=?").get(idv);
      check(e, "Document not found.", 404);
      check(e.kind === "quote", "Issued documents are locked. Void and replace if appropriate.", 409);
      check(
        e.state === "issued",
        e.state === "accepted"
          ? "An accepted quotation can't be edited. Duplicate it to make a new version."
          : e.state === "draft"
            ? "This quotation is still a draft."
            : "This quotation can no longer be edited.",
        409,
      );
      check(b && typeof b === "object", "Invalid document.");
      return this.saveDocument(
        { ...b, client_id: e.client_id, issue_date: e.issue_date, currency: e.currency, fx_rate: e.fx_rate, [REVISE]: true },
        idv,
      );
    });
  }
  issue(idv) {
    return this.tx(() => {
      const d = this.document(idv);
      check(d.state === "draft", "Document already issued.", 409);
      const business = this.settings();
      const key = `${d.kind}-${d.issue_date.slice(0, 4)}`;
      this.db
        .prepare(
          "INSERT INTO counters(key,value) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET value=value+1",
        )
        .run(key);
      const n = this.db
        .prepare("SELECT value FROM counters WHERE key=?")
        .get(key).value;
      const number = `${prefixFor(d.kind, business)}-${d.issue_date.slice(0, 4)}-${String(n).padStart(4, "0")}`;
      this.db
        .prepare(
          "UPDATE documents SET state='issued',number=?,client_snapshot=?,business_snapshot=?,updated=? WHERE id=?",
        )
        .run(
          number,
          JSON.stringify(d.client),
          JSON.stringify(business),
          now(),
          idv,
        );
      this.audit("document.issued", idv, number);
      return this.document(idv);
    });
  }
  share(idv) {
    const d = this.document(idv);
    check(
      ["issued", "accepted"].includes(d.state),
      "Issue the document before sharing.",
    );
    const token = randomBytes(32).toString("base64url");
    const expires = Date.now() + 30 * 86400000;
    this.db
      .prepare("UPDATE documents SET token_hash=?,token_expires=? WHERE id=?")
      .run(hash(token), expires, idv);
    this.audit(
      "link.created",
      idv,
      "Expires in 30 days; previous link revoked.",
    );
    return { token, expires };
  }
  revoke(idv) {
    this.document(idv);
    this.db
      .prepare(
        "UPDATE documents SET token_hash=NULL,token_expires=NULL WHERE id=?",
      )
      .run(idv);
    this.audit("link.revoked", idv);
  }
  publicDocument(token, markViewed = false) {
    check(
      typeof token === "string" && /^[\w-]{43}$/.test(token),
      "Link unavailable.",
      404,
    );
    const row = this.db
      .prepare(
        "SELECT * FROM documents WHERE token_hash=? AND token_expires>? AND state!='void'",
      )
      .get(hash(token), Date.now());
    check(row, "Link expired or unavailable.", 404);
    if (markViewed && !row.viewed_at) {
      this.db
        .prepare("UPDATE documents SET viewed_at=? WHERE id=?")
        .run(now(), row.id);
      this.audit("document.viewed", row.id);
    }
    return this.document(row.id);
  }
  accept(token, name) {
    return this.tx(() => {
      const d = this.publicDocument(token);
      check(
        d.kind === "quote" && d.state === "issued",
        "Quotation cannot be accepted.",
        409,
      );
      check(d.due_date >= today(), "Quotation has expired.", 409);
      name = text(name, 120, true);
      this.db
        .prepare(
          "UPDATE documents SET state='accepted',accepted_name=?,updated=? WHERE id=?",
        )
        .run(name, now(), d.id);
      this.audit("quotation.accepted", d.id, name);
      return this.document(d.id);
    });
  }
  convert(idv) {
    return this.tx(() => {
      const q = this.document(idv);
      check(
        q.kind === "quote" && q.state === "accepted",
        "Accept quotation before converting.",
      );
      const old = this.db
        .prepare("SELECT id FROM documents WHERE source_quote=?")
        .get(idv);
      if (old) return this.document(old.id);
      // The invoice keeps the quotation's currency, rate, language, codes and
      // line discounts. Deposit deductions are added by the documents module.
      const d = this.saveDocument({
        kind: "invoice",
        client_id: q.client_id,
        issue_date: today(),
        due_date: addDays(today(), q.client.terms),
        items: regularItems(q.items).map(itemInput),
        discount: (q.discount / 100).toFixed(2),
        notes: q.notes,
        terms: q.terms,
        currency: q.currency,
        fx_rate: q.fx_rate,
        language: q.language,
        custom: q.meta.custom || {},
        [LINK]: { source_quote: idv },
      });
      this.audit("quotation.converted", idv, d.id);
      return this.document(d.id);
    });
  }
  void(idv, reason) {
    return this.tx(() => {
      const d = this.document(idv);
      check(d.state !== "void", "Document already void.", 409);
      check(d.paid === 0, "Reverse payments before voiding.", 409);
      check(
        !this.db
          .prepare("SELECT 1 FROM documents WHERE source_quote=?")
          .get(idv),
        "Quotation already converted.",
      );
      reason = text(reason, 500, true);
      this.db
        .prepare(
          "UPDATE documents SET state='void',token_hash=NULL,token_expires=NULL,updated=? WHERE id=?",
        )
        .run(now(), idv);
      this.audit("document.voided", idv, reason);
      return this.document(idv);
    });
  }
  recordPayment(idv, b) {
    return this.tx(() => {
      const d = this.document(idv);
      check(
        d.kind === "invoice" && d.state === "issued",
        "Payments require an issued invoice.",
      );
      const amount = money(b.amount);
      check(
        amount > 0 && amount <= d.balance,
        "Payment must be positive and cannot exceed remaining balance.",
      );
      const paid_date = date(b.paid_date);
      check(paid_date <= today(), "Payment date cannot be in the future.");
      const p = {
        id: id(),
        invoice_id: idv,
        amount,
        paid_date,
        method: text(b.method, 40, true),
        reference: text(b.reference, 120, true),
        note: text(b.note || "", 500),
        created: now(),
      };
      check(
        ["Bank transfer", "Cash", "Card", "Other"].includes(p.method),
        "Invalid payment method.",
      );
      check(
        !this.db
          .prepare("SELECT id FROM payments WHERE invoice_id=? AND reference=?")
          .get(idv, p.reference),
        "This payment reference has already been recorded.",
        409,
      );
      this.db
        .prepare(
          "INSERT INTO payments(id,invoice_id,amount,paid_date,method,reference,note,created) VALUES(:id,:invoice_id,:amount,:paid_date,:method,:reference,:note,:created)",
        )
        .run(p);
      if (b.proof_id)
        this.db
          .prepare(
            "UPDATE proofs SET status='confirmed' WHERE id=? AND invoice_id=? AND status='pending'",
          )
          .run(b.proof_id, idv);
      this.audit(
        "payment.recorded",
        idv,
        `${p.id}: ${amount} sen / ${p.reference}`,
      );
      return p;
    });
  }
  reverse(paymentId, reason) {
    const p = this.db
      .prepare("SELECT * FROM payments WHERE id=?")
      .get(paymentId);
    check(p && !p.reversed, "Active payment not found.", 404);
    reason = text(reason, 500, true);
    this.db
      .prepare("UPDATE payments SET reversed=1,reversal_reason=? WHERE id=?")
      .run(reason, paymentId);
    this.audit("payment.reversed", p.invoice_id, `${paymentId}: ${reason}`);
  }
  proof(token, b) {
    const d = this.publicDocument(token);
    check(
      d.kind === "invoice" && d.state === "issued" && d.balance > 0,
      "This invoice is not awaiting payment.",
    );
    check(
      this.db
        .prepare(
          "SELECT count(*) n FROM proofs WHERE invoice_id=? AND status='pending'",
        )
        .get(d.id).n < 5,
      "Five payment references are already awaiting review.",
    );
    const p = {
      id: id(),
      invoice_id: d.id,
      reference: text(b.reference, 120, true),
      note: text(b.note || "", 500),
      created: now(),
    };
    check(
      !this.db
        .prepare(
          "SELECT id FROM proofs WHERE invoice_id=? AND reference=? AND status='pending'",
        )
        .get(d.id, p.reference),
      "This reference is already awaiting review.",
      409,
    );
    this.db
      .prepare(
        "INSERT INTO proofs(id,invoice_id,reference,note,created) VALUES(:id,:invoice_id,:reference,:note,:created)",
      )
      .run(p);
    this.audit("payment.reference.submitted", d.id);
    return p;
  }
  saveSchedule(b) {
    this.client(b.client_id);
    const service = this.db
      .prepare("SELECT * FROM services WHERE id=? AND active=1")
      .get(b.service_id);
    check(service, "Choose an active service.");
    const s = {
      id: id(),
      client_id: b.client_id,
      service_id: b.service_id,
      next_date: date(b.next_date),
      terms: integer(b.terms ?? 14, 0, 365),
      anchor_day: Number(b.next_date.slice(-2)),
      month_end: b.month_end === true ? 1 : 0,
      created: now(),
    };
    this.db
      .prepare(
        "INSERT INTO schedules(id,client_id,service_id,next_date,terms,anchor_day,month_end,created) VALUES(:id,:client_id,:service_id,:next_date,:terms,:anchor_day,:month_end,:created)",
      )
      .run(s);
    this.audit("schedule.created", s.id);
    return s;
  }
  runSchedule(sid) {
    return this.tx(() => {
      const s = this.db
        .prepare("SELECT * FROM schedules WHERE id=? AND active=1")
        .get(sid);
      check(s, "Active schedule not found.", 404);
      check(s.next_date <= today(), "This schedule is not due yet.");
      const service = this.db
        .prepare("SELECT * FROM services WHERE id=? AND active=1")
        .get(s.service_id);
      check(service, "Service is inactive.");
      const old = this.db
        .prepare(
          "SELECT invoice_id FROM schedule_runs WHERE schedule_id=? AND period=?",
        )
        .get(sid, s.next_date);
      check(!old, "This period already has an invoice.", 409);
      const d = this.saveDocument({
        kind: "invoice",
        client_id: s.client_id,
        issue_date: s.next_date,
        due_date: addDays(s.next_date, s.terms),
        items: [
          {
            description: `${service.name} - ${s.next_date.slice(0, 7)}`,
            quantity: 1,
            rate: (service.rate / 100).toFixed(2),
            tax_rate: service.tax_rate ?? 0,
          },
        ],
      });
      this.db
        .prepare("INSERT INTO schedule_runs VALUES(?,?,?)")
        .run(sid, s.next_date, d.id);
      this.db
        .prepare("UPDATE schedules SET next_date=? WHERE id=?")
        .run(nextMonth(s.next_date, s.anchor_day, s.month_end), sid);
      this.audit("schedule.draft.created", sid, d.id);
      return d;
    });
  }
  workspace() {
    return {
      settings: this.settings(),
      clients: this.db.prepare("SELECT * FROM clients ORDER BY name").all(),
      services: this.db.prepare("SELECT * FROM services ORDER BY name").all(),
      documents: this.documents(),
      schedules: this.db
        .prepare("SELECT * FROM schedules ORDER BY next_date")
        .all(),
      audit: this.db
        .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 150")
        .all(),
      today: today(),
    };
  }
}

attachFinance(Store);
attachBanking(Store);

attachSales(Store);
attachAutomation(Store);
attachRecords(Store);
attachMail(Store);
attachTax(Store);
attachPlugins(Store);
