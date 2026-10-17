import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { today, addDays } from "../server/domain.mjs";
import { addMonths } from "../server/recurring-dates.mjs";
import { runDuePlans, runContracts } from "../server/recurring-auto.mjs";

function setup({ mail = false } = {}) {
  const store = openDatabase(":memory:");
  store.saveSettings({ registration: "TEST-001", address: "Test office", email: "owner@example.com", company: "Test Co" });
  const client = store.saveClient({ name: "Retainer client", email: "ap@client.example" });
  const sent = [];
  const mailer = {
    status: () => ({ configured: mail }),
    async deliver(m) {
      if (m.dedupeKey && sent.some((x) => x.dedupeKey === m.dedupeKey)) return null;
      sent.push(m);
      return { status: "sent" };
    },
  };
  const ctx = { store, mailer, appUrl: "https://app.example" };
  const contract = (b = {}) =>
    store.saveRecurringContract({
      client_id: client.id,
      title: "Support retainer",
      value: "12000.00",
      start_date: addMonths(today(), -11),
      end_date: addDays(today(), 20),
      ...b,
    });
  const plan = (b = {}) =>
    store.saveSchedule({
      client_id: client.id,
      lines: [{ description: "Retainer", rate: "1000.00" }],
      next_date: today(),
      ...b,
    });
  return { store, client, ctx, sent, contract, plan };
}
const runCount = (store, sid) => store.db.prepare("SELECT count(*) n FROM schedule_runs WHERE schedule_id=?").get(sid).n;
const audits = (store, action) => store.db.prepare("SELECT * FROM audit WHERE action=? ORDER BY id").all(action);

test("contracts are validated, audited and show expiring inside the notice window", () => {
  const { store, client, contract } = setup();
  try {
    assert.throws(() => contract({ end_date: addMonths(today(), -12) }), /on or after the start/);
    assert.throws(() => contract({ renewal: "maybe" }), /Choose manual/);
    assert.throws(() => contract({ title: "" }), /Required/);
    assert.throws(() => contract({ value: "-5" }), /Amounts/);
    const c = contract({ notice_days: 30 });
    assert.equal(c.status, "active");
    assert.equal(c.value, 1200000);
    const [listed] = store.recurringContracts();
    assert.equal(listed.display_status, "expiring");
    assert.equal(listed.days_left, 20);
    assert.equal(listed.terms.length, 1);
    store.saveRecurringContract({ notice_days: 7 }, c.id);
    assert.equal(store.recurringContracts()[0].display_status, "active");
    const changed = audits(store, "contract.changed");
    assert.equal(JSON.parse(changed[0].before_data).notice_days, 30);
    assert.equal(JSON.parse(changed[0].after_data).notice_days, 7);
    assert.throws(() => store.deleteClient(client.id), /has contracts/);
  } finally {
    store.db.close();
  }
});

test("linked plans stop billing after the contract ends, and the contract is marked ended", async () => {
  const { store, ctx, contract, plan } = setup();
  try {
    const c = contract({ start_date: addMonths(today(), -6), end_date: addMonths(today(), -2) });
    const s = plan({ next_date: addMonths(today(), -4), contract_id: c.id });
    const r = await runDuePlans(ctx);
    assert.equal(r.ended, 1);
    assert.equal(runCount(store, s.id), 3, "periods up to the end date only");
    assert.equal(store.recurringContract(c.id).status, "ended");
    assert.equal(audits(store, "contract.ended").length, 1);
    await runDuePlans(ctx);
    assert.equal(runCount(store, s.id), 3);
    assert.equal(audits(store, "contract.ended").length, 1);
    assert.equal(store.recurringPlans().find((p) => p.id === s.id).status, "Ended");
    assert.throws(() => store.runSchedule(s.id), /plan has ended/);
    // Renewing for another term lets the plan bill again from where it stopped.
    const renewed = store.renewRecurringContract(c.id);
    assert.equal(renewed.status, "active");
    assert.equal(renewed.renewals, 1);
    assert.equal(audits(store, "contract.renewed").length, 1);
    await runDuePlans(ctx);
    assert.equal(runCount(store, s.id), 5);
  } finally {
    store.db.close();
  }
});

test("auto-renewing contracts add terms once and keep linked plans billing", async () => {
  const { store, ctx, contract, plan } = setup();
  try {
    const start = addMonths(today(), -12);
    const c = contract({ start_date: start, end_date: addDays(addMonths(start, 1), -1), renewal: "auto", term_months: 1 });
    const s = plan({ next_date: addMonths(today(), -2), contract_id: c.id });
    const r = await runDuePlans(ctx);
    assert.ok(r.renewed >= 11);
    const after = store.recurringContract(c.id);
    assert.ok(after.end_date >= today());
    assert.equal(after.status, "active");
    assert.equal(runCount(store, s.id), 3);
    const terms = store.db.prepare("SELECT * FROM recurring_contract_terms WHERE contract_id=? ORDER BY term_no").all(c.id);
    assert.equal(terms.length, r.renewed + 1);
    for (let i = 1; i < terms.length; i++) assert.equal(terms[i].start_date, addDays(terms[i - 1].end_date, 1));
    assert.equal(audits(store, "contract.auto_renewed").length, r.renewed);
    assert.equal(audits(store, "contract.auto_renewed")[0].actor, "system");
    const again = await runContracts(ctx);
    assert.equal(again.renewed, 0);
  } finally {
    store.db.close();
  }
});

test("renewal notices go to the owner once per end date", async () => {
  const { store, ctx, sent, contract } = setup({ mail: true });
  try {
    const c = contract({ renewal: "notify", notice_days: 30 });
    contract({ title: "Far away", renewal: "notify", notice_days: 10 });
    let r = await runContracts(ctx);
    assert.deepEqual([r.notices, r.emailed], [1, 1]);
    assert.deepEqual(sent[0].to, ["owner@example.com"]);
    assert.equal(sent[0].kind, "contract_notice");
    assert.match(sent[0].subject, /Support retainer \(Retainer client\)/);
    r = await runContracts(ctx);
    assert.equal(r.notices, 0);
    assert.equal(sent.length, 1);
    assert.equal(store.recurringContract(c.id).notified_for, c.end_date);
    // Moving the end date asks again for the new date.
    store.saveRecurringContract({ end_date: addDays(today(), 25) }, c.id);
    r = await runContracts(ctx);
    assert.equal(r.notices, 1);
    assert.equal(sent.length, 2);
    assert.equal(audits(store, "contract.renewal_notice").length, 2);
  } finally {
    store.db.close();
  }
});

test("notices are still recorded when email is not configured", async () => {
  const { store, ctx, sent, contract } = setup({ mail: false });
  try {
    contract({ renewal: "notify" });
    const r = await runContracts(ctx);
    assert.deepEqual([r.notices, r.emailed], [1, 0]);
    assert.equal(sent.length, 0);
    assert.match(audits(store, "contract.renewal_notice")[0].detail, /Shown on the overview/);
  } finally {
    store.db.close();
  }
});

test("cancelling stops linked plans from today; cancelled contracts cannot change", async () => {
  const { store, ctx, contract, plan } = setup();
  try {
    const c = contract({ end_date: addMonths(today(), 6) });
    const s = plan({ next_date: today(), contract_id: c.id });
    assert.throws(() => store.cancelRecurringContract(c.id, ""), /Required/);
    store.cancelRecurringContract(c.id, "Client moved to another provider");
    assert.equal(store.recurringEnd(store.recurringPlan(s.id)), today());
    // Even looking two months ahead, nothing after the cancellation date is billed.
    await runDuePlans(ctx, { asOf: addMonths(today(), 2) });
    assert.equal(runCount(store, s.id), 1);
    assert.throws(() => store.renewRecurringContract(c.id), /cancelled contract cannot be renewed/);
    assert.throws(() => store.saveRecurringContract({ title: "New" }, c.id), /cannot be edited/);
    assert.throws(() => plan({ contract_id: c.id }), /cancelled/);
    assert.throws(() => store.deleteRecurringContract(c.id), /Unlink them/);
    assert.equal(audits(store, "contract.cancelled").length, 1);
  } finally {
    store.db.close();
  }
});

test("ended contracts reopen when their end date moves forward; unused contracts can be deleted", () => {
  const { store, contract, plan } = setup();
  try {
    const c = contract({ start_date: addMonths(today(), -6), end_date: addDays(today(), -3) });
    store.recurringContractSweep();
    assert.equal(store.recurringContract(c.id).status, "ended");
    assert.equal(store.saveRecurringContract({ end_date: addMonths(today(), 3) }, c.id).status, "active");
    const s = plan();
    store.saveRecurringContract({ schedule_ids: [s.id] }, c.id);
    assert.equal(store.recurringPlan(s.id).contract_id, c.id);
    assert.equal(store.recurringContracts()[0].plans.length, 1);
    store.updateSchedule(s.id, { contract_id: "" });
    store.deleteRecurringContract(c.id);
    assert.throws(() => store.recurringContract(c.id), /not found/);
    assert.equal(audits(store, "contract.deleted").length, 1);
  } finally {
    store.db.close();
  }
});
