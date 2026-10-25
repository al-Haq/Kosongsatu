# Nawlogic Invoice · Kosongsatu

An owner-operated invoicing web app for **NAWLOGIC SYSTEMS SOLUTION**, using the supplied Nawlogic logo and teal / orange / ink brand palette.

Release **0.9.0** is a working owner billing application: the browser talks to an authenticated Node.js API and a persistent SQLite database. It is not a localStorage-only mockup. No customer data, credentials, business registration attachments or payment account numbers are committed.

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

Open **Sales** to manage opportunities, prepare quotation proposals, record verified customer acceptance and register customer purchase orders. **Automation** provides the review queue, opt-in rules, connector tokens and optional built-in AI chat.

The MCP stdio server and scoped REST tools let your agents or n8n read permitted records and queue proposals. Owner approval is separate. An enabled deterministic PO rule can create an invoice draft automatically; it never issues, sends or charges. Configure your own tool-capable compatible model to use the natural-language assistant. No model or external account is connected by default.

See [AI, MCP and sales setup](docs/AUTOMATION.md) for configuration, tool scopes, n8n examples, data handling and exact limitations.

## Included

The core workspace:

- Owner login, hashed passwords, expiring server-side sessions, CSRF and origin checks, login throttling, password changes and sign-out. Optional authenticator MFA (with a QR code) and one-use recovery codes.
- Dashboard with issued invoice value, confirmed collections, outstanding balances, overdue invoices, cash health, tax thresholds and expiring contracts.
- Clients of every kind (company, individual, government body, organisation) with labels that follow the type; only the name is required. Services with editable payment terms, default rates, SKUs, default SST rates and classification codes. Archive, guarded deletes, duplication.
- Draft quotations and invoices with live preview, per-line and document discounts, SST per line, custom fields, attachments, deposits and instalment plans. Proforma invoices, sales orders and delivery orders.
- Issue-time numbering and immutable snapshots. Branded PDFs with three layouts, your own logo, English / Bahasa Melayu / 中文 and multiple currencies at a fixed rate.
- Cash receipts, allocations, partial payments, credit/debit notes (with their SST share), refunds, bank CSV import in Malaysian bank layouts, smart matching suggestions and an audit history chained with SHA-256.
- Funding: owner, director and investor money kept apart from sales (capital, loans to the business, loan repayments) with what is still owed per person; it counts as cash in the forecast, never as income.
- When something fails, the message says why it usually happens and what to try; an out-of-date sign-in check (another tab, a server update) is refreshed and the save retried for the same account.
- Client links and a client portal: documents, statements, online payment, payment references with slip upload, drawn or typed e-signatures on quotations, feedback after payment.
- Recurring plans from weekly to yearly with draft, auto-issue or auto-send modes, automatic late fees, contracts and retainers, and a monthly accountant pack.
- Books: expenses and vendors, receipt scanning, supplier POs and bills, sales reports, profit and loss, cash flow forecast, Form B/P working summary, late-payment prediction, exports for Xero, QuickBooks, Bukku, SQL Account and AutoCount.
- Operations: partial and amended customer POs, timesheets with a timer, projects and milestone billing, optional inventory, proof of work on documents.
- Tax: SST-02 worksheet, SST exemptions per customer, LHDN MyInvois e-Invoices (submission, validation QR, cancellation, credit/debit/refund notes, consolidated and self-billed), a "MyInvois ready" checker and a tax threshold monitor.
- Communication: SMTP settings in the app, editable email templates (EN/BM), open and bounce tracking, WhatsApp Business messages and reminders, owner notifications, AI-assisted collection follow-ups that wait for approval, link previews.
- Team: owner, staff and read-only accountant roles, invitations, password reset by email, off-site encrypted backups to S3-compatible storage.
- Platform: outgoing webhooks with signatures, CSV import of clients, services and historical invoices, an installable app, invoices typed in plain language, a Docker/Caddy hosting kit with install and update scripts.
- Sales opportunities, customer POs, an MCP server and scoped REST tools for agents and n8n, with owner approval of every proposal.

Each module is described for owners in [docs/features](docs/features): [documents](docs/features/documents.md), [recurring](docs/features/recurring.md), [tax](docs/features/tax.md), [payments](docs/features/payments.md), [comms](docs/features/comms.md), [portal](docs/features/portal.md), [books](docs/features/books.md), [funding](docs/features/funding.md), [ops](docs/features/ops.md), [team](docs/features/team.md), [platform](docs/features/platform.md), [recently deleted](docs/features/trash.md). The roadmap and status of all 100 features is in [docs/100-CIRI.md](docs/100-CIRI.md).

**Issued** means published/locked inside this app. Sharing opens a link or WhatsApp composer unless email or WhatsApp Business is set up. A viewed status means the link was opened and is not proof of delivery or identity.

## Needs your own accounts

These are built and tested with simulated providers, and switch on when you add the keys under **Settings > Integration keys** (or on the server):

- Email (SMTP): sending documents, statements, reminders, invitations, password resets and the accountant pack.
- Online payment: Billplz, ToyyibPay, Stripe or iPay88 keys. ToyyibPay and iPay88 have not been exercised against a live account; run a small live test first.
- WhatsApp Business (Meta Cloud API): access token, phone number ID, app secret, approved templates.
- LHDN MyInvois: client ID and secret (sandbox or production) and, for signed documents, your certificate. Not yet exercised against the live sandbox; see [docs/features/tax.md](docs/features/tax.md).
- An OpenAI-compatible model: receipt scanning, AI wording for follow-ups and plain-language invoices. Everything has a non-AI path.
- S3-compatible storage for off-site backups.
- A server and domain for production hosting ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)); Cloudflare Tunnel and R2 are supported in front of it, and several companies can share one server, each with its own separate install.

Still outside this release: automatic bank feeds or direct debit, multi-company tenancy, self-registration, partial deliveries, and fetched exchange rates (rates are typed by the owner). The SST-02 worksheet, Form B/P summary and accounting exports are working aids: check them with your accountant, and test the exports against a real import before relying on them. Do not treat a client-submitted reference as bank verification.

## Verify

```sh
npm run check
npm test
npm run test:e2e   # browser tests (Playwright, Chromium)
npm audit --omit=dev
```

More than 440 domain and HTTP tests cover exact amounts, immutable snapshots, allocations/notes/refunds, recurring cadences, idempotency, CSV reconciliation, migrations on populated databases, TOTP and recovery codes, encrypted backup/restore, role permissions, webhook signatures, e-Invoice signing, portal sessions and PDF rendering, with every external provider simulated. Browser tests in `e2e/` sign in to a disposable demo workspace and cover page navigation, the invoice flow (draft, issue, client link, payment reference, payment, PDF), online quotation acceptance and the phone layout. The manual checklist in [ACCEPTANCE.md](docs/ACCEPTANCE.md) covers the remaining flows. GitHub Actions runs `check`, `test`, `audit` and the browser tests on every push and pull request.

See the [phase 1 release matrix](docs/RELEASE-0.2.md), [deployment and backup](docs/DEPLOYMENT.md), [design decisions](docs/DESIGN.md) and [manual browser checks](docs/ACCEPTANCE.md). Production hosting is **not** configured by this repository commit.
