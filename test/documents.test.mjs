import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { calculate, today, addDays, toMYR, allocateDiscount } from "../server/domain.mjs";
import { totals, depositParts } from "../public/ext/documents-calc.mjs";
import { instalmentSchedule } from "../server/documents-store.mjs";

const setup = (settings = {}) => {
  const store = openDatabase(":memory:");
  store.saveSettings({ registration: "TEST-001", address: "Test office", email: "billing@example.com", ...settings });
  const client = store.saveClient({ name: "Test client", email: "client@example.com", terms: 14 });
  const draft = (b = {}) =>
    store.saveDocument({
      kind: "invoice",
      client_id: client.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      items: [{ description: "Integration", quantity: 1, rate: "1000.00" }],
      ...b,
    });
  return { store, client, draft };
};
const pay = (store, id, amount, reference, extra = {}) =>
  store.recordPayment(id, { amount, paid_date: today(), method: "Bank transfer", reference, ...extra });

test("line discounts come off before the document discount, and SST follows both", () => {
  const r = calculate(
    [
      { description: "A", quantity: "2", rate: "100.00", tax_rate: 8, discount_percent: "10" },
      { description: "B", quantity: 1, rate: "50", discount_amount: "5" },
      { description: "C", quantity: 1, rate: "10" },
    ],
    "11.50",
  );
  const [a, b, c] = r.items;
  assert.deepEqual([a.gross, a.discount, a.amount, a.discount_percent], [20000, 2000, 18000, "10"]);
  assert.deepEqual([b.gross, b.discount, b.amount, b.discount_amount], [5000, 500, 4500, "5.00"]);
  assert.equal(c.discount, undefined, "lines without a discount keep the old shape");
  assert.equal(r.subtotal, 23500);
  // The document discount is shared by the lines' amounts after their own discounts.
  assert.equal(a.taxable + b.taxable + c.taxable, 23500 - 1150);
  assert.equal(a.tax, Math.round((a.taxable * 8) / 100));
  assert.equal(r.total, 23500 - 1150 + a.tax);
  assert.throws(() => calculate([{ description: "X", quantity: 1, rate: "10", discount_percent: "101" }]), /0 to 100%/);
  assert.throws(() => calculate([{ description: "X", quantity: 1, rate: "10", discount_percent: "1.234" }]), /0 to 100%/);
  assert.throws(() => calculate([{ description: "X", quantity: 1, rate: "10", discount_amount: "10.01" }]), /more than the line/);
  assert.throws(() => calculate([{ description: "X", quantity: 1, rate: "10", discount_percent: "100" }]), /greater than zero/);
  // 100% off one line is fine while the document still has a value.
  const free = calculate([
    { description: "X", quantity: 1, rate: "10", discount_percent: "100" },
    { description: "Y", quantity: 1, rate: "10" },
  ]);
  assert.equal(free.total, 1000);
});

// calculate() as it was before line discounts, kept as the reference for old documents.
function legacyCalculate(items, discount) {
  const money = (v) => {
    const [a, b = ""] = String(v).split(".");
    return Number(a) * 100 + Number(b.padEnd(2, "0"));
  };
  const clean = items.map((item) => {
    const rate = money(item.rate);
    const quantity = Math.round(Number(String(item.quantity)) * 100);
    const amount = Math.round((rate * quantity) / 100);
    return { description: item.description.trim(), quantity: quantity / 100, rate, amount, tax_rate: Number(item.tax_rate ?? 0) };
  });
  const subtotal = clean.reduce((sum, i) => sum + i.amount, 0);
  const off = money(discount);
  if (!(off <= subtotal && subtotal - off > 0)) return null;
  const shares = allocateDiscount(clean.map((i) => i.amount), off);
  for (const [n, i] of clean.entries()) {
    i.taxable = i.amount - shares[n];
    i.tax = Math.round((i.taxable * i.tax_rate) / 100);
  }
  const tax = clean.reduce((s, i) => s + i.tax, 0);
  return { items: clean, subtotal, discount: off, tax, total: subtotal - off + tax };
}
test("documents without the new fields total and serialize exactly as before", () => {
  let seed = 11;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  let checked = 0;
  for (let k = 0; k < 400; k++) {
    const items = Array.from({ length: 1 + rnd(8) }, (_, n) => ({
      description: " Line " + n,
      quantity: (1 + rnd(5000) / 100).toFixed(rnd(3)),
      rate: (rnd(2000000) / 100).toFixed(2),
      tax_rate: [0, 5, 6, 8, 10][rnd(5)],
    }));
    const discount = (rnd(100000) / 100).toFixed(2);
    const old = legacyCalculate(items, discount);
    if (!old) {
      assert.throws(() => calculate(items, discount));
      continue;
    }
    // Same values and the same keys in the same order, so stored JSON is unchanged.
    assert.equal(JSON.stringify(calculate(items, discount)), JSON.stringify(old));
    checked++;
  }
  assert.ok(checked > 300);
});

test("the editor preview arithmetic matches calculate() on random documents", () => {
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let k = 0; k < 400; k++) {
    const items = Array.from({ length: 1 + rnd(6) }, (_, n) => {
      const rate = (rnd(500000) / 100).toFixed(2);
      const i = { description: "L" + n, quantity: (1 + rnd(900) / 100).toFixed(2), rate, tax_rate: [0, 5, 6, 8, 10][rnd(5)] };
      const t = rnd(3);
      if (t === 1) i.discount_percent = String(rnd(5000) / 100);
      if (t === 2) i.discount_amount = (Math.min(rnd(2000), Number(rate) * 100) / 100).toFixed(2);
      return i;
    });
    let server;
    try {
      server = calculate(items, "0");
    } catch {
      continue;
    }
    const discount = Math.floor(rnd(Math.max(1, server.subtotal)) / 3);
    server = calculate(items, (discount / 100).toFixed(2));
    // The browser parses the same form values and calls the shared totals().
    const lines = items.map((i) => {
      const rate = Math.round(Number(i.rate) * 100),
        q = Math.round(Number(i.quantity) * 100),
        gross = Math.round((rate * q) / 100);
      const off = i.discount_percent
        ? Math.round((gross * Math.round(Number(i.discount_percent) * 100)) / 10000)
        : Math.round(Number(i.discount_amount || 0) * 100);
      return { gross, discount: off, tax_rate: i.tax_rate };
    });
    const preview = totals(lines, discount);
    assert.equal(preview.total, server.total, JSON.stringify(items));
    assert.equal(preview.tax, server.tax);
    assert.deepEqual(preview.lines.map((l) => l.tax), server.items.map((i) => i.tax));
  }
});

test("delivery orders carry no prices; new kinds get their own number prefixes", () => {
  const { store, draft } = setup();
  try {
    const dlv = draft({ kind: "delivery_order", items: [{ description: "Router", quantity: 3, rate: "999.00", tax_rate: 8, unit: "Unit" }] });
    assert.equal(dlv.total, 0);
    assert.deepEqual([dlv.items[0].rate, dlv.items[0].tax, dlv.items[0].unit], [0, 0, "Unit"]);
    assert.match(store.issue(dlv.id).number, /^DO-\d{4}-0001$/);
    assert.match(store.issue(draft({ kind: "proforma" }).id).number, /^PF-\d{4}-0001$/);
    assert.match(store.issue(draft({ kind: "sales_order" }).id).number, /^SO-\d{4}-0001$/);
    assert.match(store.issue(draft().id).number, /^INV-\d{4}-0001$/);
    store.saveSettings({ proformaPrefix: "PRO" });
    assert.match(store.issue(draft({ kind: "proforma" }).id).number, /^PRO-\d{4}-0002$/);
    assert.throws(() => store.saveSettings({ salesOrderPrefix: "INV" }), /own number prefix/);
    assert.throws(() => store.saveSettings({ deliveryOrderPrefix: "CN" }), /reserved/);
    assert.throws(() => store.saveSettings({ deliveryOrderPrefix: "do" }), /uppercase/);
    assert.throws(() => draft({ kind: "receipt" }), /Invalid document type/);
  } finally {
    store.db.close();
  }
});

test("a proforma never affects balances and converts once into a linked invoice", () => {
  const { store, draft } = setup();
  try {
    const pf = store.issue(draft({ kind: "proforma" }).id);
    assert.equal(pf.balance, 0);
    assert.throws(() => pay(store, pf.id, "10", "PF-PAY"), /issued invoice/);
    assert.equal(store.share(pf.id).token.length, 43, "shareable");
    const inv = store.deriveDocument(pf.id, "invoice");
    assert.equal(inv.kind, "invoice");
    assert.equal(inv.state, "draft");
    assert.equal(inv.total, pf.total);
    assert.equal(inv.links.source.id, pf.id);
    assert.equal(store.deriveDocument(pf.id, "invoice").id, inv.id, "converting again opens the same invoice");
    assert.equal(store.document(pf.id).status, "Issued", "a draft invoice does not convert it yet");
    store.issue(inv.id);
    assert.equal(store.document(pf.id).status, "Converted");
    assert.throws(() => store.void(pf.id, "mistake"), /linked/);
    assert.throws(() => store.deriveDocument(pf.id, "sales_order"), /cannot be converted/);
    assert.throws(() => store.deriveDocument(draft({ kind: "proforma" }).id, "invoice"), /Issue the document/);
  } finally {
    store.db.close();
  }
});

test("quotation -> sales order -> invoice and delivery order, with codes and units kept", () => {
  const { store, client, draft } = setup();
  try {
    const svc = store.saveService({ name: "Router", rate: "450.00", unit: "Unit", sku: "rt-100" });
    assert.equal(svc.sku, "RT-100");
    assert.throws(() => store.saveService({ name: "Other", rate: "1", sku: "RT-100" }), /already uses/);
    const q = store.issue(
      draft({
        kind: "quote",
        items: [
          { description: "Router", quantity: 2, rate: "450.00", service_id: svc.id, discount_percent: "10" },
          { description: "Setup", quantity: 1, rate: "200.00" },
        ],
      }).id,
    );
    assert.deepEqual([q.items[0].sku, q.items[0].unit, q.items[0].service_id], ["RT-100", "Unit", svc.id]);
    assert.throws(() => store.deriveDocument(q.id, "sales_order"), /Accept the quotation/);
    store.acceptOffline(q.id, { name: "Aina", evidence: "Email" });
    const so = store.issue(store.deriveDocument(q.id, "sales_order").id);
    assert.equal(so.total, q.total);
    assert.equal(so.items[0].discount, q.items[0].discount);
    assert.throws(() => store.convert(q.id), /sales order/);
    const inv = store.issue(store.deriveDocument(so.id, "invoice").id);
    assert.equal(inv.total, q.total);
    assert.equal(inv.items[0].service_id, svc.id);
    assert.equal(store.document(so.id).status, "Invoiced");
    const dlv = store.deriveDocument(so.id, "delivery_order");
    assert.equal(dlv.total, 0);
    assert.deepEqual(dlv.items.map((i) => [i.description, i.quantity, i.sku || "", i.rate]), [
      ["Router", 2, "RT-100", 0],
      ["Setup", 1, "", 0],
    ]);
    store.issue(dlv.id);
    assert.equal(store.document(so.id).status, "Completed");
    const fromInvoice = store.deriveDocument(inv.id, "delivery_order");
    assert.equal(fromInvoice.links.source.id, inv.id);
    // A sales order from scratch converts too.
    const loose = store.issue(draft({ kind: "sales_order" }).id);
    assert.equal(store.deriveDocument(loose.id, "invoice").client_id, client.id);
    // Deleted catalog items are dropped from new lines instead of failing.
    store.deleteService(svc.id);
    const copy = store.duplicateDocument(q.id);
    assert.equal(copy.items[0].service_id, undefined);
    assert.equal(copy.items[0].discount_percent, "10");
  } finally {
    store.db.close();
  }
});

test("documents in other currencies: rates, receipts in the same currency, MYR reports", () => {
  const { store, client, draft } = setup({ sstNumber: "W10-1234-56789012" });
  try {
    assert.throws(() => draft({ currency: "USD" }), /exchange rate/);
    assert.throws(() => draft({ currency: "XYZ", fx_rate: "1" }), /supported currency/);
    const usd = store.issue(draft({ currency: "USD", fx_rate: "4.4500", items: [{ description: "App", quantity: 1, rate: "1000.00", tax_rate: 8 }] }).id);
    assert.deepEqual([usd.currency, usd.fx_rate, usd.total], ["USD", "4.45", 108000]);
    const myr = store.issue(draft().id);
    // A payment against the USD invoice is a USD receipt.
    const p = pay(store, usd.id, "500.00", "USD-1", { fx_rate: "4.50" });
    const r = store.receipt(p.receipt_id);
    assert.deepEqual([r.currency, r.fx_rate, r.amount], ["USD", "4.5", 50000]);
    assert.throws(() => store.allocate(r.id, { invoice_id: myr.id, amount: "10" }), /only pay USD/);
    const myrReceipt = store.receive({ client_id: client.id, amount: "50", paid_date: today(), method: "Cash", reference: "CASH-1" });
    assert.equal(myrReceipt.currency, "MYR");
    assert.throws(() => store.allocate(myrReceipt.id, { invoice_id: usd.id, amount: "10" }), /only pay MYR/);
    // Bank lines are MYR, so USD receipts never match them.
    store.importBank({ csv: `date,reference,amount\n${today()},USD-1,500.00`, account: "MAIN" });
    const t = store.db.prepare("SELECT id FROM bank_transactions").get();
    assert.throws(() => store.matchBank(t.id, { kind: "receipt", target_id: r.id }), /MYR receipts only/);
    // SST reporting is in MYR at the invoice's rate.
    const sst = store.sstReport({});
    const row = sst.rows.find((x) => x.number === usd.number);
    assert.deepEqual([row.currency, row.taxable, row.tax, row.tax_original], ["USD", toMYR(100000, "4.45"), toMYR(8000, "4.45"), 8000]);
    assert.equal(sst.tax, toMYR(8000, "4.45"));
    // Statements show one section per currency.
    const s = store.statement(client.id, {});
    assert.deepEqual(s.groups.map((g) => g.currency), ["MYR", "USD"]);
    assert.equal(s.groups[1].closing, 108000 - 50000);
    assert.equal(s.groups[0].closing, myr.total);
    // Client default currency and language apply to new documents.
    store.saveClient({ ...client, currency: "SGD", language: "ms" }, client.id);
    // The editor sends the client's default currency; a document that names no
    // currency (schedules, proposals with MYR catalog prices) stays in MYR.
    const plain = draft();
    assert.deepEqual([plain.currency, plain.language], ["MYR", "ms"]);
    const sgd = draft({ currency: "SGD", fx_rate: "3.4" });
    assert.equal(sgd.currency, "SGD");
    // A currency without a rate reuses the last rate entered for it.
    assert.equal(draft({ currency: "SGD" }).fx_rate, "3.4");
    assert.throws(() => draft({ currency: "EUR" }), /exchange rate/);
    assert.throws(() => store.saveClient({ ...client, currency: "ABC" }, client.id), /supported currency/);
  } finally {
    store.db.close();
  }
});

test("deposits: one invoice per rate, deducted on the final invoice with SST on both", () => {
  const { store, draft } = setup({ sstNumber: "W10-1234-56789012" });
  try {
    const items = [
      { description: "Development", quantity: 1, rate: "10000.00", tax_rate: 8 },
      { description: "Hardware", quantity: 2, rate: "1234.57", tax_rate: 10 },
      { description: "Training", quantity: 1, rate: "999.99" },
    ];
    assert.throws(() => draft({ kind: "quote", items, deposit: { type: "percent", value: "100" } }), /between 0 and 100/);
    assert.throws(() => draft({ kind: "quote", items, deposit: { type: "amount", amount: 99999999 } }), /less than the quotation total/);
    const q = store.issue(draft({ kind: "quote", items, discount: "100.00", deposit_type: "percent", deposit_value: "30" }).id);
    assert.equal(q.meta.deposit.value, "30");
    assert.ok(Math.abs(q.deposit.total - Math.round(q.total * 0.3)) <= 2, "about 30% of the total");
    assert.throws(() => store.createDepositInvoice(q.id), /Accept the quotation/);
    store.acceptOffline(q.id, { name: "Aina", evidence: "Signed" });
    const depDraft = store.createDepositInvoice(q.id);
    assert.equal(store.createDepositInvoice(q.id).id, depDraft.id, "one click, once");
    assert.throws(() => store.convert(q.id), /deposit invoice draft/);
    const dep = store.issue(depDraft.id);
    assert.deepEqual(dep.items.map((i) => i.tax_rate), [0, 8, 10]);
    assert.equal(dep.total, q.deposit.total);
    const fin = store.issue(store.convert(q.id).id);
    const deductions = fin.items.filter((i) => i.deposit_id);
    assert.equal(deductions.length, 3);
    assert.ok(deductions.every((i) => i.deposit_number === dep.number && i.amount < 0));
    // Together the two invoices bill exactly the quotation, and SST at each rate.
    assert.equal(dep.total + fin.total, q.total);
    const sst = (d, rate) => d.items.filter((i) => i.tax_rate === rate).reduce((s, i) => s + i.tax, 0);
    for (const rate of [8, 10]) assert.equal(sst(dep, rate) + sst(fin, rate), sst(q, rate));
    const report = store.sstReport({});
    for (const rate of [8, 10])
      assert.equal(report.rates.find((x) => x.rate === rate).tax, sst(q, rate), "the SST report counts the deposit once");
    // The deposit cannot be voided while a final invoice deducts it.
    assert.throws(() => store.void(dep.id, "oops"), /deducted on/);
    assert.throws(() => store.createDepositInvoice(q.id) && store.void(q.id, "x"), /linked|converted/);
    // A fixed deposit is before SST, split by rate the same way.
    const q2 = store.issue(draft({ kind: "quote", items, deposit: { type: "amount", amount: 500000 } }).id);
    assert.equal(q2.deposit.amount, 500000);
    assert.equal(depositParts(q2.items, q2.meta.deposit).reduce((s, p) => s + p.amount, 0), 500000);
  } finally {
    store.db.close();
  }
});

test("a voided deposit makes the final draft stale until it is saved again", () => {
  const { store, draft } = setup();
  try {
    const q = store.issue(draft({ kind: "quote", deposit: { type: "percent", value: "50" } }).id);
    store.acceptOffline(q.id, { name: "A", evidence: "B" });
    const dep = store.issue(store.createDepositInvoice(q.id).id);
    const fin = store.convert(q.id);
    assert.equal(fin.total, 50000);
    store.deleteDraft(fin.id);
    store.void(dep.id, "Client paid in full instead");
    const again = store.convert(q.id);
    assert.equal(again.total, 100000, "no deduction once the deposit is void");
  } finally {
    store.db.close();
  }
});

test("instalments: plan validation, next due date and Overdue follow the plan", () => {
  const { store, draft } = setup();
  try {
    const inv = store.issue(draft({ issue_date: addDays(today(), -40), due_date: addDays(today(), -26) }).id);
    assert.equal(inv.status, "Overdue");
    assert.equal(inv.next_due_date, inv.due_date);
    const plan = [
      { due_date: addDays(today(), -30), amount: "300.00" },
      { due_date: addDays(today(), 10), amount: "300.00" },
      { due_date: addDays(today(), 40), amount: "400.00" },
    ];
    assert.throws(() => store.setInstalments(inv.id, plan.slice(0, 2)), /add up to the invoice total/);
    assert.throws(() => store.setInstalments(inv.id, [plan[1], plan[0], plan[2]]), /date order/);
    assert.throws(() => store.setInstalments(inv.id, [{ due_date: addDays(today(), -60), amount: "1000" }, plan[1]]), /before the invoice date/);
    assert.throws(() => store.setInstalments(draft().id, plan), /issued invoice/);
    let d = store.setInstalments(inv.id, plan);
    assert.equal(d.status, "Overdue", "the first instalment is late");
    assert.deepEqual([d.next_due_date, d.next_due_amount], [plan[0].due_date, 30000]);
    pay(store, inv.id, "350.00", "I-1");
    d = store.document(inv.id);
    assert.equal(d.status, "Part-paid", "not overdue once the late instalment is paid");
    assert.deepEqual([d.next_due_date, d.next_due_amount], [plan[1].due_date, 25000]);
    assert.deepEqual(d.instalments.map((i) => i.status), ["paid", "part", "due"]);
    // A credit note reduces the last instalments.
    store.adjustment(inv.id, { kind: "credit", amount: "200.00", reason: "Scope change" });
    d = store.document(inv.id);
    assert.deepEqual(d.instalments.map((i) => i.amount), [30000, 30000, 20000]);
    store.clearInstalments(inv.id);
    assert.equal(store.document(inv.id).status, "Overdue");
    // Schedule maths on its own.
    assert.deepEqual(instalmentSchedule([{ seq: 1, due_date: "2026-01-01", amount: 100 }, { seq: 2, due_date: "2026-02-01", amount: 100 }], 250, 0).instalments.map((i) => i.amount), [100, 150]);
  } finally {
    store.db.close();
  }
});

test("custom fields: up to 10, per kind, frozen at issue, internal ones stay internal", () => {
  const { store, draft } = setup();
  try {
    assert.throws(() => store.saveSettings({ customFields: Array.from({ length: 11 }, (_, i) => ({ label: "F" + i })) }), /up to 10/);
    assert.throws(() => store.saveSettings({ customFields: [{ label: "" }] }), /Required/);
    const s = store.saveSettings({
      customFields: [
        { label: "Project code", applies: "all", show: "pdf" },
        { label: "Cost centre", applies: "invoice", show: "internal" },
        { label: "Site", applies: "quote", show: "pdf" },
      ],
    });
    const [project, cost, site] = s.customFields;
    const d = draft({ ["cf_" + project.id]: "PRJ-7", custom: { [cost.id]: "OPS", [site.id]: "ignored on invoices" } });
    assert.deepEqual(d.meta.custom, { [project.id]: "PRJ-7", [cost.id]: "OPS" });
    const issued = store.issue(d.id);
    // Renaming the field later does not change the issued document's label.
    store.saveSettings({ customFields: [{ ...project, label: "Renamed" }, cost, site] });
    assert.equal(store.document(issued.id).business.customFields[0].label, "Project code");
    assert.equal(store.settings().customFields[0].id, project.id, "ids are kept");
    assert.throws(() => store.saveDocument({ ...d, ["cf_" + project.id]: "X" }, d.id), /locked/);
  } finally {
    store.db.close();
  }
});

test("Chinese documents and Chinese line text need a CJK font to issue", () => {
  const { store, draft } = setup();
  try {
    store.cjkFont = () => null;
    assert.throws(() => store.issue(draft({ language: "zh" }).id), /Chinese font/);
    assert.throws(() => store.issue(draft({ items: [{ description: "网站设计", quantity: 1, rate: "10" }] }).id), /Chinese font/);
    assert.ok(store.issue(draft({ language: "ms" }).id).number, "Malay needs no extra font");
    store.cjkFont = () => "/fonts/cjk.ttc";
    assert.ok(store.issue(draft({ language: "zh" }).id).number);
    assert.throws(() => draft({ language: "fr" }), /English, Bahasa Melayu or Chinese/);
  } finally {
    store.db.close();
  }
});

test("every document label exists in English, Bahasa Melayu and Chinese", async () => {
  const { LABELS, labels } = await import("../public/ext/documents-i18n.mjs");
  const keys = Object.keys(LABELS.en).sort();
  for (const lang of ["ms", "zh"]) assert.deepEqual(Object.keys(LABELS[lang]).sort(), keys, lang);
  assert.equal(
    labels("ms")("nextPaymentDue", { amount: "RM 1.00", date: "1 Jan" }),
    "Bayaran seterusnya sebanyak RM 1.00 perlu dibuat pada 1 Jan.",
  );
  assert.equal(labels("fr")("billTo"), "Bill to", "unknown languages fall back to English");
});
