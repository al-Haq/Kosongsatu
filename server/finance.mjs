import { randomBytes } from "node:crypto";
import {
  id,
  hash,
  now,
  today,
  check,
  money,
  text,
  date,
  integer,
  status,
} from "./domain.mjs";
function normal(value) {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}
export const receiptKey = (b) =>
  hash(
    `${normal(b.account || "MAIN")}|${b.method}|${b.paid_date}|${normal(b.reference)}`,
  );
export function attachFinance(Store) {
  const originalClient = Store.prototype.saveClient,
    originalService = Store.prototype.saveService,
    originalDraft = Store.prototype.saveDocument;
  const originalHydrate = Store.prototype.hydrate,
    originalIssue = Store.prototype.issue,
    originalSettings = Store.prototype.saveSettings,
    originalVoid = Store.prototype.void;
  Object.assign(Store.prototype, {
    saveClient(b, idv) {
      return this.tx(() => {
        const before = idv
          ? this.db.prepare("SELECT * FROM clients WHERE id=?").get(idv) || null
          : null;
        const out = originalClient.call(this, b, idv);
        this.audit(
          "client.changed",
          out.id,
          "Billing contact changes",
          before,
          out,
        );
        return out;
      });
    },
    saveService(b, idv) {
      return this.tx(() => {
        const before = idv
          ? this.db.prepare("SELECT * FROM services WHERE id=?").get(idv) ||
            null
          : null;
        const out = originalService.call(this, b, idv);
        this.audit("service.changed", out.id, "Catalog changes", before, out);
        return out;
      });
    },
    saveDocument(b, idv) {
      return this.tx(() => {
        const pick = (d) =>
          d
            ? {
                client_id: d.client_id,
                items: d.items,
                issue_date: d.issue_date,
                due_date: d.due_date,
                total: d.total,
                discount: d.discount,
                notes: d.notes,
                terms: d.terms,
              }
            : null;
        const before = idv ? pick(this.document(idv)) : null;
        const out = originalDraft.call(this, b, idv);
        this.audit(
          "draft.changed",
          out.id,
          "Draft content changes",
          before,
          pick(out),
        );
        return out;
      });
    },
    number(prefix, day = today()) {
      const key = `serial:${prefix}:${day.slice(0, 4)}`;
      this.db
        .prepare(
          "INSERT INTO counters(key,value) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET value=value+1",
        )
        .run(key);
      return `${prefix}-${day.slice(0, 4)}-${String(this.db.prepare("SELECT value FROM counters WHERE key=?").get(key).value).padStart(5, "0")}`;
    },
    idempotent(scope, key, payload, fn) {
      if (!key) return fn();
      check(
        typeof key === "string" && /^[\w-]{16,100}$/.test(key),
        "Invalid request key.",
      );
      return this.tx(() => {
        const fingerprint = hash(JSON.stringify(payload));
        const old = this.db
          .prepare("SELECT * FROM idempotency WHERE scope=? AND key=?")
          .get(scope, key);
        if (old) {
          check(
            old.fingerprint === fingerprint,
            "Request key was used with different data.",
            409,
          );
          return JSON.parse(old.result);
        }
        const result = fn();
        this.db
          .prepare("INSERT INTO idempotency VALUES(?,?,?,?,?)")
          .run(scope, key, fingerprint, JSON.stringify(result), now());
        return result;
      });
    },
    saveSettings(b) {
      return this.tx(() => {
        const old = this.settings(),
          next = originalSettings.call(this, b);
        check(
          !["CN", "DN", "RC", "RF"].includes(next.invoicePrefix) &&
            !["CN", "DN", "RC", "RF"].includes(next.quotePrefix),
          "CN, DN, RC and RF are reserved for financial notes and receipts.",
        );
        check(
          !next.email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email),
          "Enter a valid billing email.",
        );
        check(
          next.invoicePrefix !== next.quotePrefix,
          "Invoice and quotation prefixes must be different.",
        );
        const out = next;
        this.audit(
          "settings.changed",
          null,
          "Company/default changes",
          old,
          out,
        );
        return out;
      });
    },
    issue(idv) {
      return this.tx(() => {
        const d = this.document(idv),
          business = this.settings();
        check(
          business.invoicePrefix !== business.quotePrefix,
          "Change the colliding invoice/quotation prefixes in Settings.",
          409,
        );
        if (!business.demo)
          check(
            business.registration &&
              business.address &&
              (business.email || business.phone),
            "Before issuing, complete registration, business address and a contact in Settings.",
          );
        check(d.client.name.trim(), "A billing client name is required.");
        check(
          !this.db
            .prepare("SELECT 1 FROM documents WHERE number=?")
            .get(
              `${d.kind === "invoice" ? business.invoicePrefix : business.quotePrefix}-${d.issue_date.slice(0, 4)}-${String((this.db.prepare("SELECT value FROM counters WHERE key=?").get(`${d.kind}-${d.issue_date.slice(0, 4)}`)?.value || 0) + 1).padStart(4, "0")}`,
            ),
          "The next document number is already in use. Review numbering settings.",
          409,
        );
        return originalIssue.call(this, idv);
      });
    },
    hydrate(row) {
      const d = originalHydrate.call(this, row);
      const adjustments = this.db
        .prepare(
          "SELECT * FROM adjustments WHERE invoice_id=? ORDER BY created",
        )
        .all(row.id);
      const credit = adjustments
          .filter((a) => a.kind === "credit")
          .reduce((s, a) => s + a.amount, 0),
        debit = adjustments
          .filter((a) => a.kind === "debit")
          .reduce((s, a) => s + a.amount, 0);
      const payments = d.payments.map((p) => {
        const released = this.db
          .prepare(
            "SELECT COALESCE(sum(amount),0) amount FROM allocation_releases WHERE payment_id=?",
          )
          .get(p.id).amount;
        return {
          ...p,
          released,
          applied: p.reversed ? 0 : p.amount - released,
        };
      });
      const paid = payments.reduce((sum, p) => sum + p.applied, 0),
        adjusted_total = d.total + debit - credit;
      return {
        ...d,
        adjustments,
        credit,
        debit,
        adjusted_total,
        paid,
        balance: Math.max(0, adjusted_total - paid),
        payments,
        status:
          adjusted_total === 0 && credit > 0
            ? "Credited"
            : status({ ...row, total: adjusted_total }, paid),
        collection_status:
          paid >= adjusted_total
            ? "Settled"
            : paid > 0
              ? "Part-paid"
              : "Unpaid",
      };
    },
    receipt(rid) {
      const r = this.db
        .prepare("SELECT * FROM cash_receipts WHERE id=?")
        .get(rid);
      check(r, "Receipt not found.", 404);
      const allocations = this.db
        .prepare(
          "SELECT * FROM payments WHERE receipt_id=? ORDER BY created,id",
        )
        .all(rid)
        .map((p) => {
          const released = this.db
            .prepare(
              "SELECT COALESCE(sum(amount),0) amount FROM allocation_releases WHERE payment_id=?",
            )
            .get(p.id).amount;
          return {
            ...p,
            released,
            applied: p.reversed ? 0 : p.amount - released,
          };
        });
      const refunds = this.db
        .prepare("SELECT * FROM refunds WHERE receipt_id=? ORDER BY created")
        .all(rid);
      const refunded = refunds.reduce((s, r) => s + r.amount, 0),
        allocated = allocations.reduce((s, p) => s + p.applied, 0);
      return {
        ...r,
        allocations,
        refunds,
        refunded,
        allocated,
        available: r.voided ? 0 : r.amount - refunded - allocated,
        client: JSON.parse(r.client_snapshot),
        business: JSON.parse(r.business_snapshot),
      };
    },
    receipts() {
      return this.db
        .prepare("SELECT id FROM cash_receipts ORDER BY created DESC,id")
        .all()
        .map((r) => this.receipt(r.id));
    },
    receive(b) {
      return this.tx(() => {
        this.client(b.client_id);
        const amount = money(b.amount);
        check(amount > 0, "Receipt amount must be positive.");
        const paid_date = date(b.paid_date);
        check(paid_date <= today(), "Receipt cannot be future-dated.");
        const method = text(b.method, 40, true);
        check(
          ["Bank transfer", "Cash", "Card", "Other"].includes(method),
          "Invalid method.",
        );
        const reference = text(b.reference, 120, true);
        const account = text(b.account || "MAIN", 80, true);
        const dedupe_key = receiptKey({
          method,
          paid_date,
          reference,
          account,
        });
        check(
          !this.db
            .prepare(
              "SELECT id FROM cash_receipts WHERE dedupe_key=? AND voided=0",
            )
            .get(dedupe_key),
          "This transaction is already recorded. Allocate its existing receipt instead.",
          409,
        );
        const receipt = {
          id: id(),
          client_id: b.client_id,
          number: this.number("RC", paid_date),
          amount,
          paid_date,
          method,
          account,
          reference,
          note: text(b.note || "", 500),
          dedupe_key,
          business_snapshot: JSON.stringify(this.settings()),
          client_snapshot: JSON.stringify(this.client(b.client_id)),
          created: now(),
        };
        this.db
          .prepare(
            "INSERT INTO cash_receipts(id,client_id,number,amount,paid_date,method,account,reference,note,dedupe_key,business_snapshot,client_snapshot,created) VALUES(:id,:client_id,:number,:amount,:paid_date,:method,:account,:reference,:note,:dedupe_key,:business_snapshot,:client_snapshot,:created)",
          )
          .run(receipt);
        if (b.allocations) {
          check(
            Array.isArray(b.allocations) && b.allocations.length <= 50,
            "Invalid allocations.",
          );
          for (const a of b.allocations) this.allocate(receipt.id, a);
        }
        this.audit(
          "receipt.received",
          receipt.id,
          `${receipt.number}: ${amount} sen`,
          null,
          { amount, reference, client_id: b.client_id },
        );
        return this.receipt(receipt.id);
      });
    },
    allocate(rid, b) {
      return this.tx(() => {
        const r = this.receipt(rid),
          d = this.document(b.invoice_id);
        check(!r.voided, "Receipt is void.");
        check(
          !r.legacy_review,
          "Review this legacy duplicate transaction first.",
        );
        check(
          d.kind === "invoice" &&
            d.state === "issued" &&
            d.client_id === r.client_id,
          "Choose an issued invoice for the same client.",
        );
        const amount = money(b.amount);
        check(
          amount > 0 && amount <= r.available && amount <= d.balance,
          "Allocation exceeds the available receipt or invoice balance.",
        );
        if (b.proof_id)
          check(
            this.db
              .prepare(
                "SELECT id FROM proofs WHERE id=? AND invoice_id=? AND status='pending'",
              )
              .get(b.proof_id, d.id),
            "The submitted reference is not awaiting review on this invoice.",
          );
        const p = {
          id: id(),
          invoice_id: d.id,
          amount,
          paid_date: r.paid_date,
          method: r.method,
          reference: `${r.reference} [${id().slice(0, 8)}]`,
          note: text(b.note || "", 500),
          receipt_id: rid,
          proof_id: b.proof_id || null,
          created: now(),
        };
        this.db
          .prepare(
            "INSERT INTO payments(id,invoice_id,amount,paid_date,method,reference,note,receipt_id,proof_id,created) VALUES(:id,:invoice_id,:amount,:paid_date,:method,:reference,:note,:receipt_id,:proof_id,:created)",
          )
          .run(p);
        if (p.proof_id)
          this.db
            .prepare("UPDATE proofs SET status='confirmed' WHERE id=?")
            .run(p.proof_id);
        this.audit(
          "payment.allocated",
          d.id,
          `${r.number}: ${amount} sen`,
          null,
          { payment_id: p.id, receipt_id: rid, amount },
        );
        return { ...p, applied: amount, released: 0 };
      });
    },
    recordPayment(invoiceId, b) {
      return this.tx(() => {
        const d = this.document(invoiceId);
        check(
          d.kind === "invoice" && d.state === "issued",
          "Payments require an issued invoice.",
        );
        const amount = money(b.amount);
        check(
          amount > 0 && amount <= d.balance,
          "Payment must be positive and cannot exceed remaining balance.",
        );
        const r = this.receive({
          ...b,
          client_id: d.client_id,
          allocations: [
            {
              invoice_id: invoiceId,
              amount: b.amount,
              proof_id: b.proof_id || null,
              note: b.note || "",
            },
          ],
        });
        return this.document(invoiceId).payments.find(
          (p) => p.receipt_id === r.id,
        );
      });
    },
    reverse(pid, reason) {
      return this.tx(() => {
        const p = this.db.prepare("SELECT * FROM payments WHERE id=?").get(pid);
        check(p && !p.reversed, "Active payment not found.", 404);
        reason = text(reason, 500, true);
        this.db
          .prepare(
            "UPDATE payments SET reversed=1,reversal_reason=? WHERE id=?",
          )
          .run(reason, pid);
        if (p.proof_id)
          this.db
            .prepare("UPDATE proofs SET status='pending' WHERE id=?")
            .run(p.proof_id);
        this.audit(
          "payment.allocation.reversed",
          p.invoice_id,
          reason,
          { payment_id: pid, amount: p.amount },
          { applied: 0 },
        );
        return this.receipt(p.receipt_id);
      });
    },
    voidReceipt(rid, reason) {
      return this.tx(() => {
        const r = this.receipt(rid);
        reason = text(reason, 500, true);
        check(
          !r.voided && r.allocated === 0 && r.refunded === 0,
          "Only an unallocated, non-refunded receipt can be voided. Reverse allocations first.",
        );
        check(
          !this.db
            .prepare("SELECT id FROM bank_transactions WHERE receipt_id=?")
            .get(rid),
          "Unmatch the bank transaction before voiding.",
        );
        this.db
          .prepare("UPDATE cash_receipts SET voided=1 WHERE id=?")
          .run(rid);
        this.audit("receipt.voided", rid, reason, { voided: 0 }, { voided: 1 });
      });
    },
    adjustment(invoiceId, b) {
      return this.tx(() => {
        const d = this.document(invoiceId);
        check(
          d.kind === "invoice" && d.state === "issued",
          "Adjustments require an issued invoice.",
        );
        check(["credit", "debit"].includes(b.kind), "Choose credit or debit.");
        const amount = money(b.amount),
          issue_date = date(b.issue_date || today());
        check(
          amount > 0 && issue_date >= d.issue_date && issue_date <= today(),
          "Adjustment must be positive and dated between the invoice issue date and today.",
        );
        check(
          b.kind !== "credit" || amount <= d.adjusted_total,
          "Credit exceeds the remaining invoice value.",
        );
        check(
          b.kind !== "debit" || d.adjusted_total + amount <= 9999999999,
          "Adjusted total is too large.",
        );
        const a = {
          id: id(),
          invoice_id: invoiceId,
          kind: b.kind,
          number: this.number(b.kind === "credit" ? "CN" : "DN", issue_date),
          amount,
          reason: text(b.reason, 1000, true),
          issue_date,
          created: now(),
        };
        this.db
          .prepare(
            "INSERT INTO adjustments(id,invoice_id,kind,number,amount,reason,issue_date,created) VALUES(:id,:invoice_id,:kind,:number,:amount,:reason,:issue_date,:created)",
          )
          .run(a);
        let excess = Math.max(
          0,
          d.paid - (d.adjusted_total + (b.kind === "debit" ? amount : -amount)),
        );
        // Release over-applied cash back to the customer's original receipts. No new cash is invented.
        for (const p of d.payments) {
          if (!excess) break;
          const release = Math.min(excess, p.applied);
          if (release > 0) {
            this.db
              .prepare("INSERT INTO allocation_releases VALUES(?,?,?,?,?,?)")
              .run(id(), p.id, release, a.reason, a.id, now());
            excess -= release;
          }
        }
        this.audit(
          `invoice.${b.kind}.issued`,
          invoiceId,
          a.reason,
          { adjusted_total: d.adjusted_total },
          {
            adjustment: a.number,
            amount,
            adjusted_total: this.document(invoiceId).adjusted_total,
          },
        );
        return a;
      });
    },
    refund(rid, b) {
      return this.tx(() => {
        const r = this.receipt(rid),
          amount = money(b.amount),
          paid_date = date(b.paid_date || today());
        check(
          !r.voided && !r.legacy_review,
          "Receipt cannot be refunded until reviewed.",
        );
        check(
          amount > 0 && amount <= r.available,
          "Refund exceeds unallocated customer funds. Release invoice allocations with a credit note first.",
        );
        check(
          paid_date >= r.paid_date && paid_date <= today(),
          "Refund date must be between receipt date and today.",
        );
        const reference = text(b.reference, 120, true);
        const duplicate = this.db
          .prepare(
            "SELECT f.reference,f.paid_date,r.account FROM refunds f JOIN cash_receipts r ON r.id=f.receipt_id WHERE f.paid_date=?",
          )
          .all(paid_date)
          .some(
            (f) =>
              normal(f.account) === normal(r.account) &&
              normal(f.reference) === normal(reference),
          );
        check(
          !duplicate,
          "Refund transaction reference already recorded on this account/date.",
          409,
        );
        const f = {
          id: id(),
          receipt_id: rid,
          number: this.number("RF", paid_date),
          amount,
          paid_date,
          reference,
          reason: text(b.reason, 1000, true),
          created: now(),
        };
        this.db
          .prepare(
            "INSERT INTO refunds VALUES(:id,:receipt_id,:number,:amount,:paid_date,:reference,:reason,:created)",
          )
          .run(f);
        this.audit(
          "refund.recorded",
          rid,
          f.reason,
          { available: r.available },
          { amount, reference, number: f.number },
        );
        return f;
      });
    },
    void(idv, reason) {
      check(
        !this.db
          .prepare("SELECT id FROM adjustments WHERE invoice_id=?")
          .get(idv),
        "An adjusted invoice must be corrected with further notes, not voided.",
      );
      return originalVoid.call(this, idv, reason);
    },
    reviewProof(pid, reason) {
      const p = this.db
        .prepare("SELECT * FROM proofs WHERE id=? AND status='pending'")
        .get(pid);
      check(p, "Pending reference not found.", 404);
      reason = text(reason, 500, true);
      this.db
        .prepare("UPDATE proofs SET status='rejected' WHERE id=?")
        .run(pid);
      this.audit("payment.reference.rejected", p.invoice_id, reason);
    },
    share(idv, days = 30) {
      const d = this.document(idv);
      check(["issued", "accepted"].includes(d.state), "Issue before sharing.");
      days = integer(days, 1, 90);
      const token = randomBytes(32).toString("base64url"),
        expires = Date.now() + days * 86400000;
      this.db
        .prepare("UPDATE documents SET token_hash=?,token_expires=? WHERE id=?")
        .run(hash(token), expires, idv);
      this.audit(
        "link.rotated",
        idv,
        `Expires in ${days} days; previous link revoked.`,
      );
      return { token, expires };
    },
    resolveLegacy(rid, reason) {
      const r = this.receipt(rid);
      check(r.legacy_review, "This receipt does not need legacy review.");
      reason = text(reason, 1000, true);
      this.db
        .prepare("UPDATE cash_receipts SET legacy_review=0 WHERE id=?")
        .run(rid);
      this.audit("legacy.receipt.reviewed", rid, reason);
      return this.receipt(rid);
    },
    finance() {
      return {
        receipts: this.receipts(),
        bankTransactions: this.db
          .prepare(
            "SELECT * FROM bank_transactions ORDER BY txn_date DESC,created DESC",
          )
          .all(),
        adjustments: this.db
          .prepare("SELECT * FROM adjustments ORDER BY created DESC")
          .all(),
      };
    },
  });
}
