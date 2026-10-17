// Contracts and retainers: a client, a value and a term, with linked recurring
// plans that stop billing after the end date. Renewal: manual, a notice N days
// before the end, or automatic renewal for another term. Every change is audited.
import { id, now, today, text, date, money, integer, check, addDays } from "./domain.mjs";
import { addMonths, lastDay, daysBetween } from "./recurring-dates.mjs";

export const RENEWALS = {
  manual: "Renew manually",
  notify: "Remind me before the end",
  auto: "Renew automatically",
};
// End of a term of `months` starting on `start` (1 Jan + 12 -> 31 Dec; 31 Jan + 1 -> 28 Feb).
export function termEnd(start, months) {
  const day = Number(start.slice(8));
  const target = addMonths(start, months, day);
  const [y, m] = target.split("-").map(Number);
  return day > lastDay(y, m) ? target : addDays(target, -1);
}
// Display status: cancelled, ended, expiring (inside the notice window) or active.
export function contractStatus(c, asOf = today()) {
  if (c.status === "cancelled") return "cancelled";
  if (c.status === "ended" || c.end_date < asOf) return "ended";
  return daysBetween(asOf, c.end_date) <= (c.notice_days || 30) ? "expiring" : "active";
}
const pick = (c) =>
  c && {
    title: c.title,
    reference: c.reference,
    value: c.value,
    start_date: c.start_date,
    end_date: c.end_date,
    renewal: c.renewal,
    notice_days: c.notice_days,
    term_months: c.term_months,
    status: c.status,
    notes: c.notes,
  };
export function attachContracts(Store) {
  const originalDeleteClient = Store.prototype.deleteClient;
  Object.assign(Store.prototype, {
    recurringContract(cid) {
      const c = this.db.prepare("SELECT * FROM recurring_contracts WHERE id=?").get(cid);
      check(c, "Contract not found.", 404);
      return c;
    },
    saveRecurringContract(b, cid = null) {
      return this.tx(() => {
        const old = cid ? this.recurringContract(cid) : null;
        check(!old || old.status !== "cancelled", "A cancelled contract cannot be edited.", 409);
        const clientId = old ? old.client_id : b.client_id;
        const client = this.client(clientId);
        if (!old)
          check(
            !client.archived,
            "This client is archived. Restore the client before creating new records.",
            409,
          );
        const start_date = date(b.start_date ?? old?.start_date);
        const end_date = date(b.end_date ?? old?.end_date);
        check(end_date >= start_date, "The end date must be on or after the start date.");
        const renewal = b.renewal ?? old?.renewal ?? "manual";
        check(Object.hasOwn(RENEWALS, renewal), "Choose manual, notice or automatic renewal.");
        const c = {
          id: cid || id(),
          client_id: clientId,
          title: text(b.title ?? old?.title ?? "", 160, true),
          reference: text(b.reference ?? old?.reference ?? "", 80),
          value: b.value === undefined ? (old?.value ?? 0) : money(b.value === "" ? "0" : b.value),
          start_date,
          end_date,
          renewal,
          notice_days: integer(b.notice_days ?? old?.notice_days ?? 30, 0, 365),
          term_months: integer(b.term_months ?? old?.term_months ?? 12, 1, 60),
          notes: text(b.notes ?? old?.notes ?? "", 2000),
          // Moving the end date of an ended contract into the future makes it active again.
          status: old?.status === "ended" && end_date >= today() ? "active" : (old?.status ?? "active"),
          // A new end date gets its own renewal notice.
          notified_for: old && old.end_date === end_date ? old.notified_for : null,
          created: old?.created || now(),
          updated: now(),
        };
        this.db
          .prepare(
            "INSERT INTO recurring_contracts(id,client_id,title,reference,value,start_date,end_date,renewal,notice_days,term_months,status,notified_for,notes,created,updated) VALUES(:id,:client_id,:title,:reference,:value,:start_date,:end_date,:renewal,:notice_days,:term_months,:status,:notified_for,:notes,:created,:updated) ON CONFLICT(id) DO UPDATE SET title=excluded.title,reference=excluded.reference,value=excluded.value,start_date=excluded.start_date,end_date=excluded.end_date,renewal=excluded.renewal,notice_days=excluded.notice_days,term_months=excluded.term_months,status=excluded.status,notified_for=excluded.notified_for,notes=excluded.notes,updated=excluded.updated",
          )
          .run(c);
        if (!old)
          this.db
            .prepare(
              "INSERT INTO recurring_contract_terms(contract_id,term_no,start_date,end_date,source,created) VALUES(?,?,?,?,?,?)",
            )
            .run(c.id, 1, start_date, end_date, "created", now());
        if (Array.isArray(b.schedule_ids))
          for (const sid of b.schedule_ids.slice(0, 50)) {
            const s = this.db.prepare("SELECT client_id FROM schedules WHERE id=?").get(sid);
            check(s && s.client_id === clientId, "Link plans for the same client only.");
            this.db.prepare("UPDATE schedules SET contract_id=? WHERE id=?").run(c.id, sid);
          }
        const after = this.recurringContract(c.id);
        this.audit(old ? "contract.changed" : "contract.created", c.id, c.title, pick(old), pick(after));
        return after;
      });
    },
    // Adds another term after the current end date. Each term is recorded once.
    renewRecurringContract(cid, { source = "owner" } = {}) {
      return this.tx(() => {
        const c = this.recurringContract(cid);
        check(c.status !== "cancelled", "A cancelled contract cannot be renewed.", 409);
        const start = addDays(c.end_date, 1),
          end = termEnd(start, c.term_months);
        const term = this.db
          .prepare("SELECT coalesce(max(term_no),0)+1 n FROM recurring_contract_terms WHERE contract_id=?")
          .get(cid).n;
        this.db
          .prepare(
            "INSERT INTO recurring_contract_terms(contract_id,term_no,start_date,end_date,source,created) VALUES(?,?,?,?,?,?)",
          )
          .run(cid, term, start, end, source, now());
        this.db
          .prepare(
            "UPDATE recurring_contracts SET end_date=?,status='active',renewals=renewals+1,notified_for=NULL,updated=? WHERE id=?",
          )
          .run(end, now(), cid);
        this.audit(
          source === "auto" ? "contract.auto_renewed" : "contract.renewed",
          cid,
          `${c.title}: ${start} to ${end}`,
          { end_date: c.end_date, status: c.status },
          { start: start, end_date: end, status: "active", term },
        );
        return this.recurringContract(cid);
      });
    },
    cancelRecurringContract(cid, reason) {
      return this.tx(() => {
        const c = this.recurringContract(cid);
        check(c.status !== "cancelled", "This contract is already cancelled.", 409);
        reason = text(reason || "", 500, true);
        const on = today() < c.start_date ? c.start_date : today();
        this.db
          .prepare(
            "UPDATE recurring_contracts SET status='cancelled',cancelled_on=?,cancel_reason=?,updated=? WHERE id=?",
          )
          .run(on, reason, now(), cid);
        this.audit("contract.cancelled", cid, reason, pick(c), { status: "cancelled", cancelled_on: on });
        return this.recurringContract(cid);
      });
    },
    deleteRecurringContract(cid) {
      return this.tx(() => {
        const c = this.recurringContract(cid);
        check(
          !this.db.prepare("SELECT 1 FROM schedules WHERE contract_id=?").get(cid),
          "Recurring plans are linked to this contract. Unlink them or cancel the contract instead.",
          409,
        );
        this.db.prepare("DELETE FROM recurring_contract_terms WHERE contract_id=?").run(cid);
        this.db.prepare("DELETE FROM recurring_contracts WHERE id=?").run(cid);
        // Files attached to the contract (e.g. a signed copy) go with it; main has deleteFilesFor.
        this.deleteFilesFor?.(cid);
        this.audit("contract.deleted", cid, c.title, pick(c), null);
      });
    },
    // Ends contracts past their end date, or renews those set to renew automatically.
    recurringContractSweep(asOf = today(), only = null) {
      return this.tx(() => {
        const out = { renewed: 0, ended: 0 };
        const list = this.db
          .prepare(
            `SELECT * FROM recurring_contracts WHERE status='active' AND end_date<?${only ? " AND id=?" : ""}`,
          )
          .all(...[asOf, ...(only ? [only] : [])]);
        for (const c of list) {
          if (c.renewal === "auto") {
            let current = c;
            for (let n = 0; current.end_date < asOf && n < 60; n++) {
              current = this.renewRecurringContract(c.id, { source: "auto" });
              out.renewed++;
            }
          } else {
            this.db
              .prepare("UPDATE recurring_contracts SET status='ended',updated=? WHERE id=?")
              .run(now(), c.id);
            this.audit("contract.ended", c.id, c.title, { status: "active" }, { status: "ended", end_date: c.end_date });
            out.ended++;
          }
        }
        return out;
      });
    },
    recurringContracts(asOf = today()) {
      const plans = this.db.prepare("SELECT id,title,active FROM schedules WHERE contract_id=?");
      const billed = this.db.prepare(
        "SELECT coalesce(sum(d.total),0) n, count(*) c FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id JOIN documents d ON d.id=r.invoice_id WHERE s.contract_id=? AND d.state='issued'",
      );
      const terms = this.db.prepare(
        "SELECT * FROM recurring_contract_terms WHERE contract_id=? ORDER BY term_no DESC LIMIT 12",
      );
      return this.db
        .prepare("SELECT * FROM recurring_contracts ORDER BY end_date,created")
        .all()
        .map((c) => {
          const b = billed.get(c.id);
          const t = terms.all(c.id);
          return {
            ...c,
            display_status: contractStatus(c, asOf),
            days_left: daysBetween(asOf, c.end_date),
            term_start: t[0]?.start_date || c.start_date,
            terms: t,
            plans: plans.all(c.id),
            billed: b.n,
            invoices: b.c,
          };
        });
    },
    deleteClient(cid) {
      check(
        !this.db.prepare("SELECT 1 FROM recurring_contracts WHERE client_id=?").get(cid),
        "This client has contracts. Archive the client instead.",
        409,
      );
      return originalDeleteClient.call(this, cid);
    },
  });
}
