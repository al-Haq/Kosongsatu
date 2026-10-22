# Communication (comms module)

Email settings, email templates, open and bounce tracking, WhatsApp Business, owner notifications, the collection follow-up agent and link previews for shared invoices.

Everything here is optional. Nothing is sent automatically unless you switch it on, every message is logged, and anything automatic goes out at most once.

Roadmap items: 32, 38, 40, 41, 43, 45, 90 and 96 (docs/100-CIRI.md).

---

## 1. Email setup (no restart needed) — items 32 and 38

Emailing invoices, quotations, statements, receipts and reminders needs an SMTP account from your email provider.

**Settings > Integration keys > Comms**

| Key | What to enter |
|---|---|
| SMTP server (`SMTP_HOST`) | e.g. `smtp.gmail.com`, `smtp.zoho.com`, `email-smtp.ap-southeast-1.amazonaws.com` |
| SMTP port (`SMTP_PORT`) | `587` (STARTTLS, default) or `465` (TLS) |
| SMTP username (`SMTP_USER`) | usually your email address or the provider's SMTP user |
| SMTP password (`SMTP_PASS`) | the SMTP password or an app password (Gmail and Microsoft need an app password) |
| From address (`MAIL_FROM`) | e.g. `Nawlogic Billing <billing@nawlogic.my>` |
| Reply-to address (`MAIL_REPLY_TO`) | optional; where client replies go |

- Keys are stored encrypted and never shown again. If the same name is set as a server environment variable, the server value wins (the panel says where the settings come from).
- Changes apply to the next email: the mail connection is rebuilt when the settings change. No restart.
- **Settings > Email delivery > Send test email** sends a test to you. If it fails you see a plain reason (wrong password, cannot connect, sender refused) without the server's raw reply.
- Automatic payment reminders (Settings > Messages > Email reminders) start working as soon as email is set up and you tick the option.

## 2. Email templates — item 40

**Settings > Email templates** lists every message in English and Bahasa Melayu: invoice, quotation, other documents (proforma, sales and delivery orders), receipt, statement of account, reminder before the due date and reminder after the due date. Each starts with a written default; "Edited" means you changed it.

- **Language:** the document's language (if set), then the client's language (if set), otherwise the *Default language for client messages* in Settings > Email delivery. You can also pick the language in the email form.
- **Placeholders:** `{{client_name}}`, `{{contact_name}}`, `{{number}}`, `{{amount}}`, `{{balance}}`, `{{paid}}`, `{{due_date}}`, `{{issue_date}}`, `{{link}}`, `{{company}}`, `{{bank_details}}`, `{{document_type}}`, `{{document_title}}`, plus `{{days_left}}` / `{{days_overdue}}` in reminders, `{{paid_date}}` / `{{invoice_numbers}}` / `{{payment_method}}` in receipts and `{{period_from}}` / `{{period_to}}` in statements. The editor lists the ones each template can use; click one to insert it.
- **Optional parts:** `{{#link}}View online: {{link}}{{/link}}` only appears when there is a link; `{{#bank_details}}…{{/bank_details}}` only when your bank details are set. `{{^link}}…{{/link}}` appears only when there is *no* link.
- **Preview** uses a real document, receipt or client of your choice (example values if there are none yet).
- **Checks:** an unknown placeholder such as `{{nmber}}` or a missing `}}` is shown and cannot be saved, so a typo never reaches a client.
- **Reset to default** restores the original text.
- The email form is filled in from the template; you can still edit the subject and message before sending. `{{link}}` stays as a placeholder in the form and becomes the new private link when you tick *Include a private online link*.
- Statements keep `{{period_from}}`, `{{period_to}}` and `{{balance}}` until sending, so they match the dates you choose.

Receipts can be emailed from the invoice page (Receipts panel). Tick *Email the official receipt to the client when a payment is recorded* to send them automatically (once per receipt; turning it on never emails old receipts).

## 3. Branded emails, open and bounce tracking — item 41

Every email has a plain-text part and a simple branded HTML part (logo, teal bar, a "View and pay online" button when a link is included). Everything in it is escaped.

### Open tracking (opt-in)

Tick **Track when clients open emails**. Each email then carries a tiny image with a one-off code; the email log shows *Opened*, how many times, and when.

Opens are approximate:
- many mail apps block images, so a read email may never show as opened;
- some (Apple Mail privacy protection, Gmail's image proxy, security scanners) load images automatically, so an email can show as opened without anyone reading it.

### Bounces and spam complaints

Rejections by your own SMTP server already show as **Failed**. Bounces that happen later (mailbox does not exist, mailbox full, marked as spam) can be reported by your mail provider:

1. Set **Bounce webhook token** (`MAIL_EVENTS_TOKEN`) in Integration keys to a long random text.
2. Give your provider this address: `https://YOUR-DOMAIN/api/hooks/comms/mail-events?token=YOUR_TOKEN`
   (the token can instead be sent as `Authorization: Bearer YOUR_TOKEN`, an `X-Webhook-Token` header, or as the password of basic auth, e.g. `https://hooks:YOUR_TOKEN@YOUR-DOMAIN/api/hooks/comms/mail-events`).

Supported reports:

| Provider | Setup |
|---|---|
| **Amazon SES** | Create an SNS topic, set it for Bounce and Complaint notifications of your identity, add an HTTPS subscription with the address above. The first message is a subscription confirmation: Settings > Email delivery shows a *Confirm subscription* button; open it once, then press *Done*. Turn on "Include original headers" for the best matching. |
| **Postmark** | Message stream > Webhooks > add the address, tick Bounce and Spam complaint. |
| **Mailgun** | Sending > Webhooks: add the address for *Permanent failure*, *Temporary failure* and *Spam complaints*. |
| **SendGrid** | Settings > Mail settings > Event webhook: add the address, tick Bounced, Dropped and Spam reports. |
| **Anything else** | Post JSON in the generic format below. |

Generic format (one object, an array, or `{ "events": [...] }`):

```json
{ "type": "bounce", "permanent": true, "email": "client@example.com",
  "reason": "550 5.1.1 mailbox unknown",
  "message_id": "<id@your-domain>", "kosongsatu_id": "optional log id" }
```

`type` is `bounce`, `soft_bounce`, `complaint` or `delivered`.

Reports are matched to the sent email by the `X-Kosongsatu-Id` header (and the provider metadata headers added when the token is set: Postmark metadata, Mailgun variables, SendGrid unique args, SES message tags), then by Message-ID, then by the provider's own ID from the SMTP reply (Amazon SES replaces the Message-ID header). Unmatched reports are ignored.

What you see: *Bounced*, *Soft bounce* or *Spam complaint* on the email log entry; a warning on the client profile, in the email form and under Settings > Email delivery for addresses with a hard bounce or complaint (*Clear warning* once fixed); and an optional owner notification.

## 4. WhatsApp Business (Cloud API) — item 43

The free **Share via WhatsApp** link (opens WhatsApp with the link typed in) keeps working without any account. The Cloud API sends messages from your business number automatically and reports delivery.

### What you need from Meta

1. A Meta Business account, a WhatsApp Business Account and a phone number added in WhatsApp Manager.
2. A Meta app with the WhatsApp product, and a **permanent system user access token** with `whatsapp_business_messaging` (and `whatsapp_business_management`).
3. **Message templates approved** in WhatsApp Manager. Messages that you start (invoice links, reminders, alerts to yourself) must use an approved template; free text is only allowed within 24 hours after the other person last wrote to you.

### Keys (Settings > Integration keys > Comms)

| Key | Where to find it |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | Business Settings > System users > Generate token |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Manager > API setup (a number ID, not your phone number) |
| `WHATSAPP_APP_SECRET` | Meta app > Settings > Basic > App secret (used to check webhook signatures) |
| `WHATSAPP_VERIFY_TOKEN` | any long random text you choose |
| `WHATSAPP_API_VERSION` | optional, default `v25.0` |

### Webhook (delivery statuses and replies)

In the Meta app > WhatsApp > Configuration, set the callback URL shown in Settings > WhatsApp Business (`https://YOUR-DOMAIN/api/hooks/comms/whatsapp`), enter your verify token and subscribe to the **messages** field. The app answers Meta's verification only with the right verify token and accepts events only with a valid `X-Hub-Signature-256` signature.

### Templates

Settings > WhatsApp Business: map each message to your approved template.

| Message | Used for |
|---|---|
| Send invoice link | WhatsApp button on invoices and other documents |
| Send quotation link | WhatsApp button on quotations |
| Payment reminder | WhatsApp reminders and collection follow-ups |
| Owner notification | alerts to your own WhatsApp number (values: `title`, `summary`, `link`) |

For each, enter the template name, language code (`en`, `en_US`, `ms`…) and the values for its parameters in order, e.g. `contact_name, number, balance, due_date` for a body `Hi {{1}}, invoice {{2}} for {{3}} is due on {{4}}.` For a template with named parameters write `customer=contact_name, invoice=number`. For a URL button whose URL is `https://YOUR-DOMAIN/client/{{1}}`, choose *URL button ending with the private link token*.

Example template to submit (Utility category): *"Hello {{1}}, your invoice {{2}} for {{3}} is ready. Due date: {{4}}. Tap below to view and pay."* with a *Visit website* button `https://YOUR-DOMAIN/client/{{1}}`.

### Sending

- **WhatsApp** button on an issued document sends the mapped template to the client's phone number (Malaysian numbers like `012-345 6789` become `60123456789`). If the template uses the link, a new private link is created and the previous one stops working.
- **Payment reminders by WhatsApp** (opt-in) use the same days as the email reminders and go out once per invoice and stage.
- **Send test message** sends Meta's `hello_world` sample template to a number of your choice.
- Every message is logged with its status: Sent, Delivered, Read or Failed (with Meta's reason).

### For other modules

`ctx.services.whatsapp`:
- `send({ to, text })` (inside the 24-hour window), `send({ to, use: "invoice_link", vars })` with one of your mapped templates, or `send({ to, template, language, components })`; optional `kind`, `documentId`, `clientId`, `dedupeKey` (at most once).
- `onInbound(handler, { clients })` — `handler({ from, fromOwner, text, type, id, timestamp, name, clientId, reply })` runs once per inbound message. Only messages from the owner's number (Settings > Owner notifications) are passed unless `{ clients: true }`. Return a string (or call `reply(text)`) to answer.
- `status()`, `configured()`, `windowOpen(number)`.

## 5. Owner notifications — item 45

The bell in the top bar shows new events with an unread count; open it to see the list, jump to the record or mark everything as read.

Events: payment received (from online payments, connectors or automations; not the payments you record yourself), online payment paid, quotation accepted by the client, payment reference or slip submitted, document opened for the first time (off by default), email bounced or marked as spam, e-Invoice rejected (audit actions named like `einvoice.*.rejected` / `myinvois.*.invalid`).

Settings > Owner notifications: per event, choose In app, Email and/or WhatsApp, and where email and WhatsApp alerts go (email defaults to your sign-in address; WhatsApp needs the Owner notification template).

Each event creates one notification (enforced by a unique key on the audit entry) and each email or WhatsApp alert is claimed before it is sent and never retried, so you are never notified twice. An online payment is announced once, not as both a receipt and a payment. A bounced notification email is never re-emailed.

## 6. Collection follow-ups (AI collection agent) — item 90

For overdue invoices, the app prepares a polite follow-up in the client's language. **Nothing is sent until you approve it.**

- **Tone** gets firmer with time and with unanswered reminders: *gentle* (under 14 days), *firm* (14–29 days, or after two reminders), *final* (30 days or more). The final tone asks for payment or a payment plan within 7 days and may mention pausing further work; it never threatens legal action.
- **Drafts** come from well-written built-in English and Malay texts, or from your AI model if one is configured (Settings > Automation shows the model) and you tick *Draft with the AI model*. The model only receives the tone, language, days overdue, number of earlier reminders and whether part was paid. It writes with placeholders; names, amounts, invoice numbers, bank details and links are filled in by the app when sending. A model answer with links, email addresses, invented facts or broken placeholders is discarded and the template is used.
- **Where drafts appear:** overview (*Follow-ups awaiting approval*), the invoice page, and Automation > Review queue. *Prepare follow-up* on an overdue invoice makes one on demand; *Prepare drafts now* or the automatic option (every 6 hours, after the number of days you choose) covers all overdue invoices. One draft per invoice waits at a time, and each stage is drafted once.
- **Review and send:** edit the subject and message, choose email and/or WhatsApp, optionally include a new private link, then *Approve & send*. It is sent once and logged (email log, WhatsApp log, audit). Approving from the AI review queue also sends it right away. If the invoice is paid before sending, nothing goes out.
- **WhatsApp** sends your *Payment reminder* template, or your approved text itself when the client wrote to you in the last 24 hours.

## 7. WhatsApp link previews — item 96

When a client link (`/client/<token>`) is pasted in WhatsApp, Telegram, Facebook or similar, the preview shows e.g. *"Invoice INV-2026-0001 from NAWLOGIC SYSTEMS SOLUTION — Amount due RM 1,500.00 · Due 31 Oct 2026 · View and pay online"* with the brand image `public/assets/link-preview.png` (1200×630).

- Only valid, unexpired, non-void links get details. Revoked or expired links show a generic "Document from <company>" preview with no number or amount.
- Building the preview never marks the document as viewed.
- Links must be absolute: set `APP_URL` to your public HTTPS address.

## Restore and export

- A restored backup never sends on its own: automatic receipts, WhatsApp reminders, the follow-up agent, email reminders and email/WhatsApp notification channels are switched off, and approved-but-unsent follow-ups are cancelled. Switch them back on after checking.
- The business export includes templates, settings, WhatsApp log, notifications, bounce records and follow-ups. Keys and tokens are never exported.

## Limits and caveats

- Opens are approximate (see above). Bounces need a provider webhook.
- WhatsApp templates must be approved by Meta first; Meta charges per conversation/message according to its pricing. Business-initiated free text is not possible outside the 24-hour window.
- AI drafts use your configured model and are subject to its availability; templates are always the fallback.
- Chinese (`zh`) documents use the business default language for messages; only English and Malay templates exist.
- Mail settings entered in Settings are ignored for any key also set in the server environment.

## Reference

Routes (owner): `PUT /api/comms/settings`, `GET /api/comms/templates`, `PUT|DELETE /api/comms/templates/:use/:lang`, `POST /api/comms/templates/preview`, `GET /api/comms/compose`, `POST /api/comms/mail/test`, `POST /api/comms/mail/sns-confirmed`, `POST /api/comms/addresses/clear`, `GET /api/comms/notifications`, `POST /api/comms/notifications/read`, `POST /api/comms/receipts/:id/email`, `POST /api/comms/documents/:id/whatsapp`, `POST /api/comms/whatsapp/test`, `POST /api/comms/documents/:id/follow-up`, `POST /api/comms/collections/run`, `POST /api/comms/collections/:proposal/approve`, `POST /api/comms/collections/:id/retry`.

Guest and webhooks: `GET /api/guest/comms/open/<token>.gif`, `GET|POST /api/hooks/comms/whatsapp`, `POST /api/hooks/comms/mail-events`.

Jobs: `comms:notifications` (every minute: notifications, automatic receipts, approved follow-ups), `comms:whatsapp-reminders` (hourly), `comms:collections` (every 6 hours).
