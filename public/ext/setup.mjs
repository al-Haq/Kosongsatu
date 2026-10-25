// Setup: the first-run checklist on the Overview and optional modules on/off (Settings > Modules).
// The business's own name and logo in the sidebar and on the sign-in page are drawn by public/app.mjs.
// Browser module contract: see docs/PLUGINS.md.
import { MODULES, moduleOff, ownCompany } from "./setup-modules.mjs";
import { OFFER_MFA } from "./features.mjs";

export default function setupUI(h) {
  const { E, icon, badge, api, refresh, renderRoute, toast } = h;
  const S = () => h.get();
  const isOwner = () => {
    const role = S()?.ext?.team?.me?.role;
    return !role || role === "owner";
  };
  const state = () => S().settings.setup || {};
  const skipped = (step) => (state().skipped || []).includes(step);
  const blank = (v) => !String(v ?? "").trim();

  // Each step: whether it is done, one line on why it matters, and a link to the
  // exact place to fix it. focus: what to bring into view there, as selectors or
  // "panel:<Settings section heading>", separated by "|" (the first found wins).
  function steps() {
    const s = S(),
      b = s.settings;
    const company = [
      ["business name", ownCompany(b), "company"],
      ["registration number", b.registration, "registration"],
      ["address", b.address, "address"],
      ["email", b.email, "email"],
      ["phone", b.phone, "phone"],
    ].filter(([, v]) => blank(v));
    const bank = [
      ["bank name", b.bankName, "bankName"],
      ["account number", b.bankAccount, "bankAccount"],
      ["account holder", b.bankHolder, "bankHolder"],
    ].filter(([, v]) => blank(v));
    const field = (name) => `form[data-form="settings"] [name=${name}]`;
    const backup = s.ext?.team?.backup;
    const local = !!backup?.status?.configured;
    const invoices = s.documents.filter((d) => d.kind === "invoice");
    const draft = invoices.find((d) => d.state === "draft");
    return [
      {
        key: "company",
        title: "Company details",
        why: "Your name, registration number and address print on every invoice.",
        done: !company.length,
        missing: company.map(([label]) => label),
        href: "#/settings",
        focus: field(company[0]?.[2] || "company"),
        label: "Add details",
      },
      {
        key: "logo",
        title: "Business logo",
        why: "It goes on your documents, client links and this workspace.",
        done: !!b.logoFileId,
        href: "#/settings",
        focus: 'form[data-form="doc-logo"] input[type=file]|panel:Company',
        label: "Upload logo",
      },
      {
        key: "bank",
        title: "Bank details",
        why: "Clients need your account to pay by transfer.",
        done: !bank.length,
        missing: bank.map(([label]) => label),
        href: "#/settings",
        focus: field(bank[0]?.[2] || "bankName"),
        label: "Add bank details",
      },
      {
        key: "sst",
        title: "SST registration",
        optional: true,
        why: "Add your SST number to charge SST on invoices.",
        done: !blank(b.sstNumber) || skipped("sst"),
        skipped: blank(b.sstNumber) && skipped("sst"),
        skipLabel: "Not registered",
        href: "#/settings",
        focus: field("sstNumber"),
        label: "Add SST number",
      },
      {
        key: "mail",
        title: "Email sending",
        why: "Send invoices, receipts and reminders straight from here.",
        done: !!s.mail?.configured,
        href: "#/settings/integrations",
        focus: '[data-action="secret-edit"][data-id="SMTP_HOST"]|panel:Integration keys',
        label: "Set up email",
      },
      {
        key: "gateway",
        title: "Online payments",
        optional: true,
        why: "Clients pay by FPX, card or e-wallet from the invoice link.",
        done: !!s.gateway?.configured || skipped("gateway"),
        skipped: !s.gateway?.configured && skipped("gateway"),
        skipLabel: "Not now",
        href: "#/settings/payments",
        focus: "panel:Online payments",
        label: "Choose a provider",
      },
      {
        key: "backup",
        title: "Encrypted backups",
        why: local
          ? "Add an off-site copy, so a server failure cannot take your backups too."
          : "Keep encrypted copies of your records, with one off this server.",
        done: local && !!backup?.remote?.configured,
        href: "#/settings/security",
        focus: "panel:Encrypted backups",
        label: local ? "Add off-site copy" : "Set up backups",
      },
      // Two-step sign-in is not offered for now (public/ext/features.mjs).
      ...(OFFER_MFA
        ? [
            {
              key: "mfa",
              title: "Two-step sign-in",
              why: "An authenticator code keeps your account safe if your password leaks.",
              done: !!s.security?.enabled,
              href: "#/settings/security",
              focus: "panel:Authenticator and recovery",
              label: "Turn on MFA",
            },
          ]
        : []),
      {
        key: "first",
        title: "First client and invoice",
        why: "Add a client, then issue your first invoice.",
        done: s.clients.length > 0 && invoices.some((d) => d.state !== "draft"),
        ...(!s.clients.length
          ? { action: "new-client", label: "Add client" }
          : draft
            ? { href: "#/document/" + draft.id, label: "Review draft" }
            : { action: "new-invoice", label: "Create invoice" }),
      },
    ];
  }

  // Stretched to the panel's width: drawn from attributes only (the CSP allows no inline styles).
  const bar = (part) =>
    `<svg class="setup-bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="setup-bar-track" width="100" height="4"/><rect class="setup-bar-fill" width="${(part * 100).toFixed(1)}" height="4"/></svg>`;

  function row(x) {
    const go = x.action
      ? `<button type="button" class="btn small" data-action="${E(x.action)}">${E(x.label)}</button>`
      : `<a class="btn small" href="${E(x.href)}"${x.focus ? ` data-setup-focus="${E(x.focus)}"` : ""}>${E(x.label)}</a>`;
    const todo = go + (x.optional ? `<button type="button" class="btn ghost small" data-action="setup-skip" data-id="${E(x.key)}">${E(x.skipLabel)}</button>` : "");
    const undo = x.skipped
      ? `<span class="setup-note">${E(x.skipLabel)}</span><button type="button" class="link-button" data-action="setup-unskip" data-id="${E(x.key)}">Undo</button>`
      : "";
    return `<li class="setup-step${x.done ? " done" : ""}" data-setup-step="${E(x.key)}"><span class="setup-mark" aria-hidden="true">${x.done ? icon("check") : ""}</span><div class="setup-text"><strong>${x.done ? '<span class="sr-only">Done: </span>' : ""}${E(x.title)}${x.optional ? ' <span class="setup-optional">Optional</span>' : ""}</strong><small>${E(x.why)}</small>${!x.done && x.missing?.length ? `<small class="setup-missing">Missing: ${E(x.missing.join(", "))}</small>` : ""}</div><div class="setup-do">${x.done ? undo : todo}</div></li>`;
  }

  // Shown to the owner until every step is done or they hide it.
  function checklist() {
    if (!isOwner() || state().dismissed) return "";
    const list = steps();
    const done = list.filter((x) => x.done);
    if (done.length === list.length) return "";
    return `<section class="panel setup-panel" aria-labelledby="setup-title"><div class="panel-head"><div><h2 id="setup-title">Set up your workspace</h2><p>${done.length} of ${list.length} done</p></div><button type="button" class="btn ghost small" data-action="setup-dismiss" aria-label="Hide the setup checklist">Hide</button></div>${bar(done.length / list.length)}<ul class="setup-list">${list
      .filter((x) => !x.done)
      .map(row)
      .join("")}</ul>${done.length ? `<details class="setup-done"><summary>Done (${done.length})</summary><ul class="setup-list">${done.map(row).join("")}</ul></details>` : ""}<p class="setup-foot">Not using everything? <a href="#/settings/modules">Turn off modules</a> for a shorter menu.</p></section>`;
  }

  function modulesPanel() {
    if (!isOwner()) return "";
    const b = S().settings;
    const on = MODULES.filter((m) => !moduleOff(b, m.key)).length;
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Modules</h2><p>Turn off what you don't use for a shorter menu. Your records stay, and turning a module back on brings it all back.</p></div>${badge(on === MODULES.length ? "Active" : "Edited", on === MODULES.length ? "All on" : `${on} of ${MODULES.length} on`)}</div><div class="setup-modules">${MODULES.map(
      (m) =>
        `<label class="setup-module"><span class="setup-module-text"><strong>${E(m.label)}</strong><small>${E(m.about)}</small></span><input type="checkbox" role="switch" class="setup-switch" data-setup-module="${E(m.key)}" aria-label="${E(m.label)}" ${moduleOff(b, m.key) ? "" : "checked"}></label>`,
    ).join("")}</div><p class="field-hint">Always on: Overview, quotations and invoices, clients, services, payments, Settings and team. Turning a module off only hides its menu entries, Overview panels and settings: recurring plans, reminders and links you sent keep working.</p>${
      state().dismissed
        ? `<div class="setting-line"><div><h3>Setup checklist</h3><p>Hidden from the Overview.</p></div><button type="button" class="btn" data-action="setup-show">Show again</button></div>`
        : ""
    }</section>`;
  }

  async function save(body, message) {
    await api("/ext/setup", "PUT", body);
    await refresh();
    renderRoute();
    toast(message);
  }

  // Module switches save as soon as they change (they sit outside a form, so
  // nothing is kept as an unsaved draft).
  document.addEventListener("change", async (event) => {
    const el = event.target;
    if (!el.matches?.("input[data-setup-module]")) return;
    const m = MODULES.find((x) => x.key === el.dataset.setupModule);
    const on = el.checked;
    el.disabled = true;
    try {
      await save(
        { modules: { [m.key]: on } },
        on ? `${m.label} is on again.` : `${m.label} is off. Its menu entries are hidden and your records are kept.`,
      );
    } catch (e) {
      el.checked = !on;
      el.disabled = false;
      toast(e.message, true);
    }
  });

  // A checklist link opens the Settings tab, then brings the field or section into view.
  let reveal = null;
  function show() {
    const wanted = reveal;
    reveal = null;
    for (const target of wanted ? wanted.split("|") : []) {
      const el = target.startsWith("panel:")
        ? [...document.querySelectorAll("main section.panel")].find((p) => p.querySelector("h2")?.textContent.trim() === target.slice(6))
        : document.querySelector(target);
      if (!el || el.closest("[hidden]")) continue;
      el.scrollIntoView({ block: "center" });
      if (el.matches("input, select, textarea, button")) el.focus({ preventScroll: true });
      const box = el.closest("section.panel") || el;
      box.classList.add("setup-flash");
      setTimeout(() => box.classList.remove("setup-flash"), 2000);
      return;
    }
  }
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[data-setup-focus]");
    if (!link) return;
    reveal = link.dataset.setupFocus;
    // Already on that page: there is no hashchange to wait for.
    if (location.hash === link.getAttribute("href")) setTimeout(show, 0);
  });
  // Runs after the workspace's own hashchange handler has drawn the page.
  window.addEventListener("hashchange", show);

  return {
    slots: {
      overviewTop: checklist,
      settings: modulesPanel,
    },
    async action(type, id) {
      switch (type) {
        case "setup-dismiss":
          await save({ dismissed: true }, "Checklist hidden. You can show it again under Settings > Modules.");
          return true;
        case "setup-show":
          await save({ dismissed: false }, "The setup checklist is back on the Overview.");
          return true;
        case "setup-skip":
          await save({ skipped: { [id]: true } }, id === "sst" ? "Marked as not registered for SST." : "Skipped for now.");
          return true;
        case "setup-unskip":
          await save({ skipped: { [id]: false } }, "Back on the checklist.");
          return true;
      }
      return false;
    },
  };
}
