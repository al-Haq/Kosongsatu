import {
  id,
  now,
  today,
  check,
  text,
  date,
  money,
  addDays,
  AppError,
  CURRENCIES,
  LANGUAGES,
  KINDS,
  DEDUCTIONS,
  LINK,
  META,
  KIND_PREFIX,
  prefixFor,
  itemInput,
  regularItems,
  toMYR,
  fxRate,
} from "./domain.mjs";

import { depositParts, basisPoints } from "../public/ext/documents-calc.mjs";
import { labels } from "../public/ext/documents-i18n.mjs";
import { hasCjk, cjkFontPath, CJK_MESSAGE } from "./documents-fonts.mjs";
import { bindPdf, freezeBusiness } from "./documents-assets.mjs";

export const LAYOUTS = ["classic", "modern", "compact"];
// A client is a company, an individual, a government body or another organisation.
export const CLIENT_KINDS = ["company", "individual", "government", "organisation"];
export const TEMPLATE_DEFAULTS = {
  pdfLayout: "classic",
  pdfAccent: "#087F7E",
  pdfShowBank: true,
  pdfShowTerms: true,
  pdfShowNotes: true,
  pdfShowBuyerTax: true,
  pdfShowFooter: true,
  pdfFooterText: "",
  documentLanguage: "en",
  logoFileId: null,
  customFields: [],
};
const SHOW_KEYS = ["pdfShowBank", "pdfShowTerms", "pdfShowNotes", "pdfShowBuyerTax", "pdfShowFooter"];
const NEW_PREFIXES = ["proformaPrefix", "salesOrderPrefix", "deliveryOrderPrefix"];
const RESERVED_PREFIXES = ["CN", "DN", "RC", "RF"];
// Settings with the document template defaults filled in.
export const documentSettings = (s = {}) => {
  const out = { ...TEMPLATE_DEFAULTS, ...s };
  for (const [key, fallback] of Object.values(KIND_PREFIX)) out[key] = s[key] || fallback;
  return out;
};
// Which custom fields a document kind shows. "invoice" also covers proforma invoices.
export const fieldApplies = (f, kind) =>
  f.applies === "all" || f.applies === kind || (f.applies === "invoice" && kind === "proforma");
// Conversions a document offers, by its kind.
export const CONVERSIONS = {
  quote: ["sales_order"],
  proforma: ["invoice"],
  sales_order: ["invoice", "delivery_order"],
  invoice: ["delivery_order"],
};
const ATTACHMENT_LIMIT = 10;
const dec = (sen) => (sen / 100).toFixed(2);
const bool = (v) => v === true || v === "on" || v === "true" || v === 1 || v === "1";

// Instalment schedule for an invoice: amounts are capped by the current invoice
// value (after credit/debit notes), and any difference falls on the last one.
export function instalmentSchedule(rows, value, paid) {
  let cumulative = 0;
  const list = rows.map((r, n) => {
    const last = n === rows.length - 1;
    const amount = last ? Math.max(0, value - cumulative) : Math.max(0, Math.min(r.amount, value - cumulative));
    cumulative += amount;
    const covered = Math.max(0, Math.min(amount, paid - (cumulative - amount)));
    return {
      seq: r.seq,
      due_date: r.due_date,
      amount,
      planned: r.amount,
      paid: covered,
      status: amount > 0 && covered >= amount ? "paid" : covered > 0 ? "part" : "due",
      cumulative,
    };
  });
  const next = list.find((i) => i.amount > 0 && i.paid < i.amount);
  return {
    instalments: list.map(({ cumulative: _c, ...i }) => i),
    next_due_date: next?.due_date || null,
    next_due_amount: next ? next.cumulative - paid : 0,
  };
}

// Documents made from this one (sales order, invoice, delivery order...), in
// the order they were made. In bulk (rowsOf) they are grouped from the rows
// already read, instead of one query per document.
const LINK_COLUMNS = ["id", "kind", "number", "state", "source_role", "total", "currency"];
function linkedChildren(store, row) {
  const bulkRows = store._bulk?.get("documents");
  if (!bulkRows)
    return store.db
      .prepare("SELECT id,kind,number,state,source_role,total,currency FROM documents WHERE source_id=? OR source_quote=? ORDER BY created,id")
      .all(row.id, row.id);
  let map = store._bulk.get("children");
  if (!map) {
    map = new Map();
    const linked = [...bulkRows.values()]
      .filter((r) => r.source_id || r.source_quote)
      .sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const r of linked)
      for (const parent of new Set([r.source_id, r.source_quote].filter(Boolean))) {
        if (!map.has(parent)) map.set(parent, []);
        map.get(parent).push(Object.fromEntries(LINK_COLUMNS.map((k) => [k, r[k]])));
      }
    store._bulk.set("children", map);
  }
  return map.get(row.id) || [];
}
export function attachDocuments(Store) {
  const P = Store.prototype;
  const original = {
    saveSettings: P.saveSettings,
    saveClient: P.saveClient,
    saveService: P.saveService,
    saveDocument: P.saveDocument,
    issue: P.issue,
    hydrate: P.hydrate,
    convert: P.convert,
    void: P.void,
    deleteDraft: P.deleteDraft,
    receive: P.receive,
    receipt: P.receipt,
    allocate: P.allocate,
    recordPayment: P.recordPayment,
    matchBank: P.matchBank,
    statement: P.statement,
    sstReport: P.sstReport,
  };
  Object.assign(P, {
    // --- Settings: prefixes, default language, PDF template, custom fields ---
    saveSettings(b) {
      return this.tx(() => {
        const before = documentSettings(this.settings());
        const out = original.saveSettings.call(this, b);
        const next = { ...out };
        for (const key of NEW_PREFIXES)
          if (key in b) {
            next[key] = text(String(b[key] ?? ""), 12, true);
            check(/^[A-Z][A-Z0-9-]{0,11}$/.test(next[key]), "Use uppercase letters/numbers for document prefixes.");
          }
        const prefixes = Object.values(KIND_PREFIX).map(([key, fallback]) => next[key] || fallback);
        check(new Set(prefixes).size === prefixes.length, "Each document type needs its own number prefix.");
        check(
          !prefixes.some((p) => RESERVED_PREFIXES.includes(p)),
          "CN, DN, RC and RF are reserved for financial notes and receipts.",
        );
        if ("documentLanguage" in b) {
          check(LANGUAGES.includes(b.documentLanguage), "Choose English, Bahasa Melayu or Chinese.");
          next.documentLanguage = b.documentLanguage;
        }
        if ("pdfLayout" in b) {
          check(LAYOUTS.includes(b.pdfLayout), "Choose a PDF layout.");
          next.pdfLayout = b.pdfLayout;
        }
        if ("pdfAccent" in b) {
          check(/^#[0-9A-Fa-f]{6}$/.test(String(b.pdfAccent || "")), "Use a colour like #087F7E.");
          next.pdfAccent = b.pdfAccent.toUpperCase();
        }
        for (const key of SHOW_KEYS) if (key in b) next[key] = bool(b[key]);
        if ("pdfFooterText" in b) next.pdfFooterText = text(String(b.pdfFooterText ?? ""), 160);
        if ("customFields" in b) next.customFields = this.cleanCustomFields(b.customFields, before.customFields);
        this.db.prepare("UPDATE settings SET data=? WHERE id=1").run(JSON.stringify(next));
        const pick = (s) => {
          const d = documentSettings(s);
          return Object.fromEntries(
            [...NEW_PREFIXES, ...Object.keys(TEMPLATE_DEFAULTS)].filter((k) => k !== "logoFileId").map((k) => [k, d[k]]),
          );
        };
        if (JSON.stringify(pick(before)) !== JSON.stringify(pick(next)))
          this.audit("settings.documents.changed", null, "Document settings", pick(before), pick(next));
        return next;
      });
    },
    cleanCustomFields(list, previous = []) {
      check(Array.isArray(list) && list.length <= 10, "Add up to 10 custom fields.");
      const known = new Set((previous || []).map((f) => f.id));
      const seen = new Set();
      return list.map((f) => {
        check(f && typeof f === "object", "Invalid custom field.");
        const fid = typeof f.id === "string" && known.has(f.id) ? f.id : id().replace(/-/g, "").slice(0, 10);
        check(!seen.has(fid), "Duplicate custom field.");
        seen.add(fid);
        const field = {
          id: fid,
          label: text(String(f.label ?? ""), 60, true),
          applies: f.applies || "all",
          show: f.show || "pdf",
        };
        check(["invoice", "quote", "all"].includes(field.applies), "Choose where the custom field applies.");
        check(["pdf", "internal"].includes(field.show), "Choose whether the custom field shows on the PDF.");
        return field;
      });
    },
    // --- Clients: default currency and document language ---
    saveClient(b, idv) {
      return this.tx(() => {
        const out = original.saveClient.call(this, b, idv);
        const sets = {};
        if (b.currency !== undefined && b.currency !== "") {
          check(CURRENCIES.includes(b.currency), "Choose a supported currency.");
          sets.currency = b.currency;
        }
        if (b.language !== undefined) {
          check(b.language === "" || LANGUAGES.includes(b.language), "Choose a document language.");
          sets.language = b.language;
        }
        // An individual has no contact person or SST registration of their own.
        if (b.kind !== undefined) {
          check(CLIENT_KINDS.includes(b.kind), "Choose the client type: company, individual, government or organisation.");
          sets.kind = b.kind;
          if (b.kind === "individual") Object.assign(sets, { contact: "", sst_number: "" });
        }
        for (const [key, value] of Object.entries(sets))
          this.db.prepare(`UPDATE clients SET ${key}=? WHERE id=?`).run(value, out.id);
        return Object.keys(sets).length ? this.client(out.id) : out;
      });
    },
    // --- Services: optional unique item code ---
    saveService(b, idv) {
      return this.tx(() => {
        const out = original.saveService.call(this, b, idv);
        if (b.sku !== undefined) {
          const sku = text(String(b.sku ?? ""), 40).toUpperCase();
          check(!sku || /^[A-Z0-9][A-Z0-9._\-/]{0,39}$/.test(sku), "Item codes use letters, numbers, dots, dashes and slashes.");
          check(
            !sku || !this.db.prepare("SELECT 1 FROM services WHERE sku=? AND id!=?").get(sku, out.id),
            "Another service already uses this item code.",
            409,
          );
          this.db.prepare("UPDATE services SET sku=? WHERE id=?").run(sku || null, out.id);
        }
        return { ...out, sku: this.db.prepare("SELECT sku FROM services WHERE id=?").get(out.id)?.sku ?? null };
      });
    },
    // --- Documents ---
    saveDocument(b, idv) {
      return this.tx(() => {
        check(b && typeof b === "object", "Invalid document.");
        const existing = idv ? this.db.prepare("SELECT * FROM documents WHERE id=?").get(idv) : null;
        const kind = existing?.kind || b.kind;
        const settings = documentSettings(this.settings());
        const input = { ...b };
        if (!existing) {
          const c = b.client_id ? this.db.prepare("SELECT currency,language FROM clients WHERE id=?").get(b.client_id) : null;
          // Documents that do not name a currency stay in MYR, as before: catalog
          // prices and recurring schedules are in MYR. The editor pre-selects the
          // client's default currency, and the language follows the client.
          if (!input.currency) input.currency = "MYR";
          if (!input.language) input.language = c?.language || settings.documentLanguage || "en";
          // Without a rate, use the last one entered for that currency.
          if (input.currency !== "MYR" && (input.fx_rate === undefined || input.fx_rate === "")) {
            const last = this.db
              .prepare(
                "SELECT fx_rate FROM documents WHERE currency=? AND fx_rate!='1' ORDER BY state='draft', updated DESC LIMIT 1",
              )
              .get(input.currency);
            if (last) input.fx_rate = last.fx_rate;
          }
        } else {
          if (!input.currency) delete input.currency;
          if (!input.language) delete input.language;
        }
        if (Array.isArray(b.items)) input.items = b.items.map((i) => this.catalogLine(i));
        const meta = existing ? JSON.parse(existing.meta || "{}") : {};
        // An issued quotation being edited (reviseQuote) prints with the custom
        // fields it was issued with, so its values follow those definitions,
        // even if a field was removed from Settings since.
        const fieldsFrom = existing && existing.state !== "draft" && existing.business_snapshot ? documentSettings(JSON.parse(existing.business_snapshot)) : settings;
        meta.custom = this.customValues(kind, b, meta.custom, fieldsFrom);
        if (kind === "quote") {
          const deposit = this.depositSetting(b, meta.deposit);
          if (deposit) meta.deposit = deposit;
          else delete meta.deposit;
        }
        if ("list_attachments" in b || b.doc_options) meta.list_attachments = bool(b.list_attachments);
        input[META] = meta;
        const language = input.language ?? existing?.language ?? "en";
        input[DEDUCTIONS] = this.depositDeductions(kind, existing || b[LINK] || null, language, idv);
        const out = original.saveDocument.call(this, input, idv);
        // An issued quotation edited into Chinese must still print: without a
        // Chinese font the edit is refused and the issued version stays as it was.
        if (existing && existing.state !== "draft" && this.needsCjk(out)) check(this.cjkFont(), CJK_MESSAGE, 409);
        if (kind === "quote" && meta.deposit)
          check(
            depositParts(out.items, meta.deposit).length,
            "The deposit must be more than zero and less than the quotation total before SST.",
          );
        return out;
      });
    },
    // A line picked from the catalog keeps its service, code and unit.
    catalogLine(i) {
      if (!i || typeof i !== "object" || !i.service_id) return i;
      const s = this.db.prepare("SELECT id,sku,unit FROM services WHERE id=?").get(String(i.service_id));
      if (!s) {
        const { service_id: _drop, ...rest } = i;
        return rest;
      }
      return { ...i, sku: s.sku || i.sku || "", unit: i.unit || s.unit };
    },
    customValues(kind, b, previous = {}, settings = documentSettings(this.settings())) {
      const out = {};
      for (const f of (settings.customFields || []).filter((f) => fieldApplies(f, kind))) {
        let v = b.custom && typeof b.custom === "object" ? b.custom[f.id] : undefined;
        if (b["cf_" + f.id] !== undefined) v = b["cf_" + f.id];
        if (v === undefined) v = previous?.[f.id];
        if (v === undefined || v === null) continue;
        v = text(String(v), 500);
        if (v) out[f.id] = v;
      }
      return out;
    },
    depositSetting(b, previous) {
      let type, value;
      if (b.deposit !== undefined) {
        if (!b.deposit) return null;
        type = b.deposit.type;
        value = type === "percent" ? b.deposit.value : b.deposit.amount !== undefined ? dec(Number(b.deposit.amount)) : b.deposit.value;
      } else if (b.deposit_type !== undefined) {
        type = b.deposit_type;
        value = b.deposit_value;
      } else return previous || null;
      if (!type) return null;
      check(["percent", "amount"].includes(type), "Choose a deposit percentage or amount.");
      if (type === "percent") {
        const bp = basisPoints(value);
        check(bp !== null && bp > 0 && bp < 10000, "A deposit percentage is between 0 and 100, with at most 2 decimal places.");
        return { type, value: String(bp / 100) };
      }
      const amount = money(value);
      check(amount > 0, "Enter the deposit amount.");
      return { type, amount };
    },
    // The quotation whose deposit invoices a final invoice must deduct.
    rootQuote(row) {
      if (!row || row.source_role === "deposit") return null;
      if (row.source_quote) return row.source_quote;
      if (!row.source_id) return null;
      const parent = this.db.prepare("SELECT id,kind,source_id FROM documents WHERE id=?").get(row.source_id);
      if (parent?.kind === "sales_order" && parent.source_id) {
        const q = this.db.prepare("SELECT id,kind FROM documents WHERE id=?").get(parent.source_id);
        if (q?.kind === "quote") return q.id;
      }
      return null;
    },
    depositInvoices(quoteId, exceptId = null) {
      return this.db
        .prepare(
          "SELECT * FROM documents WHERE source_id=? AND source_role='deposit' AND kind='invoice' AND state!='void' AND id IS NOT ? ORDER BY created,id",
        )
        .all(quoteId, exceptId);
    },
    // Deduction lines for every issued deposit invoice of the quotation: the
    // deposit's taxable value and SST come off at the same rates.
    depositDeductions(kind, row, language = "en", selfId = null) {
      if (kind !== "invoice") return [];
      const quoteId = this.rootQuote(row);
      if (!quoteId) return [];
      const deposits = this.depositInvoices(quoteId, selfId);
      check(
        !deposits.some((d) => d.state === "draft"),
        "Issue or delete the deposit invoice draft for this quotation first.",
        409,
      );
      const t = labels(language);
      return deposits.flatMap((dep) => {
        const lines = regularItems(JSON.parse(dep.items));
        const several = new Set(lines.map((l) => l.tax_rate || 0)).size > 1;
        return lines.map((l) => ({
          description: `${t("lessDeposit")} ${dep.number}${several ? ` (SST ${l.tax_rate || 0}%)` : ""}`,
          quantity: 1,
          rate: -l.amount,
          amount: -l.amount,
          tax_rate: l.tax_rate || 0,
          taxable: -(l.taxable ?? l.amount),
          tax: -(l.tax || 0),
          deposit_id: dep.id,
          deposit_number: dep.number,
        }));
      });
    },
    cjkFont() {
      let configured = null;
      try {
        configured = this.config("PDF_CJK_FONT");
      } catch {
        configured = null;
      }
      return cjkFontPath(configured);
    },
    // Chinese documents, and Chinese text in lines, notes or terms, need a CJK font.
    needsCjk(d) {
      return (
        d.language === "zh" ||
        [...d.items.flatMap((i) => [i.description, i.details]), d.notes, d.terms, ...Object.values(d.meta?.custom || {})].some(hasCjk)
      );
    },
    issue(idv) {
      return this.tx(() => {
        const d = this.document(idv);
        if (d.state === "draft") {
          if (this.needsCjk(d)) check(this.cjkFont(), CJK_MESSAGE, 409);
          if (d.kind === "invoice") {
            const row = this.db.prepare("SELECT * FROM documents WHERE id=?").get(idv);
            const expected = this.depositDeductions("invoice", row, d.language, idv);
            const key = (list) => JSON.stringify(list.map((l) => [l.deposit_id, l.tax_rate, l.taxable, l.tax]));
            check(
              key(expected) === key(d.items.filter((i) => i.deposit_id)),
              "The deposit invoices for this quotation changed. Open the draft and save it again.",
              409,
            );
          }
        }
        return original.issue.call(this, idv);
      });
    },
    hydrate(row) {
      const d = original.hydrate.call(this, row);
      bindPdf(d.business, this);
      if (row.business_snapshot) freezeBusiness(d.business);
      const children = linkedChildren(this, row);
      const parentId = row.source_id || row.source_quote;
      const bulkRows = this._bulk?.get("documents");
      const parent = parentId && bulkRows ? bulkRows.get(parentId) : null;
      const source = !parentId
        ? null
        : bulkRows
          ? parent
            ? { id: parent.id, kind: parent.kind, number: parent.number, state: parent.state }
            : null
          : this.db.prepare("SELECT id,kind,number,state FROM documents WHERE id=?").get(parentId) || null;
      d.links = { source, source_role: row.source_role || (row.source_quote ? "conversion" : null), children };
      const active = children.filter((c) => c.state !== "void");
      if (["proforma", "sales_order", "delivery_order"].includes(d.kind)) {
        d.paid = 0;
        d.balance = 0;
        if (["issued", "accepted"].includes(d.state)) {
          const invoiced = active.some((c) => c.kind === "invoice" && c.state !== "draft"),
            delivered = active.some((c) => c.kind === "delivery_order" && c.state !== "draft");
          if (d.kind === "proforma" && invoiced) d.status = "Converted";
          if (d.kind === "sales_order")
            d.status = invoiced && delivered ? "Completed" : invoiced ? "Invoiced" : delivered ? "Delivered" : d.status;
        }
      }
      if (d.kind === "quote" && d.meta.deposit) {
        const parts = depositParts(d.items, d.meta.deposit);
        const amount = parts.reduce((s, p) => s + p.amount, 0),
          tax = parts.reduce((s, p) => s + p.tax, 0);
        const invoice = active.find((c) => c.source_role === "deposit") || null;
        d.deposit = { ...d.meta.deposit, parts, amount, tax, total: amount + tax, invoice };
      }
      d.instalments = [];
      d.next_due_date = null;
      d.next_due_amount = 0;
      if (d.kind === "invoice") {
        const rows = this.rowsOf(
          "instalments",
          "invoice_id",
          row.id,
          () => this.db.prepare("SELECT seq,due_date,amount FROM document_instalments WHERE invoice_id=? ORDER BY seq").all(row.id),
          "SELECT invoice_id,seq,due_date,amount FROM document_instalments ORDER BY seq",
        ).map(({ seq, due_date, amount }) => ({ seq, due_date, amount }));
        const open = d.state === "issued" && d.balance > 0;
        if (rows.length) {
          const plan = instalmentSchedule(rows, d.adjusted_total ?? d.total, d.paid);
          d.instalments = plan.instalments;
          if (open) {
            d.next_due_date = plan.next_due_date;
            d.next_due_amount = plan.next_due_amount;
            if (["Overdue", "Issued", "Viewed", "Part-paid"].includes(d.status))
              d.status =
                d.next_due_date && d.next_due_date < today()
                  ? "Overdue"
                  : d.paid > 0
                    ? "Part-paid"
                    : d.viewed_at
                      ? "Viewed"
                      : "Issued";
          }
        } else if (open) {
          d.next_due_date = d.due_date;
          d.next_due_amount = d.balance;
        }
      }
      d.attachments = this.rowsOf(
        "attachments",
        "entity_id",
        row.id,
        () => this.files("document", row.id, "attachment"),
        "SELECT id,entity_type,entity_id,purpose,name,mime,size,sha256,visibility,created_by,created FROM files WHERE entity_type='document' AND purpose='attachment' ORDER BY created,id",
      );
      return d;
    },
    convert(idv) {
      return this.tx(() => {
        const so = this.db
          .prepare(
            "SELECT number FROM documents WHERE source_id=? AND kind='sales_order' AND state!='void'",
          )
          .get(idv);
        check(
          !so,
          `This quotation has sales order ${so?.number || "(draft)"}. Create the invoice from the sales order.`,
          409,
        );
        return original.convert.call(this, idv);
      });
    },
    // Creates (or opens) the linked document: quotation -> sales order,
    // proforma -> invoice, sales order -> invoice or delivery order, invoice -> delivery order.
    deriveDocument(sid, to) {
      return this.tx(() => {
        const s = this.document(sid);
        check(KINDS.includes(to) && (CONVERSIONS[s.kind] || []).includes(to), "This document cannot be converted to that type.");
        check(
          s.kind === "quote" ? s.state === "accepted" : s.state === "issued",
          s.kind === "quote" ? "Accept the quotation before creating a sales order." : "Issue the document before converting it.",
          409,
        );
        const old = this.db
          .prepare(
            "SELECT id FROM documents WHERE source_id=? AND kind=? AND source_role='conversion' AND state!='void' ORDER BY created LIMIT 1",
          )
          .get(sid, to);
        if (old) return this.document(old.id);
        if (s.kind === "quote")
          check(
            !this.db.prepare("SELECT 1 FROM documents WHERE source_quote=? AND state!='void'").get(sid),
            "This quotation already has an invoice.",
            409,
          );
        const c = this.client(s.client_id);
        const delivery = to === "delivery_order";
        const d = this.saveDocument({
          kind: to,
          client_id: s.client_id,
          issue_date: today(),
          due_date: to === "invoice" ? addDays(today(), c.terms) : delivery ? today() : addDays(today(), 14),
          items: regularItems(s.items).map((i) => (delivery ? { ...itemInput(i), rate: "0", tax_rate: 0 } : itemInput(i))),
          discount: delivery ? "0" : dec(s.discount),
          notes: s.notes,
          terms: delivery ? "" : s.terms,
          currency: s.currency,
          fx_rate: s.fx_rate,
          language: s.language,
          custom: s.meta?.custom || {},
          [LINK]: { source_id: sid, source_role: "conversion" },
        });
        this.audit("document.converted", sid, `${s.number} to ${to}`, null, { id: d.id, kind: to });
        return d;
      });
    },
    // One deposit invoice per accepted quotation, split by SST rate.
    createDepositInvoice(qid) {
      return this.tx(() => {
        const q = this.document(qid);
        check(q.kind === "quote" && q.state === "accepted", "Accept the quotation before invoicing its deposit.", 409);
        check(q.meta?.deposit, "This quotation does not ask for a deposit.");
        const old = this.depositInvoices(qid)[0];
        if (old) return this.document(old.id);
        const invoiced =
          this.db.prepare("SELECT 1 FROM documents WHERE source_quote=? AND state!='void'").get(qid) ||
          this.db
            .prepare(
              "SELECT 1 FROM documents i JOIN documents o ON o.id=i.source_id WHERE o.source_id=? AND o.kind='sales_order' AND i.kind='invoice' AND i.state!='void'",
            )
            .get(qid);
        check(!invoiced, "This quotation is already invoiced. Add the deposit to that invoice instead.", 409);
        const parts = depositParts(q.items, q.meta.deposit);
        check(parts.length, "The deposit must be less than the quotation total before SST.");
        const t = labels(q.language);
        const share = q.meta.deposit.type === "percent" ? ` ${q.meta.deposit.value}%` : "";
        const c = this.client(q.client_id);
        const d = this.saveDocument({
          kind: "invoice",
          client_id: q.client_id,
          issue_date: today(),
          due_date: addDays(today(), c.terms),
          items: parts.map((p) => ({
            description: `${t("deposit")}${share} ${t("forQuotation")} ${q.number}${parts.length > 1 ? ` (SST ${p.rate}%)` : ""}`,
            quantity: 1,
            rate: dec(p.amount),
            tax_rate: p.rate,
          })),
          discount: "0",
          notes: "",
          terms: q.terms,
          currency: q.currency,
          fx_rate: q.fx_rate,
          language: q.language,
          [LINK]: { source_id: qid, source_role: "deposit" },
        });
        this.audit("quotation.deposit.invoiced", qid, d.id, null, { invoice_id: d.id, amount: d.total });
        return d;
      });
    },
    void(idv, reason) {
      return this.tx(() => {
        const kids = this.db
          .prepare("SELECT number,kind,state FROM documents WHERE source_id=? AND state!='void'")
          .all(idv);
        check(
          !kids.length,
          `This document has linked ${kids[0]?.number || "draft " + String(kids[0]?.kind || "").replace("_", " ")}. Void or delete it first.`,
          409,
        );
        const deducted = this.db
          .prepare("SELECT number FROM documents WHERE kind='invoice' AND state!='void' AND id!=? AND instr(items, ?) > 0")
          .get(idv, `"deposit_id":"${idv}"`);
        check(
          !deducted,
          `This deposit is deducted on ${deducted?.number || "a draft invoice"}. Void or delete that invoice first.`,
          409,
        );
        const out = original.void.call(this, idv, reason);
        this.db.prepare("DELETE FROM document_instalments WHERE invoice_id=?").run(idv);
        return out;
      });
    },
    // Attachments go with the draft: the core files wrapper deletes every file
    // owned by a deleted record (store.deleteFilesFor).
    deleteDraft(did) {
      return original.deleteDraft.call(this, did);
    },
    // --- Instalments ---
    setInstalments(iid, list) {
      return this.tx(() => {
        const d = this.document(iid);
        check(d.kind === "invoice" && d.state === "issued", "Instalments need an issued invoice.", 409);
        check(d.balance > 0, "This invoice has no balance left to split.", 409);
        check(Array.isArray(list) && list.length >= 2 && list.length <= 24, "Split the invoice into 2 to 24 instalments.");
        let previous = null;
        const rows = list.map((x, n) => {
          check(x && typeof x === "object", "Invalid instalment.");
          const due_date = date(x.due_date);
          const amount = money(x.amount);
          check(amount > 0, "Each instalment needs an amount.");
          check(due_date >= d.issue_date, "Instalments cannot be due before the invoice date.");
          check(!previous || due_date > previous, "Put instalments in date order, one per date.");
          previous = due_date;
          return { seq: n + 1, due_date, amount };
        });
        const sum = rows.reduce((s, r) => s + r.amount, 0);
        check(
          sum === d.adjusted_total,
          `Instalments must add up to the invoice total (${dec(d.adjusted_total)}); they add up to ${dec(sum)}.`,
        );
        const before = d.instalments.map((i) => ({ due_date: i.due_date, amount: i.planned }));
        this.db.prepare("DELETE FROM document_instalments WHERE invoice_id=?").run(iid);
        for (const r of rows)
          this.db
            .prepare("INSERT INTO document_instalments(invoice_id,seq,due_date,amount,created) VALUES(?,?,?,?,?)")
            .run(iid, r.seq, r.due_date, r.amount, now());
        this.audit(
          "invoice.instalments.set",
          iid,
          `${rows.length} instalments`,
          before.length ? before : null,
          rows.map(({ due_date, amount }) => ({ due_date, amount })),
        );
        return this.document(iid);
      });
    },
    clearInstalments(iid) {
      return this.tx(() => {
        const d = this.document(iid);
        check(d.instalments.length, "This invoice has no instalment plan.", 404);
        this.db.prepare("DELETE FROM document_instalments WHERE invoice_id=?").run(iid);
        this.audit(
          "invoice.instalments.cleared",
          iid,
          "",
          d.instalments.map((i) => ({ due_date: i.due_date, amount: i.planned })),
          null,
        );
        return this.document(iid);
      });
    },
    // --- Attachments ---
    addAttachment(did, { name, data, visibility }) {
      return this.tx(() => {
        const d = this.document(did);
        check(d.state !== "void", "This document is void.", 409);
        check(
          this.files("document", did, "attachment").length < ATTACHMENT_LIMIT,
          `A document can have up to ${ATTACHMENT_LIMIT} attachments.`,
          409,
        );
        return this.saveFile({
          entity_type: "document",
          entity_id: did,
          purpose: "attachment",
          name: name || "attachment",
          data,
          visibility: visibility === "client" ? "client" : "private",
        });
      });
    },
    attachment(fid) {
      const f = this.db
        .prepare("SELECT id,entity_type,entity_id,purpose,name,mime,size,visibility,created FROM files WHERE id=?")
        .get(fid);
      check(f && f.entity_type === "document" && f.purpose === "attachment", "Attachment not found.", 404);
      return f;
    },
    setAttachmentVisibility(fid, visibility) {
      const f = this.attachment(fid);
      check(["client", "private"].includes(visibility), "Choose who can see the attachment.");
      this.db.prepare("UPDATE files SET visibility=? WHERE id=?").run(visibility, fid);
      this.audit("file.visibility.changed", f.entity_id, f.name, { visibility: f.visibility }, { visibility });
      return this.attachment(fid);
    },
    removeAttachment(fid) {
      this.attachment(fid);
      this.deleteFile(fid);
    },
    // A client-visible attachment of the document behind a client link.
    publicAttachment(token, fid) {
      const d = this.publicDocument(token);
      const f = this.db.prepare("SELECT * FROM files WHERE id=?").get(String(fid));
      check(
        f &&
          f.entity_type === "document" &&
          f.entity_id === d.id &&
          f.purpose === "attachment" &&
          f.visibility === "client",
        "File not found.",
        404,
      );
      return { ...f, data: Buffer.from(f.data) };
    },
    // --- Business logo ---
    setLogo({ name, data }) {
      return this.tx(() => {
        const f = this.saveFile(
          { entity_type: "business", entity_id: "workspace", purpose: "logo", name: name || "logo", data, visibility: "client" },
          { accept: ["image/png", "image/jpeg"], maxBytes: 1024 * 1024 },
        );
        const s = this.settings();
        this.db.prepare("UPDATE settings SET data=? WHERE id=1").run(JSON.stringify({ ...s, logoFileId: f.id }));
        this.audit("settings.logo.changed", null, f.name, { logoFileId: s.logoFileId || null }, { logoFileId: f.id });
        return f;
      });
    },
    clearLogo() {
      const s = this.settings();
      // The file is kept: issued documents still show the logo they were issued with.
      this.db.prepare("UPDATE settings SET data=? WHERE id=1").run(JSON.stringify({ ...s, logoFileId: null }));
      this.audit("settings.logo.changed", null, "Logo removed", { logoFileId: s.logoFileId || null }, { logoFileId: null });
    },
    // Logo bytes for a document's business snapshot. A frozen snapshot (issued
    // document, receipt) keeps the logo it was issued with. One issued before
    // the business had a logo showed only the Nawlogic placeholder: it takes
    // the business's logo once uploaded. Drafts and live settings use the
    // current logo.
    logoFor(business) {
      const ids = business?.frozen && business.logoFileId ? [business.logoFileId] : [business?.logoFileId, this.settings().logoFileId];
      for (const fid of ids) {
        if (!fid) continue;
        const f = this.db.prepare("SELECT mime,data FROM files WHERE id=? AND purpose='logo'").get(fid);
        if (f && ["image/png", "image/jpeg"].includes(f.mime)) return { mime: f.mime, data: Buffer.from(f.data) };
      }
      return null;
    },
    // --- Money received in other currencies ---
    receive(b) {
      return this.tx(() => {
        check(b && typeof b === "object", "Invalid receipt.");
        const { allocations, ...rest } = b;
        let invoice = null;
        if (Array.isArray(allocations) && allocations[0]?.invoice_id)
          invoice = this.db.prepare("SELECT currency,fx_rate FROM documents WHERE id=?").get(String(allocations[0].invoice_id));
        const currency = b.currency || invoice?.currency || "MYR";
        check(CURRENCIES.includes(currency), "Choose a supported currency.");
        const rate = currency === "MYR" ? "1" : fxRate(b.fx_rate ?? (invoice?.currency === currency ? invoice.fx_rate : undefined));
        const r = original.receive.call(this, rest);
        this.db.prepare("UPDATE cash_receipts SET currency=?,fx_rate=? WHERE id=?").run(currency, rate, r.id);
        if (allocations) {
          check(Array.isArray(allocations) && allocations.length <= 50, "Invalid allocations.");
          for (const a of allocations) this.allocate(r.id, a);
        }
        return this.receipt(r.id);
      });
    },
    receipt(rid) {
      const r = original.receipt.call(this, rid);
      bindPdf(r.business, this);
      freezeBusiness(r.business);
      return { ...r, currency: r.currency || "MYR", fx_rate: r.fx_rate || "1" };
    },
    allocate(rid, b) {
      const r = this.db.prepare("SELECT currency FROM cash_receipts WHERE id=?").get(rid);
      const d = b?.invoice_id ? this.db.prepare("SELECT currency FROM documents WHERE id=?").get(String(b.invoice_id)) : null;
      if (r && d)
        check(
          (r.currency || "MYR") === (d.currency || "MYR"),
          `This receipt is in ${r.currency}; it can only pay ${r.currency} invoices.`,
          409,
        );
      return original.allocate.call(this, rid, b);
    },
    recordPayment(iid, b) {
      const d = this.document(iid);
      return original.recordPayment.call(this, iid, {
        ...b,
        currency: d.currency,
        fx_rate: d.currency === "MYR" ? "1" : b.fx_rate || d.fx_rate,
      });
    },
    // Bank statements are in MYR, so only MYR receipts match bank lines.
    matchBank(tid, b) {
      if ((b?.kind || "receipt") === "receipt" && b?.target_id) {
        const r = this.db.prepare("SELECT currency FROM cash_receipts WHERE id=?").get(String(b.target_id));
        check(!r || (r.currency || "MYR") === "MYR", "Bank matching is for MYR receipts only.", 409);
      }
      return original.matchBank.call(this, tid, b);
    },
    // Statements show one section per currency.
    statement(cid, b = {}) {
      if (b.currency) {
        const s = original.statement.call(this, cid, b);
        bindPdf(s.business, this);
        return { ...s, currency: b.currency };
      }
      const found = this.db
        .prepare("SELECT DISTINCT currency FROM documents WHERE client_id=? AND kind='invoice' AND state='issued'")
        .all(cid)
        .map((r) => r.currency || "MYR");
      // MYR first, then the other currencies alphabetically.
      const currencies = found.length
        ? [...new Set(found)].sort((x, y) => (x === "MYR" ? -1 : y === "MYR" ? 1 : x.localeCompare(y)))
        : ["MYR"];
      const groups = currencies.map((currency) => {
        const s = original.statement.call(this, cid, { ...b, currency });
        return { ...s, currency };
      });
      const main = groups[0];
      bindPdf(main.business, this);
      return { ...main, groups };
    },
    // SST figures for reporting are in MYR, converted at each invoice's rate.
    sstReport(b = {}) {
      const r = original.sstReport.call(this, b);
      if (r.currency === "MYR") return r;
      const rates = new Map(
        this.db
          .prepare("SELECT number,currency,fx_rate FROM documents WHERE kind='invoice' AND number IS NOT NULL")
          .all()
          .map((x) => [x.number, x]),
      );
      const convert = (number, amount) => {
        const x = rates.get(number);
        return x && x.currency !== "MYR" ? toMYR(amount, x.fx_rate) : amount;
      };
      const rows = r.rows.map((x) => {
        const f = rates.get(x.number);
        if (!f || f.currency === "MYR") return { ...x, currency: "MYR", fx_rate: "1" };
        return {
          ...x,
          currency: f.currency,
          fx_rate: f.fx_rate,
          taxable_original: x.taxable,
          tax_original: x.tax,
          taxable: toMYR(x.taxable, f.fx_rate),
          tax: toMYR(x.tax, f.fx_rate),
        };
      });
      const byRate = new Map();
      for (const x of rows) {
        const t = byRate.get(x.rate) || { rate: x.rate, taxable: 0, tax: 0 };
        t.taxable += x.taxable;
        t.tax += x.tax;
        byRate.set(x.rate, t);
      }
      return {
        ...r,
        currency: "MYR",
        rows,
        rates: [...byRate.values()].sort((a, c) => a.rate - c.rate),
        tax: rows.reduce((s, x) => s + x.tax, 0),
        notes: r.notes.map((n) => ({ ...n, amount: convert(n.invoice, n.amount) })),
      };
    },
  });
}
export { AppError };
