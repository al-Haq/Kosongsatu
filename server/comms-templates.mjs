// Email and message templates: placeholders, defaults in English and Bahasa
// Melayu, rendering and the branded HTML part. Templates are plain text with
// {{name}} placeholders and {{#name}}...{{/name}} sections that only appear
// when the value is present ({{^name}}...{{/name}} when it is missing).
// Values are inserted once and never parsed again.
import { AppError, today } from "./domain.mjs";
export const LANGUAGES = ["en", "ms"];
export const LANGUAGE_LABELS = { en: "English", ms: "Bahasa Melayu" };
const COMMON = ["client_name", "contact_name", "company", "company_email", "company_phone"];
const DOCUMENT = ["number", "document_type", "document_title", "amount", "issue_date", "due_date", "link"];
const INVOICE = [...DOCUMENT, "balance", "amount_due", "paid", "bank_details"];
export const VAR_HELP = {
  client_name: "Client's billing name",
  contact_name: "Contact person, or the client name when there is none",
  company: "Your registered business name",
  company_email: "Your billing email",
  company_phone: "Your phone number",
  number: "Document or receipt number",
  document_type: "invoice, quotation, proforma invoice…",
  document_title: "Invoice, Quotation, Proforma invoice…",
  amount: "Document total (or receipt amount)",
  balance: "Amount still due",
  amount_due: "Amount due now: the next instalment for an instalment plan, otherwise the balance",
  paid: "Amount paid so far (empty when nothing is paid)",
  issue_date: "Issue date",
  due_date: "Due date or valid-until date",
  link: "Private online link (only when a link is included)",
  bank_details: "Your bank name, account holder, account number and payment reference",
  days_left: "Days until the due date",
  days_overdue: "Days since the due date",
  paid_date: "Date the payment was received",
  invoice_numbers: "Invoices the payment was applied to",
  payment_method: "Payment method",
  period_from: "Statement start date",
  period_to: "Statement end date",
};
export const USES = {
  invoice: { label: "Invoice", vars: [...COMMON, ...INVOICE] },
  quote: { label: "Quotation", vars: [...COMMON, ...DOCUMENT] },
  document: { label: "Other documents (proforma, orders)", vars: [...COMMON, ...DOCUMENT] },
  receipt: { label: "Receipt", vars: [...COMMON, "number", "amount", "paid_date", "invoice_numbers", "payment_method"] },
  statement: { label: "Statement of account", vars: [...COMMON, "period_from", "period_to", "balance", "amount", "bank_details"] },
  reminder_before: { label: "Reminder before the due date", vars: [...COMMON, ...INVOICE, "days_left"] },
  reminder_after: { label: "Reminder after the due date", vars: [...COMMON, ...INVOICE, "days_overdue"] },
};
// Collection follow-ups (owner-approved) are rendered with the same values.
export const COLLECTION_VARS = [...COMMON, ...INVOICE, "days_overdue"];
export const templateUse = (kind) =>
  kind === "invoice" ? "invoice" : kind === "quote" ? "quote" : "document";
const bank = (label) => `{{#bank_details}}

${label}:
{{bank_details}}
{{/bank_details}}`;
const linkLine = (label) => `{{#link}}

${label}: {{link}}
{{/link}}`;
export const DEFAULT_TEMPLATES = {
  invoice: {
    en: {
      subject: "Invoice {{number}} from {{company}}",
      body: `Dear {{contact_name}},

Please find attached invoice {{number}} for {{amount}}.

Invoice: {{number}}
Due date: {{due_date}}
Balance due: {{balance}}
${bank("Payment details")}
${linkLine("View and pay online")}

Thank you for your business.

{{company}}`,
    },
    ms: {
      subject: "Invois {{number}} daripada {{company}}",
      body: `Salam sejahtera {{contact_name}},

Bersama-sama ini dilampirkan invois {{number}} berjumlah {{amount}}.

Invois: {{number}}
Tarikh akhir bayaran: {{due_date}}
Baki perlu dibayar: {{balance}}
${bank("Maklumat pembayaran")}
${linkLine("Lihat dan bayar dalam talian")}

Terima kasih atas urusan Tuan/Puan.

{{company}}`,
    },
  },
  quote: {
    en: {
      subject: "Quotation {{number}} from {{company}}",
      body: `Dear {{contact_name}},

Please find attached quotation {{number}} for {{amount}}.

Quotation: {{number}}
Valid until: {{due_date}}
Total: {{amount}}
${linkLine("View and accept online")}

Please let us know if you have any questions.

{{company}}`,
    },
    ms: {
      subject: "Sebut harga {{number}} daripada {{company}}",
      body: `Salam sejahtera {{contact_name}},

Bersama-sama ini dilampirkan sebut harga {{number}} berjumlah {{amount}}.

Sebut harga: {{number}}
Sah sehingga: {{due_date}}
Jumlah: {{amount}}
${linkLine("Lihat dan terima dalam talian")}

Sila hubungi kami jika ada sebarang pertanyaan.

{{company}}`,
    },
  },
  document: {
    en: {
      subject: "{{document_title}} {{number}} from {{company}}",
      body: `Dear {{contact_name}},

Please find attached {{document_type}} {{number}}.

{{document_title}}: {{number}}
Date: {{issue_date}}
${linkLine("View online")}

Please let us know if you have any questions.

{{company}}`,
    },
    ms: {
      subject: "{{document_title}} {{number}} daripada {{company}}",
      body: `Salam sejahtera {{contact_name}},

Bersama-sama ini dilampirkan {{document_type}} {{number}}.

{{document_title}}: {{number}}
Tarikh: {{issue_date}}
${linkLine("Lihat dalam talian")}

Sila hubungi kami jika ada sebarang pertanyaan.

{{company}}`,
    },
  },
  receipt: {
    en: {
      subject: "Receipt {{number}} from {{company}}",
      body: `Dear {{contact_name}},

Thank you for your payment of {{amount}} received on {{paid_date}}.
{{#invoice_numbers}}
Applied to: {{invoice_numbers}}
{{/invoice_numbers}}

Your official receipt {{number}} is attached.

{{company}}`,
    },
    ms: {
      subject: "Resit {{number}} daripada {{company}}",
      body: `Salam sejahtera {{contact_name}},

Terima kasih atas bayaran sebanyak {{amount}} yang diterima pada {{paid_date}}.
{{#invoice_numbers}}
Untuk: {{invoice_numbers}}
{{/invoice_numbers}}

Resit rasmi {{number}} dilampirkan.

{{company}}`,
    },
  },
  statement: {
    en: {
      subject: "Statement of account from {{company}}",
      body: `Dear {{contact_name}},

Please find your statement of account attached.

Period: {{period_from}} to {{period_to}}
Balance due: {{balance}}
${bank("Payment details")}

{{company}}`,
    },
    ms: {
      subject: "Penyata akaun daripada {{company}}",
      body: `Salam sejahtera {{contact_name}},

Bersama-sama ini dilampirkan penyata akaun Tuan/Puan.

Tempoh: {{period_from}} hingga {{period_to}}
Baki perlu dibayar: {{balance}}
${bank("Maklumat pembayaran")}

{{company}}`,
    },
  },
  reminder_before: {
    en: {
      subject: "Upcoming payment reminder: {{number}}",
      body: `Dear {{contact_name}},

This is a friendly reminder that invoice {{number}} is due on {{due_date}}. The amount due is {{amount_due}}.

If you have already paid, please ignore this message or reply with your transaction reference.
${bank("Payment details")}
${linkLine("View and pay online")}

{{company}}`,
    },
    ms: {
      subject: "Peringatan bayaran akan datang: {{number}}",
      body: `Salam sejahtera {{contact_name}},

Ini adalah peringatan mesra bahawa invois {{number}} perlu dibayar pada {{due_date}}. Jumlah perlu dibayar ialah {{amount_due}}.

Jika Tuan/Puan telah membuat bayaran, sila abaikan mesej ini atau balas dengan rujukan transaksi.
${bank("Maklumat pembayaran")}
${linkLine("Lihat dan bayar dalam talian")}

{{company}}`,
    },
  },
  reminder_after: {
    en: {
      subject: "Overdue payment reminder: {{number}}",
      body: `Dear {{contact_name}},

Our records show that invoice {{number}} was due on {{due_date}} and has {{amount_due}} outstanding.

If you have already paid, please ignore this message or reply with your transaction reference.
${bank("Payment details")}
${linkLine("View and pay online")}

{{company}}`,
    },
    ms: {
      subject: "Peringatan bayaran tertunggak: {{number}}",
      body: `Salam sejahtera {{contact_name}},

Menurut rekod kami, invois {{number}} telah tamat tempoh bayaran pada {{due_date}} dengan jumlah tertunggak sebanyak {{amount_due}}.

Jika Tuan/Puan telah membuat bayaran, sila abaikan mesej ini atau balas dengan rujukan transaksi.
${bank("Maklumat pembayaran")}
${linkLine("Lihat dan bayar dalam talian")}

{{company}}`,
    },
  },
};
// Labels used inside generated values.
const WORDS = {
  en: {
    reference: "Reference",
    kinds: { invoice: "invoice", quote: "quotation", proforma: "proforma invoice", sales_order: "sales order", delivery_order: "delivery order" },
    viewOnline: "View online",
    button: { invoice: "View and pay online", quote: "View quotation", document: "View document" },
    footer: "This email was sent by {company}.",
  },
  ms: {
    reference: "Rujukan",
    kinds: { invoice: "invois", quote: "sebut harga", proforma: "invois proforma", sales_order: "pesanan jualan", delivery_order: "pesanan penghantaran" },
    viewOnline: "Lihat dalam talian",
    button: { invoice: "Lihat dan bayar dalam talian", quote: "Lihat sebut harga", document: "Lihat dokumen" },
    footer: "E-mel ini dihantar oleh {company}.",
  },
};
export const words = (lang) => WORDS[lang] || WORDS.en;
// ---- Parsing --------------------------------------------------------------
const TAG = /\{\{\s*([#^/]?)\s*([A-Za-z0-9_]*)\s*\}\}/g;
export function parseTemplate(source) {
  const src = String(source ?? "").replace(/\r\n?/g, "\n");
  const root = { children: [] },
    stack = [root],
    errors = [],
    names = new Set();
  let last = 0;
  const pushText = (value) => {
    if (!value) return;
    if (/\{\{|\}\}/.test(value)) {
      const at = value.search(/\{\{|\}\}/);
      errors.push(`Check the braces near "${value.slice(Math.max(0, at - 10), at + 12).trim()}". Placeholders look like {{name}}.`);
    }
    stack.at(-1).children.push({ type: "text", value });
  };
  for (const m of src.matchAll(TAG)) {
    const [whole, sigil, name] = m;
    let start = m.index,
      end = start + whole.length,
      standalone = false;
    if (sigil) {
      // A section tag alone on its line takes the whole line with it.
      const lineStart = src.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = src.indexOf("\n", end);
      if (
        lineStart >= last &&
        /^[ \t]*$/.test(src.slice(lineStart, start)) &&
        /^[ \t]*$/.test(src.slice(end, lineEnd === -1 ? src.length : lineEnd))
      ) {
        standalone = true;
        start = lineStart;
        end = lineEnd === -1 ? src.length : lineEnd + 1;
      }
    }
    pushText(src.slice(last, start));
    last = end;
    if (!name) {
      errors.push("Remove the empty placeholder {{}}.");
      continue;
    }
    names.add(name);
    if (sigil === "#" || sigil === "^") {
      const node = { type: sigil === "#" ? "section" : "inverted", name, children: [], openStandalone: standalone };
      stack.at(-1).children.push(node);
      stack.push(node);
    } else if (sigil === "/") {
      const open = stack.at(-1);
      if (stack.length === 1 || open.name !== name)
        errors.push(`{{/${name}}} has no matching {{#${name}}}.`);
      else {
        open.closeStandalone = standalone;
        stack.pop();
      }
    } else stack.at(-1).children.push({ type: "var", name });
  }
  pushText(src.slice(last));
  if (stack.length > 1) errors.push(`Close {{#${stack.at(-1).name}}} with {{/${stack.at(-1).name}}}.`);
  return { tree: root.children, errors, names };
}
// Problems with a template, as plain sentences (empty when it is valid).
export function validateTemplate(source, allowed) {
  const { errors, names } = parseTemplate(source);
  const unknown = [...names].filter((n) => !allowed.includes(n));
  return [
    ...errors,
    ...unknown.map((n) => `Unknown placeholder {{${n}}}. Available: ${allowed.map((a) => `{{${a}}}`).join(", ")}.`),
  ];
}
function renderNodes(nodes, vars, keep) {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += n.value;
    else if (n.type === "var") out += keep.includes(n.name) ? `{{${n.name}}}` : String(vars[n.name] ?? "");
    else if (keep.includes(n.name)) {
      const sigil = n.type === "section" ? "#" : "^";
      out += `{{${sigil}${n.name}}}${n.openStandalone ? "\n" : ""}${renderNodes(n.children, vars, keep)}{{/${n.name}}}${n.closeStandalone ? "\n" : ""}`;
    } else {
      const present = vars[n.name] !== undefined && vars[n.name] !== null && String(vars[n.name]) !== "";
      if (present === (n.type === "section")) out += renderNodes(n.children, vars, keep);
    }
  }
  return out;
}
// Renders a template with values. Unknown placeholders are an error, so a typo
// never reaches a client as "{{nmber}}". `keep` leaves some placeholders as they
// are (e.g. {{link}} before the link exists).
export function renderTemplate(source, vars, allowed, { keep = [], singleLine = false } = {}) {
  const problems = validateTemplate(source, allowed);
  if (problems.length) throw new AppError(problems[0]);
  const { tree } = parseTemplate(source);
  let out = renderNodes(tree, vars, keep)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (singleLine) out = out.replace(/\s*\n\s*/g, " ").trim();
  return out;
}
// ---- Values ---------------------------------------------------------------
const locale = (lang) => (lang === "ms" ? "ms-MY" : "en-MY");
export function formatMoney(sen, currency = "MYR", lang = "en") {
  const value = (Number(sen) || 0) / 100;
  try {
    return new Intl.NumberFormat(locale(lang), { style: "currency", currency: currency || "MYR" }).format(value);
  } catch {
    return new Intl.NumberFormat(locale(lang), { style: "currency", currency: "MYR" }).format(value);
  }
}
export function formatDate(iso, lang = "en") {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "";
  return new Date(iso.slice(0, 10) + "T00:00:00Z").toLocaleDateString(locale(lang), {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
export const daysBetween = (from, to) =>
  Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export function businessVars(business = {}, client = {}) {
  return {
    client_name: client.name || "",
    contact_name: client.contact || client.name || "",
    company: business.company || "",
    company_email: business.email || "",
    company_phone: business.phone || "",
  };
}
// Values for a document (invoice, quotation, other kinds) in one language.
export function documentVars(d, { lang = "en", link = "", asOf = today() } = {}) {
  const b = d.business || {},
    w = words(lang),
    currency = d.currency || "MYR";
  const due = d.next_due_date || d.due_date;
  const type = w.kinds[d.kind] || w.kinds.invoice;
  const financial = d.kind === "invoice";
  const days = due ? daysBetween(due, asOf) : 0;
  return {
    ...businessVars(b, d.client || {}),
    number: d.number || "",
    document_type: type,
    document_title: capital(type),
    amount: formatMoney(d.adjusted_total ?? d.total, currency, lang),
    balance: financial ? formatMoney(d.balance, currency, lang) : "",
    // Instalment plans: what is due by the next instalment date.
    amount_due: financial
      ? formatMoney(d.instalments?.length && d.next_due_date ? d.next_due_amount : d.balance, currency, lang)
      : "",
    paid: financial && d.paid > 0 ? formatMoney(d.paid, currency, lang) : "",
    issue_date: formatDate(d.issue_date, lang),
    due_date: formatDate(due, lang),
    link: link || "",
    bank_details:
      financial && b.bankAccount
        ? [b.bankName, b.bankHolder, b.bankAccount, `${w.reference}: ${d.number}`].filter(Boolean).join("\n")
        : "",
    days_left: String(Math.max(0, -days)),
    days_overdue: String(Math.max(0, days)),
  };
}
export function statementVars(statement, lang = "en") {
  const b = statement.business || {};
  return {
    ...businessVars(b, statement.client || {}),
    period_from: formatDate(statement.from, lang),
    period_to: formatDate(statement.to, lang),
    // Statements list one balance per currency when a client is billed in several.
    balance: statement.groups?.length
      ? statement.groups.map((g) => formatMoney(g.closing, g.currency || "MYR", lang)).join(" + ")
      : formatMoney(statement.closing, "MYR", lang),
    amount: statement.groups?.length
      ? statement.groups.map((g) => formatMoney(g.outstanding ?? g.closing, g.currency || "MYR", lang)).join(" + ")
      : formatMoney(statement.outstanding, "MYR", lang),
    bank_details: b.bankAccount ? [b.bankName, b.bankHolder, b.bankAccount].filter(Boolean).join("\n") : "",
  };
}
export function receiptVars(receipt, invoiceNumbers = [], lang = "en") {
  return {
    ...businessVars(receipt.business || {}, receipt.client || {}),
    number: receipt.number,
    amount: formatMoney(receipt.amount, "MYR", lang),
    paid_date: formatDate(receipt.paid_date, lang),
    invoice_numbers: invoiceNumbers.join(", "),
    payment_method: receipt.method || "",
  };
}
// The language for a message: an explicit choice, then the document, then the
// client, then the business default. Only English and Malay have templates.
export function pickLanguage(...choices) {
  for (const c of choices) if (LANGUAGES.includes(c)) return c;
  return "en";
}
// ---- HTML part -------------------------------------------------------------
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function linkify(escaped) {
  return escaped.replace(/https?:\/\/[^\s<>"']+/g, (url) => {
    const trail = url.match(/[.,;:!?)]+$/)?.[0] || "";
    const clean = trail ? url.slice(0, -trail.length) : url;
    return `<a href="${clean}" style="color:#087f7e">${clean}</a>${trail}`;
  });
}
// A simple branded HTML version of a plain-text message. Every value is escaped.
export function emailHtml({ text, company = "", lang = "en", button = null, pixel = null, logo = null }) {
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.6">${linkify(esc(p)).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const cta =
    button && /^https?:\/\//.test(button.url)
      ? `<p style="margin:6px 0 20px"><a href="${esc(button.url)}" style="display:inline-block;background:#087f7e;color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:8px">${esc(button.label)}</a></p>`
      : "";
  const head = logo
    ? `<img src="${esc(logo)}" alt="${esc(company)}" width="150" style="display:block;border:0;max-width:150px;height:auto">`
    : `<strong style="font-size:16px;color:#0f172a">${esc(company)}</strong>`;
  return `<!doctype html><html lang="${lang === "ms" ? "ms" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(company)}</title></head><body style="margin:0;padding:0;background:#f4f7fa"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fa"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;border-top:4px solid #0ea5a4"><tr><td style="padding:22px 28px 6px">${head}</td></tr><tr><td style="padding:14px 28px 10px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a">${paragraphs}${cta}</td></tr><tr><td style="padding:12px 28px 22px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#64748b;border-top:1px solid #e2e8f0">${esc(words(lang).footer.replace("{company}", company))}</td></tr></table></td></tr></table>${pixel ? `<img src="${esc(pixel)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` : ""}</body></html>`;
}
// WhatsApp template parameters cannot contain new lines, tabs or more than four
// spaces in a row.
export function whatsappText(value, max = 900) {
  return String(value ?? "")
    .replace(/\s*\n\s*/g, ", ")
    .replace(/[\t\u00a0\u202f]/g, " ")
    .replace(/ {4,}/g, "   ")
    .trim()
    .slice(0, max);
}
