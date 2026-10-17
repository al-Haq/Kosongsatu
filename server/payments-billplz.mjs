// Billplz (FPX, card, DuitNow) through the Billplz v3 bills API.
// https://www.billplz.com/api : bills are created with Basic auth (API key as the
// user name), callbacks and redirects carry an X Signature (HMAC-SHA256).
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError, check } from "./domain.mjs";
export function gatewayConfiguration(env = process.env) {
  if (!env.BILLPLZ_API_KEY) return null;
  check(
    env.BILLPLZ_COLLECTION_ID && env.BILLPLZ_X_SIGNATURE_KEY,
    "BILLPLZ_COLLECTION_ID and BILLPLZ_X_SIGNATURE_KEY are required with BILLPLZ_API_KEY.",
  );
  const sandbox = env.BILLPLZ_SANDBOX === "true";
  return {
    provider: "billplz",
    apiKey: env.BILLPLZ_API_KEY,
    collectionId: env.BILLPLZ_COLLECTION_ID,
    signatureKey: env.BILLPLZ_X_SIGNATURE_KEY,
    sandbox,
    base: sandbox
      ? "https://www.billplz-sandbox.com/api/v3"
      : "https://www.billplz.com/api/v3",
  };
}
// Billplz X Signature: each key+value pair (nested redirect keys flattened,
// e.g. billplz[id] -> billplzid), sorted case-insensitively and joined with "|".
export function billplzSignature(params, key) {
  const source = Object.entries(params)
    .filter(([k]) => k !== "x_signature" && k !== "billplz[x_signature]")
    .map(([k, v]) => k.replace(/[[\]]/g, "") + String(v ?? ""))
    .sort((a, b) => {
      const x = a.toLowerCase(),
        y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .join("|");
  return createHmac("sha256", key).update(source).digest("hex");
}
export const sameHex = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  /^[0-9a-f]+$/i.test(a) &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a.toLowerCase()), Buffer.from(b.toLowerCase()));
const auth = (config) => ({
  Authorization: "Basic " + Buffer.from(config.apiKey + ":").toString("base64"),
});
async function api(http, config, path, form) {
  const res = await http(config.base + path, {
    method: form ? "POST" : "GET",
    headers: auth(config),
    form,
  });
  if (!res.ok || !res.data || typeof res.data !== "object")
    throw new AppError("The payment provider rejected the request. Try again shortly.", 502);
  return res.data;
}
export const billplz = {
  name: "billplz",
  label: "Billplz",
  account: "BILLPLZ",
  methods: "online banking (FPX), card or DuitNow",
  minAmount: 100,
  reuseMs: 7 * 86400000,
  keys: [
    { name: "BILLPLZ_API_KEY", label: "Billplz API secret key", help: "Billplz > Settings > Keys & Integration.", secret: true, required: true },
    { name: "BILLPLZ_COLLECTION_ID", label: "Billplz collection ID", help: "Billplz > Billing > the collection that receives invoice payments.", secret: false, required: true },
    { name: "BILLPLZ_X_SIGNATURE_KEY", label: "Billplz X Signature key", help: "Billplz > Settings > Keys & Integration (turn on X Signature).", secret: true, required: true },
    { name: "BILLPLZ_SANDBOX", label: "Billplz sandbox", help: "true to use billplz-sandbox.com for testing.", secret: false, flag: true },
  ],
  configure: (values) => gatewayConfiguration(values),
  async create({ http, config, doc, business, origin, token, amount, returnUrl }) {
    const email = doc.client.email || business.email;
    const mobile = (doc.client.phone || "").replace(/[^\d+]/g, "");
    check(email || mobile, "Online payment needs an email address on the invoice. Contact the sender.", 409);
    const bill = await api(http, config, "/bills", {
      collection_id: config.collectionId,
      ...(email ? { email } : {}),
      ...(mobile ? { mobile } : {}),
      name: doc.client.name.slice(0, 255),
      amount: String(amount),
      // Existing bills point here, so Billplz keeps its original callback path.
      callback_url: `${origin}/api/payments/billplz/callback`,
      redirect_url: returnUrl || `${origin}/client/${token}`,
      description: `Invoice ${doc.number} from ${business.company || "Nawlogic"}`.slice(0, 200),
      reference_1_label: "Invoice",
      reference_1: doc.number,
    });
    check(
      typeof bill.id === "string" &&
        /^[\w-]{1,40}$/.test(bill.id) &&
        typeof bill.url === "string" &&
        bill.url.startsWith("https://") &&
        Number(bill.amount) === amount,
      "The payment provider returned an unexpected response.",
      502,
    );
    return { bill_id: bill.id, url: bill.url, ref: doc.number };
  },
  // The signed notice only says which bill changed; the paid state and amount
  // are read back from Billplz.
  async confirm({ http, config, row }) {
    const bill = await api(http, config, "/bills/" + encodeURIComponent(row.bill_id));
    if (!(bill.paid === true && bill.state === "paid")) return { paid: false, status: String(bill.state || "due") };
    check(
      bill.id === row.bill_id && bill.collection_id === config.collectionId,
      "The payment provider returned a mismatched bill.",
      502,
    );
    return {
      paid: true,
      amount: Number(bill.paid_amount ?? bill.amount),
      paidAt: bill.paid_at,
      reference: bill.id,
    };
  },
  // Older bills were for a different balance; withdraw them so the client cannot
  // overpay. Billplz refuses to delete a paid bill, and such a payment still settles.
  async cancel({ http, config, row }) {
    await http(config.base + "/bills/" + encodeURIComponent(row.bill_id), {
      method: "DELETE",
      headers: auth(config),
    });
  },
  async test({ http, config }) {
    const c = await api(http, config, "/collections/" + encodeURIComponent(config.collectionId));
    check(c.id === config.collectionId, "Billplz did not return this collection. Check the collection ID.", 502);
    return `Connected to Billplz collection ${c.title || c.id}${config.sandbox ? " (sandbox)" : ""}.`;
  },
  // Server callback (x_signature) or browser redirect (billplz[x_signature]).
  verify(params, config) {
    const given = params.x_signature ?? params["billplz[x_signature]"];
    check(
      typeof given === "string" &&
        /^[0-9a-f]{64}$/.test(given) &&
        sameHex(given, billplzSignature(params, config.signatureKey)),
      "Invalid payment signature.",
      403,
    );
    const id = params.id ?? params["billplz[id]"];
    check(typeof id === "string" && /^[\w-]{1,40}$/.test(id), "Invalid bill.", 400);
    return { id, paidAt: params.paid_at ?? params["billplz[paid_at]"] };
  },
};
