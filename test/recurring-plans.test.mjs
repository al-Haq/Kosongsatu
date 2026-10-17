import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../server/db.mjs";
import { Mailer } from "../server/mailer.mjs";
import { today, addDays } from "../server/domain.mjs";
import { addMonths } from "../server/recurring-dates.mjs";
import { processPeriod, sendRun, runDuePlans } from "../server/recurring-auto.mjs";

function fakeTransport({ fail = false, delay = 0 } = {}) {
  const sent = [];
  return {
    sent,
    attempts: 0,
    async sendMail(m) {
      this.attempts++;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (fail) throw new Error("550 rejected");
      sent.push(m);
      return { messageId: `<${sent.length}@test>` };
    },
  };
}
function setup({ settings = {}, mail = true, transport = fakeTransport() } = {}) {
  const store = openDatabase(":memory:");
  store.saveSettings({
    registration: "TEST-001",
    address: "Test office",
    email: "billing@example.com",
    ...settings,
  });
  const client = store.saveClient({ name: "Plan client", email: "ap@client.example", terms: 14 });
  const service = store.saveService({ name: "Maintenance", rate: "750.00", unit: "Month" });
  const mailer = new Mailer(store, { config: mail ? { from: "billing@example.com" } : null, transport: mail ? transport : null });
  const ctx = { store, mailer, appUrl: "https://app.example", services: {} };
  const plan = (b = {}) =>
    store.saveSchedule({
      client_id: client.id,
      lines: [{ service_id: service.id }],
      next_date: today(),
      ...b,
    });
  return { store, client, service, mailer, transport, ctx, plan };
}
const runs = (store, sid) =>
  store.db.prepare("SELECT * FROM schedule_runs WHERE schedule_id=? ORDER BY period").all(sid);
const failures = (store, sid) =>
  store.db.prepare("SELECT count(*) n FROM audit WHERE action='schedule.automation.failed' AND entity_id=?").get(sid).n;

test("a multi-line plan bills every line with the service period, discount, notes and terms", () => {
  const { store, client, service } = setup({ settings: { sstNumber: "W10-1808-31000001" } });
  try {
    const s = store.saveSchedule({
      client_id: client.id,
      title: "Care plan",
      frequency: "monthly",
      next_date: "2026-01-31",
      terms: 7,
      lines: [
        { service_id: service.id, quantity: 2, rate: "500.00", tax_rate: 8 },
        { description: "Backup storage {period}", quantity: "1.5", rate: "40.00" },
      ],
      discount: "50.00",
      notes: "Thank you for your business.",
      terms_text: "Pay within 7 days.",
    });
    assert.equal(s.lines.length, 2);
    assert.equal(s.service_id, service.id, "first catalog line is kept for compatibility");
    const d = store.runSchedule(s.id);
    assert.equal(d.state, "draft");
    assert.deepEqual(
      d.items.map((i) => i.description),
      ["Maintenance – Jan 2026", "Backup storage Jan 2026"],
    );
    assert.equal(d.subtotal, 100000 + 6000);
    assert.equal(d.discount, 5000);
    // 8% SST on the maintenance line after its share of the discount.
    assert.equal(d.items[0].tax, Math.round(((100000 - 4717) * 8) / 100));
    assert.equal(d.total, d.subtotal - d.discount + d.tax);
    assert.equal(d.issue_date, "2026-01-31");
    assert.equal(d.due_date, "2026-02-07");
    assert.equal(d.notes, "Thank you for your business.");
    assert.equal(d.terms, "Pay within 7 days.");
    assert.equal(store.recurringPlan(s.id).next_date, "2026-02-28");
    const feb = store.runSchedule(s.id);
    assert.equal(feb.items[0].description, "Maintenance – Feb 2026");
    assert.equal(store.recurringPlan(s.id).next_date, "2026-03-31");
  } finally {
    store.db.close();
  }
});

test("weekly and quarterly plans step their dates and label date ranges", () => {
  const { store, plan } = setup();
  try {
    const w = plan({ frequency: "biweekly", next_date: "2025-12-24" });
    assert.equal(store.runSchedule(w.id).items[0].description, "Maintenance – 24 Dec 2025 – 6 Jan 2026");
    assert.equal(store.recurringPlan(w.id).next_date, "2026-01-07");
    const q = plan({ frequency: "quarterly", next_date: "2025-11-30" });
    assert.equal(store.runSchedule(q.id).items[0].description, "Maintenance – Nov 2025 – Jan 2026");
    assert.equal(store.recurringPlan(q.id).next_date, "2026-02-28");
    store.runSchedule(q.id);
    assert.equal(store.recurringPlan(q.id).next_date, "2026-05-30", "anchor day 30 comes back after February");
  } finally {
    store.db.close();
  }
});

test("plans are validated: lines, services, SST, recipients, contracts and frequency", () => {
  const { store, client, service, plan } = setup();
  try {
    assert.throws(() => plan({ lines: [] }), /between 1 and 20/);
    assert.throws(() => plan({ lines: [{ description: "", rate: "1.00" }] }), /Required/);
    assert.throws(() => plan({ lines: [{ description: "X", rate: "1.001" }] }), /2 decimal/);
    assert.throws(() => plan({ lines: [{ description: "X", rate: "10", tax_rate: 7 }] }), /SST rate/);
    assert.throws(() => plan({ lines: [{ description: "X", rate: "10", tax_rate: 8 }] }), /SST registration/);
    assert.throws(() => plan({ lines: [{ description: "X", rate: "10" }], discount: "11" }), /Discount/);
    assert.throws(() => plan({ mode: "charge" }), /Choose draft only/);
    assert.throws(() => plan({ send_to: "not-an-email" }), /Invalid email/);
    assert.throws(() => plan({ frequency: "daily" }), /Choose weekly/);
    store.saveService({ ...service, active: false }, service.id);
    assert.throws(() => plan(), /active service/);
    const other = store.saveClient({ name: "Other client" });
    const c = store.saveRecurringContract({
      client_id: other.id,
      title: "Other retainer",
      start_date: "2026-01-01",
      end_date: "2026-12-31",
    });
    assert.throws(
      () => plan({ lines: [{ description: "Support", rate: "100" }], contract_id: c.id }),
      /same client/,
    );
    assert.equal(client.terms, 14);
  } finally {
    store.db.close();
  }
});

test("editing keeps billed periods and the anchor; a billed plan cannot move to another client", () => {
  const { store, plan } = setup();
  try {
    const s = plan({ next_date: "2025-01-30" });
    store.runSchedule(s.id);
    assert.throws(() => store.updateSchedule(s.id, { next_date: "2025-01-30" }), /after the last generated period/);
    const other = store.saveClient({ name: "Someone else" });
    assert.throws(() => store.updateSchedule(s.id, { client_id: other.id }), /billed periods/);
    const edited = store.updateSchedule(s.id, {
      lines: [{ description: "Support retainer", quantity: 1, rate: "300.00" }],
      mode: "issue",
    });
    assert.equal(edited.anchor_day, 30);
    assert.equal(edited.next_date, "2025-02-28");
    assert.equal(edited.mode, "issue");
    assert.equal(edited.service_id, null);
    const audit = store.db.prepare("SELECT * FROM audit WHERE action='schedule.changed' ORDER BY id DESC").get();
    assert.equal(JSON.parse(audit.before_data).mode, "draft");
    assert.equal(JSON.parse(audit.after_data).mode, "issue");
  } finally {
    store.db.close();
  }
});

test("the job bills each due period once, catches up missed periods and never runs future ones early", async () => {
  const { store, ctx, plan } = setup();
  try {
    const start = addMonths(today(), -3);
    const s = plan({ next_date: start });
    const future = plan({ next_date: addDays(today(), 1) });
    const [a, b] = await Promise.all([runDuePlans(ctx), runDuePlans(ctx)]);
    assert.equal(a.generated + b.generated, 4, "four periods, each once, even with two overlapping runs");
    assert.equal(runs(store, s.id).length, 4);
    assert.ok(store.recurringPlan(s.id).next_date > today());
    assert.equal(runs(store, future.id).length, 0);
    assert.throws(() => store.runSchedule(future.id), /not due yet/);
    const again = await runDuePlans(ctx);
    assert.equal(again.generated, 0);
    assert.equal(runs(store, s.id).length, 4);
    await assert.rejects(processPeriod(ctx, s.id, { manual: true }), /not due yet/);
    const ended = plan({ next_date: addMonths(today(), -2), end_date: addMonths(today(), -1) });
    await runDuePlans(ctx);
    assert.equal(runs(store, ended.id).length, 2, "periods after the end date are not billed");
    assert.equal(store.recurringPlans().find((p) => p.id === ended.id).status, "Ended");
    await assert.rejects(processPeriod(ctx, ended.id, { manual: true }), /plan has ended/);
  } finally {
    store.db.close();
  }
});

test("auto-issue numbers recent periods; older catch-up periods stay drafts for review", async () => {
  const { store, ctx, plan } = setup();
  try {
    const s = plan({ mode: "issue", next_date: addMonths(today(), -2) });
    const r = await runDuePlans(ctx);
    assert.equal(r.generated, 3);
    assert.equal(r.issued, 1);
    const docs = runs(store, s.id).map((x) => store.document(x.invoice_id));
    assert.deepEqual(
      docs.map((d) => d.state),
      ["draft", "draft", "issued"],
    );
    assert.match(runs(store, s.id)[0].note, /kept as a draft/);
    assert.ok(docs[2].number);
    assert.equal(
      store.db.prepare("SELECT count(*) n FROM audit WHERE action='schedule.invoice.issued'").get().n,
      1,
    );
  } finally {
    store.db.close();
  }
});

test("an auto-issue failure is recorded on the plan and not retried", async () => {
  const { store, ctx, plan } = setup();
  try {
    store.saveSettings({ registration: "" });
    const s = plan({ mode: "issue" });
    const r = await runDuePlans(ctx);
    assert.deepEqual([r.generated, r.issued, r.failed], [1, 0, 1]);
    const [run] = runs(store, s.id);
    assert.equal(run.error_step, "issue");
    assert.match(run.error, /registration/);
    assert.equal(store.document(run.invoice_id).state, "draft", "the period stays billed once, as a draft");
    const p = store.recurringPlans().find((x) => x.id === s.id);
    assert.equal(p.status, "Needs attention");
    assert.match(p.last_error, /registration/);
    await runDuePlans(ctx);
    await runDuePlans(ctx);
    assert.equal(failures(store, s.id), 1);
    assert.equal(runs(store, s.id).length, 1);
    store.recurringClearError(s.id);
    assert.equal(store.recurringPlan(s.id).last_error, null);
  } finally {
    store.db.close();
  }
});

test("a generation failure holds the plan until the owner retries or edits it", async () => {
  const { store, ctx, service, client, plan } = setup();
  try {
    const s = plan({ mode: "issue" });
    store.saveService({ ...service, active: false }, service.id);
    let r = await runDuePlans(ctx);
    assert.equal(r.failed, 1);
    const held = store.recurringPlan(s.id);
    assert.equal(held.hold_period, today());
    assert.match(held.last_error, /Service is inactive: Maintenance/);
    store.saveService({ ...service, active: true }, service.id);
    r = await runDuePlans(ctx);
    assert.equal(r.generated, 0, "held plans are not retried automatically");
    assert.equal(failures(store, s.id), 1);
    store.recurringClearError(s.id, { retry: true });
    r = await runDuePlans(ctx);
    assert.deepEqual([r.generated, r.issued], [1, 1]);
    // Archived clients are refused too (archiving normally needs the plan paused first).
    const t = plan({ lines: [{ description: "Hosting", rate: "50.00" }] });
    store.db.prepare("UPDATE clients SET archived=1 WHERE id=?").run(client.id);
    r = await runDuePlans(ctx);
    assert.equal(r.failed, 1);
    assert.match(store.recurringPlan(t.id).last_error, /archived/);
    store.db.prepare("UPDATE clients SET archived=0 WHERE id=?").run(client.id);
    store.updateSchedule(t.id, { notes: "Edited" });
    assert.equal(store.recurringPlan(t.id).hold_period, null, "editing clears the hold");
    r = await runDuePlans(ctx);
    assert.equal(r.generated, 1);
  } finally {
    store.db.close();
  }
});

test("auto-send emails each period once with an optional link; the owner can retry a failure", async () => {
  const transport = fakeTransport();
  const { store, ctx, plan, client } = setup({ transport });
  try {
    const s = plan({ mode: "send", include_link: true, title: "Monthly care" });
    const r = await runDuePlans(ctx);
    assert.deepEqual([r.generated, r.issued, r.sent], [1, 1, 1]);
    assert.equal(transport.sent.length, 1);
    const m = transport.sent[0];
    assert.deepEqual(m.to, ["ap@client.example"]);
    assert.match(m.text, /Monthly care/);
    assert.match(m.text, /https:\/\/app\.example\/client\/[\w-]{43}/);
    assert.equal(m.attachments[0].content.subarray(0, 4).toString(), "%PDF");
    assert.equal(runs(store, s.id)[0].send_status, "sent");
    await runDuePlans(ctx);
    await assert.rejects(sendRun(ctx, s.id, runs(store, s.id)[0].period, { manual: true }), /already emailed/);
    assert.equal(transport.sent.length, 1);
    // Plan recipients replace the client's address.
    const other = plan({ mode: "send", send_to: "accounts@client.example, cfo@client.example" });
    await runDuePlans(ctx);
    assert.deepEqual(transport.sent[1].to, ["accounts@client.example", "cfo@client.example"]);
    assert.equal(runs(store, other.id)[0].send_status, "sent");
    // A rejected message is recorded and not retried by the job.
    transport.sendMail = async () => {
      throw new Error("550 rejected");
    };
    const bad = plan({ mode: "send", next_date: today(), lines: [{ description: "Hosting", rate: "10.00" }] });
    const fail = await runDuePlans(ctx);
    assert.equal(fail.failed, 1);
    const [run] = runs(store, bad.id);
    assert.equal(run.send_status, "failed");
    assert.equal(store.document(run.invoice_id).state, "issued");
    assert.equal(store.recurringPlan(bad.id).last_error_step, "send");
    await runDuePlans(ctx);
    assert.equal(failures(store, bad.id), 1);
    transport.sendMail = async (msg) => (transport.sent.push(msg), { messageId: "<retry@test>" });
    assert.deepEqual(await sendRun(ctx, bad.id, run.period, { manual: true }), { sent: true });
    assert.equal(runs(store, bad.id)[0].send_status, "sent");
    assert.equal(store.recurringPlan(bad.id).last_error, null);
    assert.equal(client.email, "ap@client.example");
  } finally {
    store.db.close();
  }
});

test("auto-send fails safely when email is not configured or the client has no address", async () => {
  const { store, ctx, plan, client } = setup({ mail: false });
  try {
    const s = plan({ mode: "send" });
    const r = await runDuePlans(ctx);
    assert.deepEqual([r.issued, r.sent, r.failed], [1, 0, 1]);
    assert.match(store.recurringPlan(s.id).last_error, /Email is not configured/);
    assert.equal(runs(store, s.id)[0].send_status, "failed");
    const noMail = store.saveClient({ name: "No email client" });
    const t = store.saveSchedule({
      client_id: noMail.id,
      lines: [{ description: "Support", rate: "100.00" }],
      next_date: today(),
      mode: "send",
    });
    const configured = { ...ctx, mailer: { status: () => ({ configured: true }), sendDocument: () => assert.fail("must not send") } };
    await runDuePlans(configured);
    assert.match(store.recurringPlan(t.id).last_error, /no email address/);
    assert.equal(client.email, "ap@client.example");
  } finally {
    store.db.close();
  }
});

test("two overlapping sends of the same period deliver one email", async () => {
  const transport = fakeTransport({ delay: 30 });
  const { store, ctx, plan } = setup({ transport });
  try {
    const s = plan({ mode: "issue" });
    await runDuePlans(ctx);
    const [run] = runs(store, s.id);
    const results = await Promise.allSettled([
      sendRun(ctx, s.id, run.period, { manual: true }),
      sendRun(ctx, s.id, run.period, { manual: true }),
    ]);
    assert.equal(transport.sent.length, 1);
    assert.equal(results.filter((x) => x.status === "fulfilled" && x.value.sent).length, 1);
    assert.match(results.find((x) => x.status === "rejected").reason.message, /being emailed/);
  } finally {
    store.db.close();
  }
});

test("old monthly schedules migrate to one-line plans and keep billing from their anchor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nwl-recurring-"));
  const path = join(dir, "v1.sqlite");
  let db = new DatabaseSync(path),
    s;
  try {
    db.exec(await readFile(new URL("../server/schema.sql", import.meta.url), "utf8"));
    db.prepare("INSERT INTO settings VALUES(1,?)").run(
      JSON.stringify({ company: "Legacy", invoicePrefix: "INV", quotePrefix: "QT", paymentTerms: "Pay soon." }),
    );
    db.exec(`INSERT INTO clients(id,name,email,created) VALUES('c','Legacy client','c@example.com','2026-01-01');
INSERT INTO services(id,name,rate,unit) VALUES('svc','Managed care',50000,'Month');
INSERT INTO documents(id,kind,number,client_id,state,issue_date,due_date,items,subtotal,total,created,updated) VALUES('d1','invoice','INV-2026-0001','c','issued','2026-01-31','2026-02-14','[]',50000,50000,'2026-01-31','2026-01-31');
INSERT INTO schedules(id,client_id,service_id,next_date,terms,created) VALUES('sch','c','svc','2026-02-28',14,'2026-01-01');
INSERT INTO schedule_runs VALUES('sch','2026-01-31','d1');`);
    db.close();
    db = null;
    s = openDatabase(path);
    const p = s.recurringPlan("sch");
    assert.equal(p.title, "Managed care");
    assert.deepEqual(p.lines, [
      { service_id: "svc", description: "Managed care", quantity: 1, rate: 50000, tax_rate: 0, unit: "Month" },
    ]);
    assert.deepEqual([p.freq_unit, p.freq_interval, p.mode, p.anchor_day], ["month", 1, "draft", 31]);
    assert.equal(s.db.prepare("SELECT send_status FROM schedule_runs").get().send_status, "none");
    const d = s.runSchedule("sch");
    assert.equal(d.items[0].description, "Managed care – Feb 2026");
    assert.equal(d.terms, "Pay soon.");
    assert.equal(s.recurringPlan("sch").next_date, "2026-03-31");
    assert.throws(() => s.deleteService("svc"), /schedule uses/);
    s.db.close();
    s = openDatabase(path);
    assert.equal(s.db.prepare("SELECT count(*) n FROM schema_migrations WHERE name='recurring-001-plans'").get().n, 1);
  } finally {
    db?.close();
    s?.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a service used on any plan line cannot be deleted", () => {
  const { store, plan, client } = setup();
  try {
    const extra = store.saveService({ name: "Backups", rate: "20.00" });
    const s = plan({ lines: [{ description: "Custom", rate: "10.00" }, { service_id: extra.id }] });
    assert.equal(s.service_id, extra.id);
    store.updateSchedule(s.id, { lines: [{ description: "Custom", rate: "10.00" }, { description: "Other", rate: "1.00" }, { service_id: extra.id }] });
    assert.throws(() => store.deleteService(extra.id), /schedule uses/);
    store.deleteSchedule(s.id);
    store.deleteService(extra.id);
    assert.ok(client.id);
  } finally {
    store.db.close();
  }
});

test("a restored copy turns automatic issuing, sending, late fees and packs off", async () => {
  const { default: recurring } = await import("../server/ext/recurring.mjs");
  const { store, plan } = setup();
  try {
    const s = plan({ mode: "send" });
    store.saveRecurringConfig({
      lateFees: { enabled: true, type: "fixed", amount: "10.00" },
      pack: { enabled: true, email: "acc@firm.example" },
    });
    recurring.onRestore(store.db);
    assert.equal(store.recurringPlan(s.id).mode, "draft");
    assert.equal(store.recurringConfig("lateFees").enabled, false);
    assert.equal(store.recurringConfig("pack").enabled, false);
    assert.equal(store.recurringConfig("pack").email, "acc@firm.example");
    const empty = new DatabaseSync(":memory:");
    recurring.onRestore(empty);
    empty.close();
  } finally {
    store.db.close();
  }
});
