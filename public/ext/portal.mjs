// Client portal: client accounts, multiple contacts, credit limits, quotation e-signatures and client feedback.
// Browser module contract: see docs/PLUGINS.md. Client-facing pages live in portal-guest.mjs.
import { portalGuest } from "./portal-guest.mjs";

const ROLES = [
  ["billing", "Billing"],
  ["technical", "Technical"],
  ["other", "Other"],
];
const roleLabel = (r) => ROLES.find(([k]) => k === r)?.[1] || "Other";
const HELD = ["invoice", "quote"];

export default function portalUI(h) {
  const { E, money, dec, badge, button, icon, timeLabel, dateLabel } = h;
  const guest = portalGuest(h);
  let lastUrl = "";
  const P = () => h.get()?.ext?.portal || null;
  const contactsOf = (cid) => P()?.contacts?.[cid] || [];
  const clientOf = (cid) => P()?.clients?.[cid] || null;
  // Badges for this module's own states (the core badge colours only known statuses).
  const tone = (label, color = "") => `<span class="badge ${color}"><span class="dot"></span>${E(label)}</span>`;
  const days = (n) => `${n} day${n === 1 ? "" : "s"}`;
  const stars = (n) => `<span class="portal-rating" aria-label="${n} out of 5">${"★".repeat(n)}<span>${"★".repeat(5 - n)}</span></span>`;
  const done = async (message) => {
    h.modal.close();
    await h.refresh();
    h.renderRoute();
    if (message) h.toast(message);
  };
  const linkModal = (title, url, note) => {
    lastUrl = url;
    h.showModal(
      title,
      `${h.input("Link", "portalurl", url, "url", false, "readonly")}<p class="field-hint">${E(note)}</p><div class="actions mt22">${button("Copy link", "portal-copy", "", true, "copy")}<a class="btn" href="https://wa.me/?text=${encodeURIComponent(url)}" target="_blank" rel="noopener noreferrer">Share via WhatsApp</a></div><p class="field-hint">The link is shown only now. Treat it like a password.</p>`,
    );
  };

  // ---- Credit (no. 51) -------------------------------------------------------
  function creditLine(s) {
    if (!s) return "";
    const parts = [
      s.credit_limit === null ? "No credit limit" : `Limit ${money(s.credit_limit)}`,
      `used ${money(s.used)}`,
      ...(s.credit_limit === null ? [] : [`available ${money(s.available)}`]),
    ];
    return parts.join(" · ");
  }
  function creditNote(cid, kind) {
    const s = clientOf(cid);
    if (!s || !HELD.includes(kind)) return `<div data-portal-credit data-kind="${E(kind)}"></div>`;
    const warn = s.held || s.over_limit;
    if (!warn && s.credit_limit === null && s.hold_days === null) return `<div data-portal-credit data-kind="${E(kind)}"></div>`;
    return `<div class="notice ${warn ? "" : "info"} portal-credit-note" data-portal-credit data-kind="${E(kind)}"><p><strong>${warn ? "Client on hold or over limit." : "Credit check."}</strong> ${E(creditLine(s))}${s.reasons.length ? "<br>" + s.reasons.map(E).join("<br>") : ""}${warn ? "<br>Issuing will be blocked unless you allow it with a reason." : ""}</p></div>`;
  }
  function creditPanel(d) {
    const c = P()?.drafts?.[d.id];
    const s = clientOf(d.client_id);
    if (!c || !s) return "";
    if (!c.blocked && s.credit_limit === null && s.hold_days === null) return "";
    return `<section class="panel"><div class="panel-head"><h2>Credit check</h2>${c.blocked ? (c.override ? tone("Allowed", "green") : tone("Blocked", "red")) : tone("Clear", "green")}</div><p>${E(creditLine(s))}</p>${s.credit_limit !== null ? `<div class="total-row"><span>After this ${d.kind === "quote" ? "quotation" : "invoice"}</span><strong>${money(c.projected)}</strong></div>` : ""}${
      c.blocked
        ? c.override
          ? `<div class="notice info mt22"><p>Issue allowed by ${E(c.override.actor)} on ${E(timeLabel(c.override.created))}.<br>Reason: ${E(c.override.reason)}</p></div>`
          : `<div class="notice mt22"><p>${E(c.reasons.join(". "))}.</p></div><div class="actions mt22">${button("Allow issue", "portal-credit-override", d.id)}</div><p class="field-hint">Issuing stays blocked until you allow it with a reason. The reason is kept in the audit history.</p>`
        : ""
    }</section>`;
  }

  // ---- Signature and feedback on a document ----------------------------------
  function signaturePanel(d) {
    const s = P()?.signatures?.[d.id];
    if (!s) return "";
    return `<section class="panel"><div class="panel-head"><h2>Client signature</h2>${badge("Accepted")}</div><div class="portal-signature"><img src="/api/files/${E(s.file_id)}" alt="Signature of ${E(s.signer_name)}"></div><dl class="detail portal-detail"><dt>Signed by</dt><dd>${E(s.signer_name)}</dd><dt>Signed at</dt><dd>${E(timeLabel(s.signed_at))}</dd><dt>Method</dt><dd>${s.method === "draw" ? "Drawn" : "Typed"} signature, ${s.source === "portal" ? "client portal" : "client link"}</dd><dt>Browser</dt><dd class="portal-wrap-text">${E(s.user_agent || "Not given")}</dd><dt>Network fingerprint</dt><dd><code>${E(s.ip_hash.slice(0, 16))}</code></dd><dt>Quotation fingerprint</dt><dd><code>${E(s.document_hash.slice(0, 16))}</code></dd></dl><p class="field-hint">The signature and these details are printed on the quotation PDF (without the browser and network details).</p></section>`;
  }
  function feedbackPanel(d) {
    const f = (P()?.feedback?.items || []).find((x) => x.invoice_id === d.id);
    if (!f) return "";
    return `<section class="panel"><div class="panel-head"><h2>Client feedback</h2>${stars(f.rating)}</div><p>${E(f.comment || "No comment.")}</p><p class="field-hint">${E(timeLabel(f.created))} · ${f.consent ? (f.testimonial ? "Shown as a testimonial" : "May be shown as a testimonial") : "Private"}</p></section>`;
  }

  // ---- Contacts and portal on the client profile (no. 49, 50) ----------------
  function contactsPanel(c) {
    const list = contactsOf(c.id);
    return `<section class="panel"><div class="panel-head"><div><h2>Contacts</h2><p>The primary billing contact fills the client's main contact, email and phone.</p></div>${button("Add contact", "portal-contact-new", c.id, false, "plus")}</div>${
      list.length
        ? list
            .map(
              (p) =>
                `<div class="payment portal-contact"><div class="payment-top"><strong>${E(p.name || p.email)}</strong><span class="actions">${p.primary_billing ? tone("Primary billing", "blue") : tone(roleLabel(p.role))}</span></div><p>${E([p.email, p.phone].filter(Boolean).join(" · ") || "No email or phone")}<br>${[p.cc_invoices ? "Copy on invoices" : "", p.portal_access ? "Portal access" : ""].filter(Boolean).map(E).join(" · ") || "No copies or portal access"}</p><div class="payment-actions">${button("Edit", "portal-contact-edit", p.id)}${p.primary_billing ? "" : `<button type="button" class="link-button red-text" data-action="portal-contact-delete" data-id="${E(p.id)}">Remove</button>`}</div></div>`,
            )
            .join("")
        : `<p>No contacts yet. Add a billing contact to send invoices and give portal access.</p>`
    }</section>`;
  }
  function portalPanel(c) {
    const s = clientOf(c.id);
    if (!s) return "";
    const a = s.portal;
    const access = contactsOf(c.id).filter((p) => p.portal_access && p.email);
    const links = a.links.filter((l) => !l.revoked_at && l.expires > Date.now());
    return `<section class="panel"><div class="panel-head"><div><h2>Client portal</h2><p>All issued documents, receipts and statements in one place for this client.</p></div>${a.enabled ? tone("On", "green") : tone("Off")}</div>${
      a.enabled
        ? `<div class="setting-line"><div><h3>Signed in now</h3><p>${a.sessions} session${a.sessions === 1 ? "" : "s"} · ${a.invites} unused sign-in link${a.invites === 1 ? "" : "s"}</p></div>${a.sessions ? button("Sign out all", "portal-sessions-revoke", c.id) : ""}</div><div class="setting-line"><div><h3>Email sign-in</h3><p>${access.length ? access.map((p) => E(p.email)).join(", ") : "No contact has portal access yet. Edit a contact and tick Portal access."}</p></div>${access.length ? button("Invite", "portal-invite", c.id, true) : ""}</div><div class="setting-line"><div><h3>Access links</h3><p>${links.length ? links.map((l) => `${E(l.label || "Access link")} · until ${E(timeLabel(new Date(l.expires).toISOString()))}${l.last_used ? " · used " + E(timeLabel(l.last_used)) : ""}`).join("<br>") : "For clients without email: a private link that opens the portal until it expires or you revoke it."}</p></div>${button("Create link", "portal-link-new", c.id)}</div>${links.length ? `<div class="actions mt22">${links.map((l) => button("Revoke " + (l.label || "link"), "portal-link-revoke", l.id)).join("")}</div>` : ""}<div class="actions mt22">${button("Turn off portal", "portal-toggle", c.id)}</div>`
        : `<p>Turn on the portal, then invite contacts that have portal access or create an access link.</p><div class="actions mt22">${c.archived ? "" : button("Turn on portal", "portal-toggle", c.id, true)}</div>`
    }</section>`;
  }
  function contactForm(clientId, contactId = "") {
    const p = contactsOf(clientId).find((x) => x.id === contactId) || { role: "billing" };
    const primary = !!p.primary_billing;
    h.showModal(
      contactId ? "Edit contact" : "Add contact",
      `<form data-form="portal-contact" data-id="${E(contactId)}" data-client="${E(clientId)}"><div class="form-grid">${h.input("Name", "name", p.name || "", "text", false, 'maxlength="120"')}${h.select("Role", "role", ROLES, p.role, true)}${h.input("Email", "email", p.email || "", "email", false, 'maxlength="160"')}${h.input("Phone", "phone", p.phone || "", "text", false, 'maxlength="60"')}</div><label class="check-row mt22"><input type="checkbox" name="primary_billing" ${primary ? "checked disabled" : ""}> Primary billing contact (fills the client's main contact, email and phone)</label><label class="check-row"><input type="checkbox" name="cc_invoices" ${p.cc_invoices ? "checked" : ""}> Copy on invoices, statements and reminders (Cc)</label><label class="check-row"><input type="checkbox" name="portal_access" ${p.portal_access ? "checked" : ""}> Portal access (can sign in with this email)</label>${primary ? '<p class="field-hint">To change the primary billing contact, edit another contact and tick Primary billing contact.</p>' : ""}${h.formEnd("Save contact")}</form>`,
    );
  }

  // ---- Feedback page (no. 99) ------------------------------------------------
  function feedbackPage() {
    const S = h.get();
    const f = P()?.feedback || { summary: { count: 0, counts: [0, 0, 0, 0, 0], by_client: {} }, items: [] };
    const sum = f.summary;
    const name = (cid) => S.clients.find((c) => c.id === cid)?.name || "Client";
    const max = Math.max(1, ...sum.counts);
    return (
      h.heading(
        "Client feedback",
        "Ratings and comments clients leave after an invoice is fully paid.",
        `<a class="btn" href="/api/portal/feedback.csv">${icon("download")} Export CSV</a><a class="btn" href="/api/portal/feedback.csv?testimonials=1">${icon("download")} Testimonials CSV</a>`,
      ) +
      `<div class="metrics"><div class="metric"><span class="metric-icon">${icon("star")}</span><div class="label">Average rating</div><div class="value">${sum.average === null ? "—" : E(sum.average) + " / 5"}</div><div class="hint">${sum.count} rating${sum.count === 1 ? "" : "s"}</div></div><div class="metric"><span class="metric-icon">${icon("check")}</span><div class="label">Testimonials</div><div class="value">${sum.testimonials}</div><div class="hint">Shown with the client's consent</div></div><div class="metric portal-dist"><div class="label">Ratings</div>${[5, 4, 3, 2, 1]
        .map((r) => `<div class="portal-bar"><span>${r}★</span><div class="portal-bar-track"><div class="portal-bar-fill" data-width="${Math.round((sum.counts[r - 1] / max) * 100)}"></div></div><small>${sum.counts[r - 1]}</small></div>`)
        .join("")}</div></div>` +
      `<div class="grid-2 mt22"><section class="panel"><div class="panel-head"><h2>Latest feedback</h2></div>${
        f.items.length
          ? `<div class="table-wrap"><table><thead><tr><th>Client / invoice</th><th>Rating</th><th>Comment</th><th>Testimonial</th></tr></thead><tbody>${f.items
              .map(
                (x) =>
                  `<tr><td><button class="link-button" data-action="open-document" data-id="${E(x.invoice_id)}">${E(x.client_name)}</button><small>${E(x.invoice_number)} · ${E(dateLabel(x.created.slice(0, 10)))}</small></td><td>${stars(x.rating)}</td><td>${E(x.comment || "—")}${x.display_name ? `<small>Show as: ${E(x.display_name)}</small>` : ""}</td><td>${x.consent ? button(x.testimonial ? "Hide" : "Show", "portal-testimonial", x.id + (x.testimonial ? ":0" : ":1")) : '<span class="field-hint">Not allowed</span>'}</td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : h.empty("No feedback yet", "Clients can rate an invoice once it is fully paid, from their link or the portal.")
      }</section><section class="panel"><div class="panel-head"><h2>By client</h2></div>${
        Object.keys(sum.by_client).length
          ? `<div class="table-wrap"><table><thead><tr><th>Client</th><th class="num">Ratings</th><th class="num">Average</th></tr></thead><tbody>${Object.entries(sum.by_client)
              .sort((a, b) => b[1].count - a[1].count)
              .map(([cid, v]) => `<tr><td><button class="link-button" data-action="open-client" data-id="${E(cid)}">${E(name(cid))}</button></td><td class="num">${v.count}</td><td class="num">${E(v.average)}</td></tr>`)
              .join("")}</tbody></table></div>`
          : "<p>Averages per client appear here.</p>"
      }</section></div>`
    );
  }
  // Bars get their widths after render (no inline styles under the CSP).
  const sizeBars = () =>
    requestAnimationFrame(() => {
      for (const el of document.querySelectorAll(".portal-bar-fill[data-width]")) el.style.width = el.dataset.width + "%";
    });

  // The client select in the editor changes which credit status applies.
  document.addEventListener("change", (e) => {
    if (e.target.name !== "client_id" || !e.target.closest('form[data-form="editor"]')) return;
    const box = e.target.form.querySelector("[data-portal-credit]");
    if (box) box.outerHTML = creditNote(e.target.value, box.dataset.kind);
  });

  return {
    nav: [{ key: "feedback", label: "Client feedback", icon: "star", group: "Records" }],
    pages: {
      feedback: () => {
        sizeBars();
        return feedbackPage();
      },
    },
    icons: {
      star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
      pen: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m14 6 4 4"/>',
    },
    // Recipients for document and statement emails come from the contacts.
    emailPrefill(kind, record, values) {
      const cid = kind === "document" ? record?.client_id : record?.id;
      const list = contactsOf(cid);
      if (!list.length) return null;
      const to = list.find((p) => p.primary_billing && p.email)?.email || values.to;
      const seen = new Set(
        [to, ...String(values.cc || "").split(/[,;]/)].map((v) => v.trim().toLowerCase()).filter(Boolean),
      );
      const cc = String(values.cc || "")
        .split(/[,;]/)
        .map((v) => v.trim())
        .filter(Boolean);
      for (const p of list)
        if (p.cc_invoices && p.email && !seen.has(p.email.toLowerCase())) {
          seen.add(p.email.toLowerCase());
          cc.push(p.email);
        }
      return { to, cc: cc.slice(0, 4).join(", ") };
    },
    guestPage: (loc) => guest.page(loc),
    async action(type, id, el) {
      if (await guest.action(type, id, el)) return true;
      switch (type) {
        case "portal-contact-new":
          contactForm(id);
          return true;
        case "portal-contact-edit": {
          const cid = Object.entries(P()?.contacts || {}).find(([, l]) => l.some((p) => p.id === id))?.[0];
          if (cid) contactForm(cid, id);
          return true;
        }
        case "portal-contact-delete":
          h.confirmModal("Remove contact?", "The contact loses portal access and copies of invoices. The change is kept in the audit history.", "portal-contact-delete-confirm", id, "Remove contact");
          return true;
        case "portal-contact-delete-confirm":
          try {
            await h.api(`/portal/contacts/${id}`, "DELETE");
          } catch (e) {
            h.modal.querySelector(".form-error").textContent = e.message;
            return true;
          }
          await done("Contact removed.");
          return true;
        case "portal-toggle": {
          const on = !clientOf(id)?.portal?.enabled;
          if (!on) {
            h.confirmModal("Turn off the portal?", "Everyone signed in is signed out, and unused sign-in and access links stop working.", "portal-toggle-off", id, "Turn off portal");
            return true;
          }
          await h.api(`/portal/clients/${id}/portal`, "PUT", { enabled: true });
          await done("Portal turned on. Invite a contact or create an access link.");
          return true;
        }
        case "portal-toggle-off":
          await h.api(`/portal/clients/${id}/portal`, "PUT", { enabled: false });
          await done("Portal turned off.");
          return true;
        case "portal-invite": {
          const S = h.get();
          const access = contactsOf(id).filter((p) => p.portal_access && p.email);
          h.showModal(
            "Invite to the client portal",
            `<form data-form="portal-invite" data-id="${E(id)}">${h.select("Contact", "contact_id", access.map((p) => [p.id, `${p.name || p.email} <${p.email}>`]))}${
              S.ext.portal.mail
                ? `<p class="field-hint">We email a sign-in link that works once, within 3 days. Later the contact signs in with their email address.</p><label class="check-row"><input type="checkbox" name="copy"> Give me the link to send myself instead</label>`
                : '<p class="field-hint">Email is not set up, so you get a one-time link (valid 3 days) to send yourself.</p>'
            }${h.formEnd(S.ext.portal.mail ? "Send invite" : "Create link")}</form>`,
          );
          return true;
        }
        case "portal-link-new":
          h.showModal(
            "Create access link",
            `<form data-form="portal-link" data-id="${E(id)}">${h.input("Label (e.g. who it is for)", "label", "", "text", false, 'maxlength="80"')}${h.select("Valid for", "days", [["30", "30 days"], ["90", "90 days"], ["180", "180 days"], ["365", "1 year"]], "90")}<p class="field-hint">Anyone with the link can open this client's portal until it expires or you revoke it. Use it for clients without email.</p>${h.formEnd("Create link")}</form>`,
          );
          return true;
        case "portal-link-revoke":
          await h.api(`/portal/links/${id}/revoke`, "POST", {});
          await done("Access link revoked.");
          return true;
        case "portal-sessions-revoke":
          await h.api(`/portal/clients/${id}/sessions/revoke`, "POST", {});
          await done("Portal sessions signed out.");
          return true;
        case "portal-copy":
          try {
            await navigator.clipboard.writeText(lastUrl);
            h.toast("Link copied.");
          } catch {
            h.modal.querySelector('input[name="portalurl"]')?.select();
            h.toast("Select and copy the link from the field.");
          }
          return true;
        case "portal-credit-override":
          h.showModal(
            "Allow issue",
            `<form data-form="portal-override" data-id="${E(id)}"><p>${E(P()?.drafts?.[id]?.message || "")}</p>${h.area("Reason (required)", "reason", "", 500)}<p class="field-hint">Only this draft, at its current amount, may be issued. The reason is kept in the audit history.</p>${h.formEnd("Allow issue")}</form>`,
          );
          h.modal.querySelector('textarea[name="reason"]').required = true;
          return true;
        case "portal-testimonial": {
          const [fid, on] = String(id).split(":");
          await h.api(`/portal/feedback/${fid}`, "PUT", { testimonial: on === "1" });
          await h.refresh();
          h.renderRoute();
          h.toast(on === "1" ? "Shown as a testimonial." : "Testimonial hidden.");
          return true;
        }
      }
      return false;
    },
    async submit(form, b) {
      if (await guest.submit(form, b)) return true;
      const type = form.dataset.form,
        id = form.dataset.id;
      if (type === "portal-contact") {
        const body = {
          name: b.name || "",
          email: b.email || "",
          phone: b.phone || "",
          role: b.role,
          cc_invoices: b.cc_invoices === "on",
          portal_access: b.portal_access === "on",
          ...(form.elements.primary_billing.disabled ? {} : { primary_billing: b.primary_billing === "on" }),
        };
        if (id) await h.api(`/portal/contacts/${id}`, "PUT", body);
        else await h.api(`/portal/clients/${form.dataset.client}/contacts`, "POST", body);
        await done("Contact saved.");
        return true;
      }
      if (type === "portal-invite") {
        const r = await h.api(`/portal/clients/${id}/invite`, "POST", { contact_id: b.contact_id, copy: b.copy === "on" });
        if (r.sent) {
          await done(`Invite sent to ${r.email}.`);
        } else {
          await h.refresh();
          h.renderRoute();
          linkModal("Portal invite link", r.url, `For ${r.email}. Works once, until ${timeLabel(new Date(r.expires).toISOString())}.`);
        }
        return true;
      }
      if (type === "portal-link") {
        const r = await h.api(`/portal/clients/${id}/links`, "POST", { label: b.label || "", days: Number(b.days) });
        await h.refresh();
        h.renderRoute();
        linkModal("Portal access link", r.url, `Opens this client's portal until ${timeLabel(new Date(r.expires).toISOString())}, or until you revoke it.`);
        return true;
      }
      if (type === "portal-override") {
        await h.api(`/portal/documents/${id}/credit-override`, "POST", { reason: b.reason });
        await done("Issue allowed for this draft.");
        return true;
      }
      if (type === "portal-settings") {
        await h.api("/portal/settings", "PUT", { feedback_emails: b.feedback_emails === "on" });
        await h.refresh();
        h.renderRoute();
        h.toast("Portal settings saved.");
        return true;
      }
      return false;
    },
    slots: {
      overview() {
        const S = h.get(),
          p = P();
        if (!p) return "";
        const held = S.clients.filter((c) => !c.archived && (p.clients[c.id]?.held || p.clients[c.id]?.over_limit));
        const f = p.feedback.summary;
        const latest = p.feedback.items.slice(0, 3);
        if (!held.length && !f.count) return "";
        return `<div class="grid-2 mt22">${
          held.length
            ? `<section class="panel"><div class="panel-head"><div><h2>Clients on hold</h2><p>New invoices and quotations are blocked</p></div>${tone(String(held.length), "red")}</div>${held
                .map((c) => {
                  const s = p.clients[c.id];
                  return `<div class="attention"><div><strong>${E(c.name)}</strong><small>${E(creditLine(s))}</small><small>${E(s.reasons.join(". ") || "Over the credit limit")}</small><button class="link-button" data-action="open-client" data-id="${E(c.id)}">Open client →</button></div>${tone(s.held ? "On hold" : "Over limit", "red")}</div>`;
                })
                .join("")}</section>`
            : ""
        }${
          f.count
            ? `<section class="panel"><div class="panel-head"><div><h2>Client feedback</h2><p>${E(f.average)} / 5 from ${f.count} rating${f.count === 1 ? "" : "s"}</p></div><a href="#/feedback">View all →</a></div>${latest
                .map((x) => `<div class="attention"><div><strong>${E(x.client_name)}</strong><small>${E(x.comment || "No comment")}</small></div>${stars(x.rating)}</div>`)
                .join("")}</section>`
            : ""
        }</div>`;
      },
      documentPanels: (d) => creditPanel(d) + (d.kind === "quote" ? signaturePanel(d) : "") + (d.kind === "invoice" ? feedbackPanel(d) : ""),
      documentFields: (value, kind) => creditNote(value.client_id, kind),
      clientFields(c) {
        const s = (c.id && clientOf(c.id)) || { credit_limit: null, hold_days: null, on_hold: false, hold_reason: "" };
        return `<div class="span-2 portal-form-head"><h3>Credit and work hold</h3><p class="field-hint">New invoices and quotations are blocked while the client is on hold or over the limit, unless you allow them with a reason.</p></div><input type="hidden" name="portal_credit" value="1">${h.input("Credit limit (MYR, optional)", "credit_limit", s.credit_limit === null ? "" : dec(s.credit_limit), "number", false, 'min="0" max="99999999.99" step="0.01" placeholder="No limit"')}${h.input("Hold when overdue more than (days, optional)", "hold_days", s.hold_days ?? "", "number", false, 'min="0" max="365" step="1" placeholder="Never"')}<div class="span-2"><label class="check-row"><input type="checkbox" name="on_hold" ${s.on_hold ? "checked" : ""}> Put this client on hold now</label>${h.input("Hold reason (required when on hold)", "hold_reason", s.hold_reason || "", "text", false, 'maxlength="300"')}</div>`;
      },
      clientDetails(c) {
        const s = clientOf(c.id);
        if (!s) return "";
        const f = P().feedback.summary.by_client[c.id];
        return `<dt>Credit</dt><dd>${E(creditLine(s))}</dd><dt>Work hold</dt><dd>${s.held ? `${tone("On hold", "red")}<br>${s.reasons.map(E).join("<br>")}` : s.over_limit ? tone("Over limit", "red") : "Not on hold"}${s.hold_days !== null ? `<br><small>Automatic hold after ${days(s.hold_days)} overdue</small>` : ""}</dd><dt>Client portal</dt><dd>${s.portal.enabled ? "On" : "Off"}</dd>${f ? `<dt>Feedback</dt><dd>${E(f.average)} / 5 from ${f.count} invoice${f.count === 1 ? "" : "s"}</dd>` : ""}`;
      },
      clientActions(c) {
        const s = clientOf(c.id);
        return s?.portal?.enabled && contactsOf(c.id).some((p) => p.portal_access && p.email)
          ? button("Invite to portal", "portal-invite", c.id)
          : "";
      },
      clientPanels: (c) => (P() ? `<div class="grid-2 mt22 portal-panels">${contactsPanel(c)}${portalPanel(c)}</div>` : ""),
      settings() {
        const p = P();
        if (!p) return "";
        return `<section class="panel mt22"><div class="panel-head"><div><h2>Client portal and feedback</h2><p>Turn on the portal per client on the client's page. Clients sign in with a one-time email link, or with an access link you send them.</p></div>${p.mail ? tone("Email sign-in on", "green") : tone("Access links only", "orange")}</div><div class="setting-line"><div><h3>Portal sign-in address</h3><p><code>${E(p.origin)}/portal/signin</code>${p.mail ? "" : " · email sign-in needs email set up; use access links until then"}</p></div></div><form data-form="portal-settings"><label class="check-row"><input type="checkbox" name="feedback_emails" ${p.settings.feedback_emails ? "checked" : ""} ${p.mail ? "" : "disabled"}> After an invoice is fully paid, email the client once to ask for a rating.</label><p class="field-hint">Clients can always rate a paid invoice from their link or the portal. Requests go only for payments recorded after you turn this on, at most once per invoice.</p>${h.errorBlock()}<div class="form-actions"><button class="btn primary" type="submit" ${p.mail ? "" : "disabled"}>Save</button></div></form></section>`;
      },
      publicPanels: (d, token) => guest.publicPanels(d, token),
    },
  };
}
