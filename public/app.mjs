import { automationUI } from "./automation.mjs";
import { financeUI } from "./finance.mjs";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const app = $("#app"),
  modal = $("#modal");
let advanced, workflow;
const requestKeys = new Map();
let S = null,
  session = null,
  filter = "All",
  search = "",
  toastTimer,
  generatedLink = "";
const E = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (c) =>
  new Intl.NumberFormat("en-MY", { style: "currency", currency: "MYR" }).format(
    (c || 0) / 100,
  );
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
const badge = (s) =>
  `<span class="badge ${{ Paid: "green", Accepted: "green", Active: "green", "Part-paid": "orange", "Pending review": "orange", Overdue: "red", Void: "red", Declined: "red", Viewed: "blue", Issued: "blue", Expired: "orange", Archived: "orange", Sent: "green", Failed: "red", Sending: "blue", Connected: "green" }[s] || ""}"><span class="dot"></span>${E(s)}</span>`;
const button = (label, action, id = "", primary = false, iconName = "") =>
  `<button type="button" class="btn ${primary ? "primary" : ""}" data-action="${action}" data-id="${E(id)}">${iconName ? icon(iconName) : ""}${E(label)}</button>`;
const empty = (title, body = "", cta = "") =>
  `<div class="empty">${icon("doc")}<h2>${E(title)}</h2><p>${E(body)}</p>${cta}</div>`;
function toast(message, error = false) {
  const t = $("#toast");
  t.textContent = message;
  t.className = "show" + (error ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 5500);
}
async function api(path, method = "GET", body) {
  const retryable =
    method === "POST" &&
    /^\/(documents|receipts|bank|clients|services|schedules|sales)/.test(path);
  const requestId = method + ":" + path + ":" + JSON.stringify(body);
  if (retryable && !requestKeys.has(requestId))
    requestKeys.set(requestId, crypto.randomUUID());
  const response = await fetch("/api" + path, {
    method,
    headers: {
      ...(retryable ? { "Idempotency-Key": requestKeys.get(requestId) } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" && session ? { "X-CSRF-Token": session.csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.ok || response.status < 500) requestKeys.delete(requestId);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Server returned an unreadable response.");
  }
  if (!response.ok) {
    if (response.status === 401 && session) {
      session = null;
      S = null;
      modal.close();
      renderLogin();
    }
    throw new Error(data.error || "Request failed.");
  }
  return data;
}
async function refresh() {
  S = await api("/workspace");
}
function showModal(title, body, wide = false) {
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
  `<label>${E(label)}<input name="${name}" type="${type}" value="${E(value)}" ${required ? "required" : ""} ${extra}></label>`;
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
  app.innerHTML = `<div class="login-screen"><section class="login-brand"><span class="eyebrow">NAWLOGIC / BILLING WORKSPACE</span><h1>Good work deserves<br><span class="accent">a clear invoice.</span></h1><p>From the first quotation to the final receipt. A quieter way to keep your business moving.</p><div class="login-points"><span>${icon("doc")}Create with confidence</span><span>${icon("wallet")}Track every payment</span><span>${icon("shield")}Your private workspace</span></div></section><section class="login-form"><div class="login-inner">${logo()}<h2>Welcome back.</h2><p>Sign in to your Nawlogic workspace.</p><form data-form="login">${input("Email address", "email", "", "email", true, 'autocomplete="username" maxlength="160"')}${input("Password", "password", "", "password", true, 'autocomplete="current-password" maxlength="256"')}${input("Authenticator or recovery code (if enabled)", "code", "", "text", false, 'autocomplete="one-time-code" maxlength="40"')}${errorBlock()}<button class="btn primary" type="submit">Sign in ${icon("arrow")}</button></form><div class="login-footer">${icon("shield")} Owner access only. Customer invoices use a separate private link.</div></div></section></div>`;
}
const navItems = [
  ["overview", "Overview", "grid"],
  ["sales", "Sales & POs", "trend"],
  ["automation", "AI & automation", "shield"],
  ["invoices", "Invoices", "doc"],
  ["quotes", "Quotations", "doc"],
  ["clients", "Clients", "users"],
  ["services", "Services", "box"],
  ["recurring", "Recurring", "clock"],
  ["payments", "Payments", "wallet"],
  ["ledger", "Cash & credits", "wallet"],
  ["bank", "Bank matching", "trend"],
  ["settings", "Settings", "settings"],
];
function renderShell(html, active) {
  app.innerHTML = `<div class="shell"><aside class="sidebar">${logo()}<div class="eyebrow">Billing workspace</div><nav aria-label="Main navigation">${navItems.map(([key, name, ic]) => `<a href="#/${key}" class="${key === active ? "active" : ""}" ${key === active ? 'aria-current="page"' : ""}>${icon(ic)}${name}</a>`).join("")}</nav><div class="owner-box"><strong>NAWLOGIC</strong><small>${E(session.email)}</small></div></aside><div class="workspace"><header class="topbar"><div class="top-left"><button class="btn ghost mobile-toggle" data-action="toggle-nav" aria-label="Toggle navigation">${icon("menu")}</button><span class="muted top-label">Nawlogic workspace</span></div><div class="right">${S.settings.demo ? '<span class="badge orange">DEMO DATA</span>' : '<span class="badge green">Owner workspace</span>'}<div class="avatar" aria-label="Owner account">WA</div><button class="btn ghost icon-only" data-action="logout" aria-label="Sign out">${icon("logout")}</button></div></header><main class="content">${S.settings.demo ? '<div class="notice"><p>Demo workspace. All clients, documents and payments are examples.</p></div>' : ""}${html}<p class="footer-note">Nawlogic Invoice · MYR · Kuala Lumpur time · MyInvois and online payment gateway are not connected.</p></main></div></div>`;
}
const heading = (title, sub, actions = "") =>
  `<div class="heading"><div><h1>${E(title)}</h1><p>${E(sub)}</p></div><div class="actions">${actions}</div></div>`;
function invoiceTable(docs) {
  if (!docs.length)
    return empty(
      "No matching documents",
      "Create your first invoice or change the filters.",
    );
  return `<div class="table-wrap"><table><caption class="sr-only">Billing documents</caption><thead><tr><th>Document</th><th>Client</th><th>Due / valid until</th><th class="num">Total</th><th class="num">Balance</th><th>Status</th><th><span class="sr-only">Action</span></th></tr></thead><tbody>${docs.map((d) => `<tr><td><button class="link-button" data-action="open-document" data-id="${d.id}">${E(d.number || "Draft")} ${!d.number ? "<small>" + d.id.slice(0, 8) + "</small>" : ""}</button></td><td>${E(d.client.name)}</td><td>${dateLabel(d.due_date)}</td><td class="num">${money(d.adjusted_total ?? d.total)}</td><td class="num">${d.kind === "quote" || d.state === "void" ? "—" : money(d.balance)}</td><td>${badge(d.status)}</td><td><button class="btn ghost small" data-action="open-document" data-id="${d.id}" aria-label="Open ${E(d.number || "draft")}">${icon("arrow")}</button></td></tr>`).join("")}</tbody></table></div>`;
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
            { paid_date: r.paid_date, amount: r.amount },
            ...r.refunds.map((f) => ({
              paid_date: f.paid_date,
              amount: -f.amount,
            })),
          ],
    );
  const sums = [
    invoices
      .filter((d) => d.issue_date.startsWith(month))
      .reduce((s, d) => s + d.total, 0) +
      S.finance.adjustments
        .filter((a) => a.issue_date.startsWith(month))
        .reduce(
          (sum, a) => sum + (a.kind === "credit" ? -a.amount : a.amount),
          0,
        ),
    payments
      .filter((p) => p.paid_date.startsWith(month))
      .reduce((s, p) => s + p.amount, 0),
    outstanding.reduce((s, d) => s + d.balance, 0),
    overdue.reduce((s, d) => s + d.balance, 0),
  ];
  const weeks = [3, 2, 1, 0].map((n) => {
    const start = addDays(S.today, -n * 7 - 6),
      end = addDays(S.today, -n * 7);
    return {
      label: dateLabel(start).slice(0, 6),
      value: payments
        .filter((p) => p.paid_date >= start && p.paid_date <= end)
        .reduce((s, p) => s + p.amount, 0),
    };
  });
  const max = Math.max(1, ...weeks.map((w) => Math.abs(w.value)));
  return (
    heading(
      "Your billing, at a glance.",
      "A clear view of the work billed, money collected and what needs attention.",
      button("New invoice", "new-invoice", "", true, "plus"),
    ) +
    (!S.settings.bankAccount
      ? `<div class="notice info">${icon("settings")}<p>Add your company details and payment instructions before sharing a real invoice.</p><a href="#/settings">Open settings →</a></div>`
      : "") +
    `<div class="metrics">${["Net invoiced this month", "Net customer cash", "Outstanding", "Overdue"].map((label, i) => `<div class="metric"><span class="metric-icon">${icon(["doc", "wallet", "clock", "trend"][i])}</span><div class="label">${label}</div><div class="value ${i === 1 ? "teal" : i === 3 ? "red-text" : ""}">${money(sums[i])}</div><div class="hint">${["Invoices + debit notes - credit notes", "Receipts less refunds / this month", `${outstanding.length} unpaid invoices / all dates`, `${overdue.length} invoices need attention`][i]}</div></div>`).join("")}</div><div class="grid-2"><section class="panel"><div class="panel-head"><div><h2>Payment collection</h2><p>Net customer cash over the last four weeks</p></div>${badge("MYR")}</div><div class="chart">${weeks.map((w) => `<div class="bar-col"><strong>${money(w.value)}</strong><div class="bar ${w.value < 0 ? "outflow" : ""}" data-height="${Math.round((Math.abs(w.value) / max) * 150) + 3}"></div><span>${w.label}</span></div>`).join("")}</div></section><section class="panel"><div class="panel-head"><div><h2>Needs your attention</h2><p>Outstanding invoices, oldest due first</p></div><a href="#/invoices">View all →</a></div>${
      [...outstanding]
        .sort((a, b) => a.due_date.localeCompare(b.due_date))
        .slice(0, 4)
        .map(
          (d) =>
            `<div class="attention"><div><strong>${E(d.number)}</strong><small>${E(d.client.name)} / ${money(d.balance)}</small><button class="link-button" data-action="open-document" data-id="${d.id}">Review invoice →</button></div>${badge(d.status)}</div>`,
        )
        .join("") || empty("All caught up", "No outstanding issued invoices.")
    }</section></div><section class="panel mt22"><div class="panel-head"><h2>Recent documents</h2><a href="#/invoices">View invoices →</a></div>${invoiceTable(S.documents.slice(0, 5))}</section>`
  );
}
function documentList(kind) {
  const quotes = kind === "quote";
  const data = S.documents.filter((d) => d.kind === kind);
  return (
    heading(
      quotes ? "Quotations" : "Invoices",
      quotes
        ? "Agree on scope, price and terms before starting work."
        : "Create, issue and keep track of every invoice.",
      button(
        quotes ? "New quotation" : "New invoice",
        quotes ? "new-quote" : "new-invoice",
        "",
        true,
        "plus",
      ),
    ) +
    `<div class="tabs" role="group" aria-label="Filter by status">${(quotes ? ["All", "Draft", "Issued", "Accepted", "Expired"] : ["All", "Unpaid", "Overdue", "Paid", "Draft"]).map((t) => `<button class="tab ${t === filter ? "active" : ""}" data-action="filter" data-id="${t}">${t} <span>${t === "All" ? data.length : data.filter((d) => matches(d, t)).length}</span></button>`).join("")}</div><section class="panel"><div class="toolbar"><label class="search"><span class="sr-only">Search documents</span>${icon("search")}<input id="document-search" placeholder="Search invoice number or client" value="${E(search)}"></label>${!quotes ? '<a class="btn" href="/api/invoices.csv">' + icon("download") + " Export CSV</a>" : ""}</div><div id="document-table">${invoiceTable(filteredDocs(kind))}</div><div class="table-foot"><span>${data.length} ${quotes ? "quotations" : "invoices"} in workspace</span><span>All dates / MYR</span></div></section>`
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
      ((d.number || "draft") + " " + d.client.name)
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
}
function clients() {
  return (
    heading(
      "Clients",
      "One place for every contact, quotation and billing history.",
      button("Add client", "new-client", "", true, "plus"),
    ) +
    `<section class="panel">${S.clients.length ? `<div class="table-wrap"><table><thead><tr><th>Client</th><th>Contact</th><th>Payment terms</th><th class="num">Outstanding</th><th>Action</th></tr></thead><tbody>${S.clients.map((c) => `<tr><td><button class="link-button" data-action="open-client" data-id="${c.id}">${E(c.name)}</button><small>${E(c.email)}</small></td><td>${E(c.contact || "—")}</td><td>${c.terms} days${c.archived ? " " + badge("Archived") : ""}</td><td class="num">${money(S.documents.filter((d) => d.client_id === c.id && d.kind === "invoice" && d.state === "issued").reduce((s, d) => s + d.balance, 0))}</td><td>${button("Edit", "edit-client", c.id)}</td></tr>`).join("")}</tbody></table></div>` : empty("Your first client starts here", "Add their billing name and contact details.", button("Add client", "new-client", "", true))}</section>`
  );
}
function clientProfile(id) {
  const c = S.clients.find((c) => c.id === id);
  if (!c) return empty("Client not found");
  return (
    heading(
      c.name,
      "Client profile and billing history.",
      button("Edit client", "edit-client", c.id) +
        (c.archived
          ? button("Restore client", "restore-client", c.id)
          : button("Archive client", "archive-client", c.id)) +
        button("Delete client", "delete-client", c.id) +
        button("Statement", "client-statement", c.id) +
        (c.archived
          ? ""
          : button("New invoice", "client-invoice", c.id, true, "plus")),
    ) +
    `<div class="profile-grid"><section class="panel"><div class="client-avatar">${E(c.name.slice(0, 2).toUpperCase())}</div><h2>${E(c.name)}</h2><dl class="detail"><dt>Billing contact</dt><dd>${E(c.contact || "Not provided")}</dd><dt>Email</dt><dd>${E(c.email || "Not provided")}</dd><dt>Phone</dt><dd>${E(c.phone || "Not provided")}</dd><dt>Billing address</dt><dd>${E(c.address || "Not provided")}</dd><dt>Payment terms</dt><dd>${c.terms} days</dd><dt>Registration / TIN</dt><dd>${E([c.brn, c.tin].filter(Boolean).join(" / ") || "Not provided")}</dd></dl></section><section class="panel"><div class="panel-head"><h2>Documents</h2>${badge("MYR")}</div>${invoiceTable(S.documents.filter((d) => d.client_id === c.id))}</section></div>`
  );
}
function services() {
  return (
    heading(
      "Service catalog",
      "Reusable line items. Tailor the final scope and price for each project.",
      button("Add service", "new-service", "", true, "plus"),
    ) +
    `<section class="panel">${S.services.length ? `<div class="table-wrap"><table><thead><tr><th>Service</th><th>Unit</th><th class="num">Default rate</th><th>Status</th><th>Action</th></tr></thead><tbody>${S.services.map((s) => `<tr><td><strong>${E(s.name)}</strong><small>${E(s.description)}</small></td><td>${E(s.unit)}</td><td class="num">${money(s.rate)}</td><td>${badge(s.active ? "Active" : "Inactive")}</td><td><div class="actions">${button("Edit", "edit-service", s.id)}${button("Delete", "delete-service", s.id)}</div></td></tr>`).join("")}</tbody></table></div>` : empty("Build your service catalog", "Add a service or use custom items directly on an invoice.", button("Add service", "new-service", "", true))}</section>`
  );
}
function recurring() {
  return (
    heading(
      "Recurring billing",
      "Monthly maintenance plans. Generate a draft, then review before issuing.",
      button("New schedule", "new-schedule", "", true, "plus"),
    ) +
    `<section class="panel"><div class="panel-head"><div><h2>Maintenance plans</h2><p>Draft-first mode / no automatic charging or sending</p></div>${badge("Owner review")}</div>${
      S.schedules.length
        ? `<div class="table-wrap"><table><thead><tr><th>Client / plan</th><th>Next run</th><th class="num">Amount</th><th>Status</th><th>Action</th></tr></thead><tbody>${S.schedules
            .map((s) => {
              const c = S.clients.find((c) => c.id === s.client_id),
                service = S.services.find((v) => v.id === s.service_id);
              return `<tr><td><strong>${E(c?.name)}</strong><small>${E(service?.name)}</small></td><td>${dateLabel(s.next_date)}</td><td class="num">${money(service?.rate)}</td><td>${badge(!s.active ? "Paused" : service?.active ? "Active" : "Service inactive")}</td><td><div class="actions">${s.active && service?.active && s.next_date <= S.today ? button("Generate draft", "run-schedule", s.id, true) : ""}${button(s.active ? "Pause" : "Resume", s.active ? "pause-schedule" : "resume-schedule", s.id)}${button("Edit", "edit-schedule", s.id)}${button("Delete", "delete-schedule", s.id)}</div></td></tr>`;
            })
            .join("")}</tbody></table></div>`
        : empty(
            "No recurring plans yet",
            "Create a monthly schedule for an agreed maintenance service.",
          )
    }</section><section class="panel mt22"><div class="panel-head"><h2>How recurring billing works</h2></div><div class="steps">${[
      [
        "01 / SCHEDULE",
        "Generate draft",
        "A due period creates a draft invoice once.",
      ],
      [
        "02 / OWNER",
        "Review & issue",
        "Check scope, service period and final amount.",
      ],
      [
        "03 / CLIENT",
        "Share & collect",
        "Share the invoice and record the payment received.",
      ],
    ]
      .map(
        ([n, t, d]) =>
          `<div class="step"><span class="eyebrow teal">${n}</span><strong>${t}</strong><p>${d}</p></div>`,
      )
      .join("")}</div></section>`
  );
}
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
    heading(
      "Payments",
      "Amounts applied to invoices. Cash & credits shows money received once.",
      button("Record payment", "choose-payment", "", true, "plus"),
    ) +
    (proofs.length
      ? `<section class="panel mb22"><div class="panel-head"><h2>Awaiting review</h2>${badge("Pending review")}</div>${proofs.map((p) => `<div class="attention"><div><strong>${E(p.document.number)} / ${E(p.document.client.name)}</strong><small>Reference: ${E(p.reference)}${p.note ? " / " + E(p.note) : ""}</small></div>${button("Review invoice", "open-document", p.document.id)}</div>`).join("")}</section>`
      : "") +
    `<section class="panel">${all.length ? `<div class="table-wrap"><table><thead><tr><th>Payment / invoice</th><th>Received</th><th>Method</th><th>Reference</th><th class="num">Amount</th><th>Status</th><th>Receipt</th></tr></thead><tbody>${all.map((p) => `<tr><td><button class="link-button" data-action="open-document" data-id="${p.document.id}">${E(p.document.number)}</button><small>${E(p.document.client.name)}</small></td><td>${dateLabel(p.paid_date)}</td><td>${E(p.method)}</td><td>${E(p.reference)}</td><td class="num">${money(p.applied ?? p.amount)}${p.released ? `<small>Released ${money(p.released)}</small>` : ""}</td><td>${badge(p.reversed ? "Reversed" : "Confirmed")}</td><td>${p.reversed ? "—" : `<a class="btn small" href="/api/payments/${p.id}/receipt">${icon("download")} PDF</a>`}</td></tr>`).join("")}</tbody></table></div>` : empty("No payments recorded", "Record a payment only after checking it was received.")}</section>`
  );
}
function settings() {
  const b = S.settings;
  return (
    heading(
      "Workspace settings",
      "Your company identity, document defaults and payment instructions.",
    ) +
    `<div class="grid-equal"><section class="panel"><div class="panel-head"><h2>Brand & company</h2></div>${logo()}<div class="palette"><div class="swatch teal-bg"><span></span>Teal<br>#0EA5A4</div><div class="swatch orange-bg"><span></span>Orange<br>#F97316</div><div class="swatch ink-bg"><span></span>Ink<br>#0F172A</div></div><form data-form="settings"><div class="form-grid">${input("Registered business name", "company", b.company, "text", true, 'maxlength="180"')}${input("Registration number", "registration", b.registration, "text", false, 'maxlength="80"')}${input("Tax identification number (TIN)", "tin", b.tin || "", "text", false, 'maxlength="20"')}${input("SST registration number", "sstNumber", b.sstNumber || "", "text", false, 'maxlength="40"')}${input("Billing email", "email", b.email, "email", false, 'maxlength="160"')}${input("Phone", "phone", b.phone, "text", false, 'maxlength="60"')}<div class="span-2">${area("Business address", "address", b.address, 600)}</div>${input("Invoice prefix", "invoicePrefix", b.invoicePrefix, "text", true, 'pattern="[A-Z][A-Z0-9-]{0,11}" maxlength="12"')}${input("Quotation prefix", "quotePrefix", b.quotePrefix, "text", true, 'pattern="[A-Z][A-Z0-9-]{0,11}" maxlength="12"')}<div class="span-2">${area("Default terms", "paymentTerms", b.paymentTerms)}</div>${input("Bank name", "bankName", b.bankName, "text", false, 'maxlength="100"')}${input("Account number", "bankAccount", b.bankAccount, "text", false, 'maxlength="60"')}<div class="span-2">${input("Account holder", "bankHolder", b.bankHolder, "text", false, 'maxlength="180"')}</div></div>${errorBlock()}<p class="field-hint">Issued documents keep a snapshot of the company and client details. Tax calculation is not configured.</p><div class="form-actions"><button class="btn primary" type="submit">Save settings</button></div></form></section><div class="stack"><section class="panel"><div class="panel-head"><h2>Access & integrations</h2></div><div class="setting-line"><div><h3>Owner access</h3><p>${E(session.email)}</p></div>${badge("Password protected")}</div><div class="setting-line"><div><h3>Client invoice links</h3><p>Document only / 1–90 days / revocable</p></div>${icon("shield")}</div><div class="setting-line"><div><h3>MyInvois / payment gateway</h3><p>Requires separate integration and validation</p></div>${badge("Not connected")}</div><div class="setting-line"><div><h3>Email & scheduled reminders</h3><p>Manual sharing in this release</p></div>${badge("Not connected")}</div></section><section class="panel"><div class="panel-head"><h2>Account password</h2></div><form data-form="password">${input("Current password", "current", "", "password", true, 'autocomplete="current-password"')}${input("New password (at least 12 characters)", "password", "", "password", true, 'minlength="12" maxlength="256" autocomplete="new-password"')}${S.security.enabled ? input("Authenticator or recovery code", "code", "", "text", true, 'autocomplete="one-time-code"') : ""}${errorBlock()}<button type="submit" class="btn">Change password & sign out</button></form></section><section class="panel"><div class="panel-head"><h2>Your business data</h2></div><p>Download a business data export, including documents, payments and audit history. Store it privately.</p><div class="actions mt22"><a class="btn" href="/api/backup">${icon("download")} Export JSON</a><a class="btn" href="/api/invoices.csv">Export CSV</a></div><p class="field-hint">For full disaster recovery, use the encrypted backup and restore procedure in the deployment guide.</p></section></div></div>`
  );
}
function paper(d, publicView = false) {
  const b = d.business,
    c = d.client;
  return `<section class="panel invoice-paper"><div class="paper-head"><div>${logo()}<div class="paper-company"><strong>${E(b.company)}</strong><p>${E([b.registration ? `Reg: ${b.registration}` : "", b.address, b.email, b.phone].filter(Boolean).join("\n"))}</p></div></div><div><h2>${d.kind === "quote" ? "QUOTATION" : "INVOICE"}</h2><p>${E(d.number || "Draft — not issued")}</p></div></div>${b.demo ? '<div class="notice">Demo document. No real transaction.</div>' : ""}<div class="billing-grid"><div><div class="eyebrow">Bill to</div><strong>${E(c.name)}</strong><p>${E([c.contact, c.address].filter(Boolean).join("\n"))}</p></div><div><div class="eyebrow">Document details</div><p>Issue date: ${dateLabel(d.issue_date)}<br>${d.kind === "quote" ? "Valid until" : "Due date"}: ${dateLabel(d.due_date)}<br>Currency: MYR</p></div></div><div class="table-wrap"><table><thead><tr><th>Description</th><th class="num line-qty">Qty</th><th class="num line-rate">Rate</th><th class="num">Amount</th></tr></thead><tbody>${d.items.map((i) => `<tr><td class="quote-scope">${E(i.description)}<small class="mobile-line-meta">${i.quantity} × ${money(i.rate)}</small></td><td class="num line-qty">${i.quantity}</td><td class="num line-rate">${money(i.rate)}</td><td class="num">${money(i.amount)}</td></tr>`).join("")}</tbody></table></div><div class="totals"><div class="total-row"><span>Subtotal</span><strong>${money(d.subtotal)}</strong></div>${d.discount ? `<div class="total-row"><span>Discount</span><strong>−${money(d.discount)}</strong></div>` : ""}${taxRows(d.items)}<div class="total-row emphasis"><span>Original total</span><span>${money(d.total)}</span></div>${d.credit ? `<div class="total-row"><span>Credit notes</span><strong>−${money(d.credit)}</strong></div>` : ""}${d.debit ? `<div class="total-row"><span>Debit notes</span><strong>+${money(d.debit)}</strong></div>` : ""}${d.credit || d.debit ? `<div class="total-row emphasis"><span>Adjusted total</span><span>${money(d.adjusted_total)}</span></div>` : ""}${d.kind === "invoice" ? `<div class="total-row"><span>Paid</span><strong>${money(d.paid)}</strong></div><div class="total-row emphasis"><span>Balance due</span><span>${money(d.balance)}</span></div>` : ""}</div>${d.kind === "invoice" && d.state !== "void" ? `<div class="paper-notes"><h3>Payment information</h3>${b.bankAccount ? `<p>${E([b.bankName, b.bankHolder, b.bankAccount].filter(Boolean).join("\n"))}</p><p>Reference: ${E(d.number || "Not yet issued")}</p>` : "<p>Bank details are not configured. Contact Nawlogic before paying.</p>"}</div>` : ""}${d.terms ? `<div class="paper-notes"><h3>Terms</h3><p>${E(d.terms)}</p></div>` : ""}${d.notes ? `<div class="paper-notes"><h3>Notes</h3><p>${E(d.notes)}</p></div>` : ""}${publicView ? '<p class="field-hint">Business document. Not a validated MyInvois e-Invoice.</p>' : ""}</section>`;
}
function taxRows(items) {
  const by = new Map();
  for (const i of items)
    if (i.tax_rate) by.set(i.tax_rate, (by.get(i.tax_rate) || 0) + (i.tax || 0));
  return [...by]
    .sort((a, b) => a[0] - b[0])
    .map(([r, v]) => `<div class="total-row"><span>SST ${r}%</span><strong>${money(v)}</strong></div>`)
    .join("");
}
function sstPanel() {
  const from = addDays(S.today, -60);
  return `<section class="panel mt22"><div class="panel-head"><div><h2>SST summary</h2><p>${S.settings.sstNumber ? "SST No. " + E(S.settings.sstNumber) : "Add your SST registration number above to charge SST."}</p></div>${badge(S.settings.sstNumber ? "Active" : "Not connected")}</div><form data-form="sst-report"><div class="form-grid">${input("From", "from", from, "date", true)}${input("To", "to", S.today, "date", true)}</div><p class="field-hint">Taxable value and SST by rate for issued invoices, by issue date. Use it to prepare the SST-02 return; credit and debit notes are listed for manual review.</p><div class="form-actions"><button class="btn primary" type="submit">Download CSV</button></div></form></section>`;
}
function emailHistory(list) {
  if (!list.length) return "";
  return `<section class="panel"><div class="panel-head"><h2>Emails</h2></div>${list
    .slice(0, 8)
    .map(
      (m) =>
        `<div class="payment"><div class="payment-top"><strong>${E(m.subject)}</strong>${badge(m.status === "sent" ? "Sent" : m.status === "failed" ? "Failed" : "Sending")}</div><p>${E(m.recipients)}<br>${timeLabel(m.created)}${m.kind === "reminder" ? " / automatic reminder" : ""}</p>${m.error ? `<p>${E(m.error)}</p>` : ""}</div>`,
    )
    .join("")}</section>`;
}
function remindersPanel() {
  const b = S.settings;
  return `<section class="panel mt22"><div class="panel-head"><div><h2>Email & payment reminders</h2><p>${S.mail.configured ? "Sending from " + E(S.mail.from) : "Email is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM on the server."}</p></div>${badge(S.mail.configured ? "Connected" : "Not connected")}</div><form data-form="reminders"><label class="check-row"><input type="checkbox" name="remindersEnabled" ${b.remindersEnabled ? "checked" : ""} ${S.mail.configured ? "" : "disabled"}> Send automatic reminders for unpaid invoices to the client's email.</label><div class="form-grid">${input("Days before due date (0 = none)", "reminderBeforeDays", b.reminderBeforeDays ?? 3, "number", true, 'min="0" max="30" step="1"')}${input("Days after due date (comma separated)", "reminderAfterDays", b.reminderAfterDays ?? "1,7,14", "text", true, 'pattern="\\s*\\d{1,3}(\\s*,\\s*\\d{1,3}){0,4}\\s*" maxlength="40"')}</div><p class="field-hint">Each invoice gets each reminder once. A missed reminder is skipped after 2 days instead of being sent late. Reminders attach the invoice PDF and your bank details.</p>${errorBlock()}<div class="form-actions">${S.mail.configured ? button("Send due reminders now", "run-reminders") : ""}<button class="btn primary" type="submit">Save reminders</button></div></form>${emailHistory(S.emailLog.filter((m) => m.kind === "reminder")).replace("<h2>Emails</h2>", "<h2>Recent reminders</h2>")}</section>`;
}
function emailForm(id) {
  const d = S.documents.find((d) => d.id === id);
  if (!S.mail.configured) {
    toast("Email is not configured on the server. Use the client link instead.", true);
    return;
  }
  showModal(
    "Email " + (d.kind === "quote" ? "quotation" : "invoice"),
    `<form data-form="email-document" data-id="${E(id)}">${input("To", "to", d.client.email || "", "text", true, 'maxlength="600" placeholder="client@example.com"')}${input("Cc (optional)", "cc", "", "text", false, 'maxlength="600"')}${input("Subject", "subject", `${d.kind === "quote" ? "Quotation" : "Invoice"} ${d.number} from ${d.business.company}`, "text", true, 'maxlength="200"')}${area("Message (optional)", "message", "", 4000)}<label class="check-row"><input type="checkbox" name="include_link"> Include a private online link. This replaces any existing link for this document.</label>${input("Link validity (days)", "link_days", 30, "number", true, 'min="1" max="90" step="1"')}<p class="field-hint">The PDF is attached. Separate addresses with commas.</p>${formEnd("Send email")}</form>`,
  );
}
function statementForm(id) {
  const c = S.clients.find((c) => c.id === id);
  showModal(
    "Statement of account",
    `<form data-form="statement" data-id="${E(id)}"><div class="form-grid">${input("From", "from_date", addDays(S.today, -90), "date", true)}${input("To", "to_date", S.today, "date", true, `max="${S.today}"`)}</div><div class="actions mt22">${button("Download PDF", "statement-pdf", id)}</div>${S.mail.configured ? `${input("Email to", "to", c.email || "", "text", true, 'maxlength="600"')}${area("Message (optional)", "message", "", 4000)}${formEnd("Email statement")}` : `<p class="field-hint">Email is not configured; download the PDF to send it yourself.</p>${errorBlock()}`}</form>`,
  );
}
function documentView(id) {
  const d = S.documents.find((d) => d.id === id);
  if (!d) return empty("Document not found");
  const actions =
    (d.state === "draft"
      ? button("Edit draft", "edit-document", id) +
        button("Delete draft", "delete-draft", id) +
        button("Issue document", "issue-document", id, true)
      : d.state === "void"
        ? ""
        : button("Client link", "share-document", id, true, "copy") +
          button("Email", "email-document", id)) +
    button("Duplicate", "duplicate-document", id) +
    `<a class="btn" href="/api/documents/${id}/pdf">${icon("download")} PDF</a>`;
  const events = S.audit.filter((a) => a.entity_id === id).slice(0, 8);
  return (
    heading(
      d.number || `Draft ${d.kind === "quote" ? "quotation" : "invoice"}`,
      d.client.name,
      actions,
    ) +
    `<div class="doc-grid">${paper(d)}<div class="stack">${advanced.documentExtras(d)}<section class="panel"><div class="panel-head"><h2>Document status</h2>${badge(d.status)}</div><div class="total-row"><span>Document total</span><strong>${money(d.total)}</strong></div>${d.kind === "invoice" ? `<div class="total-row"><span>Confirmed payments</span><strong>${money(d.paid)}</strong></div><div class="total-row emphasis"><span>Balance</span><span>${money(d.balance)}</span></div>` : ""}${d.state === "draft" ? '<p class="field-hint">Review the client, dates, amounts and terms before issuing. Issuing locks the document.</p>' : ""}${d.kind === "invoice" && d.state === "issued" && d.balance > 0 ? `<div class="actions mt22">${button("Record payment", "record-payment", id, true, "plus")}</div>` : ""}${d.kind === "quote" && d.state === "accepted" ? `<p class="field-hint">Accepted by ${E(d.accepted_name)}</p><div class="mt22">${button("Create / open invoice", "convert-quote", id, true)}</div>` : ""}${d.token_hash ? `<div class="mt22">${button("Revoke client link", "revoke-link", id)}</div>` : ""}${d.state !== "void" ? `<div class="mt22">${button("Void document", "void-document", id)}</div>` : ""}</section>${
      d.proofs.filter((p) => p.status === "pending").length
        ? `<section class="panel"><div class="panel-head"><h2>Awaiting review</h2>${badge("Pending review")}</div>${d.proofs
            .filter((p) => p.status === "pending")
            .map(
              (p) =>
                `<div class="payment"><strong>${E(p.reference)}</strong><p>${E(p.note || "Client submitted a transaction reference.")}<br>${timeLabel(p.created)}</p><p>Check your bank account before recording a payment.</p>${button("Reject reference", "reject-proof", p.id)}</div>`,
            )
            .join("")}</section>`
        : ""
    }${d.kind === "invoice" ? `<section class="panel"><div class="panel-head"><h2>Payment history</h2></div>${d.payments.map((p) => `<div class="payment"><div class="payment-top"><strong>${money(p.amount)}</strong>${badge(p.reversed ? "Reversed" : "Confirmed")}</div><p>${dateLabel(p.paid_date)} / ${E(p.method)}<br>Reference: ${E(p.reference)}</p>${p.reversed ? `<p>Reversal: ${E(p.reversal_reason)}</p>` : `<div class="payment-actions"><a href="/api/payments/${p.id}/receipt">Receipt PDF</a><button class="link-button red-text" data-action="reverse-payment" data-id="${p.id}">Reverse</button></div>`}</div>`).join("") || "<p>No payments recorded yet.</p>"}</section>` : ""}${emailHistory(S.emailLog.filter((m) => m.document_id === id))}<section class="panel"><div class="panel-head"><h2>Activity</h2></div><div class="timeline">${events.map((e) => `<div class="timeline-item"><strong>${E(e.action.replaceAll(".", " "))}</strong><small>${timeLabel(e.created)} / ${E(e.actor || "system")}</small>${e.detail ? `<p>${E(e.detail)}</p>` : ""}</div>`).join("") || "<p>No activity yet.</p>"}</div></section></div></div>`
  );
}
function renderRoute() {
  if (!session || !S) return;
  const [rawPage, id] = location.hash.replace(/^#\/?/, "").split("/");
  const page = rawPage || "overview";
  let html,
    active = page;
  switch (page) {
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
    case "recurring":
      html = recurring();
      break;
    case "ledger":
      html = advanced.ledger();
      break;
    case "bank":
      html = advanced.bank();
      break;
    case "payments":
      html = payments();
      break;
    case "settings":
      html = settings() + sstPanel() + remindersPanel() + advanced.security();
      break;
    case "document":
      html = documentView(id);
      active =
        S.documents.find((d) => d.id === id)?.kind === "quote"
          ? "quotes"
          : "invoices";
      break;
    default:
      html = empty(
        "Page not found",
        "Use the navigation to return to your workspace.",
      );
  }
  renderShell(html, active);
  $$("[data-height]").forEach((el) => {
    el.style.height = el.dataset.height + "px";
  });
}
function navigate(route) {
  if (location.hash === "#/" + route) renderRoute();
  else location.hash = "/" + route;
}
function clientForm(id) {
  const c = S.clients.find((c) => c.id === id) || { terms: 14 };
  showModal(
    id ? "Edit client" : "Add client",
    `<form data-form="client" data-id="${E(id || "")}"><div class="form-grid">${input("Billing name", "name", c.name, "text", true, 'maxlength="160"')}${input("Contact person", "contact", c.contact, "text", false, 'maxlength="120"')}${input("Email", "email", c.email, "email", false, 'maxlength="160"')}${input("Phone", "phone", c.phone, "text", false, 'maxlength="60"')}${input("Registration / IC number", "brn", c.brn || "", "text", false, 'maxlength="40"')}${input("Tax identification number (TIN)", "tin", c.tin || "", "text", false, 'maxlength="20"')}${input("SST registration (if any)", "sst_number", c.sst_number || "", "text", false, 'maxlength="40"')}<div class="span-2">${area("Billing address", "address", c.address, 600)}</div>${input("Payment terms (days)", "terms", c.terms, "number", true, 'min="0" max="365" step="1"')}</div>${formEnd("Save client")}</form>`,
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
      ["Project", "Month", "Hour", "Day", "Item"].map((v) => [v, v]),
      s.unit,
    )}${input("Rate (MYR)", "rate", dec(s.rate), "number", true, 'min="0" max="99999999.99" step="0.01"')}${select(
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
const sstEnabled = () => !!S.settings.sstNumber;
function lineMarkup(i = { description: "", quantity: 1, rate: 0 }) {
  const tax = Number(i.tax_rate || 0);
  return `<div class="line-item"><textarea aria-label="Line description" class="item-description" rows="1" maxlength="240" required>${E(i.description)}</textarea><input aria-label="Quantity" class="item-quantity" type="number" min="0.01" max="99999.99" step="0.01" value="${i.quantity}" required><input aria-label="Rate MYR" class="item-rate" type="number" min="0" max="99999999.99" step="0.01" value="${dec(i.rate)}" required>${sstEnabled() ? `<select aria-label="SST rate" class="item-tax">${TAX_RATES.map((r) => `<option value="${r}" ${r === tax ? "selected" : ""}>${r ? r + "%" : "No SST"}</option>`).join("")}</select>` : ""}<button class="btn ghost" type="button" data-action="remove-line" aria-label="Remove item">${icon("close")}</button></div>`;
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
  const value = d || {
    client_id: c.id,
    issue_date: S.today,
    due_date: addDays(S.today, c.terms),
    items: [{ description: "", quantity: 1, rate: 0 }],
    discount: 0,
    notes: "",
    terms: S.settings.paymentTerms,
  };
  showModal(
    d ? "Edit draft" : kind === "quote" ? "New quotation" : "New invoice",
    `<form data-form="editor" data-id="${E(id)}" data-kind="${kind}"><div class="editor-grid ${sstEnabled() ? "with-tax" : ""}"><div><div class="form-grid"><div class="span-2">${select("Bill to", "client_id", clientOptions(value.client_id), value.client_id)}</div>${input("Issue date", "issue_date", value.issue_date, "date", true)}${input(kind === "quote" ? "Valid until" : "Due date", "due_date", value.due_date, "date", true)}</div><div class="line-head"><span>DESCRIPTION</span><span>QTY</span><span>RATE (MYR)</span>${sstEnabled() ? "<span>SST</span>" : ""}<span></span></div><div id="line-items">${value.items.map(lineMarkup).join("")}</div><div class="actions mt22">${button("Custom item", "add-line", "", "", "plus")}<label class="catalog-picker"><span class="sr-only">Add service from catalog</span><select id="catalog-service"><option value="">Add from catalog...</option>${S.services
      .filter((s) => s.active)
      .map(
        (s) =>
          `<option value="${s.id}">${E(s.name)} / ${money(s.rate)}</option>`,
      )
      .join(
        "",
      )}</select></label></div><div class="mt22">${input("Discount (MYR)", "discount", dec(value.discount), "number", true, 'min="0" max="99999999.99" step="0.01"')}${area("Payment / project terms", "terms", value.terms)}${area("Notes", "notes", value.notes, 2000)}</div></div><aside class="preview"><div class="eyebrow mb22">Live preview / draft</div><div id="live-preview"></div><p class="field-hint">${sstEnabled() ? "MYR. SST is calculated per line after discount. The saved document is authoritative." : "MYR. Add your SST registration number in Settings to charge SST."} This preview is not a validated e-Invoice.</p></aside></div>${formEnd("Save draft & review")}</form>`,
    true,
  );
  updatePreview();
}
function editorData(form) {
  const b = Object.fromEntries(new FormData(form));
  return {
    kind: form.dataset.kind,
    ...b,
    items: $$(".line-item", form).map((row) => ({
      description: $(".item-description", row).value,
      quantity: $(".item-quantity", row).value,
      rate: $(".item-rate", row).value,
      tax_rate: Number($(".item-tax", row)?.value || 0),
    })),
  };
}
function updatePreview() {
  const form = $('form[data-form="editor"]');
  if (!form) return;
  const b = editorData(form);
  const items = b.items.map((i) => ({
    ...i,
    amount: Math.max(
      0,
      Math.round(
        (Math.round(Number(i.rate || 0) * 100) *
          Math.round(Number(i.quantity || 0) * 100)) /
          100,
      ) || 0,
    ),
  }));
  const subtotal = items.reduce((s, i) => s + i.amount, 0);
  const discount = Math.round(Number(b.discount || 0) * 100);
  // Mirrors the server's allocateDiscount: shares by line amount, remainders by largest fraction.
  const off = Math.min(Math.max(discount, 0), subtotal);
  const shares = items.map((i) => (subtotal ? Number((BigInt(off) * BigInt(i.amount)) / BigInt(subtotal)) : 0));
  if (subtotal) {
    let left = off - shares.reduce((s, v) => s + v, 0);
    const order = items
      .map((i, n) => [(BigInt(off) * BigInt(i.amount)) % BigInt(subtotal), i.amount, n])
      .sort((x, y) => (x[0] === y[0] ? y[1] - x[1] : x[0] < y[0] ? 1 : -1));
    for (const [, a, n] of order) {
      if (!left) break;
      if (shares[n] < a) {
        shares[n]++;
        left--;
      }
    }
  }
  const taxes = new Map();
  items.forEach((i, n) => {
    if (i.tax_rate)
      taxes.set(
        i.tax_rate,
        (taxes.get(i.tax_rate) || 0) +
          Math.round(((i.amount - shares[n]) * i.tax_rate) / 100),
      );
  });
  const tax = [...taxes.values()].reduce((s, v) => s + v, 0);
  $("#live-preview").innerHTML =
    `<div class="preview-paper">${logo()}<h3>${E(S.settings.company)}</h3><p class="field-hint">${E(S.clients.find((c) => c.id === b.client_id)?.name || "Select a client")}<br>Due / valid until: ${E(b.due_date)}</p><div class="mt22">${items.map((i) => `<div class="preview-row"><span>${E(i.description || "New line item")}</span><strong>${money(i.amount)}</strong></div>`).join("")}</div>${discount ? `<div class="preview-row"><span>Discount</span><strong>−${money(discount)}</strong></div>` : ""}${[...taxes].map(([r, v]) => `<div class="preview-row"><span>SST ${r}%</span><strong>${money(v)}</strong></div>`).join("")}<div class="preview-total"><span>Total</span><span class="teal">${money(subtotal - discount + tax)}</span></div></div>`;
}
function paymentForm(id) {
  const d = S.documents.find((d) => d.id === id);
  if (!d || d.balance <= 0)
    return toast("This invoice has no remaining balance.", true);
  showModal(
    "Record payment",
    `<form data-form="payment" data-id="${id}"><div class="notice info"><p>${E(d.number)} / ${E(d.client.name)}<br>Remaining balance: <strong>${money(d.balance)}</strong></p></div><div class="form-grid">${input("Amount received (MYR)", "amount", dec(d.balance), "number", true, `min="0.01" max="${dec(d.balance)}" step="0.01"`)}${input("Date received", "paid_date", S.today, "date", true, `max="${S.today}"`)}${select(
      "Payment method",
      "method",
      ["Bank transfer", "Cash", "Card", "Other"].map((v) => [v, v]),
    )}${input("Transaction reference", "reference", "", "text", true, 'maxlength="120"')}<div class="span-2">${area("Internal note", "note", "", 500)}</div>${d.proofs.some((p) => p.status === "pending") ? `<div class="span-2">${select("Match a client reference (optional)", "proof_id", [["", "No submitted reference"], ...d.proofs.filter((p) => p.status === "pending").map((p) => [p.id, p.reference])], "", false)}</div>` : ""}</div><label class="check-row"><input type="checkbox" name="confirmed" required> I have checked that this payment was received.</label>${formEnd("Confirm & create receipt")}</form>`,
  );
}
function scheduleForm(sid) {
  const s = S.schedules.find((x) => x.id === sid);
  if (s) {
    showModal(
      "Edit monthly schedule",
      `<form data-form="schedule" data-id="${E(sid)}"><p>${E(S.clients.find((c) => c.id === s.client_id)?.name || "")}</p>${select("Monthly service", "service_id", [["", "Select a service"], ...S.services.filter((v) => v.active || v.id === s.service_id).map((v) => [v.id, `${v.name} / ${money(v.rate)}`])], s.service_id)}<div class="form-grid">${input("Next run date", "next_date", s.next_date, "date", true)}${input("Payment terms (days)", "terms", s.terms, "number", true, 'min="0" max="365" step="1"')}</div><label class="check-row"><input type="checkbox" name="month_end" ${s.month_end ? "checked" : ""}>Bill on the last day of each month.</label>${formEnd("Save schedule")}</form>`,
    );
    return;
  }
  if (!S.clients.length || !S.services.some((s) => s.active)) {
    toast("Add a client and an active service first.");
    return;
  }
  showModal(
    "New monthly schedule",
    `<form data-form="schedule">${select("Client", "client_id", clientOptions())}${select("Monthly service", "service_id", [["", "Select a service"], ...S.services.filter((s) => s.active).map((s) => [s.id, `${s.name} / ${money(s.rate)}`])])}<div class="form-grid">${input("First run date", "next_date", S.today, "date", true)}${input("Payment terms (days)", "terms", 14, "number", true, 'min="0" max="365" step="1"')}</div><label class="check-row"><input type="checkbox" name="month_end">Bill on the last day of each month.</label><div class="notice info"><p>Monthly / draft-first. Generating a draft does not send an invoice or charge the client.</p></div>${formEnd("Save schedule")}</form>`,
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
    `<p>Anyone with this private link can view this document and download its PDF.</p>${input("Link validity (days)", "linkdays", 30, "number", true, 'min="1" max="90" step="1"')}${d.token_hash ? '<div class="notice mt22"><p>Replacing the link will immediately disable the previous link. Keep using your existing link unless a replacement is needed.</p></div>' : ""}<div class="actions mt22">${button(d.token_hash ? "Replace existing link" : "Generate private link", "generate-link", id, true)}${d.token_hash ? button("Revoke existing link", "revoke-link", id) : ""}</div>`,
  );
}
async function runAction(action, id, el) {
  if (await workflow.action(action, id)) return;
  if (await advanced.action(action, id)) return;
  switch (action) {
    case "close-modal":
      modal.close();
      break;
    case "toggle-nav":
      $(".sidebar").classList.toggle("open");
      break;
    case "logout":
      await api("/logout", "POST", {});
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
      renderRoute();
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
        `<p>Check the client, dates, amounts and terms. Issuing assigns an official number and locks the document.</p><p class="field-hint">This does not send an email or create a validated MyInvois e-Invoice.</p><div class="form-actions">${button("Cancel", "close-modal")}${button("Issue document", "confirm-issue", id, true)}</div>`,
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
            `${d.number} / ${d.client.name} / ${money(d.balance)}`,
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
    case "new-schedule":
      scheduleForm();
      break;
    case "edit-schedule":
      scheduleForm(id);
      break;
    case "delete-schedule":
      confirmModal(
        "Delete schedule?",
        "Only schedules that never generated an invoice can be deleted. Pause a used schedule instead.",
        "confirm-delete-schedule",
        id,
        "Delete schedule",
      );
      break;
    case "delete-draft":
      confirmModal(
        "Delete this draft?",
        "The draft is removed permanently. The deletion is kept in the audit history.",
        "confirm-delete-draft",
        id,
        "Delete draft",
      );
      break;
    case "delete-client":
      confirmModal(
        "Delete client?",
        "Only clients with no documents, receipts, schedules or sales records can be deleted. Archive a client with history instead.",
        "confirm-delete-client",
        id,
        "Delete client",
      );
      break;
    case "delete-service":
      confirmModal(
        "Delete service?",
        "Existing documents keep their line text and rates. A service used by a schedule must be marked inactive instead.",
        "confirm-delete-service",
        id,
        "Delete service",
      );
      break;
    case "confirm-delete-schedule":
    case "confirm-delete-draft":
    case "confirm-delete-client":
    case "confirm-delete-service": {
      const target = action.slice("confirm-delete-".length);
      try {
        await api(
          `/${{ schedule: "schedules", draft: "documents", client: "clients", service: "services" }[target]}/${id}`,
          "DELETE",
        );
      } catch (e) {
        modal.querySelector(".form-error").textContent = e.message;
        break;
      }
      modal.close();
      await refresh();
      if (target === "draft") navigate(location.hash.includes("quote") ? "quotes" : "invoices");
      else if (target === "client") navigate("clients");
      else renderRoute();
      toast("Deleted. The audit history keeps a record.");
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
    case "email-document":
      emailForm(id);
      break;
    case "client-statement":
      statementForm(id);
      break;
    case "statement-pdf": {
      const f = modal.querySelector("form[data-form=statement]");
      const q = new URLSearchParams({
        from: f.from_date.value,
        to: f.to_date.value,
      });
      location.href = `/api/clients/${id}/statement/pdf?${q}`;
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
    case "run-schedule": {
      const d = await api(`/schedules/${id}/run`, "POST", {});
      await refresh();
      navigate("document/" + d.id);
      toast("Recurring draft created. Review before issuing.");
      break;
    }
    case "pause-schedule":
    case "resume-schedule":
      await api(
        `/schedules/${id}/${action === "pause-schedule" ? "pause" : "resume"}`,
        "POST",
        {},
      );
      await refresh();
      renderRoute();
      toast("Schedule updated.");
      break;
    case "public-accept":
      showModal(
        "Accept quotation",
        `<form data-form="accept">${input("Your full name", "name", "", "text", true, 'maxlength="120"')}<p>Please confirm that you agree to the scope, price and terms in this quotation.</p><label class="check-row mt22"><input type="checkbox" required> I agree to the quotation.</label>${formEnd("Accept quotation")}</form>`,
      );
      break;
    case "public-reference":
      showModal(
        "Submit payment reference",
        `<form data-form="public-reference"><p>This reference will be reviewed by Nawlogic. Your invoice remains unpaid until the payment is confirmed.</p><div class="mt22">${input("Bank transaction reference", "reference", "", "text", true, 'maxlength="120"')}${area("Message (optional)", "note", "", 500)}</div>${formEnd("Submit reference")}</form>`,
      );
      break;
  }
}
function publicToken() {
  return location.pathname.match(/^\/client\/([\w-]+)$/)?.[1];
}
async function renderPublic() {
  const token = publicToken();
  try {
    const d = await api(`/public/${token}`);
    document.title = `${d.number} | Nawlogic`;
    app.innerHTML = `<main class="public-wrap"><header class="public-header">${logo()}<span class="badge">Private client document</span></header><div class="public-top"><div><h1>${d.kind === "quote" ? "Quotation" : "Invoice"} ${E(d.number)}</h1><p>${E(d.client.name)} / ${badge(d.status)}</p></div><div class="actions"><a class="btn" href="/api/public/${token}/pdf">${icon("download")} Download PDF</a></div></div><div class="doc-grid">${paper(d, true)}<aside class="stack"><section class="balance-card"><p>${d.kind === "quote" ? "Quotation total" : "Balance due"}</p><div class="value">${money(d.kind === "quote" ? d.total : d.balance)}</div><p>${d.kind === "quote" ? "Valid until" : "Due"} ${dateLabel(d.due_date)}</p><p>Total ${money(d.adjusted_total ?? d.total)}${d.kind === "invoice" ? " / Paid " + money(d.paid) : ""}</p></section><section class="panel"><h2>${d.kind === "quote" ? "Your quotation" : "Payment information"}</h2>${d.kind === "quote" ? (d.state === "accepted" ? `<div class="notice info mt22"><p>Accepted by ${E(d.accepted_name)}. Nawlogic will follow up with the next step.</p></div>` : d.status === "Expired" ? '<p class="mt22">This quotation has expired. Contact Nawlogic for an updated quotation.</p>' : `<p class="mt22">Review the scope and terms. Accept when you are ready to proceed.</p><button class="btn primary full" data-action="public-accept">Accept quotation</button>`) : d.balance <= 0 ? `<div class="notice info mt22"><p>${d.status === "Credited" ? "This invoice is fully credited. No payment is due." : "Thank you. No further payment is due."}</p></div>` : `<p class="mt22">${d.business.bankAccount ? E(d.business.bankName) + "<br>" + E(d.business.bankHolder) + "<br><strong>" + E(d.business.bankAccount) + "</strong>" : "Bank details are not configured. Contact Nawlogic before paying."}</p><p class="field-hint">Use ${E(d.number)} as the bank transfer reference.</p><button class="btn primary full" data-action="public-reference">Submit payment reference</button>`}${d.proofs.length ? `<div class="mt22">${d.proofs.map((p) => `<div class="payment"><strong>${E(p.reference)}</strong><p>${badge(p.status === "pending" ? "Pending review" : p.status === "confirmed" ? "Confirmed" : "Rejected")}</p></div>`).join("")}</div>` : ""}</section></aside></div><footer class="public-footer">Powered by Nawlogic · Keep your document link private.<br>Questions? Contact Nawlogic using the contact details on your document.</footer></main>`;
  } catch (e) {
    app.innerHTML = `<main class="error-page">${logo()}<h1>This document link is unavailable.</h1><p>${E(e.message)} Contact Nawlogic for a new link.</p></main>`;
  }
}
async function submitForm(form) {
  const type = form.dataset.form,
    b = Object.fromEntries(new FormData(form)),
    id = form.dataset.id;
  if (await workflow.submit(form, b)) return;
  if (await advanced.submit(form, b)) return;
  if (type === "login") {
    session = await api("/login", "POST", b);
    await refresh();
    renderRoute();
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
    toast("Draft saved. Review before issuing.");
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
  if (type === "email-document") {
    await api(`/documents/${id}/email`, "POST", {
      ...b,
      include_link: b.include_link === "on",
      link_days: Number(b.link_days),
    });
    modal.close();
    await refresh();
    renderRoute();
    toast("Email sent.");
    return;
  }
  if (type === "statement") {
    await api(`/clients/${id}/statement/email`, "POST", b);
    modal.close();
    await refresh();
    toast("Statement emailed.");
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
  if (type === "schedule") {
    await api(id ? "/schedules/" + id : "/schedules", id ? "PUT" : "POST", {
      ...b,
      month_end: b.month_end === "on",
    });
    modal.close();
    await refresh();
    renderRoute();
    toast(id ? "Schedule updated." : "Monthly schedule created.");
    return;
  }
  if (type === "accept") {
    await api(`/public/${publicToken()}/accept`, "POST", b);
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
document.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  event.preventDefault();
  if (el.disabled) return;
  el.disabled = true;
  try {
    await runAction(el.dataset.action, el.dataset.id, el);
  } catch (e) {
    toast(e.message, true);
  } finally {
    el.disabled = false;
  }
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
  try {
    await submitForm(form);
  } catch (e) {
    if (error && error.isConnected) error.textContent = e.message;
    else toast(e.message, true);
  } finally {
    if (submit) submit.disabled = false;
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "document-search") {
    search = event.target.value;
    $("#document-table").innerHTML = invoiceTable(
      filteredDocs(location.hash.includes("quotes") ? "quote" : "invoice"),
    );
  } else if (event.target.closest('form[data-form="editor"]')) updatePreview();
});
document.addEventListener("change", (event) => {
  if (event.target.id === "catalog-service" && event.target.value) {
    const s = S.services.find((s) => s.id === event.target.value);
    const first = $(".line-item");
    if ($$(".line-item").length === 1 && !$(".item-description", first).value) {
      first.outerHTML = lineMarkup({
        description: s.description || s.name,
        quantity: 1,
        rate: s.rate,
        tax_rate: s.tax_rate,
      });
    } else
      $("#line-items").insertAdjacentHTML(
        "beforeend",
        lineMarkup({
          description: s.description || s.name,
          quantity: 1,
          rate: s.rate,
          tax_rate: s.tax_rate,
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
    if (c)
      form.elements.due_date.value = addDays(
        form.elements.issue_date.value,
        c.terms,
      );
    updatePreview();
  }
});
window.addEventListener("hashchange", () => {
  filter = "All";
  search = "";
  renderRoute();
  window.scrollTo(0, 0);
});
async function boot() {
  if (publicToken()) return renderPublic();
  try {
    session = await api("/session");
    await refresh();
    renderRoute();
  } catch (e) {
    if (e.message === "Please sign in.") renderLogin();
    else {
      app.innerHTML = `<main class="error-page">${logo()}<h1>Workspace unavailable.</h1><p>${E(e.message)}</p><button class="btn" data-action="reload">Retry</button></main>`;
    }
  }
}
document.addEventListener("click", (event) => {
  if (event.target.closest('[data-action="reload"]')) location.reload();
});
const uiHelpers = {
  get: () => S,
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
  area,
  select,
  formEnd,
  heading,
  empty,
  icon,
};
advanced = financeUI(uiHelpers);
workflow = automationUI(uiHelpers);
boot();
