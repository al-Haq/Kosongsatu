// Automatic work for recurring billing: generating, issuing and emailing due
// periods, contract renewals and notices, and the monthly accountant pack.
// Every automatic action is opt-in, audited and happens at most once.
import { id, now, today, check, currency } from "./domain.mjs";
import { daysBetween, periodLabel, previousMonth, monthRange, dayLabel } from "./recurring-dates.mjs";
import { STALE_DAYS, planOf } from "./recurring-plans.mjs";
import { packData, packFiles } from "./recurring-pack.mjs";

const message = (e) => (e?.status ? e.message : "Unexpected error. See the server log.");
const row = (store, sid) => store.db.prepare("SELECT * FROM schedules WHERE id=?").get(sid);

// Generates the next due period of a plan and applies its automation.
// manual: the owner pressed "Run now", so errors are thrown back and older
// periods follow the plan's mode too.
export async function processPeriod(ctx, sid, { asOf = today(), manual = false } = {}) {
  const { store } = ctx;
  const s = row(store, sid);
  check(s, "Schedule not found.", 404);
  const period = s.next_date;
  let d;
  try {
    d = store.recurringGenerate(sid, { asOf });
  } catch (e) {
    if (manual) throw e;
    if (e.status === 409 && /already has an invoice/.test(e.message)) return { skipped: true, period };
    store.recurringFailure(sid, { period, step: "generate", message: message(e) });
    return { period, failed: true, step: "generate", error: message(e) };
  }
  const out = { period, label: periodLabel(period, planOf(s)), document: d, generated: true, issued: false, sent: false };
  if (s.mode === "draft") return out;
  if (!manual && daysBetween(period, asOf) > STALE_DAYS) {
    store.recurringNote(sid, period, "Older period: kept as a draft for review instead of being issued automatically.");
    return { ...out, stale: true };
  }
  try {
    out.document = store.recurringIssue(sid, period);
    out.issued = true;
  } catch (e) {
    store.recurringFailure(sid, { period, step: "issue", message: message(e) });
    return { ...out, failed: true, step: "issue", error: message(e) };
  }
  if (s.mode === "send") {
    const r = await sendRun(ctx, sid, period);
    out.sent = !!r.sent;
    if (r.error) Object.assign(out, { failed: true, step: "send", error: r.error });
  }
  return out;
}

// Emails the invoice of one period. The send is claimed first, so it happens at
// most once; a failure is recorded and only the owner can try again.
export async function sendRun(ctx, sid, period, { manual = false } = {}) {
  const { store, mailer, appUrl } = ctx;
  const run = store.db.prepare("SELECT * FROM schedule_runs WHERE schedule_id=? AND period=?").get(sid, period);
  check(run, "This period has no invoice.", 404);
  const allowed = manual ? ["none", "pending", "failed"] : ["none", "pending"];
  let claimed = store.db
    .prepare(
      `UPDATE schedule_runs SET send_status='sending',updated=? WHERE schedule_id=? AND period=? AND send_status IN (${allowed.map(() => "?").join(",")})`,
    )
    .run(now(), sid, period, ...allowed).changes;
  // A send interrupted by a restart stays "sending"; the owner may retry it after 15 minutes.
  if (!claimed && manual && run.send_status === "sending" && Date.now() - Date.parse(run.updated || 0) > 900000)
    claimed = store.db
      .prepare("UPDATE schedule_runs SET updated=? WHERE schedule_id=? AND period=? AND send_status='sending' AND updated=?")
      .run(now(), sid, period, run.updated).changes;
  if (!claimed) {
    check(!manual, run.send_status === "sent" ? "This invoice was already emailed." : "This invoice is being emailed.", 409);
    return { skipped: true };
  }
  try {
    const d = store.document(run.invoice_id);
    check(d.state === "issued", "Issue the invoice before emailing it.", 409);
    check(
      mailer?.status().configured,
      "Email is not configured. Set up SMTP before invoices can be emailed automatically.",
      409,
    );
    const s = planOf(row(store, sid));
    const to = s.send_to || store.client(d.client_id).email;
    check(to, "The client has no email address. Add one to the client or set recipients on the plan.", 409);
    const label = periodLabel(period, s);
    await mailer.sendDocument(
      d.id,
      {
        to,
        include_link: !!s.include_link,
        message: `Dear ${d.client.contact || d.client.name},\n\nPlease find invoice ${d.number} for ${s.title} (${label}) attached.`,
      },
      (token) => `${appUrl}/client/${token}`,
    );
    store.tx(() => {
      store.db
        .prepare(
          "UPDATE schedule_runs SET send_status='sent',error=NULL,error_step=NULL,updated=? WHERE schedule_id=? AND period=?",
        )
        .run(now(), sid, period);
      if (manual)
        store.db
          .prepare(
            "UPDATE schedules SET last_error=NULL,last_error_step=NULL,last_error_at=NULL WHERE id=? AND last_error_step='send'",
          )
          .run(sid);
      store.audit("schedule.invoice.sent", sid, d.number, null, { period, to, manual });
    });
    return { sent: true };
  } catch (e) {
    store.recurringFailure(sid, { period, step: "send", message: message(e) });
    if (manual) throw e;
    return { sent: false, error: message(e) };
  }
}

// The daily job: renews/ends contracts, then works through every due period.
// A plan held by a failure is skipped until the owner edits it or retries.
export async function runDuePlans(ctx, { asOf = today(), maxPerPlan = 12 } = {}) {
  const { store } = ctx;
  const out = { generated: 0, issued: 0, sent: 0, failed: 0, ...store.recurringContractSweep(asOf) };
  const due = store.db
    .prepare(
      "SELECT id FROM schedules WHERE active=1 AND next_date<=? AND (hold_period IS NULL OR hold_period<>next_date) ORDER BY next_date,created",
    )
    .all(asOf);
  for (const { id: sid } of due) {
    for (let n = 0; n < maxPerPlan; n++) {
      const s = row(store, sid);
      if (!s?.active || s.next_date > asOf || s.hold_period === s.next_date) break;
      const end = store.recurringEnd(s);
      if (end && s.next_date > end) break;
      const r = await processPeriod(ctx, sid, { asOf });
      if (r.skipped) break;
      if (r.generated) out.generated++;
      if (r.issued) out.issued++;
      if (r.sent) out.sent++;
      if (r.failed) out.failed++;
      if (r.step === "generate") break;
    }
  }
  return out;
}

// Renewal notices go to the business email once per contract end date.
export async function runContracts(ctx, { asOf = today() } = {}) {
  const { store, mailer } = ctx;
  const out = { ...store.recurringContractSweep(asOf), notices: 0, emailed: 0 };
  const list = store.db
    .prepare(
      "SELECT * FROM recurring_contracts WHERE status='active' AND renewal='notify' AND end_date>=? AND (notified_for IS NULL OR notified_for<>end_date)",
    )
    .all(asOf)
    .filter((c) => daysBetween(asOf, c.end_date) <= c.notice_days);
  for (const c of list) {
    const marked = store.db
      .prepare(
        "UPDATE recurring_contracts SET notified_for=end_date WHERE id=? AND (notified_for IS NULL OR notified_for<>end_date)",
      )
      .run(c.id).changes;
    if (!marked) continue;
    out.notices++;
    const owner = store.settings();
    const client = store.client(c.client_id);
    let emailed = false,
      note = "Shown on the overview.";
    if (mailer?.status().configured && owner.email) {
      try {
        const r = await mailer.deliver({
          kind: "contract_notice",
          clientId: c.client_id,
          to: [owner.email],
          subject: `Contract ending ${dayLabel(c.end_date)}: ${c.title} (${client.name})`,
          body: [
            `The contract "${c.title}" with ${client.name} ends on ${dayLabel(c.end_date)}.`,
            c.value ? `Contract value: ${currency(c.value)}` : null,
            "",
            "Open Recurring > Contracts to renew it or let it end. Linked recurring plans stop billing after the end date.",
            "",
            owner.company,
          ]
            .filter((l) => l !== null)
            .join("\n"),
          dedupeKey: `recurring:contract:${c.id}:${c.end_date}`,
        });
        emailed = !!r;
        note = emailed ? `Emailed to ${owner.email}.` : note;
      } catch (e) {
        note = `Email failed: ${message(e)}`;
      }
    }
    if (emailed) out.emailed++;
    store.audit("contract.renewal_notice", c.id, `${c.title}: ends ${c.end_date}. ${note}`);
  }
  return out;
}

// Emails a month's pack. `source` "auto" is deduplicated per month and never retried.
export async function sendPack(ctx, month, { to = null, source = "manual" } = {}) {
  const { store, mailer } = ctx;
  const range = monthRange(month);
  const cfg = store.recurringConfig("pack");
  check(range.month < today().slice(0, 7), "Choose a month that has ended.");
  const recipients = (to || cfg.email || "")
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter(Boolean);
  const pid = id();
  const claimed = store.db
    .prepare(
      "INSERT INTO recurring_packs(id,month,source,status,recipients,created,updated) VALUES(?,?,?,'sending',?,?,?) ON CONFLICT DO NOTHING",
    )
    .run(pid, month, source, recipients.join(", "), now(), now()).changes;
  if (!claimed) return { skipped: true };
  try {
    check(recipients.length, "Enter the accountant's email address.");
    check(mailer?.status().configured, "Email is not configured. Set up SMTP to email the pack.", 409);
    const p = packData(store, month);
    const files = await packFiles(p);
    const b = p.business;
    await mailer.deliver({
      kind: "accountant_pack",
      to: recipients,
      subject: `Accountant pack ${p.label}: ${b.company}`,
      body: [
        `Hello,\n\nPlease find the accounts pack for ${p.label} attached.`,
        "",
        `Invoices issued: ${p.totals.invoices} (${currency(p.totals.invoiced)}, SST ${currency(p.totals.sst)})`,
        `Credit / debit notes: −${currency(p.totals.credit)} / +${currency(p.totals.debit)}`,
        `Cash received: ${currency(p.totals.received)}; refunds: ${currency(p.totals.refunded)}`,
        `Outstanding at ${dayLabel(p.to)}: ${currency(p.totals.outstanding)}`,
        "",
        "Attached: PDF summary, invoices and notes CSV, receipts CSV and SST CSV.",
        "",
        b.company,
      ].join("\n"),
      attachments: files.map((f) => ({ filename: f.name, content: f.data, contentType: f.type })),
      dedupeKey: source === "auto" ? `recurring:pack:${month}` : null,
    });
    store.db.prepare("UPDATE recurring_packs SET status='sent',updated=? WHERE id=?").run(now(), pid);
    store.audit("accountant_pack.sent", null, `${month} to ${recipients.join(", ")}`, null, { month, source });
    return { sent: true, month };
  } catch (e) {
    store.db
      .prepare("UPDATE recurring_packs SET status='failed',error=?,updated=? WHERE id=?")
      .run(message(e), now(), pid);
    store.audit("accountant_pack.failed", null, `${month}: ${message(e)}`, null, { month, source });
    if (source === "manual") throw e;
    return { sent: false, month, error: message(e) };
  }
}

// Sends last month's pack once, on the chosen day or within 6 days after it.
export async function runAccountantPack(ctx, { asOf = today() } = {}) {
  const cfg = ctx.store.recurringConfig("pack");
  if (!cfg.enabled) return { skipped: true, reason: "off" };
  const day = Number(asOf.slice(8));
  if (day < cfg.day || day > cfg.day + 6) return { skipped: true, reason: "not the send day" };
  const month = previousMonth(asOf);
  const r = await sendPack(ctx, month, { source: "auto" });
  return { month, ...r };
}
