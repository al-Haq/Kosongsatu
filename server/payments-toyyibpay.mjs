// ToyyibPay (FPX and card) through its form API at toyyibpay.com/index.php/api.
// createBill returns [{ BillCode }]; the client pays at <base>/<BillCode>.
// The callback posts refno, status (1 paid, 2 pending, 3 failed), reason,
// billcode, order_id, amount and hash = md5(secret + status + order_id + refno + "ok").
// Money is only recorded after getBillTransactions confirms the payment.
import { createHash } from "node:crypto";
import { AppError, check } from "./domain.mjs";
import { rmToSen, looseDate } from "./payments-util.mjs";
import { sameHex } from "./payments-billplz.mjs";
// ToyyibPay accepts letters, digits, spaces and underscores in bill names.
const clean = (s, max) =>
  String(s || "")
    .replace(/-/g, "_")
    .replace(/[^A-Za-z0-9 _]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const CODE = /^[A-Za-z0-9]{4,40}$/;
async function post(http, config, endpoint, form) {
  const res = await http(`${config.base}/index.php/api/${endpoint}`, { method: "POST", form });
  if (!res.ok) throw new AppError("The payment provider rejected the request. Try again shortly.", 502);
  return res.data ?? res.text;
}
export const toyyibpay = {
  name: "toyyibpay",
  label: "ToyyibPay",
  account: "TOYYIBPAY",
  methods: "online banking (FPX) or card",
  minAmount: 100,
  reuseMs: 6 * 86400000,
  keys: [
    { name: "TOYYIBPAY_SECRET_KEY", label: "ToyyibPay user secret key", help: "ToyyibPay dashboard > Settings > User Secret Key.", secret: true, required: true },
    { name: "TOYYIBPAY_CATEGORY_CODE", label: "ToyyibPay category code", help: "ToyyibPay dashboard > Category > the category for invoice payments.", secret: false, required: true },
    { name: "TOYYIBPAY_SANDBOX", label: "ToyyibPay sandbox", help: "true to use dev.toyyibpay.com with a sandbox account.", secret: false, flag: true },
  ],
  configure(v) {
    check(CODE.test(v.TOYYIBPAY_CATEGORY_CODE || ""), "TOYYIBPAY_CATEGORY_CODE looks wrong (letters and digits only).");
    const sandbox = v.TOYYIBPAY_SANDBOX === "true";
    return {
      provider: "toyyibpay",
      secretKey: v.TOYYIBPAY_SECRET_KEY,
      categoryCode: v.TOYYIBPAY_CATEGORY_CODE,
      sandbox,
      base: sandbox ? "https://dev.toyyibpay.com" : "https://toyyibpay.com",
    };
  },
  reference: (rowId) => "KS" + rowId.replace(/-/g, "").slice(0, 18).toUpperCase(),
  async create({ http, config, doc, business, origin, token, amount, ref, returnUrl }) {
    const back = returnUrl || `${origin}/client/${token}`,
      sep = back.includes("?") ? "&" : "?";
    const email = doc.client.email || business.email;
    const phone = (doc.client.phone || business.phone || "").replace(/[^\d+]/g, "");
    check(email, "Online payment needs an email address on the invoice. Contact the sender.", 409);
    const data = await post(http, config, "createBill", {
      userSecretKey: config.secretKey,
      categoryCode: config.categoryCode,
      billName: clean(`Invoice ${doc.number}`, 30),
      billDescription: clean(`Invoice ${doc.number} from ${business.company || "Nawlogic"}`, 100),
      billPriceSetting: "1",
      billPayorInfo: "1",
      billAmount: String(amount),
      billReturnUrl: `${back}${sep}payment=toyyibpay`,
      billCallbackUrl: `${origin}/api/hooks/payments/toyyibpay`,
      billExternalReferenceNo: ref,
      billTo: doc.client.name.slice(0, 100),
      billEmail: email,
      billPhone: phone,
      billSplitPayment: "0",
      billSplitPaymentArgs: "",
      billPaymentChannel: "2",
      billContentEmail: `Payment for invoice ${doc.number}`.slice(0, 1000),
      // Blank: fees are charged to the merchant, so the paid amount equals the bill.
      billChargeToCustomer: "",
      billExpiryDays: "7",
    });
    const code = Array.isArray(data) ? data[0]?.BillCode : null;
    check(typeof code === "string" && CODE.test(code), "The payment provider returned an unexpected response.", 502);
    return { bill_id: code, url: `${config.base}/${code}`, ref };
  },
  async confirm({ http, config, row }) {
    const data = await post(http, config, "getBillTransactions", {
      billCode: row.bill_id,
      userSecretKey: config.secretKey,
    });
    const list = Array.isArray(data) ? data : [];
    const paid = list.filter((t) => String(t?.billpaymentStatus) === "1");
    if (!paid.length) {
      const s = String(list[0]?.billpaymentStatus || "");
      return { paid: false, status: s === "2" || s === "4" ? "pending" : s === "3" ? "failed" : "unpaid" };
    }
    for (const t of paid)
      check(
        !t.billExternalReferenceNo || !row.ref || t.billExternalReferenceNo === row.ref,
        "The payment provider returned a mismatched bill.",
        502,
      );
    // Two successful payments on one fixed bill would not equal the bill amount
    // and are refused for the owner to review.
    const amount = paid.reduce((s, t) => s + rmToSen(t.billpaymentAmount), 0);
    return {
      paid: true,
      amount: Number.isNaN(amount) ? -1 : amount,
      paidAt: looseDate(paid[0].billPaymentDate),
      reference: String(paid[0].billpaymentInvoiceNo || row.bill_id).slice(0, 80),
    };
  },
  async cancel({ http, config, row }) {
    await post(http, config, "inactiveBill", { secretKey: config.secretKey, userSecretKey: config.secretKey, billCode: row.bill_id });
  },
  async test({ http, config }) {
    const data = await post(http, config, "getCategoryDetails", {
      userSecretKey: config.secretKey,
      categoryCode: config.categoryCode,
    });
    const c = Array.isArray(data) ? data[0] : null;
    check(c && typeof c.categoryName === "string", "ToyyibPay did not accept the secret key and category code.", 502);
    return `Connected to ToyyibPay category ${c.categoryName}${config.sandbox ? " (sandbox)" : ""}.`;
  },
  // A callback with a hash must carry the right one. The callback itself never
  // records money: the bill is always read back with getBillTransactions.
  verify(params, config) {
    const billcode = params.billcode;
    check(typeof billcode === "string" && CODE.test(billcode), "Invalid bill.", 400);
    if (params.hash !== undefined) {
      const expected = createHash("md5")
        .update(`${config.secretKey}${params.status ?? ""}${params.order_id ?? ""}${params.refno ?? ""}ok`)
        .digest("hex");
      check(sameHex(String(params.hash), expected), "Invalid payment signature.", 403);
    }
    return { id: billcode, status: String(params.status ?? params.status_id ?? ""), orderId: params.order_id };
  },
};
