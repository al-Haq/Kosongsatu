# Nawlogic design and implementation

Based on the 10-page Nawlogic invoice UI/UX concept approved in this conversation. The original user-supplied wordmark is used as a cropped brand asset; the phone screenshot and business registration files are not included.

## Palette

- Teal: `#0EA5A4`, brand accent, collection bars and illustrations.
- Dark teal: `#087F7E`, primary controls and readable text on white.
- Orange: `#F97316`, attention accent; pale orange badges use dark text.
- Ink: `#0F172A`, headings and customer balance card.
- White and cool grey surfaces keep the billing information central.

Reusable fields, tables, status badges, dialogs and panels share one stylesheet. Navigation becomes a drawer on narrow displays. The client portal deliberately omits owner navigation and presents the balance, due date, PDF and payment reference action first.

## Left menu and Overview

In the left menu, the current page is a black pill with white text, and the group names (Sell, Get paid, Records...) are in plain case.

The Overview shows:

- **Invoiced** and **collected** this month, each against the same days last month, with a 12-week sparkline.
- **Outstanding**, with an aging bar.
- **Overdue**, with how late the oldest invoice is.
- **Collections** for the last 12 weeks against the 12 weeks before. Hover a week for its figures.
- **Needs attention**, with days late.
- **Aging**: open invoices by days past due, in MYR at each invoice's rate.

The charts are SVG built from attributes only, because the CSP allows no inline styles.

## Setup checklist, modules and the business's own brand

Built by the `setup` module (`server/ext/setup.mjs`, `public/ext/setup.mjs`). Owner guide: [features/setup.md](features/setup.md).

**Setup checklist.** Until every step is done or the owner hides it, the top of the Overview shows "Set up your workspace" with "N of 8 done", a progress bar, and the open steps. Each step has one line on why it matters and a button to the exact place to fix it: the Settings tab opens with the field focused or the section in view. Done steps fold away under "Done".

1. Company details: business name, registration number, address, email and phone.
2. Business logo (Settings > Documents).
3. Bank details for transfers.
4. SST registration. Optional: **Not registered** marks it done.
5. Email sending (SMTP, under Integration keys).
6. Online payments. Optional: **Not now**.
7. Encrypted backups with an off-site copy.
8. First client and first issued invoice.

Two-step sign-in (MFA) is hidden for now (`public/ext/features.mjs`), so it is not a step.

The steps are worked out in the browser from the workspace data it already has. **Hide** is saved in Settings, so the checklist stays hidden on every device; **Show again** is under Settings > Modules. Staff and accountants never see it. It takes the place of the older "add your company details" notice while it shows.

**Modules.** Settings > Modules has a switch for each optional module: sales pipeline, proforma invoices, sales and delivery orders, recurring billing, bank matching, expenses/bills/reports, tax and e-Invoice, projects/timesheets/inventory, client portal and feedback, automation and assistant, and webhooks. Turning one off hides its menu entries, its Overview panels and its Settings sections, and nothing else: records, pages opened by link, server routes, background jobs and client links keep working, and turning it back on brings everything back. Overview, quotations and invoices, clients, services, payments, Settings and team cannot be turned off. Every module starts on, so an upgrade changes nothing. Only the owner can change this.

- The list is `MODULES` in `public/ext/setup-modules.mjs`, shared by the browser and the server. Each module names its menu entries (nav keys, from the core menu or a module's `nav`), the browser modules whose `overview` panels it owns, and the headings of its Settings sections.
- `public/app.mjs` leaves those out in three places: `allNav()`, `slot("overview")` and the Settings tabs.
- Settings stores only what is off (`modules: { books: false }`), so a missing key means on. `PUT /api/ext/setup` (owner only) changes it, with `dismissed` and `skipped` for the checklist; unknown modules and required steps are refused, and each change is audited.

**The business's own brand.** Once the business name differs from the default ("NAWLOGIC SYSTEMS SOLUTION"), the sidebar and the sign-in page show it instead of Nawlogic, with the logo from Settings > Documents when there is one. The browser tab reads "Invoices · Kedai Aminah Sdn Bhd" or "Sign in · Kedai Aminah Sdn Bhd". With neither set, the Nawlogic logo and name stay.

Before sign-in the page calls `GET /api/guest/setup/branding`, which returns only `{ company, logo }`: the name (or null) and the logo's address (or null). `GET /api/guest/setup/logo` serves that one image without a session, and only while it is set. No other setting or file becomes public, and client links do not carry the module or checklist settings.

## Autosave and offline

What you type into a workspace form is kept on the device as you type (`public/autosave.mjs`). Nothing is lost if the computer or phone switches off, the tab closes or the connection drops before you press Save.

**What gets kept, and where**

- Each form's unsaved input is saved in the browser's `localStorage` for the signed-in user, about half a second after the last keystroke, and again when the page is hidden or closed.
- Lines are kept too, including lines added later: invoices and quotations, recurring plans, supplier bills and purchase orders. A module keeps its own lines through an `autosave` capture/restore hook, and lists the actions that open its forms in `autosaveOpeners`.
- A draft is only kept if all of it can be put back. A form with line rows but no hook is not autosaved. Neither is a form whose rows changed: a row added or removed, or one removed and a new one added in its place. A field's row is known from the `data-` attributes around it, such as a custom field row's `data-field`, and a tick box's or option's from its value, such as a time entry's id. A draft is never restored by half, or into the wrong rows.
- Restoring a draft fires `input` and `change` only on fields whose value changes, as if typed. A module that fills fields when another changes, and does so after a wait (an email language's template), must not overwrite text typed or restored during that wait.
- A draft belongs to its record and its parent. Every `data-` attribute on the form is part of the draft's key: the record (`data-id`) and the parent it is saved under (`data-project`, `data-doc`, `data-client`…). A milestone typed under one project never opens under another. Request keys are not part of the draft's key.

**Getting it back**

- Opening the same form again restores what was typed, with the note "Restored what you typed on … It is not saved yet." and a **Discard** button. A form on a page, such as Settings, is restored when you go back to that page.
- A draft remembers the page its form was on, even if you leave the page straight after typing.
- After signing in or reloading, any unsaved work whose form is not on screen is listed once at the top under "Unsaved changes on this device". It has **Open**, for new or edited documents, clients and services, or the page it came from, and **Discard**.

- A save that reached the server but whose answer was lost (the connection dropped, or the power went) is not done twice. Its request key is kept on the device until the server answers, and kept with the draft for a module form's own key (`data-request-key`, `data-key`). Sending the restored draft again reuses the key, and the server returns the first result.

**When a draft is removed**

- Saving the form, or **Cancel**, Close or Esc on a dialog.
- Signing out removes that user's drafts and kept request keys from the device.
- Drafts expire after 7 days.

**What is never kept**

- Password, code and key fields.
- File pickers and hidden fields.
- The sign-in, password, MFA, integration-key and backup-key forms.

**Offline**

- A bar at the bottom says "You are offline…".
- A save that cannot reach the server says "No connection. What you typed is kept on this device. Save again when you are back online."
- Saving again reuses the same idempotency key, so a payment or document is never recorded twice.

The browser-test server raises the sign-in limit (`loginLimit`), because every test signs in. Production keeps 10 attempts per address per 15 minutes, and a unit test covers that limit.

## Ten workflows

1. Dashboard: separate invoiced value, collected payments, outstanding and overdue.
2. Invoice list: search and status filters; CSV export.
3. Invoice editor: catalog or custom items with live totals, save then review.
4. Quotations: share, accept via client link, convert once to an invoice draft.
5. Clients: contact details and one document history.
6. Services: default rates/units with scope editable on each draft.
7. Recurring: monthly schedules generate drafts for deliberate review.
8. Payments: partial/full payments, evidence references, reversal and receipts.
9. Client portal: responsive document-specific view with PDF and acceptance/reference actions.
10. Settings: company identity, payment instructions, numbering, password and data export.

## Deliberate simplifications

This implementation uses Node.js 24, SQLite and standard browser modules rather than introducing a build pipeline, multiple services or an external database for a single-owner tool. Financial and authorization rules live on the server. Client forms/preview are convenience only and never authoritative. Integer sen are used for all stored totals. Issuance, conversion, payment recording and recurring generation are transactional.

Keep the data layer separated if a future PostgreSQL migration is required. Schema v2 migrations retain legacy payments as cash receipts, quarantine ambiguous duplicates and preserve rollback snapshots. Do not turn this single-owner implementation into multi-tenant hosting merely by adding an organization field.

### Official workflow references

Reviewed 15 October 2026:

- [Zoho Invoice](https://www.zoho.com/invoice/): quotation-to-invoice workflow, client history and reminders.
- [Invoice Ninja](https://invoiceninja.com/): service billing, recurring workflows and client portal patterns.
- [Stripe hosted invoice page](https://docs.stripe.com/invoicing/hosted-invoice-page): focused customer document and payment experience.
- [Node SQLite API](https://nodejs.org/api/sqlite.html) and [Node crypto API](https://nodejs.org/docs/latest-v24.x/api/crypto.html).

This is an original Nawlogic interface. No partner status or vendor integration is implied by these references.

## Financial state in v0.2

Cash receipts represent money received. Payments are invoice allocations against those receipts, with separate releases and reversal history. Credit/debit notes adjust the invoice value; refunds consume unallocated cash. Dashboard cash is receipts less refunds by event date, independent of invoice allocation. See [the release matrix](RELEASE-0.2.md).

Financial writes run in SQLite transactions. Optional idempotency keys bind a scope and request payload to one result; keys reused with different input are rejected. Secret-bearing link and MFA responses are excluded from this cache. Browser retries retain request keys in memory after transport/server failures.

MFA secrets use AES-256-GCM with a server key outside the database; recovery codes are hashed and consumed transactionally. Backups use a separate encryption key and a private temporary directory for the online SQLite snapshot. Request-scoped audit actors distinguish owner, client-link and system actions. Audit entries have database update/delete guards and are chained with SHA-256 (`prev_hash`, `hash`); tampering is detectable against a chain head recorded outside the server, not provable against a server administrator who rewrites everything after the last recorded head.
