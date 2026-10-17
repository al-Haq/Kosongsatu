import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { fixture, issuedInvoice, password } from "./helpers.mjs";
import { ipay88Signature } from "../server/payments-ipay88.mjs";
import { verifyStripeWebhook } from "../server/payments-stripe.mjs";
import { Gateway } from "../server/gateway.mjs";
import { openDatabase } from "../server/db.mjs";

const reply = (status, body) => ({
  ok: status < 400,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});
const form = (init) => Object.fromEntries(new URLSearchParams(init.body || ""));
// One fake for every provider's HTTP API.
function fakeProviders() {
  const calls = [];
  const toyyib = new Map(),
    stripe = new Map(),
    ipay = new Map(),
    billplz = new Map();
  let n = 0;
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.host === "dev.toyyibpay.com") {
      const f = form(init);
      if (u.pathname.endsWith("/createBill")) {
        const code = "tb" + ++n + "abcd";
        toyyib.set(code, { f, tx: [] });
        return reply(200, [{ BillCode: code }]);
      }
      if (u.pathname.endsWith("/getBillTransactions")) {
        const b = toyyib.get(f.billCode);
        return reply(200, b ? b.tx : []);
      }
      if (u.pathname.endsWith("/getCategoryDetails"))
        return f.userSecretKey === "toyyib-secret" ? reply(200, [{ categoryName: "Invoices", categoryStatus: "1" }]) : reply(200, "[KEY-DID-NOT-EXIST]");
      if (u.pathname.endsWith("/inactiveBill")) return reply(200, [{ status: "success" }]);
    }
    if (u.host === "api.stripe.com") {
      assert.equal(init.headers.Authorization, "Bearer sk_test_abcdefgh123");
      if (u.pathname === "/v1/checkout/sessions" && init.method === "POST") {
        const f = form(init);
        const id = "cs_test_session" + ++n;
        const s = {
          id,
          object: "checkout.session",
          mode: f.mode,
          url: "https://checkout.stripe.com/c/pay/" + id,
          amount_total: Number(f["line_items[0][price_data][unit_amount]"]),
          currency: f["line_items[0][price_data][currency]"],
          client_reference_id: f.client_reference_id,
          status: "open",
          payment_status: "unpaid",
          payment_intent: null,
          form: f,
          idempotency: init.headers["Idempotency-Key"],
        };
        stripe.set(id, s);
        return reply(200, s);
      }
      if (u.pathname === "/v1/checkout/sessions") return reply(200, { object: "list", data: [] });
      const m = u.pathname.match(/^\/v1\/checkout\/sessions\/([\w]+)(\/expire)?$/);
      if (m && stripe.has(m[1])) {
        if (m[2]) stripe.get(m[1]).status = "expired";
        return reply(200, stripe.get(m[1]));
      }
      return reply(404, { error: { message: "No such checkout session" } });
    }
    if (u.host === "sandbox.ipay88.com.my" && u.pathname === "/ePayment/enquiry.asp") {
      const p = ipay.get(u.searchParams.get("RefNo"));
      if (!p) return reply(200, "Record not found");
      if (p.amount !== u.searchParams.get("Amount")) return reply(200, "Incorrect amount");
      return reply(200, p.paid ? "00" : "Payment Pending");
    }
    if (u.host === "www.billplz-sandbox.com") {
      const auth = "Basic " + Buffer.from("bp-key:").toString("base64");
      if (init.headers.Authorization !== auth) return reply(401, { error: { type: "Unauthorized" } });
      if (u.pathname === "/api/v3/collections/col-9") return reply(200, { id: "col-9", title: "Invoices" });
      if (u.pathname === "/api/v3/bills" && init.method === "POST") {
        const f = form(init);
        const bill = { id: "bp" + ++n, collection_id: f.collection_id, amount: Number(f.amount), paid: false, state: "due", url: "https://www.billplz-sandbox.com/bills/bp" + n };
        billplz.set(bill.id, bill);
        return reply(200, bill);
      }
    }
    return reply(404, { error: "not found" });
  };
  return { fetcher, calls, toyyib, stripe, ipay, billplz };
}
async function setup(secrets = {}) {
  const fake = fakeProviders();
  const f = await fixture({ app: { gatewayFetch: fake.fetcher } });
  for (const [k, v] of Object.entries(secrets)) f.store.setSecret(k, v);
  const { client, invoice } = issuedInvoice(f.store, { rate: "250.00" });
  const { token } = f.store.share(invoice.id);
  const pub = (path, body, headers = {}) =>
    f.request(`/api/public/${token}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  const hook = (provider, body, headers = {}) =>
    fetch(f.base + "/api/hooks/payments/" + provider, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: typeof body === "string" ? body : new URLSearchParams(body).toString(),
    });
  return { ...f, fake, client, invoice, token, pub, hook };
}
const TOYYIB = { TOYYIBPAY_SECRET_KEY: "toyyib-secret", TOYYIBPAY_CATEGORY_CODE: "cat123", TOYYIBPAY_SANDBOX: "true" };
const STRIPE = { STRIPE_SECRET_KEY: "sk_test_abcdefgh123", STRIPE_WEBHOOK_SECRET: "whsec_testsecret123" };
const IPAY = { IPAY88_MERCHANT_CODE: "M01234", IPAY88_MERCHANT_KEY: "ipay-key", IPAY88_SANDBOX: "true" };
const receiptsFor = (f, prefix) => f.store.receipts().filter((r) => r.reference.startsWith(prefix));

test("gateway keys saved in Settings take effect at once, need the password, and can be tested", async () => {
  const f = await setup();
  try {
    let ws = await f.json("/api/workspace");
    assert.equal(ws.gateway.configured, false);
    assert.equal((await (await f.pub("")).json()).online_payment, false);
    const values = { BILLPLZ_API_KEY: "bp-key", BILLPLZ_COLLECTION_ID: "col-9", BILLPLZ_X_SIGNATURE_KEY: "sig" };
    const bad = await f.auth("/api/payments/providers/billplz", "PUT", { values, sandbox: true, password: "wrong" });
    assert.equal(bad.status, 403);
    const saved = await f.json("/api/payments/providers/billplz", "PUT", { values, sandbox: true, password });
    assert.equal(saved.provider, "billplz");
    assert.equal(saved.sandbox, true);
    const raw = f.store.db.prepare("SELECT value FROM secrets WHERE name='BILLPLZ_API_KEY'").get().value;
    assert.ok(!Buffer.from(raw, "base64").toString().includes("bp-key"), "stored encrypted");
    ws = await f.json("/api/workspace");
    assert.equal(ws.gateway.configured, true);
    assert.ok(!JSON.stringify(ws).includes("bp-key"), "key values never reach the browser");
    const page = await (await f.pub("")).json();
    assert.equal(page.online_payment, true);
    assert.match(page.online_methods, /FPX/);
    const ok = await f.json("/api/payments/providers/billplz/test", "POST", {});
    assert.equal(ok.ok, true);
    assert.match(ok.message, /Invoices/);
    // A wrong key fails the test without throwing.
    await f.json("/api/payments/providers/billplz", "PUT", { values: { BILLPLZ_API_KEY: "other" }, password });
    const failed = await f.json("/api/payments/providers/billplz/test", "POST", {});
    assert.equal(failed.ok, false);
    const checkout = await f.pub("/checkout", {});
    assert.equal(checkout.status, 502, "the new key is used without a restart");
    await f.json("/api/payments/providers/billplz", "PUT", { values: { BILLPLZ_API_KEY: null }, password });
    assert.equal((await f.json("/api/workspace")).gateway.configured, false);
    assert.equal((await f.auth("/api/payments/providers/billplz/test", "POST", {})).status, 409);
  } finally {
    await f.close();
  }
});

test("the owner chooses the active provider; unconfigured providers cannot be chosen", async () => {
  const f = await setup(TOYYIB);
  try {
    assert.equal((await f.json("/api/workspace")).gateway.provider, "toyyibpay", "first configured provider by default");
    assert.equal((await f.auth("/api/payments/provider", "PUT", { provider: "stripe" })).status, 409);
    for (const [k, v] of Object.entries(STRIPE)) f.store.setSecret(k, v);
    assert.equal((await f.json("/api/payments/provider", "PUT", { provider: "stripe" })).provider, "stripe");
    assert.equal((await (await f.pub("")).json()).online_methods, "card or online banking (FPX)");
    assert.equal((await f.json("/api/payments/provider", "PUT", { provider: "off" })).configured, false);
    assert.equal((await (await f.pub("")).json()).online_payment, false);
    assert.equal((await f.pub("/checkout", {})).status, 503);
    assert.equal((await f.auth("/api/payments/provider", "PUT", { provider: "paypal" })).status, 400);
    assert.equal((await f.auth("/api/payments/provider", "PUT", { provider: "constructor" })).status, 400);
    assert.equal((await f.auth("/api/payments/providers/constructor/test", "POST", {})).status, 404);
    assert.equal((await f.pub("/payment-return", { provider: "toString" })).status, 400);
    assert.ok(f.store.db.prepare("SELECT 1 FROM audit WHERE action='payments.provider.changed'").get());
  } finally {
    await f.close();
  }
});

test("ToyyibPay: bill for the balance, hash-checked callback, re-confirmed amount, one receipt", async () => {
  const f = await setup(TOYYIB);
  try {
    const { url } = await (await f.pub("/checkout", {})).json();
    const [code, bill] = [...f.fake.toyyib][0];
    assert.equal(url, "https://dev.toyyibpay.com/" + code);
    assert.equal(bill.f.billAmount, "25000", "amount in sen");
    assert.equal(bill.f.billPriceSetting, "1");
    assert.equal(bill.f.billCallbackUrl, "http://localhost/api/hooks/payments/toyyibpay");
    assert.match(bill.f.billName, /^Invoice INV_\d{4}_\d{4}$/);
    assert.equal((await (await f.pub("/checkout", {})).json()).url, url, "reused while pending");
    const ref = bill.f.billExternalReferenceNo;
    const signed = (p) => ({ ...p, hash: createHash("md5").update(`toyyib-secret${p.status}${p.order_id}${p.refno}ok`).digest("hex") });
    const notice = { refno: "TP123", status: "1", reason: "Approved", billcode: code, order_id: ref, amount: "250.00" };
    assert.equal((await f.hook("toyyibpay", { ...notice, hash: "0".repeat(32) })).status, 403, "forged hash");
    // Signed, but the provider has no payment yet: nothing is recorded.
    assert.equal((await f.hook("toyyibpay", signed(notice))).status, 200);
    assert.equal(receiptsFor(f, "ToyyibPay").length, 0);
    // The provider reports a different amount: refused and logged.
    bill.tx = [{ billpaymentStatus: "1", billpaymentAmount: "200.00", billpaymentInvoiceNo: "TP123", billExternalReferenceNo: ref, billPaymentDate: "17-10-2026 10:00:00" }];
    assert.equal((await f.hook("toyyibpay", signed(notice))).status, 502);
    assert.equal(receiptsFor(f, "ToyyibPay").length, 0);
    assert.ok(f.store.db.prepare("SELECT 1 FROM audit WHERE action='online_payment.mismatch'").get());
    bill.tx[0].billpaymentAmount = "250.00";
    assert.equal((await f.hook("toyyibpay", signed(notice))).status, 200);
    assert.equal((await f.hook("toyyibpay", signed(notice))).status, 200, "replay is harmless");
    const r = receiptsFor(f, "ToyyibPay");
    assert.equal(r.length, 1);
    assert.equal(r[0].allocated, 25000);
    assert.equal(f.store.document(f.invoice.id).status, "Paid");
    assert.deepEqual(await (await f.pub("/payment-return", { provider: "toyyibpay", reference: code })).json(), { state: "paid" });
    // A signed notice for someone else's bill is acknowledged and ignored.
    assert.equal((await f.hook("toyyibpay", signed({ ...notice, billcode: "other123" }))).status, 200);
    const t = await f.json("/api/payments/providers/toyyibpay/test", "POST", {});
    assert.equal(t.ok, true);
  } finally {
    await f.close();
  }
});

test("Stripe: Checkout Session in MYR with card and FPX; signed webhook; replays and mismatches", async () => {
  const f = await setup(STRIPE);
  try {
    const { url } = await (await f.pub("/checkout", {})).json();
    const [id, s] = [...f.fake.stripe][0];
    assert.equal(url, "https://checkout.stripe.com/c/pay/" + id);
    assert.equal(s.currency, "myr");
    assert.equal(s.amount_total, 25000);
    assert.equal(s.form["payment_method_types[0]"], "card");
    assert.equal(s.form["payment_method_types[1]"], "fpx");
    assert.match(s.form.success_url, /session_id=\{CHECKOUT_SESSION_ID\}$/);
    assert.ok(s.idempotency, "idempotency key sent");
    const event = (type = "checkout.session.completed", t = Math.floor(Date.now() / 1000)) => {
      const body = JSON.stringify({ id: "evt_1", type, created: t, data: { object: { id } } });
      const sig = createHmac("sha256", "whsec_testsecret123").update(`${t}.${body}`).digest("hex");
      return { body, header: `t=${t},v1=${sig}` };
    };
    const send = (e, header = e.header) =>
      fetch(f.base + "/api/hooks/payments/stripe", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": header }, body: e.body });
    const e1 = event();
    assert.equal((await send(e1, e1.header.replace(/v1=(.)/, (m, c) => "v1=" + (c === "0" ? "1" : "0")))).status, 403, "forged signature");
    assert.equal((await send(e1, "")).status, 400);
    const old = event("checkout.session.completed", Math.floor(Date.now() / 1000) - 3600);
    assert.equal((await send(old)).status, 403, "old events are refused as replays");
    assert.equal((await send(e1)).status, 200);
    assert.equal(receiptsFor(f, "Stripe").length, 0, "unpaid session records nothing");
    Object.assign(s, { status: "complete", payment_status: "paid", payment_intent: "pi_123", amount_total: 100 });
    assert.equal((await send(event())).status, 502, "amount mismatch refused");
    assert.equal(receiptsFor(f, "Stripe").length, 0);
    s.amount_total = 25000;
    // Settled another way meanwhile: the money stays as customer funds.
    f.store.recordPayment(f.invoice.id, { amount: "100.00", paid_date: f.store.workspace().today, method: "Bank transfer", reference: "PART-1" });
    const e2 = event();
    assert.equal((await send(e2)).status, 200);
    assert.equal((await send(e2)).status, 200, "same event again");
    const r = receiptsFor(f, "Stripe");
    assert.equal(r.length, 1);
    assert.equal(r[0].allocated, 15000);
    assert.equal(r[0].available, 10000);
    assert.equal(f.store.document(f.invoice.id).balance, 0);
    assert.equal(f.store.db.prepare("SELECT provider_ref FROM online_payments WHERE bill_id=?").get(id).provider_ref, "pi_123");
    assert.deepEqual(await (await f.pub("/payment-return", { provider: "stripe", reference: id })).json(), { state: "paid" });
    assert.equal((await f.pub("/payment-return", { provider: "stripe", reference: "cs_test_unknown" })).status, 404);
  } finally {
    await f.close();
  }
});

test("Stripe needs at least RM 2.00 and expires an older session when the balance changes", async () => {
  const f = await setup(STRIPE);
  try {
    await f.pub("/checkout", {});
    f.store.adjustment(f.invoice.id, { kind: "credit", amount: "50.00", reason: "Discount", issue_date: f.store.workspace().today });
    await f.pub("/checkout", {});
    const sessions = [...f.fake.stripe.values()];
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].status, "expired");
    assert.equal(sessions[1].amount_total, 20000);
    const { invoice } = issuedInvoice(f.store, { rate: "1.50" });
    const small = f.store.share(invoice.id).token;
    assert.equal((await (await f.request("/api/public/" + small)).json()).online_payment, false);
    const res = await f.request(`/api/public/${small}/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 409);
  } finally {
    await f.close();
  }
});

test("iPay88: signed form page, HMAC-SHA512 backend post, re-query before recording", async () => {
  const f = await setup(IPAY);
  try {
    const { url } = await (await f.pub("/checkout", {})).json();
    assert.match(url, /^http:\/\/localhost\/api\/guest\/payments\/ipay88\/[\w-]{36}\?t=/);
    const page = await f.request(new URL(url).pathname + new URL(url).search);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /script-src 'sha256-/);
    assert.equal(page.headers.get("referrer-policy"), "origin");
    const html = await page.text();
    const field = (n) => html.match(new RegExp(`name="${n}" value="([^"]*)"`))[1];
    const refNo = field("RefNo");
    assert.equal(field("Amount"), "250.00");
    assert.equal(field("SignatureType"), "HMACSHA512");
    assert.equal(field("Signature"), ipay88Signature("ipay-key", ["M01234", refNo, "25000", "MYR"]));
    assert.match(html, /action="https:\/\/sandbox\.ipay88\.com\.my\/ePayment\/entry\.asp"/);
    assert.equal((await f.request(new URL(url).pathname + "?t=" + "x".repeat(43))).status, 404, "token checked");
    const post = (status = "1", amount = "250.00", sig) => {
      const p = { MerchantCode: "M01234", PaymentId: "2", RefNo: refNo, Amount: amount, Currency: "MYR", Status: status, TransId: "T0001", ErrDesc: "" };
      p.Signature = sig || ipay88Signature("ipay-key", ["M01234", "2", refNo, amount.replace(/[.,]/g, ""), "MYR", status]);
      return p;
    };
    assert.equal((await f.hook("ipay88", post("1", "250.00", "ab".repeat(64)))).status, 403, "forged signature");
    f.fake.ipay.set(refNo, { amount: "250.00", paid: false });
    const pending = await f.hook("ipay88", post());
    assert.equal(pending.status, 503, "not recorded until the re-query says paid");
    assert.equal(receiptsFor(f, "iPay88").length, 0);
    const wrong = await f.hook("ipay88", post("1", "25.00"));
    assert.equal(await wrong.text(), "RECEIVEOK");
    assert.equal(receiptsFor(f, "iPay88").length, 0, "posted amount mismatch is not recorded");
    f.fake.ipay.get(refNo).paid = true;
    const ok = await f.hook("ipay88", post());
    assert.equal(await ok.text(), "RECEIVEOK");
    assert.equal(await (await f.hook("ipay88", post())).text(), "RECEIVEOK", "replay");
    assert.equal(receiptsFor(f, "iPay88").length, 1);
    assert.equal(f.store.document(f.invoice.id).status, "Paid");
    const back = await f.hook("ipay88/return/" + f.token, post());
    assert.equal(back.status, 303);
    assert.equal(back.headers.get("location"), `/client/${f.token}?payment=ipay88&result=paid`);
    const forgedBack = await f.hook("ipay88/return/" + f.token, post("1", "250.00", "00"));
    assert.equal(forgedBack.headers.get("location"), `/client/${f.token}?payment=ipay88&result=error`);
    assert.deepEqual(await (await f.pub("/payment-return", { provider: "ipay88" })).json(), { state: "paid" });
  } finally {
    await f.close();
  }
});

test("the re-check job confirms a payment whose callback never arrived", async () => {
  const f = await setup(STRIPE);
  try {
    await f.pub("/checkout", {});
    const s = [...f.fake.stripe.values()][0];
    Object.assign(s, { status: "complete", payment_status: "paid" });
    const result = await f.server.runJob("payments:recheck");
    assert.deepEqual(result, { checked: 1, paid: 1 });
    assert.equal(f.store.document(f.invoice.id).status, "Paid");
    assert.deepEqual(await f.server.runJob("payments:recheck"), { checked: 0, paid: 0 });
  } finally {
    await f.close();
  }
});

test("Stripe webhook signatures follow the t.v1 scheme with a 5-minute tolerance", () => {
  const body = '{"type":"x"}',
    t = 1700000000;
  const sig = createHmac("sha256", "whsec_k").update(`${t}.${body}`).digest("hex");
  assert.equal(verifyStripeWebhook(body, `t=${t},v1=${sig}`, "whsec_k", t + 10).type, "x");
  assert.equal(verifyStripeWebhook(body, `t=${t},v1=${"1".repeat(64)},v1=${sig}`, "whsec_k", t).type, "x", "any v1 may match");
  assert.throws(() => verifyStripeWebhook(body, `t=${t},v1=${sig}`, "whsec_k", t + 301), /replay/);
  assert.throws(() => verifyStripeWebhook(body + " ", `t=${t},v1=${sig}`, "whsec_k", t), /signature/);
});

test("server environment keys win over Settings and incomplete keys stay off", () => {
  const s = openDatabase(":memory:");
  try {
    s.setSecret("STRIPE_SECRET_KEY", "sk_test_fromsettings1");
    let g = new Gateway(s, { env: {} });
    assert.equal(g.status().configured, false);
    assert.deepEqual(g.status().providers.find((p) => p.name === "stripe").missing, ["STRIPE_WEBHOOK_SECRET"]);
    g = new Gateway(s, { env: { STRIPE_WEBHOOK_SECRET: "whsec_fromserver1", PAYMENT_PROVIDER: "stripe" } });
    assert.equal(g.status().provider, "stripe");
    assert.equal(g.status().choiceFromServer, true);
    assert.equal(g.providerConfig("stripe").config.webhookSecret, "whsec_fromserver1");
    s.setSecret("STRIPE_SECRET_KEY", "not-a-key");
    assert.match(g.providerConfig("stripe").error, /sk_live_/);
  } finally {
    s.db.close();
  }
});
