import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { today, addDays } from "../server/domain.mjs";
import { addMonths, periodFor, recentPeriods, sst02, taxSettings, TAX_DEFAULTS } from "../server/tax-sst.mjs";
import { fixture } from "./helpers.mjs";
import { invoice } from "./tax-helpers.mjs";

function store() {
  const s = openDatabase(":memory:");
  s.saveSettings({ registration: "TEST-1", address: "Office", email: "t@example.com", sstNumber: "W10-1808-32000001" });
  return s;
}
const setTax = (s, data) =>
  s.db
    .prepare("INSERT INTO tax_settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
    .run(JSON.stringify({ ...TAX_DEFAULTS, ...data }));
const month = today().slice(0, 7);

test("taxable periods follow the length and starting month set by Customs", () => {
  const two = { ...TAX_DEFAULTS, sstPeriodMonths: 2, sstPeriodStart: 1 };
  assert.deepEqual(periodFor("2026-10", two), { from: "2026-09-01", to: "2026-10-31", months: 2, key: "2026-09", due: "2026-11-30" });
  assert.deepEqual(periodFor("2026-09", two).from, "2026-09-01");
  const feb = { ...TAX_DEFAULTS, sstPeriodMonths: 2, sstPeriodStart: 2 };
  assert.deepEqual(periodFor("2026-01", feb), { from: "2025-12-01", to: "2026-01-31", months: 2, key: "2025-12", due: "2026-02-28" });
  assert.equal(periodFor("2026-02", { ...TAX_DEFAULTS, sstPeriodMonths: 1 }).to, "2026-02-28");
  assert.equal(periodFor("2028-02", { ...TAX_DEFAULTS, sstPeriodMonths: 1 }).to, "2028-02-29");
  const list = recentPeriods(two, 3, "2026-10-17");
  assert.deepEqual(list.map((p) => p.key), ["2026-09", "2026-07", "2026-05"]);
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.throws(() => periodFor("2026-13", two), /valid month/);
});

test("invoice basis: tax by rate, debit notes in item 11, credit notes in 13(a), zero-rated in Part D", () => {
  const s = store();
  try {
    setTax(s, { serviceTaxBasis: "invoice", sstPeriodMonths: 1 });
    const c = s.saveClient({ name: "Basis" });
    const d = invoice(s, c, { discount: "175.00" });
    s.adjustment(d.id, { kind: "debit", amount: "54.00", reason: "More", tax_lines_from: [0] });
    s.adjustment(d.id, { kind: "credit", amount: "55.00", reason: "Less", tax_lines_from: [1] });
    const ws = sst02(s, taxSettings(s), { period: month });
    assert.deepEqual(ws.items["11d"], { value: 90000 + 5000, tax: 7200 + 400 });
    assert.deepEqual(ws.items["11b"], { value: 45000, tax: 4500 });
    assert.equal(ws.items["11a"].tax + ws.items["11c"].tax, 0);
    assert.equal(ws.item12, 7600 + 4500);
    assert.equal(ws.deductions.a, 500);
    assert.equal(ws.item14, 12100 - 500);
    assert.deepEqual(ws.partD, { exempt: 0, other: 22500 });
    assert.ok(ws.rows.some((r) => r.item === "13a" && r.kind === "credit note"));
    assert.equal(ws.sstNumber, "W10-1808-32000001");
    // Nothing from a different period.
    const other = sst02(s, taxSettings(s), { period: addMonths(today(), -3).slice(0, 7) });
    assert.equal(other.item12, 0);
  } finally {
    s.db.close();
  }
});

test("payment basis: service tax follows money received, sales tax stays on invoice date", () => {
  const s = store();
  try {
    setTax(s, { serviceTaxBasis: "payment", sstPeriodMonths: 1 });
    const c = s.saveClient({ name: "Pay" });
    const d = invoice(s, c, {
      items: [
        { description: "Support", quantity: "1", rate: "1000.00", tax_rate: 8 },
        { description: "Part", quantity: "1", rate: "100.00", tax_rate: 10 },
      ],
    });
    let ws = sst02(s, taxSettings(s), { period: month });
    assert.deepEqual(ws.items["11d"], { value: 0, tax: 0 }, "unpaid service tax is not yet due");
    assert.deepEqual(ws.items["11b"], { value: 10000, tax: 1000 });
    // Half the invoice is paid.
    s.recordPayment(d.id, { amount: (d.total / 200).toFixed(2), paid_date: today(), method: "Cash", reference: "HALF" });
    ws = sst02(s, taxSettings(s), { period: month });
    assert.deepEqual(ws.items["11d"], { value: 50000, tax: 4000 });
    // Paid in full, then a credit note on the service line: a deduction under 13(a).
    s.recordPayment(d.id, { amount: (d.total / 200).toFixed(2), paid_date: today(), method: "Cash", reference: "REST" });
    s.adjustment(d.id, { kind: "credit", amount: "108.00", reason: "Refund hours", tax_lines_from: [0] });
    ws = sst02(s, taxSettings(s), { period: month });
    assert.deepEqual(ws.items["11d"], { value: 90000, tax: 7200 }, "net of the credit within the same period");
  } finally {
    s.db.close();
  }
});

test("payment basis: an invoice unpaid after 12 months becomes due, and later credits are deductions", () => {
  const s = store();
  try {
    setTax(s, { serviceTaxBasis: "payment", sstPeriodMonths: 1 });
    const c = s.saveClient({ name: "Old" });
    const issued = addMonths(today(), -13);
    const d = invoice(s, c, { issue_date: issued, items: [{ description: "Old work", quantity: "1", rate: "100.00", tax_rate: 6 }] });
    const dueMonth = addDays(addMonths(issued, 12), 1).slice(0, 7);
    const ws = sst02(s, taxSettings(s), { period: dueMonth });
    assert.deepEqual(ws.items["11c"], { value: 10000, tax: 600 });
    assert.ok(ws.warnings.some((w) => /12 months/.test(w)));
    assert.equal(sst02(s, taxSettings(s), { period: issued.slice(0, 7) }).items["11c"].tax, 0);
    s.adjustment(d.id, { kind: "credit", amount: "106.00", reason: "Written back" });
    const now = sst02(s, taxSettings(s), { period: month });
    assert.equal(now.deductions.a, 600);
    assert.ok(now.rows.some((r) => r.item === "13a" && r.kind === "credit after payment"));
  } finally {
    s.db.close();
  }
});

test("foreign-currency documents are reported in MYR at their exchange rate", () => {
  const s = store();
  try {
    setTax(s, { serviceTaxBasis: "invoice", sstPeriodMonths: 1 });
    const c = s.saveClient({ name: "Overseas" });
    invoice(s, c, { items: [{ description: "Consulting", quantity: "1", rate: "100.00", tax_rate: 8 }] });
    // Documents from the documents module may carry currency and fx_rate.
    const original = s.documents.bind(s);
    s.documents = () => original().map((d) => ({ ...d, currency: "USD", fx_rate: "4.5" }));
    const ws = sst02(s, taxSettings(s), { period: month });
    assert.deepEqual(ws.items["11d"], { value: 45000, tax: 3600 });
  } finally {
    s.db.close();
  }
});

test("HTTP: worksheet JSON, CSV and PDF are owner-only and validate the period", async () => {
  const f = await fixture({ settings: { sstNumber: "W10-1808-32000001" } });
  try {
    const c = f.store.saveClient({ name: "=HYPERLINK(evil)" });
    const d = invoice(f.store, c, { items: [{ description: "Goods", quantity: "2", rate: "50.00", tax_rate: 10 }] });
    assert.equal((await f.request("/api/tax/sst02")).status, 401);
    assert.equal((await f.request("/api/tax/sst02.pdf")).status, 401);
    const ws = await f.json(`/api/tax/sst02?period=${month}`);
    assert.equal(ws.items["11b"].tax, 1000);
    const csv = await f.auth(`/api/tax/sst02.csv?period=${month}`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type"), /text\/csv/);
    const body = await csv.text();
    assert.match(body, /not a submission/);
    assert.match(body, /"11\(b\)","Sales tax 10%","100.00","10.00"/);
    assert.match(body, new RegExp(d.number));
    assert.match(body, /"'=HYPERLINK\(evil\)"/, "formula cells are neutralised");
    const pdf = await f.auth(`/api/tax/sst02.pdf?period=${month}`);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
    assert.equal((await f.auth("/api/tax/sst02?period=2026-13")).status, 400);
  } finally {
    await f.close();
  }
});

test("HTTP: tax settings are validated and audited", async () => {
  const f = await fixture();
  try {
    const saved = await f.json("/api/tax/settings", "PUT", { sstPeriodMonths: 2, sstPeriodStart: 3, serviceTaxBasis: "invoice", sstThreshold: "1000000.00", msic: "62010", activity: "Software", state: "14", postcode: "50450", country: "MYS" });
    assert.equal(saved.sstPeriodStart, 3);
    assert.equal(saved.sstThreshold, 100000000);
    for (const bad of [{ sstPeriodMonths: 9 }, { serviceTaxBasis: "cash" }, { msic: "12345" }, { state: "99" }, { country: "ZZZ" }, { postcode: "123" }, { defaultClass: "999" }, { sstThreshold: "5.00" }]) {
      const r = await f.auth("/api/tax/settings", "PUT", bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.ok(f.store.db.prepare("SELECT 1 FROM audit WHERE action='tax.settings.changed'").get());
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.tax.settings.serviceTaxBasis, "invoice");
    assert.equal(ws.ext.tax.periods[0].months, 2);
  } finally {
    await f.close();
  }
});
