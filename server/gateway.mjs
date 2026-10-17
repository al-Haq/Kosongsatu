// Online payment from the client link. The owner picks one active provider
// (Billplz, ToyyibPay, Stripe or iPay88); keys come from the server environment
// or Settings > Integration keys and are read on every call, so a change takes
// effect without a restart. Every provider follows the same rules:
// - a payment is started for the invoice balance only,
// - callbacks and redirects are authenticated (signature or our own reference),
// - the paid amount is always read back from the provider before money is recorded,
// - exactly one receipt + allocation is recorded through store.receive(), and
//   money beyond the balance stays as customer funds.
import { chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AppError, check, today } from "./domain.mjs";
import { billplz, billplzSignature, gatewayConfiguration } from "./payments-billplz.mjs";
import { toyyibpay } from "./payments-toyyibpay.mjs";
import { stripe } from "./payments-stripe.mjs";
import { ipay88 } from "./payments-ipay88.mjs";
export { billplzSignature, gatewayConfiguration };
// No prototype, so a name from a request ("constructor", "toString") is never a provider.
export const PROVIDERS = Object.freeze(Object.assign(Object.create(null), { billplz, toyyibpay, stripe, ipay88 }));
export const PROVIDER_ORDER = ["billplz", "toyyibpay", "stripe", "ipay88"];
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
const MAX_RESPONSE = 1000000;
export class Gateway {
  // config: a fixed Billplz configuration (tests, older callers). Without it,
  // every provider reads its keys through store.config() at call time.
  constructor(store, { config, fetcher = fetch, env = process.env } = {}) {
    this.store = store;
    this.fetcher = fetcher;
    this.env = env;
    this.fixed = config ? { billplz: config } : {};
  }
  get config() {
    return this.providerConfig("billplz").config;
  }
  // One HTTP call to a provider: { ok, status, data (JSON or null), text }.
  async http(url, { method = "GET", headers = {}, form } = {}) {
    let response;
    try {
      response = await this.fetcher(url, {
        method,
        redirect: "error",
        headers: {
          ...headers,
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new AppError("The payment provider could not be reached. Try again shortly.", 502);
    }
    let data = null,
      text = "";
    try {
      if (typeof response.text === "function") {
        text = String(await response.text()).slice(0, MAX_RESPONSE);
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      } else if (typeof response.json === "function") data = await response.json();
    } catch {
      throw new AppError("The payment provider could not be reached. Try again shortly.", 502);
    }
    return { ok: !!response.ok, status: response.status, data, text };
  }
  read(name) {
    return this.store.config(name, this.env);
  }
  // { config, missing, error } for one provider; config is null until complete.
  providerConfig(name) {
    const p = PROVIDERS[name];
    check(p, "Unknown payment provider.", 404);
    if (this.fixed[name]) return { config: this.fixed[name], missing: [], error: null };
    const values = Object.fromEntries(p.keys.map((k) => [k.name, this.read(k.name) ?? ""]));
    const required = p.keys.filter((k) => k.required);
    const missing = required.filter((k) => !values[k.name]).map((k) => k.name);
    if (missing.length) return { config: null, missing, error: null, started: missing.length < required.length };
    try {
      return { config: p.configure(values), missing: [], error: null };
    } catch (e) {
      return { config: null, missing: [], error: e.message };
    }
  }
  // The owner's choice: PAYMENT_PROVIDER on the server, else Settings.
  choice() {
    const env = this.env.PAYMENT_PROVIDER;
    if (env) return env;
    return this.store.paymentOptions?.().provider || null;
  }
  active() {
    const choice = this.choice();
    if (choice === "off") return null;
    if (choice && PROVIDERS[choice]) return this.providerConfig(choice).config ? choice : null;
    return PROVIDER_ORDER.find((n) => this.providerConfig(n).config) || null;
  }
  status() {
    const active = this.active();
    const providers = PROVIDER_ORDER.map((name) => {
      const p = PROVIDERS[name],
        s = this.providerConfig(name);
      return {
        name,
        label: p.label,
        methods: p.methods,
        configured: !!s.config,
        sandbox: !!s.config?.sandbox,
        missing: s.missing,
        error: s.error,
        active: name === active,
        minAmount: p.minAmount,
        keys: p.keys.map((k) => ({
          name: k.name,
          label: k.label,
          help: k.help,
          secret: k.secret !== false,
          required: !!k.required,
          flag: !!k.flag,
          source: this.env[k.name] ? "server" : this.store.secret?.(k.name) ? "settings" : this.fixed[name] ? "server" : null,
        })),
      };
    });
    const a = providers.find((x) => x.active);
    return {
      configured: !!a,
      provider: a?.name || null,
      label: a?.label || null,
      methods: a?.methods || null,
      sandbox: !!a?.sandbox,
      choice: this.choice(),
      choiceFromServer: !!this.env.PAYMENT_PROVIDER,
      providers,
    };
  }
  // Whether the client link can offer online payment for this document.
  canPay(d) {
    const name = this.active();
    if (!name || d.kind !== "invoice" || d.state !== "issued" || d.balance < (PROVIDERS[name].minAmount || 1)) return false;
    const contact = d.client.email || this.store.settings().email;
    return name === "stripe" ? true : name === "billplz" ? !!(contact || d.client.phone) : !!contact;
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
    const name = this.active();
    check(name, "Online payment is not available for this invoice.", 503);
    const p = PROVIDERS[name],
      { config } = this.providerConfig(name);
    check(
      d.balance >= (p.minAmount || 1),
      `Online payment needs a balance of at least RM ${((p.minAmount || 1) / 100).toFixed(2)}. Please pay by bank transfer.`,
      409,
    );
    const recent = new Date(Date.now() - p.reuseMs).toISOString();
    const existing = this.store.db
      .prepare(
        "SELECT * FROM online_payments WHERE invoice_id=? AND provider=? AND state='pending' AND amount=? AND created>? ORDER BY created DESC",
      )
      .get(d.id, name, d.balance, recent);
    if (existing) return { url: p.visit ? p.visit(existing.url, token) : existing.url, provider: name };
    const stale = this.store.db
      .prepare("SELECT id,provider,bill_id,amount FROM online_payments WHERE invoice_id=? AND state='pending'")
      .all(d.id);
    const rowId = randomUUID();
    const ref = p.reference ? p.reference(rowId) : rowId;
    const created = await p.create({
      http: (url, init) => this.http(url, init),
      config,
      doc: d,
      business: this.store.settings(),
      origin,
      token,
      amount: d.balance,
      rowId,
      ref,
      returnUrl,
    });
    check(
      created &&
        typeof created.bill_id === "string" &&
        /^[\w.-]{1,200}$/.test(created.bill_id) &&
        typeof created.url === "string" &&
        (created.url.startsWith("https://") || created.url.startsWith(origin + "/")),
      "The payment provider returned an unexpected response.",
      502,
    );
    this.store.tx(() => {
      this.store.db
        .prepare(
          "INSERT INTO online_payments(id,invoice_id,provider,bill_id,amount,url,created,ref) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(rowId, d.id, name, created.bill_id, d.balance, created.url, new Date().toISOString(), created.ref || ref);
      this.store.audit("online_payment.started", d.id, `${p.label} ${created.bill_id}: ${d.balance} sen`);
    });
    for (const s of stale) {
      const sp = PROVIDERS[s.provider],
        sc = sp && this.providerConfig(s.provider).config;
      if (sp?.cancel && sc)
        await sp.cancel({ http: (url, init) => this.http(url, init), config: sc, row: s }).catch(() => {});
    }
    return { url: p.visit ? p.visit(created.url, token) : created.url, provider: name };
  }
  // Billplz callback/redirect signature check (kept for the original callback route).
  verify(params) {
    const { config } = this.providerConfig("billplz");
    check(config, "Online payment is not configured.", 404);
    return billplz.verify(params, config);
  }
  row(billId, provider = null) {
    return provider
      ? this.store.db.prepare("SELECT * FROM online_payments WHERE provider=? AND bill_id=?").get(provider, billId)
      : this.store.db.prepare("SELECT * FROM online_payments WHERE bill_id=?").get(billId);
  }
  // A notification or a redirect only says which payment changed. The paid state
  // and amount are always read back from the provider before money is recorded.
  async settle(billId, hint = null, provider = null) {
    const row = this.row(billId, provider);
    check(row, "Payment not found.", 404);
    if (row.state === "paid") return row;
    const p = PROVIDERS[row.provider];
    check(p, "Unknown payment provider.", 500);
    const { config } = this.providerConfig(row.provider);
    check(config, "Online payment is not available for this invoice.", 503);
    const result = await p.confirm({
      http: (url, init) => this.http(url, init),
      config,
      row,
      hint,
    });
    const stamp = new Date().toISOString();
    if (!result.paid) {
      this.store.db
        .prepare("UPDATE online_payments SET checked=?,detail=? WHERE id=?")
        .run(stamp, String(result.status || "pending").slice(0, 80), row.id);
      return this.store.db.prepare("SELECT * FROM online_payments WHERE id=?").get(row.id);
    }
    if (result.amount !== row.amount) {
      // Logged once; the owner reviews it with the provider. Nothing is recorded.
      if (row.detail !== "Amount mismatch")
        this.store.audit(
          "online_payment.mismatch",
          row.invoice_id,
          `${p.label} ${row.bill_id}: provider reported ${result.amount} sen, expected ${row.amount} sen`,
        );
      this.store.db
        .prepare("UPDATE online_payments SET checked=?,detail='Amount mismatch' WHERE id=?")
        .run(stamp, row.id);
      throw new AppError("The payment provider returned a mismatched bill.", 502);
    }
    return this.record(row, p, result, hint);
  }
  record(row, p, result, hint) {
    return this.store.tx(() => {
      const current = this.store.db
        .prepare("SELECT * FROM online_payments WHERE id=?")
        .get(row.id);
      if (current.state === "paid") return current;
      const paid = result.amount;
      const d = this.store.document(row.invoice_id);
      // If the invoice was settled another way meanwhile, the extra money stays
      // as customer funds for the owner to allocate or refund.
      const applied = d.kind === "invoice" && d.state === "issued" ? Math.min(d.balance, paid) : 0;
      // Prefer the provider's paid time (from the confirmation or the signed notice).
      const hintDate = typeof hint === "string" ? hint : hint?.paidAt;
      const stamp = [result.paidAt, hintDate].find(
        (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v),
      );
      const paidDate = stamp ? stamp.slice(0, 10) : today();
      const receipt = this.store.receive({
        client_id: d.client_id,
        amount: (paid / 100).toFixed(2),
        paid_date: paidDate > today() ? today() : paidDate,
        method: "Other",
        account: p.account,
        reference: `${p.label} ${row.bill_id}`.slice(0, 120),
        note: `Online payment for ${d.number}`,
        allocations: applied
          ? [{ invoice_id: d.id, amount: (applied / 100).toFixed(2), note: "Online payment" }]
          : undefined,
      });
      this.store.db
        .prepare(
          "UPDATE online_payments SET state='paid',receipt_id=?,paid_at=?,provider_ref=?,checked=?,detail=NULL WHERE id=?",
        )
        .run(
          receipt.id,
          new Date().toISOString(),
          String(result.reference || row.bill_id).slice(0, 120),
          new Date().toISOString(),
          row.id,
        );
      this.store.audit(
        "online_payment.paid",
        d.id,
        `${p.label} ${row.bill_id}: ${paid} sen`,
        { state: "pending" },
        { state: "paid", receipt_id: receipt.id, applied },
      );
      return this.store.db.prepare("SELECT * FROM online_payments WHERE id=?").get(row.id);
    });
  }
  // Owner action: checks that the keys work, without creating a payment.
  async test(name) {
    const p = PROVIDERS[name];
    check(p, "Unknown payment provider.", 404);
    const s = this.providerConfig(name);
    check(
      s.config,
      s.error || `Enter ${s.missing.join(", ")} first.`,
      409,
    );
    try {
      const message = await p.test({ http: (url, init) => this.http(url, init), config: s.config });
      this.store.audit("online_payment.tested", null, `${p.label}: ok`);
      return { ok: true, message };
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      this.store.audit("online_payment.tested", null, `${p.label}: ${e.message}`.slice(0, 300));
      return { ok: false, message: e.message };
    }
  }
  list(limit = 50) {
    return this.store.db
      .prepare(
        "SELECT o.id,o.invoice_id,d.number,o.provider,o.bill_id,o.amount,o.state,o.receipt_id,o.paid_at,o.created,o.checked,o.detail FROM online_payments o JOIN documents d ON d.id=o.invoice_id ORDER BY o.created DESC LIMIT ?",
      )
      .all(limit)
      .map((o) => ({ ...o, provider_label: PROVIDERS[o.provider]?.label || o.provider }));
  }
}
