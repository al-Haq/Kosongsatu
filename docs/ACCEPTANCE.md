# Local acceptance checklist

Run `npm run check`, `npm test` and `npm audit --omit=dev` first. Use a disposable demo database for browser checks; never insert demo transactions into the real workspace.

- Log in using the temporary demo owner credentials; verify invalid login has a useful error.
- Open all twelve navigation entries. Check narrow mobile widths and keyboard access.
- Add/edit a client and service. Confirm names containing HTML characters appear as text.
- Add an invoice with fractional quantity, multiple line items and a discount; verify live totals and server totals.
- Save/reopen a draft, issue it, confirm edits are locked and download the PDF.
- Generate a client link, open it in a separate logged-out context, and verify only that document is visible.
- Submit a payment reference; confirm the invoice remains unpaid until an owner checks the bank and records payment.
- Record a partial payment, download a receipt, confirm duplicate references/overpayments are rejected, reverse with a reason, then record the full remaining amount.
- Issue a quotation, accept it through the client link, convert to invoice twice and confirm one draft exists.
- Generate a due recurring period and confirm it advances and cannot run early for the next period.
- Revoke a client link and confirm it no longer returns the document/PDF.
- Update company details and confirm issued PDFs keep their original snapshots.
- Download CSV/JSON exports. Change password and verify the previous session is invalidated.
- Stop/restart and verify persisted documents. Back up and restore a disposable database before real use.

## v0.2 acceptance

- Record one RM200 receipt and allocate RM100 each to two invoices. Verify cash totals stay RM200.
- Credit RM20 on one paid invoice; verify original total stays fixed and RM20 becomes available. Record a real-world refund in the test ledger; verify net cash becomes RM180. Add a debit note and verify the invoice reopens.
- Download receipt, credit/debit and refund PDFs. Check long reasons and multiple adjustment pages retain footer margins.
- Preview/import normalized bank CSV; import twice and verify duplicates skip. Match receipt and refund, reset with a reason, and exclude owner capital without creating sales.
- Enrol an authenticator, save recovery codes, sign out and sign in with a recovery code. Verify it cannot be reused; verify password changes and disabling MFA require a factor.
- Configure encrypted backups in a private test environment, run a backup, restore to a new file and check balances, revoked sessions/links and original MFA key requirements. Verify an existing restore target is refused.
- Upgrade a disposable v1 database. Check rollback snapshot, preserved invoice balances, manual legacy-duplicate review and recurring anchor behavior.

No live bank payment, email delivery, MyInvois submission, production TLS deployment or Docker build is covered by the local tests.

## v0.3 acceptance

- Create an opportunity, prepare a catalog quotation proposal, review/approve it once and verify a linked draft. Issue it using the existing owner workflow.
- Record verified offline acceptance with evidence; distinguish this audit action from customer portal acceptance.
- Register a full-value customer PO. Reject mismatched amounts, duplicate references and unaccepted quotations. Create the invoice twice and verify one draft with its PO reference.
- Enable a rule before a new event. Process events twice and verify one result; enabling later must not run historical events. Test failure/retry rollback.
- Create a scoped connector with current password/MFA. Store its token once, confirm read/proposal restrictions and revoke it. Check a real MCP handshake and tool call.
- With an explicit test model/provider, run a chat tool loop that queues a proposal. Verify no record changes before owner approval and inspect phone layouts. Never present deterministic fake-provider tests as live-model verification.
- Restore a disposable backup and confirm connector revocation, rules disabled, preserved sales/PO records and unchanged invoice balances.
