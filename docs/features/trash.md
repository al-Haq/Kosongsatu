# Recently deleted

Everything you delete in Nawlogic stays in **Recently deleted** (Workspace → Recently deleted) for **30 days**, so a mistake can be undone. After 30 days the copy is removed for good.

## Undo and restore

- Right after a delete, the message at the bottom of the screen has an **Undo** button for a few seconds. It brings the record straight back and, for drafts, clients, projects, plans and contracts, opens it again.
- Later, open **Recently deleted** and click **Restore** on the item.
- A restored record is exactly what was deleted: the same ID, lines, notes and dates, with its attached files and the records that belong to it (a project's milestones, a client's portal contacts and settings).
- Links the delete cleared come back too. Deleting a draft invoice frees its milestones and time entries; restoring the draft bills them on it again, unless they were billed on another invoice in the meantime. Then they stay where they are and the message says so.

## What can be restored

| Deleted | Comes back as |
| --- | --- |
| Draft invoice, quotation, proforma, sales or delivery order | The draft, with its attachments |
| Client (only possible without documents) | The client, with portal contacts and portal settings |
| Service | The service |
| Recurring plan (only possible before its first invoice) | The plan, **paused**: check the next date, then resume it |
| Contract | The contract and its terms and files |
| Client contact | The contact |
| Sales opportunity | The opportunity |
| Vendor, expense, recurring cost | The record, with its files |
| Project, milestone, time entry | The record (a project with its milestones) |
| Work log entry, work photo, document attachment, PO file | The entry or file |
| Webhook endpoint | The endpoint, **switched off**: turn it on when you are ready |

Things restore in order: a draft whose client was also deleted asks you to restore the client first. A vendor cannot be restored while another active vendor has its name.

## What is never deleted

Issued invoices and quotations, receipts, payments, credit and debit notes and the audit trail are never deleted, so they never appear here. Void a document, reverse a payment or void a receipt instead; all of these stay in the history with the reason.

Sign-in sessions, client portal links and invitation tokens are not kept either: a restored client contact needs a new portal link.

## Who can do what

- **Owner:** sees every deleted item, restores anything, and can **Delete for good** before the 30 days are up (for example for personal data a client asked you to remove).
- **Staff:** see and restore only what they deleted themselves.
- **Accountant:** read-only; no access.

Every delete, restore and removal for good is in the audit trail with who did it.

## Backups

Deleted items are part of the database, so encrypted backups include them until they expire. Restoring a backup brings back Recently deleted as it was at backup time.
