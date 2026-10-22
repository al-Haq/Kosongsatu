// Communication: mail settings, email templates, open and bounce tracking,
// WhatsApp Business, owner notifications, the AI collection agent and link previews.
// Browser module contract: see docs/PLUGINS.md.
const USES = [
  ["invoice", "Invoice"],
  ["quote", "Quotation"],
  ["document", "Other documents (proforma, orders)"],
  ["receipt", "Receipt"],
  ["statement", "Statement of account"],
  ["reminder_before", "Reminder before the due date"],
  ["reminder_after", "Reminder after the due date"],
];
const LANGS = [
  ["en", "English"],
  ["ms", "Bahasa Melayu"],
];
const TONES = { gentle: "Gentle", firm: "Firm", final: "Final" };
const WA_STATUS = { sending: "Sending", sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed", received: "Received" };
export default function commsUI(h) {
  const { E, badge, button, input, area, select, formEnd, icon, money, dateLabel, timeLabel, showModal, toast, api, refresh, renderRoute, navigate, modal } = h;
  const S = () => h.get();
  const C = () => S().ext?.comms || {};
  let templateInfo = null,
    poller = null,
    notes = [],
    lastField = null;
  const $ = (sel, root = modal) => root.querySelector(sel);
  const reload = async (message) => {
    await refresh();
    renderRoute();
    if (message) toast(message);
  };
  const checkbox = (name, label, checked, extra = "") =>
    `<label class="check-row"><input type="checkbox" name="${name}" ${checked ? "checked" : ""} ${extra}> ${label}</label>`;
  const pendingFollowUps = () =>
    (S().automation?.proposals || []).filter((p) => p.kind === "collection_message" && p.state === "pending" && p.expires > Date.now());
  const doc = (id) => S().documents.find((d) => d.id === id);
  const today = () => S().today;
  // ---- Notification bell -------------------------------------------------
  function setCount(n) {
    const c = C();
    if (c.notifications) c.notifications.unread = n;
    for (const el of document.querySelectorAll("[data-comms-count]")) {
      el.textContent = n > 99 ? "99+" : String(n);
      el.classList.toggle("hidden", !n);
      el.closest("button")?.setAttribute("aria-label", n ? `Notifications, ${n} unread` : "Notifications");
    }
  }
  function startPolling() {
    if (poller) return;
    poller = setInterval(async () => {
      if (!h.session() || document.hidden || !document.querySelector("[data-comms-count]")) return;
      try {
        setCount((await api("/comms/notifications")).unread);
      } catch {
        // A failed check is retried on the next tick.
      }
    }, 60000);
  }
  function bell() {
    const n = C().notifications?.unread || 0;
    startPolling();
    return `<button type="button" class="btn ghost icon-only comms-bell" data-action="comms-bell" aria-label="${n ? `Notifications, ${n} unread` : "Notifications"}">${icon("bell")}<span class="comms-count${n ? "" : " hidden"}" data-comms-count>${n > 99 ? "99+" : n}</span></button>`;
  }
  async function openNotifications() {
    const r = await api("/comms/notifications");
    notes = r.items;
    setCount(r.unread);
    showModal(
      "Notifications",
      notes.length
        ? `<div class="comms-notes">${notes
            .map(
              (n) =>
                `<div class="comms-note${n.read_at ? "" : " unread"}"><div><strong>${E(n.title)}</strong>${n.body ? `<p>${E(n.body)}</p>` : ""}<small>${timeLabel(n.created)}</small></div>${n.route ? button("Open", "comms-note-open", n.id) : ""}</div>`,
            )
            .join("")}</div><div class="form-actions">${button("Close", "close-modal")}${r.unread ? button("Mark all as read", "comms-note-read-all", "", true) : ""}</div>`
        : h.empty("No notifications yet", "Online payments, accepted quotations, payment references and bounced emails appear here."),
    );
  }
  // ---- Email form (documents) and statement form --------------------------
  const bouncedNotice = (list) =>
    list?.length
      ? `<div class="notice warn comms-warn"><p>${list
          .map((b) => `Email to ${E(b.email)} ${b.type === "complaint" ? "was marked as spam" : "bounced"} on ${timeLabel(b.created)}${b.detail ? ` (${E(b.detail)})` : ""}.`)
          .join(" ")} Check the address before sending.</p></div>`
      : "";
  const trackingNote = () =>
    C().settings?.trackOpens
      ? '<p class="field-hint">Opens are tracked with a tiny image. Many mail apps block or pre-load images, so treat opens as approximate.</p>'
      : "";
  function wireLanguage(form, query) {
    let edited = false;
    for (const f of [form.elements.subject, form.elements.message]) f?.addEventListener("input", () => (edited = true));
    form.elements.language?.addEventListener("change", async () => {
      if (edited && !confirm("Replace your edited subject and message with the template in this language?")) return;
      try {
        const c = await api(`/comms/compose?${query}&language=${form.elements.language.value}`);
        form.elements.subject.value = c.subject;
        form.elements.message.value = c.message;
        edited = false;
      } catch (e) {
        toast(e.message, true);
      }
    });
  }
  async function emailForm(id) {
    const d = doc(id);
    if (!S().mail?.configured) {
      toast("Email is not set up yet. Add the SMTP settings in Settings > Integration keys, or share the client link instead.", true);
      return;
    }
    const c = await api(`/comms/compose?document_id=${encodeURIComponent(id)}`);
    const label = d.kind === "quote" ? "quotation" : d.kind === "invoice" ? "invoice" : "document";
    // Other modules (e.g. client contacts) may pre-fill recipients and add fields.
    const v = h.emailPrefill("document", d, { to: d.client.email || "", cc: "" });
    showModal(
      "Email " + label,
      `<form data-form="email-document" data-id="${E(id)}">${bouncedNotice(c.bounced)}<div class="form-grid">${input("To", "to", v.to, "text", true, 'maxlength="600" placeholder="client@example.com"')}${input("Cc (optional)", "cc", v.cc, "text", false, 'maxlength="600"')}</div>${h.slot("emailFields", "document", d)}${select("Language", "language", LANGS, c.language)}${input("Subject", "subject", c.subject, "text", true, 'maxlength="200"')}<label>Message<textarea name="message" rows="14" maxlength="5000" required>${E(c.message)}</textarea></label><p class="field-hint">From your ${E(USES.find(([u]) => u === c.use)?.[1].toLowerCase() || "email")} template. {{link}} becomes the private link when one is included. The PDF is attached.</p>${checkbox("include_link", "Include a private online link. This replaces any existing link for this document.", !d.token_hash)}${input("Link validity (days)", "link_days", 30, "number", true, 'min="1" max="90" step="1"')}${trackingNote()}${formEnd("Send email")}</form>`,
      true,
    );
    wireLanguage($("form"), `document_id=${encodeURIComponent(id)}`);
  }
  async function statementForm(id) {
    const c = S().clients.find((x) => x.id === id);
    const mail = S().mail?.configured;
    const compose = mail ? await api(`/comms/compose?client_id=${encodeURIComponent(id)}`) : null;
    const v = h.emailPrefill("statement", c, { to: c.email || "", cc: "" });
    showModal(
      "Statement of account",
      `<form data-form="statement" data-id="${E(id)}"><div class="form-grid">${input("From", "from_date", h.addDays(today(), -90), "date", true)}${input("To", "to_date", today(), "date", true, `max="${today()}"`)}</div><div class="actions">${button("Download PDF", "statement-pdf", id)}</div>${
        mail
          ? `<div class="mt22">${bouncedNotice(compose.bounced)}<div class="form-grid">${input("Email to", "to", v.to, "text", true, 'maxlength="600"')}${input("Cc (optional)", "cc", v.cc, "text", false, 'maxlength="600"')}</div>${h.slot("emailFields", "statement", c)}${select("Language", "language", LANGS, compose.language)}${input("Subject", "subject", compose.subject, "text", true, 'maxlength="200"')}<label>Message<textarea name="message" rows="10" maxlength="5000" required>${E(compose.message)}</textarea></label><p class="field-hint">{{period_from}}, {{period_to}} and {{balance}} are filled in for the dates above when sent.</p>${formEnd("Email statement")}</div>`
          : `<p class="field-hint mt22">Email is not set up; download the PDF to send it yourself.</p>${h.errorBlock()}`
      }</form>`,
    );
    if (mail) wireLanguage($("form"), `client_id=${encodeURIComponent(id)}`);
  }
  // ---- Settings panels ------------------------------------------------------
  function mailPanel() {
    const c = C(),
      s = c.settings || {},
      m = S().mail || {};
    const status = m.configured
      ? `Sending from ${E(m.from)}${m.source === "settings" ? " (Integration keys)" : " (server settings)"}.`
      : m.error
        ? `The mail settings have a problem: ${E(m.error)}`
        : "Not set up. Add the SMTP server, port, username, password and From address under Integration keys below.";
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Email delivery</h2><p>${status}</p></div><div class="actions">${badge(m.configured ? "Connected" : "Not connected")}${m.configured ? button("Send test email", "comms-test-email") : ""}</div></div><form data-form="comms-mail"><div class="form-grid">${select("Default language for client messages", "language", LANGS, s.language)}<div></div></div>${checkbox("trackOpens", "Track when clients open emails", s.trackOpens)}<p class="field-hint">Adds a tiny image to each email. Opens are approximate: many mail apps block images (no open is recorded) or load them automatically (an open is recorded without the client reading it).</p>${checkbox("reminderLinks", "Include a fresh private link in reminders", s.reminderLinks)}<p class="field-hint">Each reminder then carries a new 30-day link and the previous link stops working.</p>${checkbox("autoReceipts", "Email the official receipt to the client when a payment is recorded", s.autoReceipts)}${h.errorBlock()}<div class="form-actions"><button class="btn primary" type="submit">Save email settings</button></div></form><h3 class="mt22">Bounces and spam complaints</h3><p class="field-hint">Ask your mail provider (Amazon SES through SNS, Postmark, Mailgun, SendGrid or any service that can post JSON) to send bounce and complaint events to this address. Rejections by your SMTP server already show as Failed.</p><input class="comms-code" readonly value="${E(c.mail?.eventsUrl || "")}?token=YOUR_BOUNCE_WEBHOOK_TOKEN" aria-label="Bounce webhook address"><p class="field-hint">${c.mail?.eventsReady ? "The bounce webhook token is set." : "Set the bounce webhook token under Integration keys first."}</p>${
      c.sns
        ? `<div class="notice warn mt22"><p>Amazon SNS asked to confirm the subscription for ${E(c.sns.topic || "your topic")}. Open the link once, then mark it as done.</p><div class="actions"><a class="btn" href="${E(c.sns.url)}" target="_blank" rel="noopener noreferrer">Confirm subscription</a>${button("Done", "comms-sns-done")}</div></div>`
        : ""
    }${addressList()}</section>`;
  }
  function addressList() {
    const list = C().addressIssues || [];
    if (!list.length) return "";
    return `<h3 class="mt22">Addresses that bounced</h3>${list
      .map(
        (a) =>
          `<div class="setting-line"><div><h3>${E(a.email)}</h3><p>${a.type === "complaint" ? "Marked as spam" : "Hard bounce"} · ${timeLabel(a.created)}${a.detail ? " · " + E(a.detail) : ""}</p></div>${button("Clear warning", "comms-address-clear", a.email)}</div>`,
      )
      .join("")}`;
  }
  function templatesPanel() {
    const edited = C().templatesEdited || [];
    const cell = (use, lang) => {
      const e = edited.find((x) => x.use === use && x.language === lang);
      return `<td>${badge(e ? "Edited" : "Default")} ${button("Edit", "comms-template-edit", `${use}:${lang}`)}</td>`;
    };
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Email templates</h2><p>The text of invoices, quotations, receipts, statements and reminders, in English and Bahasa Melayu. The document or client language picks one, otherwise the default language above.</p></div></div><div class="table-wrap"><table><thead><tr><th>Message</th><th>English</th><th>Bahasa Melayu</th></tr></thead><tbody>${USES.map(([use, label]) => `<tr><td>${E(label)}</td>${cell(use, "en")}${cell(use, "ms")}</tr>`).join("")}</tbody></table></div></section>`;
  }
  const waStatusBadge = (s) => badge(WA_STATUS[s] || s);
  const mappingText = (m) => (m ? `${m.name} · ${m.language}${m.params.length ? " · " + m.params.join(", ") : ""}${m.button ? " · link button" : ""}` : "Not set up");
  function whatsappPanel() {
    const c = C(),
      w = c.whatsapp || {},
      s = c.settings || {};
    const templates = s.whatsapp?.templates || {};
    const status = w.configured
      ? `Connected to phone number ID ${E(w.phoneNumberId)} (Graph API ${E(w.version)}).${w.webhookReady ? "" : " Add the app secret and verify token to receive delivery statuses and replies."}`
      : w.error
        ? `The WhatsApp keys have a problem: ${E(w.error)}`
        : "Not connected. Add the WhatsApp access token and phone number ID under Integration keys. The Share via WhatsApp link keeps working without an account.";
    const log = (w.log || []).slice(0, 12);
    return `<section class="panel mt22"><div class="panel-head"><div><h2>WhatsApp Business</h2><p>${status}</p></div><div class="actions">${badge(w.configured ? "Connected" : "Not connected")}${w.configured ? button("Send test message", "comms-wa-test") : ""}</div></div><p class="field-hint">Messages you start must use templates approved in WhatsApp Manager. Map each message below to your template's name, language code and the values for its {{1}}, {{2}}… parameters (or name=value for named parameters).</p>${(w.uses || [])
      .map(
        (u) =>
          `<div class="setting-line"><div><h3>${E(u.label)}</h3><p>${E(mappingText(templates[u.use]))}</p></div>${button(templates[u.use] ? "Edit" : "Set up", "comms-wa-map", u.use)}</div>`,
      )
      .join("")}<form data-form="comms-wa" class="mt22">${checkbox("reminders", "Also send payment reminders by WhatsApp (same days as the email reminders, once per stage)", s.whatsapp?.reminders, templates.payment_reminder ? "" : "disabled")}<p class="field-hint">${templates.payment_reminder ? "Uses your payment reminder template and the client's phone number." : "Set up the payment reminder template first."}</p>${h.errorBlock()}<div class="form-actions">${w.configured && s.whatsapp?.reminders ? button("Send due WhatsApp reminders now", "comms-wa-run") : ""}<button class="btn primary" type="submit">Save</button></div></form><h3 class="mt22">Webhook</h3><p class="field-hint">In your Meta app, set the callback URL below, use your WhatsApp webhook verify token, and subscribe to the messages field.</p><input class="comms-code" readonly value="${E(w.webhookUrl || "")}" aria-label="WhatsApp webhook address">${
      log.length
        ? `<h3 class="mt22">Recent messages</h3><div class="table-wrap"><table><thead><tr><th>When</th><th>Number</th><th>Message</th><th>Status</th></tr></thead><tbody>${log
            .map(
              (x) =>
                `<tr><td>${timeLabel(x.created)}</td><td>${x.direction === "in" ? "From " : "To "}${E(x.number)}</td><td class="comms-wrap">${E(x.body)}${x.error ? `<small class="red-text">${E(x.error)}</small>` : ""}</td><td>${waStatusBadge(x.status)}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : ""
    }</section>`;
  }
  function notifyPanel() {
    const c = C(),
      s = c.settings || {},
      types = c.notifyTypes || {};
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Owner notifications</h2><p>Shown under the bell at the top. Choose which ones also come by email or WhatsApp. Each event is notified once.</p></div></div><form data-form="comms-notify"><div class="table-wrap"><table><thead><tr><th>Event</th><th>In app</th><th>Email</th><th>WhatsApp</th></tr></thead><tbody>${Object.entries(types)
      .map(([k, t]) => {
        const p = s.notify?.[k] || {};
        const box = (ch, label) => `<input type="checkbox" class="comms-box" name="${k}.${ch}" aria-label="${E(t.label)}: ${label}" ${p[ch] ? "checked" : ""}>`;
        return `<tr><td class="comms-wrap"><strong>${E(t.label)}</strong><small>${E(t.hint)}</small></td><td>${box("inapp", "in app")}</td><td>${box("email", "email")}</td><td>${box("whatsapp", "WhatsApp")}</td></tr>`;
      })
      .join("")}</tbody></table></div><div class="form-grid mt22">${input("Email notifications to", "ownerEmail", s.ownerEmail || "", "email", false, `maxlength="160" placeholder="${E(c.ownerLogin || "")}"`)}${input("Your WhatsApp number", "ownerWhatsApp", s.ownerWhatsApp || "", "text", false, 'maxlength="30" placeholder="60123456789"')}</div><p class="field-hint">Email goes to your sign-in address unless you enter another. WhatsApp alerts need the owner notification template above.</p>${h.errorBlock()}<div class="form-actions"><button class="btn primary" type="submit">Save notifications</button></div></form></section>`;
  }
  function collectionPanel() {
    const c = C(),
      s = c.settings?.collection || {};
    const recent = (c.collections || []).slice(0, 8);
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Collection follow-ups</h2><p>Prepares a polite follow-up for overdue invoices, in the client's language, firmer as the invoice gets older. Every message waits for your approval and can be edited first.</p></div><div class="actions">${badge(s.enabled ? "Active" : "Not connected")}${button("Prepare drafts now", "comms-collect-run")}</div></div><form data-form="comms-collect">${checkbox("enabled", "Prepare drafts automatically every few hours", s.enabled)}${checkbox("useAi", "Draft with the AI model", s.useAi, c.aiReady ? "" : "disabled")}<p class="field-hint">${c.aiReady ? "Only the tone, language, days overdue and number of earlier reminders are sent to the model. Names, amounts, invoice numbers and contact details are filled in here when the message is sent." : "No AI model is configured; drafts use the built-in templates."}</p><div class="form-grid">${input("Start after this many days overdue", "minDays", s.minDays ?? 3, "number", true, 'min="1" max="90" step="1"')}<div></div></div>${checkbox("email", "Send by email", s.email !== false)}${checkbox("whatsapp", "Send by WhatsApp (uses the payment reminder template unless the client wrote in the last 24 hours)", s.whatsapp)}${checkbox("includeLink", "Include a new private link (replaces the current link)", s.includeLink)}${h.errorBlock()}<div class="form-actions"><button class="btn primary" type="submit">Save follow-up settings</button></div></form>${
      recent.length
        ? `<h3 class="mt22">Recent follow-ups</h3>${recent.map((x) => followUpLine(x)).join("")}`
        : ""
    }</section>`;
  }
  const STATE = { approved: "Pending", sending: "Sending", sent: "Sent", partial: "Part-paid", failed: "Failed", cancelled: "Void" };
  function followUpLine(x) {
    const d = doc(x.invoice_id);
    const result = x.result ? Object.values(x.result).filter(Boolean).join(" · ") : "";
    const subject = d ? x.subject.replace(/\{\{\s*number\s*\}\}/g, d.number) : x.subject;
    return `<div class="payment"><div class="payment-top"><strong>${E(d?.number || "Invoice")} · ${E(TONES[x.tone] || x.tone)}</strong>${badge(x.state === "partial" ? "Partly sent" : STATE[x.state] || x.state)}</div><p>${E(subject)}<br>${timeLabel(x.sent || x.created)}${result ? " · " + E(result) : ""}</p>${["failed", "partial"].includes(x.state) ? button("Send again", "comms-collect-retry", x.id) : ""}</div>`;
  }
  // ---- Template editor ------------------------------------------------------
  async function templateEditor(key) {
    const [use, lang] = key.split(":");
    templateInfo = templateInfo || (await api("/comms/templates"));
    const own = templateInfo.overrides.find((o) => o.use === use && o.language === lang);
    const t = own || templateInfo.defaults[use][lang];
    const vars = templateInfo.uses.find((u) => u.use === use).vars;
    showModal(
      `${USES.find(([u]) => u === use)[1]} · ${LANGS.find(([l]) => l === lang)[1]}`,
      `<form data-form="comms-template" data-id="${E(key)}"><div class="comms-editor"><div>${input("Subject", "subject", t.subject, "text", true, 'maxlength="200"')}<label>Message<textarea name="body" rows="16" maxlength="5000" required>${E(t.body)}</textarea></label><p class="field-hint">Click a placeholder to insert it where the cursor is. {{#link}}…{{/link}} shows its text only when there is a value; {{^link}}…{{/link}} only when there is none.</p><div class="comms-chips">${vars
        .map((v) => `<button type="button" class="comms-chip" data-action="comms-insert" data-id="${E(v.name)}" title="${E(v.help)}">{{${E(v.name)}}}</button>`)
        .join("")}</div></div><div class="comms-preview"><div class="comms-preview-head"><h3>Preview</h3><label>With<select name="record_id" aria-label="Preview with"></select></label></div><div class="form-error comms-problems" role="alert"></div><p class="comms-preview-subject"></p><div class="comms-preview-body"></div></div></div>${h.errorBlock()}<div class="form-actions">${own ? button("Reset to default", "comms-template-reset", key) : ""}${button("Cancel", "close-modal")}<button class="btn primary" type="submit">Save template</button></div></form>`,
      true,
    );
    const form = $("form");
    let timer;
    const preview = async () => {
      try {
        const p = await api("/comms/templates/preview", "POST", {
          use,
          language: lang,
          subject: form.elements.subject.value,
          body: form.elements.body.value,
          record_id: form.elements.record_id.value || undefined,
        });
        if (!form.isConnected) return;
        $(".comms-problems").textContent = p.problems.join(" ");
        $(".comms-preview-subject").textContent = p.subject ? "Subject: " + p.subject : "";
        $(".comms-preview-body").textContent = p.body;
        const sel = form.elements.record_id;
        if (!sel.options.length) {
          sel.innerHTML = p.records.length
            ? p.records.map((r) => `<option value="${E(r.id)}">${E(r.label)}</option>`).join("")
            : '<option value="">Example values</option>';
          if (p.record) sel.value = p.record;
        }
      } catch (e) {
        $(".comms-problems").textContent = e.message;
      }
    };
    for (const f of [form.elements.subject, form.elements.body]) {
      f.addEventListener("focus", () => (lastField = f));
      for (const ev of ["click", "keyup"]) f.addEventListener(ev, () => (f.dataset.touched = "1"));
      f.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(preview, 300);
      });
    }
    form.elements.record_id.addEventListener("change", preview);
    lastField = form.elements.body;
    preview();
  }
  function insertPlaceholder(name) {
    const f = lastField?.isConnected ? lastField : $("textarea[name=body]");
    if (!f) return;
    const tag = `{{${name}}}`;
    // Until the owner places the cursor, placeholders go at the end.
    const touched = f.dataset.touched === "1";
    const start = touched ? f.selectionStart : f.value.length,
      end = touched ? f.selectionEnd : f.value.length;
    f.value = f.value.slice(0, start) + tag + f.value.slice(end);
    f.focus();
    f.selectionStart = f.selectionEnd = start + tag.length;
    f.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function waMappingForm(use) {
    const c = C();
    const u = (c.whatsapp?.uses || []).find((x) => x.use === use);
    const m = c.settings?.whatsapp?.templates?.[use] || { name: "", language: "en", params: [], button: "" };
    showModal(
      `WhatsApp template: ${u.label}`,
      `<form data-form="comms-wa-template" data-id="${E(use)}"><div class="form-grid">${input("Template name", "name", m.name, "text", true, 'maxlength="512" pattern="[a-z0-9_]+" placeholder="invoice_link"')}${input("Language code", "language", m.language, "text", true, 'maxlength="10" placeholder="en, en_US or ms"')}</div>${input("Parameters, in order", "params", m.params.join(", "), "text", false, 'maxlength="600"')}<p class="field-hint">Comma separated, one per {{1}}, {{2}}… in your template. For named parameters write name=value, e.g. customer=contact_name. Values: ${E(u.vars.join(", "))}.</p>${select("Button", "button", [["", "No dynamic button"], ["link_token", "URL button ending with the private link token"]], m.button, false)}<p class="field-hint">For a URL button, set the template's button URL to ${E(location.origin)}/client/{{1}}.</p>${h.errorBlock()}<div class="form-actions">${m.name ? button("Remove", "comms-wa-unmap", use) : ""}${button("Cancel", "close-modal")}<button class="btn primary" type="submit">Save template</button></div></form>`,
    );
  }
  // ---- Documents ---------------------------------------------------------------
  function followUpReview(pid) {
    const p = pendingFollowUps().find((x) => x.id === pid);
    if (!p) return toast("This follow-up was already reviewed.", true);
    const b = p.payload,
      d = doc(b.invoice_id);
    showModal(
      "Review follow-up",
      `<p>${E(d?.number || "")} · ${E(d?.client.name || "")} · ${money(d?.balance || 0)} due · ${b.days_overdue} days overdue · ${E(TONES[b.tone])} tone · ${b.generated_by === "ai" ? "drafted by AI" : "drafted from the built-in template"}</p><form data-form="comms-review" data-id="${E(pid)}" class="mt22">${input("Subject", "subject", b.subject, "text", true, 'maxlength="200"')}<label>Message<textarea name="message" rows="15" maxlength="5000" required>${E(b.message)}</textarea></label><p class="field-hint">{{balance}}, {{due_date}}, {{days_overdue}} and the other placeholders are filled in with the invoice's figures when it is sent.</p>${checkbox("email", `Email to ${E(d?.client.email || "no email on file")}`, b.email, d?.client.email ? "" : "disabled")}${checkbox("whatsapp", `WhatsApp to ${E(d?.client.phone || "no phone on file")}`, b.whatsapp, d?.client.phone && C().whatsapp?.configured ? "" : "disabled")}<p class="field-hint">WhatsApp sends your approved payment reminder template, or this text if the client wrote to you in the last 24 hours.</p>${checkbox("include_link", "Include a new private link (replaces the current link)", b.include_link)}<div class="notice mt22"><p>Nothing is sent until you approve. It is sent once.</p></div>${h.errorBlock()}<div class="form-actions">${button("Reject", "comms-review-reject", pid)}${button("Cancel", "close-modal")}<button class="btn primary" type="submit">Approve & send</button></div></form>`,
      true,
    );
  }
  function whatsappForm(id) {
    const d = doc(id);
    const use = d.kind === "quote" ? "quote_link" : "invoice_link";
    const m = C().settings?.whatsapp?.templates?.[use];
    if (!m) return toast("Set up the WhatsApp template for this message in Settings first.", true);
    showModal(
      "Send by WhatsApp",
      `<form data-form="comms-doc-wa" data-id="${E(id)}">${input("Client WhatsApp number", "to", d.client.phone || "", "text", true, 'maxlength="30" placeholder="60123456789"')}<p class="field-hint">Sends your approved template "${E(m.name)}" (${E(m.language)}).</p>${checkbox("include_link", "Create a new private link for this message (replaces the current link)", true)}${formEnd("Send")}</form>`,
    );
  }
  function receiptForm(rid) {
    const r = S().finance.receipts.find((x) => x.id === rid);
    if (!S().mail?.configured) return toast("Email is not set up yet.", true);
    showModal(
      "Email receipt " + r.number,
      `<form data-form="comms-receipt" data-id="${E(rid)}">${bouncedNotice((C().addressIssues || []).filter((a) => a.email === (r.client.email || "").toLowerCase()))}${input("To", "to", r.client.email || "", "text", true, 'maxlength="600"')}${select("Language", "language", [["", "Automatic"], ...LANGS], "", false)}<p class="field-hint">Uses your receipt template and attaches the receipt PDF.</p>${formEnd("Send receipt")}</form>`,
    );
  }
  function documentPanels(d) {
    const parts = [];
    const pending = pendingFollowUps().filter((p) => p.payload.invoice_id === d.id);
    if (pending.length)
      parts.push(
        `<section class="panel"><div class="panel-head"><h2>Follow-up awaiting approval</h2>${badge("Pending review")}</div>${pending
          .map((p) => `<div class="payment"><strong>${E(p.payload.subject)}</strong><p>${E(TONES[p.payload.tone])} tone · ${p.payload.generated_by === "ai" ? "AI draft" : "Template draft"} · ${timeLabel(p.created)}</p>${button("Review and send", "comms-review", p.id, true)}</div>`)
          .join("")}</section>`,
      );
    const wa = (C().whatsapp?.log || []).filter((x) => x.document_id === d.id).slice(0, 6);
    const follow = (C().collections || []).filter((x) => x.invoice_id === d.id).slice(0, 4);
    if (wa.length || follow.length)
      parts.push(
        `<section class="panel"><div class="panel-head"><h2>Messages</h2></div>${wa
          .map((x) => `<div class="payment"><div class="payment-top"><strong>WhatsApp ${E(x.kind)}</strong>${waStatusBadge(x.status)}</div><p>${E(x.number)} · ${timeLabel(x.created)}</p>${x.error ? `<p>${E(x.error)}</p>` : ""}</div>`)
          .join("")}${follow.map(followUpLine).join("")}</section>`,
      );
    if (d.kind === "invoice") {
      const ids = [...new Set((d.payments || []).filter((p) => !p.reversed && p.receipt_id).map((p) => p.receipt_id))];
      const receipts = ids.map((rid) => S().finance?.receipts.find((r) => r.id === rid)).filter((r) => r && !r.voided);
      if (receipts.length && S().mail?.configured)
        parts.push(
          `<section class="panel"><div class="panel-head"><h2>Receipts</h2></div>${receipts
            .map((r) => `<div class="setting-line"><div><h3>${E(r.number)}</h3><p>${money(r.amount)} · ${dateLabel(r.paid_date)}</p></div>${button("Email", "comms-receipt", r.id)}</div>`)
            .join("")}</section>`,
        );
    }
    return parts.join("");
  }
  function documentActions(d) {
    let out = "";
    if (["issued", "accepted"].includes(d.state) && C().whatsapp?.configured) out += button("WhatsApp", "comms-doc-wa", d.id, false, "chat");
    if (d.kind === "invoice" && d.state === "issued" && d.balance > 0 && (d.next_due_date || d.due_date) < today() && !pendingFollowUps().some((p) => p.payload.invoice_id === d.id))
      out += button("Prepare follow-up", "comms-follow-up", d.id);
    return out;
  }
  function overviewPanel() {
    const list = pendingFollowUps();
    if (!list.length) return "";
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Follow-ups awaiting approval</h2><p>Nothing is sent until you approve.</p></div>${badge(list.length + " pending")}</div>${list
      .slice(0, 6)
      .map((p) => {
        const d = doc(p.payload.invoice_id);
        return `<div class="attention"><div><strong>${E(d?.number || "")}</strong><small>${E(d?.client.name || "")} / ${money(d?.balance || 0)} / ${p.payload.days_overdue} days overdue</small><button class="link-button" data-action="comms-review" data-id="${E(p.id)}">Review & send →</button></div>${badge(TONES[p.payload.tone])}</div>`;
      })
      .join("")}</section>`;
  }
  function clientDetails(c) {
    const issue = (C().addressIssues || []).find((a) => a.email === String(c.email || "").toLowerCase());
    if (!issue) return "";
    return `<dt>Email warning</dt><dd><span class="badge red"><span class="dot"></span>${issue.type === "complaint" ? "Marked as spam" : "Bounced"}</span> ${timeLabel(issue.created)}${issue.detail ? `<small>${E(issue.detail)}</small>` : ""}<button class="link-button" data-action="comms-address-clear" data-id="${E(issue.email)}">Clear warning</button></dd>`;
  }
  // ---- Actions and forms -------------------------------------------------------
  const bools = (form, names) => Object.fromEntries(names.map((n) => [n, !!form.elements[n]?.checked]));
  return {
    icons: {
      bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
      chat: '<path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.5L3 21l2-5.5A8.5 8.5 0 1 1 21 11.5z"/>',
    },
    slots: {
      topbar: bell,
      overview: overviewPanel,
      documentActions,
      documentPanels,
      clientDetails,
      settings: () => mailPanel() + templatesPanel() + whatsappPanel() + notifyPanel() + collectionPanel(),
    },
    async action(type, id) {
      switch (type) {
        case "email-document":
          await emailForm(id);
          return true;
        case "client-statement":
          await statementForm(id);
          return true;
        case "comms-bell":
          await openNotifications();
          return true;
        case "comms-note-open": {
          const n = notes.find((x) => x.id === id);
          await api("/comms/notifications/read", "POST", { ids: [id] });
          modal.close();
          await refresh();
          navigate(n.route);
          return true;
        }
        case "comms-note-read-all":
          await api("/comms/notifications/read", "POST", { all: true });
          modal.close();
          await reload("All notifications marked as read.");
          return true;
        case "comms-test-email":
          showModal("Send test email", `<form data-form="comms-test-email">${input("Send to", "to", C().settings?.ownerEmail || C().ownerLogin || "", "email", true, 'maxlength="160"')}<p class="field-hint">Uses the current SMTP settings. If it fails, the reason is shown here.</p>${formEnd("Send test")}</form>`);
          return true;
        case "comms-sns-done":
          await api("/comms/mail/sns-confirmed", "POST", {});
          await reload("Subscription marked as confirmed.");
          return true;
        case "comms-address-clear":
          await api("/comms/addresses/clear", "POST", { email: id });
          await reload("Warning cleared.");
          return true;
        case "comms-template-edit":
          await templateEditor(id);
          return true;
        case "comms-insert":
          insertPlaceholder(id);
          return true;
        case "comms-template-reset": {
          const [use, lang] = id.split(":");
          await api(`/comms/templates/${use}/${lang}`, "DELETE");
          templateInfo = null;
          modal.close();
          await reload("Template reset to the default text.");
          return true;
        }
        case "comms-wa-map":
          waMappingForm(id);
          return true;
        case "comms-wa-unmap":
          await api("/comms/settings", "PUT", { whatsapp: { templates: { [id]: null } } });
          modal.close();
          await reload("WhatsApp template removed.");
          return true;
        case "comms-wa-test":
          showModal("Send WhatsApp test", `<form data-form="comms-wa-test">${input("Send to", "to", C().settings?.ownerWhatsApp || "", "text", true, 'maxlength="30" placeholder="60123456789"')}<p class="field-hint">Sends Meta's approved "hello_world" sample template (en_US). The number must be able to receive WhatsApp messages; test numbers must be added in your Meta app first.</p>${formEnd("Send test")}</form>`);
          return true;
        case "comms-wa-run": {
          const r = await api("/jobs/comms:whatsapp-reminders/run", "POST", {});
          await reload(r.skipped ? "WhatsApp reminders are off." : `${r.sent} WhatsApp reminder(s) sent.`);
          return true;
        }
        case "comms-doc-wa":
          whatsappForm(id);
          return true;
        case "comms-receipt":
          receiptForm(id);
          return true;
        case "comms-follow-up": {
          const r = await api(`/comms/documents/${id}/follow-up`, "POST", { force: true });
          await refresh();
          renderRoute();
          followUpReview(r.proposal.id);
          return true;
        }
        case "comms-review":
          followUpReview(id);
          return true;
        case "comms-review-reject":
          showModal("Reject follow-up", `<form data-form="proposal-reject" data-id="${E(id)}">${area("Reason (required)", "reason", "", 1000)}${formEnd("Reject")}</form>`);
          $("textarea[name=reason]").required = true;
          return true;
        case "comms-collect-run": {
          const r = await api("/comms/collections/run", "POST", {});
          await reload(r.prepared ? `${r.prepared} follow-up draft(s) ready for review.` : "No new follow-ups are needed right now.");
          return true;
        }
        case "comms-collect-retry": {
          const r = await api(`/comms/collections/${id}/retry`, "POST", {});
          await reload(r.state === "sent" ? "Follow-up sent." : "Some channels still failed. See the follow-up for details.");
          return true;
        }
      }
      return false;
    },
    async submit(form, b) {
      const type = form.dataset.form,
        id = form.dataset.id;
      switch (type) {
        case "email-document":
          await api(`/documents/${id}/email`, "POST", {
            to: b.to,
            cc: b.cc,
            subject: b.subject,
            message: b.message,
            language: b.language,
            include_link: b.include_link === "on",
            link_days: Number(b.link_days),
          });
          modal.close();
          await reload("Email sent.");
          return true;
        case "statement":
          await api(`/clients/${id}/statement/email`, "POST", b);
          modal.close();
          await reload("Statement emailed.");
          return true;
        case "comms-mail":
          await api("/comms/settings", "PUT", { language: b.language, ...bools(form, ["trackOpens", "reminderLinks", "autoReceipts"]) });
          await reload("Email settings saved.");
          return true;
        case "comms-test-email":
          await api("/comms/mail/test", "POST", { to: b.to });
          modal.close();
          await reload("Test email sent. Check the inbox (and spam folder).");
          return true;
        case "comms-template": {
          const [use, lang] = id.split(":");
          await api(`/comms/templates/${use}/${lang}`, "PUT", { subject: b.subject, body: b.body });
          templateInfo = null;
          modal.close();
          await reload("Template saved.");
          return true;
        }
        case "comms-wa":
          await api("/comms/settings", "PUT", { whatsapp: { reminders: !!form.elements.reminders?.checked } });
          await reload("WhatsApp settings saved.");
          return true;
        case "comms-wa-template":
          await api("/comms/settings", "PUT", {
            whatsapp: { templates: { [id]: { name: b.name, language: b.language, params: b.params, button: b.button } } },
          });
          modal.close();
          await reload("WhatsApp template saved.");
          return true;
        case "comms-wa-test":
          await api("/comms/whatsapp/test", "POST", { to: b.to });
          modal.close();
          await reload("Test message sent. Delivery status appears under Recent messages.");
          return true;
        case "comms-notify": {
          const notify = {};
          for (const k of Object.keys(C().notifyTypes || {}))
            notify[k] = Object.fromEntries(["inapp", "email", "whatsapp"].map((ch) => [ch, !!form.elements[`${k}.${ch}`]?.checked]));
          await api("/comms/settings", "PUT", { notify, ownerEmail: b.ownerEmail, ownerWhatsApp: b.ownerWhatsApp });
          await reload("Notification settings saved.");
          return true;
        }
        case "comms-collect":
          await api("/comms/settings", "PUT", {
            collection: { ...bools(form, ["enabled", "useAi", "email", "whatsapp", "includeLink"]), minDays: Number(b.minDays) },
          });
          await reload("Follow-up settings saved.");
          return true;
        case "comms-review": {
          const r = await api(`/comms/collections/${id}/approve`, "POST", {
            subject: b.subject,
            message: b.message,
            ...bools(form, ["email", "whatsapp", "include_link"]),
          });
          modal.close();
          const c = r.collection;
          await reload(c.state === "sent" ? "Follow-up approved and sent." : c.state === "cancelled" ? "The invoice was already paid, so nothing was sent." : "Approved, but some channels failed. See Messages on the invoice.");
          return true;
        }
        case "comms-doc-wa":
          await api(`/comms/documents/${id}/whatsapp`, "POST", { to: b.to, include_link: b.include_link === "on" });
          modal.close();
          await reload("WhatsApp message sent.");
          return true;
        case "comms-receipt":
          await api(`/comms/receipts/${id}/email`, "POST", { to: b.to, ...(b.language ? { language: b.language } : {}) });
          modal.close();
          await reload("Receipt emailed.");
          return true;
      }
      return false;
    },
  };
}
