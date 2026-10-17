# Recurring billing, contracts, late fees and the accountant pack

This module covers roadmap items 9, 10, 33, 70 and 95. Everything lives under **Recurring** (Sell group) and two panels in **Settings**. No external account is needed, except an SMTP server for anything that sends email.

## Recurring plans (items 9 and 10)

A plan bills one client on a schedule. Open **Recurring > New plan**.

- **Frequency:** weekly, every 2 weeks, monthly, quarterly, every 6 months or yearly.
  - Month-based plans keep their day: a plan that starts on 31 January bills on 28 or 29 February, then 31 March. Tick **Bill on the last day of the month** to always bill on the month end.
  - Weekly plans step by exactly 7 or 14 days.
- **Lines:** pick a catalog service (it fills the description, rate and SST) or write a custom line. Each plan can have up to 20 lines, a discount, notes and terms. Leave the terms blank to use your default terms from Settings.
- **Service period in the line text:** each line gets the period added, for example "Maintenance – Nov 2026", "Support – Nov 2026 – Jan 2027" (quarterly) or "Support – 2–8 Nov 2026" (weekly). Write `{period}` in a description to place it yourself.
- **End date (optional)** and **contract (optional):** the plan stops billing after the earlier of the two.

### When a period is due

A background check runs every hour. For each active plan it creates the invoice for every due period **once** (a period can never be billed twice, even if the check runs again or overlaps with you pressing **Run now**). Future periods never run early.

What happens next depends on the plan's **automation** setting:

| Setting | What happens |
|---|---|
| Draft only (default) | A draft invoice is created for you to review and issue. |
| Issue automatically | The invoice is created and issued (numbered). |
| Issue and email automatically | As above, then emailed to the client with the PDF. Optionally include a private client link. Set **Email to** to send somewhere other than the client's email. |

Safety rules:

- Issuing and emailing only happen when you choose them on the plan. Every automatic step is written to the audit history (`schedule.draft.created`, `schedule.invoice.issued`, `schedule.invoice.sent`, `email.sent`).
- If the server was off and a plan has fallen behind, missed periods are caught up (up to 12 per plan per hour). Periods more than 7 days old are created as **drafts only**, never issued or emailed automatically, and are marked "Older period" in the plan history.
- If something stops an invoice (an archived client, an inactive service, missing company details for issuing, email not set up, a client without an email address, the mail server refusing the message), the plan shows **Needs attention** with the reason, on the Recurring page and the overview. **Nothing is retried automatically.**
  - If the invoice could not be created, the plan waits. Press **Try again** (or edit the plan) after fixing the cause.
  - If the invoice was created but could not be issued, it stays a draft. Fix the cause and issue it from the invoice.
  - If it was issued but not emailed, press **Send again** on the plan or the invoice.
- **Run now** creates the due invoice straight away and applies the plan's automation. **Pause** stops a plan; resuming a plan that is far behind catches it up as described above.

Plans that never created an invoice can be deleted; used plans are kept for their history (pause them instead). A catalog service used on any plan line cannot be deleted (mark it inactive instead).

**Existing schedules** were converted to one-line plans with the same service, rate, next date and anchor day, in "Draft only" mode. The only visible change is the line text, which now reads "Service – Oct 2026" instead of "Service - 2026-10", and the hourly check now creates their due drafts without a click.

## Contracts and retainers (item 70)

Open **Recurring > Contracts > New contract**: client, title, optional reference, value, start and end dates, renewal term (months) and renewal mode.

- **Link plans** by choosing the contract in a plan's form. Linked plans stop billing after the contract's end date (the last period that starts on or before the end date is billed).
- **Renewal modes:**
  - *Renew manually:* the contract ends after its end date; press **Renew now** to add another term.
  - *Remind me before the end:* N days before the end, a reminder is emailed once to your billing email (Settings) if email is set up. It always shows on the overview.
  - *Renew automatically:* the day after the end date, another term of the chosen length is added and linked plans keep billing.
- **Status:** Active, Expiring (inside the reminder window, 30 days if none is set), Ended, Cancelled. Expiring and recently ended contracts show on the overview and on the client's profile.
- **Cancel** (with a reason) stops linked plans from billing after today. A cancelled contract can no longer be edited or renewed.
- Renewals (manual and automatic), edits, endings, reminders and cancellations are all in the audit history. Each term is listed on the contract page.

## Automatic late fees (item 33)

Turn on in **Settings > Late payment fees**. Off by default.

- **Fee:** a fixed amount (MYR) or a percentage of the unpaid balance.
- **When:** after N days overdue; optionally again every N days while unpaid, up to a number of times; optionally capped at a total amount per invoice.
- Each fee is a numbered **debit note** on the invoice (so balances, statements, reminders and reports include it). Each invoice and fee number is charged at most once, even if the check runs many times. A fee that cannot be charged is recorded on the invoice and not retried.
- Percentage fees use the unpaid balance **without earlier late fees** (no fee on fees). Nothing more is charged once only fees remain unpaid.
- Fees only apply to invoices **issued on or after the day you turned them on**, because those are the invoices that show the policy. The policy is printed on the invoice PDF and the client page ("Late payment").
- **Exclude a client:** edit the client and tick **Never charge late fees to this client**.
- **On an invoice:** **Waive late fees** cancels all its fees with one credit note and stops further fees on it; **Stop late fees** stops future fees without a credit note.
- Fixed fees are in MYR, so they are not charged on invoices in another currency (percentage fees are).
- **Charge due fees now** in Settings runs the check immediately.

Check with your accountant or lawyer that your late fee wording and amounts suit your contracts with clients.

## Monthly accountant pack (item 95)

Set up in **Settings > Monthly accountant pack**.

- The pack for a month contains a **PDF summary** (invoices issued, credit and debit notes, cash received and refunds, SST by rate, aging of unpaid invoices at month end, open invoices) and three **CSV files**: invoices and notes, receipts and refunds, and SST (same layout as the SST report).
- **Automatic email:** tick the box, enter your accountant's email (up to 5 addresses) and the day of the month (1–28, default the 1st). The previous month's pack is emailed once, on that day or within the 6 days after it (if the server was off). If it cannot be sent (for example email is not set up), the failure is shown in the panel and not retried; use **Send now**.
- **Any past month:** choose the month, then **Download pack** (one .zip with the PDF and CSV files) or **Send now** (to the accountant or another address).
- Amounts come from the records in this workspace at the time the pack is made. It is a working aid, not a tax return or a MyInvois report.

## What you need to provide

- **SMTP email settings** (Settings > Integration keys or the server environment) for auto-send, contract reminder emails and the accountant pack. Without them, plans set to email will stop with "Email is not configured" and the pack can only be downloaded.
- Your **billing email** in Settings, to receive contract reminders.
- Complete company details (registration, address, contact) before plans can issue invoices automatically.

## For developers

- Server: `server/ext/recurring.mjs` (routes, jobs, migration), `server/recurring-plans.mjs`, `recurring-contracts.mjs`, `recurring-fees.mjs`, `recurring-pack.mjs`, `recurring-auto.mjs`, `recurring-dates.mjs`. Browser: `public/ext/recurring.mjs` and `.css`.
- Jobs (hourly): `recurring:schedules`, `recurring:contracts`, `recurring:late-fees`, `recurring:accountant-pack`. Each can be run from `POST /api/jobs/<name>/run`.
- Owner routes under `/api/recurring/`; plans keep using `/api/schedules`.
- After restoring a backup, plans go back to "Draft only" and late fees and the automatic pack are turned off until you turn them on again.
