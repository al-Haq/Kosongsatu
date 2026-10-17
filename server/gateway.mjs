import { chmodSync } from "node:fs";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { AppError, check, today } from "./domain.mjs";
export function migrateGateway(db, path) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version >= 7) return;
  if (
    path !== ":memory:" &&
    db.prepare("SELECT count(*) n FROM documents").get().n
  ) {
    const snapshot = path + ".pre-v7-" + Date.now() + ".sqlite";
    db.prepare("VACUUM INTO ?").run(snapshot);
    chmodSync(snapshot, 0o600);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
 CREATE TABLE online_payments(
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES documents(id),
  provider TEXT NOT NULL,
  bill_id TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','paid')),
  receipt_id TEXT REFERENCES cash_receipts(id),
  paid_at TEXT,
  created TEXT NOT NULL
 );
 CREATE INDEX online_payments_invoice ON online_payments(invoice_id,state);
 PRAGMA user_version=7; COMMIT;`);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
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
const sameHex = (a, b) =>
  typeof a === "string" &&
  /^[0-9a-f]{64}$/.test(a) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class Gateway {
  constructor(store, { config = gatewayConfiguration(), fetcher = fetch } = {}) {
    this.store = store;
    this.config = config;
    this.fetcher = fetcher;
  }
  status() {
    return {
      configured: !!this.config,
      provider: this.config?.provider || null,
      sandbox: !!this.config?.sandbox,
    };
  }
  async api(path, form) {
    check(this.config, "Online payment is not available for this invoice.", 503);
    let response, data;
    try {
      response = await this.fetcher(this.config.base + path, {
        method: form ? "POST" : "GET",
        headers: {
          Authorization:
            "Basic " + Buffer.from(this.config.apiKey + ":").toString("base64"),
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal: AbortSignal.timeout(15000),
      });
      data = await response.json();
    } catch {
      throw new AppError("The payment provider could not be reached. Try again shortly.", 502);
    }
    if (!response.ok || !data || typeof data !== "object")
      throw new AppError("The payment provider rejected the request. Try again shortly.", 502);
    return data;
  }
  // Starts (or resumes) an online payment for the full balance of a shared invoice.
  // returnUrl lets the client portal bring the client back to its own page.
  async checkout(token, origin, returnUrl = `${origin}/client/${token}`) {
    const d = this.store.publicDocument(token);
    check(
      d.kind === "invoice" && d.state === "issued" && d.balance > 0,
      "This invoice is not awaiting payment.",
      409,
    );
    check(this.config, "Online payment is not available for this invoice.", 503);
    const recent = new Date(Date.now() - 7 * 86400000).toISOString();
    const existing = this.store.db
      .prepare(
        "SELECT * FROM online_payments WHERE invoice_id=? AND state='pending' AND amount=? AND created>? ORDER BY created DESC",
      )
      .get(d.id, d.balance, recent);
    if (existing) return { url: existing.url };
    const business = this.store.settings();
    const email = d.client.email || business.email;
    const mobile = (d.client.phone || "").replace(/[^\d+]/g, "");
    check(email || mobile, "Online payment needs an email address on the invoice. Contact the sender.", 409);
    const stale = this.store.db
      .prepare("SELECT bill_id FROM online_payments WHERE invoice_id=? AND state='pending'")
      .all(d.id);
    const bill = await this.api("/bills", {
      collection_id: this.config.collectionId,
      ...(email ? { email } : {}),
      ...(mobile ? { mobile } : {}),
      name: d.client.name.slice(0, 255),
      amount: String(d.balance),
      callback_url: `${origin}/api/payments/billplz/callback`,
      redirect_url: returnUrl,
      description: `Invoice ${d.number} from ${business.company || "Nawlogic"}`.slice(0, 200),
      reference_1_label: "Invoice",
      reference_1: d.number,
    });
    check(
      typeof bill.id === "string" &&
        /^[\w-]{1,40}$/.test(bill.id) &&
        typeof bill.url === "string" &&
        bill.url.startsWith("https://") &&
        Number(bill.amount) === d.balance,
      "The payment provider returned an unexpected response.",
      502,
    );
    this.store.tx(() => {
      this.store.db
        .prepare(
          "INSERT INTO online_payments(id,invoice_id,provider,bill_id,amount,url,created) VALUES(?,?,?,?,?,?,?)",
        )
        .run(randomUUID(), d.id, "billplz", bill.id, d.balance, bill.url, new Date().toISOString());
      this.store.audit("online_payment.started", d.id, `Billplz ${bill.id}: ${d.balance} sen`);
    });
    // Older bills were for a different balance; withdraw them so the client cannot overpay.
    // Billplz refuses to delete a bill that is already paid, and such a payment still settles.
    for (const s of stale)
      await this.fetcher(this.config.base + "/bills/" + encodeURIComponent(s.bill_id), {
        method: "DELETE",
        headers: { Authorization: "Basic " + Buffer.from(this.config.apiKey + ":").toString("base64") },
        signal: AbortSignal.timeout(15000),
      }).catch(() => {});
    return { url: bill.url };
  }
  verify(params) {
    check(this.config, "Online payment is not configured.", 404);
    const given = params.x_signature ?? params["billplz[x_signature]"];
    check(
      sameHex(given, billplzSignature(params, this.config.signatureKey)),
      "Invalid payment signature.",
      403,
    );
    const id = params.id ?? params["billplz[id]"];
    check(typeof id === "string" && /^[\w-]{1,40}$/.test(id), "Invalid bill.", 400);
    return { id, paidAt: params.paid_at ?? params["billplz[paid_at]"] };
  }
  // The signed notification only tells us which bill changed. The amount and
  // paid state are always read back from the provider before money is recorded.
  async settle(billId, paidAt) {
    const row = this.store.db
      .prepare("SELECT * FROM online_payments WHERE bill_id=?")
      .get(billId);
    check(row, "Payment not found.", 404);
    if (row.state === "paid") return row;
    const bill = await this.api("/bills/" + encodeURIComponent(billId));
    if (!(bill.paid === true && bill.state === "paid")) return row;
    const paid = Number(bill.paid_amount ?? bill.amount);
    check(
      bill.id === billId && bill.collection_id === this.config.collectionId && paid === row.amount,
      "The payment provider returned a mismatched bill.",
      502,
    );
    return this.store.tx(() => {
      const current = this.store.db
        .prepare("SELECT * FROM online_payments WHERE id=?")
        .get(row.id);
      if (current.state === "paid") return current;
      const d = this.store.document(row.invoice_id);
      // If the invoice was settled another way meanwhile, the extra money stays
      // as customer funds for the owner to allocate or refund.
      const applied = d.state === "issued" ? Math.min(d.balance, paid) : 0;
      // Prefer the provider's paid time (from the bill or the signed notification).
      const stamp = [bill.paid_at, paidAt].find(
        (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v),
      );
      const paidDate = stamp ? stamp.slice(0, 10) : today();
      const receipt = this.store.receive({
        client_id: d.client_id,
        amount: (paid / 100).toFixed(2),
        paid_date: paidDate > today() ? today() : paidDate,
        method: "Other",
        account: "BILLPLZ",
        reference: "Billplz " + billId,
        note: `Online payment for ${d.number}`,
        allocations: applied
          ? [{ invoice_id: d.id, amount: (applied / 100).toFixed(2), note: "Online payment" }]
          : undefined,
      });
      this.store.db
        .prepare("UPDATE online_payments SET state='paid',receipt_id=?,paid_at=? WHERE id=?")
        .run(receipt.id, new Date().toISOString(), row.id);
      this.store.audit(
        "online_payment.paid",
        d.id,
        `Billplz ${billId}: ${paid} sen`,
        { state: "pending" },
        { state: "paid", receipt_id: receipt.id, applied },
      );
      return this.store.db.prepare("SELECT * FROM online_payments WHERE id=?").get(row.id);
    });
  }
  list(limit = 50) {
    return this.store.db
      .prepare(
        "SELECT o.id,o.invoice_id,d.number,o.bill_id,o.amount,o.state,o.receipt_id,o.paid_at,o.created FROM online_payments o JOIN documents d ON d.id=o.invoice_id ORDER BY o.created DESC LIMIT ?",
      )
      .all(limit);
  }
}
