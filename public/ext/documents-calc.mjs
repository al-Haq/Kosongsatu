// Document arithmetic shared by the server (calculate() in server/domain.mjs)
// and the editor's live preview, so both always produce the same totals.
// Pure functions only: no DOM, no Node APIs. Amounts are integer minor units.

// Document kinds. Only "invoice" affects money (payments, balances, SST, reports).
export const KINDS = ["invoice", "quote", "proforma", "sales_order", "delivery_order"];
// Two-decimal currencies a document can be issued in. MYR is the home currency.
export const CURRENCIES = ["MYR", "USD", "SGD", "EUR", "GBP", "AUD", "CNY", "HKD", "THB", "IDR", "BND"];
export const LANGUAGES = ["en", "ms", "zh"];

// Splits a document discount across lines in proportion to their amounts
// (largest remainder method), so no line's share ever exceeds its amount.
export function allocate(amounts, off) {
  const subtotal = amounts.reduce((s, a) => s + a, 0);
  if (!off || !subtotal) return amounts.map(() => 0);
  // BigInt keeps off * amount exact for amounts up to RM 99,999,999.99.
  const total = BigInt(subtotal),
    discount = BigInt(off);
  const shares = amounts.map((a) => Number((discount * BigInt(a)) / total));
  let left = off - shares.reduce((s, v) => s + v, 0);
  const order = amounts
    .map((a, n) => [(discount * BigInt(a)) % total, a, n])
    .sort((x, y) => (x[0] === y[0] ? y[1] - x[1] : x[0] < y[0] ? 1 : -1));
  for (const [, a, n] of order) {
    if (!left) break;
    if (shares[n] < a) {
      shares[n]++;
      left--;
    }
  }
  return shares;
}

// A percentage with up to 2 decimals as basis points ("12.5" -> 1250), or null.
export function basisPoints(value) {
  const s = String(value ?? "").trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  const [a, b = ""] = s.split(".");
  return Number(a) * 100 + Number(b.padEnd(2, "0"));
}
// amount x percentage, rounded half up (amount >= 0).
export function percentOf(amount, bp) {
  return Number((BigInt(amount) * BigInt(bp) + 5000n) / 10000n);
}

// Totals for parsed lines.
//   lines: [{ gross, discount, tax_rate }]   gross = quantity x rate, discount = line discount
//   off: document discount, spread over the lines after their own discounts
//   deductions: fixed lines copied from deposit invoices: [{ amount, tax }] (negative)
// SST is charged on each line after its own discount and its share of the document discount.
export function totals(lines, off = 0, deductions = []) {
  const amounts = lines.map((l) => l.gross - (l.discount || 0));
  const subtotal = amounts.reduce((s, a) => s + a, 0);
  const shares = allocate(amounts, Math.min(Math.max(off, 0), subtotal));
  const out = lines.map((l, n) => {
    const taxable = amounts[n] - shares[n];
    return { amount: amounts[n], taxable, tax: Math.round((taxable * (l.tax_rate || 0)) / 100) };
  });
  const lineTax = out.reduce((s, l) => s + l.tax, 0);
  const deducted = deductions.reduce((s, d) => s + d.amount, 0),
    deductedTax = deductions.reduce((s, d) => s + d.tax, 0);
  const tax = lineTax + deductedTax;
  return { lines: out, subtotal, discount: off, tax, total: subtotal - off + tax + deducted };
}

// MYR value of an amount in another currency at a decimal "MYR per 1 unit" rate
// (up to 6 decimals), rounded half away from zero. MYR amounts are returned as is.
export function toMYR(amount, rate = "1") {
  const s = String(rate ?? "1");
  if (s === "1" || !amount) return amount || 0;
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return amount;
  const micro = BigInt(m[1]) * 1000000n + BigInt((m[2] || "").padEnd(6, "0"));
  const sign = amount < 0 ? -1n : 1n;
  const v = (BigInt(Math.abs(amount)) * micro + 500000n) / 1000000n;
  return Number(v * sign);
}

// SST rates, per rate, of a set of document lines (deposit deductions included).
export function taxByRate(items) {
  const byRate = new Map();
  for (const i of items)
    if (i.tax_rate) byRate.set(i.tax_rate, (byRate.get(i.tax_rate) || 0) + (i.tax || 0));
  return [...byRate].sort((a, b) => a[0] - b[0]).map(([rate, tax]) => ({ rate, tax }));
}

// The deposit a quotation asks for, split by SST rate in proportion to the
// quotation's taxable value at each rate. Each part is invoiced as one line,
// so the deposit invoice charges SST exactly like a line at that rate would.
//   items: the quotation's stored lines; deposit: { type: "percent", value } | { type: "amount", amount }
export function depositParts(items, deposit) {
  if (!deposit) return [];
  const regular = items.filter((i) => !i.deposit_id);
  const rates = [...new Set(regular.map((i) => i.tax_rate || 0))].sort((a, b) => a - b);
  const bases = rates.map((r) =>
    regular.filter((i) => (i.tax_rate || 0) === r).reduce((s, i) => s + (i.taxable ?? i.amount), 0),
  );
  const base = bases.reduce((s, v) => s + v, 0);
  const wanted =
    deposit.type === "percent" ? percentOf(base, basisPoints(deposit.value) || 0) : Number(deposit.amount || 0);
  if (!(wanted > 0) || wanted >= base) return [];
  const parts = allocate(bases, wanted);
  return rates
    .map((rate, n) => ({ rate, amount: parts[n], tax: Math.round((parts[n] * rate) / 100) }))
    .filter((p) => p.amount > 0);
}
