# Tax (SST and e-Invoice)

The tax module adds Malaysian SST working papers and LHDN MyInvois e-Invoices to Kosongsatu. Open it from **Books > Tax**. It has five tabs: Overview, SST-02 worksheet, e-Invoices, Self-billed and Settings.

Nothing in this module files a return or pays tax for you. The SST-02 worksheet is a working aid you copy into MySST. e-Invoices are only sent to LHDN when you press **Submit e-Invoice**, or when you switch on automatic submission yourself.

Roadmap items covered: 18, 19, 20, 21, 22, 23, 24, 93 and 94.

---

## What you need to provide

| What | Where | Needed for |
|---|---|---|
| SST registration number, TIN, registration number, phone, email | Settings > Company | SST and e-Invoice |
| MSIC code, business activity, structured address (lines, city, postcode, state) | Tax > Settings | e-Invoice |
| MyInvois client ID and client secret | Settings > Integration keys | Submitting e-Invoices |
| MyInvois environment (`sandbox` or `production`) | Settings > Integration keys | Default is sandbox |
| Signing private key and certificate (PEM), passphrase if any | Settings > Integration keys | Only for signed version 1.1 documents |

Integration keys are stored encrypted and never shown again. A server environment variable with the same name (`MYINVOIS_CLIENT_ID`, `MYINVOIS_CLIENT_SECRET`, `MYINVOIS_ENV`, `MYINVOIS_SIGNING_KEY`, `MYINVOIS_SIGNING_CERT`, `MYINVOIS_KEY_PASSPHRASE`) takes precedence.

**Getting MyInvois keys:** sign in to the MyInvois portal (start with the sandbox, `preprod.myinvois.hasil.gov.my`), open your taxpayer profile and register an ERP system. The portal shows a client ID and a client secret (the secret only once). Enter them in Settings > Integration keys and press **Test connection** on the Tax overview.

**Certificate (optional today):** LHDN still accepts unsigned version 1.0 documents. A signed version 1.1 needs a document-signing certificate from a Malaysian certificate authority. Authorities usually hand out a `.p12` file; convert it once with `openssl pkcs12 -in cert.p12 -nodes -out key.pem` and paste the private key and the certificate into Integration keys (pasting on one line is fine). When both are set, every document is signed and sent as version 1.1.

---

## 18. SST-02 worksheet

**What it does.** For a taxable period it lays out the figures in the order of the SST-02 return:

- **Part A** – SST registration number, name, taxable period, return and payment due date (last day of the month after the period).
- **Part B2** – taxable value and tax at each rate: 11(a) sales tax 5%, 11(b) sales tax 10%, 11(c) service tax 6%, 11(d) service tax 8%, 11(e) credit card services (not tracked, shown as 0), and 12 total tax.
- **Deductions** – 13(a) tax from credit notes (calculated). 13(b) approved sales tax deduction, 13(c) approved service tax deduction and 13(d) bad debt relief are shown as 0 for you to enter on MySST.
- **14** – total tax payable before any penalty. Penalties (items 15–16) are worked out by Customs.
- **Part D (item 18)** – sales to SST-exempt customers and other sales without SST.
- A list of every document counted, and warnings (open period, older notes without an SST split, invoices unpaid for 12 months, deductions larger than tax).

Download it as **PDF** or **CSV**. Both say clearly that they are a working aid and not a submission.

**Turn it on.** In Tax > Settings choose the taxable period length (normally 2 months) and the month your first period starts, as given in your Customs registration. Choose how service tax is counted:

- **When payment is received** (default). Service tax is due when you receive payment. If an invoice is not paid within 12 months, the remaining tax becomes due the day after those 12 months. Part payments count in proportion.
- **On the invoice date** – only if Customs approved accrual accounting for you.

Sales tax is always counted on the invoice date. Debit notes are added to item 11 in the period of the note. Credit notes go to 13(a) in the period of the note. On the payment basis, a credit that comes after the tax was already accounted for shows as a 13(a) deduction; an earlier one simply lowers the tax due when the money comes in.

**Limits.** Foreign-currency documents are converted at the document's exchange rate. The worksheet does not cover imported taxable services, the RM25 credit card service tax, Schedule C exemptions or bad debt relief.

## 19. SST on credit and debit notes

**What it does.** Every credit and debit note now carries its own SST split by rate. The note amount you type stays tax-inclusive, exactly as before, so the adjusted invoice total, allocations and customer funds still balance.

- By default the amount is split across the whole invoice in proportion to each rate's tax-inclusive value (after the invoice discount), then the SST is taken out of each share. A full credit gives back exactly the SST of the invoice.
- In the note form you can tick the invoice lines the note is about. The amount is then split across those lines only. A credit cannot be larger than what the ticked lines have left after earlier credit notes, so a line (and its SST) is never credited twice.
- A credit on the whole invoice is split over what is left on each line, and the SST credited at a rate never goes beyond the SST still on the invoice at that rate.
- The note PDF shows the taxable amount and SST per rate. The SST summary report (CSV) and the SST-02 worksheet use the split: credit notes reduce and debit notes increase tax in the period of the note.

Notes created before this feature have no stored split; reports estimate theirs the same proportional way and say so.

## 20. SST exemption per customer

**What it does.** In the client form, tick **This client is exempt from SST** and enter the exemption reference or certificate number and, if it has one, the date it is valid until.

- While the exemption is valid on a document's issue date, saving the document removes SST from every line. The editor shows a hint when you pick an exempt client.
- Issuing is refused if a draft still charges SST to an exempt client, or if the exemption has expired since the draft was saved (save the draft again).
- The PDF and the client page state "No SST is charged" with the exemption reference. On an e-Invoice those lines use tax type `E` (exempt) with the reference as the reason.
- Expired exemptions, and ones expiring within 30 days, are listed on the overview and the Tax page. The client profile marks an expired exemption.

## 21. LHDN MyInvois e-Invoice

**What it does.**

- Signs in as a taxpayer system with your client ID and secret (OAuth client credentials, scope `InvoicingAPI`). Tokens are cached for their hour.
- **Submit e-Invoice** on an issued invoice builds a UBL 2.1 JSON document (type 01), signs it when a certificate is set (version 1.1, otherwise version 1.0) and submits it.
- A background job (every minute) and the **Check status** button poll MyInvois. The document page shows the submission UID, document UUID, long ID, status and any validation errors.
- Once valid, the invoice PDF prints the validation QR code and link, and its footer says it is a validated MyInvois e-Invoice. The client page shows the QR code and a **Check on MyInvois** link. Sandbox documents are marked as tests.
- **Automatic submission (opt-in):** in Tax > Settings you can submit each invoice when it is issued, and its notes once the invoice is valid. It is off by default. Each document is queued once (dedupe key) and sent once.

**Safety.** Only the official hosts are contacted (`api.myinvois.hasil.gov.my`, `preprod-api.myinvois.hasil.gov.my`). A document can have only one active e-Invoice. If MyInvois does not answer, the record is marked "Checking" and looked up in MyInvois before anything is sent again; after 15 minutes without a trace it can be submitted again. A submission left at "Sending" because the server stopped mid-send is treated the same way after 2 minutes, by the background job or **Check status**. A restored backup never resends: queued work is re-checked and automatic submission is switched off. An invoice with a valid e-Invoice cannot be voided until the e-Invoice is cancelled.

**e-Invoice date.** MyInvois rejects documents whose issue time is more than 72 hours before submission, so the e-Invoice carries the submission date and time (UTC). The invoice number links it to your invoice.

## 22. Cancel within 72 hours, and e-Invoice notes

- **Cancel e-Invoice** appears on a valid e-Invoice until 72 hours after validation. It asks for a reason, which is sent to LHDN. The invoice in Kosongsatu stays issued; void it or issue a credit note afterwards. After 72 hours, use a credit or debit note.
- Credit and debit notes are submitted as types 02 and 03, refund notes (Credits refunds) as type 04. Each refers to the original e-Invoice by its number and UUID, so the original must be valid first. A refund note asks which invoice it relates to, in the refund's currency; a refund in USD is a USD e-Invoice at the receipt's exchange rate. Note lines use the note's SST split.
- **Seller details are locked per document.** An e-Invoice for an invoice uses the business details in that invoice's snapshot and the seller tax profile (ID type, MSIC, address) kept when it was issued. Renaming the company or changing its identity later does not change e-Invoices for earlier invoices. A detail that was empty or not valid at issue comes from today's settings, so it can be completed or corrected afterwards. The address counts as one detail: if the kept address was not valid, today's whole address is used. The readiness list checks each invoice with these same details, and a sale reported in the monthly consolidated e-Invoice with today's, which the consolidation is sent with. A credit, debit or refund note names the same seller as the e-Invoice it refers to: the invoice's own, or the monthly consolidated one.

## 23. Consolidated and self-billed e-Invoices

**Consolidated (B2C).** Set a client's e-Invoice option to **Monthly consolidated** when the buyer did not ask for an e-Invoice (for example walk-in or individual customers). Their invoices are not submitted one by one. After the month ends, the e-Invoices tab lists them and you create one consolidated e-Invoice for the month (number `CON-YYYY-MM-NN`): buyer "General Public" with TIN `EI00000000010`, one line per invoice (per rate) with classification `004`. Submit it within 7 days after the month ends; the screen shows the deadline and warns when it is late. Sales above RM10,000 are left out and need their own e-Invoice with full buyer details. Credit notes on consolidated sales refer to the consolidated e-Invoice.

**Self-billed (types 11–14).** For purchases where you issue the e-Invoice instead of the seller (foreign suppliers, individuals not in business, agents and similar). The form takes the seller's details (use TIN `EI00000000030` and ID `NA` for a foreign seller), the lines with a classification (for example `034` imported goods, `035` imported services, `036` others) and the currency. The seller is the supplier on the e-Invoice and your business is the buyer. Self-billed credit, debit and refund notes refer to the original self-billed invoice. Each has a PDF.

## 24. Classification codes and full buyer address

- **Client form:** ID type (BRN, NRIC, passport or army; the registration / IC number field is the ID number), address lines (up to 3), city, postcode, state code (MyInvois list) and country code (ISO 3166 alpha-3). Values are checked against the official lists.
- **Your business:** MSIC code (checked against the 1,166 MSIC codes in the MyInvois list), activity description and structured address in Tax > Settings.
- **Line classification:** each line needs a MyInvois classification code. The code comes from, in order: a code set on the line (**Classification > Change** on the document), the service's default (Tax > Settings > Service classifications; matched by service or by the line text), the document default (in the editor), then the business default (`022 Others` unless you change it). Classifications lock once the e-Invoice is submitted.

## 93. "MyInvois ready" mode

Every invoice is checked for what an e-Invoice needs: your TIN, registration, MSIC, activity, address and phone; the buyer's TIN, ID, address, postcode, state and phone; a classification for each line; and an exchange rate for foreign currency. The document page lists what is missing with buttons to fix it. The overview shows how many issued invoices are not ready, and the Tax overview lists them with links. You can use this long before you must comply, without connecting to LHDN.

## 94. Tax threshold monitor

Shows rolling 12-month sales (current month and the 11 before it): issued invoices plus debit notes less credit notes, excluding SST, converted to MYR. It compares them with:

- the **SST registration threshold** (default RM500,000; change it in settings because some service groups use RM1,000,000 or RM1,500,000), and
- the **e-Invoice exemption threshold** (default RM3,000,000).

Bars turn orange at 80% and red at 100%, with the month the threshold was first reached. The e-Invoice exemption also depends on related companies: it does not apply when a non-individual shareholder, holding company, related company or joint venture partner has revenue at or above the threshold. The monitor cannot see those companies.

---

## Rules and sources (checked 17 October 2026)

The build environment could not open `sdk.myinvois.hasil.gov.my` or `hasil.gov.my` directly. The MyInvois details below were taken from search excerpts of the official SDK pages and cross-checked against published open-source MyInvois clients that reproduce LHDN's own signed sample documents (`@ibnumalik/myinvois` 4.0.0, August 2026; `@weiliang79/ubl-builder` 0.4.1, September 2026; `@ripwords/myinvois-client` 0.6.0 for the code tables). Please run a sandbox submission before production.

**MyInvois (LHDN SDK)**

- Login: `POST {api}/connect/token`, form fields `client_id`, `client_secret`, `grant_type=client_credentials`, `scope=InvoicingAPI`; token valid 1 hour; login limit 12 per minute. Hosts: `preprod-api.myinvois.hasil.gov.my` (sandbox), `api.myinvois.hasil.gov.my` (production).
- Submit: `POST /api/v1.0/documentsubmissions/` with `{ documents: [{ format: "JSON", document: base64, documentHash: SHA-256 hex of the raw document, codeNumber }] }`; at most 300 KB per document. Status: `GET /api/v1.0/documentsubmissions/{uid}`; errors: `GET /api/v1.0/documents/{uuid}/details`; recent documents: `GET /api/v1.0/documents/recent`; cancel: `PUT /api/v1.0/documents/state/{uuid}/state` with `{ status: "cancelled", reason }`; TIN check: `GET /api/v1.0/taxpayer/validate/{tin}?idType=&idValue=`.
- Validation link and QR: `{portal}/{uuid}/share/{longId}` with portal `preprod.myinvois.hasil.gov.my` or `myinvois.hasil.gov.my` (SDK, "Get document details").
- Versions: 1.0 has signature validation disabled and "will be deprecated ... at a later date that will be announced"; taxpayers may keep using 1.0 until LHDN issues a retirement notice (SDK document type pages and FAQ). 1.1 requires the signature. The September 2026 SVDP versions 1.2 and 1.3 are only for the voluntary disclosure programme and are not used here.
- Signature (1.1, SDK "Signature creation (JSON)"): remove `UBLExtensions` and `Signature`, minify; DocDigest = Base64(SHA-256); signature = RSA-SHA256 over the same minified document; CertDigest = Base64(SHA-256 of the DER certificate); signed properties hold the signing time, CertDigest, issuer name and decimal serial number; PropsDigest = Base64(SHA-256 of the minified `QualifyingProperties` object, including `Target`). The issuer name is written in the certificate's order (`C=..., O=..., CN=...`) as in LHDN's signed sample. If MyInvois ever answers DS326 (issuer name mismatch) or DS320 (signed properties digest), these two choices are the first to revisit.
- Cancellation within 72 hours of validation; afterwards credit/debit/refund notes. Notes refer to the original document's number and UUID.
- Code tables: e-Invoice types 01–04 and 11–14, tax types (01 sales tax, 02 service tax, 06 not applicable, E exempt), state codes 01–17, ISO 3166-1 alpha-3 countries, classification codes 001–045, MSIC codes, general TINs (`EI00000000010` general public, `EI00000000020` foreign buyer, `EI00000000030` foreign supplier, `EI00000000040` government).

**LHDN e-Invoice guidelines**

- Consolidated e-Invoice: issue within 7 calendar days after the month ends; buyer TIN `EI00000000010`; transactions above RM10,000 need an individual e-Invoice (LHDN e-Invoice FAQ and general guideline; RM10,000 rule from 1 January 2026). Some industries may not consolidate (for example automotive, aviation, luxury goods and jewellery, construction, betting and gaming, payments to agents/dealers); check yours.
- Exemption threshold RM3,000,000 annual revenue under e-Invoice General Guideline version 4.8 dated 30 August 2026 (secondary sources give 1 September 2026 as the effective date). The related-company condition is in §1.6.10 according to the same secondary summaries. A business that reaches the threshold is reported to start from 1 January of the second year after the year it reached it; check the guideline for your case.
- Self-billed e-Invoices for imports and payments to individuals, agents and similar (LHDN e-Invoice Specific Guideline).

**SST (Royal Malaysian Customs Department)**

- SST-02 items: Part A particulars; B2 items 11(a)–(e) and 12; deductions 13(a) credit notes, 13(b) approved sales tax deduction, 13(c) approved service tax deduction, 13(d) bad debt relief; 14 = 12 − 13; Part D item 18 exempt and non-taxable sales; 15–16 penalties worked out by Customs. Based on the Customs guide *Panduan Mengisi Penyata SST-02* (31 May 2026), the SST-02 form amended 2 October 2026 as summarised publicly on 13 October 2026, and KPMG's June 2026 note on the updated guide (13(a) is the tax in a credit note for an invoice whose tax was already accounted for).
- Return and payment are due by the last day of the month after the taxable period.
- Service tax is accounted on a payment basis; if payment is not received within 12 months from when the service was provided, the tax is due the day after (Customs Guide on Return and Payment; Service Tax General Guide; KPMG, 25 September 2019). The app uses the invoice issue date as the date the service was provided. Accrual (invoice) basis needs Customs approval.
- Sales tax is due at the time of sale.
- Registration thresholds: RM500,000 in 12 months for most taxable services; RM1,000,000 for some groups such as financial services and rental/leasing; RM1,500,000 is quoted for food and beverage, construction and private healthcare (sources disagree on healthcare). Use the current First Schedule to the Service Tax Regulations 2018.

## Caveats

- This is not certified tax software and has not been reviewed by Customs or LHDN. Check the worksheet with your adviser before filing.
- No real MyInvois submission was made while building this; tests use a simulated MyInvois. Try the sandbox first.
- The e-Invoice uses MYR tax amounts with the document's exchange rate for foreign-currency invoices.
- Refund notes are sent with tax type 06 (not applicable): the SST adjustment is carried by the credit note that released the money.
- Intermediary submission (acting for other taxpayers) and XML documents are not supported.
