import test from "node:test";
import assert from "node:assert/strict";
import { fixture, issuedInvoice } from "./helpers.mjs";
import { today, addDays } from "../server/domain.mjs";
import { previousMonth } from "../server/recurring-dates.mjs";

function transport() {
  const sent = [];
  return {
    sent,
    async sendMail(m) {
      sent.push(m);
      return { messageId: "<api@test>" };
    },
  };
}

test("recurring routes need a session, CSRF token and the app origin", async () => {
  const f = await fixture();
  try {
    const month = previousMonth(today());
    assert.equal((await f.request(`/api/recurring/packs/${month}.zip`)).status, 401);
    const noCsrf = await f.request("/api/recurring/contracts", {
      method: "POST",
      headers: { Cookie: f.cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(noCsrf.status, 403);
    const evil = await fetch(f.base + "/api/recurring/settings", {
      method: "PUT",
      headers: { Origin: "https://evil.example", Cookie: f.cookie, "X-CSRF-Token": f.session.csrf, "Content-Type": "application/json" },
      body: JSON.stringify({ lateFees: { enabled: true } }),
    });
    assert.equal(evil.status, 403);
    assert.equal(f.store.recurringConfig("lateFees").enabled, false);
    assert.equal((await f.auth("/api/recurring/nothing")).status, 404);
  } finally {
    await f.close();
  }
});

test("plans are created, edited and run through the schedule routes", async () => {
  const transportFake = transport();
  const f = await fixture({ app: { mailConfig: { from: "billing@example.com" }, mailTransport: transportFake } });
  try {
    const client = await f.json("/api/clients", "POST", { name: "API client", email: "ap@api.example" });
    const service = await f.json("/api/services", "POST", { name: "Care", rate: "300.00", unit: "Month" });
    const bad = await f.auth("/api/schedules", "POST", { client_id: client.id, lines: [], next_date: today() });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /between 1 and 20/);
    const plan = await f.json("/api/schedules", "POST", {
      client_id: client.id,
      title: "Care plan",
      frequency: "weekly",
      next_date: today(),
      lines: [{ service_id: service.id, quantity: "1" }, { description: "Call-outs", quantity: "2", rate: "50.00" }],
      discount: "10.00",
    });
    assert.equal(plan.freq_unit, "week");
    const edited = await f.json(`/api/schedules/${plan.id}`, "PUT", { mode: "send", include_link: true });
    assert.equal(edited.mode, "send");
    const ws = await f.json("/api/workspace");
    const listed = ws.ext.recurring.plans.find((p) => p.id === plan.id);
    assert.equal(listed.amount, 30000 + 10000 - 1000);
    assert.equal(listed.frequency_label, "Weekly");
    assert.equal(listed.status, "Due");
    const run = await f.json(`/api/recurring/schedules/${plan.id}/run`, "POST", {});
    assert.deepEqual([run.generated, run.issued, run.sent], [true, true, true]);
    assert.equal(run.document.state, "issued");
    assert.equal(transportFake.sent.length, 1);
    const again = await f.auth(`/api/recurring/schedules/${plan.id}/run`, "POST", {});
    assert.equal(again.status, 400);
    assert.match((await again.json()).error, /not due yet/);
    const resend = await f.auth(`/api/recurring/runs/${run.document.id}/send`, "POST", {});
    assert.equal(resend.status, 409);
    assert.equal(transportFake.sent.length, 1);
    // The core draft route stays draft-only.
    const draftPlan = await f.json("/api/schedules", "POST", { client_id: client.id, service_id: service.id, next_date: today() });
    const draft = await f.json(`/api/schedules/${draftPlan.id}/run`, "POST", {});
    assert.equal(draft.state, "draft");
    assert.equal((await f.auth(`/api/schedules/${draftPlan.id}`, "DELETE")).status, 409);
    const dismissed = await f.json(`/api/recurring/schedules/${plan.id}/dismiss`, "POST", {});
    assert.equal(dismissed.last_error, null);
    const job = await f.json("/api/jobs/recurring:schedules/run", "POST", {});
    assert.equal(job.generated, 0);
    const backup = await f.json("/api/backup");
    assert.equal(backup.ext.recurring.plans.length, 2);
    assert.equal(backup.ext.recurring.runs.length, 2);
    assert.ok(Array.isArray(backup.ext.recurring.contracts));
  } finally {
    await f.close();
  }
});

test("contracts, settings, client opt-out and waivers have owner routes", async () => {
  const f = await fixture();
  try {
    const { client, invoice } = issuedInvoice(f.store, { rate: "1000.00" });
    const c = await f.json("/api/recurring/contracts", "POST", {
      client_id: client.id,
      title: "Retainer",
      value: "5000.00",
      start_date: today(),
      end_date: addDays(today(), 10),
      renewal: "auto",
      term_months: 6,
    });
    assert.equal(c.value, 500000);
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.recurring.contracts[0].display_status, "expiring");
    const renewed = await f.json(`/api/recurring/contracts/${c.id}/renew`, "POST", {});
    assert.equal(renewed.renewals, 1);
    const changed = await f.json(`/api/recurring/contracts/${c.id}`, "PUT", { title: "Retainer 2027" });
    assert.equal(changed.title, "Retainer 2027");
    assert.equal((await f.auth(`/api/recurring/contracts/${c.id}/cancel`, "POST", {})).status, 400);
    const cancelled = await f.json(`/api/recurring/contracts/${c.id}/cancel`, "POST", { reason: "Ended early" });
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await f.auth(`/api/recurring/contracts/${c.id}`, "DELETE")).status, 200);
    assert.equal((await f.auth("/api/recurring/contracts/missing", "PUT", {})).status, 404);

    const badFee = await f.auth("/api/recurring/settings", "PUT", { lateFees: { enabled: true, type: "fixed", amount: "0" } });
    assert.equal(badFee.status, 400);
    const cfg = await f.json("/api/recurring/settings", "PUT", {
      lateFees: { enabled: true, type: "fixed", amount: "25.00", after_days: 3 },
      pack: { enabled: true, email: "acc@firm.example", day: 2 },
    });
    assert.equal(cfg.lateFees.since, today());
    assert.equal(cfg.pack.day, 2);
    const s = await f.json("/api/workspace");
    assert.match(s.ext.recurring.lateFees.policy, /RM\s?25\.00/);

    const updated = await f.json(`/api/clients/${client.id}`, "PUT", { ...client, recurring_fields: "1", late_fee_exempt: "on" });
    assert.equal(updated.late_fee_exempt, 1);
    assert.deepEqual((await f.json("/api/workspace")).ext.recurring.exemptClients, [client.id]);

    const hold = await f.json(`/api/recurring/late-fees/${invoice.id}/hold`, "POST", { hold: true });
    assert.deepEqual(hold, { hold: true });
    assert.equal((await f.auth(`/api/recurring/late-fees/${invoice.id}/hold`, "POST", { hold: "yes" })).status, 400);
    const waive = await f.auth(`/api/recurring/late-fees/${invoice.id}/waive`, "POST", {});
    assert.equal(waive.status, 409);
    assert.match((await waive.json()).error, /no late fees/);
  } finally {
    await f.close();
  }
});

test("waiving through the route is idempotent with a request key", async () => {
  const f = await fixture();
  try {
    const { invoice } = issuedInvoice(f.store, { rate: "500.00" });
    f.store.db.prepare("UPDATE documents SET issue_date=?,due_date=? WHERE id=?").run(addDays(today(), -30), addDays(today(), -20), invoice.id);
    f.store.saveRecurringConfig({ lateFees: { enabled: true, type: "fixed", amount: "10.00", after_days: 7 } }, addDays(today(), -60));
    assert.equal(f.store.runLateFees().charged, 1);
    const key = { "Idempotency-Key": "waive-request-key-0001" };
    const one = await f.auth(`/api/recurring/late-fees/${invoice.id}/waive`, "POST", { reason: "Goodwill" }, key);
    const two = await f.auth(`/api/recurring/late-fees/${invoice.id}/waive`, "POST", { reason: "Goodwill" }, key);
    assert.equal(one.status, 201);
    assert.equal(two.status, 201);
    assert.equal((await one.json()).number, (await two.json()).number);
    assert.equal(f.store.document(invoice.id).credit, 1000);
  } finally {
    await f.close();
  }
});

test("pack downloads and sends are for ended months only", async () => {
  const f = await fixture();
  try {
    issuedInvoice(f.store);
    const month = previousMonth(today());
    const z = await f.auth(`/api/recurring/packs/${month}.zip`);
    assert.equal(z.status, 200);
    assert.equal(z.headers.get("content-type"), "application/zip");
    assert.match(z.headers.get("content-disposition"), new RegExp(`accountant-pack-${month}\\.zip`));
    assert.equal(Buffer.from(await z.arrayBuffer()).readUInt32LE(0), 0x04034b50);
    const pdf = await f.auth(`/api/recurring/packs/${month}.pdf`);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), "%PDF");
    const csv = await f.auth(`/api/recurring/packs/${month}/sst.csv`);
    assert.match(csv.headers.get("content-type"), /text\/csv/);
    assert.equal((await f.auth(`/api/recurring/packs/${today().slice(0, 7)}.zip`)).status, 400);
    assert.equal((await f.auth(`/api/recurring/packs/2026-13.zip`)).status, 400);
    const send = await f.auth(`/api/recurring/packs/${month}/send`, "POST", { to: "acc@firm.example" });
    assert.equal(send.status, 409, "email is not configured");
    const badTo = await f.auth(`/api/recurring/packs/${month}/send`, "POST", { to: "not-an-email" });
    assert.equal(badTo.status, 400);
  } finally {
    await f.close();
  }
});

test("client links show the late fee policy and nothing owner-only", async () => {
  const f = await fixture();
  try {
    f.store.saveRecurringConfig({ lateFees: { enabled: true, type: "percent", percent: "2", after_days: 14 } });
    const { invoice } = issuedInvoice(f.store);
    const r = await f.json(`/api/documents/${invoice.id}/share`, "POST", { days: 7 });
    const token = r.url.split("/client/")[1];
    const pub = await (await f.request(`/api/public/${token}`)).json();
    assert.deepEqual(Object.keys(pub.ext.recurring), ["lateFeePolicy"]);
    assert.match(pub.ext.recurring.lateFeePolicy, /2% of the unpaid balance/);
    const pdf = await f.request(`/api/public/${token}/pdf`);
    assert.equal(pdf.status, 200);
  } finally {
    await f.close();
  }
});
