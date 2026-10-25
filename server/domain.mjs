import { randomUUID, createHash } from "node:crypto";
import {
  allocate,
  totals,
  basisPoints,
  percentOf,
  taxByRate,
  KINDS,
  CURRENCIES,
  LANGUAGES,
  toMYR,
} from "../public/ext/documents-calc.mjs";
export { KINDS, CURRENCIES, LANGUAGES, toMYR };
export const id = () => randomUUID();
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const now = () => new Date().toISOString();
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function check(condition, message, status = 400) {
  if (!condition) throw new AppError(message, status);
}
export function text(v, max = 200, required = false) {
  check(typeof v === "string", "Expected text.");
  v = v.trim();
  check(v.length <= max, `Text must be ${max} characters or fewer.`);
  check(!required || v.length > 0, "Required field is missing.");
  check(
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v),
    "Invalid control character.",
  );
  return v;
}
export function date(v) {
  check(
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v),
    "Use a valid date.",
  );
  const parsed = new Date(v + "T00:00:00Z");
  check(
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === v,
    "Invalid calendar date.",
  );
  check(
    v >= "2000-01-01" && v <= "2100-12-31",
    "Date outside supported range.",
  );
  return v;
}
export function money(v) {
  check(
    typeof v === "string" || typeof v === "number",
    "Enter a valid amount.",
  );
  const s = String(v);
  check(
    /^\d{1,8}(\.\d{1,2})?$/.test(s),
    "Amounts need at most 2 decimal places.",
  );
  const [a, b = ""] = s.split(".");
  return Number(a) * 100 + Number(b.padEnd(2, "0"));
}
export function integer(v, min, max) {
  check(
    Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max,
    "Number outside allowed range.",
  );
  return Number(v);
}
// Exchange rate as a decimal string: MYR per 1 unit of the document currency.
export function fxRate(value) {
  const s = String(value ?? "").trim();
  check(
    /^\d{1,6}(\.\d{1,6})?$/.test(s) && Number(s) > 0,
    "Enter the exchange rate as MYR per 1 unit, with up to 6 decimal places.",
  );
  return s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
// Malaysian SST rates: sales tax 5%/10%, service tax 6%/8%.
export const TAX_RATES = [0, 5, 6, 8, 10];
// Splits a document discount across lines in proportion to their amounts
// (largest remainder method), so no line's share ever exceeds its amount.
// The arithmetic lives in public/ext/documents-calc.mjs so the editor preview matches.
export const allocateDiscount = allocate;
// Server-only input to saveDocument: deposit deduction lines derived from issued
// deposit invoices. A Symbol key can never arrive in a JSON request body.
export const DEDUCTIONS = Symbol("deposit deductions");
// Server-only input to saveDocument: { source_quote, source_id, source_role } for a new document.
export const LINK = Symbol("document link");
// Server-only input to saveDocument: sanitized module data stored in documents.meta.
export const META = Symbol("document meta");
// Server-only input to saveDocument: this save edits an issued quotation (Store.reviseQuote).
export const REVISE = Symbol("edit an issued quotation");
export const KIND_PREFIX = {
  invoice: ["invoicePrefix", "INV"],
  quote: ["quotePrefix", "QT"],
  proforma: ["proformaPrefix", "PF"],
  sales_order: ["salesOrderPrefix", "SO"],
  delivery_order: ["deliveryOrderPrefix", "DO"],
};
// Number prefix for a document kind, from Settings with a default.
export const prefixFor = (kind, settings) =>
  settings[KIND_PREFIX[kind][0]] || KIND_PREFIX[kind][1];
// Delivery orders list goods and quantities only, so they carry no prices.
export const priced = (kind) => kind !== "delivery_order";
export function calculate(items, discount = "0", { kind = "invoice", deductions = [] } = {}) {
  check(
    Array.isArray(items) && items.length > 0 && items.length <= 50,
    "Add between 1 and 50 line items.",
  );
  const withPrices = priced(kind);
  const clean = items.map((item, idx) => {
    check(item && typeof item === "object", "Invalid line item.");
    const description = text(item.description, 240, true);
    const rate = withPrices ? money(item.rate) : 0;
    const q = String(item.quantity);
    check(
      /^\d{1,5}(\.\d{1,2})?$/.test(q) && Number(q) > 0,
      "Quantity must be positive with at most 2 decimal places.",
    );
    const quantity = Math.round(Number(q) * 100);
    const gross = Math.round((rate * quantity) / 100);
    check(
      Number.isSafeInteger(gross) && gross <= 9999999999,
      "Line total is too large.",
    );
    const tax_rate = withPrices ? Number(item.tax_rate ?? 0) : 0;
    check(TAX_RATES.includes(tax_rate), "Choose an SST rate of 0, 5, 6, 8 or 10%.");
    const line = { description, quantity: quantity / 100, rate, amount: gross, tax_rate };
    // A line discount is a percentage or an amount; the result is stored in sen.
    const percent = withPrices ? String(item.discount_percent ?? "").trim() : "";
    const fixed = withPrices ? String(item.discount_amount ?? "").trim() : "";
    let off = 0;
    if (percent && Number(percent) !== 0) {
      const bp = basisPoints(percent);
      check(
        bp !== null && bp <= 10000,
        "Line discounts are 0 to 100% with at most 2 decimal places.",
      );
      off = percentOf(gross, bp);
      if (off) line.discount_percent = String(bp / 100);
    } else if (fixed && Number(fixed) !== 0) {
      off = money(fixed);
      check(off <= gross, "A line discount cannot be more than the line amount.");
      if (off) line.discount_amount = (off / 100).toFixed(2);
    }
    if (off) {
      line.gross = gross;
      line.discount = off;
      line.amount = gross - off;
    }
    // The longer description under the title (public/ext/line-details.mjs markup).
    if (item.details) {
      const details = String(item.details).replace(/\r\n?/g, "\n").trim();
      check(details.length <= 3000, `Line ${idx + 1}: the description can have up to 3000 characters.`);
      line.details = text(details, 3000);
      if (!line.details) delete line.details;
    }
    if (item.sku) {
      line.sku = text(String(item.sku), 40).toUpperCase();
      if (!line.sku) delete line.sku;
    }
    if (item.unit) {
      line.unit = text(String(item.unit), 30);
      if (!line.unit) delete line.unit;
    }
    if (item.service_id) {
      check(/^[\w-]{1,80}$/.test(String(item.service_id)), "Invalid catalog item.");
      line.service_id = String(item.service_id);
    }
    return line;
  });
  const off = withPrices ? money(discount) : 0;
  const subtotal = clean.reduce((sum, i) => sum + i.amount, 0);
  check(
    subtotal <= 9999999999 && off <= subtotal,
    "Discount cannot exceed subtotal.",
  );
  const result = totals(
    clean.map((i) => ({ gross: i.gross ?? i.amount, discount: i.discount || 0, tax_rate: i.tax_rate })),
    off,
    deductions,
  );
  for (const [n, i] of clean.entries()) {
    i.taxable = result.lines[n].taxable;
    i.tax = result.lines[n].tax;
  }
  // A deposit deduction can never take a rate below zero taxable value or SST.
  for (const rate of new Set(deductions.map((d) => d.tax_rate))) {
    const at = (list, key) =>
      list.filter((i) => i.tax_rate === rate).reduce((s, i) => s + i[key], 0);
    check(
      -at(deductions, "taxable") <= at(clean, "taxable") && -at(deductions, "tax") <= at(clean, "tax"),
      `The deposit already invoiced at SST ${rate}% is more than the lines at that rate.`,
    );
  }
  if (withPrices)
    check(result.total > 0, "Document total must be greater than zero.");
  return {
    items: [...clean, ...deductions],
    subtotal: result.subtotal,
    discount: off,
    tax: result.tax,
    total: result.total,
  };
}
// A stored line as saveDocument input, for converting or copying a document.
// Deposit deductions are never copied: they are derived from deposit invoices.
export function itemInput(i) {
  const out = {
    description: i.description,
    quantity: String(i.quantity),
    rate: (i.rate / 100).toFixed(2),
    tax_rate: i.tax_rate ?? 0,
  };
  if (i.discount_percent) out.discount_percent = i.discount_percent;
  else if (i.discount) out.discount_amount = (i.discount / 100).toFixed(2);
  for (const key of ["details", "sku", "unit", "service_id"]) if (i[key]) out[key] = i[key];
  return out;
}
export const regularItems = (items) => items.filter((i) => !i.deposit_id);
export function addDays(value, n) {
  const d = new Date(value + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Clamp month-end (31 Jan -> 28/29 Feb), instead of skipping February.
export function nextMonth(value, anchorDay = null, monthEnd = false) {
  const d = new Date(value + "T00:00:00Z");
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const end = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(monthEnd ? end : Math.min(anchorDay ?? day, end));
  return d.toISOString().slice(0, 10);
}
export function status(doc, paid = 0, asOf = today()) {
  if (doc.state === "void") return "Void";
  if (doc.state === "draft") return "Draft";
  if (doc.kind === "quote") {
    if (doc.state === "accepted") return "Accepted";
    if (doc.state === "declined") return "Declined";
    return doc.due_date < asOf
      ? "Expired"
      : doc.viewed_at
        ? "Viewed"
        : "Issued";
  }
  // Proforma invoices, sales orders and delivery orders never carry a balance.
  if (doc.kind && doc.kind !== "invoice") return doc.viewed_at ? "Viewed" : "Issued";
  if (paid >= doc.total) return "Paid";
  if (doc.due_date < asOf) return "Overdue";
  if (paid > 0) return "Part-paid";
  return doc.viewed_at ? "Viewed" : "Issued";
}
export const amountString = (cents) => (cents / 100).toFixed(2);
export const currency = (cents, code = "MYR") =>
  new Intl.NumberFormat("en-MY", { style: "currency", currency: code || "MYR" }).format(
    cents / 100,
  );
// Groups a document's lines by SST rate for display and reporting.
export const taxSummary = taxByRate;
