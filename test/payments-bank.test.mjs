import test from "node:test";
import assert from "node:assert/strict";
import { autoMapping, detectDelimiter, parseStatement, splitCsv, parseAmount, parseDate } from "../server/payments-bank.mjs";
import { openDatabase } from "../server/db.mjs";
import { fixture } from "./helpers.mjs";

const MAYBANK = `Account Number,512345678901
Account Name,NAWLOGIC SYSTEMS SOLUTION
Statement Date,17/10/2026

Entry Date,Transaction Description,Transaction Amount,Statement Balance
01/10/2026,BEGINNING BALANCE,,"10,000.00"
02/10/2026,"IBG CREDIT
MERANTI DIGITAL INV2026 12","1,500.00+","11,500.00"
03/10/2026,TRANSFER TO A/C RENT OCT,"2,000.00-","9,500.00"
,PAYMENT FOR OCT,,
05/10/2026,DUITNOW TRF RIMBA RETAIL,"1,200.00+","10,700.00"
`;
const CIMB = `Date,Description,Cheque / Ref No,Withdrawal,Deposit,Balance
02/10/2026,IBG CREDIT MERANTI DIGITAL,INV-2026-0012,,"1,500.00","11,500.00"
03/10/2026,JOMPAY TNB,,120.50,,"11,379.50"
`;
const PUBLIC_BANK = `PUBLIC BANK BERHAD;;;;
Account No;3123456789;;;
Date;Transaction;Debit;Credit;Balance
02/10/2026;DUITNOW CR MERANTI DIGITAL;;1,500.00;11,500.00
03/10/2026;SERVICE CHARGE;0.50;;11,499.50
;Closing balance;;;11,499.50
`;
const HONG_LEONG = `Date,Description,Withdrawal,Deposit,Balance
05-Oct-2026,INSTANT TRANSFER BAYU DESIGN,,"1,000.00","12,000.00"
06-Okt-2026,CASH WITHDRAWAL,200.00,,"11,800.00"
`;
const RHB = `Date,Description,Reference,Debit,Credit,Balance
02-10-2026,IBG CREDIT,MERANTI INV 0012,,1500.00,11500.00
`;
const BANK_ISLAM = `Transaction Date,Description,Reference No,Debit,Credit,Balance
02/10/2026,FUND TRANSFER CR,RIMBA RETAIL,,"1,200.00","9,700.00"
`;
const parse = (csv, layout) => {
  const delimiter = detectDelimiter(csv);
  const rows = splitCsv(csv, delimiter);
  const mapping = autoMapping(rows, { layout, delimiter });
  return { mapping, ...parseStatement(csv, mapping, "maybank") };
};

test("Maybank2u layout: header below account lines, trailing +/- amounts, wrapped descriptions", () => {
  const p = parse(MAYBANK, "maybank");
  assert.equal(p.mapping.headerRow, 3);
  assert.equal(p.mapping.amountMode, "signed");
  assert.equal(p.errors.length, 0);
  assert.equal(p.skipped, 1, "beginning balance skipped");
  assert.deepEqual(p.rows.map((r) => [r.txn_date, r.amount]), [
    ["2026-10-02", 150000],
    ["2026-10-03", -200000],
    ["2026-10-05", 120000],
  ]);
  assert.match(p.rows[0].reference, /IBG CREDIT\s+MERANTI DIGITAL INV2026 12/);
  assert.match(p.rows[1].description, /PAYMENT FOR OCT/, "continuation line joined");
  assert.equal(p.rows[0].account, "MAYBANK");
});

test("CIMB, Public Bank, RHB, Hong Leong and Bank Islam layouts map debit/credit columns", () => {
  const cimb = parse(CIMB, "cimb");
  assert.equal(cimb.mapping.amountMode, "split");
  assert.deepEqual(cimb.rows.map((r) => r.amount), [150000, -12050]);
  assert.equal(cimb.rows[0].reference, "INV-2026-0012");
  assert.equal(cimb.rows[0].description, "IBG CREDIT MERANTI DIGITAL");
  const pbb = parse(PUBLIC_BANK, "publicbank");
  assert.equal(pbb.mapping.delimiter, ";");
  assert.equal(pbb.mapping.headerRow, 2);
  assert.deepEqual(pbb.rows.map((r) => r.amount), [150000, -50]);
  assert.equal(pbb.skipped, 1, "closing balance skipped");
  const hlb = parse(HONG_LEONG, "hongleong");
  assert.equal(hlb.mapping.dateFormat, "DMONY");
  assert.deepEqual(hlb.rows.map((r) => [r.txn_date, r.amount]), [["2026-10-05", 100000], ["2026-10-06", -20000]]);
  const rhb = parse(RHB, "rhb");
  assert.equal(rhb.rows[0].txn_date, "2026-10-02");
  assert.equal(rhb.rows[0].reference, "MERANTI INV 0012");
  const bi = parse(BANK_ISLAM, "bankislam");
  assert.equal(bi.rows[0].amount, 120000);
  assert.equal(bi.rows[0].reference, "RIMBA RETAIL");
});

test("any layout: DR/CR indicator column, decimal commas, day-first dates and the normalized format", () => {
  const ind = parse(`Posting Date,Details,Amount,DR/CR\n02/10/2026,IBG MERANTI,"1,500.00",CR\n03/10/2026,FEE,"0.50",DR\n`);
  assert.equal(ind.mapping.amountMode, "indicator");
  assert.deepEqual(ind.rows.map((r) => r.amount), [150000, -50]);
  const comma = parse(`Datum;Tarikh;Keterangan;Amaun\nx;02.10.2026;PEMINDAHAN MERANTI;1.500,00\ny;03.10.2026;CAJ;-0,50\n`);
  assert.equal(comma.mapping.decimal, ",");
  assert.deepEqual(comma.rows.map((r) => [r.txn_date, r.amount]), [["2026-10-02", 150000], ["2026-10-03", -50]]);
  const normal = parse("date,reference,amount,description,transaction_id\n2026-10-02,INV-1,100.00,Transfer,tx-1\n");
  assert.equal(normal.mapping.dateFormat, "YMD");
  assert.equal(normal.rows[0].source_id, "tx-1");
  assert.equal(parseDate("01/02/2026", "DMY"), "2026-02-01", "Malaysian banks write the day first");
  assert.equal(parseAmount("(1,234.56)").sign, -1);
  assert.throws(() => parseAmount("12.345"), /not an amount/);
});

test("bad rows are reported, not guessed", () => {
  const p = parse(`Date,Description,Debit,Credit\n32/10/2026,X,,10.00\n02/10/2026,Y,5.00,6.00\n02/10/2026,Z,,abc\n03/10/2026,OK,,1.00\n`);
  assert.equal(p.rows.length, 1);
  assert.deepEqual(p.errors.map((e) => e.row), [2, 3, 4]);
  assert.match(p.errors[1].message, /Both debit and credit/);
  assert.throws(() => parseStatement(CIMB, { ...autoMapping(splitCsv(CIMB)), date: 40 }, "MAIN"), /not in this file/);
});

test("statement imports reuse the duplicate-safe path and never record income", () => {
  const s = openDatabase(":memory:");
  try {
    const p = parse(CIMB, "cimb");
    assert.equal(s.importBankRows(p.rows).inserted, 2);
    assert.equal(s.importBankRows(parse(CIMB, "cimb").rows).skipped, 2, "same statement again");
    // Two equal transfers on the same day are two transactions.
    const twice = `${CIMB}02/10/2026,IBG CREDIT MERANTI DIGITAL,INV-2026-0012,,"1,500.00","13,000.00"\n`;
    const t = parse(twice, "cimb");
    assert.equal(t.rows.length, 3);
    assert.equal(s.importBankRows(t.rows).inserted, 1);
    assert.equal(s.receipts().length, 0);
  } finally {
    s.db.close();
  }
});

test("owners preview, adjust, save and reuse a mapping over HTTP", async () => {
  const f = await fixture();
  try {
    const preview = await f.json("/api/payments/bank/preview", "POST", { csv: MAYBANK, account: "MBB", layout: "maybank" });
    assert.equal(preview.total, 3);
    assert.equal(preview.fresh, 3);
    assert.equal(preview.columns[1].label, "Transaction Description");
    assert.equal(preview.rows[0].amount, 150000);
    // A broken mapping comes back as a message with the columns to fix it.
    const broken = await f.json("/api/payments/bank/preview", "POST", { csv: MAYBANK, mapping: { ...preview.mapping, date: null } });
    assert.match(broken.mappingError, /date column/);
    assert.equal(broken.columns.length, 4);
    const imported = await f.json("/api/payments/bank/import", "POST", { csv: MAYBANK, account: "MBB", layout: "maybank", mapping: preview.mapping });
    assert.deepEqual(imported, { inserted: 3, skipped: 0, unreadable: 0 });
    const again = await f.json("/api/payments/bank/preview", "POST", { csv: MAYBANK, account: "MBB", mapping: preview.mapping });
    assert.equal(again.duplicates, 3);
    assert.equal(f.store.finance().bankTransactions.length, 3);
    // Unreadable rows block the import unless the owner chooses to skip them.
    const messy = MAYBANK + "06/10/2026,BAD AMOUNT,abc+,\n";
    const blocked = await f.auth("/api/payments/bank/import", "POST", { csv: messy, account: "MBB", mapping: preview.mapping });
    assert.equal(blocked.status, 400);
    assert.match((await blocked.json()).error, /1 row/);
    const skipped = await f.json("/api/payments/bank/import", "POST", { csv: messy, account: "MBB", mapping: preview.mapping, skipErrors: true });
    assert.deepEqual(skipped, { inserted: 0, skipped: 3, unreadable: 1 });
    // Save the mapping by column names; it still fits when the bank reorders columns.
    const saved = await f.json("/api/payments/bank/layouts", "POST", { name: "My Maybank", csv: MAYBANK, mapping: preview.mapping });
    assert.equal(saved.mapping.names.amount, "Transaction Amount");
    const reordered = "Entry Date,Statement Balance,Transaction Amount,Transaction Description\n07/10/2026,\"9,000.00\",\"50.00+\",REFUND FROM SUPPLIER\n";
    const reuse = await f.json("/api/payments/bank/preview", "POST", { csv: reordered, account: "MBB", layout: "preset:" + saved.id });
    assert.equal(reuse.mappingError, null);
    assert.equal(reuse.rows[0].amount, 5000);
    assert.equal(reuse.rows[0].reference, "REFUND FROM SUPPLIER");
    const wrong = await f.json("/api/payments/bank/preview", "POST", { csv: CIMB, layout: "preset:" + saved.id });
    assert.match(wrong.mappingError || "", /does not match/);
    assert.equal((await f.json("/api/workspace")).ext.payments.bankPresets.length, 1);
    assert.equal((await f.auth("/api/payments/bank/layouts/" + saved.id, "DELETE")).status, 200);
    assert.equal(f.store.receipts().length, 0, "import alone never creates income");
  } finally {
    await f.close();
  }
});
