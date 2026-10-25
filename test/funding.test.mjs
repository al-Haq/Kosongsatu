// Owner, director and investor money: capital and loans in, repayments out,
// kept apart from customer receipts, with what each person is still owed.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { member } from "./team-helpers.mjs";
import { cashForecast, latePayment } from "../server/books-calc.mjs";
import { today, addDays } from "../server/domain.mjs";

test("funding: capital and loans in, repayments out, and what each person is still owed", async () => {
  const f = await fixture();
  try {
    const t = today();
    const capital = await f.json("/api/funding", "POST", {
      kind: "capital",
      party: "Aizat",
      role: "owner",
      amount: "20000.00",
      txn_date: addDays(t, -30),
      method: "Bank transfer",
      reference: "CAP-1",
    });
    assert.match(capital.number, /^FD-\d{4}-\d{5}$/);
    assert.equal(capital.amount, 2000000);
    assert.equal(capital.dedupe_key, undefined);
    const loan = await f.json("/api/funding", "POST", {
      kind: "loan",
      party: "Farah",
      role: "director",
      amount: "5000.00",
      txn_date: addDays(t, -20),
      method: "Cash",
    });
    assert.equal(loan.balance, 500000);

    // A repayment goes to the lender, no more than what is owed, not before the loan.
    await assert.rejects(
      f.json("/api/funding", "POST", {
        kind: "repayment",
        loan_id: loan.id,
        amount: "6000.00",
        txn_date: t,
      }),
      /more than what is still owed on FD-\d{4}-\d{5} \(RM 5,000\.00\)/,
    );
    await assert.rejects(
      f.json("/api/funding", "POST", {
        kind: "repayment",
        loan_id: loan.id,
        amount: "100.00",
        txn_date: addDays(t, -25),
      }),
      /dated before the loan/,
    );
    await assert.rejects(
      f.json("/api/funding", "POST", {
        kind: "repayment",
        amount: "100.00",
        txn_date: t,
      }),
      /Choose which loan/,
    );
    await assert.rejects(
      f.json("/api/funding", "POST", {
        kind: "repayment",
        loan_id: capital.id,
        amount: "100.00",
        txn_date: t,
      }),
      /Choose which loan/,
    );
    const repay = await f.json("/api/funding", "POST", {
      kind: "repayment",
      loan_id: loan.id,
      party: "ignored",
      role: "other",
      amount: "1000.00",
      txn_date: addDays(t, -10),
      method: "Bank transfer",
      reference: "RP-1",
    });
    assert.equal(repay.party, "Farah");
    assert.equal(repay.role, "director");
    assert.equal(repay.loan_number, loan.number);

    const { entries, summary } = await f.json("/api/funding");
    const l = entries.find((e) => e.id === loan.id);
    assert.equal(l.repaid, 100000);
    assert.equal(l.balance, 400000);
    assert.deepEqual(
      {
        capital: summary.capital,
        loans: summary.loans,
        repaid: summary.repaid,
        outstanding: summary.outstanding,
      },
      { capital: 2000000, loans: 500000, repaid: 100000, outstanding: 400000 },
    );
    assert.deepEqual(
      summary.people.map((p) => [
        p.party,
        p.role,
        p.capital,
        p.loans,
        p.repaid,
        p.outstanding,
      ]),
      [
        ["Farah", "director", 0, 500000, 100000, 400000],
        ["Aizat", "owner", 2000000, 0, 0, 0],
      ],
    );

    // What is typed is checked.
    await assert.rejects(
      f.json("/api/funding", "POST", {
        kind: "gift",
        party: "X",
        amount: "1.00",
        txn_date: t,
      }),
      /Choose what this money is/,
    );
    await assert.rejects(
      f.json("/api/funding", "POST", {
        kind: "capital",
        party: "",
        amount: "1.00",
        txn_date: t,
      }),
      /who the money is from/,
    );
    await assert.rejects(
      f.json("/api/funding", "POST", {
        kind: "capital",
        party: "X",
        role: "friend",
        amount: "1.00",
        txn_date: t,
      }),
      /Choose their role/,
    );
    await assert.rejects(
      f.json("/api/funding", "POST", {
        kind: "capital",
        party: "X",
        amount: "0",
        txn_date: t,
      }),
      /above zero/,
    );
    await assert.rejects(
      f.json("/api/funding", "POST", {
        kind: "capital",
        party: "X",
        amount: "1.00",
        txn_date: addDays(t, 1),
      }),
      /cannot be in the future/,
    );
    await assert.rejects(
      f.json("/api/funding", "POST", {
        kind: "capital",
        party: "X",
        amount: "1.00",
        txn_date: t,
        method: "Gold",
      }),
      /how the money moved/,
    );
    // The form sends its hidden loan field with every kind; only a repayment uses it.
    const stray = await f.json("/api/funding", "POST", {
      kind: "capital",
      party: "Stray",
      amount: "1.00",
      txn_date: t,
      loan_id: loan.id,
    });
    assert.equal(stray.loan_id, null);
    assert.equal(stray.loan_number, "");
    // The same entry twice is refused.
    await assert.rejects(
      f.json("/api/funding", "POST", {
        kind: "capital",
        party: "aizat",
        role: "owner",
        amount: "20000.00",
        txn_date: addDays(t, -30),
        method: "Bank transfer",
        reference: "cap-1",
      }),
      (e) => e.status === 409 && /already recorded/.test(e.message),
    );

    // Void: a loan with repayments waits for them; the repayment goes first.
    await assert.rejects(
      f.json(`/api/funding/${loan.id}/void`, "POST", { reason: "typo" }),
      /Void those first/,
    );
    await assert.rejects(
      f.json(`/api/funding/${repay.id}/void`, "POST", { reason: "" }),
      /./,
    );
    const voided = await f.json(`/api/funding/${repay.id}/void`, "POST", {
      reason: "Wrong amount",
    });
    assert.equal(voided.voided, true);
    assert.equal(voided.void_reason, "Wrong amount");
    await assert.rejects(
      f.json(`/api/funding/${repay.id}/void`, "POST", { reason: "again" }),
      /already voided/,
    );
    const after = await f.json("/api/funding");
    assert.equal(after.entries.find((e) => e.id === loan.id).balance, 500000);
    assert.equal(after.summary.outstanding, 500000);
    const gone = await f.json(`/api/funding/${loan.id}/void`, "POST", {
      reason: "Was a gift; recorded as capital instead",
    });
    assert.equal(gone.balance, 0);
    assert.equal((await f.json("/api/funding")).summary.outstanding, 0);
    await assert.rejects(
      f.json(`/api/funding/nope/void`, "POST", { reason: "x" }),
      (e) => e.status === 404,
    );

    // The audit trail keeps every step.
    const actions = f.store.db
      .prepare(
        "SELECT action FROM audit WHERE action LIKE 'funding.%' ORDER BY created, rowid",
      )
      .all()
      .map((r) => r.action);
    assert.deepEqual(actions, [
      "funding.recorded",
      "funding.recorded",
      "funding.recorded",
      "funding.recorded",
      "funding.voided",
      "funding.voided",
    ]);

    // CSV, the workspace and the business export carry the entries.
    const csv = await (await f.auth("/api/funding.csv")).text();
    assert.match(csv, /^"Number","Date","Type","Person","Role"/);
    assert.match(csv, /"Capital","Aizat","Owner","20000\.00"/);
    assert.match(csv, /Void: Wrong amount/);
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.funding.entries.length, 4);
    assert.equal(ws.ext.funding.summary.capital, 2000100);
    const backup = await (await f.auth("/api/backup")).json();
    assert.equal(backup.ext.funding.entries.length, 4);

    // An accountant reads; staff see nothing.
    const acc = await member(f, "accountant");
    assert.equal((await acc.json("/api/funding")).entries.length, 4);
    await assert.rejects(
      acc.json("/api/funding", "POST", {
        kind: "capital",
        party: "X",
        amount: "1.00",
        txn_date: t,
      }),
      (e) => e.status === 403,
    );
    const staff = await member(f, "staff");
    await assert.rejects(staff.json("/api/funding"), (e) => e.status === 403);
    assert.ok(!(await staff.json("/api/workspace")).ext.funding);
  } finally {
    await f.close();
  }
});

test("cash forecast: capital and loans count as cash in, repayments as cash out", () => {
  const asOf = "2026-03-01";
  const base = {
    docs: [],
    receipts: [],
    expenses: [],
    bills: [],
    lateness: latePayment({ docs: [], asOf }),
    cashBalance: 100000,
    cashDate: "2026-02-01",
    asOf,
  };
  assert.equal(cashForecast(base).opening.estimated, 100000);
  const withFunding = cashForecast({
    ...base,
    funding: [
      { date: "2026-02-10", amount: 500000, kind: "loan" },
      { date: "2026-02-20", amount: -100000, kind: "repayment" },
      // Before the bank balance date: already in that balance.
      { date: "2026-01-15", amount: 999999, kind: "capital" },
    ],
  });
  assert.equal(withFunding.opening.funding, 400000);
  assert.equal(withFunding.opening.estimated, 500000);
});
