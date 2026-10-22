// Recurring billing: weekly to yearly schedules, multi-line plans, auto-issue and auto-send, late fees, contracts and retainers, monthly accountant report.
// Browser module contract: see docs/PLUGINS.md.
const TAX_RATES = [0, 5, 6, 8, 10];
export default function recurringUI(h) {
  const { get, api, refresh, renderRoute, navigate, showModal, modal, toast, E, money, dec, dateLabel, timeLabel } = h;
  const { button, input, area, select, formEnd, heading, empty, errorBlock, confirmModal, clientOptions } = h;
  const R = () =>
    get().ext?.recurring || {
      plans: [],
      contracts: [],
      frequencies: [],
      modes: {},
      renewals: {},
      lateFees: {},
      exemptClients: [],
      holds: [],
      charges: [],
      pack: {},
      packs: [],
    };
  const tag = (label, color = "") => `<span class="badge ${color}"><span class="dot"></span>${E(label)}</span>`;
  const PLAN_COLORS = { Active: "green", Due: "blue", "Needs attention": "red", Paused: "", Ended: "" };
  const planTag = (p) => tag(p.status, PLAN_COLORS[p.status]);
  const CONTRACT = { active: ["Active", "green"], expiring: ["Expiring", "orange"], ended: ["Ended", ""], cancelled: ["Cancelled", "red"] };
  const contractTag = (c) => tag(...CONTRACT[c.display_status]);
  const clientName = (id) => get().clients.find((c) => c.id === id)?.name || "—";
  const modeLabel = (m) => R().modes[m] || m;
  const STEP = { generate: "Creating the invoice", issue: "Issuing the invoice", send: "Emailing the invoice" };
  const SEND = { sent: ["Emailed", "green"], failed: ["Email failed", "red"], sending: ["Sending", "blue"] };
  const plan = (id) => R().plans.find((p) => p.id === id);
  const contract = (id) => R().contracts.find((c) => c.id === id);
  const runFor = (invoiceId) => {
    for (const p of R().plans) {
      const r = p.runs.find((x) => x.invoice_id === invoiceId);
      if (r) return { ...r, plan: p };
    }
    return null;
  };
  const sstOn = () => !!get().settings.sstNumber;
  const lineAmount = (l) => Math.round((Math.round(Number(l.rate || 0) * 100) * Math.round(Number(l.quantity || 0) * 100)) / 100) || 0;
  const days = (n) => `${n} day${Math.abs(n) === 1 ? "" : "s"}`;
  const policyApplies = (d) => {
    const f = R().lateFees;
    return (
      !!f.enabled &&
      d.kind === "invoice" &&
      ["draft", "issued"].includes(d.state) &&
      (!f.since || d.issue_date >= f.since) &&
      !R().exemptClients.includes(d.client_id) &&
      !R().holds.includes(d.id) &&
      !(f.type === "fixed" && d.currency && d.currency !== "MYR")
    );
  };
  const mutate = async (fn, message, route) => {
    const out = await fn();
    if (modal.open) modal.close();
    await refresh();
    if (route) navigate(route);
    else renderRoute();
    if (message) toast(typeof message === "function" ? message(out) : message);
    return out;
  };

  // ---- Plans -------------------------------------------------------------
  function tabs(active) {
    return `<div class="tabs rec-tabs" role="group" aria-label="Recurring sections">${[
      ["recurring", "Plans", R().plans.length],
      ["recurring/contracts", "Contracts", R().contracts.length],
    ]
      .map(([href, label, n]) => `<a class="tab ${active === label ? "active" : ""}" href="#/${href}">${label} <span>${n}</span></a>`)
      .join("")}</div>`;
  }
  function plansPage() {
    const r = R();
    const attention = r.plans.filter((p) => p.last_error);
    return (
      heading(
        "Recurring billing",
        "Plans that bill a client weekly, monthly, quarterly or yearly.",
        button("Run due plans now", "rec-job", "recurring:schedules") + button("New plan", "rec-plan-new", "", true, "plus"),
      ) +
      tabs("Plans") +
      (attention.length
        ? `<section class="panel mb22"><div class="panel-head"><div><h2>Needs attention</h2><p>Automatic billing stopped for these plans until you look at them.</p></div>${tag("Needs attention", "red")}</div>${attention
            .map(
              (p) =>
                `<div class="attention"><div><strong>${E(p.title)} / ${E(clientName(p.client_id))}</strong><small>${E(STEP[p.last_error_step] || "Automation")}: ${E(p.last_error)}</small><a class="link-button" href="#/plan/${E(p.id)}">Review plan →</a></div>${p.last_error_at ? `<small class="muted">${timeLabel(p.last_error_at)}</small>` : ""}</div>`,
            )
            .join("")}</section>`
        : "") +
      `<section class="panel">${
        r.plans.length
          ? `<div class="table-wrap"><table class="rec-table"><caption class="sr-only">Recurring plans</caption><thead><tr><th>Plan / client</th><th>Frequency</th><th>Next run</th><th class="num">Amount</th><th>Automation</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${r.plans
              .map(
                (p) =>
                  `<tr><td><a class="link-button" href="#/plan/${E(p.id)}">${E(p.title)}</a><small>${E(clientName(p.client_id))} / ${p.lines.length} line${p.lines.length === 1 ? "" : "s"}</small></td><td>${E(p.frequency_label)}</td><td>${p.status === "Ended" ? "—" : dateLabel(p.next_date)}<small>${p.status === "Ended" ? "Ended " + dateLabel(p.effective_end) : E(p.next_label)}</small></td><td class="num">${p.amount === null ? "—" : money(p.amount)}</td><td>${E(modeLabel(p.mode))}</td><td>${planTag(p)}</td><td><div class="actions">${planActions(p)}</div></td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : empty("No recurring plans yet", "Create a plan for maintenance, hosting or a retainer that you bill on a schedule.", button("New plan", "rec-plan-new", "", true))
      }</section>` +
      `<section class="panel mt22"><div class="panel-head"><h2>How recurring billing works</h2></div><div class="steps">${[
        ["01 / PLAN", "Lines and frequency", "Choose services or custom lines, how often to bill and when to start."],
        ["02 / AUTOMATIC", "Billed once per period", "A check every hour creates each due invoice once: as a draft, or issued and emailed if you turn that on."],
        ["03 / OWNER", "Problems wait for you", "If something stops an invoice, the plan shows it here and nothing is retried until you look."],
      ]
        .map(([n, t, d]) => `<div class="step"><span class="eyebrow teal">${n}</span><strong>${t}</strong><p>${d}</p></div>`)
        .join("")}</div></section>`
    );
  }
  // The list keeps the everyday actions; Delete is on the plan page.
  function planActions(p, full = false) {
    const due = p.active && p.status !== "Ended" && p.next_date <= get().today;
    return (
      (due ? button("Run now", "rec-plan-run", p.id, true) : "") +
      button("Edit", "rec-plan-edit", p.id) +
      button(p.active ? "Pause" : "Resume", p.active ? "rec-plan-pause" : "rec-plan-resume", p.id) +
      (full && !p.runs.length ? button("Delete", "rec-plan-delete", p.id) : "")
    );
  }
  function planView(id) {
    const p = plan(id);
    if (!p) return empty("Plan not found", "It may have been deleted.");
    const c = p.contract_id ? contract(p.contract_id) : null;
    const errorRun = p.runs.find((r) => r.error_step && r.error_step === p.last_error_step);
    const notice = p.last_error
      ? `<div class="notice error rec-notice" role="alert"><div><p><strong>${E(STEP[p.last_error_step] || "Automation")} failed</strong>${p.last_error_at ? " · " + timeLabel(p.last_error_at) : ""}</p><p>${E(p.last_error)}</p><p>${
          p.last_error_step === "generate"
            ? "The plan waits until you try again or edit it."
            : p.last_error_step === "issue"
              ? "The draft invoice was created. Fix the problem, then issue it from the invoice."
              : "The invoice was issued but not emailed. Fix the problem, then send it again."
        }</p></div><div class="actions">${
          p.last_error_step === "generate"
            ? button("Try again", "rec-plan-retry", p.id, true)
            : p.last_error_step === "send" && errorRun
              ? button("Send again", "rec-send-run", errorRun.invoice_id, true)
              : errorRun
                ? button("Open invoice", "open-document", errorRun.invoice_id, true)
                : ""
        }${button("Dismiss", "rec-plan-dismiss", p.id)}</div></div>`
      : "";
    const lines = p.lines
      .map(
        (l) =>
          `<tr><td>${E(l.description)}${l.service_id ? `<small>Catalog service</small>` : ""}</td><td class="num">${E(l.quantity)}</td><td class="num">${money(l.rate)}</td>${sstOn() || p.tax ? `<td class="num">${l.tax_rate ? l.tax_rate + "%" : "—"}</td>` : ""}<td class="num">${money(lineAmount({ rate: l.rate / 100, quantity: l.quantity }))}</td></tr>`,
      )
      .join("");
    const history = p.runs.length
      ? `<div class="table-wrap"><table><thead><tr><th>Period</th><th>Invoice</th><th>Status</th><th>Email</th></tr></thead><tbody>${p.runs
          .map((r) => {
            const send = SEND[r.send_status];
            return `<tr><td>${E(r.label)}<small>${dateLabel(r.period)}</small></td><td><button class="link-button" data-action="open-document" data-id="${E(r.invoice_id)}">${E(r.number || "Draft")}</button>${r.total ? `<small>${money(r.total)}</small>` : ""}</td><td>${tag(r.state === "issued" ? "Issued" : r.state === "void" ? "Void" : "Draft", r.state === "issued" ? "blue" : r.state === "void" ? "red" : "")}${r.error && r.error_step !== "send" ? `<small class="red-text">${E(r.error)}</small>` : ""}${r.note ? `<small>${E(r.note)}</small>` : ""}</td><td>${send ? tag(...send) : "—"}${r.send_status === "failed" ? `<small class="red-text">${E(r.error || "")}</small>${r.state === "issued" ? button("Send again", "rec-send-run", r.invoice_id) : ""}` : ""}</td></tr>`;
          })
          .join("")}</tbody></table></div>`
      : `<p class="field-hint">No invoices yet. The first one is due ${dateLabel(p.next_date)}.</p>`;
    return (
      heading(p.title, `${clientName(p.client_id)} · ${p.frequency_label}`, planActions(p, true)) +
      notice +
      `<div class="doc-grid"><section class="panel"><div class="panel-head"><div><h2>Plan lines</h2><p>The next invoice reads “${E(p.lines[0]?.description.includes("{period}") ? p.lines[0].description.replace("{period}", p.next_label) : (p.lines[0]?.description || "") + " – " + p.next_label)}”.</p></div>${planTag(p)}</div><div class="table-wrap"><table><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th>${sstOn() || p.tax ? '<th class="num">SST</th>' : ""}<th class="num">Amount</th></tr></thead><tbody>${lines}</tbody></table></div><div class="totals">${p.discount ? `<div class="total-row"><span>Discount</span><strong>−${money(p.discount)}</strong></div>` : ""}${p.tax ? `<div class="total-row"><span>SST</span><strong>${money(p.tax)}</strong></div>` : ""}<div class="total-row emphasis"><span>Each invoice</span><span>${p.amount === null ? "—" : money(p.amount)}</span></div></div>${p.notes ? `<div class="paper-notes"><h3>Notes</h3><p>${E(p.notes)}</p></div>` : ""}${p.terms_text ? `<div class="paper-notes"><h3>Terms</h3><p>${E(p.terms_text)}</p></div>` : ""}</section><div class="stack"><section class="panel"><div class="panel-head"><h2>Schedule</h2></div><dl class="detail"><dt>Client</dt><dd><a href="#/client/${E(p.client_id)}">${E(clientName(p.client_id))}</a></dd><dt>Frequency</dt><dd>${E(p.frequency_label)}${p.unit === "month" ? (p.month_end ? " · last day of the month" : ` · on day ${E(p.anchor_day)}`) : ""}</dd><dt>Next run</dt><dd>${p.status === "Ended" ? "Ended" : `${dateLabel(p.next_date)} · ${E(p.next_label)}`}</dd><dt>Ends</dt><dd>${p.effective_end ? dateLabel(p.effective_end) + (c && p.effective_end !== p.end_date ? " (contract)" : "") : "No end date"}</dd><dt>Payment terms</dt><dd>${E(p.terms)} days</dd><dt>Automation</dt><dd>${E(modeLabel(p.mode))}${p.mode === "send" ? `<br><small>To ${E(p.send_to || get().clients.find((x) => x.id === p.client_id)?.email || "the client (no email yet)")}${p.include_link ? " · with a private link" : ""}</small>` : ""}</dd><dt>Contract</dt><dd>${c ? `<a href="#/contract/${E(c.id)}">${E(c.title)}</a> ${contractTag(c)}` : "None"}</dd></dl></section></div></div>` +
      `<section class="panel mt22"><div class="panel-head"><div><h2>Invoices from this plan</h2><p>Each period is billed once.</p></div></div>${history}</section>`
    );
  }
  function lineRow(l = { description: "", quantity: 1, rate: 0, tax_rate: 0, service_id: "" }) {
    const services = get().services.filter((s) => s.active || s.id === l.service_id);
    return `<div class="rec-line"><select aria-label="Service" data-field="service_id"><option value="">Custom line</option>${services
      .map((s) => `<option value="${E(s.id)}" ${s.id === l.service_id ? "selected" : ""}>${E(s.name)}</option>`)
      .join("")}</select><input aria-label="Description" data-field="description" maxlength="200" required value="${E(l.description)}"><input aria-label="Quantity" data-field="quantity" type="number" min="0.01" max="99999.99" step="0.01" required value="${E(l.quantity)}"><input aria-label="Rate MYR" data-field="rate" type="number" min="0" max="99999999.99" step="0.01" required value="${dec(l.rate)}">${
      sstOn()
        ? `<select aria-label="SST rate" data-field="tax_rate">${TAX_RATES.map((r) => `<option value="${r}" ${Number(l.tax_rate || 0) === r ? "selected" : ""}>${r ? r + "%" : "No SST"}</option>`).join("")}</select>`
        : ""
    }<button type="button" class="btn ghost small" data-action="rec-line-remove" aria-label="Remove line">${h.icon("close")}</button></div>`;
  }
  const contractOptions = (clientId, selected = "") => [
    ["", "No contract"],
    ...R()
      .contracts.filter((c) => c.client_id === clientId && (c.status !== "cancelled" || c.id === selected))
      .map((c) => [c.id, `${c.title} (to ${dateLabel(c.end_date)})`]),
  ];
  function planForm(id = "", clientId = "") {
    const S = get();
    const p = id ? plan(id) : null;
    if (!p && !S.clients.some((c) => !c.archived)) return toast("Add a client first.", true);
    const v = p || {
      client_id: clientId || "",
      title: "",
      frequency: "monthly",
      next_date: S.today,
      terms: S.clients.find((c) => c.id === clientId)?.terms ?? 14,
      end_date: "",
      contract_id: "",
      month_end: 0,
      lines: [{ description: "", quantity: 1, rate: 0, tax_rate: 0, service_id: "" }],
      discount: 0,
      notes: "",
      terms_text: "",
      mode: "draft",
      send_to: "",
      include_link: 0,
      runs: [],
    };
    const freqs = R().frequencies.map((f) => [f.key, f.label]);
    if (p && !p.frequency) freqs.push(["", p.frequency_label]);
    showModal(
      p ? "Edit recurring plan" : "New recurring plan",
      `<form data-form="rec-plan" data-id="${E(id)}" class="rec-plan-form"><div class="form-grid">${
        p && p.runs.length
          ? `<div class="span-2"><input type="hidden" name="client_id" value="${E(p.client_id)}"><p class="field-hint">Client</p><p><strong>${E(clientName(p.client_id))}</strong></p></div>`
          : `<div class="span-2">${select("Client", "client_id", clientOptions(v.client_id), v.client_id)}</div>`
      }${input("Plan name", "title", v.title, "text", false, 'maxlength="120" placeholder="e.g. Managed maintenance"')}${select("Frequency", "frequency", freqs, v.frequency || "")}${input(p ? "Next run date" : "First run date", "next_date", v.next_date, "date", true)}${input("Payment terms (days)", "terms", v.terms, "number", true, 'min="0" max="365" step="1"')}${input("End date (optional)", "end_date", v.end_date || "", "date")}${select("Contract", "contract_id", contractOptions(v.client_id, v.contract_id || ""), v.contract_id || "", false)}</div><label class="check-row"><input type="checkbox" name="month_end" ${v.month_end ? "checked" : ""}> Bill on the last day of the month (month-based plans)</label><div class="rec-lines-head mt22"><h3>Lines</h3>${button("Add line", "rec-line-add", "", false, "plus")}</div><div class="rec-lines ${sstOn() ? "with-tax" : ""}"><div class="rec-line rec-line-labels" aria-hidden="true"><span>SERVICE</span><span>DESCRIPTION</span><span>QTY</span><span>RATE (MYR)</span>${sstOn() ? "<span>SST</span>" : ""}<span></span></div><div class="rec-lines-body">${v.lines
        .map((l) => lineRow({ ...l, rate: l.rate }))
        .join("")}</div></div><p class="field-hint">Each line gets the service period, e.g. “Maintenance – Nov 2026”, or a date range for weekly plans. Write {period} to place it yourself.</p><div class="form-grid mt22">${input("Discount (MYR)", "discount", dec(v.discount || 0), "number", false, 'min="0" max="99999999.99" step="0.01"')}<div class="rec-estimate"><span class="field-hint">Each invoice (before SST)</span><strong data-estimate>${money(0)}</strong></div><div class="span-2">${area("Notes on each invoice", "notes", v.notes || "", 2000)}</div><div class="span-2">${area("Terms (leave blank to use your default terms)", "terms_text", v.terms_text || "", 1000)}</div></div><h3 class="mt22">Automation</h3>${select("When a period is due", "mode", Object.entries(R().modes), v.mode)}<div class="form-grid">${input("Email to (optional)", "send_to", v.send_to || "", "text", false, 'maxlength="600" placeholder="Client email by default"')}<label class="check-row rec-link-check"><input type="checkbox" name="include_link" ${v.include_link ? "checked" : ""}> Include a private client link in the email</label></div><div class="notice info"><p>A check every hour bills each due period once. Issuing and emailing happen only if you choose them here, are kept in the audit history, and stop for your review if anything goes wrong. ${R().mail ? "" : "Email is not configured yet, so emailing would fail until SMTP is set up."}</p></div>${formEnd(p ? "Save plan" : "Create plan")}</form>`,
      true,
    );
    const form = modal.querySelector("form[data-form=rec-plan]");
    const estimate = () => {
      const rows = [...form.querySelectorAll(".rec-lines-body .rec-line")].map((row) => ({
        rate: row.querySelector('[data-field="rate"]').value,
        quantity: row.querySelector('[data-field="quantity"]').value,
      }));
      const total = rows.reduce((s, l) => s + lineAmount(l), 0) - Math.round(Number(form.elements.discount.value || 0) * 100);
      form.querySelector("[data-estimate]").textContent = money(Math.max(0, total));
    };
    form.addEventListener("input", estimate);
    form.addEventListener("change", (event) => {
      const t = event.target;
      if (t.dataset.field === "service_id" && t.value) {
        const s = get().services.find((x) => x.id === t.value);
        const row = t.closest(".rec-line");
        row.querySelector('[data-field="description"]').value = s.name;
        row.querySelector('[data-field="rate"]').value = dec(s.rate);
        const tax = row.querySelector('[data-field="tax_rate"]');
        if (tax) tax.value = String(s.tax_rate || 0);
      }
      if (t.name === "client_id") {
        const c = get().clients.find((x) => x.id === t.value);
        if (c && !p) form.elements.terms.value = c.terms;
        form.elements.contract_id.innerHTML = contractOptions(t.value)
          .map(([value, label]) => `<option value="${E(value)}">${E(label)}</option>`)
          .join("");
      }
      estimate();
    });
    estimate();
  }
  function planPayload(form, b) {
    const lines = [...form.querySelectorAll(".rec-lines-body .rec-line")].map((row) => {
      const f = (name) => row.querySelector(`[data-field="${name}"]`)?.value;
      return {
        service_id: f("service_id") || null,
        description: f("description"),
        quantity: f("quantity"),
        rate: f("rate"),
        tax_rate: Number(f("tax_rate") || 0),
      };
    });
    return {
      client_id: b.client_id,
      title: b.title,
      ...(b.frequency ? { frequency: b.frequency } : {}),
      next_date: b.next_date,
      terms: Number(b.terms),
      end_date: b.end_date || "",
      contract_id: b.contract_id || "",
      month_end: b.month_end === "on",
      lines,
      discount: b.discount || "0",
      notes: b.notes || "",
      terms_text: b.terms_text || "",
      mode: b.mode,
      send_to: b.send_to || "",
      include_link: b.include_link === "on",
    };
  }
  const runMessage = (r) =>
    r.failed
      ? `Invoice created, but ${STEP[r.step]?.toLowerCase() || "a step"} failed: ${r.error}`
      : r.sent
        ? `Invoice ${r.document.number} issued and emailed.`
        : r.issued
          ? `Invoice ${r.document.number} issued.`
          : "Draft invoice created. Review before issuing.";

  // ---- Contracts ---------------------------------------------------------
  function contractsPage() {
    const r = R();
    return (
      heading(
        "Recurring billing",
        "Contracts and retainers with their terms and renewals.",
        button("Check renewals now", "rec-job", "recurring:contracts") + button("New contract", "rec-contract-new", "", true, "plus"),
      ) +
      tabs("Contracts") +
      `<section class="panel">${
        r.contracts.length
          ? `<div class="table-wrap"><table class="rec-table"><caption class="sr-only">Contracts</caption><thead><tr><th>Contract / client</th><th>Current term</th><th class="num">Value</th><th>Renewal</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${r.contracts
              .map(
                (c) =>
                  `<tr><td><a class="link-button" href="#/contract/${E(c.id)}">${E(c.title)}</a><small>${E(clientName(c.client_id))}${c.reference ? " / " + E(c.reference) : ""}</small></td><td>${dateLabel(c.term_start)} – ${dateLabel(c.end_date)}<small>${c.display_status === "cancelled" ? "Cancelled " + dateLabel(c.cancelled_on) : c.days_left >= 0 ? days(c.days_left) + " left" : "Ended " + days(-c.days_left) + " ago"}</small></td><td class="num">${money(c.value)}</td><td>${E(r.renewals[c.renewal] || c.renewal)}</td><td>${contractTag(c)}</td><td><div class="actions">${c.status !== "cancelled" ? button("Renew", "rec-contract-renew", c.id) + button("Edit", "rec-contract-edit", c.id) : ""}</div></td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : empty("No contracts yet", "Record a retainer or maintenance contract to track its end date and renewal.", button("New contract", "rec-contract-new", "", true))
      }</section><section class="panel mt22"><div class="panel-head"><h2>How contracts work</h2></div><div class="steps">${[
        ["01 / TERM", "Start and end dates", "Link recurring plans to the contract; they stop billing after its end date."],
        ["02 / RENEWAL", "Your choice", "Renew by hand, get a reminder N days before the end, or renew automatically for another term."],
        ["03 / RECORD", "Every change kept", "Renewals, edits and cancellations are kept in the audit history."],
      ]
        .map(([n, t, d]) => `<div class="step"><span class="eyebrow teal">${n}</span><strong>${t}</strong><p>${d}</p></div>`)
        .join("")}</div></section>`
    );
  }
  function contractView(id) {
    const c = contract(id);
    if (!c) return empty("Contract not found", "It may have been deleted.");
    const r = R();
    const events = get().audit.filter((a) => a.entity_id === id).slice(0, 10);
    const actions =
      c.status === "cancelled"
        ? !c.plans.length
          ? button("Delete", "rec-contract-delete", c.id)
          : ""
        : button("Edit", "rec-contract-edit", c.id) +
          button("Cancel contract", "rec-contract-cancel", c.id) +
          (!c.plans.length ? button("Delete", "rec-contract-delete", c.id) : "") +
          button("Renew now", "rec-contract-renew", c.id, true);
    const note =
      c.display_status === "expiring"
        ? `<div class="notice warn"><p>Ends ${dateLabel(c.end_date)} (${days(c.days_left)}). ${c.renewal === "auto" ? "It renews automatically for another " + c.term_months + " months." : "Renew it now or let it end; linked plans stop billing after the end date."}</p></div>`
        : c.display_status === "ended"
          ? `<div class="notice warn"><p>Ended ${dateLabel(c.end_date)}. Linked plans no longer bill. Renew to continue.</p></div>`
          : "";
    return (
      heading(c.title, clientName(c.client_id), actions) +
      note +
      `<div class="grid-2"><section class="panel"><div class="panel-head"><h2>Contract</h2>${contractTag(c)}</div><dl class="detail"><dt>Client</dt><dd><a href="#/client/${E(c.client_id)}">${E(clientName(c.client_id))}</a></dd>${c.reference ? `<dt>Reference</dt><dd>${E(c.reference)}</dd>` : ""}<dt>Value</dt><dd>${money(c.value)}</dd><dt>Started</dt><dd>${dateLabel(c.start_date)}</dd><dt>Current term</dt><dd>${dateLabel(c.term_start)} – ${dateLabel(c.end_date)}</dd><dt>Renewal</dt><dd>${E(r.renewals[c.renewal] || c.renewal)}${c.renewal === "notify" ? ` · ${days(c.notice_days)} before the end` : ""} · ${c.term_months}-month terms</dd>${c.status === "cancelled" ? `<dt>Cancelled</dt><dd>${dateLabel(c.cancelled_on)} · ${E(c.cancel_reason || "")}</dd>` : ""}<dt>Billed from linked plans</dt><dd>${money(c.billed)} in ${c.invoices} issued invoice${c.invoices === 1 ? "" : "s"}</dd>${c.notes ? `<dt>Notes</dt><dd>${E(c.notes)}</dd>` : ""}</dl></section><div class="stack"><section class="panel"><div class="panel-head"><h2>Linked plans</h2></div>${
        c.plans.length
          ? c.plans
              .map((p) => {
                const full = plan(p.id);
                return `<div class="attention"><div><strong>${E(p.title)}</strong><small>${E(full?.frequency_label || "")}${full?.amount != null ? " / " + money(full.amount) : ""}</small><a class="link-button" href="#/plan/${E(p.id)}">Open plan →</a></div>${full ? planTag(full) : ""}</div>`;
              })
              .join("")
          : `<p class="field-hint">No plans linked. Edit a recurring plan and choose this contract.</p>`
      }</section><section class="panel"><div class="panel-head"><h2>Terms</h2></div>${c.terms
        .map((t) => `<div class="total-row"><span>Term ${t.term_no}: ${dateLabel(t.start_date)} – ${dateLabel(t.end_date)}</span><small>${E({ created: "Original", owner: "Renewed", auto: "Renewed automatically" }[t.source] || t.source)}</small></div>`)
        .join("")}</section>${
        events.length
          ? `<section class="panel"><div class="panel-head"><h2>History</h2></div><div class="timeline">${events.map((a) => `<div class="timeline-item"><strong>${E(a.action.replace(/[._]/g, " "))}</strong><small>${timeLabel(a.created)} · ${E(a.actor)}</small><p>${E(a.detail)}</p></div>`).join("")}</div></section>`
          : ""
      }</div></div>`
    );
  }
  function contractForm(id = "", clientId = "") {
    const S = get();
    const c = id ? contract(id) : null;
    if (!c && !S.clients.some((x) => !x.archived)) return toast("Add a client first.", true);
    const v = c || {
      client_id: clientId,
      title: "",
      reference: "",
      value: 0,
      start_date: S.today,
      end_date: h.addDays(S.today, 364),
      renewal: "notify",
      notice_days: 30,
      term_months: 12,
      notes: "",
    };
    showModal(
      c ? "Edit contract" : "New contract",
      `<form data-form="rec-contract" data-id="${E(id)}"><div class="form-grid">${
        c ? `<div class="span-2"><p class="field-hint">Client</p><p><strong>${E(clientName(c.client_id))}</strong></p></div>` : `<div class="span-2">${select("Client", "client_id", clientOptions(v.client_id), v.client_id)}</div>`
      }${input("Contract title", "title", v.title, "text", true, 'maxlength="160" placeholder="e.g. Annual support retainer"')}${input("Reference (optional)", "reference", v.reference, "text", false, 'maxlength="80"')}${input("Contract value (MYR)", "value", dec(v.value), "number", false, 'min="0" max="99999999.99" step="0.01"')}${input("Renewal term (months)", "term_months", v.term_months, "number", true, 'min="1" max="60" step="1"')}${input("Start date", "start_date", v.start_date, "date", true)}${input("End date", "end_date", v.end_date, "date", true)}${select("Renewal", "renewal", Object.entries(R().renewals), v.renewal)}${input("Remind / mark expiring (days before the end)", "notice_days", v.notice_days, "number", true, 'min="0" max="365" step="1"')}<div class="span-2">${area("Notes", "notes", v.notes, 2000)}</div></div><p class="field-hint">Recurring plans linked to this contract stop billing after the end date. Automatic renewal adds another term on the day after the end date. Reminders go to your billing email when email is set up, and always show on the overview.</p>${formEnd(c ? "Save contract" : "Create contract")}</form>`,
    );
  }

  // ---- Settings: late fees and the accountant pack ------------------------
  function lateFeePanel() {
    const f = R().lateFees;
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Late payment fees</h2><p>${f.enabled ? E(f.policy) : "Off. Overdue invoices are not charged a fee."}</p></div>${tag(f.enabled ? "On" : "Off", f.enabled ? "green" : "")}</div><form data-form="rec-late-fees"><label class="check-row"><input type="checkbox" name="enabled" ${f.enabled ? "checked" : ""}> Charge late fees on overdue invoices automatically</label><div class="form-grid">${select("Fee", "type", [["fixed", "Fixed amount"], ["percent", "Percentage of the unpaid balance"]], f.type)}${input("Fixed amount (MYR)", "amount", dec(f.amount || 0), "number", false, 'min="0" max="99999999.99" step="0.01"')}${input("Percentage (%)", "percent", ((f.percent_bp || 0) / 100).toFixed(2), "number", false, 'min="0.01" max="25" step="0.01"')}${input("Days overdue before the first fee", "after_days", f.after_days, "number", true, 'min="1" max="365" step="1"')}${input("Repeat every (days, 0 = charge once)", "repeat_days", f.repeat_days, "number", true, 'min="0" max="365" step="1"')}${input("Most fees per invoice", "max_count", f.max_count, "number", true, 'min="1" max="24" step="1"')}${input("Most in total per invoice (MYR, 0 = no limit)", "cap", dec(f.cap || 0), "number", false, 'min="0" max="99999999.99" step="0.01"')}</div><p class="field-hint">Fees are added as numbered debit notes, only on invoices issued after you turn this on, and the policy is printed on those invoices. Turn fees off for a client in their profile, or waive them on an invoice with one click.${f.since ? " On since " + dateLabel(f.since) + "." : ""}</p>${errorBlock()}<div class="form-actions">${f.enabled ? button("Charge due fees now", "rec-job", "recurring:late-fees") : ""}<button class="btn primary" type="submit">Save late fees</button></div></form></section>`;
  }
  function packPanel() {
    const r = R(),
      k = r.pack;
    const last = h.addDays(get().today.slice(0, 7) + "-01", -1).slice(0, 7);
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Monthly accountant pack</h2><p>A PDF summary with CSV files for one month: invoices, credit and debit notes, cash received and refunds, aging at month end and SST by rate.</p></div>${tag(k.enabled ? "On" : "Off", k.enabled ? "green" : "")}</div><form data-form="rec-pack"><label class="check-row"><input type="checkbox" name="enabled" ${k.enabled ? "checked" : ""}> Email last month's pack to my accountant automatically</label><div class="form-grid">${input("Accountant's email", "email", k.email || "", "text", false, 'maxlength="600" placeholder="accounts@firm.example"')}${input("Send on day of the month (1–28)", "day", k.day || 1, "number", true, 'min="1" max="28" step="1"')}</div><p class="field-hint">Sent once per month, on that day or within 6 days after it if the server was off. ${r.mail ? "" : "Email is not configured yet, so the pack cannot be emailed; you can still download it."}</p>${errorBlock()}<div class="form-actions"><button class="btn primary" type="submit">Save pack settings</button></div></form><form data-form="rec-pack-send" class="mt22"><h3>Any past month</h3><div class="form-grid">${input("Month", "month", last, "month", true, `max="${last}"`)}${input("Send to (optional)", "to", "", "text", false, 'maxlength="600" placeholder="Accountant\'s email by default"')}</div>${errorBlock()}<div class="form-actions">${button("Download pack", "rec-pack-download", "", false, "download")}<button class="btn" type="submit" ${r.mail ? "" : "disabled"}>Send now</button></div></form>${
      r.packs.length
        ? `<div class="mt22">${r.packs
            .slice(0, 6)
            .map(
              (x) =>
                `<div class="payment"><div class="payment-top"><strong>${E(x.month)} · ${x.source === "auto" ? "automatic" : "sent by you"}</strong>${tag(x.status === "sent" ? "Sent" : x.status === "failed" ? "Failed" : "Sending", x.status === "sent" ? "green" : x.status === "failed" ? "red" : "blue")}</div><p>${E(x.recipients)}<br>${timeLabel(x.created)}${x.error ? "<br>" + E(x.error) : ""}</p></div>`,
            )
            .join("")}</div>`
        : ""
    }</section>`;
  }

  // ---- Slots -------------------------------------------------------------
  function overviewPanel() {
    const r = R();
    const attention = r.plans.filter((p) => p.last_error);
    const due = r.plans.filter((p) => p.status === "Due");
    const expiring = r.contracts.filter((c) => c.display_status === "expiring");
    const ended = r.contracts.filter((c) => c.display_status === "ended" && c.status !== "cancelled" && c.days_left >= -30);
    if (!attention.length && !due.length && !expiring.length && !ended.length) return "";
    const rows = [
      ...attention.map(
        (p) =>
          `<div class="attention"><div><strong>${E(p.title)}</strong><small>${E(clientName(p.client_id))} / ${E(p.last_error)}</small><a class="link-button" href="#/plan/${E(p.id)}">Review plan →</a></div>${tag("Needs attention", "red")}</div>`,
      ),
      ...due.map(
        (p) =>
          `<div class="attention"><div><strong>${E(p.title)}</strong><small>${E(clientName(p.client_id))} / ${E(p.next_label)} / ${p.amount == null ? "" : money(p.amount)}</small><a class="link-button" href="#/plan/${E(p.id)}">Open plan →</a></div>${tag("Due", "blue")}</div>`,
      ),
      ...[...expiring, ...ended].map(
        (c) =>
          `<div class="attention"><div><strong>${E(c.title)}</strong><small>${E(clientName(c.client_id))} / ${c.days_left >= 0 ? `ends ${dateLabel(c.end_date)} (${days(c.days_left)})` : `ended ${dateLabel(c.end_date)}`} / ${E(r.renewals[c.renewal] || "")}</small><a class="link-button" href="#/contract/${E(c.id)}">Review contract →</a></div>${contractTag(c)}</div>`,
      ),
    ];
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Recurring and contracts</h2><p>Plans waiting for you and contracts ending soon</p></div><a href="#/recurring">Open recurring →</a></div>${rows.slice(0, 8).join("")}</section>`;
  }
  function clientPanel(c) {
    const r = R();
    const plans = r.plans.filter((p) => p.client_id === c.id),
      contracts = r.contracts.filter((x) => x.client_id === c.id);
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Contracts and recurring plans</h2><p>${contracts.length} contract${contracts.length === 1 ? "" : "s"} / ${plans.length} plan${plans.length === 1 ? "" : "s"}</p></div>${c.archived ? "" : `<div class="actions">${button("New contract", "rec-contract-new", c.id)}${button("New plan", "rec-plan-new", c.id, false, "plus")}</div>`}</div>${
      contracts.length || plans.length
        ? [
            ...contracts.map(
              (x) =>
                `<div class="attention"><div><strong>${E(x.title)}</strong><small>Contract / ${dateLabel(x.term_start)} – ${dateLabel(x.end_date)} / ${money(x.value)}</small><a class="link-button" href="#/contract/${E(x.id)}">Open contract →</a></div>${contractTag(x)}</div>`,
            ),
            ...plans.map(
              (p) =>
                `<div class="attention"><div><strong>${E(p.title)}</strong><small>${E(p.frequency_label)} / ${p.amount == null ? "" : money(p.amount)} / next ${p.status === "Ended" ? "—" : dateLabel(p.next_date)}</small><a class="link-button" href="#/plan/${E(p.id)}">Open plan →</a></div>${planTag(p)}</div>`,
            ),
          ].join("")
        : '<p class="field-hint">No contracts or recurring plans for this client.</p>'
    }</section>`;
  }
  function documentPanel(d) {
    if (d.kind !== "invoice") return "";
    const r = R();
    const run = runFor(d.id);
    let html = "";
    if (run) {
      const send = SEND[run.send_status];
      html += `<section class="panel"><div class="panel-head"><h2>Recurring plan</h2>${send ? tag(...send) : ""}</div><p><a href="#/plan/${E(run.plan.id)}">${E(run.plan.title)}</a><br><small class="muted">${E(run.label)} · ${E(modeLabel(run.mode || "draft"))}</small></p>${run.error ? `<p class="red-text">${E(STEP[run.error_step] || "Automation")} failed: ${E(run.error)}</p>` : ""}${run.note ? `<p class="field-hint">${E(run.note)}</p>` : ""}${run.send_status === "failed" && d.state === "issued" ? `<div class="actions mt22">${button("Send again", "rec-send-run", d.id)}</div>` : ""}</section>`;
    }
    const charges = r.charges.filter((x) => x.invoice_id === d.id).sort((a, b) => a.charge_no - b.charge_no);
    const applies = policyApplies(d);
    const held = r.holds.includes(d.id);
    if (d.state === "issued" && (charges.length || applies || (held && r.lateFees.enabled))) {
      const open = charges.filter((x) => x.status === "charged" && !x.waiver_number);
      html += `<section class="panel"><div class="panel-head"><h2>Late fees</h2>${held ? tag("Stopped") : applies ? tag("Policy applies", "orange") : ""}</div>${
        charges.length
          ? charges
              .map(
                (x) =>
                  `<div class="total-row"><span>${x.status === "failed" ? `Fee ${x.charge_no} not charged: ${E(x.error || "")}` : `${E(x.number || "")} · fee ${x.charge_no}`}${x.waiver_number ? ` <small>waived (${E(x.waiver_number)})</small>` : ""}</span><strong>${money(x.amount)}</strong></div>`,
              )
              .join("")
          : `<p class="field-hint">${applies ? "No fee charged yet. " + E(r.lateFees.policy) : "No late fees on this invoice."}</p>`
      }<div class="actions mt22">${open.length ? button("Waive late fees", "rec-fee-waive", d.id, true) : ""}${r.lateFees.enabled && !r.exemptClients.includes(d.client_id) ? button(held ? "Allow late fees" : "Stop late fees", held ? "rec-fee-resume" : "rec-fee-stop", d.id) : ""}</div></section>`;
    }
    return html;
  }
  function paperNote(d, publicView) {
    const policy = publicView ? d.ext?.recurring?.lateFeePolicy : policyApplies(d) ? R().lateFees.policy : null;
    return policy ? `<div class="paper-notes"><h3>Late payment</h3><p>${E(policy)}</p></div>` : "";
  }

  return {
    nav: [{ key: "recurring", label: "Recurring", icon: "clock", group: "Sell" }],
    pages: {
      recurring: (tab) => (tab === "contracts" ? contractsPage() : plansPage()),
      plan: planView,
      contract: contractView,
    },
    activeFor: { plan: "recurring", contract: "recurring" },
    async action(type, id, el) {
      switch (type) {
        case "rec-plan-new":
          planForm("", id || "");
          return true;
        case "rec-plan-edit":
          planForm(id);
          return true;
        case "rec-line-add":
          modal.querySelector(".rec-lines-body").insertAdjacentHTML("beforeend", lineRow());
          modal.querySelector(".rec-lines-body .rec-line:last-child select").focus();
          return true;
        case "rec-line-remove": {
          const rows = modal.querySelectorAll(".rec-lines-body .rec-line");
          if (rows.length > 1) el.closest(".rec-line").remove();
          else toast("A plan needs at least one line.", true);
          modal.querySelector("form[data-form=rec-plan]")?.dispatchEvent(new Event("input"));
          return true;
        }
        case "rec-plan-run":
        case "rec-plan-retry": {
          const r = await api(`/recurring/schedules/${id}/${type === "rec-plan-run" ? "run" : "retry"}`, "POST", {});
          await refresh();
          navigate("document/" + r.document.id);
          toast(runMessage(r), !!r.failed);
          return true;
        }
        case "rec-plan-dismiss":
          await mutate(() => api(`/recurring/schedules/${id}/dismiss`, "POST", {}), "Notice dismissed.");
          return true;
        case "rec-plan-pause":
        case "rec-plan-resume":
          await mutate(
            () => api(`/schedules/${id}/${type === "rec-plan-pause" ? "pause" : "resume"}`, "POST", {}),
            type === "rec-plan-pause" ? "Plan paused." : "Plan resumed.",
          );
          return true;
        case "rec-plan-delete":
          confirmModal("Delete plan?", "Only plans that never created an invoice can be deleted; pause a used plan instead. A deleted plan can be restored, paused, from Recently deleted for 30 days.", "rec-plan-delete-confirm", id, "Delete plan");
          return true;
        case "rec-plan-delete-confirm":
          try {
            await api(`/schedules/${id}`, "DELETE");
          } catch (e) {
            modal.querySelector(".form-error").textContent = e.message;
            return true;
          }
          await mutate(async () => null, "Plan deleted. The audit history keeps a record.", "recurring");
          return true;
        case "rec-send-run":
          await mutate(() => api(`/recurring/runs/${id}/send`, "POST", {}), "Invoice emailed.");
          return true;
        case "rec-job": {
          const r = await api(`/jobs/${id}/run`, "POST", {});
          await refresh();
          renderRoute();
          const parts = [];
          if (r.skipped) parts.push(r.reason === "off" ? "This is turned off." : "Already running.");
          if (r.generated !== undefined) parts.push(`${r.generated} invoice(s) created, ${r.issued} issued, ${r.sent} emailed${r.failed ? `, ${r.failed} need attention` : ""}.`);
          if (r.charged !== undefined) parts.push(`${r.charged} late fee(s) charged${r.failed ? `, ${r.failed} failed` : ""}.`);
          if (r.notices !== undefined) parts.push(`${r.renewed} renewed, ${r.ended} ended, ${r.notices} reminder(s).`);
          toast(parts.join(" ") || "Done.");
          return true;
        }
        case "rec-contract-new":
          contractForm("", id || "");
          return true;
        case "rec-contract-edit":
          contractForm(id);
          return true;
        case "rec-contract-renew": {
          const c = contract(id);
          const start = h.addDays(c.end_date, 1);
          confirmModal("Renew contract?", `Adds another ${c.term_months}-month term starting ${dateLabel(start)}. Linked plans keep billing. The renewal is kept in the audit history.`, "rec-contract-renew-confirm", id, "Renew contract");
          return true;
        }
        case "rec-contract-renew-confirm":
          await mutate(() => api(`/recurring/contracts/${id}/renew`, "POST", {}), (c) => `Renewed until ${dateLabel(c.end_date)}.`);
          return true;
        case "rec-contract-cancel":
          h.reasonForm("Cancel contract", "rec-contract-cancel", id);
          return true;
        case "rec-contract-delete":
          confirmModal("Delete contract?", "Only contracts with no linked plans can be deleted. You can restore it from Recently deleted for 30 days.", "rec-contract-delete-confirm", id, "Delete contract");
          return true;
        case "rec-contract-delete-confirm":
          try {
            await api(`/recurring/contracts/${id}`, "DELETE");
          } catch (e) {
            modal.querySelector(".form-error").textContent = e.message;
            return true;
          }
          await mutate(async () => null, "Contract deleted.", "recurring/contracts");
          return true;
        case "rec-fee-waive":
          showModal(
            "Waive late fees",
            `<form data-form="rec-fee-waive" data-id="${E(id)}"><p>All late fees on this invoice are cancelled with one credit note, and no more fees are charged on it.</p>${area("Reason (optional)", "reason", "", 500)}${formEnd("Waive late fees")}</form>`,
          );
          return true;
        case "rec-fee-stop":
        case "rec-fee-resume":
          await mutate(
            () => api(`/recurring/late-fees/${id}/hold`, "POST", { hold: type === "rec-fee-stop" }),
            type === "rec-fee-stop" ? "No more late fees on this invoice." : "Late fees apply to this invoice again.",
          );
          return true;
        case "rec-pack-download": {
          const form = el.closest("form");
          if (!form.reportValidity()) return true;
          location.href = `/api/recurring/packs/${encodeURIComponent(form.elements.month.value)}.zip`;
          return true;
        }
      }
      return false;
    },
    async submit(form, b) {
      const type = form.dataset.form,
        id = form.dataset.id;
      if (type === "rec-plan") {
        const body = planPayload(form, b);
        const p = await api(id ? `/schedules/${id}` : "/schedules", id ? "PUT" : "POST", body);
        await mutate(async () => p, id ? "Plan saved." : "Plan created.", "plan/" + p.id);
        return true;
      }
      if (type === "rec-contract") {
        const body = { ...b, value: b.value || "0", term_months: Number(b.term_months), notice_days: Number(b.notice_days) };
        const c = await api(id ? `/recurring/contracts/${id}` : "/recurring/contracts", id ? "PUT" : "POST", body);
        await mutate(async () => c, id ? "Contract saved." : "Contract created.", "contract/" + c.id);
        return true;
      }
      if (type === "rec-contract-cancel") {
        await mutate(() => api(`/recurring/contracts/${id}/cancel`, "POST", { reason: b.reason }), "Contract cancelled. Linked plans stop billing.");
        return true;
      }
      if (type === "rec-fee-waive") {
        await mutate(() => api(`/recurring/late-fees/${id}/waive`, "POST", { reason: b.reason || "" }), (cn) => `Late fees waived with ${cn.number}.`);
        return true;
      }
      if (type === "rec-late-fees") {
        await mutate(
          () =>
            api("/recurring/settings", "PUT", {
              lateFees: {
                enabled: b.enabled === "on",
                type: b.type,
                amount: b.amount || "0",
                percent: b.percent || "1",
                after_days: Number(b.after_days),
                repeat_days: Number(b.repeat_days || 0),
                max_count: Number(b.max_count),
                cap: b.cap || "0",
              },
            }),
          "Late fee settings saved.",
        );
        return true;
      }
      if (type === "rec-pack") {
        await mutate(
          () => api("/recurring/settings", "PUT", { pack: { enabled: b.enabled === "on", email: b.email || "", day: Number(b.day) } }),
          "Accountant pack settings saved.",
        );
        return true;
      }
      if (type === "rec-pack-send") {
        await mutate(() => api(`/recurring/packs/${b.month}/send`, "POST", { to: b.to || "" }), `Pack for ${b.month} sent.`);
        return true;
      }
      return false;
    },
    slots: {
      overview: overviewPanel,
      clientPanels: clientPanel,
      clientFields: (c) =>
        `<div class="span-2"><input type="hidden" name="recurring_fields" value="1"><label class="check-row"><input type="checkbox" name="late_fee_exempt" ${c.late_fee_exempt ? "checked" : ""}> Never charge late fees to this client</label></div>`,
      clientDetails: (c) =>
        R().lateFees.enabled
          ? `<dt>Late fees</dt><dd>${R().exemptClients.includes(c.id) ? "Not charged (turned off for this client)" : "Charged as set in Settings"}</dd>`
          : "",
      documentPanels: documentPanel,
      paper: paperNote,
      settings: () => lateFeePanel() + packPanel(),
    },
  };
}
