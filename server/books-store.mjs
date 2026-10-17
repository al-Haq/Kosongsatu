// Books records: vendors, expense categories, expenses, supplier bills, purchase
// orders, recurring costs, receipt scans and accounting codes for clients.
import {
  id,
  now,
  today,
  check,
  text,
  date,
  money,
  integer,
  addDays,
  TAX_RATES,
} from "./domain.mjs";
import {
  FORM_LINE_KEYS,
  salesReport,
  profitAndLoss,
  taxSummary,
  latePayment,
  cashForecast,
  cashHealth,
} from "./books-calc.mjs";

const DEFAULT_CATEGORIES = [
  ["advertising", "Advertising & marketing", "promotion", 100],
  ["bank_fees", "Bank & payment fees", "other", 100],
  ["bad_debts", "Bad debts written off", "bad_debts", 100],
  ["commissions", "Commissions", "commissions", 100],
  ["cost_of_sales", "Hardware & licences for resale", "cost_of_sales", 100],
  ["contractors", "Subcontractors & freelancers", "contracts", 100],
  ["equipment", "Equipment & assets (capital)", "other", 0],
  ["fines", "Fines & penalties", "other", 0],
  ["insurance", "Insurance", "other", 100],
  ["internet_phone", "Internet & phone", "other", 100],
  ["interest", "Loan interest", "loan_interest", 100],
  ["entertainment", "Meals & entertainment", "other", 50],
  ["office", "Office supplies", "other", 100],
  ["professional", "Professional fees (accounting, legal)", "other", 100],
  ["rent", "Rent & lease", "rental", 100],
  ["repairs", "Repairs & maintenance", "repairs", 100],
  ["salaries", "Salaries, EPF, SOCSO & EIS", "salaries", 100],
  ["software", "Software & subscriptions", "other", 100],
  ["training", "Training & courses", "other", 100],
  ["travel", "Travel & transport", "travel", 100],
  ["utilities", "Utilities", "other", 100],
  ["other", "Other expenses", "other", 100],
];
const quote = (v) => "'" + String(v).replaceAll("'", "''") + "'";
export const BOOKS_MIGRATIONS = [
  {
    name: "books-001-tables",
    sql: `CREATE TABLE books_settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
 CREATE TABLE books_categories(id TEXT PRIMARY KEY, name TEXT NOT NULL, form_line TEXT NOT NULL DEFAULT 'other', deductible INTEGER NOT NULL DEFAULT 100 CHECK(deductible BETWEEN 0 AND 100), account_code TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL);
 CREATE UNIQUE INDEX books_category_name ON books_categories(lower(name));
 CREATE TABLE books_vendors(id TEXT PRIMARY KEY, name TEXT NOT NULL, registration TEXT NOT NULL DEFAULT '', tin TEXT NOT NULL DEFAULT '', sst_number TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', default_category TEXT REFERENCES books_categories(id), terms INTEGER NOT NULL DEFAULT 30, archived INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL, updated TEXT NOT NULL);
 CREATE TABLE books_bills(id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE, vendor_id TEXT NOT NULL REFERENCES books_vendors(id), vendor_snapshot TEXT NOT NULL, reference TEXT NOT NULL DEFAULT '', bill_date TEXT NOT NULL, due_date TEXT NOT NULL, items TEXT NOT NULL, subtotal INTEGER NOT NULL, tax INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL CHECK(total>0), notes TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','void')), void_reason TEXT, po_id TEXT UNIQUE, created TEXT NOT NULL, updated TEXT NOT NULL);
 CREATE TABLE books_expenses(id TEXT PRIMARY KEY, date TEXT NOT NULL, vendor_id TEXT REFERENCES books_vendors(id), vendor_name TEXT NOT NULL DEFAULT '', category_id TEXT NOT NULL REFERENCES books_categories(id), description TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL CHECK(amount>0), tax INTEGER NOT NULL DEFAULT 0 CHECK(tax>=0 AND tax<=amount), payment_method TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('paid','unpaid')), paid_date TEXT, due_date TEXT, reference TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', bill_id TEXT REFERENCES books_bills(id), scan_id TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, CHECK(status='unpaid' OR paid_date IS NOT NULL), CHECK(bill_id IS NULL OR status='paid'));
 CREATE INDEX books_expense_date ON books_expenses(date);
 CREATE INDEX books_expense_bill ON books_expenses(bill_id);
 CREATE INDEX books_expense_vendor ON books_expenses(vendor_id);
 CREATE TABLE books_pos(id TEXT PRIMARY KEY, number TEXT UNIQUE, vendor_id TEXT NOT NULL REFERENCES books_vendors(id), vendor_snapshot TEXT, business_snapshot TEXT, po_date TEXT NOT NULL, expected_date TEXT, items TEXT NOT NULL, subtotal INTEGER NOT NULL, tax INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL CHECK(total>0), notes TEXT NOT NULL DEFAULT '', terms TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','issued','received','billed','cancelled')), bill_id TEXT REFERENCES books_bills(id), cancel_reason TEXT, issued_at TEXT, received_at TEXT, sent_at TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
 CREATE TABLE books_recurring(id TEXT PRIMARY KEY, name TEXT NOT NULL, vendor_id TEXT REFERENCES books_vendors(id), category_id TEXT NOT NULL REFERENCES books_categories(id), amount INTEGER NOT NULL CHECK(amount>0), every TEXT NOT NULL CHECK(every IN ('week','month','quarter','year')), next_date TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL, updated TEXT NOT NULL);
 CREATE TABLE books_scans(id TEXT PRIMARY KEY, file_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('uploaded','reading','extracted','failed','confirmed','discarded')), draft TEXT, model TEXT, error TEXT, expense_id TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
 CREATE TABLE books_client_codes(client_id TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE, code TEXT NOT NULL UNIQUE COLLATE NOCASE);
 INSERT INTO books_categories(id,name,form_line,deductible,created) VALUES ${DEFAULT_CATEGORIES.map(([cid, name, line, d]) => `(${quote(cid)},${quote(name)},${quote(line)},${d},'2026-10-17T00:00:00.000Z')`).join(",")};`,
  },
];
export const EXPORT_TARGETS = ["xero", "quickbooks", "bukku", "sqlaccount", "autocount"];
export const DEFAULT_SETTINGS = {
  poPrefix: "PO",
  poTerms: "Please quote this purchase order number on your invoice and delivery order.",
  cashBalance: null,
  cashDate: null,
  exportDateFormat: "DD/MM/YYYY",
  accounts: { xero: "200", quickbooks: "Sales", bukku: "Sales", sqlaccount: "500-000", autocount: "500-0000" },
  // Tax codes for each SST rate (0, 5, 6, 8, 10%) in each package. Defaults follow
  // each vendor's published SST code lists; check them against your own setup.
  taxCodes: {
    xero: { 0: "Tax Exempt", 5: "Sales Tax 5%", 6: "Service Tax 6%", 8: "Service Tax 8%", 10: "Sales Tax 10%" },
    quickbooks: { 0: "Exempt", 5: "Sales Tax 5%", 6: "Service Tax 6%", 8: "Service Tax 8%", 10: "Sales Tax 10%" },
    bukku: { 0: "", 5: "SL5", 6: "SV6", 8: "SV8", 10: "SL10" },
    sqlaccount: { 0: "", 5: "ST5", 6: "SV", 8: "SV", 10: "ST" },
    autocount: { 0: "", 5: "S-5", 6: "SV-6", 8: "SV-8", 10: "S-10" },
  },
};
export const PAYMENT_METHODS = ["Bank transfer", "Card", "Cash", "Cheque", "E-wallet", "Direct debit", "Other"];
const RESERVED_PREFIXES = ["CN", "DN", "RC", "RF", "BILL"];
const json = (v) => JSON.parse(v);
const optional = (v) => (v === undefined || v === null || v === "" ? null : v);
const emailOk = (e) => !e || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// Lines for purchase orders and supplier bills: description, category, quantity,
// rate and SST rate. A supplier's own tax figure may be entered per line.
export function purchaseLines(items, categoryIds) {
  check(Array.isArray(items) && items.length > 0 && items.length <= 50, "Add between 1 and 50 lines.");
  const lines = items.map((i) => {
    check(i && typeof i === "object", "Invalid line.");
    const description = text(i.description, 240, true);
    const q = String(i.quantity ?? 1);
    check(/^\d{1,5}(\.\d{1,2})?$/.test(q) && Number(q) > 0, "Quantity must be positive with at most 2 decimal places.");
    const quantity = Math.round(Number(q) * 100);
    const rate = money(i.rate);
    const amount = Math.round((rate * quantity) / 100);
    check(amount <= 9999999999, "Line total is too large.");
    const tax_rate = Number(i.tax_rate ?? 0);
    check(TAX_RATES.includes(tax_rate), "Choose an SST rate of 0, 5, 6, 8 or 10%.");
    const tax = optional(i.tax) === null ? Math.round((amount * tax_rate) / 100) : money(i.tax);
    check(tax <= amount, "Line tax cannot exceed the line amount.");
    const category_id = i.category_id || "other";
    check(categoryIds.includes(category_id), "Choose a valid expense category.");
    return { description, category_id, quantity: quantity / 100, rate, amount, tax_rate, tax };
  });
  const subtotal = lines.reduce((s, l) => s + l.amount, 0),
    tax = lines.reduce((s, l) => s + l.tax, 0);
  check(subtotal + tax > 0, "Total must be greater than zero.");
  check(subtotal + tax <= 9999999999, "Total is too large.");
  return { items: lines, subtotal, tax, total: subtotal + tax };
}

export function attachBooks(Store) {
  const originalSaveClient = Store.prototype.saveClient;
  Object.assign(Store.prototype, {
    // Clients can carry their customer code for accounting exports.
    saveClient(b, idv) {
      return this.tx(() => {
        const out = originalSaveClient.call(this, b, idv);
        if (b && typeof b.books_account_code === "string") this.setClientCode(out.id, b.books_account_code);
        return out;
      });
    },
    // ----- settings -----
    booksSettings() {
      const row = this.db.prepare("SELECT data FROM books_settings WHERE id=1").get();
      const saved = row ? json(row.data) : {};
      return {
        ...DEFAULT_SETTINGS,
        ...saved,
        accounts: { ...DEFAULT_SETTINGS.accounts, ...(saved.accounts || {}) },
        taxCodes: Object.fromEntries(
          EXPORT_TARGETS.map((t) => [t, { ...DEFAULT_SETTINGS.taxCodes[t], ...(saved.taxCodes?.[t] || {}) }]),
        ),
      };
    },
    writeBooksSettings(next, action, detail) {
      const before = this.booksSettings();
      this.db
        .prepare("INSERT INTO books_settings(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
        .run(JSON.stringify(next));
      this.audit(action, null, detail, before, this.booksSettings());
      return this.booksSettings();
    },
    saveBooksSettings(b) {
      return this.tx(() => {
        const s = this.booksSettings();
        const next = { ...s };
        if ("poPrefix" in b) {
          const prefix = text(String(b.poPrefix), 12, true).toUpperCase();
          const core = this.settings();
          check(/^[A-Z][A-Z0-9-]{0,11}$/.test(prefix), "Use uppercase letters/numbers for the purchase order prefix.");
          check(
            !RESERVED_PREFIXES.includes(prefix) && prefix !== core.invoicePrefix && prefix !== core.quotePrefix,
            "The purchase order prefix must differ from invoice, quotation, note and receipt prefixes.",
          );
          next.poPrefix = prefix;
        }
        if ("poTerms" in b) next.poTerms = text(String(b.poTerms), 1000);
        if ("exportDateFormat" in b) {
          check(["DD/MM/YYYY", "YYYY-MM-DD", "MM/DD/YYYY"].includes(b.exportDateFormat), "Choose a date format.");
          next.exportDateFormat = b.exportDateFormat;
        }
        if (b.accounts) {
          check(typeof b.accounts === "object", "Invalid account codes.");
          next.accounts = { ...s.accounts };
          for (const t of EXPORT_TARGETS)
            if (t in b.accounts) next.accounts[t] = text(String(b.accounts[t] ?? ""), 40);
        }
        if (b.taxCodes) {
          check(typeof b.taxCodes === "object", "Invalid tax codes.");
          next.taxCodes = { ...s.taxCodes };
          for (const t of EXPORT_TARGETS)
            if (b.taxCodes[t]) {
              next.taxCodes[t] = { ...s.taxCodes[t] };
              for (const r of TAX_RATES)
                if (r in b.taxCodes[t]) next.taxCodes[t][r] = text(String(b.taxCodes[t][r] ?? ""), 40);
            }
        }
        return this.writeBooksSettings(next, "books.settings.changed", "Books settings");
      });
    },
    // The owner's bank balance on a date; the forecast adds money in and out since.
    setCashBalance(b) {
      return this.tx(() => {
        const next = { ...this.booksSettings() };
        if (b.balance === null || b.balance === "") {
          next.cashBalance = null;
          next.cashDate = null;
        } else {
          const raw = String(b.balance).trim();
          const negative = raw.startsWith("-");
          const sen = money(negative ? raw.slice(1) : raw);
          next.cashBalance = negative ? -sen : sen;
          next.cashDate = date(b.date || today());
          check(next.cashDate <= today(), "The balance date cannot be in the future.");
        }
        return this.writeBooksSettings(next, "books.cash.updated", next.cashDate ? `Balance on ${next.cashDate}` : "Cleared");
      });
    },
    // ----- categories -----
    booksCategories() {
      return this.db.prepare("SELECT * FROM books_categories ORDER BY active DESC, lower(name)").all();
    },
    categoryIds(activeOnly = false) {
      return this.db
        .prepare(`SELECT id FROM books_categories ${activeOnly ? "WHERE active=1" : ""}`)
        .all()
        .map((r) => r.id);
    },
    saveCategory(b, cid = null) {
      return this.tx(() => {
        const before = cid ? this.db.prepare("SELECT * FROM books_categories WHERE id=?").get(cid) : null;
        check(!cid || before, "Category not found.", 404);
        const c = {
          id: cid || "c-" + id().slice(0, 8),
          name: text(b.name ?? before?.name, 80, true),
          form_line: b.form_line ?? before?.form_line ?? "other",
          deductible: integer(b.deductible ?? before?.deductible ?? 100, 0, 100),
          account_code: text(String(b.account_code ?? before?.account_code ?? ""), 40),
          active: b.active === undefined ? (before?.active ?? 1) : b.active === true || b.active === "1" || b.active === 1 ? 1 : 0,
          created: before?.created || now(),
        };
        check(FORM_LINE_KEYS.includes(c.form_line), "Choose a Form B / Form P line.");
        check(
          !this.db.prepare("SELECT 1 FROM books_categories WHERE lower(name)=lower(?) AND id!=?").get(c.name, c.id),
          "A category with this name already exists.",
          409,
        );
        if (!c.active) check(c.id !== "other", "The Other expenses category is always available.");
        this.db
          .prepare(
            "INSERT INTO books_categories(id,name,form_line,deductible,account_code,active,created) VALUES(:id,:name,:form_line,:deductible,:account_code,:active,:created) ON CONFLICT(id) DO UPDATE SET name=excluded.name,form_line=excluded.form_line,deductible=excluded.deductible,account_code=excluded.account_code,active=excluded.active",
          )
          .run(c);
        this.audit("books.category.saved", c.id, c.name, before, c);
        return c;
      });
    },
    // ----- vendors -----
    vendors() {
      return this.db.prepare("SELECT * FROM books_vendors ORDER BY archived, lower(name)").all();
    },
    vendor(vid) {
      const v = this.db.prepare("SELECT * FROM books_vendors WHERE id=?").get(vid);
      check(v, "Vendor not found.", 404);
      return v;
    },
    saveVendor(b, vid = null) {
      return this.tx(() => {
        const before = vid ? this.vendor(vid) : null;
        const v = {
          id: vid || id(),
          name: text(b.name, 160, true),
          registration: text(b.registration || "", 40),
          tin: text(b.tin || "", 20).toUpperCase(),
          sst_number: text(b.sst_number || "", 40).toUpperCase(),
          contact: text(b.contact || "", 120),
          email: text(b.email || "", 160),
          phone: text(b.phone || "", 60),
          address: text(b.address || "", 600),
          default_category: optional(b.default_category),
          terms: integer(b.terms ?? before?.terms ?? 30, 0, 365),
          archived: before?.archived || 0,
          created: before?.created || now(),
          updated: now(),
        };
        check(emailOk(v.email), "Enter a valid email.");
        if (v.default_category) check(this.categoryIds().includes(v.default_category), "Choose a valid category.");
        check(
          !this.db.prepare("SELECT 1 FROM books_vendors WHERE lower(name)=lower(?) AND id!=? AND archived=0").get(v.name, v.id),
          "A vendor with this name already exists.",
          409,
        );
        this.db
          .prepare(
            "INSERT INTO books_vendors(id,name,registration,tin,sst_number,contact,email,phone,address,default_category,terms,archived,created,updated) VALUES(:id,:name,:registration,:tin,:sst_number,:contact,:email,:phone,:address,:default_category,:terms,:archived,:created,:updated) ON CONFLICT(id) DO UPDATE SET name=excluded.name,registration=excluded.registration,tin=excluded.tin,sst_number=excluded.sst_number,contact=excluded.contact,email=excluded.email,phone=excluded.phone,address=excluded.address,default_category=excluded.default_category,terms=excluded.terms,updated=excluded.updated",
          )
          .run(v);
        this.audit(before ? "books.vendor.changed" : "books.vendor.created", v.id, v.name, before, v);
        return this.vendor(v.id);
      });
    },
    archiveVendor(vid, archived) {
      return this.tx(() => {
        const v = this.vendor(vid);
        check(typeof archived === "boolean", "Choose archive or restore.");
        this.db.prepare("UPDATE books_vendors SET archived=?,updated=? WHERE id=?").run(archived ? 1 : 0, now(), vid);
        this.audit(archived ? "books.vendor.archived" : "books.vendor.restored", vid, v.name, { archived: v.archived }, { archived: archived ? 1 : 0 });
        return this.vendor(vid);
      });
    },
    deleteVendor(vid) {
      return this.tx(() => {
        const v = this.vendor(vid);
        for (const [table, label] of [
          ["books_expenses", "expenses"],
          ["books_bills", "bills"],
          ["books_pos", "purchase orders"],
          ["books_recurring", "recurring costs"],
        ])
          check(!this.db.prepare(`SELECT 1 FROM ${table} WHERE vendor_id=?`).get(vid), `This vendor has ${label}. Archive it instead.`, 409);
        this.db.prepare("DELETE FROM books_vendors WHERE id=?").run(vid);
        this.removeRecordFiles(vid, "books_vendor");
        this.audit("books.vendor.deleted", vid, v.name, v, null);
      });
    },
    // ----- expenses -----
    expense(eid) {
      const e = this.db
        .prepare("SELECT e.*,b.number bill_number FROM books_expenses e LEFT JOIN books_bills b ON b.id=e.bill_id WHERE e.id=?")
        .get(eid);
      check(e, "Expense not found.", 404);
      return { ...e, files: this.files("books_expense", eid) };
    },
    expenses(q = {}) {
      const where = [],
        args = [];
      if (q.from) where.push("e.date>=?"), args.push(date(q.from));
      if (q.to) where.push("e.date<=?"), args.push(date(q.to));
      if (q.category) where.push("e.category_id=?"), args.push(String(q.category));
      if (q.vendor) where.push("e.vendor_id=?"), args.push(String(q.vendor));
      if (q.status === "paid" || q.status === "unpaid") where.push("e.status=?"), args.push(q.status);
      if (q.bill === "linked") where.push("e.bill_id IS NOT NULL");
      if (q.bill === "none") where.push("e.bill_id IS NULL");
      if (q.q) {
        const like = "%" + String(q.q).toLowerCase().slice(0, 120).replace(/[%_\\]/g, (c) => "\\" + c) + "%";
        where.push("(lower(e.vendor_name) LIKE ? ESCAPE '\\' OR lower(e.description) LIKE ? ESCAPE '\\' OR lower(e.reference) LIKE ? ESCAPE '\\' OR lower(e.notes) LIKE ? ESCAPE '\\')");
        args.push(like, like, like, like);
      }
      const sql = `FROM books_expenses e LEFT JOIN books_bills b ON b.id=e.bill_id ${where.length ? "WHERE " + where.join(" AND ") : ""}`;
      const sum = this.db
        .prepare(`SELECT count(*) n, COALESCE(sum(e.amount),0) amount, COALESCE(sum(e.tax),0) tax, COALESCE(sum(CASE WHEN e.status='unpaid' THEN e.amount ELSE 0 END),0) unpaid ${sql}`)
        .get(...args);
      const limit = Math.min(Math.max(Number(q.limit) || 50, 1), q.all ? 100000 : 200);
      const offset = Math.max(Number(q.offset) || 0, 0);
      const rows = this.db
        .prepare(`SELECT e.*,b.number bill_number ${sql} ORDER BY e.date DESC, e.created DESC LIMIT ? OFFSET ?`)
        .all(...args, limit, offset);
      const files = this.db.prepare("SELECT count(*) n FROM files WHERE entity_type='books_expense' AND entity_id=?");
      return {
        total: sum.n,
        sum: { amount: sum.amount, tax: sum.tax, unpaid: sum.unpaid },
        limit,
        offset,
        items: rows.map((e) => ({ ...e, file_count: files.get(e.id).n })),
      };
    },
    allExpenses() {
      return this.db.prepare("SELECT * FROM books_expenses ORDER BY date, created").all();
    },
    saveExpense(b, eid = null) {
      return this.tx(() => {
        const before = eid ? this.db.prepare("SELECT * FROM books_expenses WHERE id=?").get(eid) : null;
        check(!eid || before, "Expense not found.", 404);
        const e = {
          id: eid || id(),
          date: date(b.date),
          vendor_id: optional(b.vendor_id),
          vendor_name: text(b.vendor_name || "", 160),
          category_id: optional(b.category_id),
          description: text(b.description || "", 240),
          amount: money(b.amount),
          tax: money(b.tax || 0),
          payment_method: text(b.payment_method || "", 40),
          status: b.status === "unpaid" ? "unpaid" : "paid",
          paid_date: null,
          due_date: null,
          reference: text(b.reference || "", 120),
          notes: text(b.notes || "", 1000),
          bill_id: optional(b.bill_id),
          scan_id: before?.scan_id || null,
          created: before?.created || now(),
          updated: now(),
        };
        check(e.date <= today(), "The expense date cannot be in the future.");
        check(e.amount > 0, "Enter the amount paid or owed.");
        check(e.tax <= e.amount, "SST or tax paid cannot exceed the amount.");
        let bill = null;
        if (e.bill_id) {
          bill = this.bill(e.bill_id);
          check(bill.state === "open", "This bill is void.", 409);
          e.vendor_id = bill.vendor_id;
          e.category_id = e.category_id || bill.items[0]?.category_id || "other";
          e.status = "paid";
          const already = bill.paid - (before?.bill_id === bill.id ? before.amount : 0);
          check(e.amount <= bill.total - already, "This payment is more than the bill's remaining balance.", 409);
        }
        if (e.vendor_id) {
          const v = this.vendor(e.vendor_id);
          if (!before || before.vendor_id !== e.vendor_id) check(!v.archived, "This vendor is archived. Restore it first.", 409);
          e.vendor_name = v.name;
          e.category_id = e.category_id || v.default_category;
        }
        check(e.vendor_name || e.description, "Enter a vendor or a description.");
        e.category_id = e.category_id || "other";
        const active = this.categoryIds(true);
        check(
          active.includes(e.category_id) || (before && before.category_id === e.category_id),
          "Choose an active expense category.",
        );
        if (e.status === "paid") {
          e.paid_date = date(b.paid_date || e.date);
          check(e.paid_date <= today(), "The payment date cannot be in the future.");
          check(PAYMENT_METHODS.includes(e.payment_method), "Choose how it was paid.");
        } else {
          e.due_date = date(b.due_date || e.date);
          check(e.due_date >= e.date, "The due date must be on or after the expense date.");
          check(!e.payment_method || PAYMENT_METHODS.includes(e.payment_method), "Choose a valid payment method.");
        }
        // The same receipt entered twice (e.g. scanned again) is refused unless confirmed.
        if (e.reference && b.allow_duplicate !== true)
          check(
            !this.db
              .prepare("SELECT 1 FROM books_expenses WHERE id!=? AND lower(vendor_name)=lower(?) AND date=? AND amount=? AND lower(reference)=lower(?)")
              .get(e.id, e.vendor_name, e.date, e.amount, e.reference),
            "An expense with the same vendor, date, amount and reference already exists.",
            409,
          );
        let scan = null;
        if (!before && b.scan_id) {
          scan = this.scan(b.scan_id);
          check(["uploaded", "extracted", "failed"].includes(scan.state), "This scan was already used or discarded.", 409);
          e.scan_id = scan.id;
        }
        this.db
          .prepare(
            "INSERT INTO books_expenses(id,date,vendor_id,vendor_name,category_id,description,amount,tax,payment_method,status,paid_date,due_date,reference,notes,bill_id,scan_id,created,updated) VALUES(:id,:date,:vendor_id,:vendor_name,:category_id,:description,:amount,:tax,:payment_method,:status,:paid_date,:due_date,:reference,:notes,:bill_id,:scan_id,:created,:updated) ON CONFLICT(id) DO UPDATE SET date=excluded.date,vendor_id=excluded.vendor_id,vendor_name=excluded.vendor_name,category_id=excluded.category_id,description=excluded.description,amount=excluded.amount,tax=excluded.tax,payment_method=excluded.payment_method,status=excluded.status,paid_date=excluded.paid_date,due_date=excluded.due_date,reference=excluded.reference,notes=excluded.notes,bill_id=excluded.bill_id,updated=excluded.updated",
          )
          .run(e);
        if (scan) {
          // The scanned file becomes the expense's receipt; the owner confirmed the draft.
          this.db
            .prepare("UPDATE files SET entity_type='books_expense',entity_id=?,purpose='receipt' WHERE id=? AND entity_type='books_scan'")
            .run(e.id, scan.file_id);
          this.db.prepare("UPDATE books_scans SET state='confirmed',expense_id=?,updated=? WHERE id=?").run(e.id, now(), scan.id);
          this.audit("books.scan.confirmed", scan.id, `Expense ${e.id}`);
        }
        const { created, updated, ...after } = e;
        this.audit(
          before ? "books.expense.changed" : e.bill_id ? "books.bill.paid" : "books.expense.created",
          e.id,
          `${e.vendor_name || e.description}: ${e.amount} sen`,
          before ? (({ created: _c, updated: _u, ...rest }) => rest)(before) : null,
          after,
        );
        return this.expense(e.id);
      });
    },
    payExpense(eid, b) {
      return this.tx(() => {
        const e = this.expense(eid);
        check(e.status === "unpaid", "This expense is already paid.", 409);
        return this.saveExpense({ ...e, amount: (e.amount / 100).toFixed(2), tax: (e.tax / 100).toFixed(2), status: "paid", paid_date: b.paid_date || today(), payment_method: b.payment_method, reference: b.reference ?? e.reference, allow_duplicate: true }, eid);
      });
    },
    deleteExpense(eid, reason) {
      return this.tx(() => {
        const e = this.db.prepare("SELECT * FROM books_expenses WHERE id=?").get(eid);
        check(e, "Expense not found.", 404);
        reason = text(reason || "", 500, true);
        this.removeRecordFiles(eid, "books_expense");
        this.db.prepare("DELETE FROM books_expenses WHERE id=?").run(eid);
        this.audit(e.bill_id ? "books.bill.payment.deleted" : "books.expense.deleted", eid, reason, e, null);
      });
    },
    // ----- supplier bills -----
    hydrateBill(row) {
      const payments = this.db
        .prepare("SELECT id,date,paid_date,amount,payment_method,reference FROM books_expenses WHERE bill_id=? ORDER BY paid_date,created")
        .all(row.id);
      const paid = payments.reduce((s, p) => s + p.amount, 0);
      const balance = row.state === "void" ? 0 : Math.max(0, row.total - paid);
      const vendor = json(row.vendor_snapshot);
      return {
        ...row,
        items: json(row.items),
        vendor,
        vendor_name: vendor.name,
        payments,
        paid,
        balance,
        status:
          row.state === "void"
            ? "Void"
            : balance === 0
              ? "Paid"
              : row.due_date < today()
                ? "Overdue"
                : paid > 0
                  ? "Part-paid"
                  : "Unpaid",
      };
    },
    bill(bid) {
      const row = this.db.prepare("SELECT * FROM books_bills WHERE id=?").get(bid);
      check(row, "Bill not found.", 404);
      return this.hydrateBill(row);
    },
    bills() {
      return this.db
        .prepare("SELECT * FROM books_bills ORDER BY bill_date DESC, created DESC")
        .all()
        .map((r) => this.hydrateBill(r));
    },
    saveBill(b, bid = null) {
      return this.tx(() => {
        const before = bid ? this.bill(bid) : null;
        if (before) {
          check(before.state === "open", "This bill is void.", 409);
          check(before.paid === 0, "Remove the bill's payments before changing it.", 409);
        }
        const vendor = this.vendor(b.vendor_id || before?.vendor_id);
        if (!before || before.vendor_id !== vendor.id) check(!vendor.archived, "This vendor is archived. Restore it first.", 409);
        const lines = purchaseLines(
          (b.items || []).map((l) => ({ ...l, category_id: l.category_id || vendor.default_category || "other" })),
          this.categoryIds(),
        );
        const bill_date = date(b.bill_date || today());
        check(bill_date <= today(), "The bill date cannot be in the future.");
        const due_date = date(b.due_date || addDays(bill_date, vendor.terms));
        check(due_date >= bill_date, "The due date must be on or after the bill date.");
        const reference = text(b.reference || "", 120);
        if (reference)
          check(
            !this.db.prepare("SELECT 1 FROM books_bills WHERE vendor_id=? AND lower(reference)=lower(?) AND id!=? AND state='open'").get(vendor.id, reference, bid || ""),
            "This supplier invoice number is already recorded for this vendor.",
            409,
          );
        const row = {
          id: bid || id(),
          number: before?.number || this.number("BILL", bill_date),
          vendor_id: vendor.id,
          vendor_snapshot: JSON.stringify({ name: vendor.name, registration: vendor.registration, tin: vendor.tin, sst_number: vendor.sst_number, address: vendor.address, email: vendor.email, contact: vendor.contact }),
          reference,
          bill_date,
          due_date,
          items: JSON.stringify(lines.items),
          subtotal: lines.subtotal,
          tax: lines.tax,
          total: lines.total,
          notes: text(b.notes || "", 2000),
          po_id: before?.po_id || b.po_id || null,
          created: before?.created || now(),
          updated: now(),
        };
        this.db
          .prepare(
            "INSERT INTO books_bills(id,number,vendor_id,vendor_snapshot,reference,bill_date,due_date,items,subtotal,tax,total,notes,po_id,created,updated) VALUES(:id,:number,:vendor_id,:vendor_snapshot,:reference,:bill_date,:due_date,:items,:subtotal,:tax,:total,:notes,:po_id,:created,:updated) ON CONFLICT(id) DO UPDATE SET vendor_id=excluded.vendor_id,vendor_snapshot=excluded.vendor_snapshot,reference=excluded.reference,bill_date=excluded.bill_date,due_date=excluded.due_date,items=excluded.items,subtotal=excluded.subtotal,tax=excluded.tax,total=excluded.total,notes=excluded.notes,updated=excluded.updated",
          )
          .run(row);
        const pick = (x) => x && { vendor_id: x.vendor_id, reference: x.reference, bill_date: x.bill_date, due_date: x.due_date, items: typeof x.items === "string" ? json(x.items) : x.items, total: x.total };
        this.audit(before ? "books.bill.changed" : "books.bill.created", row.id, `${row.number}: ${row.total} sen`, pick(before), pick(row));
        return this.bill(row.id);
      });
    },
    voidBill(bid, reason) {
      return this.tx(() => {
        const bill = this.bill(bid);
        check(bill.state === "open", "This bill is already void.", 409);
        check(bill.paid === 0, "Remove the bill's payments before voiding it.", 409);
        reason = text(reason || "", 500, true);
        // The order can be billed again, so the void bill lets go of it.
        this.db.prepare("UPDATE books_bills SET state='void',void_reason=?,po_id=NULL,updated=? WHERE id=?").run(bill.po_id ? `${reason} (was from a purchase order)` : reason, now(), bid);
        if (bill.po_id) this.db.prepare("UPDATE books_pos SET state='received',bill_id=NULL,updated=? WHERE id=? AND bill_id=?").run(now(), bill.po_id, bid);
        this.audit("books.bill.voided", bid, reason, { state: "open" }, { state: "void" });
        return this.bill(bid);
      });
    },
    // A bill payment is an expense linked to the bill: it is money out on its
    // date, and the bill (not the payment) is the cost in accrual reports.
    payBill(bid, b) {
      return this.tx(() => {
        const bill = this.bill(bid);
        check(bill.state === "open" && bill.balance > 0, "This bill has nothing left to pay.", 409);
        const amount = b.amount === undefined || b.amount === "" ? (bill.balance / 100).toFixed(2) : b.amount;
        const sen = money(amount);
        return this.saveExpense({
          bill_id: bid,
          date: b.paid_date || today(),
          paid_date: b.paid_date || today(),
          status: "paid",
          amount,
          // Informational SST share of this payment.
          tax: (Math.round((bill.tax * Math.min(sen, bill.total)) / bill.total) / 100).toFixed(2),
          description: `Payment for ${bill.number}${bill.reference ? " (" + bill.reference + ")" : ""}`,
          payment_method: b.payment_method,
          reference: b.reference || "",
          notes: b.notes || "",
          category_id: bill.items[0]?.category_id,
          allow_duplicate: true,
        });
      });
    },
    // ----- purchase orders -----
    hydratePo(row) {
      const vendor = row.vendor_snapshot ? json(row.vendor_snapshot) : (() => {
        const v = this.db.prepare("SELECT * FROM books_vendors WHERE id=?").get(row.vendor_id);
        return v ? { name: v.name, registration: v.registration, tin: v.tin, sst_number: v.sst_number, address: v.address, email: v.email, contact: v.contact, phone: v.phone } : { name: "" };
      })();
      return {
        ...row,
        items: json(row.items),
        vendor,
        vendor_name: vendor.name,
        business: row.business_snapshot ? json(row.business_snapshot) : this.settings(),
        bill_number: row.bill_id ? this.db.prepare("SELECT number FROM books_bills WHERE id=?").get(row.bill_id)?.number || null : null,
        emails: this.db.prepare("SELECT id,recipients,subject,status,created FROM email_log WHERE dedupe_key LIKE ? ORDER BY created DESC").all(`books-po:${row.id}:%`),
      };
    },
    po(pid) {
      const row = this.db.prepare("SELECT * FROM books_pos WHERE id=?").get(pid);
      check(row, "Purchase order not found.", 404);
      return this.hydratePo(row);
    },
    pos() {
      return this.db
        .prepare("SELECT * FROM books_pos ORDER BY created DESC")
        .all()
        .map((r) => this.hydratePo(r));
    },
    savePo(b, pid = null) {
      return this.tx(() => {
        const before = pid ? this.po(pid) : null;
        if (before) check(before.state === "draft", "Issued purchase orders are locked. Cancel and create a new one if needed.", 409);
        const vendor = this.vendor(b.vendor_id || before?.vendor_id);
        if (!before || before.vendor_id !== vendor.id) check(!vendor.archived, "This vendor is archived. Restore it first.", 409);
        const lines = purchaseLines(
          (b.items || []).map((l) => ({ ...l, category_id: l.category_id || vendor.default_category || "other" })),
          this.categoryIds(),
        );
        const po_date = date(b.po_date || today());
        const expected_date = optional(b.expected_date) ? date(b.expected_date) : null;
        check(!expected_date || expected_date >= po_date, "The expected date must be on or after the order date.");
        const row = {
          id: pid || id(),
          vendor_id: vendor.id,
          po_date,
          expected_date,
          items: JSON.stringify(lines.items),
          subtotal: lines.subtotal,
          tax: lines.tax,
          total: lines.total,
          notes: text(b.notes || "", 2000),
          terms: text(b.terms ?? this.booksSettings().poTerms, 1000),
          created: before?.created || now(),
          updated: now(),
        };
        this.db
          .prepare(
            "INSERT INTO books_pos(id,vendor_id,po_date,expected_date,items,subtotal,tax,total,notes,terms,created,updated) VALUES(:id,:vendor_id,:po_date,:expected_date,:items,:subtotal,:tax,:total,:notes,:terms,:created,:updated) ON CONFLICT(id) DO UPDATE SET vendor_id=excluded.vendor_id,po_date=excluded.po_date,expected_date=excluded.expected_date,items=excluded.items,subtotal=excluded.subtotal,tax=excluded.tax,total=excluded.total,notes=excluded.notes,terms=excluded.terms,updated=excluded.updated",
          )
          .run(row);
        this.audit(before ? "books.po.changed" : "books.po.created", row.id, `${row.total} sen`, before && { items: before.items, total: before.total, vendor_id: before.vendor_id }, { items: lines.items, total: row.total, vendor_id: row.vendor_id });
        return this.po(row.id);
      });
    },
    issuePo(pid) {
      return this.tx(() => {
        const p = this.po(pid);
        check(p.state === "draft", "This purchase order is already issued.", 409);
        const v = this.vendor(p.vendor_id);
        const prefix = this.booksSettings().poPrefix;
        const number = this.number(prefix, p.po_date);
        check(!this.db.prepare("SELECT 1 FROM books_pos WHERE number=?").get(number), "The next purchase order number is already in use.", 409);
        this.db
          .prepare("UPDATE books_pos SET state='issued',number=?,vendor_snapshot=?,business_snapshot=?,issued_at=?,updated=? WHERE id=?")
          .run(
            number,
            JSON.stringify({ name: v.name, registration: v.registration, tin: v.tin, sst_number: v.sst_number, address: v.address, email: v.email, contact: v.contact, phone: v.phone }),
            JSON.stringify(this.settings()),
            now(),
            now(),
            pid,
          );
        this.audit("books.po.issued", pid, number);
        return this.po(pid);
      });
    },
    receivePo(pid) {
      return this.tx(() => {
        const p = this.po(pid);
        check(p.state === "issued", "Only an issued purchase order can be marked received.", 409);
        this.db.prepare("UPDATE books_pos SET state='received',received_at=?,updated=? WHERE id=?").run(now(), now(), pid);
        this.audit("books.po.received", pid, p.number);
        return this.po(pid);
      });
    },
    cancelPo(pid, reason) {
      return this.tx(() => {
        const p = this.po(pid);
        check(["draft", "issued", "received"].includes(p.state), "This purchase order cannot be cancelled.", 409);
        reason = text(reason || "", 500, true);
        this.db.prepare("UPDATE books_pos SET state='cancelled',cancel_reason=?,updated=? WHERE id=?").run(reason, now(), pid);
        this.audit("books.po.cancelled", pid, reason, { state: p.state }, { state: "cancelled" });
        return this.po(pid);
      });
    },
    // Converts a received (or issued) order into one supplier bill. Repeating the
    // conversion returns the same bill.
    billFromPo(pid, b = {}) {
      return this.tx(() => {
        const p = this.po(pid);
        if (p.bill_id) return this.bill(p.bill_id);
        check(["issued", "received"].includes(p.state), "Issue the purchase order before converting it to a bill.", 409);
        const bill = this.saveBill({
          vendor_id: p.vendor_id,
          bill_date: b.bill_date || today(),
          due_date: b.due_date || undefined,
          reference: b.reference || "",
          notes: b.notes || `From purchase order ${p.number}`,
          po_id: p.id,
          items: p.items.map((l) => ({ description: l.description, category_id: l.category_id, quantity: String(l.quantity), rate: (l.rate / 100).toFixed(2), tax_rate: l.tax_rate, tax: (l.tax / 100).toFixed(2) })),
        });
        this.db.prepare("UPDATE books_pos SET state='billed',bill_id=?,updated=? WHERE id=?").run(bill.id, now(), pid);
        this.audit("books.po.billed", pid, bill.number);
        return bill;
      });
    },
    // ----- recurring costs (forecast only) -----
    recurringCosts() {
      return this.db.prepare("SELECT * FROM books_recurring ORDER BY active DESC, next_date").all();
    },
    saveRecurringCost(b, rid = null) {
      return this.tx(() => {
        const before = rid ? this.db.prepare("SELECT * FROM books_recurring WHERE id=?").get(rid) : null;
        check(!rid || before, "Recurring cost not found.", 404);
        const r = {
          id: rid || id(),
          name: text(b.name, 160, true),
          vendor_id: optional(b.vendor_id),
          category_id: b.category_id || "other",
          amount: money(b.amount),
          every: b.every,
          next_date: date(b.next_date),
          active: b.active === false || b.active === "0" ? 0 : 1,
          created: before?.created || now(),
          updated: now(),
        };
        check(r.amount > 0, "Enter the amount.");
        check(["week", "month", "quarter", "year"].includes(r.every), "Choose how often it repeats.");
        check(this.categoryIds().includes(r.category_id), "Choose a valid category.");
        if (r.vendor_id) this.vendor(r.vendor_id);
        this.db
          .prepare(
            "INSERT INTO books_recurring(id,name,vendor_id,category_id,amount,every,next_date,active,created,updated) VALUES(:id,:name,:vendor_id,:category_id,:amount,:every,:next_date,:active,:created,:updated) ON CONFLICT(id) DO UPDATE SET name=excluded.name,vendor_id=excluded.vendor_id,category_id=excluded.category_id,amount=excluded.amount,every=excluded.every,next_date=excluded.next_date,active=excluded.active,updated=excluded.updated",
          )
          .run(r);
        this.audit(before ? "books.recurring.changed" : "books.recurring.created", r.id, r.name, before, r);
        return r;
      });
    },
    deleteRecurringCost(rid) {
      return this.tx(() => {
        const r = this.db.prepare("SELECT * FROM books_recurring WHERE id=?").get(rid);
        check(r, "Recurring cost not found.", 404);
        this.db.prepare("DELETE FROM books_recurring WHERE id=?").run(rid);
        this.audit("books.recurring.deleted", rid, r.name, r, null);
      });
    },
    // ----- receipt scans -----
    scan(sid) {
      const s = this.db.prepare("SELECT * FROM books_scans WHERE id=?").get(sid);
      check(s, "Scan not found.", 404);
      const file = this.db.prepare("SELECT id,name,mime,size FROM files WHERE id=?").get(s.file_id) || null;
      return { ...s, draft: s.draft ? json(s.draft) : null, file };
    },
    createScan({ data, name }) {
      return this.tx(() => {
        const sid = id();
        const f = this.saveFile(
          { entity_type: "books_scan", entity_id: sid, purpose: "receipt", name: name || "receipt", data },
          { accept: ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"] },
        );
        this.db.prepare("INSERT INTO books_scans(id,file_id,state,created,updated) VALUES(?,?,'uploaded',?,?)").run(sid, f.id, now(), now());
        this.audit("books.scan.uploaded", sid, f.name);
        return this.scan(sid);
      });
    },
    setScanState(sid, state, fields = {}) {
      this.db
        .prepare("UPDATE books_scans SET state=?,draft=COALESCE(?,draft),model=COALESCE(?,model),error=?,updated=? WHERE id=?")
        .run(state, fields.draft ? JSON.stringify(fields.draft) : null, fields.model || null, fields.error || null, now(), sid);
      return this.scan(sid);
    },
    discardScan(sid) {
      return this.tx(() => {
        const s = this.scan(sid);
        check(s.state !== "confirmed", "This scan is already an expense. Delete the expense instead.", 409);
        if (s.file && this.db.prepare("SELECT 1 FROM files WHERE id=? AND entity_type='books_scan'").get(s.file.id)) this.deleteFile(s.file.id);
        this.db.prepare("UPDATE books_scans SET state='discarded',draft=NULL,updated=? WHERE id=?").run(now(), sid);
        this.audit("books.scan.discarded", sid, "");
      });
    },
    // Files of scans that were never confirmed are removed after `days`.
    purgeScans(days = 14) {
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      const old = this.db.prepare("SELECT id FROM books_scans WHERE state NOT IN ('confirmed','discarded') AND updated<?").all(cutoff);
      for (const s of old) this.discardScan(s.id);
      return { removed: old.length };
    },
    // Files attached to a record being deleted go with it. Uses the core
    // deleteFilesFor when the workspace has it.
    removeRecordFiles(entityId, entityType) {
      if (typeof this.deleteFilesFor === "function") return this.deleteFilesFor(entityId);
      const list = this.files(entityType, entityId);
      for (const f of list) this.deleteFile(f.id);
      return list.length;
    },
    // ----- client codes for accounting exports -----
    clientCodes() {
      return Object.fromEntries(this.db.prepare("SELECT client_id,code FROM books_client_codes").all().map((r) => [r.client_id, r.code]));
    },
    setClientCode(cid, code) {
      code = text(String(code || ""), 20).toUpperCase();
      const before = this.db.prepare("SELECT code FROM books_client_codes WHERE client_id=?").get(cid)?.code || "";
      if (code === before) return;
      if (!code) this.db.prepare("DELETE FROM books_client_codes WHERE client_id=?").run(cid);
      else {
        check(/^[A-Z0-9][A-Z0-9/-]{0,19}$/.test(code), "Accounting codes use letters, numbers, - and /.");
        check(!this.db.prepare("SELECT 1 FROM books_client_codes WHERE code=? AND client_id!=?").get(code, cid), "Another client already uses this accounting code.", 409);
        this.db
          .prepare("INSERT INTO books_client_codes(client_id,code) VALUES(?,?) ON CONFLICT(client_id) DO UPDATE SET code=excluded.code")
          .run(cid, code);
      }
      this.audit("books.client_code.changed", cid, code || "cleared", { code: before }, { code });
    },
    // Codes for clients without one, e.g. 300-A0001, assigned once and kept.
    ensureClientCodes(ids) {
      return this.tx(() => {
        const codes = this.clientCodes();
        const used = new Set(Object.values(codes));
        for (const cid of ids) {
          if (codes[cid]) continue;
          const c = this.client(cid);
          const letter = (c.name.match(/[A-Za-z]/)?.[0] || "X").toUpperCase();
          let n = 1,
            code;
          do code = `300-${letter}${String(n++).padStart(4, "0")}`;
          while (used.has(code));
          used.add(code);
          codes[cid] = code;
          this.db.prepare("INSERT INTO books_client_codes(client_id,code) VALUES(?,?)").run(cid, code);
          this.audit("books.client_code.assigned", cid, code);
        }
        return codes;
      });
    },
    // ----- reports -----
    booksInputs() {
      const docs = this.documents();
      const runs = new Set(this.db.prepare("SELECT invoice_id FROM schedule_runs").all().map((r) => r.invoice_id));
      return {
        docs,
        receipts: this.receipts(),
        services: this.db.prepare("SELECT * FROM services").all(),
        clients: this.db.prepare("SELECT * FROM clients").all(),
        schedules: this.db.prepare("SELECT * FROM schedules").all(),
        expenses: this.allExpenses(),
        bills: this.bills(),
        pos: this.pos(),
        recurring: this.recurringCosts(),
        categories: this.booksCategories(),
        scheduledDrafts: docs.filter((d) => d.kind === "invoice" && d.state === "draft" && runs.has(d.id)),
      };
    },
    salesReport(q = {}) {
      const { from, to } = period(q);
      const i = this.booksInputs();
      return salesReport({ ...i, from, to });
    },
    profitAndLoss(q = {}) {
      const { from, to } = period(q);
      const i = this.booksInputs();
      return profitAndLoss({ ...i, from, to });
    },
    taxSummary(q = {}) {
      const year = integer(q.year ?? Number(today().slice(0, 4)) - 1, 2000, 2100);
      const i = this.booksInputs();
      const pnl = profitAndLoss({ ...i, from: `${year}-01-01`, to: `${year}-12-31` });
      return taxSummary({ pnl, categories: i.categories, year });
    },
    // Late payment prediction, the 13-week forecast and cash health together,
    // because each builds on the previous one.
    cashPicture(asOf = today()) {
      const i = this.booksInputs();
      const s = this.booksSettings();
      const lateness = latePayment({ docs: i.docs, asOf });
      const forecast = cashForecast({ ...i, lateness, cashBalance: s.cashBalance, cashDate: s.cashDate, asOf });
      const health = cashHealth({ forecast, expenses: i.expenses, lateness, asOf });
      return { lateness, forecast, health };
    },
  });
}
// Report periods default to the current calendar year to date.
export function period(q = {}) {
  const t = today();
  const to = q.to ? date(q.to) : t;
  const from = q.from ? date(q.from) : `${to.slice(0, 4)}-01-01`;
  check(from <= to, "Choose a valid report period.");
  check(Date.parse(to) - Date.parse(from) <= 6 * 366 * 86400000, "Choose a period of up to 6 years.");
  return { from, to };
}
