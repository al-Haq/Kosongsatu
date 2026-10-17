// AI collection agent: polite follow-ups for overdue invoices, queued as
// proposals for the owner to edit and approve. Nothing is sent before approval.
// The AI model (if configured and allowed) only sees the tone, language, days
// overdue and reminder count; facts are placeholders filled in at send time.
import { z } from "zod";
import { id, now, today, check, AppError, text } from "./domain.mjs";
import {
  COLLECTION_VARS,
  documentVars,
  renderTemplate,
  validateTemplate,
  daysBetween,
  pickLanguage,
  formatMoney,
  words,
} from "./comms-templates.mjs";
import { normalizePhone, templateComponents } from "./comms-whatsapp.mjs";
export const TONES = ["gentle", "firm", "final"];
export const SOURCE = "comms:collection-agent";
// Tone follows days overdue, and steps up when earlier reminders went unanswered.
export function collectionTone(daysOverdue, history = 0) {
  let tone = daysOverdue >= 30 ? "final" : daysOverdue >= 14 ? "firm" : "gentle";
  if (tone === "gentle" && history >= 2) tone = "firm";
  if (tone === "firm" && history >= 4) tone = "final";
  return tone;
}
const GREETING = { en: "Dear {{contact_name}},", ms: "Salam sejahtera {{contact_name}}," };
const FOOTER = {
  en: `{{#bank_details}}

Payment details:
{{bank_details}}
{{/bank_details}}
{{#link}}

View and pay online: {{link}}
{{/link}}

Thank you.

Best regards,
{{company}}`,
  ms: `{{#bank_details}}

Maklumat pembayaran:
{{bank_details}}
{{/bank_details}}
{{#link}}

Lihat dan bayar dalam talian: {{link}}
{{/link}}

Sekian, terima kasih.

Yang benar,
{{company}}`,
};
const PAID = {
  en: "{{#paid}}\nThank you for the {{paid}} received so far.\n{{/paid}}",
  ms: "{{#paid}}\nTerima kasih atas bayaran {{paid}} yang telah diterima.\n{{/paid}}",
};
// Written in a courteous Malaysian business register; firmer, never threatening.
const CORE = {
  gentle: {
    en: {
      subject: "Friendly reminder: invoice {{number}}",
      core: `I hope you are well. This is a gentle reminder that invoice {{number}} was due on {{due_date}}, and {{balance}} is still outstanding.

If payment has already been made, thank you, and please share the transaction reference so we can update our records. Otherwise, we would appreciate payment at your earliest convenience.`,
    },
    ms: {
      subject: "Peringatan mesra: invois {{number}}",
      core: `Semoga Tuan/Puan sihat sejahtera. Ini adalah peringatan mesra bahawa invois {{number}} telah tamat tempoh bayaran pada {{due_date}}, dan baki sebanyak {{balance}} masih belum dijelaskan.

Sekiranya bayaran telah dibuat, terima kasih, dan mohon kongsikan rujukan transaksi supaya kami dapat mengemas kini rekod. Jika belum, kami amat menghargai jika bayaran dapat dibuat secepat mungkin.`,
    },
  },
  firm: {
    en: {
      subject: "Payment overdue: invoice {{number}}",
      core: `Invoice {{number}} is now {{days_overdue}} days past its due date of {{due_date}}, with {{balance}} outstanding. We have sent earlier reminders but have not yet received payment or a reply.

Could you please arrange payment within the next 7 days? If there is an issue with the invoice, let us know and we will gladly help resolve it.`,
    },
    ms: {
      subject: "Bayaran tertunggak: invois {{number}}",
      core: `Invois {{number}} kini telah tertunggak selama {{days_overdue}} hari selepas tarikh akhir bayaran pada {{due_date}}, dengan baki sebanyak {{balance}}. Kami telah menghantar peringatan sebelum ini tetapi masih belum menerima bayaran atau maklum balas.

Mohon jasa baik Tuan/Puan untuk menjelaskan bayaran dalam tempoh 7 hari. Sekiranya terdapat sebarang isu berkaitan invois ini, sila maklumkan kepada kami supaya kami dapat membantu.`,
    },
  },
  final: {
    en: {
      subject: "Final reminder: invoice {{number}}",
      core: `Invoice {{number}} remains unpaid {{days_overdue}} days after its due date of {{due_date}}, with {{balance}} outstanding. We value working with you and would like to settle this amicably.

Please arrange payment, or contact us within 7 days to agree on a payment plan. If we do not hear from you, we may need to put further work on hold until the account is settled.`,
    },
    ms: {
      subject: "Peringatan akhir: invois {{number}}",
      core: `Invois {{number}} masih belum dijelaskan selepas {{days_overdue}} hari dari tarikh akhir bayaran pada {{due_date}}, dengan baki sebanyak {{balance}}. Kami menghargai hubungan baik dengan Tuan/Puan dan berharap perkara ini dapat diselesaikan secara baik.

Mohon jelaskan bayaran, atau hubungi kami dalam tempoh 7 hari untuk membincangkan pelan bayaran. Sekiranya tiada maklum balas, kami mungkin perlu menangguhkan kerja seterusnya sehingga akaun ini diselesaikan.`,
    },
  },
};
const assemble = (lang, core) => `${GREETING[lang]}\n\n${core.trim()}\n${PAID[lang]}\n${FOOTER[lang]}`;
export function templateDraft(tone, lang) {
  const t = CORE[tone][lang];
  return { subject: t.subject, message: assemble(lang, t.core), generated_by: "template" };
}
// Placeholders the model may use; everything else is added around its text.
const AI_VARS = ["number", "balance", "amount", "due_date", "days_overdue", "paid"];
export async function aiDraft(assistant, { tone, lang, days, history, partlyPaid }) {
  const config = assistant?.config;
  if (!config) return null;
  const system = `You write short payment follow-up emails for a Malaysian business. Write in ${lang === "ms" ? "Bahasa Melayu (formal, address the reader as Tuan/Puan)" : "clear, polite English"}. Tone: ${tone} (gentle = friendly nudge; firm = clear request with a deadline; final = last reminder, still courteous). Be culturally appropriate: respectful, calm, no blame, no threats of legal action, no invented facts. Use these placeholders exactly where the facts belong, and never write the facts yourself: {{number}} (invoice number), {{balance}} (amount still due), {{due_date}}, {{days_overdue}}${partlyPaid ? ", {{paid}} (amount already paid)" : ""}. Do not write a greeting, a sign-off, payment details, links, names or email addresses: they are added separately. Reply with JSON only: {"subject": "...", "message": "..."}. The message is two or three short paragraphs.`;
  const facts = { language: lang, tone, days_overdue: days, earlier_reminders: history, partly_paid: partlyPaid };
  try {
    const response = await assistant.fetcher(config.base + "/chat/completions", {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(config.key ? { Authorization: "Bearer " + config.key } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(facts) },
        ],
        max_tokens: 700,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return null;
    const raw = await response.text();
    if (raw.length > 100000) return null;
    const content = JSON.parse(raw)?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const out = JSON.parse(content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
    const subject = text(String(out.subject || ""), 150, true).replace(/\s*\n\s*/g, " ");
    const core = text(String(out.message || ""), 2500, true);
    // The model's text is checked like any template; anything odd falls back.
    if (core.length < 40 || /https?:|www\.|@/i.test(core + subject)) return null;
    if (validateTemplate(subject, AI_VARS).length || validateTemplate(core, AI_VARS).length) return null;
    if (!core.includes("{{number}}") || !core.includes("{{balance}}")) return null;
    return { subject, message: assemble(lang, core), generated_by: "ai" };
  } catch {
    return null;
  }
}
export const proposalSchema = z
  .object({
    invoice_id: z.string().min(1).max(80),
    tone: z.enum(TONES),
    language: z.enum(["en", "ms"]),
    days_overdue: z.number().int().min(0).max(36500),
    subject: z.string().min(1).max(200),
    message: z.string().min(1).max(5000),
    email: z.boolean(),
    whatsapp: z.boolean(),
    include_link: z.boolean(),
    generated_by: z.enum(["ai", "template"]),
  })
  .strict();
export function validateProposal(store, b) {
  const d = store.document(b.invoice_id);
  check(d.kind === "invoice" && d.state === "issued" && d.balance > 0, "This invoice is no longer awaiting payment.", 409);
  check(b.email || b.whatsapp, "Choose email, WhatsApp or both.");
  check(!b.email || d.client.email, "The client has no email address.");
  check(!b.whatsapp || normalizePhone(d.client.phone), "The client has no valid WhatsApp number.");
  for (const p of [...validateTemplate(b.subject, COLLECTION_VARS), ...validateTemplate(b.message, COLLECTION_VARS)])
    throw new AppError(p);
}
export function applyProposal(store, b) {
  const cid = id();
  store.db
    .prepare(
      "INSERT INTO comms_collections(id,invoice_id,tone,language,subject,message,channels,include_link,generated_by,state,created) VALUES(?,?,?,?,?,?,?,?,?,'approved',?)",
    )
    .run(
      cid,
      b.invoice_id,
      b.tone,
      b.language,
      b.subject,
      b.message,
      JSON.stringify({ email: b.email, whatsapp: b.whatsapp }),
      b.include_link ? 1 : 0,
      b.generated_by,
      now(),
    );
  store.audit("collection.approved", b.invoice_id, `${b.tone} follow-up approved`);
  return { kind: "collection_message", id: cid };
}
export function proposalSummary(b, store) {
  let label = "an invoice";
  try {
    const d = store.document(b.invoice_id);
    label = `${d.number} (${d.client.name}, ${formatMoney(d.balance, d.currency)} due)`;
  } catch {
    // The invoice may have been removed; the summary stays generic.
  }
  const channels = [b.email && "email", b.whatsapp && "WhatsApp"].filter(Boolean).join(" and ");
  return `${b.tone[0].toUpperCase() + b.tone.slice(1)} follow-up for ${label}, ${b.days_overdue} days overdue, by ${channels}. Subject: ${b.subject}`;
}
// How many follow-ups this invoice already had (email reminders, WhatsApp
// reminders and approved collection messages).
export function followUpHistory(store, did) {
  const one = (sql) => store.db.prepare(sql).get(did).n;
  return (
    one("SELECT count(*) n FROM email_log WHERE document_id=? AND kind='reminder' AND status='sent'") +
    one("SELECT count(*) n FROM comms_whatsapp WHERE document_id=? AND kind='reminder' AND status!='failed'") +
    one("SELECT count(*) n FROM comms_collections WHERE invoice_id=? AND state IN ('sent','partial')")
  );
}
// Prepares one draft for an overdue invoice and queues it for approval.
// Returns { proposal } or { skipped: reason }.
export async function prepareFollowUp(ctx, did, { settings, whatsappReady, asOf = today(), force = false, useAi } = {}) {
  const { store } = ctx;
  const d = store.document(did);
  if (!(d.kind === "invoice" && d.state === "issued" && d.balance > 0)) return { skipped: "Invoice is not awaiting payment." };
  const due = d.next_due_date || d.due_date;
  const days = daysBetween(due, asOf);
  if (days < 1) return { skipped: "Invoice is not overdue yet." };
  const pending = store.db
    .prepare("SELECT id,payload FROM automation_proposals WHERE kind='collection_message' AND state='pending'")
    .all()
    .find((p) => JSON.parse(p.payload).invoice_id === did);
  if (pending) return { skipped: "A follow-up for this invoice is already waiting for approval.", proposal: { id: pending.id, state: "pending" } };
  const history = followUpHistory(store, did);
  const tone = collectionTone(days, history);
  const key = force ? `collect-${did}-${tone}-${Date.now()}` : `collect-${did}-${tone}`;
  if (!force && store.db.prepare("SELECT 1 FROM automation_proposals WHERE source=? AND request_key=?").get(SOURCE, key))
    return { skipped: "This follow-up stage was already prepared." };
  const c = settings.collection;
  const email = !!(c.email && d.client.email);
  const whatsapp = !!(c.whatsapp && whatsappReady && normalizePhone(d.client.phone));
  if (!email && !whatsapp) return { skipped: "The client has no email or WhatsApp number for the chosen channels." };
  const lang = pickLanguage(d.language, d.client.language, settings.language);
  const ai = (useAi ?? c.useAi) ? await aiDraft(ctx.assistant, { tone, lang, days, history, partlyPaid: d.paid > 0 }) : null;
  const draft = ai || templateDraft(tone, lang);
  const proposal = store.propose(
    "collection_message",
    {
      invoice_id: did,
      tone,
      language: lang,
      days_overdue: days,
      subject: draft.subject,
      message: draft.message,
      email,
      whatsapp,
      include_link: c.includeLink === true,
      generated_by: draft.generated_by,
    },
    SOURCE,
    key,
  );
  return { proposal, generated_by: draft.generated_by };
}
// Sends an approved follow-up once. The row is claimed before anything goes out.
export async function sendFollowUp(ctx, whatsapp, settings, cid) {
  const { store, mailer } = ctx;
  if (!store.db.prepare("UPDATE comms_collections SET state='sending' WHERE id=? AND state='approved'").run(cid).changes)
    return store.db.prepare("SELECT * FROM comms_collections WHERE id=?").get(cid);
  const row = store.db.prepare("SELECT * FROM comms_collections WHERE id=?").get(cid);
  const finish = (state, result) => {
    store.db
      .prepare("UPDATE comms_collections SET state=?,result=?,sent=? WHERE id=?")
      .run(state, JSON.stringify(result), now(), cid);
    store.audit("collection." + state, row.invoice_id, Object.values(result).filter(Boolean).join("; ").slice(0, 300));
    return store.db.prepare("SELECT * FROM comms_collections WHERE id=?").get(cid);
  };
  let d;
  try {
    d = store.document(row.invoice_id);
  } catch {
    return finish("cancelled", { reason: "Invoice not found." });
  }
  if (!(d.state === "issued" && d.balance > 0)) return finish("cancelled", { reason: "The invoice was paid or closed before sending." });
  const channels = JSON.parse(row.channels);
  const lang = row.language;
  const result = { email: null, whatsapp: null };
  const deliverAll = async (link = "") => {
    const vars = { ...documentVars(d, { lang, link }), link_token: link ? link.split("/").pop() : "" };
    if (channels.email)
      try {
        const subject = renderTemplate(row.subject, vars, COLLECTION_VARS, { singleLine: true });
        const body = renderTemplate(row.message, vars, COLLECTION_VARS);
        const r = await mailer.deliver({
          kind: "collection",
          documentId: d.id,
          clientId: d.client_id,
          to: [d.client.email],
          subject,
          body,
          language: lang,
          button: link ? { label: words(lang).button.invoice, url: link } : null,
          dedupeKey: `collection:${cid}:email`,
        });
        result.email = r ? "Email sent" : "Email already sent";
      } catch (e) {
        result.email = "Email failed: " + (e.status ? e.message : "unexpected error");
      }
    if (channels.whatsapp)
      try {
        const phone = normalizePhone(d.client.phone);
        const mapping = settings.whatsapp.templates.payment_reminder;
        let r;
        if (whatsapp.windowOpen(phone))
          // The client wrote to us in the last 24 hours, so the approved text can go as is.
          r = await whatsapp.send({
            to: phone,
            kind: "collection",
            text: renderTemplate(row.message, vars, COLLECTION_VARS),
            documentId: d.id,
            clientId: d.client_id,
            dedupeKey: `collection:${cid}:wa`,
          });
        else {
          check(mapping, "No payment reminder template is set up for WhatsApp.");
          r = await whatsapp.send({
            to: phone,
            kind: "collection",
            template: mapping.name,
            language: mapping.language,
            components: templateComponents(mapping, vars),
            summary: `${mapping.name}: ${d.number} ${vars.balance}`,
            documentId: d.id,
            clientId: d.client_id,
            dedupeKey: `collection:${cid}:wa`,
          });
        }
        result.whatsapp = r ? "WhatsApp sent" : "WhatsApp already sent";
      } catch (e) {
        result.whatsapp = "WhatsApp failed: " + (e.status ? e.message : "unexpected error");
      }
    const ok = Object.values(result).filter((v) => v && !/failed/.test(v)).length;
    // Nothing went out: put the previous client link back.
    if (link && !ok) throw Object.assign(new Error("not sent"), { result });
  };
  try {
    if (row.include_link)
      await mailer.withLink(d.id, 30, (t) => `${ctx.appUrl}/client/${t}`, deliverAll);
    else await deliverAll();
  } catch {
    // Every channel failed; the details are in result.
  }
  const values = Object.values(result).filter(Boolean);
  const ok = values.filter((v) => !/failed/.test(v)).length;
  return finish(ok === values.length ? "sent" : ok ? "partial" : "failed", result);
}
