// Operations: partial and amended customer POs, timesheets, projects and milestones, inventory and proof of work.
// Browser module contract: see docs/PLUGINS.md.
export default function opsUI(h) {
  const {
    E,
    money,
    dec,
    dateLabel,
    timeLabel,
    button,
    badge,
    input,
    area,
    formEnd,
    heading,
    empty,
    icon,
    api,
    refresh,
    renderRoute,
    navigate,
    showModal,
    modal,
    toast,
    confirmModal,
    get,
  } = h;
  const S = () => get();
  const ops = () =>
    get()?.ext?.ops || { projects: [], milestones: [], unbilled: [], links: {}, timer: null, inventory: { enabled: false, items: [] } };
  // ---- Data loaded on demand (week, project, proof of work) ----
  const cache = new Map(),
    loading = new Set();
  function load(key, path) {
    if (cache.has(key)) return cache.get(key);
    if (!loading.has(key)) {
      loading.add(key);
      api(path)
        .then(
          (d) => cache.set(key, d),
          (e) => cache.set(key, { error: e.message }),
        )
        .finally(() => {
          loading.delete(key);
          renderRoute();
        });
    }
    return null;
  }
  const cached = (field) => [...cache.values()].flatMap((v) => (v && !v.error && Array.isArray(v[field]) ? v[field] : []));
  async function done(message, route) {
    cache.clear();
    await refresh();
    if (route) navigate(route);
    else renderRoute();
    if (message) toast(message);
  }
  // JSON or file requests with an optional idempotency key (safe retries).
  async function send(path, method, body, key) {
    const file = typeof Blob !== "undefined" && body instanceof Blob;
    const res = await fetch("/api" + path, {
      method,
      headers: {
        "X-CSRF-Token": h.session()?.csrf || "",
        ...(key ? { "Idempotency-Key": key } : {}),
        ...(file ? { "Content-Type": "application/octet-stream" } : body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: file ? body : JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({ error: "Server returned an unreadable response." }));
    if (!res.ok) throw new Error(data.error || "Request failed.");
    return data;
  }
  const keyFor = (form) => form.dataset.requestKey || (form.dataset.requestKey = crypto.randomUUID());
  // ---- Small helpers ----
  const pick = (label, name, options, selected = "", required = false, attrs = "") =>
    `<label>${E(label)}<select name="${name}" ${required ? "required" : ""} ${attrs}>${options.map(([v, t]) => `<option value="${E(v)}" ${String(v) === String(selected) ? "selected" : ""}>${E(t)}</option>`).join("")}</select></label>`;
  const check = (label, name, on = false) =>
    `<label class="check-row"><input type="checkbox" name="${name}" ${on ? "checked" : ""}>${E(label)}</label>`;
  const tag = (t, tone = "") => `<span class="badge ${tone}"><span class="dot"></span>${E(t)}</span>`;
  const hrs = (h100) => (h100 / 100).toFixed(2);
  const qty = (q100) => (Number.isInteger(q100 / 100) ? String(q100 / 100) : (q100 / 100).toFixed(2));
  const pct = (p100) => (p100 / 100).toFixed(2).replace(/\.?0+$/, "");
  const SST = [
    [0, "No SST"],
    [5, "5%"],
    [6, "6%"],
    [8, "8%"],
    [10, "10%"],
  ];
  const STATUS = { planned: "Planned", active: "Active", on_hold: "On hold", completed: "Completed", cancelled: "Cancelled" };
  const clientName = (cid) => S().clients.find((c) => c.id === cid)?.name || "Unknown client";
  const projectOf = (pid) => ops().projects.find((p) => p.id === pid);
  const serviceOf = (sid) => S().services.find((s) => s.id === sid);
  const docOf = (did) => S().documents.find((d) => d.id === did);
  const docLabel = (did) => {
    const d = docOf(did);
    return d ? d.number || `Draft ${d.kind === "quote" ? "quotation" : "invoice"}` : "Document";
  };
  const docLink = (did) => `<a href="#/document/${E(did)}">${E(docLabel(did))}</a>`;
  const mondayOf = (day) => h.addDays(day, -((new Date(day + "T00:00:00Z").getUTCDay() + 6) % 7));
  const weekday = (day) =>
    new Intl.DateTimeFormat("en-MY", { weekday: "short", day: "numeric", timeZone: "UTC" }).format(new Date(day + "T00:00:00Z"));
  const elapsed = (iso) => {
    const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
    return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  setInterval(() => {
    for (const el of document.querySelectorAll("[data-ops-since]")) el.textContent = elapsed(el.dataset.opsSince);
  }, 1000);
  const clientOpts = (selected = "") => h.clientOptions(selected);
  const projectOpts = (cid, selected = "") => [
    ["", "No project"],
    ...ops()
      .projects.filter((p) => p.client_id === cid && (p.status !== "cancelled" || p.id === selected))
      .map((p) => [p.id, p.name]),
  ];
  const serviceOpts = (selected = "") => [
    ["", "No service"],
    ...S()
      .services.filter((s) => s.active || s.id === selected)
      .map((s) => [s.id, `${s.name} (${money(s.rate)} / ${s.unit})`]),
  ];
  const ordered = (qid) =>
    S()
      .sales.purchaseOrders.filter((p) => p.quote_id === qid && p.status !== "cancelled")
      .reduce((s, p) => s + p.amount, 0);
  // Keeps the project list and the default-rate hint in step with the chosen client/service.
  function rateHint(form) {
    const el = form?.querySelector("[data-ops-rate-hint]");
    if (!el) return;
    const s = serviceOf(form.elements.service_id?.value),
      c = S().clients.find((x) => x.id === form.elements.client_id?.value);
    el.textContent = s?.rate
      ? `Leave blank to use the service rate, ${money(s.rate)}.`
      : c?.ops_hourly_rate
        ? `Leave blank to use the client's rate, ${money(c.ops_hourly_rate)} per hour.`
        : "No default rate. Enter one, choose a service, or set a rate on the client.";
  }
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.matches("select[data-ops-client]") && t.form?.elements.project_id) {
      t.form.elements.project_id.innerHTML = projectOpts(t.value)
        .map(([v, l]) => `<option value="${E(v)}">${E(l)}</option>`)
        .join("");
      rateHint(t.form);
    }
    if (t.matches("select[data-ops-service]")) rateHint(t.form);
    if (t.matches("select[data-ops-quote]")) quoteChosen(t.form);
    if (t.matches("input[data-ops-po-file]")) addPOFile(t);
  });
  // ======================= Timesheets =======================
  function timerPanel() {
    const t = ops().timer;
    if (t) {
      const p = projectOf(t.project_id);
      return `<section class="panel ops-timer is-running"><div class="ops-timer-main"><span class="eyebrow">Timer running</span><strong>${E(clientName(t.client_id))}${p ? " / " + E(p.name) : ""}</strong><p>${E(t.description || "No description yet")} · started ${E(timeLabel(t.started))}</p></div><div class="ops-clock" data-ops-since="${E(t.started)}">${elapsed(t.started)}</div><div class="actions">${button("Stop and save", "ops-timer-stop", "", true)}${button("Discard", "ops-timer-discard")}</div></section>`;
    }
    if (clientOpts().length < 2) return '<section class="panel ops-timer"><p>Add a client first to start logging time.</p></section>';
    return `<section class="panel ops-timer"><form data-form="ops-timer-start" class="ops-timer-form">${pick("Client", "client_id", clientOpts(), "", true, "data-ops-client")}${pick("Project", "project_id", projectOpts(""))}${pick("Service", "service_id", serviceOpts())}${input("What are you working on?", "description", "", "text", false, 'maxlength="240"')}${check("Billable", "billable", true)}<div class="form-error" role="alert"></div><button class="btn primary" type="submit">${icon("clock")}Start timer</button></form></section>`;
  }
  function entryStatus(e) {
    if (!e.billable) return tag("Not billable");
    if (!e.invoice_id) return tag("Unbilled", "orange");
    return `${e.invoice_state === "draft" ? "On draft " : ""}${docLink(e.invoice_id)}`;
  }
  function entryRows(list, showClient = true) {
    return list
      .map((e) => {
        const p = projectOf(e.project_id),
          s = serviceOf(e.service_id);
        return `<tr><td>${dateLabel(e.entry_date)}</td><td class="ops-wrap"><strong>${E(e.description)}</strong><small>${E([showClient ? clientName(e.client_id) : "", p?.name, s?.name].filter(Boolean).join(" / "))}${e.source === "timer" ? " · timer" : ""}</small></td><td class="num">${hrs(e.hours100)}</td><td class="num">${e.billable ? money(e.rate) : "—"}</td><td class="num">${e.billable ? money(e.value) : "—"}</td><td>${entryStatus(e)}</td><td><div class="actions ops-acts">${e.invoice_id ? "" : button("Edit", "ops-time-edit", e.id) + button("Delete", "ops-time-delete", e.id)}</div></td></tr>`;
      })
      .join("");
  }
  const entryTable = (list, showClient = true) =>
    `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Work</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Value</th><th>Billing</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${entryRows(list, showClient)}</tbody></table></div>`;
  function weekPanel(week, data) {
    const end = h.addDays(week, 6),
      days = [...Array(7)].map((_, n) => h.addDays(week, n));
    const nav = `<div class="actions">${button("Previous", "ops-week", h.addDays(week, -7))}${button("This week", "ops-week", mondayOf(S().today))}${button("Next", "ops-week", h.addDays(week, 7))}</div>`;
    let body;
    if (!data) body = '<p class="ops-loading">Loading time…</p>';
    else if (data.error) body = `<p class="notice">${E(data.error)}</p>`;
    else if (!data.entries.length) body = empty("No time this week", "Start the timer or add time to see it here.");
    else {
      const rows = new Map();
      for (const e of data.entries) {
        const k = e.client_id + "|" + (e.project_id || "");
        const r = rows.get(k) || { client_id: e.client_id, project_id: e.project_id, days: Array(7).fill(0), total: 0 };
        const i = days.indexOf(e.entry_date);
        if (i >= 0) r.days[i] += e.hours100;
        r.total += e.hours100;
        rows.set(k, r);
      }
      const sum = (list) => list.reduce((s, e) => s + e.hours100, 0);
      const billable = data.entries.filter((e) => e.billable);
      body = `<div class="ops-week-stats"><div><span>Total</span><strong>${hrs(sum(data.entries))} h</strong></div><div><span>Billable</span><strong>${hrs(sum(billable))} h</strong></div><div><span>Billable value</span><strong>${money(billable.reduce((s, e) => s + e.value, 0))}</strong></div></div><div class="table-wrap"><table class="ops-week-grid"><thead><tr><th>Client / project</th>${days.map((d) => `<th class="num ${d === S().today ? "ops-today" : ""}">${E(weekday(d))}</th>`).join("")}<th class="num">Total</th></tr></thead><tbody>${[...rows.values()]
        .map(
          (r) =>
            `<tr><td><strong>${E(clientName(r.client_id))}</strong>${r.project_id ? `<small>${E(projectOf(r.project_id)?.name || "")}</small>` : ""}</td>${r.days.map((v) => `<td class="num">${v ? hrs(v) : "·"}</td>`).join("")}<td class="num"><strong>${hrs(r.total)}</strong></td></tr>`,
        )
        .join("")}<tr class="ops-total-row"><td>Day total</td>${days.map((d) => `<td class="num">${hrs(sum(data.entries.filter((e) => e.entry_date === d)))}</td>`).join("")}<td class="num">${hrs(sum(data.entries))}</td></tr></tbody></table></div><h3 class="mt22">Entries</h3>${entryTable(data.entries)}`;
    }
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Week of ${dateLabel(week)}</h2><p>${dateLabel(week)} to ${dateLabel(end)}</p></div>${nav}</div>${body}</section>`;
  }
  function unbilledPanel(filter = () => true, title = "Unbilled time") {
    const rows = ops().unbilled.filter(filter);
    if (!rows.length) return "";
    return `<section class="panel mt22"><div class="panel-head"><div><h2>${E(title)}</h2><p>Billable time not yet on an invoice</p></div></div><div class="table-wrap"><table><thead><tr><th>Client / project</th><th>Period</th><th class="num">Entries</th><th class="num">Hours</th><th class="num">Value</th><th><span class="sr-only">Invoice</span></th></tr></thead><tbody>${rows
      .map(
        (r) =>
          `<tr><td><strong>${E(clientName(r.client_id))}</strong><small>${E(projectOf(r.project_id)?.name || "No project")}</small></td><td>${dateLabel(r.first)} – ${dateLabel(r.last)}</td><td class="num">${r.entries}</td><td class="num">${hrs(r.hours)}</td><td class="num">${money(r.value)}</td><td>${button("Create invoice", "ops-time-invoice", `${r.client_id}|${r.project_id || ""}`, true)}</td></tr>`,
      )
      .join("")}</tbody></table></div></section>`;
  }
  function timesheets(param) {
    const week = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(param || "") ? param : S().today);
    const data = load("week:" + week, `/ops/time?from=${week}&to=${h.addDays(week, 6)}`);
    return (
      heading("Timesheets", "Log time by client and project, then bill it in one step.", button("Add time", "ops-time-new", "", true, "plus")) +
      timerPanel() +
      weekPanel(week, data) +
      unbilledPanel()
    );
  }
  function timeForm(id, preset = "") {
    const e = id ? [...cached("entries"), ...cached("time")].find((x) => x.id === id) : null;
    if (id && !e) return toast("Reload the page and try again.", true);
    const [pc, pp] = preset.split("|");
    const v = e || { entry_date: S().today, client_id: pc || "", project_id: pp || "", service_id: "", description: "", billable: 1 };
    if (clientOpts(v.client_id).length < 2) return toast("Add a client first.");
    showModal(
      e ? "Edit time" : "Add time",
      `<form data-form="ops-time-save" data-id="${E(id || "")}"><div class="form-grid">${input("Date", "entry_date", v.entry_date, "date", true, `max="${S().today}"`)}${input("Hours", "hours", e ? hrs(e.hours100) : "", "number", true, 'min="0.01" max="24" step="0.01"')}${pick("Client", "client_id", clientOpts(v.client_id), v.client_id, true, "data-ops-client")}${pick("Project", "project_id", projectOpts(v.client_id, v.project_id), v.project_id || "")}${pick("Service", "service_id", serviceOpts(v.service_id), v.service_id || "", false, "data-ops-service")}${input("Hourly rate (MYR)", "rate", e?.billable ? dec(e.rate) : "", "number", false, 'min="0" step="0.01"')}<div class="span-2">${input("Description", "description", v.description, "text", true, 'maxlength="240"')}<small class="field-hint" data-ops-rate-hint></small></div></div>${check("Billable", "billable", !!v.billable)}${formEnd(e ? "Save time" : "Add time")}</form>`,
    );
    rateHint(modal.querySelector("form"));
  }
  async function invoiceTimeForm(key) {
    const [client_id, project_id] = key.split("|");
    const data = await api(`/ops/time?unbilled=1&client_id=${encodeURIComponent(client_id)}${project_id ? "&project_id=" + encodeURIComponent(project_id) : ""}`);
    if (!data.entries.length) return toast("There is no unbilled time for this selection.");
    const sst = !!S().settings.sstNumber;
    showModal(
      "Invoice unbilled time",
      `<form data-form="ops-time-invoice" data-client="${E(client_id)}" data-project="${E(project_id || "")}"><p><strong>${E(clientName(client_id))}</strong>${project_id ? " / " + E(projectOf(project_id)?.name || "") : ""}</p><div class="table-wrap ops-pick mt22"><table><thead><tr><th><span class="sr-only">Bill</span></th><th>Date</th><th>Work</th><th class="num">Hours</th><th class="num">Value</th></tr></thead><tbody>${data.entries
        .map(
          (x) =>
            `<tr><td><input type="checkbox" name="entry" value="${E(x.id)}" checked aria-label="Bill this entry"></td><td>${dateLabel(x.entry_date)}</td><td class="ops-wrap">${E(x.description)}<small>${E([projectOf(x.project_id)?.name, serviceOf(x.service_id)?.name].filter(Boolean).join(" / "))}</small></td><td class="num">${hrs(x.hours100)}</td><td class="num">${money(x.value)}</td></tr>`,
        )
        .join("")}</tbody></table></div><div class="form-grid mt22">${pick("Invoice lines", "group", [
        ["service", "Group by service and rate"],
        ["entry", "One line per entry"],
      ])}${sst ? pick("SST for lines without a service", "tax_rate", SST, 0) : ""}${input("Invoice date", "issue_date", S().today, "date", true)}</div><p class="field-hint">Creates one draft invoice and links this time to it, so it cannot be billed twice. Deleting the draft releases the time; issuing locks it.</p>${formEnd("Create draft invoice")}</form>`,
      true,
    );
  }
  // ======================= Projects =======================
  function progress(value, max) {
    return max > 0
      ? `<progress class="ops-progress" max="${max}" value="${Math.min(value, max)}" aria-label="Invoiced of budget"></progress><small>${Math.round((value / max) * 100)}% of budget</small>`
      : "<small>No budget</small>";
  }
  function projects() {
    const list = ops().projects;
    const table = list.length
      ? `<section class="panel"><div class="table-wrap"><table><thead><tr><th>Project</th><th>Status</th><th class="num">Budget</th><th class="num">Invoiced</th><th class="num">Paid</th><th class="num">Hours</th><th>Progress</th></tr></thead><tbody>${list
          .map(
            (p) =>
              `<tr><td><a href="#/project/${E(p.id)}"><strong>${E(p.name)}</strong></a><small>${E(clientName(p.client_id))}</small></td><td>${badge(STATUS[p.status])}</td><td class="num">${p.budget ? money(p.budget) : "—"}</td><td class="num">${money(p.stats.invoiced)}${p.stats.drafted ? `<small>${money(p.stats.drafted)} in draft</small>` : ""}</td><td class="num">${money(p.stats.paid)}</td><td class="num">${hrs(p.stats.hours)}</td><td class="ops-progress-cell">${progress(p.stats.invoiced, p.budget)}</td></tr>`,
          )
          .join("")}</tbody></table></div></section>`
      : `<section class="panel">${empty("No projects yet", "Create a project to track its budget, milestones and time.", button("New project", "ops-project-new", "", true))}</section>`;
    return heading("Projects", "Budgets, milestones and time for client work.", button("New project", "ops-project-new", "", true, "plus")) + table + readyPanel();
  }
  function readyPanel() {
    const ready = ops().milestones.filter((m) => m.status === "ready");
    if (!ready.length) return "";
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Milestones ready to bill</h2><p>Marked ready and not invoiced yet</p></div></div>${ready
      .map(
        (m) =>
          `<div class="attention"><div><strong>${E(m.project)}: ${E(m.name)}</strong><small>${E(clientName(m.client_id))} / ${money(m.effective)}${m.due_date ? " / due " + dateLabel(m.due_date) : ""}</small></div>${button("Invoice", "ops-ms-invoice", m.id, true)}</div>`,
      )
      .join("")}</section>`;
  }
  function milestoneRows(list, project) {
    return list
      .map((m) => {
        const status =
          m.status === "invoiced"
            ? `${m.invoice_state === "draft" ? "On draft " : "Invoiced "}${docLink(m.invoice_id)}`
            : m.status === "ready"
              ? tag("Ready", "green")
              : tag("Pending");
        const acts =
          m.status === "invoiced"
            ? ""
            : (m.status === "ready"
                ? button("Invoice", "ops-ms-invoice", m.id, true) + button("Back to pending", "ops-ms-pending", m.id)
                : button("Mark ready", "ops-ms-ready", m.id) + button("Invoice", "ops-ms-invoice", m.id)) +
              button("Edit", "ops-ms-edit", m.id) +
              button("Delete", "ops-ms-delete", m.id);
        return `<tr><td class="ops-wrap"><strong>${E(m.name)}</strong>${m.percent != null ? `<small>${pct(m.percent)}% of budget</small>` : ""}</td><td>${m.due_date ? dateLabel(m.due_date) : "—"}</td><td class="num">${money(m.effective)}</td><td>${m.tax_rate ? m.tax_rate + "%" : "—"}</td><td>${status}</td><td><div class="actions ops-acts">${project.status === "cancelled" ? "" : acts}</div></td></tr>`;
      })
      .join("");
  }
  function projectPage(id) {
    const p = projectOf(id);
    if (!p) return empty("Project not found", "It may have been deleted. Open Projects to see the list.");
    const data = load("project:" + id, "/ops/projects/" + encodeURIComponent(id));
    const st = data?.stats || p.stats;
    const ms = data?.milestones || ops().milestones.filter((m) => m.project_id === id);
    const metric = (label, value, hint) =>
      `<div class="metric"><div class="label">${E(label)}</div><div class="value">${value}</div><div class="hint">${E(hint)}</div></div>`;
    const actions =
      button("Edit", "ops-project-edit", id) +
      (p.status !== "cancelled" ? button("Log time", "ops-time-new", `${p.client_id}|${id}`) : "") +
      (st.unbilled ? button("Invoice unbilled time", "ops-time-invoice", `${p.client_id}|${id}`, true) : "") +
      (!st.entries && !st.invoices.length ? button("Delete", "ops-project-delete", id) : "");
    return (
      heading(p.name, `${clientName(p.client_id)} · ${STATUS[p.status]}${p.start_date ? " · " + dateLabel(p.start_date) : ""}${p.end_date ? " to " + dateLabel(p.end_date) : ""}`, actions) +
      `<div class="ops-metrics">${metric("Budget", p.budget ? money(p.budget) : "—", p.budget ? `${money(st.planned)} planned in milestones` : "No budget set")}${metric("Invoiced", money(st.invoiced), st.drafted ? `${money(st.drafted)} more in draft` : "Before SST, issued invoices")}${metric("Paid", money(st.paid), "Share of payments received")}${metric("Time logged", hrs(st.hours) + " h", `${hrs(st.billable_hours)} h billable`)}${metric("Unbilled time", money(st.unbilled), `${hrs(st.unbilled_hours)} h ready to bill`)}</div>` +
      (p.budget ? `<div class="ops-budget">${progress(st.invoiced, p.budget)}</div>` : "") +
      (p.description ? `<section class="panel"><p class="ops-pre">${E(p.description)}</p></section>` : "") +
      `<section class="panel mt22"><div class="panel-head"><div><h2>Milestones</h2><p>Bill a fixed amount or a share of the budget, once each</p></div>${p.status !== "cancelled" ? button("Add milestone", "ops-ms-new", id) : ""}</div>${ms.length ? `<div class="table-wrap"><table><thead><tr><th>Milestone</th><th>Due</th><th class="num">Amount</th><th>SST</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${milestoneRows(ms, p)}</tbody></table></div>` : "<p>No milestones yet.</p>"}</section>` +
      `<section class="panel mt22"><div class="panel-head"><div><h2>Time</h2><p>Latest entries for this project</p></div></div>${!data ? '<p class="ops-loading">Loading time…</p>' : data.error ? `<p class="notice">${E(data.error)}</p>` : data.time.length ? entryTable(data.time, false) : "<p>No time logged yet.</p>"}</section>` +
      (st.invoices.length
        ? `<section class="panel mt22"><div class="panel-head"><h2>Invoices</h2></div><div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Status</th><th class="num">This project</th><th class="num">Invoice total</th><th class="num">Paid</th></tr></thead><tbody>${st.invoices.map((d) => `<tr><td>${docLink(d.id)}</td><td>${badge(d.status)}</td><td class="num">${money(d.net)}</td><td class="num">${money(d.total)}</td><td class="num">${money(d.paid)}</td></tr>`).join("")}</tbody></table></div></section>`
        : "")
    );
  }
  function projectForm(id) {
    const p = id ? projectOf(id) : { client_id: "", name: "", description: "", budget: 0, status: "active", start_date: S().today, end_date: "" };
    showModal(
      id ? "Edit project" : "New project",
      `<form data-form="ops-project-save" data-id="${E(id || "")}">${pick("Client", "client_id", clientOpts(p.client_id), p.client_id, true)}${input("Project name", "name", p.name, "text", true, 'maxlength="160"')}<div class="form-grid">${input("Budget (MYR, before SST)", "budget", p.budget ? dec(p.budget) : "", "number", false, 'min="0" step="0.01"')}${pick("Status", "status", Object.entries(STATUS), p.status, true)}${input("Start date", "start_date", p.start_date || "", "date")}${input("End date", "end_date", p.end_date || "", "date")}</div>${area("Description", "description", p.description, 1000)}<p class="field-hint">Percentage milestones use the budget. Leave the budget empty if there is none.</p>${formEnd(id ? "Save project" : "Create project")}</form>`,
    );
  }
  function milestoneForm(projectId, id) {
    const m = id ? ops().milestones.find((x) => x.id === id) : { name: "", amount: null, percent: null, tax_rate: 0, due_date: "", status: "pending" };
    const p = projectOf(projectId || m.project_id);
    showModal(
      id ? "Edit milestone" : "Add milestone",
      `<form data-form="ops-ms-save" data-id="${E(id || "")}" data-project="${E(p.id)}">${input("Milestone", "name", m.name, "text", true, 'maxlength="160"')}<div class="form-grid">${input("Amount (MYR, before SST)", "amount", m.amount ? dec(m.amount) : "", "number", false, 'min="0.01" step="0.01"')}${input("Or % of budget", "percent", m.percent ? pct(m.percent) : "", "number", false, `min="0.01" max="100" step="0.01" ${p.budget ? "" : "disabled"}`)}${input("Due date", "due_date", m.due_date || "", "date")}${pick("SST", "tax_rate", SST, m.tax_rate)}${pick("Status", "status", [["pending", "Pending"], ["ready", "Ready to bill"]], m.status)}</div><p class="field-hint">${p.budget ? `Budget ${money(p.budget)}. A percentage overrides the amount.` : "Set a project budget to use percentages."} Milestones cannot add up to more than the budget.</p>${formEnd(id ? "Save milestone" : "Add milestone")}</form>`,
    );
  }
  // ======================= Inventory =======================
  const MOVE = { receive: "Received", adjust: "Adjusted", deduct: "Deducted", reverse: "Put back" };
  function inventory() {
    const inv = ops().inventory;
    if (!inv.enabled)
      return (
        heading("Inventory", "Optional stock counts for selected catalog items.") +
        `<section class="panel"><h2>Inventory is off</h2><p class="mt22">Turn it on if you sell goods and want stock counts for selected catalog items. Service businesses can leave it off; nothing changes while it is off.</p><div class="actions mt22">${button("Turn on inventory", "ops-inventory-on", "", true)}</div></section>`
      );
    const low = inv.items.filter((i) => i.low);
    return (
      heading("Inventory", "Stock on hand for the catalog items you track.", button("Track an item", "ops-stock-track", "", true, "plus")) +
      (low.length ? `<div class="notice"><p>${low.length} ${low.length === 1 ? "item is" : "items are"} at or below the reorder level.</p></div>` : "") +
      `<section class="panel"><form data-form="ops-inventory-settings" class="ops-inline-form">${pick("Deduct stock when", "trigger", [["invoice", "An invoice is issued"], ["delivery_order", "A delivery order is issued"]], inv.trigger)}<button class="btn" type="submit">Save</button>${button("Turn off inventory", "ops-inventory-off")}<div class="form-error" role="alert"></div></form><p class="field-hint">Lines are matched to tracked items by catalog item or SKU. Voiding the document puts the stock back. Stock can go below zero; issuing is never blocked.</p></section>` +
      `<section class="panel mt22">${inv.items.length ? `<div class="table-wrap"><table><thead><tr><th>Item</th><th>SKU</th><th class="num">On hand</th><th class="num">Reorder at</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${inv.items
        .map(
          (i) =>
            `<tr><td><strong>${E(i.name)}</strong><small>${E(i.unit)}</small></td><td>${E(i.sku || "—")}</td><td class="num ${i.on_hand <= 0 ? "red-text" : ""}">${qty(i.on_hand)}</td><td class="num">${i.reorder_level ? qty(i.reorder_level) : "—"}</td><td>${!i.active ? tag("Not tracked") : i.on_hand <= 0 ? tag("Out of stock", "red") : i.low ? tag("Low", "orange") : tag("In stock", "green")}</td><td><div class="actions ops-acts">${i.active ? button("Receive", "ops-stock-receive", i.service_id) + button("Adjust", "ops-stock-adjust", i.service_id) : ""}${button("History", "ops-stock-history", i.service_id)}${button("Edit", "ops-stock-edit", i.service_id)}</div></td></tr>`,
        )
        .join("")}</tbody></table></div>` : empty("No tracked items", "Choose catalog items to track. Others are never counted.", button("Track an item", "ops-stock-track", "", true))}</section>`
    );
  }
  function stockItem(sid) {
    return ops().inventory.items.find((i) => i.service_id === sid);
  }
  // ======================= Customer POs =======================
  function poHint(q) {
    const used = ordered(q.id);
    return `Quotation total ${money(q.total)} (SST included). Already on POs: ${money(used)}. A PO below the remaining amount is a partial PO and is invoiced for its own amount.`;
  }
  function quoteChosen(form) {
    const q = docOf(form.elements.quote_id.value);
    if (!q) return;
    const left = q.total - ordered(q.id);
    form.elements.amount.value = dec(left);
    form.elements.amount.max = dec(left);
    form.querySelector("[data-ops-po-hint]").textContent = poHint(q);
  }
  function poForm(quoteId = "") {
    const quotes = S()
      .documents.filter((q) => q.kind === "quote" && q.state === "accepted" && q.total - ordered(q.id) > 0)
      .map((q) => [q, q.total - ordered(q.id)]);
    if (!quotes.length) return toast("Record acceptance of a quotation first. Fully ordered quotations cannot take more POs.");
    const [q, left] = quotes.find(([x]) => x.id === quoteId) || quotes[0];
    showModal(
      "Register customer PO",
      `<form data-form="ops-po-save">${pick("Accepted quotation", "quote_id", quotes.map(([x, l]) => [x.id, `${x.number} / ${x.client.name} / ${money(l)} left`]), q.id, true, "data-ops-quote")}${input("Customer PO reference", "reference", "", "text", true, 'maxlength="120"')}<div class="form-grid">${input("PO value (MYR)", "amount", dec(left), "number", true, `min="0.01" step="0.01" max="${dec(left)}"`)}${input("PO date", "po_date", S().today, "date", true, `max="${S().today}"`)}</div><p class="field-hint" data-ops-po-hint>${E(poHint(q))}</p>${area("PO notes", "notes", "", 1000)}<label>PO file (PDF or image, optional)<input type="file" name="po_file" accept="application/pdf,image/png,image/jpeg,image/webp"></label><label class="check-row"><input type="checkbox" required>I have verified this PO was issued by the customer.</label>${formEnd("Register PO")}</form>`,
    );
  }
  async function poDetails(id) {
    const d = await api("/ops/pos/" + encodeURIComponent(id));
    const p = d.po;
    const invoice =
      p.status === "cancelled"
        ? ""
        : p.invoice_id && p.invoice_state !== "void"
          ? `Invoice: ${docLink(p.invoice_id)}${p.invoice_state === "draft" ? " (draft)" : ""}`
          : "Not invoiced yet";
    const FIELD = { reference: "reference", amount: "amount", po_date: "PO date", notes: "notes", status: "status" };
    showModal(
      `Customer PO ${p.reference}`,
      `<div class="ops-po-summary"><div><span class="eyebrow">Value</span><strong>${money(p.amount)}</strong><small>of ${money(d.quote.total)} on ${E(d.quote.number || "")}</small></div><div><span class="eyebrow">On POs</span><strong>${money(d.quote.ordered)}</strong><small>${money(Math.max(0, d.quote.total - d.quote.ordered))} left to order</small></div><div><span class="eyebrow">Status</span><strong>${p.status === "cancelled" ? "Cancelled" : "Open"}</strong><small>Revision ${p.revision} · ${dateLabel(p.po_date)}</small></div></div><p class="mt22">${invoice}</p>${p.notes ? `<p class="ops-pre">${E(p.notes)}</p>` : ""}<h3 class="mt22">PO files</h3>${d.files.length ? d.files.map((f) => `<div class="attention"><div><a href="/api/files/${E(f.id)}?inline=1" target="_blank" rel="noopener">${E(f.name)}</a><small>${Math.ceil(f.size / 1024)} KB · ${timeLabel(f.created)}</small></div>${button("Delete", "ops-po-file-delete", `${f.id}|${p.id}`)}</div>`).join("") : "<p>No files yet.</p>"}<label class="mt22">Add a PO file (PDF or image, up to 5 MB)<input type="file" data-ops-po-file data-id="${E(p.id)}" accept="application/pdf,image/png,image/jpeg,image/webp"></label><h3 class="mt22">Revision history</h3><div class="table-wrap"><table><thead><tr><th>Rev</th><th>When</th><th>Reference</th><th class="num">Amount</th><th>PO date</th><th>Reason</th></tr></thead><tbody>${d.revisions
        .map(
          (r) =>
            `<tr><td>${r.revision}${r.status === "cancelled" ? " " + tag("Cancelled", "red") : ""}</td><td>${timeLabel(r.created)}<small>${E(r.actor)}</small></td><td>${E(r.reference)}</td><td class="num">${money(r.amount)}</td><td>${dateLabel(r.po_date)}</td><td class="ops-wrap">${E(r.reason)}${r.changes.length ? `<small>Changed: ${E(r.changes.map((c) => FIELD[c] || c).join(", "))}</small>` : ""}</td></tr>`,
        )
        .join("")}</tbody></table></div>${p.status === "open" ? `<div class="form-actions">${button("Cancel PO", "po-cancel", p.id)}${button("Amend PO", "po-amend", p.id, true)}</div>` : ""}`,
      true,
    );
  }
  async function addPOFile(el) {
    const file = el.files?.[0];
    if (!file) return;
    el.disabled = true;
    try {
      await send(`/ops/pos/${encodeURIComponent(el.dataset.id)}/files?name=${encodeURIComponent(file.name)}`, "POST", file);
      await refresh();
      await poDetails(el.dataset.id);
      toast("File added.");
    } catch (e) {
      el.disabled = false;
      toast(e.message, true);
    }
  }
  function poAmendForm(id) {
    const p = S().sales.purchaseOrders.find((x) => x.id === id);
    const issued = p.invoice_id && !["draft", "void"].includes(p.invoice_state);
    const draft = p.invoice_id && p.invoice_state === "draft";
    showModal(
      `Amend PO ${p.reference}`,
      `<form data-form="ops-po-amend" data-id="${E(id)}">${input("Customer PO reference", "reference", p.reference, "text", true, 'maxlength="120"')}<div class="form-grid">${input("PO value (MYR)", "amount", dec(p.amount), "number", true, `min="0.01" step="0.01" ${issued ? "readonly" : ""}`)}${input("PO date", "po_date", p.po_date, "date", true, `max="${S().today}"`)}</div>${issued ? `<p class="field-hint">The amount is locked because ${E(p.invoice_number || "the invoice")} is issued. Use a credit or debit note for a difference.</p>` : ""}${draft ? check("If the amount changes, remove the draft invoice so a new one can be made for the new amount", "replace_draft") : ""}${area("PO notes", "notes", p.notes, 1000)}${area("Reason for the amendment (required)", "reason", "", 500)}<p class="field-hint">Saved as revision ${p.revision + 1}. Earlier revisions stay in the history.</p>${formEnd("Save amendment")}</form>`,
    );
    modal.querySelector("[name=reason]").required = true;
  }
  function poCancelForm(id) {
    const p = S().sales.purchaseOrders.find((x) => x.id === id);
    const draft = p.invoice_id && p.invoice_state === "draft";
    showModal(
      `Cancel PO ${p.reference}`,
      `<form data-form="ops-po-cancel" data-id="${E(id)}"><p>The PO stays in the history and its amount is freed on the quotation.</p>${draft ? check("Remove the draft invoice for this PO", "replace_draft") : ""}${area("Reason (required)", "reason", "", 500)}${formEnd("Cancel PO")}</form>`,
    );
    modal.querySelector("[name=reason]").required = true;
  }
  // ======================= Proof of work =======================
  async function shrink(file) {
    // Re-encodes photos (max 1600 px, JPEG) so they upload fast and lose
    // camera metadata such as GPS location.
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
      return blob?.size ? new File([blob], file.name.replace(/\.[A-Za-z0-9]{1,5}$/, "") + ".jpg", { type: "image/jpeg" }) : file;
    } catch {
      return file;
    }
  }
  const visibleTag = (on) => (on ? tag("Client can see", "green") : tag("Private"));
  function workPanel(d) {
    const w = load("work:" + d.id, `/ops/documents/${encodeURIComponent(d.id)}/work`);
    const open = d.state !== "void";
    let body;
    if (!w) body = '<p class="ops-loading">Loading…</p>';
    else if (w.error) body = `<p class="notice">${E(w.error)}</p>`;
    else {
      const photos = w.photos.length
        ? `<div class="ops-photos">${w.photos
            .map(
              (p) =>
                `<figure class="ops-photo"><a href="/api/files/${E(p.id)}" target="_blank" rel="noopener"><img src="/api/files/${E(p.id)}" alt="${p.kind === "before" ? "Before" : "After"} photo ${E(p.name)}" loading="lazy"></a><figcaption><strong>${p.kind === "before" ? "Before" : "After"}</strong>${visibleTag(p.visibility === "client")}${open ? `<span class="ops-photo-actions">${button(p.visibility === "client" ? "Hide" : "Show to client", "ops-photo-toggle", p.id)}${button("Delete", "ops-photo-delete", p.id)}</span>` : ""}</figcaption></figure>`,
            )
            .join("")}</div>`
        : "<p>No photos yet.</p>";
      const logs = w.logs.length
        ? w.logs
            .map(
              (l) =>
                `<div class="payment"><div class="payment-top"><strong>${dateLabel(l.log_date)} · ${E(l.person)}</strong>${visibleTag(l.visible)}</div><p class="ops-pre">${E(l.notes)}</p>${open ? `<div class="payment-actions">${button("Edit", "ops-log-edit", l.id)}${button("Delete", "ops-log-delete", l.id)}</div>` : ""}</div>`,
            )
            .join("")
        : "<p>No work log yet.</p>";
      const r = w.report;
      body = `${photos}<div class="panel-head mt22"><h3>Work log</h3>${open ? button("Add entry", "ops-log-new", d.id) : ""}</div>${logs}<div class="panel-head mt22"><h3>Service report</h3>${open ? button(r.report ? "Edit report" : "Write report", "ops-report", d.id) : ""}</div>${r.report ? `<p class="ops-pre ops-clip">${E(r.report)}</p><p>${visibleTag(r.visible)}</p>` : "<p>No service report.</p>"}<p class="field-hint">Only items marked "Client can see" appear on the client link${r.pdf ? " and in the PDF (up to 4 PNG or JPEG photos)" : ". Proof of work is left out of the PDF"}.</p>`;
    }
    return `<section class="panel" id="ops-work-panel"><div class="panel-head"><h2>Proof of work</h2>${open ? button("Add photos", "ops-photo-add", d.id) : ""}</div>${body}</section>`;
  }
  function poPanel(d) {
    if (d.kind !== "quote") return "";
    const pos = S().sales.purchaseOrders.filter((p) => p.quote_id === d.id);
    if (d.state !== "accepted" && !pos.length) return "";
    const used = ordered(d.id),
      left = d.total - used;
    return `<section class="panel"><div class="panel-head"><h2>Customer POs</h2>${tag(`${money(used)} of ${money(d.total)}`, left ? "orange" : "green")}</div>${pos
      .map(
        (p) =>
          `<div class="attention"><div><strong>${E(p.reference)}${p.revision ? ` <small>rev ${p.revision}</small>` : ""}</strong><small>${money(p.amount)} · ${dateLabel(p.po_date)}${p.status === "cancelled" ? " · cancelled" : p.invoice_id && p.invoice_state !== "void" ? " · " + E(p.invoice_number || "draft invoice") : " · not invoiced"}</small></div>${button("Details", "po-details", p.id)}</div>`,
      )
      .join("") || "<p>No POs yet.</p>"}${d.state === "accepted" && left > 0 ? `<div class="mt22">${button("Register customer PO", "po-new", d.id, true)}</div><p class="field-hint">${money(left)} still to order. Partial POs are invoiced for their own amount.</p>` : ""}</section>`;
  }
  function billingPanel(d) {
    if (d.kind !== "invoice") return "";
    const po = S().sales.purchaseOrders.find((p) => p.invoice_id === d.id);
    const link = ops().links[d.id];
    if (!po && !link) return "";
    const lines = [];
    if (po)
      lines.push(
        `<div class="attention"><div><strong>Customer PO ${E(po.reference)}</strong><small>${money(po.amount)}${po.revision ? ` · revision ${po.revision}` : ""} · this invoice cannot be more than the PO</small></div>${button("Details", "po-details", po.id)}</div>`,
      );
    if (link?.time)
      lines.push(`<div class="attention"><div><strong>${link.time} time ${link.time === 1 ? "entry" : "entries"}</strong><small>${hrs(link.hours100)} hours billed on this invoice</small></div></div>`);
    for (const m of link?.milestones || [])
      lines.push(`<div class="attention"><div><strong>Milestone: ${E(m.name)}</strong><small>${E(m.project)}</small></div></div>`);
    const release = d.state === "draft" && (link?.time || link?.milestones?.length);
    return `<section class="panel"><div class="panel-head"><h2>Billed from</h2></div>${lines.join("")}${release ? `<div class="mt22">${button("Release time and milestones", "ops-unlink", d.id)}</div><p class="field-hint">Releases them for billing again. Edit or delete this draft's lines afterwards.</p>` : ""}</section>`;
  }
  // ======================= Overview, top bar, clients =======================
  function overviewPanel() {
    const o = ops();
    const unbilled = o.unbilled.reduce((s, r) => ({ value: s.value + r.value, hours: s.hours + r.hours, clients: s.clients.add(r.client_id) }), { value: 0, hours: 0, clients: new Set() });
    const ready = o.milestones.filter((m) => m.status === "ready");
    const low = o.inventory?.enabled ? o.inventory.items.filter((i) => i.low) : [];
    if (!unbilled.value && !ready.length && !low.length) return "";
    const block = (title, value, hint, href, tone = "") =>
      `<a class="ops-overview-item ${tone}" href="${href}"><span>${E(title)}</span><strong>${value}</strong><small>${hint}</small></a>`;
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Operations</h2><p>Work ready to bill and stock to reorder</p></div></div><div class="ops-overview">${unbilled.value ? block("Unbilled time", money(unbilled.value), `${hrs(unbilled.hours)} h across ${unbilled.clients.size} ${unbilled.clients.size === 1 ? "client" : "clients"}`, "#/timesheets") : ""}${ready.length ? block("Milestones ready", money(ready.reduce((s, m) => s + m.effective, 0)), `${ready.length} ready to invoice`, "#/projects") : ""}${low.length ? block("Low stock", String(low.length), E(low.slice(0, 3).map((i) => `${i.name} (${qty(i.on_hand)})`).join(", ")), "#/inventory", "is-alert") : ""}</div></section>`;
  }
  function clientPanel(c) {
    const list = ops().projects.filter((p) => p.client_id === c.id);
    const unbilled = unbilledPanel((r) => r.client_id === c.id, "Unbilled time for this client");
    if (!list.length && !unbilled) return "";
    return (
      (list.length
        ? `<section class="panel mt22"><div class="panel-head"><h2>Projects</h2>${button("New project", "ops-project-new", c.id)}</div>${list.map((p) => `<div class="attention"><div><a href="#/project/${E(p.id)}"><strong>${E(p.name)}</strong></a><small>${E(STATUS[p.status])} · ${money(p.stats.invoiced)} invoiced${p.budget ? " of " + money(p.budget) : ""}</small></div></div>`).join("")}</section>`
        : "") + unbilled
    );
  }
  function settingsPanel() {
    const inv = ops().inventory;
    return `<section class="panel mt22"><h2>Operations</h2><div class="setting-line"><div><h3>Inventory</h3><p>${inv.enabled ? `On. Stock is deducted when ${inv.trigger === "delivery_order" ? "a delivery order" : "an invoice"} is issued.` : "Off. Turn it on only if you sell goods and want stock counts."}</p></div>${button(inv.enabled ? "Turn off" : "Turn on", inv.enabled ? "ops-inventory-off" : "ops-inventory-on")}</div><div class="setting-line"><div><h3>Proof of work</h3><p>Work photos, logs and service reports are private until you mark them "Client can see" on each document.</p></div></div><div class="setting-line"><div><h3>Timesheets</h3><p>Set a default hourly rate on each client. A service's rate, or a rate typed on the entry, comes first.</p></div></div></section>`;
  }
  // ======================= Actions and forms =======================
  async function action(type, id) {
    switch (type) {
      case "ops-week":
        navigate("timesheets/" + id);
        return true;
      case "ops-time-new":
        timeForm(null, id || "");
        return true;
      case "ops-time-edit":
        timeForm(id);
        return true;
      case "ops-time-delete":
        confirmModal("Delete time entry", "Delete this time entry? The audit history keeps a record.", "ops-time-delete-yes", id, "Delete");
        return true;
      case "ops-time-delete-yes":
        await api("/ops/time/" + encodeURIComponent(id), "DELETE");
        modal.close();
        await done("Time deleted.");
        return true;
      case "ops-time-invoice":
        await invoiceTimeForm(id);
        return true;
      case "ops-timer-stop": {
        const t = ops().timer;
        showModal(
          "Stop timer",
          `<form data-form="ops-timer-stop"><p>${E(clientName(t.client_id))} · <span data-ops-since="${E(t.started)}">${elapsed(t.started)}</span></p>${input("Description", "description", t.description, "text", true, 'maxlength="240"')}${formEnd("Save time")}</form>`,
        );
        return true;
      }
      case "ops-timer-discard":
        confirmModal("Discard timer", "Discard the running timer without saving any time?", "ops-timer-discard-yes", "", "Discard");
        return true;
      case "ops-timer-discard-yes":
        await api("/ops/timer/discard", "POST", {});
        modal.close();
        await done("Timer discarded.");
        return true;
      case "ops-unlink":
        confirmModal("Release time and milestones", "Release the time and milestones on this draft so they can be billed again? The draft lines stay until you edit them.", "ops-unlink-yes", id, "Release");
        return true;
      case "ops-unlink-yes":
        await api(`/ops/invoices/${encodeURIComponent(id)}/unlink`, "POST", {});
        modal.close();
        await done("Released. Edit the draft lines to match.");
        return true;
      case "ops-project-new": {
        projectForm();
        if (id && modal.querySelector("[name=client_id]")) modal.querySelector("[name=client_id]").value = id;
        return true;
      }
      case "ops-project-edit":
        projectForm(id);
        return true;
      case "ops-project-delete":
        confirmModal("Delete project", "Delete this project and its milestones? Projects with time or invoices cannot be deleted.", "ops-project-delete-yes", id, "Delete project");
        return true;
      case "ops-project-delete-yes":
        await api("/ops/projects/" + encodeURIComponent(id), "DELETE");
        modal.close();
        await done("Project deleted.", "projects");
        return true;
      case "ops-ms-new":
        milestoneForm(id);
        return true;
      case "ops-ms-edit":
        milestoneForm(null, id);
        return true;
      case "ops-ms-delete":
        confirmModal("Delete milestone", "Delete this milestone?", "ops-ms-delete-yes", id, "Delete");
        return true;
      case "ops-ms-delete-yes":
        await api("/ops/milestones/" + encodeURIComponent(id), "DELETE");
        modal.close();
        await done("Milestone deleted.");
        return true;
      case "ops-ms-ready":
      case "ops-ms-pending":
        await api(`/ops/milestones/${encodeURIComponent(id)}/${type === "ops-ms-ready" ? "ready" : "pending"}`, "POST", {});
        await done();
        return true;
      case "ops-ms-invoice": {
        const d = await send(`/ops/milestones/${encodeURIComponent(id)}/invoice`, "POST", {}, crypto.randomUUID());
        await done("Draft invoice created. Review it before issuing.", "document/" + d.id);
        return true;
      }
      case "ops-inventory-on":
      case "ops-inventory-off":
        await api("/ops/inventory", "PUT", { enabled: type === "ops-inventory-on" });
        await done(type === "ops-inventory-on" ? "Inventory is on." : "Inventory is off. Stock records are kept.", type === "ops-inventory-on" ? "inventory" : null);
        return true;
      case "ops-stock-track": {
        const tracked = new Set(ops().inventory.items.map((i) => i.service_id));
        const options = S().services.filter((s) => !tracked.has(s.id));
        if (!options.length) return toast("All catalog items are tracked. Add the item in Services first."), true;
        showModal(
          "Track an item",
          `<form data-form="ops-stock-track">${pick("Catalog item", "service_id", options.map((s) => [s.id, `${s.name} (${s.unit})`]), "", true)}<div class="form-grid">${input("SKU (optional)", "sku", "", "text", false, 'maxlength="40" pattern="[A-Za-z0-9_.\\-/]+"')}${input("Opening quantity", "opening", "0", "number", false, 'min="0" step="0.01"')}${input("Reorder level", "reorder_level", "", "number", false, 'min="0" step="0.01"')}</div><p class="field-hint">Invoice lines for this item (or with this SKU) deduct stock when issued.</p>${formEnd("Track item")}</form>`,
        );
        return true;
      }
      case "ops-stock-receive":
      case "ops-stock-adjust": {
        const i = stockItem(id);
        const receive = type === "ops-stock-receive";
        showModal(
          `${receive ? "Receive" : "Adjust"} ${i.name}`,
          `<form data-form="ops-stock-move" data-id="${E(id)}" data-kind="${receive ? "receive" : "adjust"}"><p>On hand: <strong>${qty(i.on_hand)}</strong> ${E(i.unit)}</p>${input(receive ? "Quantity received" : "Change (use - to reduce)", "quantity", "", "number", true, receive ? 'min="0.01" step="0.01"' : 'step="0.01"')}${input(receive ? "Reference (supplier DO, optional)" : "Reason (required)", "reason", "", "text", !receive, 'maxlength="300"')}${formEnd(receive ? "Receive stock" : "Save adjustment")}</form>`,
        );
        return true;
      }
      case "ops-stock-history": {
        const d = await api("/ops/stock/" + encodeURIComponent(id));
        showModal(
          `Stock history: ${d.item.name || ""}`,
          d.movements.length
            ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Movement</th><th class="num">Quantity</th><th class="num">Balance</th><th>Reason</th></tr></thead><tbody>${d.movements.map((m) => `<tr><td>${timeLabel(m.created)}<small>${E(m.actor)}</small></td><td>${E(MOVE[m.kind])}</td><td class="num">${m.quantity > 0 ? "+" : ""}${qty(m.quantity)}</td><td class="num">${qty(m.balance)}</td><td class="ops-wrap">${E(m.reason)}${m.document_id ? `<small>${docLink(m.document_id)}</small>` : ""}</td></tr>`).join("")}</tbody></table></div>`
            : "<p>No movements yet.</p>",
          true,
        );
        return true;
      }
      case "ops-stock-edit": {
        const i = stockItem(id);
        showModal(
          `Edit ${i.name}`,
          `<form data-form="ops-stock-edit" data-id="${E(id)}"><div class="form-grid">${input("SKU", "sku", i.sku, "text", false, 'maxlength="40" pattern="[A-Za-z0-9_.\\-/]+"')}${input("Reorder level", "reorder_level", i.reorder_level ? qty(i.reorder_level) : "", "number", false, 'min="0" step="0.01"')}</div>${check("Track this item", "active", !!i.active)}${formEnd("Save")}</form>`,
        );
        return true;
      }
      case "po-new":
        poForm(id);
        return true;
      case "po-details":
        await poDetails(id);
        return true;
      case "po-amend":
        poAmendForm(id);
        return true;
      case "po-cancel":
        poCancelForm(id);
        return true;
      case "ops-po-file-delete": {
        const [fid, pid] = id.split("|");
        confirmModal("Delete PO file", "Delete this file? The audit history keeps a record.", "ops-po-file-delete-yes", `${fid}|${pid}`, "Delete file");
        return true;
      }
      case "ops-po-file-delete-yes": {
        const [fid, pid] = id.split("|");
        await api("/files/" + encodeURIComponent(fid), "DELETE");
        await refresh();
        await poDetails(pid);
        toast("File deleted.");
        return true;
      }
      case "ops-work-jump":
        document.getElementById("ops-work-panel")?.scrollIntoView({ behavior: "smooth" });
        return true;
      case "ops-photo-add":
        showModal(
          "Add work photos",
          `<form data-form="ops-photo-upload" data-id="${E(id)}">${pick("Photo type", "kind", [["before", "Before"], ["after", "After"]], "before")}<label>Photos (PNG, JPEG or WEBP)<input type="file" name="photos" accept="image/png,image/jpeg,image/webp" multiple required></label>${check("Client can see these photos", "visible")}<p class="field-hint">Photos are resized and their camera details (such as location) removed before upload. Up to 12 photos per document.</p>${formEnd("Upload")}</form>`,
        );
        return true;
      case "ops-photo-toggle": {
        const p = cached("photos").find((x) => x.id === id);
        await api("/ops/photos/" + encodeURIComponent(id), "PUT", { visible: p?.visibility !== "client" });
        await done(p?.visibility !== "client" ? "The client can now see this photo." : "Photo is now private.");
        return true;
      }
      case "ops-photo-delete":
        confirmModal("Delete photo", "Delete this photo? The audit history keeps a record.", "ops-photo-delete-yes", id, "Delete photo");
        return true;
      case "ops-photo-delete-yes":
        await api("/ops/photos/" + encodeURIComponent(id), "DELETE");
        modal.close();
        await done("Photo deleted.");
        return true;
      case "ops-log-new":
      case "ops-log-edit": {
        const l = type === "ops-log-edit" ? cached("logs").find((x) => x.id === id) : { log_date: S().today, person: "", notes: "", visible: 0 };
        showModal(
          type === "ops-log-edit" ? "Edit work log entry" : "Add work log entry",
          `<form data-form="ops-log-save" data-id="${E(type === "ops-log-edit" ? id : "")}" data-doc="${E(type === "ops-log-new" ? id : "")}"><div class="form-grid">${input("Date", "log_date", l.log_date, "date", true, `max="${S().today}"`)}${input("Person", "person", l.person, "text", true, 'maxlength="120"')}</div>${area("What was done", "notes", l.notes, 1000)}${check("Client can see this entry", "visible", !!l.visible)}${formEnd("Save entry")}</form>`,
        );
        modal.querySelector("[name=notes]").required = true;
        return true;
      }
      case "ops-log-delete":
        confirmModal("Delete work log entry", "Delete this entry?", "ops-log-delete-yes", id, "Delete");
        return true;
      case "ops-log-delete-yes":
        await api("/ops/logs/" + encodeURIComponent(id), "DELETE");
        modal.close();
        await done("Entry deleted.");
        return true;
      case "ops-report": {
        const r = cache.get("work:" + id)?.report || { report: "", visible: 0, pdf: 1 };
        showModal(
          "Service report",
          `<form data-form="ops-report-save" data-id="${E(id)}">${area("Report", "report", r.report, 4000)}${check("Client can see the report", "visible", !!r.visible)}${check("Include proof of work in the PDF", "pdf", !!r.pdf)}<p class="field-hint">The PDF shows only client-visible items: the report, up to 4 PNG or JPEG photos and the work log.</p>${formEnd("Save report")}</form>`,
          true,
        );
        return true;
      }
    }
    return false;
  }
  async function submit(form, b) {
    const type = form.dataset.form,
      id = form.dataset.id;
    switch (type) {
      case "ops-timer-start":
        await api("/ops/timer/start", "POST", { ...b, billable: b.billable === "on" });
        await done("Timer started.");
        return true;
      case "ops-timer-stop": {
        const e = await api("/ops/timer/stop", "POST", { description: b.description });
        modal.close();
        await done(`Saved ${hrs(e.hours100)} hours.`);
        return true;
      }
      case "ops-time-save": {
        const body = { ...b, billable: b.billable === "on" };
        if (id) await api("/ops/time/" + encodeURIComponent(id), "PUT", body);
        else await send("/ops/time", "POST", body, keyFor(form));
        modal.close();
        await done(id ? "Time saved." : "Time added.");
        return true;
      }
      case "ops-time-invoice": {
        const entry_ids = [...form.querySelectorAll("input[name=entry]:checked")].map((x) => x.value);
        if (!entry_ids.length) throw new Error("Choose at least one entry.");
        const d = await send(
          "/ops/time/invoice",
          "POST",
          {
            client_id: form.dataset.client,
            ...(form.dataset.project ? { project_id: form.dataset.project } : {}),
            entry_ids,
            group: b.group,
            tax_rate: Number(b.tax_rate || 0),
            issue_date: b.issue_date,
          },
          keyFor(form),
        );
        modal.close();
        await done("Draft invoice created. Review it before issuing.", "document/" + d.id);
        return true;
      }
      case "ops-project-save": {
        const p = id
          ? await api("/ops/projects/" + encodeURIComponent(id), "PUT", b)
          : await send("/ops/projects", "POST", b, keyFor(form));
        modal.close();
        await done("Project saved.", "project/" + p.id);
        return true;
      }
      case "ops-ms-save": {
        const body = { ...b, tax_rate: Number(b.tax_rate || 0) };
        if (id) await api("/ops/milestones/" + encodeURIComponent(id), "PUT", body);
        else await send(`/ops/projects/${encodeURIComponent(form.dataset.project)}/milestones`, "POST", body, keyFor(form));
        modal.close();
        await done("Milestone saved.");
        return true;
      }
      case "ops-inventory-settings":
        await api("/ops/inventory", "PUT", { trigger: b.trigger });
        await done("Saved.");
        return true;
      case "ops-stock-track":
        await send("/ops/stock", "POST", b, keyFor(form));
        modal.close();
        await done("Item tracked.");
        return true;
      case "ops-stock-move":
        await send(`/ops/stock/${encodeURIComponent(id)}/movements`, "POST", { ...b, kind: form.dataset.kind }, keyFor(form));
        modal.close();
        await done("Stock updated.");
        return true;
      case "ops-stock-edit":
        await api("/ops/stock/" + encodeURIComponent(id), "PUT", { ...b, active: b.active === "on" });
        modal.close();
        await done("Saved.");
        return true;
      case "ops-po-save": {
        const file = form.elements.po_file?.files?.[0];
        const p = await api("/sales/customer-pos", "POST", {
          quote_id: b.quote_id,
          reference: b.reference,
          amount: b.amount,
          po_date: b.po_date,
          notes: b.notes,
        });
        modal.close();
        let note = "Customer PO registered.";
        if (file)
          try {
            await send(`/ops/pos/${encodeURIComponent(p.id)}/files?name=${encodeURIComponent(file.name)}`, "POST", file);
          } catch (e) {
            note = `PO registered, but the file was not saved: ${e.message}`;
          }
        await done(note);
        return true;
      }
      case "ops-po-amend":
      case "ops-po-cancel": {
        const amend = type === "ops-po-amend";
        const r = await send(
          `/ops/pos/${encodeURIComponent(id)}/${amend ? "amend" : "cancel"}`,
          "POST",
          amend
            ? { reference: b.reference, amount: b.amount, po_date: b.po_date, notes: b.notes, reason: b.reason, replace_draft: b.replace_draft === "on" }
            : { reason: b.reason, replace_draft: b.replace_draft === "on" },
          keyFor(form),
        );
        modal.close();
        await done(amend ? `PO amended (revision ${r.revision}).` : "PO cancelled.");
        return true;
      }
      case "ops-photo-upload": {
        const files = [...(form.elements.photos?.files || [])];
        if (!files.length) throw new Error("Choose at least one photo.");
        let added = 0;
        try {
          for (const f of files) {
            const small = await shrink(f);
            await send(
              `/ops/documents/${encodeURIComponent(id)}/photos?${new URLSearchParams({ kind: b.kind, visible: b.visible === "on" ? "1" : "0", name: small.name || "photo" })}`,
              "POST",
              small,
            );
            added++;
          }
        } finally {
          if (added) {
            modal.close();
            await done(`${added} ${added === 1 ? "photo" : "photos"} added.`);
          }
        }
        return true;
      }
      case "ops-log-save": {
        const body = { log_date: b.log_date, person: b.person, notes: b.notes, visible: b.visible === "on" };
        if (id) await api("/ops/logs/" + encodeURIComponent(id), "PUT", body);
        else await api(`/ops/documents/${encodeURIComponent(form.dataset.doc)}/logs`, "POST", body);
        modal.close();
        await done("Work log saved.");
        return true;
      }
      case "ops-report-save":
        await api(`/ops/documents/${encodeURIComponent(id)}/report`, "PUT", { report: b.report, visible: b.visible === "on", pdf: b.pdf === "on" });
        modal.close();
        await done("Report saved.");
        return true;
    }
    return false;
  }
  return {
    nav: [
      { key: "projects", label: "Projects", icon: "folder", group: "Operations" },
      { key: "timesheets", label: "Timesheets", icon: "clock", group: "Operations" },
      { key: "inventory", label: "Inventory", icon: "layers", group: "Operations", hidden: () => !ops().inventory?.enabled },
    ],
    pages: { projects, project: projectPage, timesheets, inventory },
    activeFor: { project: "projects" },
    icons: {
      folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
      camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    },
    action,
    submit,
    slots: {
      topbar: () => {
        const t = ops().timer;
        return t
          ? `<a class="ops-timer-pill" href="#/timesheets" title="Timer running for ${E(clientName(t.client_id))}">${icon("clock")}<span data-ops-since="${E(t.started)}">${elapsed(t.started)}</span></a>`
          : "";
      },
      overview: overviewPanel,
      documentActions: (d) => (d.state !== "void" && ["invoice", "quote"].includes(d.kind) ? button("Proof of work", "ops-work-jump", d.id, false, "camera") : ""),
      documentPanels: (d) => poPanel(d) + billingPanel(d) + workPanel(d),
      clientFields: (c) =>
        input("Default hourly rate (MYR)", "ops_hourly_rate", c.ops_hourly_rate ? dec(c.ops_hourly_rate) : "", "number", false, 'min="0" step="0.01" placeholder="For timesheets"'),
      clientDetails: (c) => (c.ops_hourly_rate ? `<dt>Default hourly rate</dt><dd>${money(c.ops_hourly_rate)} per hour</dd>` : ""),
      clientPanels: clientPanel,
      settings: settingsPanel,
      publicPanels: (d, token) => {
        const w = d.ext?.ops?.work;
        if (!w || (!w.photos.length && !w.logs.length && !w.report)) return "";
        const src = (p) => `/api/guest/ops/work/${encodeURIComponent(token)}/${encodeURIComponent(p.id)}`;
        return `<section class="panel"><h2>Proof of work</h2>${w.report ? `<h3 class="mt22">Service report</h3><p class="ops-pre">${E(w.report)}</p>` : ""}${w.photos.length ? `<div class="ops-photos mt22">${w.photos.map((p) => `<figure class="ops-photo"><a href="${E(src(p))}" target="_blank" rel="noopener"><img src="${E(src(p))}" alt="${p.kind === "before" ? "Before" : "After"} photo" loading="lazy"></a><figcaption><strong>${p.kind === "before" ? "Before" : "After"}</strong></figcaption></figure>`).join("")}</div>` : ""}${w.logs.length ? `<h3 class="mt22">Work log</h3>${w.logs.map((l) => `<div class="payment"><strong>${dateLabel(l.log_date)} · ${E(l.person)}</strong><p class="ops-pre">${E(l.notes)}</p></div>`).join("")}` : ""}</section>`;
      },
    },
  };
}
