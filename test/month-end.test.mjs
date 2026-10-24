// One full month of billing, then every month-end report is checked against
// hand-worked figures and against each other: statements, aging, the
// accountant pack, the SST-02 worksheet, the sales and profit-and-loss
// reports and the consolidated e-Invoice. Activity after the month must not
// change any of them.
import test from "node:test";
import assert from "node:assert/strict";
import { today } from "../server/domain.mjs";
import { previousMonth } from "../server/recurring-dates.mjs";
import { packData } from "../server/recurring-pack.mjs";
import { sst02, taxSettings } from "../server/tax-sst.mjs";
import { fixture } from "./helpers.mjs";
import { configure, fakeMyInvois, readyBusiness } from "./tax-helpers.mjs";

const M = previousMonth(today());
const P = previousMonth(M + "-01");
const day = (d, month = M) => `${month}-${String(d).padStart(2, "0")}`;
const lastDay = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const END = lastDay(M);

async function setup() {
  const f = await fixture();
  readyBusiness(f.store, { sstNumber: "W10-1808-32000001" });
  // One-month SST periods, tax counted on the invoice date.
  f.store.db.prepare("UPDATE tax_settings SET data=json_set(data,'$.sstPeriodMonths',1,'$.serviceTaxBasis','invoice')").run();
  configure(f.store);
  const fake = fakeMyInvois();
  f.server.ctx.services.tax.api.fetch = fake.fetch;
  f.server.ctx.services.tax.einvoices.pollDelay = 0;
  return { ...f, fake };
}

// The month, as a small business would live it.
function month(s) {
  const client = (name, extra = {}) => s.saveClient({ name, ...extra });
  const issue = (c, issued, due, items, extra = {}) =>
    s.issue(s.saveDocument({ kind: "invoice", client_id: c.id, issue_date: issued, due_date: due, items, ...extra }).id);
  const line = (rate, tax_rate = 0, description = "Work") => ({ description, quantity: "1", rate, tax_rate });
  const pay = (d, amount, paid_date, reference, method = "Bank transfer") => s.recordPayment(d.id, { amount, paid_date, method, reference });

  const alpha = client("Alpha Sdn Bhd");
  const beta = client("Beta Trading");
  const usa = client("Acme Inc (USA)");
  const walkIn = client("Walk-in customers", { tax_fields: "1", tax_einvoice: "consolidate" });

  // Brought forward from the month before: unpaid at month end.
  const a0 = issue(alpha, day(10, P), day(24, P), [line("500.00")]);
  // Alpha: paid in full, then a credit note moves RM 108 back to customer funds, which is refunded.
  const a1 = issue(alpha, day(3), day(17), [line("1000.00", 8, "Retainer")]);
  pay(a1, "1080.00", day(15), "ALPHA-1");
  s.adjustment(a1.id, { kind: "credit", amount: "108.00", reason: "Missed hours", issue_date: day(25) });
  const alphaReceipt = s.receipts().find((r) => r.reference === "ALPHA-1");
  s.refund(alphaReceipt.id, { amount: "108.00", paid_date: day(27), reference: "RF-ALPHA-1", reason: "Credit note refunded" });
  // Beta: two lines, part paid, a debit note on the taxed line, and a payment
  // keyed in by mistake (no money came in), reversed and its receipt voided.
  const b1 = issue(beta, day(5), day(19), [line("1500.00", 8, "Setup"), line("500.00", 0, "Hardware pass-through")]);
  pay(b1, "1000.00", day(20), "BETA-1");
  const wrong = pay(b1, "200.00", day(21), "BETA-WRONG");
  s.reverse(wrong.id, "Keyed in by mistake");
  s.voidReceipt(wrong.receipt_id, "No such transfer");
  s.adjustment(b1.id, { kind: "debit", amount: "54.00", reason: "Extra visit", issue_date: day(26), tax_lines_from: [0] });
  // A US client billed in dollars at 4.5, part paid.
  const u1 = issue(usa, day(8), day(22), [line("100.00", 0, "Remote support")], { currency: "USD", fx_rate: "4.5" });
  pay(u1, "60.00", day(21), "ACME-1");
  // Walk-in sales, paid on the spot, reported in the monthly consolidated e-Invoice.
  const w1 = issue(walkIn, day(10), day(10), [line("250.00", 8, "Laptop repair")]);
  pay(w1, "270.00", day(10), "CASH-W1", "Cash");
  const w2 = issue(walkIn, day(12), day(12), [line("100.00", 0, "Data recovery")]);
  pay(w2, "100.00", day(12), "CASH-W2", "Cash");
  // Issued in error and voided; a quotation. Neither is money.
  s.void(issue(beta, day(14), day(28), [line("75.00")]).id, "Issued in error");
  s.saveDocument({ kind: "quote", client_id: beta.id, issue_date: day(15), due_date: day(28), items: [line("999.00")] });
  // The month's one cost.
  s.saveExpense({ date: day(1), vendor_name: "Landlord", category_id: "rent", amount: "1500.00", status: "paid", payment_method: "Bank transfer" });
  return { alpha, beta, usa, walkIn, a0, a1, b1, u1, w1, w2 };
}

// Everything an owner or accountant reads for the month.
function reports(s, m) {
  const { generated, business, ...pack } = packData(s, M);
  const statement = (c, currency) => {
    const { business: _b, client: _c, ...st } = s.statement(c.id, { from_date: day(1), to_date: END, currency });
    return st;
  };
  return {
    pack,
    statements: {
      alpha: statement(m.alpha),
      beta: statement(m.beta),
      usa: statement(m.usa, "USD"),
      walkIn: statement(m.walkIn),
    },
    sst02: { ...sst02(s, taxSettings(s), { period: M }), generated: undefined },
    sales: s.salesReport({ from: day(1), to: END }),
    pnl: s.profitAndLoss({ from: day(1), to: END }),
  };
}

// What happens after the month ends: none of it may change the month's reports.
function nextMonth(s, m) {
  const t = today();
  s.recordPayment(m.b1.id, { amount: "1174.00", paid_date: t, method: "Bank transfer", reference: "BETA-2" });
  s.recordPayment(m.u1.id, { amount: "40.00", paid_date: t, method: "Bank transfer", reference: "ACME-2" });
  s.adjustment(m.a0.id, { kind: "credit", amount: "100.00", reason: "Late discount", issue_date: t });
  // A second credit on a paid invoice moves more of its payment to customer funds, dated today.
  s.adjustment(m.a1.id, { kind: "credit", amount: "54.00", reason: "Rate corrected", issue_date: t });
  s.issue(s.saveDocument({ kind: "invoice", client_id: m.alpha.id, issue_date: t, due_date: t, items: [{ description: "Work", quantity: "1", rate: "300.00", tax_rate: 8 }] }).id);
  s.saveExpense({ date: t, vendor_name: "Landlord", category_id: "rent", amount: "1500.00", status: "paid", payment_method: "Bank transfer" });
}

const sumAging = (list) => list.reduce((t, a) => Object.fromEntries(Object.keys(t).map((k) => [k, t[k] + a[k]])), { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 });
const scale = (aging, rate) => Object.fromEntries(Object.entries(aging).map(([k, v]) => [k, Math.round(v * rate)]));

test("one month end to end: every report agrees, and later activity changes none of them", async () => {
  const f = await setup();
  try {
    const s = f.store;
    const m = month(s);
    const r = reports(s, m);
    const { pack, statements: st, sst02: ws, sales, pnl } = r;

    // Hand-worked figures, in sen. Invoiced: 1,080 + 2,120 + USD 100 at 4.5 + 270 + 100.
    assert.deepEqual(pack.totals, {
      invoices: 5,
      invoiced: 108000 + 212000 + 45000 + 27000 + 10000,
      sst: 8000 + 12000 + 2000 + 400 - 800, // invoices, debit note, less the credit note's share
      credit: 10800,
      debit: 5400,
      net_invoiced: 402000 + 5400 - 10800,
      received: 108000 + 100000 + 27000 + 27000 + 10000, // the voided receipt is not money
      refunded: 10800,
      net_cash: 272000 - 10800,
      outstanding: 50000 + 117400 + 18000, // Alpha's older invoice, Beta, USD 40 at 4.5
    });
    assert.deepEqual(pack.aging, { current: 0, d30: 117400 + 18000, d60: 50000, d90: 0, over90: 0 });
    assert.deepEqual(pack.open.map((o) => [o.number, o.balance]), [[m.a0.number, 50000], [m.b1.number, 117400], [m.u1.number, 18000]]);

    // Statements as at month end, one per client and currency.
    assert.deepEqual(
      st.alpha.lines.map((l) => [l.type, l.debit, l.credit]),
      [["Invoice", 108000, 0], ["Payment", 0, 108000], ["Credit note", 0, 10800], ["Moved to customer funds", 10800, 0]],
    );
    assert.equal(st.alpha.opening, 50000, "the older invoice is brought forward");
    assert.equal(st.alpha.closing, 50000);
    assert.deepEqual(st.beta.lines.map((l) => [l.type, l.debit, l.credit]), [["Invoice", 212000, 0], ["Payment", 0, 100000], ["Debit note", 5400, 0]]);
    assert.equal(st.beta.closing, 117400);
    assert.equal(st.usa.closing, 4000, "in dollars");
    assert.equal(st.walkIn.closing, 0);
    for (const x of Object.values(st)) assert.equal(x.closing, x.outstanding, "running balance and open invoices agree");
    // The pack's receivables are the statements added up (USD at its rate).
    assert.equal(st.alpha.outstanding + st.beta.outstanding + st.walkIn.outstanding + st.usa.outstanding * 4.5, pack.totals.outstanding);
    assert.deepEqual(sumAging([st.alpha.aging, st.beta.aging, st.walkIn.aging, scale(st.usa.aging, 4.5)]), pack.aging);

    // SST: the pack, the SST-02 worksheet and the books report one figure.
    assert.equal(ws.item12, 8000 + 12000 + 2000 + 400);
    assert.equal(ws.deductions.a, 800);
    assert.equal(ws.item14, pack.totals.sst);
    assert.equal(pnl.accrual.sst.total, pack.totals.sst);
    assert.equal(sales.totals.sst, pack.totals.sst);

    // Income and cash: the books agree with the pack.
    assert.equal(sales.totals.invoiced, pack.totals.net_invoiced);
    assert.equal(pnl.accrual.income.total, pack.totals.net_invoiced - pack.totals.sst, "income excludes SST, notes included");
    assert.equal(pnl.accrual.income.total, 100000 + 200000 + 45000 + 25000 + 10000 + 5000 - 10000);
    assert.equal(pnl.cash.income.total, pack.totals.net_cash);
    assert.equal(sales.totals.collected, pack.totals.net_cash);
    assert.equal(pnl.accrual.expenses.total, 150000);
    assert.equal(pnl.accrual.net.total, pnl.accrual.income.total - 150000);
    assert.equal(pnl.cash.net.total, pack.totals.net_cash - 150000);
    // No money is left unaccounted: the refund used the funds the credit note released.
    assert.equal(s.receipts().reduce((t, x) => t + x.available, 0), 0);

    // The walk-in sales go out as one consolidated e-Invoice for the month.
    const cands = await f.json(`/api/tax/consolidated?month=${M}`);
    assert.deepEqual(cands.ready.map((x) => x.number).sort(), [m.w1.number, m.w2.number].sort());
    const con = await f.json("/api/tax/consolidated", "POST", { month: M });
    const e = await f.json("/api/tax/einvoices", "POST", { source: "consolidated", id: con.id });
    assert.equal(e.state, "valid");
    const sent = f.fake.calls.filter((c) => c.path === "/api/v1.0/documentsubmissions/").at(-1).documents[0].json.Invoice[0];
    assert.equal(sent.LegalMonetaryTotal[0].PayableAmount[0]._ * 100, m.w1.total + m.w2.total);
    assert.equal(sent.TaxTotal[0].TaxAmount[0]._ * 100, m.w1.tax);

    // Next month's payments, notes, invoices and costs leave the month untouched.
    nextMonth(s, m);
    assert.deepEqual(reports(s, m), r);
  } finally {
    await f.close();
  }
});
