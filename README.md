# Nawlogic Invoice · Kosongsatu

An owner-operated invoicing web app for **NAWLOGIC SYSTEMS SOLUTION**, using the supplied Nawlogic logo and teal / orange / ink brand palette.

Release **0.3.0** is a working owner billing application: the browser talks to an authenticated Node.js API and a persistent SQLite database. It is not a localStorage-only mockup. No customer data, credentials, business registration attachments or payment account numbers are committed.

## Run locally

Requires **Node.js 24.x** and npm. No frontend build step is needed.

```sh
npm ci
npm run setup
npm start
```

`setup` asks for your owner email and generates a strong password. Save it in your password manager. Open **http://localhost:3000**, sign in, then update the password in Settings. Configure company details, invoice terms and bank instructions before issuing real documents. A setup email/password can alternatively be provided through `ADMIN_EMAIL` / `ADMIN_PASSWORD` environment variables, without committing them.

For disposable example data:

```sh
npm run demo
```

This starts on loopback only and prints a new temporary demo password. Demo records are stored in **data/demo.sqlite**, separately from the real workspace (**data/nawlogic.sqlite**). Each demo launch invalidates previous demo sessions. Do not use the demo workspace for real customer data.

Optional runtime settings can be copied from `.env.example` to `.env`. Set `APP_URL` to the exact browser origin, including its port. In local development use `localhost`, not `127.0.0.1`, in your browser unless `APP_URL` is changed accordingly.

## Sales and automation

Open **Sales & POs** to manage opportunities, prepare quotation proposals, record verified customer acceptance and register customer purchase orders. **AI & automation** provides the review queue, opt-in rules, connector tokens and optional built-in AI chat.

The MCP stdio server and scoped REST tools let your agents or n8n read permitted records and queue proposals. Owner approval is separate. An enabled deterministic PO rule can create an invoice draft automatically; it never issues, sends or charges. Configure your own tool-capable compatible model to use the natural-language assistant. No model or external account is connected by default.

See [AI, MCP and sales setup](docs/AUTOMATION.md) for configuration, tool scopes, n8n examples, data handling and exact limitations.

## Included

- Owner login, hashed passwords, expiring server-side sessions, CSRF and origin checks, login throttling, password changes and sign-out.
- Dashboard with issued invoice value, confirmed collections, outstanding balances and overdue invoices. Monthly and all-date metrics are explicitly distinguished.
- Client and service catalogs, including editable payment terms and default rates.
- Draft quotations and invoices with live preview, quantities to 2 decimals, line rounding in integer sen, discounts and MYR totals.
- Issue-time numbering and immutable snapshots of client/business details. Issued documents cannot be silently rewritten.
- Unicode-capable, branded downloadable PDF invoices, quotations and payment receipts. Long documents paginate.
- Cash receipts recorded once, allocations across multiple invoices, partial payments and available customer funds. Allocation reversals and erroneous receipt voids preserve history.
- Numbered credit/debit notes and refunds, with branded PDFs and adjusted invoice balances. Credits on paid invoices release existing funds for reuse or refund.
- Normalized bank CSV preview/import, duplicate skipping, manual receipt/refund matching and exclusion reasons. Import alone never creates income.
- Document-only client links with random tokens, hashed token storage, configurable 1–90 day expiry, revocation and rotation.
- Responsive client invoice pages, PDF downloads and transaction-reference submission. Client references remain **pending** until an owner verifies actual receipt of money.
- Client quotation acceptance with signer name and audit entry. A quotation converts to one linked draft invoice, even if conversion is repeated.
- Monthly recurring schedules with preserved anchor day or month end, pause/resume, and owner-triggered draft generation once per period. Future periods cannot run early.
- CSV export with formula-cell neutralization, business JSON export and actor/before-after audit history.
- Optional authenticator MFA, one-use recovery codes and local operator recovery.
- AES-256-GCM online backups, daily scheduling when configured and integrity-checked restore to a new database.
- Responsive desktop/mobile layout and semantic forms, keyboard-focus styling, explicit labels and native dialogs.

**Issued** means published/locked inside this app, not emailed. Sharing opens a link or WhatsApp composer; the app does not send a message itself. A viewed status means the link was opened and is not proof of delivery or identity.

## Not connected in this release

- LHDN MyInvois e-Invoice submission, validation, cancellation or validated tax notes.
- SST registration, tax calculation or tax reporting. The app must not be represented as tax-compliant software without a separate review and integration.
- Payment gateways, automatic bank feeds, direct debit, automatic reminders or email sending.
- Payment-slip file uploads (clients submit a transaction reference and message), multiple staff roles, multi-company tenancy or self-registration.
- Fully automatic recurring scheduling. An owner deliberately generates due drafts; no job sends/charges automatically.
- Business JSON import. Export is portable business data; use the encrypted database backup/restore procedure for recovery.

Do not treat a client-submitted reference as bank verification. This is a single-business billing tool, not a general ledger or bank account.

## Verify

```sh
npm run check
npm test
npm audit --omit=dev
```

Domain and HTTP integration tests cover exact amounts, immutable snapshots, financial allocations/notes/refunds, recurring anchors, idempotency, CSV reconciliation, migration, TOTP vectors and recovery codes, encrypted backup/restore, authorization and PDF pagination. Browser flows (billing, finance/security, sales) are covered by the manual checklist in [ACCEPTANCE.md](docs/ACCEPTANCE.md); there is no automated browser test suite yet. GitHub Actions runs `check`, `test` and `audit` on every push and pull request.

See the [phase 1 release matrix](docs/RELEASE-0.2.md), [deployment and backup](docs/DEPLOYMENT.md), [design decisions](docs/DESIGN.md) and [manual browser checks](docs/ACCEPTANCE.md). Production hosting is **not** configured by this repository commit.
