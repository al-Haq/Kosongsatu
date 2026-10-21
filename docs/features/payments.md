# Payments

This module covers how clients pay and how money in your bank account is matched to invoices:

- online payment through **Billplz, ToyyibPay, Stripe or iPay88**, with the keys entered in Settings,
- your bank's **static DuitNow QR** on invoices and client links,
- **payment slips** that clients attach to their transaction reference,
- **bank statement import** from Maybank, CIMB, Public Bank, RHB, Hong Leong, Bank Islam or any other CSV layout,
- **smart bank matching** that suggests which invoice each bank credit pays.

Nothing here records money on its own except a payment that the provider itself confirms (online payment). Everything else waits for you to confirm.

## Online payment (roadmap 27, 28, 29)

Open **Settings > Online payments**. Each provider shows whether it is connected, in test mode or live.

1. Choose **Set up** next to a provider and enter its keys (see the table below). Your password (and authenticator code, if MFA is on) is asked again. Keys are stored encrypted on your server and never shown again.
2. Choose **Test connection**. It checks the keys with the provider without creating a payment.
3. Choose **Use for invoices** to make it the active provider. Only one provider is active at a time. If you never choose, the first connected provider is used (Billplz, ToyyibPay, Stripe, iPay88). **Turn off online payment** hides the Pay online button everywhere.

Keys take effect at once; no restart is needed. A key set on the server environment (for example `BILLPLZ_API_KEY` in `.env`) always wins over the value saved in Settings, and `PAYMENT_PROVIDER` on the server fixes the provider.

When a provider is active, client links for unpaid invoices show **Pay online** for the full balance. When the provider confirms the payment, the app records **one receipt** and allocates it to the invoice, so the invoice switches to **Paid** by itself. If the invoice was already settled another way, the money is kept as customer funds on the Credits page for you to allocate or refund.

| Provider | Keys | Where to find them | Notes |
|---|---|---|---|
| Billplz | `BILLPLZ_API_KEY`, `BILLPLZ_COLLECTION_ID`, `BILLPLZ_X_SIGNATURE_KEY`, test mode | Billplz > Settings > Keys & Integration (turn on X Signature); Billing > collection | FPX, card, DuitNow. Callback set on each bill. |
| ToyyibPay | `TOYYIBPAY_SECRET_KEY`, `TOYYIBPAY_CATEGORY_CODE`, test mode | ToyyibPay dashboard > Settings (secret key) and Category | FPX and card. Fees are charged to you, so the paid amount equals the bill. |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe > Developers > API keys and Webhooks | Card and FPX in MYR, at least RM 2.00. Test mode follows the key (`sk_test_…`). |
| iPay88 | `IPAY88_MERCHANT_CODE`, `IPAY88_MERCHANT_KEY`, test mode | From iPay88 when your merchant account is opened | FPX, card and e-wallets. HMAC-SHA512 signatures. |

### What each provider needs from you

- **Billplz:** nothing beyond the keys. Each bill carries its own callback address (`/api/payments/billplz/callback`, kept from earlier releases; `/api/hooks/payments/billplz` also works).
- **ToyyibPay:** create a category for invoice payments. Each bill carries its callback (`/api/hooks/payments/toyyibpay`) and return address.
- **Stripe:** in Stripe > Developers > Webhooks add the endpoint `https://<your app>/api/hooks/payments/stripe` with the events `checkout.session.completed` and `checkout.session.async_payment_succeeded`, then paste its signing secret. FPX must be turned on in your Stripe payment methods (Stripe asks for your business registration number for FPX).
- **iPay88:** ask iPay88 to register your app address (for example `https://billing.your-domain.my`) as the request URL. The response and backend addresses are sent with each payment (`/api/hooks/payments/ipay88`). iPay88 does not publish one sandbox address for every account; if test mode does not work, ask iPay88 which test endpoint your account uses.

### How payments are checked

- A payment is started only for the current balance of an issued invoice, from a valid client link. A changed balance starts a new payment and withdraws the old one where the provider allows it.
- Callbacks are authenticated: Billplz X Signature, Stripe-Signature (5-minute window against replays), iPay88 HMAC-SHA512 signature, and ToyyibPay's callback hash when it is present. A wrong signature is refused.
- Before any money is recorded, the payment is read back from the provider (Billplz bill, ToyyibPay `getBillTransactions`, Stripe Checkout Session, iPay88 re-query). The amount must equal the amount the payment was started for. A mismatch is refused and written to the activity log so you can check it with the provider.
- The same payment is recorded at most once, however many times a callback arrives.
- If a callback never arrives, a background check looks at pending payments from the last two days (every 15 minutes at first, then every two hours). You can also choose **Check status** in the Online payments list.

## DuitNow QR (roadmap 30)

In **Settings > DuitNow QR**, either paste the text of your bank's **static** DuitNow QR or upload the QR image your bank gave you (PNG or JPEG).

- To get the text, scan the QR from your bank with any QR reader app and copy the result. It starts with `000201`.
- The text is checked: EMVCo structure, Malaysian ringgit, country MY and the CRC-16 checksum. A one-time (dynamic) QR or a QR with a fixed amount is refused; the app never invents amounts.
- Unpaid invoice PDFs get a **Pay with DuitNow QR** block, and client links show the QR, with the amount to enter and the invoice number as the reference.
- There is no fee and no gateway. The app does not know when someone paid: check your bank account and record the payment (or let bank matching suggest it).

## Payment slips (roadmap 31)

On a client link, **Submit payment reference** now accepts an optional **payment slip** (photo, screenshot or PDF, up to 5 MB) with the transaction reference.

- The slip is private: only you can open it. The client page only says that a slip was attached.
- You see the slip on the invoice (Awaiting review) and on the Payments page. It stays linked to the reference after you confirm or reject it.
- Uploads check the link, come only from the client page, are limited to a few per address every 10 minutes, and at most five references can wait for review per invoice.
- A slip is not proof that money arrived. Check your bank account before recording the payment.

## Bank statement import (roadmap 37)

On **Bank matching**, choose **Import statement**, pick the bank layout (or *Detect automatically*), and choose the CSV file you downloaded from internet banking (or paste it).

The preview shows what was found: the header row, date and amount columns, how many rows are new, already imported, or could not be read. Open **Columns and formats** to adjust:

- header row (statements often start with account details), delimiter (comma, semicolon, tab),
- date column and date format (DD/MM/YYYY, DD MMM YYYY, YYYY-MM-DD, MM/DD/YYYY),
- description and reference columns (several can be combined),
- amounts as one signed column, separate debit/credit (withdrawal/deposit) columns, or an amount with a DR/CR column,
- thousands separator and decimal mark (1,234.56 or 1.234,56). Trailing `+`/`-`, `CR`/`DR`, brackets and `RM` are understood.

Wrapped description lines are joined to their transaction; opening, closing and balance lines are skipped. Rows that cannot be read are listed; you can fix the mapping or choose to skip them. **Save layout** keeps the mapping by column names, so it still fits when the bank moves columns around.

The built-in layouts for Maybank2u, CIMB Clicks, Public Bank, RHB, Hong Leong Connect and Bank Islam describe the layouts these banks typically export. **Banks change their export files without notice**, and business and personal banking often differ, so always check the preview, adjust the columns if needed and save your own layout.

Import uses the same duplicate check as before: importing the same statement again skips rows already imported. Two identical transfers on the same day in one statement are both kept. Importing never records income.

## Smart bank matching (roadmap 91)

For each unmatched bank credit, the Bank matching page suggests the most likely invoices (or an already recorded receipt) with a confidence level and the reasons, for example:

- the amount equals an open balance,
- the invoice number appears in the reference or description, also when mangled (`INV2026 12`, `inv-2026-0012`, `2026/0012`),
- words from the client's name appear (also when the bank cuts them short, like `MERANTI DIGI`),
- the client submitted that reference on the client link,
- the date is close to the due date, or the payment came before the invoice was issued,
- a part payment, or several invoices of one client paid together.

When two suggestions are equally good, both are marked as a hard case. **Record & allocate** records the bank credit as a receipt (bank date, amount and reference) and allocates it to the suggested invoices in one step; anything left over stays as customer funds. If you already recorded the receipt by hand, the suggestion is **Match receipt**, so the money is never recorded twice. **Review** shows every suggestion and its reasons.

### Asking your AI model (optional)

If an AI model is configured for the assistant (`AI_BASE_URL`, `AI_MODEL`, see [AUTOMATION.md](../AUTOMATION.md)), hard cases show **Ask AI**. Only after you tick the confirmation, the app sends the bank line (date, amount, reference, description) and, for up to 8 open invoices, the invoice number, client name, balance and due date. No emails, addresses, tax numbers or record IDs are sent. The answer is shown as a ranking with reasons; nothing is recorded until you confirm. Each request is written to the activity log with the provider address.

## Limits

- One active online provider at a time. Payments started with an earlier provider still settle as long as its keys remain.
- Online payment is always for the full open balance; partial online payments and instalments are not offered.
- Provider APIs and dashboards change. The integrations were written against each provider's published API (Billplz v3, ToyyibPay `index.php/api`, Stripe Checkout Sessions, iPay88 OPSG with HMAC-SHA512) and tested with simulated responses; test each provider in its sandbox or with a small live payment before you rely on it.
- ToyyibPay does not always sign its callbacks. An unsigned callback is only used as a signal to re-check the bill with ToyyibPay.
- DuitNow QR and payment slips do not confirm payment; you still check your bank.
- Bank statement layouts are detected from column names; unusual files may need the mapping adjusted once.
