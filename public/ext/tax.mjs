// Tax and compliance: SST-02 worksheet, SST on notes, exemptions, LHDN MyInvois e-Invoice, readiness checks and tax threshold monitor.
// Browser module contract: see docs/PLUGINS.md.
export default function taxUI(h) {
  const { dateValue, E, money, dec, dateLabel, timeLabel, button, input, area, select, formEnd, heading, empty, api, refresh, renderRoute, navigate, showModal, modal, toast } = h;
  const S = () => h.get();
  const T = () => S()?.ext?.tax;
  const STATES = {
    queued: ["Queued", "blue"],
    sending: ["Sending", "blue"],
    submitted: ["Awaiting validation", "orange"],
    valid: ["Valid", "green"],
    invalid: ["Invalid", "red"],
    rejected: ["Rejected", "red"],
    cancelled: ["Cancelled", "red"],
    failed: ["Not sent", "red"],
    unknown: ["Checking", "orange"],
  };
  const pill = (label, color = "") => `<span class="badge ${color}"><span class="dot"></span>${E(label)}</span>`;
  const statePill = (e) => (e ? pill(...STATES[e.state]) : pill("Not submitted"));
  const latest = (source, id) => T()?.einvoices.find((e) => e.source === source && e.source_id === id) || null;
  const ACTIVE = ["queued", "sending", "submitted", "valid", "unknown"];
  const isActive = (e) => e && ACTIVE.includes(e.state);
  const typeName = (code) => T()?.codes.types[code] || "e-Invoice";
  const classOptions = (blank = "Not set") => [["", blank], ...Object.entries(T().codes.classes).map(([c, d]) => [c, `${c} ${d}`])];
  const stateOptions = () => [["", "Choose a state"], ...Object.entries(T().codes.states).map(([c, n]) => [c, `${c} ${n}`])];
  const countryOptions = (current) => {
    const common = T().codes.countries;
    const rest = T().codes.allCountries.filter((c) => !common[c]);
    if (current && !common[current] && !rest.includes(current)) rest.unshift(current);
    return [...Object.entries(common).map(([c, n]) => [c, `${n} (${c})`]), ...rest.map((c) => [c, c])];
  };
  const exemptOn = (c, day) => !!c?.tax_exempt && !!c.tax_exempt_ref && (!c.tax_exempt_until || c.tax_exempt_until >= day);
  const missingList = (list) => `<ul class="tax-missing">${list.map((m) => `<li>${E(m)}</li>`).join("")}</ul>`;
  // A notice that stacks its intro, list and link instead of lining them up.
  const missingNotice = (kind, intro, list, link = "") => `<div class="notice ${kind}"><div><p>${intro}</p>${missingList(list)}${link}</div></div>`;
  const small = (label, act, id = "") => `<button type="button" class="btn small" data-action="${act}" data-id="${E(id)}">${E(label)}</button>`;
  const late = (c) => c.closed && c.deadline < S().today;
  const short = (v) => (v ? E(String(v).slice(0, 10)) + "…" : "-");
  let sstPeriod = null,
    conPreview = null;

  // ---- Progress (thresholds) ----
  function meter(label, w, help) {
    const level = { ok: ["On track", "green"], near: ["Above 80%", "orange"], over: ["Reached", "red"] }[w.level];
    return `<div class="tax-meter"><div class="tax-meter-head"><strong>${E(label)}</strong>${pill(...level)}</div><progress class="tax-progress ${w.level}" max="100" value="${Math.min(100, w.percent)}">${w.percent}%</progress><p class="field-hint">${money(T().thresholds.total)} of ${money(w.threshold)} (${w.percent}%)${w.crossed ? ` · reached in ${E(monthLabel(w.crossed))}` : ""}</p>${help ? `<details class="tax-help"><summary>What this means</summary><p class="field-hint">${E(help)}</p></details>` : ""}</div>`;
  }
  const monthLabel = (ym) => dateLabel(ym + "-01").slice(3);
  function thresholdPanel(compact = false) {
    const t = T().thresholds;
    const sstHelp = t.sst.registered
      ? "You are SST registered."
      : t.sst.level === "over"
        ? "Register for SST on MySST. Check the deadline for your service group."
        : "Service tax registration is needed once taxable services pass the threshold in 12 months.";
    const eHelp =
      t.einvoice.level === "ok"
        ? "Below the e-Invoice exemption threshold. It also depends on related companies: the exemption does not apply if a shareholder company, holding, related company or joint venture partner is above it."
        : "Plan for MyInvois e-Invoice. LHDN sets the start date from the year your revenue reached the threshold.";
    return `<section class="panel${compact ? "" : " mt22"}"><div class="panel-head"><div><h2>Tax threshold monitor</h2><p>Sales excluding SST, ${dateLabel(t.from)} to ${dateLabel(t.to)} (issued invoices and debit notes less credit notes)</p></div></div>${meter("SST registration", t.sst, sstHelp)}${meter("e-Invoice exemption", t.einvoice, eHelp)}</section>`;
  }

  // ---- Readiness ----
  function readinessCounts() {
    const ready = T().ready;
    const docs = S().documents.filter((d) => ready[d.id] && d.state === "issued");
    const notReady = docs.filter((d) => !ready[d.id].ready && !isActive(latest("invoice", d.id)));
    return { docs, notReady };
  }
  function readinessPanel(limit = 6) {
    const { docs, notReady } = readinessCounts();
    const gaps = T().supplierGaps;
    return `<section class="panel mt22"><div class="panel-head"><div><h2>MyInvois readiness</h2><p>${docs.length ? `${docs.length - notReady.length} of ${docs.length} issued invoices have everything an e-Invoice needs` : "No issued invoices yet"}</p></div>${pill(notReady.length || gaps.length ? `${notReady.length} need details` : "Ready", notReady.length || gaps.length ? "orange" : "green")}</div>${gaps.length ? missingNotice("warn", "Your business profile is missing:", gaps, '<a class="btn small" href="#/tax/settings">Complete tax settings</a>') : ""}${notReady
      .slice(0, limit)
      .map((d) => `<div class="attention"><div><strong>${E(d.number)}</strong><small>${E(d.client.name)} / ${E(T().ready[d.id].missing.filter((m) => !gaps.includes(m)).slice(0, 3).join("; ") || "business details")}</small><button class="link-button" data-action="open-document" data-id="${E(d.id)}">Review →</button></div></div>`)
      .join("")}${notReady.length > limit ? `<p class="field-hint">${notReady.length - limit} more invoice(s) need details.</p>` : ""}</section>`;
  }
  function warnings() {
    const t = T();
    const out = [];
    for (const c of t.exemptions.expired) out.push(`SST exemption ${c.ref} for ${c.name} expired on ${dateLabel(c.until)}. New documents charge SST again.`);
    for (const c of t.exemptions.expiring) out.push(`SST exemption ${c.ref} for ${c.name} expires on ${dateLabel(c.until)}.`);
    const bad = t.einvoices.filter((e) => ["invalid", "rejected", "failed"].includes(e.state) && latest(e.source, e.source_id)?.id === e.id);
    if (bad.length) out.push(`${bad.length} e-Invoice(s) were not accepted by MyInvois. Fix and submit again.`);
    if (t.candidates.ready.length && t.candidates.closed)
      out.push(`${t.candidates.ready.length} B2C invoice(s) from ${monthLabel(t.candidates.month)} need a consolidated e-Invoice. ${late(t.candidates) ? `It was due by ${dateLabel(t.candidates.deadline)}; submit it now.` : `Submit it by ${dateLabel(t.candidates.deadline)}.`}`);
    return out;
  }
  function overviewSlot() {
    if (!T()) return "";
    const w = warnings();
    const { notReady } = readinessCounts();
    const t = T().thresholds;
    return `<section class="panel mt22 tax-watch"><div class="panel-head"><div><h2>Tax watch</h2><p>SST and MyInvois e-Invoice at a glance</p></div><a href="#/tax">Tax &amp; e-Invoice →</a></div><div class="tax-watch-grid"><div>${meter("SST registration", t.sst, "")}</div><div>${meter("e-Invoice exemption", t.einvoice, "")}</div></div><div class="setting-line"><div><h3>MyInvois ready</h3><p>${notReady.length ? `${notReady.length} issued invoice(s) are missing e-Invoice details: ${notReady.slice(0, 4).map((d) => `<button class="link-button" data-action="open-document" data-id="${E(d.id)}">${E(d.number)}</button>`).join(", ")}${notReady.length > 4 ? " …" : ""}` : "All issued invoices have the details an e-Invoice needs"}</p></div>${notReady.length ? `<a href="#/tax">Review →</a>` : pill("Ready", "green")}</div>${w.map((x) => `<div class="notice warn tax-note"><p>${E(x)}</p></div>`).join("")}</section>`;
  }

  // ---- Document panel ----
  function einvoiceBlock(e) {
    if (!e) return "";
    const errors = e.errors?.length && ["invalid", "rejected", "failed", "unknown"].includes(e.state);
    return `<dl class="detail tax-detail">${e.uuid ? `<dt>UUID</dt><dd class="tax-code">${E(e.uuid)}</dd>` : ""}${e.long_id ? `<dt>Long ID</dt><dd class="tax-code">${E(e.long_id)}</dd>` : ""}${e.submission_uid ? `<dt>Submission UID</dt><dd class="tax-code">${E(e.submission_uid)}</dd>` : ""}<dt>Type</dt><dd>${E(typeName(e.type_code))} · v${E(e.version)} · ${E(e.environment)}</dd>${e.submitted_at ? `<dt>Submitted</dt><dd>${timeLabel(e.submitted_at)}</dd>` : ""}${e.validated_at && e.state === "valid" ? `<dt>Validated</dt><dd>${timeLabel(e.validated_at)}</dd>` : ""}${e.cancelled_at ? `<dt>Cancelled</dt><dd>${timeLabel(e.cancelled_at)}${e.cancel_reason ? " / " + E(e.cancel_reason) : ""}</dd>` : ""}${e.reject_requested ? `<dt>Buyer</dt><dd class="red-text">Asked to reject on ${timeLabel(e.reject_requested)}</dd>` : ""}</dl>${errors ? missingNotice(e.state === "unknown" ? "warn" : "error", e.state === "unknown" ? "Waiting for MyInvois:" : "MyInvois said:", e.errors.map((x) => [x.code, x.message, x.target].filter(Boolean).join(" · "))) : ""}${e.state === "valid" && e.url ? `<div class="tax-qr-row"><img class="tax-qr" src="/api/tax/einvoices/${E(e.id)}/qr.svg" alt="MyInvois validation QR code"><p><a href="${E(e.url)}" target="_blank" rel="noopener noreferrer">Open validation link</a>${e.environment === "sandbox" ? "<br><small>Sandbox test document</small>" : ""}</p></div>` : ""}`;
  }
  // Buttons for an e-Invoice; compact gives small buttons without a wrapper (table cells).
  function einvoiceActions(source, id, e, ready = true, compact = false) {
    const st = T().status;
    const b = (label, act, bid, primary) => (compact ? small(label, act, bid) : button(label, act, bid, primary));
    const out = [];
    if (!isActive(e) && st.configured && ready) out.push(b(e ? "Submit again" : "Submit e-Invoice", "tax-submit", `${source}:${id}`, !e));
    if (e && ["sending", "submitted", "unknown", "valid"].includes(e.state)) out.push(b(compact ? "Check" : "Check status", "tax-check", e.id));
    if (e?.state === "valid" && e.cancel_until && e.cancel_until > new Date().toISOString()) out.push(b(compact ? "Cancel" : "Cancel e-Invoice", "tax-cancel", e.id));
    if (compact) return out.join("");
    return out.length ? `<div class="actions mt22">${out.join("")}</div>` : "";
  }
  function notesBlock(d) {
    if (!d.adjustments?.length) return "";
    const ref = latest("invoice", d.id)?.state === "valid" || T().consolidated.some((c) => c.documents.includes(d.id) && c.einvoice?.state === "valid");
    return `<h3 class="mt22">Credit and debit notes</h3>${d.adjustments
      .map((a) => {
        let lines = [];
        try {
          lines = JSON.parse(a.tax_lines || "[]");
        } catch {
          lines = [];
        }
        const e = latest(a.kind, a.id);
        return `<div class="payment"><div class="payment-top"><strong>${E(a.number)} / ${money(a.amount)}</strong>${statePill(e)}</div><p>${E(a.kind === "credit" ? "Credit note" : "Debit note")}${a.tax_from_lines ? ` · lines ${E(a.tax_from_lines)}` : ""}<br>${lines.length ? lines.map((l) => `${l.rate}%: ${money(l.taxable)}${l.tax ? " + SST " + money(l.tax) : ""}`).join("<br>") : "No SST split (older note)"}</p>${einvoiceBlock(e)}${ref ? einvoiceActions(a.kind, a.id, e) : T().status.configured ? '<p class="field-hint">Submit the invoice as an e-Invoice first; the note then refers to it.</p>' : ""}</div>`;
      })
      .join("")}`;
  }
  function documentPanels(d) {
    const t = T();
    if (!t) return "";
    const exempt = exemptOn(d.client, d.issue_date);
    const exemptNote = exempt
      ? `<div class="notice info tax-note"><p>No SST: ${E(d.client.name)} holds SST exemption ${E(d.client.tax_exempt_ref)}${d.client.tax_exempt_until ? ` (valid until ${dateLabel(d.client.tax_exempt_until)})` : ""}. The PDF states the reference.</p></div>`
      : d.client.tax_exempt && d.client.tax_exempt_until && d.state === "draft"
        ? `<div class="notice warn tax-note"><p>The client's SST exemption ${E(d.client.tax_exempt_ref)} expired on ${dateLabel(d.client.tax_exempt_until)}. SST is charged on this document.</p></div>`
        : "";
    const r = t.ready[d.id];
    if (d.kind !== "invoice" || !r) return exemptNote ? `<section class="panel"><div class="panel-head"><h2>SST</h2></div>${exemptNote}</section>` : "";
    const e = latest("invoice", d.id);
    const con = t.consolidated.find((c) => c.documents.includes(d.id));
    const status = !t.status.configured
      ? '<p class="field-hint">MyInvois is not connected. Add the keys in Settings > Integration keys to submit.</p>'
      : "";
    const readyHtml =
      r.mode === "consolidated"
        ? `<p class="field-hint">${con ? `Included in consolidated e-Invoice ${E(con.number)}.` : "This buyer did not ask for an e-Invoice. The sale goes into the monthly consolidated e-Invoice."}</p>${con ? statePill(con.einvoice) : ""}`
        : r.ready
          ? `<p class="field-hint">${isActive(e) ? "" : "Ready for MyInvois."}</p>`
          : `<div class="notice warn"><p>Missing for an e-Invoice:</p>${missingList(r.missing)}<div class="actions">${button("Edit client", "edit-client", d.client_id)}<a class="btn" href="#/tax/settings">Tax settings</a></div></div>`;
    const lines = t.classes[d.id] || [];
    const classes = `<div class="setting-line"><div><h3>Classification</h3><p>${E([...new Set(lines.map((l) => l.code || "missing"))].join(", ") || "-")}</p></div>${!isActive(e) || e?.state === "queued" ? button("Change", "tax-classes", d.id) : ""}</div>`;
    return `<section class="panel tax-panel"><div class="panel-head"><h2>e-Invoice</h2>${r.mode === "consolidated" ? pill("Consolidated", "blue") : statePill(e)}</div>${exemptNote}${status}${d.state === "issued" || d.state === "void" ? readyHtml : `<p class="field-hint">Issue the invoice first. ${r.ready ? "Its details are complete." : "Still missing: " + E(r.missing.slice(0, 4).join("; "))}</p>`}${einvoiceBlock(e)}${d.state === "issued" && r.mode !== "consolidated" ? einvoiceActions("invoice", d.id, e, r.ready) : ""}${classes}${notesBlock(d)}</section>`;
  }
  function documentActions(d) {
    const t = T();
    if (!t || d.kind !== "invoice" || d.state !== "issued" || !t.status.configured) return "";
    const r = t.ready[d.id];
    if (!r?.ready || r.mode === "consolidated" || isActive(latest("invoice", d.id))) return "";
    return button("Submit e-Invoice", "tax-submit", `invoice:${d.id}`);
  }
  function documentFields(value) {
    const t = T();
    if (!t) return "";
    const current = (t.classes[value.id] || []).find((l) => l.source === "document")?.code || "";
    return `<div class="form-grid tax-doc-fields">${select("e-Invoice classification (lines without a service default)", "tax_class", classOptions(t.settings.defaultClass ? `Business default (${t.settings.defaultClass})` : "Not set"), current, false)}<div class="tax-exempt-note" data-tax-exempt-note>${exemptText(value.client_id, value.issue_date)}</div></div>`;
  }
  function exemptText(clientId, day) {
    const c = S().clients.find((x) => x.id === clientId);
    if (!c?.tax_exempt) return "";
    return exemptOn(c, day || S().today)
      ? `<p class="field-hint tax-ok">${E(c.name)} is SST exempt (${E(c.tax_exempt_ref)}). SST is removed when you save.</p>`
      : `<p class="field-hint red-text">${E(c.name)}'s SST exemption ${E(c.tax_exempt_ref)} is not valid on this date. SST is charged.</p>`;
  }

  // ---- Client form and profile ----
  function clientFields(c) {
    const t = T();
    if (!t) return "";
    return `<input type="hidden" name="tax_fields" value="1"><div class="span-2 tax-fieldset"><h3>SST exemption</h3></div><label class="check-row span-2"><input type="checkbox" name="tax_exempt" ${c.tax_exempt ? "checked" : ""}> This client is exempt from SST. Documents charge no SST while the exemption is valid.</label>${input("Exemption reference / certificate no.", "tax_exempt_ref", c.tax_exempt_ref || "", "text", false, 'maxlength="60"')}${input("Valid until (optional)", "tax_exempt_until", c.tax_exempt_until || "", "date")}<div class="span-2 tax-fieldset"><h3>e-Invoice (MyInvois)</h3><p class="field-hint">The registration / IC number above is the buyer ID number. Use the buyer's TIN from LHDN. For an individual without a TIN, LHDN's general TIN is used with their MyKad or passport number.</p></div>${select("ID type", "tax_id_type", [["", "Not set"], ...Object.entries(t.codes.idTypes)], c.tax_id_type || "", false)}${select("e-Invoice", "tax_einvoice", [["individual", "Own e-Invoice"], ["consolidate", "Monthly consolidated (buyer did not ask)"]], c.tax_einvoice || "individual")}<div class="span-2">${area("Address lines (up to 3)", "tax_addr_lines", c.tax_addr_lines || "", 450)}</div>${input("City", "tax_city", c.tax_city || "", "text", false, 'maxlength="50"')}${input("Postcode", "tax_postcode", c.tax_postcode || "", "text", false, 'maxlength="10" inputmode="numeric"')}${select("State", "tax_state", stateOptions(), c.tax_state || "", false)}${select("Country", "tax_country", countryOptions(c.tax_country), c.tax_country || "MYS")}`;
  }
  function clientDetails(c) {
    const t = T();
    if (!t) return "";
    const ex = c.tax_exempt
      ? `${E(c.tax_exempt_ref)}${c.tax_exempt_until ? " · valid until " + dateLabel(c.tax_exempt_until) : " · no end date"}${c.tax_exempt_until && c.tax_exempt_until < S().today ? " " + pill("Expired", "red") : ""}`
      : "Not exempt";
    const where = [t.codes.idTypes[c.tax_id_type] ? c.tax_id_type : "", t.codes.states[c.tax_state] || "", c.tax_einvoice === "consolidate" ? "Monthly consolidated" : "Own e-Invoice"].filter(Boolean).join(" · ");
    return `<dt>SST exemption</dt><dd>${ex}</dd><dt>e-Invoice</dt><dd>${E(where)}</dd>`;
  }

  // ---- Pages ----
  const TABS = [
    ["overview", "Overview"],
    ["sst", "SST-02 worksheet"],
    ["einvoice", "e-Invoices"],
    ["selfbilled", "Self-billed"],
    ["settings", "Settings"],
  ];
  function page(tab = "overview") {
    const t = T();
    if (!t) return empty("Tax module unavailable", "Reload the page.");
    if (!TABS.some(([k]) => k === tab)) tab = "overview";
    const nav = `<div class="tabs" role="navigation" aria-label="Tax sections">${TABS.map(([k, l]) => `<a class="tab ${k === tab ? "active" : ""}" href="#/tax/${k}" ${k === tab ? 'aria-current="page"' : ""}>${E(l)}</a>`).join("")}</div>`;
    const body = { overview, sst: sstTab, einvoice: einvoiceTab, selfbilled: selfBilledTab, settings: settingsTab }[tab]();
    return heading("Tax", "") + nav + body;
  }
  function overview() {
    const t = T();
    const w = warnings();
    const st = t.status;
    const count = (states) => t.einvoices.filter((e) => states.includes(e.state)).length;
    return `${w.map((x) => `<div class="notice warn"><p>${E(x)}</p></div>`).join("")}<div class="grid-equal"><section class="panel"><div class="panel-head"><div><h2>MyInvois connection</h2><p>${st.configured ? `Connected to the ${E(st.env)} environment · documents version ${E(st.version)}${st.version === "1.0" ? " (unsigned; add a certificate for signed 1.1)" : " (signed)"}` : "Not connected. Add your MyInvois client ID and secret in Settings > Integration keys."}</p></div>${pill(st.configured ? "Connected" : "Not connected", st.configured ? "green" : "")}</div><div class="metrics tax-metrics"><div class="metric"><div class="label">Valid</div><div class="value teal">${count(["valid"])}</div></div><div class="metric"><div class="label">Waiting</div><div class="value">${count(["queued", "sending", "submitted", "unknown"])}</div></div><div class="metric"><div class="label">Not accepted</div><div class="value ${count(["invalid", "rejected", "failed"]) ? "red-text" : ""}">${count(["invalid", "rejected", "failed"])}</div></div></div><div class="actions">${st.configured ? button("Test connection", "tax-test") : '<a class="btn" href="#/settings">Open Settings</a>'}<a class="btn" href="#/tax/einvoice">View e-Invoices</a></div></section>${thresholdPanel(true)}</div>${readinessPanel()}`;
  }

  // SST-02 worksheet, loaded on demand.
  function sstTab() {
    const t = T();
    const periods = t.periods;
    if (!sstPeriod) sstPeriod = (periods[1] || periods[0]).key;
    setTimeout(() => loadSst(sstPeriod), 0);
    return `<div class="notice info"><p>A working aid laid out like the SST-02 return. File and pay on MySST (mysst.customs.gov.my); nothing is sent to Customs from here. Taxable period: ${t.settings.sstPeriodMonths} month(s). Service tax is counted ${t.settings.serviceTaxBasis === "payment" ? "when payment is received" : "on the invoice date (approved accrual basis)"}.</p></div><section class="panel"><form data-form="tax-sst" class="tax-inline">${select("Taxable period", "period", periods.map((p) => [p.key, `${dateLabel(p.from)} – ${dateLabel(p.to)}`]), sstPeriod)}<button class="btn primary" type="submit">Show</button><a class="btn" href="/api/tax/sst02.pdf?period=${E(sstPeriod)}">${h.icon("download")} PDF</a><a class="btn" href="/api/tax/sst02.csv?period=${E(sstPeriod)}">${h.icon("download")} CSV</a></form></section><div id="tax-sst-sheet" class="mt22"><p class="field-hint">Loading worksheet…</p></div>`;
  }
  async function loadSst(period) {
    const el = document.getElementById("tax-sst-sheet");
    if (!el) return;
    try {
      const ws = await api(`/tax/sst02?period=${encodeURIComponent(period)}`);
      if (document.getElementById("tax-sst-sheet") === el) el.innerHTML = sheet(ws);
    } catch (e) {
      el.innerHTML = `<div class="notice error"><p>${E(e.message)}</p></div>`;
    }
  }
  function sheet(ws) {
    const row = (k, label, v) => `<tr><td>${E(k)}</td><td>${E(label)}</td><td class="num">${money(v.value)}</td><td class="num">${money(v.tax)}</td></tr>`;
    return `${ws.warnings.map((w) => `<div class="notice warn"><p>${E(w)}</p></div>`).join("")}<div class="grid-equal"><section class="panel"><div class="panel-head"><h2>Part A · Registered person</h2></div><dl class="detail"><dt>SST registration</dt><dd>${E(ws.sstNumber || "Not set")}</dd><dt>Name</dt><dd>${E(ws.business)}</dd><dt>Taxable period</dt><dd>${dateLabel(ws.period.from)} – ${dateLabel(ws.period.to)}</dd><dt>Return and payment due</dt><dd>${dateLabel(ws.period.due)}</dd></dl></section><section class="panel"><div class="panel-head"><h2>Tax payable</h2></div><div class="total-row"><span>12 · Total tax</span><strong>${money(ws.item12)}</strong></div><div class="total-row"><span>13(a) · Tax from credit notes</span><strong>−${money(ws.deductions.a)}</strong></div><div class="total-row"><span>13(b)–(d) · Approved deductions, bad debt relief</span><strong>Enter on MySST</strong></div><div class="total-row emphasis"><span>14 · Total tax payable</span><span>${money(ws.item14)}</span></div><p class="field-hint">Penalties (items 15–16) are worked out by Customs.</p></section></div><section class="panel mt22"><div class="panel-head"><h2>Part B2 · Value and tax by rate</h2></div><div class="table-wrap"><table><thead><tr><th>Item</th><th>Description</th><th class="num">Taxable value</th><th class="num">Tax</th></tr></thead><tbody>${row("11(a)", "Sales tax 5%", ws.items["11a"])}${row("11(b)", "Sales tax 10%", ws.items["11b"])}${row("11(c)", "Service tax 6%", ws.items["11c"])}${row("11(d)", "Service tax 8%", ws.items["11d"])}<tr><td>11(e)</td><td>Credit / charge card services (RM25 per card)</td><td class="num">Not tracked</td><td class="num">-</td></tr><tr><td><strong>12</strong></td><td><strong>Total tax</strong></td><td></td><td class="num"><strong>${money(ws.item12)}</strong></td></tr></tbody></table></div></section><section class="panel mt22"><div class="panel-head"><h2>Part D · Exempt and non-taxable sales</h2></div><div class="total-row"><span>Sales to SST-exempt customers</span><strong>${money(ws.partD.exempt)}</strong></div><div class="total-row"><span>Other sales without SST</span><strong>${money(ws.partD.other)}</strong></div></section><section class="panel mt22"><details><summary><strong>Documents in this period (${ws.rows.length})</strong></summary>${ws.rows.length ? `<div class="table-wrap mt22"><table><thead><tr><th>Item</th><th>Date</th><th>Document</th><th>Client</th><th class="num">Rate</th><th class="num">Value</th><th class="num">Tax</th></tr></thead><tbody>${ws.rows.map((r) => `<tr><td>${E(r.item)}</td><td>${dateLabel(r.date)}</td><td>${E(r.number)}<small>${E(r.kind)}</small></td><td>${E(r.client)}</td><td class="num">${r.rate}%</td><td class="num">${money(r.value)}</td><td class="num">${money(r.tax)}</td></tr>`).join("")}</tbody></table></div>` : '<p class="field-hint mt22">Nothing to report for this period.</p>'}</details></section>`;
  }

  function einvoiceTab() {
    const t = T();
    const docName = (e) => {
      if (e.source === "invoice" || e.source === "credit" || e.source === "debit") return e.code_number || "Queued";
      return e.code_number || "-";
    };
    const link = (e) => {
      if (e.source === "invoice") return `<button class="link-button" data-action="open-document" data-id="${E(e.source_id)}">${E(docName(e))}</button>`;
      if (e.source === "credit" || e.source === "debit") {
        const d = S().documents.find((x) => x.adjustments?.some((a) => a.id === e.source_id));
        return d ? `<button class="link-button" data-action="open-document" data-id="${E(d.id)}">${E(docName(e))}</button>` : E(docName(e));
      }
      return E(docName(e));
    };
    const refunds = (S().finance?.receipts || []).flatMap((r) => r.refunds.map((f) => ({ ...f, client: r.client.name, client_id: r.client_id })));
    const c = conPreview || t.candidates;
    return `<section class="panel"><div class="panel-head"><div><h2>Monthly consolidated e-Invoice</h2><p>B2C sales where the buyer did not ask for an e-Invoice are reported together within 7 days after the month ends. Sales above RM10,000 need their own e-Invoice.</p></div></div><form data-form="tax-con" class="tax-inline">${input("Month", "month", c.month, "month", true)}<button class="btn" type="submit">Preview</button></form><div class="mt22"><p>${c.ready.length ? `${E(monthLabel(c.month))}: ${c.ready.length} invoice(s) to consolidate, ${money(c.ready.reduce((s, x) => s + x.total, 0))}. ${late(c) ? `<strong class="red-text">Overdue: due ${dateLabel(c.deadline)}.</strong>` : `Submit by ${dateLabel(c.deadline)}.`}` : `${E(monthLabel(c.month))}: nothing left to consolidate.`}</p>${c.tooLarge.length ? `<div class="notice warn"><p>Need their own e-Invoice (above RM10,000): ${E(c.tooLarge.map((x) => x.number).join(", "))}</p></div>` : ""}${c.ready.length && c.closed ? `<div class="actions">${button("Create consolidated e-Invoice", "tax-con-create", c.month, true)}</div>` : !c.closed ? '<p class="field-hint">The month has not ended yet.</p>' : ""}</div>${t.consolidated.length ? `<div class="table-wrap mt22"><table><thead><tr><th>Number</th><th>Month</th><th class="num">Invoices</th><th>Status</th><th>Actions</th></tr></thead><tbody>${t.consolidated.map((x) => `<tr><td><strong>${E(x.number)}</strong>${x.einvoice?.uuid ? `<small class="tax-code">${E(x.einvoice.uuid)}</small>` : ""}</td><td>${E(monthLabel(x.month))}</td><td class="num">${x.count}</td><td>${statePill(x.einvoice)}</td><td><div class="actions">${einvoiceActions("consolidated", x.id, x.einvoice, true, true)}${!isActive(x.einvoice) && x.einvoice?.state !== "cancelled" ? small("Delete", "tax-con-delete", x.id) : ""}${x.einvoice?.state === "valid" && x.einvoice.url ? `<a class="btn small" href="${E(x.einvoice.url)}" target="_blank" rel="noopener noreferrer">Validation link</a>` : ""}</div></td></tr>`).join("")}</tbody></table></div>` : ""}</section><section class="panel mt22"><div class="panel-head"><div><h2>Submissions</h2><p>Every e-Invoice sent to MyInvois, newest first.</p></div></div>${t.einvoices.length ? `<div class="table-wrap"><table><thead><tr><th>Document</th><th>Type</th><th>Status</th><th>UUID</th><th>Submitted</th><th>Actions</th></tr></thead><tbody>${h.paged(t.einvoices).rows.map((e) => `<tr><td>${link(e)}</td><td>${E(typeName(e.type_code))}<small>v${E(e.version)} · ${E(e.environment)}</small></td><td>${statePill(e)}${e.errors?.length && e.state !== "valid" ? `<small>${E(e.errors[0].message)}</small>` : ""}</td><td class="tax-code">${short(e.uuid)}</td><td>${e.submitted_at ? timeLabel(e.submitted_at) : "-"}</td><td><div class="actions">${["submitted", "unknown", "valid"].includes(e.state) ? small("Check", "tax-check", e.id) : ""}${e.url ? `<a class="btn small" href="${E(e.url)}" target="_blank" rel="noopener noreferrer">Link</a>` : ""}</div></td></tr>`).join("")}</tbody></table></div>${h.paged(t.einvoices).nav}` : empty("No e-Invoices yet", "Submit an issued invoice from its page.")}</section>${refunds.length ? `<section class="panel mt22"><div class="panel-head"><div><h2>Refund notes</h2><p>A refund e-Invoice (type 04) refers to the validated invoice it relates to.</p></div></div>${refunds.map((f) => { const e = latest("refund", f.id); return `<div class="attention"><div><strong>${E(f.number)} / ${money(f.amount)}</strong><small>${E(f.client)} / ${E(f.reason)}</small></div><div class="actions">${statePill(e)}${!isActive(e) && t.status.configured ? small(e ? "Submit again" : "Submit e-Invoice", "tax-refund", f.id) : ""}${e && ["submitted", "unknown", "valid"].includes(e.state) ? small("Check", "tax-check", e.id) : ""}</div></div>`; }).join("")}</section>` : ""}<section class="panel mt22"><div class="panel-head"><div><h2>Check a TIN</h2><p>Asks MyInvois whether a TIN matches the ID number.</p></div></div><form data-form="tax-tin" class="form-grid">${input("TIN", "tin", "", "text", true, 'maxlength="14"')}${select("ID type", "id_type", Object.entries(t.codes.idTypes), "BRN")}${input("ID number", "id_value", "", "text", true, 'maxlength="30"')}<div class="form-actions span-2">${h.errorBlock()}<button class="btn" type="submit" ${t.status.configured ? "" : "disabled"}>Check TIN</button></div></form></section>`;
  }

  function selfBilledTab() {
    const t = T();
    return `<section class="panel"><div class="panel-head"><div><h2>Self-billed e-Invoices</h2><p>For purchases where you issue the e-Invoice instead of the seller: foreign suppliers, individuals who are not in business, agents and similar cases.</p></div>${button("New self-billed", "tax-sb-new", "", true, "plus")}</div>${t.selfbilled.length ? `<div class="table-wrap"><table><thead><tr><th>Number</th><th>Type</th><th>Seller</th><th>Date</th><th class="num">Total</th><th>Status</th><th>Actions</th></tr></thead><tbody>${t.selfbilled.map((x) => `<tr><td><strong>${E(x.number)}</strong></td><td>${E(typeName(x.type_code))}</td><td>${E(x.supplier)}</td><td>${dateLabel(x.issue_date)}</td><td class="num">${E(x.currency)} ${dec(x.total)}</td><td>${statePill(x.einvoice)}</td><td><div class="actions">${einvoiceActions("selfbilled", x.id, x.einvoice, true, true)}<a class="btn small" href="/api/tax/selfbilled/${E(x.id)}/pdf">PDF</a></div></td></tr>`).join("")}</tbody></table></div>` : empty("No self-billed documents", "Create one when a seller cannot issue you an e-Invoice.")}</section>`;
  }
  function selfBilledForm() {
    const t = T();
    const originals = t.selfbilled.filter((x) => x.type_code === "11");
    const lineRow = (n) =>
      `<div class="tax-sb-line" data-line="${n}"><input aria-label="Description" name="l_description" maxlength="300" placeholder="Description"><input aria-label="Quantity" name="l_quantity" type="number" min="0.01" step="0.01" value="1"><input aria-label="Unit price" name="l_rate" type="number" min="0" step="0.01" placeholder="Unit price"><select aria-label="SST rate" name="l_tax_rate">${[0, 5, 6, 8, 10].map((r) => `<option value="${r}">${r ? r + "%" : "No SST"}</option>`).join("")}</select><select aria-label="Classification" name="l_class">${classOptions("Classification").map(([c, d]) => `<option value="${E(c)}" ${c === "035" ? "selected" : ""}>${E(d)}</option>`).join("")}</select></div>`;
    showModal(
      "New self-billed e-Invoice",
      `<form data-form="tax-selfbilled"><div class="form-grid">${select("Type", "type_code", [["11", "Self-billed invoice"], ...(originals.length ? [["12", "Self-billed credit note"], ["13", "Self-billed debit note"], ["14", "Self-billed refund note"]] : [])], "11")}${originals.length ? select("Original self-billed invoice (for notes)", "ref_id", [["", "Not a note"], ...originals.map((x) => [x.id, `${x.number} / ${x.supplier}`])], "", false) : ""}${input("Issue date", "issue_date", S().today, "date", true, `max="${S().today}"`)}${input("Currency", "currency", "MYR", "text", true, 'maxlength="3" pattern="[A-Za-z]{3}"')}${input("Exchange rate to MYR (if not MYR)", "fx_rate", "", "text", false, 'maxlength="20" inputmode="decimal"')}</div><h3 class="mt22">Seller</h3><div class="form-grid">${input("Name", "s_name", "", "text", true, 'maxlength="200"')}${input("TIN (EI00000000030 for a foreign seller)", "s_tin", "", "text", true, 'maxlength="14" list="tax-general-tins"')}<datalist id="tax-general-tins">${Object.entries(t.codes.generalTins).map(([c, d]) => `<option value="${E(c)}">${E(d)}</option>`).join("")}</datalist>${select("ID type", "s_id_type", Object.entries(t.codes.idTypes), "BRN")}${input("ID number (NA if foreign)", "s_id_value", "NA", "text", true, 'maxlength="30"')}${input("SST number (NA if none)", "s_sst", "NA", "text", false, 'maxlength="40"')}${input("Phone with country code", "s_phone", "", "text", true, 'maxlength="20" placeholder="+6591234567"')}${input("Email", "s_email", "", "email", false, 'maxlength="160"')}${input("MSIC code (00000 if not applicable)", "s_msic", "00000", "text", true, 'maxlength="5"')}<div class="span-2">${input("Business activity (NA if not applicable)", "s_activity", "NA", "text", true, 'maxlength="300"')}</div><div class="span-2">${area("Address lines (up to 3)", "s_address", "", 450)}</div>${input("City", "s_city", "", "text", true, 'maxlength="50"')}${input("Postcode", "s_postcode", "", "text", false, 'maxlength="10"')}${select("State (Not applicable outside Malaysia)", "s_state", stateOptions(), "")}${select("Country", "s_country", countryOptions("MYS"), "MYS")}</div><h3 class="mt22">Lines</h3><div id="tax-sb-lines">${lineRow(0)}</div><div class="actions">${button("Add line", "tax-sb-add-line", "", false, "plus")}</div>${area("Notes", "notes", "", 1000)}${formEnd("Create")}</form>`,
      true,
    );
    modal.querySelector("[name=s_address]").required = true;
    modal._taxLine = lineRow;
  }

  function settingsTab() {
    const t = T();
    const s = t.settings;
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return `<form data-form="tax-settings"><div class="grid-equal"><section class="panel"><div class="panel-head"><div><h2>Business e-Invoice profile</h2><p>Your TIN, registration number, SST number, phone and email come from Settings.</p></div></div>${t.supplierGaps.length ? missingNotice("warn", "Still missing:", t.supplierGaps) : ""}<div class="form-grid">${input("MSIC code", "msic", s.msic, "text", false, 'maxlength="5" inputmode="numeric" list="tax-msic"')}<datalist id="tax-msic">${Object.entries(t.codes.msic).map(([c, d]) => `<option value="${E(c)}">${E(d)}</option>`).join("")}</datalist>${select("Registration type", "idType", Object.entries(t.codes.idTypes), s.idType)}<div class="span-2">${input("Business activity description", "activity", s.activity, "text", false, 'maxlength="300"')}</div><div class="span-2">${area("Address lines (up to 3)", "addressLines", s.addressLines, 450)}</div>${input("City", "city", s.city, "text", false, 'maxlength="50"')}${input("Postcode", "postcode", s.postcode, "text", false, 'maxlength="10"')}${select("State", "state", stateOptions(), s.state, false)}${select("Country", "country", countryOptions(s.country), s.country)}<div class="span-2">${select("Default classification", "defaultClass", classOptions("None (set per line)"), s.defaultClass, false)}</div></div><label class="check-row mt22"><input type="checkbox" name="autoSubmit" ${s.autoSubmit ? "checked" : ""} ${t.status.configured ? "" : "disabled"}> Submit each invoice to MyInvois automatically when it is issued (and its notes once the invoice is valid).</label><p class="field-hint">Off by default. Each document is sent at most once; problems are shown on the document.</p></section><section class="panel"><div class="panel-head"><div><h2>SST-02 and thresholds</h2><p>Set the taxable period Customs gave you.</p></div></div><div class="form-grid">${select("Taxable period", "sstPeriodMonths", [1, 2, 3, 4, 5, 6].map((n) => [String(n), n === 1 ? "1 month" : `${n} months`]), String(s.sstPeriodMonths))}${select("First period starts in", "sstPeriodStart", months.map((m, i) => [String(i + 1), m]), String(s.sstPeriodStart))}<div class="span-2">${select("Service tax counted", "serviceTaxBasis", [["payment", "When payment is received (default rule)"], ["invoice", "On the invoice date (only with Customs approval)"]], s.serviceTaxBasis)}</div>${input("SST registration threshold (MYR)", "sstThreshold", dec(s.sstThreshold), "number", true, 'min="10000" step="0.01"')}${input("e-Invoice exemption threshold (MYR)", "einvoiceThreshold", dec(s.einvoiceThreshold), "number", true, 'min="10000" step="0.01"')}</div><p class="field-hint">Most taxable services register at RM500,000 in 12 months; some groups use RM1,000,000 or RM1,500,000. The e-Invoice exemption is RM3,000,000 annual revenue under LHDN's guideline 4.8, unless a related company is above it.</p></section></div>${h.errorBlock()}<div class="form-actions"><button class="btn primary" type="submit">Save tax settings</button></div></form><section class="panel mt22"><div class="panel-head"><div><h2>Service classifications</h2><p>Lines added from a service use its classification on the e-Invoice.</p></div></div>${S().services.length ? `<form data-form="tax-services"><div class="table-wrap"><table><thead><tr><th>Service</th><th>Classification</th></tr></thead><tbody>${S().services.map((v) => `<tr><td><strong>${E(v.name)}</strong><small>${E(v.unit)}</small></td><td><label class="tax-cell"><span class="sr-only">Classification for ${E(v.name)}</span><select name="svc_${E(v.id)}">${classOptions("Use the default").map(([c, l]) => `<option value="${E(c)}" ${c === (v.tax_class || "") ? "selected" : ""}>${E(l)}</option>`).join("")}</select></label></td></tr>`).join("")}</tbody></table></div>${h.errorBlock()}<div class="form-actions"><button class="btn" type="submit">Save classifications</button></div></form>` : empty("No services", "Add services to set their classification.")}</section>`;
  }

  // ---- Credit/debit note form with SST line choice ----
  function noteForm(did) {
    const d = S().documents.find((x) => x.id === did);
    if (!d) return false;
    showModal(
      "Issue adjustment note",
      `<form data-form="adjustment" data-id="${E(did)}" data-tax-lines="1"><div class="notice info"><p>${E(d.number)} / current invoice value ${money(d.adjusted_total)}<br>The original invoice stays unchanged. Credits release any excess allocation to customer funds.</p></div>${select("Note type", "kind", [["credit", "Credit note - reduce invoice"], ["debit", "Debit note - add charge"]])}<div class="form-grid">${input("Adjustment amount including SST (MYR)", "amount", "", "number", true, 'min="0.01" step="0.01"')}${input("Issue date", "issue_date", S().today, "date", true, `max="${S().today}"`)}</div>${area("Reason shown on the note", "reason", "", 1000)}${d.items.length > 1 || d.tax ? `<fieldset class="tax-lines"><legend>SST split</legend><p class="field-hint">Leave all unticked to split the amount across the whole invoice. Tick lines to split it across those lines only.</p>${d.items.map((i, n) => `<label class="check-row"><input type="checkbox" name="tax_line" value="${n}"> ${n + 1}. ${E(i.description.slice(0, 80))} · ${money((i.taxable ?? i.amount) + (i.tax || 0))}${i.tax_rate ? ` (SST ${i.tax_rate}%)` : ""}</label>`).join("")}</fieldset>` : ""}${formEnd("Issue note")}</form>`,
    );
    modal.querySelector("[name=reason]").required = true;
    return true;
  }
  function classesForm(did) {
    const d = S().documents.find((x) => x.id === did);
    const lines = T().classes[did] || [];
    showModal(
      "e-Invoice classification",
      `<form data-form="tax-classes" data-id="${E(did)}"><p class="field-hint">Each line needs a MyInvois classification code. Leave a line on "Default" to use the service, document or business default.</p>${d.items.map((i, n) => `<div class="tax-class-line">${select(`${n + 1}. ${i.description.slice(0, 60)}`, "line_" + n, classOptions(`Default${lines[n]?.code && lines[n].source !== "line" ? ` (${lines[n].code})` : ""}`), lines[n]?.source === "line" ? lines[n].code : "", false)}</div>`).join("")}${formEnd("Save")}</form>`,
      true,
    );
  }
  function refundForm(fid) {
    const r = (S().finance?.receipts || []).find((x) => x.refunds.some((f) => f.id === fid));
    const t = T();
    const validFor = (id) => latest("invoice", id)?.state === "valid" || t.consolidated.some((c) => c.documents.includes(id) && c.einvoice?.state === "valid");
    const docs = S().documents.filter((d) => d.kind === "invoice" && d.client_id === r?.client_id && validFor(d.id));
    if (!docs.length) return toast("This client has no validated e-Invoice to refer to.", true);
    showModal(
      "Refund e-Invoice",
      `<form data-form="tax-refund" data-id="${E(fid)}"><p>Choose the invoice this refund relates to. Its e-Invoice UUID is quoted on the refund note.</p>${select("Invoice", "invoice_id", docs.map((d) => [d.id, `${d.number} / ${money(d.adjusted_total)}`]), t.refundRefs[fid] || docs[0].id)}${formEnd("Submit refund e-Invoice")}</form>`,
    );
  }

  async function done(message) {
    modal.open && modal.close();
    await refresh();
    renderRoute();
    if (message) toast(message);
  }
  const submitted = (e) =>
    e.state === "valid"
      ? "Validated by MyInvois."
      : e.state === "submitted"
        ? "Submitted. MyInvois is validating it; the status updates automatically."
        : e.state === "unknown"
          ? "MyInvois did not answer. The status will be checked again before anything is resent."
          : "MyInvois did not accept it. See the errors on the document.";

  async function action(type, id) {
    if (!T()) return false;
    switch (type) {
      case "invoice-adjust":
        return noteForm(id);
      case "tax-submit": {
        const [source, sid] = id.split(":");
        const e = await api("/tax/einvoices", "POST", { source, id: sid });
        await done(submitted(e));
        return true;
      }
      case "tax-check": {
        const e = await api(`/tax/einvoices/${id}/check`, "POST", {});
        await done(`Status: ${STATES[e.state][0]}.`);
        return true;
      }
      case "tax-cancel":
        showModal(
          "Cancel e-Invoice",
          `<form data-form="tax-cancel" data-id="${E(id)}"><p>MyInvois allows cancellation within 72 hours of validation. The reason is sent to LHDN and the buyer. The invoice in Kosongsatu stays issued; void it or issue a credit note if needed.</p>${area("Reason (required)", "reason", "", 300)}${formEnd("Cancel e-Invoice")}</form>`,
        );
        modal.querySelector("[name=reason]").required = true;
        return true;
      case "tax-test": {
        const r = await api("/tax/test", "POST", {});
        toast(`Signed in to MyInvois (${r.env}). Documents use version ${r.version}${r.signing ? `; certificate valid until ${dateLabel(r.signing.validTo.slice(0, 10))}` : ""}.`);
        return true;
      }
      case "tax-classes":
        classesForm(id);
        return true;
      case "tax-refund":
        refundForm(id);
        return true;
      case "tax-con-create": {
        const c = await api("/tax/consolidated", "POST", { month: id });
        conPreview = null;
        await done(`${c.number} created with ${c.count} invoice(s). Submit it from the list.`);
        return true;
      }
      case "tax-con-delete":
        await api(`/tax/consolidated/${id}`, "DELETE");
        await done("Consolidated e-Invoice removed. Its invoices can be consolidated again.");
        return true;
      case "tax-sb-new":
        selfBilledForm();
        return true;
      case "tax-sb-add-line": {
        const box = modal.querySelector("#tax-sb-lines");
        if (box.children.length < 50) box.insertAdjacentHTML("beforeend", modal._taxLine(box.children.length));
        return true;
      }
    }
    return false;
  }
  async function submit(form, b) {
    if (!T()) return false;
    const type = form.dataset.form,
      id = form.dataset.id;
    if (type === "adjustment" && form.dataset.taxLines) {
      const lines = [...form.querySelectorAll("input[name=tax_line]:checked")].map((x) => Number(x.value));
      await api(`/documents/${id}/adjustments`, "POST", { kind: b.kind, amount: b.amount, issue_date: b.issue_date, reason: b.reason, ...(lines.length ? { tax_lines_from: lines } : {}) });
      await done("Note issued with its SST split. Balances updated.");
      return true;
    }
    if (type === "tax-settings") {
      await api("/tax/settings", "PUT", { ...b, autoSubmit: b.autoSubmit === "on" });
      await done("Tax settings saved.");
      return true;
    }
    if (type === "tax-services") {
      for (const v of S().services) {
        const code = b["svc_" + v.id] ?? "";
        if (code !== (v.tax_class || "")) await api(`/tax/services/${v.id}`, "PUT", { tax_class: code });
      }
      await done("Service classifications saved.");
      return true;
    }
    if (type === "tax-classes") {
      const lines = Object.fromEntries(Object.entries(b).filter(([k]) => k.startsWith("line_")).map(([k, v]) => [k.slice(5), v]));
      await api(`/tax/documents/${id}/classes`, "PUT", { lines });
      await done("Classification saved.");
      return true;
    }
    if (type === "tax-cancel") {
      await api(`/tax/einvoices/${id}/cancel`, "POST", { reason: b.reason });
      await done("e-Invoice cancelled in MyInvois.");
      return true;
    }
    if (type === "tax-refund") {
      const e = await api("/tax/einvoices", "POST", { source: "refund", id, invoice_id: b.invoice_id });
      await done(submitted(e));
      return true;
    }
    if (type === "tax-sst") {
      sstPeriod = b.period;
      renderRoute();
      return true;
    }
    if (type === "tax-con") {
      conPreview = await api(`/tax/consolidated?month=${encodeURIComponent(b.month)}`);
      renderRoute();
      return true;
    }
    if (type === "tax-tin") {
      const r = await api("/tax/validate-tin", "POST", b);
      toast(r.valid ? "MyInvois confirms this TIN and ID number." : "MyInvois does not know this TIN and ID combination.", !r.valid);
      return true;
    }
    if (type === "tax-selfbilled") {
      const lines = [...form.querySelectorAll(".tax-sb-line")]
        .map((row) => Object.fromEntries([...row.querySelectorAll("input,select")].map((x) => [x.name.slice(2), x.value])))
        .filter((l) => l.description.trim());
      const supplier = Object.fromEntries(Object.entries(b).filter(([k]) => k.startsWith("s_")).map(([k, v]) => [k.slice(2), v]));
      const sb = await api("/tax/selfbilled", "POST", { type_code: b.type_code, ref_id: b.ref_id || undefined, issue_date: b.issue_date, currency: b.currency, fx_rate: b.fx_rate, notes: b.notes, supplier, lines });
      await done(`${sb.number} created. Submit it to MyInvois from the list.`);
      return true;
    }
    return false;
  }

  // The exemption hint in the document editor follows the chosen client and date.
  document.addEventListener("change", (event) => {
    const form = event.target.closest?.('form[data-form="editor"]');
    if (!form || !["client_id", "issue_date"].includes(event.target.name) || !T()) return;
    const note = form.querySelector("[data-tax-exempt-note]");
    if (note) note.innerHTML = exemptText(form.elements.client_id.value, dateValue(form.elements.issue_date));
  });

  return {
    nav: [{ key: "tax", label: "Tax", icon: "receipt", group: "Books" }],
    pages: { tax: (id) => page(id) },
    icons: { receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>' },
    action,
    submit,
    slots: {
      overview: overviewSlot,
      documentActions,
      documentPanels,
      documentFields,
      clientFields,
      clientDetails,
      settings: () =>
        T()
          ? `<section class="panel mt22"><div class="panel-head"><div><h2>Tax</h2><p>SST-02 worksheet, exemptions, MyInvois e-Invoice and threshold monitor. MyInvois keys are under Integration keys below.</p></div><a class="btn" href="#/tax/settings">Open tax settings</a></div></section>`
          : "",
      publicPanels: (d) => {
        const x = d.ext?.tax;
        if (!x) return "";
        return `${x.einvoice ? `<section class="panel"><h2>e-Invoice</h2>${x.einvoice.qr ? `<div class="tax-qr-row mt22"><img class="tax-qr" src="${E(x.einvoice.qr)}" alt="MyInvois validation QR code"><p>Validated by LHDN MyInvois${x.einvoice.sandbox ? " (test)" : ""}.<br><a href="${E(x.einvoice.url)}" target="_blank" rel="noopener noreferrer">Check on MyInvois</a></p></div>` : "<p>Validated by LHDN MyInvois.</p>"}<p class="field-hint tax-code">UUID ${E(x.einvoice.uuid)}</p></section>` : ""}${x.exemption ? `<section class="panel"><h2>SST</h2><p class="mt22">No SST is charged. Exemption reference ${E(x.exemption.ref)}${x.exemption.until ? `, valid until ${dateLabel(x.exemption.until)}` : ""}.</p></section>` : ""}`;
      },
    },
  };
}
