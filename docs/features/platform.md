# Platform: quick invoices, webhooks, import, installable app and hosting

This module covers roadmap items 80, 84, 85, 88 and 100. Everything here works without any outside account except where a section says otherwise.

| Feature | Where | Needs |
| --- | --- | --- |
| Quick invoice from plain language (88) | Overview, **Quick invoice** button in the top bar | Nothing. Optional: your AI model, WhatsApp connection |
| Outgoing webhooks (84) | Workspace › **Webhooks** | An HTTPS endpoint (n8n, Zapier, Make, your own server) |
| Data import (85) | Workspace › **Import** | A CSV file |
| Installable app (85) | Settings › **Install the app** | HTTPS (or localhost) |
| Hosting kit and one-command install (80, 100) | `docker-compose.yml`, `scripts/`, [DEPLOYMENT.md](../DEPLOYMENT.md) | Your own server and domain |

## Quick invoice

Type what to bill, in Bahasa Melayu or English, for example:

- `Invois ABC Sdn Bhd, maintenance Oktober, RM1,500`
- `Quote Meranti Digital: 3 days onsite support at RM800/day, due in 30 days`
- `inv meranti - cloud setup 1.5k + maintenance oct rm750`
- `Bil ABC: 2 x laptop repair @ RM150, diskaun 10%, tempoh 14 hari`

You get a **draft preview** to check and edit (client, document type, dates, lines, SST, discount, notes). **Save draft** creates a normal draft; it is never issued, shared or sent. Open it, check it and issue it yourself.

What the parser understands, without any AI model:

- **Document type**: invois, invoice, inv, bil, bill (invoice); quote, quotation, sebut harga, estimate (quotation). Invoice when none is given.
- **Client**: matched to your existing clients, ignoring "Sdn Bhd", "(M)", "Enterprise" and similar, with small typos and short forms ("Meranti Dig"). When two clients fit equally, you choose. When no client matches, you can add the typed name as a new client with the draft. Archived clients are never matched.
- **Amounts**: RM1,500 · RM 1500.00 · 1500 ringgit · 1.5k · RM2.5K · 3 ribu · 5rb · RM1.2j (juta).
- **Quantity and rate**: `3 days … at RM800/day`, `2 x … @ RM150`, `x2 … RM150 each`, `12 months @ RM50 per month`, `RM600 sehari`, `tiga hari`. An amount after a quantity without `@`, `at`, `/day`, `each` or `per` is read as the line total and the rate is worked out (the preview says so). `total RM2,400` after a per-day rate is checked against it.
- **Several lines**: separate with commas, `+` or just write the next amount (`cloud setup 1.5k + maintenance oct rm750`).
- **Periods**: month names in both languages (Oktober / October, Ogos / August, Disember / December), `bulan lepas` / `last month`, `bulan ini`, `next month`, `Q3 2026`, ranges like `Okt-Dis`. The period is added to the line, e.g. "Maintenance - Oktober 2026". "Mac" is only March with a year or "bulan" before it (so "Mac mini repair" stays as it is).
- **Due date**: `due in 30 days`, `net 30`, `payment terms 45 days`, `tempoh 14 hari`, `bayar dalam 7 hari`, `60 hari kredit`, `due 15/11/2026`, `sebelum 30 Nov`, `valid until 1 Dec`, `sah 14 hari`, `due on receipt`, `hujung bulan`. Otherwise the client's payment terms.
- **Catalog services**: a line that matches a service (also through common Malay words such as penyelenggaraan, sokongan, pemasangan) takes the service's SST rate; a line with no amount takes the service's rate.
- **SST**: `+SST`, `SST 6%`, `tanpa SST`. SST is only added after your SST registration number is set in Settings. Dates are written day first (15/11/2026).
- **Discount and notes**: `discount 10%`, `diskaun RM100`, `5% off`; `note: PO 4500012345`.

### Optional: your AI model

If an AI model is configured for the assistant (`AI_BASE_URL`, `AI_MODEL`, see [AUTOMATION.md](../AUTOMATION.md)) and the parser cannot read every part of a request, the preview offers **Ask the AI model**. You must tick a box each time; then only the request text and your client and service *names* (with service rates) are sent to that provider. The model's answer is checked like the parser's own result: the client is matched again against your real records, amounts go through the same rules, and you still review the draft. The use is recorded in the audit log.

### Optional: from your own WhatsApp

When the WhatsApp connection (Messages module) is set up, set **Owner WhatsApp number for quick invoices** in Settings › Integration keys (`PLATFORM_OWNER_WHATSAPP`, e.g. `60123456789`; several numbers can be separated by commas). Then a message **from that number** that starts with Invois, Invoice, Quote or Sebut harga is read the same way. When the client and every amount are clear, a draft is saved and you get a reply with its link; otherwise the reply asks you to name the client or rephrase. Messages from other numbers and other messages are ignored. Each message is handled once, and at most 30 drafts an hour are made this way. The AI model is never used for WhatsApp messages. Without the WhatsApp connection this stays off.

## Outgoing webhooks

Webhooks send business events to your automation tools the moment they happen, without polling.

1. Open **Webhooks** › **Add endpoint**, paste the HTTPS URL your tool gives you, choose the events and confirm with your password (and authenticator code if MFA is on).
2. Copy the **signing secret** shown once into your receiver. You can create a new one later (**New secret**); the old one stops working at once.
3. Use **Send test** to check the endpoint.

### Events

| Type | When |
| --- | --- |
| `invoice.issued` | An invoice is issued |
| `invoice.paid` | An invoice becomes fully paid (sent once per invoice) |
| `quotation.issued` | A quotation is issued |
| `quotation.accepted` | A client accepts online, or you record offline acceptance |
| `payment.received` | A receipt is recorded (also online payments) |
| `receipt.voided` | A receipt is voided |
| `document.issued` | Another document is issued (proforma, sales order, delivery order) |
| `document.voided` | A document is voided |
| `credit_note.issued` / `debit_note.issued` | A credit or debit note is issued |
| `client.created` / `client.updated` | A client is added or changed |
| `webhook.test` | You pressed Send test (always sent, `"test": true`) |

Events that happened before an endpoint existed are not sent. Records added by **Import** do not send events.

### Payload

```json
{
  "id": "evt_6f1c…",
  "type": "invoice.issued",
  "created": "2026-10-17T02:15:04.123Z",
  "data": {
    "id": "…", "kind": "invoice", "number": "INV-2026-0042", "status": "Issued",
    "currency": "MYR", "issue_date": "2026-10-17", "due_date": "2026-10-31",
    "client": { "id": "…", "name": "ABC Sdn Bhd", "email": "…", "phone": "…", "tin": "…", "brn": "…" },
    "items": [{ "description": "Maintenance - Oktober 2026", "quantity": 1, "rate": 150000, "amount": 150000, "tax_rate": 8, "tax": 12000 }],
    "subtotal": 150000, "discount": 0, "tax": 12000, "total": 162000,
    "adjusted_total": 162000, "paid": 0, "balance": 162000,
    "url": "https://billing.example.com/#/document/…"
  }
}
```

A line with a description under its title also has `details` (the description markup, see [Line title and description](documents.md#line-title-and-description)). Amounts are integers in sen (RM1.00 = 100). `url` opens the record in your workspace (sign-in needed); it is not a client link. Payloads never contain passwords, keys, client link tokens, bank account details or payment proofs.

### Checking the signature

Each request has these headers:

- `Nawlogic-Signature: t=1792200000,v1=5f2b…` – `t` is the Unix time of this attempt, `v1` is the hex HMAC-SHA256 of `t + "." + raw request body` with your signing secret.
- `Nawlogic-Event` (the type), `Nawlogic-Event-Id` (same as `id`), `Nawlogic-Delivery`.

Your receiver should recompute the HMAC over the **raw body** (before parsing JSON), compare it in constant time, and **reject requests whose `t` is more than 5 minutes old**, so a captured request cannot be replayed later. Deliveries can repeat after a timeout, so ignore an `Nawlogic-Event-Id` you have already processed.

Node.js:

```js
import { createHmac, timingSafeEqual } from "node:crypto";
function verify(secret, header, rawBody) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return /^[0-9a-f]{64}$/.test(parts.v1) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(parts.v1, "hex"));
}
```

Python:

```python
import hmac, hashlib, time
def verify(secret: str, header: str, raw_body: bytes) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    t = int(parts.get("t", "0"))
    if abs(time.time() - t) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

In n8n, use a Webhook node with "Raw body" on, then a Code node with the Node.js check above.

### Delivery, retries and turning off

- Deliveries run in the background every 20 seconds. Any 2xx answer counts as delivered; anything else, a redirect, a timeout (10 seconds) or a TLS error is a failure.
- Failures are retried after 1, 2, 4, 8, 16, 32 minutes and so on (at most 6 hours apart) for up to **24 hours**, then the delivery is marked failed. **Send again** puts a failed delivery back in the queue for another 24 hours.
- An endpoint that has failed continuously for 24 hours (at least 10 attempts, no success) is **turned off automatically**, and so is one that answers `410 Gone`. The Webhooks page and the overview show a notice; pending deliveries are cancelled and the event `webhook.disabled` is written to the audit log. Fix the receiver and press **Turn on**.
- The delivery log (with response codes and the payload) is kept for 30 days. Up to 10 endpoints.

### Safety limits

- Only `https://` URLs, without a user name or password in them.
- Destinations must be public: names such as `localhost`, `*.local` or `*.internal`, and addresses in private, loopback, link-local, carrier-grade NAT, multicast, documentation or cloud metadata ranges (for example 10.x, 192.168.x, 127.x, 169.254.169.254, fd00::/8) are refused. The name is resolved **again at every delivery**, every resolved address must be public, and the connection is made to that checked address, so a DNS change cannot redirect deliveries inside your network.
- Redirects are not followed.
- Creating an endpoint, changing its URL and making a new secret need your password again. Secrets are stored encrypted with the workspace key.
- After a database restore, all endpoints are turned off until you check them.

## Import

Bring records over from a spreadsheet or your previous system: **clients first, then services, then historical invoices**.

1. Download the **template** for the type, fill it in (Excel, Google Sheets or LibreOffice) and save as CSV.
2. Choose the file and press **Check file**. Every row is checked with the same rules as the normal screens and shown as *Import*, *Skip* (already in the workspace) or *Error* with the reason. Nothing is saved yet.
3. When there are no errors, press **Import**. The whole file is imported in one go, or nothing is. Importing the same file again creates nothing new.

Rules and formats:

- Up to 2,000 rows and 1 MB per file. Comma, semicolon and tab separated files work; UTF-8 and Excel's Windows encoding are both read.
- Common column names from other systems are accepted (e.g. "Client Name", "E-mail", "Payment Terms", "Invoice No", "Amount Paid").
- Dates: `YYYY-MM-DD` or day first `DD/MM/YYYY`. Amounts: `1500.00`, `1,500` or `RM1,500`.
- **Clients**: `name` is required; a client whose name already exists is skipped. Same validation as the client form (valid email, payment terms 0–365 days).
- **Services**: `name` and `rate` are required; existing names are skipped. SST rate 0, 5, 6, 8 or 10.
- **Historical invoices**: one row per line; rows with the same `number` make one invoice (leave the client and dates blank on the extra rows). Each invoice keeps its **original number, issue date, due date and status**:
  - `status` is `unpaid`, `partly paid`, `paid` or `void` (Malay words such as belum bayar, separa, dibayar and batal also work). Without a status it follows `paid_amount`.
  - A paid amount becomes a **receipt marked as imported** (account `IMPORTED`, reference `IMPORTED <number>`, dated `paid_date` or the issue date) and is applied to the invoice, so balances, statements and aging stay consistent.
  - The client must already exist with exactly the same name. Charging SST needs your SST number in Settings.
  - The invoice number may use letters, numbers and `- / . #`. When it follows your current invoice series (e.g. `INV-2026-0042`), new invoices continue after it.
- Imported invoices are locked like issued invoices but are **never emailed, shared, sent to webhooks or reported as newly issued**. Past imports are listed on the page, and every record is in the audit log under an `import:` actor.

## Installable app

Nawlogic can be installed on a phone or computer and opened from the home screen like an app (a "progressive web app"):

- Chrome or Edge (Android, Windows, macOS): **Settings › Install the app › Install**, or the browser's own install button.
- iPhone or iPad: open the workspace in Safari, tap **Share**, then **Add to Home Screen**.

The installed app shows the same workspace. It needs a connection to your server: offline it shows a short offline page. The service worker caches only the app's own files (scripts, styles, fonts, icons) and that offline page. It never stores API responses, invoices, client data, client links or PDFs on the device. Installing needs HTTPS (or `localhost` while testing). Client document links are not installable as the owner app.

## Hosting and one-command install

`docker-compose.yml`, `deploy/Caddyfile`, `scripts/install.sh` and `scripts/update.sh` run the app on one Ubuntu or Debian server with automatic HTTPS, health checks, restarts, log rotation, encrypted backups and safe updates. A systemd + nginx alternative is in `deploy/`. See [DEPLOYMENT.md](../DEPLOYMENT.md) for the full guide, including Malaysian hosting choices, DNS, firewall and backups off the server.

The server, the domain and its DNS record are **your decision and your accounts**; this repository cannot provision them, and no hosting provider is recommended.

## Settings and keys

| Key | Where | Purpose |
| --- | --- | --- |
| `PLATFORM_OWNER_WHATSAPP` | Settings › Integration keys or server environment | Owner's own WhatsApp number(s) for quick invoices |
| `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` | Server environment | Optional AI model for hard-to-read quick invoice requests |
| `DOMAIN`, `ACME_EMAIL`, `BACKUP_HOST_DIR` | `.env` for docker-compose | Domain for HTTPS, certificate email, backup folder |

## Limits and caveats

- The parser is rule based. It handles the common ways of writing a bill, not every sentence; always read the preview. Two clients with almost the same name are offered as choices rather than guessed.
- Webhook delivery is "at least once": a receiver may see the same event twice after a timeout and should use the event id. Events are built from the record as it is when the event is processed (within about 20 seconds), not a historical copy.
- The import does not create clients from the invoice file and cannot undo an import; check the preview carefully. Imported paid amounts are opening balances, not bank transactions to reconcile.
- WhatsApp quick invoices depend on the WhatsApp service of the Messages module; the expected interface is `ctx.services.whatsapp.onInbound(handler)`, where the handler receives `{ id, from, text }` and returns the reply text (or `null` when the message is not a billing command).
