// Recurring plans (the `schedules` table): several lines, weekly to yearly
// frequencies, optional end date and contract, and per-plan automation.
// Each period is billed at most once (schedule_runs primary key).
import {
  id,
  now,
  today,
  text,
  date,
  money,
  integer,
  check,
  calculate,
  addDays,
  TAX_RATES,
} from "./domain.mjs";
import { frequencyOf, frequencyLabel, frequencyKey, stepPeriod, periodLabel } from "./recurring-dates.mjs";

export const MODES = {
  draft: "Draft only",
  issue: "Issue automatically",
  send: "Issue and email automatically",
};
// Periods older than this are created as drafts for review, never issued or sent.
export const STALE_DAYS = 7;

const emailPattern = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
export function recipients(value) {
  const list = text(value || "", 600)
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter(Boolean);
  check(list.length <= 5, "Send to at most 5 recipients.");
  for (const e of list) check(emailPattern.test(e), `Invalid email: ${e}`);
  return list.join(", ");
}
export const planOf = (row) =>
  row ? { ...row, lines: JSON.parse(row.lines || "[]"), unit: row.freq_unit, interval: row.freq_interval } : null;
const itemFor = (l) => ({
  description: l.description,
  quantity: String(l.quantity),
  rate: (l.rate / 100).toFixed(2),
  tax_rate: l.tax_rate,
});
// Totals for a plan, worked out exactly as the invoice will be.
export function planAmounts(lines, discount) {
  return calculate(lines.map(itemFor), (discount / 100).toFixed(2));
}
// The invoice lines for one period: "Maintenance – Nov 2026" or "{period}" replaced.
export function periodItems(plan, period) {
  const label = periodLabel(period, plan);
  return plan.lines.map((l) => ({
    ...itemFor(l),
    description: (l.description.includes("{period}")
      ? l.description.replaceAll("{period}", label)
      : `${l.description} – ${label}`
    ).slice(0, 240),
    ...(l.service_id ? { service_id: l.service_id } : {}),
    ...(l.unit ? { unit: l.unit } : {}),
  }));
}
function cleanLines(store, lines, previous = []) {
  check(Array.isArray(lines) && lines.length >= 1 && lines.length <= 20, "Add between 1 and 20 plan lines.");
  return lines.map((l) => {
    check(l && typeof l === "object", "Invalid plan line.");
    let service = null;
    if (l.service_id) {
      service = store.db.prepare("SELECT * FROM services WHERE id=?").get(l.service_id);
      check(service, "Service not found.", 404);
      check(
        service.active || previous.some((p) => p.service_id === service.id),
        "Choose an active service.",
      );
    }
    const description = text(l.description || service?.name || "", 200, true);
    const q = String(l.quantity ?? 1);
    check(
      /^\d{1,5}(\.\d{1,2})?$/.test(q) && Number(q) > 0,
      "Quantity must be positive with at most 2 decimal places.",
    );
    const rate =
      (l.rate === undefined || l.rate === null || l.rate === "") && service ? service.rate : money(l.rate);
    const tax_rate = Number(l.tax_rate ?? service?.tax_rate ?? 0);
    check(TAX_RATES.includes(tax_rate), "Choose an SST rate of 0, 5, 6, 8 or 10%.");
    return {
      service_id: service?.id || null,
      description,
      quantity: Number(q),
      rate,
      tax_rate,
      unit: service?.unit || text(l.unit || "", 30),
    };
  });
}
const bool = (v) => v === true || v === "on" || v === "true" || v === 1 || v === "1";
// Builds the stored plan from a request body; `s` is the existing plan when editing.
function normalizePlan(store, b, s = null) {
  const client = store.client(b.client_id ?? s.client_id);
  const previous = s ? JSON.parse(s.lines || "[]") : [];
  let lines;
  if (b.lines !== undefined) lines = cleanLines(store, b.lines, previous);
  else if (b.service_id !== undefined && (!s || b.service_id !== s.service_id))
    lines = cleanLines(store, [{ service_id: b.service_id }], []);
  else if (s) lines = previous;
  else check(false, "Choose an active service.");
  const freq = frequencyOf(b, s ? { unit: s.freq_unit, interval: s.freq_interval } : undefined);
  const next_date = date(b.next_date ?? s?.next_date);
  const moved = !s || next_date !== s.next_date || freq.unit !== s.freq_unit;
  const month_end =
    freq.unit === "week"
      ? 0
      : b.month_end === undefined
        ? (s?.month_end ?? 0)
        : bool(b.month_end)
          ? 1
          : 0;
  const discount =
    b.discount === undefined ? (s?.discount ?? 0) : money(b.discount === "" ? "0" : b.discount);
  const mode = b.mode ?? s?.mode ?? "draft";
  check(Object.hasOwn(MODES, mode), "Choose draft only, auto-issue or auto-issue and email.");
  const end_date =
    b.end_date === undefined ? (s?.end_date ?? null) : b.end_date ? date(b.end_date) : null;
  let contract_id = b.contract_id === undefined ? (s?.contract_id ?? null) : b.contract_id || null;
  if (contract_id) {
    const c = store.db.prepare("SELECT * FROM recurring_contracts WHERE id=?").get(contract_id);
    check(c, "Contract not found.", 404);
    check(c.client_id === client.id, "Choose a contract for the same client.");
    check(
      c.status !== "cancelled" || contract_id === s?.contract_id,
      "This contract is cancelled. Choose another one.",
    );
  }
  const terms_text =
    b.terms_text === undefined
      ? (s?.terms_text ?? null)
      : b.terms_text === null || b.terms_text === ""
        ? null
        : text(b.terms_text, 1000);
  const plan = {
    client_id: client.id,
    service_id: lines.find((l) => l.service_id)?.service_id || null,
    title: text(b.title ?? s?.title ?? "", 120) || lines[0].description.slice(0, 120),
    lines: JSON.stringify(lines),
    discount,
    notes: text(b.notes ?? s?.notes ?? "", 2000),
    terms_text,
    freq_unit: freq.unit,
    freq_interval: freq.interval,
    next_date,
    end_date,
    terms: integer(b.terms ?? s?.terms ?? client.terms ?? 14, 0, 365),
    // Keep the original anchor (e.g. the 30th clamped to 28 Feb) unless the date was moved.
    anchor_day: moved ? Number(next_date.slice(-2)) : s.anchor_day,
    month_end,
    mode,
    include_link: b.include_link === undefined ? (s?.include_link ?? 0) : bool(b.include_link) ? 1 : 0,
    send_to: b.send_to === undefined ? (s?.send_to ?? "") : recipients(b.send_to),
    contract_id,
  };
  const amounts = planAmounts(lines, discount);
  check(
    !amounts.tax || store.settings().sstNumber,
    "Add your SST registration number in Settings before charging SST.",
  );
  return plan;
}
const COLUMNS = [
  "client_id",
  "service_id",
  "title",
  "lines",
  "discount",
  "notes",
  "terms_text",
  "freq_unit",
  "freq_interval",
  "next_date",
  "end_date",
  "terms",
  "anchor_day",
  "month_end",
  "mode",
  "include_link",
  "send_to",
  "contract_id",
];
export function attachPlans(Store) {
  const originalDeleteService = Store.prototype.deleteService;
  Object.assign(Store.prototype, {
    recurringPlan(sid) {
      const s = this.db.prepare("SELECT * FROM schedules WHERE id=?").get(sid);
      check(s, "Schedule not found.", 404);
      return planOf(s);
    },
    // Last day a plan may bill: its own end date or its contract's end / cancellation.
    recurringEnd(s) {
      let end = s.end_date || null;
      if (s.contract_id) {
        const c = this.db.prepare("SELECT * FROM recurring_contracts WHERE id=?").get(s.contract_id);
        if (c) {
          const stop =
            c.status === "cancelled" && c.cancelled_on && c.cancelled_on < c.end_date
              ? c.cancelled_on
              : c.end_date;
          if (!end || stop < end) end = stop;
        }
      }
      return end;
    },
    saveSchedule(b) {
      return this.tx(() => {
        check(
          !this.client(b.client_id).archived,
          "This client is archived. Restore the client before creating new records.",
          409,
        );
        const plan = { id: id(), ...normalizePlan(this, b), created: now(), updated: now() };
        this.db
          .prepare(
            `INSERT INTO schedules(id,${COLUMNS.join(",")},created,updated) VALUES(:id,${COLUMNS.map((c) => ":" + c).join(",")},:created,:updated)`,
          )
          .run(plan);
        this.audit("schedule.created", plan.id, plan.title, null, { ...plan, lines: JSON.parse(plan.lines) });
        return this.recurringPlan(plan.id);
      });
    },
    updateSchedule(sid, b) {
      return this.tx(() => {
        const s = this.db.prepare("SELECT * FROM schedules WHERE id=?").get(sid);
        check(s, "Schedule not found.", 404);
        const last = this.db
          .prepare("SELECT max(period) p FROM schedule_runs WHERE schedule_id=?")
          .get(sid).p;
        if (b.client_id !== undefined && b.client_id !== s.client_id) {
          check(!last, "This plan has billed periods. Create a new plan for another client.", 409);
          check(
            !this.client(b.client_id).archived,
            "This client is archived. Restore the client before creating new records.",
            409,
          );
        }
        const plan = normalizePlan(this, b, s);
        check(
          !last || plan.next_date > last,
          "The next run must be after the last generated period.",
        );
        // Editing the plan clears a failure that was holding the job back.
        this.db
          .prepare(
            `UPDATE schedules SET ${COLUMNS.map((c) => `${c}=:${c}`).join(",")},hold_period=NULL,last_error=NULL,last_error_step=NULL,last_error_at=NULL,updated=:updated WHERE id=:id`,
          )
          .run({ ...plan, updated: now(), id: sid });
        const after = this.recurringPlan(sid);
        this.audit("schedule.changed", sid, "Schedule edited", { ...s, lines: JSON.parse(s.lines) }, after);
        return after;
      });
    },
    // Owner-triggered draft for the due period (the plan's automation is not applied).
    runSchedule(sid, asOf = today()) {
      return this.recurringGenerate(sid, { asOf });
    },
    // Creates the draft invoice for the plan's next due period, once.
    recurringGenerate(sid, { asOf = today() } = {}) {
      return this.tx(() => {
        const s = this.db.prepare("SELECT * FROM schedules WHERE id=? AND active=1").get(sid);
        check(s, "Active schedule not found.", 404);
        check(s.next_date <= asOf, "This schedule is not due yet.");
        if (s.contract_id) this.recurringContractSweep?.(asOf, s.contract_id);
        const end = this.recurringEnd(s);
        check(
          !end || s.next_date <= end,
          "This plan has ended. Change its end date or renew the contract to bill again.",
          409,
        );
        const period = s.next_date;
        check(
          !this.db
            .prepare("SELECT 1 FROM schedule_runs WHERE schedule_id=? AND period=?")
            .get(sid, period),
          "This period already has an invoice.",
          409,
        );
        const plan = planOf(s);
        check(plan.lines.length, "This plan has no lines. Edit the plan to add them.");
        for (const l of plan.lines)
          if (l.service_id) {
            const v = this.db.prepare("SELECT name,active FROM services WHERE id=?").get(l.service_id);
            check(
              v?.active,
              `Service is inactive: ${v?.name || l.description}. Reactivate it or edit the plan.`,
            );
          }
        const d = this.saveDocument({
          kind: "invoice",
          client_id: s.client_id,
          issue_date: period,
          due_date: addDays(period, s.terms),
          items: periodItems(plan, period),
          discount: (s.discount / 100).toFixed(2),
          notes: s.notes,
          terms: s.terms_text ?? this.settings().paymentTerms,
        });
        this.db
          .prepare(
            "INSERT INTO schedule_runs(schedule_id,period,invoice_id,created,mode,send_status,updated) VALUES(?,?,?,?,?,'none',?)",
          )
          .run(sid, period, d.id, now(), s.mode, now());
        this.db
          .prepare("UPDATE schedules SET next_date=?,updated=? WHERE id=?")
          .run(stepPeriod(period, plan), now(), sid);
        this.audit("schedule.draft.created", sid, d.id, null, {
          period,
          label: periodLabel(period, plan),
          invoice_id: d.id,
          total: d.total,
        });
        return d;
      });
    },
    // Issues the invoice of one generated period (auto-issue).
    recurringIssue(sid, period) {
      return this.tx(() => {
        const run = this.db
          .prepare("SELECT * FROM schedule_runs WHERE schedule_id=? AND period=?")
          .get(sid, period);
        check(run, "Run not found.", 404);
        const d = this.issue(run.invoice_id);
        this.db
          .prepare("UPDATE schedule_runs SET error=NULL,error_step=NULL,updated=? WHERE schedule_id=? AND period=?")
          .run(now(), sid, period);
        this.audit("schedule.invoice.issued", sid, d.number, null, { period, invoice_id: d.id, number: d.number });
        return d;
      });
    },
    // Records an automation failure on the plan, so the owner sees it and the job stops retrying.
    recurringFailure(sid, { period, step, message }) {
      const at = now();
      this.tx(() => {
        if (step === "generate")
          this.db
            .prepare(
              "UPDATE schedules SET hold_period=?,last_error=?,last_error_step=?,last_error_at=? WHERE id=?",
            )
            .run(period, message, step, at, sid);
        else {
          this.db
            .prepare("UPDATE schedules SET last_error=?,last_error_step=?,last_error_at=? WHERE id=?")
            .run(message, step, at, sid);
          this.db
            .prepare(
              `UPDATE schedule_runs SET error=?,error_step=?,updated=?${step === "send" ? ",send_status='failed'" : ""} WHERE schedule_id=? AND period=?`,
            )
            .run(message, step, at, sid, period);
        }
        this.audit("schedule.automation.failed", sid, `${step} ${period}: ${message}`, null, {
          period,
          step,
          error: message,
        });
      });
    },
    // Clears the plan's failure notice; `retry` also lets the job try a held period again.
    recurringClearError(sid, { retry = false } = {}) {
      return this.tx(() => {
        const s = this.recurringPlan(sid);
        this.db
          .prepare(
            `UPDATE schedules SET last_error=NULL,last_error_step=NULL,last_error_at=NULL${retry ? ",hold_period=NULL" : ""} WHERE id=?`,
          )
          .run(sid);
        this.audit(retry ? "schedule.retry" : "schedule.error.dismissed", sid, s.last_error || "", {
          last_error: s.last_error,
          hold_period: s.hold_period,
        }, null);
        return this.recurringPlan(sid);
      });
    },
    recurringNote(sid, period, note) {
      this.db
        .prepare("UPDATE schedule_runs SET note=?,updated=? WHERE schedule_id=? AND period=?")
        .run(note, now(), sid, period);
    },
    // A service used on any plan line stays in the catalog (mark it inactive instead).
    deleteService(sid) {
      check(
        !this.db
          .prepare(
            "SELECT 1 FROM schedules s, json_each(s.lines) j WHERE json_extract(j.value,'$.service_id')=? LIMIT 1",
          )
          .get(sid),
        "A recurring schedule uses this service. Mark it inactive instead.",
        409,
      );
      return originalDeleteService.call(this, sid);
    },
    // Plans as the owner's screens show them.
    recurringPlans(asOf = today()) {
      const runs = this.db.prepare(
        "SELECT r.*,d.number,d.state,d.total FROM schedule_runs r LEFT JOIN documents d ON d.id=r.invoice_id WHERE r.schedule_id=? ORDER BY r.period DESC LIMIT 24",
      );
      return this.db
        .prepare("SELECT * FROM schedules ORDER BY next_date,created")
        .all()
        .map((row) => {
          const s = planOf(row);
          const end = this.recurringEnd(s);
          let amounts = null;
          try {
            amounts = planAmounts(s.lines, s.discount);
          } catch {
            amounts = null;
          }
          const ended = !!end && s.next_date > end;
          return {
            ...s,
            frequency: frequencyKey(s.unit, s.interval),
            frequency_label: frequencyLabel(s.unit, s.interval),
            next_label: periodLabel(s.next_date, s),
            effective_end: end,
            amount: amounts?.total ?? null,
            tax: amounts?.tax ?? 0,
            status: !s.active
              ? "Paused"
              : ended
                ? "Ended"
                : s.last_error
                  ? "Needs attention"
                  : s.next_date <= asOf
                    ? "Due"
                    : "Active",
            runs: runs.all(s.id).map((r) => ({ ...r, label: periodLabel(r.period, s) })),
          };
        });
    },
  });
}
