// Stripe Checkout (card and FPX in MYR) through the REST API with form encoding.
// A Checkout Session is created per balance; the webhook is verified with the
// Stripe-Signature header (HMAC-SHA256 of "<t>.<raw body>" with the endpoint
// secret) and the session is always retrieved again before money is recorded.
import { createHmac } from "node:crypto";
import { AppError, check } from "./domain.mjs";
import { formEncode } from "./payments-util.mjs";
import { sameHex } from "./payments-billplz.mjs";
const BASE = "https://api.stripe.com/v1";
const SESSION = /^cs_(test|live)_[A-Za-z0-9]{8,200}$/;
export const STRIPE_TOLERANCE = 300;
const headers = (config, extra = {}) => ({ Authorization: "Bearer " + config.secretKey, ...extra });
async function api(http, config, path, form, extra) {
  const res = await http(BASE + path, { method: form ? "POST" : "GET", headers: headers(config, extra), form });
  if (!res.ok || !res.data || typeof res.data !== "object") {
    const message = res.data?.error?.message;
    throw new AppError(
      message ? `Stripe refused the request: ${String(message).slice(0, 200)}` : "The payment provider rejected the request. Try again shortly.",
      502,
    );
  }
  return res.data;
}
// Returns the parsed event, or throws 400/403. `now` is in seconds.
export function verifyStripeWebhook(raw, header, secret, now = Math.floor(Date.now() / 1000)) {
  check(typeof header === "string" && header.length < 2000, "Missing Stripe-Signature header.", 400);
  const parts = header.split(",").map((p) => p.trim());
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const sigs = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  check(/^\d{1,12}$/.test(t || "") && sigs.length, "Invalid Stripe-Signature header.", 400);
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  check(sigs.some((s) => /^[0-9a-f]{64}$/.test(s) && sameHex(s, expected)), "Invalid payment signature.", 403);
  check(Math.abs(now - Number(t)) <= STRIPE_TOLERANCE, "Stripe event is too old (possible replay).", 403);
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    throw new AppError("Invalid JSON body.", 400);
  }
  check(event && typeof event === "object" && typeof event.type === "string", "Invalid Stripe event.", 400);
  return event;
}
export const stripe = {
  name: "stripe",
  label: "Stripe",
  account: "STRIPE",
  methods: "card or online banking (FPX)",
  // Stripe's minimum charge for MYR is RM 2.00.
  minAmount: 200,
  reuseMs: 20 * 3600000,
  keys: [
    { name: "STRIPE_SECRET_KEY", label: "Stripe secret key", help: "Stripe Dashboard > Developers > API keys (sk_live_… or sk_test_…; a restricted key needs Checkout Sessions write).", secret: true, required: true },
    { name: "STRIPE_WEBHOOK_SECRET", label: "Stripe webhook signing secret", help: "Stripe Dashboard > Developers > Webhooks > your endpoint (whsec_…).", secret: true, required: true },
  ],
  configure(v) {
    const key = v.STRIPE_SECRET_KEY || "";
    check(/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(key), "STRIPE_SECRET_KEY must start with sk_live_, sk_test_, rk_live_ or rk_test_.");
    check(/^whsec_[A-Za-z0-9+/=]{8,}$/.test(v.STRIPE_WEBHOOK_SECRET || ""), "STRIPE_WEBHOOK_SECRET must start with whsec_.");
    return { provider: "stripe", secretKey: key, webhookSecret: v.STRIPE_WEBHOOK_SECRET, sandbox: key.includes("_test_") };
  },
  async create({ http, config, doc, business, origin, token, amount, rowId, returnUrl }) {
    const back = returnUrl || `${origin}/client/${token}`,
      sep = back.includes("?") ? "&" : "?";
    const email = doc.client.email || "";
    const session = await api(
      http,
      config,
      "/checkout/sessions",
      formEncode({
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "myr",
              unit_amount: amount,
              product_data: { name: `Invoice ${doc.number}`, description: `From ${business.company || "Nawlogic"}`.slice(0, 200) },
            },
          },
        ],
        payment_method_types: ["card", "fpx"],
        success_url: `${back}${sep}payment=stripe&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${back}${sep}payment=stripe&cancelled=1`,
        client_reference_id: rowId,
        metadata: { invoice_id: doc.id, invoice_number: doc.number },
        payment_intent_data: {
          description: `Invoice ${doc.number}`,
          metadata: { invoice_id: doc.id, invoice_number: doc.number },
        },
        ...(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { customer_email: email } : {}),
        expires_at: Math.floor(Date.now() / 1000) + 23 * 3600,
      }),
      { "Idempotency-Key": rowId },
    );
    check(
      typeof session.id === "string" &&
        SESSION.test(session.id) &&
        typeof session.url === "string" &&
        session.url.startsWith("https://checkout.stripe.com/") &&
        session.amount_total === amount &&
        session.currency === "myr",
      "The payment provider returned an unexpected response.",
      502,
    );
    return { bill_id: session.id, url: session.url, ref: rowId };
  },
  async confirm({ http, config, row, hint }) {
    const s = await api(http, config, "/checkout/sessions/" + encodeURIComponent(row.bill_id));
    if (!(s.payment_status === "paid" && s.status === "complete")) return { paid: false, status: String(s.status || "open") };
    check(
      s.id === row.bill_id &&
        s.mode === "payment" &&
        s.currency === "myr" &&
        (!row.ref || s.client_reference_id === row.ref),
      "The payment provider returned a mismatched bill.",
      502,
    );
    const pi = typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id;
    return { paid: true, amount: Number(s.amount_total), paidAt: hint, reference: pi || s.id };
  },
  async cancel({ http, config, row }) {
    await http(BASE + "/checkout/sessions/" + encodeURIComponent(row.bill_id) + "/expire", {
      method: "POST",
      headers: headers(config),
      form: {},
    });
  },
  async test({ http, config }) {
    const list = await api(http, config, "/checkout/sessions?limit=1");
    check(list.object === "list", "Stripe returned an unexpected response.", 502);
    return `Connected to Stripe${config.sandbox ? " in test mode" : " (live)"}.`;
  },
};
