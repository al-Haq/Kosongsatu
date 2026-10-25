// Client-facing parts of the portal module: the client portal pages under
// /portal/..., the signature pad for accepting quotations, and the feedback
// form. No owner data is available here.
import { errorTip } from "./error-tips.mjs";
const BASE = "/api/guest/portal";
const KIND = {
  invoice: "Invoice",
  quote: "Quotation",
  proforma: "Proforma invoice",
  sales_order: "Sales order",
  delivery_order: "Delivery order",
};
export const kindLabel = (k) => KIND[k] || "Document";
const INK = "#0F172A";
const SCRIPT_FONT = '"Segoe Script","Brush Script MT","Snell Roundhand","URW Chancery L",cursive';

export function portalGuest(h) {
  const { E, badge, icon, dateLabel, timeLabel } = h;
  const app = document.querySelector("#app");
  let csrf = null;
  // Who this page is signed in as, to retry only for the same person.
  let who = "";
  const identity = (s) => `${s?.client?.name || ""}|${s?.contact?.email || ""}`;
  let overview = null,
    docFilter = "All";
  const fmt = (cents, cur = "MYR") => {
    try {
      return new Intl.NumberFormat("en-MY", { style: "currency", currency: cur || "MYR" }).format((cents || 0) / 100);
    } catch {
      return h.money(cents);
    }
  };
  async function gapi(path, method = "GET", body, retried = false) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET" && csrf ? { "X-Portal-CSRF": csrf } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error("Server returned an unreadable response.");
    }
    if (!res.ok) {
      // The sign-in check is out of date (signed in again in another tab): take
      // the current one and try once more, if it is still the same person.
      if (res.status === 403 && csrf && who && !retried && /^Session verification failed/.test(data.error || "")) {
        const now = await fetch(BASE + "/session")
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        if (now?.csrf && identity(now) === who) {
          csrf = now.csrf;
          return gapi(path, method, body, true);
        }
      }
      throw Object.assign(new Error(data.error || "Request failed."), { status: res.status });
    }
    return data;
  }
  const linkToken = () => location.pathname.match(/^\/client\/([\w-]{43})$/)?.[1];

  // ---- Signature pad -------------------------------------------------------
  function setupPad(canvas) {
    const ctx = canvas.getContext("2d");
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = INK;
    let last = null;
    canvas.dataset.ink = "0";
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
    };
    const to = (p) => {
      ctx.beginPath();
      ctx.moveTo(last[0], last[1]);
      ctx.lineTo(p[0], p[1]);
      ctx.stroke();
      canvas.dataset.ink = String(Number(canvas.dataset.ink) + Math.hypot(p[0] - last[0], p[1] - last[1]));
      last = p;
    };
    canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      canvas.setPointerCapture?.(e.pointerId);
      last = pos(e);
      to([last[0] + 0.5, last[1] + 0.5]);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!last) return;
      e.preventDefault();
      for (const ev of e.getCoalescedEvents?.() || [e]) to(pos(ev));
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
      canvas.addEventListener(type, () => (last = null));
  }
  function drawTyped(canvas, value) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!value.trim()) return;
    let size = 64;
    ctx.font = `italic ${size}px ${SCRIPT_FONT}`;
    const width = ctx.measureText(value).width;
    if (width > canvas.width - 40) size = Math.max(18, Math.floor((size * (canvas.width - 40)) / width));
    ctx.font = `italic ${size}px ${SCRIPT_FONT}`;
    ctx.fillStyle = INK;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(value, canvas.width / 2, canvas.height / 2);
  }
  function signatureModal(form, id = "") {
    h.showModal(
      "Accept quotation",
      `<form data-form="${form}" data-id="${E(id)}" class="portal-sign">${h.input("Your full name", "name", "", "text", true, 'maxlength="120" autocomplete="name"')}<div class="tabs portal-sign-tabs" role="group" aria-label="Signature type"><button type="button" class="tab active" data-action="portal-sign-mode" data-id="draw" aria-pressed="true">Draw</button><button type="button" class="tab" data-action="portal-sign-mode" data-id="type" aria-pressed="false">Type</button></div><input type="hidden" name="method" value="draw"><div class="portal-sign-draw"><canvas class="portal-pad" width="600" height="200" role="img" aria-label="Signature pad. Draw your signature."></canvas><div class="portal-pad-foot"><span class="field-hint">Sign with your finger, a pen or the mouse.</span><button type="button" class="btn small ghost" data-action="portal-sign-clear">Clear</button></div></div><div class="portal-sign-type" hidden>${h.input("Type your full name as your signature", "typed", "", "text", false, 'maxlength="120" autocomplete="off"')}<canvas class="portal-pad portal-pad-typed" width="600" height="200" aria-hidden="true"></canvas></div><label class="check-row mt22"><input type="checkbox" name="agree" required> I agree to the scope, price and terms in this quotation, and I am authorised to accept it.</label><p class="field-hint">Your name, signature, the time, your browser and a fingerprint of your network address are kept with the acceptance and printed on the quotation.</p>${h.formEnd("Sign and accept")}</form>`,
    );
    const f = h.modal.querySelector("form.portal-sign");
    setupPad(f.querySelector(".portal-sign-draw canvas"));
    const typed = f.querySelector(".portal-pad-typed");
    f.elements.typed.addEventListener("input", (e) => drawTyped(typed, e.target.value));
  }
  function signatureMode(mode) {
    const f = h.modal.querySelector("form.portal-sign");
    if (!f) return;
    f.elements.method.value = mode;
    f.querySelector(".portal-sign-draw").hidden = mode !== "draw";
    f.querySelector(".portal-sign-type").hidden = mode !== "type";
    f.elements.typed.required = mode === "type";
    for (const b of f.querySelectorAll(".portal-sign-tabs .tab")) {
      b.classList.toggle("active", b.dataset.id === mode);
      b.setAttribute("aria-pressed", String(b.dataset.id === mode));
    }
    if (mode === "type" && !f.elements.typed.value) {
      f.elements.typed.value = f.elements.name.value;
      drawTyped(f.querySelector(".portal-pad-typed"), f.elements.typed.value);
    }
  }
  let shownRevision = "";
  function signaturePayload(form, b) {
    const method = b.method === "type" ? "type" : "draw";
    const canvas = form.querySelector(method === "draw" ? ".portal-sign-draw canvas" : ".portal-pad-typed");
    if (method === "draw" && Number(canvas.dataset.ink || 0) < 60) throw new Error("Draw your signature in the box.");
    if (method === "type") {
      if (!String(b.typed || "").trim()) throw new Error("Type your name as your signature.");
      drawTyped(canvas, b.typed);
    }
    // The version on screen: if the quotation was edited meanwhile, the server asks to reload.
    return { name: b.name, typed: b.typed || "", method, agree: b.agree === "on", signature: canvas.toDataURL("image/png"), revision: shownRevision };
  }

  // ---- Feedback --------------------------------------------------------------
  const stars = (prefix) =>
    `<div class="portal-stars" role="radiogroup" aria-label="Your rating">${[5, 4, 3, 2, 1]
      .map(
        (n) =>
          `<input type="radio" id="${prefix}-${n}" name="rating" value="${n}" required><label for="${prefix}-${n}" aria-label="${n} out of 5" title="${n} out of 5">★</label>`,
      )
      .join("")}</div>`;
  const feedbackForm = (mode, id) =>
    `<form data-form="portal-feedback" data-mode="${mode}" data-id="${E(id)}"><p>How was the work on this invoice? Your rating goes to the business only.</p>${stars("rate-" + mode)}<div class="portal-more">${h.area("Comment (optional)", "comment", "", 500)}<label class="check-row"><input type="checkbox" name="consent"> You may show my rating and comment as a testimonial.</label>${h.input("Name to show with a testimonial (optional)", "display_name", "", "text", false, 'maxlength="80"')}${h.errorBlock()}<div class="form-actions"><button class="btn primary" type="submit">Send feedback</button></div></div></form>`;
  const feedbackThanks = '<div class="notice info"><p>Thank you for your feedback.</p></div>';
  const feedbackPanel = (f, mode, id) =>
    !f
      ? ""
      : f.submitted
        ? `<section class="panel"><h2>Your feedback</h2>${feedbackThanks}</section>`
        : f.eligible
          ? `<section class="panel portal-feedback"><h2>Rate our work</h2>${feedbackForm(mode, id)}</section>`
          : "";
  async function sendFeedback(form, b) {
    const body = { rating: Number(b.rating), comment: b.comment || "", consent: b.consent === "on", display_name: b.display_name || "" };
    const mode = form.dataset.mode;
    const path =
      mode === "link"
        ? `/link/${linkToken()}/feedback`
        : mode === "email"
          ? `/feedback/${form.dataset.id}`
          : `/documents/${form.dataset.id}/feedback`;
    await gapi(path, "POST", body);
    form.outerHTML = feedbackThanks;
    h.toast("Thank you for your feedback.");
  }
  const signatureBlock = (s, src) =>
    s
      ? `<div class="portal-signature"><img src="${E(src)}" alt="Signature of ${E(s.signer_name)}"><p>Accepted by <strong>${E(s.signer_name)}</strong><br>${E(timeLabel(s.signed_at))} · ${s.method === "draw" ? "drawn" : "typed"} signature</p></div>`
      : "";

  // ---- Portal pages ----------------------------------------------------------
  const footer = (company) =>
    `<footer class="public-footer">Client portal · ${E(company || "")} · Keep your sign-in links private.<br>Questions? Reply to the email you received or contact us using the details on your documents.</footer>`;
  function shell(session, body, company) {
    return `<main class="public-wrap portal-wrap"><header class="public-header portal-header">${h.logo()}<div class="portal-who"><span class="badge blue">Client portal</span><strong>${E(session.client.name)}</strong>${session.contact ? `<small>${E(session.contact.email)}</small>` : ""}</div><button type="button" class="btn" data-action="portal-signout">${icon("logout")}Sign out</button></header>${body}${footer(company)}</main>`;
  }
  async function session() {
    try {
      const s = await gapi("/session");
      csrf = s.csrf;
      who = identity(s);
      return s;
    } catch (e) {
      if (e.status === 401) {
        history.replaceState(null, "", "/portal/signin");
        await renderSignin();
        return null;
      }
      throw e;
    }
  }
  function errorPage(title, message) {
    const tip = errorTip(message);
    app.innerHTML = `<main class="error-page">${h.logo()}<h1>${E(title)}</h1><p>${E(message)}</p>${tip ? `<p class="error-tip">${E(tip)}</p>` : ""}<a class="btn" href="/portal/signin">Go to portal sign-in</a></main>`;
  }
  async function renderSignin(note = "") {
    document.title = "Client portal sign-in";
    let cfg = { company: "", email_signin: false };
    try {
      cfg = await gapi("/config");
    } catch {}
    app.innerHTML = `<main class="portal-signin"><section class="panel">${h.logo()}<span class="eyebrow">CLIENT PORTAL</span><h1>Sign in to ${E(cfg.company || "the client portal")}</h1>${note ? `<div class="notice info"><p>${E(note)}</p></div>` : ""}${
      cfg.email_signin
        ? `<p>Enter the email address we have on file for you. We will email you a sign-in link that works once, for 15 minutes.</p><form data-form="portal-signin">${h.input("Email address", "email", "", "email", true, 'autocomplete="email" maxlength="160"')}${h.errorBlock()}<button class="btn primary full" type="submit">Email me a sign-in link ${icon("arrow")}</button></form>`
        : `<div class="notice"><p>Email sign-in is not available. Ask ${E(cfg.company || "us")} for your portal link${cfg.email ? ` at ${E(cfg.email)}` : ""}.</p></div>`
    }<p class="field-hint">No password needed. Only addresses given portal access can sign in.</p></section></main>`;
  }
  async function exchange(kind, token) {
    // Drop the token from the address bar and history before using it.
    history.replaceState(null, "", "/portal/home");
    try {
      csrf = (await gapi(kind === "login" ? "/verify" : "/access", "POST", { token })).csrf;
    } catch (e) {
      history.replaceState(null, "", "/portal/signin");
      return renderSignin(e.message);
    }
    return renderHome();
  }
  const docRow = (d) =>
    `<tr><td><a href="/portal/d/${E(d.id)}">${E(d.number)}</a><small>${E(kindLabel(d.kind))}</small></td><td>${dateLabel(d.issue_date)}</td><td>${dateLabel(d.due_date)}</td><td class="num">${fmt(d.total, d.currency)}</td><td class="num">${d.balance === null ? "—" : fmt(d.balance, d.currency)}</td><td>${badge(d.status)}</td><td><a class="btn small" href="${BASE}/documents/${E(d.id)}/pdf" aria-label="Download ${E(d.number)} PDF">${icon("download")}PDF</a></td></tr>`;
  const docFilters = ["All", "Invoices", "Quotations", "Other"];
  const filtered = (docs) =>
    docs.filter((d) =>
      docFilter === "All"
        ? true
        : docFilter === "Invoices"
          ? d.kind === "invoice"
          : docFilter === "Quotations"
            ? d.kind === "quote"
            : !["invoice", "quote"].includes(d.kind),
    );
  const docTable = (docs) =>
    docs.length
      ? `<div class="table-wrap"><table><caption class="sr-only">Your documents</caption><thead><tr><th>Document</th><th>Issued</th><th>Due / valid until</th><th class="num">Total</th><th class="num">Balance</th><th>Status</th><th><span class="sr-only">PDF</span></th></tr></thead><tbody>${docs.map(docRow).join("")}</tbody></table></div>`
      : h.empty("No documents here yet", "Issued invoices and quotations appear here.");
  function homeBody(s, o) {
    const t = o.totals;
    const cards = [
      ["Outstanding", fmt(t.outstanding), `${t.open_invoices} open invoice${t.open_invoices === 1 ? "" : "s"}`, "dark"],
      ["Overdue", fmt(t.overdue), t.overdue ? "Please arrange payment" : "Nothing overdue", t.overdue ? "alert" : ""],
      ...(t.credit_available ? [["Credit available", fmt(t.credit_available), "Unallocated payments", ""]] : []),
    ];
    return `<div class="public-top"><div><h1>Hello, ${E(s.contact?.name || o.client.name)}</h1><p>Your documents with ${E(o.business.company)}</p></div></div><div class="portal-cards">${cards
      .map(([l, v, n, c]) => `<section class="portal-card ${c}"><p>${E(l)}</p><div class="value">${E(v)}</div><small>${E(n)}</small></section>`)
      .join("")}</div><section class="panel mt22"><div class="panel-head"><h2>Documents</h2><div class="tabs portal-tabs" role="group" aria-label="Filter documents">${docFilters
      .map((f) => `<button type="button" class="tab ${f === docFilter ? "active" : ""}" data-action="portal-filter" data-id="${f}">${f}</button>`)
      .join("")}</div></div><div id="portal-docs">${docTable(filtered(o.documents))}</div></section><div class="grid-2 mt22"><section class="panel"><div class="panel-head"><h2>Receipts</h2></div>${
      o.receipts.length
        ? `<div class="table-wrap"><table><thead><tr><th>Receipt</th><th>Date</th><th class="num">Amount</th><th><span class="sr-only">PDF</span></th></tr></thead><tbody>${o.receipts
            .map(
              (r) =>
                `<tr><td>${E(r.number)}<small>${E(r.invoices.map((i) => i.number).join(", ") || r.method)}</small></td><td>${dateLabel(r.paid_date)}</td><td class="num">${fmt(r.amount, r.currency)}</td><td><a class="btn small" href="${BASE}/receipts/${E(r.id)}/pdf">${icon("download")}PDF</a></td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : "<p>No receipts yet.</p>"
    }</section><section class="panel"><div class="panel-head"><h2>Credit and debit notes</h2></div>${
      o.notes.length
        ? `<div class="table-wrap"><table><thead><tr><th>Note</th><th>Date</th><th class="num">Amount</th><th><span class="sr-only">PDF</span></th></tr></thead><tbody>${o.notes
            .map(
              (n) =>
                `<tr><td>${E(n.number)}<small>${n.kind === "credit" ? "Credit note" : "Debit note"} · ${E(n.invoice_number)}</small></td><td>${dateLabel(n.issue_date)}</td><td class="num">${n.kind === "credit" ? "−" : "+"}${fmt(n.amount)}</td><td><a class="btn small" href="${BASE}/notes/${E(n.id)}/pdf">${icon("download")}PDF</a></td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : "<p>No credit or debit notes.</p>"
    }</section></div><div class="grid-2 mt22"><section class="panel"><div class="panel-head"><h2>Statement of account</h2></div><form data-form="portal-statement"><div class="form-grid">${h.input("From", "from", h.addDays(today(), -90), "date", true)}${h.input("To", "to", today(), "date", true, `max="${today()}"`)}</div><p class="field-hint">Invoices, notes and payments in the period, with the balance and aging.</p>${h.errorBlock()}<div class="form-actions"><button class="btn primary" type="submit">${icon("download")}Download statement</button></div></form></section><section class="panel"><div class="panel-head"><h2>Contact us</h2></div><p><strong>${E(o.business.company)}</strong><br>${E([o.business.email, o.business.phone].filter(Boolean).join(" · "))}</p>${o.business.address ? `<p class="field-hint">${E(o.business.address)}</p>` : ""}</section></div>`;
  }
  const today = () =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  async function renderHome() {
    const s = await session();
    if (!s) return;
    overview = await gapi("/overview");
    document.title = `Client portal | ${overview.business.company}`;
    app.innerHTML = shell(s, homeBody(s, overview), overview.business.company);
  }
  function quotePanel(d, s) {
    const sig = d.ext?.portal?.signature;
    if (d.state === "accepted")
      return `<section class="panel"><h2>Your quotation</h2><div class="notice info mt22"><p>Accepted by ${E(d.accepted_name)}. We will follow up with the next step.</p></div>${signatureBlock(sig, `${BASE}/documents/${d.id}/signature`)}</section>`;
    if (d.status === "Expired")
      return `<section class="panel"><h2>Your quotation</h2><p class="mt22">This quotation has expired. Contact us for an updated quotation.</p></section>`;
    if (d.kind !== "quote") return "";
    return `<section class="panel"><h2>Your quotation</h2><p class="mt22">Review the scope and terms. Accept and sign when you are ready to proceed.</p><button class="btn primary full" data-action="portal-accept" data-id="${E(d.id)}">Accept and sign</button></section>`;
  }
  function invoicePanel(d) {
    if (d.kind !== "invoice") return "";
    if (d.balance <= 0)
      return `<section class="panel"><h2>Payment</h2><div class="notice info mt22"><p>${d.status === "Credited" ? "This invoice is fully credited. No payment is due." : "Thank you. No further payment is due."}</p></div></section>`;
    const b = d.business;
    return `<section class="panel"><h2>Payment</h2>${d.online_payment ? `<p class="mt22">Pay ${fmt(d.balance, d.currency)} now with online banking (FPX), card or DuitNow.</p><button class="btn primary full" data-action="portal-pay" data-id="${E(d.id)}">Pay online</button><h3 class="mt22">Or pay by bank transfer</h3>` : ""}<p class="mt22">${b.bankAccount ? `${E(b.bankName)}<br>${E(b.bankHolder)}<br><strong>${E(b.bankAccount)}</strong>` : "Bank details are not configured. Contact us before paying."}</p><p class="field-hint">Use ${E(d.number)} as the transfer reference.</p><button class="btn ${d.online_payment ? "" : "primary "}full" data-action="portal-reference" data-id="${E(d.id)}">Submit payment reference</button>${d.proofs.length ? `<div class="mt22">${d.proofs.map((p) => `<div class="payment"><strong>${E(p.reference)}</strong><p>${badge(p.status === "pending" ? "Pending review" : p.status === "confirmed" ? "Confirmed" : "Rejected")}</p></div>`).join("")}</div>` : ""}</section>`;
  }
  async function renderDoc(docId) {
    const s = await session();
    if (!s) return;
    const query = new URLSearchParams(location.search);
    let returned = null;
    if (query.has("billplz[id]")) {
      history.replaceState(null, "", location.pathname);
      try {
        returned = (
          await gapi(`/documents/${docId}/payment-return`, "POST", {
            params: Object.fromEntries([...query].filter(([k]) => k.startsWith("billplz["))),
          })
        ).state;
      } catch {
        returned = "error";
      }
    }
    let d;
    try {
      d = await gapi(`/documents/${docId}`);
    } catch (e) {
      app.innerHTML = shell(s, `<div class="panel mt22">${h.empty("Document not found", "It may have been withdrawn. Go back to your documents.")}<div class="actions"><a class="btn" href="/portal/home">All documents</a></div></div>`, "");
      return;
    }
    shownRevision = d.revision || "";
    document.title = `${d.number} | Client portal`;
    const body = `<p class="portal-back"><a href="/portal/home">← All documents</a></p><div class="public-top"><div><h1>${E(kindLabel(d.kind))} ${E(d.number)}</h1><p>${E(d.client.name)} / ${badge(d.status)}</p></div><div class="actions"><a class="btn" href="${BASE}/documents/${E(d.id)}/pdf">${icon("download")} Download PDF</a></div></div><div class="doc-grid">${h.paper(d, true)}<aside class="stack"><section class="balance-card"><p>${d.kind === "invoice" ? "Balance due" : "Total"}</p><div class="value">${fmt(d.kind === "invoice" ? d.balance : d.adjusted_total ?? d.total, d.currency)}</div><p>${d.kind === "quote" ? "Valid until" : d.kind === "invoice" ? "Due" : "Dated"} ${dateLabel(d.kind === "invoice" || d.kind === "quote" ? d.due_date : d.issue_date)}</p>${d.kind === "invoice" ? `<p>Total ${fmt(d.adjusted_total ?? d.total, d.currency)} / Paid ${fmt(d.paid, d.currency)}</p>` : ""}</section>${quotePanel(d, s)}${invoicePanel(d)}${feedbackPanel(d.ext?.portal?.feedback, "portal", d.id)}</aside></div>`;
    app.innerHTML = shell(s, body, d.business?.company);
    if (returned === "paid") h.toast("Payment received. Thank you.");
    else if (returned) h.toast("Payment was not completed. You can try again or pay by bank transfer.", returned === "error");
  }
  async function renderFeedbackLink(token) {
    history.replaceState(null, "", location.pathname);
    let info;
    try {
      info = await gapi(`/feedback/${token}`);
    } catch (e) {
      return errorPage("This feedback link is unavailable.", e.message);
    }
    document.title = `Feedback | ${info.company}`;
    app.innerHTML = `<main class="portal-signin"><section class="panel">${h.logo()}<span class="eyebrow">${E(info.company)}</span><h1>How did we do?</h1><p>Invoice ${E(info.number)} for ${E(info.client)} · ${fmt(info.total, info.currency)}</p>${info.feedback?.submitted ? feedbackThanks : info.feedback?.eligible ? feedbackForm("email", token) : '<div class="notice"><p>Feedback is not open for this invoice.</p></div>'}</section></main>`;
  }

  return {
    // Renders /portal/... pages. Returns true when the location is a portal page.
    async page(loc) {
      const m = loc.pathname.match(/^\/portal\/([\w-]+)(?:\/([\w-]+))?$/);
      if (!m) return false;
      const [, page, arg] = m;
      try {
        if (page === "signin") await renderSignin();
        else if ((page === "login" || page === "access") && arg) await exchange(page, arg);
        else if (page === "d" && arg) await renderDoc(arg);
        else if (page === "feedback" && arg) await renderFeedbackLink(arg);
        else {
          if (page !== "home") history.replaceState(null, "", "/portal/home");
          await renderHome();
        }
      } catch (e) {
        errorPage("The client portal is unavailable.", e.message);
      }
      return true;
    },
    // Client link page (/client/<token>): signature and feedback panels.
    publicPanels(d, token) {
      shownRevision = d.revision || "";
      const p = d.ext?.portal || {};
      let out = "";
      if (new URLSearchParams(location.search).has("signed")) {
        history.replaceState(null, "", location.pathname);
        setTimeout(() => h.toast("Quotation accepted. Thank you."), 0);
      }
      if (d.kind === "quote" && p.signature)
        out += `<section class="panel"><h2>Signature</h2>${signatureBlock(p.signature, `${BASE}/link/${token}/signature`)}</section>`;
      out += feedbackPanel(p.feedback, "link", d.id);
      return out;
    },
    async action(type, id) {
      switch (type) {
        case "public-accept":
          signatureModal("accept");
          return true;
        case "portal-accept":
          signatureModal("portal-accept", id);
          return true;
        case "portal-sign-mode":
          signatureMode(id);
          return true;
        case "portal-sign-clear": {
          const c = h.modal.querySelector(".portal-sign-draw canvas");
          c.getContext("2d").clearRect(0, 0, c.width, c.height);
          c.dataset.ink = "0";
          return true;
        }
        case "portal-signout":
          try {
            await gapi("/signout", "POST", {});
          } catch {}
          csrf = null;
          location.assign("/portal/signin");
          return true;
        case "portal-filter":
          docFilter = id;
          for (const b of document.querySelectorAll(".portal-tabs .tab")) b.classList.toggle("active", b.dataset.id === id);
          document.querySelector("#portal-docs").innerHTML = docTable(filtered(overview?.documents || []));
          return true;
        case "portal-pay": {
          const { url } = await gapi(`/documents/${id}/checkout`, "POST", {});
          if (/^https:\/\//.test(url)) location.href = url;
          return true;
        }
        case "portal-reference":
          h.showModal(
            "Submit payment reference",
            `<form data-form="portal-reference" data-id="${E(id)}"><p>We will check this reference against our bank account. The invoice stays unpaid until the payment is confirmed.</p><div class="mt22">${h.input("Bank transaction reference", "reference", "", "text", true, 'maxlength="120"')}${h.area("Message (optional)", "note", "", 500)}</div>${h.formEnd("Submit reference")}</form>`,
          );
          return true;
      }
      return false;
    },
    async submit(form, b) {
      const type = form.dataset.form;
      if (type === "accept" && linkToken()) {
        await gapi(`/link/${linkToken()}/accept`, "POST", signaturePayload(form, b));
        h.modal.close();
        location.replace(location.pathname + "?signed=1");
        return true;
      }
      if (type === "portal-accept") {
        await gapi(`/documents/${form.dataset.id}/accept`, "POST", signaturePayload(form, b));
        h.modal.close();
        await renderDoc(form.dataset.id);
        h.toast("Quotation accepted. Thank you.");
        return true;
      }
      if (type === "portal-feedback") {
        await sendFeedback(form, b);
        return true;
      }
      if (type === "portal-reference") {
        await gapi(`/documents/${form.dataset.id}/payment-reference`, "POST", { reference: b.reference, note: b.note || "" });
        h.modal.close();
        await renderDoc(form.dataset.id);
        h.toast("Reference submitted for review.");
        return true;
      }
      if (type === "portal-signin") {
        const r = await gapi("/signin", "POST", { email: b.email });
        form.outerHTML = `<div class="notice info"><p>${E(r.message)}</p></div><p class="field-hint">Didn't get it? Check your spam folder, or ask us to check that your email has portal access.</p>`;
        return true;
      }
      if (type === "portal-statement") {
        location.href = `${BASE}/statement.pdf?${new URLSearchParams({ from: b.from, to: b.to })}`;
        return true;
      }
      return false;
    },
  };
}
