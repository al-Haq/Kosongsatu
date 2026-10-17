# Books: expenses, bills and reports

The **Books** group in the sidebar covers money going out and the reports built from your invoices, receipts and expenses:

- **Expenses**: costs and receipts, vendors and expense categories.
- **Bills & POs**: supplier bills, purchase orders and recurring costs.
- **Reports**: sales, profit and loss, cash flow forecast, late payers, the annual income tax summary and exports for accounting software.

It also adds a **Cash health** panel to the Overview, a **Payment behaviour** panel to each client profile and a **Payment forecast** panel to each open invoice.

Everything works without any external account. Only receipt reading with AI (feature 56) needs your own AI model.

All amounts are in MYR. If an invoice carries a `currency` and `fx_rate` (MYR per 1 unit), its figures are converted with that rate per document; receipts follow the rate of the invoices they were allocated to.

---

## 55. Expenses and vendor receipts

**Expenses** lists every cost: date, vendor, category, description, amount, SST or tax paid (included in the amount), paid or unpaid, payment method, due date, reference and notes.

- **New expense**: enter the details. Choose *Not paid yet* for a cost you owe; it then needs a due date and shows in the cash flow forecast until you press **Mark paid**.
- **Receipts**: attach a photo or PDF (PNG, JPEG, WEBP, GIF or PDF, up to 5 MB). Files are stored privately inside the database, so encrypted backups include them. They are never shown on client links.
- **Filters**: period, category, vendor, paid/unpaid and a search over vendor, description, reference and notes. **Export CSV** downloads the filtered list (with vendor registration, TIN and category account code).
- **Edit** keeps a before/after copy in the audit history. **Delete** asks for a reason, removes the attached files and keeps the deleted record in the audit history.
- The same receipt entered twice (same vendor, date, amount and reference) is refused unless you tick *This is a separate expense*.

**Vendors** (Expenses > Vendors): name, SSM registration, TIN, SST number, contact, email, phone, address, a default category and payment terms. A vendor with history can be archived but not deleted.

**Categories** (Expenses > Categories): 22 small-business categories to start with (rent, internet and phone, software, subcontractors, salaries/EPF/SOCSO/EIS, travel, meals and entertainment, equipment, fines and so on). Rename them, add your own or mark them inactive. Each category also has:

- the **Form B / Form P line** it belongs to (used by the tax summary),
- how much of it is **tax deductible** (for example 50% for entertainment, 0% for fines and capital equipment),
- an optional **account code** for your accountant.

## 56. Receipt scanning

Press **Scan receipt**, choose a photo or PDF, and the expense form opens next to the image.

- **Without an AI model** you type the details while looking at the receipt. The file becomes the expense's receipt when you save.
- **With an AI model** a **Read with AI** button appears. The box above it says exactly what is sent: the file (name and size) and your category names, to your provider's address, with the model name. The model's answer fills in the vendor, date, total, tax, reference, description and category. Every value is checked like typed input (unclear dates or totals are left empty, a tax larger than the total is dropped, a receipt in another currency is flagged).
- **Nothing is saved until you press Save.** The model never creates an expense. Text from the receipt is treated as data only.
- The vendor is matched to a saved vendor by registration number or exact name, and that vendor's default category is used if the model gave none.
- Uploaded receipts that are never saved as an expense are deleted automatically after 14 days (background job `books:scan-cleanup`, runs daily).

**To turn it on**, set these on the server (the same settings as the built-in assistant, see [AUTOMATION.md](../AUTOMATION.md)):

| Setting | What |
|---|---|
| `AI_BASE_URL` | Your OpenAI-compatible provider, e.g. `https://api.openai.com/v1` or a local `http://127.0.0.1:11434/v1` |
| `AI_MODEL` | The model name |
| `AI_API_KEY` | The key, if your provider needs one |
| `BOOKS_VISION_MODEL` | Optional, in Settings > Integration keys: a different, image-capable model at the same provider for receipts |

The model must be able to read images. Images are sent as a `data:` URL in an `image_url` message part. PDFs are sent as a `file` part, which not every provider accepts; if yours refuses, upload a photo or screenshot instead. Requests go only to the configured provider, with a 60-second limit.

## 64. Supplier purchase orders and bills

**Purchase orders** (Bills & POs > Purchase orders):

1. **New purchase order**: vendor, order date, optional needed-by date, lines (description, category, quantity, rate, SST) and terms. It is a draft and can be edited.
2. **Issue order** gives it the next number, `PO-2026-00001` (the prefix can be changed in Settings > Books) and locks it. Issuing sends nothing.
3. **PDF** downloads a branded purchase order. **Email** sends it with the PDF attached through your SMTP server (only shown when email is configured). A retried send goes out once.
4. **Mark received** when the goods or service arrive.
5. **Convert to bill** creates one supplier bill with the order's lines. Converting again opens the same bill. Cancelled orders cannot be billed.

**Supplier bills** (Bills & POs > Supplier bills): vendor, the supplier's invoice number, bill date, due date (defaults to the vendor's terms), lines with categories and SST, notes and attachments (the supplier's invoice as a photo or PDF).

- **Record payment** records an amount, date, method and bank reference. Each payment is saved as an **expense linked to the bill** (shown with the bill number in Expenses). The bill shows Unpaid, Part-paid, Paid or Overdue.
- You can also link an expense to a bill yourself with *This pays a supplier bill* on the expense form.
- A payment can never be more than the bill's remaining balance. A bill with payments cannot be edited or voided until the payments are removed. The same supplier invoice number cannot be recorded twice for one vendor.

**No double counting:** in accrual reports a bill counts once, on its bill date, split by its line categories; its payments are not added again. In cash reports only the payments count, on the date paid, split by the bill's categories. The cash flow forecast uses only the bill's remaining balance.

**Recurring costs** (Bills & POs > Recurring costs): rent, salaries or subscriptions with an amount and how often they repeat (weekly, monthly, quarterly, yearly). They are used only by the cash flow forecast and never create expenses.

## 57. Sales reports

Reports > Sales, for any period (quick buttons for this month, last month, this year, last year and the last 12 months):

- **By client**, **by service / item** and **by month**, each with invoiced and collected amounts and simple bars.
- **Invoiced** = issued invoices by issue date, plus debit notes and less credit notes by note date, including SST (the SST column shows how much).
- **Collected** = money received less refunds, by date (the same figure as "Net customer cash" on the Overview).
- Services are grouped by the line's SKU or catalog service when it has one, otherwise by the catalog service whose name matches the description, otherwise by description (a trailing ` - 2026-10` period from recurring drafts is ignored).
- Credit/debit notes and payments are shared across an invoice's lines in proportion. Money received but not applied to an invoice (customer funds, refunds) is shown on its own row, so every view adds up to the same totals.
- **CSV** downloads the view you are looking at.

## 58. Profit and loss

Reports > Profit & loss shows both bases side by side, by category and by month:

- **Accrual**: issued invoices by issue date and credit/debit notes by note date, **excluding SST** (SST is owed to customs and shown as a memo line); expenses by expense date; supplier bills by bill date.
- **Cash**: money received less refunds; expenses and bill payments on the date they were paid (including SST paid).

Download it as **PDF** or **CSV**. It is clearly marked as a **management report, not audited accounts**. Equipment bought is shown as a cost here; your accountant may capitalise it.

## 59. Exports for accounting software

Reports > Exports downloads CSV files of the issued invoices in a period, and of your clients:

| Package | Files | How sure we are of the format |
|---|---|---|
| Xero | Sales invoices, Contacts | Follows Xero's published sales invoice and contact import templates |
| QuickBooks Online | Invoices | Follows Intuit's invoice import guide; QuickBooks maps columns during import |
| Bukku | Sales invoices, Customers | **Closest documented format** |
| SQL Account | Sales invoices, Customers | **Closest documented format** |
| AutoCount Accounting | A/R invoices, Debtors | **Closest documented format** |

We could not open the vendors' official template files while building this, so the formats were put together from published help pages and import specifications. Each card on the Exports screen says how sure we are. Before a large import, export one or two invoices and compare them with the template your software gives you.

Common rules:

- One row per invoice line. A document discount becomes one extra **Discount** line per SST rate, and the line tax amounts are set so they add up to the invoice's SST exactly.
- Dates: Xero, QuickBooks and Bukku use the date format chosen on the Exports screen (default DD/MM/YYYY). SQL Account and AutoCount always use DD/MM/YYYY, as their import specifications require.
- Payments, credit notes and debit notes are not exported. Record them in your accounting software (or import your bank statement there).
- **Account and tax codes** are editable on the Exports screen: a sales account for each package and a tax code for each SST rate (0, 5, 6, 8, 10%). Defaults: Xero `200` and `Service Tax 8%` style names; QuickBooks `Sales`; Bukku `SL5`, `SV6`, `SV8`, `SL10`; SQL Account `500-000`, `ST5`, `SV`, `ST`; AutoCount `500-0000`, `S-5`, `SV-6`, `SV-8`, `S-10`. These follow each vendor's published SST code list; check them against your own setup.
- **Customer codes**: each client can have an *Accounting code* (Edit client). Clients without one get a code like `300-A0001` the first time they are exported, and keep it.

Column mapping:

**Xero sales invoices**: `*ContactName` client name · `EmailAddress` client email · `POAddressLine1`–`4` client address split by lines · `*InvoiceNumber` · `Reference` (blank) · `*InvoiceDate` · `*DueDate` · `Total` invoice total · `InventoryItemCode` (blank, so Xero does not need matching items) · `*Description` · `*Quantity` · `*UnitAmount` line rate · `Discount` (blank; discounts are separate lines) · `*AccountCode` your sales account · `*TaxType` the tax code for the line's SST rate · `TaxAmount` line SST · `TrackingName/Option` (blank) · `Currency` document currency (MYR by default) · `BrandingTheme` (blank).

**Xero contacts**: `*ContactName` · `AccountNumber` customer code · `EmailAddress` · `POAttentionTo` contact person · `POAddressLine1`–`4` · `PhoneNumber` · `TaxNumber` TIN · `CompanyNumber` registration number.

**QuickBooks Online invoices**: `InvoiceNo` · `Customer` · `InvoiceDate` · `DueDate` · `Terms` (`Net 14`) · `Location` (blank) · `Memo` invoice notes · `Item(Product/Service)` the matching catalog service name, otherwise `Services`, or `Discount` · `ItemDescription` · `ItemQuantity` · `ItemRate` · `ItemAmount` · `ItemTaxCode` · `ItemTaxAmount` · `Currency` · `ServiceDate` (blank). Turn on custom transaction numbers in QuickBooks to keep your invoice numbers.

**Bukku sales invoices** (closest format, copy into Bukku's template): `Contact` · `Contact Code` · `Number` · `Date` · `Due Date` · `Term (days)` · `Currency` · `Exchange Rate` · `Reference` · `Title` · `Description` · `Account` · `Quantity` · `Unit Price` · `Amount` (before SST) · `Tax Code` · `Tax Amount`. **Bukku customers**: `Type` · `Code` · `Legal Name` · `Registration No.` · `TIN` · `SST Registration No.` · `Email` · `Phone` · `Contact Person` · `Billing Address` · `Payment Term (days)`.

**SQL Account sales invoices** (closest format, map in the XLS import tool): `DocNo` · `DocDate` · `Code` customer code · `CompanyName` · `Terms` (`14 Days`) · `Description` (`Sales`) · `CurrencyCode` (`----` for local currency) · `CurrencyRate` · `Account` sales account · `ItemDescription` · `Qty` · `UnitPrice` · `Disc` (blank) · `Tax` tax code · `TaxRate` (`8%`) · `TaxAmt` · `Amount` (before SST). **SQL Account customers**: `Code` · `CompanyName` · `Attention` · `Address1`–`4` · `Phone1` · `Email` · `Terms` · `CurrencyCode` · `BRN` · `TIN` · `SSTRegNo`.

**AutoCount A/R invoices** (closest format, File > Import From Excel > Import A/R Invoice): `DocNo` · `DocDate` · `DebtorCode` · `CompanyName` · `Description` (`Sales`) · `CurrencyRate` · `AccNo` sales account · `DetailDescription` (quantity and rate added when the quantity is not 1) · `Amount` (before SST) · `TaxType` · `TaxAmt`. **AutoCount debtors**: `AccNo` · `CompanyName` · `Attention` · `Address1`–`4` · `Phone1` · `EmailAddress` · `DisplayTerm` · `CurrencyCode` · `RegisterNo` · `TIN` · `SSTRegisterNo`.

Sources used (October 2026): Intuit QuickBooks help "Import multiple invoices at once", Bukku help centre (batch import articles and "Malaysia SST Tax Codes in Bukku"), eStream SQL Account wiki ("SQL Acc XLS n MDB Import", "SST-Tax Code"), AutoCount "Import From Excel" specification and "Explanation on Tax Code", and Xero's import template layout.

## 62. Cash flow forecast

Reports > Cash flow:

1. Enter your **bank balance** and the date (also possible from the Overview). Receipts, refunds and paid expenses recorded after that date are added to estimate today's cash.
2. The next **13 weeks** (week 1 starts today) show money in, money out, net and closing balance, with a bar chart. **Weeks below zero are highlighted** in red.

Money in:

- each open invoice's balance on the date the client is expected to pay (due date adjusted by the client's usual lateness, see feature 89), overdue ones no earlier than this week,
- draft invoices created by recurring schedules, at their due date plus the client's usual delay,
- upcoming recurring schedule runs (service rate plus SST), at run date + terms + the client's usual delay.

Money out:

- unpaid expenses and supplier bill balances by due date (overdue ones in week 1),
- issued purchase orders not yet billed, on the needed-by date (or 30 days after the order),
- recurring costs.

Open a week to see each item. Download as CSV. It is an estimate, not a promise.

## 63. Annual income tax summary (Form B / Form P)

Reports > Tax summary, for a year of assessment (1 January – 31 December):

- **Sales / turnover**: issued invoices net of credit/debit notes, excluding SST (accrual).
- **Cost of sales** (categories mapped to *Purchases and cost of production*) and **gross profit**.
- **Expenses** grouped by the Form B / Form P financial-particulars lines: loan interest; salaries and wages; rental / lease; contracts and subcontracts; commissions; bad debts; travelling and transport; repairs and maintenance; promotion and advertisement; other expenses. Each line lists its categories.
- **Net profit per accounts**, then **add-backs** for the non-deductible part of each category (e.g. 50% of entertainment, all fines and equipment), giving an **adjusted net profit before capital allowances**.

PDF and CSV are available. It is clearly marked **"working aid, check with your tax agent"**. The line names come from the financial particulars section of the published Form B (Part K in 2021, Part N in 2022; the part letter and item numbers change between years, so only the line names are used). Form P has the same lines for partnerships. Capital allowances, approved donations, reliefs, other income and private use are not worked out.

## 89. Late payment prediction

For each client, the app looks at up to the last 12 invoices that were **paid in full**, and counts the days between each due date and the day the payments brought it to zero (early payments count as negative days).

- **Average days late** (early payments count as on time), **share paid late**, and a **trend** that compares the newer half of the history with the older half (a change of 3 days or more).
- **Expected payment date** of each open invoice: its due date plus the client's average delay. A client with no history uses the average of all clients (once there are 3 paid invoices), otherwise the due date. An invoice already later than usual is expected within a week and marked high risk.
- **Risk**: high when at least half of 2+ invoices were paid late with 15+ days average, or an invoice is over 30 days overdue; medium when a quarter were late, the average is over 3 days, an invoice is overdue or payments are getting later; otherwise low.
- **Reminder advice**: high risk, remind 7 days before the due date, on the due date and follow up 3 days after; medium, 3 days before and 1 day after; low, on the due date. The automatic email reminders in Settings stay the same for every client; use the advice to send an earlier personal reminder.

Shown on the client profile (*Payment behaviour*), on each open invoice (*Payment forecast*), in Reports > Late payers, and used by the cash flow forecast. The full explanation is on the Late payers screen. There is no hidden model: it is the arithmetic above.

## 92. Cash health at a glance

The Overview shows:

- **Cash on hand**: your bank balance plus money in and out since (or a prompt to enter it),
- **Monthly spending**: paid expenses (including bill payments) over the last 90 days, divided by 3,
- **Runway**: how many days or months that cash lasts at that spending,
- **Due in 30 days** and **Overdue** client invoice balances,
- the **3 most critical invoices**: the largest overdue balances weighted by risk (high ×3, medium ×2, low ×1), with links,
- a warning if the forecast goes below zero.

---

## Settings

- **Settings > Books**: purchase order prefix and default terms; whether receipt scanning is on.
- **Settings > Integration keys**: `BOOKS_VISION_MODEL` (optional).
- **Reports > Exports**: date format, sales accounts and tax codes for each package.

## Limits and caveats

- Expenses are entered in MYR. Supplier bills and purchase orders are in MYR.
- Bank transactions imported in Bank matching are not matched to expenses automatically.
- Reports read all records each time; they are fast for a small business (thousands of invoices and expenses), not built for very large data sets.
- The profit and loss and tax summary are management working aids, not audited accounts or tax computations.
- The export formats for Bukku, SQL Account and AutoCount are the closest documented formats; check them with a small import first.
