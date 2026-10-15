import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { parseBankCsv } from "../server/banking.mjs";
import { today } from "../server/domain.mjs";
const csv = (amount = "100.00", ref = "BANK-1") =>
  `date,reference,amount,description,transaction_id\n${today()},${ref},${amount},"Transfer, customer",tx-${ref}`;
test("normalized CSV parses quoted text, BOM, negative amounts and rejects malformed records", () => {
  assert.equal(
    parseBankCsv("\uFEFF" + csv())[0].description,
    "Transfer, customer",
  );
  assert.equal(parseBankCsv(csv("-20.50"))[0].amount, -2050);
  assert.throws(() => parseBankCsv("date,reference\n2026-01-01,REF"));
  assert.throws(() => parseBankCsv(csv("1.001")));
  assert.throws(() => parseBankCsv('date,reference,amount\n"broken'));
});
test("CSV imports are duplicate safe and do not create income", () => {
  const s = openDatabase(":memory:");
  try {
    assert.equal(s.previewBank({ csv: csv() })[0].duplicate, false);
    assert.equal(s.importBank({ csv: csv() }).inserted, 1);
    assert.equal(s.importBank({ csv: csv() }).skipped, 1);
    assert.equal(s.receipts().length, 0);
  } finally {
    s.db.close();
  }
});
test("receipt recording and bank matching are atomic; duplicate/amount/account matches fail", () => {
  const s = openDatabase(":memory:");
  try {
    const c = s.saveClient({ name: "Customer" });
    s.importBank({ csv: csv(), account: "MAIN" });
    const tid = s.finance().bankTransactions[0].id;
    const r = s.recordBankReceipt(tid, { client_id: c.id });
    assert.equal(r.amount, 10000);
    assert.equal(s.finance().bankTransactions[0].receipt_id, r.id);
    assert.throws(() => s.recordBankReceipt(tid, { client_id: c.id }));
    assert.throws(() => s.voidReceipt(r.id, "Matched receipt"));
    s.resetBank(tid, "Review again");
    s.matchBank(tid, { kind: "receipt", target_id: r.id });
    s.importBank({ csv: csv("200", "BANK-2") });
    const other = s
      .finance()
      .bankTransactions.find((t) => t.reference === "BANK-2");
    assert.throws(() => s.matchBank(other.id, { target_id: r.id }));
    assert.equal(s.receipts().length, 1);
  } finally {
    s.db.close();
  }
});
test("bank debits can match recorded refunds and exclusions require reasons", () => {
  const s = openDatabase(":memory:");
  try {
    const c = s.saveClient({ name: "Customer" });
    const r = s.receive({
      client_id: c.id,
      amount: 100,
      paid_date: today(),
      method: "Bank transfer",
      reference: "IN",
    });
    const f = s.refund(r.id, {
      amount: 20,
      reference: "OUT",
      reason: "Return deposit",
    });
    s.importBank({ csv: csv("-20", "OUT") });
    const t = s.finance().bankTransactions[0];
    s.matchBank(t.id, { kind: "refund", target_id: f.id });
    assert.equal(s.finance().bankTransactions[0].refund_id, f.id);
    s.resetBank(t.id, "Reclassify");
    assert.throws(() => s.ignoreBank(t.id, ""));
    s.ignoreBank(t.id, "Not customer billing");
    assert.equal(
      s.finance().bankTransactions[0].ignored_reason,
      "Not customer billing",
    );
  } finally {
    s.db.close();
  }
});
