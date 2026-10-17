// CSV files for accounting software. Each package has its own column layout;
// the docs (docs/features/books.md) list how every column is filled.
import { allocateDiscount } from "./domain.mjs";
import { isSalesInvoice, lineKey, days } from "./books-calc.mjs";

// How sure we are of each layout. "template": built from the vendor's published
// import template. "mapping": the vendor's import screen maps columns by name.
// "closest": no public template could be confirmed; this is the closest
// documented format and columns may need copying into the vendor's own file.
export const TARGETS = {
  xero: {
    label: "Xero",
    datasets: { invoices: "Sales invoices", contacts: "Contacts" },
    certainty: "template",
    note: "Columns follow Xero's sales invoice and contact import templates. Xero matches columns by heading; check them against the template on Xero's import screen before a large import.",
  },
  quickbooks: {
    label: "QuickBooks Online",
    datasets: { invoices: "Invoices" },
    certainty: "mapping",
    note: "Columns follow Intuit's invoice import guide (Settings > Import data > Invoices). QuickBooks asks you to map each column during import and can add missing customers.",
  },
  bukku: {
    label: "Bukku",
    datasets: { invoices: "Sales invoices", contacts: "Customers" },
    certainty: "closest",
    note: "Bukku's own import template could not be confirmed from a public source. This is the closest documented format: copy the columns into the template you download from Bukku (Sales > Invoices > Import) without changing its column order.",
  },
  sqlaccount: {
    label: "SQL Account",
    datasets: { invoices: "Sales invoices", contacts: "Customers" },
    certainty: "closest",
    note: "Uses the field names of SQL Account's Excel import (DocNo, DocDate, Code, ...). The exact template could not be confirmed; map the columns in SQL Account's XLS import tool.",
  },
  autocount: {
    label: "AutoCount Accounting",
    datasets: { invoices: "A/R invoices", contacts: "Debtors" },
    certainty: "closest",
    note: "Uses the field names of AutoCount's Import From Excel specification (DocNo, DocDate, DebtorCode, ...). The exact current template could not be confirmed; paste into File > Import From Excel and check the columns.",
  },
};

export const csvCell = (v) => {
  let s = String(v ?? "");
  // Neutralise spreadsheet formulas, but keep plain negative numbers usable.
  if (/^\s*[=+@\t\r]/.test(s) || (/^\s*-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s))) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
};
export const toCsv = (rows) => "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
export const dec = (sen) => (sen / 100).toFixed(2);
export function formatDate(v, format = "DD/MM/YYYY") {
  if (!v) return "";
  const [y, m, d] = v.split("-");
  if (format === "YYYY-MM-DD") return v;
  if (format === "MM/DD/YYYY") return `${m}/${d}/${y}`;
  return `${d}/${m}/${y}`;
}
const qty = (q) => String(Number(q));
const addressLines = (a) =>
  String(a || "")
    .split(/\r?\n|,\s*(?=\S)/)
    .map((s) => s.trim())
    .filter(Boolean);
function address4(a) {
  const l = addressLines(a);
  if (l.length <= 4) return [...l, "", "", "", ""].slice(0, 4);
  return [...l.slice(0, 3), l.slice(3).join(", ")];
}
// Invoice lines at their quantity and rate. A document discount becomes one
// "Discount" line per SST rate, and line SST amounts are set so they add up to
// the invoice's SST exactly.
export function exportLines(d) {
  const lines = d.items.map((i) => ({
    description: i.description,
    quantity: i.quantity,
    rate: i.rate,
    amount: i.amount,
    tax_rate: i.tax_rate || 0,
    tax: i.tax || 0,
    sku: i.sku || "",
    service_id: i.service_id || "",
    item: i,
  }));
  if (!d.discount) return lines;
  const legacy = allocateDiscount(
    d.items.map((i) => i.amount),
    d.discount,
  );
  const groups = new Map();
  d.items.forEach((i, n) => {
    const rate = i.tax_rate || 0;
    const g = groups.get(rate) || { share: 0, tax: 0, lines: [] };
    g.share += i.taxable !== undefined ? i.amount - i.taxable : legacy[n];
    g.tax += i.tax || 0;
    g.lines.push(lines[n]);
    groups.set(rate, g);
  });
  for (const [rate, g] of groups) {
    if (!g.share) continue;
    // Tax on each full line, as the accounting package will work it out; the
    // discount line carries the difference.
    for (const l of g.lines) l.tax = Math.round((l.amount * rate) / 100);
    const lineTax = g.lines.reduce((s, l) => s + l.tax, 0);
    lines.push({ description: "Discount", quantity: 1, rate: -g.share, amount: -g.share, tax_rate: rate, tax: g.tax - lineTax, discount: true, item: {} });
  }
  return lines;
}
const currencyOf = (d) => d.currency || "MYR";
const rateOf = (d) => (d.fx_rate ? String(d.fx_rate) : "1");

export function buildExport(target, dataset, { docs, clients, services, codes, settings, from, to }) {
  const t = TARGETS[target];
  if (!t || !t.datasets[dataset]) return null;
  const fmt = (v) => formatDate(v, ["sqlaccount", "autocount"].includes(target) ? "DD/MM/YYYY" : settings.exportDateFormat);
  const account = settings.accounts[target] || "";
  const tax = (rate) => settings.taxCodes[target]?.[rate] ?? "";
  const invoices = docs
    .filter((d) => isSalesInvoice(d) && d.issue_date >= from && d.issue_date <= to)
    .sort((a, b) => a.issue_date.localeCompare(b.issue_date) || a.number.localeCompare(b.number));
  const itemName = (l) => (l.discount ? "Discount" : lineKey(l.item, services).key.startsWith("service:") ? lineKey(l.item, services).label : "Services");
  const terms = (d) => Math.max(0, days(d.issue_date, d.due_date));
  let rows;
  if (dataset === "invoices") {
    const each = (fn) => invoices.flatMap((d) => exportLines(d).map((l) => fn(d, l)));
    if (target === "xero")
      rows = [
        ["*ContactName", "EmailAddress", "POAddressLine1", "POAddressLine2", "POAddressLine3", "POAddressLine4", "POCity", "PORegion", "POPostalCode", "POCountry", "*InvoiceNumber", "Reference", "*InvoiceDate", "*DueDate", "Total", "InventoryItemCode", "*Description", "*Quantity", "*UnitAmount", "Discount", "*AccountCode", "*TaxType", "TaxAmount", "TrackingName1", "TrackingOption1", "TrackingName2", "TrackingOption2", "Currency", "BrandingTheme"],
        ...each((d, l) => [d.client.name, d.client.email || "", ...address4(d.client.address), "", "", "", "", d.number, d.reference || "", fmt(d.issue_date), fmt(d.due_date), dec(d.total), "", l.description, qty(l.quantity), dec(l.rate), "", account, tax(l.tax_rate), dec(l.tax), "", "", "", "", currencyOf(d), ""]),
      ];
    if (target === "quickbooks")
      rows = [
        ["InvoiceNo", "Customer", "InvoiceDate", "DueDate", "Terms", "Location", "Memo", "Item(Product/Service)", "ItemDescription", "ItemQuantity", "ItemRate", "ItemAmount", "ItemTaxCode", "ItemTaxAmount", "Currency", "ServiceDate"],
        ...each((d, l) => [d.number, d.client.name, fmt(d.issue_date), fmt(d.due_date), `Net ${terms(d)}`, "", (d.notes || "").slice(0, 1000), itemName(l), l.description, qty(l.quantity), dec(l.rate), dec(l.amount), tax(l.tax_rate), dec(l.tax), currencyOf(d), ""]),
      ];
    if (target === "bukku")
      rows = [
        ["Contact", "Contact Code", "Number", "Date", "Due Date", "Term (days)", "Currency", "Exchange Rate", "Reference", "Title", "Description", "Account", "Quantity", "Unit Price", "Amount", "Tax Code", "Tax Amount"],
        ...each((d, l) => [d.client.name, codes[d.client_id] || "", d.number, fmt(d.issue_date), fmt(d.due_date), terms(d), currencyOf(d), rateOf(d), d.reference || "", "Invoice", l.description, account, qty(l.quantity), dec(l.rate), dec(l.amount), tax(l.tax_rate), dec(l.tax)]),
      ];
    if (target === "sqlaccount")
      rows = [
        ["DocNo", "DocDate", "Code", "CompanyName", "Terms", "Description", "CurrencyCode", "CurrencyRate", "Account", "ItemDescription", "Qty", "UnitPrice", "Disc", "Tax", "TaxRate", "TaxAmt", "Amount"],
        ...each((d, l) => [d.number, fmt(d.issue_date), codes[d.client_id] || "", d.client.name, `${terms(d)} Days`, "Sales", currencyOf(d) === "MYR" ? "----" : currencyOf(d), rateOf(d), account, l.description, qty(l.quantity), dec(l.rate), "", tax(l.tax_rate), l.tax_rate ? `${l.tax_rate}%` : "", dec(l.tax), dec(l.amount)]),
      ];
    if (target === "autocount")
      rows = [
        ["DocNo", "DocDate", "DebtorCode", "CompanyName", "Description", "CurrencyRate", "AccNo", "DetailDescription", "Amount", "TaxType", "TaxAmt"],
        ...each((d, l) => [d.number, fmt(d.issue_date), codes[d.client_id] || "", d.client.name, "Sales", rateOf(d), account, l.quantity !== 1 && !l.discount ? `${l.description} (${qty(l.quantity)} x ${dec(l.rate)})` : l.description, dec(l.amount), tax(l.tax_rate), dec(l.tax)]),
      ];
  } else {
    const invoiced = new Set(invoices.map((d) => d.client_id));
    const list = clients.filter((c) => !c.archived || invoiced.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
    if (target === "xero")
      rows = [
        ["*ContactName", "AccountNumber", "EmailAddress", "FirstName", "LastName", "POAttentionTo", "POAddressLine1", "POAddressLine2", "POAddressLine3", "POAddressLine4", "POCity", "PORegion", "POPostalCode", "POCountry", "PhoneNumber", "MobileNumber", "TaxNumber", "CompanyNumber"],
        ...list.map((c) => [c.name, codes[c.id] || "", c.email || "", "", "", c.contact || "", ...address4(c.address), "", "", "", "", c.phone || "", "", c.tin || "", c.brn || ""]),
      ];
    if (target === "bukku")
      rows = [
        ["Type", "Code", "Legal Name", "Registration No.", "TIN", "SST Registration No.", "Email", "Phone", "Contact Person", "Billing Address", "Payment Term (days)"],
        ...list.map((c) => ["Customer", codes[c.id] || "", c.name, c.brn || "", c.tin || "", c.sst_number || "", c.email || "", c.phone || "", c.contact || "", addressLines(c.address).join(", "), c.terms]),
      ];
    if (target === "sqlaccount")
      rows = [
        ["Code", "CompanyName", "Attention", "Address1", "Address2", "Address3", "Address4", "Phone1", "Email", "Terms", "CurrencyCode", "BRN", "TIN", "SSTRegNo"],
        ...list.map((c) => [codes[c.id] || "", c.name, c.contact || "", ...address4(c.address), c.phone || "", c.email || "", `${c.terms} Days`, "----", c.brn || "", c.tin || "", c.sst_number || ""]),
      ];
    if (target === "autocount")
      rows = [
        ["AccNo", "CompanyName", "Attention", "Address1", "Address2", "Address3", "Address4", "Phone1", "EmailAddress", "DisplayTerm", "CurrencyCode", "RegisterNo", "TIN", "SSTRegisterNo"],
        ...list.map((c) => [codes[c.id] || "", c.name, c.contact || "", ...address4(c.address), c.phone || "", c.email || "", `${c.terms} Days`, "MYR", c.brn || "", c.tin || "", c.sst_number || ""]),
      ];
  }
  return {
    rows,
    count: rows.length - 1,
    filename: `${target}-${dataset}-${from}-${to}.csv`,
  };
}
// Clients that an export needs a customer code for.
export function exportClientIds(dataset, { docs, clients, from, to }) {
  if (dataset === "contacts") {
    const invoiced = new Set(docs.filter((d) => isSalesInvoice(d) && d.issue_date >= from && d.issue_date <= to).map((d) => d.client_id));
    return clients.filter((c) => !c.archived || invoiced.has(c.id)).map((c) => c.id);
  }
  return [...new Set(docs.filter((d) => isSalesInvoice(d) && d.issue_date >= from && d.issue_date <= to).map((d) => d.client_id))];
}
