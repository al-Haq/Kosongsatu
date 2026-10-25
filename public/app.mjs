import { automationUI } from "./automation.mjs";
import { dmy, isoDate, tidyDmy } from "./dates.mjs";
import { financeUI } from "./finance.mjs";
import { detailsHtml, detailsPlain, htmlToDetails, DETAILS_MAX } from "./ext/line-details.mjs";
import { lineChoices, matchChoices } from "./ext/line-suggest.mjs";
import { auditChanges } from "./ext/doc-changes.mjs";
import { errorTip, errorHtml } from "./ext/error-tips.mjs";
import { documentId } from "./ext/privacy.mjs";
import { createAutosave } from "./autosave.mjs";
import { UI_PLUGINS } from "./plugins.mjs";
import { totals, toMYR, basisPoints, percentOf } from "./ext/documents-calc.mjs";
import { labels, titleFor, statusLabel, formatDate } from "./ext/documents-i18n.mjs";
import { navModule, overviewModule, hiddenSettings, moduleOff, ownCompany } from "./ext/setup-modules.mjs";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const app = $("#app"),
  modal = $("#modal");
let advanced, workflow;
// Feature modules loaded from public/ext (see docs/PLUGINS.md).
let plugins = [];
// Overview panels of modules turned off in Settings > Modules are left out.
const slot = (name, ...args) =>
  plugins
    .filter((p) => name !== "overview" || !moduleOff(S?.settings, overviewModule(p.name)))
    .map((p) => p.slots?.[name]?.(...args) || "")
    .join("");
// Modules may hide navigation, pages and actions (e.g. by user role) with
// can(kind, name) returning false. The server still enforces every permission.
const allowed = (kind, name) =>
  plugins.every((p) => p.can?.(kind, name) !== false);
// Keeps unsaved form input on this device (see autosave.mjs); set up before boot.
let autosave = null;
let S = null,
  publicDoc = null,
  session = null,
  filter = "All",
  search = "",
  page = 0,
  toastTimer,
  generatedLink = "",
  // The copy a delete just kept in Recently deleted; the next toast offers "Undo".
  undoBin = null;
const E = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (c, currency = "MYR") =>
  new Intl.NumberFormat("en-MY", { style: "currency", currency: currency || "MYR" }).format(
    (c || 0) / 100,
  );
// MYR value of a document or receipt amount at its own exchange rate.
const myr = (amount, x) => toMYR(amount || 0, x?.fx_rate || "1");
const dec = (c) => (c / 100).toFixed(2);
const dateLabel = (s) =>
  s
    ? new Intl.DateTimeFormat("en-MY", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(s + "T00:00:00Z"))
    : "-";
const timeLabel = (s) =>
  new Intl.DateTimeFormat("en-MY", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(new Date(s));
const addDays = (s, n) => {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const icons = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
  users:
    '<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M23 21v-2a4 4 0 0 0-3-3.87"/><circle cx="10" cy="7" r="4"/><path d="M16 3a4 4 0 0 1 0 8"/>',
  box: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 10h18M9 4v6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  wallet:
    '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18M15 15h3"/>',
  settings:
    '<path d="M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2M6 18l2-2M16 8l2-2"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  shield:
    '<path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z"/><path d="m8 12 3 3 5-6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  logout: '<path d="M9 4H4v16h5m5-13 5 5-5 5M8 12h11"/>',
  trend: '<path d="m3 17 6-6 4 4 8-10M15 5h6v6"/>',
};
const icon = (n) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[n] || icons.doc}</svg>`;
const logo = () =>
  '<img class="logo" src="/assets/nawlogic-logo.png" alt="Nawlogic">';
// The business's own name and logo once set (Settings > Company and Documents),
// the Nawlogic brand until then. Signed out, it comes from /api/guest/setup/branding.
let guestBrand = null;
const brandFrom = (s) => ({
  company: ownCompany(s),
  logo: s.logoFileId ? `/api/guest/setup/logo?v=${String(s.logoFileId).slice(0, 8)}` : "",
});
const brand = () =>
  S
    ? { company: ownCompany(S.settings), logo: S.settings.logoFileId ? `/api/files/${S.settings.logoFileId}` : "" }
    : guestBrand || { company: "", logo: "" };
const brandMark = (b = brand()) =>
  b.logo
    ? `<img class="logo brand-logo" src="${E(b.logo)}" alt="${E(b.company || "Business logo")}">`
    : b.company
      ? `<span class="brand-name">${E(b.company)}</span>`
      : logo();
async function loadBrand() {
  try {
    const response = await fetch("/api/guest/setup/branding");
    if (response.ok) guestBrand = await response.json();
  } catch {
    // The Nawlogic brand is shown instead.
  }
}
const badge = (s, label = s) =>
  `<span class="badge ${{ Paid: "green", Accepted: "green", Active: "green", "Part-paid": "orange", "Pending review": "orange", Overdue: "red", Void: "red", Declined: "red", Viewed: "blue", Issued: "blue", Expired: "orange", Archived: "orange", Sent: "green", Failed: "red", Sending: "blue", Connected: "green", Opened: "green", Delivered: "green", Read: "green", Bounced: "red", "Spam complaint": "red", "Soft bounce": "orange", "Partly sent": "orange", Pending: "orange", Edited: "blue", Received: "blue", Converted: "green", Invoiced: "green", Delivered: "green", Completed: "green" }[s] || ""}"><span class="dot"></span>${E(label)}</span>`;
const button = (label, action, id = "", primary = false, iconName = "") =>
  !allowed("action", action)
    ? ""
    : `<button type="button" class="btn ${primary ? "primary" : ""}" data-action="${action}" data-id="${E(id)}">${iconName ? icon(iconName) : ""}${E(label)}</button>`;
const empty = (title, body = "", cta = "") =>
  `<div class="empty">${icon("doc")}<h2>${E(title)}</h2><p>${E(body)}</p>${cta}</div>`;
// message is text or an Error. An error also says what to try next (error-tips.mjs).
function toast(message, error = false) {
  const t = $("#toast");
  const undo = !error && undoBin && Date.now() - undoBin.at < 15000 ? undoBin.id : "";
  undoBin = null;
  const text = message?.message ?? String(message ?? "");
  const tip = error ? (message?.tip ?? errorTip(text, message?.status)) : "";
  t.innerHTML = `<span>${E(text)}${tip ? `<span class="error-tip">${E(tip)}</span>` : ""}</span>${undo ? `<button type="button" class="toast-undo" data-action="bin-undo" data-id="${E(undo)}">Undo</button>` : ""}`;
  t.className = "show" + (error ? " error" : "") + (undo ? " with-action" : "");
  clearTimeout(toastTimer);
  // Longer when there is a tip to read.
  toastTimer = setTimeout(() => (t.className = ""), undo ? 10000 : tip ? 12000 : 5500);
}
// A failed request: the server's message, its HTTP status and a tip.
const failure = (message, status = 0) => Object.assign(new Error(message), { status, tip: errorTip(message, status) });
async function api(path, method = "GET", body, retried = false) {
  const retryable =
    method === "POST" &&
    /^\/(documents|receipts|bank|clients|services|schedules|sales)/.test(path);
  const requestId = method + ":" + path + ":" + JSON.stringify(body);
  // Kept on this device until the server answers (see autosave.mjs).
  const requestKey = retryable ? autosave?.requestKey(requestId) || crypto.randomUUID() : null;
  let response;
  try {
    response = await fetch("/api" + path, {
      method,
      headers: {
        ...(requestKey ? { "Idempotency-Key": requestKey } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET" && session ? { "X-CSRF-Token": session.csrf } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // No answer: nothing is lost. The form keeps its input (and a draft on this
    // device), and saving again reuses the same idempotency key, so it is not doubled.
    throw new Error("No connection. What you typed is kept on this device. Save again when you are back online.");
  }
  if (requestKey && (response.ok || response.status < 500)) autosave?.answered(requestId);
  const bin = response.ok && response.headers.get("X-Bin-Entry");
  if (bin) undoBin = { id: bin, at: Date.now() };
  let data;
  try {
    data = await response.json();
  } catch {
    throw failure("Server returned an unreadable response.", response.status);
  }
  if (!response.ok) {
    // The page's sign-in check is out of date (signed in again in another tab,
    // a server update): take the current one and try once more, but only for
    // the same account. The server refused before doing anything.
    if (response.status === 403 && session && !retried && /^Session verification failed/.test(data.error || "")) {
      const now = await fetch("/api/session")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (now?.csrf && now.email === session.email) {
        session = { ...session, csrf: now.csrf };
        return api(path, method, body, true);
      }
      if (now?.email) throw failure(`You are now signed in as ${now.email} in another tab.`, 409);
    }
    if (response.status === 401 && session) {
      session = null;
      S = null;
      modal.close();
      renderLogin();
    }
    throw failure(data.error || "Request failed.", response.status);
  }
  return data;
}
async function refresh() {
  S = await api("/workspace");
  // Kept for the sign-in page after signing out.
  guestBrand = brandFrom(S.settings);
}
function showModal(title, body, wide = false) {
  autosave?.flush();
  modal.className = wide ? "wide" : "";
  modal.innerHTML = `<div class="modal-head"><h2>${E(title)}</h2><button type="button" class="btn ghost" data-action="close-modal" aria-label="Close dialog">${icon("close")}</button></div><div class="modal-body">${body}</div>`;
  modal.showModal();
  modal.querySelector("input:not([readonly]),select,textarea")?.focus();
}
const input = (
  label,
  name,
  value = "",
  type = "text",
  required = false,
  extra = "",
) =>
  type === "date"
    ? dateInput(label, name, value, required, extra)
    : `<label>${E(label)}<input name="${name}" type="${type}" value="${E(value)}" ${required ? "required" : ""} ${extra}></label>`;
// Dates are typed as dd/mm/yyyy; the calendar button opens the browser's own
// picker. Read them with dateValue() or formValues(), which return ISO dates.
function dateInput(label, name, value, required, extra) {
  const bounds = (extra.match(/\b(?:min|max)="[^"]*"/g) || []).join(" ");
  return `<label>${E(label)}<span class="date-field"><input name="${name}" type="text" inputmode="numeric" autocomplete="off" placeholder="dd/mm/yyyy" title="dd/mm/yyyy" pattern="\\d{2}/\\d{2}/\\d{4}|\\d{4}-\\d{2}-\\d{2}" value="${E(dmy(value))}" data-date ${required ? "required" : ""} ${extra}><input type="date" class="date-picker" tabindex="-1" aria-hidden="true" ${bounds}><button type="button" class="date-pick" aria-label="Choose a date" title="Choose a date">${icon("calendar")}</button></span></label>`;
}
const dateValue = (el) => isoDate(el.value);
const setDateValue = (el, iso) => {
  el.value = dmy(iso);
};
// A form's fields as an object; dd/mm/yyyy date fields come back as ISO dates.
function formValues(form) {
  const b = Object.fromEntries(new FormData(form));
  for (const el of form.querySelectorAll("input[data-date]")) if (el.name in b) b[el.name] = isoDate(b[el.name]);
  return b;
}
const area = (label, name, value = "", max = 1000) =>
  `<label>${E(label)}<textarea name="${name}" maxlength="${max}">${E(value)}</textarea></label>`;
const select = (label, name, options, selected = "", required = true) =>
  `<label>${E(label)}<select name="${name}" ${required ? "required" : ""}>${options.map(([v, t]) => `<option value="${E(v)}" ${String(v) === String(selected) ? "selected" : ""}>${E(t)}</option>`).join("")}</select></label>`;
const errorBlock = () => '<div class="form-error" role="alert"></div>';
const formEnd = (label = "Save") =>
  `${errorBlock()}<div class="form-actions">${button("Cancel", "close-modal")}<button class="btn primary" type="submit">${E(label)}</button></div>`;
// Archived clients stay selectable only on records that already use them.
const clientOptions = (selected = "") => [
  ["", "Select a client"],
  ...S.clients
    .filter((c) => !c.archived || c.id === selected)
    .map((c) => [c.id, c.name]),
];
const confirmModal = (title, message, action, id, label) =>
  showModal(
    title,
    `<p>${E(message)}</p><div class="form-error" role="alert"></div><div class="form-actions">${button("Cancel", "close-modal")}${button(label, action, id, true)}</div>`,
  );
function renderLogin() {
  autosave?.flush();
  const { company } = brand();
  document.title = company ? `Sign in · ${company}` : "Nawlogic Invoice";
  app.innerHTML = `<div class="login-screen"><section class="login-brand"><span class="eyebrow">${company ? E(company) : "NAWLOGIC"} / BILLING WORKSPACE</span><h1>Good work deserves<br><span class="accent">a clear invoice.</span></h1><p>From the first quotation to the final receipt. A quieter way to keep your business moving.</p><div class="login-points"><span>${icon("doc")}Create with confidence</span><span>${icon("wallet")}Track every payment</span><span>${icon("shield")}Your private workspace</span></div></section><section class="login-form"><div class="login-inner">${brandMark()}<h2>Welcome back.</h2><p>${company ? `Sign in to the ${E(company)} workspace.` : "Sign in to your Nawlogic workspace."}</p><form data-form="login">${input("Email address", "email", "", "email", true, 'autocomplete="username" maxlength="160"')}${input("Password", "password", "", "password", true, 'autocomplete="current-password" maxlength="256"')}<div class="mfa-step" hidden><p class="field-hint">This account uses two-step sign-in. Enter the code from your authenticator app, or a recovery code.</p>${input("Authenticator or recovery code", "code", "", "text", false, 'autocomplete="one-time-code" maxlength="40"')}</div>${errorBlock()}<button class="btn primary" type="submit">Sign in ${icon("arrow")}</button></form>${slot("login")}<div class="login-footer">${icon("shield")} Team access only. Customer invoices use a separate private link.</div></div></section></div>`;
}
const NAV_GROUPS = ["Sell", "Get paid", "Records", "Books", "Operations", "Workspace"];
const navItems = [
  ["overview", "Overview", "grid", "Sell"],
  ["sales", "Sales", "trend", "Sell"],
  ["quotes", "Quotations", "doc", "Sell"],
  ["invoices", "Invoices", "doc", "Sell"],
  ["proformas", "Proforma", "doc", "Sell"],
  ["sales-orders", "Sales orders", "box", "Sell"],
  ["delivery-orders", "Delivery orders", "box", "Sell"],
  ["payments", "Payments", "wallet", "Get paid"],
  ["ledger", "Credits", "wallet", "Get paid"],
  ["bank", "Bank matching", "trend", "Get paid"],
  ["clients", "Clients", "users", "Records"],
  ["services", "Services", "box", "Records"],
  ["automation", "Automation", "shield", "Workspace"],
  ["settings", "Settings", "settings", "Workspace"],
];
// Modules add entries as { key, label, icon, group, hidden?(), module? }. Entries
// of a module turned off in Settings > Modules are left out (public/ext/setup-modules.mjs).
function allNav() {
  const extra = plugins.flatMap((p) => p.nav || []).filter((n) => !n.hidden?.());
  const list = [...navItems.map(([key, label, ic, group]) => ({ key, label, icon: ic, group })), ...extra].filter(
    (n) => allowed("nav", n.key) && !moduleOff(S?.settings, n.module || navModule(n.key)),
  );
  const groups = [...NAV_GROUPS, ...new Set(extra.map((n) => n.group).filter((g) => !NAV_GROUPS.includes(g)))];
  return groups
    .map((g) => [g, list.filter((n) => (n.group || "Workspace") === g)])
    .filter(([, items]) => items.length);
}
// Initials for the avatar, from the sign-in email: w.amirul -> WA, cloud -> CL.
const initials = (email = "") => {
  const local = email.split("@")[0] || "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : local.slice(0, 2)).toUpperCase() || "?";
};
function renderShell(html, active) {
  const items = allNav().flatMap(([, list]) => list);
  const own = brand().company;
  const label = items.find((n) => n.key === active)?.label;
  const title = label || own || "Nawlogic";
  document.title = (label ? label + " · " : "") + (own || "Nawlogic Invoice");
  const accountLink = items.some((n) => n.key === "account")
    ? '<a href="#/account">My account</a>'
    : items.some((n) => n.key === "settings")
      ? // The logo is used on every PDF, email, the menu and the sign-in page.
        '<a href="#/settings">Settings</a><a href="#/settings" data-account="logo">Change logo</a>'
      : "";
  app.innerHTML = `<div class="shell"><aside class="sidebar">${brandMark()}<nav aria-label="Main navigation">${allNav()
    .map(
      ([group, items]) =>
        `<span class="nav-group">${E(group)}</span>${items.map((n) => `<a href="#/${n.key}" class="${n.key === active ? "active" : ""}" ${n.key === active ? 'aria-current="page"' : ""}>${icon(n.icon)}${E(n.label)}</a>`).join("")}`,
    )
    .join("")}</nav><div class="owner-box"><strong>${E(own || "Nawlogic")}</strong><small>${E(session.email)}</small></div></aside><div class="workspace"><header class="topbar"><div class="top-left"><button class="btn ghost mobile-toggle" data-action="toggle-nav" aria-label="Toggle navigation">${icon("menu")}</button><span class="top-title">${E(title)}</span></div><div class="right">${slot("topbar")}${S.settings.demo ? '<span class="badge orange">DEMO DATA</span>' : ""}<details class="dropdown avatar-menu"><summary class="avatar" aria-label="Account menu">${E(initials(session.email))}</summary><div class="menu"><small>${E(session.email)}</small>${accountLink}<button type="button" data-action="logout">Sign out</button></div></details></div></header><main class="content">${S.settings.demo ? '<div class="notice"><p>Demo workspace. All clients, documents and payments are examples.</p></div>' : ""}${html}</main></div></div>`;
}
const heading = (title, sub, actions = "") =>
  `<div class="heading"><div><h1>${E(title)}</h1>${sub ? `<p>${E(sub)}</p>` : ""}</div><div class="actions">${actions}</div></div>`;
const PAGE_SIZE = 50;
// Long lists show 50 rows at a time; search and filters still cover every record.
function paged(list) {
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  const rows = list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const nav =
    pages > 1
      ? `<nav class="pager" aria-label="Pages"><button class="btn" type="button" data-action="page" data-id="${page - 1}" ${page ? "" : "disabled"}>Previous</button><span>${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + rows.length} of ${list.length}</span><button class="btn" type="button" data-action="page" data-id="${page + 1}" ${page < pages - 1 ? "" : "disabled"}>Next</button></nav>`
      : "";
  return { rows, nav };
}
function documentTable(docs) {
  const { rows, nav } = paged(docs);
  return invoiceTable(rows) + nav;
}
function invoiceTable(docs) {
  if (!docs.length)
    return empty(
      "No matching documents",
      "Create your first invoice or change the filters.",
    );
  return `<div class="table-wrap"><table class="table-cards"><caption class="sr-only">Billing documents</caption><thead><tr><th>Document</th><th>Client</th><th>Due / valid until</th><th class="num">Total</th><th class="num">Balance</th><th class="status">Status</th></tr></thead><tbody>${docs.map((d) => `<tr class="row-link" data-action="open-document" data-id="${d.id}"><td class="card-title"><button class="link-button" data-action="open-document" data-id="${d.id}">${E(d.number || "Draft")} ${!d.number ? "<small>" + d.id.slice(0, 8) + "</small>" : ""}</button>${d.kind !== "invoice" ? `<small>${E(kindLabel(d.kind))}</small>` : ""}</td><td data-label="Client">${E(d.client.name)}</td><td data-label="Due">${dateLabel(d.due_date)}</td><td class="num" data-label="Total">${d.kind === "delivery_order" ? "—" : money(d.adjusted_total ?? d.total, d.currency)}</td><td class="num" data-label="Balance">${d.kind !== "invoice" || d.state === "void" ? "—" : money(d.balance, d.currency)}</td><td class="status" data-label="Status">${badge(d.status)}</td></tr>`).join("")}</tbody></table></div>`;
}
// ---- Overview charts: SVG drawn from attributes only (the CSP allows no inline styles) ----
const sumBetween = (list, from, to) => list.reduce((t, x) => (x.date >= from && x.date <= to ? t + x.amount : t), 0);
// The same day one month earlier (31 Mar -> 28 Feb), for month-to-date comparisons.
const monthEarlier = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 2, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.toISOString().slice(0, 8)}${String(Math.min(d, last)).padStart(2, "0")}`;
};
// Twelve weeks ending today, oldest first; "back" moves the window further back.
const weekly = (list, back = 0) =>
  Array.from({ length: 12 }, (_, i) => {
    const end = addDays(S.today, -(11 - i) * 7 - back),
      start = addDays(end, -6);
    return { start, end, value: sumBetween(list, start, end) };
  });
function deltaLine(cur, prev, note) {
  if (!prev) return "";
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  const dir = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  return `<span class="delta ${dir}">${{ up: "↑", down: "↓", flat: "→" }[dir]} ${Math.abs(pct)}%</span> <span class="delta-note">${E(note)}</span>`;
}
function scaleY(values, height, pad = 2) {
  const max = Math.max(0, ...values),
    min = Math.min(0, ...values);
  const span = max - min || 1;
  return (v) => (pad + (height - 2 * pad) * (1 - (v - min) / span)).toFixed(1);
}
function sparkline(values) {
  const y = scaleY(values, 32),
    step = 120 / (values.length - 1 || 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${y(v)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 120 32" preserveAspectRatio="none" aria-hidden="true"><polygon class="spark-area" points="0,32 ${pts} 120,32"/><polyline class="spark-line" points="${pts}" vector-effect="non-scaling-stroke"/></svg>`;
}
function trendChart(current, previous) {
  const W = 600,
    H = 190,
    step = W / (current.length - 1);
  const y = scaleY([...current, ...previous].map((w) => w.value), H, 8);
  const line = (ws) => ws.map((w, i) => `${(i * step).toFixed(1)},${y(w.value)}`).join(" ");
  const grid = [0.25, 0.5, 0.75].map((f) => `<line class="grid" x1="0" x2="${W}" y1="${(H * f).toFixed(1)}" y2="${(H * f).toFixed(1)}" vector-effect="non-scaling-stroke"/>`).join("");
  const hits = current
    .map((w, i) => {
      const x = Math.max(0, i * step - step / 2);
      return `<rect class="hit" x="${x.toFixed(1)}" y="0" width="${(i === 0 || i === current.length - 1 ? step / 2 : step).toFixed(1)}" height="${H}"><title>${E(`${dateLabel(w.start).slice(0, 6)} – ${dateLabel(w.end).slice(0, 6)}: ${money(w.value)} (12 weeks before: ${money(previous[i].value)})`)}</title></rect>`;
    })
    .join("");
  return `<svg class="trend" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${E(`Collections per week for the last 12 weeks, ${money(current.reduce((t, w) => t + w.value, 0))} in total`)}">${grid}<polygon class="trend-area" points="0,${H} ${line(current)} ${W},${H}"/><polyline class="trend-prev" points="${line(previous)}" vector-effect="non-scaling-stroke"/><polyline class="trend-line" points="${line(current)}" vector-effect="non-scaling-stroke"/>${hits}</svg>`;
}
const AGING = ["Current", "1–30 days", "31–60 days", "61–90 days", "Over 90 days"];
// When an invoice is due now: its next instalment if it has a plan, as its status uses.
const dueOf = (d) => d.next_due_date || d.due_date;
const lateDays = (d) => Math.round((Date.parse(S.today + "T00:00:00Z") - Date.parse(dueOf(d) + "T00:00:00Z")) / 86400000);
function agingBuckets(open) {
  const b = AGING.map((label) => ({ label, amount: 0, count: 0 }));
  for (const d of open) {
    const late = lateDays(d);
    const i = late <= 0 ? 0 : late <= 30 ? 1 : late <= 60 ? 2 : late <= 90 ? 3 : 4;
    b[i].amount += myr(d.balance, d);
    b[i].count++;
  }
  return b;
}
function agingBar(buckets, cls = "aging-bar") {
  const total = buckets.reduce((t, x) => t + x.amount, 0) || 1;
  let x = 0;
  const rects = buckets
    .map((b, i) => {
      const w = (b.amount / total) * 100;
      const r = w > 0 ? `<rect class="age-${i}" x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="10"/>` : "";
      x += w;
      return r;
    })
    .join("");
  return `<svg class="${cls}" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">${rects || '<rect class="age-empty" x="0" y="0" width="100" height="10"/>'}</svg>`;
}
function overview() {
  const invoices = S.documents.filter(
      (d) => d.kind === "invoice" && d.state === "issued",
    ),
    month = S.today.slice(0, 7),
    outstanding = invoices.filter((d) => d.balance > 0),
    overdue = invoices.filter((d) => d.status === "Overdue"),
    payments = S.finance.receipts.flatMap((r) =>
      r.voided
        ? []
        : [
            { date: r.paid_date, amount: myr(r.amount, r) },
            ...r.refunds.map((f) => ({ date: f.paid_date, amount: -myr(f.amount, r) })),
          ],
    ),
    // Invoices by issue date and notes by note date, as "Invoiced this month".
    billed = [
      ...invoices.map((d) => ({ date: d.issue_date, amount: myr(d.total, d) })),
      ...S.finance.adjustments.map((a) => {
        const value = myr(a.amount, S.documents.find((d) => d.id === a.invoice_id));
        return { date: a.issue_date, amount: a.kind === "credit" ? -value : value };
      }),
    ];
  const from = month + "-01",
    prevTo = monthEarlier(S.today),
    prevFrom = prevTo.slice(0, 8) + "01";
  const sums = [
    sumBetween(billed, from, S.today),
    sumBetween(payments, from, S.today),
    outstanding.reduce((s, d) => s + myr(d.balance, d), 0),
    overdue.reduce((s, d) => s + myr(d.balance, d), 0),
  ];
  const prev = [sumBetween(billed, prevFrom, prevTo), sumBetween(payments, prevFrom, prevTo)];
  const buckets = agingBuckets(outstanding);
  const oldest = Math.max(0, ...overdue.map(lateDays));
  const collected = weekly(payments),
    before = weekly(payments, 84);
  const total12 = collected.reduce((t, w) => t + w.value, 0),
    totalBefore = before.reduce((t, w) => t + w.value, 0);
  const cards = [
    { label: "Invoiced this month", icon: "doc", value: sums[0], foot: deltaLine(sums[0], prev[0], "vs same days last month") || "Invoices and notes", chart: sparkline(weekly(billed).map((w) => w.value)) },
    { label: "Collected this month", icon: "wallet", value: sums[1], foot: deltaLine(sums[1], prev[1], "vs same days last month") || "Receipts minus refunds", chart: sparkline(collected.map((w) => w.value)), cls: "teal" },
    { label: "Outstanding", icon: "clock", value: sums[2], foot: `${outstanding.length} unpaid invoice${outstanding.length === 1 ? "" : "s"}`, chart: agingBar(buckets, "mini-aging") },
    { label: "Overdue", icon: "trend", value: sums[3], foot: overdue.length ? `${overdue.length} overdue, oldest ${oldest} day${oldest === 1 ? "" : "s"} late` : "Nothing overdue", cls: "red-text" },
  ];
  const agingTotal = buckets.reduce((t, b) => t + b.amount, 0);
  // The setup checklist (public/ext/setup.mjs) covers the company and bank details while it shows.
  const top = slot("overviewTop");
  // Company figures (the money tiles, the collections chart, aging) are for the
  // owner and the accountant; staff get the work list.
  const figures = allowed("view", "money");
  return (
    heading(
      "Overview",
      "",
      button("New invoice", "new-invoice", "", true, "plus"),
    ) +
    (top ||
      (!S.settings.bankAccount
        ? `<div class="notice info">${icon("settings")}<p>Add your company details and payment instructions before sharing a real invoice.</p><a href="#/settings">Open settings →</a></div>`
        : "")) +
    `${figures ? `<div class="metrics">${cards.map((c) => `<div class="metric"><span class="metric-icon">${icon(c.icon)}</span><div class="label">${c.label}</div><div class="value ${c.cls || ""}">${money(c.value)}</div><div class="hint">${c.foot}</div>${c.chart || ""}</div>`).join("")}</div>` : ""}${figures ? `<div class="grid-2"><section class="panel"><div class="panel-head"><div><h2>Collections</h2><p>Last 12 weeks · MYR</p></div><div class="legend"><span class="key now">Last 12 weeks</span><span class="key before">12 weeks before</span></div></div><div class="trend-total"><strong>${money(total12)}</strong>${deltaLine(total12, totalBefore, "vs the 12 weeks before")}</div>${trendChart(collected, before)}<div class="trend-axis"><span>${dateLabel(collected[0].start).slice(0, 6)}</span><span>${dateLabel(collected[6].start).slice(0, 6)}</span><span>Today</span></div></section>` : ""}<section class="panel"><div class="panel-head"><div><h2>Needs attention</h2><p>Oldest due first</p></div><a href="#/invoices">View all →</a></div>${
      [...outstanding]
        .sort((a, b) => dueOf(a).localeCompare(dueOf(b)))
        .slice(0, 4)
        .map((d) => {
          const late = lateDays(d);
          return `<button type="button" class="attention" data-action="open-document" data-id="${d.id}"><span><strong>${E(d.number)}</strong><small>${E(d.client.name)}</small></span><span class="attention-right">${late > 0 ? `<span class="late-chip">${late} day${late === 1 ? "" : "s"} late</span>` : ""}<strong>${money(d.balance, d.currency)}</strong>${badge(d.status)}</span></button>`;
        })
        .join("") || empty("All caught up", "No outstanding issued invoices.")
    }</section>${figures ? `</div><section class="panel mt22 aging-panel"><div class="panel-head"><div><h2>Aging</h2><p>Open invoices by days past due · MYR</p></div><strong class="aging-total">${money(agingTotal)}</strong></div>${agingTotal ? `${agingBar(buckets)}<div class="aging-tiles">${buckets.map((b, i) => `<div class="aging-tile"><span class="age-key"><span class="age-dot age-${i}"></span>${b.label}</span><strong>${money(b.amount)}</strong><small>${b.count} invoice${b.count === 1 ? "" : "s"} · ${Math.round((b.amount / agingTotal) * 100)}%</small></div>`).join("")}</div>` : "<p>No money is owed to you right now.</p>"}</section>${slot("overview")}<section class="panel mt22"><div class="panel-head"><h2>Recent documents</h2><a href="#/invoices">View invoices →</a></div>${invoiceTable(S.documents.slice(0, 5))}</section>` : ""}`
  );
}
// Screens per document kind. Only invoices carry money owed.
const KIND_UI = {
  invoice: {
    list: "invoices",
    title: "Invoices",
    one: "invoice",
    sub: "",
    action: "new-invoice",
    tabs: ["All", "Unpaid", "Overdue", "Paid", "Draft"],
  },
  quote: {
    list: "quotes",
    title: "Quotations",
    one: "quotation",
    sub: "",
    action: "new-quote",
    tabs: ["All", "Draft", "Issued", "Accepted", "Expired"],
  },
  proforma: {
    list: "proformas",
    title: "Proforma invoices",
    one: "proforma invoice",
    sub: "",
    action: "new-proforma",
    tabs: ["All", "Draft", "Issued", "Converted"],
  },
  sales_order: {
    list: "sales-orders",
    title: "Sales orders",
    one: "sales order",
    sub: "",
    action: "new-sales-order",
    tabs: ["All", "Draft", "Issued", "Invoiced", "Delivered", "Completed"],
  },
  delivery_order: {
    list: "delivery-orders",
    title: "Delivery orders",
    one: "delivery order",
    sub: "",
    action: "new-delivery-order",
    tabs: ["All", "Draft", "Issued"],
  },
};
const kindUI = (kind) => KIND_UI[kind] || KIND_UI.invoice;
const kindLabel = (kind) => {
  const one = kindUI(kind).one;
  return one[0].toUpperCase() + one.slice(1);
};
function documentList(kind) {
  const k = kindUI(kind);
  const data = S.documents.filter((d) => d.kind === kind);
  const currencies = [...new Set(data.map((d) => d.currency || "MYR"))];
  return (
    heading(k.title, k.sub, button("New " + k.one, k.action, "", true, "plus")) +
    `<div class="list-toolbar"><div class="tabs" role="group" aria-label="Filter by status">${k.tabs.map((t) => `<button class="tab ${t === filter ? "active" : ""}" data-action="filter" data-id="${t}">${t} <span>${t === "All" ? data.length : data.filter((d) => matches(d, t)).length}</span></button>`).join("")}</div><div class="toolbar-right"><label class="search"><span class="sr-only">Search documents</span>${icon("search")}<input id="document-search" data-kind="${kind}" placeholder="Search number or client" value="${E(search)}"></label>${kind === "invoice" ? '<a class="btn icon-only" href="/api/invoices.csv" aria-label="Export CSV" title="Export CSV">' + icon("download") + "</a>" : ""}</div></div><section class="panel"><div id="document-table">${documentTable(filteredDocs(kind))}</div><div class="table-foot"><span>${data.length} ${k.title.toLowerCase()} in workspace</span><span>All dates / ${E(currencies.length > 1 ? currencies.join(", ") : currencies[0] || "MYR")}</span></div></section>`
  );
}
function matches(d, f) {
  return (
    f === "All" ||
    (f === "Unpaid"
      ? d.state === "issued" && d.balance > 0
      : f === "Issued"
        ? ["Issued", "Viewed"].includes(d.status)
        : d.status === f)
  );
}
function filteredDocs(kind) {
  return S.documents.filter(
    (d) =>
      d.kind === kind &&
      matches(d, filter) &&
      ((d.number || "draft") + " " + d.client.name + " " + (d.client.email || ""))
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
}
// A client is a company, an individual, a government body or another
// organisation. Only the name is needed to save one; the other details are for
// documents and e-Invoices.
const CLIENT_KINDS = [
  ["company", "Company or business", "Sdn Bhd, Bhd, enterprise, sole proprietor…"],
  ["individual", "Individual", "A person, not a business"],
  ["government", "Government", "Ministry, agency, department, council, school…"],
  ["organisation", "Organisation", "NGO, association, society, cooperative…"],
];
const KIND_LABEL = Object.fromEntries(CLIENT_KINDS.map(([k, label]) => [k, label]));
const clientKind = (c) => (KIND_LABEL[c?.kind] ? c.kind : "company");
const kindTag = (c) => (clientKind(c) === "company" ? "" : `<span class="kind-tag">${E(KIND_LABEL[clientKind(c)])}</span>`);
// Regular, member or VIP: a reminder of who gets extra care (a bigger discount,
// a gift). It is shown where documents are made; nothing is applied automatically.
const CLIENT_TIERS = [
  ["regular", "Regular"],
  ["member", "Member"],
  ["vip", "VIP"],
];
const TIER_LABEL = Object.fromEntries(CLIENT_TIERS);
const clientTier = (c) => (TIER_LABEL[c?.tier] ? c.tier : "regular");
const tierBadge = (c) => (clientTier(c) === "regular" ? "" : `<span class="badge tier-${clientTier(c)}"><span class="dot"></span>${TIER_LABEL[clientTier(c)]}</span>`);
// What a member or VIP gets, for the person billing them.
const perks = (c) => (!c || clientTier(c) === "regular" ? "" : `${TIER_LABEL[clientTier(c)]} client${c.tier_note ? ": " + c.tier_note : ""}`);
function clients() {
  return (
    heading("Clients", "", button("Add client", "new-client", "", true, "plus")) +
    `<section class="panel">${S.clients.length ? `<div class="table-wrap"><table class="table-cards"><thead><tr><th>Client</th><th>Contact</th><th>Payment terms</th><th class="num">Outstanding</th></tr></thead><tbody>${paged(S.clients).rows.map((c) => `<tr class="row-link" data-action="open-client" data-id="${c.id}"><td class="card-title"><button class="link-button" data-action="open-client" data-id="${c.id}">${E(c.name)}</button>${kindTag(c)}${tierBadge(c)}<small>${E(c.email)}</small></td><td data-label="Contact">${E(clientKind(c) === "individual" ? c.phone || "" : c.contact || "")}</td><td data-label="Terms">${c.terms} days${c.archived ? " " + badge("Archived") : ""}</td><td class="num" data-label="Outstanding">${money(S.documents.filter((d) => d.client_id === c.id && d.kind === "invoice" && d.state === "issued").reduce((s, d) => s + myr(d.balance, d), 0))}</td></tr>`).join("")}</tbody></table></div>${paged(S.clients).nav}` : empty("Your first client starts here", "Add their billing name and contact details.", button("Add client", "new-client", "", true))}</section>`
  );
}
function clientProfile(id) {
  const c = S.clients.find((c) => c.id === id);
  if (!c) return empty("Client not found");
  const person = clientKind(c) === "individual";
  // Everyday actions stay visible; module actions, archive and delete wait in "More".
  const more =
    slot("clientActions", c) +
    (c.archived ? button("Restore client", "restore-client", c.id) : button("Archive client", "archive-client", c.id)) +
    button("Delete client", "delete-client", c.id);
  return (
    heading(
      c.name,
      KIND_LABEL[clientKind(c)] + (clientTier(c) === "regular" ? "" : " · " + TIER_LABEL[clientTier(c)]),
      button("Edit client", "edit-client", c.id) +
        button("Statement", "client-statement", c.id) +
        (more ? `<details class="dropdown"><summary class="btn">More</summary><div class="menu">${more}</div></details>` : "") +
        (c.archived ? "" : button("New invoice", "client-invoice", c.id, true, "plus")),
    ) +
    `<div class="profile-grid"><section class="panel"><div class="client-avatar">${E(c.name.slice(0, 2).toUpperCase())}</div><h2>${E(c.name)}</h2><dl class="detail"><dt>Client type</dt><dd>${E(KIND_LABEL[clientKind(c)])}</dd>${clientTier(c) === "regular" ? "" : `<dt>Relationship</dt><dd>${tierBadge(c)}${c.tier_note ? ` ${E(c.tier_note)}` : ""}</dd>`}${person ? "" : `<dt>Billing contact</dt><dd>${E(c.contact || "Not provided")}</dd>`}<dt>Email</dt><dd>${E(c.email || "Not provided")}</dd><dt>Phone</dt><dd>${E(c.phone || "Not provided")}</dd><dt>${person ? "Address" : "Billing address"}</dt><dd>${E(c.address || "Not provided")}</dd><dt>Payment terms</dt><dd>${c.terms} days</dd><dt>${person ? "IC or passport / TIN" : "Registration / TIN"}</dt><dd>${E([c.brn, c.tin].filter(Boolean).join(" / ") || "Not provided")}</dd>${slot("clientDetails", c)}</dl></section><section class="panel"><div class="panel-head"><h2>Documents</h2>${badge("MYR")}</div>${invoiceTable(S.documents.filter((d) => d.client_id === c.id))}</section></div>${slot("clientPanels", c)}`
  );
}
function services() {
  return (
    heading(
      "Service catalog",
      "Reusable line items. Tailor the final scope and price for each project.",
      button("Add service", "new-service", "", true, "plus"),
    ) +
    `<section class="panel">${S.services.length ? `<div class="table-wrap"><table><thead><tr><th>Service</th><th>Code</th><th>Unit</th><th class="num">Default rate</th><th>Status</th><th>Action</th></tr></thead><tbody>${S.services.map((s) => `<tr><td><strong>${E(s.name)}</strong><small>${E(s.description)}</small></td><td>${E(s.sku || "—")}</td><td>${E(s.unit)}</td><td class="num">${money(s.rate)}</td><td>${badge(s.active ? "Active" : "Inactive")}</td><td><div class="actions">${button("Edit", "edit-service", s.id)}${button("Delete", "delete-service", s.id)}</div></td></tr>`).join("")}</tbody></table></div>` : empty("Build your service catalog", "Add a service or use custom items directly on an invoice.", button("Add service", "new-service", "", true))}</section>`
  );
}
// Payment slips the client attached to a reference (owner-only files).
// A receipt's allocation keeps "[xxxxxxxx]" (its own id) after the reference; the list shows the reference people typed.
const refLabel = (r = "") => r.replace(/ \[[0-9a-f]{8}\]$/, "");
const slipLinks = (p) =>
  (p.files || [])
    .map(
      (f) =>
        `<a class="slip-link" href="/api/files/${E(f.id)}?inline=1" target="_blank" rel="noopener">${f.mime.startsWith("image/") ? `<img src="/api/files/${E(f.id)}" alt="Payment slip">` : icon("doc")}<span>View payment slip</span></a>`,
    )
    .join("");
function payments() {
  const all = S.documents
    .filter((d) => d.kind === "invoice")
    .flatMap((d) => d.payments.map((p) => ({ ...p, document: d })))
    .sort((a, b) => b.created.localeCompare(a.created));
  const proofs = S.documents.flatMap((d) =>
    d.proofs
      .filter((p) => p.status === "pending")
      .map((p) => ({ ...p, document: d })),
  );
  return (
    heading("Payments", "", button("Record payment", "choose-payment", "", true, "plus")) +
    (proofs.length
      ? `<section class="panel mb22"><div class="panel-head"><h2>Awaiting review</h2>${badge("Pending review")}</div>${proofs.map((p) => `<div class="attention"><div><strong>${E(p.document.number)} / ${E(p.document.client.name)}</strong><small>Reference: ${E(p.reference)}${p.note ? " / " + E(p.note) : ""}</small>${slipLinks(p)}</div>${button("Open", "open-document", p.document.id)}</div>`).join("")}</section>`
      : "") +
    `<section class="panel">${all.length ? `<div class="table-wrap"><table class="table-cards"><thead><tr><th>Payment / invoice</th><th>Received</th><th>Method</th><th>Reference</th><th class="num">Amount</th><th class="status">Status</th><th class="num">Receipt</th></tr></thead><tbody>${all.map((p) => `<tr class="row-link" data-action="open-document" data-id="${p.document.id}"><td class="card-title"><button class="link-button" data-action="open-document" data-id="${p.document.id}">${E(p.document.number)}</button><small>${E(p.document.client.name)}</small></td><td data-label="Received">${dateLabel(p.paid_date)}</td><td data-label="Method">${E(p.method)}</td><td data-label="Reference" title="${E(p.reference)}">${E(refLabel(p.reference))}</td><td class="num" data-label="Amount">${money(p.applied ?? p.amount, p.document.currency)}${p.released ? `<small>Released ${money(p.released, p.document.currency)}</small>` : ""}</td><td class="status" data-label="Status">${badge(p.reversed ? "Reversed" : "Confirmed")}</td><td class="num" data-label="Receipt">${p.reversed ? "—" : `<a class="table-link" href="/api/payments/${p.id}/receipt">PDF</a>`}</td></tr>`).join("")}</tbody></table></div>` : empty("No payments recorded", "Record a payment only after checking it was received.")}</section>`
  );
}
function settings() {
  const b = S.settings;
  return (
    heading("Settings", "") +
    `<section class="panel mt22"><div class="panel-head"><h2>Company</h2></div>${slot("companyLogo") || brandMark({ company: "", logo: brand().logo })}<form data-form="settings"><div class="form-grid"><h3 class="form-section span-2">Business</h3>${input("Registered business name", "company", b.company, "text", true, 'maxlength="180"')}${input("Registration number (SSM)", "registration", b.registration, "text", false, 'maxlength="80"')}${input("Tax identification number (TIN)", "tin", b.tin || "", "text", false, 'maxlength="20"')}${input("SST registration number", "sstNumber", b.sstNumber || "", "text", false, 'maxlength="40"')}<h3 class="form-section span-2">Contact</h3>${input("Billing email", "email", b.email, "email", false, 'maxlength="160"')}${input("Phone", "phone", b.phone, "text", false, 'maxlength="60"')}<div class="span-2">${area("Business address", "address", b.address, 600)}</div><h3 class="form-section span-2">Documents</h3>${input("Invoice prefix", "invoicePrefix", b.invoicePrefix, "text", true, 'pattern="[A-Z][A-Z0-9\\-]{0,11}" maxlength="12"')}${input("Quotation prefix", "quotePrefix", b.quotePrefix, "text", true, 'pattern="[A-Z][A-Z0-9\\-]{0,11}" maxlength="12"')}<div class="span-2">${area("Default terms and conditions", "paymentTerms", b.paymentTerms, 4000)}</div><h3 class="form-section span-2">Bank account</h3>${input("Bank name", "bankName", b.bankName, "text", false, 'maxlength="100"')}${input("Account number", "bankAccount", b.bankAccount, "text", false, 'maxlength="60"')}<div class="span-2">${input("Account holder", "bankHolder", b.bankHolder, "text", false, 'maxlength="180"')}</div></div>${errorBlock()}<p class="field-hint">Issued documents keep a snapshot of the company and client details. SST is charged only after you add your SST registration number.</p><div class="form-actions"><button class="btn primary" type="submit">Save settings</button></div></form></section><section class="panel mt22"><div class="panel-head"><h2>Connections</h2></div><div class="setting-line"><div><h3>Owner access</h3><p>${E(session.email)}</p></div>${badge("Password protected")}</div><div class="setting-line"><div><h3>Client invoice links</h3><p>Document only / 1–90 days / revocable</p></div>${badge("Enabled")}</div><div class="setting-line"><div><h3>LHDN MyInvois</h3><p>${S.ext?.tax?.status?.configured ? `e-Invoice via MyInvois (${E(S.ext.tax.status.env)})` : "Add MyInvois keys under Integration keys"}</p></div>${badge(S.ext?.tax?.status?.configured ? "Connected" : "Not connected")}</div><div class="setting-line"><div><h3>Online payment</h3><p>${S.gateway?.configured ? E(S.gateway.label) + (S.gateway.sandbox ? " / test mode" : " / live") : "Choose a provider under Online payments below"}</p></div>${badge(S.gateway?.configured ? "Connected" : "Not connected")}</div><div class="setting-line"><div><h3>Email and scheduled reminders</h3><p>${S.mail?.configured ? "Sending from " + E(S.mail.from) : "Add SMTP settings under Integration keys"}</p></div>${badge(S.mail?.configured ? "Connected" : "Not connected")}</div></section><section class="panel mt22"><div class="panel-head"><h2>Account password</h2></div><form data-form="password">${input("Current password", "current", "", "password", true, 'autocomplete="current-password"')}${input("New password (at least 12 characters)", "password", "", "password", true, 'minlength="12" maxlength="256" autocomplete="new-password"')}${S.security.enabled ? input("Authenticator or recovery code", "code", "", "text", true, 'autocomplete="one-time-code"') : ""}${errorBlock()}<button type="submit" class="btn">Change password and sign out</button></form></section><section class="panel mt22"><div class="panel-head"><h2>Your business data</h2></div><p>Download a business data export, including documents, payments and audit history. Store it privately.</p><div class="actions mt22"><a class="btn" href="/api/backup">${icon("download")} Export JSON</a><a class="btn" href="/api/invoices.csv">Export CSV</a></div><p class="field-hint">For full disaster recovery, use the encrypted backup and restore procedure in the deployment guide.</p></section>`
  );
}
// Labels, columns and money on the paper follow the document's language and currency.
const dateIn = (lang, s) => formatDate(lang, s);
const fieldApplies = (f, kind) =>
  f.applies === "all" || f.applies === kind || (f.applies === "invoice" && kind === "proforma");
function dueLabelFor(t, kind) {
  return kind === "invoice"
    ? t("dueDate")
    : kind === "sales_order"
      ? t("requiredBy")
      : kind === "delivery_order"
        ? t("deliveryDate")
        : t("validUntil");
}
// A document's history, with what each save changed (rates, quantities,
// titles, descriptions, dates, terms, totals). Only the owner sees it.
const ACTIVITY_TITLES = {
  "draft.changed": "Draft saved",
  "document.revised": "Edited after issue",
  "document.issued": "Issued",
};
function activityPanel(events, d) {
  if (!allowed("view", "activity")) return "";
  const options = {
    clientName: (cid) => S.clients.find((c) => c.id === cid)?.name || "another client",
    date: (x) => (x ? dateLabel(x) : "—"),
    dueLabel: dueLabelFor(labels("en"), d.kind),
  };
  const who = (actor) => String(actor || "system").replace(/^owner:/, "");
  const item = (e) => {
    const changes = auditChanges(e, options);
    const title = ACTIVITY_TITLES[e.action] || e.action.replaceAll(".", " ").replace(/^./, (c) => c.toUpperCase());
    const body = changes
      ? changes.length
        ? `<ul class="change-list">${changes
            .slice(0, 12)
            .map((c) => `<li>${E(c)}</li>`)
            .join("")}${changes.length > 12 ? `<li>and ${changes.length - 12} more</li>` : ""}</ul>`
        : "<p>Saved with no changes.</p>"
      : e.detail
        ? `<p>${E(e.detail)}</p>`
        : "";
    return `<div class="timeline-item"><strong>${E(title)}</strong><small>${timeLabel(e.created)} / ${E(who(e.actor))}</small>${body}</div>`;
  };
  return `<section class="panel activity-panel"><div class="panel-head"><h2>Activity</h2><span class="badge">Owner only</span></div><div class="timeline">${events.map(item).join("") || "<p>No activity yet.</p>"}</div></section>`;
}
function paper(d, publicView = false) {
  const b = d.business,
    c = d.client,
    ext = d.ext?.documents || {};
  const lang = d.language || "en",
    t = labels(lang),
    cur = d.currency || "MYR",
    m = (v) => money(v, cur),
    dl = (s) => dateIn(lang, s);
  const priced = d.kind !== "delivery_order";
  const items = d.items.filter((i) => !i.deposit_id);
  const deducted = d.items.filter((i) => i.deposit_id).reduce((s, i) => s + i.amount, 0);
  const deposits = [...new Set(d.items.filter((i) => i.deposit_id).map((i) => i.deposit_number))];
  const showCode = items.some((i) => i.sku),
    showUnit = items.some((i) => i.unit),
    showDiscount = priced && items.some((i) => i.discount);
  const wide = showCode || showUnit || showDiscount || !priced;
  const custom = publicView
    ? ext.custom || []
    : (b.customFields || [])
        .filter((f) => fieldApplies(f, d.kind) && d.meta?.custom?.[f.id])
        .map((f) => ({ label: f.label, value: d.meta.custom[f.id], internal: f.show !== "pdf" }));
  const logoId = b.logoFileId || (!publicView && S?.settings?.logoFileId);
  const logoHtml = publicView
    ? ext.logo
      ? `<img class="logo brand-logo" src="/api/guest/documents/${E(publicToken())}/logo" alt="${E(b.company)}">`
      : logo()
    : logoId
      ? `<img class="logo brand-logo" src="/api/files/${E(logoId)}" alt="${E(b.company)}">`
      : logo();
  const files = publicView
    ? ext.list_attachments
      ? ext.attachments || []
      : []
    : d.meta?.list_attachments
      ? (d.attachments || []).filter((f) => f.visibility === "client")
      : [];
  const buyerTax =
    b.pdfShowBuyerTax === false
      ? ""
      : [c.brn ? `${t("regIc")}: ${documentId(c)}` : "", c.tin ? `${t("tin")}: ${c.tin}` : ""].filter(Boolean).join("  |  ");
  const cell = (i) => {
    const meta = [i.quantity + (i.unit ? " " + i.unit : ""), priced ? "× " + m(i.rate) : "", i.discount ? "− " + m(i.discount) : ""]
      .filter(Boolean)
      .join(" ");
    return `<tr${i.details ? ' class="has-details"' : ""}>${showCode ? `<td class="line-code">${E(i.sku || "")}</td>` : ""}<td class="quote-scope">${i.details ? `<span class="line-title">${E(i.description)}</span><div class="line-details-view">${detailsHtml(i.details)}</div>` : E(i.description)}<small class="mobile-line-meta">${E(meta)}</small></td><td class="num line-qty">${i.quantity}</td>${showUnit ? `<td class="line-unit">${E(i.unit || "")}</td>` : ""}${priced ? `<td class="num line-rate">${m(i.rate)}</td>${showDiscount ? `<td class="num line-disc">${i.discount ? m(i.discount) + (i.discount_percent ? `<small>${E(i.discount_percent)}%</small>` : "") : ""}</td>` : ""}<td class="num">${m(i.amount)}</td>` : ""}</tr>`;
  };
  const details = [
    `${t("issueDate")}: ${dl(d.issue_date)}`,
    `${dueLabelFor(t, d.kind)}: ${dl(d.due_date)}`,
    `${t("currency")}: ${cur}`,
    cur !== "MYR" && d.fx_rate ? `${t("exchangeRate")}: 1 ${cur} = ${d.fx_rate} MYR` : "",
    d.links?.source?.number || d.source_number ? `${t("basedOn")}: ${d.links?.source?.number || d.source_number}` : "",
    ...deposits.map((n) => `${t("deposit")}: ${n}`),
  ]
    .filter(Boolean)
    .map(E)
    .join("<br>");
  const customHtml = custom
    .map((f) => `<br>${E(f.label)}: ${E(f.value)}${f.internal ? ' <span class="badge">Internal</span>' : ""}`)
    .join("");
  const totals = priced
    ? `<div class="totals"><div class="total-row"><span>${t("subtotal")}</span><strong>${m(d.subtotal)}</strong></div>${d.discount ? `<div class="total-row"><span>${t("discount")}</span><strong>−${m(d.discount)}</strong></div>` : ""}${deducted ? `<div class="total-row"><span>${t("lessDepositShort")}</span><strong>${m(deducted)}</strong></div>` : ""}${taxRows(d.items, cur, t)}<div class="total-row ${d.kind === "invoice" ? "strong" : "emphasis"}"><span>${d.kind === "invoice" || d.kind === "quote" ? t("originalTotal") : t("total")}</span><span>${m(d.total)}</span></div>${d.credit ? `<div class="total-row"><span>${t("creditNotes")}</span><strong>−${m(d.credit)}</strong></div>` : ""}${d.debit ? `<div class="total-row"><span>${t("debitNotes")}</span><strong>+${m(d.debit)}</strong></div>` : ""}${d.credit || d.debit ? `<div class="total-row strong"><span>${t("adjustedTotal")}</span><span>${m(d.adjusted_total)}</span></div>` : ""}${d.kind === "invoice" ? `<div class="total-row"><span>${t("paid")}</span><strong>${m(d.paid)}</strong></div><div class="total-row emphasis"><span>${t("balanceDue")}</span><span>${m(d.balance)}</span></div>` : ""}</div>`
    : "";
  const deposit =
    d.kind === "quote" && d.deposit?.total
      ? `<div class="paper-notes"><h3>${t("depositRequired")}</h3><p>${E(t("depositOf", { value: d.deposit.type === "percent" ? d.deposit.value + "%" : "", amount: m(d.deposit.total) + (d.deposit.tax ? ` (${t("inclSst")})` : "") }).replace("  ", " "))}</p></div>`
      : "";
  const plan = (d.instalments || []).length
    ? `<div class="paper-notes"><h3>${t("instalmentPlan")}</h3><div class="instalment-list">${d.instalments.map((i) => `<div class="instalment-row"><span>${i.seq}. ${dl(i.due_date)}</span><strong>${m(i.amount)}</strong><span>${E(t("ins_" + i.status))}</span></div>`).join("")}</div>${d.next_due_date ? `<p>${E(t("nextPaymentDue", { amount: m(d.next_due_amount), date: dl(d.next_due_date) }))}</p>` : ""}</div>`
    : "";
  const signatures =
    d.kind === "delivery_order"
      ? `<div class="paper-notes signature-grid">${[t("deliveredBy"), t("receivedBy")].map((h, n) => `<div><h3>${E(h)}</h3>${n ? `<p>${E(t("goodsReceived"))}</p>` : ""}<div class="signature-line">${E(t("signature"))}</div><div class="signature-line">${E(t("name"))}</div><div class="signature-line">${E(t("date"))}</div></div>`).join("")}</div>`
      : "";
  const bank =
    (d.kind === "invoice" || d.kind === "proforma") && d.state !== "void" && b.pdfShowBank !== false && !(d.kind === "invoice" && d.balance <= 0)
      ? `<div class="paper-notes"><h3>${t("paymentInformation")}</h3>${b.bankAccount ? `<p>${E([b.bankName, b.bankHolder, b.bankAccount].filter(Boolean).join("\n"))}</p><p>${t("reference")}: ${E(d.number || t("notYetIssued"))}</p>` : `<p>${t("bankMissing")}</p>`}</div>`
      : "";
  return `<section class="panel invoice-paper" lang="${lang === "zh" ? "zh-Hans" : lang}"><div class="paper-head"><div>${logoHtml}<div class="paper-company"><strong>${E(b.company)}</strong><p>${E([b.registration ? `${t("regShort")}: ${b.registration}` : "", b.address, b.email, b.phone].filter(Boolean).join("\n"))}</p></div></div><div><h2>${E(titleFor(lang, d.kind))}</h2><p>${E(d.number || t("draft"))}</p></div></div>${b.demo ? `<div class="notice">${t("demoShort")}</div>` : ""}<div class="billing-grid"><div><div class="eyebrow">${d.kind === "delivery_order" ? t("deliverTo") : t("billTo")}</div><strong>${E(c.name)}</strong><p>${E([c.contact, c.address, buyerTax].filter(Boolean).join("\n"))}</p></div><div><div class="eyebrow">${t("documentDetails")}</div><p>${details}${customHtml}</p></div></div><div class="table-wrap"><table class="${wide ? "wide-lines" : ""}${priced ? "" : " no-price-lines"}"><thead><tr>${showCode ? `<th class="line-code">${t("code")}</th>` : ""}<th>${t("description")}</th><th class="num line-qty">${t("qty")}</th>${showUnit ? `<th class="line-unit">${t("unit")}</th>` : ""}${priced ? `<th class="num line-rate">${t("rate")}</th>${showDiscount ? `<th class="num line-disc">${t("discount")}</th>` : ""}<th class="num">${t("amount")}</th>` : ""}</tr></thead><tbody>${items.map(cell).join("")}</tbody></table></div>${totals}${deposit}${plan}${bank}${d.terms && b.pdfShowTerms !== false ? `<div class="paper-notes"><h3>${t("terms")}</h3><p>${E(d.terms)}</p></div>` : ""}${d.notes && b.pdfShowNotes !== false ? `<div class="paper-notes"><h3>${t("notes")}</h3><p>${E(d.notes)}</p></div>` : ""}${files.length ? `<div class="paper-notes"><h3>${t("attachments")}</h3><p>${files.map((f) => E(f.name)).join("\n")}</p></div>` : ""}${signatures}${slot("paper", d, publicView)}${publicView && !d.ext?.tax?.einvoice ? `<p class="field-hint">${t("businessDocument")}</p>` : ""}</section>`;
}
function taxRows(items, cur = "MYR", t = labels("en")) {
  const by = new Map();
  for (const i of items)
    if (i.tax_rate) by.set(i.tax_rate, (by.get(i.tax_rate) || 0) + (i.tax || 0));
  return [...by]
    .sort((a, b) => a[0] - b[0])
    .map(([r, v]) => `<div class="total-row"><span>${t("sst")} ${r}%</span><strong>${money(v, cur)}</strong></div>`)
    .join("");
}
function sstPanel() {
  const from = addDays(S.today, -60);
  return `<section class="panel mt22"><div class="panel-head"><div><h2>SST summary</h2><p>${S.settings.sstNumber ? "SST No. " + E(S.settings.sstNumber) : "Add your SST registration number above to charge SST."}</p></div>${badge(S.settings.sstNumber ? "Active" : "Not connected")}</div><form data-form="sst-report"><div class="form-grid">${input("From", "from", from, "date", true)}${input("To", "to", S.today, "date", true)}</div><p class="field-hint">Taxable value and SST by rate for issued invoices, by issue date. Credit and debit notes carry their SST share. The full SST-02 worksheet is under Books > Tax.</p><div class="form-actions"><button class="btn primary" type="submit">Download CSV</button></div></form></section>`;
}
function emailHistory(list) {
  if (!list.length) return "";
  return `<section class="panel"><div class="panel-head"><h2>Emails</h2></div>${list
    .slice(0, 8)
    .map(
      (m) =>
        `<div class="payment"><div class="payment-top"><strong>${E(m.subject)}</strong><span class="actions">${m.bounce_type ? badge(m.bounce_type === "complaint" ? "Spam complaint" : m.bounce_type === "soft" ? "Soft bounce" : "Bounced") : m.opened_first ? badge("Opened") : ""}${badge(m.status === "sent" ? "Sent" : m.status === "failed" ? "Failed" : "Sending")}</span></div><p>${E(m.recipients)}<br>${timeLabel(m.created)}${m.kind === "reminder" ? " / automatic reminder" : ""}</p>${m.error ? `<p>${E(m.error)}</p>` : ""}${m.bounce_type ? `<p>${E(m.bounce_detail || "Reported by the mail provider.")}</p>` : m.opened_first ? `<p>Opened ${m.open_count === 1 ? "once" : m.open_count + " times"}, last ${timeLabel(m.opened_last)} (approximate)</p>` : ""}</div>`,
    )
    .join("")}</section>`;
}
function remindersPanel() {
  const b = S.settings;
  return `<section class="panel mt22"><div class="panel-head"><div><h2>Email reminders</h2><p>${S.mail.configured ? "Sending from " + E(S.mail.from) : "Email is not set up. Add the SMTP settings under Integration keys below."}</p></div>${badge(S.mail.configured ? "Connected" : "Not connected")}</div><form data-form="reminders"><label class="check-row"><input type="checkbox" name="remindersEnabled" ${b.remindersEnabled ? "checked" : ""} ${S.mail.configured ? "" : "disabled"}> Send automatic reminders for unpaid invoices to the client's email.</label><div class="form-grid">${input("Days before due date (0 = none)", "reminderBeforeDays", b.reminderBeforeDays ?? 3, "number", true, 'min="0" max="30" step="1"')}${input("Days after due date (comma separated)", "reminderAfterDays", b.reminderAfterDays ?? "1,7,14", "text", true, 'pattern="\\s*\\d{1,3}(\\s*,\\s*\\d{1,3}){0,4}\\s*" maxlength="40"')}</div><p class="field-hint">Each invoice gets each reminder once. A missed reminder is skipped after 2 days instead of being sent late. Reminders attach the invoice PDF and your bank details.</p>${errorBlock()}<div class="form-actions">${S.mail.configured ? button("Send due reminders now", "run-reminders") : ""}<button class="btn primary" type="submit">Save reminders</button></div></form>${emailHistory(S.emailLog.filter((m) => m.kind === "reminder")).replace("<h2>Emails</h2>", "<h2>Recent reminders</h2>")}</section>`;
}
// Integration keys declared by feature modules. Values are write-only.
function integrationKeysPanel() {
  const list = S.secrets || [];
  if (!list.length) return "";
  const groups = [...new Set(list.map((x) => x.plugin))];
  return `<section class="panel mt22"><div class="panel-head"><div><h2>Integration keys</h2><p>Saved encrypted on this server and never shown again. A value set on the server environment takes precedence.</p></div>${badge(list.some((x) => x.source) ? "Connected" : "Not connected")}</div>${groups
    .map(
      (g) =>
        `<h3 class="mt22">${E(g[0].toUpperCase() + g.slice(1))}</h3>${list
          .filter((x) => x.plugin === g)
          .map(
            (x) =>
              `<div class="setting-line"><div><h3>${E(x.label)}</h3><p>${E(x.help || x.name)}${x.source === "server" ? " · set on the server" : x.updated ? " · saved " + timeLabel(x.updated) : ""}</p></div><div class="actions">${badge(x.source ? "Connected" : "Not connected")}${x.source === "server" ? "" : button(x.source ? "Replace" : "Set", "secret-edit", x.name)}${x.source === "settings" ? button("Clear", "secret-clear", x.name) : ""}</div></div>`,
          )
          .join("")}`,
    )
    .join("")}</section>`;
}
function secretForm(name, clear = false) {
  const x = (S.secrets || []).find((s) => s.name === name);
  showModal(
    clear ? "Clear " + x.label : x.label,
    `<form data-form="secret-save" data-id="${E(name)}" data-clear="${clear ? 1 : ""}">${clear ? `<p>${E(x.label)} will be removed from this server.</p>` : x.secret ? input(x.label, "value", "", "password", true, 'autocomplete="off" maxlength="8000"') : area(x.label, "value", "", 8000)}${x.help ? `<p class="field-hint">${E(x.help)}</p>` : ""}${input("Current password", "password", "", "password", true, 'autocomplete="current-password"')}${S.security.enabled ? input("Authenticator or recovery code", "code", "", "text", true, 'autocomplete="one-time-code"') : ""}${formEnd(clear ? "Clear" : "Save")}</form>`,
  );
}
// Email forms (public/ext/comms.mjs) start from these values; modules may change them (e.g. recipients
// from client contacts) with emailPrefill(kind, record, values) and add fields
// with the emailFields slot. kind is "document" or "statement".
function emailPrefill(kind, record, values) {
  for (const p of plugins) Object.assign(values, p.emailPrefill?.(kind, record, { ...values }) || {});
  return values;
}
function documentView(id) {
  const d = S.documents.find((d) => d.id === id);
  if (!d) return empty("Document not found");
  const cur = d.currency || "MYR";
  // Everyday actions stay visible, the main one last; the rest (duplicate,
  // delete, delivery, proof, ...) wait in "More".
  const more = button("Duplicate", "duplicate-document", id) + (d.state === "draft" ? button("Delete draft", "delete-draft", id) : "") + slot("documentActions", d);
  const pdf = `<a class="btn" href="/api/documents/${id}/pdf">${icon("download")} PDF</a>`;
  const menu = more ? `<details class="dropdown"><summary class="btn">More</summary><div class="menu">${more}</div></details>` : "";
  const actions =
    d.state === "draft"
      ? button("Edit draft", "edit-document", id) + pdf + menu + button("Issue document", "issue-document", id, true)
      : d.state === "void"
        ? pdf + menu
        : (d.kind === "quote" && d.state === "issued" ? button("Edit quotation", "edit-document", id) : "") +
          button("Email", "email-document", id) +
          pdf +
          menu +
          button("Share", "share-document", id, true, "copy");
  // "draft.changed" / "document.revised" say what changed; the bare save entry under them adds nothing.
  const events = S.audit.filter((a) => a.entity_id === id && a.action !== "document.draft.saved").slice(0, 10);
  const statusActions = [
    d.kind === "invoice" && d.state === "issued" && d.balance > 0 ? button("Record payment", "record-payment", id, true, "plus") : "",
    d.kind === "quote" && d.state === "accepted" ? button("Create / open invoice", "convert-quote", id, true) : "",
    d.token_hash ? button("Revoke client link", "revoke-link", id) : "",
    d.state !== "void" ? button("Void document", "void-document", id) : "",
  ].join("");
  return (
    heading(d.number || `Draft ${kindUI(d.kind).one}`, d.client.name, actions) +
    `<div class="doc-grid">${paper(d)}<div class="stack">${advanced.documentExtras(d)}${slot("documentPanels", d)}<section class="panel"><div class="panel-head"><h2>Document status</h2>${badge(d.status)}</div>${d.kind === "delivery_order" ? "" : `<div class="total-row"><span>Document total</span><strong>${money(d.total, cur)}</strong></div>`}${d.kind === "invoice" ? `<div class="total-row"><span>Confirmed payments</span><strong>${money(d.paid, cur)}</strong></div><div class="total-row emphasis"><span>Balance</span><span>${money(d.balance, cur)}</span></div>${cur !== "MYR" ? `<p class="field-hint">${E(cur)} at ${E(d.fx_rate)} MYR = ${money(myr(d.balance, d))}</p>` : ""}` : ""}${d.state === "draft" ? `<p class="field-hint">Review the client, dates, amounts and terms before issuing. ${d.kind === "quote" ? "Issuing gives it a number; you can still edit it until the client accepts." : "Issuing locks the document."}</p>` : d.kind === "quote" && d.state === "issued" ? '<p class="field-hint">You can still edit this quotation until the client accepts or declines it. It keeps its number.</p>' : ""}${d.kind === "quote" && d.state === "accepted" ? `<p class="field-hint">Accepted by ${E(d.accepted_name)}</p>` : ""}${statusActions ? `<div class="actions mt22">${statusActions}</div>` : ""}</section>${
      d.proofs.filter((p) => p.status === "pending").length
        ? `<section class="panel"><div class="panel-head"><h2>Awaiting review</h2>${badge("Pending review")}</div>${d.proofs
            .filter((p) => p.status === "pending")
            .map(
              (p) =>
                `<div class="payment"><strong>${E(p.reference)}</strong><p>${E(p.note || "Client submitted a transaction reference.")}<br>${timeLabel(p.created)}</p>${slipLinks(p)}<p>Check your bank account before recording a payment.</p>${button("Reject reference", "reject-proof", p.id)}</div>`,
            )
            .join("")}</section>`
        : ""
    }${d.kind === "invoice" ? `<section class="panel"><div class="panel-head"><h2>Payment history</h2></div>${d.payments.map((p) => `<div class="payment"><div class="payment-top"><strong>${money(p.amount, cur)}</strong>${badge(p.reversed ? "Reversed" : "Confirmed")}</div><p>${dateLabel(p.paid_date)} / ${E(p.method)}<br>Reference: ${E(p.reference)}</p>${p.reversed ? `<p>Reversal: ${E(p.reversal_reason)}</p>` : `<div class="payment-actions"><a href="/api/payments/${p.id}/receipt">Receipt PDF</a>${allowed("action", "reverse-payment") ? `<button class="link-button red-text" data-action="reverse-payment" data-id="${p.id}">Reverse</button>` : ""}</div>`}</div>`).join("") || "<p>No payments recorded yet.</p>"}</section>` : ""}${emailHistory(S.emailLog.filter((m) => m.document_id === id))}${activityPanel(events, d)}</div></div>`
  );
}
// Settings panels are grouped into tabs after rendering, by their heading, so
// modules keep adding panels through the settings slot without knowing the tabs.
const SETTINGS_TABS = [
  ["company", "Company", ["Company", "Your business data", "SST summary", "Tax", "Books", "Operations"]],
  ["modules", "Modules", ["Modules"]],
  ["documents", "Documents", ["Document template", "Custom fields", "Late payment fees", "Monthly accountant pack", "Client portal and feedback"]],
  ["payments", "Payments", ["Online payments", "DuitNow QR"]],
  ["messages", "Messages", ["Email reminders", "Email delivery", "Email templates", "WhatsApp Business", "Owner notifications", "Collection follow-ups"]],
  ["integrations", "Integrations", ["Connections", "Integration keys", "Install the app"]],
  ["security", "Security", ["Account password", "Team and access", "Encrypted backups", "Authenticator and recovery"]],
];
function settingsTabs(wanted) {
  const content = $("main.content");
  const titleOf = (panel) => panel.querySelector("h2")?.textContent.trim() || "";
  // Sections of modules turned off in Settings > Modules.
  const hidden = hiddenSettings(S.settings);
  for (const panel of $$(":scope > section.panel", content)) if (hidden.has(titleOf(panel))) panel.remove();
  const panels = $$(":scope > section.panel", content);
  if (!panels.length) return;
  const tabOf = (panel) => SETTINGS_TABS.find(([, , titles]) => titles.includes(titleOf(panel)))?.[0] || "integrations";
  const keys = panels.map(tabOf);
  const active = keys.includes(wanted) ? wanted : SETTINGS_TABS.find(([k]) => keys.includes(k))[0];
  panels.forEach((panel, n) => (panel.hidden = keys[n] !== active));
  const nav = document.createElement("div");
  nav.className = "tabs settings-tabs";
  nav.setAttribute("role", "navigation");
  nav.setAttribute("aria-label", "Settings sections");
  nav.innerHTML = SETTINGS_TABS.filter(([k]) => keys.includes(k))
    .map(([k, label]) => `<a class="tab ${k === active ? "active" : ""}" href="#/settings/${k}" ${k === active ? 'aria-current="page"' : ""}>${label}</a>`)
    .join("");
  $(".heading", content).after(nav);
}
function renderRoute() {
  if (!session || !S) return;
  autosave?.flush();
  const [rawPage, id] = location.hash.replace(/^#\/?/, "").split("/");
  const page = rawPage || "overview";
  let html,
    active = page;
  if (!allowed("page", page))
    html = empty("Not available", "Your access does not include this page. Ask the workspace owner.");
  else switch (page) {
    case "sales":
      html = workflow.sales();
      break;
    case "automation":
      html = workflow.automation();
      break;
    case "overview":
      html = overview();
      break;
    case "invoices":
      html = documentList("invoice");
      break;
    case "quotes":
      html = documentList("quote");
      break;
    case "proformas":
      html = documentList("proforma");
      break;
    case "sales-orders":
      html = documentList("sales_order");
      break;
    case "delivery-orders":
      html = documentList("delivery_order");
      break;
    case "clients":
      html = clients();
      break;
    case "client":
      html = clientProfile(id);
      active = "clients";
      break;
    case "services":
      html = services();
      break;
    case "ledger":
      html = advanced.ledger();
      break;
    case "payments":
      html = payments();
      break;
    case "settings":
      html =
        settings() +
        sstPanel() +
        remindersPanel() +
        slot("settings") +
        integrationKeysPanel() +
        advanced.security();
      break;
    case "document":
      html = documentView(id);
      active = kindUI(S.documents.find((d) => d.id === id)?.kind).list;
      break;
    default: {
      const owner = plugins.find((p) => p.pages?.[page]);
      if (owner) {
        html = owner.pages[page](id);
        active = owner.activeFor?.[page] || page;
      } else
        html = empty(
          "Page not found",
          "Use the navigation to return to your workspace.",
        );
    }
  }
  renderShell(html, active);
  if (page === "settings") settingsTabs(id);
  $$("[data-height]").forEach((el) => {
    el.style.height = /%$/.test(el.dataset.height) ? el.dataset.height : el.dataset.height + "px";
  });
}
function navigate(route) {
  if (location.hash === "#/" + route) renderRoute();
  else location.hash = "/" + route;
}
// The labels follow the client type; an individual has no contact person or
// SST number of their own. Only the name is required.
function clientForm(id) {
  const c = S.clients.find((c) => c.id === id) || { terms: 14, kind: "company" };
  const kind = clientKind(c);
  // One <span> per type; the form's data-client-kind shows the right one (app.css).
  const by = (map) => CLIENT_KINDS.map(([k]) => `<span class="when-${k}">${E(map[k] ?? map.other)}</span>`).join("");
  const field = (label, name, value, type = "text", required = false, extra = "", cls = "") =>
    `<label${cls ? ` class="${cls}"` : ""}>${label}<input name="${name}" type="${type}" value="${E(value ?? "")}" ${required ? "required" : ""} ${extra}></label>`;
  const option = ([value, label, hint]) =>
    `<label class="kind-option"><input type="radio" name="kind" value="${value}" ${kind === value ? "checked" : ""}><span><strong>${E(label)}</strong><small>${E(hint)}</small></span></label>`;
  showModal(
    id ? "Edit client" : "Add client",
    `<form data-form="client" data-id="${E(id || "")}" data-client-kind="${kind}" class="client-form"><fieldset class="kind-choice client-kind"><legend>Client type</legend>${CLIENT_KINDS.map(option).join("")}</fieldset><p class="field-hint">Only the name is required. Registration, TIN and SST are used on documents and e-Invoices; add them when you have them.</p><div class="form-grid">${field(by({ company: "Company name", individual: "Full name", government: "Agency or department name", organisation: "Organisation name" }), "name", c.name, "text", true, 'maxlength="160"')}${field(by({ government: "Officer in charge", other: "Contact person" }), "contact", c.contact, "text", false, 'maxlength="120"', "company-only")}${field("Email", "email", c.email, "email", false, 'maxlength="160"')}${field("Phone", "phone", c.phone, "text", false, 'maxlength="60"')}${field(by({ company: "Registration number (SSM)", individual: "IC or passport number", government: "Reference number, if any", organisation: "Registration number (ROS / SSM), if any" }), "brn", c.brn || "", "text", false, 'maxlength="40"')}${field(by({ company: "Tax identification number (TIN)", other: "Tax identification number (TIN), if any" }), "tin", c.tin || "", "text", false, 'maxlength="20"')}${field("SST registration (if any)", "sst_number", c.sst_number || "", "text", false, 'maxlength="40"', "company-only")}<div class="span-2"><label>${by({ individual: "Address", other: "Billing address" })}<textarea name="address" maxlength="600">${E(c.address || "")}</textarea></label></div>${input("Payment terms (days)", "terms", c.terms, "number", true, 'min="0" max="365" step="1"')}${select("Relationship", "tier", CLIENT_TIERS, clientTier(c))}<div class="span-2">${field("What they get, as a reminder when you bill them (optional)", "tier_note", c.tier_note || "", "text", false, 'maxlength="200" placeholder="e.g. 10% extra discount, 2 pendrives per order"')}</div>${slot("clientFields", c)}</div>${formEnd("Save client")}</form>`,
  );
}
function serviceForm(id) {
  const s = S.services.find((s) => s.id === id) || {
    rate: 0,
    unit: "Project",
    active: 1,
  };
  showModal(
    id ? "Edit service" : "Add service",
    `<form data-form="service" data-id="${E(id || "")}">${input("Service name", "name", s.name, "text", true, 'maxlength="160"')}${area("Description", "description", s.description, 240)}<div class="form-grid">${select(
      "Billing unit",
      "unit",
      [...new Set(["Project", "Month", "Hour", "Day", "Item", "Unit", "Set", "Lot", s.unit])].map((v) => [v, v]),
      s.unit,
    )}${input("Item code / SKU (optional)", "sku", s.sku || "", "text", false, 'maxlength="40"')}${input("Rate (MYR)", "rate", dec(s.rate), "number", true, 'min="0" max="99999999.99" step="0.01"')}${select(
      "Default SST",
      "tax_rate",
      TAX_RATES.map((r) => [String(r), r ? r + "%" : "No SST"]),
      String(s.tax_rate || 0),
    )}${select(
      "Status",
      "active",
      [
        ["1", "Active"],
        ["0", "Inactive"],
      ],
      s.active,
    )}</div>${formEnd("Save service")}</form>`,
  );
}
const TAX_RATES = [0, 5, 6, 8, 10];
// SST lines show when the business is registered. An issued quotation being
// edited keeps the registration it was issued under, so its rates stay.
let issuedSst = null;
const sstEnabled = () => issuedSst ?? !!S.settings.sstNumber;
const editorKind = () => $('form[data-form="editor"]')?.dataset.kind || "invoice";
// One editor line: description, quantity, rate and SST, then code, unit and line discount.
// The formatted description under a line's title (public/ext/line-details.mjs).
function detailsEditor(details = "") {
  const fmt = (cmd, label, text) => `<button type="button" class="fmt-btn" data-fmt="${cmd}" aria-label="${label}" title="${label}">${text}</button>`;
  return `<div class="line-details"${details ? "" : " hidden"}><div class="details-toolbar" role="toolbar" aria-label="Description formatting">${fmt("bold", "Bold", "<b>B</b>")}${fmt("italic", "Italic", "<i>I</i>")}${fmt("strikeThrough", "Strikethrough", "<s>S</s>")}${fmt("insertUnorderedList", "Bullet list", "• List")}${fmt("insertOrderedList", "Numbered list", "1. List")}<button type="button" class="fmt-btn details-remove" data-details="remove" aria-label="Remove description" title="Remove description">${icon("close")}</button></div><div class="item-details" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Item description" data-placeholder="Description: features, scope, specifications…">${detailsHtml(details)}</div><small class="details-count">${details.length} / ${DETAILS_MAX}</small></div><button type="button" class="link-button details-add" data-details="add"${details ? " hidden" : ""}>+ Description</button>`;
}
// A catalog service's description becomes the line's description; its
// stars and tildes are text, not formatting.
const catalogDetails = (s) => (s.description && s.description !== s.name ? s.description.replace(/([\\*~])/g, "\\$1") : "");
// The description markup of a line, or "" when it has none.
const lineDetails = (row) => {
  const box = $(".line-details", row);
  return box && !box.hidden ? htmlToDetails($(".item-details", box)) : "";
};
function lineMarkup(i = { description: "", quantity: 1, rate: 0 }, kind = editorKind()) {
  const tax = Number(i.tax_rate || 0);
  const priced = kind !== "delivery_order";
  const percent = !!i.discount_percent;
  const off = i.discount_percent || (i.discount ? dec(i.discount) : i.discount_amount || "");
  const more = i.sku || i.unit || off ? " open" : "";
  const details = i.details || "";
  return `<div class="line-item"><textarea aria-label="Item title" class="item-description" rows="1" maxlength="240" placeholder="Item title" autocomplete="off" aria-autocomplete="list" aria-expanded="false" required>${E(i.description)}</textarea><input aria-label="Quantity" class="item-quantity" type="number" min="0.01" max="99999.99" step="0.01" value="${i.quantity}" required>${priced ? `<input aria-label="Rate" class="item-rate" type="number" min="0" max="99999999.99" step="0.01" value="${dec(i.rate)}" required>` : ""}${priced && sstEnabled() ? `<select aria-label="SST rate" class="item-tax">${TAX_RATES.map((r) => `<option value="${r}" ${r === tax ? "selected" : ""}>${r ? r + "%" : "No SST"}</option>`).join("")}</select>` : ""}<button class="btn ghost" type="button" data-action="remove-line" aria-label="Remove item">${icon("close")}</button><details class="line-more"${more}><summary>${priced ? "Code, unit, discount" : "Code and unit"}</summary><div class="line-extra"><input aria-label="Item code" class="item-sku" maxlength="40" placeholder="Code" value="${E(i.sku || "")}"><input aria-label="Unit" class="item-unit" maxlength="30" placeholder="Unit" value="${E(i.unit || "")}">${priced ? `<span class="line-discount"><input aria-label="Line discount" class="item-discount" type="number" min="0" step="0.01" placeholder="Discount" value="${E(off)}"><select aria-label="Discount type" class="item-discount-type"><option value="amount" ${percent ? "" : "selected"}>Amount</option><option value="percent" ${percent ? "selected" : ""}>%</option></select></span>` : ""}<input type="hidden" class="item-service" value="${E(i.service_id || "")}"></div></details>${detailsEditor(details)}</div>`;
}
// A new document starts with the terms and conditions of the latest one of
// the same kind (what was used last time), or the company default. They can
// be changed for that document only.
function lastTerms(kind) {
  const prev = S.documents
    .filter((x) => x.kind === kind && x.state !== "void" && String(x.terms || "").trim())
    .sort((a, b) => String(b.created || "").localeCompare(String(a.created || "")))[0];
  return prev ? { terms: prev.terms, from: prev.number || "your latest draft" } : null;
}
function termsHint(last, kind, priced) {
  if (!last) return "";
  const reset = priced && last.terms !== (S.settings.paymentTerms || "") ? ` <button type="button" class="link-button" data-terms-default>Use the company default</button>` : "";
  return `<p class="field-hint terms-hint">Same as ${E(last.from)}. Change them here for this ${E(kindUI(kind).one)} only.${reset}</p>`;
}
function documentForm(kind = "invoice", id = "", clientId = "") {
  if (!S.clients.length) {
    toast("Add your first client before creating a document.");
    clientForm();
    return;
  }
  const d = S.documents.find((d) => d.id === id);
  const c =
    S.clients.find((c) => c.id === (d?.client_id || clientId)) || S.clients[0];
  const priced = kind !== "delivery_order";
  // An issued quotation can still be edited (server/db.mjs reviseQuote).
  const revising = !!d && d.state !== "draft";
  issuedSst = revising ? !!d.business?.sstNumber || d.items.some((i) => Number(i.tax_rate) > 0) : null;
  const last = d ? null : lastTerms(kind);
  const value = d || {
    kind,
    client_id: c.id,
    issue_date: S.today,
    due_date: addDays(S.today, kind === "delivery_order" ? 0 : ["invoice", "quote"].includes(kind) ? c.terms : 14),
    items: [{ description: "", quantity: 1, rate: 0 }],
    discount: 0,
    notes: "",
    terms: last ? last.terms : priced ? S.settings.paymentTerms : "",
    currency: c.currency || "MYR",
    language: c.language || S.settings.documentLanguage || "en",
    fx_rate: "",
    meta: {},
  };
  const tax = priced && sstEnabled();
  showModal(
    revising ? `Edit ${kindUI(kind).one} ${d.number}` : d ? "Edit draft" : "New " + kindUI(kind).one,
    `<form data-form="editor" data-id="${E(id)}" data-kind="${kind}">${revising ? `<div class="notice info revise-note"><p>This ${E(kindUI(kind).one)} is issued as <strong>${E(d.number)}</strong>. Saving keeps its number, and its PDF and client link show the new version. The client and issue date stay as issued. Each change is kept in the activity history.</p></div>` : ""}<div class="editor-grid ${tax ? "with-tax" : ""} ${priced ? "" : "no-price"}"><div><div class="form-grid"><div class="span-2">${select(kind === "delivery_order" ? "Deliver to" : "Bill to", "client_id", clientOptions(value.client_id), value.client_id)}<p class="field-hint client-perks">${E(perks(S.clients.find((c) => c.id === value.client_id)))}</p></div>${input("Issue date", "issue_date", value.issue_date, "date", true)}${input(dueLabelFor(labels("en"), kind), "due_date", value.due_date, "date", true)}</div><div class="line-head"><span>ITEM</span><span>QTY</span>${priced ? '<span class="rate-head">RATE</span>' : ""}${tax ? "<span>SST</span>" : ""}<span></span></div><div id="line-items">${value.items
      .filter((i) => !i.deposit_id)
      .map((i) => lineMarkup(i, kind))
      .join("")}</div>${value.items.some((i) => i.deposit_id) ? `<p class="field-hint">The deposit already invoiced (${E([...new Set(value.items.filter((i) => i.deposit_id).map((i) => i.deposit_number))].join(", "))}) is deducted when you save.</p>` : ""}<div class="actions mt22">${button("Custom item", "add-line", "", "", "plus")}<label class="catalog-picker"><span class="sr-only">Add service from catalog</span><select id="catalog-service"><option value="">Add from catalog...</option>${S.services
      .filter((s) => s.active)
      .map(
        (s) =>
          `<option value="${s.id}">${E(s.sku ? s.sku + " · " : "")}${E(s.name)} / ${money(s.rate)}</option>`,
      )
      .join(
        "",
      )}</select></label></div><div class="mt22">${slot("documentFields", value, kind)}<h3 class="form-section">${priced ? "Discount, terms and notes" : "Terms and notes"}</h3>${priced ? input("Document discount", "discount", dec(value.discount), "number", true, 'min="0" max="99999999.99" step="0.01"') : ""}${area(kind === "quote" ? "Terms and conditions" : priced ? "Payment / project terms" : "Delivery terms", "terms", value.terms, 4000)}${termsHint(last, kind, priced)}${area("Notes", "notes", value.notes, 2000)}</div></div><aside class="preview"><div class="eyebrow mb22">Live preview</div><div id="live-preview"></div><p class="field-hint">${!priced ? "Delivery orders list items and quantities only." : sstEnabled() ? "SST is calculated per line after line and document discounts. The saved document is authoritative." : "Add your SST registration number in Settings to charge SST."} This preview is not a validated e-Invoice.</p></aside></div>${formEnd(revising ? "Save changes" : "Save draft and review")}</form>`,
    true,
  );
  if (revising) lockIssuedFields($('form[data-form="editor"]'));
  updatePreview();
}
// The client, issue date and currency of an issued document stay as issued:
// shown, but not changeable (the server keeps them too).
function lockIssuedFields(form) {
  for (const name of ["client_id", "currency"]) {
    const el = form.elements[name];
    if (!el || el.tagName !== "SELECT") continue;
    el.disabled = true;
    el.insertAdjacentHTML("afterend", `<input type="hidden" name="${name}" value="${E(el.value)}">`);
  }
  for (const name of ["issue_date", "fx_rate"]) {
    const el = form.elements[name];
    if (!el) continue;
    el.readOnly = true;
    el.closest(".date-field")?.querySelector(".date-pick")?.setAttribute("hidden", "");
  }
}
function editorData(form) {
  const b = formValues(form);
  return {
    kind: form.dataset.kind,
    ...b,
    items: $$(".line-item", form).map((row) => {
      const item = {
        description: $(".item-description", row).value,
        details: lineDetails(row),
        quantity: $(".item-quantity", row).value,
        rate: $(".item-rate", row)?.value ?? "0",
        tax_rate: Number($(".item-tax", row)?.value || 0),
        sku: $(".item-sku", row)?.value.trim() || "",
        unit: $(".item-unit", row)?.value.trim() || "",
      };
      const service = $(".item-service", row)?.value;
      if (service) item.service_id = service;
      const off = $(".item-discount", row)?.value.trim();
      if (off) item[$(".item-discount-type", row).value === "percent" ? "discount_percent" : "discount_amount"] = off;
      return item;
    }),
  };
}
// The same arithmetic as the server (public/ext/documents-calc.mjs).
function updatePreview() {
  const form = $('form[data-form="editor"]');
  if (!form) return;
  const b = editorData(form);
  const priced = b.kind !== "delivery_order";
  const cur = b.currency || "MYR";
  const lines = b.items.map((i) => {
    const rate = priced ? Math.max(0, Math.round(Number(i.rate || 0) * 100) || 0) : 0;
    const q = Math.max(0, Math.round(Number(i.quantity || 0) * 100) || 0);
    const gross = Math.round((rate * q) / 100);
    let off = 0;
    if (priced && i.discount_percent) {
      const bp = basisPoints(i.discount_percent);
      off = bp !== null && bp <= 10000 ? percentOf(gross, bp) : 0;
    } else if (priced && i.discount_amount)
      off = Math.min(gross, Math.max(0, Math.round(Number(i.discount_amount) * 100) || 0));
    return { gross, discount: off, tax_rate: priced ? Number(i.tax_rate || 0) : 0 };
  });
  const existing = S.documents.find((d) => d.id === form.dataset.id);
  const deductions = priced ? (existing?.items || []).filter((i) => i.deposit_id) : [];
  const subtotal = lines.reduce((s, l) => s + l.gross - l.discount, 0);
  const discount = priced ? Math.min(subtotal, Math.max(0, Math.round(Number(b.discount || 0) * 100) || 0)) : 0;
  const r = totals(lines, discount, deductions);
  const taxes = new Map();
  [...r.lines.map((l, n) => ({ tax_rate: lines[n].tax_rate, tax: l.tax })), ...deductions].forEach((x) => {
    if (x.tax_rate) taxes.set(x.tax_rate, (taxes.get(x.tax_rate) || 0) + x.tax);
  });
  const deducted = deductions.reduce((s, x) => s + x.amount, 0);
  $("#live-preview").innerHTML =
    `<div class="preview-paper">${brandMark({ company: "", logo: brand().logo })}<h3>${E(S.settings.company)}</h3><p class="field-hint">${E(S.clients.find((c) => c.id === b.client_id)?.name || "Select a client")}<br>${E(dueLabelFor(labels("en"), b.kind))}: ${E(/^\d{4}-\d{2}-\d{2}$/.test(b.due_date || "") ? dateLabel(b.due_date) : b.due_date || "")}</p><div class="mt22">${b.items.map((i, n) => `<div class="preview-row"><span>${E(i.description || "New line item")}${i.details ? `<div class="line-details-view">${detailsHtml(i.details)}</div>` : ""}${lines[n].discount ? `<small>Line discount −${money(lines[n].discount, cur)}</small>` : ""}</span><strong>${priced ? money(r.lines[n].amount, cur) : E(`${i.quantity || 0} ${i.unit || ""}`)}</strong></div>`).join("")}</div>${priced ? `${discount ? `<div class="preview-row"><span>Discount</span><strong>−${money(discount, cur)}</strong></div>` : ""}${deducted ? `<div class="preview-row"><span>Less deposit</span><strong>${money(deducted, cur)}</strong></div>` : ""}${[...taxes].sort((x, y) => x[0] - y[0]).map(([rate, v]) => `<div class="preview-row"><span>SST ${rate}%</span><strong>${money(v, cur)}</strong></div>`).join("")}<div class="preview-total"><span>Total</span><span class="teal">${money(r.total, cur)}</span></div>` : ""}</div>`;
}
function paymentForm(id) {
  const d = S.documents.find((d) => d.id === id);
  if (!d || d.balance <= 0)
    return toast("This invoice has no remaining balance.", true);
  const cur = d.currency || "MYR";
  showModal(
    "Record payment",
    `<form data-form="payment" data-id="${id}"><div class="notice info"><p>${E(d.number)} / ${E(d.client.name)}<br>Remaining balance: <strong>${money(d.balance, cur)}</strong></p></div><div class="form-grid">${input(`Amount received (${cur})`, "amount", dec(d.balance), "number", true, `min="0.01" max="${dec(d.balance)}" step="0.01"`)}${input("Date received", "paid_date", S.today, "date", true, `max="${S.today}"`)}${select(
      "Payment method",
      "method",
      ["Bank transfer", "Cash", "Card", "Other"].map((v) => [v, v]),
    )}${input("Transaction reference", "reference", "", "text", true, 'maxlength="120"')}${cur !== "MYR" ? `<div class="span-2">${input(`Exchange rate on the day (MYR per 1 ${cur})`, "fx_rate", d.fx_rate, "text", true, 'inputmode="decimal" pattern="\\d{1,6}(\\.\\d{1,6})?"')}<p class="field-hint">The receipt is recorded in ${E(cur)}; reports convert it to MYR at this rate.</p></div>` : ""}<div class="span-2">${area("Internal note", "note", "", 500)}</div>${d.proofs.some((p) => p.status === "pending") ? `<div class="span-2">${select("Match a client reference (optional)", "proof_id", [["", "No submitted reference"], ...d.proofs.filter((p) => p.status === "pending").map((p) => [p.id, p.reference])], "", false)}</div>` : ""}</div><label class="check-row"><input type="checkbox" name="confirmed" required> I have checked that this payment was received.</label>${formEnd("Confirm and create receipt")}</form>`,
  );
}
function reasonForm(title, type, id) {
  showModal(
    title,
    `<form data-form="${type}" data-id="${id}"><p>This action is retained in the audit history.</p>${area("Reason (required)", "reason", "", 500)}${formEnd("Confirm")}</form>`,
  );
  $('textarea[name="reason"]', modal).required = true;
}
function shareModal(id) {
  const d = S.documents.find((d) => d.id === id);
  showModal(
    "Client document link",
    `<p>Anyone with this private link can view this document and download its PDF.</p>${input("Link validity (days)", "linkdays", 30, "number", true, 'min="1" max="90" step="1"')}${d.token_hash ? '<div class="notice warn mt22"><p>Replacing the link will immediately disable the previous link. Keep using your existing link unless a replacement is needed.</p></div>' : ""}<div class="actions mt22">${button(d.token_hash ? "Replace existing link" : "Generate private link", "generate-link", id, true)}${d.token_hash ? button("Revoke existing link", "revoke-link", id) : ""}</div>`,
  );
}
async function runAction(action, id, el) {
  for (const p of plugins) if (await p.action?.(action, id, el)) return;
  if (await workflow.action(action, id)) return;
  if (await advanced.action(action, id)) return;
  switch (action) {
    case "close-modal":
      // Cancel or Close: what was typed in the dialog is not kept.
      autosave?.discardIn(modal);
      modal.close();
      break;
    case "secret-edit":
      secretForm(id);
      break;
    case "secret-clear":
      secretForm(id, true);
      break;
    case "toggle-nav":
      $(".sidebar").classList.toggle("open");
      break;
    case "logout":
      await api("/logout", "POST", {});
      autosave?.clearUser();
      session = null;
      S = null;
      renderLogin();
      break;
    case "new-client":
      clientForm();
      break;
    case "edit-client":
      clientForm(id);
      break;
    case "new-service":
      serviceForm();
      break;
    case "edit-service":
      serviceForm(id);
      break;
    case "new-invoice":
      documentForm();
      break;
    case "client-invoice":
      documentForm("invoice", "", id);
      break;
    case "new-quote":
      documentForm("quote");
      break;
    case "new-proforma":
      documentForm("proforma");
      break;
    case "new-sales-order":
      documentForm("sales_order");
      break;
    case "new-delivery-order":
      documentForm("delivery_order");
      break;
    case "edit-document": {
      const d = S.documents.find((d) => d.id === id);
      documentForm(d.kind, id);
      break;
    }
    case "open-document":
      navigate("document/" + id);
      break;
    case "open-client":
      navigate("client/" + id);
      break;
    case "filter":
      filter = id;
      page = 0;
      renderRoute();
      break;
    case "page":
      page = Math.max(0, Number(id) || 0);
      renderRoute();
      window.scrollTo(0, 0);
      break;
    case "add-line":
      $("#line-items").insertAdjacentHTML("beforeend", lineMarkup());
      updatePreview();
      break;
    case "remove-line":
      if ($$(".line-item").length > 1) {
        el.closest(".line-item").remove();
        updatePreview();
      } else toast("Keep at least one item.");
      break;
    case "issue-document":
      showModal(
        "Issue this document?",
        `<p>Check the client, dates, amounts and terms. ${S.documents.find((x) => x.id === id)?.kind === "quote" ? "Issuing assigns an official number. You can still edit the quotation until the client accepts it." : "Issuing assigns an official number and locks the document."}</p><p class="field-hint">This does not send an email or create a validated MyInvois e-Invoice.</p><div class="form-actions">${button("Cancel", "close-modal")}${button("Issue document", "confirm-issue", id, true)}</div>`,
      );
      break;
    case "confirm-issue":
      await api(`/documents/${id}/issue`, "POST", {});
      modal.close();
      await refresh();
      renderRoute();
      toast("Document issued. You can now share the client link.");
      break;
    case "share-document":
      shareModal(id);
      break;
    case "generate-link": {
      const r = await api(`/documents/${id}/share`, "POST", {
        days: Number(modal.querySelector("[name=linkdays]")?.value || 30),
      });
      generatedLink = r.url;
      modal.close();
      await refresh();
      renderRoute();
      showModal(
        "Private link ready",
        `${input("Client document link", "shareurl", r.url, "url", false, "readonly")}<p class="field-hint">Expires ${timeLabel(new Date(r.expires).toISOString())}. Treat this link as private.</p><div class="actions mt22">${button("Copy link", "copy-link", "", true, "copy")}<a class="btn" href="https://wa.me/?text=${encodeURIComponent("Your Nawlogic document: " + r.url)}" target="_blank" rel="noopener noreferrer">Share via WhatsApp</a></div><p class="field-hint">Sharing opens WhatsApp. Nothing is sent automatically.</p>`,
      );
      break;
    }
    case "copy-link":
      try {
        await navigator.clipboard.writeText(generatedLink);
        toast("Link copied.");
      } catch {
        $('input[name="shareurl"]').select();
        toast("Select and copy the link from the field.");
      }
      break;
    case "revoke-link":
      showModal(
        "Revoke client link?",
        `<p>The current client link will stop working immediately.</p><div class="form-actions">${button("Cancel", "close-modal")}${button("Revoke link", "confirm-revoke", id, true)}</div>`,
      );
      break;
    case "confirm-revoke":
      await api(`/documents/${id}/revoke`, "POST", {});
      modal.close();
      await refresh();
      renderRoute();
      toast("Client link revoked.");
      break;
    case "record-payment":
      paymentForm(id);
      break;
    case "choose-payment": {
      const docs = S.documents.filter(
        (d) => d.kind === "invoice" && d.state === "issued" && d.balance > 0,
      );
      if (!docs.length) {
        toast("There are no unpaid issued invoices.");
        break;
      }
      showModal(
        "Choose invoice",
        `<form data-form="choose-payment">${select(
          "Invoice",
          "invoice_id",
          docs.map((d) => [
            d.id,
            `${d.number} / ${d.client.name} / ${money(d.balance, d.currency)}`,
          ]),
        )}${formEnd("Continue")}</form>`,
      );
      break;
    }
    case "void-document":
      reasonForm("Void document", "void", id);
      break;
    case "reverse-payment":
      reasonForm("Reverse recorded payment", "reverse", id);
      break;
    case "convert-quote": {
      const d = await api(`/documents/${id}/convert`, "POST", {});
      await refresh();
      navigate("document/" + d.id);
      toast("Quotation linked to a draft invoice.");
      break;
    }
    case "delete-draft":
      confirmModal(
        "Delete this draft?",
        "The draft moves to Recently deleted, where you can restore it for 30 days.",
        "confirm-delete-draft",
        id,
        "Delete draft",
      );
      break;
    case "delete-client":
      confirmModal(
        "Delete client?",
        "Only clients with no documents, receipts, schedules or sales records can be deleted; archive a client with history instead. A deleted client can be restored from Recently deleted for 30 days.",
        "confirm-delete-client",
        id,
        "Delete client",
      );
      break;
    case "delete-service":
      confirmModal(
        "Delete service?",
        "Existing documents keep their line text and rates. A service used by a schedule must be marked inactive instead. You can restore it from Recently deleted for 30 days.",
        "confirm-delete-service",
        id,
        "Delete service",
      );
      break;
    case "confirm-delete-draft":
    case "confirm-delete-client":
    case "confirm-delete-service": {
      const target = action.slice("confirm-delete-".length);
      try {
        await api(
          `/${{ draft: "documents", client: "clients", service: "services" }[target]}/${id}`,
          "DELETE",
        );
      } catch (e) {
        modal.querySelector(".form-error").innerHTML = errorHtml(e);
        break;
      }
      modal.close();
      await refresh();
      if (target === "draft") navigate(location.hash.includes("quote") ? "quotes" : "invoices");
      else if (target === "client") navigate("clients");
      else renderRoute();
      toast({ draft: "Draft deleted.", client: "Client deleted.", service: "Service deleted." }[target]);
      break;
    }
    case "archive-client":
    case "restore-client":
      await api(
        `/clients/${id}/${action === "archive-client" ? "archive" : "restore"}`,
        "POST",
        {},
      );
      await refresh();
      renderRoute();
      toast(action === "archive-client" ? "Client archived." : "Client restored.");
      break;
    case "statement-pdf": {
      const f = modal.querySelector("form[data-form=statement]");
      const q = new URLSearchParams({
        from: dateValue(f.from_date),
        to: dateValue(f.to_date),
      });
      location.href = `/api/clients/${id}/statement/pdf?${q}`;
      break;
    }
    case "check-online-payment": {
      const r = await api(`/online-payments/${id}/check`, "POST", {});
      await refresh();
      renderRoute();
      toast(r.state === "paid" ? "Payment confirmed and recorded." : "Still waiting for the client's payment.");
      break;
    }
    case "run-reminders": {
      const r = await api("/reminders/run", "POST", {});
      await refresh();
      renderRoute();
      toast(r.skipped ? "Reminders are turned off." : `${r.sent} reminder(s) sent.`);
      break;
    }
    case "duplicate-document": {
      const d = await api(`/documents/${id}/duplicate`, "POST", {});
      await refresh();
      navigate("document/" + d.id);
      toast("Copy created as a new draft. Review the dates before issuing.");
      break;
    }
    case "public-accept": {
      const t = labels(publicDoc?.language);
      showModal(
        t("acceptQuotation"),
        `<form data-form="accept">${input(t("yourName"), "name", "", "text", true, 'maxlength="120"')}<p>${t("agreeText")}</p><label class="check-row mt22"><input type="checkbox" required> ${t("agree")}</label>${errorBlock()}<div class="form-actions">${button(t("cancel"), "close-modal")}<button class="btn primary" type="submit">${E(t("acceptQuotation"))}</button></div></form>`,
      );
      break;
    }
    case "public-pay": {
      const { url } = await api(`/public/${publicToken()}/checkout`, "POST", {});
      if (/^https:\/\//.test(url)) location.href = url;
      break;
    }
    case "public-reference": {
      const t = labels(publicDoc?.language);
      showModal(
        t("submitReference"),
        `<form data-form="public-reference"><p>${t("referenceText")}</p><div class="mt22">${input(t("bankReference"), "reference", "", "text", true, 'maxlength="120"')}${area(t("messageOptional"), "note", "", 500)}</div>${errorBlock()}<div class="form-actions">${button(t("cancel"), "close-modal")}<button class="btn primary" type="submit">${E(t("submitReference"))}</button></div></form>`,
      );
      break;
    }
  }
}
function publicToken() {
  return location.pathname.match(/^\/client\/([\w-]+)$/)?.[1];
}
async function renderPublic() {
  const token = publicToken();
  try {
    const d = await api(`/public/${token}`);
    publicDoc = d;
    const lang = d.language || "en",
      t = labels(lang),
      cur = d.currency || "MYR",
      m = (v) => money(v, cur),
      dl = (s) => dateIn(lang, s);
    document.documentElement.lang = lang === "zh" ? "zh-Hans" : lang;
    document.title = `${d.number} | Nawlogic`;
    const ext = d.ext?.documents || {};
    const brand = ext.logo
      ? `<img class="logo brand-logo" src="/api/guest/documents/${E(token)}/logo" alt="${E(d.business.company)}">`
      : logo();
    const due = dueLabelFor(t, d.kind);
    const card =
      d.kind === "delivery_order"
        ? `<section class="balance-card"><p>${t("deliveryDate")}</p><div class="value">${dl(d.due_date)}</div></section>`
        : d.kind === "invoice"
          ? d.balance <= 0
            ? `<section class="balance-card paid"><p>${t("status")}</p><div class="value">${E(statusLabel(lang, d.status))}</div><p>${d.status === "Credited" ? t("fullyCredited") : t("thankYou")}</p><p>${t("total")} ${m(d.adjusted_total ?? d.total)} / ${t("paid")} ${m(d.paid)}</p></section>`
            : `<section class="balance-card"><p>${t("balanceDue")}</p><div class="value">${m(d.balance)}</div><p>${d.next_due_date && d.instalments?.length ? E(t("nextPaymentDue", { amount: m(d.next_due_amount), date: dl(d.next_due_date) })) : `${t("due")} ${dl(d.due_date)}`}</p><p>${t("total")} ${m(d.adjusted_total ?? d.total)} / ${t("paid")} ${m(d.paid)}</p></section>`
          : `<section class="balance-card"><p>${d.kind === "quote" ? t("quotationTotal") : t("documentTotal")}</p><div class="value">${m(d.total)}</div><p>${due} ${dl(d.due_date)}</p><p>${t("total")} ${m(d.adjusted_total ?? d.total)}</p></section>`;
    const bankLines = d.business.bankAccount
      ? E(d.business.bankName) + "<br>" + E(d.business.bankHolder) + "<br><strong>" + E(d.business.bankAccount) + "</strong>"
      : E(t("bankMissing"));
    let info;
    if (d.kind === "quote")
      info = `<h2>${t("yourQuotation")}</h2>${d.deposit?.total ? `<p class="mt22">${E(t("depositOf", { value: d.deposit.type === "percent" ? d.deposit.value + "%" : "", amount: m(d.deposit.total) }).replace("  ", " "))}</p>` : ""}${d.state === "accepted" ? `<div class="notice info mt22"><p>${E(t("acceptedBy", { name: d.accepted_name }))}</p></div>` : d.status === "Expired" ? `<p class="mt22">${t("quoteExpired")}</p>` : `<p class="mt22">${t("reviewAccept")}</p><button class="btn primary full" data-action="public-accept">${t("acceptQuotation")}</button>`}`;
    else if (d.kind === "invoice")
      // Settled: the card above already says so; only submitted references remain worth a panel.
      info = `${d.balance <= 0 ? (d.proofs.length ? `<h2>${t("paymentInformation")}</h2>` : "") : `<h2>${t("paymentInformation")}</h2>${d.online_payment && cur === "MYR" ? `<p class="mt22">${E(t("payOnline", { amount: m(d.balance) }))}${d.online_methods ? " (" + E(d.online_methods) + ")" : ""}</p><button class="btn primary full" data-action="public-pay">${t("payOnlineButton")}</button><h3 class="mt22">${t("orBank")}</h3>` : ""}<p class="mt22">${bankLines}</p><p class="field-hint">${E(t("useReference", { number: d.number }))}</p><button class="btn ${d.online_payment && cur === "MYR" ? "" : "primary "}full" data-action="public-reference">${t("submitReference")}</button>`}${d.proofs.length ? `<div class="mt22">${d.proofs.map((p) => `<div class="payment"><strong>${E(p.reference)}</strong><p>${badge(p.status === "pending" ? "Pending review" : p.status === "confirmed" ? "Confirmed" : "Rejected", p.status === "pending" ? t("pendingReview") : p.status === "confirmed" ? t("confirmed") : t("rejected"))}${p.slip ? " Payment slip attached." : ""}</p></div>`).join("")}</div>` : ""}`;
    else if (d.kind === "proforma")
      info = `<h2>${t("paymentInformation")}</h2><p class="mt22">${t("proformaNote")}</p>${d.business.pdfShowBank === false ? "" : `<p class="mt22">${bankLines}</p><p class="field-hint">${E(t("useReference", { number: d.number }))}</p>`}`;
    else info = `<h2>${t("yourDocument")}</h2><p class="mt22">${d.kind === "sales_order" ? t("orderNote") : t("deliveryNote")}</p>`;
    app.innerHTML = `<main class="public-wrap"><header class="public-header">${brand}</header><div class="public-top"><div><h1>${E(t("kind_" + d.kind))} ${E(d.number)}</h1><p>${E(d.client.name)}</p></div><div class="actions">${badge(d.status, statusLabel(lang, d.status))}<a class="btn" href="/api/public/${token}/pdf">${icon("download")} ${t("downloadPdf")}</a></div></div><div class="doc-grid">${paper(d, true)}<aside class="stack">${card}${info ? `<section class="panel">${info}</section>` : ""}${slot("publicPanels", d, token)}</aside></div><footer class="public-footer">${t("privateDocument")} · ${t("poweredBy")}<br>${t("questions")}</footer></main>`;
  } catch (e) {
    app.innerHTML = `<main class="error-page">${logo()}<h1>This document link is unavailable.</h1><p>${E(e.message)}</p><p class="error-tip">${E(e.status === 404 || e.status === 410 ? "The link may be mistyped, replaced by a newer one, or withdrawn by the business. Ask the business that sent it for a new link." : e.tip || errorTip(e.message, e.status) || "Ask the business that sent it for a new link.")}</p></main>`;
  }
}
async function submitForm(form) {
  const type = form.dataset.form,
    b = formValues(form),
    id = form.dataset.id;
  for (const p of plugins) if (await p.submit?.(form, b)) return;
  if (await workflow.submit(form, b)) return;
  if (await advanced.submit(form, b)) return;
  if (type === "secret-save") {
    await api(`/secrets/${id}`, "PUT", {
      value: form.dataset.clear ? null : b.value,
      password: b.password,
      code: b.code,
    });
    modal.close();
    await refresh();
    renderRoute();
    toast(form.dataset.clear ? "Removed." : "Saved.");
    return;
  }
  if (type === "login") {
    session = await api("/login", "POST", b);
    await refresh();
    renderRoute();
    autosave?.showPending($("main.content"));
    return;
  }
  if (type === "client") {
    await api("/clients" + (id ? "/" + id : ""), id ? "PUT" : "POST", b);
    modal.close();
    await refresh();
    renderRoute();
    toast("Client saved.");
    return;
  }
  if (type === "service") {
    await api("/services" + (id ? "/" + id : ""), id ? "PUT" : "POST", {
      ...b,
      active: b.active === "1",
      tax_rate: Number(b.tax_rate || 0),
    });
    modal.close();
    await refresh();
    renderRoute();
    toast("Service saved.");
    return;
  }
  if (type === "editor") {
    const d = await api(
      "/documents" + (id ? "/" + id : ""),
      id ? "PUT" : "POST",
      editorData(form),
    );
    modal.close();
    await refresh();
    navigate("document/" + d.id);
    toast(d.state === "draft" ? "Draft saved. Review before issuing." : `${d.number} updated.`);
    return;
  }
  if (type === "settings") {
    await api("/settings", "PUT", b);
    await refresh();
    renderRoute();
    toast("Workspace settings saved.");
    return;
  }
  if (type === "password") {
    await api("/password", "POST", b);
    session = null;
    S = null;
    renderLogin();
    toast("Password changed. Sign in with your new password.");
    return;
  }
  if (type === "choose-payment") {
    modal.close();
    paymentForm(b.invoice_id);
    return;
  }
  if (type === "payment") {
    await api(`/documents/${id}/payments`, "POST", b);
    modal.close();
    await refresh();
    navigate("document/" + id);
    toast("Payment confirmed. Receipt PDF is ready.");
    return;
  }
  if (type === "void") {
    await api(`/documents/${id}/void`, "POST", b);
    modal.close();
    await refresh();
    renderRoute();
    toast("Document voided; history retained.");
    return;
  }
  if (type === "reverse") {
    await api(`/payments/${id}/reverse`, "POST", b);
    modal.close();
    await refresh();
    renderRoute();
    toast("Payment reversed. Invoice balance updated.");
    return;
  }
  if (type === "sst-report") {
    location.href = `/api/reports/sst.csv?${new URLSearchParams({ from: b.from, to: b.to })}`;
    return;
  }
  if (type === "reminders") {
    await api("/settings", "PUT", {
      remindersEnabled: b.remindersEnabled === "on",
      reminderBeforeDays: Number(b.reminderBeforeDays),
      reminderAfterDays: b.reminderAfterDays,
    });
    await refresh();
    renderRoute();
    toast("Reminder settings saved.");
    return;
  }
  if (type === "accept") {
    await api(`/public/${publicToken()}/accept`, "POST", { ...b, revision: publicDoc?.revision });
    modal.close();
    await renderPublic();
    toast("Quotation accepted.");
    return;
  }
  if (type === "public-reference") {
    await api(`/public/${publicToken()}/payment-reference`, "POST", b);
    modal.close();
    await renderPublic();
    toast("Reference submitted for review.");
    return;
  }
}
document.addEventListener("click", (event) => {
  for (const menu of $$(".dropdown[open]")) if (!menu.contains(event.target)) menu.removeAttribute("open");
});
document.addEventListener("change", (event) => {
  const picker = event.target;
  if (!picker.matches?.(".file-pick input[type=file]")) return;
  const name = picker.closest(".file-row")?.querySelector(".file-name");
  if (name) name.textContent = picker.files?.[0]?.name || name.dataset.empty || "";
});
document.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  // A plain link inside a clickable row (a receipt PDF, for example) is the browser's to follow.
  const link = event.target.closest("a[href]");
  if (link && link !== el && el.contains(link)) return;
  event.preventDefault();
  if (el.disabled) return;
  el.disabled = true;
  try {
    await runAction(el.dataset.action, el.dataset.id, el);
  } catch (e) {
    toast(e, true);
  } finally {
    el.disabled = false;
  }
});
// Date fields: dd/mm/yyyy typing help and the calendar picker.
document.addEventListener("input", (event) => {
  const el = event.target;
  if (!el.matches?.("input[data-date]") || event.inputType !== "insertText") return;
  if (/^\d{2}$/.test(el.value) || /^\d{2}\/\d{2}$/.test(el.value)) el.value += "/";
});
document.addEventListener("focusout", (event) => {
  const el = event.target;
  if (el.matches?.("input[data-date]")) el.value = tidyDmy(el.value);
});
document.addEventListener("click", (event) => {
  const btn = event.target.closest?.(".date-pick");
  if (!btn) return;
  const field = btn.closest(".date-field");
  const text = field.querySelector("input[data-date]"),
    picker = field.querySelector(".date-picker");
  const iso = isoDate(text.value);
  picker.value = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : "";
  try {
    picker.showPicker();
  } catch {
    picker.focus();
    picker.click();
  }
});
document.addEventListener("change", (event) => {
  const picker = event.target;
  if (!picker.matches?.(".date-picker") || !picker.value) return;
  const text = picker.closest(".date-field").querySelector("input[data-date]");
  text.value = dmy(picker.value);
  text.dispatchEvent(new Event("input", { bubbles: true }));
  text.dispatchEvent(new Event("change", { bubbles: true }));
});
document.addEventListener("submit", async (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  const submit = $('button[type="submit"]', form);
  if (submit?.disabled) return;
  const error = $(".form-error", form);
  if (error) error.textContent = "";
  if (submit) submit.disabled = true;
  // Taken before the save, which may replace the form.
  const draftKey = autosave?.submit(form);
  try {
    await submitForm(form);
    autosave?.saved(form, draftKey);
  } catch (e) {
    autosave?.failed(form, draftKey);
    // The error block is shown only if it is still on screen (api() closes the
    // modal when the sign-in has ended).
    if (error && error.isConnected && (modal.open || !modal.contains(error))) error.innerHTML = errorHtml(e);
    else toast(e, true);
    // Only an account that uses two-step sign-in is asked for a code, after its password.
    if (form.dataset.form === "login" && /code/i.test(e.message)) {
      const step = $(".mfa-step", form);
      if (step) {
        step.hidden = false;
        $("input[name=code]", step)?.focus();
      }
    }
  } finally {
    if (submit) submit.disabled = false;
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "document-search") {
    search = event.target.value;
    page = 0;
    $("#document-table").innerHTML = documentTable(
      filteredDocs(event.target.dataset.kind || "invoice"),
    );
  } else if (event.target.closest('form[data-form="editor"]')) updatePreview();
});
// "Use the company default" under the terms of a new document.
document.addEventListener("click", (event) => {
  const reset = event.target.closest?.("[data-terms-default]");
  if (!reset) return;
  const field = reset.closest("form")?.elements.terms;
  if (!field) return;
  field.value = S.settings.paymentTerms || "";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  reset.closest(".terms-hint").textContent = "The company default terms, from Settings.";
});
// Line descriptions: formatting buttons keep the text selection (mousedown),
// paste brings plain text only, and the counter follows what is typed.
document.addEventListener("mousedown", (event) => {
  if (event.target.closest(".details-toolbar [data-fmt]")) event.preventDefault();
});
document.addEventListener("click", (event) => {
  const fmt = event.target.closest(".details-toolbar [data-fmt]");
  if (fmt) {
    const box = $(".item-details", fmt.closest(".line-details"));
    if (document.activeElement !== box) box.focus();
    document.execCommand(fmt.dataset.fmt, false);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  const toggle = event.target.closest("[data-details]");
  if (!toggle) return;
  const row = toggle.closest(".line-item");
  const box = $(".line-details", row);
  const add = $(".details-add", row);
  if (toggle.dataset.details === "add") {
    box.hidden = false;
    add.hidden = true;
    $(".item-details", box).focus();
  } else {
    $(".item-details", box).innerHTML = "";
    box.hidden = true;
    add.hidden = false;
  }
  row.dispatchEvent(new Event("input", { bubbles: true }));
});
document.addEventListener("paste", (event) => {
  const box = event.target.closest?.(".item-details");
  if (!box) return;
  event.preventDefault();
  const text = (event.clipboardData || window.clipboardData).getData("text/plain");
  document.execCommand("insertText", false, text);
});
document.addEventListener("input", (event) => {
  const box = event.target.closest?.(".item-details");
  if (!box) return;
  const used = htmlToDetails(box).length;
  const count = $(".details-count", box.closest(".line-details"));
  if (count) {
    // Over the limit nothing is cut: it says so, and saving is refused until it is shorter.
    count.textContent = `${used} / ${DETAILS_MAX}${used > DETAILS_MAX ? " · too long to save" : ""}`;
    count.classList.toggle("red-text", used > DETAILS_MAX);
  }
});
// Items used before: clicking an empty line title, or typing in one, lists
// lines from saved documents and catalog services (public/ext/line-suggest.mjs).
// One click (or arrows and Enter) fills the title, description, rate, SST,
// code and unit; the quantity stays.
let suggestCache = { docs: null, services: null, list: [] };
const suggestChoices = () => {
  if (suggestCache.docs !== S.documents || suggestCache.services !== S.services)
    suggestCache = { docs: S.documents, services: S.services, list: lineChoices(S.documents, S.services) };
  return suggestCache.list;
};
let suggest = { row: null, items: [], active: -1 };
function closeSuggest() {
  for (const el of document.querySelectorAll(".line-suggest")) el.remove();
  const field = suggest.row && $(".item-description", suggest.row);
  if (field) {
    field.setAttribute("aria-expanded", "false");
    field.removeAttribute("aria-activedescendant");
  }
  suggest = { row: null, items: [], active: -1 };
}
function openSuggest(field) {
  const row = field.closest(".line-item");
  const form = field.closest('form[data-form="editor"]');
  if (!row || !form) return;
  const currency = form.elements.currency?.value || "MYR";
  const items = matchChoices(suggestChoices(), field.value, { currency });
  if (!items.length) return closeSuggest();
  if (suggest.row && suggest.row !== row) closeSuggest();
  let box = $(".line-suggest", row);
  if (!box) {
    box = document.createElement("div");
    box.className = "line-suggest";
    box.id = "line-suggest";
    box.setAttribute("role", "listbox");
    box.setAttribute("aria-label", "Items used before");
    row.append(box);
  }
  const priced = form.dataset.kind !== "delivery_order";
  suggest = { row, items, active: -1 };
  box.innerHTML = `<div class="suggest-head">Items used before</div>${items
    .map(
      (c, n) =>
        `<button type="button" tabindex="-1" class="suggest-item" role="option" id="line-suggest-${n}" data-pick="${n}" aria-selected="false"><span class="suggest-main"><strong>${E(c.title)}</strong>${c.details ? `<small>${E(detailsPlain(c.details).replace(/\s+/g, " ").slice(0, 100))}</small>` : ""}</span><span class="suggest-meta">${priced && c.rate != null ? `<strong>${money(c.rate, c.currency || currency)}</strong>` : ""}<small>${c.source === "catalog" ? "Catalog" : c.uses > 1 ? `Used ${c.uses} times` : "Used once"}</small></span></button>`,
    )
    .join("")}`;
  box.style.top = field.offsetTop + field.offsetHeight + 4 + "px";
  field.setAttribute("aria-expanded", "true");
  field.setAttribute("aria-controls", "line-suggest");
}
function moveSuggest(step) {
  const n = suggest.items.length;
  suggest.active = suggest.active < 0 && step < 0 ? n - 1 : (suggest.active + step + n) % n;
  const field = $(".item-description", suggest.row);
  for (const el of $$(".suggest-item", suggest.row)) {
    const on = Number(el.dataset.pick) === suggest.active;
    el.classList.toggle("active", on);
    el.setAttribute("aria-selected", String(on));
    if (on) {
      el.scrollIntoView({ block: "nearest" });
      field.setAttribute("aria-activedescendant", el.id);
    }
  }
}
function pickSuggestion(n) {
  const c = suggest.items[n];
  const row = suggest.row;
  if (!c || !row) return;
  const form = row.closest("form");
  const rate = $(".item-rate", row);
  closeSuggest();
  const tpl = document.createElement("template");
  tpl.innerHTML = lineMarkup(
    {
      description: c.title,
      details: c.details,
      quantity: $(".item-quantity", row).value || 1,
      rate: c.rate ?? Math.round(Number(rate?.value || 0) * 100),
      tax_rate: c.tax_rate,
      sku: c.sku,
      unit: c.unit,
      service_id: c.service_id,
    },
    form.dataset.kind,
  );
  const fresh = tpl.content.firstElementChild;
  row.replaceWith(fresh);
  const qty = $(".item-quantity", fresh);
  qty.focus();
  qty.select();
  fresh.dispatchEvent(new Event("input", { bubbles: true }));
}
document.addEventListener("focusin", (event) => {
  const field = event.target.closest?.('form[data-form="editor"] .item-description');
  if (field && !field.value.trim()) openSuggest(field);
});
document.addEventListener("input", (event) => {
  const field = event.target.closest?.('form[data-form="editor"] .item-description');
  if (field) openSuggest(field);
});
document.addEventListener("focusout", (event) => {
  if (suggest.row && event.target.matches?.(".item-description")) closeSuggest();
});
document.addEventListener("mousedown", (event) => {
  if (event.target.closest?.(".suggest-item")) event.preventDefault();
});
document.addEventListener("click", (event) => {
  const pick = event.target.closest?.(".suggest-item");
  if (pick) pickSuggestion(Number(pick.dataset.pick));
});
document.addEventListener("keydown", (event) => {
  if (!suggest.row || !event.target.matches?.(".item-description")) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveSuggest(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter" && suggest.active >= 0) {
    event.preventDefault();
    pickSuggestion(suggest.active);
  } else if (event.key === "Escape") {
    // Closes the list only, not the dialog.
    event.preventDefault();
    closeSuggest();
  } else if (event.key === "Tab") closeSuggest();
});
// Client type: the form's labels and fields follow the choice.
document.addEventListener("change", (event) => {
  const kind = event.target.closest?.('form[data-form="client"] input[name=kind]');
  if (kind) kind.form.dataset.clientKind = kind.value;
});
document.addEventListener("change", (event) => {
  if (event.target.id === "catalog-service" && event.target.value) {
    const s = S.services.find((s) => s.id === event.target.value);
    const first = $(".line-item");
    if ($$(".line-item").length === 1 && !$(".item-description", first).value) {
      first.outerHTML = lineMarkup({
        description: s.name,
        details: catalogDetails(s),
        quantity: 1,
        rate: s.rate,
        tax_rate: s.tax_rate,
        service_id: s.id,
        sku: s.sku,
        unit: s.unit,
      });
    } else
      $("#line-items").insertAdjacentHTML(
        "beforeend",
        lineMarkup({
          description: s.name,
          details: catalogDetails(s),
          quantity: 1,
          rate: s.rate,
          tax_rate: s.tax_rate,
          service_id: s.id,
          sku: s.sku,
          unit: s.unit,
        }),
      );
    event.target.value = "";
    updatePreview();
  }
  if (
    event.target.name === "client_id" &&
    event.target.closest('form[data-form="editor"]')
  ) {
    const form = event.target.form,
      c = S.clients.find((c) => c.id === event.target.value);
    if (c) setDateValue(form.elements.due_date, addDays(dateValue(form.elements.issue_date), c.terms));
    const hint = form.querySelector(".client-perks");
    if (hint) hint.textContent = perks(c);
    updatePreview();
  }
});
window.addEventListener("hashchange", () => {
  filter = "All";
  search = "";
  page = 0;
  renderRoute();
  window.scrollTo(0, 0);
});
async function boot() {
  // Guest pages from modules (client portal, password reset, feedback...).
  for (const p of plugins) if (await p.guestPage?.(location)) return;
  if (publicToken()) return renderPublic();
  try {
    session = await api("/session");
    await refresh();
    renderRoute();
    autosave?.showPending($("main.content"));
  } catch (e) {
    if (e.message === "Please sign in.") {
      // The business's own name and logo on the sign-in page, when set.
      await loadBrand();
      renderLogin();
    } else {
      app.innerHTML = `<main class="error-page">${logo()}<h1>Workspace unavailable.</h1><p>${E(e.message)}</p>${e.tip ? `<p class="error-tip">${E(e.tip)}</p>` : ""}<button class="btn" data-action="reload">Retry</button></main>`;
    }
  }
}
document.addEventListener("click", (event) => {
  if (event.target.closest('[data-action="reload"]')) location.reload();
});
// Uploads a File/Blob to /api/files and returns the stored file's details.
async function upload(file, params) {
  const response = await fetch("/api/files?" + new URLSearchParams({ name: file.name || "upload", ...params }), {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-CSRF-Token": session.csrf },
    body: file,
  });
  const data = await response.json().catch(() => ({ error: "Upload failed." }));
  if (!response.ok) throw new Error(data.error || "Upload failed.");
  return data;
}
const uiHelpers = {
  emailPrefill,
  // allowed("view", "money"): whether this person may see company figures.
  allowed,
  get: () => S,
  paper,
  brandMark: () => brandMark(),
  loadBrand: () => loadBrand(),
  logo,
  session: () => session,
  upload,
  slot,
  icons,
  errorBlock,
  confirmModal,
  clientOptions,
  addDays,
  paged,
  invoiceTable,
  reasonForm,
  api,
  refresh,
  renderRoute,
  navigate,
  showModal,
  modal,
  toast,
  E,
  money,
  dec,
  dateLabel,
  timeLabel,
  button,
  badge,
  input,
  formValues,
  dateValue,
  setDateValue,
  area,
  select,
  formEnd,
  heading,
  empty,
  icon,
};
advanced = financeUI(uiHelpers);
workflow = automationUI(uiHelpers);
plugins = UI_PLUGINS.map(([name, make]) => ({ name, ...make(uiHelpers) }));
for (const p of plugins) Object.assign(icons, p.icons || {});
// Esc closes a dialog like Cancel does.
modal.addEventListener("cancel", () => autosave?.discardIn(modal));
// Dialogs opened by these actions can be opened again from the "unsaved changes" list.
const REOPEN = new Set([
  ...["new-invoice", "client-invoice", "new-quote", "new-proforma", "new-sales-order", "new-delivery-order", "edit-document"],
  ...["new-client", "edit-client", "new-service", "edit-service"],
  ...plugins.flatMap((p) => p.autosaveOpeners || []),
]);
autosave = createAutosave({
  user: () => session?.email || null,
  extras: {
    // Modules keep their own line rows (recurring plans, supplier bills...).
    ...Object.assign({}, ...plugins.map((p) => p.autosave || {})),
    // Invoice lines have no field names: kept as a list and rebuilt on restore.
    editor: {
      capture: (form) => editorData(form).items,
      restore: (form, items) => {
        if (!Array.isArray(items) || !items.length) return;
        $("#line-items", form).innerHTML = items
          .map((i) => lineMarkup({ ...i, rate: Math.round(Number(i.rate || 0) * 100) }, form.dataset.kind))
          .join("");
        updatePreview();
      },
    },
  },
  canReopen: (action) => REOPEN.has(action),
  reopen: async (o) => {
    if (o.route && location.hash !== o.route) {
      location.hash = o.route.replace(/^#/, "");
      await new Promise((r) => setTimeout(r, 0));
    }
    if (o.action === "edit-document" && !S.documents.some((d) => d.id === o.id && (d.state === "draft" || (d.kind === "quote" && d.state === "issued"))))
      return toast("That document is no longer editable.", true);
    await runAction(o.action, o.id);
  },
});
boot();
