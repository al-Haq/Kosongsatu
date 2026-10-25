// Books and reports: expenses and vendor bills, receipt scanning, sales reports, profit and loss, accounting exports, cash flow, tax summaries, late-payment prediction and cash health.
// Feature module contract: see docs/PLUGINS.md.
import { AppError, check, text, today, addDays, currency } from "../domain.mjs";
import { BOOKS_MIGRATIONS, attachBooks, period, PAYMENT_METHODS } from "../books-store.mjs";
import { FORM_LINES } from "../books-calc.mjs";
import { scanConfig, readReceipt } from "../books-scan.mjs";
import { TARGETS, buildExport, exportClientIds, toCsv, dec, csvCell } from "../books-export.mjs";
import { renderReportPdf, renderPurchaseOrderPdf, dateLabel } from "../books-pdf.mjs";
import { businessLogo, snapshotLogo } from "../pdf-logo.mjs";

// A draft purchase order follows the current logo; an issued one keeps the logo it was issued with.
const poLogo = (store, p) => (p.state === "draft" ? businessLogo(store) : snapshotLogo(store, p.business));

const ID = "([\\w-]{1,80})";
const route = (r, method, pattern) => {
  if (r.method !== method) return null;
  return r.path.match(new RegExp("^/api/books" + pattern + "$"));
};
const csvResponse = (r, rows, filename) =>
  r.send(200, toCsv(rows), {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"`,
  });
const pdfResponse = (r, bytes, filename) =>
  r.send(200, bytes, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"`,
  });
const query = (r, ...names) => Object.fromEntries(names.map((n) => [n, r.url.searchParams.get(n) || undefined]));
const owner = (r) => r.session?.owner_id ?? "owner";
const emailList = (value, required = true) => {
  const list = text(value || "", 600, required)
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter(Boolean);
  check(!required || list.length, "Enter at least one recipient.");
  check(list.length <= 5, "Send to at most 5 recipients.");
  for (const e of list) check(/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(e), `Invalid email: ${e}`);
  return list;
};
const MANAGEMENT =
  "Management report prepared from the records in this app, not audited accounts. Check figures with your accountant before relying on them.";
const TAX_AID =
  "Working aid only, not a tax computation or a filed return. Check every figure with your tax agent before completing Form B or Form P.";
const money = (v) => (v / 100).toFixed(2);

function pnlRows(p) {
  const rows = [["Basis", "Section", "Line", ...p.months, "Total MYR"]];
  for (const [basis, b] of [
    ["Accrual", p.accrual],
    ["Cash", p.cash],
  ]) {
    rows.push([basis, "Income", basis === "Accrual" ? "Invoiced, net of credit/debit notes, excl. SST" : "Received from customers, less refunds", ...b.income.byMonth.map(money), money(b.income.total)]);
    for (const c of b.categories) rows.push([basis, "Expenses", c.name, ...c.byMonth.map(money), money(c.total)]);
    rows.push([basis, "Expenses", "Total expenses", ...b.expenses.byMonth.map(money), money(b.expenses.total)]);
    rows.push([basis, "Result", basis === "Accrual" ? "Net profit / (loss)" : "Net cash (money in less money out, not profit)", ...b.net.byMonth.map(money), money(b.net.total)]);
    if (basis === "Accrual") rows.push([basis, "Memo", "SST charged (not income)", ...b.sst.byMonth.map(money), money(b.sst.total)]);
    rows.push([]);
  }
  rows.push([MANAGEMENT]);
  return rows;
}
function taxRows(t) {
  const rows = [
    ["Year of assessment", String(t.year)],
    ["Basis", "Accrual: issued invoices net of notes by issue date, expenses and supplier bills by their date"],
    [],
    ["Form B / Form P line", "Category", "Amount MYR"],
    ["Sales / turnover (excl. SST)", "", money(t.income)],
    ["Purchases and cost of production (cost of sales)", "", money(t.costOfSales)],
    ...t.costLines.map((c) => ["", c.name, money(c.total)]),
    ["Gross profit", "", money(t.grossProfit)],
  ];
  for (const l of t.lines) {
    rows.push([l.label, "", money(l.total)]);
    for (const c of l.categories) rows.push(["", c.name, money(c.total)]);
  }
  rows.push(["Total expenses", "", money(t.expenses)], ["Net profit / (loss) per accounts", "", money(t.netProfit)], [], ["Add back: expenses not (fully) deductible", "Deductible %", "Amount MYR"]);
  for (const a of t.adjustments) rows.push([a.name, `${a.deductible}%`, money(a.amount)]);
  rows.push(["Total add-backs", "", money(t.addBack)], ["Adjusted net profit (before capital allowances)", "", money(t.adjustedProfit)], [], [TAX_AID]);
  return rows;
}

export default {
  name: "books",
  // Staff record expenses, vendors, bills and supplier POs; reports, exports,
  // settings, categories, deletes and voids stay with the owner. Accountants read all.
  access: {
    staff: [
      ["GET", /^\/api\/books\/(expenses|vendors|categories|bills|pos|recurring|scans)(\.csv|\/.*)?$/],
      ["POST", /^\/api\/books\/(expenses|vendors|scans|bills|pos)$/],
      ["PUT", /^\/api\/books\/(expenses|vendors|bills|pos)\/[\w-]+$/],
      ["POST", /^\/api\/books\/expenses\/[\w-]+\/pay$/],
      ["POST", /^\/api\/books\/scans\/[\w-]+\/read$/],
      ["POST", /^\/api\/books\/bills\/[\w-]+\/payments$/],
      ["POST", /^\/api\/books\/pos\/[\w-]+\/(issue|receive|bill|email)$/],
      ["DELETE", /^\/api\/books\/scans\/[\w-]+$/],
    ],
    accountant: [["GET", /^\/api\/books\//]],
  },
  migrations: BOOKS_MIGRATIONS,
  secrets: [
    {
      name: "BOOKS_VISION_MODEL",
      label: "Receipt scanning model",
      help: "Optional. A vision-capable model at your AI provider (AI_BASE_URL), e.g. one that reads images. Leave empty to use AI_MODEL.",
      secret: false,
    },
  ],
  attach(Store) {
    attachBooks(Store);
  },
  init(ctx) {
    ctx.services.books = { scanConfig: () => scanConfig(ctx.assistant, ctx.store) };
  },
  routes: {
    async owner(r) {
      if (!r.path.startsWith("/api/books/")) return false;
      const store = r.ctx.store;
      let m;
      // ----- expenses -----
      if ((m = route(r, "GET", "/expenses"))) {
        const q = query(r, "from", "to", "category", "vendor", "status", "q", "bill", "limit", "offset");
        return r.send(200, store.expenses(q)), true;
      }
      if ((m = route(r, "GET", "/expenses\\.csv"))) {
        const q = { ...query(r, "from", "to", "category", "vendor", "status", "q", "bill"), all: true };
        const list = store.expenses(q);
        const cats = new Map(store.booksCategories().map((c) => [c.id, c]));
        const vendors = new Map(store.vendors().map((v) => [v.id, v]));
        const rows = [
          ["Date", "Vendor", "Vendor registration", "Vendor TIN", "Category", "Account code", "Description", "Reference", "Amount MYR", "SST / tax MYR", "Status", "Paid date", "Due date", "Payment method", "Bill", "Receipt files", "Notes"],
          ...list.items.map((e) => {
            const v = vendors.get(e.vendor_id);
            return [e.date, e.vendor_name, v?.registration || "", v?.tin || "", cats.get(e.category_id)?.name || e.category_id, cats.get(e.category_id)?.account_code || "", e.description, e.reference, dec(e.amount), dec(e.tax), e.status === "paid" ? "Paid" : "Unpaid", e.paid_date || "", e.due_date || "", e.payment_method, e.bill_number || "", e.file_count, e.notes];
          }),
          ["Total", "", "", "", "", "", "", "", dec(list.sum.amount), dec(list.sum.tax)],
        ];
        return csvResponse(r, rows, `expenses-${q.from || "all"}-${q.to || today()}.csv`), true;
      }
      if ((m = route(r, "POST", "/expenses"))) {
        const b = await r.body();
        return r.send(201, r.write("books.expense", b, () => store.saveExpense(b))), true;
      }
      if ((m = route(r, "GET", `/expenses/${ID}`))) return r.send(200, store.expense(m[1])), true;
      if ((m = route(r, "PUT", `/expenses/${ID}`))) return r.send(200, store.saveExpense(await r.body(), m[1])), true;
      if ((m = route(r, "POST", `/expenses/${ID}/pay`))) return r.send(200, store.payExpense(m[1], await r.body())), true;
      if ((m = route(r, "POST", `/expenses/${ID}/delete`))) {
        store.deleteExpense(m[1], (await r.body()).reason);
        return r.send(200, { ok: true }), true;
      }
      // ----- vendors and categories -----
      if ((m = route(r, "POST", "/vendors"))) {
        const b = await r.body();
        return r.send(201, r.write("books.vendor", b, () => store.saveVendor(b))), true;
      }
      if ((m = route(r, "PUT", `/vendors/${ID}`))) return r.send(200, store.saveVendor(await r.body(), m[1])), true;
      if ((m = route(r, "POST", `/vendors/${ID}/(archive|restore)`))) return r.send(200, store.archiveVendor(m[1], m[2] === "archive")), true;
      if ((m = route(r, "DELETE", `/vendors/${ID}`))) {
        store.deleteVendor(m[1]);
        return r.send(200, { ok: true }), true;
      }
      if ((m = route(r, "POST", "/categories"))) return r.send(201, store.saveCategory(await r.body())), true;
      if ((m = route(r, "PUT", `/categories/${ID}`))) return r.send(200, store.saveCategory(await r.body(), m[1])), true;
      // ----- settings -----
      if ((m = route(r, "PUT", "/settings"))) return r.send(200, store.saveBooksSettings(await r.body())), true;
      if ((m = route(r, "PUT", "/cash"))) return r.send(200, store.setCashBalance(await r.body())), true;
      // ----- recurring costs -----
      if ((m = route(r, "POST", "/recurring"))) {
        const b = await r.body();
        return r.send(201, r.write("books.recurring", b, () => store.saveRecurringCost(b))), true;
      }
      if ((m = route(r, "PUT", `/recurring/${ID}`))) return r.send(200, store.saveRecurringCost(await r.body(), m[1])), true;
      if ((m = route(r, "DELETE", `/recurring/${ID}`))) {
        store.deleteRecurringCost(m[1]);
        return r.send(200, { ok: true }), true;
      }
      // ----- receipt scans -----
      if ((m = route(r, "POST", "/scans"))) {
        r.allow("books-upload:" + owner(r), 60, 600000);
        const data = await r.rawBody();
        const scan = store.createScan({ data, name: r.url.searchParams.get("name") || "receipt" });
        return r.send(201, { ...scan, ai: scanStatus(r) }), true;
      }
      if ((m = route(r, "GET", `/scans/${ID}`))) return r.send(200, store.scan(m[1])), true;
      if ((m = route(r, "DELETE", `/scans/${ID}`))) {
        store.discardScan(m[1]);
        return r.send(200, { ok: true }), true;
      }
      if ((m = route(r, "POST", `/scans/${ID}/read`))) {
        r.allow("books-scan:" + owner(r), 20, 600000);
        const b = await r.body();
        check(b.consent === true, "Confirm sending this receipt to your AI provider first.");
        const config = scanConfig(r.ctx.assistant, store);
        check(config, "No AI model is configured. Fill in the form yourself, or set AI_BASE_URL and AI_MODEL on the server.", 503);
        const scan = store.scan(m[1]);
        check(["uploaded", "failed", "extracted"].includes(scan.state) || (scan.state === "reading" && Date.parse(scan.updated) < Date.now() - 120000), scan.state === "reading" ? "This receipt is already being read." : "This scan was already used or discarded.", 409);
        check(scan.file, "The receipt file is missing.", 409);
        const file = store.file(scan.file.id);
        store.setScanState(scan.id, "reading");
        store.audit("books.scan.sent", scan.id, `Sent ${file.name} (${Math.ceil(file.size / 1024)} KB) and the category list to ${config.origin} (${config.model}).`);
        r.res.setTimeout(120000);
        try {
          const draft = await readReceipt({ config, fetcher: r.ctx.assistant.fetcher, file, categories: store.booksCategories() });
          // Match the vendor by registration number or exact name.
          const vendors = store.vendors().filter((v) => !v.archived);
          const vendor =
            (draft.vendor_registration && vendors.find((v) => v.registration && v.registration.replace(/\W/g, "").toUpperCase() === draft.vendor_registration.replace(/\W/g, "").toUpperCase())) ||
            vendors.find((v) => v.name.toLowerCase() === draft.vendor_name.toLowerCase());
          if (vendor) {
            draft.vendor_id = vendor.id;
            draft.vendor_name = vendor.name;
            if (!draft.category_id && vendor.default_category) draft.category_id = vendor.default_category;
          }
          const out = store.setScanState(scan.id, "extracted", { draft, model: config.model });
          store.audit("books.scan.read", scan.id, `Draft from ${config.model}; waiting for the owner to confirm.`);
          return r.send(200, out), true;
        } catch (e) {
          store.setScanState(scan.id, "failed", { error: e instanceof AppError ? e.message : "Reading failed." });
          throw e instanceof AppError ? e : new AppError("Reading the receipt failed. Fill in the form yourself.", 502);
        }
      }
      // ----- supplier bills -----
      if ((m = route(r, "GET", "/bills"))) return r.send(200, store.bills()), true;
      if ((m = route(r, "POST", "/bills"))) {
        const b = await r.body();
        return r.send(201, r.write("books.bill", b, () => store.saveBill(b))), true;
      }
      if ((m = route(r, "GET", `/bills/${ID}`))) return r.send(200, { ...store.bill(m[1]), files: store.files("books_bill", m[1]) }), true;
      if ((m = route(r, "PUT", `/bills/${ID}`))) return r.send(200, store.saveBill(await r.body(), m[1])), true;
      if ((m = route(r, "POST", `/bills/${ID}/void`))) return r.send(200, store.voidBill(m[1], (await r.body()).reason)), true;
      if ((m = route(r, "POST", `/bills/${ID}/payments`))) {
        const b = await r.body();
        return r.send(201, r.write("books.bill.pay:" + m[1], b, () => store.payBill(m[1], b))), true;
      }
      // ----- purchase orders -----
      if ((m = route(r, "GET", "/pos"))) return r.send(200, store.pos()), true;
      if ((m = route(r, "POST", "/pos"))) {
        const b = await r.body();
        return r.send(201, r.write("books.po", b, () => store.savePo(b))), true;
      }
      if ((m = route(r, "GET", `/pos/${ID}`))) return r.send(200, store.po(m[1])), true;
      if ((m = route(r, "PUT", `/pos/${ID}`))) return r.send(200, store.savePo(await r.body(), m[1])), true;
      if ((m = route(r, "GET", `/pos/${ID}/pdf`))) {
        const p = store.po(m[1]);
        return pdfResponse(r, await renderPurchaseOrderPdf(p, poLogo(store, p)), `${p.number || "PO-DRAFT"}.pdf`), true;
      }
      if ((m = route(r, "POST", `/pos/${ID}/(issue|receive|cancel|bill|email)`))) {
        const [, pid, action] = m;
        const b = await r.body();
        if (action === "issue") return r.send(200, r.write("books.po.issue:" + pid, {}, () => store.issuePo(pid))), true;
        if (action === "receive") return r.send(200, store.receivePo(pid)), true;
        if (action === "cancel") return r.send(200, store.cancelPo(pid, b.reason)), true;
        if (action === "bill") return r.send(201, r.write("books.po.bill:" + pid, b, () => store.billFromPo(pid, b))), true;
        // Email, sent at most once per request key.
        r.allow("email:" + owner(r), 30, 600000);
        const p = store.po(pid);
        check(["issued", "received", "billed"].includes(p.state), "Issue the purchase order before emailing it.", 409);
        const key = text(b.request_key || "", 100, true);
        check(/^[\w-]{16,100}$/.test(key), "Invalid request key.");
        const to = emailList(b.to),
          cc = emailList(b.cc, false);
        const subject = text(b.subject || `Purchase order ${p.number} from ${p.business.company}`, 200, true);
        const message = text(b.message || "", 4000);
        const body = [
          message || `Dear ${p.vendor.contact || p.vendor.name},\n\nPlease find purchase order ${p.number} attached.`,
          "",
          `Purchase order: ${p.number}`,
          `Order date: ${dateLabel(p.po_date)}`,
          ...(p.expected_date ? [`Needed by: ${dateLabel(p.expected_date)}`] : []),
          `Total: ${currency(p.total)}`,
          "",
          p.business.company,
          [p.business.email, p.business.phone].filter(Boolean).join(" / "),
        ].join("\n");
        const sent = await r.ctx.mailer.deliver({
          kind: "purchase_order",
          to,
          cc,
          subject,
          body,
          attachments: [{ filename: `${p.number}.pdf`, content: await renderPurchaseOrderPdf(p, poLogo(store, p)), contentType: "application/pdf" }],
          dedupeKey: `books-po:${pid}:${key}`,
        });
        if (sent) {
          store.db.prepare("UPDATE books_pos SET sent_at=? WHERE id=?").run(new Date().toISOString(), pid);
          store.audit("books.po.emailed", pid, `${p.number} to ${to.join(", ")}`);
        }
        return r.send(201, { status: sent ? "sent" : "already sent", po: store.po(pid) }), true;
      }
      // ----- reports -----
      if ((m = route(r, "GET", "/reports/sales(\\.csv)?"))) {
        const rep = store.salesReport(query(r, "from", "to"));
        if (!m[1]) return r.send(200, rep), true;
        const view = r.url.searchParams.get("view") || "client";
        check(["client", "item", "month"].includes(view), "Choose client, item or month.");
        const rows =
          view === "client"
            ? [["Client", "Invoices", "Invoiced MYR (net of notes, incl. SST)", "SST MYR", "Collected MYR"], ...rep.clients.map((c) => [c.client, c.count, money(c.invoiced), money(c.sst), money(c.collected)])]
            : view === "item"
              ? [["Service / item", "Quantity", "Invoiced MYR (net of notes, incl. SST)", "Collected MYR"], ...rep.items.map((i) => [i.label, i.quantity || "", money(i.invoiced), money(i.collected)])]
              : [["Month", "Invoices", "Invoiced MYR (net of notes, incl. SST)", "SST MYR", "Collected MYR"], ...rep.months.map((x) => [x.month, x.count, money(x.invoiced), money(x.sst), money(x.collected)])];
        rows.push(["Total", "", money(rep.totals.invoiced), view === "item" ? money(rep.totals.collected) : money(rep.totals.sst), ...(view === "item" ? [] : [money(rep.totals.collected)])]);
        if (view === "item") rows[rows.length - 1] = ["Total", "", money(rep.totals.invoiced), money(rep.totals.collected)];
        return csvResponse(r, rows, `sales-by-${view}-${rep.from}-${rep.to}.csv`), true;
      }
      if ((m = route(r, "GET", "/reports/pnl(\\.csv|\\.pdf)?"))) {
        const p = store.profitAndLoss(query(r, "from", "to"));
        if (!m[1]) return r.send(200, p), true;
        if (m[1] === ".csv") return csvResponse(r, pnlRows(p), `profit-and-loss-${p.from}-${p.to}.csv`), true;
        const col = (label, width, align = "right") => ({ label, width, align });
        const sections = [{ notice: MANAGEMENT }];
        for (const [title, b, incomeLabel] of [
          ["Accrual basis", p.accrual, "Invoiced, net of credit/debit notes (excl. SST)"],
          ["Cash basis", p.cash, "Received from customers, less refunds"],
        ])
          sections.push({
            heading: title,
            table: {
              columns: [col("Line", 391, "left"), col("MYR", 120)],
              rows: [
                { cells: ["Income: " + incomeLabel, currency(b.income.total)], bold: true },
                ...b.categories.map((c) => ({ cells: ["   " + c.name, currency(c.total)] })),
                { cells: ["Total expenses", currency(b.expenses.total)], bold: true, rule: true },
                { cells: [title === "Accrual basis" ? "Net profit / (loss)" : "Net cash (money in less money out, not profit)", currency(b.net.total)], bold: true, rule: true, color: b.net.total < 0 ? "red" : "" },
                ...(title === "Accrual basis" ? [{ cells: ["Memo: SST charged on invoices (owed to customs, not income)", currency(b.sst.total)] }] : []),
              ],
            },
          });
        sections.push({
          heading: "By month",
          table: {
            columns: [col("Month", 91, "left"), col("Accrual income", 70), col("Accrual costs", 70), col("Accrual net", 70), col("Cash in", 70), col("Cash out", 70), col("Cash net", 70)],
            rows: p.months.map((mo, i) => ({
              cells: [mo, currency(p.accrual.income.byMonth[i]), currency(p.accrual.expenses.byMonth[i]), currency(p.accrual.net.byMonth[i]), currency(p.cash.income.byMonth[i]), currency(p.cash.expenses.byMonth[i]), currency(p.cash.net.byMonth[i])],
            })),
          },
        });
        sections.push({ text: "Accrual: issued invoices by issue date, credit and debit notes by note date, expenses by expense date and supplier bills by bill date. Cash: money received less refunds, and expenses and bill payments by the date they were paid. Amounts in other currencies are converted with each document's exchange rate." });
        const pdf = await renderReportPdf({ title: "Profit and loss", subtitle: `${dateLabel(p.from)} – ${dateLabel(p.to)}`, business: store.settings(), sections, footerText: "Management report. Not audited accounts.", logo: businessLogo(store) });
        return pdfResponse(r, pdf, `profit-and-loss-${p.from}-${p.to}.pdf`), true;
      }
      if ((m = route(r, "GET", "/reports/tax(\\.csv|\\.pdf)?"))) {
        const t = store.taxSummary({ year: r.url.searchParams.get("year") || undefined });
        if (!m[1]) return r.send(200, t), true;
        if (m[1] === ".csv") return csvResponse(r, taxRows(t), `income-tax-summary-${t.year}.csv`), true;
        const col = (label, width, align = "right") => ({ label, width, align });
        const lineRows = [];
        for (const l of t.lines) {
          lineRows.push({ cells: [l.label, currency(l.total)], bold: !!l.total });
          for (const c of l.categories) lineRows.push({ cells: ["   " + c.name, currency(c.total)] });
        }
        const pdf = await renderReportPdf({
          title: "Income tax summary",
          subtitle: `Year of assessment ${t.year} (1 Jan – 31 Dec)`,
          business: store.settings(),
          logo: businessLogo(store),
          footerText: "Working aid only. Check with your tax agent.",
          sections: [
            { notice: TAX_AID },
            {
              heading: "Business income",
              table: {
                columns: [col("Form B / Form P line", 391, "left"), col("MYR", 120)],
                rows: [
                  { cells: ["Sales / turnover (excl. SST)", currency(t.income)], bold: true },
                  { cells: ["Purchases and cost of production (cost of sales)", currency(t.costOfSales)] },
                  ...t.costLines.map((c) => ({ cells: ["   " + c.name, currency(c.total)] })),
                  { cells: ["Gross profit", currency(t.grossProfit)], bold: true, rule: true },
                ],
              },
            },
            { heading: "Expenses", table: { columns: [col("Form B / Form P line", 391, "left"), col("MYR", 120)], rows: [...lineRows, { cells: ["Total expenses", currency(t.expenses)], bold: true, rule: true }, { cells: ["Net profit / (loss) per accounts", currency(t.netProfit)], bold: true }] } },
            {
              heading: "Tax adjustments",
              table: {
                columns: [col("Not (fully) deductible", 291, "left"), col("Deductible", 100), col("Add back MYR", 120)],
                rows: [
                  ...t.adjustments.map((a) => ({ cells: [a.name, `${a.deductible}%`, currency(a.amount)] })),
                  { cells: ["Total add-backs", "", currency(t.addBack)], bold: true, rule: true },
                  { cells: ["Adjusted net profit (before capital allowances)", "", currency(t.adjustedProfit)], bold: true },
                ],
              },
            },
            { text: "Capital allowances, approved donations, reliefs and other income are not included. Equipment and other capital purchases are added back here; claim capital allowances on them instead. The deductible percentage of each category can be changed under Books > Expenses > Categories." },
          ],
        });
        return pdfResponse(r, pdf, `income-tax-summary-${t.year}.pdf`), true;
      }
      if ((m = route(r, "GET", "/forecast(\\.csv)?"))) {
        const { forecast } = store.cashPicture();
        if (!m[1]) return r.send(200, forecast), true;
        const rows = [["Week", "From", "To", "Money in MYR", "Money out MYR", "Net MYR", "Closing balance MYR", "Below zero"]];
        for (const w of forecast.weeks) rows.push([w.week, w.start, w.end, money(w.inflow), money(w.outflow), money(w.net), money(w.closing), w.negative ? "Yes" : ""]);
        rows.push([], ["Week", "Expected date", "Type", "Item", "Amount MYR"]);
        for (const w of forecast.weeks) for (const i of w.items) rows.push([w.week, i.date, i.kind, i.label, money(i.amount)]);
        rows.push([], [forecast.opening.known ? `Opening: bank balance ${money(forecast.opening.balance)} on ${forecast.opening.date}, estimated ${money(forecast.opening.estimated)} today` : "No bank balance entered; the forecast starts from zero."]);
        return csvResponse(r, rows, `cash-flow-forecast-${forecast.asOf}.csv`), true;
      }
      if ((m = route(r, "GET", "/lateness"))) return r.send(200, store.cashPicture().lateness), true;
      // ----- accounting exports -----
      if ((m = route(r, "GET", "/exports/([a-z]+)/([a-z]+)\\.csv"))) {
        const [, target, dataset] = m;
        check(TARGETS[target]?.datasets[dataset], "Export not found.", 404);
        const { from, to } = period(query(r, "from", "to"));
        const docs = store.documents();
        const clients = store.db.prepare("SELECT * FROM clients").all();
        const codes = store.ensureClientCodes(exportClientIds(dataset, { docs, clients, from, to }));
        const out = buildExport(target, dataset, { docs, clients, services: store.db.prepare("SELECT * FROM services").all(), codes, settings: store.booksSettings(), from, to });
        store.audit("books.export", null, `${TARGETS[target].label} ${dataset}: ${out.count} rows (${from} to ${to})`);
        return csvResponse(r, out.rows, out.filename), true;
      }
      return false;
    },
  },
  jobs: [
    {
      name: "scan-cleanup",
      every: 86400000,
      delay: 120000,
      // Receipt photos that were uploaded but never confirmed are removed after 14 days.
      async run(ctx) {
        return ctx.store.purgeScans(14);
      },
    },
  ],
  workspace(r) {
    const store = r.ctx.store;
    const { lateness, health, forecast } = store.cashPicture();
    // Cash health and the forecast are company figures: owner and accountant only.
    const money = r.session.role !== "staff";
    return {
      settings: store.booksSettings(),
      categories: store.booksCategories(),
      vendors: store.vendors(),
      recurring: store.recurringCosts(),
      bills: store.bills(),
      pos: store.pos().map(({ business, business_snapshot, ...p }) => p),
      clientCodes: store.clientCodes(),
      lateness,
      health: money ? health : null,
      forecastSummary: money ? { lowest: forecast.lowest, negativeWeeks: forecast.negativeWeeks, openingKnown: forecast.opening.known } : null,
      ai: scanStatus(r),
      mail: r.ctx.mailer.status().configured,
      paymentMethods: PAYMENT_METHODS,
      formLines: FORM_LINES,
      exports: Object.fromEntries(Object.entries(TARGETS).map(([k, t]) => [k, { label: t.label, datasets: t.datasets, certainty: t.certainty, note: t.note }])),
    };
  },
  exportData(store) {
    return {
      settings: store.booksSettings(),
      categories: store.booksCategories(),
      vendors: store.vendors(),
      expenses: store.allExpenses(),
      bills: store.bills(),
      purchaseOrders: store.pos(),
      recurringCosts: store.recurringCosts(),
      clientCodes: store.clientCodes(),
    };
  },
  seedDemo(store) {
    seed(store);
  },
};
function scanStatus(r) {
  const c = scanConfig(r.ctx.assistant, r.ctx.store);
  return { configured: !!c, model: c?.model || null, origin: c?.origin || null };
}
// Example vendors, expenses, a part-paid bill, a purchase order and payment history.
function seed(store) {
  const t = today();
  const v = (name, cat, terms = 30, extra = {}) => store.saveVendor({ name, default_category: cat, terms, ...extra });
  const unifi = v("Telco Fibre (Demo)", "internet_phone", 14, { registration: "199901000001", email: "billing@telco.example" });
  const cloud = v("Cloud Host (Demo)", "software", 30);
  const landlord = v("Menara Office (Demo)", "rent", 7);
  const parts = v("Komponen IT Supplies (Demo)", "cost_of_sales", 30, { email: "sales@komponen.example", contact: "Hafiz" });
  const exp = (days, vendor, amount, extra = {}) =>
    store.saveExpense({ date: addDays(t, -days), vendor_id: vendor.id, amount, payment_method: "Bank transfer", status: "paid", paid_date: addDays(t, -days), ...extra });
  for (const n of [5, 35, 65]) {
    exp(n, unifi, "199.00", { tax: "14.74", description: "Business fibre", reference: "TF-" + n });
    exp(n + 2, cloud, "420.00", { description: "Servers and backups" });
    exp(n + 1, landlord, "1800.00", { description: "Office rent" });
  }
  exp(12, unifi, "86.40", { category_id: "travel", description: "Grab to client site", vendor_id: undefined, vendor_name: "Grab (Demo)", payment_method: "E-wallet" });
  store.saveExpense({ date: addDays(t, -3), vendor_name: "Printing shop (Demo)", category_id: "office", description: "Business cards", amount: "150.00", status: "unpaid", due_date: addDays(t, 11) });
  const bill = store.saveBill({
    vendor_id: parts.id,
    bill_date: addDays(t, -20),
    due_date: addDays(t, 10),
    reference: "KIS-88812",
    items: [
      { description: "Network switch", quantity: "2", rate: "650.00", tax_rate: 0, category_id: "cost_of_sales" },
      { description: "Installation", quantity: "1", rate: "300.00", tax_rate: 8, category_id: "contractors" },
    ],
  });
  store.payBill(bill.id, { amount: "800.00", paid_date: addDays(t, -6), payment_method: "Bank transfer", reference: "DEMO-BILL-1" });
  store.savePo({ vendor_id: parts.id, expected_date: addDays(t, 14), items: [{ description: "Wi-Fi access points", quantity: "4", rate: "380.00", category_id: "cost_of_sales" }] });
  store.saveRecurringCost({ name: "Office rent", vendor_id: landlord.id, category_id: "rent", amount: "1800.00", every: "month", next_date: addDays(t, 20) });
  store.setCashBalance({ balance: "18500.00", date: addDays(t, -7) });
  // Payment history: one client that usually pays about three weeks late.
  const late = store.db.prepare("SELECT * FROM clients WHERE name LIKE 'Rimba Retail%'").get();
  if (late)
    for (const [ago, lateBy] of [
      [150, 18],
      [120, 25],
      [90, 21],
    ]) {
      const issue = addDays(t, -ago);
      const d = store.issue(store.saveDocument({ kind: "invoice", client_id: late.id, issue_date: issue, due_date: addDays(issue, 14), items: [{ description: "Workflow automation", quantity: 1, rate: "900.00" }] }).id);
      store.recordPayment(d.id, { amount: "900.00", paid_date: addDays(issue, 14 + lateBy), method: "Bank transfer", reference: "DEMO-LATE-" + ago });
    }
}
// Re-exported for tests.
export { csvCell };
