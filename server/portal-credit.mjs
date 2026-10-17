// No. 51: per-client credit limit and work hold. A new invoice or quotation
// cannot be issued for a client on hold or over its limit unless the owner
// records an override with a reason for that exact draft.
import { id, now, today, check, text, money, integer, currency } from "./domain.mjs";
import { requestContext } from "./context.mjs";

const flag = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true";
// Only these kinds start new work or create a debt; other kinds are never held.
export const HELD_KINDS = ["invoice", "quote"];
// Documents in another currency count at their exchange rate (MYR per unit).
export const inMYR = (d, amount) => {
  if (!d.currency || d.currency === "MYR") return amount;
  const rate = Number(d.fx_rate);
  return Number.isFinite(rate) && rate > 0 ? Math.round(amount * rate) : amount;
};
const daysBetween = (from, to) =>
  Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);

export function attachCredit(Store) {
  const originalSaveClient = Store.prototype.saveClient,
    originalIssue = Store.prototype.issue;
  Object.assign(Store.prototype, {
    portalClient(clientId) {
      return (
        this.db.prepare("SELECT * FROM portal_clients WHERE client_id=?").get(clientId) || {
          client_id: clientId,
          portal_enabled: 0,
          credit_limit: null,
          hold_days: null,
          on_hold: 0,
          hold_reason: "",
          updated: null,
        }
      );
    },
    savePortalClient(clientId, changes) {
      const row = { ...this.portalClient(clientId), ...changes, client_id: clientId, updated: now() };
      this.db
        .prepare(
          "INSERT INTO portal_clients(client_id,portal_enabled,credit_limit,hold_days,on_hold,hold_reason,updated) VALUES(:client_id,:portal_enabled,:credit_limit,:hold_days,:on_hold,:hold_reason,:updated) ON CONFLICT(client_id) DO UPDATE SET portal_enabled=excluded.portal_enabled,credit_limit=excluded.credit_limit,hold_days=excluded.hold_days,on_hold=excluded.on_hold,hold_reason=excluded.hold_reason,updated=excluded.updated",
        )
        .run(row);
      return row;
    },
    // The client form sends portal_credit=1 with these fields; other callers
    // (API, automation) that leave them out keep the current settings.
    saveClient(b, idv) {
      return this.tx(() => {
        const out = originalSaveClient.call(this, b, idv);
        if (b && (b.portal_credit !== undefined || "credit_limit" in b)) this.saveCreditSettings(out.id, b);
        return out;
      });
    },
    saveCreditSettings(clientId, b) {
      return this.tx(() => {
        this.client(clientId);
        const before = this.portalClient(clientId);
        const limit = b.credit_limit === undefined ? before.credit_limit : b.credit_limit === "" || b.credit_limit === null ? null : money(b.credit_limit);
        const days = b.hold_days === undefined ? before.hold_days : b.hold_days === "" || b.hold_days === null ? null : integer(b.hold_days, 0, 365);
        const onHold = b.on_hold === undefined && b.portal_credit === undefined ? !!before.on_hold : flag(b.on_hold);
        const reason = onHold ? text(b.hold_reason ?? before.hold_reason ?? "", 300) : "";
        check(!onHold || reason, "Give a reason for putting the client on hold.");
        const next = { credit_limit: limit, hold_days: days, on_hold: onHold ? 1 : 0, hold_reason: reason };
        const changed = ["credit_limit", "hold_days", "on_hold", "hold_reason"].some((k) => (before[k] ?? null) !== next[k]);
        if (!changed) return before;
        const out = this.savePortalClient(clientId, next);
        const pick = (r) => ({ credit_limit: r.credit_limit, hold_days: r.hold_days, on_hold: r.on_hold, hold_reason: r.hold_reason });
        this.audit(
          before.on_hold !== next.on_hold ? (next.on_hold ? "client.hold.placed" : "client.hold.released") : "client.credit.changed",
          clientId,
          next.on_hold ? reason : "Credit settings",
          pick(before),
          pick(out),
        );
        return out;
      });
    },
    // Credit used is the open balance of issued invoices, in MYR.
    creditStatus(clientId, asOf = today(), invoices = null) {
      const cfg = this.portalClient(clientId);
      const open = (
        invoices ||
        this.db
          .prepare("SELECT * FROM documents WHERE client_id=? AND kind='invoice' AND state='issued'")
          .all(clientId)
          .map((row) => this.hydrate(row))
      ).filter((d) => d.balance > 0);
      const used = open.reduce((s, d) => s + inMYR(d, d.balance), 0);
      const late = open.filter((d) => d.due_date < asOf);
      const overdueDays = late.reduce((m, d) => Math.max(m, daysBetween(d.due_date, asOf)), 0);
      const reasons = [];
      if (cfg.on_hold) reasons.push(`On hold: ${cfg.hold_reason}`);
      if (cfg.hold_days !== null && overdueDays > cfg.hold_days)
        reasons.push(`An invoice is ${overdueDays} day${overdueDays === 1 ? "" : "s"} overdue (hold after ${cfg.hold_days})`);
      return {
        credit_limit: cfg.credit_limit,
        hold_days: cfg.hold_days,
        on_hold: !!cfg.on_hold,
        hold_reason: cfg.hold_reason,
        used,
        available: cfg.credit_limit === null ? null : cfg.credit_limit - used,
        over_limit: cfg.credit_limit !== null && used > cfg.credit_limit,
        overdue_days: overdueDays,
        overdue_amount: late.reduce((s, d) => s + inMYR(d, d.balance), 0),
        held: reasons.length > 0,
        reasons,
      };
    },
    // Would issuing this draft be blocked?
    creditCheck(d, status = null) {
      if (d.state !== "draft" || !HELD_KINDS.includes(d.kind)) return { blocked: false, reasons: [] };
      const s = status || this.creditStatus(d.client_id);
      const amount = inMYR(d, d.total);
      const projected = s.used + amount;
      const reasons = [...s.reasons];
      if (s.credit_limit !== null && projected > s.credit_limit)
        reasons.push(
          `${d.kind === "quote" ? "This quotation" : "This invoice"} would bring the balance to ${currency(projected)}, over the ${currency(s.credit_limit)} credit limit`,
        );
      const override = reasons.length ? this.creditOverrideFor(d) : null;
      return {
        blocked: reasons.length > 0,
        reasons,
        projected,
        amount,
        override,
        message: reasons.length
          ? `Issuing is blocked for ${d.client.name}. ${reasons.join(". ")}.`
          : "",
      };
    },
    creditOverrideFor(d) {
      return (
        this.db
          .prepare(
            "SELECT * FROM portal_credit_overrides WHERE document_id=? AND client_id=? AND total=? AND used_at IS NULL ORDER BY created DESC LIMIT 1",
          )
          .get(d.id, d.client_id, d.total) || null
      );
    },
    // The owner confirms that this exact draft may be issued anyway.
    allowCreditOverride(docId, reason) {
      return this.tx(() => {
        const d = this.document(docId);
        check(d.state === "draft", "Only a draft can be allowed past the credit check.", 409);
        const c = this.creditCheck(d);
        check(c.blocked, "This draft is not blocked by a credit limit or hold.", 409);
        reason = text(reason, 500, true);
        const row = {
          id: id(),
          document_id: d.id,
          client_id: d.client_id,
          total: d.total,
          reason,
          detail: c.reasons.join(". "),
          used_at: null,
          created: now(),
          actor: requestContext.getStore()?.actor || "system",
        };
        this.db
          .prepare(
            "INSERT INTO portal_credit_overrides(id,document_id,client_id,total,reason,detail,used_at,created,actor) VALUES(:id,:document_id,:client_id,:total,:reason,:detail,:used_at,:created,:actor)",
          )
          .run(row);
        this.audit("credit.override.allowed", d.id, reason, { blocked: c.reasons }, { total: d.total, client_id: d.client_id });
        return row;
      });
    },
    issue(idv) {
      return this.tx(() => {
        const d = this.document(idv);
        const c = this.creditCheck(d);
        if (c.blocked) {
          check(
            c.override,
            `${c.message} To issue anyway, open the draft and choose "Allow issue" with a reason.`,
            409,
          );
          this.db.prepare("UPDATE portal_credit_overrides SET used_at=? WHERE id=?").run(now(), c.override.id);
          this.audit("credit.override.used", d.id, c.override.reason, { blocked: c.reasons }, { override: c.override.id });
        }
        return originalIssue.call(this, idv);
      });
    },
  });
}
