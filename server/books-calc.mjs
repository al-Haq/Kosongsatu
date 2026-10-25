// Books calculations: pure functions over plain records, so every figure can be
// tested with exact sen amounts. Nothing here reads the database.
//
// Conventions
// - Money is integer sen. Documents may carry `currency` and `fx_rate` (MYR per
//   1 unit, decimal string); figures are converted to MYR per document and then
//   apportioned, so totals always reconcile.
// - Only issued invoices count as sales. Drafts, voided documents and any other
//   document kind (quotes, proformas, orders) are ignored.
// - Expenses are always in MYR. A supplier bill counts as the cost on its bill
//   date (accrual); its payments are expense records linked by `bill_id`, which
//   count as cash out on their paid date and are never added to the accrual cost
//   a second time.
import { addDays, allocateDiscount, nextMonth } from "./domain.mjs";
import { planOf, planAmounts } from "./recurring-plans.mjs";
import { stepPeriod } from "./recurring-dates.mjs";
import { noteLines } from "./tax-sst.mjs";

// Typical Malaysian Form B / Form P "financial particulars" expense lines.
export const FORM_LINES = [
  ["cost_of_sales", "Purchases and cost of production (cost of sales)"],
  ["loan_interest", "Loan interest"],
  ["salaries", "Salaries and wages"],
  ["rental", "Rental / lease"],
  ["contracts", "Contracts and subcontracts"],
  ["commissions", "Commissions"],
  ["bad_debts", "Bad debts"],
  ["travel", "Travelling and transport"],
  ["repairs", "Repairs and maintenance"],
  ["promotion", "Promotion and advertisement"],
  ["other", "Other expenses"],
];
export const FORM_LINE_KEYS = FORM_LINES.map(([k]) => k);

// ---------------------------------------------------------------------------
// Exact arithmetic helpers
// ---------------------------------------------------------------------------
export function parseRate(v) {
  const s = String(v ?? "1").trim();
  if (!/^\d{1,9}(\.\d{1,10})?$/.test(s)) return [1n, 1n];
  const [a, b = ""] = s.split(".");
  const num = BigInt(a + b),
    den = 10n ** BigInt(b.length);
  return num > 0n ? [num, den] : [1n, 1n];
}
// Converts sen in a document currency to MYR sen, rounding half up (away from zero).
export function toMyr(sen, rate = "1") {
  const [n, d] = parseRate(rate);
  if (n === d) return sen;
  const v = BigInt(Math.abs(sen)) * n;
  let q = v / d;
  if ((v % d) * 2n >= d) q += 1n;
  return Number(sen < 0 ? -q : q);
}
export const docRate = (d) => (d && d.fx_rate ? String(d.fx_rate) : "1");
// Splits `total` over `weights` in proportion (largest remainder), so the parts
// always add up to the total exactly.
export function apportion(total, weights) {
  if (!weights.length) return [];
  const ws = weights.map((w) => BigInt(Math.max(0, Math.trunc(w || 0))));
  const W = ws.reduce((s, w) => s + w, 0n);
  if (W === 0n) return weights.map((_, i) => (i === 0 ? total : 0));
  const T = BigInt(Math.abs(total));
  const shares = ws.map((w) => (T * w) / W);
  let left = T - shares.reduce((s, v) => s + v, 0n);
  const order = ws
    .map((w, i) => [(T * w) % W, i])
    .sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? 1 : -1));
  for (const [, i] of order) {
    if (left <= 0n) break;
    shares[i] += 1n;
    left -= 1n;
  }
  return shares.map((s) => Number(total < 0 ? -s : s));
}
export const days = (from, to) =>
  Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
export function monthsBetween(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4)),
    m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (let i = 0; i < 600; i++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > end) break;
    out.push(key);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
const inRange = (d, from, to) => !!d && d >= from && d <= to;
const series = (months) => ({ total: 0, byMonth: months.map(() => 0) });
function add(s, months, day, value) {
  const i = months.indexOf(day.slice(0, 7));
  if (i < 0) return;
  s.total += value;
  s.byMonth[i] += value;
}

// ---------------------------------------------------------------------------
// Documents as facts
// ---------------------------------------------------------------------------
export const isSalesInvoice = (d) =>
  d && d.kind === "invoice" && !["draft", "void"].includes(d.state) && !!d.number;
const normalise = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\s+-\s+\d{4}-\d{2}$/, "")
    .replace(/\s+/g, " ")
    .trim();
// Groups invoice lines by SKU, catalog service or description.
export function lineKey(item, services = []) {
  if (item.sku) return { key: "sku:" + String(item.sku).toUpperCase(), label: `${item.sku} · ${item.description}` };
  const service = item.service_id ? services.find((s) => s.id === item.service_id) : null;
  if (service) return { key: "service:" + service.id, label: service.name };
  const text = normalise(item.description);
  const match = services.find(
    (s) => normalise(s.name) === text || (s.description && normalise(s.description) === text) || text.startsWith(normalise(s.name) + " "),
  );
  if (match) return { key: "service:" + match.id, label: match.name };
  return { key: "text:" + text, label: String(item.description || "").replace(/\s+-\s+\d{4}-\d{2}$/, "") };
}
// The value of each line including its share of the discount and its SST, in the
// document currency. The values add up to the document total.
export function lineValues(d) {
  const legacy = allocateDiscount(
    d.items.map((i) => i.amount),
    d.discount || 0,
  );
  const values = d.items.map((i, n) => (i.taxable ?? i.amount - legacy[n]) + (i.tax || 0));
  const sum = values.reduce((s, v) => s + v, 0);
  // Documents from other modules may round differently; keep the total exact.
  if (sum !== d.total && values.length) return apportion(d.total, values.length ? values : [1]);
  return values;
}
export function invoiceFacts(d) {
  const rate = docRate(d);
  const payments = (d.payments || [])
    .filter((p) => !p.reversed && (p.applied ?? p.amount) > 0)
    .map((p) => ({ paid_date: p.paid_date, created: p.created || "", applied: p.applied ?? p.amount }))
    .sort((a, b) => (a.paid_date === b.paid_date ? a.created.localeCompare(b.created) : a.paid_date.localeCompare(b.paid_date)));
  const notes = (d.adjustments || []).map((a) => {
    const sign = a.kind === "credit" ? -1 : 1;
    // A note's SST is its stored split by rate, the figure SST-02 uses.
    const tax = a.tax ?? (d.items ? noteLines(d, a).reduce((s, l) => s + l.tax, 0) : 0);
    return {
      kind: a.kind,
      number: a.number,
      issue_date: a.issue_date,
      amountMyr: sign * toMyr(a.amount, rate),
      taxMyr: sign * toMyr(tax, rate),
    };
  });
  const adjusted = d.adjusted_total ?? d.total;
  return {
    id: d.id,
    number: d.number,
    client_id: d.client_id,
    client: d.client?.name || "",
    issue_date: d.issue_date,
    due_date: d.due_date,
    rate,
    totalMyr: toMyr(d.total, rate),
    taxMyr: toMyr(d.tax || 0, rate),
    adjustedMyr: toMyr(adjusted, rate),
    balanceMyr: toMyr(d.balance ?? adjusted, rate),
    adjusted,
    balance: d.balance ?? adjusted,
    payments,
    notes,
  };
}
// Receipts are in MYR unless they say otherwise, or all their allocations are to
// invoices in one other currency (then that invoice's rate applies).
export function receiptRate(r, docsById) {
  if (r.fx_rate) return String(r.fx_rate);
  const rates = [
    ...new Set(
      (r.allocations || [])
        .map((p) => docsById.get(p.invoice_id))
        .filter(Boolean)
        .map(docRate),
    ),
  ];
  return rates.length === 1 ? rates[0] : "1";
}
// What a payment had applied to its invoice at the end of a day: money a later
// credit note moved to customer funds was still on the invoice then.
export const appliedAt = (p, day) =>
  p.releases ? p.amount - p.releases.filter((r) => r.date <= day).reduce((s, r) => s + r.amount, 0) : (p.applied ?? p.amount);
// Money from customers by date: receipts in, refunds out (MYR).
export function customerCash(receipts, docsById) {
  const out = [];
  for (const r of receipts) {
    if (r.voided) continue;
    const rate = receiptRate(r, docsById);
    out.push({ date: r.paid_date, client_id: r.client_id, amount: toMyr(r.amount, rate), kind: "receipt" });
    for (const f of r.refunds || [])
      out.push({ date: f.paid_date, client_id: r.client_id, amount: -toMyr(f.amount, rate), kind: "refund" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 57. Sales reports
// ---------------------------------------------------------------------------
export function salesReport({ docs, receipts, services = [], from, to }) {
  const months = monthsBetween(from, to);
  const byClient = new Map(),
    byItem = new Map(),
    byMonth = months.map((month) => ({ month, invoiced: 0, sst: 0, collected: 0, count: 0 }));
  const docsById = new Map(docs.map((d) => [d.id, d]));
  const client = (id, name) => {
    if (!byClient.has(id)) byClient.set(id, { client_id: id, client: name, invoiced: 0, sst: 0, collected: 0, count: 0 });
    return byClient.get(id);
  };
  const item = (k) => {
    if (!byItem.has(k.key)) byItem.set(k.key, { key: k.key, label: k.label, invoiced: 0, collected: 0, quantity: 0 });
    return byItem.get(k.key);
  };
  const month = (day) => byMonth[months.indexOf(day.slice(0, 7))];
  let applied = 0;
  for (const d of docs.filter(isSalesInvoice)) {
    const f = invoiceFacts(d);
    const keys = d.items.map((i) => lineKey(i, services));
    const weights = lineValues(d);
    const spread = (value, field) =>
      apportion(value, weights).forEach((v, n) => (item(keys[n])[field] += v));
    if (inRange(d.issue_date, from, to)) {
      const c = client(d.client_id, f.client);
      c.invoiced += f.totalMyr;
      c.sst += f.taxMyr;
      c.count++;
      const m = month(d.issue_date);
      m.invoiced += f.totalMyr;
      m.sst += f.taxMyr;
      m.count++;
      spread(f.totalMyr, "invoiced");
      d.items.forEach((i, n) => (item(keys[n]).quantity += Number(i.quantity) || 0));
    }
    for (const n of f.notes)
      if (inRange(n.issue_date, from, to)) {
        const c = client(d.client_id, f.client);
        c.invoiced += n.amountMyr;
        c.sst += n.taxMyr;
        const m = month(n.issue_date);
        m.invoiced += n.amountMyr;
        m.sst += n.taxMyr;
        spread(n.amountMyr, "invoiced");
      }
    const paid = (d.payments || [])
      .filter((p) => !p.reversed && inRange(p.paid_date, from, to))
      .reduce((s, p) => s + toMyr(appliedAt(p, to), f.rate), 0);
    if (paid) {
      applied += paid;
      spread(paid, "collected");
    }
  }
  const clientNames = new Map(docs.map((d) => [d.client_id, d.client?.name || ""]));
  let collected = 0;
  for (const c of customerCash(receipts, docsById))
    if (inRange(c.date, from, to)) {
      collected += c.amount;
      client(c.client_id, clientNames.get(c.client_id) || receipts.find((r) => r.client_id === c.client_id)?.client?.name || "").collected += c.amount;
      month(c.date).collected += c.amount;
    }
  const items = [...byItem.values()];
  if (collected !== applied)
    items.push({ key: "unapplied", label: "Not applied to an invoice (customer funds, refunds)", invoiced: 0, collected: collected - applied, quantity: 0 });
  const totals = {
    invoiced: byMonth.reduce((s, m) => s + m.invoiced, 0),
    sst: byMonth.reduce((s, m) => s + m.sst, 0),
    collected,
  };
  const sort = (a, b) => b.invoiced - a.invoiced || b.collected - a.collected || String(a.client || a.label).localeCompare(String(b.client || b.label));
  return {
    from,
    to,
    totals,
    clients: [...byClient.values()].sort(sort),
    items: items.filter((i) => i.invoiced || i.collected).sort((a, b) => (a.key === "unapplied") - (b.key === "unapplied") || sort(a, b)),
    months: byMonth,
  };
}

// ---------------------------------------------------------------------------
// 58. Profit and loss
// ---------------------------------------------------------------------------
// A bill's value per category (line amount + its SST), in MYR sen.
export function billCategoryValues(bill) {
  const map = new Map();
  for (const l of bill.items || []) map.set(l.category_id, (map.get(l.category_id) || 0) + l.amount + (l.tax || 0));
  return [...map];
}
export function profitAndLoss({ docs, receipts, expenses, bills, categories = [], from, to }) {
  const months = monthsBetween(from, to);
  const names = new Map(categories.map((c) => [c.id, c.name]));
  const billsById = new Map(bills.map((b) => [b.id, b]));
  const docsById = new Map(docs.map((d) => [d.id, d]));
  const make = () => ({ income: series(months), sst: series(months), categories: new Map(), expenses: series(months) });
  const accrual = make(),
    cash = make();
  const spend = (basis, category, day, value) => {
    if (!basis.categories.has(category)) basis.categories.set(category, series(months));
    add(basis.categories.get(category), months, day, value);
    add(basis.expenses, months, day, value);
  };
  for (const d of docs.filter(isSalesInvoice)) {
    const f = invoiceFacts(d);
    if (inRange(d.issue_date, from, to)) {
      add(accrual.income, months, d.issue_date, f.totalMyr - f.taxMyr);
      add(accrual.sst, months, d.issue_date, f.taxMyr);
    }
    for (const n of f.notes)
      if (inRange(n.issue_date, from, to)) {
        add(accrual.income, months, n.issue_date, n.amountMyr - n.taxMyr);
        add(accrual.sst, months, n.issue_date, n.taxMyr);
      }
  }
  for (const c of customerCash(receipts, docsById)) if (inRange(c.date, from, to)) add(cash.income, months, c.date, c.amount);
  for (const e of expenses) {
    // Accrual: the expense date, unless it pays a bill (the bill already counts).
    if (!e.bill_id && inRange(e.date, from, to)) spend(accrual, e.category_id, e.date, e.amount);
    if (e.status !== "paid" || !inRange(e.paid_date, from, to)) continue;
    const bill = e.bill_id ? billsById.get(e.bill_id) : null;
    const parts = bill ? billCategoryValues(bill) : [];
    if (!parts.length) spend(cash, e.category_id, e.paid_date, e.amount);
    else apportion(e.amount, parts.map(([, v]) => v)).forEach((v, i) => v && spend(cash, parts[i][0], e.paid_date, v));
  }
  for (const b of bills)
    if (b.state !== "void" && inRange(b.bill_date, from, to))
      for (const [category, value] of billCategoryValues(b)) spend(accrual, category, b.bill_date, value);
  const finish = (basis) => {
    const list = [...basis.categories]
      .map(([id, s]) => ({ id, name: names.get(id) || "Uncategorised", ...s }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const net = series(months);
    net.total = basis.income.total - basis.expenses.total;
    net.byMonth = months.map((_, i) => basis.income.byMonth[i] - basis.expenses.byMonth[i]);
    return { income: basis.income, sst: basis.sst, categories: list, expenses: basis.expenses, net };
  };
  return { from, to, months, accrual: finish(accrual), cash: finish(cash) };
}

// ---------------------------------------------------------------------------
// 63. Annual income tax summary (working aid)
// ---------------------------------------------------------------------------
export function taxSummary({ pnl, categories, year }) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const income = pnl.accrual.income.total;
  const lines = new Map(FORM_LINES.map(([k, label]) => [k, { key: k, label, total: 0, categories: [] }]));
  let addBack = 0;
  const adjustments = [];
  for (const c of pnl.accrual.categories) {
    const cat = byId.get(c.id) || { form_line: "other", deductible: 100, name: c.name };
    const key = FORM_LINE_KEYS.includes(cat.form_line) ? cat.form_line : "other";
    const line = lines.get(key);
    line.total += c.total;
    line.categories.push({ id: c.id, name: c.name, total: c.total });
    const deductible = Math.min(100, Math.max(0, Number(cat.deductible ?? 100)));
    if (deductible < 100 && c.total) {
      const amount = Math.round((c.total * (100 - deductible)) / 100);
      addBack += amount;
      adjustments.push({ id: c.id, name: c.name, total: c.total, deductible, amount });
    }
  }
  const costOfSales = lines.get("cost_of_sales").total;
  const expenseLines = [...lines.values()].filter((l) => l.key !== "cost_of_sales");
  const expenses = expenseLines.reduce((s, l) => s + l.total, 0);
  const grossProfit = income - costOfSales;
  const netProfit = grossProfit - expenses;
  return {
    year,
    from: pnl.from,
    to: pnl.to,
    income,
    sst: pnl.accrual.sst.total,
    costOfSales,
    costLines: lines.get("cost_of_sales").categories,
    grossProfit,
    lines: expenseLines,
    expenses,
    netProfit,
    adjustments,
    addBack,
    adjustedProfit: netProfit + addBack,
  };
}

// ---------------------------------------------------------------------------
// 89. Late payment prediction
// ---------------------------------------------------------------------------
const HISTORY = 12;
// When an invoice was fully paid: the date its applied payments reached its value.
export function settledDate(f) {
  if (f.adjusted <= 0 || f.balance > 0) return null;
  let sum = 0;
  for (const p of f.payments) {
    sum += p.applied;
    if (sum >= f.adjusted) return p.paid_date;
  }
  return null;
}
const mean = (list) => (list.length ? list.reduce((s, v) => s + v, 0) / list.length : 0);
const round1 = (v) => Math.round(v * 10) / 10;
export const RISK_WEIGHT = { high: 3, medium: 2, low: 1 };
export function reminderAdvice(risk) {
  if (risk === "high")
    return { beforeDays: 7, text: "Chronic late payer: remind 7 days before the due date, again on the due date, then call or WhatsApp 3 days after." };
  if (risk === "medium") return { beforeDays: 3, text: "Often a little late: remind 3 days before the due date and 1 day after." };
  return { beforeDays: 0, text: "Usually pays on time: one reminder on the due date is enough." };
}
const NO_HISTORY = { beforeDays: 0, text: "No payment history yet: one reminder on the due date is a good start." };
export function latePayment({ docs, asOf }) {
  const perClient = new Map();
  const all = [];
  const open = [];
  for (const d of docs.filter(isSalesInvoice)) {
    const f = invoiceFacts(d);
    if (f.adjusted <= 0) continue;
    if (!perClient.has(d.client_id)) perClient.set(d.client_id, { history: [], open: [] });
    const settled = settledDate(f);
    if (settled) {
      const h = { id: d.id, number: d.number, due_date: d.due_date, settled, days: days(d.due_date, settled) };
      perClient.get(d.client_id).history.push(h);
      all.push(h);
    } else if (f.balance > 0) {
      const o = { ...f, overdue: Math.max(0, days(d.due_date, asOf)) };
      perClient.get(d.client_id).open.push(o);
      open.push(o);
    }
  }
  const recent = all.sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(-50);
  const workspace = {
    count: recent.length,
    avgDelay: recent.length >= 3 ? round1(mean(recent.map((h) => h.days))) : 0,
  };
  const clients = {};
  for (const [cid, { history, open: openList }] of perClient) {
    const list = history.sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(-HISTORY);
    const late = list.filter((h) => h.days > 0);
    const avgDelay = round1(mean(list.map((h) => h.days)));
    const avgDaysLate = round1(mean(list.map((h) => Math.max(0, h.days))));
    const shareLate = list.length ? late.length / list.length : 0;
    let trend = "not enough history",
      trendDelta = 0;
    if (list.length >= 4) {
      const half = Math.floor(list.length / 2);
      trendDelta = round1(mean(list.slice(half).map((h) => h.days)) - mean(list.slice(0, half).map((h) => h.days)));
      trend = trendDelta >= 3 ? "worsening" : trendDelta <= -3 ? "improving" : "steady";
    }
    const maxOverdue = Math.max(0, ...openList.map((o) => o.overdue));
    const reasons = [];
    if (list.length) {
      reasons.push(`Paid ${late.length} of the last ${list.length} invoice${list.length === 1 ? "" : "s"} after the due date.`);
      reasons.push(
        avgDelay > 0
          ? `On average payment arrives ${avgDelay} day${avgDelay === 1 ? "" : "s"} after the due date.`
          : avgDelay < 0
            ? `On average payment arrives ${-avgDelay} day${avgDelay === -1 ? "" : "s"} before the due date.`
            : "On average payment arrives on the due date.",
      );
    } else reasons.push("No fully paid invoices yet, so there is no payment history.");
    if (trend === "worsening") reasons.push(`Recent invoices were paid ${trendDelta} days later than earlier ones.`);
    if (trend === "improving") reasons.push(`Recent invoices were paid ${-trendDelta} days sooner than earlier ones.`);
    if (maxOverdue) reasons.push(`An open invoice is ${maxOverdue} day${maxOverdue === 1 ? "" : "s"} overdue.`);
    let risk = "low";
    if ((list.length >= 2 && shareLate >= 0.5 && avgDaysLate >= 15) || maxOverdue > 30) risk = "high";
    else if ((list.length && (shareLate >= 0.25 || avgDaysLate > 3)) || maxOverdue > 0 || trend === "worsening") risk = "medium";
    clients[cid] = {
      client_id: cid,
      count: list.length,
      lateCount: late.length,
      shareLate: round1(shareLate * 100),
      avgDelay,
      avgDaysLate,
      trend,
      trendDelta,
      maxOverdue,
      openCount: openList.length,
      risk,
      basis: list.length ? "client" : workspace.count >= 3 ? "workspace" : "none",
      reasons,
      advice: list.length || risk !== "low" ? reminderAdvice(risk) : NO_HISTORY,
      history: list.map(({ number, due_date, settled, days: d }) => ({ number, due_date, settled, days: d })),
    };
  }
  const invoices = {};
  for (const o of open) {
    const c = clients[o.client_id];
    const delay = Math.round(c.count ? c.avgDelay : workspace.avgDelay);
    let predicted = addDays(o.due_date, delay);
    if (predicted < o.issue_date) predicted = o.issue_date;
    let late = false;
    if (predicted < asOf) {
      late = o.due_date < asOf;
      predicted = late ? addDays(asOf, 7) : asOf;
    }
    let risk = c.risk;
    const why = [...c.reasons];
    if (late) {
      risk = "high";
      why.push("This invoice is already later than this client usually pays.");
    } else if (o.overdue > 30) risk = "high";
    else if (o.overdue > 0 && risk === "low") risk = "medium";
    const advice = c.count || risk !== "low" ? reminderAdvice(risk) : NO_HISTORY;
    const remindOn = addDays(o.due_date, -advice.beforeDays);
    invoices[o.id] = {
      id: o.id,
      number: o.number,
      client_id: o.client_id,
      client: o.client,
      due_date: o.due_date,
      balance: o.balance,
      balanceMyr: o.balanceMyr,
      overdue: o.overdue,
      delay,
      predicted,
      laterThanUsual: late,
      risk,
      basis: c.count ? "client" : workspace.count >= 3 ? "workspace" : "none",
      reasons: why,
      advice: advice.text,
      remindOn,
      remindNow: o.due_date < asOf ? "Overdue: follow up now." : remindOn <= asOf ? "Send a reminder now." : null,
    };
  }
  return { asOf, workspace, clients, invoices };
}

// ---------------------------------------------------------------------------
// 62. Cash flow forecast
// ---------------------------------------------------------------------------
function step(day, every, s = {}) {
  if (every === "week" || every === "weekly") return addDays(day, 7);
  if (every === "fortnight" || every === "fortnightly") return addDays(day, 14);
  const months = { quarter: 3, quarterly: 3, half: 6, "half-yearly": 6, year: 12, yearly: 12, annually: 12, annual: 12 }[every] || 1;
  let d = day;
  for (let i = 0; i < months; i++) d = nextMonth(d, s.anchor_day ?? Number(day.slice(-2)), !!s.month_end);
  return d;
}
const planLabel = (s) => {
  const lines = typeof s.lines === "string" ? planOf(s).lines : Array.isArray(s.lines) ? s.lines : [];
  return lines[0]?.description ? lines[0].description + (lines.length > 1 ? ` +${lines.length - 1}` : "") : "";
};
// A plan's expected invoice total. Plans store their lines and discount, so
// the amount is worked out exactly as the invoice will be; older one-service
// rows fall back to the catalog rate.
export function scheduleAmount(s, service) {
  const lines = typeof s.lines === "string" ? planOf(s).lines : Array.isArray(s.lines) ? s.lines : [];
  if (lines.length)
    try {
      return planAmounts(lines, s.discount || 0).total;
    } catch {
      // A plan the recurring module refuses to bill adds nothing to the forecast.
      return 0;
    }
  if (Number.isInteger(s.amount) && s.amount > 0) return s.amount;
  if (!service) return 0;
  return service.rate + Math.round((service.rate * (service.tax_rate || 0)) / 100);
}
// The next billing date of a plan: weekly to yearly, keeping the anchor day.
export function scheduleStep(day, s) {
  if (s.freq_unit)
    return stepPeriod(day, { unit: s.freq_unit, interval: s.freq_interval || 1, anchor_day: s.anchor_day, month_end: s.month_end });
  return step(day, s.frequency || "month", s);
}
export function cashForecast({
  docs,
  receipts,
  expenses,
  bills,
  pos = [],
  schedules = [],
  services = [],
  clients = [],
  recurring = [],
  scheduledDrafts = [],
  funding = [],
  lateness,
  cashBalance = null,
  cashDate = null,
  asOf,
  weeks = 13,
}) {
  const docsById = new Map(docs.map((d) => [d.id, d]));
  const horizon = addDays(asOf, weeks * 7 - 1);
  const list = Array.from({ length: weeks }, (_, i) => {
    const start = addDays(asOf, i * 7);
    return { week: i + 1, start, end: addDays(start, 6), inflow: 0, outflow: 0, net: 0, closing: 0, negative: false, items: [] };
  });
  const put = (day, amount, item) => {
    if (!amount) return;
    const when = day < asOf ? asOf : day;
    if (when > horizon) return;
    const w = list[Math.floor(days(asOf, when) / 7)];
    if (amount > 0) w.inflow += amount;
    else w.outflow -= amount;
    w.items.push({ date: day, amount, ...item });
  };
  // Opening balance: the owner's bank balance plus money in and out since that date.
  let opening = { known: cashBalance !== null && !!cashDate, balance: cashBalance ?? 0, date: cashDate, receipts: 0, refunds: 0, spent: 0, funding: 0 };
  if (opening.known) {
    for (const c of customerCash(receipts, docsById))
      if (c.date > cashDate && c.date <= asOf) c.amount > 0 ? (opening.receipts += c.amount) : (opening.refunds -= c.amount);
    for (const e of expenses) if (e.status === "paid" && e.paid_date > cashDate && e.paid_date <= asOf) opening.spent += e.amount;
    // Capital and loans in, loan repayments out (funding module).
    for (const f of funding) if (f.date > cashDate && f.date <= asOf) opening.funding += f.amount;
  }
  opening.estimated = opening.balance + opening.receipts - opening.refunds - opening.spent + opening.funding;
  const delayOf = (cid) => {
    const c = lateness?.clients?.[cid];
    return Math.round(c?.count ? c.avgDelay : lateness?.workspace?.avgDelay || 0);
  };
  // Inflows
  for (const d of docs.filter(isSalesInvoice)) {
    const p = lateness?.invoices?.[d.id];
    const f = invoiceFacts(d);
    if (f.balance <= 0) continue;
    put(p?.predicted || d.due_date, f.balanceMyr, {
      kind: "invoice",
      label: `${d.number} · ${f.client}`,
      ref: d.id,
      note: p ? (p.delay ? `due ${d.due_date}, expected ${p.delay > 0 ? p.delay + " days late" : -p.delay + " days early"}` : `due ${d.due_date}`) : "",
    });
  }
  const clientById = new Map(clients.map((c) => [c.id, c]));
  for (const d of scheduledDrafts) {
    const rate = docRate(d);
    put(addDays(d.due_date, delayOf(d.client_id)), toMyr(d.total, rate), { kind: "draft", label: `Recurring draft · ${d.client?.name || ""}`, ref: d.id });
  }
  for (const s of schedules) {
    if (!s.active) continue;
    const service = services.find((v) => v.id === s.service_id);
    if (service && !service.active) continue;
    const amount = scheduleAmount(s, service);
    if (!amount) continue;
    const name = clientById.get(s.client_id)?.name || "";
    let day = s.next_date;
    for (let i = 0; i < 60 && day <= horizon; i++) {
      if (s.end_date && day > s.end_date) break;
      put(addDays(day, (s.terms ?? 14) + delayOf(s.client_id)), amount, {
        kind: "schedule",
        label: `${service?.name || planLabel(s) || "Recurring plan"} · ${name}`,
        note: `billed ${day}`,
        ref: s.id,
      });
      day = scheduleStep(day, s);
    }
  }
  // Outflows
  for (const e of expenses)
    if (e.status !== "paid" && !e.bill_id)
      put(e.due_date || e.date, -e.amount, { kind: "expense", label: `${e.vendor_name || "Expense"} · ${e.description || ""}`.replace(/ · $/, ""), ref: e.id });
  for (const b of bills)
    if (b.state !== "void" && b.balance > 0) put(b.due_date, -b.balance, { kind: "bill", label: `${b.number} · ${b.vendor_name || ""}`, ref: b.id });
  for (const p of pos)
    if (["issued", "received"].includes(p.state) && !p.bill_id)
      put(p.expected_date || addDays(p.po_date, 30), -p.total, { kind: "po", label: `${p.number} · ${p.vendor_name || ""}`, ref: p.id, note: "purchase order not yet billed" });
  for (const r of recurring) {
    if (!r.active) continue;
    let day = r.next_date;
    for (let i = 0; i < 120 && day <= horizon; i++) {
      put(day, -r.amount, { kind: "recurring", label: r.name, ref: r.id });
      day = step(day, r.every);
    }
  }
  let balance = opening.estimated;
  for (const w of list) {
    w.net = w.inflow - w.outflow;
    balance += w.net;
    w.closing = balance;
    w.negative = balance < 0;
    w.items.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  }
  const lowest = list.reduce((m, w) => (w.closing < m.closing ? w : m), list[0]);
  return {
    asOf,
    horizon,
    opening,
    weeks: list,
    totals: { inflow: list.reduce((s, w) => s + w.inflow, 0), outflow: list.reduce((s, w) => s + w.outflow, 0) },
    lowest: { week: lowest.week, start: lowest.start, closing: lowest.closing },
    negativeWeeks: list.filter((w) => w.negative).map((w) => w.week),
  };
}

// ---------------------------------------------------------------------------
// 92. Cash health
// ---------------------------------------------------------------------------
export function cashHealth({ forecast, expenses, lateness, asOf }) {
  const start = addDays(asOf, -89);
  const spent = expenses.filter((e) => e.status === "paid" && e.paid_date >= start && e.paid_date <= asOf).reduce((s, e) => s + e.amount, 0);
  const monthly = Math.round(spent / 3);
  const cash = forecast.opening.known ? forecast.opening.estimated : null;
  let runwayDays = null;
  if (cash !== null && spent > 0) runwayDays = cash <= 0 ? 0 : Math.floor((cash * 90) / spent);
  const open = Object.values(lateness.invoices);
  const soon = addDays(asOf, 30);
  const dueSoon = open.filter((i) => i.due_date >= asOf && i.due_date <= soon);
  const overdue = open.filter((i) => i.due_date < asOf);
  const critical = [...overdue]
    .map((i) => ({ ...i, score: i.balanceMyr * RISK_WEIGHT[i.risk] }))
    .sort((a, b) => b.score - a.score || b.overdue - a.overdue)
    .slice(0, 3)
    .map(({ id, number, client, balanceMyr, overdue: o, risk, predicted }) => ({ id, number, client, balance: balanceMyr, overdue: o, risk, predicted }));
  return {
    asOf,
    cash,
    cashDate: forecast.opening.date,
    spent90: spent,
    monthlySpend: monthly,
    runwayDays,
    runwayMonths: runwayDays === null ? null : Math.round((runwayDays / 30.4375) * 10) / 10,
    dueSoon: dueSoon.reduce((s, i) => s + i.balanceMyr, 0),
    dueSoonCount: dueSoon.length,
    overdue: overdue.reduce((s, i) => s + i.balanceMyr, 0),
    overdueCount: overdue.length,
    critical,
    lowestWeek: forecast.lowest,
    negativeWeeks: forecast.negativeWeeks,
  };
}
