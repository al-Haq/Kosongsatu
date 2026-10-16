# Nawlogic Invoice 0.2.0 — financial integrity and recovery

Phase 1 implements priorities 1–16 from the feature review. The remaining product roadmap is outside this release. Existing invoice/quotation/client workflows remain available.

| Priority | Delivered                                                                                                                    | Verification                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1        | One cash receipt, multiple invoice allocations; dashboard counts cash once                                                   | Finance and browser tests                        |
| 2        | Recurring anchor day and explicit month end survive February                                                                 | Domain and migration tests                       |
| 3        | Distinct document prefixes, reserved note/receipt prefixes and collision checks                                              | Finance tests                                    |
| 4        | Integer sen, validated decimal input, line rounding, server-authoritative totals                                             | Domain tests                                     |
| 5        | Issued document identity/content snapshots remain locked                                                                     | Domain tests                                     |
| 6        | Numbered immutable credit notes; excess payment allocation returns to original customer receipt                              | Finance, HTTP, PDF and browser checks            |
| 7        | Numbered immutable debit notes; outstanding balance reopens                                                                  | Finance tests                                    |
| 8        | Numbered refund records against real unallocated cash; bank-reference duplication blocked                                    | Finance, banking and browser checks              |
| 9        | Unallocated customer funds retained separately from invoice balances                                                         | Finance and browser checks                       |
| 10       | Normalized CSV preview/import, duplicate skipping, receipt/refund matching, exclusions and reset reasons                     | Parser, banking and browser checks               |
| 11       | Business registration, address, contact and client-name guards before real issuance                                          | Finance tests                                    |
| 12       | Actor audit, before/after snapshots for edits and financial transitions, update/delete guards                                | Finance and HTTP tests                           |
| 13       | Online encrypted backup, daily scheduling when configured, restore to a new file with integrity checks and access revocation | Backup/restore tests                             |
| 14       | Encrypted TOTP secret, replay prevention, hashed one-use recovery codes, operator console recovery                           | RFC vectors, persistence, HTTP and browser tests |
| 15       | Idempotency keys for financial creation and other record creation                                                            | Finance and HTTP tests                           |
| 16       | Document-scoped private links, configurable 1–90 day expiry, rotation/revocation                                             | Domain and browser tests                         |

"Browser" checks in this table are the manual steps in [ACCEPTANCE.md](ACCEPTANCE.md); the repository has no automated browser suite.

## Accounting behavior

Receipt RM200 → allocate RM100 each to two invoices = RM200 cash, not RM400. Credit RM20 against a paid invoice releases RM20 to the original receipt; it does not create new cash. Recording a RM20 bank refund consumes those available funds. A debit note raises the invoice balance but does not automatically reuse released funds.

Reverse allocation means undo an invoice application; cash stays recorded. To correct a receipt entered in error, reverse its allocations, reset any bank match, then void the cash entry with a reason. To return real money, use a refund record after the bank refund has occurred. Issued notes are corrected with further notes, not edited or deleted.

## Upgrade from 0.1

Startup migrates SQLite transactionally. A file database with existing documents gets a private `*.pre-v2-*.sqlite` rollback snapshot before schema changes. Keep it until upgrade acceptance, then move it to encrypted backup storage or remove it according to your retention policy. It contains private data in plaintext.

Every old payment gets a corresponding receipt, preserving payment IDs, values, reversals and invoice balances. Same-date/method/reference legacy groups remain separate and are marked for manual review; the app never guesses which old payment is a duplicate. Verify bank evidence, then either confirm a distinct legitimate receipt or reverse/void the duplicate recording. Cash totals can include unresolved legacy duplicates until corrected. Missing historical recurring anchors use the earliest recorded run, otherwise the existing next date; inspect migrated schedules where the original intended date cannot be inferred.

## Boundaries

- CSV uses the documented normalized columns; this is not an automatic Maybank/CIMB feed or a universal parser for native bank exports.
- Refunds, bank receipt confirmations and reference checks are owner records. This app does not move money or independently verify a bank account.
- Credit/debit notes here are commercial billing documents, not validated LHDN MyInvois submissions. SST is not calculated.
- Backups need server configuration and an operator-managed off-host copy. No production host or external integration has been provisioned.
- Single owner/business only. Audit is append-only through application/database guards; a server/database administrator can still alter storage.
