// iPay88 Malaysia (OPSG): the browser posts a signed form to entry.asp; iPay88
// posts the result to ResponseURL (browser) and BackendURL (server, answered
// with RECEIVEOK). Signatures are HMAC-SHA512 keyed with the merchant key over
//   request:  MerchantKey + MerchantCode + RefNo + Amount(digits) + Currency
//   response: MerchantKey + MerchantCode + PaymentId + RefNo + Amount(digits) + Currency + Status
// A paid result is re-queried with enquiry.asp ("00" = paid) before money is recorded.
import { createHash, createHmac } from "node:crypto";
import { check } from "./domain.mjs";
import { senToRm, rmToSen } from "./payments-util.mjs";
import { sameHex } from "./payments-billplz.mjs";
const REF = /^[A-Za-z0-9-]{1,20}$/;
const digits = (amount) => String(amount).replace(/[.,]/g, "");
export function ipay88Signature(key, parts) {
  return createHmac("sha512", key).update(key + parts.join("")).digest("hex");
}
const E = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Auto-submits the payment form; the CSP allows exactly this script by hash.
const SCRIPT = 'document.getElementById("pay").submit();';
export const IPAY88_SCRIPT_HASH = "sha256-" + createHash("sha256").update(SCRIPT).digest("base64");
export const ipay88 = {
  name: "ipay88",
  label: "iPay88",
  account: "IPAY88",
  methods: "online banking (FPX), card or e-wallet",
  minAmount: 100,
  reuseMs: 3600000,
  keys: [
    { name: "IPAY88_MERCHANT_CODE", label: "iPay88 merchant code", help: "From iPay88 (e.g. M01234).", secret: false, required: true },
    { name: "IPAY88_MERCHANT_KEY", label: "iPay88 merchant key", help: "From iPay88 with your merchant code. Used for HMAC-SHA512 signatures.", secret: true, required: true },
    { name: "IPAY88_SANDBOX", label: "iPay88 sandbox", help: "true to post to sandbox.ipay88.com.my (ask iPay88 which test endpoint your account uses).", secret: false, flag: true },
  ],
  configure(v) {
    check(/^[A-Za-z0-9]{3,20}$/.test(v.IPAY88_MERCHANT_CODE || ""), "IPAY88_MERCHANT_CODE looks wrong (letters and digits only).");
    const sandbox = v.IPAY88_SANDBOX === "true";
    const base = sandbox ? "https://sandbox.ipay88.com.my" : "https://payment.ipay88.com.my";
    return {
      provider: "ipay88",
      merchantCode: v.IPAY88_MERCHANT_CODE,
      merchantKey: v.IPAY88_MERCHANT_KEY,
      sandbox,
      entry: base + "/ePayment/entry.asp",
      enquiry: base + "/ePayment/enquiry.asp",
    };
  },
  reference: (rowId) => "KS" + rowId.replace(/-/g, "").slice(0, 18).toUpperCase(),
  // No API call: the client is sent to our own page that posts the signed form.
  async create({ config, doc, business, origin, rowId, ref }) {
    const email = doc.client.email || business.email;
    check(email, "Online payment needs an email address on the invoice. Contact the sender.", 409);
    check(REF.test(ref) && config.merchantCode, "Invalid payment reference.", 500);
    return { bill_id: ref, url: `${origin}/api/guest/payments/ipay88/${rowId}`, ref };
  },
  visit: (url, token) => `${url}?t=${token}`,
  // The fields the browser posts to entry.asp.
  fields({ config, row, doc, business, origin }) {
    const amount = senToRm(row.amount, true);
    return {
      MerchantCode: config.merchantCode,
      PaymentId: "",
      RefNo: row.bill_id,
      Amount: amount,
      Currency: "MYR",
      ProdDesc: `Invoice ${doc.number} from ${business.company || "Nawlogic"}`.slice(0, 100),
      UserName: doc.client.name.slice(0, 100),
      UserEmail: (doc.client.email || business.email || "").slice(0, 100),
      UserContact: (doc.client.phone || business.phone || "").replace(/[^\d+]/g, "").slice(0, 20),
      Remark: `Invoice ${doc.number}`.slice(0, 100),
      Lang: "UTF-8",
      SignatureType: "HMACSHA512",
      Signature: ipay88Signature(config.merchantKey, [config.merchantCode, row.bill_id, digits(amount), "MYR"]),
      ResponseURL: `${origin}/api/hooks/payments/ipay88/return/${row.id}`,
      BackendURL: `${origin}/api/hooks/payments/ipay88`,
    };
  },
  page(config, fields) {
    const inputs = Object.entries(fields)
      .map(([k, v]) => `<input type="hidden" name="${E(k)}" value="${E(v)}">`)
      .join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue to iPay88</title><link rel="stylesheet" href="/app.css"></head><body><main class="error-page"><h1>Opening iPay88…</h1><p>You are paying ${E("RM " + fields.Amount)} for ${E(fields.Remark)}.</p><form id="pay" method="post" action="${E(config.entry)}">${inputs}<button class="btn primary" type="submit">Continue to iPay88</button></form></main><script>${SCRIPT}</script></body></html>`;
  },
  // Checks the signed result from ResponseURL or BackendURL.
  verify(params, config) {
    check(params.MerchantCode === config.merchantCode, "Invalid merchant.", 403);
    const expected = ipay88Signature(config.merchantKey, [
      config.merchantCode,
      params.PaymentId ?? "",
      params.RefNo ?? "",
      digits(params.Amount ?? ""),
      params.Currency ?? "",
      params.Status ?? "",
    ]);
    check(sameHex(String(params.Signature || ""), expected), "Invalid payment signature.", 403);
    check(REF.test(params.RefNo || ""), "Invalid payment reference.", 400);
    check(params.Currency === "MYR", "Unexpected currency.", 400);
    return {
      id: params.RefNo,
      status: String(params.Status),
      amount: rmToSen(params.Amount),
      transId: String(params.TransId || "").slice(0, 60),
    };
  },
  async confirm({ http, config, row, hint }) {
    const q = new URLSearchParams({
      MerchantCode: config.merchantCode,
      RefNo: row.bill_id,
      Amount: senToRm(row.amount, true),
    });
    const res = await http(`${config.enquiry}?${q}`, { method: "GET" });
    check(res.ok, "The payment provider could not be reached. Try again shortly.", 502);
    const answer = String(res.text || "").trim().slice(0, 80);
    // "00" means paid in full for this RefNo and amount; anything else is not paid
    // (e.g. "Payment Pending", "Payment fail", "Record not found", "Incorrect amount").
    if (answer !== "00") return { paid: false, status: answer || "unknown" };
    return { paid: true, amount: row.amount, paidAt: null, reference: hint?.transId || row.bill_id };
  },
  async test({ http, config }) {
    const q = new URLSearchParams({ MerchantCode: config.merchantCode, RefNo: "TEST" + Date.now(), Amount: "1.00" });
    const res = await http(`${config.enquiry}?${q}`, { method: "GET" });
    check(res.ok && res.text, "iPay88 could not be reached.", 502);
    return `iPay88 answered "${String(res.text).trim().slice(0, 60)}". The merchant key is checked with the first payment.`;
  },
};
