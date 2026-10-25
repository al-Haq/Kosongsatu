# Funding: owner and investor money

**Get paid → Funding** records money that comes into the business but is **not a sale**: the owner's or an investor's capital, a loan to the business from the owner, a director or an investor, and each repayment of such a loan.

Customer money stays where it was: **Payments** and **Credits** (receipts). The _Record money received_ form on Credits is for clients only; it points here for anything else.

## Three kinds of entry

| Kind                     | What it means                                                                            | Money moves |
| ------------------------ | ---------------------------------------------------------------------------------------- | ----------- |
| **Capital**              | Money put in to stay (owner's capital, an investor's contribution). It is not paid back. | In          |
| **Loan to the business** | Money lent to the business, to be paid back later.                                       | In          |
| **Loan repayment**       | The business pays part of a loan back to the lender.                                     | Out         |

Each entry records who (name and role: owner, director, investor or other), how much, the date, how the money moved (bank transfer, cash, cheque, other), the account label and a reference, with an optional note. Entries are numbered `FD-<year>-<serial>`.

## Loans and what is still owed

- A repayment always belongs to **one loan**. Choose the loan in the form (or press **Repay** on the loan's row); the lender is taken from the loan.
- A repayment cannot be more than what is still owed on that loan, and cannot be dated before the loan.
- The page shows, for every loan and for every person: **original amount, repaid so far, still owed**. Example: a RM 5,000 director loan with RM 1,000 repaid shows RM 4,000 still owed.
- The four tiles at the top total everything: capital in, loans received, repaid so far, still owed.

## Mistakes

An entry is never deleted. **Void** it with a reason; it stays in the list marked _Void_ and in the audit history. A loan with repayments cannot be voided until its repayments are voided.

The same entry twice (same kind, person, date, amount and reference) is refused, so a double click or a retried save does not record it twice.

## Where it shows

- **Cash flow forecast and cash health (Books)**: capital and loans count as cash in, repayments as cash out, from your bank-balance date to today.
- **Not** on invoices, receipts, the sales report or profit and loss: funding is financing, not income or an expense.
- **CSV**: _Entries → CSV_ exports every entry with its number, kind, person, amounts and status.
- **Backup**: the JSON business export includes the entries.

## Who can see it

The owner records and voids entries. An accountant sees the page and the CSV but cannot change anything. Staff do not see Funding at all.
