import test from "node:test";
import assert from "node:assert/strict";
import { renderPdf } from "../server/pdf.mjs";
const fixture = () => ({
  kind: "invoice",
  number: "INV-2026-0001",
  status: "Part-paid",
  business: { company: "Nawlogic Systems Solution" },
  client: { name: "Pelanggan Café" },
  issue_date: "2026-10-15",
  due_date: "2026-10-29",
  items: [
    {
      description: "Integrasi sistem",
      quantity: 1,
      rate: 500000,
      amount: 500000,
    },
  ],
  subtotal: 500000,
  discount: 0,
  total: 500000,
  paid: 200000,
  balance: 300000,
  terms: "Payment within 14 days.",
  notes: "",
});
const pageCount = (b) =>
  (b.toString("latin1").match(/\/Type \/Page\b/g) || []).length;
test("invoice PDF keeps the footer on its single content page", async () => {
  const pdf = await renderPdf(fixture());
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.equal(pageCount(pdf), 1);
});
test("receipt PDF is a single branded page", async () => {
  const pdf = await renderPdf(fixture(), {
    id: "abcd1234",
    paid_date: "2026-10-15",
    method: "Bank transfer",
    reference: "TX-1",
    amount: 200000,
  });
  assert.equal(pageCount(pdf), 1);
});
test("long invoice paginates without one extra page per footer", async () => {
  const d = fixture();
  d.items = Array.from({ length: 50 }, (_, i) => ({
    description: `Item ${i + 1} - System integration and documented handover with a clear implementation scope.`,
    quantity: 1,
    rate: 1000,
    amount: 1000,
  }));
  d.total = d.subtotal = 50000;
  d.paid = 0;
  d.balance = 50000;
  const pdf = await renderPdf(d);
  assert.ok(pageCount(pdf) >= 3);
  assert.ok(pageCount(pdf) <= 8);
});
