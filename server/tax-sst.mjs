// SST working papers: tax on credit/debit notes, the SST-02 worksheet and the
// rolling 12-month threshold monitor. All money is integer sen.
// Rules and sources are listed in docs/features/tax.md.
import { allocateDiscount, addDays, today, check, date } from "./domain.mjs";

export const SALES_RATES = [5, 10];
export const SERVICE_RATES = [6, 8];

export const TAX_DEFAULTS = {
  // SST-02 taxable period: normally two months, aligned to the month Customs gave you.
  sstPeriodMonths: 2,
  sstPeriodStart: 1,
  // Service tax is due when payment is received unless Customs approved invoice basis.
  serviceTaxBasis: "payment",
  // Thresholds in sen.
  sstThreshold: 50000000,
  einvoiceThreshold: 300000000,
  // e-Invoice business profile.
  msic: "",
  activity: "",
  idType: "BRN",
  addressLines: "",
  city: "",
  postcode: "",
  state: "",
  country: "MYS",
  defaultClass: "022",
  autoSubmit: false,
};

// Module settings live in their own table so core settings stay untouched.
export function taxSettings(store) {
  const row = store.db.prepare("SELECT data FROM tax_settings WHERE id=1").get();
  return { ...TAX_DEFAULTS, ...(row ? JSON.parse(row.data) : {}) };
}

// Largest-remainder split of total across weights. Unlike allocateDiscount it
// never caps a share at its weight, so it also works for debit notes that are
// larger than the invoice.
export function splitProportional(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!total) return weights.map(() => 0);
  if (!sum) {
    const out = weights.map(() => 0);
    if (out.length) out[0] = total;
    return out;
  }
  const t = BigInt(total),
    s = BigInt(sum);
  const shares = weights.map((w) => Number((t * BigInt(w)) / s));
  let left = total - shares.reduce((a, v) => a + v, 0);
  const order = weights
    .map((w, n) => [(t * BigInt(w)) % s, w, n])
    .sort((x, y) => (x[0] === y[0] ? y[1] - x[1] : x[0] < y[0] ? 1 : -1));
  for (const [, , n] of order) {
    if (!left) break;
    shares[n]++;
    left--;
  }
  return shares;
}

// Each line's taxable value and SST. Documents made before SST support have no
// per-line taxable value, so their discount is spread the same way as today.
export function lineValues(d) {
  const legacy = allocateDiscount(
    d.items.map((i) => i.amount),
    d.discount || 0,
  );
  return d.items.map((i, n) => {
    const taxable = i.taxable ?? i.amount - legacy[n];
    return { rate: i.tax_rate || 0, taxable, tax: i.tax || 0, gross: taxable + (i.tax || 0) };
  });
}
// Taxable value and SST of a document by rate.
export function rateTotals(d) {
  const by = new Map();
  for (const l of lineValues(d)) {
    const r = by.get(l.rate) || { rate: l.rate, taxable: 0, tax: 0 };
    r.taxable += l.taxable;
    r.tax += l.tax;
    by.set(l.rate, r);
  }
  return [...by.values()].sort((a, b) => a.rate - b.rate);
}

// What is left on each invoice line after earlier notes. The notes are replayed
// in order and split the way a new note is: a credit within a rate goes to the
// lines it was made for (or all lines of that rate) by what they had left, a
// debit by their value. Credits take value and SST off; debits add them back.
export function lineUsage(d, notes = []) {
  const values = lineValues(d);
  const left = values.map((v) => v.gross),
    taxLeft = values.map((v) => v.tax);
  for (const a of notes) {
    const credit = a.kind === "credit";
    const from = String(a.tax_from_lines || "")
      .split(",")
      .map((n) => Number(n) - 1)
      .filter((n) => Number.isInteger(n) && n >= 0 && n < values.length);
    for (const row of noteLines(d, a)) {
      const ofRate = (list) => list.filter((n) => values[n].rate === row.rate);
      const pool = ofRate(from).length ? ofRate(from) : ofRate(values.map((v, n) => n));
      if (!pool.length) continue;
      const room = pool.map((n) => Math.max(0, left[n]));
      const weights = credit && room.some((w) => w > 0) ? room : pool.map((n) => values[n].gross);
      const gross = splitProportional(row.taxable + row.tax, weights),
        tax = splitProportional(row.tax, weights);
      pool.forEach((n, k) => {
        left[n] += credit ? -gross[k] : gross[k];
        taxLeft[n] += credit ? -tax[k] : tax[k];
      });
    }
  }
  return values.map((v, n) => ({ ...v, left: Math.max(0, left[n]), taxLeft: Math.max(0, taxLeft[n]) }));
}
// How much a credit note can still take off the chosen lines (or the whole invoice).
export function creditRoom(d, lines = null, notes = []) {
  const usage = lineUsage(d, notes);
  const chosen = lines && lines.length ? lines : usage.map((v, n) => n);
  return chosen.reduce((s, n) => s + (usage[n]?.left || 0), 0);
}

// The SST inside a note: its tax-inclusive amount is split across the invoice's
// rates in proportion to their tax-inclusive value (all lines, or only the chosen
// ones), then the SST is taken out of each share. The rows always add up to the
// note amount, so the ledger (adjusted total, allocations) is unchanged.
// For a credit note, pass the invoice's earlier notes: the split then uses what
// is left on each line, and the SST credited at a rate never goes beyond the SST
// still on the invoice at that rate.
export function noteTaxLines(d, amount, lines = null, { kind = "", prior = null } = {}) {
  const values = prior && kind === "credit" ? lineUsage(d, prior) : lineValues(d);
  let chosen = values.map((v, n) => n);
  if (lines && lines.length) {
    check(Array.isArray(lines) && lines.length <= 50, "Choose the invoice lines for this note.");
    chosen = [...new Set(lines.map(Number))];
    check(
      chosen.every((n) => Number.isInteger(n) && n >= 0 && n < values.length),
      "Choose lines from this invoice.",
    );
  }
  const capped = values[0] && "left" in values[0];
  const byRate = new Map(),
    taxLeft = new Map();
  for (const n of chosen) {
    const v = values[n];
    byRate.set(v.rate, (byRate.get(v.rate) || 0) + (capped ? v.left : v.gross));
    taxLeft.set(v.rate, (taxLeft.get(v.rate) || 0) + (capped ? v.taxLeft : 0));
  }
  const rates = [...byRate.keys()].sort((a, b) => a - b);
  const gross = rates.map((r) => byRate.get(r));
  const shares = splitProportional(amount, gross);
  return rates
    .map((rate, n) => {
      const share = shares[n];
      let tax = rate ? Math.round((share * rate) / (100 + rate)) : 0;
      if (capped) tax = Math.min(tax, taxLeft.get(rate));
      return { rate, taxable: share - tax, tax };
    })
    .filter((r) => r.taxable || r.tax);
}
export function parseTaxLines(a) {
  if (!a?.tax_lines) return null;
  try {
    const rows = typeof a.tax_lines === "string" ? JSON.parse(a.tax_lines) : a.tax_lines;
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}
// Stored breakdown, or the proportional estimate for notes made before this feature.
export function noteLines(d, a) {
  return parseTaxLines(a) || noteTaxLines(d, a.amount);
}

// ---- Taxable periods ----
const monthIndex = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const monthOf = (idx) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
const monthEnd = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};
export const addMonths = (day, n) => {
  const [y, m, d] = day.split("-").map(Number);
  const target = monthOf(y * 12 + m - 1 + n);
  const last = Number(monthEnd(target).slice(8));
  return `${target}-${String(Math.min(d, last)).padStart(2, "0")}`;
};
// The taxable period that contains month (YYYY-MM).
export function periodFor(month, s = TAX_DEFAULTS) {
  check(typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month), "Choose a valid month.");
  const len = s.sstPeriodMonths,
    anchor = s.sstPeriodStart - 1;
  const idx = monthIndex(month);
  const start = idx - ((((idx - anchor) % len) + len) % len);
  const from = monthOf(start) + "-01",
    to = monthEnd(monthOf(start + len - 1));
  // Return and payment are due by the last day of the month after the period.
  return { from, to, months: len, key: monthOf(start), due: monthEnd(monthOf(start + len)) };
}
// Recent periods for a picker, newest first.
export function recentPeriods(s = TAX_DEFAULTS, count = 8, asOf = today()) {
  const out = [];
  let p = periodFor(asOf.slice(0, 7), s);
  for (let i = 0; i < count; i++) {
    out.push(p);
    p = periodFor(addMonths(p.from, -1).slice(0, 7), s);
  }
  return out;
}

// ---- Payment basis for service tax ----
// Service tax accounted on an invoice up to and including a day: the share of the
// (adjusted) invoice value received so far, or all of it once 12 months have passed
// without full payment. Notes dated on or before the day are included, so a credit
// after payment shows up as a negative change (a deduction under item 13(a)).
export function accruedServiceTax(d, day, releases = []) {
  const out = new Map();
  if (d.issue_date > day) return out;
  const totals = new Map(rateTotals(d).map((r) => [r.rate, { ...r }]));
  let gross = d.total;
  for (const a of d.adjustments || []) {
    if (a.issue_date > day) continue;
    const sign = a.kind === "credit" ? -1 : 1;
    gross += sign * a.amount;
    for (const l of noteLines(d, a)) {
      const r = totals.get(l.rate) || { rate: l.rate, taxable: 0, tax: 0 };
      r.taxable += sign * l.taxable;
      r.tax += sign * l.tax;
      totals.set(l.rate, r);
    }
  }
  let paid = 0;
  for (const p of d.payments || []) if (!p.reversed && p.paid_date <= day) paid += p.amount;
  for (const r of releases) if (r.day <= day) paid -= r.amount;
  const deemed = day > addMonths(d.issue_date, 12);
  const received = BigInt(Math.min(Math.max(paid, 0), Math.max(gross, 0)));
  const share = (v) => {
    if (deemed) return v;
    if (gross <= 0) return 0;
    const g = BigInt(gross),
      n = BigInt(Math.abs(v)) * received;
    return Math.sign(v) * Number((2n * n + g) / (2n * g));
  };
  for (const rate of SERVICE_RATES) {
    const r = totals.get(rate);
    if (r) out.set(rate, { taxable: share(r.taxable), tax: share(r.tax), deemed });
  }
  return out;
}

const blankBox = () => ({ value: 0, tax: 0 });
// SST-02 working paper for one taxable period, laid out by the return's items.
export function sst02(store, s, b = {}) {
  const month = b.period || today().slice(0, 7);
  const period = periodFor(month, s);
  const { from, to } = period;
  const before = addDays(from, -1);
  const settings = store.settings();
  const basis = s.serviceTaxBasis === "invoice" ? "invoice" : "payment";
  const items = { "11a": blankBox(), "11b": blankBox(), "11c": blankBox(), "11d": blankBox(), "11e": blankBox() };
  const boxFor = { 5: "11a", 10: "11b", 6: "11c", 8: "11d" };
  const deductions = { a: 0, b: 0, c: 0, d: 0 };
  const creditValue = { sales: 0, service: 0 };
  const partD = { exempt: 0, other: 0 };
  const rows = [];
  const warnings = [];
  let estimated = 0,
    deemed = 0;
  const inPeriod = (day) => day >= from && day <= to;
  const releases = new Map();
  for (const r of store.db
    .prepare(
      "SELECT p.invoice_id,r.amount,r.created,a.issue_date FROM allocation_releases r JOIN payments p ON p.id=r.payment_id LEFT JOIN adjustments a ON a.id=r.adjustment_id",
    )
    .all())
    releases.set(r.invoice_id, [
      ...(releases.get(r.invoice_id) || []),
      { amount: r.amount, day: r.issue_date || r.created.slice(0, 10) },
    ]);
  const exempt = new Set(
    store.db.prepare("SELECT document_id FROM tax_doc_meta WHERE exempt_ref<>''").all().map((r) => r.document_id),
  );
  for (const d of store.documents()) {
    if (d.kind !== "invoice" || d.state !== "issued") continue;
    const client = d.client.name;
    // SST is reported in MYR: foreign-currency documents use their exchange rate.
    const fx = d.currency && d.currency !== "MYR" ? d.fx_rate || "1" : "1";
    const m = (v) => toMyr(v, fx);
    const add = (rate, rawValue, rawTax, ref, kind, day) => {
      const key = boxFor[rate];
      if (!key) return;
      const value = m(rawValue),
        tax = m(rawTax);
      items[key].value += value;
      items[key].tax += tax;
      rows.push({ item: key, number: ref, kind, date: day, client, rate, value, tax });
    };
    const invoiceBasis = (rate) => SALES_RATES.includes(rate) || basis === "invoice";
    if (inPeriod(d.issue_date))
      for (const r of rateTotals(d)) {
        if (r.rate === 0) {
          partD[exempt.has(d.id) ? "exempt" : "other"] += m(r.taxable);
          rows.push({ item: "18", number: d.number, kind: exempt.has(d.id) ? "exempt" : "no SST", date: d.issue_date, client, rate: 0, value: m(r.taxable), tax: 0 });
        } else if (invoiceBasis(r.rate)) add(r.rate, r.taxable, r.tax, d.number, "invoice", d.issue_date);
      }
    for (const a of d.adjustments || []) {
      if (!inPeriod(a.issue_date)) continue;
      if (!parseTaxLines(a)) estimated++;
      for (const l of noteLines(d, a)) {
        if (l.rate === 0) {
          const sign = a.kind === "credit" ? -1 : 1;
          partD[exempt.has(d.id) ? "exempt" : "other"] += sign * m(l.taxable);
          continue;
        }
        if (!invoiceBasis(l.rate)) continue;
        if (a.kind === "debit") add(l.rate, l.taxable, l.tax, a.number, "debit note", a.issue_date);
        else {
          deductions.a += m(l.tax);
          creditValue[SALES_RATES.includes(l.rate) ? "sales" : "service"] += m(l.taxable);
          rows.push({ item: "13a", number: a.number, kind: "credit note", date: a.issue_date, client, rate: l.rate, value: -m(l.taxable), tax: -m(l.tax) });
        }
      }
    }
    if (basis === "payment" && d.items.some((i) => SERVICE_RATES.includes(i.tax_rate))) {
      const end = accruedServiceTax(d, to, releases.get(d.id) || []);
      const start = accruedServiceTax(d, before, releases.get(d.id) || []);
      for (const rate of SERVICE_RATES) {
        const e = end.get(rate) || { taxable: 0, tax: 0 },
          st = start.get(rate) || { taxable: 0, tax: 0 };
        const value = e.taxable - st.taxable,
          tax = e.tax - st.tax;
        if (!value && !tax) continue;
        if (e.deemed && !st.deemed) deemed++;
        if (tax >= 0 && value >= 0) add(rate, value, tax, d.number, e.deemed && !st.deemed ? "unpaid after 12 months" : "payment received", to);
        else {
          deductions.a += Math.max(0, -m(tax));
          creditValue.service += Math.max(0, -m(value));
          rows.push({ item: "13a", number: d.number, kind: "credit after payment", date: to, client, rate, value: m(value), tax: m(tax) });
        }
      }
    }
  }
  const item12 = Object.values(items).reduce((s2, x) => s2 + x.tax, 0);
  const totalDeductions = deductions.a + deductions.b + deductions.c + deductions.d;
  if (!settings.sstNumber)
    warnings.push("Add your SST registration number in Settings. Without it no SST is charged and the return has nothing to report.");
  if (to > today()) warnings.push("This taxable period has not ended yet. Figures can still change.");
  if (estimated)
    warnings.push(`${estimated} older credit/debit note(s) have no SST breakdown; their SST is estimated in proportion to the invoice.`);
  if (deemed)
    warnings.push(`${deemed} invoice(s) were unpaid 12 months after issue, so their remaining service tax is included as due.`);
  if (item12 - totalDeductions < 0)
    warnings.push("Deductions are larger than the tax for this period. Check the credit notes with your adviser before filing.");
  return {
    period,
    business: settings.company,
    sstNumber: settings.sstNumber || "",
    basis: { sales: "invoice", service: basis },
    items,
    item12,
    deductions,
    creditValue,
    item14: item12 - totalDeductions,
    partD,
    rows: rows.sort((x, y) => x.date.localeCompare(y.date) || String(x.number).localeCompare(String(y.number))),
    warnings,
    generated: new Date().toISOString(),
  };
}

// ---- Threshold monitor ----
// Exchange rate is a decimal string (MYR per unit). Kept exact with BigInt.
export function toMyr(sen, fx) {
  if (!fx || fx === "1") return sen;
  const m = String(fx).match(/^(\d{1,9})(?:\.(\d{1,10}))?$/);
  if (!m) return sen;
  const scale = 10n ** BigInt((m[2] || "").length);
  const rate = BigInt(m[1] + (m[2] || ""));
  const v = BigInt(Math.abs(sen)) * rate;
  return Math.sign(sen) * Number((v + scale / 2n) / scale);
}
// Net sales excluding SST per month: invoices by issue date, plus debit notes,
// less credit notes, converted to MYR.
export function monthlySales(store) {
  const months = new Map();
  const add = (day, v) => months.set(day.slice(0, 7), (months.get(day.slice(0, 7)) || 0) + v);
  for (const d of store.documents()) {
    if (d.kind !== "invoice" || d.state !== "issued") continue;
    const fx = d.fx_rate || "1";
    add(d.issue_date, toMyr(d.total - (d.tax || 0), fx));
    for (const a of d.adjustments || []) {
      const lines = noteLines(d, a);
      const value = lines.reduce((s, l) => s + l.taxable, 0);
      add(a.issue_date, toMyr(a.kind === "credit" ? -value : value, fx));
    }
  }
  return months;
}
export function thresholdMonitor(store, s, asOf = today()) {
  const months = monthlySales(store);
  const current = monthIndex(asOf.slice(0, 7));
  const rolling = (idx) => {
    let sum = 0;
    for (let i = idx - 11; i <= idx; i++) sum += months.get(monthOf(i)) || 0;
    return sum;
  };
  const total = rolling(current);
  const history = [];
  for (let i = current - 23; i <= current; i++) history.push({ month: monthOf(i), sales: months.get(monthOf(i)) || 0, rolling: rolling(i) });
  const watch = (threshold) => {
    const percent = threshold ? Math.floor((total * 100) / threshold) : 0;
    const crossed = history.find((h) => h.rolling >= threshold)?.month || null;
    return { threshold, percent, level: percent >= 100 ? "over" : percent >= 80 ? "near" : "ok", crossed };
  };
  return {
    asOf,
    from: monthOf(current - 11) + "-01",
    to: asOf,
    total,
    sst: { ...watch(s.sstThreshold), registered: !!store.settings().sstNumber },
    einvoice: watch(s.einvoiceThreshold),
    history: history.slice(-12),
  };
}
export const validMonth = (v) => {
  check(typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(v), "Choose a valid month.");
  date(v + "-01");
  return v;
};
