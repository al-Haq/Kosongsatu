import nodemailer from "nodemailer";
import { chmodSync } from "node:fs";
import {
  id,
  now,
  today,
  check,
  AppError,
  text,
  integer,
  addDays,
  currency,
  date,
} from "./domain.mjs";
import { renderPdf } from "./pdf.mjs";
import { renderStatementPdf } from "./statement.mjs";
export function migrateMail(db, path) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version >= 5) return;
  if (
    path !== ":memory:" &&
    db.prepare("SELECT count(*) n FROM documents").get().n
  ) {
    const snapshot = path + ".pre-v5-" + Date.now() + ".sqlite";
    db.prepare("VACUUM INTO ?").run(snapshot);
    chmodSync(snapshot, 0o600);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
 CREATE TABLE email_log(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('document','reminder','statement')),document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,recipients TEXT NOT NULL,subject TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('sending','sent','failed')),error TEXT,message_id TEXT,dedupe_key TEXT UNIQUE,created TEXT NOT NULL);
 CREATE INDEX email_document_idx ON email_log(document_id);
 PRAGMA user_version=5; COMMIT;`);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
const dateLabel = (v) =>
  new Date(v + "T00:00:00Z").toLocaleDateString("en-MY", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
export function mailConfiguration(env = process.env) {
  if (!env.SMTP_HOST || !env.MAIL_FROM) return null;
  const port = Number(env.SMTP_PORT || 587);
  check(
    Number.isInteger(port) && port > 0 && port < 65536,
    "SMTP_PORT is invalid.",
  );
  return {
    host: env.SMTP_HOST,
    port,
    // Port 465 uses implicit TLS; other ports must upgrade with STARTTLS.
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465,
    requireTLS: port !== 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    from: env.MAIL_FROM,
    replyTo: env.MAIL_REPLY_TO || undefined,
  };
}
const emailList = (value, required = true) => {
  const list = text(value || "", 600, required)
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter(Boolean);
  check(!required || list.length, "Enter at least one recipient.");
  check(list.length <= 5, "Send to at most 5 recipients.");
  for (const e of list)
    check(/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(e), `Invalid email: ${e}`);
  return list;
};
const DEFAULT_STAGES = { before: 3, after: "1,7,14" };
export function reminderSettings(settings) {
  const after = String(settings.reminderAfterDays ?? DEFAULT_STAGES.after)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => integer(v, 1, 120));
  return {
    enabled: settings.remindersEnabled === true,
    before: integer(settings.reminderBeforeDays ?? DEFAULT_STAGES.before, 0, 30),
    after: [...new Set(after)].sort((a, b) => a - b).slice(0, 5),
  };
}
// Days after a stage during which a missed reminder may still go out (server downtime);
// beyond it the stage is skipped rather than sending a stale message.
const STAGE_WINDOW = 2;
export function dueStage(dueDate, asOf, stages) {
  const days = Math.round(
    (Date.parse(asOf + "T00:00:00Z") - Date.parse(dueDate + "T00:00:00Z")) /
      86400000,
  );
  const candidates = [
    ...(stages.before > 0 ? [{ key: `before-${stages.before}`, at: -stages.before }] : []),
    ...stages.after.map((n) => ({ key: `after-${n}`, at: n })),
  ];
  return (
    candidates
      .filter((s) => days >= s.at && days <= s.at + STAGE_WINDOW)
      .sort((a, b) => b.at - a.at)[0] || null
  );
}
export class Mailer {
  constructor(store, { config = mailConfiguration(), transport } = {}) {
    this.store = store;
    this.config = config;
    this.transport =
      transport || (config ? nodemailer.createTransport(config) : null);
    this.running = false;
  }
  status() {
    return {
      configured: !!(this.config && this.transport),
      from: this.config?.from || null,
    };
  }
  async deliver({ kind, documentId = null, clientId = null, to, cc = [], subject, body, attachments, dedupeKey = null }) {
    check(this.status().configured, "Email is not configured on the server. Set SMTP_HOST and MAIL_FROM.", 409);
    const db = this.store.db;
    let logId = id();
    const previous = dedupeKey
      ? db.prepare("SELECT id,status FROM email_log WHERE dedupe_key=?").get(dedupeKey)
      : null;
    // A deduplicated message goes out once; only a failed attempt is retried.
    if (previous && previous.status !== "failed") return null;
    if (previous) {
      logId = previous.id;
      db.prepare("UPDATE email_log SET status='sending',error=NULL WHERE id=?").run(logId);
    } else
      db.prepare(
        "INSERT INTO email_log(id,kind,document_id,client_id,recipients,subject,status,dedupe_key,created) VALUES(?,?,?,?,?,?,'sending',?,?)",
      ).run(logId, kind, documentId, clientId, [...to, ...cc].join(", "), subject, dedupeKey, now());
    try {
      const info = await this.transport.sendMail({
        from: this.config.from,
        replyTo: this.config.replyTo,
        to,
        cc: cc.length ? cc : undefined,
        subject,
        text: body,
        attachments,
      });
      db.prepare("UPDATE email_log SET status='sent',message_id=? WHERE id=?").run(
        String(info?.messageId || ""),
        logId,
      );
      this.store.audit("email.sent", documentId || clientId, `${kind}: ${subject}`, null, {
        recipients: [...to, ...cc],
      });
      return { id: logId, status: "sent" };
    } catch {
      db.prepare("UPDATE email_log SET status='failed',error=? WHERE id=?").run(
        "The mail server rejected or did not accept the message.",
        logId,
      );
      this.store.audit("email.failed", documentId || clientId, `${kind}: ${subject}`);
      throw new AppError(
        "Email could not be sent. Check the mail server settings and try again.",
        502,
      );
    }
  }
  async sendDocument(did, b, linkFor) {
    const d = this.store.document(did);
    check(
      ["issued", "accepted"].includes(d.state),
      "Issue the document before emailing it.",
      409,
    );
    const to = emailList(b.to),
      cc = emailList(b.cc, false);
    const label = d.kind === "quote" ? "Quotation" : "Invoice";
    const subject = text(
      b.subject || `${label} ${d.number} from ${d.business.company}`,
      200,
      true,
    );
    const message = text(b.message || "", 4000);
    let link = "";
    if (b.include_link) {
      const r = this.store.share(did, b.link_days ?? 30);
      link = linkFor(r.token);
    }
    const lines = [
      message ||
        `Dear ${d.client.contact || d.client.name},\n\nPlease find ${label.toLowerCase()} ${d.number} attached.`,
      "",
      `${label}: ${d.number}`,
      `${d.kind === "quote" ? "Valid until" : "Due date"}: ${dateLabel(d.due_date)}`,
      d.kind === "quote"
        ? `Total: ${currency(d.total)}`
        : `Balance due: ${currency(d.balance)}`,
      ...(d.kind === "invoice" && d.business.bankAccount
        ? ["", "Payment details:", d.business.bankName, d.business.bankHolder, d.business.bankAccount, `Reference: ${d.number}`]
        : []),
      ...(link ? ["", `View online: ${link}`] : []),
      "",
      d.business.company,
    ];
    return this.deliver({
      kind: "document",
      documentId: did,
      clientId: d.client_id,
      to,
      cc,
      subject,
      body: lines.filter((l) => l !== undefined).join("\n"),
      attachments: [{ filename: `${d.number}.pdf`, content: await renderPdf(d), contentType: "application/pdf" }],
    });
  }
  async sendStatement(cid, b) {
    const statement = this.store.statement(cid, b);
    const to = emailList(b.to || statement.client.email),
      cc = emailList(b.cc, false);
    const subject = text(
      b.subject || `Statement of account from ${statement.business.company}`,
      200,
      true,
    );
    const body = [
      text(b.message || "", 4000) ||
        `Dear ${statement.client.contact || statement.client.name},\n\nPlease find your statement of account attached.`,
      "",
      `Period: ${dateLabel(statement.from)} to ${dateLabel(statement.to)}`,
      `Balance due: ${currency(statement.closing)}`,
      "",
      statement.business.company,
    ].join("\n");
    return this.deliver({
      kind: "statement",
      clientId: cid,
      to,
      cc,
      subject,
      body,
      attachments: [{ filename: `statement-${statement.to}.pdf`, content: await renderStatementPdf(statement), contentType: "application/pdf" }],
    });
  }
  // Sends at most one reminder per invoice and stage. Never sends when disabled or unconfigured.
  async runReminders(asOf = today()) {
    const settings = this.store.settings();
    const stages = reminderSettings(settings);
    if (!stages.enabled || !this.status().configured || this.running)
      return { sent: 0, skipped: true };
    this.running = true;
    let sent = 0;
    try {
      const due = this.store
        .documents()
        .filter((d) => d.kind === "invoice" && d.state === "issued" && d.balance > 0 && d.client.email);
      for (const d of due) {
        const stage = dueStage(d.due_date, asOf, stages);
        if (!stage) continue;
        const overdue = stage.at > 0;
        const subject = `${overdue ? "Overdue" : "Upcoming"} payment reminder: ${d.number}`;
        const body = [
          `Dear ${d.client.contact || d.client.name},`,
          "",
          overdue
            ? `Our records show that invoice ${d.number} was due on ${dateLabel(d.due_date)} and has an outstanding balance of ${currency(d.balance)}.`
            : `This is a reminder that invoice ${d.number} is due on ${dateLabel(d.due_date)}. The balance is ${currency(d.balance)}.`,
          "If you have already paid, please ignore this message or reply with your transaction reference.",
          ...(d.business.bankAccount
            ? ["", "Payment details:", d.business.bankName, d.business.bankHolder, d.business.bankAccount, `Reference: ${d.number}`]
            : []),
          "",
          d.business.company,
        ].join("\n");
        try {
          const r = await this.deliver({
            kind: "reminder",
            documentId: d.id,
            clientId: d.client_id,
            to: [d.client.email],
            subject,
            body,
            attachments: [{ filename: `${d.number}.pdf`, content: await renderPdf(d), contentType: "application/pdf" }],
            dedupeKey: `reminder:${d.id}:${stage.key}`,
          });
          if (r) sent++;
        } catch {
          // Failure is logged per invoice; one bad address must not block the others.
        }
      }
      return { sent, skipped: false };
    } finally {
      this.running = false;
    }
  }
}
export function attachMail(Store) {
  const originalSettings = Store.prototype.saveSettings;
  Object.assign(Store.prototype, {
    saveSettings(b) {
      return this.tx(() => {
        const out = originalSettings.call(this, b);
        const next = { ...out };
        if ("remindersEnabled" in b) next.remindersEnabled = b.remindersEnabled === true;
        if ("reminderBeforeDays" in b) next.reminderBeforeDays = integer(b.reminderBeforeDays, 0, 30);
        if ("reminderAfterDays" in b) next.reminderAfterDays = text(String(b.reminderAfterDays), 40);
        reminderSettings(next);
        this.db.prepare("UPDATE settings SET data=? WHERE id=1").run(JSON.stringify(next));
        return next;
      });
    },
    emailLog(limit = 100) {
      return this.db
        .prepare("SELECT id,kind,document_id,client_id,recipients,subject,status,error,created FROM email_log ORDER BY created DESC LIMIT ?")
        .all(limit);
    },
    // Statement of account: opening balance, dated movements and aging for one client.
    statement(cid, b = {}) {
      const client = this.client(cid);
      const to = b.to_date ? date(b.to_date) : today();
      const from = b.from_date ? date(b.from_date) : addDays(to, -90);
      check(from <= to, "Choose a valid statement period.");
      const docs = this.documents().filter(
        (d) => d.client_id === cid && d.kind === "invoice" && d.state === "issued",
      );
      const entries = [];
      for (const d of docs) {
        entries.push({ date: d.issue_date, type: "Invoice", ref: d.number, debit: d.total, credit: 0 });
        for (const a of d.adjustments)
          entries.push({
            date: a.issue_date,
            type: a.kind === "credit" ? "Credit note" : "Debit note",
            ref: a.number,
            debit: a.kind === "debit" ? a.amount : 0,
            credit: a.kind === "credit" ? a.amount : 0,
          });
        for (const p of d.payments)
          if (p.applied > 0)
            entries.push({ date: p.paid_date, type: "Payment", ref: d.number, debit: 0, credit: p.applied });
      }
      entries.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
      const net = (e) => e.debit - e.credit;
      const opening = entries.filter((e) => e.date < from).reduce((s, e) => s + net(e), 0);
      let running = opening;
      const lines = entries
        .filter((e) => e.date >= from && e.date <= to)
        .map((e) => ({ ...e, balance: (running += net(e)) }));
      const aging = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 };
      for (const d of docs) {
        if (d.balance <= 0) continue;
        const late = Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(d.due_date + "T00:00:00Z")) / 86400000);
        const bucket = late <= 0 ? "current" : late <= 30 ? "d30" : late <= 60 ? "d60" : late <= 90 ? "d90" : "over90";
        aging[bucket] += d.balance;
      }
      return {
        client,
        business: this.settings(),
        from,
        to,
        opening,
        lines,
        closing: running,
        outstanding: docs.reduce((s, d) => s + d.balance, 0),
        aging,
        open: docs
          .filter((d) => d.balance > 0)
          .map((d) => ({ number: d.number, issue_date: d.issue_date, due_date: d.due_date, balance: d.balance })),
      };
    },
  });
}
