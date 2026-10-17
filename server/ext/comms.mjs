// Communication: mail settings, email templates, open and bounce tracking,
// WhatsApp Business, owner notifications, the AI collection agent and link
// previews for shared client links.
// Feature module contract: see docs/PLUGINS.md. Owner guide: docs/features/comms.md.
import { now, today, hash, check, AppError, text, integer } from "../domain.mjs";
import { requestContext } from "../context.mjs";
import { registerProposalKind } from "../automation.mjs";
import { dueStage, reminderSettings } from "../mailer.mjs";
import {
  DEFAULT_TEMPLATES,
  USES,
  LANGUAGES,
  LANGUAGE_LABELS,
  VAR_HELP,
  validateTemplate,
  renderTemplate,
  documentVars,
  statementVars,
  receiptVars,
  templateUse,
  pickLanguage,
  formatMoney,
  formatDate,
  emailHtml,
} from "../comms-templates.mjs";
import { parseMailEvents, applyMailEvents } from "../comms-mail-events.mjs";
import { WhatsApp, normalizePhone, validSignature, sameSecret, templateComponents } from "../comms-whatsapp.mjs";
import { NOTIFY_TYPES, collectNotifications, deliverNotifications } from "../comms-notify.mjs";
import {
  proposalSchema,
  validateProposal,
  applyProposal,
  proposalSummary,
  prepareFollowUp,
  sendFollowUp,
} from "../comms-collect.mjs";
// WhatsApp templates the owner maps to their approved Meta templates.
export const WA_USES = {
  invoice_link: { label: "Send invoice link", vars: [...USES.invoice.vars, "link_token"] },
  quote_link: { label: "Send quotation link", vars: [...USES.quote.vars, "link_token"] },
  payment_reminder: { label: "Payment reminder", vars: [...USES.reminder_after.vars, "days_left", "link_token"] },
  owner_alert: { label: "Owner notification", vars: ["title", "summary", "link"] },
};
const DEFAULTS = () => ({
  language: "en",
  trackOpens: false,
  reminderLinks: false,
  autoReceipts: false,
  ownerEmail: "",
  ownerWhatsApp: "",
  notify: Object.fromEntries(
    Object.entries(NOTIFY_TYPES).map(([k, t]) => [k, { inapp: t.inapp, email: false, whatsapp: false }]),
  ),
  whatsapp: { reminders: false, templates: Object.fromEntries(Object.keys(WA_USES).map((k) => [k, null])) },
  collection: { enabled: false, useAi: false, minDays: 3, email: true, whatsapp: false, includeLink: false },
  sns: null,
});
function merge(base, extra) {
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra))
    if (k in base)
      out[k] =
        base[k] && typeof base[k] === "object" && !Array.isArray(base[k]) && v && typeof v === "object" && !Array.isArray(v)
          ? merge(base[k], v)
          : v;
  return out;
}
const bool = (v, name) => {
  check(typeof v === "boolean", `${name} must be on or off.`);
  return v;
};
function waMapping(use, m) {
  if (m === null || m === undefined || m === "") return null;
  check(m && typeof m === "object", "Invalid WhatsApp template settings.");
  const name = text(String(m.name || ""), 512, true);
  check(/^[a-z0-9_]{1,512}$/.test(name), "WhatsApp template names use lowercase letters, numbers and underscores.");
  const language = text(String(m.language || ""), 10, true);
  check(/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language), "Use a WhatsApp language code such as en, en_US or ms.");
  const raw = Array.isArray(m.params) ? m.params : String(m.params || "").split(",");
  const params = raw.map((p) => String(p).trim()).filter(Boolean);
  check(params.length <= 10, "Use at most 10 template parameters.");
  const allowed = WA_USES[use].vars;
  const named = params.some((p) => p.includes("="));
  for (const p of params) {
    const [left, right] = p.split("=").map((x) => x.trim());
    const variable = right === undefined ? left : right;
    check(!named || right !== undefined, "Use name=value for every parameter of a named template, or plain values for all.");
    check(!named || /^[a-z_][a-z0-9_]{0,40}$/.test(left), `Invalid parameter name "${left}".`);
    check(allowed.includes(variable), `Unknown value "${variable}". Available: ${allowed.join(", ")}.`);
  }
  check(["", "link_token"].includes(m.button || ""), "Invalid button setting.");
  return { name, language, params, button: m.button || "" };
}
function cleanSettings(current, b) {
  const next = structuredClone(current);
  if ("language" in b) {
    check(LANGUAGES.includes(b.language), "Choose English or Bahasa Melayu.");
    next.language = b.language;
  }
  for (const k of ["trackOpens", "reminderLinks", "autoReceipts"]) if (k in b) next[k] = bool(b[k], k);
  if ("ownerEmail" in b) {
    const v = text(String(b.ownerEmail || ""), 160).toLowerCase();
    check(!v || /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(v), "Enter a valid email for notifications.");
    next.ownerEmail = v;
  }
  if ("ownerWhatsApp" in b) {
    const raw = text(String(b.ownerWhatsApp || ""), 30);
    const v = raw ? normalizePhone(raw) : "";
    check(!raw || v, "Enter your WhatsApp number with the country code, e.g. 60123456789.");
    next.ownerWhatsApp = v;
  }
  if ("notify" in b) {
    check(b.notify && typeof b.notify === "object", "Invalid notification settings.");
    for (const [type, pref] of Object.entries(b.notify)) {
      check(type in NOTIFY_TYPES, "Unknown notification type.");
      for (const ch of ["inapp", "email", "whatsapp"]) if (pref && ch in pref) next.notify[type][ch] = bool(pref[ch], ch);
    }
  }
  if ("whatsapp" in b) {
    const w = b.whatsapp || {};
    if ("reminders" in w) next.whatsapp.reminders = bool(w.reminders, "WhatsApp reminders");
    if (w.templates) {
      check(typeof w.templates === "object", "Invalid WhatsApp template settings.");
      for (const [use, m] of Object.entries(w.templates)) {
        check(use in WA_USES, "Unknown WhatsApp message type.");
        next.whatsapp.templates[use] = waMapping(use, m);
      }
    }
  }
  if ("collection" in b) {
    const c = b.collection || {};
    for (const k of ["enabled", "useAi", "email", "whatsapp", "includeLink"]) if (k in c) next.collection[k] = bool(c[k], k);
    if ("minDays" in c) next.collection.minDays = integer(c.minDays, 1, 90);
  }
  return next;
}
const ownerEmail = (store) => store.db.prepare("SELECT email FROM owners ORDER BY id LIMIT 1").get()?.email || "";
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const attr = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Open Graph / Twitter tags for a shared client link. Reading them never marks
// the document as viewed; expired, revoked or void links get no details.
export function linkPreviewHead(store, path, appUrl) {
  const m = path.match(/^\/client\/([^/]+)$/);
  if (!m) return "";
  const company = store.settings().company;
  const image = `${appUrl}/assets/link-preview.png`;
  let title = `Document from ${company}`,
    description = "Private client link. Open it to view the document.",
    url = null,
    lang = "en";
  const token = m[1];
  const row = /^[\w-]{43}$/.test(token)
    ? store.db
        .prepare("SELECT id FROM documents WHERE token_hash=? AND token_expires>? AND state NOT IN ('void','draft')")
        .get(hash(token), Date.now())
    : null;
  if (row) {
    const d = store.document(row.id);
    lang = pickLanguage(d.language, store.commsSettings().language);
    const v = documentVars(d, { lang });
    const w = lang === "ms";
    url = `${appUrl}/client/${token}`;
    title = `${v.document_title} ${d.number} ${w ? "daripada" : "from"} ${d.business?.company || company}`;
    if (d.kind === "invoice")
      description =
        d.balance > 0
          ? w
            ? `Jumlah perlu dibayar ${v.balance} · Tarikh akhir ${v.due_date} · Lihat dan bayar dalam talian`
            : `Amount due ${v.balance} · Due ${v.due_date} · View and pay online`
          : w
            ? "Telah dibayar sepenuhnya · Terima kasih"
            : "Paid in full · Thank you";
    else if (d.kind === "quote")
      description =
        d.state === "accepted"
          ? w
            ? `Sebut harga diterima · Jumlah ${v.amount}`
            : `Accepted quotation · Total ${v.amount}`
          : w
            ? `Jumlah ${v.amount} · Sah sehingga ${v.due_date} · Lihat dan terima dalam talian`
            : `Total ${v.amount} · Valid until ${v.due_date} · View and accept online`;
    else description = w ? `${v.document_title} · Lihat dalam talian` : `${v.document_title} · View online`;
  }
  const tags = [
    ["property", "og:type", "website"],
    ["property", "og:site_name", company],
    ["property", "og:title", title],
    ["property", "og:description", description],
    ...(url ? [["property", "og:url", url]] : []),
    ["property", "og:image", image],
    ["property", "og:image:width", "1200"],
    ["property", "og:image:height", "630"],
    ["property", "og:image:alt", company],
    ["property", "og:locale", lang === "ms" ? "ms_MY" : "en_MY"],
    ["name", "twitter:card", "summary_large_image"],
    ["name", "twitter:title", title],
    ["name", "twitter:description", description],
    ["name", "twitter:image", image],
    ["name", "robots", "noindex, nofollow"],
  ];
  return tags.map(([k, n, v]) => `    <meta ${k}="${n}" content="${attr(v)}" />`).join("\n");
}
const waOf = (ctx) => ctx.services.whatsapp.client;
const settingsOf = (store) => store.commsSettings();
// The document link use for one document kind.
const linkUse = (d) => (d.kind === "quote" ? "quote_link" : "invoice_link");
const needsLink = (m) => !!m && (m.button === "link_token" || m.params.some((p) => /(^|=)\s*link(_token)?$/.test(p)));
async function sendDocumentWhatsApp(ctx, did, b) {
  const { store } = ctx;
  const d = store.document(did);
  check(["issued", "accepted"].includes(d.state), "Issue the document before sending it.", 409);
  const settings = settingsOf(store);
  const mapping = settings.whatsapp.templates[linkUse(d)];
  check(mapping, `Set up the WhatsApp "${WA_USES[linkUse(d)].label}" template in Settings first.`, 409);
  const to = normalizePhone(b.to || d.client.phone);
  check(to, "Enter the client's WhatsApp number with the country code, e.g. 60123456789.");
  const lang = pickLanguage(b.language, d.language, d.client.language, settings.language);
  const send = (link = "") =>
    waOf(ctx).send({
      to,
      kind: "document",
      template: mapping.name,
      language: mapping.language,
      components: templateComponents(mapping, { ...documentVars(d, { lang, link }), link_token: link ? link.split("/").pop() : "" }),
      summary: `${mapping.name}: ${d.number}${link ? " with a new link" : ""}`,
      documentId: d.id,
      clientId: d.client_id,
    });
  const days = b.link_days === undefined ? 30 : integer(b.link_days, 1, 90);
  return b.include_link !== false && needsLink(mapping)
    ? ctx.mailer.withLink(d.id, days, (t) => `${ctx.appUrl}/client/${t}`, send)
    : send();
}
// WhatsApp reminders: opt-in, same stages as the email reminders, once per stage.
async function runWhatsAppReminders(ctx, asOf = today()) {
  const { store } = ctx;
  const settings = settingsOf(store);
  const mapping = settings.whatsapp.templates.payment_reminder;
  const wa = waOf(ctx);
  if (!settings.whatsapp.reminders || !mapping || !wa.status().configured) return { sent: 0, skipped: true };
  const stages = reminderSettings(store.settings());
  let sent = 0;
  for (const d of store.documents()) {
    if (!(d.kind === "invoice" && d.state === "issued" && d.balance > 0)) continue;
    const phone = normalizePhone(d.client.phone);
    if (!phone) continue;
    const stage = dueStage(d.next_due_date || d.due_date, asOf, stages);
    if (!stage) continue;
    const dedupeKey = `wa-reminder:${d.id}:${stage.key}`;
    const done = store.db.prepare("SELECT status FROM comms_whatsapp WHERE dedupe_key=?").get(dedupeKey);
    if (done && done.status !== "failed") continue;
    const lang = pickLanguage(d.language, d.client.language, settings.language);
    const send = (link = "") =>
      wa.send({
        to: phone,
        kind: "reminder",
        template: mapping.name,
        language: mapping.language,
        components: templateComponents(mapping, {
          ...documentVars(d, { lang, link, asOf }),
          link_token: link ? link.split("/").pop() : "",
        }),
        summary: `${mapping.name}: ${d.number} (${stage.key})`,
        documentId: d.id,
        clientId: d.client_id,
        dedupeKey,
      });
    try {
      const r =
        settings.reminderLinks && needsLink(mapping)
          ? await ctx.mailer.withLink(d.id, 30, (t) => `${ctx.appUrl}/client/${t}`, send)
          : await send();
      if (r) sent++;
    } catch {
      // Logged per message; one bad number does not stop the others.
    }
  }
  return { sent, skipped: false };
}
// Overdue invoices that need a follow-up draft.
async function runCollections(ctx, { manual = false, asOf = today() } = {}) {
  const { store } = ctx;
  const settings = settingsOf(store);
  if (!manual && !settings.collection.enabled) return { prepared: 0, skipped: true };
  const due = store
    .documents()
    .filter(
      (d) =>
        d.kind === "invoice" &&
        d.state === "issued" &&
        d.balance > 0 &&
        (d.next_due_date || d.due_date) <= addDaysIso(asOf, -settings.collection.minDays),
    );
  let prepared = 0;
  const skipped = [];
  for (const d of due) {
    // At most 20 new drafts per run, so a large backlog never floods the review queue.
    if (prepared >= 20) break;
    try {
      const r = await prepareFollowUp(ctx, d.id, { settings, whatsappReady: waOf(ctx).status().configured, asOf });
      if (r.proposal && !r.skipped) prepared++;
      else skipped.push({ number: d.number, reason: r.skipped });
    } catch (e) {
      skipped.push({ number: d.number, reason: e.status ? e.message : "Could not prepare a draft." });
    }
  }
  return { prepared, skipped, skippedCount: skipped.length };
}
function addDaysIso(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Values for a template preview, from a real record when there is one.
function previewValues(store, use, lang, recordId, appUrl) {
  const docs = store.documents().filter((d) => ["issued", "accepted"].includes(d.state));
  const sampleLink = `${appUrl}/client/example-private-link`;
  if (use === "receipt") {
    const list = store.receipts().filter((r) => !r.voided).slice(0, 20);
    const r = list.find((x) => x.id === recordId) || list[0];
    const records = list.map((x) => ({ id: x.id, label: `${x.number} · ${x.client.name} · ${formatMoney(x.amount)}` }));
    if (!r) return { values: null, records };
    const numbers = r.allocations.filter((a) => a.applied > 0).map((a) => store.document(a.invoice_id).number);
    return { values: receiptVars(r, [...new Set(numbers)], lang), records, record: r.id };
  }
  if (use === "statement") {
    const clients = store.db.prepare("SELECT id,name FROM clients ORDER BY name LIMIT 50").all();
    const c = clients.find((x) => x.id === recordId) || clients[0];
    const records = clients.map((x) => ({ id: x.id, label: x.name }));
    if (!c) return { values: null, records };
    return { values: statementVars(store.statement(c.id), lang), records, record: c.id };
  }
  const kinds =
    use === "quote" ? ["quote"] : use === "document" ? null : ["invoice"];
  const list = docs
    .filter((d) => (kinds ? kinds.includes(d.kind) : !["invoice", "quote"].includes(d.kind)))
    .slice(0, 30);
  const d = list.find((x) => x.id === recordId) || list[0];
  const records = list.map((x) => ({ id: x.id, label: `${x.number} · ${x.client.name}` }));
  if (!d) return { values: null, records };
  return { values: documentVars(d, { lang, link: sampleLink }), records, record: d.id };
}
function sampleValues(use, lang) {
  const fake = {
    kind: use === "quote" ? "quote" : use === "document" ? "proforma" : "invoice",
    number: use === "quote" ? "QT-2026-0001" : "INV-2026-0001",
    issue_date: today(),
    due_date: addDaysIso(today(), use === "reminder_after" ? -7 : 14),
    total: 150000,
    adjusted_total: 150000,
    balance: 150000,
    paid: 0,
    client: { name: "Example Sdn Bhd", contact: "Puan Aminah" },
    business: { company: "Your company", bankName: "Example Bank", bankHolder: "Your company", bankAccount: "1234567890" },
  };
  return {
    ...documentVars(fake, { lang, link: "https://example.com/client/example-private-link" }),
    period_from: formatDate(addDaysIso(today(), -90), lang),
    period_to: formatDate(today(), lang),
    paid_date: formatDate(today(), lang),
    invoice_numbers: "INV-2026-0001",
    payment_method: "Bank transfer",
  };
}
export default {
  name: "comms",
  // Staff send documents, receipts and approved follow-ups and see alerts;
  // mail settings, templates and address clean-up stay with the owner.
  access: {
    staff: [
      ["GET", /^\/api\/comms\/(compose|notifications|templates)$/],
      ["POST", /^\/api\/comms\/notifications\/read$/],
      ["POST", /^\/api\/comms\/templates\/preview$/],
      ["POST", /^\/api\/comms\/receipts\/[\w-]+\/email$/],
      ["POST", /^\/api\/comms\/documents\/[\w-]+\/(whatsapp|follow-up)$/],
      ["POST", /^\/api\/comms\/collections\/[\w-]+\/(approve|retry)$/],
    ],
    accountant: [["GET", /^\/api\/comms\/(notifications|templates)$/]],
  },
  migrations: [
    {
      name: "comms-001-tracking",
      sql: `ALTER TABLE email_log ADD COLUMN provider_id TEXT;
ALTER TABLE email_log ADD COLUMN open_token TEXT;
ALTER TABLE email_log ADD COLUMN opened_first TEXT;
ALTER TABLE email_log ADD COLUMN opened_last TEXT;
ALTER TABLE email_log ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_log ADD COLUMN bounced TEXT;
ALTER TABLE email_log ADD COLUMN bounce_type TEXT;
ALTER TABLE email_log ADD COLUMN bounce_detail TEXT;
CREATE UNIQUE INDEX email_open_token_idx ON email_log(open_token) WHERE open_token IS NOT NULL;
CREATE INDEX email_message_idx ON email_log(message_id);
CREATE INDEX email_provider_idx ON email_log(provider_id);
CREATE TABLE comms_address_events(id TEXT PRIMARY KEY, email TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('hard','soft','complaint')), detail TEXT NOT NULL DEFAULT '', email_id TEXT, provider TEXT NOT NULL, created TEXT NOT NULL, cleared TEXT);
CREATE INDEX comms_address_idx ON comms_address_events(email);`,
    },
    {
      name: "comms-002-settings-templates",
      sql: `CREATE TABLE comms_settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
CREATE TABLE comms_templates(use TEXT NOT NULL, language TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY(use, language));`,
    },
    {
      name: "comms-003-whatsapp",
      sql: `CREATE TABLE comms_whatsapp(id TEXT PRIMARY KEY, direction TEXT NOT NULL CHECK(direction IN ('out','in')), kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 40), document_id TEXT REFERENCES documents(id) ON DELETE SET NULL, client_id TEXT REFERENCES clients(id) ON DELETE SET NULL, number TEXT NOT NULL, template TEXT, language TEXT, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('sending','sent','delivered','read','failed','received')), error TEXT, wa_id TEXT UNIQUE, dedupe_key TEXT UNIQUE, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE INDEX comms_whatsapp_doc_idx ON comms_whatsapp(document_id);
CREATE INDEX comms_whatsapp_number_idx ON comms_whatsapp(number, direction, created);`,
    },
    {
      name: "comms-004-notifications",
      sql: `CREATE TABLE comms_notifications(id TEXT PRIMARY KEY, audit_id INTEGER NOT NULL UNIQUE, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', entity_id TEXT, route TEXT, inapp INTEGER NOT NULL DEFAULT 1, email_state TEXT NOT NULL DEFAULT 'none' CHECK(email_state IN ('none','pending','sending','sent','failed','skipped')), wa_state TEXT NOT NULL DEFAULT 'none' CHECK(wa_state IN ('none','pending','sending','sent','failed','skipped')), created TEXT NOT NULL, read_at TEXT);
CREATE INDEX comms_notifications_created_idx ON comms_notifications(created);`,
    },
    {
      name: "comms-005-collections",
      sql: `CREATE TABLE comms_collections(id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES documents(id), tone TEXT NOT NULL, language TEXT NOT NULL, subject TEXT NOT NULL, message TEXT NOT NULL, channels TEXT NOT NULL, include_link INTEGER NOT NULL DEFAULT 0, generated_by TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('approved','sending','sent','partial','failed','cancelled')), result TEXT, created TEXT NOT NULL, sent TEXT);
CREATE INDEX comms_collections_invoice_idx ON comms_collections(invoice_id);`,
    },
  ],
  secrets: [
    { name: "SMTP_HOST", label: "SMTP server", help: "Your mail provider's SMTP host, e.g. smtp.gmail.com or email-smtp.ap-southeast-1.amazonaws.com", secret: false },
    { name: "SMTP_PORT", label: "SMTP port", help: "587 (STARTTLS, the default) or 465 (TLS)", secret: false },
    { name: "SMTP_USER", label: "SMTP username", help: "Usually your email address or the provider's SMTP user name", secret: false },
    { name: "SMTP_PASS", label: "SMTP password", help: "SMTP password or app password", secret: true },
    { name: "MAIL_FROM", label: "From address", help: 'Who emails come from, e.g. Nawlogic Billing <billing@nawlogic.my>', secret: false },
    { name: "MAIL_REPLY_TO", label: "Reply-to address (optional)", help: "Where client replies go, if not the From address", secret: false },
    { name: "MAIL_EVENTS_TOKEN", label: "Bounce webhook token", help: "A long random text. Add it to the bounce webhook address you give your mail provider", secret: true },
    { name: "WHATSAPP_ACCESS_TOKEN", label: "WhatsApp access token", help: "A permanent system user token from Meta Business Settings with whatsapp_business_messaging", secret: true },
    { name: "WHATSAPP_PHONE_NUMBER_ID", label: "WhatsApp phone number ID", help: "From WhatsApp Manager > API setup (a number, not your phone number)", secret: false },
    { name: "WHATSAPP_APP_SECRET", label: "Meta app secret", help: "Meta app > Settings > Basic. Used to check webhook signatures", secret: true },
    { name: "WHATSAPP_VERIFY_TOKEN", label: "WhatsApp webhook verify token", help: "Any long random text; enter the same text in the Meta webhook settings", secret: true },
    { name: "WHATSAPP_API_VERSION", label: "Graph API version (optional)", help: "Defaults to v25.0", secret: false },
  ],
  attach(Store) {
    Object.assign(Store.prototype, {
      commsSettings() {
        const row = this.db.prepare("SELECT data FROM comms_settings WHERE id=1").get();
        let data = null;
        try {
          data = row ? JSON.parse(row.data) : null;
        } catch {
          data = null;
        }
        return merge(DEFAULTS(), data);
      },
      saveCommsSettings(b) {
        check(b && typeof b === "object", "Invalid settings.");
        return this.tx(() => {
          const before = this.commsSettings();
          const next = cleanSettings(before, b);
          this.db
            .prepare("INSERT INTO comms_settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
            .run(JSON.stringify(next));
          this.audit("comms.settings.changed", null, "Messages and notifications", before, next);
          return next;
        });
      },
      _setCommsState(patch) {
        const next = { ...this.commsSettings(), ...patch };
        this.db
          .prepare("INSERT INTO comms_settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
          .run(JSON.stringify(next));
      },
      emailTemplate(use, lang) {
        const row = this.db.prepare("SELECT subject,body FROM comms_templates WHERE use=? AND language=?").get(use, lang);
        return row || null;
      },
      saveEmailTemplate(use, lang, b) {
        check(use in USES, "Unknown template.", 404);
        check(LANGUAGES.includes(lang), "Unknown language.", 404);
        const subject = text(String(b.subject ?? ""), 200, true).replace(/\s*\n\s*/g, " ");
        const body = text(String(b.body ?? ""), 5000, true);
        const problems = [...validateTemplate(subject, USES[use].vars), ...validateTemplate(body, USES[use].vars)];
        if (problems.length) throw new AppError(problems[0]);
        const before = this.emailTemplate(use, lang);
        this.db
          .prepare(
            "INSERT INTO comms_templates(use,language,subject,body,updated) VALUES(?,?,?,?,?) ON CONFLICT(use,language) DO UPDATE SET subject=excluded.subject,body=excluded.body,updated=excluded.updated",
          )
          .run(use, lang, subject, body, now());
        this.audit("email.template.saved", null, `${use} (${lang})`, before, { subject, body });
        return { use, language: lang, subject, body };
      },
      resetEmailTemplate(use, lang) {
        check(use in USES && LANGUAGES.includes(lang), "Unknown template.", 404);
        const before = this.emailTemplate(use, lang);
        this.db.prepare("DELETE FROM comms_templates WHERE use=? AND language=?").run(use, lang);
        if (before) this.audit("email.template.reset", null, `${use} (${lang})`, before, null);
        return { use, language: lang, ...DEFAULT_TEMPLATES[use][lang] };
      },
      // Addresses with an unresolved hard bounce or spam complaint.
      addressIssues(emails = null) {
        const rows = this.db
          .prepare(
            "SELECT email,type,detail,created FROM comms_address_events WHERE cleared IS NULL AND type IN ('hard','complaint') ORDER BY created DESC LIMIT 500",
          )
          .all();
        const seen = new Map();
        for (const r of rows) if (!seen.has(r.email)) seen.set(r.email, r);
        const list = [...seen.values()];
        if (!emails) return list;
        const wanted = emails.map((e) => String(e).trim().toLowerCase());
        return list.filter((r) => wanted.includes(r.email));
      },
      clearAddressIssue(email) {
        const e = text(String(email || ""), 160, true).toLowerCase();
        const r = this.db.prepare("UPDATE comms_address_events SET cleared=? WHERE email=? AND cleared IS NULL").run(now(), e);
        check(r.changes, "No warning for this address.", 404);
        this.audit("email.address.cleared", null, e);
      },
      notifications(limit = 50) {
        return this.db
          .prepare("SELECT id,type,title,body,route,email_state,wa_state,created,read_at FROM comms_notifications WHERE inapp=1 ORDER BY created DESC,audit_id DESC LIMIT ?")
          .all(limit);
      },
      unreadNotifications() {
        return this.db.prepare("SELECT count(*) n FROM comms_notifications WHERE inapp=1 AND read_at IS NULL").get().n;
      },
      readNotifications(b) {
        if (b.all === true)
          return this.db.prepare("UPDATE comms_notifications SET read_at=? WHERE read_at IS NULL").run(now()).changes;
        check(Array.isArray(b.ids) && b.ids.length <= 100, "Choose notifications to mark as read.");
        let n = 0;
        for (const nid of b.ids)
          n += this.db.prepare("UPDATE comms_notifications SET read_at=? WHERE id=? AND read_at IS NULL").run(now(), String(nid)).changes;
        return n;
      },
    });
    registerProposalKind("collection_message", {
      schema: proposalSchema,
      validate: validateProposal,
      apply: applyProposal,
      summary: proposalSummary,
    });
    // An approved follow-up is sent right after the approval commits (the
    // module's job also picks up anything left over).
    const originalReview = Store.prototype.reviewProposal;
    Store.prototype.reviewProposal = function (pid, approve, reason) {
      const out = originalReview.call(this, pid, approve, reason);
      if (approve && out?.kind === "collection_message" && this._commsSend) {
        const send = this._commsSend;
        setImmediate(() => send(out.id).catch(() => {}));
      }
      return out;
    };
  },
  init(ctx) {
    ctx.mailer.appUrl = ctx.appUrl;
    const wa = new WhatsApp(ctx.store);
    ctx.store._commsSend = (cid) => sendFollowUp(ctx, wa, settingsOf(ctx.store), cid);
    // Shared WhatsApp service for other modules (e.g. creating invoices from chat).
    ctx.services.whatsapp = {
      client: wa,
      status: () => wa.status(),
      configured: () => wa.status().configured,
      // send({ to, text }) inside the 24-hour window, or send({ to, use, vars })
      // with one of the owner's mapped templates, or send({ to, template, language, components }).
      send: (opts = {}) => {
        if (opts.use) {
          const mapping = settingsOf(ctx.store).whatsapp.templates[opts.use];
          check(mapping, "This WhatsApp message type has no template set up.", 409);
          return wa.send({
            ...opts,
            template: mapping.name,
            language: mapping.language,
            components: templateComponents(mapping, opts.vars || {}),
            summary: opts.summary || mapping.name,
          });
        }
        return wa.send(opts);
      },
      windowOpen: (number) => wa.windowOpen(number),
      // handler({ from, fromOwner, text, type, id, timestamp, name, clientId, reply }).
      // Owner messages only, unless { clients: true }.
      onInbound: (handler, options) => wa.onInbound(handler, options),
    };
  },
  routes: {
    async guest(r) {
      const { store } = r.ctx;
      const wa = waOf(r.ctx);
      const pixel = r.path.match(/^\/api\/guest\/comms\/open\/([\w-]{32})\.gif$/);
      if (pixel && r.method === "GET") {
        let counted = true;
        try {
          r.allow("comms-open:" + r.ip, 300, 60000);
        } catch {
          counted = false;
        }
        if (counted) {
          const row = store.db.prepare("SELECT id,document_id,client_id,opened_first FROM email_log WHERE open_token=? AND status='sent'").get(hash(pixel[1]));
          if (row) {
            store.db
              .prepare("UPDATE email_log SET opened_first=COALESCE(opened_first,?),opened_last=?,open_count=open_count+1 WHERE id=?")
              .run(now(), now(), row.id);
            if (!row.opened_first) {
              requestContext.getStore().actor = "email-open";
              store.audit("email.opened", row.document_id || row.client_id, "First open (approximate)");
            }
          }
        }
        r.send(200, PIXEL, { "Content-Type": "image/gif", "Content-Length": PIXEL.length });
        return true;
      }
      if (r.path === "/api/hooks/comms/whatsapp") {
        r.allow("comms-wa-hook:" + r.ip, 600, 60000);
        requestContext.getStore().actor = "whatsapp:webhook";
        const cfg = wa.config();
        if (r.method === "GET") {
          const q = r.url.searchParams;
          check(
            cfg?.verifyToken && q.get("hub.mode") === "subscribe" && sameSecret(q.get("hub.verify_token"), cfg.verifyToken),
            "Verification failed.",
            403,
          );
          const challenge = q.get("hub.challenge") || "";
          check(/^[\w-]{1,200}$/.test(challenge), "Invalid challenge.");
          r.send(200, challenge, { "Content-Type": "text/plain; charset=utf-8" });
          return true;
        }
        if (r.method === "POST") {
          check(cfg?.appSecret, "WhatsApp webhook is not set up.", 404);
          const raw = await r.rawBody(1000000);
          check(validSignature(raw, r.req.headers["x-hub-signature-256"], cfg.appSecret), "Invalid signature.", 401);
          let payload;
          try {
            payload = JSON.parse(raw.toString("utf8"));
          } catch {
            throw new AppError("Invalid JSON body.");
          }
          const result = wa.receive(payload, settingsOf(store).ownerWhatsApp);
          r.send(200, "OK", { "Content-Type": "text/plain; charset=utf-8" });
          if (result.inbound.length) setImmediate(() => wa.dispatch(result.inbound));
          return true;
        }
      }
      if (r.path === "/api/hooks/comms/mail-events" && r.method === "POST") {
        r.allow("comms-mail-hook:" + r.ip, 300, 60000);
        requestContext.getStore().actor = "mail:webhook";
        const expected = store.config("MAIL_EVENTS_TOKEN");
        check(expected, "Not found.", 404);
        const h = r.req.headers;
        const auth = String(h.authorization || "");
        let given = r.url.searchParams.get("token") || h["x-webhook-token"] || null;
        if (!given && auth.startsWith("Bearer ")) given = auth.slice(7);
        if (!given && auth.startsWith("Basic "))
          given = Buffer.from(auth.slice(6), "base64").toString("utf8").split(":").slice(1).join(":");
        check(sameSecret(given, expected), "Invalid token.", 401);
        const raw = await r.rawBody(1000000);
        let payload;
        try {
          payload = JSON.parse(raw.toString("utf8"));
        } catch {
          throw new AppError("Invalid JSON body.");
        }
        const { events, confirm } = parseMailEvents(payload);
        if (confirm) {
          store._setCommsState({ sns: { ...confirm, received: now() } });
          store.audit("email.events.subscription", null, confirm.topic || "Amazon SNS");
        }
        r.send(200, { ok: true, ...applyMailEvents(store, events) });
        return true;
      }
    },
    async owner(r) {
      const { store, mailer } = r.ctx;
      const wa = waOf(r.ctx);
      const { path, method } = r;
      if (!path.startsWith("/api/comms/")) return false;
      const done = (status, data) => (r.send(status, data), true);
      if (path === "/api/comms/settings" && method === "PUT") return done(200, store.saveCommsSettings(await r.body()));
      if (path === "/api/comms/templates" && method === "GET")
        return done(200, {
          languages: LANGUAGES.map((l) => ({ id: l, label: LANGUAGE_LABELS[l] })),
          uses: Object.entries(USES).map(([use, u]) => ({
            use,
            label: u.label,
            vars: u.vars.map((v) => ({ name: v, help: VAR_HELP[v] || "" })),
          })),
          defaults: DEFAULT_TEMPLATES,
          overrides: store.db.prepare("SELECT use,language,subject,body,updated FROM comms_templates").all(),
        });
      const tpl = path.match(/^\/api\/comms\/templates\/([a-z_]+)\/([a-z]{2})$/);
      if (tpl && method === "PUT") return done(200, store.saveEmailTemplate(tpl[1], tpl[2], await r.body()));
      if (tpl && method === "DELETE") return done(200, store.resetEmailTemplate(tpl[1], tpl[2]));
      if (path === "/api/comms/templates/preview" && method === "POST") {
        const b = await r.body();
        check(b.use in USES, "Unknown template.");
        const lang = pickLanguage(b.language);
        const subject = String(b.subject ?? "").slice(0, 400),
          body = String(b.body ?? "").slice(0, 6000);
        const allowed = USES[b.use].vars;
        const problems = [...validateTemplate(subject, allowed), ...validateTemplate(body, allowed)];
        const real = previewValues(store, b.use, lang, b.record_id || null, r.ctx.appUrl);
        const values = real.values || sampleValues(b.use, lang);
        const out = problems.length
          ? { subject: "", body: "" }
          : {
              subject: renderTemplate(subject, values, allowed, { singleLine: true }),
              body: renderTemplate(body, values, allowed),
            };
        return done(200, {
          problems,
          ...out,
          html: problems.length ? "" : emailHtml({ text: out.body, company: store.settings().company, lang }),
          records: real.records,
          record: real.record || null,
          sample: !real.values,
        });
      }
      if (path === "/api/comms/compose" && method === "GET") {
        const q = r.url.searchParams;
        if (q.get("document_id")) {
          const d = store.document(q.get("document_id"));
          const lang = mailer.language(d, q.get("language"));
          const use = templateUse(d.kind);
          const t = mailer.template(use, lang);
          const values = documentVars(d, { lang });
          const keep = ["link"];
          return done(200, {
            language: lang,
            use,
            subject: renderTemplate(t.subject, values, USES[use].vars, { keep, singleLine: true }),
            message: renderTemplate(t.body, values, USES[use].vars, { keep }),
            bounced: store.addressIssues([d.client.email].filter(Boolean)),
          });
        }
        const cid = q.get("client_id");
        check(cid, "Choose a document or client.");
        const c = store.client(cid);
        const lang = mailer.language({ client: c }, q.get("language"));
        const t = mailer.template("statement", lang);
        const keep = ["period_from", "period_to", "balance", "amount"];
        const values = statementVars({ client: c, business: store.settings() }, lang);
        return done(200, {
          language: lang,
          use: "statement",
          subject: renderTemplate(t.subject, values, USES.statement.vars, { keep, singleLine: true }),
          message: renderTemplate(t.body, values, USES.statement.vars, { keep }),
          bounced: store.addressIssues([c.email].filter(Boolean)),
        });
      }
      if (path === "/api/comms/mail/test" && method === "POST") {
        r.allow("comms-test:" + r.session.owner_id, 10, 600000);
        const b = await r.body();
        return done(201, await mailer.sendTest(b.to || settingsOf(store).ownerEmail || ownerEmail(store)));
      }
      if (path === "/api/comms/mail/sns-confirmed" && method === "POST") {
        store._setCommsState({ sns: null });
        store.audit("email.events.subscription.confirmed", null, "Amazon SNS");
        return done(200, { ok: true });
      }
      if (path === "/api/comms/addresses/clear" && method === "POST") {
        store.clearAddressIssue((await r.body()).email);
        return done(200, { ok: true });
      }
      if (path === "/api/comms/notifications" && method === "GET")
        return done(200, { unread: store.unreadNotifications(), items: store.notifications(50) });
      if (path === "/api/comms/notifications/read" && method === "POST")
        return done(200, { marked: store.readNotifications(await r.body()), unread: store.unreadNotifications() });
      const receipt = path.match(/^\/api\/comms\/receipts\/([\w-]+)\/email$/);
      if (receipt && method === "POST") {
        r.allow("email:" + r.session.owner_id, 30, 600000);
        return done(201, await mailer.sendReceipt(receipt[1], await r.body()));
      }
      const docWa = path.match(/^\/api\/comms\/documents\/([\w-]+)\/whatsapp$/);
      if (docWa && method === "POST") {
        r.allow("comms-wa:" + r.session.owner_id, 30, 600000);
        return done(201, await sendDocumentWhatsApp(r.ctx, docWa[1], await r.body()));
      }
      if (path === "/api/comms/whatsapp/test" && method === "POST") {
        r.allow("comms-wa:" + r.session.owner_id, 30, 600000);
        const b = await r.body();
        // Every WhatsApp Business account has Meta's approved "hello_world" sample template.
        return done(
          201,
          await wa.send({
            to: b.to || settingsOf(store).ownerWhatsApp,
            kind: "test",
            template: text(String(b.template || "hello_world"), 512, true),
            language: text(String(b.language || "en_US"), 10, true),
            summary: "Test message",
          }),
        );
      }
      const followUp = path.match(/^\/api\/comms\/documents\/([\w-]+)\/follow-up$/);
      if (followUp && method === "POST") {
        r.allow("comms-collect:" + r.session.owner_id, 20, 600000);
        const b = await r.body();
        const settings = settingsOf(store);
        const out = await prepareFollowUp(r.ctx, followUp[1], {
          settings: {
            ...settings,
            collection: {
              ...settings.collection,
              ...(typeof b.email === "boolean" ? { email: b.email } : {}),
              ...(typeof b.whatsapp === "boolean" ? { whatsapp: b.whatsapp } : {}),
            },
          },
          whatsappReady: wa.status().configured,
          force: b.force === true,
        });
        check(out.proposal && !out.skipped, out.skipped || "No draft was prepared.", 409);
        return done(201, out);
      }
      if (path === "/api/comms/collections/run" && method === "POST") {
        r.allow("comms-collect:" + r.session.owner_id, 20, 600000);
        return done(200, await runCollections(r.ctx, { manual: true }));
      }
      const approve = path.match(/^\/api\/comms\/collections\/([\w-]+)\/approve$/);
      if (approve && method === "POST") {
        const b = await r.body();
        const p = store.db.prepare("SELECT * FROM automation_proposals WHERE id=? AND kind='collection_message'").get(approve[1]);
        check(p, "Follow-up not found.", 404);
        check(p.state === "pending", "This follow-up was already reviewed.", 409);
        const before = JSON.parse(p.payload);
        const next = {
          ...before,
          ...(b.subject !== undefined ? { subject: text(String(b.subject), 200, true) } : {}),
          ...(b.message !== undefined ? { message: text(String(b.message), 5000, true) } : {}),
          ...(typeof b.email === "boolean" ? { email: b.email } : {}),
          ...(typeof b.whatsapp === "boolean" ? { whatsapp: b.whatsapp } : {}),
          ...(typeof b.include_link === "boolean" ? { include_link: b.include_link } : {}),
        };
        const parsed = proposalSchema.safeParse(next);
        check(parsed.success, "Check the follow-up text.");
        validateProposal(store, parsed.data);
        const result = store.tx(() => {
          if (JSON.stringify(parsed.data) !== JSON.stringify(before)) {
            store.db.prepare("UPDATE automation_proposals SET payload=? WHERE id=? AND state='pending'").run(JSON.stringify(parsed.data), p.id);
            store.audit(
              "collection.edited",
              p.id,
              "Owner edited the follow-up before approval",
              { subject: before.subject, message: before.message, email: before.email, whatsapp: before.whatsapp },
              { subject: parsed.data.subject, message: parsed.data.message, email: parsed.data.email, whatsapp: parsed.data.whatsapp },
            );
          }
          return store.reviewProposal(p.id, true);
        });
        const sent = await sendFollowUp(r.ctx, wa, settingsOf(store), result.id);
        return done(200, { result, collection: { ...sent, result: sent.result ? JSON.parse(sent.result) : null } });
      }
      const retry = path.match(/^\/api\/comms\/collections\/([\w-]+)\/retry$/);
      if (retry && method === "POST") {
        const c = store.db.prepare("SELECT * FROM comms_collections WHERE id=?").get(retry[1]);
        check(c, "Follow-up not found.", 404);
        check(["failed", "partial"].includes(c.state), "Only a follow-up that failed can be sent again.", 409);
        // Channels that already went out are skipped by their dedupe keys.
        store.db.prepare("UPDATE comms_collections SET state='approved' WHERE id=?").run(c.id);
        store.audit("collection.retry", c.invoice_id, "Owner asked to send again");
        const sent = await sendFollowUp(r.ctx, wa, settingsOf(store), c.id);
        return done(200, { ...sent, result: sent.result ? JSON.parse(sent.result) : null });
      }
      return false;
    },
  },
  jobs: [
    {
      // Notifications, automatic receipts and approved follow-ups waiting to go out.
      name: "notifications",
      every: 60000,
      delay: 10000,
      async run(ctx) {
        const { store, mailer } = ctx;
        const settings = settingsOf(store);
        const created = collectNotifications(store, settings);
        const delivered = await deliverNotifications({
          store,
          mailer,
          whatsapp: waOf(ctx),
          appUrl: ctx.appUrl,
          settings,
          ownerEmail: settings.ownerEmail || ownerEmail(store),
        });
        // Automatic receipt emails (opt-in, once per receipt). The cursor always
        // moves, so turning the option on never emails old receipts.
        let receipts = 0;
        const rows = store.auditSince("comms-receipts", 100);
        if (rows.length) {
          if (settings.autoReceipts && mailer.status().configured)
            for (const row of rows.filter((x) => x.action === "receipt.received")) {
              try {
                const rc = store.receipt(row.entity_id);
                if (rc.voided || !rc.client.email) continue;
                if (await mailer.sendReceipt(rc.id, {}, { dedupeKey: `receipt:${rc.id}` })) receipts++;
              } catch {
                // Logged in the email log; the next receipt is still sent.
              }
            }
          store.ackAudit("comms-receipts", rows.at(-1).id);
        }
        let followUps = 0;
        for (const c of store.db.prepare("SELECT id FROM comms_collections WHERE state='approved' LIMIT 10").all()) {
          await sendFollowUp(ctx, waOf(ctx), settings, c.id);
          followUps++;
        }
        return { created, delivered, receipts, followUps };
      },
    },
    {
      name: "whatsapp-reminders",
      every: 3600000,
      delay: 60000,
      run: (ctx) => runWhatsAppReminders(ctx),
    },
    {
      name: "collections",
      every: 6 * 3600000,
      delay: 120000,
      run: (ctx) => runCollections(ctx),
    },
  ],
  workspace(r) {
    const { store, appUrl } = r.ctx;
    const wa = waOf(r.ctx);
    const settings = settingsOf(store);
    return {
      settings: { ...settings, sns: undefined },
      sns: settings.sns,
      ownerLogin: ownerEmail(store),
      mail: {
        eventsUrl: `${appUrl}/api/hooks/comms/mail-events`,
        eventsReady: !!store.config("MAIL_EVENTS_TOKEN"),
        trackingReady: !!appUrl,
      },
      whatsapp: {
        ...wa.status(),
        webhookUrl: `${appUrl}/api/hooks/comms/whatsapp`,
        uses: Object.entries(WA_USES).map(([use, u]) => ({ use, label: u.label, vars: u.vars })),
        log: wa.log({ limit: 60 }),
      },
      notifyTypes: NOTIFY_TYPES,
      notifications: { unread: store.unreadNotifications(), recent: store.notifications(20) },
      addressIssues: store.addressIssues(),
      templatesEdited: store.db.prepare("SELECT use,language,updated FROM comms_templates").all(),
      collections: store.db
        .prepare("SELECT id,invoice_id,tone,language,subject,channels,generated_by,state,result,created,sent FROM comms_collections ORDER BY created DESC LIMIT 40")
        .all()
        .map((c) => ({ ...c, channels: JSON.parse(c.channels), result: c.result ? JSON.parse(c.result) : null })),
      aiReady: !!r.ctx.assistant?.config,
    };
  },
  pageHead(r) {
    if (!r.path.startsWith("/client/")) return "";
    try {
      r.allow("comms-preview:" + r.ip, 120, 60000);
      return linkPreviewHead(r.ctx.store, r.path, r.ctx.appUrl);
    } catch {
      return "";
    }
  },
  exportData(store) {
    return {
      settings: { ...store.commsSettings(), sns: undefined },
      templates: store.db.prepare("SELECT use,language,subject,body,updated FROM comms_templates").all(),
      whatsapp: store.db
        .prepare("SELECT id,direction,kind,document_id,client_id,number,template,language,body,status,error,created,updated FROM comms_whatsapp ORDER BY created")
        .all(),
      notifications: store.db.prepare("SELECT id,type,title,body,route,created,read_at FROM comms_notifications ORDER BY created").all(),
      addressEvents: store.db.prepare("SELECT email,type,detail,provider,created,cleared FROM comms_address_events ORDER BY created").all(),
      collections: store.db.prepare("SELECT * FROM comms_collections ORDER BY created").all(),
    };
  },
  // A restored copy must not send anything on its own: switch off automatic
  // messages and cancel anything that was waiting to go out.
  onRestore(db) {
    const has = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (has("comms_collections"))
      db.exec("UPDATE comms_collections SET state='cancelled',result='{\"reason\":\"Cancelled by restore\"}' WHERE state IN ('approved','sending')");
    if (has("comms_notifications"))
      db.exec(
        "UPDATE comms_notifications SET email_state='skipped' WHERE email_state IN ('pending','sending');" +
          "UPDATE comms_notifications SET wa_state='skipped' WHERE wa_state IN ('pending','sending');",
      );
    // Email reminders are switched off too; the owner turns them on again after checking.
    db.prepare("UPDATE settings SET data=json_set(data,'$.remindersEnabled',json('false')) WHERE id=1").run();
    const row = has("comms_settings") ? db.prepare("SELECT data FROM comms_settings WHERE id=1").get() : null;
    if (!row) return;
    const data = JSON.parse(row.data);
    data.autoReceipts = false;
    data.whatsapp = { ...(data.whatsapp || {}), reminders: false };
    data.collection = { ...(data.collection || {}), enabled: false };
    data.notify = Object.fromEntries(
      Object.entries(data.notify || {}).map(([k, v]) => [k, { ...v, email: false, whatsapp: false }]),
    );
    db.prepare("UPDATE comms_settings SET data=? WHERE id=1").run(JSON.stringify(data));
  },
};
export { runWhatsAppReminders, runCollections, sendDocumentWhatsApp };
