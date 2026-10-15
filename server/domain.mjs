import { randomUUID, createHash } from "node:crypto";
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
export function calculate(items, discount = "0") {
  check(
    Array.isArray(items) && items.length > 0 && items.length <= 50,
    "Add between 1 and 50 line items.",
  );
  const clean = items.map((item) => {
    const description = text(item.description, 240, true);
    const rate = money(item.rate);
    const q = String(item.quantity);
    check(
      /^\d{1,5}(\.\d{1,2})?$/.test(q) && Number(q) > 0,
      "Quantity must be positive with at most 2 decimal places.",
    );
    const quantity = Math.round(Number(q) * 100);
    const amount = Math.round((rate * quantity) / 100);
    check(
      Number.isSafeInteger(amount) && amount <= 9999999999,
      "Line total is too large.",
    );
    return { description, quantity: quantity / 100, rate, amount };
  });
  const subtotal = clean.reduce((sum, i) => sum + i.amount, 0);
  const off = money(discount);
  check(
    subtotal <= 9999999999 && off <= subtotal,
    "Discount cannot exceed subtotal.",
  );
  check(subtotal - off > 0, "Document total must be greater than zero.");
  return { items: clean, subtotal, discount: off, total: subtotal - off };
}
export function addDays(value, n) {
  const d = new Date(value + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Clamp month-end (31 Jan -> 28/29 Feb), instead of skipping February.
export function nextMonth(value) {
  const d = new Date(value + "T00:00:00Z");
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const end = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, end));
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
  if (paid >= doc.total) return "Paid";
  if (doc.due_date < asOf) return "Overdue";
  if (paid > 0) return "Part-paid";
  return doc.viewed_at ? "Viewed" : "Issued";
}
export const amountString = (cents) => (cents / 100).toFixed(2);
export const currency = (cents) =>
  new Intl.NumberFormat("en-MY", { style: "currency", currency: "MYR" }).format(
    cents / 100,
  );
