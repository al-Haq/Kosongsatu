import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { renderAdjustmentPdf } from "../server/pdf.mjs";
import { noteTaxLines, splitProportional } from "../server/tax-sst.mjs";
import { today } from "../server/domain.mjs";
import { fixture } from "./helpers.mjs";
import { MIXED, invoice } from "./tax-helpers.mjs";

function store() {
  const s = openDatabase(":memory:");
  s.saveSettings({ registration: "TEST-1", address: "Office", email: "t@example.com", sstNumber: "W10-1808-32000001" });
  return s;
}
const sum = (rows) => rows.reduce((t, r) => t + r.taxable + r.tax, 0);

test("splitting never loses a sen, even for debits larger than the invoice", () => {
  assert.deepEqual(splitProportional(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(splitProportional(500, [100]), [500]);
  assert.equal(splitProportional(999999, [3, 7, 11]).reduce((a, b) => a + b, 0), 999999);
  assert.deepEqual(splitProportional(7, [0, 0]), [7, 0]);
});

test("a credit note on a mixed-rate, discounted invoice carries its own SST split", () => {
  const s = store();
  try {
    const c = s.saveClient({ name: "Mixed" });
    const d = invoice(s, c, { discount: "175.00" });
    assert.equal(d.total, 169200);
    const a = s.adjustment(d.id, { kind: "credit", amount: "100.00", reason: "Goodwill" });
    const rows = JSON.parse(a.tax_lines);
    assert.deepEqual(rows, [
      { rate: 0, taxable: 1330, tax: 0 },
      { rate: 8, taxable: 5319, tax: 426 },
      { rate: 10, taxable: 2659, tax: 266 },
    ]);
    assert.equal(sum(rows), 10000, "split adds up to the note amount");
    // A full credit gives back exactly the invoice's SST at each rate.
    const full = noteTaxLines(d, d.total);
    assert.deepEqual(full.map((r) => [r.rate, r.taxable, r.tax]), [[0, 22500, 0], [8, 90000, 7200], [10, 45000, 4500]]);
    // The ledger is unchanged: adjusted total = total - credit.
    const after = s.document(d.id);
    assert.equal(after.adjusted_total, 169200 - 10000);
    assert.equal(after.adjustments[0].tax_from_lines, "");
  } finally {
    s.db.close();
  }
});

test("notes can be split by chosen lines, and a credit cannot exceed those lines", () => {
  const s = store();
  try {
    const c = s.saveClient({ name: "Lines" });
    const d = invoice(s, c);
    assert.throws(() => s.adjustment(d.id, { kind: "credit", amount: "300.00", reason: "Too much", tax_lines_from: [2] }), /larger than the chosen lines/);
    assert.throws(() => s.adjustment(d.id, { kind: "credit", amount: "1.00", reason: "x", tax_lines_from: [7] }), /lines from this invoice/);
    const a = s.adjustment(d.id, { kind: "credit", amount: "550.00", reason: "Goods returned", tax_lines_from: [1] });
    assert.deepEqual(JSON.parse(a.tax_lines), [{ rate: 10, taxable: 50000, tax: 5000 }]);
    assert.equal(a.tax_from_lines, "2");
    const debit = s.adjustment(d.id, { kind: "debit", amount: "2000.00", reason: "Extra hours", tax_lines_from: ["0"] });
    assert.deepEqual(JSON.parse(debit.tax_lines), [{ rate: 8, taxable: 185185, tax: 14815 }]);
    const after = s.document(d.id);
    assert.equal(after.adjusted_total, d.total - 55000 + 200000);
  } finally {
    s.db.close();
  }
});

test("a credit on a paid invoice still releases the excess allocation and keeps the split", () => {
  const s = store();
  try {
    const c = s.saveClient({ name: "Paid" });
    const d = invoice(s, c);
    s.recordPayment(d.id, { amount: (d.total / 100).toFixed(2), paid_date: today(), method: "Cash", reference: "PAID-1" });
    const a = s.adjustment(d.id, { kind: "credit", amount: "108.00", reason: "Over-billed", tax_lines_from: [0] });
    assert.deepEqual(JSON.parse(a.tax_lines), [{ rate: 8, taxable: 10000, tax: 800 }]);
    const after = s.document(d.id);
    assert.equal(after.paid, after.adjusted_total);
    assert.equal(after.balance, 0);
    assert.equal(s.receipts()[0].available, 10800, "released cash is available to the customer");
  } finally {
    s.db.close();
  }
});

test("the SST summary nets credit notes and adds debit notes by rate", () => {
  const s = store();
  try {
    const c = s.saveClient({ name: "Report", tin: "C1234567890" });
    const d = invoice(s, c);
    s.adjustment(d.id, { kind: "credit", amount: "108.00", reason: "Less service", tax_lines_from: [0] });
    s.adjustment(d.id, { kind: "debit", amount: "55.00", reason: "More goods", tax_lines_from: [1] });
    const r = s.sstReport({});
    assert.deepEqual(r.rates.map((x) => [x.rate, x.taxable, x.tax]), [[0, 25000, 0], [8, 90000, 7200], [10, 55000, 5500]]);
    assert.equal(r.tax, 12700);
    assert.equal(r.notes.length, 0, "notes with a split are no longer listed for manual review");
    assert.ok(r.rows.some((x) => x.note === "credit" && x.tax === -800));
  } finally {
    s.db.close();
  }
});

test("the note PDF shows SST by rate", async () => {
  const s = store();
  try {
    const c = s.saveClient({ name: "PDF" });
    const d = invoice(s, c);
    const a = s.adjustment(d.id, { kind: "credit", amount: "100.00", reason: "Goodwill" });
    const row = s.db.prepare("SELECT * FROM adjustments WHERE id=?").get(a.id);
    const pdf = await renderAdjustmentPdf(s.document(d.id), row, [{ heading: "Extra", text: "Block text", footer: "Validated MyInvois e-Invoice TEST" }]);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.length > 3000);
  } finally {
    s.db.close();
  }
});

test("HTTP: notes accept chosen lines, and the note PDF route works", async () => {
  const f = await fixture({ settings: { sstNumber: "W10-1808-32000001" } });
  try {
    const c = f.store.saveClient({ name: "Route" });
    const d = invoice(f.store, c, { items: MIXED });
    const a = await f.json(`/api/documents/${d.id}/adjustments`, "POST", { kind: "credit", amount: "54.00", reason: "Partial", issue_date: today(), tax_lines_from: [0] });
    assert.deepEqual(JSON.parse(a.tax_lines), [{ rate: 8, taxable: 5000, tax: 400 }]);
    const bad = await f.auth(`/api/documents/${d.id}/adjustments`, "POST", { kind: "credit", amount: "54.00", reason: "x", tax_lines_from: "a,b" });
    assert.equal(bad.status, 400);
    const pdf = await f.auth(`/api/adjustments/${a.id}/pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal((await f.request(`/api/adjustments/${a.id}/pdf`)).status, 401);
    const ws = await f.json("/api/workspace");
    assert.equal(JSON.parse(ws.finance.adjustments[0].tax_lines)[0].tax, 400);
  } finally {
    await f.close();
  }
});
