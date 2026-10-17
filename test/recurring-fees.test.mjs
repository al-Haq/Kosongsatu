import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { today, addDays, AppError } from "../server/domain.mjs";
import { lateFeeDue, normalizeLateFees, lateFeePolicy, LATE_FEE_DEFAULTS } from "../server/recurring-fees.mjs";

const fixed = { ...LATE_FEE_DEFAULTS, enabled: true, type: "fixed", amount: 2000, after_days: 7 };
const percent = {
  ...LATE_FEE_DEFAULTS,
  enabled: true,
  type: "percent",
  percent_bp: 150,
  after_days: 7,
  repeat_days: 30,
  max_count: 3,
  cap: 4000,
};
const due = "2026-03-01";

test("fixed fees start after N days overdue and are charged once without a repeat", () => {
  assert.equal(lateFeeDue(fixed, { due_date: due, balance: 100000 }, "2026-03-07"), null);
  assert.deepEqual(lateFeeDue(fixed, { due_date: due, balance: 100000 }, "2026-03-08"), {
    charge_no: 1,
    amount: 2000,
    base: 100000,
    late: 7,
  });
  const charged = [{ charge_no: 1, amount: 2000 }];
  assert.equal(lateFeeDue(fixed, { due_date: due, balance: 102000, charged }, "2026-06-01"), null);
  assert.equal(lateFeeDue(fixed, { due_date: due, balance: 0 }, "2026-04-01"), null, "paid invoices are not charged");
  assert.equal(lateFeeDue({ ...fixed, enabled: false }, { due_date: due, balance: 100000 }, "2026-04-01"), null);
});

test("percentage fees repeat every N days on the balance without earlier fees, up to the count and cap", () => {
  const first = lateFeeDue(percent, { due_date: due, balance: 100000 }, "2026-03-08");
  assert.deepEqual([first.charge_no, first.amount], [1, 1500]);
  const one = [{ charge_no: 1, amount: 1500 }];
  assert.equal(lateFeeDue(percent, { due_date: due, balance: 101500, charged: one }, "2026-04-06"), null, "day 36 is too early");
  const second = lateFeeDue(percent, { due_date: due, balance: 101500, charged: one }, "2026-04-07");
  assert.deepEqual([second.charge_no, second.amount, second.base], [2, 1500, 100000], "no fee on fees");
  const two = [...one, { charge_no: 2, amount: 1500 }];
  const third = lateFeeDue(percent, { due_date: due, balance: 103000, charged: two }, "2026-05-07");
  assert.deepEqual([third.charge_no, third.amount], [3, 1000], "capped at RM 40 in total");
  const three = [...two, { charge_no: 3, amount: 1000 }];
  assert.equal(lateFeeDue(percent, { due_date: due, balance: 104000, charged: three }, "2026-12-01"), null);
  assert.equal(lateFeeDue({ ...percent, cap: 3000 }, { due_date: due, balance: 103000, charged: two }, "2026-05-07"), null);
  // Payments reduce the base; rounding is to the nearest sen.
  assert.equal(lateFeeDue(percent, { due_date: due, balance: 33333 }, "2026-03-08").amount, 500);
  // Only fees left unpaid: nothing more is charged.
  assert.equal(lateFeeDue(percent, { due_date: due, balance: 1500, charged: one }, "2026-04-07"), null);
});

test("late fee settings are validated and remember when they were turned on", () => {
  const on = normalizeLateFees(
    { enabled: true, type: "percent", percent: "1.5", after_days: 7, repeat_days: 30, max_count: 3, cap: "40.00" },
    LATE_FEE_DEFAULTS,
    "2026-10-01",
  );
  assert.deepEqual([on.percent_bp, on.cap, on.since], [150, 4000, "2026-10-01"]);
  assert.equal(normalizeLateFees({ after_days: 10 }, on, "2026-11-01").since, "2026-10-01", "edits keep the start date");
  assert.equal(normalizeLateFees({ enabled: false }, on, "2026-11-01").since, null);
  assert.equal(normalizeLateFees({ repeat_days: 0, max_count: 5 }, on, "2026-11-01").max_count, 1);
  assert.throws(() => normalizeLateFees({ type: "compound" }, on, "2026-10-01"), /fixed amount or a percentage/);
  assert.throws(() => normalizeLateFees({ percent: "30" }, on, "2026-10-01"), /between 0.01 and 25/);
  assert.throws(() => normalizeLateFees({ percent: "1.555" }, on, "2026-10-01"), /percentage/);
  assert.throws(() => normalizeLateFees({ type: "fixed", amount: "0" }, on, "2026-10-01"), /greater than zero/);
  assert.throws(() => normalizeLateFees({ after_days: 0 }, on, "2026-10-01"), /Number outside/);
  assert.throws(() => normalizeLateFees({ max_count: 25 }, on, "2026-10-01"), /Number outside/);
  assert.match(lateFeePolicy(on), /1\.5% of the unpaid balance/);
  assert.match(lateFeePolicy(on), /every 30 days .* up to 3 times \(no more than RM\s?40\.00 in total\)/);
  assert.match(lateFeePolicy({ ...fixed }), /7 days after the due date, a late fee of RM\s?20\.00/);
  assert.equal(lateFeePolicy({ ...fixed, enabled: false }), null);
});

function setup() {
  const store = openDatabase(":memory:");
  store.saveSettings({ registration: "TEST-001", address: "Test office", email: "billing@example.com" });
  const client = store.saveClient({ name: "Late payer", email: "late@example.com" });
  const invoice = ({ issued = -40, due = -30, rate = "1000.00", c = client } = {}) =>
    store.issue(
      store.saveDocument({
        kind: "invoice",
        client_id: c.id,
        issue_date: addDays(today(), issued),
        due_date: addDays(today(), due),
        items: [{ description: "Work", quantity: 1, rate }],
      }).id,
    );
  // The policy was turned on 90 days ago, so these invoices carried it.
  const enable = (b) => store.saveRecurringConfig({ lateFees: { enabled: true, ...b } }, addDays(today(), -90));
  return { store, client, invoice, enable };
}
const fees = (store, id) => store.db.prepare("SELECT * FROM recurring_late_fees WHERE invoice_id=? ORDER BY charge_no").all(id);

test("the late fee job charges a debit note once per invoice and charge number", () => {
  const { store, invoice, enable } = setup();
  try {
    const d = invoice();
    assert.deepEqual(store.runLateFees(), { charged: 0, failed: 0, skipped: true }, "off by default");
    enable({ type: "fixed", amount: "20.00", after_days: 7 });
    assert.equal(store.runLateFees().charged, 1);
    assert.equal(store.runLateFees().charged, 0);
    assert.equal(store.runLateFees().charged, 0);
    const after = store.document(d.id);
    assert.equal(after.debit, 2000);
    assert.equal(after.adjusted_total, 102000);
    assert.equal(after.adjustments[0].kind, "debit");
    assert.match(after.adjustments[0].reason, /Late payment fee: invoice .* 30 days overdue/);
    const [fee] = fees(store, d.id);
    assert.deepEqual([fee.charge_no, fee.amount, fee.status, fee.adjustment_id], [1, 2000, "charged", after.adjustments[0].id]);
    assert.equal(store.db.prepare("SELECT count(*) n FROM audit WHERE action='late_fee.charged'").get().n, 1);
  } finally {
    store.db.close();
  }
});

test("repeating percentage fees catch up to the count and cap, and respect payments", () => {
  const { store, invoice, enable } = setup();
  try {
    const d = invoice({ issued: -80, due: -70 });
    const part = invoice({ issued: -80, due: -10 });
    store.recordPayment(part.id, { amount: "400.00", paid_date: today(), method: "Bank transfer", reference: "PART-1" });
    enable({ type: "percent", percent: "1.5", after_days: 7, repeat_days: 30, max_count: 3, cap: "40.00" });
    assert.equal(store.runLateFees().charged, 4);
    assert.deepEqual(fees(store, d.id).map((f) => f.amount), [1500, 1500, 1000]);
    assert.deepEqual(fees(store, part.id).map((f) => [f.amount, f.base]), [[900, 60000]]);
    assert.equal(store.runLateFees().charged, 0);
    assert.equal(store.document(d.id).adjusted_total, 104000);
  } finally {
    store.db.close();
  }
});

test("exempt clients, stopped invoices and invoices from before the policy are never charged", () => {
  const { store, client, invoice, enable } = setup();
  try {
    const exemptClient = store.saveClient({ name: "Partner", recurring_fields: "1", late_fee_exempt: "on" });
    assert.equal(exemptClient.late_fee_exempt, 1);
    const edited = store.saveClient({ ...exemptClient, name: "Partner Sdn Bhd" }, exemptClient.id);
    assert.equal(edited.late_fee_exempt, 1, "saves without the form field keep the setting");
    const a = invoice({ c: exemptClient });
    const old = invoice({ issued: -100, due: -95 });
    const stopped = invoice();
    store.holdLateFees(stopped.id, true);
    enable({ type: "fixed", amount: "20.00", after_days: 7 });
    assert.equal(store.runLateFees().charged, 0);
    assert.equal(store.lateFeePolicyFor(store.document(a.id)), null);
    assert.equal(store.lateFeePolicyFor(store.document(old.id)), null);
    store.holdLateFees(stopped.id, false);
    assert.equal(store.runLateFees().charged, 1);
    assert.equal(fees(store, stopped.id).length, 1);
    store.saveClient({ ...client, recurring_fields: "1" }, client.id);
    assert.equal(store.client(client.id).late_fee_exempt, 0);
    assert.equal(
      store.db.prepare("SELECT count(*) n FROM audit WHERE action='client.late_fees'").get().n,
      1,
    );
  } finally {
    store.db.close();
  }
});

test("waiving issues one credit note for all late fees and stops further fees", () => {
  const { store, invoice, enable } = setup();
  try {
    const d = invoice({ issued: -80, due: -70 });
    enable({ type: "fixed", amount: "20.00", after_days: 7, repeat_days: 30, max_count: 3 });
    assert.equal(store.runLateFees().charged, 3);
    const cn = store.waiveLateFees(d.id, "Long-standing client");
    assert.equal(cn.kind, "credit");
    assert.equal(cn.amount, 6000);
    assert.match(cn.reason, /Late fee waived \(DN-.*\): Long-standing client/);
    const after = store.document(d.id);
    assert.equal(after.adjusted_total, after.total);
    assert.ok(fees(store, d.id).every((f) => f.waiver_id === cn.id));
    assert.throws(() => store.waiveLateFees(d.id), /no late fees to waive/);
    assert.equal(store.runLateFees().charged, 0);
    assert.equal(store.lateFeePolicyFor(after), null);
  } finally {
    store.db.close();
  }
});

test("a failed charge is recorded once and not retried", () => {
  const { store, invoice, enable } = setup();
  try {
    const d = invoice();
    enable({ type: "fixed", amount: "20.00", after_days: 7 });
    store.adjustment = () => {
      throw new AppError("Simulated refusal.", 409);
    };
    assert.deepEqual(store.runLateFees(), { charged: 0, failed: 1, skipped: false });
    delete store.adjustment;
    assert.equal(store.runLateFees().charged, 0);
    const [fee] = fees(store, d.id);
    assert.deepEqual([fee.status, fee.error, fee.adjustment_id], ["failed", "Simulated refusal.", null]);
    assert.equal(store.document(d.id).debit, 0);
  } finally {
    store.db.close();
  }
});

test("the policy prints on eligible invoice PDFs only", async () => {
  const { store, invoice, enable } = setup();
  try {
    const d = invoice({ issued: 0, due: 14 });
    assert.deepEqual(await store.pdfBlocks(d), []);
    enable({ type: "fixed", amount: "20.00", after_days: 7 });
    const blocks = await store.pdfBlocks(store.document(d.id));
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].heading, "Late payment");
    assert.match(blocks[0].text, /RM\s?20\.00/);
    const quote = store.saveDocument({
      kind: "quote",
      client_id: d.client_id,
      issue_date: today(),
      due_date: today(),
      items: [{ description: "Quote", quantity: 1, rate: "1.00" }],
    });
    assert.deepEqual(await store.pdfBlocks(quote), []);
  } finally {
    store.db.close();
  }
});
