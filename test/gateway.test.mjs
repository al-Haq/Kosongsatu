import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import { Gateway, billplzSignature, gatewayConfiguration } from "../server/gateway.mjs";
import { today, addDays } from "../server/domain.mjs";
const config = gatewayConfiguration({
  BILLPLZ_API_KEY: "test-key",
  BILLPLZ_COLLECTION_ID: "col1",
  BILLPLZ_X_SIGNATURE_KEY: "sig-key",
  BILLPLZ_SANDBOX: "true",
});
// A minimal stand-in for the Billplz bills API.
function fakeBillplz() {
  const bills = new Map();
  const calls = [];
  let n = 0;
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.headers.Authorization, "Basic " + Buffer.from("test-key:").toString("base64"));
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith("/bills") && init.method === "POST") {
      const f = Object.fromEntries(new URLSearchParams(init.body));
      const bill = {
        id: "bill" + ++n,
        collection_id: f.collection_id,
        amount: Number(f.amount),
        paid_amount: 0,
        paid: false,
        state: "due",
        url: "https://www.billplz-sandbox.com/bills/bill" + n,
        callback_url: f.callback_url,
        redirect_url: f.redirect_url,
      };
      bills.set(bill.id, bill);
      return json(200, bill);
    }
    const id = url.split("/bills/")[1];
    return bills.has(id) ? json(200, bills.get(id)) : json(404, { error: "not found" });
  };
  const pay = (id) => Object.assign(bills.get(id), { paid: true, state: "paid", paid_amount: bills.get(id).amount, paid_at: today() + "T10:00:00.000+08:00" });
  return { fetcher, bills, calls, pay };
}
function fixture() {
  const s = openDatabase(":memory:");
  s.saveSettings({ registration: "TEST-1", address: "Test office", email: "test@example.com", company: "Test Co" });
  const c = s.saveClient({ name: "Pay client", email: "client@example.com" });
  const d = s.issue(
    s.saveDocument({
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      items: [{ description: "Work", quantity: "1", rate: "250.00" }],
    }).id,
  );
  const { token } = s.share(d.id);
  return { s, c, d, token };
}
const signed = (params) => ({ ...params, x_signature: billplzSignature(params, "sig-key") });
test("configuration needs all Billplz keys and is off without them", () => {
  assert.equal(gatewayConfiguration({}), null);
  assert.throws(() => gatewayConfiguration({ BILLPLZ_API_KEY: "k" }), /COLLECTION_ID/);
  assert.equal(config.base, "https://www.billplz-sandbox.com/api/v3");
});
test("signatures follow the sorted key+value scheme and reject tampering", () => {
  const p = { id: "abc", paid: "true", amount: "25000", collection_id: "col1" };
  const sig = billplzSignature(p, "sig-key");
  assert.equal(billplzSignature({ collection_id: "col1", amount: "25000", paid: "true", id: "abc" }, "sig-key"), sig);
  assert.notEqual(billplzSignature({ ...p, amount: "1" }, "sig-key"), sig);
  const redirect = { "billplz[id]": "abc", "billplz[paid]": "true" };
  assert.equal(billplzSignature(redirect, "k"), billplzSignature({ billplzid: "abc", billplzpaid: "true" }, "k"));
});
test("checkout creates one bill for the balance and reuses it", async () => {
  const { s, d, token } = fixture();
  try {
    const fake = fakeBillplz();
    const g = new Gateway(s, { config, fetcher: fake.fetcher });
    const a = await g.checkout(token, "https://app.example");
    const b = await g.checkout(token, "https://app.example");
    assert.equal(a.url, b.url);
    assert.equal(fake.bills.size, 1);
    const bill = [...fake.bills.values()][0];
    assert.equal(bill.amount, d.balance);
    assert.equal(bill.callback_url, "https://app.example/api/payments/billplz/callback");
    assert.equal(bill.redirect_url, "https://app.example/client/" + token);
    const off = new Gateway(s, { config: null });
    await assert.rejects(off.checkout(token, "https://app.example"), (e) => e.status === 503);
  } finally {
    s.db.close();
  }
});
test("a paid bill records one receipt, settles the invoice and ignores repeats", async () => {
  const { s, d, token } = fixture();
  try {
    const fake = fakeBillplz();
    const g = new Gateway(s, { config, fetcher: fake.fetcher });
    await g.checkout(token, "https://app.example");
    assert.equal((await g.settle("bill1")).state, "pending", "unpaid bills stay pending");
    fake.pay("bill1");
    assert.equal((await g.settle("bill1")).state, "paid");
    assert.equal((await g.settle("bill1")).state, "paid");
    const doc = s.document(d.id);
    assert.equal(doc.balance, 0);
    assert.equal(doc.payments.length, 1);
    assert.equal(s.receipts().filter((r) => r.reference === "Billplz bill1").length, 1);
    await assert.rejects(g.checkout(token, "https://app.example"), /not awaiting payment/);
  } finally {
    s.db.close();
  }
});
test("a mismatched amount is refused and money paid after a manual payment stays as customer funds", async () => {
  const { s, d, token } = fixture();
  try {
    const fake = fakeBillplz();
    const g = new Gateway(s, { config, fetcher: fake.fetcher });
    await g.checkout(token, "https://app.example");
    fake.pay("bill1");
    fake.bills.get("bill1").paid_amount = 100;
    await assert.rejects(g.settle("bill1"), (e) => e.status === 502);
    assert.equal(s.document(d.id).payments.length, 0);
    fake.bills.get("bill1").paid_amount = 25000;
    s.recordPayment(d.id, { amount: "250.00", paid_date: today(), method: "Bank transfer", reference: "MANUAL-1" });
    assert.equal((await g.settle("bill1")).state, "paid");
    const r = s.receipts().find((x) => x.reference === "Billplz bill1");
    assert.equal(r.allocated, 0);
    assert.equal(s.document(d.id).payments.length, 1);
  } finally {
    s.db.close();
  }
});
test("HTTP callback and browser return need a valid signature", async () => {
  const { s, d, token } = fixture();
  const fake = fakeBillplz();
  const server = createApp({ store: s, appUrl: "http://localhost", gatewayConfig: config, gatewayFetch: fake.fetcher });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const origin = { Origin: "http://localhost", "Content-Type": "application/json" };
  try {
    const page = await (await fetch(base + "/api/public/" + token)).json();
    assert.equal(page.online_payment, true);
    const checkout = await fetch(base + `/api/public/${token}/checkout`, { method: "POST", headers: origin, body: "{}" });
    assert.match((await checkout.json()).url, /^https:\/\//);
    const callback = (params) =>
      fetch(base + "/api/payments/billplz/callback", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params).toString(),
      });
    fake.pay("bill1");
    const forged = { id: "bill1", paid: "true", x_signature: "0".repeat(64) };
    assert.equal((await callback(forged)).status, 403);
    assert.equal(s.document(d.id).balance, 25000);
    const ret = await fetch(base + `/api/public/${token}/payment-return`, {
      method: "POST",
      headers: origin,
      body: JSON.stringify({
        params: (({ x_signature, ...p }) => ({ ...p, "billplz[x_signature]": x_signature }))(
          signed({ "billplz[id]": "bill1", "billplz[paid]": "true" }),
        ),
      }),
    });
    assert.deepEqual(await ret.json(), { state: "paid" });
    assert.equal(s.document(d.id).balance, 0);
    const ok = await callback(signed({ id: "bill1", collection_id: "col1", paid: "true", state: "paid", amount: "25000" }));
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "OK");
    assert.equal(s.document(d.id).payments.length, 1);
  } finally {
    await new Promise((r) => server.close(r));
    s.db.close();
  }
});
