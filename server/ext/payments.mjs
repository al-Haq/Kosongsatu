// Payments: gateway keys in Settings, ToyyibPay, Stripe and iPay88, DuitNow QR,
// payment slip uploads, bank statement formats and smart bank matching.
// Feature module contract: see docs/PLUGINS.md. Owner guide: docs/features/payments.md.
import { PROVIDERS, PROVIDER_ORDER } from "../gateway.mjs";
import { verifyStripeWebhook } from "../payments-stripe.mjs";
import { IPAY88_SCRIPT_HASH } from "../payments-ipay88.mjs";
import { klDate } from "../payments-util.mjs";
import { verifyPassword } from "../auth.mjs";
import { verifySecondFactor } from "../mfa.mjs";
import { requestContext } from "../context.mjs";
import { validateDuitNow } from "../payments-duitnow.mjs";
import { qrDataUri } from "../qr.mjs";
import {
  BANK_LAYOUTS,
  DATE_FORMATS,
  splitCsv,
  detectDelimiter,
  autoMapping,
  cleanMapping,
  parseStatement,
  presetToMapping,
  mappingNames,
} from "../payments-bank.mjs";
import { suggestMatches } from "../payments-match.mjs";
import { bankRowKey } from "../banking.mjs";
import { rankWithAi } from "../payments-ai.mjs";
import { AppError, check, text, currency, id, money } from "../domain.mjs";
const TOKEN = /^[\w-]{43}$/;
const SLIP_BYTES = 5 * 1024 * 1024;
const actor = (name) => {
  const c = requestContext.getStore();
  if (c) c.actor = name;
};
// Reads an application/x-www-form-urlencoded body from a provider (16 KB).
async function formBody(r, limit = 16000) {
  check(
    (r.req.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded"),
    "Form request required.",
    415,
  );
  const raw = await r.rawBody(limit);
  return Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
}
const plain = (r, status, body) => r.send(status, body, { "Content-Type": "text/plain; charset=utf-8" });
// JSON body with a larger limit than r.body() (bank statements).
async function bigJson(r, limit) {
  check((r.req.headers["content-type"] || "").startsWith("application/json"), "JSON request required.", 415);
  const raw = await r.rawBody(limit);
  try {
    const v = JSON.parse(raw.toString("utf8"));
    check(v && typeof v === "object" && !Array.isArray(v), "JSON object required.");
    return v;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("Invalid JSON body.");
  }
}
const payable = (d) => d.kind === "invoice" && d.state === "issued" && d.balance > 0;
// What the owner sees in Settings (the payload is the owner's own public QR).
function duitnowState(store) {
  const dn = store.duitnow();
  if (!dn) return null;
  return {
    payload: dn.payload,
    merchant: dn.merchant,
    city: dn.city,
    qr: dn.payload ? qrDataUri(dn.payload) : null,
    image: dn.image ? { id: dn.image.id, name: dn.image.name, size: dn.image.size } : null,
  };
}
async function confirmOwner(r, b) {
  const { store } = r.ctx;
  const owner = store.db.prepare("SELECT password FROM owners WHERE id=?").get(r.session.owner_id);
  check(await verifyPassword(b.password, owner.password), "Current password is incorrect.", 403);
  check(verifySecondFactor(store, r.session.owner_id, b.code), "Authenticator or recovery code required/invalid.", 403);
}
export default {
  name: "payments",
  // Staff import and match bank statements; provider keys, the active provider
  // and the DuitNow QR stay with the owner.
  access: {
    staff: [
      ["POST", /^\/api\/payments\/bank\/(preview|import|layouts)$/],
      ["POST", /^\/api\/payments\/bank\/[\w-]+\/(apply|ai)$/],
    ],
  },
  migrations: [
    {
      name: "payments-001-options",
      sql: `CREATE TABLE payment_options(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
 INSERT INTO payment_options(id,data) VALUES(1,'{}');`,
    },
    {
      // Our own reference sent to the provider, the provider's transaction id,
      // and the last status check.
      name: "payments-002-online-payments",
      sql: `ALTER TABLE online_payments ADD COLUMN ref TEXT;
 ALTER TABLE online_payments ADD COLUMN provider_ref TEXT;
 ALTER TABLE online_payments ADD COLUMN checked TEXT;
 ALTER TABLE online_payments ADD COLUMN detail TEXT;
 CREATE INDEX online_payments_provider ON online_payments(provider,bill_id);
 CREATE UNIQUE INDEX online_payments_receipt ON online_payments(receipt_id) WHERE receipt_id IS NOT NULL;`,
    },
    {
      // Column mappings the owner saved for bank statement imports.
      name: "payments-003-bank-presets",
      sql: "CREATE TABLE bank_presets(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, mapping TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);",
    },
    {
      // The latest AI ranking the owner asked for, per bank transaction.
      name: "payments-004-bank-hints",
      sql: "CREATE TABLE bank_match_hints(transaction_id TEXT PRIMARY KEY REFERENCES bank_transactions(id) ON DELETE CASCADE, ranking TEXT NOT NULL, model TEXT NOT NULL, created TEXT NOT NULL);",
    },
  ],
  // Gateway keys, entered in Settings > Integration keys (the server environment wins).
  secrets: PROVIDER_ORDER.flatMap((n) =>
    PROVIDERS[n].keys.map((k) => ({ name: k.name, label: k.label, help: k.help, secret: k.secret !== false })),
  ),
  attach(Store) {
    Object.assign(Store.prototype, {
      paymentOptions() {
        const row = this.db.prepare("SELECT data FROM payment_options WHERE id=1").get();
        return row ? JSON.parse(row.data) : {};
      },
      savePaymentOptions(patch, action = "payments.settings.changed") {
        return this.tx(() => {
          const before = this.paymentOptions(),
            after = { ...before, ...patch };
          for (const [k, v] of Object.entries(after)) if (v === null || v === undefined) delete after[k];
          this.db.prepare("UPDATE payment_options SET data=? WHERE id=1").run(JSON.stringify(after));
          this.audit(action, null, Object.keys(patch).join(", "), before, after);
          return after;
        });
      },
      // --- DuitNow QR: a pasted static payload, or the QR image from the bank ---
      duitnowImage() {
        return this.files("payments", "duitnow", "duitnow_qr").at(-1) || null;
      },
      duitnow() {
        const o = this.paymentOptions().duitnow;
        const image = this.duitnowImage();
        if (!o?.payload && !image) return null;
        return { payload: o?.payload || null, merchant: o?.merchant || null, city: o?.city || null, image };
      },
      saveDuitnow(payload) {
        return this.tx(() => {
          if (payload === null || payload === "") {
            this.savePaymentOptions({ duitnow: null }, "payments.duitnow.removed");
            return null;
          }
          const v = validateDuitNow(payload);
          for (const f of this.files("payments", "duitnow", "duitnow_qr")) this.deleteFile(f.id);
          this.savePaymentOptions({ duitnow: { payload: v.payload, merchant: v.merchant, city: v.city, updated: new Date().toISOString() } }, "payments.duitnow.saved");
          return v;
        });
      },
      saveDuitnowImage(data, name) {
        return this.tx(() => {
          for (const f of this.files("payments", "duitnow", "duitnow_qr")) this.deleteFile(f.id);
          // PDFs can embed PNG and JPEG only.
          const f = this.saveFile(
            { entity_type: "payments", entity_id: "duitnow", purpose: "duitnow_qr", name: name || "duitnow-qr", data, visibility: "client" },
            { accept: ["image/png", "image/jpeg"], maxBytes: 2 * 1024 * 1024 },
          );
          this.savePaymentOptions({ duitnow: null }, "payments.duitnow.saved");
          return f;
        });
      },
      removeDuitnowImage() {
        for (const f of this.files("payments", "duitnow", "duitnow_qr")) this.deleteFile(f.id);
      },
      // --- Bank statements in each bank's own CSV layout ---
      bankPresets() {
        return this.db
          .prepare("SELECT id,name,mapping,updated FROM bank_presets ORDER BY name")
          .all()
          .map((p) => ({ ...p, mapping: JSON.parse(p.mapping) }));
      },
      saveBankPreset(b, rows) {
        const name = text(b.name, 60, true);
        const m = cleanMapping(b.mapping, Math.max(1, ...rows.map((r) => r.length)));
        const mapping = { ...m, names: mappingNames(m, rows) };
        const at = new Date().toISOString();
        this.db
          .prepare(
            "INSERT INTO bank_presets(id,name,mapping,created,updated) VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET mapping=excluded.mapping,updated=excluded.updated",
          )
          .run(id(), name, JSON.stringify(mapping), at, at);
        this.audit("bank.layout.saved", null, name, null, mapping);
        return this.bankPresets().find((p) => p.name === name);
      },
      deleteBankPreset(pid) {
        const p = this.db.prepare("SELECT name FROM bank_presets WHERE id=?").get(pid);
        check(p, "Layout not found.", 404);
        this.db.prepare("DELETE FROM bank_presets WHERE id=?").run(pid);
        this.audit("bank.layout.deleted", null, p.name);
      },
      // Detects (or applies) the column mapping and shows what would be imported.
      previewStatement(b) {
        check(typeof b.csv === "string" && b.csv.trim(), "Choose or paste a statement CSV.");
        const delimiter = b.mapping?.delimiter || detectDelimiter(b.csv);
        const rows = splitCsv(b.csv, delimiter);
        check(rows.length, "The file has no rows.");
        const layout = String(b.layout || "auto");
        let mapping,
          presetError = null;
        if (b.mapping && typeof b.mapping === "object") mapping = { ...b.mapping, delimiter };
        else if (layout.startsWith("preset:")) {
          const preset = this.bankPresets().find((p) => p.id === layout.slice(7));
          check(preset, "Saved layout not found.", 404);
          try {
            mapping = { ...presetToMapping(preset, rows), delimiter };
          } catch (e) {
            if (!(e instanceof AppError)) throw e;
            presetError = e.message;
            mapping = autoMapping(rows, { delimiter });
          }
        } else mapping = autoMapping(rows, { layout, delimiter });
        const width = Math.max(1, ...rows.map((r) => r.length));
        const headerRow = Number.isInteger(Number(mapping.headerRow)) ? Number(mapping.headerRow) : -1;
        const header = headerRow >= 0 ? rows[headerRow] || [] : [];
        const out = {
          layout,
          delimiter,
          headerRow,
          columns: Array.from({ length: width }, (_, i) => ({ index: i, label: header[i] || `Column ${i + 1}` })),
          sample: rows.slice(headerRow + 1, headerRow + 7).map((r) => r.map((v) => v.slice(0, 40))),
          lines: rows.slice(0, 12).map((r) => r.join(" | ").slice(0, 120)),
          mapping,
          rows: [],
          total: 0,
          fresh: 0,
          duplicates: 0,
          errors: [],
          errorCount: 0,
          skipped: 0,
          mappingError: null,
        };
        try {
          const parsed = parseStatement(b.csv, mapping, b.account || "MAIN");
          const preview = this.previewBankRows(parsed.rows);
          Object.assign(out, {
            mapping: { ...parsed.mapping },
            rows: preview.slice(0, 300).map(({ dedupe_key, source_id, ...r }) => r),
            total: preview.length,
            duplicates: preview.filter((r) => r.duplicate).length,
            fresh: preview.filter((r) => !r.duplicate).length,
            errors: parsed.errors.slice(0, 50),
            errorCount: parsed.errors.length,
            skipped: parsed.skipped,
          });
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          out.mappingError = e.message;
        }
        if (presetError) out.mappingError = presetError;
        return out;
      },
      importStatement(b) {
        check(b.mapping && typeof b.mapping === "object", "Preview the statement before importing.");
        const parsed = parseStatement(b.csv, b.mapping, b.account || "MAIN");
        check(parsed.rows.length, "No transactions were found with this mapping.");
        check(
          !parsed.errors.length || b.skipErrors === true,
          `${parsed.errors.length} row(s) could not be read. Fix the mapping, or choose to skip them.`,
        );
        const layout = BANK_LAYOUTS.find((l) => l.id === b.layout)?.name || (String(b.layout || "").startsWith("preset:") ? "saved layout" : "custom mapping");
        const result = this.importBankRows(parsed.rows, `Statement layout: ${layout}; ${parsed.errors.length} unreadable row(s) skipped.`);
        return { ...result, unreadable: parsed.errors.length };
      },
      // --- Smart bank matching ---
      bankMatchData() {
        const invoices = this.db
          .prepare("SELECT id FROM documents WHERE kind='invoice' AND state='issued'")
          .all()
          .map((x) => this.document(x.id))
          .filter((d) => d.balance > 0)
          .map((d) => ({
            id: d.id,
            number: d.number,
            client_id: d.client_id,
            client_name: d.client.name,
            balance: d.balance,
            total: d.adjusted_total ?? d.total,
            issue_date: d.issue_date,
            due_date: d.due_date,
          }));
        const receipts = this.db
          .prepare(
            "SELECT r.id,r.number,r.amount,r.account,r.reference,r.client_id,r.client_snapshot,r.paid_date FROM cash_receipts r WHERE r.voided=0 AND r.legacy_review=0 AND r.method='Bank transfer' AND NOT EXISTS(SELECT 1 FROM bank_transactions b WHERE b.receipt_id=r.id)",
          )
          .all()
          .map(({ client_snapshot, ...r }) => ({ ...r, client_name: JSON.parse(client_snapshot).name }));
        const proofs = this.db.prepare("SELECT id,invoice_id,reference FROM proofs WHERE status='pending'").all();
        return { invoices, receipts, proofs };
      },
      unmatchedCredits(limit = 150) {
        return this.db
          .prepare(
            "SELECT * FROM bank_transactions WHERE amount>0 AND receipt_id IS NULL AND refund_id IS NULL AND ignored_reason IS NULL ORDER BY txn_date DESC,created DESC LIMIT ?",
          )
          .all(limit);
      },
      bankSuggestions(limit = 150) {
        const data = this.bankMatchData();
        return Object.fromEntries(this.unmatchedCredits(limit).map((t) => [t.id, suggestMatches(t, data)]));
      },
      // One click: record the bank credit as a receipt and allocate it, or match
      // it to a receipt that was already recorded. Uses the normal ledger methods.
      applyBankMatch(tid, b) {
        return this.tx(() => {
          const t = this.db.prepare("SELECT * FROM bank_transactions WHERE id=?").get(tid);
          check(t, "Bank transaction not found.", 404);
          check(t.amount > 0 && !t.receipt_id && !t.refund_id && !t.ignored_reason, "Choose an unmatched bank credit.", 409);
          if (b.receipt_id) {
            this.matchBank(tid, { kind: "receipt", target_id: String(b.receipt_id) });
            this.audit("bank.suggestion.applied", tid, "Matched to an existing receipt", null, { receipt_id: b.receipt_id });
            return this.receipt(b.receipt_id);
          }
          check(Array.isArray(b.allocations) && b.allocations.length >= 1 && b.allocations.length <= 10, "Choose the invoices to allocate.");
          const docs = b.allocations.map((a) => this.document(String(a.invoice_id)));
          const client = docs[0].client_id;
          check(docs.every((d) => d.client_id === client && d.kind === "invoice" && d.state === "issued"), "Choose issued invoices of one client.");
          check(new Set(docs.map((d) => d.id)).size === docs.length, "Each invoice can be chosen once.");
          const amounts = b.allocations.map((a) => money(a.amount));
          check(amounts.every((a) => a > 0), "Allocation amounts must be positive.");
          check(amounts.reduce((s, a) => s + a, 0) <= t.amount, "The allocations are more than the bank credit.");
          const proof = b.proof_id
            ? this.db.prepare("SELECT * FROM proofs WHERE id=? AND status='pending'").get(String(b.proof_id))
            : null;
          check(!b.proof_id || (proof && docs.some((d) => d.id === proof.invoice_id)), "The submitted reference is not awaiting review on these invoices.");
          const receipt = this.recordBankReceipt(tid, { client_id: client, note: text(b.note || "Matched from the bank statement", 500) });
          docs.forEach((d, i) =>
            this.allocate(receipt.id, {
              invoice_id: d.id,
              amount: (amounts[i] / 100).toFixed(2),
              note: "Bank match",
              ...(proof && proof.invoice_id === d.id ? { proof_id: proof.id } : {}),
            }),
          );
          this.audit("bank.suggestion.applied", tid, docs.map((d) => d.number).join(", "), null, {
            receipt_id: receipt.id,
            allocations: docs.map((d, i) => ({ invoice_id: d.id, amount: amounts[i] })),
          });
          return this.receipt(receipt.id);
        });
      },
      bankHints() {
        return Object.fromEntries(
          this.db
            .prepare("SELECT transaction_id,ranking,model,created FROM bank_match_hints")
            .all()
            .map((h) => [h.transaction_id, { ranking: JSON.parse(h.ranking), model: h.model, created: h.created }]),
        );
      },
      // The PDF block for an unpaid invoice; the invoice number is the reference.
      duitnowBlock(d) {
        const dn = this.duitnow();
        if (!dn) return null;
        const text = `Scan with your banking or e-wallet app${dn.merchant ? ` to pay ${dn.merchant}` : ""}. Enter the amount (${currency(d.balance)}) and use ${d.number} as the reference.`;
        if (dn.payload) return { heading: "Pay with DuitNow QR", qr: dn.payload, qrSize: 110, text };
        const f = this.file(dn.image.id);
        return { heading: "Pay with DuitNow QR", image: f.data, imageWidth: 120, imageHeight: 160, text };
      },
    });
    // Payment slips are files linked to the client's pending reference (proof).
    // Owners see them on each proof; client pages only learn that one exists.
    const originalHydrate = Store.prototype.hydrate;
    Store.prototype.hydrate = function (row) {
      const d = originalHydrate.call(this, row);
      if (!d.proofs?.length) return d;
      const files = this.db
        .prepare(
          "SELECT f.id,f.entity_id,f.name,f.mime,f.size,f.created FROM files f JOIN proofs p ON p.id=f.entity_id WHERE f.entity_type='proof' AND f.purpose='payment_slip' AND p.invoice_id=? ORDER BY f.created,f.id",
        )
        .all(row.id);
      d.proofs = d.proofs.map((p) => {
        const mine = files.filter((f) => f.entity_id === p.id).map(({ entity_id, ...f }) => f);
        return { ...p, files: mine, slip: mine.length > 0 };
      });
      return d;
    };
    const originalBlocks = Store.prototype.pdfBlocks;
    Store.prototype.pdfBlocks = async function (d) {
      const blocks = [...((await originalBlocks.call(this, d)) || [])];
      if (d?.kind === "invoice" && d.state === "issued" && d.balance > 0 && d.number) {
        const b = this.duitnowBlock(d);
        if (b) blocks.push(b);
      }
      return blocks;
    };
  },
  init(ctx) {
    ctx.services.payments = { gateway: ctx.gateway };
  },
  routes: {
    async guest(r) {
      const { store, gateway, appUrl } = r.ctx;
      const { path, method } = r;
      // --- Client link: start a payment and come back from the provider ---
      const pub = path.match(/^\/api\/public\/([\w-]+)\/(checkout|payment-return)$/);
      if (pub && method === "POST") {
        const [, token, action] = pub;
        actor("client-link");
        r.allow("public:" + r.ip, 120, 60000);
        if (action === "checkout") {
          r.allow("checkout:" + r.ip, 10, 60000);
          return r.send(200, await gateway.checkout(token, appUrl)), true;
        }
        r.allow("submit:" + r.ip, 12, 60000);
        const d = store.publicDocument(token);
        const b = await r.body();
        let row;
        if (b.params && typeof b.params === "object") {
          // Billplz redirect: signed billplz[...] query values.
          const params = Object.fromEntries(
            Object.entries(b.params)
              .filter(([k, v]) => /^billplz\[[a-z_]+\]$/.test(k) && typeof v === "string")
              .slice(0, 10),
          );
          const { id, paidAt } = gateway.verify(params);
          row = store.db.prepare("SELECT * FROM online_payments WHERE provider='billplz' AND bill_id=? AND invoice_id=?").get(id, d.id);
          check(row, "Payment not found.", 404);
          return r.send(200, { state: (await gateway.settle(id, paidAt, "billplz")).state }), true;
        }
        // Other providers: the redirect is not trusted; the payment must be one we
        // started for this invoice, and its state is read back from the provider.
        const provider = String(b.provider || "");
        check(PROVIDERS[provider], "Unknown payment provider.", 400);
        const ref = typeof b.reference === "string" ? b.reference.slice(0, 200) : null;
        row = ref
          ? store.db.prepare("SELECT * FROM online_payments WHERE provider=? AND bill_id=? AND invoice_id=?").get(provider, ref, d.id)
          : store.db.prepare("SELECT * FROM online_payments WHERE provider=? AND invoice_id=? ORDER BY created DESC").get(provider, d.id);
        check(row, "Payment not found.", 404);
        return r.send(200, { state: (await gateway.settle(row.bill_id, null, provider)).state }), true;
      }
      // --- Signed provider notifications (no browser origin check) ---
      const hook = path.match(/^\/api\/hooks\/payments\/(billplz|toyyibpay|stripe|ipay88)(\/return\/([\w-]+))?$/);
      if (hook && method === "POST") {
        const [, provider, isReturn, token] = hook;
        actor("gateway:" + provider);
        r.allow("gateway:" + r.ip, 120, 60000);
        const { config } = gateway.providerConfig(provider);
        if (provider === "billplz") {
          const params = await formBody(r);
          const notice = gateway.verify(params);
          await gateway.settle(notice.id, notice.paidAt, "billplz").catch((e) => {
            // A validly signed notice for a bill this app did not create needs no retries.
            if (e.status !== 404) throw e;
          });
          return plain(r, 200, "OK"), true;
        }
        if (provider === "toyyibpay") {
          check(config, "Online payment is not configured.", 404);
          const params = await formBody(r);
          const notice = PROVIDERS.toyyibpay.verify(params, config);
          const row = gateway.row(notice.id, "toyyibpay");
          if (!row) return plain(r, 200, "OK"), true;
          check(!notice.orderId || !row.ref || notice.orderId === row.ref, "Payment reference does not match.", 400);
          if (notice.status === "1") await gateway.settle(row.bill_id, null, "toyyibpay");
          return plain(r, 200, "OK"), true;
        }
        if (provider === "stripe") {
          check(config, "Online payment is not configured.", 503);
          const raw = (await r.rawBody(256000)).toString("utf8");
          const event = verifyStripeWebhook(raw, r.req.headers["stripe-signature"], config.webhookSecret);
          if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
            const id = event.data?.object?.id;
            check(typeof id === "string" && /^cs_/.test(id), "Invalid Stripe event.", 400);
            await gateway.settle(id, klDate(event.created), "stripe").catch((e) => {
              if (e.status !== 404) throw e;
            });
          }
          return r.send(200, { received: true }), true;
        }
        // iPay88: the browser return (ResponseURL) and the server post (BackendURL).
        if (isReturn) {
          check(TOKEN.test(token), "Not found.", 404);
          let result = "error";
          try {
            check(config, "Online payment is not configured.", 404);
            const notice = PROVIDERS.ipay88.verify(await formBody(r), config);
            const row = gateway.row(notice.id, "ipay88");
            if (row && notice.status === "1" && notice.amount === row.amount)
              result = (await gateway.settle(row.bill_id, notice, "ipay88")).state;
            else result = notice.status === "1" ? "pending" : "failed";
          } catch (e) {
            if (!(e instanceof AppError)) throw e;
          }
          r.res.writeHead(303, { Location: `/client/${token}?payment=ipay88&result=${result}`, "Cache-Control": "no-store" });
          r.res.end();
          return true;
        }
        check(config, "Online payment is not configured.", 404);
        const notice = PROVIDERS.ipay88.verify(await formBody(r), config);
        const row = gateway.row(notice.id, "ipay88");
        if (!row || notice.status !== "1") return plain(r, 200, "RECEIVEOK"), true;
        if (notice.amount !== row.amount) {
          store.audit("online_payment.mismatch", row.invoice_id, `iPay88 ${row.bill_id}: posted ${notice.amount} sen, expected ${row.amount} sen`);
          return plain(r, 200, "RECEIVEOK"), true;
        }
        const settled = await gateway.settle(row.bill_id, notice, "ipay88");
        // iPay88 retries until it reads RECEIVEOK; ask again while re-query is pending.
        return plain(r, settled.state === "paid" ? 200 : 503, settled.state === "paid" ? "RECEIVEOK" : "PENDING"), true;
      }
      // --- Payment slip: a transaction reference with the client's slip (raw upload) ---
      const slip = path.match(/^\/api\/guest\/payments\/slip\/([\w-]+)$/);
      if (slip && method === "POST") {
        actor("client-link");
        r.allow("public:" + r.ip, 120, 60000);
        r.allow("slip:" + r.ip, 6, 600000);
        const token = slip[1];
        check(TOKEN.test(token), "Link unavailable.", 404);
        const size = Number(r.req.headers["content-length"] || 0);
        check(size <= SLIP_BYTES, "Slips must be 5 MB or smaller.", 413);
        // The link must be valid before the upload is read.
        const d = store.publicDocument(token);
        check(payable(d), "This invoice is not awaiting payment.", 409);
        const data = await r.rawBody(SLIP_BYTES);
        const q = r.url.searchParams;
        const result = store.tx(() => {
          const p = store.proof(token, { reference: q.get("reference") || "", note: q.get("note") || "" });
          const f = store.saveFile(
            { entity_type: "proof", entity_id: p.id, purpose: "payment_slip", name: q.get("name") || "payment-slip", data, visibility: "private" },
            { accept: ["image/png", "image/jpeg", "image/webp", "application/pdf"], maxBytes: SLIP_BYTES },
          );
          store.audit("payment.slip.uploaded", d.id, `${p.reference}: ${f.name}`);
          return { reference: p.reference, status: "pending", created: p.created, slip: true };
        });
        return r.send(201, result), true;
      }
      // --- DuitNow QR image for an invoice awaiting payment ---
      const qr = path.match(/^\/api\/guest\/payments\/duitnow\/([\w-]+)$/);
      if (qr && method === "GET") {
        actor("client-link");
        r.allow("public:" + r.ip, 120, 60000);
        const d = store.publicDocument(qr[1]);
        const image = payable(d) && store.duitnowImage();
        check(image, "Not found.", 404);
        r.sendFile(store.file(image.id), r.url);
        return true;
      }
      // --- iPay88: our page that posts the signed form to iPay88 ---
      const go = path.match(/^\/api\/guest\/payments\/ipay88\/([\w-]{36})$/);
      if (go && method === "GET") {
        actor("client-link");
        r.allow("public:" + r.ip, 120, 60000);
        const token = r.url.searchParams.get("t") || "";
        const d = store.publicDocument(token);
        const row = store.db
          .prepare("SELECT * FROM online_payments WHERE id=? AND provider='ipay88' AND invoice_id=? AND state='pending'")
          .get(go[1], d.id);
        check(row, "This payment link has expired. Go back to the invoice and choose Pay online again.", 404);
        const { config } = gateway.providerConfig("ipay88");
        check(config, "Online payment is not available for this invoice.", 503);
        const fields = PROVIDERS.ipay88.fields({ config, row, doc: d, business: store.settings(), origin: appUrl, token });
        r.send(200, PROVIDERS.ipay88.page(config, fields), {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": `default-src 'none'; style-src 'self'; img-src 'self'; script-src '${IPAY88_SCRIPT_HASH}'; form-action https:; base-uri 'none'; frame-ancestors 'none'`,
          // iPay88 checks that the request comes from the registered site.
          "Referrer-Policy": "origin",
        });
        return true;
      }
    },
    async owner(r) {
      const { store, gateway } = r.ctx;
      const { path, method } = r;
      const bank = path.match(/^\/api\/payments\/bank\/([\w-]{36})\/(apply|ai)$/);
      if (bank && method === "POST" && bank[2] === "apply") {
        const b = await r.body();
        return r.send(201, r.write("bank.apply:" + bank[1], b, () => store.applyBankMatch(bank[1], b))), true;
      }
      if (bank && method === "POST" && bank[2] === "ai") {
        r.allow("bank-ai:" + r.session.owner_id, 20, 600000);
        const b = await r.body();
        check(b.consent === true, "Confirm sending this bank line and the candidate invoices to your AI provider.");
        const t = store.db
          .prepare("SELECT * FROM bank_transactions WHERE id=? AND amount>0 AND receipt_id IS NULL AND refund_id IS NULL AND ignored_reason IS NULL")
          .get(bank[1]);
        check(t, "Choose an unmatched bank credit.", 409);
        const data = store.bankMatchData();
        // The local suggestions first, then invoices with the nearest balances.
        const local = suggestMatches(t, data, { limit: 8, min: 1 }).flatMap((s) => s.invoices.map((i) => i.id));
        const ids = [...new Set([...local, ...[...data.invoices].sort((x, y) => Math.abs(x.balance - t.amount) - Math.abs(y.balance - t.amount)).map((i) => i.id)])].slice(0, 8);
        const assistant = r.ctx.assistant;
        const result = await rankWithAi({
          config: assistant?.config,
          fetcher: assistant?.fetcher,
          t,
          candidates: ids.map((x) => data.invoices.find((i) => i.id === x)),
        });
        const model = assistant.config.model;
        store.db
          .prepare("INSERT INTO bank_match_hints(transaction_id,ranking,model,created) VALUES(?,?,?,?) ON CONFLICT(transaction_id) DO UPDATE SET ranking=excluded.ranking,model=excluded.model,created=excluded.created")
          .run(t.id, JSON.stringify(result.ranking), model, new Date().toISOString());
        store.audit("bank.ai.ranked", t.id, `${ids.length} candidate invoice(s) sent to ${new URL(assistant.config.base).origin} (${model})`);
        return r.send(200, { ...result, model }), true;
      }
      if (path === "/api/payments/bank/preview" && method === "POST")
        return r.send(200, store.previewStatement(await bigJson(r, 900000))), true;
      if (path === "/api/payments/bank/import" && method === "POST") {
        const b = await bigJson(r, 900000);
        return r.send(201, r.write("bank.statement.import", b, () => store.importStatement(b))), true;
      }
      if (path === "/api/payments/bank/layouts" && method === "POST") {
        const b = await bigJson(r, 900000);
        check(typeof b.csv === "string", "Preview the statement before saving its layout.");
        const rows = splitCsv(b.csv, b.mapping?.delimiter || detectDelimiter(b.csv));
        return r.send(201, store.saveBankPreset(b, rows)), true;
      }
      const layout = path.match(/^\/api\/payments\/bank\/layouts\/([\w-]+)$/);
      if (layout && method === "DELETE") {
        store.deleteBankPreset(layout[1]);
        return r.send(200, { ok: true }), true;
      }
      if (path === "/api/payments/duitnow" && method === "PUT") {
        const b = await r.body();
        store.saveDuitnow(b.payload ?? null);
        return r.send(200, duitnowState(store)), true;
      }
      if (path === "/api/payments/duitnow/image" && method === "POST") {
        r.allow("upload:" + r.session.owner_id, 60, 600000);
        store.saveDuitnowImage(await r.rawBody(2 * 1024 * 1024), r.url.searchParams.get("name") || "duitnow-qr");
        return r.send(201, duitnowState(store)), true;
      }
      if (path === "/api/payments/duitnow/image" && method === "DELETE") {
        store.removeDuitnowImage();
        return r.send(200, duitnowState(store)), true;
      }
      if (path === "/api/payments/provider" && method === "PUT") {
        const b = await r.body();
        const provider = b.provider === null || b.provider === "" || b.provider === "auto" ? null : String(b.provider);
        check(provider === null || provider === "off" || PROVIDERS[provider], "Unknown payment provider.");
        if (provider && provider !== "off")
          check(gateway.providerConfig(provider).config, "Enter and test this provider's keys first.", 409);
        store.savePaymentOptions({ provider }, "payments.provider.changed");
        return r.send(200, gateway.status()), true;
      }
      const keys = path.match(/^\/api\/payments\/providers\/([a-z0-9]+)(\/test)?$/);
      if (keys && method === "POST" && keys[2]) {
        r.allow("payment-test:" + r.session.owner_id, 20, 600000);
        return r.send(200, await gateway.test(keys[1])), true;
      }
      if (keys && method === "PUT" && !keys[2]) {
        // Several keys at once; needs the password again, like Settings > Integration keys.
        r.allow("secret:" + r.session.owner_id, 20, 600000);
        const p = PROVIDERS[keys[1]];
        check(p, "Unknown payment provider.", 404);
        const b = await r.body();
        await confirmOwner(r, b);
        const values = b.values && typeof b.values === "object" ? b.values : {};
        store.tx(() => {
          for (const k of p.keys) {
            if (gateway.env[k.name]) continue;
            if (k.flag) {
              if (typeof b.sandbox === "boolean" && k.name.endsWith("_SANDBOX")) store.setSecret(k.name, b.sandbox ? "true" : null);
              continue;
            }
            const v = values[k.name];
            if (v === null) store.setSecret(k.name, null);
            else if (typeof v === "string" && v.trim()) store.setSecret(k.name, text(v, 8000, true));
          }
        });
        return r.send(200, gateway.status()), true;
      }
    },
  },
  // Re-checks recent pending payments, in case a callback never arrived.
  jobs: [
    {
      name: "recheck",
      every: 15 * 60000,
      delay: 60000,
      async run(ctx) {
        const { store, gateway } = ctx;
        const since = new Date(Date.now() - 2 * 86400000).toISOString();
        const rows = store.db
          .prepare("SELECT * FROM online_payments WHERE state='pending' AND created>? ORDER BY created DESC LIMIT 50")
          .all(since);
        let checked = 0,
          paid = 0;
        for (const row of rows) {
          // Young payments every run; older ones every two hours.
          const age = Date.now() - Date.parse(row.created);
          const last = row.checked ? Date.now() - Date.parse(row.checked) : Infinity;
          if (last < (age < 3600000 ? 10 * 60000 : 2 * 3600000)) continue;
          if (!gateway.providerConfig(row.provider).config) continue;
          if (checked >= 20) break;
          checked++;
          try {
            if ((await gateway.settle(row.bill_id, null, row.provider)).state === "paid") paid++;
          } catch {
            // Logged on the row / in the audit by settle(); try again next run.
          }
        }
        return { checked, paid };
      },
    },
  ],
  workspace(r) {
    const base = r.ctx.appUrl;
    return {
      hooks: {
        billplz: `${base}/api/payments/billplz/callback`,
        toyyibpay: `${base}/api/hooks/payments/toyyibpay`,
        stripe: `${base}/api/hooks/payments/stripe`,
        ipay88: `${base}/api/hooks/payments/ipay88`,
      },
      origin: base,
      duitnow: duitnowState(r.ctx.store),
      bankLayouts: BANK_LAYOUTS,
      dateFormats: DATE_FORMATS,
      bankPresets: r.ctx.store.bankPresets().map(({ id, name, updated }) => ({ id, name, updated })),
      suggestions: r.ctx.store.bankSuggestions(),
      hints: r.ctx.store.bankHints(),
      ai: !!r.ctx.assistant?.config,
    };
  },
  // Client-safe extras on the client link: the DuitNow QR while payment is due.
  publicDocument(d, r) {
    if (!payable(d)) return { slip: false, duitnow: null };
    const dn = r.ctx.store.duitnow();
    return {
      slip: true,
      duitnow: dn
        ? { qr: dn.payload ? qrDataUri(dn.payload) : null, image: !dn.payload && !!dn.image, merchant: dn.merchant || null }
        : null,
    };
  },
  // Business export: the provider choice, the DuitNow payload and saved
  // statement layouts. Keys stay out (they live in Settings, encrypted).
  exportData(store) {
    return { options: store.paymentOptions(), bankLayouts: store.bankPresets() };
  },
  // Demo bank lines with the kind of messy references real statements have.
  seedDemo(store) {
    const open = store.db
      .prepare("SELECT id FROM documents WHERE kind='invoice' AND state='issued' ORDER BY number")
      .all()
      .map((x) => store.document(x.id))
      .filter((d) => d.balance > 0);
    const day = store.workspace().today;
    const rows = open.slice(0, 2).map((d, i) => {
      const [, y, n] = d.number.match(/-(\d{4})-0*(\d+)$/) || [];
      const words = d.client.name.replace(/\(Demo\)/, "").trim().toUpperCase();
      return i === 0
        ? { reference: "IBG CREDIT", description: `${words.split(" ")[0]} DIGI INV${y} ${n}`, amount: d.balance }
        : { reference: `DUITNOW TRF ${words}`, description: "PAYMENT", amount: d.balance };
    });
    rows.push({ reference: "CDM CASH DEPOSIT", description: "", amount: 45000 }, { reference: "JOMPAY TNB", description: "Electricity", amount: -12050 });
    store.importBankRows(
      rows.map((r, i) => {
        const row = { account: "MAIN", txn_date: day, ...r };
        return { ...row, dedupe_key: bankRowKey("MAIN", { ...row, source_id: "demo-" + i }) };
      }),
      "Demo statement.",
    );
  },
};
