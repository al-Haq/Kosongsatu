import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { today, addDays } from "../server/domain.mjs";
import { packData } from "../server/recurring-pack.mjs";
import { fixture, PNG_1PX, password } from "./helpers.mjs";
function workspace() {
  const s = openDatabase(":memory:");
  s.saveSettings({ registration: "R", address: "A", email: "a@example.com" });
  return s;
}
const usdInvoice = (s, c) =>
  s.issue(
    s.saveDocument({
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      currency: "USD",
      fx_rate: "4.5",
      items: [{ description: "Work", quantity: 1, rate: "100.00" }],
    }).id,
  );

test("foreign-currency invoices and receipts are reported in MYR by the accountant pack and the portal", () => {
  const s = workspace();
  try {
    const c = s.saveClient({ name: "US client", email: "us@example.com" });
    const d = usdInvoice(s, c);
    assert.equal(d.currency, "USD");
    s.receive({
      client_id: c.id,
      amount: "100.00",
      paid_date: today(),
      method: "Bank transfer",
      reference: "USD-1",
      currency: "USD",
      fx_rate: "4.5",
      allocations: [{ invoice_id: d.id, amount: "40.00" }],
    });
    const p = packData(s, today().slice(0, 7));
    const inv = p.invoices.find((i) => i.number === d.number);
    assert.deepEqual([inv.currency, inv.total], ["USD", 45000], "USD 100 at 4.5 is RM 450");
    assert.equal(p.receipts[0].amount, 45000);
    assert.equal(p.totals.received, 45000);
    assert.equal(p.totals.outstanding, 27000, "USD 60 still due");
    const o = s.portalOverview(c.id);
    assert.equal(o.totals.outstanding, 27000);
    assert.equal(o.totals.credit_available, 27000, "USD 60 unallocated");
    assert.equal(o.receipts[0].currency, "USD");
  } finally {
    s.db.close();
  }
});

test("webhook receipt payloads carry the receipt's currency and rate", async () => {
  const f = await fixture();
  try {
    const svc = f.server.ctx.services.webhooks;
    const calls = [];
    svc.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    svc.send = async (req) => (calls.push(req), { status: 200, body: "ok" });
    const res = await f.auth("/api/platform/webhooks", "POST", { url: "https://hooks.example.com/in", events: ["payment.received"], description: "test", password });
    assert.equal(res.status, 201);
    const c = f.store.saveClient({ name: "US client", email: "us@example.com" });
    const d = usdInvoice(f.store, c);
    f.store.receive({ client_id: c.id, amount: "100.00", paid_date: today(), method: "Bank transfer", reference: "USD-2", currency: "USD", fx_rate: "4.5", allocations: [{ invoice_id: d.id, amount: "100.00" }] });
    svc.collect();
    await svc.deliverDue();
    const paid = calls.map((x) => JSON.parse(x.body)).find((e) => e.type === "payment.received");
    assert.ok(paid, "payment.received delivered");
    assert.deepEqual([paid.data.currency, paid.data.fx_rate, paid.data.amount], ["USD", "4.5", 10000]);
  } finally {
    await f.close();
  }
});

test("issued documents keep the logo they were issued with, even when that is none", () => {
  const s = workspace();
  try {
    const c = s.saveClient({ name: "Logo client" });
    const draft = (kind = "invoice") =>
      s.saveDocument({ kind, client_id: c.id, issue_date: today(), due_date: addDays(today(), 14), items: [{ description: "Work", quantity: 1, rate: "10.00" }] });
    const before = s.issue(draft().id);
    const open = draft();
    assert.equal(s.logoFor(before.business), null);
    s.setLogo({ name: "logo.png", data: PNG_1PX });
    assert.equal(s.logoFor(s.document(before.id).business), null, "issued before the logo: unchanged");
    assert.ok(s.logoFor(s.document(open.id).business), "drafts show the current logo");
    const after = s.issue(draft().id);
    assert.ok(s.logoFor(s.document(after.id).business), "issued after the logo: keeps it");
    assert.equal(JSON.stringify(s.document(before.id).business).includes("frozen"), false, "the marker is never serialised");
  } finally {
    s.db.close();
  }
});
