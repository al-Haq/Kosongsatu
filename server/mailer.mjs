import { imageSize, fitBox } from "./pdf-logo.mjs";
import nodemailer from "nodemailer";
import { chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  id,
  now,
  today,
  hash,
  check,
  AppError,
  text,
  integer,
  addDays,
  date,
} from "./domain.mjs";
import { renderPdf, renderReceiptPdf } from "./pdf.mjs";
import { renderStatementPdf } from "./statement.mjs";
import {
  DEFAULT_TEMPLATES,
  USES,
  templateUse,
  renderTemplate,
  validateTemplate,
  documentVars,
  statementVars,
  receiptVars,
  pickLanguage,
  emailHtml,
  words,
} from "./comms-templates.mjs";
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
// SMTP settings. They can be set on the server or in Settings > Integration keys
// (the server environment wins); changes apply to the next email without a restart.
export const MAIL_SETTINGS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_SECURE",
  "MAIL_FROM",
  "MAIL_REPLY_TO",
];
export function mailConfiguration(env = process.env) {
  if (!env.SMTP_HOST || !env.MAIL_FROM) return null;
  const port = Number(env.SMTP_PORT || 587);
  check(
    Number.isInteger(port) && port > 0 && port < 65536,
    "SMTP_PORT is invalid.",
  );
  check(/@/.test(env.MAIL_FROM), "MAIL_FROM must be an email address.");
  check(!env.MAIL_REPLY_TO || /@/.test(env.MAIL_REPLY_TO), "MAIL_REPLY_TO must be an email address.");
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
export { emailList };
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
// The provider's own message ID from the SMTP reply ("250 Ok <id>", "queued as <id>"),
// used to match bounce reports from services that replace the Message-ID header.
export function providerMessageId(response) {
  const s = String(response || "");
  const m =
    s.match(/queued as\s+<?([^\s<>]+)>?/i) ||
    s.match(/^2\d\d[\s-]+(?:\d\.\d\.\d\s+)?ok:?\s+<?([A-Za-z0-9._@=-]{6,200})>?/i);
  return m ? m[1] : null;
}
// Plain reasons for a failed test email; the raw server reply is never shown.
const SMTP_REASONS = {
  EAUTH: "The mail server refused the username or password.",
  ECONNECTION: "Could not connect to the mail server. Check the host and port.",
  ESOCKET: "Could not connect to the mail server. Check the host, port and TLS setting.",
  ETIMEDOUT: "The mail server did not answer in time. Check the host and port.",
  EDNS: "The mail server name could not be found. Check the host.",
  EENVELOPE: "The mail server refused the sender or recipient address. Check MAIL_FROM.",
  ETLS: "A secure connection to the mail server could not be made.",
};
export class Mailer {
  // The logo at the top of emails: the business's own once uploaded (served
  // publicly by the setup module, and only while set), otherwise Nawlogic's.
  logoPath() {
    try {
      const own = this.store.branding?.().logo;
      if (own) return own;
    } catch {}
    return "/assets/nawlogic-logo.png";
  }
  // With its exact display size, worked out from the image: email programs
  // ignore CSS limits, so a tall or wide logo still fits 150 x 60.
  emailLogo() {
    const src = `${this.appUrl}${this.logoPath()}`;
    let size = { width: 400, height: 106 };
    try {
      if (!src.endsWith("/assets/nawlogic-logo.png")) size = imageSize(this.store.brandLogo?.()?.data) || size;
    } catch {}
    return { src, ...fitBox(size, 150, 60) };
  }
  constructor(store, { config, transport, createTransport } = {}) {
    this.store = store;
    // An explicit config (tests, embedding) is fixed; otherwise it is read on each use.
    this.fixed = config !== undefined;
    this.fixedConfig = config ?? null;
    this.injected = transport || null;
    this.createTransport = createTransport || ((c) => nodemailer.createTransport(c));
    this.cached = null;
    this.running = false;
    // Absolute links (open tracking, logo). Set by the app at start-up.
    this.appUrl = process.env.APP_URL || null;
  }
  // The SMTP settings in force now. The transport is rebuilt when they change.
  current() {
    let config = null,
      error = null,
      source = null;
    if (this.fixed) {
      config = this.fixedConfig;
      source = config ? "server" : null;
    } else {
      try {
        const env = {};
        for (const n of MAIL_SETTINGS) {
          const v = this.store.config(n);
          if (v !== null && v !== undefined && String(v).trim() !== "") env[n] = String(v).trim();
        }
        config = mailConfiguration(env);
        source = config ? (process.env.SMTP_HOST ? "server" : "settings") : null;
      } catch (e) {
        error = e instanceof AppError ? e.message : "The mail settings could not be read.";
      }
    }
    let transport = this.injected;
    if (config && !transport) {
      const key = JSON.stringify(config);
      if (this.cached?.key !== key) {
        try {
          this.cached?.transport?.close?.();
        } catch {
          // An old transport that cannot close is simply dropped.
        }
        this.cached = { key, transport: this.createTransport(config) };
      }
      transport = this.cached.transport;
    }
    return { config, transport: config ? transport : null, source, error };
  }
  get config() {
    return this.current().config;
  }
  status() {
    const c = this.current();
    return {
      configured: !!(c.config && c.transport),
      from: c.config?.from || null,
      source: c.source,
      error: c.error,
    };
  }
  comms() {
    return this.store.commsSettings?.() || {};
  }
  // Language for a message: the owner's choice, the document, the client, then
  // the business default.
  language(d, choice) {
    return pickLanguage(choice, d?.language, d?.client?.language, this.comms().language);
  }
  // The owner's edited template, or the default text.
  template(use, lang) {
    return (
      this.store.emailTemplate?.(use, lang) ||
      DEFAULT_TEMPLATES[use][lang] ||
      DEFAULT_TEMPLATES[use].en
    );
  }
  // Subject and body from the owner's text (if any) or the template. Problems are
  // reported before anything is created or sent.
  compose(use, lang, b, vars, allowed = USES[use].vars) {
    const tpl = this.template(use, lang);
    const subject = b.subject ? text(b.subject, 200, true) : tpl.subject;
    const body = b.message ? text(b.message, 5000) || tpl.body : tpl.body;
    const problems = [...validateTemplate(subject, allowed), ...validateTemplate(body, allowed)];
    if (problems.length) throw new AppError(problems[0]);
    return {
      render: (values) => ({
        subject: renderTemplate(subject, values, allowed, { singleLine: true }),
        body: renderTemplate(body, values, allowed),
      }),
    };
  }
  async deliver({
    kind,
    documentId = null,
    clientId = null,
    to,
    cc = [],
    subject,
    body,
    html,
    button = null,
    language = "en",
    track,
    attachments,
    dedupeKey = null,
  }) {
    const { config, transport } = this.current();
    check(
      config && transport,
      "Email is not configured. Add the SMTP settings in Settings > Integration keys.",
      409,
    );
    subject = String(subject).replace(/[\r\n]+/g, " ").trim();
    const db = this.store.db;
    let logId = id();
    const previous = dedupeKey
      ? db.prepare("SELECT id,status FROM email_log WHERE dedupe_key=?").get(dedupeKey)
      : null;
    // A deduplicated message goes out once; only a failed attempt is retried.
    if (previous && previous.status !== "failed") return null;
    // Open tracking is opt-in; the pixel token is stored as a hash.
    const tracking = (track ?? this.comms().trackOpens === true) && html !== false && !!this.appUrl;
    const pixel = tracking ? randomBytes(24).toString("base64url") : null;
    if (previous) {
      logId = previous.id;
      db.prepare(
        "UPDATE email_log SET status='sending',error=NULL,open_token=?,subject=?,recipients=? WHERE id=?",
      ).run(pixel ? hash(pixel) : null, subject, [...to, ...cc].join(", "), logId);
    } else
      db.prepare(
        "INSERT INTO email_log(id,kind,document_id,client_id,recipients,subject,status,dedupe_key,open_token,created) VALUES(?,?,?,?,?,?,'sending',?,?,?)",
      ).run(logId, kind, documentId, clientId, [...to, ...cc].join(", "), subject, dedupeKey, pixel ? hash(pixel) : null, now());
    const domain = (String(config.from).match(/@([A-Za-z0-9.-]+)/)?.[1] || "localhost").toLowerCase();
    const messageId = `<${logId}@${domain}>`;
    const company = this.store.settings().company;
    // Identifiers that bounce reports from common providers echo back.
    const headers = { "X-Kosongsatu-Id": logId };
    if (this.store.config("MAIL_EVENTS_TOKEN"))
      Object.assign(headers, {
        "X-PM-Metadata-kosongsatu-id": logId,
        "X-Mailgun-Variables": JSON.stringify({ kosongsatu_id: logId }),
        "X-SMTPAPI": JSON.stringify({ unique_args: { kosongsatu_id: logId } }),
        "X-SES-MESSAGE-TAGS": `kosongsatu_id=${logId}`,
      });
    try {
      const info = await transport.sendMail({
        from: config.from,
        replyTo: config.replyTo,
        to,
        cc: cc.length ? cc : undefined,
        subject,
        text: body,
        html:
          html === false
            ? undefined
            : html ||
              emailHtml({
                text: body,
                company,
                lang: language,
                button,
                pixel: pixel ? `${this.appUrl}/api/guest/comms/open/${pixel}.gif` : null,
                logo: this.appUrl?.startsWith("https://") ? this.emailLogo() : null,
              }),
        attachments,
        messageId,
        headers,
      });
      db.prepare("UPDATE email_log SET status='sent',message_id=?,provider_id=? WHERE id=?").run(
        String(info?.messageId || messageId),
        providerMessageId(info?.response),
        logId,
      );
      this.store.audit("email.sent", documentId || clientId, `${kind}: ${subject}`, null, {
        recipients: [...to, ...cc],
      });
      return { id: logId, status: "sent" };
    } catch (e) {
      db.prepare("UPDATE email_log SET status='failed',error=?,open_token=NULL WHERE id=?").run(
        "The mail server rejected or did not accept the message.",
        logId,
      );
      this.store.audit("email.failed", documentId || clientId, `${kind}: ${subject}`);
      throw Object.assign(
        new AppError("Email could not be sent. Check the mail server settings and try again.", 502),
        { reason: SMTP_REASONS[e?.code] || null },
      );
    }
  }
  // Rotates the client link for one message; if sending fails the previous
  // link is put back, because the new one never reached anyone.
  async withLink(did, days, linkFor, fn) {
    const previous = this.store.db
      .prepare("SELECT token_hash,token_expires FROM documents WHERE id=?")
      .get(did);
    const r = this.store.share(did, days);
    try {
      return await fn(linkFor(r.token));
    } catch (e) {
      this.store.db
        .prepare("UPDATE documents SET token_hash=?,token_expires=? WHERE id=?")
        .run(previous.token_hash, previous.token_expires, did);
      this.store.audit("link.restored", did, "Message failed; previous link kept.");
      throw e;
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
    const lang = this.language(d, b.language);
    const use = templateUse(d.kind);
    const composer = this.compose(use, lang, b);
    const days = b.link_days === undefined || b.link_days === "" ? 30 : integer(b.link_days, 1, 90);
    const pdf = await renderPdf(d, null, await this.store.pdfBlocks(d));
    const send = (link = "") => {
      const m = composer.render(documentVars(d, { lang, link }));
      // A new link must reach the client even if the owner's text left it out.
      if (link && !m.body.includes(link)) m.body += `\n\n${words(lang).viewOnline}: ${link}`;
      return this.deliver({
        kind: "document",
        documentId: did,
        clientId: d.client_id,
        to,
        cc,
        subject: m.subject,
        body: m.body,
        language: lang,
        button: link ? { label: words(lang).button[use], url: link } : null,
        attachments: [{ filename: `${d.number}.pdf`, content: pdf, contentType: "application/pdf" }],
      });
    };
    return b.include_link ? this.withLink(did, days, linkFor, send) : send();
  }
  async sendStatement(cid, b) {
    const statement = this.store.statement(cid, b);
    const to = emailList(b.to || statement.client.email),
      cc = emailList(b.cc, false);
    const lang = this.language({ client: statement.client }, b.language);
    const m = this.compose("statement", lang, b).render(statementVars(statement, lang));
    return this.deliver({
      kind: "statement",
      clientId: cid,
      to,
      cc,
      subject: m.subject,
      body: m.body,
      language: lang,
      attachments: [{ filename: `statement-${statement.to}.pdf`, content: await renderStatementPdf(statement), contentType: "application/pdf" }],
    });
  }
  // Official receipt by email. With a dedupe key (automatic receipts) it goes out once.
  async sendReceipt(rid, b = {}, { dedupeKey = null } = {}) {
    const r = this.store.receipt(rid);
    check(!r.voided, "Receipt was voided.", 409);
    const to = emailList(b.to || r.client.email),
      cc = emailList(b.cc, false);
    const lang = this.language({ client: r.client }, b.language);
    const invoices = [
      ...new Map(
        r.allocations
          .filter((a) => a.applied > 0)
          .map((a) => {
            const d = this.store.document(a.invoice_id);
            return [d.id, d.number];
          }),
      ),
    ];
    const m = this.compose("receipt", lang, b).render(
      receiptVars(r, invoices.map(([, n]) => n), lang),
    );
    return this.deliver({
      kind: "receipt",
      documentId: invoices[0]?.[0] || null,
      clientId: r.client_id,
      to,
      cc,
      subject: m.subject,
      body: m.body,
      language: lang,
      dedupeKey,
      attachments: [{ filename: `${r.number}.pdf`, content: await renderReceiptPdf(r), contentType: "application/pdf" }],
    });
  }
  // "Send test email" in Settings. The reason for a failure is shown in plain words.
  async sendTest(address) {
    const to = emailList(address);
    const { config } = this.current();
    const company = this.store.settings().company;
    try {
      return await this.deliver({
        kind: "test",
        to,
        subject: `Test email from ${company}`,
        body: `This is a test email from ${company}.\n\nIf you can read this, your email settings work. Invoices, statements and reminders will be sent from ${config?.from || "your configured address"}.`,
        track: false,
      });
    } catch (e) {
      if (e.reason) throw new AppError(`${e.message} ${e.reason}`, e.status);
      throw e;
    }
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
      const links = this.comms().reminderLinks === true && this.appUrl;
      for (const d of due) {
        const stage = dueStage(d.next_due_date || d.due_date, asOf, stages);
        if (!stage) continue;
        // Each instalment date gets its own reminders, once each.
        const plan = d.instalments?.length > 0 && d.next_due_date;
        const dedupeKey = plan
          ? `reminder:${d.id}:${d.next_due_date}:${stage.key}`
          : `reminder:${d.id}:${stage.key}`;
        const done = this.store.db.prepare("SELECT status FROM email_log WHERE dedupe_key=?").get(dedupeKey);
        if (done && done.status !== "failed") continue;
        const use = stage.at > 0 ? "reminder_after" : "reminder_before";
        const lang = this.language(d);
        try {
          const composer = this.compose(use, lang, {});
          const pdf = await renderPdf(d, null, await this.store.pdfBlocks(d));
          const send = (link = "") => {
            const m = composer.render(documentVars(d, { lang, link, asOf }));
            return this.deliver({
              kind: "reminder",
              documentId: d.id,
              clientId: d.client_id,
              to: [d.client.email],
              subject: m.subject,
              body: m.body,
              language: lang,
              button: link ? { label: words(lang).button.invoice, url: link } : null,
              attachments: [{ filename: `${d.number}.pdf`, content: pdf, contentType: "application/pdf" }],
              dedupeKey,
            });
          };
          const r = links
            ? await this.withLink(d.id, 30, (t) => `${this.appUrl}/client/${t}`, send)
            : await send();
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
        .prepare(
          "SELECT id,kind,document_id,client_id,recipients,subject,status,error,created,open_token IS NOT NULL AS tracked,opened_first,opened_last,open_count,bounced,bounce_type,bounce_detail FROM email_log ORDER BY created DESC LIMIT ?",
        )
        .all(limit);
    },
    // Statement of account: opening balance, dated movements and aging for one client.
    statement(cid, b = {}) {
      const client = this.client(cid);
      const to = b.to_date ? date(b.to_date) : today();
      const from = b.from_date ? date(b.from_date) : addDays(to, -90);
      check(from <= to, "Choose a valid statement period.");
      const docs = this.documents().filter(
        (d) =>
          d.client_id === cid &&
          d.kind === "invoice" &&
          d.state === "issued" &&
          (d.currency || "MYR") === (b.currency || "MYR"),
      );
      // A credit note can later move part of a payment back to customer funds.
      // That move is dated with the note, so a statement that ended before it
      // still shows the payment in full and the balance it had then.
      const moves = (p) => (p.reversed ? [] : p.releases || []);
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
        for (const p of d.payments) {
          if (p.reversed) continue;
          entries.push({ date: p.paid_date, type: "Payment", ref: d.number, debit: 0, credit: p.amount });
          for (const m of moves(p))
            entries.push({ date: m.date, type: "Moved to customer funds", ref: d.number, debit: m.amount, credit: 0 });
        }
      }
      entries.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
      const net = (e) => e.debit - e.credit;
      const opening = entries.filter((e) => e.date < from).reduce((s, e) => s + net(e), 0);
      let running = opening;
      const lines = entries
        .filter((e) => e.date >= from && e.date <= to)
        .map((e) => ({ ...e, balance: (running += net(e)) }));
      // Balances are taken as at the statement end date, so later activity
      // never changes a statement that has already ended.
      const atEnd = docs
        .filter((d) => d.issue_date <= to)
        .map((d) => {
          let balance = d.total;
          for (const a of d.adjustments)
            if (a.issue_date <= to) balance += a.kind === "debit" ? a.amount : -a.amount;
          for (const p of d.payments) {
            if (p.reversed || p.paid_date > to) continue;
            balance -= p.amount;
            for (const m of moves(p)) if (m.date <= to) balance += m.amount;
          }
          return { ...d, balance };
        });
      const aging = { current: 0, d30: 0, d60: 0, d90: 0, over90: 0 };
      for (const d of atEnd) {
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
        outstanding: atEnd.reduce((s, d) => s + d.balance, 0),
        aging,
        open: atEnd
          .filter((d) => d.balance > 0)
          .map((d) => ({ number: d.number, issue_date: d.issue_date, due_date: d.due_date, balance: d.balance })),
      };
    },
  });
}
