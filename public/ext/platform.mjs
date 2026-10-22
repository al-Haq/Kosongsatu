// Platform: outgoing webhooks, data import, installable app, invoices from plain language, hosting and one-command install.
// Browser module contract: see docs/PLUGINS.md.
export default function platformUI(h) {
  const { get, api, refresh, renderRoute, navigate, showModal, modal, toast, E, money, dateLabel, timeLabel, button, input, formValues, dateValue, setDateValue, area, select, formEnd, heading, empty, icon } = h;
  let quick = null; // the draft being reviewed
  let quickText = "";
  let pendingImport = null; // { kind, bytes, name, result }
  let installPrompt = null;

  // ---------- installable app ----------
  // The service worker caches only the app shell and an offline page.
  if ("serviceWorker" in navigator && location.pathname === "/" && (location.protocol === "https:" || location.hostname === "localhost"))
    navigator.serviceWorker.register("/sw.mjs", { scope: "/" }).catch(() => {});
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    if (location.hash.startsWith("#/settings")) renderRoute();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    toast("Nawlogic Invoice is installed.");
  });

  const ext = () => ({ webhooks: [], deliveries: [], eventTypes: [], imports: [], quick: {}, ...(get()?.ext?.platform || {}) });
  const tag = (label, color = "") => `<span class="badge ${color}"><span class="dot"></span>${E(label)}</span>`;
  const sen = (v) => {
    const s = String(v ?? "").trim();
    if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) return null;
    const [a, b = ""] = s.split(".");
    return Number(a) * 100 + Number(b.padEnd(2, "0"));
  };
  const addDays = h.addDays;
  const sstOn = () => !!get().settings.sstNumber;
  const TAX = [0, 5, 6, 8, 10];

  // ---------- quick invoice ----------
  const EXAMPLES = ["Invois ABC Sdn Bhd, maintenance Oktober, RM1,500", "Quote Meranti Digital: 3 days onsite support at RM800/day, due in 30 days"];
  const quickForm = (inline) =>
    `<form data-form="platform-quick" class="pq-form${inline ? " inline" : ""}"><label class="sr-only" for="pq-text-${inline ? "a" : "b"}">What to bill</label><input id="pq-text-${inline ? "a" : "b"}" name="text" maxlength="600" required autocomplete="off" placeholder="${E(EXAMPLES[0])}" value="${E(inline ? "" : quickText)}"><button class="btn primary" type="submit">${icon("bolt")}Preview draft</button>${h.errorBlock()}</form>`;
  function quickPanel() {
    const q = ext().quick;
    return `<section class="panel mt22 pq-panel"><div class="panel-head"><div><h2>Quick invoice</h2><p>Type what to bill in Bahasa Melayu or English. You review the draft before it is saved; nothing is issued or sent.</p></div>${icon("bolt")}</div>${quickForm(true)}<p class="field-hint">e.g. “${E(EXAMPLES[1])}”${q.whatsapp && q.whatsappNumber ? " · Also works from your own WhatsApp number." : ""}</p></section>`;
  }
  function quickModal() {
    showModal("Quick invoice", `<p>Type what to bill. Client, lines, amounts and due date are read from your words.</p>${quickForm(false)}<p class="field-hint">${EXAMPLES.map((x) => "“" + E(x) + "”").join("<br>")}</p>`);
  }
  function lineRow(i = { description: "", quantity: "1", rate: "0.00", tax_rate: 0 }) {
    return `<div class="line-item pq-line" data-service="${E(i.service_id || "")}" data-unit="${E(i.unit || "")}"><input aria-label="Description" class="pq-desc" maxlength="240" required value="${E(i.description)}"><input aria-label="Quantity" class="pq-qty" type="number" min="0.01" max="99999.99" step="0.01" required value="${E(i.quantity)}"><input aria-label="Rate MYR" class="pq-rate${i.needs_rate ? " needs" : ""}" type="number" min="0" max="99999999.99" step="0.01" required value="${E(i.rate)}">${sstOn() ? `<select aria-label="SST rate" class="pq-tax">${TAX.map((r) => `<option value="${r}" ${r === Number(i.tax_rate || 0) ? "selected" : ""}>${r ? r + "%" : "No SST"}</option>`).join("")}</select>` : ""}<button class="btn ghost" type="button" data-action="platform-line-remove" aria-label="Remove line">${icon("close")}</button></div>`;
  }
  function clientChoices(d) {
    const S = get();
    const first = (d.clientChoices || []).map((c) => [c.id, c.name]);
    const rest = S.clients.filter((c) => !c.archived && !first.some(([id]) => id === c.id)).map((c) => [c.id, c.name]);
    const opts = [["", "Choose a client"], ...first, ...rest];
    if (d.clientQuery && !d.client) opts.push(["__new__", `Add new client: ${d.clientQuery}`]);
    return opts;
  }
  function showQuick() {
    const d = quick,
      q = ext().quick;
    const selected = d.client?.id || (!d.clientChoices?.length && d.clientQuery ? "__new__" : "");
    const warn = d.warnings?.length ? `<div class="notice pq-warn"><ul>${d.warnings.map((w) => `<li>${E(w)}</li>`).join("")}</ul></div>` : "";
    const ai =
      !d.understood && q.ai && d.source !== "ai"
        ? `<div class="notice info pq-ai"><div><p>The parser could not read every part. You can fill the lines yourself, or ask your AI model.</p><label class="check-row"><input type="checkbox" id="pq-consent"> Send this text and your client and service names to ${E(q.aiOrigin)}.</label></div>${button("Ask the AI model", "platform-quick-ai")}</div>`
        : "";
    showModal(
      "Review quick draft",
      `${ai}${warn}<form data-form="platform-quick-save"><p class="field-hint pq-source">From: “${E(quickText)}”${d.source === "ai" ? " · read by the AI model" : ""}</p><div class="form-grid">${select("Document", "kind", [["invoice", "Invoice"], ["quote", "Quotation"]], d.kind)}${select("Bill to", "client_id", clientChoices(d), selected)}${input("Issue date", "issue_date", d.issue_date, "date", true)}${input(d.kind === "quote" ? "Valid until" : "Due date", "due_date", d.due_date, "date", true)}</div><div class="pq-lines${sstOn() ? " with-tax" : ""}"><div class="line-head"><span>DESCRIPTION</span><span>QTY</span><span>RATE (MYR)</span>${sstOn() ? "<span>SST</span>" : ""}<span></span></div><div id="pq-lines">${(d.items.length ? d.items : [undefined]).map(lineRow).join("")}</div></div><div class="actions mt22">${button("Add line", "platform-line-add", "", false, "plus")}</div><div class="form-grid mt22">${input("Discount (MYR)", "discount", d.discount || "0.00", "number", true, 'min="0" max="99999999.99" step="0.01"')}<div class="pq-total"><span>Total</span><strong id="pq-total">—</strong></div><div class="span-2">${area("Notes", "notes", d.notes || "", 2000)}</div></div><p class="field-hint">Saved as a draft. Open it to check, then issue it yourself.</p>${formEnd("Save draft")}</form>`,
      true,
    );
    quickTotal();
  }
  function quickData(form) {
    const b = formValues(form);
    const items = [...form.querySelectorAll(".pq-line")].map((row) => ({
      description: row.querySelector(".pq-desc").value,
      quantity: row.querySelector(".pq-qty").value,
      rate: row.querySelector(".pq-rate").value,
      tax_rate: Number(row.querySelector(".pq-tax")?.value || 0),
      ...(row.dataset.service ? { service_id: row.dataset.service } : {}),
      ...(row.dataset.unit ? { unit: row.dataset.unit } : {}),
    }));
    return { ...b, items };
  }
  // Mirrors the server: line amounts in sen, discount spread before SST.
  function quickTotal() {
    const form = document.querySelector('form[data-form="platform-quick-save"]');
    const out = document.getElementById("pq-total");
    if (!form || !out) return;
    const b = quickData(form);
    const lines = b.items.map((i) => ({ amount: Math.round(((sen(i.rate) ?? 0) * Math.round(Number(i.quantity || 0) * 100)) / 100) || 0, tax: i.tax_rate }));
    const subtotal = lines.reduce((t, l) => t + l.amount, 0);
    const off = Math.min(sen(b.discount) ?? 0, subtotal);
    // Discount shares by line amount, remainders to the largest fractions (as allocateDiscount).
    const shares = lines.map((l) => (subtotal ? Number((BigInt(off) * BigInt(l.amount)) / BigInt(subtotal)) : 0));
    if (subtotal) {
      let left = off - shares.reduce((t, v) => t + v, 0);
      const order = lines.map((l, n) => [(BigInt(off) * BigInt(l.amount)) % BigInt(subtotal), l.amount, n]).sort((x, y) => (x[0] === y[0] ? y[1] - x[1] : x[0] < y[0] ? 1 : -1));
      for (const [, a, n] of order) {
        if (!left) break;
        if (shares[n] < a) {
          shares[n]++;
          left--;
        }
      }
    }
    const tax = lines.reduce((t, l, n) => t + Math.round(((l.amount - shares[n]) * l.tax) / 100), 0);
    out.textContent = money(subtotal - off + tax);
  }
  document.addEventListener("input", (e) => {
    if (e.target.closest?.('form[data-form="platform-quick-save"]')) quickTotal();
  });
  document.addEventListener("change", (e) => {
    const form = e.target.closest?.('form[data-form="platform-quick-save"]');
    if (!form || e.target.name !== "client_id" || !quick || quick.due_source === "text") return;
    const c = get().clients.find((x) => x.id === e.target.value);
    if (c) setDateValue(form.elements.due_date, addDays(dateValue(form.elements.issue_date), c.terms));
  });

  // ---------- webhooks ----------
  const typeLabel = (t) => ext().eventTypes.find((e) => e.type === t)?.label || t;
  const autoOff = (w) => !w.active && w.disabled_reason && w.disabled_reason !== "Turned off by the owner.";
  function webhookStatus(w) {
    if (w.active) return w.consecutive_failures ? tag("Failing", "orange") : tag("Active", "green");
    return autoOff(w) ? tag("Turned off", "red") : tag("Paused");
  }
  const deliveryBadge = (d) =>
    ({ delivered: tag("Delivered", "green"), pending: d.attempts ? tag("Retrying", "orange") : tag("Queued", "blue"), delivering: tag("Sending", "blue"), failed: tag("Failed", "red"), cancelled: tag("Cancelled") })[d.state] || tag(d.state);
  function webhooksPage() {
    const { webhooks, deliveries } = ext();
    const off = webhooks.filter(autoOff);
    const byId = Object.fromEntries(webhooks.map((w) => [w.id, w]));
    return (
      heading("Webhooks", "", webhooks.length < 10 ? button("Add endpoint", "platform-webhook-new", "", true, "plus") : "") +
      off.map((w) => `<div class="notice">${icon("hook")}<p><strong>${E(w.url)}</strong> was turned off${w.disabled_at ? " on " + E(timeLabel(w.disabled_at)) : ""}. ${E(w.disabled_reason)} Fix the receiver, then turn it on again.</p></div>`).join("") +
      `<section class="panel pw-section"><div class="panel-head"><div><h2>Endpoints</h2><p>Each delivery is signed. Failed deliveries are retried for up to 24 hours.</p></div></div>${
        webhooks.length
          ? `<div class="table-wrap"><table><thead><tr><th>Endpoint</th><th>Events</th><th>Status</th><th>Last delivery</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${webhooks
              .map(
                (w) =>
                  `<tr><td class="pw-url"><strong>${E(w.url)}</strong><small>${E(w.description || "")}</small></td><td><span class="pw-events">${w.events.map((t) => `<span class="badge">${E(t)}</span>`).join(" ")}</span></td><td>${webhookStatus(w)}</td><td>${w.last_success ? "OK " + E(timeLabel(w.last_success)) : "—"}${w.last_failure ? `<small>Failed ${E(timeLabel(w.last_failure))}</small>` : ""}</td><td><div class="actions">${button("Send test", "platform-webhook-test", w.id)}${button("Edit", "platform-webhook-edit", w.id)}${button(w.active ? "Turn off" : "Turn on", "platform-webhook-toggle", w.id)}${button("New secret", "platform-webhook-rotate", w.id)}${button("Delete", "platform-webhook-delete", w.id)}</div></td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : empty("No endpoints yet", "Add an HTTPS URL from n8n, Zapier, Make or your own server to receive events such as invoice issued or payment received.", button("Add endpoint", "platform-webhook-new", "", true))
      }</section>` +
      `<section class="panel mt22 pw-section"><div class="panel-head"><div><h2>Recent deliveries</h2><p>Kept for 30 days.</p></div></div>${
        deliveries.length
          ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Event</th><th>Endpoint</th><th>Status</th><th>Response</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${deliveries
              .map(
                (d) =>
                  `<tr><td>${E(timeLabel(d.created))}</td><td>${E(d.type)}${d.test ? " <small>test</small>" : ""}</td><td class="pw-url"><small>${E(byId[d.webhook_id]?.url || "")}</small></td><td>${deliveryBadge(d)}<small>${d.attempts} attempt${d.attempts === 1 ? "" : "s"}${d.next_attempt ? " · next " + E(timeLabel(d.next_attempt)) : ""}</small></td><td>${d.last_status ? "HTTP " + E(d.last_status) : ""}${d.last_error && d.state !== "delivered" && d.last_error !== "HTTP " + d.last_status ? `<small>${E(d.last_error)}</small>` : ""}</td><td><div class="actions">${button("Details", "platform-delivery-view", d.id)}${["failed", "cancelled"].includes(d.state) && !d.test ? button("Send again", "platform-delivery-retry", d.id) : ""}</div></td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : '<p class="field-hint">No deliveries yet. Use Send test to check an endpoint.</p>'
      }</section>` +
      `<section class="panel mt22"><div class="panel-head"><h2>Check the signature</h2></div><p>Every request carries <code>Nawlogic-Signature: t=&lt;unix time&gt;,v1=&lt;hex&gt;</code>. Compute HMAC-SHA256 of <code>t + "." + raw body</code> with your signing secret, compare in constant time and reject requests older than 5 minutes. Use <code>Nawlogic-Event-Id</code> to ignore repeats.</p><pre class="csv-example pw-code">${E(`const [t, v1] = header.split(",").map((p) => p.split("=")[1]);
const expected = crypto.createHmac("sha256", secret).update(t + "." + rawBody).digest("hex");
const fresh = Math.abs(Date.now() / 1000 - Number(t)) <= 300;
const valid = fresh && /^[0-9a-f]{64}$/.test(v1) &&
  crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex"));`)}</pre><p class="field-hint">Amounts are integers in sen (RM1.00 = 100). Payloads never contain passwords, keys, client link tokens or bank details.</p></section>`
    );
  }
  function webhookForm(id = "") {
    const w = ext().webhooks.find((x) => x.id === id) || { url: "", description: "", events: ["invoice.issued", "payment.received"] };
    const S = get();
    showModal(
      id ? "Edit endpoint" : "Add webhook endpoint",
      `<form data-form="platform-webhook" data-id="${E(id)}">${input("Endpoint URL (HTTPS)", "url", w.url, "url", true, 'maxlength="500" placeholder="https://n8n.example.com/webhook/nawlogic"')}${input("Label (optional)", "description", w.description, "text", false, 'maxlength="120" placeholder="n8n billing flow"')}<fieldset class="pw-types"><legend>Events to send</legend>${ext()
        .eventTypes.map((t) => `<label class="check-row"><input type="checkbox" name="events" value="${E(t.type)}" ${w.events.includes(t.type) ? "checked" : ""}> ${E(t.label)} <small>${E(t.type)}</small></label>`)
        .join("")}</fieldset>${input(id ? "Current password (only to change the URL)" : "Current password", "password", "", "password", !id, 'autocomplete="current-password"')}${S.security.enabled ? input("Authenticator or recovery code", "code", "", "text", false, 'autocomplete="one-time-code"') : ""}<p class="field-hint">Only public HTTPS addresses are allowed. Business data is sent to this URL, so the password is checked again.</p>${formEnd(id ? "Save endpoint" : "Add endpoint")}</form>`,
    );
  }
  function showSecret(secret, url) {
    showModal(
      "Signing secret",
      `<div class="notice info"><p>Copy this secret into your receiver now. It is shown only once; you can create a new one later.</p></div>${input("Endpoint", "url", url, "text", false, "readonly")}<label>Signing secret<input id="pw-secret" value="${E(secret)}" readonly></label><div class="form-actions">${button("Copy secret", "platform-copy-secret")}${button("Done", "close-modal", "", true)}</div>`,
    );
  }
  function confirmPassword(title, type, id, help) {
    showModal(
      title,
      `<form data-form="${type}" data-id="${E(id)}"><p>${E(help)}</p>${input("Current password", "password", "", "password", true, 'autocomplete="current-password"')}${get().security.enabled ? input("Authenticator or recovery code", "code", "", "text", true, 'autocomplete="one-time-code"') : ""}${formEnd("Confirm")}</form>`,
    );
  }
  async function showDelivery(id) {
    const d = await api(`/platform/deliveries/${id}`);
    showModal(
      "Delivery details",
      `<p>${E(d.type)} · ${deliveryBadge(d)} · ${d.attempts} attempt${d.attempts === 1 ? "" : "s"}</p>${
        d.attempts_log.length
          ? `<div class="table-wrap mt22 pw-detail"><table><thead><tr><th>#</th><th>When</th><th>Result</th><th class="num">Time</th></tr></thead><tbody>${d.attempts_log.map((a) => `<tr><td>${a.attempt}</td><td>${E(timeLabel(a.created))}</td><td>${a.status ? "HTTP " + E(a.status) : ""} ${E(a.error || "")}${a.response ? `<small>${E(a.response)}</small>` : ""}</td><td class="num">${a.duration_ms} ms</td></tr>`).join("")}</tbody></table></div>`
          : ""
      }<label class="mt22">Payload<textarea readonly rows="12" class="pw-payload">${E(JSON.stringify(d.payload, null, 2))}</textarea></label><div class="form-actions">${button("Close", "close-modal", "", true)}</div>`,
      true,
    );
  }

  // ---------- import ----------
  const IMPORTS = {
    clients: ["Clients", "Billing name, contact details, TIN/BRN and payment terms.", "name, email, phone, contact, address, tin, brn, sst_number, terms"],
    services: ["Services", "Your catalog with default rates, units and SST rates.", "name, description, unit, rate, tax_rate"],
    invoices: [
      "Historical invoices",
      "Past and unpaid invoices as opening balances. They keep their number, dates and status; paid amounts become receipts marked Imported.",
      "number, client, issue_date, due_date, description, quantity, rate, tax_rate, status (unpaid / partly paid / paid / void), paid_amount, paid_date, notes",
    ],
  };
  function importPage() {
    const { imports } = ext();
    return (
      heading("Import", "") +
      `<div class="notice info">${icon("shield")}<p>Imports never email, share or issue anything. Each file is checked row by row first and imported only if every row is valid. Import clients first, then services, then invoices.</p></div><div class="pi-grid">${Object.entries(IMPORTS)
        .map(
          ([kind, [title, text, cols]]) =>
            `<section class="panel"><div class="panel-head"><h2>${E(title)}</h2>${icon(kind === "invoices" ? "doc" : kind === "clients" ? "users" : "box")}</div><p>${E(text)}</p><p class="field-hint">Columns: ${E(cols)}. Dates as YYYY-MM-DD or DD/MM/YYYY; amounts like 1500.00 or RM1,500.</p><div class="actions mt22"><a class="btn" href="/api/platform/import/template/${kind}.csv">${icon("download")} Template</a></div><label class="mt22">CSV file<input type="file" accept=".csv,text/csv" data-import-kind="${kind}"></label><div class="actions mt22">${button("Check file", "platform-import-preview", kind, true)}</div></section>`,
        )
        .join("")}</div><section class="panel mt22"><div class="panel-head"><h2>Past imports</h2></div>${
        imports.length
          ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th class="num">Rows</th><th class="num">Imported</th><th class="num">Skipped</th></tr></thead><tbody>${imports.map((i) => `<tr><td>${E(timeLabel(i.created))}</td><td>${E(IMPORTS[i.kind]?.[0] || i.kind)}</td><td class="num">${i.rows}</td><td class="num">${i.created_count}</td><td class="num">${i.skipped_count}</td></tr>`).join("")}</tbody></table></div>`
          : '<p class="field-hint">Nothing imported yet.</p>'
      }</section>`
    );
  }
  async function sendCsv(path, bytes) {
    const res = await fetch("/api/platform/import/" + path, {
      method: "POST",
      headers: { "Content-Type": "text/csv", "X-CSRF-Token": h.session().csrf },
      body: bytes,
    });
    const data = await res.json().catch(() => ({ error: "Server returned an unreadable response." }));
    if (!res.ok && !(res.status === 422 && data.results)) throw new Error(data.error || "Import failed.");
    return data;
  }
  function showImport() {
    const { kind, name, result: r } = pendingImport;
    const label = { ok: tag("Import", "green"), skip: tag("Skip", "blue"), error: tag("Error", "red") };
    showModal(
      `Check ${IMPORTS[kind][0].toLowerCase()}`,
      `<p><strong>${E(name)}</strong>: ${r.units} ${kind === "invoices" ? "invoices" : "rows"} checked. ${r.created} to import, ${r.skipped} already in the workspace, ${r.errors} with problems.</p>${r.errors ? '<div class="notice"><p>Fix the rows marked Error and check the file again. Nothing is imported until every row is valid.</p></div>' : ""}<div class="table-wrap mt22 pi-preview"><table><thead><tr><th>Row</th><th>Record</th><th>Result</th></tr></thead><tbody>${r.results
        .map((x) => `<tr class="${x.status === "error" ? "pi-error" : ""}"><td>${x.lines.length > 1 ? `${x.lines[0]}–${x.lines.at(-1)}` : x.lines[0]}</td><td>${E(x.summary || "")}${x.message ? `<small>${E(x.message)}</small>` : ""}</td><td>${label[x.status]}</td></tr>`)
        .join("")}</tbody></table></div>${h.errorBlock()}<div class="form-actions">${button("Cancel", "close-modal")}${!r.errors && r.created ? button(`Import ${r.created} record${r.created === 1 ? "" : "s"}`, "platform-import-commit", "", true) : ""}</div>`,
      true,
    );
  }

  // ---------- installable app panel ----------
  function installPanel() {
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Install the app</h2><p>Open Nawlogic from your phone or computer home screen, like an app. Your data stays on your server.</p></div>${standalone ? tag("Installed", "green") : icon("phone")}</div>${
      standalone
        ? "<p>You are using the installed app.</p>"
        : installPrompt
          ? `<div class="actions">${button("Install app", "platform-install", "", true, "phone")}</div>`
          : ios
            ? "<p>In Safari, tap Share, then <strong>Add to Home Screen</strong>.</p>"
            : "<p>In Chrome or Edge, open the browser menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>"
    }<p class="field-hint">Without a connection the app shows an offline page. Invoices and client data are never stored on the device.</p></section>`;
  }

  // ---------- actions and forms ----------
  async function reload(message) {
    await refresh();
    renderRoute();
    if (message) toast(message);
  }
  async function action(type, id, el) {
    switch (type) {
      case "platform-quick":
        quickModal();
        return true;
      case "platform-line-add":
        document.getElementById("pq-lines").insertAdjacentHTML("beforeend", lineRow());
        quickTotal();
        return true;
      case "platform-line-remove":
        if (document.querySelectorAll(".pq-line").length > 1) el.closest(".pq-line").remove();
        quickTotal();
        return true;
      case "platform-quick-ai": {
        if (!document.getElementById("pq-consent")?.checked) {
          toast("Tick the box to allow sending this text to the AI provider.", true);
          return true;
        }
        quick = await api("/platform/quick/parse", "POST", { text: quickText, ai: true, consent: true });
        showQuick();
        return true;
      }
      case "platform-webhook-new":
        webhookForm();
        return true;
      case "platform-webhook-edit":
        webhookForm(id);
        return true;
      case "platform-webhook-toggle": {
        const w = ext().webhooks.find((x) => x.id === id);
        await api(`/platform/webhooks/${id}`, "PUT", { active: !w.active });
        await reload(w.active ? "Endpoint turned off." : "Endpoint turned on.");
        return true;
      }
      case "platform-webhook-test": {
        const r = await api(`/platform/webhooks/${id}/test`, "POST", {});
        await reload();
        toast(r.state === "delivered" ? `Test delivered (HTTP ${r.status}).` : `Test failed: ${r.error || "no response"}.`, r.state !== "delivered");
        return true;
      }
      case "platform-webhook-rotate":
        confirmPassword("New signing secret", "platform-webhook-rotate", id, "The old secret stops working at once. Update your receiver with the new one.");
        return true;
      case "platform-webhook-delete":
        h.confirmModal("Delete endpoint", "The endpoint and its delivery log are removed. Events are no longer sent to it.", "platform-webhook-delete-confirm", id, "Delete endpoint");
        return true;
      case "platform-webhook-delete-confirm":
        await api(`/platform/webhooks/${id}`, "DELETE");
        modal.close();
        await reload("Endpoint deleted.");
        return true;
      case "platform-delivery-view":
        await showDelivery(id);
        return true;
      case "platform-delivery-retry":
        await api(`/platform/deliveries/${id}/retry`, "POST", {});
        await reload("Queued to send again.");
        return true;
      case "platform-copy-secret": {
        const v = document.getElementById("pw-secret")?.value || "";
        await navigator.clipboard?.writeText(v).then(
          () => toast("Secret copied."),
          () => toast("Copy it from the box.", true),
        );
        return true;
      }
      case "platform-import-preview": {
        const file = document.querySelector(`input[data-import-kind="${id}"]`)?.files?.[0];
        if (!file) return toast("Choose a CSV file first.", true), true;
        if (file.size > 1048576) return toast("Files must be 1 MB or smaller. Split the file.", true), true;
        const bytes = new Uint8Array(await file.arrayBuffer());
        pendingImport = { kind: id, bytes, name: file.name, result: await sendCsv(`${id}/preview`, bytes) };
        showImport();
        return true;
      }
      case "platform-import-commit": {
        const p = pendingImport;
        if (!p) return true;
        const r = await sendCsv(`${p.kind}?sha256=${p.result.sha256}`, p.bytes);
        if (!r.imported) {
          pendingImport.result = r;
          showImport();
          return true;
        }
        pendingImport = null;
        modal.close();
        await reload(`Imported ${r.created} record${r.created === 1 ? "" : "s"}${r.skipped ? `; ${r.skipped} already there` : ""}.`);
        return true;
      }
      case "platform-install":
        if (installPrompt) {
          installPrompt.prompt();
          await installPrompt.userChoice.catch(() => null);
          installPrompt = null;
          renderRoute();
        }
        return true;
      default:
        return false;
    }
  }
  async function submit(form, b) {
    const type = form.dataset.form,
      id = form.dataset.id;
    if (type === "platform-quick") {
      quickText = b.text;
      quick = await api("/platform/quick/parse", "POST", { text: b.text });
      showQuick();
      return true;
    }
    if (type === "platform-quick-save") {
      const data = quickData(form);
      if (!data.client_id) throw new Error("Choose a client.");
      const body = { ...data, text: quickText };
      if (data.client_id === "__new__") {
        delete body.client_id;
        body.new_client_name = quick.clientQuery;
      }
      const doc = await api("/platform/quick/draft", "POST", body);
      modal.close();
      quick = null;
      quickText = "";
      await refresh();
      navigate("document/" + doc.id);
      toast("Draft saved. Check it, then issue it when ready.");
      return true;
    }
    if (type === "platform-webhook") {
      const events = [...form.querySelectorAll('input[name="events"]:checked')].map((x) => x.value);
      const payload = { url: b.url, description: b.description, events, password: b.password, code: b.code };
      if (id) {
        const w = ext().webhooks.find((x) => x.id === id);
        if (payload.url === w.url) delete payload.password;
        await api(`/platform/webhooks/${id}`, "PUT", payload);
        modal.close();
        await reload("Endpoint saved.");
      } else {
        const r = await api("/platform/webhooks", "POST", payload);
        await reload();
        showSecret(r.secret, r.webhook.url);
      }
      return true;
    }
    if (type === "platform-webhook-rotate") {
      const r = await api(`/platform/webhooks/${id}/rotate`, "POST", { password: b.password, code: b.code });
      await reload();
      showSecret(r.secret, r.webhook.url);
      return true;
    }
    return false;
  }

  function overviewNotices() {
    const off = ext().webhooks.filter(autoOff);
    return off.length ? `<div class="notice mt22">${icon("hook")}<p>${off.length === 1 ? "A webhook endpoint was" : off.length + " webhook endpoints were"} turned off after repeated failures.</p><a href="#/webhooks">Review →</a></div>` : "";
  }

  return {
    nav: [
      { key: "webhooks", label: "Webhooks", icon: "hook", group: "Workspace" },
      { key: "import", label: "Import", icon: "upload", group: "Workspace" },
    ],
    pages: { webhooks: webhooksPage, import: importPage },
    icons: {
      hook: '<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>',
      upload: '<path d="M12 21V9m-5 5 5-5 5 5M4 8V3h16v5"/>',
      bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
      phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    },
    action,
    submit,
    slots: {
      topbar: () => `<button type="button" class="btn pq-top" data-action="platform-quick" aria-label="Quick invoice">${icon("bolt")}<span>Quick invoice</span></button>`,
      overview: () => overviewNotices() + quickPanel(),
      settings: installPanel,
    },
  };
}
