// Payments: online payment providers and keys, DuitNow QR, payment slips,
// bank statement import with column mapping, and smart bank matching.
// Browser module contract: see docs/PLUGINS.md.
import { errorHtml } from "./error-tips.mjs";
export default function paymentsUI(h) {
  const { get, api, refresh, renderRoute, showModal, modal, toast, E, money, dec, dateLabel, timeLabel, button, badge, input, area, select, formEnd, heading, empty, icon, paged } = h;
  const ext = () => get()?.ext?.payments || {};
  let pending = null; // statement import in progress: { csv, account, layout, preview }
  const clientToken = () => location.pathname.match(/^\/client\/([\w-]+)$/)?.[1];
  const level = (c, score) =>
    `<span class="badge ${c === "High" ? "green" : c === "Medium" ? "orange" : ""}"><span class="dot"></span>${E(c)}${score ? " " + score + "%" : ""}</span>`;
  // msg is text or an Error; an error also says what to try next.
  const formError = (msg) => {
    const el = modal.querySelector(".form-error");
    if (el) el.innerHTML = errorHtml(msg);
    else toast(msg, true);
  };
  // Raw upload with the owner's CSRF token (or none on the client page).
  async function raw(path, file) {
    const s = h.session();
    const res = await fetch("/api" + path, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", ...(s ? { "X-CSRF-Token": s.csrf } : {}) },
      body: file,
    });
    const data = await res.json().catch(() => ({ error: "Upload failed." }));
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    return data;
  }

  // ---------- Settings: online payment providers ----------
  function providersPanel() {
    const S = get(),
      g = S.gateway || {},
      list = g.providers || [],
      online = S.onlinePayments || [];
    const state = g.configured
      ? `Client links show a Pay online button through <strong>${E(g.label)}</strong>${g.sandbox ? " in <strong>test mode</strong>" : ""}. Paid invoices get a receipt automatically.`
      : g.choice === "off"
        ? "Online payment is turned off. Client links show bank transfer details only."
        : "Not connected. Set up one provider below to show a Pay online button on client links.";
    const line = (p) => {
      const started = p.keys.some((k) => k.source);
      const note = p.configured
        ? p.sandbox
          ? "test mode"
          : "live"
        : p.error
          ? p.error
          : started && p.missing.length
            ? "missing " + p.keys.filter((k) => p.missing.includes(k.name)).map((k) => k.label).join(", ")
            : "";
      return `<div class="setting-line"><div><h3>${E(p.label)} ${p.active ? badge("Active") : ""}</h3><p>${E(p.methods)}${note ? " · " + E(note) : ""}</p></div><div class="actions">${badge(p.configured ? "Connected" : "Not connected")}${button(p.configured ? "Keys" : "Set up", "pay-keys", p.name)}${p.configured ? button("Test connection", "pay-test", p.name) : ""}${p.configured && !p.active && !g.choiceFromServer ? button("Use for invoices", "pay-use", p.name, true) : ""}</div></div>`;
    };
    const table = online.length
      ? `<div class="table-wrap mt22"><table><thead><tr><th>Invoice</th><th>Provider / reference</th><th class="num">Amount</th><th>Status</th><th>Started</th><th></th></tr></thead><tbody>${online
          .slice(0, 20)
          .map(
            (o) =>
              `<tr><td><a href="#/document/${E(o.invoice_id)}">${E(o.number)}</a></td><td>${E(o.provider_label)}<small>${E(o.bill_id)}</small></td><td class="num">${money(o.amount)}</td><td>${badge(o.state === "paid" ? "Paid" : o.detail === "Amount mismatch" ? "Failed" : "Pending review")}${o.detail && o.state !== "paid" ? `<small>${E(o.detail)}</small>` : ""}</td><td>${timeLabel(o.created)}</td><td>${o.state === "pending" ? button("Check status", "check-online-payment", o.id) : ""}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : '<p class="field-hint mt22">No online payments yet.</p>';
    return `<section class="panel mt22" id="online-payments"><div class="panel-head"><div><h2>Online payments</h2><p>${state}</p></div>${badge(g.configured ? "Connected" : "Not connected")}</div>${list.map(line).join("")}${g.choiceFromServer ? '<p class="field-hint">The provider is fixed by PAYMENT_PROVIDER on the server.</p>' : g.configured ? `<div class="actions mt22">${button("Turn off online payment", "pay-use", "off")}</div>` : g.choice === "off" ? `<div class="actions mt22">${button("Turn online payment back on", "pay-use", "auto")}</div>` : ""}${table}</section>`;
  }
  function hookNote(name) {
    const x = ext(),
      origin = x.origin || location.origin;
    if (name === "stripe")
      return `<div class="notice info"><p>In Stripe > Developers > Webhooks, add the endpoint <strong>${E(x.hooks?.stripe || "")}</strong> with the events <strong>checkout.session.completed</strong> and <strong>checkout.session.async_payment_succeeded</strong>, then paste its signing secret here. Stripe needs at least RM 2.00 per payment.</p></div>`;
    if (name === "ipay88")
      return `<div class="notice info"><p>Ask iPay88 to register <strong>${E(origin)}</strong> as your request URL. The response and backend URLs are sent with each payment.</p></div>`;
    if (name === "toyyibpay") return '<div class="notice info"><p>The callback and return addresses are set on each bill automatically. Create a category in ToyyibPay for invoice payments.</p></div>';
    return '<div class="notice info"><p>The callback and return addresses are set on each bill automatically. Turn on X Signature in Billplz.</p></div>';
  }
  function keysForm(name) {
    const S = get(),
      p = (S.gateway?.providers || []).find((x) => x.name === name);
    if (!p) return;
    const fields = p.keys
      .map((k) => {
        if (k.source === "server") return `<p class="field-hint">${E(k.label)}: set on the server.</p>`;
        if (k.flag) return `<label class="check-row"><input type="checkbox" name="sandbox" ${p.sandbox ? "checked" : ""}> Test mode (sandbox)</label>`;
        const keep = k.source === "settings" ? 'placeholder="Saved. Leave blank to keep it."' : "";
        return `${input(k.label, "key_" + k.name, "", k.secret ? "password" : "text", !k.source && k.required, `autocomplete="off" maxlength="8000" ${keep}`)}<p class="field-hint">${E(k.help || "")}</p>`;
      })
      .join("");
    showModal(
      `${p.label} keys`,
      `<form data-form="pay-keys" data-id="${E(name)}">${hookNote(name)}${fields}${p.keys.some((k) => k.source === "settings") ? `<label class="check-row mt22"><input type="checkbox" name="clear"> Remove the saved ${E(p.label)} keys</label>` : ""}<p class="field-hint">Keys are saved encrypted on this server and never shown again. They take effect at once.</p>${input("Current password", "password", "", "password", true, 'autocomplete="current-password"')}${S.security?.enabled ? input("Authenticator or recovery code", "code", "", "text", true, 'autocomplete="one-time-code"') : ""}${formEnd("Save keys")}</form>`,
    );
  }

  // ---------- Settings: DuitNow QR ----------
  function duitnowPanel() {
    const dn = ext().duitnow;
    const preview = dn
      ? `<div class="duitnow-preview">${dn.qr ? `<img src="${E(dn.qr)}" alt="DuitNow QR preview">` : `<img src="/api/files/${E(dn.image.id)}" alt="DuitNow QR preview">`}<div><strong>${E(dn.merchant || "QR image from your bank")}</strong><p>${E(dn.city || "")}</p><p class="field-hint">Printed on unpaid invoice PDFs and shown on client links with the invoice number as the reference.</p></div></div>`
      : "";
    return `<section class="panel mt22"><div class="panel-head"><div><h2>DuitNow QR</h2><p>Let clients pay by scanning your bank's static DuitNow QR. They type the amount and use the invoice number as the reference. Check your bank account and record the payment as usual.</p></div>${badge(dn ? "Active" : "Not connected")}</div>${preview}<form data-form="pay-duitnow">${area("QR text from your bank (starts with 000201)", "payload", dn?.payload || "", 512)}<p class="field-hint">Scan your bank's static QR with any QR reader and paste the text. The checksum is checked; one-time (dynamic) or fixed-amount codes are refused. Or upload the QR image your bank gave you.</p><div class="form-error" role="alert"></div><div class="form-actions">${dn ? button("Remove QR", "pay-duitnow-remove") : ""}${button("Upload QR image", "pay-duitnow-upload")}<button class="btn primary" type="submit">Save QR text</button></div></form></section>`;
  }

  // ---------- Bank matching page ----------
  // Amounts out of the account carry a real minus sign.
  const signed = (v) => money(v).replace(/^-/, "−");
  // What the best suggestion is and, in one line, why.
  function matchCell(top, hint) {
    let html = "";
    if (top) {
      const what = top.kind === "receipt" ? `Receipt ${E(top.receipt_number)}` : top.invoices.map((i) => E(i.number)).join(" + ");
      const why = [top.client_name, top.ambiguous ? "several close matches" : "", top.reasons[0] || ""].filter(Boolean).join(" · ");
      html += `<div class="match-top"><strong>${what}</strong><small class="match-why" title="${E(why)}">${E(why)}</small></div>`;
    } else html += '<small class="muted">No likely invoice found.</small>';
    if (hint?.ranking?.length) {
      const pick = hint.ranking[0];
      const ai = `AI (${hint.model}): ${pick.number} · ${pick.confidence}%${pick.reason ? " · " + pick.reason : ""}`;
      html += `<small class="match-why" title="${E(ai)}">${E(ai)}</small>`;
    }
    return html;
  }
  // The row's status: matched, excluded, or how sure the best suggestion is.
  function rowStatus(t, top) {
    if (t.receipt_id || t.refund_id) return badge("Matched");
    if (t.ignored_reason) return badge("Excluded") + `<small>${E(t.ignored_reason)}</small>`;
    if (!top) return badge("Unmatched");
    return `<span class="badge ${top.confidence === "High" ? "green" : top.confidence === "Medium" ? "orange" : ""}"><span class="dot"></span>Suggested ${top.score}%</span>`;
  }
  // One primary action per row; everything else waits in "More".
  function rowActions(t, list, hint, open) {
    if (!open) return button("Reset match", "bank-reset", t.id);
    const S = get(),
      x = ext();
    const top = t.amount > 0 ? list[0] : null;
    const pick = hint?.ranking?.[0];
    const aiOpen = pick && S.documents.some((d) => d.id === pick.invoice_id && d.state === "issued" && d.balance > 0);
    const primary = top
      ? button(top.kind === "receipt" ? "Match receipt" : "Record and allocate", "bank-apply", `${t.id}:0`, top.confidence === "High")
      : t.amount > 0
        ? button("Record receipt", "bank-receive", t.id)
        : button("Match existing", "bank-match", t.id);
    const more = [
      top ? button(list.length > 1 ? `Review ${list.length} matches` : "Why this match?", "bank-review", t.id) : "",
      aiOpen ? button(`Use AI pick ${pick.number}`, "bank-apply-ai", `${t.id}:${pick.invoice_id}`) : "",
      x.ai && t.amount > 0 && !hint?.ranking?.length && (!top || top.ambiguous || top.confidence !== "High") ? button("Ask AI", "bank-ai", t.id) : "",
      t.amount > 0 || top ? button("Match existing", "bank-match", t.id) : "",
      top ? button("Record receipt", "bank-receive", t.id) : "",
      button("Exclude", "bank-exclude", t.id),
    ].join("");
    return `${primary}<details class="dropdown"><summary class="btn icon-only more" aria-label="More actions" title="More actions">⋯</summary><div class="menu">${more}</div></details>`;
  }
  function bankPage() {
    const S = get(),
      x = ext(),
      txns = S.finance.bankTransactions,
      sugg = x.suggestions || {},
      hints = x.hints || {};
    const unmatched = txns.filter((t) => !t.receipt_id && !t.refund_id && !t.ignored_reason);
    const credits = unmatched.filter((t) => t.amount > 0);
    const strong = credits.filter((t) => sugg[t.id]?.[0]?.confidence === "High").length;
    const metrics = `<div class="metrics bank-metrics"><div class="metric"><div class="label">Unmatched credits</div><div class="value">${credits.length}</div><div class="hint">${money(credits.reduce((s, t) => s + t.amount, 0))} not yet recorded</div></div><div class="metric"><div class="label">Strong suggestions</div><div class="value teal">${strong}</div><div class="hint">High confidence, ready to confirm</div></div><div class="metric"><div class="label">Unmatched debits</div><div class="value">${unmatched.length - credits.length}</div><div class="hint">Match refunds or exclude</div></div></div>`;
    const rows = paged(txns);
    const table = txns.length
      ? `<div class="table-wrap"><table class="bank-table table-cards"><thead><tr><th>Bank date / account</th><th>Reference</th><th class="num">Amount</th><th>Status</th><th>Suggested match</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows.rows
          .map((t) => {
            const open = !t.receipt_id && !t.refund_id && !t.ignored_reason;
            const list = open && t.amount > 0 ? sugg[t.id] || [] : [];
            return `<tr><td class="card-title">${dateLabel(t.txn_date)}<small>${E(t.account)}</small></td><td class="bank-ref" data-label="Reference">${E(t.reference)}<small>${E(t.description)}</small></td><td class="num" data-label="Amount">${signed(t.amount)}</td><td data-label="Status">${rowStatus(t, list[0])}</td><td class="bank-suggest" ${list.length ? 'data-label="Suggested"' : ""}>${open && t.amount > 0 ? matchCell(list[0], hints[t.id]) : ""}</td><td class="bank-actions"><div class="actions">${rowActions(t, list, hints[t.id], open)}</div></td></tr>`;
          })
          .join("")}</tbody></table></div>${rows.nav}`
      : empty("No bank transactions", "Import a statement CSV from your bank. Duplicate rows are skipped and importing never records income.");
    return (
      heading(
        "Bank reconciliation",
        "Import your bank statement and confirm each match. Importing does not record income.",
        button("Import statement", "bank-import", "", true, "plus"),
      ) + metrics + `<section class="panel">${table}</section><p class="field-hint mt22">Suggestions compare the amount with open balances, look for invoice numbers (also when written like "INV2026 12"), client names, references your clients submitted and dates. Always check the bank line before you confirm.</p>`
    );
  }
  function reviewModal(tid) {
    const S = get(),
      t = S.finance.bankTransactions.find((x) => x.id === tid),
      list = ext().suggestions?.[tid] || [];
    showModal(
      "Suggested matches",
      `<div class="notice info"><p>${dateLabel(t.txn_date)} / ${E(t.reference)}${t.description ? " / " + E(t.description) : ""}<br><strong>${signed(t.amount)}</strong> into ${E(t.account)}</p></div>${
        list
          .map(
            (s, i) =>
              `<div class="payment"><div class="payment-top"><strong>${s.kind === "receipt" ? "Receipt " + E(s.receipt_number) : s.invoices.map((x) => `${E(x.number)} (${money(x.allocate)})`).join(" + ")}</strong>${level(s.confidence, s.score)}</div><p>${E(s.client_name)}</p><ul class="match-reasons">${s.reasons.map((r) => `<li>${E(r)}</li>`).join("")}</ul>${button(s.kind === "receipt" ? "Match this receipt" : "Record receipt and allocate", "bank-apply", `${tid}:${i}`, i === 0)}</div>`,
          )
          .join("") || "<p>No likely invoice found. Use Record receipt to choose the client yourself.</p>"
      }<p class="field-hint">Recording uses the bank date, amount and reference. Any amount left over stays as customer funds.</p>`,
      true,
    );
  }
  async function apply(tid, body, label) {
    const r = await api(`/payments/bank/${tid}/apply`, "POST", body);
    if (modal.open) modal.close();
    await refresh();
    renderRoute();
    toast(`${label} Receipt ${r.number} ${body.receipt_id ? "matched" : "recorded"}.`);
  }

  // ---------- Statement import ----------
  function importForm() {
    const x = ext();
    const layouts = [...(x.bankLayouts || []).map((l) => [l.id, l.name]), ...(x.bankPresets || []).map((p) => ["preset:" + p.id, "Saved: " + p.name])];
    showModal(
      "Import bank statement",
      `<form data-form="pay-bank-preview"><div class="form-grid">${input("Account label", "account", pending?.account || "MAIN", "text", true, 'maxlength="80"')}${select("Bank layout", "layout", layouts, pending?.layout || "auto")}</div><label class="mt22">Statement CSV file<input type="file" name="file" accept=".csv,.txt,text/csv"></label>${area("Or paste the CSV", "csv", "", 400000)}<div class="notice info mt22"><p>Download the statement or transaction history as CSV from your bank's internet banking. Banks change their export layouts from time to time, so check the preview, adjust the columns if needed and save the layout for next time.</p></div>${formEnd("Preview")}</form>`,
    );
  }
  const colOptions = (p, none = "Not used") => [["", none], ...p.columns.map((c) => [String(c.index), c.label])];
  function checks(p, name, chosen) {
    return `<fieldset class="col-checks"><legend>${name === "description" ? "Description columns" : "Reference columns"}</legend>${p.columns
      .map((c) => `<label class="check-row"><input type="checkbox" name="${name}" value="${c.index}" ${chosen.includes(c.index) ? "checked" : ""}> ${E(c.label)}</label>`)
      .join("")}</fieldset>`;
  }
  function previewModal() {
    const p = pending.preview,
      m = p.mapping,
      x = ext();
    const layout = [...(x.bankLayouts || [])].find((l) => l.id === pending.layout);
    const v = (n) => (n === null || n === undefined || n === -1 ? "" : String(n));
    const mapping = `<details class="bank-mapping" ${p.mappingError ? "open" : ""}><summary>Columns and formats</summary><div class="form-grid mt22">${select("Header row", "headerRow", [["-1", "No header row"], ...p.lines.map((l, i) => [String(i), `Line ${i + 1}: ${l}`])], String(p.headerRow))}${select("Delimiter", "delimiter", [[",", "Comma ,"], [";", "Semicolon ;"], ["\t", "Tab"], ["|", "Bar |"]], p.delimiter)}${select("Date column", "date", colOptions(p, "Choose"), v(m.date), false)}${select("Date format", "dateFormat", (x.dateFormats || []).map((f) => [f.id, f.label]), m.dateFormat)}${select("Amount style", "amountMode", [["signed", "One amount column (negative = money out)"], ["split", "Separate debit and credit columns"], ["indicator", "Amount with a DR/CR column"]], m.amountMode)}${select("Amount column", "amount", colOptions(p), v(m.amount), false)}${select("Debit (money out) column", "debit", colOptions(p), v(m.debit), false)}${select("Credit (money in) column", "credit", colOptions(p), v(m.credit), false)}${select("DR/CR column", "indicator", colOptions(p), v(m.indicator), false)}${select("Transaction ID column", "transactionId", colOptions(p), v(m.transactionId), false)}${select("Thousands separator", "thousands", [[",", "Comma 1,234.56"], [".", "Dot 1.234,56"], [" ", "Space 1 234.56"], ["", "None"]], m.thousands, false)}${select("Decimal mark", "decimal", [[".", "Dot"], [",", "Comma"]], m.decimal)}</div><div class="grid-equal mt22">${checks(p, "description", m.description || [])}${checks(p, "reference", m.reference || [])}</div><div class="actions mt22">${button("Update preview", "pay-bank-remap")}</div><div class="form-grid mt22 layout-save">${input("Save this layout as", "preset_name", "", "text", false, 'maxlength="60" placeholder="e.g. Maybank current account"')}<div class="actions">${button("Save layout", "pay-bank-save-layout")}</div></div></details>`;
    const summary = `<p class="mt22"><strong>${p.total}</strong> transactions found · <strong>${p.fresh}</strong> new · ${p.duplicates} already imported · ${p.skipped} balance or blank lines skipped${p.errorCount ? ` · <span class="red-text">${p.errorCount} unreadable</span>` : ""}</p>`;
    const errors = p.errors.length
      ? `<div class="notice error"><p>${p.errors
          .slice(0, 8)
          .map((e) => `Line ${e.row}: ${E(e.message)} <small>${E(e.text)}</small>`)
          .join("<br>")}${p.errorCount > 8 ? `<br>…and ${p.errorCount - 8} more.` : ""}</p></div>`
      : "";
    const table = p.rows.length
      ? `<div class="table-wrap mt22"><table><thead><tr><th>Date</th><th>Reference / description</th><th class="num">Amount</th><th>Import</th></tr></thead><tbody>${p.rows
          .slice(0, 60)
          .map((r) => `<tr><td>${dateLabel(r.txn_date)}</td><td>${E(r.reference)}<small>${E(r.description)}</small></td><td class="num ${r.amount < 0 ? "red-text" : ""}">${money(r.amount)}</td><td>${r.duplicate ? "Skip duplicate" : "New row"}</td></tr>`)
          .join("")}</tbody></table></div>${p.rows.length > 60 ? `<p class="field-hint">Showing 60 of ${p.total}.</p>` : ""}`
      : "";
    showModal(
      "Review bank import",
      `<form data-form="pay-bank-import">${layout && layout.id !== "auto" ? `<div class="notice info"><p>${E(layout.name)}: ${E(layout.note)}</p></div>` : ""}${p.mappingError ? `<div class="notice"><p>${E(p.mappingError)}</p></div>` : ""}${mapping}${summary}${errors}${table}${p.errorCount ? '<label class="check-row mt22"><input type="checkbox" name="skipErrors"> Skip the unreadable rows and import the rest</label>' : ""}<p class="field-hint">Importing records bank lines only. No payments are created until you confirm a match.</p>${formEnd(p.fresh ? `Import ${p.fresh} new row${p.fresh === 1 ? "" : "s"}` : "Nothing new to import")}</form>`,
      true,
    );
    if (!p.fresh || p.mappingError) modal.querySelector('button[type="submit"]').disabled = true;
  }
  function mappingFrom(form) {
    const val = (n) => form.elements[n]?.value ?? "";
    const num = (n) => (val(n) === "" ? null : Number(val(n)));
    const many = (n) => [...form.querySelectorAll(`input[name="${n}"]:checked`)].map((i) => Number(i.value));
    return {
      headerRow: Number(val("headerRow")),
      delimiter: val("delimiter"),
      date: num("date"),
      dateFormat: val("dateFormat"),
      amountMode: val("amountMode"),
      amount: num("amount"),
      debit: num("debit"),
      credit: num("credit"),
      indicator: num("indicator"),
      transactionId: num("transactionId"),
      thousands: val("thousands"),
      decimal: val("decimal"),
      description: many("description"),
      reference: many("reference"),
    };
  }
  async function preview(body) {
    pending.preview = await api("/payments/bank/preview", "POST", { csv: pending.csv, account: pending.account, layout: pending.layout, ...body });
    previewModal();
  }

  // ---------- Client page ----------
  function duitnowPublic(d, token) {
    const dn = d.ext?.payments?.duitnow;
    if (!dn || d.kind !== "invoice" || d.balance <= 0) return "";
    const src = dn.qr || (dn.image ? `/api/guest/payments/duitnow/${token}` : "");
    if (!src) return "";
    return `<section class="panel duitnow-panel"><h2>Pay with DuitNow QR</h2><p class="mt22">Scan with your banking or e-wallet app${dn.merchant ? ` to pay <strong>${E(dn.merchant)}</strong>` : ""}. Enter <strong>${money(d.balance)}</strong> and use <strong>${E(d.number)}</strong> as the reference.</p><img class="duitnow-qr" src="${E(src)}" alt="DuitNow QR code"><p class="field-hint">After paying, use Submit payment reference to send your transaction reference and slip, so it can be matched quickly.</p></section>`;
  }
  function referenceModal() {
    showModal(
      "Submit payment reference",
      `<form data-form="public-reference"><p>Nawlogic will check this against the bank account. Your invoice stays unpaid until the payment is confirmed.</p><div class="mt22">${input("Bank transaction reference", "reference", "", "text", true, 'maxlength="120"')}${area("Message (optional)", "note", "", 500)}<label>Payment slip (optional)<input type="file" name="slip" accept="image/png,image/jpeg,image/webp,application/pdf"></label><p class="field-hint">A photo, screenshot or PDF of your transfer, up to 5 MB. Only Nawlogic can see it.</p></div>${formEnd("Submit reference")}</form>`,
    );
  }
  async function returned(loc) {
    const token = loc.pathname.match(/^\/client\/([\w-]+)$/)?.[1];
    if (!token) return;
    const q = new URLSearchParams(loc.search);
    let body = null,
      failed = false;
    const provider = q.get("payment");
    if ([...q.keys()].some((k) => k.startsWith("billplz[")))
      body = { params: Object.fromEntries([...q].filter(([k]) => k.startsWith("billplz["))) };
    else if (provider === "stripe" && q.get("session_id")) body = { provider, reference: q.get("session_id") };
    else if (provider === "stripe" && q.get("cancelled")) failed = true;
    else if (provider === "toyyibpay" && q.get("billcode")) {
      if (q.get("status_id") === "3") failed = true;
      else body = { provider, reference: q.get("billcode") };
    } else if (provider === "ipay88") {
      if (q.get("result") === "failed") failed = true;
      else body = { provider };
    }
    const sent = q.get("slip") === "sent";
    if (!body && !failed && !sent) return;
    // Drop the provider's values from the address bar; the server re-checks.
    history.replaceState(null, "", loc.pathname);
    if (sent) return toast("Reference and slip submitted for review.");
    if (failed) return toast("Payment was not completed. You can try again or pay by bank transfer.");
    try {
      const { state } = await api(`/public/${token}/payment-return`, "POST", body);
      toast(state === "paid" ? "Payment received. Thank you." : "The payment is not confirmed yet. If you paid, this page will show it once the bank confirms.");
    } catch {
      toast("The payment could not be confirmed yet. If you paid, it will show here shortly.", true);
    }
  }

  return {
    pages: { bank: () => bankPage() },
    slots: {
      settings: () => providersPanel() + duitnowPanel(),
      publicPanels: (d, token) => duitnowPublic(d, token),
    },
    async guestPage(loc) {
      await returned(loc);
      return false;
    },
    async action(type, id, el) {
      const S = get();
      switch (type) {
        case "pay-keys":
          keysForm(id);
          return true;
        case "pay-test": {
          const r = await api(`/payments/providers/${id}/test`, "POST", {});
          toast(r.message, !r.ok);
          return true;
        }
        case "pay-use": {
          await api("/payments/provider", "PUT", { provider: id === "auto" ? null : id });
          await refresh();
          renderRoute();
          toast(id === "off" ? "Online payment turned off." : "Online payment provider updated.");
          return true;
        }
        case "pay-duitnow-remove":
          await api("/payments/duitnow", "PUT", { payload: null });
          await api("/payments/duitnow/image", "DELETE");
          await refresh();
          renderRoute();
          toast("DuitNow QR removed.");
          return true;
        case "pay-duitnow-upload":
          showModal(
            "Upload DuitNow QR image",
            `<form data-form="pay-duitnow-image"><label>QR image from your bank (PNG or JPEG, up to 2 MB)<input type="file" name="file" accept="image/png,image/jpeg" required></label><p class="field-hint">Use the static QR your bank issued for your business account. It replaces any QR text you saved.</p>${formEnd("Upload")}</form>`,
          );
          return true;
        case "bank-import":
          importForm();
          return true;
        case "pay-bank-remap": {
          const form = modal.querySelector('form[data-form="pay-bank-import"]');
          try {
            await preview({ mapping: mappingFrom(form) });
          } catch (e) {
            formError(e);
          }
          return true;
        }
        case "pay-bank-save-layout": {
          const form = modal.querySelector('form[data-form="pay-bank-import"]');
          const name = form.elements.preset_name.value.trim();
          if (!name) return formError("Enter a name for this layout."), true;
          try {
            const saved = await api("/payments/bank/layouts", "POST", { name, csv: pending.csv, mapping: mappingFrom(form) });
            await refresh();
            pending.layout = "preset:" + saved.id;
            toast(`Layout "${saved.name}" saved.`);
          } catch (e) {
            formError(e);
          }
          return true;
        }
        case "bank-review":
          reviewModal(id);
          return true;
        case "bank-apply": {
          const [tid, i] = id.split(":");
          const s = ext().suggestions?.[tid]?.[Number(i)];
          if (!s) return true;
          if (s.kind === "receipt") await apply(tid, { receipt_id: s.receipt_id }, "Matched.");
          else
            await apply(
              tid,
              { allocations: s.invoices.map((x) => ({ invoice_id: x.id, amount: dec(x.allocate) })), proof_id: s.proof_id || undefined },
              `Allocated to ${s.invoices.map((x) => x.number).join(", ")}.`,
            );
          return true;
        }
        case "bank-apply-ai": {
          const [tid, invoiceId] = id.split(":");
          const t = S.finance.bankTransactions.find((x) => x.id === tid),
            d = S.documents.find((x) => x.id === invoiceId);
          if (!t || !d) return true;
          await apply(tid, { allocations: [{ invoice_id: d.id, amount: dec(Math.min(t.amount, d.balance)) }] }, `Allocated to ${d.number}.`);
          return true;
        }
        case "bank-ai": {
          const t = S.finance.bankTransactions.find((x) => x.id === id);
          showModal(
            "Ask your AI model",
            `<form data-form="pay-bank-ai" data-id="${E(id)}"><p>${dateLabel(t.txn_date)} / ${E(t.reference)} / ${money(t.amount)}</p><div class="notice info mt22"><p>This sends the bank line (date, amount, reference and description) and, for up to 8 open invoices, the invoice number, client name, balance and due date to ${E(S.assistant?.providerOrigin || "your AI provider")} (${E(S.assistant?.model || "")}). No emails, addresses, tax numbers or record IDs are sent. Nothing is recorded until you confirm.</p></div><label class="check-row"><input type="checkbox" name="consent" required> Send this to my AI model</label>${formEnd("Ask AI")}</form>`,
          );
          return true;
        }
        case "public-pay": {
          const { url } = await api(`/public/${clientToken()}/checkout`, "POST", {});
          if (/^https:\/\//.test(url) || url.startsWith(location.origin + "/")) location.href = url;
          return true;
        }
        case "public-reference":
          referenceModal();
          return true;
      }
      return false;
    },
    async submit(form, b) {
      const type = form.dataset.form,
        id = form.dataset.id;
      if (type === "pay-keys") {
        const S = get(),
          p = S.gateway.providers.find((x) => x.name === id);
        const clear = b.clear === "on";
        const values = Object.fromEntries(
          p.keys.filter((k) => !k.flag && k.source !== "server").map((k) => [k.name, clear ? null : (b["key_" + k.name] || "").trim()]),
        );
        await api(`/payments/providers/${id}`, "PUT", {
          values,
          ...(p.keys.some((k) => k.flag && k.source !== "server") ? { sandbox: clear ? false : b.sandbox === "on" } : {}),
          password: b.password,
          code: b.code,
        });
        modal.close();
        await refresh();
        renderRoute();
        toast(clear ? `${p.label} keys removed.` : `${p.label} keys saved. Use Test connection to check them.`);
        return true;
      }
      if (type === "pay-duitnow") {
        await api("/payments/duitnow", "PUT", { payload: b.payload || null });
        await refresh();
        renderRoute();
        toast(b.payload ? "DuitNow QR saved. It now shows on unpaid invoices." : "DuitNow QR removed.");
        return true;
      }
      if (type === "pay-duitnow-image") {
        const file = form.elements.file.files[0];
        if (!file) throw new Error("Choose an image.");
        await raw("/payments/duitnow/image?" + new URLSearchParams({ name: file.name }), file);
        modal.close();
        await refresh();
        renderRoute();
        toast("DuitNow QR image saved.");
        return true;
      }
      if (type === "pay-bank-preview") {
        const file = form.elements.file.files[0];
        if (file && file.size > 400000) throw new Error("Import up to 400 KB at a time. Split longer statements by month.");
        const csv = file ? await file.text() : b.csv;
        if (!csv?.trim()) throw new Error("Choose a CSV file or paste the statement.");
        pending = { csv, account: b.account, layout: b.layout, preview: null };
        await preview({});
        return true;
      }
      if (type === "pay-bank-import") {
        const mapping = pending.preview.mapping;
        const r = await api("/payments/bank/import", "POST", { csv: pending.csv, account: pending.account, layout: pending.layout, mapping, skipErrors: b.skipErrors === "on" });
        pending = null;
        modal.close();
        await refresh();
        renderRoute();
        toast(`${r.inserted} bank row(s) imported; ${r.skipped} duplicate(s) skipped${r.unreadable ? `; ${r.unreadable} unreadable row(s) left out` : ""}.`);
        return true;
      }
      if (type === "pay-bank-ai") {
        const r = await api(`/payments/bank/${id}/ai`, "POST", { consent: b.consent === "on" });
        await refresh();
        renderRoute();
        const S = get();
        showModal(
          "AI ranking",
          `${r.ranking.length ? r.ranking.map((x) => `<div class="payment"><div class="payment-top"><strong>${E(x.number)} / ${E(x.client_name)}</strong>${level(x.confidence >= 70 ? "High" : x.confidence >= 40 ? "Medium" : "Low", x.confidence)}</div><p>${E(x.reason)}</p>${S.documents.some((d) => d.id === x.invoice_id && d.balance > 0) ? button("Record receipt and allocate", "bank-apply-ai", `${id}:${x.invoice_id}`) : ""}</div>`).join("") : "<p>The model did not find a likely invoice.</p>"}<p class="field-hint">Suggested by ${E(r.model)}. Check the bank line before you confirm.</p>`,
        );
        return true;
      }
      if (type === "public-reference") {
        const file = form.elements.slip?.files?.[0];
        if (!file) return false; // the core form sends the reference alone
        if (file.size > 5 * 1024 * 1024) throw new Error("Slips must be 5 MB or smaller.");
        await raw(`/guest/payments/slip/${clientToken()}?` + new URLSearchParams({ reference: b.reference, note: b.note || "", name: file.name }), file);
        location.replace(location.pathname + "?slip=sent");
        return true;
      }
      return false;
    },
  };
}
