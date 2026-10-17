// Late payment fees: policy settings, the fee arithmetic and the text printed on invoices.
// Amounts are integer sen; percentages are basis points (150 = 1.50%).
import { id, now, today, text, check, integer, money, currency } from "./domain.mjs";
import { daysBetween } from "./recurring-dates.mjs";

export const LATE_FEE_DEFAULTS = {
  enabled: false,
  type: "fixed",
  amount: 2000,
  percent_bp: 150,
  after_days: 7,
  repeat_days: 0,
  max_count: 1,
  cap: 0,
  since: null,
};
const percentToBp = (v) => {
  const s = String(v ?? "").trim();
  check(/^\d{1,2}(\.\d{1,2})?$/.test(s), "Enter a percentage between 0.01 and 25 with at most 2 decimals.");
  const [a, b = ""] = s.split(".");
  const bp = Number(a) * 100 + Number(b.padEnd(2, "0"));
  check(bp >= 1 && bp <= 2500, "Enter a percentage between 0.01 and 25.");
  return bp;
};
export const bpLabel = (bp) => `${(bp / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
// Validates the owner's late fee settings. `amount` and `cap` are MYR strings.
export function normalizeLateFees(b, current = LATE_FEE_DEFAULTS, asOf) {
  const out = { ...LATE_FEE_DEFAULTS, ...current };
  if ("enabled" in b) out.enabled = b.enabled === true;
  if ("type" in b) {
    check(["fixed", "percent"].includes(b.type), "Choose a fixed amount or a percentage.");
    out.type = b.type;
  }
  if ("amount" in b) out.amount = money(b.amount);
  if ("percent" in b) out.percent_bp = percentToBp(b.percent);
  if ("after_days" in b) out.after_days = integer(b.after_days, 1, 365);
  if ("repeat_days" in b) out.repeat_days = integer(b.repeat_days || 0, 0, 365);
  if ("max_count" in b) out.max_count = integer(b.max_count, 1, 24);
  if ("cap" in b) out.cap = money(b.cap || "0");
  if (out.type === "fixed") check(out.amount > 0, "Enter a late fee amount greater than zero.");
  if (!out.repeat_days) out.max_count = 1;
  // Fees apply only to invoices issued once the policy is on (clients see it on those invoices).
  if (out.enabled && (!current.enabled || !out.since)) out.since = asOf;
  if (!out.enabled) out.since = null;
  return out;
}
// The charge that is due now for one invoice, or null.
// `charged` lists earlier charges for the invoice: [{ charge_no, amount }].
// Percentage fees use the unpaid balance without earlier fees, so fees never
// earn fees, and nothing more is charged once only fees remain unpaid.
export function lateFeeDue(cfg, { due_date, balance, charged = [] }, asOf) {
  if (!cfg.enabled || balance <= 0) return null;
  const late = daysBetween(due_date, asOf);
  const made = charged.length ? Math.max(...charged.map((c) => c.charge_no)) : 0;
  const k = made + 1;
  if (k > cfg.max_count || (k > 1 && !cfg.repeat_days)) return null;
  if (late < cfg.after_days + (k - 1) * cfg.repeat_days) return null;
  const fees = charged.reduce((s, c) => s + c.amount, 0);
  const base = Math.max(0, balance - fees);
  if (base <= 0) return null;
  let amount = cfg.type === "percent" ? Math.round((base * cfg.percent_bp) / 10000) : cfg.amount;
  if (cfg.cap > 0) amount = Math.min(amount, cfg.cap - fees);
  if (amount < 1) return null;
  return { charge_no: k, amount, base, late };
}
// Plain-language policy for invoices and the client page.
export function lateFeePolicy(cfg) {
  if (!cfg?.enabled) return null;
  const what =
    cfg.type === "percent"
      ? `a late fee of ${bpLabel(cfg.percent_bp)} of the unpaid balance`
      : `a late fee of ${currency(cfg.amount)}`;
  const day = (n) => `${n} day${n === 1 ? "" : "s"}`;
  let text = `If this invoice is not paid in full ${day(cfg.after_days)} after the due date, ${what} will be charged as a debit note`;
  if (cfg.repeat_days && cfg.max_count > 1)
    text += `, and again every ${day(cfg.repeat_days)} while it stays unpaid, up to ${cfg.max_count} times`;
  if (cfg.cap > 0) text += ` (no more than ${currency(cfg.cap)} in total)`;
  return text + ".";
}

const feeRows = (store, invoiceId) =>
  store.db
    .prepare(
      "SELECT f.*,a.number,w.number waiver_number FROM recurring_late_fees f LEFT JOIN adjustments a ON a.id=f.adjustment_id LEFT JOIN adjustments w ON w.id=f.waiver_id WHERE f.invoice_id=? ORDER BY f.charge_no",
    )
    .all(invoiceId);
export function attachLateFees(Store) {
  const originalBlocks = Store.prototype.pdfBlocks;
  Object.assign(Store.prototype, {
    // The policy text for an invoice, or null when no fee can be charged on it.
    lateFeePolicyFor(d) {
      if (d.kind !== "invoice" || !["draft", "issued"].includes(d.state)) return null;
      const cfg = this.recurringConfig("lateFees");
      if (!cfg.enabled || (cfg.since && d.issue_date < cfg.since)) return null;
      if (cfg.type === "fixed" && d.currency && d.currency !== "MYR") return null;
      if (this.db.prepare("SELECT late_fee_exempt FROM clients WHERE id=?").get(d.client_id)?.late_fee_exempt)
        return null;
      if (this.db.prepare("SELECT 1 FROM recurring_fee_holds WHERE invoice_id=?").get(d.id)) return null;
      return lateFeePolicy(cfg);
    },
    async pdfBlocks(d) {
      const blocks = await originalBlocks.call(this, d);
      const policy = this.lateFeePolicyFor(d);
      return policy ? [...blocks, { heading: "Late payment", text: policy }] : blocks;
    },
    lateFees(invoiceId) {
      return feeRows(this, invoiceId);
    },
    // Charges the late fees that are due on every overdue invoice. Each invoice and
    // charge number is charged at most once; a failed charge is recorded, not retried.
    runLateFees(asOf = today()) {
      const cfg = this.recurringConfig("lateFees");
      if (!cfg.enabled) return { charged: 0, failed: 0, skipped: true };
      const exempt = new Set(
        this.db.prepare("SELECT id FROM clients WHERE late_fee_exempt=1").all().map((r) => r.id),
      );
      const holds = new Set(
        this.db.prepare("SELECT invoice_id FROM recurring_fee_holds").all().map((r) => r.invoice_id),
      );
      const out = { charged: 0, failed: 0, skipped: false };
      const candidates = this.db
        .prepare(
          "SELECT id FROM documents WHERE kind='invoice' AND state='issued' AND due_date<? AND issue_date>=? ORDER BY due_date",
        )
        .all(asOf, cfg.since || "0000-00-00");
      for (const { id: invoiceId } of candidates) {
        let d = this.document(invoiceId);
        if (d.balance <= 0 || exempt.has(d.client_id) || holds.has(d.id)) continue;
        if (cfg.type === "fixed" && d.currency && d.currency !== "MYR") continue;
        for (let n = 0; n < cfg.max_count; n++) {
          const rows = feeRows(this, invoiceId);
          if (rows.some((r) => r.status === "failed")) break;
          const due = lateFeeDue(
            cfg,
            { due_date: d.due_date, balance: d.balance, charged: rows.filter((r) => !r.waiver_id) },
            asOf,
          );
          if (!due) break;
          try {
            if (!this.chargeLateFee(d, due, cfg, asOf)) break;
            out.charged++;
          } catch (e) {
            this.db
              .prepare(
                "INSERT INTO recurring_late_fees(id,invoice_id,charge_no,amount,base,status,error,created) VALUES(?,?,?,?,?,'failed',?,?) ON CONFLICT(invoice_id,charge_no) DO NOTHING",
              )
              .run(id(), invoiceId, due.charge_no, due.amount, due.base, e.status ? e.message : "Unexpected error.", now());
            this.audit("late_fee.failed", invoiceId, e.status ? e.message : "Unexpected error.", null, due);
            out.failed++;
            break;
          }
          d = this.document(invoiceId);
        }
      }
      return out;
    },
    chargeLateFee(d, due, cfg, asOf) {
      return this.tx(() => {
        const fid = id();
        const claimed = this.db
          .prepare(
            "INSERT INTO recurring_late_fees(id,invoice_id,charge_no,amount,base,status,created) VALUES(?,?,?,?,?,'charged',?) ON CONFLICT(invoice_id,charge_no) DO NOTHING",
          )
          .run(fid, d.id, due.charge_no, due.amount, due.base, now()).changes;
        if (!claimed) return null;
        const label = cfg.max_count > 1 ? ` ${due.charge_no} of ${cfg.max_count}` : "";
        const a = this.adjustment(d.id, {
          kind: "debit",
          amount: (due.amount / 100).toFixed(2),
          reason: `Late payment fee${label}: invoice ${d.number} was ${due.late} days overdue.`,
          issue_date: asOf,
        });
        this.db.prepare("UPDATE recurring_late_fees SET adjustment_id=? WHERE id=?").run(a.id, fid);
        this.audit("late_fee.charged", d.id, `${a.number}: ${due.amount} sen`, null, {
          charge_no: due.charge_no,
          amount: due.amount,
          base: due.base,
          days_overdue: due.late,
          debit_note: a.number,
        });
        return a;
      });
    },
    // One credit note for every unwaived late fee on the invoice; no further fees are charged on it.
    waiveLateFees(invoiceId, reason = "") {
      return this.tx(() => {
        const d = this.document(invoiceId);
        const fees = feeRows(this, invoiceId).filter((f) => f.status === "charged" && !f.waiver_id);
        check(fees.length, "There are no late fees to waive on this invoice.", 409);
        reason = text(reason || "", 500);
        const amount = fees.reduce((s, f) => s + f.amount, 0);
        const numbers = fees.map((f) => f.number).join(", ");
        const cn = this.adjustment(d.id, {
          kind: "credit",
          amount: (amount / 100).toFixed(2),
          reason: `Late fee waived (${numbers})${reason ? ": " + reason : "."}`,
        });
        const set = this.db.prepare("UPDATE recurring_late_fees SET waiver_id=? WHERE id=?");
        for (const f of fees) set.run(cn.id, f.id);
        this.db
          .prepare(
            "INSERT INTO recurring_fee_holds(invoice_id,reason,created) VALUES(?,?,?) ON CONFLICT(invoice_id) DO NOTHING",
          )
          .run(d.id, "waived", now());
        this.audit("late_fee.waived", d.id, `${cn.number}: ${amount} sen`, { debit_notes: numbers }, {
          credit_note: cn.number,
          amount,
        });
        return cn;
      });
    },
    // Stops (or allows again) late fees on one invoice.
    holdLateFees(invoiceId, hold) {
      return this.tx(() => {
        const d = this.document(invoiceId);
        check(d.kind === "invoice", "Late fees apply to invoices only.");
        check(typeof hold === "boolean", "Choose stop or resume.");
        if (hold)
          this.db
            .prepare(
              "INSERT INTO recurring_fee_holds(invoice_id,reason,created) VALUES(?,?,?) ON CONFLICT(invoice_id) DO NOTHING",
            )
            .run(d.id, "owner", now());
        else this.db.prepare("DELETE FROM recurring_fee_holds WHERE invoice_id=?").run(d.id);
        this.audit(hold ? "late_fee.stopped" : "late_fee.resumed", d.id, d.number || "");
        return { hold };
      });
    },
  });
}
