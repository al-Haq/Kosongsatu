# Documents and billing

This module adds more document types, more control over each line, other currencies and languages, and nicer PDFs. Everything works without outside accounts. The only optional setup is a Chinese font on the server (see [Chinese documents](#14-documents-in-english-bahasa-melayu-and-chinese)).

## Line title and description

Each line has a short **title** (what used to be the line description, up to 240 characters) and an optional **description** under it, as on Refrens.

- Press **+ Description** under a line. The box has buttons for **bold**, *italic*, ~~strikethrough~~, a bullet list and a numbered list. Ctrl+B and Ctrl+I work too. Pasted text keeps its words but not its formatting.
- A description holds up to 3000 characters; the counter under the box shows how many are used. The **×** in the toolbar removes it.
- The document page, the client link, the client portal and the PDF show the title (in bold when a description follows) and then the formatted description in smaller grey text. PDF rows grow to fit, so nothing runs past the row's line, in all three PDF layouts. A description taller than a page carries on to the next page under the table header.
- Choosing a service from the catalog puts the service name in the title and its description in the description.
- **Items used before.** Click an empty line title, or start typing in one, and a list shows items from documents saved before (quotations, invoices, proformas, sales and delivery orders, drafts included) and catalog services not used yet. Each shows its rate and how often it was used. Click one, or use the arrow keys and Enter, to fill the title, description, rate, SST, code and unit; the quantity stays and the cursor moves to it. Esc closes the list without closing the editor.
  - Each title is listed once, as it was last used. A title used only on delivery orders takes its rate from the latest priced document that has it.
  - Typing matches titles that start with the text first, then a word in the title, then item codes, and from 3 letters the description too. With nothing typed, the most used items come first.
  - Only lines in the document's currency are offered. Deposit deductions are never offered.
  - Nothing new is stored: the list is built in the browser from the documents already loaded (`public/ext/line-suggest.mjs`), so a line is offered as soon as its document is saved.
- The description is copied when a quotation becomes an invoice, when a document is duplicated, and from a sales order to its invoice or delivery order. Webhook payloads carry it as `items[].details`.
- It is stored as plain text with a small markup: `**bold**`, `*italic*`, `~~strike~~`, lines starting with `- ` (bullets) or `1. ` (numbers), and a blank line between paragraphs. It is never stored or shown as HTML. `public/ext/line-details.mjs` reads it for the browser and the PDF.
- The e-Invoice and accounting exports use the title only.

Lines saved before this change have only a title. On the PDF, a line's SST rate is now a small grey note under its title.

## Editing an issued quotation

An issued quotation can still be changed until the client accepts or declines it.

- On the quotation, press **Edit quotation**. Lines, descriptions, rates, discounts, the validity date, terms and notes can change. The quotation keeps its number (for example QT-2026-0002), and its PDF and client link show the new version at once.
- The client, issue date and currency stay as issued: they are shown but locked, and the server keeps them even if a request sends others. The client details were frozen when it was issued.
- It keeps the SST registration, the client's tax position and the custom fields it was issued with: clearing the SST number, exempting the client or removing a custom field later does not drop its SST or field values when it is edited.
- An edit that would need a Chinese font the server doesn't have (Chinese text or language) is refused, so the issued quotation's PDF keeps working.
- Each edit is kept in the activity as **Edited after issue**, with what changed.
- A client always accepts or signs the version they were shown. The client link and portal send back the version on screen (`revision`, a fingerprint of the lines, totals, dates, terms, notes, deposit, custom fields and language). If the quotation was edited after they opened it, they see "This quotation was changed after you opened it. Reload the page to see the latest version, then accept." Nothing is accepted until they reload.
- Once accepted, a quotation is locked: "An accepted quotation can't be edited. Duplicate it to make a new version." Declined and void quotations are locked too. Issued invoices and other documents stay locked as before.
- Staff can edit issued quotations; accountants cannot.

## Terms and conditions follow the last one

A new document starts with the terms and conditions of the latest document of the same kind (the last quotation for a new quotation, and so on). Under the box it says "Same as QT-2026-0002", and **Use the company default** puts back the default from Settings. Changing them affects only that document. With no earlier document, the company default is used. Terms and conditions, and the company default, can be up to 4000 characters; long terms carry on over PDF pages.

## Activity: what changed, for the owner

The **Activity** panel on each document lists every save with what it changed, for example:

- Line 1 "Asus Vivobook 16": quantity 6 → 5, rate 3,800.00 → 3,860.00, description changed
- Added line 3 "Setup": 1 × 150.00, or Removed line "Bag" (1 × 90.00)
- Client, issue date and due or valid-until date: old → new
- Document discount and total: old → new
- Terms and conditions changed, Notes changed

Lines are matched by title, so a line moved or added in the middle is not reported as every line changing. The changes are worked out from the before and after copies the audit history already kept, so saves made before this update show their details too (`public/ext/doc-changes.mjs`).

Only the owner sees the Activity panel; see [Team](team.md).

## 6. Line discounts

Each line in the editor has a **Line discount** box. Choose **Amount** or **%**.

- The line amount is quantity × rate, less its own discount.
- The **Document discount** (the old "Discount" field) then comes off the whole document, shared across lines in proportion to their amounts.
- SST is charged on each line after both discounts.
- The live preview uses exactly the same arithmetic as the server, so the preview total is the saved total.
- The PDF and the document page show a **Discount** column only when at least one line has a discount.

Old documents are unchanged: they total and print exactly as before.

## 7. Item codes (SKU) and units

- In **Services**, give a service an optional **Item code / SKU** (letters, numbers, `.` `-` `/`). Codes are unique and saved in capitals.
- Lines added from the catalog keep the service, its code and its unit. You can also type a code and unit on any custom line.
- The PDF and the document page show **Code** and **Unit** columns when lines have them.

## 8. PDF template and logo

**Settings > Document template**:

- **Layout**: Classic (today's look, the default), Modern colour header, or Compact.
- **Accent colour**: used for titles, totals and the Modern header.
- **Business logo**: upload a PNG or JPEG (up to 1 MB). It replaces the Nawlogic logo on PDFs and on client links. "Use Nawlogic logo" switches back.
- **Show**: bank details, terms, notes, client TIN/registration, page footer text. Switch any of them off.
- **Footer text**: replaces "Nawlogic | Business document". The "Not a validated MyInvois e-Invoice" notice stays whenever the footer is shown.

The template applies to invoices, quotations, proforma invoices, sales and delivery orders, receipts, credit/debit/refund notes and statements. An issued document keeps the template and logo it was issued with.

## 11. Proforma invoices

**Sell > Proforma** works like invoices, with its own numbers (`PF-2026-0001`; change the prefix in Settings > Document template).

- A proforma can be shared and emailed, and shows your bank details, but it never changes balances, reports or SST.
- **Convert to invoice** creates a linked draft invoice once. Converting again opens the same invoice. The proforma shows **Converted** once that invoice is issued.

## 12. Sales orders and delivery orders

- **Sales orders** (`SO-…`): create one from scratch, or from an accepted quotation with the **Sales order** button. From an issued sales order, **Create invoice** and **Delivery order**. The sales order shows Invoiced, Delivered or Completed as those documents are issued.
- **Delivery orders** (`DO-…`): from a sales order or an issued invoice, or from scratch. They list items, codes, quantities and units with no prices, and end with **Delivered by** and **Received by** signature lines.
- When a quotation has a sales order, create the invoice from the sales order (the quotation's own "Create invoice" is then blocked, so nothing is invoiced twice).
- A document with linked documents cannot be voided until those are voided or deleted.

## 13. Other currencies

- Choose the **Currency** in the editor (MYR, USD, SGD, EUR, GBP, AUD, CNY, HKD, THB, IDR, BND) and type the **Exchange rate** as MYR per 1 unit (for example 4.45 for USD). The rate is fixed when the document is issued. If you leave the rate empty, the last rate you used for that currency is used.
- Each client can have a **Default currency** (client form); new documents in the editor start with it. Documents created without a currency (recurring schedules, AI proposals) stay in MYR because catalog prices are in MYR.
- Amounts are kept in the document currency. Paper, PDF, client link and lists show that currency.
- **Payments**: a payment on a USD invoice is recorded as a USD receipt, with the rate on the day (it defaults to the invoice rate). A receipt can only be applied to invoices in its own currency. When you record money received on **Credits**, pick its currency.
- **Reports and dashboards** convert to MYR at each document's or receipt's own rate: overview totals, client outstanding, the invoice CSV (MYR columns plus currency, rate and original amounts), and the SST report (SST figures in MYR).
- **Statements** show one section per currency.
- When a credit note moves part of a payment back to customer funds, the statement shows that as its own line on the note's date ("Moved to customer funds"). A statement for an earlier period, and the accountant pack's month-end aging, keep the balances they had.
- **Online payment** (all providers) and **bank CSV import/matching** are MYR only. The Pay online button is hidden for other currencies and the payment page refuses them. If ringgit is ever collected online for an invoice in another currency, it is kept as MYR customer funds and never marks that invoice paid. A non-MYR receipt never matches a bank line.

## 14. Documents in English, Bahasa Melayu and Chinese

- Pick the **Document language** in the editor. It defaults to the client's language (client form), then to the default in Settings > Document template.
- All fixed labels on the PDF, the document page and the client link are translated: titles, headings, columns, totals, statuses, payment instructions and buttons. Your own text (lines, notes, terms) is printed as you typed it.
- Receipts and statements use the client's language.

**Chinese needs a Chinese font on the server.** The default font has no Chinese characters, so without one a Chinese PDF would print empty boxes. The app looks for:

1. the path in **Settings > Integration keys > Chinese PDF font file** (`PDF_CJK_FONT`), or the same server environment variable, then
2. the usual system fonts: Noto Sans CJK (`fonts-noto-cjk` on Debian/Ubuntu), WenQuanYi and others.

The Docker image installs `fonts-noto-cjk`. On another server run `sudo apt install fonts-noto-cjk`. Settings shows whether a font was found. Without one, a 中文 document, or a document with Chinese text in its lines, notes or terms, cannot be issued and its PDF is refused with a clear message. Any text containing Chinese characters uses the Chinese font, even on English documents.

## 15. Custom fields and attachments

**Custom fields** (Settings > Custom fields): up to 10 fields, each with a label, where it is used (all documents, invoices and proforma, or quotations) and whether it shows on the PDF and client link or stays **internal**. Values are typed in the editor and locked when the document is issued; renaming a field later does not change issued documents. Internal values never reach PDFs or client links.

**Attachments** (Attachments panel on any document): upload PDFs or images (5 MB each, up to 10 per document). Each file is **Private** or **Client can see**. Client-visible files can be downloaded from the client link while the link is valid. Tick **List client-visible attachments on the PDF** in the editor to print their names on the PDF.

## 34. Deposits on quotations

- In the quotation editor, set **Deposit on acceptance** to a percentage of the total, or a fixed amount before SST.
- The quotation shows the deposit (with SST) on the paper, PDF and client link.
- After the client accepts, **Deposit invoice** creates the deposit invoice in one click (once per quotation). It has one line per SST rate, so SST on the deposit is charged at the same rates as the quoted lines.
- The final invoice from the quotation (or from its sales order) lists all quoted lines and then **Less deposit** with the deposit's value and SST at each rate. Together the two invoices bill exactly the quotation total and its SST, and the SST report counts the deposit once.
- Issue or delete the deposit invoice draft before creating the final invoice. A deposit invoice that a final invoice deducts cannot be voided; void the final invoice first. If a deposit is voided before the final invoice is issued, save the final draft again to remove the deduction.

## 35. Instalment plans

- On an issued invoice, **Set up instalments** splits it into 2 to 24 instalments with dates and amounts that add up to the invoice total.
- The paper, PDF and client link show the plan and the next amount due.
- Payments cover the earliest instalments first. **Overdue** means an instalment date has passed unpaid, not the invoice due date.
- Payment reminders (Settings > Messages > Email reminders) follow the instalment dates: each instalment gets its own before/after reminders, once each.
- Credit notes reduce the last instalments; debit notes add to the last one. Edit or remove the plan at any time; changes are kept in the audit history.

## Limits and notes

- Delivery orders are one per sales order or invoice (void it to make a new one); partial deliveries are not tracked.
- Exchange rates are typed by you; the app does not fetch rates.
- Statements' aging uses invoice due dates, not instalment dates.
- None of these documents is a validated MyInvois e-Invoice.
