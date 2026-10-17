import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { today, addDays } from "../server/domain.mjs";
import { hours100, klDate } from "../server/ops-work.mjs";
import { fixture } from "./helpers.mjs";

function setup() {
  const s = openDatabase(":memory:");
  s.saveSettings({ registration: "TEST-1", address: "Test office", email: "test@example.com", sstNumber: "W10-1808-32000001" });
  const c = s.saveClient({ name: "Time client", ops_hourly_rate: "150.00" });
  const other = s.saveClient({ name: "Other client" });
  const svc = s.saveService({ name: "Consulting", rate: "200.00", unit: "Hour", tax_rate: 8 });
  return { s, c, other, svc };
}
const log = (s, c, extra = {}) =>
  s.saveTime({ entry_date: today(), client_id: c.id, description: "Support work", hours: "1.5", billable: true, ...extra });

test("hours keep 2 decimals and rates come from the entry, the service or the client", () => {
  const { s, c, other, svc } = setup();
  try {
    assert.equal(hours100("1.25"), 125);
    assert.equal(hours100(8), 800);
    for (const bad of ["0", "24.01", "1.234", "-1", "abc"]) assert.throws(() => hours100(bad));
    assert.equal(log(s, c).rate, 15000, "client default");
    assert.equal(log(s, c, { service_id: svc.id }).rate, 20000, "service rate");
    assert.equal(log(s, c, { service_id: svc.id, rate: "99.90" }).rate, 9990, "entered rate");
    assert.equal(log(s, c, { hours: "0.25" }).value, 3750);
    assert.throws(() => log(s, other), /hourly rate/, "billable time needs a rate");
    assert.equal(log(s, other, { billable: false }).billable, 0);
    assert.throws(() => log(s, c, { entry_date: addDays(today(), 1) }), /future/);
    const p = s.saveProject({ client_id: other.id, name: "Other's project" });
    assert.throws(() => log(s, c, { project_id: p.id }), /same client/);
    assert.equal(s.client(c.id).ops_hourly_rate, 15000);
  } finally {
    s.db.close();
  }
});

test("invoicing unbilled time groups lines, links entries and never bills them twice", () => {
  const { s, c, svc } = setup();
  try {
    const p = s.saveProject({ client_id: c.id, name: "Website" });
    const e1 = log(s, c, { entry_date: addDays(today(), -3), service_id: svc.id, project_id: p.id, hours: "2" });
    const e2 = log(s, c, { entry_date: addDays(today(), -2), service_id: svc.id, project_id: p.id, hours: "1.25" });
    const e3 = log(s, c, { hours: "1" });
    const off = log(s, c, { billable: false, hours: "3" });
    const d = s.invoiceTime({ client_id: c.id, tax_rate: 0 });
    assert.equal(d.state, "draft");
    assert.equal(d.items.length, 2, "grouped by service, project and rate");
    const grouped = d.items.find((i) => i.rate === 20000);
    assert.equal(grouped.quantity, 3.25);
    assert.equal(grouped.amount, 65000);
    assert.equal(grouped.tax_rate, 8, "service SST rate");
    assert.ok(grouped.description.includes("Website"));
    assert.equal(d.items.find((i) => i.rate === 15000).tax_rate, 0);
    for (const e of [e1, e2, e3]) assert.equal(s.db.prepare("SELECT invoice_id FROM ops_time_entries WHERE id=?").get(e.id).invoice_id, d.id);
    assert.equal(s.db.prepare("SELECT invoice_id FROM ops_time_entries WHERE id=?").get(off.id).invoice_id, null);
    assert.throws(() => s.invoiceTime({ client_id: c.id }), /no unbilled/);
    assert.throws(() => s.saveTime({ hours: "9" }, e1.id), /on an invoice/);
    assert.throws(() => s.deleteTime(e1.id), /on an invoice/);
    // Deleting the draft releases the time.
    s.deleteDraft(d.id);
    assert.equal(s.timeEntries({ unbilled: true, client_id: c.id }).entries.length, 3);
    // One line per entry, and only the chosen entries.
    const d2 = s.invoiceTime({ client_id: c.id, project_id: p.id, group: "entry", entry_ids: [e1.id] });
    assert.equal(d2.items.length, 1);
    assert.equal(d2.items[0].quantity, 2);
    assert.throws(() => s.invoiceTime({ client_id: c.id, entry_ids: [e1.id, e3.id] }), /already billed/);
    // Issued: locked; void: released again.
    s.issue(d2.id);
    assert.throws(() => s.unlinkBilling(d2.id), /Only a draft/);
    assert.throws(() => s.saveTime({ hours: "1" }, e1.id), /on an invoice/);
    s.void(d2.id, "Billed in error");
    assert.equal(s.db.prepare("SELECT invoice_id FROM ops_time_entries WHERE id=?").get(e1.id).invoice_id, null);
    // A draft can release its time without being deleted.
    const d3 = s.invoiceTime({ client_id: c.id });
    assert.deepEqual(s.unlinkBilling(d3.id), { time: 3, milestones: 0 });
    assert.equal(s.document(d3.id).state, "draft");
  } finally {
    s.db.close();
  }
});

test("the timer keeps its start on the server and stops into a time entry", () => {
  const { s, c, svc } = setup();
  try {
    assert.throws(() => s.stopTimer(), /No timer/);
    const t = s.startTimer({ client_id: c.id, service_id: svc.id, description: "Server patching" });
    assert.ok(t.started);
    assert.throws(() => s.startTimer({ client_id: c.id }), /already running/);
    // Pretend it started 1 h 30 min ago.
    s.db.prepare("UPDATE ops_timers SET started=?").run(new Date(Date.now() - 90 * 60000).toISOString());
    const e = s.stopTimer({});
    assert.equal(e.hours100, 150);
    assert.equal(e.rate, 20000);
    assert.equal(e.source, "timer");
    assert.equal(s.timer(), null);
    s.startTimer({ client_id: c.id });
    assert.throws(() => s.stopTimer({}), /description/);
    s.db.prepare("UPDATE ops_timers SET started=?").run(new Date(Date.now() - 25 * 3600000).toISOString());
    assert.throws(() => s.stopTimer({ description: "Long" }), /24 hours/);
    s.discardTimer();
    assert.equal(s.timer(), null);
    assert.equal(klDate("2026-10-16T17:30:00Z"), "2026-10-17", "Kuala Lumpur day");
  } finally {
    s.db.close();
  }
});

test("milestones: amount or percentage of budget, invoiced once, released on draft delete or void", () => {
  const { s, c } = setup();
  try {
    assert.throws(() => s.saveMilestone(s.saveProject({ client_id: c.id, name: "No budget" }).id, { name: "Half", percent: "50" }), /budget/);
    const p = s.saveProject({ client_id: c.id, name: "Rollout", budget: "10000.00", start_date: today() });
    const m1 = s.saveMilestone(p.id, { name: "Design", percent: "30", tax_rate: 8 });
    const m2 = s.saveMilestone(p.id, { name: "Build", amount: "5000.00" });
    assert.throws(() => s.saveMilestone(p.id, { name: "Extra", amount: "2000.01" }), /more than the project budget/);
    assert.throws(() => s.saveProject({ budget: "7000.00" }, p.id), /more than the project budget/);
    assert.equal(s.milestones(p.id)[0].effective, 300000);
    s.setMilestoneReady(m1.id, true);
    const d = s.invoiceMilestone(m1.id);
    assert.equal(d.items.length, 1);
    assert.equal(d.subtotal, 300000);
    assert.equal(d.tax, 24000);
    assert.throws(() => s.invoiceMilestone(m1.id), /already invoiced/);
    assert.throws(() => s.saveMilestone(null, { name: "Renamed" }, m1.id), /locked/);
    assert.throws(() => s.deleteMilestone(m1.id), /invoiced/);
    // The budget can change later without changing what was invoiced.
    s.saveProject({ budget: "12000.00" }, p.id);
    assert.equal(s.milestones(p.id)[0].effective, 300000);
    s.deleteDraft(d.id);
    const back = s.milestones(p.id)[0];
    assert.equal(back.status, "ready");
    assert.equal(back.invoice_id, null);
    assert.equal(back.effective, 360000, "percentage follows the new budget until invoiced");
    const d2 = s.invoiceMilestone(m1.id);
    s.issue(d2.id);
    s.void(d2.id, "Wrong client contact");
    assert.equal(s.milestones(p.id)[0].status, "ready");
    const d3 = s.invoiceMilestone(m2.id);
    s.issue(d3.id);
    s.recordPayment(d3.id, { amount: "2500.00", paid_date: today(), method: "Bank transfer", reference: "PAY-1" });
    const e = log(s, c, { project_id: p.id, hours: "4" });
    const t = s.invoiceTime({ client_id: c.id, project_id: p.id });
    s.issue(t.id);
    const stats = s.projectStats(p.id);
    assert.equal(stats.budget, 1200000);
    assert.equal(stats.invoiced, 500000 + 60000);
    assert.equal(stats.paid, 250000, "half of the milestone invoice is paid");
    assert.equal(stats.hours, 400);
    assert.equal(stats.unbilled, 0);
    assert.throws(() => s.deleteProject(p.id), /time or invoices/);
    assert.ok(e.id);
  } finally {
    s.db.close();
  }
});

test("clients and services with operations records are protected", () => {
  const { s, c, svc } = setup();
  try {
    log(s, c, { service_id: svc.id });
    assert.throws(() => s.deleteClient(c.id), /projects or time/);
    s.deleteService(svc.id);
    assert.equal(s.db.prepare("SELECT service_id FROM ops_time_entries").get().service_id, null);
    const empty = s.saveClient({ name: "Nothing here" });
    s.deleteClient(empty.id);
    s.archiveClient(c.id, true);
    assert.throws(() => log(s, c), /archived/);
  } finally {
    s.db.close();
  }
});

test("time, timer and project routes", async () => {
  const f = await fixture();
  try {
    const c = f.store.saveClient({ name: "Route client", ops_hourly_rate: "100.00" });
    const key = { "Idempotency-Key": "ops-time-create-000000001" };
    const body = { entry_date: today(), client_id: c.id, description: "Call", hours: "0.5", billable: true };
    const first = await (await f.auth("/api/ops/time", "POST", body, key)).json();
    const retry = await (await f.auth("/api/ops/time", "POST", body, key)).json();
    assert.equal(first.id, retry.id, "a retried create is applied once");
    const week = await f.json(`/api/ops/time?from=${addDays(today(), -6)}&to=${today()}`);
    assert.equal(week.entries.length, 1);
    assert.equal((await f.auth("/api/ops/time?from=2026-01-01&to=2028-01-01")).status, 400);
    await f.json("/api/ops/timer/start", "POST", { client_id: c.id, description: "Live" });
    const ws = await f.json("/api/workspace");
    assert.ok(ws.ext.ops.timer.started);
    assert.equal(ws.ext.ops.unbilled[0].value, 5000);
    await f.json("/api/ops/timer/discard", "POST", {});
    const project = await f.json("/api/ops/projects", "POST", { client_id: c.id, name: "Route project", budget: "1000.00" });
    const m = await f.json(`/api/ops/projects/${project.id}/milestones`, "POST", { name: "All", percent: "100" });
    await f.json(`/api/ops/milestones/${m.id}/ready`, "POST", {});
    const inv = await f.json(`/api/ops/milestones/${m.id}/invoice`, "POST", {});
    assert.equal(inv.total, 100000);
    const again = await f.auth(`/api/ops/milestones/${m.id}/invoice`, "POST", {});
    assert.equal(again.status, 409);
    const detail = await f.json(`/api/ops/projects/${project.id}`);
    assert.equal(detail.stats.drafted, 100000);
    const billed = await f.json("/api/ops/time/invoice", "POST", { client_id: c.id });
    assert.equal(billed.total, 5000);
    assert.equal((await f.auth(`/api/ops/time/${first.id}`, "DELETE")).status, 409);
    assert.equal((await f.request("/api/ops/time")).status, 401);
    const noCsrf = await f.request("/api/ops/time", {
      method: "POST",
      headers: { Cookie: f.cookie, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(noCsrf.status, 403);
  } finally {
    await f.close();
  }
});
