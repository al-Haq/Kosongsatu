# Client portal, contacts, credit holds, e-signatures and feedback

This module covers roadmap items 49, 50, 51, 52 and 99. Nothing here needs an outside account. Email features use your own SMTP server (Settings shows whether email is connected); without email, you copy links and send them yourself.

## 49. Client portal

One private place where a client sees everything you have issued to them:

- invoices, quotations and any other issued documents (drafts and void documents never show), with status and balance;
- receipts and credit/debit notes, each with a PDF;
- totals: outstanding, overdue and unallocated customer credit;
- a statement of account PDF for any period;
- on an invoice: pay online (if Billplz is connected), bank details, and "Submit payment reference";
- on a quotation: accept and sign (see no. 52);
- on a fully paid invoice: rate the work (see no. 99).

**Turn it on:** open the client, then in **Client portal** choose **Turn on portal**. Then either:

- **Invite** a contact. The contact needs an email and the **Portal access** tick (see no. 50). With email set up, the contact gets a sign-in link that works once within 3 days. Tick "Give me the link to send myself instead" to copy it (for WhatsApp, for example). Without email, you always get the link to copy.
- **Create link** for clients without email. It opens the portal until it expires (30 days to 1 year) or you revoke it. The link is shown once. Treat it like a password: anyone who has it can open the portal.

**Signing in later:** clients go to `https://<your address>/portal/signin`, type their email and receive a new one-time link (valid 15 minutes). The page answers the same way for every address, so it does not reveal who has access. Each address gets at most 3 links per 15 minutes, and each network address can ask 5 times per 15 minutes.

**Sessions** last 12 hours. On the client page you can see how many are active and **Sign out all**. Turning the portal off, archiving the client, removing a contact's portal access or changing their email ends their sessions at once. Revoking an access link ends the sessions opened with it. A restored backup cancels all sessions, sign-in links and access links.

**What the client never sees:** your credit limits, hold reasons, internal notes, other clients, contact lists, audit history or signature details such as the network fingerprint.

**Security details:** sign-in and access links are random and only their hash is stored. Sign-in links work once. The portal cookie is separate from your owner login, HttpOnly, SameSite=Strict, limited to the portal's API path and Secure in production. Every change a client makes also needs a per-session token and must come from your own web address. Every document, receipt and note is looked up within the signed-in client only; another client's ID returns "not found". Portal actions use the same rules as the client document link (accept, payment reference, online payment) and never replace the client's existing document link.

## 50. Several contacts per client

On the client page, **Contacts** lists every contact with a role (billing, technical, other) and two ticks:

- **Copy on invoices**: the contact is put in Cc when you email an invoice, quotation or statement, and on automatic payment reminders.
- **Portal access**: the contact can sign in to the portal with their email.

The **primary billing contact** and the client's main contact, email and phone are always the same: editing one updates the other. To change it, edit another contact and tick **Primary billing contact**. Existing clients got their current contact as the primary billing contact when this module was installed.

The email forms for documents and statements fill **To** with the primary billing email and **Cc** with the contacts marked "copy on invoices". You can still change them before sending. Email allows 5 addresses in To and 5 in Cc.

## 51. Credit limit and work hold

In the client form, under **Credit and work hold**:

- **Credit limit (MYR)**: optional. Credit used is the unpaid balance of the client's issued invoices (foreign-currency invoices count at their exchange rate).
- **Hold when overdue more than N days**: optional. The client goes on hold automatically while any invoice is more than N days past its due date, and comes off hold when it is paid.
- **Put this client on hold now**: a manual hold, with a reason.

While a client is on hold, or a new document would take them over the limit, **issuing** a new invoice or quotation is blocked with a message that says why. Drafts can still be saved. To issue anyway, open the draft and choose **Allow issue** with a reason. The permission is for that draft at its current amount only; if you change the amount or client, you are asked again. Both the permission and its use are kept in the audit history.

The client page shows the limit, credit used and available, and the hold status. The document editor and the draft show the same check, and the overview lists clients on hold. The block applies to every way of issuing, including integrations and any automatic issuing, so a held client also stops automatically issued invoices until you allow them.

## 52. E-signature on quotation acceptance

On the client's quotation page (from the document link or the portal), **Accept** now asks for:

- the signer's full name;
- a signature, either **drawn** with a finger, pen or mouse (works on phones), or **typed** (the typed name must match the full name);
- a tick confirming they agree to the scope, price and terms and are authorised to accept.

The server checks the signature image (a real PNG of a sensible size, with some ink and not a photo), removes any hidden data from it and stores it with the quotation. It also keeps the time, the browser, a keyed fingerprint of the network address (the address itself is not stored) and a fingerprint of the quotation's content at signing. If any part fails, nothing is accepted. A quotation can be signed once and the signature cannot be deleted.

You see the signature and its details on the quotation. The quotation PDF (yours and the client's) prints the signature with "Accepted by … on …". The older name-only acceptance still works for integrations that use the API directly.

Malaysia's Electronic Commerce Act 2006 (section 9) accepts an electronic signature that is linked to the message, identifies the person and shows their approval, and is reliable enough for the purpose. This feature is designed to support that for everyday quotations; for high-value or regulated contracts, check with your lawyer.

## 99. Client feedback after payment

When an invoice is fully paid, the client's document page and the portal offer a 1–5 star rating with an optional comment (once per invoice). The client may tick "You may show my rating and comment as a testimonial" and give a name to show.

**Client feedback** (in the menu under Records) shows the average rating, the spread of ratings, averages per client and every comment. For feedback with consent, choose **Show** to mark it as a testimonial. **Export CSV** downloads all feedback; **Testimonials CSV** only the testimonials. The client page shows each client's average, and the overview shows the latest ratings.

**Automatic feedback request (optional):** in Settings, **Client portal and feedback**, tick "After an invoice is fully paid, email the client once to ask for a rating". It needs email set up. Requests go only for payments recorded after you turn it on, to the client's main email, at most once per invoice. The emailed link works for 30 days and only until feedback is given. A background job checks every 10 minutes.

## Limits and notes

- Online payment from the portal uses the Billplz connection; other gateways added later appear on the document link but not yet as a portal button.
- Payment references from the portal stay **pending** until you confirm the money arrived, exactly like the document link.
- Sign-in emails are sent in the background after the answer, so a mail server problem does not show to the client. A failed send is recorded in the audit history as "email failed".
- Clients without any contact email can only use access links.
