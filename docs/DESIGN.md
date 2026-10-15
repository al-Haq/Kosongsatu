# Nawlogic design and implementation

Based on the 10-page Nawlogic invoice UI/UX concept approved in this conversation. The original user-supplied wordmark is used as a cropped brand asset; the phone screenshot and business registration files are not included.

## Palette

- Teal: `#0EA5A4`, brand accent, collection bars and illustrations.
- Dark teal: `#087F7E`, primary controls and readable text on white.
- Orange: `#F97316`, attention accent; pale orange badges use dark text.
- Ink: `#0F172A`, headings and customer balance card.
- White and cool grey surfaces keep the billing information central.

Reusable fields, tables, status badges, dialogs and panels share one stylesheet. Navigation becomes a drawer on narrow displays. The client portal deliberately omits owner navigation and presents the balance, due date, PDF and payment reference action first.

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

This first implementation uses Node.js 24, SQLite and standard browser modules rather than introducing a build pipeline, multiple services or an external database for a single-owner tool. Financial and authorization rules live on the server. Client forms/preview are convenience only and never authoritative. Integer sen are used for all stored totals. Issuance, conversion, payment recording and recurring generation are transactional.

Keep the data layer separated if a future PostgreSQL migration is required. Add migrations and integration tests before expanding the schema. Do not turn this single-owner implementation into multi-tenant hosting merely by adding an organization field.

### Official workflow references

Reviewed 15 October 2026:

- [Zoho Invoice](https://www.zoho.com/invoice/): quotation-to-invoice workflow, client history and reminders.
- [Invoice Ninja](https://invoiceninja.com/): service billing, recurring workflows and client portal patterns.
- [Stripe hosted invoice page](https://docs.stripe.com/invoicing/hosted-invoice-page): focused customer document and payment experience.
- [Node SQLite API](https://nodejs.org/api/sqlite.html) and [Node crypto API](https://nodejs.org/docs/latest-v24.x/api/crypto.html).

This is an original Nawlogic interface. No partner status or vendor integration is implied by these references.
