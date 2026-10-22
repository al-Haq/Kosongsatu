// Books and reports: expenses and vendor bills, receipt scanning, sales reports, profit and loss, accounting exports, cash flow, tax summaries, late-payment prediction and cash health.
// Browser module contract: see docs/PLUGINS.md.
export default function booksUI(h) {
  const { E, money, dec, dateLabel, button, input, setDateValue, area, select, formEnd, heading, empty, icon, showModal, modal, toast } = h;
  const S = () => h.get();
  const B = () => S()?.ext?.books || null;
  const T = () => S().today;
  const addDays = h.addDays;

  // ---------- small helpers ----------
  const tag = (text, color = "") => `<span class="badge ${color}"><span class="dot"></span>${E(text)}</span>`;
  const riskTag = (risk) => tag({ high: "High risk", medium: "Medium risk", low: "Low risk" }[risk] || "No history", { high: "red", medium: "orange", low: "green" }[risk] || "");
  const statusTag = (s) => tag(s, { Paid: "green", "Part-paid": "orange", Unpaid: "blue", Overdue: "red", Void: "red", Draft: "", Issued: "blue", Received: "orange", Billed: "green", Cancelled: "red" }[s] || "");
  const link = (label, href, extra = "") => `<a class="btn ${extra}" href="${E(href)}">${E(label)}</a>`;
  const tabs = (items, active) =>
    `<div class="tabs books-tabs" role="navigation" aria-label="Sections">${items.map(([key, label, href]) => `<a class="tab ${key === active ? "active" : ""}" href="${E(href)}" ${key === active ? 'aria-current="page"' : ""}>${E(label)}</a>`).join("")}</div>`;
  const cat = (id) => B()?.categories.find((c) => c.id === id);
  const catName = (id) => cat(id)?.name || "Uncategorised";
  const catOptions = (selected = "", includeInactive = false) =>
    B()
      .categories.filter((c) => c.active || includeInactive || c.id === selected)
      .map((c) => [c.id, c.name + (c.active ? "" : " (inactive)")]);
  const vendorOptions = (selected = "", blank = "No saved vendor") => [
    ["", blank],
    ...B()
      .vendors.filter((v) => !v.archived || v.id === selected)
      .map((v) => [v.id, v.name]),
  ];
  const methodOptions = () => B().paymentMethods.map((m) => [m, m]);
  const pct = (v, max) => (max > 0 ? Math.max(0, Math.min(100, Math.round((Math.abs(v) / max) * 1000) / 10)) : 0);
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  const days = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
  const field = (form, name) => form.querySelector(`[name="${name}"]`);

  // Creating records retries safely: the same request key is reused until the
  // server answers, so a lost response never creates a second record.
  const keys = new Map();
  async function send(path, method, body) {
    const sig = method + path + JSON.stringify(body);
    if (method === "POST" && !keys.has(sig)) keys.set(sig, crypto.randomUUID());
    const res = await fetch("/api" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": h.session()?.csrf || "",
        ...(method === "POST" ? { "Idempotency-Key": keys.get(sig) } : {}),
      },
      body: JSON.stringify(body),
    });
    if (res.ok || res.status < 500) keys.delete(sig);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error("Server returned an unreadable response.");
    }
    if (!res.ok) throw new Error(data.error || "Request failed.");
    return data;
  }
  async function reload(message) {
    modal.close();
    await h.refresh();
    h.renderRoute();
    if (message) toast(message);
  }

  // ---------- async page parts and CSS-free sizing ----------
  // Pages render placeholders; this fills them and sizes the bars (the content
  // security policy does not allow style attributes in markup).
  const loaders = {};
  function process() {
    for (const el of document.querySelectorAll("[data-books-w]")) {
      el.style.width = el.dataset.booksW + "%";
      el.removeAttribute("data-books-w");
    }
    for (const el of document.querySelectorAll("[data-books-h]")) {
      el.style.height = el.dataset.booksH + "px";
      el.removeAttribute("data-books-h");
    }
    for (const el of document.querySelectorAll("[data-books-load]:not([data-books-busy])")) {
      el.dataset.booksBusy = "1";
      const fn = loaders[el.dataset.booksLoad];
      if (!fn) continue;
      Promise.resolve()
        .then(() => fn(el.dataset.q || "", el))
        .then((html) => {
          if (el.isConnected) el.innerHTML = html;
        })
        .catch((e) => {
          if (el.isConnected) el.innerHTML = `<div class="notice error"><p>${E(e.message)}</p></div>`;
        });
    }
  }
  new MutationObserver(process).observe(document.body, { childList: true, subtree: true });
  const placeholder = (kind, q = "") => `<div data-books-load="${E(kind)}" data-q="${E(q)}"><p class="muted books-loading">Loading…</p></div>`;

  // ---------- state ----------
  const yearStart = () => T().slice(0, 4) + "-01-01";
  let expFilter = null;
  const filters = () => (expFilter ||= { from: "", to: "", category: "", vendor: "", status: "", q: "", offset: 0 });
  let range = null;
  const period = () => (range ||= { from: yearStart(), to: T() });
  let salesView = "client";
  let pnlBasis = "accrual";
  let taxYear = null;

  // ---------- expenses ----------
  function expensesPage(sub) {
    const b = B();
    if (!b) return empty("Books are unavailable", "Refresh the page.");
    const t = tabs(
      [
        ["list", "Expenses", "#/expenses"],
        ["vendors", "Vendors", "#/expenses/vendors"],
        ["categories", "Categories", "#/expenses/categories"],
      ],
      sub || "list",
    );
    if (sub === "vendors") return heading("Vendors", "", button("Add vendor", "books-new-vendor", "", true, "plus")) + t + vendorsTable();
    if (sub === "categories")
      return (
        heading("Expense categories", "", button("Add category", "books-new-category", "", true, "plus")) +
        t +
        categoriesTable()
      );
    const f = filters();
    const q = qs({ ...f, limit: 50 });
    return (
      heading("Expenses", "",
        button("Scan receipt", "books-scan", "", false, "receipt") + button("New expense", "books-new-expense", "", true, "plus"),
      ) +
      t +
      `<section class="panel"><form data-form="books-exp-filter" class="books-filter"><div class="books-filter-grid">${input("From", "from", f.from, "date")}${input("To", "to", f.to, "date")}${select("Category", "category", [["", "All categories"], ...catOptions(f.category, true)], f.category, false)}${select("Vendor", "vendor", vendorOptions(f.vendor, "All vendors"), f.vendor, false)}${select("Status", "status", [["", "Paid and unpaid"], ["paid", "Paid"], ["unpaid", "Unpaid"]], f.status, false)}${input("Search", "q", f.q, "search", false, 'maxlength="120" placeholder="Vendor, description, reference"')}</div><div class="actions"><button class="btn primary" type="submit">Apply filters</button>${button("Clear", "books-exp-clear")}<a class="btn" href="/api/books/expenses.csv?${E(qs({ ...f, offset: "" }))}">${icon("download")} Export CSV</a></div></form>${placeholder("expenses", q)}</section>`
    );
  }
  loaders.expenses = async (q) => {
    const r = await h.api("/books/expenses?" + q);
    const f = filters();
    const rows = r.items
      .map(
        (e) =>
          `<tr><td>${dateLabel(e.date)}</td><td><button class="link-button" data-action="books-edit-expense" data-id="${E(e.id)}">${E(e.vendor_name || e.description || "Expense")}</button><small>${E([e.vendor_name ? e.description : "", e.reference].filter(Boolean).join(" · "))}</small></td><td>${E(catName(e.category_id))}${e.bill_number ? `<small><a href="#/bill/${E(e.bill_id)}">${E(e.bill_number)}</a></small>` : ""}</td><td>${e.status === "paid" ? statusTag("Paid") : e.due_date < T() ? statusTag("Overdue") : statusTag("Unpaid")}<small>${e.status === "paid" ? dateLabel(e.paid_date) + " · " + E(e.payment_method) : "Due " + dateLabel(e.due_date)}</small></td><td class="num">${money(e.amount)}${e.tax ? `<small>SST ${money(e.tax)}</small>` : ""}</td><td>${e.file_count ? `<span class="books-clip" title="${e.file_count} receipt file(s)">${icon("receipt")}<span class="sr-only">${e.file_count} receipt file(s)</span></span>` : ""}</td><td><div class="actions books-row-actions">${e.status === "unpaid" ? button("Mark paid", "books-pay-expense", e.id) : ""}${button("Edit", "books-edit-expense", e.id)}</div></td></tr>`,
      )
      .join("");
    const pager =
      r.total > r.limit
        ? `<nav class="pager" aria-label="Pages"><button class="btn" type="button" data-action="books-exp-page" data-id="${Math.max(0, f.offset - r.limit)}" ${f.offset ? "" : "disabled"}>Previous</button><span>${f.offset + 1}–${f.offset + r.items.length} of ${r.total}</span><button class="btn" type="button" data-action="books-exp-page" data-id="${f.offset + r.limit}" ${f.offset + r.limit < r.total ? "" : "disabled"}>Next</button></nav>`
        : "";
    return `<div class="books-tiles books-tiles-3"><div class="metric"><div class="label">Total</div><div class="value">${money(r.sum.amount)}</div><div class="hint">${r.total} expense${r.total === 1 ? "" : "s"} matching</div></div><div class="metric"><div class="label">SST / tax paid</div><div class="value">${money(r.sum.tax)}</div><div class="hint">Included in the total</div></div><div class="metric"><div class="label">Unpaid</div><div class="value ${r.sum.unpaid ? "red-text" : ""}">${money(r.sum.unpaid)}</div><div class="hint">Owed, not yet paid</div></div></div>${
      r.items.length
        ? `<div class="table-wrap"><table><caption class="sr-only">Expenses</caption><thead><tr><th>Date</th><th>Vendor / description</th><th>Category</th><th>Status</th><th class="num">Amount</th><th><span class="sr-only">Receipt</span></th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows}</tbody></table></div>${pager}`
        : empty("No expenses yet", "Record a cost or scan a receipt to start.", button("New expense", "books-new-expense", "", true))
    }<p class="field-hint">Bill payments appear here as expenses linked to their bill. Reports count a bill once: on its bill date (accrual) or on each payment date (cash).</p>`;
  };
  function expenseForm(e = null, scan = null) {
    const b = B();
    const d = scan?.draft || {};
    const v = e || {
      date: d.date || T(),
      vendor_id: d.vendor_id || "",
      vendor_name: d.vendor_name || "",
      category_id: d.category_id || "",
      description: d.description || "",
      amount: d.amount ? Math.round(Number(d.amount) * 100) : "",
      tax: d.tax ? Math.round(Number(d.tax) * 100) : 0,
      status: "paid",
      paid_date: d.date || T(),
      due_date: addDays(T(), 14),
      payment_method: "Bank transfer",
      reference: d.reference || "",
      notes: "",
      bill_id: "",
    };
    const bills = b.bills.filter((x) => x.state === "open" && (x.balance > 0 || x.id === v.bill_id));
    const file = scan?.file;
    const preview = file
      ? `<div class="books-preview">${file.mime.startsWith("image/") ? `<img src="/api/files/${E(file.id)}" alt="Uploaded receipt ${E(file.name)}">` : `<div class="notice info"><p>PDF receipt: ${E(file.name)}</p></div><a class="btn" href="/api/files/${E(file.id)}?inline=1" target="_blank" rel="noopener">Open PDF</a>`}${
          b.ai.configured
            ? `<div class="notice info mt22"><p><strong>Read with AI.</strong> This sends the file (${E(file.name)}, ${Math.ceil(file.size / 1024)} KB) and your category names to ${E(b.ai.origin)} using the model ${E(b.ai.model)}. Nothing is saved until you press Save.</p></div><div class="actions mt22">${button("Read with AI", "books-scan-read", scan.id, true)}</div>`
            : '<p class="field-hint">No AI model is set up, so fill in the form while looking at the receipt. To read receipts automatically, set AI_BASE_URL and AI_MODEL on the server (see Books in the docs).</p>'
        }<div class="books-warnings" role="status">${(d.warnings || []).map((w) => `<p class="field-hint">${E(w)}</p>`).join("")}</div></div>`
      : "";
    const existing = e?.files?.length
      ? `<div class="span-2"><h3 class="books-sub">Receipts</h3><ul class="books-files">${e.files.map((x) => `<li><a href="/api/files/${E(x.id)}${x.mime === "application/pdf" ? "?inline=1" : ""}" target="_blank" rel="noopener">${E(x.name)}</a> <small>${Math.ceil(x.size / 1024)} KB</small> <button class="link-button red-text" type="button" data-action="books-delete-file" data-id="${E(x.id)}">Remove</button></li>`).join("")}</ul></div>`
      : "";
    const form = `<form data-form="books-expense" data-id="${E(e?.id || "")}" data-scan="${E(scan?.id || "")}"><div class="form-grid">${input("Date", "date", v.date, "date", true, `max="${T()}"`)}${select("Vendor", "vendor_id", vendorOptions(v.vendor_id), v.vendor_id, false)}${input("Vendor name (if not saved)", "vendor_name", v.vendor_id ? "" : v.vendor_name, "text", false, 'maxlength="160"')}${select("Category", "category_id", [["", "Vendor's default / Other"], ...catOptions(v.category_id)], v.category_id, false)}<div class="span-2">${input("Description", "description", v.description, "text", false, 'maxlength="240" placeholder="What was it for?"')}</div>${input("Amount paid or owed (MYR)", "amount", v.amount === "" ? "" : dec(v.amount), "number", true, 'min="0.01" max="99999999.99" step="0.01"')}${input("SST / tax included (MYR)", "tax", dec(v.tax || 0), "number", false, 'min="0" max="99999999.99" step="0.01"')}${select("Status", "status", [["paid", "Paid"], ["unpaid", "Not paid yet"]], v.status)}${input("Reference (receipt or invoice no.)", "reference", v.reference, "text", false, 'maxlength="120"')}<div class="books-when-paid">${input("Paid on", "paid_date", v.paid_date || v.date, "date", false, `max="${T()}"`)}</div><div class="books-when-paid">${select("Paid by", "payment_method", methodOptions(), v.payment_method || "Bank transfer", false)}</div><div class="books-when-unpaid">${input("Due date", "due_date", v.due_date || addDays(v.date, 14), "date", false)}</div>${bills.length ? `<div class="span-2">${select("This pays a supplier bill (optional)", "bill_id", [["", "Not a bill payment"], ...bills.map((x) => [x.id, `${x.number} · ${x.vendor_name} · ${money(x.balance)} left`])], v.bill_id || "", false)}</div>` : ""}<div class="span-2">${area("Notes", "notes", v.notes, 1000)}</div>${existing}<div class="span-2"><label>${e ? "Add a receipt file" : file ? "Receipt" : "Receipt photo or PDF (optional)"}${file ? `<span class="field-hint">${E(file.name)} is attached when you save.</span>` : `<input type="file" class="books-file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf">`}</label></div><label class="check-row span-2 books-dup" hidden><input type="checkbox" name="allow_duplicate"> This is a separate expense with the same vendor, date, amount and reference.</label></div>${e ? `<div class="actions">${button("Delete expense", "books-delete-expense", e.id)}</div>` : ""}${formEnd(e ? "Save changes" : "Save expense")}</form>`;
    showModal(e ? "Edit expense" : scan ? "Check the receipt" : "New expense", file ? `<div class="books-scan-grid">${preview}<div>${form}</div></div>` : form, !!file);
    const f = modal.querySelector('form[data-form="books-expense"]');
    const toggle = () => {
      const paid = field(f, "status").value === "paid";
      f.querySelectorAll(".books-when-paid").forEach((el) => (el.hidden = !paid));
      f.querySelectorAll(".books-when-unpaid").forEach((el) => (el.hidden = paid));
    };
    field(f, "status").addEventListener("change", toggle);
    const billSel = field(f, "bill_id");
    billSel?.addEventListener("change", () => {
      const bill = B().bills.find((x) => x.id === billSel.value);
      if (!bill) return;
      field(f, "vendor_id").value = bill.vendor_id;
      field(f, "status").value = "paid";
      if (!field(f, "amount").value) field(f, "amount").value = dec(bill.balance);
      toggle();
    });
    field(f, "vendor_id").addEventListener("change", (ev) => {
      const vendor = B().vendors.find((x) => x.id === ev.target.value);
      if (vendor?.default_category && !field(f, "category_id").value) field(f, "category_id").value = vendor.default_category;
    });
    toggle();
  }
  function fillDraft(d) {
    const f = modal.querySelector('form[data-form="books-expense"]');
    if (!f) return;
    const set = (name, value) => {
      const el = field(f, name);
      if (!el || !value) return;
      if (el.matches("input[data-date]")) setDateValue(el, value);
      else el.value = value;
    };
    set("date", d.date);
    set("paid_date", d.date);
    if (d.vendor_id) set("vendor_id", d.vendor_id);
    else set("vendor_name", d.vendor_name);
    set("category_id", d.category_id);
    set("description", d.description);
    set("amount", d.amount);
    set("tax", d.tax);
    set("reference", d.reference);
    const w = modal.querySelector(".books-warnings");
    if (w) w.innerHTML = `<div class="notice info mt22"><p>Details filled in from the receipt. Check every field before saving.</p></div>${(d.warnings || []).map((x) => `<p class="field-hint">${E(x)}</p>`).join("")}`;
  }
  function scanModal() {
    showModal(
      "Scan a receipt",
      `<form data-form="books-scan-upload"><label>Receipt photo or PDF<input type="file" class="books-file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" capture="environment" required></label><p class="field-hint">Up to 5 MB. The file is kept privately with the expense. ${B().ai.configured ? "You can then ask your AI model to read it, or fill in the form yourself." : "Fill in the form next to the image."} Nothing is saved as an expense until you confirm.</p>${formEnd("Upload")}</form>`,
    );
  }
  async function uploadScan(file) {
    const res = await fetch("/api/books/scans?" + new URLSearchParams({ name: file.name || "receipt" }), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-CSRF-Token": h.session().csrf },
      body: file,
    });
    const data = await res.json().catch(() => ({ error: "Upload failed." }));
    if (!res.ok) throw new Error(data.error || "Upload failed.");
    return data;
  }
  function payExpenseModal(id, e) {
    showModal(
      "Mark expense paid",
      `<form data-form="books-pay-expense" data-id="${E(id)}"><p>${E(e.vendor_name || e.description)} · ${money(e.amount)}</p><div class="form-grid">${input("Paid on", "paid_date", T(), "date", true, `max="${T()}"`)}${select("Paid by", "payment_method", methodOptions(), "Bank transfer")}</div>${formEnd("Mark paid")}</form>`,
    );
  }
  function vendorsTable() {
    const list = B().vendors;
    if (!list.length) return `<section class="panel">${empty("No vendors yet", "Save the suppliers you buy from regularly.", button("Add vendor", "books-new-vendor", "", true))}</section>`;
    return `<section class="panel"><div class="table-wrap"><table><caption class="sr-only">Vendors</caption><thead><tr><th>Vendor</th><th>Contact</th><th>Default category</th><th>Terms</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${list
      .map(
        (v) =>
          `<tr><td><strong>${E(v.name)}</strong>${v.archived ? " " + tag("Archived", "orange") : ""}<small>${E([v.registration && "Reg " + v.registration, v.tin && "TIN " + v.tin].filter(Boolean).join(" · "))}</small></td><td>${E(v.contact || "—")}<small>${E([v.email, v.phone].filter(Boolean).join(" · "))}</small></td><td>${E(v.default_category ? catName(v.default_category) : "—")}</td><td>${v.terms} days</td><td><div class="actions">${button("Edit", "books-edit-vendor", v.id)}${button(v.archived ? "Restore" : "Archive", v.archived ? "books-restore-vendor" : "books-archive-vendor", v.id)}${button("Delete", "books-delete-vendor", v.id)}</div></td></tr>`,
      )
      .join("")}</tbody></table></div></section>`;
  }
  function vendorForm(id) {
    const v = B().vendors.find((x) => x.id === id) || { terms: 30 };
    showModal(
      id ? "Edit vendor" : "Add vendor",
      `<form data-form="books-vendor" data-id="${E(id || "")}"><div class="form-grid"><div class="span-2">${input("Vendor name", "name", v.name, "text", true, 'maxlength="160"')}</div>${input("Registration number (SSM)", "registration", v.registration, "text", false, 'maxlength="40"')}${input("Tax identification number (TIN)", "tin", v.tin, "text", false, 'maxlength="20"')}${input("SST registration (if any)", "sst_number", v.sst_number, "text", false, 'maxlength="40"')}${input("Contact person", "contact", v.contact, "text", false, 'maxlength="120"')}${input("Email", "email", v.email, "email", false, 'maxlength="160"')}${input("Phone", "phone", v.phone, "text", false, 'maxlength="60"')}<div class="span-2">${area("Address", "address", v.address, 600)}</div>${select("Default category", "default_category", [["", "None"], ...catOptions(v.default_category)], v.default_category || "", false)}${input("Payment terms (days)", "terms", v.terms, "number", true, 'min="0" max="365" step="1"')}</div>${formEnd("Save vendor")}</form>`,
    );
  }
  function categoriesTable() {
    const lines = Object.fromEntries(B().formLines);
    return `<section class="panel"><div class="table-wrap"><table><caption class="sr-only">Expense categories</caption><thead><tr><th>Category</th><th>Form B / Form P line</th><th class="num">Tax deductible</th><th>Account code</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${B()
      .categories.map(
        (c) =>
          `<tr><td><strong>${E(c.name)}</strong></td><td>${E(lines[c.form_line] || c.form_line)}</td><td class="num">${c.deductible}%</td><td>${E(c.account_code || "—")}</td><td>${tag(c.active ? "Active" : "Inactive", c.active ? "green" : "")}</td><td>${button("Edit", "books-edit-category", c.id)}</td></tr>`,
      )
      .join("")}</tbody></table></div><p class="field-hint">The Form B / Form P line and the deductible share feed the annual tax summary, which is a working aid. Meals and entertainment are usually only 50% deductible, fines and private costs not at all, and equipment is claimed through capital allowances instead. Check with your tax agent.</p></section>`;
  }
  function categoryForm(id) {
    const c = B().categories.find((x) => x.id === id) || { form_line: "other", deductible: 100, active: 1 };
    showModal(
      id ? "Edit category" : "Add category",
      `<form data-form="books-category" data-id="${E(id || "")}">${input("Name", "name", c.name, "text", true, 'maxlength="80"')}<div class="form-grid">${select("Form B / Form P line", "form_line", B().formLines, c.form_line)}${input("Tax deductible (%)", "deductible", c.deductible, "number", true, 'min="0" max="100" step="1"')}${input("Account code (optional)", "account_code", c.account_code || "", "text", false, 'maxlength="40"')}${select("Status", "active", [["1", "Active"], ["0", "Inactive"]], c.active ? "1" : "0")}</div>${formEnd("Save category")}</form>`,
    );
  }

  // ---------- purchase lines (bills and POs) ----------
  const TAX = [0, 5, 6, 8, 10];
  const lineRow = (l = { description: "", quantity: 1, rate: 0, tax_rate: 0, category_id: "" }) =>
    `<div class="books-line"><label class="books-line-desc">Description<input class="bl-desc" maxlength="240" value="${E(l.description)}" required></label><label>Category<select class="bl-cat">${[["", "Vendor default"], ...catOptions(l.category_id)].map(([v, t]) => `<option value="${E(v)}" ${v === (l.category_id || "") ? "selected" : ""}>${E(t)}</option>`).join("")}</select></label><label>Qty<input class="bl-qty" type="number" min="0.01" max="99999.99" step="0.01" value="${E(l.quantity)}" required></label><label>Rate (MYR)<input class="bl-rate" type="number" min="0" max="99999999.99" step="0.01" value="${dec(l.rate || 0)}" required></label><label>SST<select class="bl-tax">${TAX.map((r) => `<option value="${r}" ${r === Number(l.tax_rate || 0) ? "selected" : ""}>${r ? r + "%" : "None"}</option>`).join("")}</select></label><button class="btn ghost books-line-remove" type="button" data-action="books-remove-line" aria-label="Remove line">${icon("close")}</button></div>`;
  const linesEditor = (items) =>
    `<div class="span-2"><h3 class="books-sub">Lines</h3><div class="books-lines">${(items?.length ? items : [undefined]).map((l) => lineRow(l)).join("")}</div><div class="actions">${button("Add line", "books-add-line", "", false, "plus")}<span class="books-live-total" aria-live="polite"></span></div></div>`;
  const readLines = (form) =>
    [...form.querySelectorAll(".books-line")].map((row) => ({
      description: row.querySelector(".bl-desc").value,
      category_id: row.querySelector(".bl-cat").value,
      quantity: row.querySelector(".bl-qty").value,
      rate: row.querySelector(".bl-rate").value,
      tax_rate: Number(row.querySelector(".bl-tax").value),
    }));
  function liveTotal() {
    const form = modal.querySelector("form[data-lines]");
    if (!form) return;
    let total = 0;
    for (const l of readLines(form)) {
      const amount = Math.round(Math.round(Number(l.rate || 0) * 100) * Math.round(Number(l.quantity || 0) * 100) / 100) || 0;
      total += amount + Math.round((amount * l.tax_rate) / 100);
    }
    const el = form.querySelector(".books-live-total");
    if (el) el.textContent = "Total " + money(total);
  }
  function wireLines() {
    const form = modal.querySelector("form[data-lines]");
    form?.addEventListener("input", liveTotal);
    form?.addEventListener("change", liveTotal);
    liveTotal();
  }

  // ---------- bills, purchase orders, recurring costs ----------
  function billsPage(sub) {
    const b = B();
    if (!b) return empty("Books are unavailable", "Refresh the page.");
    const t = tabs(
      [
        ["bills", "Supplier bills", "#/bills"],
        ["pos", "Purchase orders", "#/bills/pos"],
        ["recurring", "Recurring costs", "#/bills/recurring"],
      ],
      sub || "bills",
    );
    if (sub === "pos") {
      const list = b.pos;
      return (
        heading("Purchase orders", "", button("New purchase order", "books-new-po", "", true, "plus")) +
        t +
        `<section class="panel">${
          list.length
            ? `<div class="table-wrap"><table><caption class="sr-only">Purchase orders</caption><thead><tr><th>Order</th><th>Vendor</th><th>Order date</th><th>Needed by</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>${list.map((p) => `<tr><td><a href="#/po/${E(p.id)}">${E(p.number || "Draft")}</a></td><td>${E(p.vendor_name)}</td><td>${dateLabel(p.po_date)}</td><td>${dateLabel(p.expected_date)}</td><td class="num">${money(p.total)}</td><td>${statusTag(poStatus(p))}</td></tr>`).join("")}</tbody></table></div>`
            : empty("No purchase orders", "Send a numbered order to a supplier before they deliver.", button("New purchase order", "books-new-po", "", true))
        }</section>`
      );
    }
    if (sub === "recurring") {
      const list = b.recurring;
      const every = { week: "Weekly", month: "Monthly", quarter: "Quarterly", year: "Yearly" };
      return (
        heading("Recurring costs", "", button("Add recurring cost", "books-new-recurring", "", true, "plus")) +
        t +
        `<section class="panel">${
          list.length
            ? `<div class="table-wrap"><table><caption class="sr-only">Recurring costs</caption><thead><tr><th>Cost</th><th>Repeats</th><th>Next</th><th class="num">Amount</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${list.map((r) => `<tr><td><strong>${E(r.name)}</strong><small>${E(catName(r.category_id))}</small></td><td>${every[r.every]}</td><td>${dateLabel(r.next_date)}</td><td class="num">${money(r.amount)}</td><td>${tag(r.active ? "Active" : "Paused", r.active ? "green" : "")}</td><td><div class="actions">${button("Edit", "books-edit-recurring", r.id)}${button("Delete", "books-delete-recurring", r.id)}</div></td></tr>`).join("")}</tbody></table></div>`
            : empty("No recurring costs", "Add rent, salaries or subscriptions so the forecast knows about them.")
        }<p class="field-hint">Recurring costs do not create expenses. Record each payment as an expense when you pay it.</p></section>`
      );
    }
    const list = b.bills;
    const open = list.filter((x) => x.state === "open" && x.balance > 0);
    return (
      heading("Supplier bills", "", button("New bill", "books-new-bill", "", true, "plus")) +
      t +
      `<div class="books-tiles books-tiles-3"><div class="metric"><div class="label">Unpaid bills</div><div class="value">${money(open.reduce((s, x) => s + x.balance, 0))}</div><div class="hint">${open.length} open</div></div><div class="metric"><div class="label">Overdue</div><div class="value red-text">${money(open.filter((x) => x.due_date < T()).reduce((s, x) => s + x.balance, 0))}</div><div class="hint">Past their due date</div></div><div class="metric"><div class="label">Due in 30 days</div><div class="value">${money(open.filter((x) => x.due_date >= T() && x.due_date <= addDays(T(), 30)).reduce((s, x) => s + x.balance, 0))}</div><div class="hint">Included in the cash flow forecast</div></div></div><section class="panel">${
        list.length
          ? `<div class="table-wrap"><table><caption class="sr-only">Supplier bills</caption><thead><tr><th>Bill</th><th>Vendor</th><th>Bill date</th><th>Due</th><th class="num">Total</th><th class="num">Balance</th><th>Status</th></tr></thead><tbody>${list.map((x) => `<tr><td><a href="#/bill/${E(x.id)}">${E(x.number)}</a><small>${E(x.reference)}</small></td><td>${E(x.vendor_name)}</td><td>${dateLabel(x.bill_date)}</td><td>${dateLabel(x.due_date)}</td><td class="num">${money(x.total)}</td><td class="num">${x.state === "void" ? "—" : money(x.balance)}</td><td>${statusTag(x.status)}</td></tr>`).join("")}</tbody></table></div>`
          : empty("No supplier bills", "Record a supplier's invoice to track what you owe.", button("New bill", "books-new-bill", "", true))
      }<p class="field-hint">Paying a bill records an expense linked to it, so the cost is counted once in reports.</p></section>`
    );
  }
  const poStatus = (p) => ({ draft: "Draft", issued: "Issued", received: "Received", billed: "Billed", cancelled: "Cancelled" })[p.state];
  function billForm(id, prefill = null) {
    const x = B().bills.find((b) => b.id === id) || prefill || {};
    showModal(
      id ? "Edit bill" : "New supplier bill",
      `<form data-form="books-bill" data-id="${E(id || "")}" data-lines="1"><div class="form-grid">${select("Vendor", "vendor_id", vendorOptions(x.vendor_id, "Select a vendor"), x.vendor_id || "")}${input("Supplier's invoice number", "reference", x.reference || "", "text", false, 'maxlength="120"')}${input("Bill date", "bill_date", x.bill_date || T(), "date", true, `max="${T()}"`)}${input("Due date (blank: vendor's terms)", "due_date", x.due_date || "", "date", false)}${linesEditor(x.items)}<div class="span-2">${area("Notes", "notes", x.notes || "", 2000)}</div></div>${B().vendors.length ? "" : '<p class="field-hint">Add the vendor first under Expenses > Vendors.</p>'}${formEnd("Save bill")}</form>`,
      true,
    );
    wireLines();
  }
  function billPage(id) {
    const x = B()?.bills.find((b) => b.id === id);
    if (!x) return empty("Bill not found", "It may have been removed.");
    const actions =
      (x.state === "open" && x.balance > 0 ? button("Record payment", "books-pay-bill", x.id, true, "plus") : "") +
      (x.state === "open" && !x.paid ? button("Edit", "books-edit-bill", x.id) + button("Void", "books-void-bill", x.id) : "") +
      link("All bills", "#/bills");
    const po = x.po_id ? B().pos.find((p) => p.id === x.po_id) : null;
    return (
      heading(`${x.number}${x.reference ? " · " + x.reference : ""}`, x.vendor_name, actions) +
      `<div class="doc-grid"><section class="panel"><div class="panel-head"><div><h2>Supplier bill</h2><p>Bill date ${dateLabel(x.bill_date)} · due ${dateLabel(x.due_date)}</p></div>${statusTag(x.status)}</div><div class="table-wrap"><table><caption class="sr-only">Bill lines</caption><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">SST</th><th class="num">Amount</th></tr></thead><tbody>${x.items.map((l) => `<tr><td>${E(l.description)}<small>${E(catName(l.category_id))}</small></td><td class="num">${l.quantity}</td><td class="num">${money(l.rate)}</td><td class="num">${l.tax ? money(l.tax) : "—"}</td><td class="num">${money(l.amount)}</td></tr>`).join("")}</tbody></table></div><div class="totals"><div class="total-row"><span>Subtotal</span><strong>${money(x.subtotal)}</strong></div>${x.tax ? `<div class="total-row"><span>SST / tax</span><strong>${money(x.tax)}</strong></div>` : ""}<div class="total-row emphasis"><span>Total</span><span>${money(x.total)}</span></div><div class="total-row"><span>Paid</span><strong>${money(x.paid)}</strong></div><div class="total-row emphasis"><span>Balance</span><span>${money(x.balance)}</span></div></div>${x.notes ? `<div class="paper-notes"><h3>Notes</h3><p>${E(x.notes)}</p></div>` : ""}${x.state === "void" ? `<div class="notice warn mt22"><p>Void: ${E(x.void_reason || "")}</p></div>` : ""}</section><div class="stack"><section class="panel"><div class="panel-head"><h2>Payments</h2></div>${x.payments.length ? x.payments.map((p) => `<div class="payment"><div class="payment-top"><strong>${money(p.amount)}</strong>${tag("Paid", "green")}</div><p>${dateLabel(p.paid_date)} · ${E(p.payment_method)}${p.reference ? "<br>Reference: " + E(p.reference) : ""}</p><button class="link-button" data-action="books-edit-expense" data-id="${E(p.id)}">Open expense</button></div>`).join("") : "<p>No payments yet.</p>"}</section><section class="panel"><div class="panel-head"><h2>Vendor</h2></div><p class="books-pre">${E([x.vendor.name, x.vendor.registration && "Reg " + x.vendor.registration, x.vendor.tin && "TIN " + x.vendor.tin, x.vendor.address].filter(Boolean).join("\n"))}</p>${po ? `<p class="mt22">From purchase order <a href="#/po/${E(po.id)}">${E(po.number)}</a></p>` : ""}</section><section class="panel"><div class="panel-head"><h2>Attachments</h2></div>${placeholder("bill-files", x.id)}<form data-form="books-bill-file" data-id="${E(x.id)}" class="mt22"><label>Add the supplier's invoice (photo or PDF)<input type="file" class="books-file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" required></label>${h.errorBlock()}<button class="btn" type="submit">Upload</button></form></section></div></div>`
    );
  }
  loaders["bill-files"] = async (id) => {
    const list = await h.api("/files?" + qs({ entity_type: "books_bill", entity_id: id }));
    return list.length
      ? `<ul class="books-files">${list.map((x) => `<li><a href="/api/files/${E(x.id)}${x.mime === "application/pdf" ? "?inline=1" : ""}" target="_blank" rel="noopener">${E(x.name)}</a> <small>${Math.ceil(x.size / 1024)} KB</small> <button class="link-button red-text" type="button" data-action="books-delete-file" data-id="${E(x.id)}">Remove</button></li>`).join("")}</ul>`
      : '<p class="field-hint">No files attached.</p>';
  };
  function payBillModal(id) {
    const x = B().bills.find((b) => b.id === id);
    showModal(
      "Record bill payment",
      `<form data-form="books-pay-bill" data-id="${E(id)}"><div class="notice info"><p>${E(x.number)} · ${E(x.vendor_name)}<br>Remaining: <strong>${money(x.balance)}</strong></p></div><div class="form-grid">${input("Amount paid (MYR)", "amount", dec(x.balance), "number", true, `min="0.01" max="${dec(x.balance)}" step="0.01"`)}${input("Paid on", "paid_date", T(), "date", true, `max="${T()}"`)}${select("Paid by", "payment_method", methodOptions(), "Bank transfer")}${input("Bank reference", "reference", "", "text", false, 'maxlength="120"')}</div>${area("Notes", "notes", "", 1000)}<p class="field-hint">The payment is recorded as an expense linked to this bill.</p>${formEnd("Record payment")}</form>`,
    );
  }
  function poForm(id) {
    const p = B().pos.find((x) => x.id === id) || { terms: B().settings.poTerms };
    showModal(
      id ? "Edit purchase order" : "New purchase order",
      `<form data-form="books-po" data-id="${E(id || "")}" data-lines="1"><div class="form-grid">${select("Vendor", "vendor_id", vendorOptions(p.vendor_id, "Select a vendor"), p.vendor_id || "")}${input("Order date", "po_date", p.po_date || T(), "date", true)}${input("Needed by (optional)", "expected_date", p.expected_date || "", "date", false)}<div></div>${linesEditor(p.items)}<div class="span-2">${area("Terms shown on the order", "terms", p.terms || "", 1000)}</div><div class="span-2">${area("Notes", "notes", p.notes || "", 2000)}</div></div><p class="field-hint">The order gets its number (${E(B().settings.poPrefix)}-YYYY-00001) when you issue it.</p>${formEnd("Save draft")}</form>`,
      true,
    );
    wireLines();
  }
  function poPage(id) {
    const p = B()?.pos.find((x) => x.id === id);
    if (!p) return empty("Purchase order not found", "It may have been removed.");
    const a = [];
    if (p.state === "draft") a.push(button("Edit", "books-edit-po", p.id), button("Issue order", "books-issue-po", p.id, true));
    if (["issued", "received"].includes(p.state)) {
      if (B().mail) a.push(button("Email", "books-email-po", p.id));
      if (p.state === "issued") a.push(button("Mark received", "books-receive-po", p.id));
      a.push(button("Convert to bill", "books-bill-po", p.id, true));
    }
    if (["draft", "issued", "received"].includes(p.state)) a.push(button("Cancel order", "books-cancel-po", p.id));
    if (p.bill_id) a.push(link("Open bill", `#/bill/${p.bill_id}`, "primary"));
    a.push(`<a class="btn" href="/api/books/pos/${E(p.id)}/pdf">${icon("download")} PDF</a>`);
    return (
      heading(p.number || "Draft purchase order", p.vendor_name, a.join("")) +
      `<div class="doc-grid"><section class="panel"><div class="panel-head"><div><h2>Purchase order</h2><p>Ordered ${dateLabel(p.po_date)}${p.expected_date ? " · needed by " + dateLabel(p.expected_date) : ""}</p></div>${statusTag(poStatus(p))}</div><div class="table-wrap"><table><caption class="sr-only">Order lines</caption><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">SST</th><th class="num">Amount</th></tr></thead><tbody>${p.items.map((l) => `<tr><td>${E(l.description)}<small>${E(catName(l.category_id))}</small></td><td class="num">${l.quantity}</td><td class="num">${money(l.rate)}</td><td class="num">${l.tax ? money(l.tax) : "—"}</td><td class="num">${money(l.amount)}</td></tr>`).join("")}</tbody></table></div><div class="totals"><div class="total-row"><span>Subtotal</span><strong>${money(p.subtotal)}</strong></div>${p.tax ? `<div class="total-row"><span>SST</span><strong>${money(p.tax)}</strong></div>` : ""}<div class="total-row emphasis"><span>Total</span><span>${money(p.total)}</span></div></div>${p.terms ? `<div class="paper-notes"><h3>Terms</h3><p>${E(p.terms)}</p></div>` : ""}${p.notes ? `<div class="paper-notes"><h3>Notes</h3><p>${E(p.notes)}</p></div>` : ""}${p.state === "cancelled" ? `<div class="notice warn mt22"><p>Cancelled: ${E(p.cancel_reason || "")}</p></div>` : ""}</section><div class="stack"><section class="panel"><div class="panel-head"><h2>Vendor</h2></div><p class="books-pre">${E([p.vendor.name, p.vendor.contact && "Attn: " + p.vendor.contact, p.vendor.email, p.vendor.address].filter(Boolean).join("\n"))}</p></section><section class="panel"><div class="panel-head"><h2>Emails</h2></div>${p.emails?.length ? p.emails.map((m) => `<div class="payment"><div class="payment-top"><strong>${E(m.subject)}</strong>${tag(m.status === "sent" ? "Sent" : m.status === "failed" ? "Failed" : "Sending", m.status === "sent" ? "green" : m.status === "failed" ? "red" : "blue")}</div><p>${E(m.recipients)}<br>${h.timeLabel(m.created)}</p></div>`).join("") : `<p>${B().mail ? "Not emailed yet." : "Email is not configured on the server. Download the PDF and send it yourself."}</p>`}</section></div></div>`
    );
  }
  function poEmailModal(id) {
    const p = B().pos.find((x) => x.id === id);
    showModal(
      "Email purchase order",
      `<form data-form="books-po-email" data-id="${E(id)}" data-key="${E(crypto.randomUUID())}">${input("To", "to", p.vendor.email || "", "text", true, 'maxlength="600"')}${input("Cc (optional)", "cc", "", "text", false, 'maxlength="600"')}${input("Subject", "subject", `Purchase order ${p.number} from ${S().settings.company}`, "text", true, 'maxlength="200"')}${area("Message (optional)", "message", "", 4000)}<p class="field-hint">The PDF is attached. Separate addresses with commas.</p>${formEnd("Send email")}</form>`,
    );
  }
  function poBillModal(id) {
    const p = B().pos.find((x) => x.id === id);
    const v = B().vendors.find((x) => x.id === p.vendor_id);
    showModal(
      "Convert to supplier bill",
      `<form data-form="books-po-bill" data-id="${E(id)}"><p>The bill copies the order's lines (${money(p.total)}). Change them on the bill if the supplier invoiced differently.</p><div class="form-grid">${input("Supplier's invoice number", "reference", "", "text", false, 'maxlength="120"')}${input("Bill date", "bill_date", T(), "date", true, `max="${T()}"`)}${input("Due date", "due_date", addDays(T(), v?.terms ?? 30), "date", true)}</div>${formEnd("Create bill")}</form>`,
    );
  }
  function recurringForm(id) {
    const r = B().recurring.find((x) => x.id === id) || { every: "month", next_date: T(), active: 1, category_id: "other" };
    showModal(
      id ? "Edit recurring cost" : "Add recurring cost",
      `<form data-form="books-recurring" data-id="${E(id || "")}">${input("Name", "name", r.name, "text", true, 'maxlength="160" placeholder="Office rent"')}<div class="form-grid">${input("Amount (MYR)", "amount", r.amount ? dec(r.amount) : "", "number", true, 'min="0.01" max="99999999.99" step="0.01"')}${select("Repeats", "every", [["week", "Weekly"], ["month", "Monthly"], ["quarter", "Quarterly"], ["year", "Yearly"]], r.every)}${input("Next payment", "next_date", r.next_date, "date", true)}${select("Category", "category_id", catOptions(r.category_id), r.category_id)}${select("Vendor (optional)", "vendor_id", vendorOptions(r.vendor_id || "", "None"), r.vendor_id || "", false)}${select("Status", "active", [["1", "Active"], ["0", "Paused"]], r.active ? "1" : "0")}</div>${formEnd("Save")}</form>`,
    );
  }

  // ---------- reports ----------
  const reportTabs = (active) =>
    tabs(
      [
        ["sales", "Sales", "#/reports/sales"],
        ["pnl", "Profit & loss", "#/reports/pnl"],
        ["cashflow", "Cash flow", "#/reports/cashflow"],
        ["late", "Late payers", "#/reports/late"],
        ["tax", "Tax summary", "#/reports/tax"],
        ["exports", "Exports", "#/reports/exports"],
      ],
      active,
    );
  function rangeForm() {
    const r = period();
    const presets = [
      ["month", "This month"],
      ["last-month", "Last month"],
      ["year", "This year"],
      ["last-year", "Last year"],
      ["12m", "Last 12 months"],
    ];
    return `<form data-form="books-range" class="books-range"><div class="books-range-grid">${input("From", "from", r.from, "date", true)}${input("To", "to", r.to, "date", true)}<div class="books-range-go"><button class="btn primary" type="submit">Show</button></div></div><div class="books-presets" role="group" aria-label="Quick periods">${presets.map(([k, l]) => `<button type="button" class="tab" data-action="books-range" data-id="${k}">${l}</button>`).join("")}</div></form>`;
  }
  function presetRange(k) {
    const t = T(),
      y = Number(t.slice(0, 4)),
      m = Number(t.slice(5, 7));
    const first = (yy, mm) => `${yy}-${String(mm).padStart(2, "0")}-01`;
    if (k === "month") return { from: first(y, m), to: t };
    if (k === "last-month") {
      const py = m === 1 ? y - 1 : y,
        pm = m === 1 ? 12 : m - 1;
      return { from: first(py, pm), to: addDays(first(y, m), -1) };
    }
    if (k === "year") return { from: `${y}-01-01`, to: t };
    if (k === "last-year") return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
    return { from: addDays(first(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1), -365).slice(0, 8) + "01", to: t };
  }
  function reportsPage(sub) {
    if (!B()) return empty("Books are unavailable", "Refresh the page.");
    const active = sub || "sales";
    const r = period();
    const head = heading("Reports", "");
    if (active === "sales")
      return (
        head +
        reportTabs(active) +
        `<section class="panel">${rangeForm()}</section><section class="panel mt22">${placeholder("sales", qs(r))}</section>`
      );
    if (active === "pnl")
      return (
        head +
        reportTabs(active) +
        `<section class="panel">${rangeForm()}</section><section class="panel mt22">${placeholder("pnl", qs(r))}</section>`
      );
    if (active === "cashflow") return head + reportTabs(active) + cashPanel() + `<section class="panel mt22">${placeholder("forecast")}</section>`;
    if (active === "late") return head + reportTabs(active) + lateReport();
    if (active === "tax") {
      const y = taxYear || Number(T().slice(0, 4)) - 1;
      const years = Array.from({ length: 6 }, (_, i) => Number(T().slice(0, 4)) - i);
      return (
        head +
        reportTabs(active) +
        `<section class="panel"><form data-form="books-tax-year" class="books-range"><div class="books-range-grid">${select("Year of assessment", "year", years.map((x) => [String(x), String(x)]), String(y))}<div class="books-range-go"><button class="btn primary" type="submit">Show</button></div></div></form></section><section class="panel mt22">${placeholder("tax", qs({ year: y }))}</section>`
      );
    }
    if (active === "exports") return head + reportTabs(active) + exportsPanel();
    return empty("Report not found");
  }
  loaders.sales = async (q) => {
    const r = await h.api("/books/reports/sales?" + q);
    const views = [
      ["client", "By client"],
      ["item", "By service / item"],
      ["month", "By month"],
    ];
    const list = salesView === "client" ? r.clients : salesView === "item" ? r.items : r.months;
    const max = Math.max(1, ...list.map((x) => Math.max(Math.abs(x.invoiced), Math.abs(x.collected))));
    const label = (x) => (salesView === "client" ? x.client : salesView === "item" ? x.label : monthLabel(x.month));
    const table = list.length
      ? `<div class="table-wrap"><table class="books-report"><caption class="sr-only">Sales ${views.find((v) => v[0] === salesView)[1].toLowerCase()}</caption><thead><tr><th>${salesView === "client" ? "Client" : salesView === "item" ? "Service / item" : "Month"}</th><th class="books-bar-col"><span class="sr-only">Chart</span></th><th class="num">Invoiced</th>${salesView === "item" ? "" : '<th class="num">SST</th>'}<th class="num">Collected</th></tr></thead><tbody>${list
          .map(
            (x) =>
              `<tr><td>${E(label(x))}${x.count ? `<small>${x.count} invoice${x.count === 1 ? "" : "s"}</small>` : ""}</td><td class="books-bar-col"><div class="books-bars" aria-hidden="true"><span class="books-bar inv ${x.invoiced < 0 ? "neg" : ""}" data-books-w="${pct(x.invoiced, max)}"></span><span class="books-bar col" data-books-w="${pct(x.collected, max)}"></span></div></td><td class="num">${money(x.invoiced)}</td>${salesView === "item" ? "" : `<td class="num">${money(x.sst)}</td>`}<td class="num">${money(x.collected)}</td></tr>`,
          )
          .join("")}<tr class="books-total"><td>Total</td><td></td><td class="num">${money(r.totals.invoiced)}</td>${salesView === "item" ? "" : `<td class="num">${money(r.totals.sst)}</td>`}<td class="num">${money(r.totals.collected)}</td></tr></tbody></table></div>`
      : empty("No sales in this period", "Issue invoices or choose another period.");
    return `<div class="panel-head"><div><h2>Sales ${dateLabel(r.from)} – ${dateLabel(r.to)}</h2><p>All amounts in MYR</p></div><a class="btn" href="/api/books/reports/sales.csv?${E(qs({ from: r.from, to: r.to, view: salesView }))}">${icon("download")} CSV</a></div><div class="books-tiles books-tiles-3"><div class="metric"><div class="label">Invoiced</div><div class="value">${money(r.totals.invoiced)}</div><div class="hint">Net of credit and debit notes, incl. SST</div></div><div class="metric"><div class="label">Collected</div><div class="value teal">${money(r.totals.collected)}</div><div class="hint">Received less refunds</div></div><div class="metric"><div class="label">SST charged</div><div class="value">${money(r.totals.sst)}</div><div class="hint">Included in invoiced</div></div></div><div class="tabs" role="group" aria-label="Group by">${views.map(([k, l]) => `<button type="button" class="tab ${k === salesView ? "active" : ""}" data-action="books-sales-view" data-id="${k}" aria-pressed="${k === salesView}">${l}</button>`).join("")}</div><p class="books-legend" aria-hidden="true"><span class="books-key inv"></span>Invoiced <span class="books-key col"></span>Collected</p>${table}<p class="field-hint">Invoiced: issued invoices by issue date, plus debit notes and less credit notes by note date. Collected: money received less refunds, by date. Services are grouped by SKU or catalog service when the line has one, otherwise by description. Notes and payments are shared across an invoice's lines in proportion. Other currencies are converted to MYR at each document's rate.</p>`;
  };
  const monthLabel = (m) => new Intl.DateTimeFormat("en-MY", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(m + "-01T00:00:00Z"));
  loaders.pnl = async (q) => {
    const p = await h.api("/books/reports/pnl?" + q);
    const b = p[pnlBasis];
    const ids = [...new Set([...p.accrual.categories, ...p.cash.categories].map((c) => c.id))];
    const val = (basis, id) => basis.categories.find((c) => c.id === id)?.total || 0;
    const names = Object.fromEntries([...p.accrual.categories, ...p.cash.categories].map((c) => [c.id, c.name]));
    const max = Math.max(1, ...p.months.map((_, i) => Math.max(Math.abs(b.income.byMonth[i]), Math.abs(b.expenses.byMonth[i]))));
    const tile = (label, v, hint, cls = "") => `<div class="metric"><div class="label">${label}</div><div class="value ${cls}">${money(v)}</div><div class="hint">${hint}</div></div>`;
    return `<div class="panel-head"><div><h2>Profit and loss ${dateLabel(p.from)} – ${dateLabel(p.to)}</h2><p>MYR · management report</p></div><div class="actions"><a class="btn" href="/api/books/reports/pnl.csv?${E(qs({ from: p.from, to: p.to }))}">${icon("download")} CSV</a><a class="btn" href="/api/books/reports/pnl.pdf?${E(qs({ from: p.from, to: p.to }))}">${icon("download")} PDF</a></div></div><div class="notice"><p>This is a management report from the records in this app, not audited accounts. Check it with your accountant before relying on it.</p></div><div class="books-compare mt22"><div><h3>Accrual basis</h3><p class="field-hint">Invoices when issued, costs when incurred</p><div class="books-tiles books-tiles-3">${tile("Income", p.accrual.income.total, "Net of notes, excl. SST")}${tile("Expenses", p.accrual.expenses.total, "Expenses and bills by date")}${tile("Net profit", p.accrual.net.total, "Income less expenses", p.accrual.net.total < 0 ? "red-text" : "teal")}</div></div><div><h3>Cash basis</h3><p class="field-hint">Money actually in and out</p><div class="books-tiles books-tiles-3">${tile("Money in", p.cash.income.total, "Received less refunds")}${tile("Money out", p.cash.expenses.total, "Paid expenses and bills")}${tile("Net cash", p.cash.net.total, "In less out", p.cash.net.total < 0 ? "red-text" : "teal")}</div></div></div><h3 class="books-sub mt22">By category</h3><div class="table-wrap"><table><caption class="sr-only">Profit and loss by category</caption><thead><tr><th>Line</th><th class="num">Accrual</th><th class="num">Cash</th></tr></thead><tbody><tr class="books-total"><td>Income</td><td class="num">${money(p.accrual.income.total)}</td><td class="num">${money(p.cash.income.total)}</td></tr>${ids.map((id) => `<tr><td>${E(names[id])}</td><td class="num">${money(val(p.accrual, id))}</td><td class="num">${money(val(p.cash, id))}</td></tr>`).join("")}<tr class="books-total"><td>Total expenses</td><td class="num">${money(p.accrual.expenses.total)}</td><td class="num">${money(p.cash.expenses.total)}</td></tr><tr class="books-total"><td>Net profit / (loss)</td><td class="num ${p.accrual.net.total < 0 ? "red-text" : ""}">${money(p.accrual.net.total)}</td><td class="num ${p.cash.net.total < 0 ? "red-text" : ""}">${money(p.cash.net.total)}</td></tr><tr><td>Memo: SST charged (owed to customs, not income)</td><td class="num">${money(p.accrual.sst.total)}</td><td class="num">—</td></tr></tbody></table></div><div class="panel-head mt22"><h3>By month</h3><div class="tabs books-inline-tabs" role="group" aria-label="Basis">${[["accrual", "Accrual"], ["cash", "Cash"]].map(([k, l]) => `<button type="button" class="tab ${k === pnlBasis ? "active" : ""}" data-action="books-pnl-basis" data-id="${k}" aria-pressed="${k === pnlBasis}">${l}</button>`).join("")}</div></div><p class="books-legend" aria-hidden="true"><span class="books-key inv"></span>${pnlBasis === "cash" ? "Money in" : "Income"} <span class="books-key out"></span>${pnlBasis === "cash" ? "Money out" : "Expenses"}</p><div class="table-wrap"><table class="books-report"><caption class="sr-only">Profit and loss by month, ${pnlBasis} basis</caption><thead><tr><th>Month</th><th class="books-bar-col"><span class="sr-only">Chart</span></th><th class="num">${pnlBasis === "cash" ? "In" : "Income"}</th><th class="num">${pnlBasis === "cash" ? "Out" : "Expenses"}</th><th class="num">Net</th></tr></thead><tbody>${p.months.map((m, i) => `<tr><td>${monthLabel(m)}</td><td class="books-bar-col"><div class="books-bars" aria-hidden="true"><span class="books-bar inv" data-books-w="${pct(b.income.byMonth[i], max)}"></span><span class="books-bar out" data-books-w="${pct(b.expenses.byMonth[i], max)}"></span></div></td><td class="num">${money(b.income.byMonth[i])}</td><td class="num">${money(b.expenses.byMonth[i])}</td><td class="num ${b.net.byMonth[i] < 0 ? "red-text" : ""}">${money(b.net.byMonth[i])}</td></tr>`).join("")}</tbody></table></div><p class="field-hint">Accrual: issued invoices by issue date and credit/debit notes by note date, excluding SST; expenses by expense date and supplier bills by bill date (their payments are not added again). Cash: money received less refunds; expenses and bill payments on the date paid, including SST paid. Other currencies are converted with each document's rate.</p>`;
  };
  function cashPanel() {
    const s = B().settings;
    return `<section class="panel"><div class="panel-head"><div><h2>Bank balance</h2><p>${s.cashDate ? `${money(s.cashBalance)} on ${dateLabel(s.cashDate)}. Money in and out recorded since then is added to estimate today's cash.` : "Enter your bank balance to start the forecast from real cash."}</p></div></div><form data-form="books-cash"><div class="books-range-grid">${input("Balance (MYR)", "balance", s.cashBalance === null ? "" : dec(s.cashBalance), "number", true, 'step="0.01" min="-99999999.99" max="99999999.99"')}${input("On date", "date", s.cashDate || T(), "date", true, `max="${T()}"`)}<div class="books-range-go"><button class="btn primary" type="submit">Save balance</button></div></div>${h.errorBlock()}</form></section>`;
  }
  loaders.forecast = async () => {
    const f = await h.api("/books/forecast");
    const max = Math.max(1, ...f.weeks.map((w) => Math.abs(w.closing)));
    const kinds = { invoice: "Invoice", draft: "Recurring draft", schedule: "Recurring billing", expense: "Unpaid expense", bill: "Supplier bill", po: "Purchase order", recurring: "Recurring cost" };
    const chart = `<div class="books-flow" role="img" aria-label="Closing balance for the next 13 weeks. Lowest ${E(money(f.lowest.closing))} in week ${f.lowest.week}.">${f.weeks.map((w) => `<div class="books-flow-col ${w.negative ? "neg" : ""}" aria-hidden="true"><div class="books-flow-up">${w.closing >= 0 ? `<span data-books-h="${Math.round(pct(w.closing, max) * 1.1) + 2}"></span>` : ""}</div>${f.negativeWeeks.length ? `<div class="books-flow-down">${w.closing < 0 ? `<span data-books-h="${Math.round(pct(w.closing, max) * 0.6) + 2}"></span>` : ""}</div>` : ""}<small>W${w.week}</small></div>`).join("")}</div>`;
    return `<div class="panel-head"><div><h2>Next 13 weeks</h2><p>${f.opening.known ? `Starting cash ${money(f.opening.estimated)} today (bank ${money(f.opening.balance)} on ${dateLabel(f.opening.date)}${f.opening.receipts ? ", + " + money(f.opening.receipts) + " received" : ""}${f.opening.refunds ? ", − " + money(f.opening.refunds) + " refunded" : ""}${f.opening.spent ? ", − " + money(f.opening.spent) + " spent" : ""})` : "No bank balance entered, so the forecast starts at RM 0.00."}</p></div><a class="btn" href="/api/books/forecast.csv">${icon("download")} CSV</a></div>${f.negativeWeeks.length ? `<div class="notice warn"><p>Cash is forecast to go below zero in week ${f.negativeWeeks.join(", ")}. Chase the invoices that are due or move payments.</p></div>` : `<div class="notice info"><p>Cash stays above zero for the next 13 weeks. Lowest point: ${money(f.lowest.closing)} in week ${f.lowest.week}.</p></div>`}${chart}<div class="table-wrap mt22"><table class="books-forecast"><caption class="sr-only">Weekly cash flow forecast</caption><thead><tr><th>Week</th><th class="num">Money in</th><th class="num">Money out</th><th class="num">Net</th><th class="num">Closing</th></tr></thead><tbody>${f.weeks
      .map(
        (w) =>
          `<tr class="${w.negative ? "books-neg" : ""}"><td><strong>Week ${w.week}</strong><small>${dateLabel(w.start)} – ${dateLabel(w.end)}</small>${w.items.length ? `<details><summary>${w.items.length} item${w.items.length === 1 ? "" : "s"}</summary><ul class="books-items">${w.items.map((i) => `<li><span>${E(kinds[i.kind] || i.kind)}: ${i.kind === "invoice" ? `<a href="#/document/${E(i.ref)}">${E(i.label)}</a>` : i.kind === "bill" ? `<a href="#/bill/${E(i.ref)}">${E(i.label)}</a>` : i.kind === "po" ? `<a href="#/po/${E(i.ref)}">${E(i.label)}</a>` : E(i.label)}${i.note ? ` <small>${E(i.note)}</small>` : ""}</span><span class="num ${i.amount < 0 ? "red-text" : "teal"}">${money(i.amount)}</span></li>`).join("")}</ul></details>` : ""}</td><td class="num">${money(w.inflow)}</td><td class="num">${money(w.outflow)}</td><td class="num">${money(w.net)}</td><td class="num ${w.negative ? "red-text" : ""}"><strong>${money(w.closing)}</strong>${w.negative ? '<small class="red-text">Below zero</small>' : ""}</td></tr>`,
      )
      .join("")}</tbody></table></div><p class="field-hint">Money in: open invoice balances on the date each client is expected to pay (due date adjusted by the client's usual lateness, see Late payers), drafts from recurring schedules, and upcoming recurring billing. Money out: unpaid expenses and supplier bills by due date (overdue ones in week 1), purchase orders not yet billed, and <a href="#/bills/recurring">recurring costs</a>. It is an estimate, not a promise.</p>`;
  };
  function lateReport() {
    const b = B();
    const S0 = S();
    const clients = Object.values(b.lateness.clients)
      .map((c) => ({ ...c, name: S0.clients.find((x) => x.id === c.client_id)?.name || "Client" }))
      .sort((a, z) => ({ high: 0, medium: 1, low: 2 })[a.risk] - ({ high: 0, medium: 1, low: 2 })[z.risk] || z.avgDaysLate - a.avgDaysLate);
    const open = Object.values(b.lateness.invoices).sort((a, z) => a.predicted.localeCompare(z.predicted));
    return `<section class="panel"><div class="panel-head"><div><h2>How clients pay</h2><p>From the dates invoices were fully paid compared with their due dates</p></div></div>${
      clients.length
        ? `<div class="table-wrap"><table><caption class="sr-only">Payment behaviour by client</caption><thead><tr><th>Client</th><th class="num">Paid invoices</th><th class="num">Average days late</th><th class="num">Paid late</th><th>Trend</th><th>Risk</th><th>Reminder advice</th></tr></thead><tbody>${clients.map((c) => `<tr><td><a href="#/client/${E(c.client_id)}">${E(c.name)}</a></td><td class="num">${c.count}</td><td class="num">${c.count ? c.avgDaysLate : "—"}</td><td class="num">${c.count ? c.shareLate + "%" : "—"}</td><td>${E(c.trend)}</td><td>${riskTag(c.count || c.maxOverdue ? c.risk : "")}</td><td class="books-wrap">${E(c.advice.text)}</td></tr>`).join("")}</tbody></table></div>`
        : empty("No issued invoices yet", "Payment behaviour appears once clients start paying.")
    }</section><section class="panel mt22"><div class="panel-head"><div><h2>Open invoices: expected payment</h2><p>Predicted from each client's history</p></div></div>${
      open.length
        ? `<div class="table-wrap"><table><caption class="sr-only">Predicted payment dates</caption><thead><tr><th>Invoice</th><th>Due</th><th>Expected</th><th class="num">Balance</th><th>Risk</th><th>Next step</th></tr></thead><tbody>${open.map((i) => `<tr><td><a href="#/document/${E(i.id)}">${E(i.number)}</a><small>${E(i.client)}</small></td><td>${dateLabel(i.due_date)}${i.overdue ? `<small class="red-text">${i.overdue} days overdue</small>` : ""}</td><td>${dateLabel(i.predicted)}${i.laterThanUsual ? '<small class="red-text">Later than usual</small>' : ""}</td><td class="num">${money(i.balanceMyr)}</td><td>${riskTag(i.risk)}</td><td class="books-wrap">${E(i.remindNow || "Remind on " + dateLabel(i.remindOn))}</td></tr>`).join("")}</tbody></table></div>`
        : '<p class="field-hint">No open invoices.</p>'
    }</section>${methodNote()}`;
  }
  const methodNote = () =>
    `<section class="panel mt22"><details><summary><strong>How the prediction works</strong></summary><div class="books-method"><p>For each client we look at up to the last 12 invoices that were paid in full. For each one we count the days between the due date and the day the last payment brought it to zero. Early payments count as negative days.</p><p><strong>Average days late</strong> treats early payments as on time. <strong>Paid late</strong> is the share of those invoices paid after the due date. The <strong>trend</strong> compares the newer half of the history with the older half (3 days or more is a change).</p><p>The <strong>expected date</strong> of an open invoice is its due date plus the client's average delay (early payments included). A client with no history uses the average of all clients once there are 3 paid invoices, otherwise the due date. If an invoice is already later than that, we expect it within a week and mark it high risk.</p><p><strong>Risk</strong> is high when at least half of 2 or more invoices were paid 15+ days late on average, or an invoice is over 30 days overdue; medium when a quarter or more were late, the average is over 3 days, an invoice is overdue or payments are getting later; otherwise low. Advice: high risk, remind 7 days before the due date; medium, 3 days before; low, on the due date. ${S().settings.remindersEnabled ? `Your automatic reminders go out ${E(S().settings.reminderBeforeDays ?? 3)} days before the due date for every client.` : "Automatic email reminders are off; turn them on in Settings."}</p></div></details></section>`;
  loaders.tax = async (q) => {
    const t = await h.api("/books/reports/tax?" + q);
    const row = (label, v, cls = "") => `<tr class="${cls}"><td>${E(label)}</td><td class="num">${money(v)}</td></tr>`;
    return `<div class="panel-head"><div><h2>Income tax summary · year of assessment ${t.year}</h2><p>1 Jan – 31 Dec ${t.year}, MYR</p></div><div class="actions"><a class="btn" href="/api/books/reports/tax.csv?year=${t.year}">${icon("download")} CSV</a><a class="btn" href="/api/books/reports/tax.pdf?year=${t.year}">${icon("download")} PDF</a></div></div><div class="notice"><p><strong>Working aid only.</strong> This is not a tax computation or a filed return. Check every figure with your tax agent before you complete Form B (sole proprietor) or Form P (partnership).</p></div><div class="table-wrap mt22"><table><caption class="sr-only">Income tax summary</caption><thead><tr><th>Form B / Form P line</th><th class="num">MYR</th></tr></thead><tbody>${row("Sales / turnover (issued invoices net of notes, excl. SST)", t.income, "books-total")}${row("Purchases and cost of production (cost of sales)", t.costOfSales)}${t.costLines.map((c) => row("    " + c.name, c.total, "books-sub-row")).join("")}${row("Gross profit", t.grossProfit, "books-total")}${t.lines.map((l) => row(l.label, l.total) + l.categories.map((c) => row("    " + c.name, c.total, "books-sub-row")).join("")).join("")}${row("Total expenses", t.expenses, "books-total")}${row("Net profit / (loss) per accounts", t.netProfit, "books-total")}</tbody></table></div><h3 class="books-sub mt22">Tax adjustments</h3><div class="table-wrap"><table><caption class="sr-only">Expenses added back</caption><thead><tr><th>Not (fully) deductible</th><th class="num">Deductible</th><th class="num">Added back</th></tr></thead><tbody>${t.adjustments.map((a) => `<tr><td>${E(a.name)}</td><td class="num">${a.deductible}%</td><td class="num">${money(a.amount)}</td></tr>`).join("") || '<tr><td colspan="3">No adjustments.</td></tr>'}<tr class="books-total"><td>Adjusted net profit (before capital allowances)</td><td></td><td class="num">${money(t.adjustedProfit)}</td></tr></tbody></table></div><p class="field-hint">Accrual basis: invoices by issue date, expenses and supplier bills by their date. SST charged (${money(t.sst)}) is excluded from income. Capital allowances, approved donations, reliefs and other income are not included. Change how a category maps or how much of it is deductible under <a href="#/expenses/categories">Expenses › Categories</a>.</p>`;
  };
  function exportsPanel() {
    const b = B();
    const r = period();
    const certainty = { template: ["Template layout", "green"], mapping: ["Map columns on import", "blue"], closest: ["Closest documented format", "orange"] };
    const s = b.settings;
    const rates = [0, 5, 6, 8, 10];
    return `<section class="panel">${rangeForm()}<p class="field-hint">Exports include issued invoices dated in this period. Payments, credit and debit notes are not included; record them in your accounting software.</p></section><div class="books-export-grid mt22">${Object.entries(b.exports)
      .map(
        ([k, t]) =>
          `<section class="panel"><div class="panel-head"><h2>${E(t.label)}</h2>${tag(...certainty[t.certainty])}</div><p class="field-hint">${E(t.note)}</p><div class="actions mt22">${Object.entries(t.datasets)
            .map(([d, l]) => `<a class="btn" href="/api/books/exports/${k}/${d}.csv?${E(qs(r))}">${icon("download")} ${E(l)}</a>`)
            .join("")}</div></section>`,
      )
      .join("")}</div><section class="panel mt22"><div class="panel-head"><div><h2>Account and tax codes</h2><p>Match these to the codes set up in your accounting software</p></div></div><form data-form="books-export-settings"><div class="form-grid">${select("Date format (Xero, QuickBooks, Bukku)", "exportDateFormat", [["DD/MM/YYYY", "DD/MM/YYYY"], ["YYYY-MM-DD", "YYYY-MM-DD"], ["MM/DD/YYYY", "MM/DD/YYYY"]], s.exportDateFormat)}<p class="field-hint">SQL Account and AutoCount always use DD/MM/YYYY.</p></div><div class="table-wrap"><table class="books-codes"><caption class="sr-only">Account and tax codes per package</caption><thead><tr><th>Package</th><th>Sales account</th>${rates.map((x) => `<th>${x ? "SST " + x + "%" : "No SST"}</th>`).join("")}</tr></thead><tbody>${Object.entries(b.exports)
      .map(
        ([k, t]) =>
          `<tr><td>${E(t.label)}</td><td><input aria-label="${E(t.label)} sales account" name="account.${k}" value="${E(s.accounts[k] || "")}" maxlength="40"></td>${rates.map((x) => `<td><input aria-label="${E(t.label)} tax code for ${x ? x + "% SST" : "no SST"}" name="tax.${k}.${x}" value="${E(s.taxCodes[k]?.[x] ?? "")}" maxlength="40"></td>`).join("")}</tr>`,
      )
      .join("")}</tbody></table></div><p class="field-hint">Defaults follow each vendor's published SST code lists (e.g. Bukku SV8, AutoCount SV-6, SQL Account SV). Customer codes for SQL Account and AutoCount come from each client's accounting code; clients without one get 300-A0001 style codes the first time they are exported.</p>${h.errorBlock()}<div class="form-actions"><button class="btn primary" type="submit">Save codes</button></div></form></section>`;
  }

  // ---------- slots ----------
  function healthPanel() {
    const b = B();
    if (!b) return "";
    const x = b.health;
    const tile = (label, value, hint, cls = "") => `<div class="metric"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="hint">${hint}</div></div>`;
    const runway =
      x.runwayDays === null
        ? x.cash === null
          ? "—"
          : "No spending"
        : x.runwayDays >= 365
          ? "12+ months"
          : x.runwayDays >= 60
            ? `${x.runwayMonths} months`
            : `${x.runwayDays} days`;
    return `<section class="panel mt22 books-health"><div class="panel-head"><div><h2>Cash health</h2><p>${x.cash === null ? "Enter your bank balance to see how long your cash lasts." : `From your bank balance on ${dateLabel(x.cashDate)}, plus money in and out since.`}</p></div><a href="#/reports/cashflow">Cash flow forecast →</a></div><div class="books-tiles books-tiles-5">${tile("Cash on hand", x.cash === null ? "Not entered" : money(x.cash), "Estimated today", x.cash !== null && x.cash < 0 ? "red-text" : "")}${tile("Monthly spending", money(x.monthlySpend), "Average, last 3 months")}${tile("Runway", runway, x.runwayDays === null ? (x.cash === null ? "Needs a bank balance" : "Nothing spent in 90 days") : `${x.runwayDays} days at that rate`, x.runwayDays !== null && x.runwayDays < 60 ? "red-text" : "teal")}${tile("Due in 30 days", money(x.dueSoon), `${x.dueSoonCount} invoice${x.dueSoonCount === 1 ? "" : "s"} from clients`)}${tile("Overdue", money(x.overdue), `${x.overdueCount} invoice${x.overdueCount === 1 ? "" : "s"} past due`, x.overdue ? "red-text" : "")}</div>${
      x.cash === null
        ? `<form data-form="books-cash" class="books-inline-cash"><div class="books-range-grid">${input("Bank balance (MYR)", "balance", "", "number", true, 'step="0.01" min="-99999999.99" max="99999999.99"')}${input("On date", "date", T(), "date", true, `max="${T()}"`)}<div class="books-range-go"><button class="btn primary" type="submit">Save balance</button></div></div>${h.errorBlock()}</form>`
        : ""
    }${x.negativeWeeks?.length ? `<div class="notice warn mt22"><p>Cash is forecast to go below zero in week ${x.negativeWeeks.join(", ")} of the next 13. <a href="#/reports/cashflow">See the forecast</a>.</p></div>` : ""}<h3 class="books-sub mt22">Most critical invoices</h3>${
      x.critical.length
        ? x.critical
            .map(
              (i) =>
                `<div class="attention"><div><strong>${E(i.number)}</strong><small>${E(i.client)} · ${money(i.balance)} · ${i.overdue} day${i.overdue === 1 ? "" : "s"} overdue · expected ${dateLabel(i.predicted)}</small><button class="link-button" data-action="open-document" data-id="${E(i.id)}">Open →</button></div>${riskTag(i.risk)}</div>`,
            )
            .join("")
        : '<p class="field-hint">No overdue invoices.</p>'
    }<p class="field-hint">Critical = overdue amount weighted by the client's payment risk.</p></section>`;
  }
  function clientPanel(c) {
    const b = B();
    const l = b?.lateness.clients[c.id];
    if (!l) return "";
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Payment behaviour</h2><p>From ${l.count} fully paid invoice${l.count === 1 ? "" : "s"}</p></div>${riskTag(l.count || l.maxOverdue ? l.risk : "")}</div>${
      l.count
        ? `<div class="books-tiles books-tiles-3"><div class="metric"><div class="label">Average days late</div><div class="value">${l.avgDaysLate}</div><div class="hint">Early payments count as on time</div></div><div class="metric"><div class="label">Paid late</div><div class="value">${l.shareLate}%</div><div class="hint">${l.lateCount} of ${l.count} invoices</div></div><div class="metric"><div class="label">Trend</div><div class="value books-trend">${l.trend === "not enough history" ? "—" : E(l.trend)}</div><div class="hint">${l.trend === "not enough history" ? "Needs 4 paid invoices" : "Newer vs older invoices"}</div></div></div>`
        : ""
    }<ul class="books-reasons">${l.reasons.map((r) => `<li>${E(r)}</li>`).join("")}</ul><div class="notice info mt22"><p><strong>Reminder advice:</strong> ${E(l.advice.text)}</p></div>${
      l.history.length
        ? `<details class="mt22"><summary>Payment history</summary><div class="table-wrap"><table><caption class="sr-only">Paid invoices</caption><thead><tr><th>Invoice</th><th>Due</th><th>Paid in full</th><th class="num">Days</th></tr></thead><tbody>${l.history
            .slice()
            .reverse()
            .map((x) => `<tr><td>${E(x.number)}</td><td>${dateLabel(x.due_date)}</td><td>${dateLabel(x.settled)}</td><td class="num ${x.days > 0 ? "red-text" : ""}">${x.days > 0 ? "+" + x.days : x.days}</td></tr>`)
            .join("")}</tbody></table></div></details>`
        : ""
    }<p class="field-hint"><a href="#/reports/late">How this is worked out</a></p></section>`;
  }
  function documentPanel(d) {
    const p = B()?.lateness.invoices[d.id];
    if (!p || d.kind !== "invoice") return "";
    return `<section class="panel"><div class="panel-head"><h2>Payment forecast</h2>${riskTag(p.risk)}</div><div class="total-row"><span>Expected payment</span><strong>${dateLabel(p.predicted)}</strong></div><div class="total-row"><span>Usual delay</span><strong>${p.basis === "none" ? "No history" : (p.delay > 0 ? p.delay + " days late" : p.delay < 0 ? -p.delay + " days early" : "On time") + (p.basis === "workspace" ? " (all clients)" : "")}</strong></div>${p.laterThanUsual ? '<p class="red-text">Already later than this client usually pays.</p>' : ""}<div class="notice info mt22"><p>${E(p.remindNow || `Remind on ${dateLabel(p.remindOn)}.`)} ${E(p.advice)}</p></div><details class="mt22"><summary>Why</summary><ul class="books-reasons">${p.reasons.map((r) => `<li>${E(r)}</li>`).join("")}</ul><p class="field-hint"><a href="#/reports/late">How this is worked out</a></p></details></section>`;
  }
  function settingsPanel() {
    const b = B();
    if (!b) return "";
    const s = b.settings;
    return `<section class="panel mt22"><div class="panel-head"><div><h2>Books</h2><p>Purchase orders, receipt scanning and reports</p></div>${tag(b.ai.configured ? "Receipt scanning on" : "Receipt scanning off", b.ai.configured ? "green" : "")}</div><form data-form="books-settings"><div class="form-grid">${input("Purchase order prefix", "poPrefix", s.poPrefix, "text", true, 'maxlength="12" autocapitalize="characters"')}<p class="field-hint">Orders are numbered ${E(s.poPrefix)}-YYYY-00001 when issued.</p><div class="span-2">${area("Default purchase order terms", "poTerms", s.poTerms, 1000)}</div></div><p class="field-hint">${b.ai.configured ? `Receipts are read by ${E(b.ai.model)} at ${E(b.ai.origin)}, only when you press Read with AI. Change the model with the Receipt scanning model key below.` : "Receipt scanning uses your own AI model: set AI_BASE_URL and AI_MODEL on the server (a model that can read images). Without it you type the details next to the image."}</p>${h.errorBlock()}<div class="form-actions"><button class="btn primary" type="submit">Save books settings</button></div></form></section>`;
  }

  // ---------- actions ----------
  async function action(type, id, el) {
    if (!type.startsWith("books-")) return false;
    const b = B();
    switch (type) {
      case "books-new-expense":
        expenseForm();
        return true;
      case "books-edit-expense":
        expenseForm(await h.api("/books/expenses/" + id));
        return true;
      case "books-scan":
        scanModal();
        return true;
      case "books-scan-read": {
        el.textContent = "Reading…";
        try {
          const scan = await h.api(`/books/scans/${id}/read`, "POST", { consent: true });
          fillDraft(scan.draft);
          toast("Receipt read. Check the details before saving.");
        } catch (e) {
          const w = modal.querySelector(".books-warnings");
          if (w) w.innerHTML = `<div class="notice error mt22"><p>${E(e.message)}</p></div>`;
          else throw e;
        } finally {
          if (el.isConnected) el.textContent = "Read again";
        }
        return true;
      }
      case "books-exp-page":
        filters().offset = Math.max(0, Number(id) || 0);
        h.renderRoute();
        window.scrollTo(0, 0);
        return true;
      case "books-exp-clear":
        expFilter = null;
        h.renderRoute();
        return true;
      case "books-pay-expense":
        payExpenseModal(id, await h.api("/books/expenses/" + id));
        return true;
      case "books-delete-expense":
        modal.close();
        h.reasonForm("Delete expense", "books-delete-expense", id);
        return true;
      case "books-delete-file":
        await h.api("/files/" + id, "DELETE");
        el.closest("li")?.remove();
        toast("File removed.");
        return true;
      case "books-new-vendor":
        vendorForm();
        return true;
      case "books-edit-vendor":
        vendorForm(id);
        return true;
      case "books-archive-vendor":
      case "books-restore-vendor":
        await h.api(`/books/vendors/${id}/${type === "books-archive-vendor" ? "archive" : "restore"}`, "POST", {});
        await reload(type === "books-archive-vendor" ? "Vendor archived." : "Vendor restored.");
        return true;
      case "books-delete-vendor":
        h.confirmModal("Delete vendor?", "Only vendors with no expenses, bills, orders or recurring costs can be deleted; archive a vendor with history instead. You can restore it from Recently deleted for 30 days.", "books-confirm-delete-vendor", id, "Delete vendor");
        return true;
      case "books-confirm-delete-vendor":
        try {
          await h.api("/books/vendors/" + id, "DELETE");
        } catch (e) {
          modal.querySelector(".form-error").textContent = e.message;
          return true;
        }
        await reload("Vendor deleted.");
        return true;
      case "books-new-category":
        categoryForm();
        return true;
      case "books-edit-category":
        categoryForm(id);
        return true;
      case "books-add-line":
        modal.querySelector(".books-lines")?.insertAdjacentHTML("beforeend", lineRow());
        liveTotal();
        return true;
      case "books-remove-line":
        if (modal.querySelectorAll(".books-line").length > 1) el.closest(".books-line").remove();
        else toast("Keep at least one line.");
        liveTotal();
        return true;
      case "books-new-bill":
        if (!b.vendors.some((v) => !v.archived)) {
          toast("Add the vendor first.");
          vendorForm();
          return true;
        }
        billForm();
        return true;
      case "books-edit-bill":
        billForm(id);
        return true;
      case "books-pay-bill":
        payBillModal(id);
        return true;
      case "books-void-bill":
        h.reasonForm("Void bill", "books-void-bill", id);
        return true;
      case "books-new-po":
        if (!b.vendors.some((v) => !v.archived)) {
          toast("Add the vendor first.");
          vendorForm();
          return true;
        }
        poForm();
        return true;
      case "books-edit-po":
        poForm(id);
        return true;
      case "books-issue-po":
        h.confirmModal("Issue this purchase order?", "Issuing gives the order its number and locks it. It does not send anything.", "books-confirm-issue-po", id, "Issue order");
        return true;
      case "books-confirm-issue-po":
        await send(`/books/pos/${id}/issue`, "POST", {});
        await reload("Purchase order issued.");
        return true;
      case "books-receive-po":
        await h.api(`/books/pos/${id}/receive`, "POST", {});
        await reload("Marked as received.");
        return true;
      case "books-cancel-po":
        h.reasonForm("Cancel purchase order", "books-cancel-po", id);
        return true;
      case "books-bill-po":
        poBillModal(id);
        return true;
      case "books-email-po":
        poEmailModal(id);
        return true;
      case "books-new-recurring":
        recurringForm();
        return true;
      case "books-edit-recurring":
        recurringForm(id);
        return true;
      case "books-delete-recurring":
        h.confirmModal("Delete recurring cost?", "It is removed from the forecast. Expenses you already recorded stay. You can restore it from Recently deleted for 30 days.", "books-confirm-delete-recurring", id, "Delete");
        return true;
      case "books-confirm-delete-recurring":
        await h.api("/books/recurring/" + id, "DELETE");
        await reload("Recurring cost deleted.");
        return true;
      case "books-range":
        range = presetRange(id);
        h.renderRoute();
        return true;
      case "books-sales-view":
        salesView = id;
        h.renderRoute();
        return true;
      case "books-pnl-basis":
        pnlBasis = id;
        h.renderRoute();
        return true;
    }
    return false;
  }

  // ---------- forms ----------
  async function submit(form, b) {
    const type = form.dataset.form;
    if (!type?.startsWith("books-")) return false;
    const id = form.dataset.id;
    switch (type) {
      case "books-exp-filter":
        expFilter = { from: b.from, to: b.to, category: b.category, vendor: b.vendor, status: b.status, q: b.q.trim(), offset: 0 };
        h.renderRoute();
        return true;
      case "books-expense": {
        const body = { ...b, allow_duplicate: b.allow_duplicate === "on" };
        if (!body.vendor_id) delete body.vendor_id;
        if (form.dataset.scan) body.scan_id = form.dataset.scan;
        const fileInput = form.querySelector("input.books-file");
        let saved;
        try {
          saved = id ? await h.api("/books/expenses/" + id, "PUT", body) : await send("/books/expenses", "POST", body);
        } catch (e) {
          if (/already exists/.test(e.message)) form.querySelector(".books-dup").hidden = false;
          throw e;
        }
        if (fileInput?.files?.[0]) await h.upload(fileInput.files[0], { entity_type: "books_expense", entity_id: saved.id, purpose: "receipt" });
        await reload(id ? "Expense updated." : "Expense saved.");
        return true;
      }
      case "books-scan-upload": {
        const file = form.querySelector("input.books-file").files[0];
        if (!file) throw new Error("Choose a file.");
        const scan = await uploadScan(file);
        modal.close();
        expenseForm(null, scan);
        return true;
      }
      case "books-pay-expense":
        await h.api(`/books/expenses/${id}/pay`, "POST", b);
        await reload("Expense marked paid.");
        return true;
      case "books-delete-expense":
        await h.api(`/books/expenses/${id}/delete`, "POST", { reason: b.reason });
        await reload("Expense deleted.");
        return true;
      case "books-vendor":
        if (id) await h.api("/books/vendors/" + id, "PUT", b);
        else await send("/books/vendors", "POST", b);
        await reload("Vendor saved.");
        return true;
      case "books-category":
        await h.api("/books/categories" + (id ? "/" + id : ""), id ? "PUT" : "POST", { ...b, active: b.active === "1", deductible: Number(b.deductible) });
        await reload("Category saved.");
        return true;
      case "books-bill": {
        const body = { ...b, items: readLines(form) };
        const saved = id ? await h.api("/books/bills/" + id, "PUT", body) : await send("/books/bills", "POST", body);
        modal.close();
        await h.refresh();
        h.navigate("bill/" + saved.id);
        toast("Bill saved.");
        return true;
      }
      case "books-pay-bill":
        await send(`/books/bills/${id}/payments`, "POST", b);
        await reload("Payment recorded as an expense.");
        return true;
      case "books-void-bill":
        await h.api(`/books/bills/${id}/void`, "POST", { reason: b.reason });
        await reload("Bill voided.");
        return true;
      case "books-bill-file": {
        const file = form.querySelector("input.books-file").files[0];
        if (!file) throw new Error("Choose a file.");
        await h.upload(file, { entity_type: "books_bill", entity_id: id, purpose: "attachment" });
        h.renderRoute();
        toast("File attached.");
        return true;
      }
      case "books-po": {
        const body = { ...b, items: readLines(form) };
        const saved = id ? await h.api("/books/pos/" + id, "PUT", body) : await send("/books/pos", "POST", body);
        modal.close();
        await h.refresh();
        h.navigate("po/" + saved.id);
        toast("Purchase order saved as a draft.");
        return true;
      }
      case "books-po-email": {
        const r = await h.api(`/books/pos/${id}/email`, "POST", { ...b, request_key: form.dataset.key });
        await reload(r.status === "sent" ? "Purchase order emailed." : "Already sent.");
        return true;
      }
      case "books-po-bill": {
        const bill = await send(`/books/pos/${id}/bill`, "POST", b);
        modal.close();
        await h.refresh();
        h.navigate("bill/" + bill.id);
        toast("Bill created from the purchase order.");
        return true;
      }
      case "books-cancel-po":
        await h.api(`/books/pos/${id}/cancel`, "POST", { reason: b.reason });
        await reload("Purchase order cancelled.");
        return true;
      case "books-recurring": {
        const body = { ...b, active: b.active === "1" };
        if (!body.vendor_id) delete body.vendor_id;
        if (id) await h.api("/books/recurring/" + id, "PUT", body);
        else await send("/books/recurring", "POST", body);
        await reload("Recurring cost saved.");
        return true;
      }
      case "books-cash":
        await h.api("/books/cash", "PUT", { balance: b.balance, date: b.date });
        await reload("Bank balance saved.");
        return true;
      case "books-range":
        if (b.from > b.to) throw new Error("The start date must be before the end date.");
        range = { from: b.from, to: b.to };
        h.renderRoute();
        return true;
      case "books-tax-year":
        taxYear = Number(b.year);
        h.renderRoute();
        return true;
      case "books-export-settings": {
        const accounts = {},
          taxCodes = {};
        for (const [k, v] of Object.entries(b)) {
          const [kind, target, rate] = k.split(".");
          if (kind === "account") accounts[target] = v;
          if (kind === "tax") (taxCodes[target] ||= {})[rate] = v;
        }
        await h.api("/books/settings", "PUT", { exportDateFormat: b.exportDateFormat, accounts, taxCodes });
        await reload("Export codes saved.");
        return true;
      }
      case "books-settings":
        await h.api("/books/settings", "PUT", { poPrefix: b.poPrefix, poTerms: b.poTerms });
        await reload("Books settings saved.");
        return true;
    }
    return false;
  }

  return {
    nav: [
      { key: "expenses", label: "Expenses", icon: "receipt", group: "Books" },
      { key: "bills", label: "Bills", icon: "cart", group: "Books" },
      { key: "reports", label: "Reports", icon: "chart", group: "Books" },
    ],
    pages: {
      expenses: expensesPage,
      bills: billsPage,
      bill: billPage,
      po: poPage,
      reports: reportsPage,
    },
    activeFor: { bill: "bills", po: "bills" },
    icons: {
      receipt: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
      cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.5 12h11.5l2-8H6.2"/>',
      chart: '<path d="M4 20V11M10 20V4M16 20v-7M2 20h20"/>',
    },
    action,
    submit,
    slots: {
      overview: healthPanel,
      clientPanels: clientPanel,
      documentPanels: documentPanel,
      clientFields: (c) =>
        B() ? input("Accounting code (for exports)", "books_account_code", B().clientCodes[c?.id] || "", "text", false, 'maxlength="20" placeholder="e.g. 300-A0001"') : "",
      settings: settingsPanel,
    },
  };
}
