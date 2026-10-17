import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { fixture } from "./helpers.mjs";
import { issued, pay } from "./portal-helpers.mjs";
import { inMYR } from "../server/portal-credit.mjs";
import { today, addDays } from "../server/domain.mjs";

function store() {
  const s = openDatabase(":memory:");
  s.saveSettings({ registration: "R-1", address: "Office", email: "a@example.com" });
  return s;
}
const draft = (s, client, rate, kind = "invoice") =>
  s.saveDocument({
    kind,
    client_id: client.id,
    issue_date: today(),
    due_date: addDays(today(), 14),
    items: [{ description: "Work", quantity: 1, rate }],
  });

test("credit used is the open balance of issued invoices, in MYR", () => {
  const s = store();
  const c = s.saveClient({ name: "Credit client" });
  assert.deepEqual(
    { limit: s.creditStatus(c.id).credit_limit, used: s.creditStatus(c.id).used, held: s.creditStatus(c.id).held },
    { limit: null, used: 0, held: false },
    "no limit and no hold by default",
  );
  const a = issued(s, c, { rate: "1000.00" });
  issued(s, c, { rate: "500.00" });
  pay(s, a, "400.00");
  draft(s, c, "9999.00");
  issued(s, c, { kind: "quote", rate: "8000.00" });
  s.saveCreditSettings(c.id, { credit_limit: "2000.00" });
  const st = s.creditStatus(c.id);
  assert.equal(st.used, 110000, "drafts and quotations do not use credit");
  assert.equal(st.available, 90000);
  assert.equal(st.over_limit, false);
  assert.equal(inMYR({ currency: "USD", fx_rate: "4.4500" }, 10000), 44500, "foreign currency at its rate");
  assert.equal(inMYR({ currency: "MYR", fx_rate: "9" }, 10000), 10000);
  assert.equal(inMYR({}, 123), 123);
});

test("issuing over the limit or on hold is blocked with a clear message", () => {
  const s = store();
  const c = s.saveClient({ name: "Busy Sdn Bhd" });
  issued(s, c, { rate: "800.00" });
  s.saveCreditSettings(c.id, { credit_limit: "1000.00" });
  const ok = draft(s, c, "200.00");
  assert.equal(s.issue(ok.id).state, "issued", "exactly at the limit is allowed");
  const over = draft(s, c, "0.01");
  assert.throws(() => s.issue(over.id), (e) => e.status === 409 && /Issuing is blocked for Busy Sdn Bhd/.test(e.message) && /over the RM\s?1,000.00 credit limit/.test(e.message));
  const quote = draft(s, c, "50.00", "quote");
  assert.throws(() => s.issue(quote.id), /This quotation would bring the balance/);
  assert.equal(s.document(over.id).state, "draft");

  const d = s.saveClient({ name: "Hold Sdn Bhd" });
  assert.throws(() => s.saveCreditSettings(d.id, { on_hold: true }), /reason/);
  s.saveCreditSettings(d.id, { on_hold: true, hold_reason: "Disputed project" });
  assert.throws(() => s.issue(draft(s, d, "1.00").id), /On hold: Disputed project/);
  s.saveCreditSettings(d.id, { on_hold: false });
  assert.equal(s.issue(draft(s, d, "1.00").id).state, "issued");
  const actions = s.db.prepare("SELECT action FROM audit WHERE entity_id=? ORDER BY id").all(d.id).map((r) => r.action);
  assert.ok(actions.includes("client.hold.placed") && actions.includes("client.hold.released"));
});

test("an invoice overdue for more than N days puts the client on hold", () => {
  const s = store();
  const c = s.saveClient({ name: "Late payer" });
  issued(s, c, { rate: "100.00", issue: addDays(today(), -40), due: addDays(today(), -10) });
  s.saveCreditSettings(c.id, { hold_days: 10 });
  assert.equal(s.creditStatus(c.id).held, false, "exactly 10 days is not more than 10");
  s.saveCreditSettings(c.id, { hold_days: 9 });
  const st = s.creditStatus(c.id);
  assert.equal(st.held, true);
  assert.equal(st.overdue_days, 10);
  assert.equal(st.overdue_amount, 10000);
  assert.throws(() => s.issue(draft(s, c, "5.00").id), /10 days overdue \(hold after 9\)/);
  // Paying the late invoice lifts the hold.
  const late = s.db.prepare("SELECT id FROM documents WHERE client_id=? AND state='issued'").get(c.id);
  pay(s, s.document(late.id));
  assert.equal(s.creditStatus(c.id).held, false);
});

test("the owner can allow one draft past the check, with an audited reason", async () => {
  const f = await fixture();
  try {
    const c = f.store.saveClient({ name: "Override client" });
    await f.json(`/api/clients/${c.id}`, "PUT", { name: "Override client", terms: 14, portal_credit: "1", credit_limit: "100.00", hold_days: "", on_hold: "on", hold_reason: "Waiting for PO" });
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.portal.clients[c.id].credit_limit, 10000);
    assert.equal(ws.ext.portal.clients[c.id].hold_reason, "Waiting for PO");
    const d = await f.json("/api/documents", "POST", { kind: "invoice", client_id: c.id, issue_date: today(), due_date: today(), items: [{ description: "Rush job", quantity: 1, rate: "150.00" }] });
    const check = await f.json(`/api/portal/documents/${d.id}/credit`);
    assert.equal(check.blocked, true);
    assert.equal(check.reasons.length, 2);
    assert.equal((await f.json("/api/workspace")).ext.portal.drafts[d.id].blocked, true);
    const blocked = await f.auth(`/api/documents/${d.id}/issue`, "POST", {});
    assert.equal(blocked.status, 409);
    assert.match((await blocked.json()).error, /Allow issue/);
    assert.equal((await f.auth(`/api/portal/documents/${d.id}/credit-override`, "POST", { reason: "" })).status, 400);
    const o = await f.json(`/api/portal/documents/${d.id}/credit-override`, "POST", { reason: "Director approved" });
    assert.equal(o.actor, "owner:owner@example.com");
    // Changing the amount after the override needs a new decision.
    await f.json(`/api/documents/${d.id}`, "PUT", { client_id: c.id, issue_date: today(), due_date: today(), items: [{ description: "Rush job", quantity: 2, rate: "150.00" }] });
    assert.equal((await f.auth(`/api/documents/${d.id}/issue`, "POST", {})).status, 409);
    await f.json(`/api/portal/documents/${d.id}/credit-override`, "POST", { reason: "Director approved the larger job" });
    assert.equal((await f.json(`/api/documents/${d.id}/issue`, "POST", {})).state, "issued");
    const audit = f.store.db.prepare("SELECT action,detail FROM audit WHERE entity_id=? AND action LIKE 'credit.%' ORDER BY id").all(d.id);
    assert.deepEqual(audit.map((a) => a.action), ["credit.override.allowed", "credit.override.allowed", "credit.override.used"]);
    assert.equal(audit[2].detail, "Director approved the larger job");
    assert.equal((await f.auth(`/api/portal/documents/${d.id}/credit-override`, "POST", { reason: "again" })).status, 409, "issued documents need no override");
    const free = f.store.saveClient({ name: "Free client" });
    const fd = draft(f.store, free, "10.00");
    assert.equal((await f.auth(`/api/portal/documents/${fd.id}/credit-override`, "POST", { reason: "x" })).status, 409, "only blocked drafts");
  } finally {
    await f.close();
  }
});

test("credit settings stay unless the client form or credit route sends them", async () => {
  const f = await fixture();
  try {
    const c = await f.json("/api/clients", "POST", { name: "Form client", terms: 14, portal_credit: "1", credit_limit: "2500.50", hold_days: "30", hold_reason: "" });
    assert.equal(f.store.portalClient(c.id).credit_limit, 250050);
    assert.equal(f.store.portalClient(c.id).hold_days, 30);
    // An API or MCP update without the fields keeps them.
    f.store.saveClient({ name: "Form client renamed" }, c.id);
    assert.equal(f.store.portalClient(c.id).credit_limit, 250050);
    const out = await f.json(`/api/portal/clients/${c.id}/credit`, "PUT", { credit_limit: "", hold_days: "" });
    assert.equal(out.credit_limit, null);
    assert.equal(out.hold_days, null);
    assert.equal((await f.auth(`/api/portal/clients/${c.id}/credit`, "PUT", { credit_limit: "-5" })).status, 400);
    assert.equal((await f.auth(`/api/portal/clients/${c.id}/credit`, "PUT", { hold_days: "400" })).status, 400);
    const before = f.store.db.prepare("SELECT before_data,after_data FROM audit WHERE action='client.credit.changed' ORDER BY id DESC").get();
    assert.equal(JSON.parse(before.before_data).credit_limit, 250050);
    assert.equal(JSON.parse(before.after_data).credit_limit, null);
  } finally {
    await f.close();
  }
});
