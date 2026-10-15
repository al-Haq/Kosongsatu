# Nawlogic Invoice · Kosongsatu

An owner-operated invoicing web app for **NAWLOGIC SYSTEMS SOLUTION**, using the supplied Nawlogic logo and teal / orange / ink brand palette.

This is a working first release: the browser talks to an authenticated Node.js API and a persistent SQLite database. It is not a localStorage-only mockup. No customer data, credentials, business registration attachments or payment account numbers are committed.

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

## Included

- Owner login, hashed passwords, expiring server-side sessions, CSRF and origin checks, login throttling, password changes and sign-out.
- Dashboard with issued invoice value, confirmed collections, outstanding balances and overdue invoices. Monthly and all-date metrics are explicitly distinguished.
- Client and service catalogs, including editable payment terms and default rates.
- Draft quotations and invoices with live preview, quantities to 2 decimals, line rounding in integer sen, discounts and MYR totals.
- Issue-time numbering and immutable snapshots of client/business details. Issued documents cannot be silently rewritten.
- Unicode-capable, branded downloadable PDF invoices, quotations and payment receipts. Long documents paginate.
- Partial payments, overpayment and duplicate-reference rejection, full-payment status, and payment reversal with an audit reason.
- Document-only client links with random tokens, hashed token storage, 30-day expiry, revocation and rotation.
- Responsive client invoice pages, PDF downloads and transaction-reference submission. Client references remain **pending** until an owner verifies actual receipt of money.
- Client quotation acceptance with signer name and audit entry. A quotation converts to one linked draft invoice, even if conversion is repeated.
- Monthly recurring schedules, pause/resume, and owner-triggered draft generation once per period. Future periods cannot run early.
- CSV export with formula-cell neutralization, business JSON export and audit history.
- Responsive desktop/mobile layout and semantic forms, keyboard-focus styling, explicit labels and native dialogs.

**Issued** means published/locked inside this app, not emailed. Sharing opens a link or WhatsApp composer; the app does not send a message itself. A viewed status means the link was opened and is not proof of delivery or identity.

## Not connected in this release

- LHDN MyInvois e-Invoice submission, validation, cancellation or credit notes.
- SST registration, tax calculation or tax reporting. The app must not be represented as tax-compliant software without a separate review and integration.
- Payment gateways, automatic bank feeds, direct debit, automatic reminders or email sending.
- Payment-slip file uploads (clients submit a transaction reference and message), MFA, multiple staff roles, multi-company tenancy or self-registration.
- Fully automatic recurring scheduling. An owner deliberately generates due drafts; no job sends/charges automatically.
- Business JSON import. Export is portable business data; a full recoverable backup is the SQLite database, using the procedure below.

Do not treat a client-submitted reference as bank verification. This is a single-business billing tool, not a general ledger or bank account.

## Verify

```sh
npm run check
npm test
npm audit --omit=dev
```

Domain and HTTP integration tests cover exact amounts, snapshots, numbering, draft locks, payment rejection/reversal, scoped links, quotation conversion, recurring periods, authentication, origin/CSRF, PDF responses and CSV escaping.

See [deployment and backup](docs/DEPLOYMENT.md), [design decisions](docs/DESIGN.md) and [manual browser checks](docs/ACCEPTANCE.md). Production hosting is **not** configured by this repository commit.
