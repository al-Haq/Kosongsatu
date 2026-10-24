import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { today, addDays } from "../server/domain.mjs";
import {
  toMyr,
  apportion,
  salesReport,
  profitAndLoss,
  latePayment,
  cashForecast,
  cashHealth,
  lineKey,
} from "../server/books-calc.mjs";
import { exportLines, buildExport, formatDate, csvCell } from "../server/books-export.mjs";
import { sanitizeDraft, moneyText, parseJsonObject } from "../server/books-scan.mjs";
import { DEFAULT_SETTINGS } from "../server/books-store.mjs";

const T = today();
function workspace(settings = {}) {
  const s = openDatabase(":memory:");
  s.saveSettings({ registration: "TEST-1", address: "Test office", email: "t@example.com", ...settings });
  return s;
}
const invoice = (s, client, items, { issue = T, due = addDays(T, 14), discount = "0" } = {}) =>
  s.issue(s.saveDocument({ kind: "invoice", client_id: client.id, issue_date: issue, due_date: due, items, discount }).id);
const pay = (s, d, amount, paid_date = T, reference = "R-" + Math.random().toString(36).slice(2)) =>
  s.recordPayment(d.id, { amount, paid_date, method: "Bank transfer", reference });

test("currency conversion and apportioning are exact in sen", () => {
  assert.equal(toMyr(10000, "4.4725"), 44725);
  assert.equal(toMyr(333, "4.47"), 1489, "1488.51 rounds half up");
  assert.equal(toMyr(-333, "4.47"), -1489);
  assert.equal(toMyr(5, "0.5"), 3);
  assert.equal(toMyr(12345, "1"), 12345);
  assert.equal(toMyr(12345, "not-a-rate"), 12345, "a bad rate falls back to 1");
  assert.deepEqual(apportion(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(apportion(-100, [1, 1, 1]), [-34, -33, -33]);
  assert.deepEqual(apportion(10, [0, 0]), [10, 0]);
  assert.deepEqual(apportion(-10000, [100000, 30100]), [-7686, -2314]);
  for (const [t, w] of [
    [99999, [3, 7, 11, 13]],
    [1, [5, 5]],
    [123456789, [1, 2, 3]],
  ])
    assert.equal(apportion(t, w).reduce((a, b) => a + b, 0), t);
});

test("sales report: invoiced net of notes, collected cash, by client, item and month, in MYR", () => {
  const s = workspace();
  const a = s.saveClient({ name: "Alpha Sdn Bhd" }),
    b = s.saveClient({ name: "Beta Trading" });
  const a1 = invoice(s, a, [
    { description: "Web design", quantity: 1, rate: "1000.00" },
    { description: "Hosting", quantity: 2, rate: "150.50" },
  ]);
  s.adjustment(a1.id, { kind: "credit", amount: "100.00", reason: "Goodwill" });
  pay(s, a1, "500.00");
  const b1 = invoice(s, b, [{ description: "Consulting", quantity: 1, rate: "100.00" }]);
  pay(s, b1, "40.00");
  // Beta's invoice is in USD at 4.4725; its receipt follows the invoice's rate.
  const docs = s.documents().map((d) => (d.id === b1.id ? { ...d, currency: "USD", fx_rate: "4.4725" } : d));
  // Receipts carry their own currency and rate (a USD invoice takes USD receipts).
  const receipts = s.receipts().map((x) => (x.client_id === b.id ? { ...x, currency: "USD", fx_rate: "4.4725" } : x));
  const r = salesReport({ docs, receipts, services: [], from: T.slice(0, 8) + "01", to: T });
  assert.deepEqual(r.totals, { invoiced: 130100 - 10000 + 44725, sst: 0, collected: 50000 + 17890 });
  const alpha = r.clients.find((c) => c.client_id === a.id);
  assert.equal(alpha.invoiced, 120100);
  assert.equal(alpha.collected, 50000);
  assert.equal(r.clients.find((c) => c.client_id === b.id).invoiced, 44725);
  const item = (label) => r.items.find((i) => i.label === label);
  assert.equal(item("Web design").invoiced, 100000 - 7686);
  assert.equal(item("Hosting").invoiced, 30100 - 2314);
  assert.equal(item("Web design").collected, 38432);
  assert.equal(item("Hosting").collected, 11568);
  assert.equal(item("Consulting").invoiced, 44725);
  assert.equal(item("Consulting").collected, 17890);
  assert.equal(r.items.reduce((x, i) => x + i.invoiced, 0), r.totals.invoiced, "items reconcile to the total");
  assert.equal(r.items.reduce((x, i) => x + i.collected, 0), r.totals.collected);
  const month = r.months.find((m) => m.month === T.slice(0, 7));
  assert.equal(month.invoiced, r.totals.invoiced);
  assert.equal(month.collected, r.totals.collected);
  // Outside the period nothing counts.
  const before = salesReport({ docs, receipts, from: "2020-01-01", to: "2020-12-31" });
  assert.deepEqual(before.totals, { invoiced: 0, sst: 0, collected: 0 });
});

test("unapplied customer funds and refunds are shown so items reconcile with cash", () => {
  const s = workspace();
  const c = s.saveClient({ name: "Gamma" });
  const d = invoice(s, c, [{ description: "Audit", quantity: 1, rate: "300.00" }]);
  const r = s.receive({ client_id: c.id, amount: "500.00", paid_date: T, method: "Bank transfer", reference: "BIG-1", allocations: [{ invoice_id: d.id, amount: "300.00" }] });
  s.refund(r.id, { amount: "50.00", reference: "RF-BANK-1", reason: "Overpaid" });
  const rep = salesReport({ docs: s.documents(), receipts: s.receipts(), from: T, to: T });
  assert.equal(rep.totals.collected, 45000);
  assert.equal(rep.items.find((i) => i.key === "unapplied").collected, 15000);
  assert.equal(rep.items.reduce((x, i) => x + i.collected, 0), 45000);
});

test("line grouping uses SKU, catalog service, then description without the period suffix", () => {
  const services = [{ id: "s1", name: "Managed maintenance", description: "" }];
  assert.equal(lineKey({ sku: "abc-1", description: "Thing" }).key, "sku:ABC-1");
  assert.equal(lineKey({ service_id: "s1", description: "x" }, services).label, "Managed maintenance");
  assert.equal(lineKey({ description: "Managed maintenance - 2026-10" }, services).key, "service:s1");
  assert.equal(lineKey({ description: "Custom   work" }).key, "text:custom work");
});

test("profit and loss: accrual vs cash, SST outside income, bills paid through expenses counted once", () => {
  const s = workspace({ sstNumber: "W10-1234-56789012" });
  const c = s.saveClient({ name: "Delta" });
  const d = invoice(s, c, [{ description: "Support", quantity: 1, rate: "1000.00", tax_rate: 8 }]);
  assert.equal(d.total, 108000);
  pay(s, d, "540.00");
  s.saveExpense({ date: T, vendor_name: "Landlord", category_id: "rent", amount: "1500.00", status: "paid", payment_method: "Bank transfer" });
  const office = s.saveExpense({ date: T, vendor_name: "Stationer", category_id: "office", amount: "200.00", status: "unpaid", due_date: addDays(T, 14) });
  const vendor = s.saveVendor({ name: "Parts Co", default_category: "cost_of_sales" });
  const bill = s.saveBill({
    vendor_id: vendor.id,
    bill_date: T,
    items: [
      { description: "Switch", quantity: "2", rate: "650.00", category_id: "cost_of_sales" },
      { description: "Installation", quantity: "1", rate: "300.00", tax_rate: 8, category_id: "contractors" },
    ],
  });
  assert.equal(bill.total, 162400);
  const payment = s.payBill(bill.id, { amount: "800.00", paid_date: T, payment_method: "Bank transfer", reference: "PB-1" });
  assert.equal(payment.bill_id, bill.id);
  assert.equal(s.bill(bill.id).status, "Part-paid");
  assert.equal(s.bill(bill.id).balance, 82400);
  const p = () => profitAndLoss({ ...s.booksInputs(), from: T, to: T });
  let r = p();
  assert.equal(r.accrual.income.total, 100000, "SST is not income");
  assert.equal(r.accrual.sst.total, 8000);
  assert.equal(r.accrual.expenses.total, 150000 + 20000 + 130000 + 32400, "the bill counts once, its payment does not add to it");
  assert.equal(r.accrual.net.total, 100000 - 332400);
  const cat = (basis, id) => basis.categories.find((x) => x.id === id)?.total || 0;
  assert.equal(cat(r.accrual, "cost_of_sales"), 130000);
  assert.equal(cat(r.accrual, "contractors"), 32400);
  assert.equal(r.cash.income.total, 54000);
  assert.equal(cat(r.cash, "cost_of_sales"), 64039, "the bill payment is split by the bill's categories");
  assert.equal(cat(r.cash, "contractors"), 15961);
  assert.equal(cat(r.cash, "office"), 0, "unpaid expenses are not cash out");
  assert.equal(r.cash.expenses.total, 150000 + 80000);
  s.payExpense(office.id, { paid_date: T, payment_method: "Cash" });
  r = p();
  assert.equal(r.cash.expenses.total, 250000);
  assert.equal(r.accrual.expenses.total, 332400, "paying an expense does not change accrual");
  // A voided bill drops out of accrual; it can only be voided once payments are removed.
  assert.throws(() => s.voidBill(bill.id, "Wrong"), /payments/);
  s.deleteExpense(payment.id, "Entered twice");
  s.voidBill(bill.id, "Wrong supplier");
  r = p();
  assert.equal(r.accrual.expenses.total, 170000);
  assert.equal(r.cash.expenses.total, 170000);
});

test("notes carry their own SST, and a later credit note leaves an earlier period alone", () => {
  const s = workspace({ sstNumber: "W10-1234-56789012" });
  const c = s.saveClient({ name: "Echo" });
  const early = addDays(T, -10);
  const d = invoice(s, c, [{ description: "Support", quantity: 1, rate: "1000.00", tax_rate: 8 }], { issue: early, due: early });
  pay(s, d, "1080.00", early);
  s.adjustment(d.id, { kind: "credit", amount: "108.00", reason: "Fewer hours", issue_date: early });
  const range = { from: early, to: early };
  const sales = s.salesReport(range);
  const pnl = s.profitAndLoss(range);
  assert.equal(sales.totals.sst, 8000 - 800, "the credit note takes its RM 8 of SST off");
  assert.equal(pnl.accrual.sst.total, 8000 - 800);
  assert.equal(pnl.accrual.income.total, 100000 - 10000, "income excludes the note's SST too");
  assert.equal(sales.items.find((i) => i.label === "Support").collected, 108000 - 10800);
  // A second credit note today moves more of the payment to customer funds.
  s.adjustment(d.id, { kind: "credit", amount: "54.00", reason: "Rate corrected", issue_date: T });
  assert.deepEqual(s.salesReport(range), sales);
  assert.deepEqual(s.profitAndLoss(range), pnl);
});

test("tax summary maps categories to Form B lines and adds back non-deductible costs", () => {
  const s = workspace();
  const c = s.saveClient({ name: "Epsilon" });
  invoice(s, c, [{ description: "Project", quantity: 1, rate: "5000.00" }]);
  const e = (category_id, amount) => s.saveExpense({ date: T, vendor_name: "V " + category_id, category_id, amount, status: "paid", payment_method: "Card" });
  e("entertainment", "123.45");
  e("fines", "300.00");
  e("salaries", "2000.00");
  e("equipment", "1000.00");
  e("cost_of_sales", "400.00");
  const t = s.taxSummary({ year: Number(T.slice(0, 4)) });
  assert.equal(t.income, 500000);
  assert.equal(t.costOfSales, 40000);
  assert.equal(t.grossProfit, 460000);
  assert.equal(t.lines.find((l) => l.key === "salaries").total, 200000);
  assert.equal(t.lines.find((l) => l.key === "other").total, 12345 + 30000 + 100000);
  assert.equal(t.expenses, 342345);
  assert.equal(t.netProfit, 460000 - 342345);
  assert.deepEqual(
    t.adjustments.map((a) => [a.id, a.amount]).sort(),
    [
      ["entertainment", 6173],
      ["equipment", 100000],
      ["fines", 30000],
    ],
  );
  assert.equal(t.adjustedProfit, t.netProfit + 136173);
  // The owner can change how a category is treated.
  s.saveCategory({ deductible: 100 }, "entertainment");
  assert.equal(s.taxSummary({ year: Number(T.slice(0, 4)) }).addBack, 130000);
});

test("late payment: averages, share late, trend, predicted dates and reminder advice", () => {
  const s = workspace();
  const slow = s.saveClient({ name: "Slow Payer" }),
    fast = s.saveClient({ name: "Early Bird" }),
    fresh = s.saveClient({ name: "New Client" });
  const settled = (client, ago, lateBy) => {
    const issue = addDays(T, -ago),
      due = addDays(issue, 14);
    const d = invoice(s, client, [{ description: "Work", quantity: 1, rate: "100.00" }], { issue, due });
    pay(s, d, "100.00", addDays(due, lateBy));
  };
  settled(slow, 300, 2);
  settled(slow, 250, 10);
  settled(slow, 200, 20);
  settled(slow, 150, 30);
  settled(fast, 120, -3);
  settled(fast, 100, 0);
  const openSlow = invoice(s, slow, [{ description: "Work", quantity: 1, rate: "250.00" }], { due: addDays(T, 10) });
  const openFast = invoice(s, fast, [{ description: "Work", quantity: 1, rate: "100.00" }], { due: addDays(T, 5) });
  const lateFast = invoice(s, fast, [{ description: "Work", quantity: 1, rate: "100.00" }], { issue: addDays(T, -20), due: addDays(T, -10) });
  const openFresh = invoice(s, fresh, [{ description: "Work", quantity: 1, rate: "100.00" }], { due: addDays(T, 3) });
  const r = latePayment({ docs: s.documents(), asOf: T });
  const cs = r.clients[slow.id];
  assert.equal(cs.count, 4);
  assert.equal(cs.avgDelay, 15.5);
  assert.equal(cs.avgDaysLate, 15.5);
  assert.equal(cs.shareLate, 100);
  assert.equal(cs.trend, "worsening");
  assert.equal(cs.trendDelta, 19);
  assert.equal(cs.risk, "high");
  assert.match(cs.advice.text, /7 days before/);
  const ps = r.invoices[openSlow.id];
  assert.equal(ps.predicted, addDays(T, 10 + 16));
  assert.equal(ps.remindOn, addDays(T, 3));
  assert.equal(ps.risk, "high");
  const cf = r.clients[fast.id];
  assert.equal(cf.avgDelay, -1.5);
  assert.equal(cf.avgDaysLate, 0);
  assert.equal(cf.shareLate, 0);
  assert.equal(r.invoices[openFast.id].predicted, addDays(T, 4), "early payers are expected before the due date");
  assert.equal(cf.risk, "medium", "an overdue open invoice raises the client's risk");
  const lf = r.invoices[lateFast.id];
  assert.equal(lf.laterThanUsual, true);
  assert.equal(lf.predicted, addDays(T, 7));
  assert.equal(lf.risk, "high");
  assert.equal(lf.remindNow, "Overdue: follow up now.");
  assert.equal(r.workspace.avgDelay, 9.8);
  const nf = r.invoices[openFresh.id];
  assert.equal(nf.basis, "workspace");
  assert.equal(nf.predicted, addDays(T, 3 + 10));
});

test("cash flow forecast: opening estimate, weekly buckets, negative weeks and cash health", () => {
  const s = workspace();
  s.setCashBalance({ balance: "500.00", date: addDays(T, -1) });
  s.saveExpense({ date: T, vendor_name: "Shop", category_id: "office", amount: "300.00", status: "paid", payment_method: "Cash" });
  s.saveExpense({ date: addDays(T, -10), vendor_name: "Courier", category_id: "travel", amount: "250.00", status: "unpaid", due_date: addDays(T, -5) });
  const c = s.saveClient({ name: "Zeta" });
  invoice(s, c, [{ description: "Work", quantity: 1, rate: "1000.00" }], { due: addDays(T, 8) });
  const v = s.saveVendor({ name: "Supplier" });
  const bill = s.saveBill({ vendor_id: v.id, bill_date: T, due_date: addDays(T, 15), items: [{ description: "Parts", quantity: 1, rate: "400.00" }] });
  s.payBill(bill.id, { amount: "150.00", paid_date: T, payment_method: "Bank transfer" });
  s.saveRecurringCost({ name: "Hosting", category_id: "software", amount: "100.00", every: "month", next_date: addDays(T, 20) });
  const { forecast: f, health } = s.cashPicture(T);
  assert.equal(f.opening.known, true);
  assert.equal(f.opening.spent, 30000 + 15000);
  assert.equal(f.opening.estimated, 50000 - 45000);
  assert.equal(f.weeks.length, 13);
  assert.equal(f.weeks[0].outflow, 25000, "overdue unpaid expenses fall in week 1");
  assert.equal(f.weeks[0].closing, 5000 - 25000);
  assert.equal(f.weeks[0].negative, true);
  assert.deepEqual(f.negativeWeeks, [1]);
  assert.equal(f.weeks[1].inflow, 100000);
  assert.equal(f.weeks[2].outflow, 25000 + 10000, "only the bill's remaining balance, plus the recurring cost");
  const recurringOut = f.weeks.flatMap((w) => w.items).filter((i) => i.kind === "recurring");
  assert.equal(recurringOut.length, 3);
  assert.equal(f.weeks[12].closing, 5000 - 25000 + 100000 - 25000 - 30000);
  assert.equal(health.cash, 5000);
  assert.equal(health.spent90, 45000);
  assert.equal(health.monthlySpend, 15000);
  assert.equal(health.runwayDays, 10);
  assert.equal(health.dueSoon, 100000);
  assert.equal(health.overdue, 0);
});

test("forecast without a bank balance starts at zero and recurring schedules add expected receipts", () => {
  const s = workspace();
  const c = s.saveClient({ name: "Eta", terms: 14 });
  const svc = s.saveService({ name: "Retainer", rate: "750.00", tax_rate: 0 });
  s.saveSchedule({ client_id: c.id, service_id: svc.id, next_date: T, terms: 14 });
  const { forecast: f, health } = s.cashPicture(T);
  assert.equal(f.opening.known, false);
  assert.equal(health.cash, null);
  assert.equal(health.runwayDays, null);
  const items = f.weeks.flatMap((w) => w.items).filter((i) => i.kind === "schedule");
  assert.ok(items.length >= 2 && items.every((i) => i.amount === 75000));
  assert.equal(f.weeks[2].inflow, 75000, "billed today, paid 14 days later");
  // A two-line plan with a discount, every 2 weeks: its own total, on its own cadence.
  s.saveSchedule({
    client_id: c.id,
    frequency: "biweekly",
    terms: 0,
    next_date: T,
    discount: "10.00",
    lines: [
      { description: "Support", quantity: 2, rate: "100.00", tax_rate: 0 },
      { description: "Hosting", quantity: 1, rate: "50.00", tax_rate: 0 },
    ],
  });
  const plan = s.cashPicture(T).forecast.weeks.flatMap((w) => w.items).filter((i) => i.kind === "schedule" && i.amount === 24000);
  assert.equal(plan.length, 7, "every 14 days over 13 weeks");
  assert.match(plan[0].label, /^Support \+1/);
});

test("cash health ranks the most critical overdue invoices by amount and risk", () => {
  const lateness = {
    invoices: {
      a: { id: "a", number: "A", due_date: addDays(T, -5), balanceMyr: 100000, risk: "low", overdue: 5 },
      b: { id: "b", number: "B", due_date: addDays(T, -5), balanceMyr: 40000, risk: "high", overdue: 5 },
      c: { id: "c", number: "C", due_date: addDays(T, -2), balanceMyr: 60000, risk: "medium", overdue: 2 },
      d: { id: "d", number: "D", due_date: addDays(T, -1), balanceMyr: 1000, risk: "low", overdue: 1 },
      e: { id: "e", number: "E", due_date: addDays(T, 9), balanceMyr: 999999, risk: "high", overdue: 0 },
    },
  };
  const forecast = { opening: { known: true, estimated: 0, date: T }, lowest: {}, negativeWeeks: [] };
  const h = cashHealth({ forecast, expenses: [], lateness, asOf: T });
  assert.deepEqual(h.critical.map((x) => x.number), ["B", "C", "A"]);
  assert.equal(h.overdue, 201000);
  assert.equal(h.dueSoon, 999999);
  assert.equal(h.runwayDays, null, "no spending recorded");
});

test("accounting export lines keep the invoice's SST exact when there is a discount", () => {
  const s = workspace({ sstNumber: "W10-1234-56789012" });
  const c = s.saveClient({ name: "Theta", address: "Lot 1\nJalan Dua\nKuala Lumpur" });
  const d = invoice(
    s,
    c,
    [
      { description: "A", quantity: 3, rate: "33.33", tax_rate: 8 },
      { description: "B", quantity: 1, rate: "10.01", tax_rate: 8 },
      { description: "C", quantity: 1, rate: "50.00", tax_rate: 0 },
    ],
    { discount: "7.77" },
  );
  const lines = exportLines(d);
  assert.equal(lines.reduce((x, l) => x + l.amount, 0), d.subtotal - d.discount);
  assert.equal(lines.reduce((x, l) => x + l.tax, 0), d.tax);
  assert.equal(lines.filter((l) => l.discount).length, 2, "one discount line per SST rate");
  const out = buildExport("xero", "invoices", { docs: s.documents(), clients: [c], services: [], codes: {}, settings: DEFAULT_SETTINGS, from: T, to: T });
  assert.equal(out.rows[0][0], "*ContactName");
  assert.equal(out.rows.length, 1 + lines.length);
  assert.equal(out.rows[1][2], "Lot 1");
  assert.equal(out.rows[1][12], formatDate(T));
  assert.equal(out.rows[1][21], "Service Tax 8%");
  assert.equal(formatDate("2026-03-09"), "09/03/2026");
  assert.equal(formatDate("2026-03-09", "MM/DD/YYYY"), "03/09/2026");
  assert.equal(csvCell("-12.50"), '"-12.50"', "negative amounts stay numbers");
  assert.equal(csvCell("-cmd"), `"'-cmd"`);
  assert.equal(csvCell("=HYPERLINK(1)"), `"'=HYPERLINK(1)"`);
});

test("receipt drafts from a model are validated like user input", () => {
  const cats = [
    { id: "travel", name: "Travel", active: 1 },
    { id: "old", name: "Old", active: 0 },
  ];
  const d = sanitizeDraft(
    { vendor_name: "Grab\u0007 Malaysia", date: "2099-01-01", total: "RM 1,234.50", tax: "9999", reference: "X".repeat(300), currency: "usd", category_id: "old" },
    cats,
    T,
  );
  assert.equal(d.vendor_name, "Grab Malaysia");
  assert.equal(d.date, "");
  assert.equal(d.amount, "1234.50");
  assert.equal(d.tax, "");
  assert.equal(d.reference.length, 120);
  assert.equal(d.currency, "USD");
  assert.equal(d.category_id, "");
  assert.ok(d.warnings.length >= 3);
  assert.equal(moneyText(12.3), "12.30");
  assert.equal(moneyText("-5"), "");
  assert.deepEqual(parseJsonObject('Sure! ```json\n{"a":1}\n```'), { a: 1 });
  assert.throws(() => parseJsonObject("no json here"), /did not return/);
});
