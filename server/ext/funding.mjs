// Funding: money put into the business by its owner, directors or investors
// (capital or loans) and loan repayments, kept apart from customer receipts.
// It is not sales income, so it never touches invoices, receipts or profit; it
// does count as cash in the cash flow forecast.
// Feature module contract: see docs/PLUGINS.md. Owner guide: docs/features/funding.md.
import { createHash } from "node:crypto";
import {
  addDays,
  check,
  date,
  id,
  money,
  now,
  text,
  today,
} from "../domain.mjs";
import { toCsv } from "../books-export.mjs";

export const FUNDING_KINDS = {
  capital: "Capital",
  loan: "Loan to the business",
  repayment: "Loan repayment",
};
export const FUNDING_ROLES = {
  owner: "Owner",
  director: "Director",
  investor: "Investor",
  other: "Other",
};
export const FUNDING_METHODS = ["Bank transfer", "Cash", "Cheque", "Other"];
const ringgit = (sen) =>
  (sen / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export function attachFunding(Store) {
  Object.assign(Store.prototype, {
    fundingRows() {
      return this.db
        .prepare("SELECT * FROM funding ORDER BY txn_date DESC, created DESC")
        .all();
    },
    // Every entry; a loan also carries what was repaid and what is still owed.
    funding() {
      const rows = this.fundingRows();
      const repaid = new Map();
      for (const r of rows)
        if (r.kind === "repayment" && !r.voided)
          repaid.set(r.loan_id, (repaid.get(r.loan_id) || 0) + r.amount);
      const numbers = new Map(rows.map((r) => [r.id, r.number]));
      return rows.map(({ dedupe_key, ...r }) => ({
        ...r,
        voided: !!r.voided,
        repaid: r.kind === "loan" ? repaid.get(r.id) || 0 : 0,
        balance:
          r.kind === "loan" && !r.voided
            ? r.amount - (repaid.get(r.id) || 0)
            : 0,
        loan_number: r.loan_id ? numbers.get(r.loan_id) || "" : "",
      }));
    },
    fundingEntry(fid) {
      const e = this.funding().find((x) => x.id === fid);
      check(e, "Funding entry not found.", 404);
      return e;
    },
    // Totals, and per person: what they put in and what the business still owes them.
    fundingSummary(entries = this.funding()) {
      const people = new Map();
      for (const e of entries) {
        if (e.voided) continue;
        const key = e.party.toLowerCase();
        const p = people.get(key) || {
          party: e.party,
          role: e.role,
          capital: 0,
          loans: 0,
          repaid: 0,
          outstanding: 0,
        };
        if (e.kind === "capital") p.capital += e.amount;
        else if (e.kind === "loan") {
          p.loans += e.amount;
          p.repaid += e.repaid;
          p.outstanding += e.balance;
        }
        people.set(key, p);
      }
      const totals = { capital: 0, loans: 0, repaid: 0, outstanding: 0 };
      for (const p of people.values())
        for (const k of Object.keys(totals)) totals[k] += p[k];
      return {
        ...totals,
        people: [...people.values()].sort(
          (a, b) =>
            b.outstanding - a.outstanding ||
            b.capital - a.capital ||
            a.party.localeCompare(b.party),
        ),
      };
    },
    // Cash in (+) and out (−) by date, for the cash flow forecast. MYR sen.
    fundingCash() {
      return this.fundingRows()
        .filter((r) => !r.voided)
        .map((r) => ({
          date: r.txn_date,
          amount: r.kind === "repayment" ? -r.amount : r.amount,
          kind: r.kind,
        }));
    },
    recordFunding(b) {
      return this.tx(() => {
        const kind = String(b.kind || "");
        check(
          kind in FUNDING_KINDS,
          "Choose what this money is: capital, a loan or a loan repayment.",
        );
        const amount = money(b.amount);
        check(amount > 0, "Enter an amount above zero.");
        const txn_date = date(b.txn_date);
        check(txn_date <= today(), "The date cannot be in the future.");
        const method = text(b.method || "Bank transfer", 40, true);
        check(
          FUNDING_METHODS.includes(method),
          "Choose how the money moved: bank transfer, cash, cheque or other.",
        );
        const account = text(b.account || "MAIN", 80, true);
        const reference = text(b.reference || "", 120);
        const note = text(b.note || "", 500);
        let party = text(b.party || "", 120);
        let role = String(b.role || "owner");
        let loan_id = null;
        if (kind === "repayment") {
          // A repayment belongs to one loan and goes back to that lender.
          const loan = this.funding().find((x) => x.id === b.loan_id);
          check(loan && loan.kind === "loan", "Choose which loan this repays.");
          check(!loan.voided, "That loan entry was voided.");
          check(
            txn_date >= loan.txn_date,
            `The repayment is dated before the loan (${loan.txn_date}).`,
          );
          check(
            amount <= loan.balance,
            `This repayment is more than what is still owed on ${loan.number} (RM ${ringgit(loan.balance)}).`,
          );
          loan_id = loan.id;
          party = loan.party;
          role = loan.role;
        } else {
          // The form's loan field is hidden for capital and loans but still sent.
          check(party, "Enter who the money is from.");
          check(
            role in FUNDING_ROLES,
            "Choose their role: owner, director, investor or other.",
          );
        }
        const dedupe_key = createHash("sha256")
          .update(
            [
              kind,
              party.toLowerCase(),
              txn_date,
              amount,
              reference.toLowerCase(),
              account.toLowerCase(),
            ].join("|"),
          )
          .digest("hex");
        check(
          !this.db
            .prepare("SELECT id FROM funding WHERE dedupe_key=? AND voided=0")
            .get(dedupe_key),
          "This entry is already recorded: same type, person, date, amount and reference.",
          409,
        );
        const row = {
          id: id(),
          number: this.number("FD", txn_date),
          kind,
          party,
          role,
          amount,
          txn_date,
          method,
          account,
          reference,
          note,
          loan_id,
          dedupe_key,
          created: now(),
        };
        this.db
          .prepare(
            "INSERT INTO funding(id,number,kind,party,role,amount,txn_date,method,account,reference,note,loan_id,dedupe_key,created) VALUES(:id,:number,:kind,:party,:role,:amount,:txn_date,:method,:account,:reference,:note,:loan_id,:dedupe_key,:created)",
          )
          .run(row);
        const { dedupe_key: _, ...after } = row;
        this.audit(
          "funding.recorded",
          row.id,
          `${row.number}: ${FUNDING_KINDS[kind]} RM ${ringgit(amount)} ${kind === "repayment" ? "to" : "from"} ${party}`,
          null,
          after,
        );
        return this.fundingEntry(row.id);
      });
    },
    // A recording mistake. The entry stays in the list and the history, marked void.
    voidFunding(fid, reason) {
      return this.tx(() => {
        const e = this.fundingEntry(fid);
        check(!e.voided, "This entry is already voided.");
        reason = text(reason, 500, true);
        if (e.kind === "loan")
          check(
            !e.repaid,
            "This loan has repayments recorded. Void those first.",
          );
        this.db
          .prepare("UPDATE funding SET voided=1, void_reason=? WHERE id=?")
          .run(reason, fid);
        this.audit("funding.voided", fid, `${e.number}: ${reason}`, e, null);
        return this.fundingEntry(fid);
      });
    },
  });
}

function csv(entries) {
  return toCsv([
    [
      "Number",
      "Date",
      "Type",
      "Person",
      "Role",
      "Money in (MYR)",
      "Money out (MYR)",
      "Still owed (MYR)",
      "Of loan",
      "Method",
      "Account",
      "Reference",
      "Note",
      "Status",
    ],
    ...entries.map((e) => [
      e.number,
      e.txn_date,
      FUNDING_KINDS[e.kind],
      e.party,
      FUNDING_ROLES[e.role] || e.role,
      e.kind === "repayment" ? "" : ringgit(e.amount).replace(/,/g, ""),
      e.kind === "repayment" ? ringgit(e.amount).replace(/,/g, "") : "",
      e.kind === "loan" && !e.voided
        ? ringgit(e.balance).replace(/,/g, "")
        : "",
      e.loan_number,
      e.method,
      e.account,
      e.reference,
      e.note,
      e.voided ? "Void: " + e.void_reason : "",
    ]),
  ]);
}

export default {
  name: "funding",
  migrations: [
    {
      name: "funding-001-entries",
      sql: `CREATE TABLE funding(
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('capital','loan','repayment')),
  party TEXT NOT NULL,
  role TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount>0),
  txn_date TEXT NOT NULL,
  method TEXT NOT NULL,
  account TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  loan_id TEXT REFERENCES funding(id),
  dedupe_key TEXT NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0,
  void_reason TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL
);
CREATE INDEX funding_loan ON funding(loan_id);
CREATE INDEX funding_date ON funding(txn_date);`,
    },
  ],
  // The owner's money: the owner records it; an accountant reads it; staff do not see it.
  access: { accountant: [["GET", /^\/api\/funding(\.csv)?$/]] },
  attach: attachFunding,
  routes: {
    async owner(r) {
      const store = r.ctx.store;
      if (r.path === "/api/funding" && r.method === "GET") {
        const entries = store.funding();
        return (
          r.send(200, { entries, summary: store.fundingSummary(entries) }),
          true
        );
      }
      if (r.path === "/api/funding.csv" && r.method === "GET")
        return (
          r.send(200, csv(store.funding()), {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="funding.csv"',
          }),
          true
        );
      if (r.path === "/api/funding" && r.method === "POST") {
        const b = await r.body();
        return (
          r.send(
            201,
            r.write("funding.record", b, () => store.recordFunding(b)),
          ),
          true
        );
      }
      const m = r.path.match(/^\/api\/funding\/([\w-]+)\/void$/);
      if (m && r.method === "POST") {
        const b = await r.body();
        return (r.send(200, store.voidFunding(m[1], b.reason)), true);
      }
      return false;
    },
  },
  workspace(r) {
    if (r.session.role === "staff") return null;
    const entries = r.ctx.store.funding();
    return { entries, summary: r.ctx.store.fundingSummary(entries) };
  },
  exportData(store) {
    return { entries: store.funding() };
  },
  // The owner's capital, a director's loan and its first repayment.
  seedDemo(store) {
    if (store.db.prepare("SELECT count(*) n FROM funding").get().n) return;
    const t = today();
    store.recordFunding({
      kind: "capital",
      party: "Aizat Arshad (Demo)",
      role: "owner",
      amount: "20000.00",
      txn_date: addDays(t, -90),
      method: "Bank transfer",
      reference: "Opening capital",
    });
    const loan = store.recordFunding({
      kind: "loan",
      party: "Farah Nadia (Demo)",
      role: "director",
      amount: "5000.00",
      txn_date: addDays(t, -60),
      method: "Bank transfer",
      reference: "Director loan",
    });
    store.recordFunding({
      kind: "repayment",
      loan_id: loan.id,
      amount: "1000.00",
      txn_date: addDays(t, -30),
      method: "Bank transfer",
      reference: "Repayment 1 of 5",
    });
  },
};
