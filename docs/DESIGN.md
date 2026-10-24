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

## Autosave and offline

What you type into a workspace form is kept on the device as you type (`public/autosave.mjs`). Nothing is lost if the computer or phone switches off, the tab closes or the connection drops before you press Save.

**What gets kept, and where**

- Each form's unsaved input is saved in the browser's `localStorage` for the signed-in user, about half a second after the last keystroke, and again when the page is hidden or closed.
- Lines are kept too, including lines added later: invoices and quotations, recurring plans, supplier bills and purchase orders. A module keeps its own lines through an `autosave` capture/restore hook, and lists the actions that open its forms in `autosaveOpeners`.
- A draft is only kept if all of it can be put back. A form with line rows but no hook is not autosaved, and neither is a form where rows were added or removed. Such a form is never restored by half.
- A draft belongs to its record and its parent. Every `data-` attribute on the form is part of the draft's key: the record (`data-id`) and the parent it is saved under (`data-project`, `data-doc`, `data-client`…). A milestone typed under one project never opens under another. Request keys are not part of the draft's key.

**Getting it back**

- Opening the same form again restores what was typed, with the note "Restored what you typed on … It is not saved yet." and a **Discard** button. A form on a page, such as Settings, is restored when you go back to that page.
- After signing in or reloading, any unsaved work whose form is not on screen is listed once at the top under "Unsaved changes on this device". It has **Open**, for new or edited documents, clients and services, or the page it came from, and **Discard**.

**When a draft is removed**

- Saving the form, or **Cancel**, Close or Esc on a dialog.
- Signing out removes that user's drafts from the device.
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
