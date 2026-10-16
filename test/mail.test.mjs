import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { Mailer, dueStage, reminderSettings } from "../server/mailer.mjs";
import { renderStatementPdf } from "../server/statement.mjs";
import { today, addDays } from "../server/domain.mjs";
const config = { from: "billing@example.com" };
function fakeTransport({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async sendMail(m) {
      if (fail) throw new Error("550 rejected");
      sent.push(m);
      return { messageId: "<" + sent.length + "@test>" };
    },
  };
}
function fixture() {
  const s = openDatabase(":memory:");
  s.saveSettings({
    registration: "TEST-1",
    address: "Test office",
    email: "test@example.com",
    bankName: "Test Bank",
    bankAccount: "1234567890",
    bankHolder: "Nawlogic",
  });
  const c = s.saveClient({ name: "Mail client", email: "client@example.com" });
  const invoice = (issue = today(), due = addDays(today(), 14), rate = "100.00") =>
    s.issue(
      s.saveDocument({
        kind: "invoice",
        client_id: c.id,
        issue_date: issue,
        due_date: due,
        items: [{ description: "Work", quantity: 1, rate }],
      }).id,
    );
  return { s, c, invoice };
}
test("reminder stages fire inside a short window and pick the latest stage", () => {
  const stages = reminderSettings({ remindersEnabled: true, reminderBeforeDays: 3, reminderAfterDays: "7,1,14" });
  assert.deepEqual(stages.after, [1, 7, 14]);
  const due = "2026-10-10";
  assert.equal(dueStage(due, "2026-10-06", stages), null);
  assert.equal(dueStage(due, "2026-10-07", stages).key, "before-3");
  assert.equal(dueStage(due, "2026-10-10", stages), null);
  assert.equal(dueStage(due, "2026-10-11", stages).key, "after-1");
  assert.equal(dueStage(due, "2026-10-18", stages).key, "after-7");
  assert.equal(dueStage(due, "2026-10-30", stages), null, "stale stages are skipped");
  assert.throws(() => reminderSettings({ reminderAfterDays: "0" }), /Number outside/);
});
test("issued documents are emailed with the PDF, optional rotated link and a log entry", async () => {
  const { s, invoice } = fixture();
  const transport = fakeTransport();
  const mailer = new Mailer(s, { config, transport });
  try {
    const d = invoice();
    const r = await mailer.sendDocument(
      d.id,
      { to: "client@example.com", cc: "ap@example.com", include_link: true, link_days: 7 },
      (t) => "https://app.example/client/" + t,
    );
    assert.equal(r.status, "sent");
    const m = transport.sent[0];
    assert.deepEqual(m.to, ["client@example.com"]);
    assert.deepEqual(m.cc, ["ap@example.com"]);
    assert.match(m.subject, new RegExp(d.number));
    assert.match(m.text, /https:\/\/app\.example\/client\/[\w-]{43}/);
    assert.match(m.text, /1234567890/);
    assert.equal(m.attachments[0].content.subarray(0, 4).toString(), "%PDF");
    assert.ok(s.document(d.id).token_hash, "link was created");
    assert.equal(s.emailLog()[0].status, "sent");
    const draft = s.saveDocument({
      kind: "invoice",
      client_id: d.client_id,
      issue_date: today(),
      due_date: today(),
      items: [{ description: "x", quantity: 1, rate: 1 }],
    });
    await assert.rejects(mailer.sendDocument(draft.id, { to: "a@example.com" }, String), /Issue the document/);
    await assert.rejects(mailer.sendDocument(d.id, { to: "not-an-email" }, String), /Invalid email/);
  } finally {
    s.db.close();
  }
});
test("delivery failures are logged and reported without leaking server errors", async () => {
  const { s, invoice } = fixture();
  try {
    const d = invoice();
    const mailer = new Mailer(s, { config, transport: fakeTransport({ fail: true }) });
    await assert.rejects(mailer.sendDocument(d.id, { to: "client@example.com" }, String), (e) => {
      assert.equal(e.status, 502);
      assert.doesNotMatch(e.message, /550/);
      return true;
    });
    assert.equal(s.emailLog()[0].status, "failed");
    const link = s.share(d.id);
    await assert.rejects(
      mailer.sendDocument(d.id, { to: "client@example.com", include_link: true }, String),
      /could not be sent/,
    );
    assert.equal(s.publicDocument(link.token).number, d.number, "the existing link keeps working");
    const off = new Mailer(s, { config: null });
    await assert.rejects(off.sendDocument(d.id, { to: "client@example.com" }, String), /not configured/);
  } finally {
    s.db.close();
  }
});
test("reminders are opt-in, sent once per stage, and a failed attempt is retried", async () => {
  const { s, invoice } = fixture();
  try {
    const d = invoice(addDays(today(), -10), addDays(today(), -1));
    const transport = fakeTransport();
    const mailer = new Mailer(s, { config, transport });
    assert.equal((await mailer.runReminders()).skipped, true);
    s.saveSettings({ remindersEnabled: true, reminderBeforeDays: 3, reminderAfterDays: "1,7" });
    assert.equal((await mailer.runReminders()).sent, 1);
    assert.equal((await mailer.runReminders()).sent, 0);
    assert.match(transport.sent[0].subject, /Overdue payment reminder/);
    assert.equal(transport.sent[0].to[0], "client@example.com");
    const other = invoice(addDays(today(), -10), addDays(today(), 3));
    const failing = new Mailer(s, { config, transport: fakeTransport({ fail: true }) });
    assert.equal((await failing.runReminders()).sent, 0);
    const retry = new Mailer(s, { config, transport });
    assert.equal((await retry.runReminders()).sent, 1);
    assert.match(transport.sent.at(-1).subject, new RegExp(other.number));
    s.recordPayment(d.id, {
      amount: "100.00",
      paid_date: today(),
      method: "Bank transfer",
      reference: "PAID-1",
    });
    assert.equal(
      s.documents().filter((x) => x.balance > 0 && x.id === d.id).length,
      0,
      "paid invoices drop out of reminders",
    );
  } finally {
    s.db.close();
  }
});
test("statement shows opening balance, movements, closing balance and aging", async () => {
  const { s, c, invoice } = fixture();
  try {
    const old = invoice(addDays(today(), -120), addDays(today(), -100), "300.00");
    const recent = invoice(addDays(today(), -5), addDays(today(), 9), "200.00");
    s.recordPayment(old.id, {
      amount: "100.00",
      paid_date: addDays(today(), -2),
      method: "Bank transfer",
      reference: "STMT-1",
    });
    s.adjustment(recent.id, { kind: "credit", amount: "50.00", reason: "Discount agreed", issue_date: today() });
    const st = s.statement(c.id, { from_date: addDays(today(), -30), to_date: today() });
    assert.equal(st.opening, 30000);
    assert.deepEqual(
      st.lines.map((l) => [l.type, l.debit, l.credit]),
      [
        ["Invoice", 20000, 0],
        ["Payment", 0, 10000],
        ["Credit note", 0, 5000],
      ],
    );
    assert.equal(st.closing, 35000);
    assert.equal(st.outstanding, 35000);
    assert.equal(st.aging.over90, 20000);
    assert.equal(st.aging.current, 15000);
    const pdf = await renderStatementPdf(st);
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    assert.throws(() => s.statement(c.id, { from_date: today(), to_date: addDays(today(), -1) }), /valid statement period/);
    // An ended statement ignores later invoices, payments and notes.
    const ended = s.statement(c.id, { from_date: addDays(today(), -30), to_date: addDays(today(), -3) });
    assert.equal(ended.closing, 50000);
    assert.equal(ended.outstanding, ended.closing);
    assert.deepEqual(ended.open.map((o) => o.balance).sort(), [20000, 30000]);
    assert.equal(ended.aging.over90, 30000);
  } finally {
    s.db.close();
  }
});
test("email and statement routes need an owner session and report mail status", async () => {
  const { s, c, invoice } = fixture();
  const { createOwner } = await import("../server/auth.mjs");
  const { createApp } = await import("../server/app.mjs");
  await createOwner(s, "owner@example.com", "Test-only-password-28");
  const transport = fakeTransport();
  const server = createApp({ store: s, appUrl: "http://localhost", mailConfig: config, mailTransport: transport });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const d = invoice();
    const anon = await fetch(base + `/api/documents/${d.id}/email`, {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(anon.status, 401);
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "Test-only-password-28" }),
    });
    const { csrf } = await login.json();
    const headers = {
      Origin: "http://localhost",
      Cookie: login.headers.get("set-cookie").split(";")[0],
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    };
    const sent = await fetch(base + `/api/documents/${d.id}/email`, {
      method: "POST",
      headers,
      body: JSON.stringify({ to: "client@example.com" }),
    });
    assert.equal(sent.status, 201);
    assert.equal(transport.sent.length, 1);
    const ws = await (await fetch(base + "/api/workspace", { headers })).json();
    assert.equal(ws.mail.configured, true);
    assert.equal(ws.emailLog[0].document_id, d.id);
    const pdf = await fetch(base + `/api/clients/${c.id}/statement/pdf`, { headers });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
  } finally {
    await new Promise((r) => server.close(r));
    s.db.close();
  }
});
