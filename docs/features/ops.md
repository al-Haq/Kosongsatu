# Operations

The Operations module covers the work behind an invoice: customer purchase orders that arrive in parts, time you log, projects billed by milestone, stock for businesses that sell goods, and proof of the work you did. Everything is built in and needs no outside account or key.

Screens: **Sales & POs** (customer POs), **Operations > Projects**, **Operations > Timesheets**, **Operations > Inventory** (only shown when inventory is on), plus panels on each quotation and invoice.

## Partial and amended customer POs (no. 67)

**What it does**

- A customer can send several POs for one accepted quotation, for example 40% now and 60% later. Together they can never be more than the quotation total (SST included). The PO form shows how much is left to order.
- Each PO is invoiced once, for its own amount. **Create invoice draft** on a partial PO makes a draft invoice whose total is exactly the PO amount: every quotation line is scaled by the same share, keeps its SST rate, and SST is worked out again on the scaled line. The invoice notes name the PO and the quotation.
  - Very rarely, SST rounding makes the exact amount impossible to reach with whole sen (for example a quotation with a single taxed line). The draft is then 1 sen below the PO, never above it.
  - A full-value PO works as before: the draft is the whole quotation with its original lines.
- A draft billed from a PO can be edited, but its total can never go above the PO. Issuing is refused if it does.
- **Amend** a PO from **Details** on Sales & POs: change the reference, amount, PO date or notes, with a reason. Each amendment is a new revision; the full history (who, when, what changed, why) stays visible and in the audit log.
  - The amount can change only while no live invoice bills the PO. If the PO has a draft invoice, tick the box to remove that draft; a new one can then be made for the new amount. If the invoice is issued, use a credit or debit note instead.
- **Cancel** a PO that is not invoiced (or whose invoice is void). Its amount is freed on the quotation; the PO stays in the history.
- **PO files**: attach the customer's PO as a PDF or image (PNG, JPEG, WEBP), up to 5 MB each and 10 per PO, from the registration form or the PO details. Files are private to you.
- If a partial PO's invoice is voided, the PO can be invoiced again.
- A quotation billed through partial POs can no longer be converted as a whole ("Create / open invoice"); create each invoice from its PO. A quotation that already has a full invoice cannot take partial POs until that invoice is deleted or voided. A quotation with open POs cannot be voided; cancel the POs first.

**Automation**: the rule "Customer PO → invoice draft" (AI & automation) now also runs when a PO is amended, and for partial POs it drafts the PO's own amount. It never issues or sends anything. AI and MCP proposals for customer POs follow the same limits.

## Timesheets → invoice (no. 68)

**What it does**

- Log time with a date, client, optional project, optional service, description, hours (to 2 decimals) and a billable tick.
- The hourly rate is taken from, in order: the rate you type, the chosen service's rate, or the client's **Default hourly rate** (new field on the client form). Billable time needs a rate. The rate is saved with the entry, so later catalog changes do not alter it.
- **Timer**: start it on Timesheets; the start time is kept on the server, so it survives reloads and other devices. A small clock shows in the top bar while it runs. **Stop and save** turns it into a time entry (rounded to 0.01 h, at least 0.01 h). A timer left running for more than 24 hours must be discarded and the time added by hand.
- **Weekly view**: hours per client and project for each day, day totals, billable hours and value, and the week's entries. Use Previous / This week / Next.
- **Invoice unbilled time**: from Timesheets, a project page or a client profile, choose **Create invoice**, untick anything you don't want to bill, and choose either one line per service and rate (default) or one line per entry. SST comes from the service; time without a service uses the SST rate you pick. One draft invoice is created and the entries are linked to it in the same step.
  - Linked time cannot be billed twice, edited or deleted.
  - Deleting the draft, or **Release time and milestones** on the draft, makes the time billable again. Voiding the issued invoice releases it too. Time on an issued invoice stays locked.
  - One invoice holds up to 50 lines.

## Projects and milestone billing (no. 69)

**What it does**

- A project has a client, name, budget (before SST), start and end dates, and a status (planned, active, on hold, completed, cancelled).
- Milestones have a name, an amount or a percentage of the budget, an SST rate, a due date and a status: pending, ready, invoiced. Milestones cannot add up to more than the budget. Percentages need a budget and follow it until the milestone is invoiced.
- **Invoice** on a milestone creates a draft invoice with one line for it, once. Deleting the draft or voiding the invoice puts the milestone back to ready.
- The project page shows **budget, invoiced, paid and time logged**, unbilled time, milestones, recent time and the linked invoices.
  - Invoiced is the project's share (before SST) of issued invoices; drafts are shown separately.
  - Paid is the paid part of each linked invoice applied to the project's share of it.
- The overview shows unbilled time and milestones ready to bill.

## Simple inventory (no. 71)

Off by default. Service businesses can leave it off; nothing about invoices changes while it is off.

**How to turn it on**: Settings > Operations > Inventory > **Turn on**, or Operations > Inventory.

**What it does**

- Track only the catalog items you choose, each with an optional SKU, an opening quantity and a reorder level. Quantities allow 2 decimals.
- Movements: **Receive** (with an optional supplier reference), **Adjust** up or down with a required reason, and automatic **deduct** and **put back**. Every movement keeps the balance after it and who made it.
- Stock is deducted when an **invoice** is issued, or, if you choose, when a **delivery order** is issued (use one or the other so goods are not counted twice). Lines are matched to tracked items by catalog item (`service_id`) or SKU. Voiding the document puts the stock back, once.
- Stock may go below zero; issuing an invoice is never blocked. Items at or below their reorder level, or out of stock, are flagged on the overview and the Inventory page.
- A tracked item with stock history cannot be deleted from Services; mark it inactive instead.

**Caveats**

- Matching needs the catalog item or SKU on the invoice line. Lines typed by hand without one are not counted.
- Invoices made from partial customer POs and from timesheets carry scaled or time lines without a catalog item, so they do not move stock. Record those goods with a delivery order or an adjustment.

## Proof of work (no. 97)

**What it does**

- On any quotation or invoice, add **before and after photos**, a **work log** (date, person, notes) and a **service report**. Use the **Proof of work** panel on the document.
- Nothing is shown to the client until you mark it **Client can see**. You can show or hide each photo, each log entry and the report at any time.
- The client's document link shows the visible report, photos and log. Clients reach photos only through their document link, and only when they are marked visible for that document; revoking the link or hiding a photo stops access straight away.
- The PDF (download and email attachment) includes the visible report, up to 4 visible photos and the visible log. Untick **Include proof of work in the PDF** in the report form to leave it out.

**Limits**: images only (PNG, JPEG or WEBP), up to 5 MB each and 12 per document; up to 100 log entries. Photos uploaded from the browser are resized to 1600 px and re-saved as JPEG, which also removes camera details such as GPS location. The PDF shows PNG and JPEG photos (WEBP photos appear on the client page only). Proof of work on a void document can no longer change. Deleting a draft deletes its proof of work.

## Data, backups and export

All records live in the main database, so encrypted backups include them. The JSON business export includes PO revisions, projects, milestones, time entries, stock items and movements, work logs and reports (file contents are not exported; they stay in backups).
