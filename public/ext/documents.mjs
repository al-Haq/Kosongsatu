// Documents and billing: line discounts, item codes, PDF templates, proforma, sales and delivery orders, currencies, languages, custom fields, deposits and instalments.
// Browser module contract: see docs/PLUGINS.md.
import { CURRENCIES, LANGUAGES } from "./documents-calc.mjs";
import { LANGUAGE_NAMES } from "./documents-i18n.mjs";

const KIND_NAMES = {
  invoice: "invoice",
  quote: "quotation",
  proforma: "proforma invoice",
  sales_order: "sales order",
  delivery_order: "delivery order",
};
const LAYOUT_NAMES = { classic: "Classic (default)", modern: "Modern colour header", compact: "Compact" };

export default function documentsUI(h) {
  const { dateValue, E, money, dec, dateLabel, button, badge, input, area, select, api, refresh, renderRoute, navigate, showModal, modal, toast } = h;
  const S = () => h.get();
  const ext = () => S().ext?.documents || {};
  const template = () => ({ ...(ext().template || {}), ...S().settings });
  const customFields = () => S().settings.customFields || [];
  const applies = (f, kind) =>
    f.applies === "all" || f.applies === kind || (f.applies === "invoice" && kind === "proforma");
  const docById = (id) => S().documents.find((d) => d.id === id);
  const kindName = (k) => KIND_NAMES[k] || "document";
  const cap = (v) => v[0].toUpperCase() + v.slice(1);
  const currencyOptions = () => (ext().currencies || CURRENCIES).map((c) => [c, c]);
  const languageOptions = (blank) => [
    ...(blank ? [["", blank]] : []),
    ...(ext().languages || LANGUAGES).map((l) => [l, LANGUAGE_NAMES[l] || l]),
  ];
  const linkButton = (label, action, id, to = "", primary = false) =>
    `<button type="button" class="btn ${primary ? "primary" : ""}" data-action="${action}" data-id="${E(id)}" data-to="${E(to)}">${E(label)}</button>`;
  // Raw uploads to this module's routes (attachments, logo).
  async function upload(path, file, params = {}) {
    const response = await fetch("/api" + path + "?" + new URLSearchParams({ name: file.name || "upload", ...params }), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-CSRF-Token": h.session().csrf },
      body: file,
    });
    const data = await response.json().catch(() => ({ error: "Upload failed." }));
    if (!response.ok) throw new Error(data.error || "Upload failed.");
    return data;
  }
  const reload = async (message) => {
    await refresh();
    renderRoute();
    if (message) toast(message);
  };

  // --- Editor fields ---
  function documentFields(value, kind) {
    const cur = value.currency || "MYR";
    const meta = value.meta || {};
    const deposit = meta.deposit || null;
    const fields = customFields().filter((f) => applies(f, kind));
    return `<section class="doc-options"><div class="form-grid">${select("Currency", "currency", currencyOptions(), cur)}<div class="fx-field ${cur === "MYR" ? "is-hidden" : ""}">${input(
      `Exchange rate (MYR per 1 ${cur === "MYR" ? "unit" : cur})`,
      "fx_rate",
      cur === "MYR" ? "" : value.fx_rate || "",
      "text",
      false,
      'inputmode="decimal" maxlength="13" placeholder="e.g. 4.45"',
    )}</div>${select("Document language", "language", languageOptions(), value.language || "en")}${
      kind === "quote"
        ? `${select(
            "Deposit on acceptance",
            "deposit_type",
            [
              ["", "No deposit"],
              ["percent", "Percentage of total"],
              ["amount", "Fixed amount (before SST)"],
            ],
            deposit?.type || "",
            false,
          )}<div class="deposit-field ${deposit ? "" : "is-hidden"}">${input("Deposit (% or amount)", "deposit_value", deposit ? (deposit.type === "percent" ? deposit.value : dec(deposit.amount)) : "", "number", false, 'min="0" step="0.01"')}</div>`
        : ""
    }${fields
      .map(
        (f) =>
          `<div>${input(f.label + (f.show === "internal" ? " (internal)" : ""), "cf_" + f.id, meta.custom?.[f.id] || "", "text", false, 'maxlength="500"')}</div>`,
      )
      .join("")}</div><input type="hidden" name="doc_options" value="1"><label class="check-row"><input type="checkbox" name="list_attachments" ${meta.list_attachments ? "checked" : ""}> List client-visible attachments on the PDF</label>${
      ext().cjkFont === false ? '<p class="field-hint doc-cjk-hint">Chinese PDFs need a Chinese font on the server (see Settings).</p>' : ""
    }</section>`;
  }
  // Defaults follow the client; the rate field shows only for other currencies.
  document.addEventListener("change", (event) => {
    const form = event.target.closest('form[data-form="editor"]');
    if (!form) return;
    if (event.target.name === "client_id" && !form.dataset.id) {
      const c = S().clients.find((x) => x.id === event.target.value);
      if (c && form.elements.currency) form.elements.currency.value = c.currency || "MYR";
      if (c && form.elements.language)
        form.elements.language.value = c.language || S().settings.documentLanguage || "en";
    }
    if (["client_id", "currency"].includes(event.target.name) && form.elements.currency) {
      const cur = form.elements.currency.value;
      form.querySelector(".fx-field")?.classList.toggle("is-hidden", cur === "MYR");
      const label = form.querySelector(".fx-field label");
      if (label?.firstChild) label.firstChild.textContent = `Exchange rate (MYR per 1 ${cur})`;
    }
    if (event.target.name === "deposit_type")
      form.querySelector(".deposit-field")?.classList.toggle("is-hidden", !event.target.value);
    // Refresh the live preview with the new currency.
    if (event.target.name === "client_id") form.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // --- Document page ---
  function documentActions(d) {
    if (d.state === "void" || d.state === "draft") return "";
    const out = [];
    if (d.kind === "quote" && d.state === "accepted") {
      if (d.deposit && !d.deposit.invoice) out.push(linkButton("Deposit invoice", "doc-deposit", d.id));
      out.push(linkButton("Sales order", "doc-convert", d.id, "sales_order"));
    }
    if (d.kind === "proforma") out.push(linkButton("Convert to invoice", "doc-convert", d.id, "invoice", true));
    if (d.kind === "sales_order") {
      out.push(linkButton("Create invoice", "doc-convert", d.id, "invoice", true));
      out.push(linkButton("Delivery", "doc-convert", d.id, "delivery_order"));
    }
    if (d.kind === "invoice") out.push(linkButton("Delivery", "doc-convert", d.id, "delivery_order"));
    return out.join("");
  }
  function linkedPanel(d) {
    const l = d.links || {};
    if (!l.source && !(l.children || []).length) return "";
    const row = (x, role) =>
      `<div class="payment"><div class="payment-top"><button class="link-button" data-action="open-document" data-id="${E(x.id)}">${E(x.number || "Draft " + kindName(x.kind))}</button>${badge(x.state === "void" ? "Void" : x.state === "draft" ? "Draft" : "Issued")}</div><p>${E(role)}</p></div>`;
    return `<section class="panel"><div class="panel-head"><h2>Linked documents</h2></div>${l.source ? row(l.source, (l.source_role === "deposit" ? "Deposit for " : "Created from ") + kindName(l.source.kind)) : ""}${(l.children || [])
      .map((c) => row(c, c.source_role === "deposit" ? "Deposit invoice" : cap(kindName(c.kind))))
      .join("")}</section>`;
  }
  function depositPanel(d) {
    if (d.kind !== "quote" || !d.deposit) return "";
    const cur = d.currency;
    return `<section class="panel"><div class="panel-head"><h2>Deposit</h2>${badge(d.deposit.invoice ? "Invoiced" : "Pending")}</div><div class="total-row"><span>${d.deposit.type === "percent" ? E(d.deposit.value) + "% before SST" : "Fixed, before SST"}</span><strong>${money(d.deposit.amount, cur)}</strong></div>${d.deposit.tax ? `<div class="total-row"><span>SST</span><strong>${money(d.deposit.tax, cur)}</strong></div>` : ""}<div class="total-row emphasis"><span>Deposit total</span><span>${money(d.deposit.total, cur)}</span></div><p class="field-hint">${d.deposit.invoice ? "The final invoice from this quotation deducts the deposit and its SST." : d.state === "accepted" ? "Create the deposit invoice now; the final invoice will deduct it." : "Available once the client accepts."}</p></section>`;
  }
  function instalmentPanel(d) {
    if (d.kind !== "invoice" || d.state !== "issued") return "";
    const cur = d.currency;
    if (!d.instalments?.length)
      return d.balance > 0
        ? `<section class="panel"><div class="panel-head"><h2>Instalments</h2></div><p>Split this invoice into instalments with their own due dates. Reminders and the Overdue status follow the plan.</p><div class="actions mt22">${button("Set up instalments", "doc-instalments", d.id)}</div></section>`
        : "";
    return `<section class="panel"><div class="panel-head"><h2>Instalments</h2>${badge(d.status)}</div>${d.instalments
      .map(
        (i) =>
          `<div class="total-row"><span>${i.seq}. ${dateLabel(i.due_date)}</span><strong>${money(i.amount, cur)} ${badge(i.status === "paid" ? "Paid" : i.status === "part" ? "Part-paid" : i.due_date < S().today ? "Overdue" : "Issued", i.status === "paid" ? "Paid" : i.status === "part" ? "Part-paid" : i.due_date < S().today ? "Overdue" : "Due")}</strong></div>`,
      )
      .join("")}${d.next_due_date ? `<p class="field-hint">Next: ${money(d.next_due_amount, cur)} due ${dateLabel(d.next_due_date)}</p>` : ""}<div class="actions mt22">${d.balance > 0 ? button("Edit plan", "doc-instalments", d.id) : ""}${button("Remove plan", "doc-instalments-clear", d.id)}</div></section>`;
  }
  function attachmentsPanel(d) {
    const files = d.attachments || [];
    return `<section class="panel"><div class="panel-head"><h2>Attachments</h2><span class="muted">${files.length} / 10</span></div>${files
      .map(
        (f) =>
          `<div class="payment"><div class="payment-top"><a href="/api/files/${E(f.id)}" target="_blank" rel="noopener">${E(f.name)}</a>${badge(f.visibility === "client" ? "Active" : "Internal", f.visibility === "client" ? "Client can see" : "Private")}</div><p>${Math.max(1, Math.round(f.size / 1024))} KB · ${E(f.mime)}</p><div class="payment-actions"><button class="link-button" data-action="doc-attachment-visibility" data-id="${E(f.id)}" data-to="${f.visibility === "client" ? "private" : "client"}">${f.visibility === "client" ? "Make private" : "Show to client"}</button><button class="link-button red-text" data-action="doc-attachment-delete" data-id="${E(f.id)}">Delete</button></div></div>`,
      )
      .join("")}${
      d.state !== "void" && files.length < 10
        ? `<form data-form="doc-attachment" data-id="${E(d.id)}" class="mt22"><div class="file-row"><label class="btn file-pick">Choose file<input type="file" name="file" accept="application/pdf,image/png,image/jpeg,image/webp,image/gif" required></label><span class="file-name muted" data-empty="PDF or image, up to 5 MB">PDF or image, up to 5 MB</span><button class="btn" type="submit">Upload</button></div><label class="check-row"><input type="checkbox" name="client"> Visible to the client</label>${h.errorBlock()}</form>`
        : ""
    }</section>`;
  }
  function documentPanels(d) {
    return linkedPanel(d) + depositPanel(d) + instalmentPanel(d) + attachmentsPanel(d);
  }
  function instalmentForm(id) {
    const d = docById(id);
    const rows = d.instalments?.length
      ? d.instalments.map((i) => ({ due_date: i.due_date, amount: i.planned ?? i.amount }))
      : (() => {
          const n = 3,
            base = Math.floor(d.adjusted_total / n);
          return Array.from({ length: n }, (_, k) => ({
            due_date: h.addDays(d.due_date, 30 * k),
            amount: k === n - 1 ? d.adjusted_total - base * (n - 1) : base,
          }));
        })();
    const row = (r) =>
      `<div class="instalment-edit">${input("Due date", "due_date", r.due_date, "date", true)}${input(`Amount (${d.currency})`, "amount", dec(r.amount), "number", true, 'min="0.01" step="0.01"')}<button type="button" class="btn ghost" data-action="doc-instalment-remove" aria-label="Remove instalment">${h.icon("close")}</button></div>`;
    showModal(
      "Instalment plan",
      `<form data-form="doc-instalments" data-id="${E(id)}"><div class="notice info"><p>${E(d.number)} / total ${money(d.adjusted_total, d.currency)}. Instalments must add up to the total; payments are applied to the earliest instalment first.</p></div><div id="instalment-rows">${rows.map(row).join("")}</div><div class="actions mt22">${button("Add instalment", "doc-instalment-add")}</div><p class="field-hint" id="instalment-sum"></p>${h.formEnd("Save plan")}</form>`,
      true,
    );
    modal.dataset.instalmentRow = row({ due_date: d.due_date, amount: 0 });
    updateSum();
  }
  function updateSum() {
    const form = modal.querySelector('form[data-form="doc-instalments"]');
    if (!form) return;
    const d = docById(form.dataset.id);
    const sum = [...form.querySelectorAll("[name=amount]")].reduce((s, el) => s + Math.round(Number(el.value || 0) * 100), 0);
    const left = d.adjusted_total - sum;
    form.querySelector("#instalment-sum").textContent = left
      ? `${money(Math.abs(left), d.currency)} ${left > 0 ? "still to allocate" : "too much"}.`
      : "The instalments add up to the invoice total.";
  }
  modal.addEventListener("input", (e) => {
    if (e.target.closest('form[data-form="doc-instalments"]')) updateSum();
  });

  // --- Settings ---
  function settings() {
    const t = template();
    const fields = customFields();
    const logoId = S().settings.logoFileId;
    const show = (key, label) =>
      `<label class="check-row"><input type="checkbox" name="${key}" ${t[key] === false ? "" : "checked"}> ${E(label)}</label>`;
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Document template</h2><p>How PDFs look for invoices, quotations, receipts, notes and statements.</p></div>${badge(LAYOUT_NAMES[t.pdfLayout || "classic"] ? "Active" : "Active", LAYOUT_NAMES[t.pdfLayout || "classic"] || "Classic")}</div><div class="doc-logo-row">${logoId ? `<img class="doc-logo-preview" src="/api/files/${E(logoId)}" alt="Business logo">` : '<img class="doc-logo-preview" src="/assets/nawlogic-logo.png" alt="Nawlogic logo">'}<form data-form="doc-logo"><label>Business logo (PNG or JPEG, up to 1 MB)<input type="file" name="file" accept="image/png,image/jpeg" required></label>${h.errorBlock()}<div class="actions">${logoId ? button("Use Nawlogic logo", "doc-logo-remove") : ""}<button class="btn" type="submit">Upload logo</button></div></form></div><form data-form="doc-template" class="mt22"><div class="form-grid">${select("Layout", "pdfLayout", Object.entries(LAYOUT_NAMES), t.pdfLayout || "classic")}<label>Accent colour<input type="color" name="pdfAccent" value="${E(t.pdfAccent || "#087F7E")}"></label>${select("Default document language", "documentLanguage", languageOptions(), t.documentLanguage || "en")}${input("Footer text (optional)", "pdfFooterText", t.pdfFooterText || "", "text", false, 'maxlength="160" placeholder="Nawlogic | Business document"')}${input("Proforma prefix", "proformaPrefix", t.proformaPrefix || "PF", "text", true, 'pattern="[A-Z][A-Z0-9\\-]{0,11}" maxlength="12"')}${input("Sales order prefix", "salesOrderPrefix", t.salesOrderPrefix || "SO", "text", true, 'pattern="[A-Z][A-Z0-9\\-]{0,11}" maxlength="12"')}${input("Delivery order prefix", "deliveryOrderPrefix", t.deliveryOrderPrefix || "DO", "text", true, 'pattern="[A-Z][A-Z0-9\\-]{0,11}" maxlength="12"')}</div><div class="doc-show">${show("pdfShowBank", "Bank details")}${show("pdfShowTerms", "Terms")}${show("pdfShowNotes", "Notes")}${show("pdfShowBuyerTax", "Client TIN and registration")}${show("pdfShowFooter", "Page footer text")}</div><p class="field-hint">Issued documents keep the template and logo they were issued with. The MyInvois notice stays in the footer whenever the footer is shown.</p>${h.errorBlock()}<div class="form-actions"><button class="btn primary" type="submit">Save template</button></div></form><div class="setting-line mt22"><div><h3>Chinese (中文) PDFs</h3><p>${ext().cjkFont ? "Chinese font found: " + E(ext().cjkFontPath || "") : "No Chinese font on the server. Install fonts-noto-cjk, or set PDF_CJK_FONT under Integration keys. Chinese documents cannot be issued until then."}</p></div>${badge(ext().cjkFont ? "Connected" : "Not connected", ext().cjkFont ? "Ready" : "Font missing")}</div></section><section class="panel mt22"><div class="panel-head"><div><h2>Custom fields</h2><p>Up to 10 extra fields on documents, such as a project code or PO number.</p></div>${badge(fields.length ? "Active" : "Not connected", fields.length + " / 10")}</div><form data-form="doc-custom-fields"><div id="custom-field-rows">${fields.map(fieldRow).join("")}</div><div class="actions mt22">${button("Add field", "doc-field-add")}</div><p class="field-hint">Values are typed in the document editor and locked when the document is issued. Internal fields never show on PDFs or client links.</p>${h.errorBlock()}<div class="form-actions"><button class="btn primary" type="submit">Save fields</button></div></form></section>`;
  }
  function fieldRow(f = { id: "", label: "", applies: "all", show: "pdf" }) {
    return `<div class="custom-field-row" data-field="${E(f.id)}">${input("Label", "label", f.label, "text", true, 'maxlength="60"')}${select("Used on", "applies", [["all", "All documents"], ["invoice", "Invoices"], ["quote", "Quotations"]], f.applies)}${select("Shown", "show", [["pdf", "On PDF and client link"], ["internal", "Internal only"]], f.show)}<button type="button" class="btn ghost" data-action="doc-field-remove" aria-label="Remove field">${h.icon("close")}</button></div>`;
  }

  // --- Clients ---
  const clientFields = (c) =>
    `${select("Default currency", "currency", currencyOptions(), c.currency || "MYR")}${select("Document language", "language", languageOptions("Business default"), c.language || "", false)}`;
  const clientDetails = (c) =>
    `<dt>Currency / language</dt><dd>${E(c.currency || "MYR")} / ${E(c.language ? LANGUAGE_NAMES[c.language] : "Business default")}</dd>`;

  // --- Client page ---
  function publicPanels(d, token) {
    const files = d.ext?.documents?.attachments || [];
    if (!files.length) return "";
    const lang = d.language || "en";
    const heading = { en: "Attachments", ms: "Lampiran", zh: "附件" }[lang] || "Attachments";
    return `<section class="panel"><h2>${heading}</h2>${files
      .map(
        (f) =>
          `<div class="attention"><div><strong>${E(f.name)}</strong><small>${Math.max(1, Math.round(f.size / 1024))} KB</small></div><a class="btn small" href="/api/guest/documents/${E(token)}/files/${E(f.id)}" rel="noopener">${h.icon("download")}</a></div>`,
      )
      .join("")}</section>`;
  }

  async function action(type, id, el) {
    switch (type) {
      case "doc-convert": {
        const d = await api(`/ext/documents/${id}/convert`, "POST", { to: el.dataset.to });
        await refresh();
        navigate("document/" + d.id);
        toast(d.state === "draft" ? `Draft ${kindName(d.kind)} created. Review it before issuing.` : `Opened the linked ${kindName(d.kind)}.`);
        return true;
      }
      case "doc-deposit": {
        const d = await api(`/ext/documents/${id}/deposit-invoice`, "POST", {});
        await refresh();
        navigate("document/" + d.id);
        toast("Deposit invoice created as a draft. Issue it to bill the deposit.");
        return true;
      }
      case "doc-instalments":
        instalmentForm(id);
        return true;
      case "doc-instalment-add":
        if (modal.querySelectorAll(".instalment-edit").length >= 24) toast("Up to 24 instalments.", true);
        else modal.querySelector("#instalment-rows").insertAdjacentHTML("beforeend", modal.dataset.instalmentRow);
        updateSum();
        return true;
      case "doc-instalment-remove":
        if (modal.querySelectorAll(".instalment-edit").length > 2) el.closest(".instalment-edit").remove();
        else toast("A plan needs at least 2 instalments.", true);
        updateSum();
        return true;
      case "doc-instalments-clear":
        await api(`/ext/documents/${id}/instalments`, "DELETE");
        await reload("Instalment plan removed. The invoice due date applies again.");
        return true;
      case "doc-attachment-visibility":
        await api(`/ext/documents/attachments/${id}`, "PUT", { visibility: el.dataset.to });
        await reload(el.dataset.to === "client" ? "The client can now download this file." : "File is private again.");
        return true;
      case "doc-attachment-delete":
        await api(`/ext/documents/attachments/${id}`, "DELETE");
        await reload("Attachment deleted.");
        return true;
      case "doc-logo-remove":
        await api("/ext/documents/logo", "DELETE");
        await reload("PDFs use the Nawlogic logo again.");
        return true;
      case "doc-field-add": {
        const rows = document.querySelector("#custom-field-rows");
        if (rows.children.length >= 10) toast("Up to 10 custom fields.", true);
        else rows.insertAdjacentHTML("beforeend", fieldRow());
        return true;
      }
      case "doc-field-remove":
        el.closest(".custom-field-row").remove();
        return true;
    }
    return false;
  }
  async function submit(form, b) {
    switch (form.dataset.form) {
      case "doc-template":
        await api("/settings", "PUT", {
          pdfLayout: b.pdfLayout,
          pdfAccent: b.pdfAccent,
          documentLanguage: b.documentLanguage,
          pdfFooterText: b.pdfFooterText || "",
          proformaPrefix: b.proformaPrefix,
          salesOrderPrefix: b.salesOrderPrefix,
          deliveryOrderPrefix: b.deliveryOrderPrefix,
          ...Object.fromEntries(
            ["pdfShowBank", "pdfShowTerms", "pdfShowNotes", "pdfShowBuyerTax", "pdfShowFooter"].map((k) => [k, b[k] === "on"]),
          ),
        });
        await reload("Document template saved.");
        return true;
      case "doc-custom-fields":
        await api("/settings", "PUT", {
          customFields: [...form.querySelectorAll(".custom-field-row")].map((row) => ({
            id: row.dataset.field || undefined,
            label: row.querySelector("[name=label]").value,
            applies: row.querySelector("[name=applies]").value,
            show: row.querySelector("[name=show]").value,
          })),
        });
        await reload("Custom fields saved.");
        return true;
      case "doc-logo":
        await upload("/ext/documents/logo", form.elements.file.files[0]);
        await reload("Logo saved. New PDFs and client links use it.");
        return true;
      case "doc-attachment":
        await upload(`/ext/documents/${form.dataset.id}/attachments`, form.elements.file.files[0], {
          visibility: b.client === "on" ? "client" : "private",
        });
        await reload("File attached.");
        return true;
      case "doc-instalments": {
        const dates = [...form.querySelectorAll("[name=due_date]")].map((el) => dateValue(el));
        const amounts = [...form.querySelectorAll("[name=amount]")].map((el) => el.value);
        await api(`/ext/documents/${form.dataset.id}/instalments`, "PUT", {
          instalments: dates.map((due_date, n) => ({ due_date, amount: amounts[n] })),
        });
        modal.close();
        await reload("Instalment plan saved. Reminders follow the new dates.");
        return true;
      }
    }
    return false;
  }
  return {
    action,
    submit,
    slots: {
      documentFields,
      documentActions,
      documentPanels,
      settings,
      clientFields,
      clientDetails,
      publicPanels,
    },
  };
}
