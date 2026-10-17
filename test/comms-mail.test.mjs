import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { Mailer, providerMessageId } from "../server/mailer.mjs";
import { parseMailEvents } from "../server/comms-mail-events.mjs";
import { today, addDays } from "../server/domain.mjs";
import { fixture, issuedInvoice, password } from "./helpers.mjs";
function fakeTransport({ fail = null } = {}) {
  const sent = [];
  return {
    sent,
    closed: 0,
    close() {
      this.closed++;
    },
    async sendMail(m) {
      if (fail) throw Object.assign(new Error("535 5.7.8 auth failed for secret-user"), { code: fail });
      sent.push(m);
      return { messageId: m.messageId, response: `250 Ok 0100018c-${sent.length}-000000` };
    },
  };
}
const business = { registration: "TEST-1", address: "Test office", email: "billing@example.com", bankName: "Test Bank", bankAccount: "1234567890", bankHolder: "Nawlogic" };
async function mailFixture(transport = fakeTransport(), settings = business) {
  const f = await fixture({ settings, app: { mailConfig: undefined, mailTransport: transport } });
  f.store.setSecret("SMTP_HOST", "smtp.example.com");
  f.store.setSecret("MAIL_FROM", "Nawlogic Billing <billing@example.com>");
  return { ...f, transport };
}
test("SMTP settings come from Integration keys and a change rebuilds the transport", () => {
  const s = openDatabase(":memory:");
  const made = [];
  const mailer = new Mailer(s, {
    createTransport: (config) => {
      const t = { config, closed: 0, close() { this.closed++; }, sendMail: async () => ({}) };
      made.push(t);
      return t;
    },
  });
  try {
    assert.equal(mailer.status().configured, false);
    s.setSecret("SMTP_HOST", "smtp.example.com");
    s.setSecret("SMTP_PORT", "465");
    s.setSecret("SMTP_USER", "billing@example.com");
    s.setSecret("SMTP_PASS", "first");
    s.setSecret("MAIL_FROM", "billing@example.com");
    const st = mailer.status();
    assert.deepEqual([st.configured, st.source, st.from], [true, "settings", "billing@example.com"]);
    assert.equal(made.length, 1);
    assert.equal(made[0].config.secure, true, "port 465 uses TLS");
    mailer.status();
    assert.equal(made.length, 1, "unchanged settings reuse the transport");
    s.setSecret("SMTP_PASS", "second");
    assert.equal(mailer.current().transport.config.auth.pass, "second");
    assert.equal(made.length, 2);
    assert.equal(made[0].closed, 1, "the old transport is closed");
    s.setSecret("SMTP_PORT", "99999");
    const bad = mailer.status();
    assert.equal(bad.configured, false);
    assert.match(bad.error, /SMTP_PORT/);
  } finally {
    s.db.close();
  }
});
test("provider message IDs are read from SMTP replies", () => {
  assert.equal(providerMessageId("250 Ok 0100018c7e4b-abcd-000000"), "0100018c7e4b-abcd-000000");
  assert.equal(providerMessageId("250 2.0.0 Ok: queued as 4F1A2B3C"), "4F1A2B3C");
  assert.equal(providerMessageId("250 Great success"), null);
});
test("owners enter SMTP keys in Settings, then send a test email without a restart", async () => {
  const transport = fakeTransport();
  const f = await fixture({ settings: business, app: { mailConfig: undefined, mailTransport: transport } });
  try {
    assert.equal((await f.json("/api/workspace")).mail.configured, false);
    for (const [name, value] of [["SMTP_HOST", "smtp.example.com"], ["MAIL_FROM", "billing@example.com"]])
      await f.json(`/api/secrets/${name}`, "PUT", { value, password });
    const ws = await f.json("/api/workspace");
    assert.equal(ws.mail.configured, true);
    assert.equal(ws.mail.source, "settings");
    assert.ok(ws.secrets.some((x) => x.name === "SMTP_PASS" && x.plugin === "comms" && x.secret));
    const r = await f.json("/api/comms/mail/test", "POST", {});
    assert.equal(r.status, "sent");
    assert.deepEqual(transport.sent[0].to, ["owner@example.com"]);
    assert.match(transport.sent[0].html, /<!doctype html>/);
    assert.equal(transport.sent[0].headers["X-Kosongsatu-Id"], r.id);
    assert.equal((await f.auth("/api/comms/mail/test", "POST", { to: "nope" })).status, 400);
  } finally {
    await f.close();
  }
  const failing = await mailFixture(fakeTransport({ fail: "EAUTH" }));
  try {
    const res = await failing.auth("/api/comms/mail/test", "POST", { to: "me@example.com" });
    assert.equal(res.status, 502);
    const { error } = await res.json();
    assert.match(error, /username or password/);
    assert.doesNotMatch(error, /535|secret-user/, "the raw server reply is not shown");
  } finally {
    await failing.close();
  }
});
test("edited templates are validated, previewed with a real document, used and reset", async () => {
  const f = await mailFixture();
  try {
    const { invoice, client } = issuedInvoice(f.store);
    const bad = await f.auth("/api/comms/templates/invoice/en", "PUT", { subject: "Hi {{nmber}}", body: "x" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Unknown placeholder \{\{nmber\}\}/);
    const preview = await f.json("/api/comms/templates/preview", "POST", {
      use: "invoice",
      language: "en",
      subject: "Bill {{number}}",
      body: "Hello {{contact_name}}, {{balance}} please.",
    });
    assert.equal(preview.subject, `Bill ${invoice.number}`);
    assert.match(preview.body, new RegExp(`Hello ${client.name}, RM`));
    assert.equal(preview.record, invoice.id);
    const problems = await f.json("/api/comms/templates/preview", "POST", { use: "invoice", language: "en", subject: "{{oops}}", body: "x" });
    assert.match(problems.problems[0], /Unknown placeholder/);
    await f.json("/api/comms/templates/invoice/en", "PUT", { subject: "Bill {{number}} / {{company}}", body: "Hi {{contact_name}}\n{{#link}}Link: {{link}}{{/link}}\nPay {{balance}}" });
    const compose = await f.json(`/api/comms/compose?document_id=${invoice.id}`);
    assert.equal(compose.subject, `Bill ${invoice.number} / NAWLOGIC SYSTEMS SOLUTION`);
    assert.match(compose.message, /\{\{#link\}\}Link: \{\{link\}\}\{\{\/link\}\}/, "the link placeholder waits for the real link");
    await f.json(`/api/documents/${invoice.id}/email`, "POST", { to: "client@example.com", include_link: true, message: compose.message, subject: compose.subject });
    const m = f.transport.sent.at(-1);
    assert.equal(m.subject, compose.subject);
    assert.match(m.text, /Link: http:\/\/localhost\/client\/[\w-]{43}/);
    await f.json("/api/comms/templates/invoice/en", "DELETE");
    await f.json(`/api/documents/${invoice.id}/email`, "POST", { to: "client@example.com" });
    assert.match(f.transport.sent.at(-1).subject, /^Invoice INV-/);
    // A Malay business default switches every message to Malay.
    await f.json("/api/comms/settings", "PUT", { language: "ms" });
    await f.json(`/api/documents/${invoice.id}/email`, "POST", { to: "client@example.com" });
    assert.match(f.transport.sent.at(-1).subject, /^Invois INV-/);
    assert.match(f.transport.sent.at(-1).text, /Salam sejahtera/);
    await f.json(`/api/clients/${client.id}/statement/email`, "POST", { to: "client@example.com" });
    assert.match(f.transport.sent.at(-1).subject, /^Penyata akaun/);
    const st = await f.json(`/api/comms/compose?client_id=${client.id}&language=en`);
    assert.match(st.message, /\{\{period_from\}\} to \{\{period_to\}\}/);
  } finally {
    await f.close();
  }
});
test("open tracking is opt-in, counts opens and never leaks the token", async () => {
  const f = await mailFixture();
  try {
    const { invoice } = issuedInvoice(f.store);
    await f.json(`/api/documents/${invoice.id}/email`, "POST", { to: "client@example.com" });
    assert.doesNotMatch(f.transport.sent[0].html, /comms\/open/, "off by default");
    await f.json("/api/comms/settings", "PUT", { trackOpens: true });
    await f.json(`/api/documents/${invoice.id}/email`, "POST", { to: "client@example.com" });
    const url = f.transport.sent[1].html.match(/http:\/\/localhost(\/api\/guest\/comms\/open\/[\w-]{32}\.gif)/)[1];
    assert.ok(!f.transport.sent[1].text.includes("comms/open"), "the plain text part has no pixel");
    const res = await f.request(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/gif");
    await f.request(url);
    const log = f.store.emailLog()[0];
    assert.equal(log.open_count, 2);
    assert.ok(log.opened_first && log.opened_last && log.tracked);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM audit WHERE action='email.opened'").get().n, 1);
    const unknown = await f.request("/api/guest/comms/open/" + "x".repeat(32) + ".gif");
    assert.equal(unknown.status, 200, "unknown tokens get the same image");
    assert.equal(f.store.emailLog()[0].open_count, 2);
  } finally {
    await f.close();
  }
});
test("bounce webhooks need the secret token and match generic, SES, Postmark, Mailgun and SendGrid reports", async () => {
  const f = await mailFixture();
  try {
    f.store.setSecret("MAIL_EVENTS_TOKEN", "events-secret-token-123");
    const { invoice, client } = issuedInvoice(f.store);
    const send = async () => {
      const r = await f.json(`/api/documents/${invoice.id}/email`, "POST", { to: "client@example.com" });
      return { id: r.id, mail: f.transport.sent.at(-1) };
    };
    const hook = (body, query = "?token=events-secret-token-123", headers = {}) =>
      f.request("/api/hooks/comms/mail-events" + query, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=UTF-8", Origin: "https://evil.example", ...headers },
        body: JSON.stringify(body),
      });
    assert.equal((await hook({ type: "bounce" }, "")).status, 401);
    assert.equal((await hook({ type: "bounce" }, "?token=wrong")).status, 401);
    const a = await send();
    assert.equal(a.mail.headers["X-PM-Metadata-kosongsatu-id"], a.id, "provider headers are added once the webhook is set up");
    const generic = await hook({ events: [{ type: "bounce", kosongsatu_id: a.id, email: "client@example.com", reason: "550 mailbox unknown", permanent: true }] });
    assert.deepEqual(await generic.json(), { ok: true, matched: 1, ignored: 0 });
    let row = f.store.emailLog().find((x) => x.id === a.id);
    assert.deepEqual([row.bounce_type, row.bounce_detail], ["hard", "550 mailbox unknown"]);
    // Amazon SES through SNS, matched by the provider ID from the SMTP reply.
    const b = await send();
    const providerId = f.store.db.prepare("SELECT provider_id FROM email_log WHERE id=?").get(b.id).provider_id;
    const ses = await hook({
      Type: "Notification",
      Message: JSON.stringify({
        notificationType: "Complaint",
        complaint: { complainedRecipients: [{ emailAddress: "client@example.com" }], complaintFeedbackType: "abuse" },
        mail: { messageId: providerId },
      }),
    }, "", { Authorization: "Bearer events-secret-token-123" });
    assert.equal((await ses.json()).matched, 1);
    assert.equal(f.store.emailLog().find((x) => x.id === b.id).bounce_type, "complaint");
    // Postmark (metadata header), with basic auth credentials in the URL.
    const c = await send();
    const pm = await hook(
      { RecordType: "Bounce", Type: "SoftBounce", Email: "client@example.com", MessageID: "pm-1", Description: "Mailbox full", Metadata: { "kosongsatu-id": c.id } },
      "",
      { Authorization: "Basic " + Buffer.from("postmark:events-secret-token-123").toString("base64") },
    );
    assert.equal((await pm.json()).matched, 1);
    assert.equal(f.store.emailLog().find((x) => x.id === c.id).bounce_type, "soft");
    // Mailgun (Message-ID) and SendGrid (smtp-id).
    const d = await send();
    await hook({ signature: {}, "event-data": { event: "failed", severity: "permanent", recipient: "client@example.com", message: { headers: { "message-id": d.mail.messageId.slice(1, -1) } }, "delivery-status": { description: "No such user" } } });
    assert.equal(f.store.emailLog().find((x) => x.id === d.id).bounce_type, "hard");
    const e = await send();
    await hook([{ email: "client@example.com", event: "dropped", reason: "Bounced Address", "smtp-id": e.mail.messageId, sg_message_id: "sg.1" }]);
    assert.equal(f.store.emailLog().find((x) => x.id === e.id).bounce_type, "hard");
    // The client is flagged; the owner can clear the warning.
    const ws = await f.json("/api/workspace");
    assert.ok(ws.ext.comms.addressIssues.some((x) => x.email === "client@example.com"));
    assert.equal((await f.json(`/api/comms/compose?document_id=${invoice.id}`)).bounced.length, 1);
    await f.json("/api/comms/addresses/clear", "POST", { email: "client@example.com" });
    assert.equal((await f.json("/api/workspace")).ext.comms.addressIssues.length, 0);
    // SNS subscription confirmations are kept for the owner to open.
    await hook({ Type: "SubscriptionConfirmation", TopicArn: "arn:aws:sns:ap-southeast-1:1:ses", SubscribeURL: "https://sns.ap-southeast-1.amazonaws.com/?Action=ConfirmSubscription&Token=x" });
    assert.match((await f.json("/api/workspace")).ext.comms.sns.url, /^https:\/\/sns\.ap-southeast-1\.amazonaws\.com/);
    assert.equal((await hook({ Type: "SubscriptionConfirmation", SubscribeURL: "https://evil.example/?x" })).status, 400);
  } finally {
    await f.close();
  }
});
test("SMTP rejections stay failed and later bounce reports do not touch them", async () => {
  const s = openDatabase(":memory:");
  s.saveSettings(business);
  try {
    const { invoice } = issuedInvoice(s);
    const mailer = new Mailer(s, { config: { from: "billing@example.com" }, transport: fakeTransport({ fail: "EENVELOPE" }) });
    await assert.rejects(mailer.sendDocument(invoice.id, { to: "client@example.com" }, String), /could not be sent/);
    const row = s.emailLog()[0];
    const { applyMailEvents } = await import("../server/comms-mail-events.mjs");
    assert.deepEqual(applyMailEvents(s, parseMailEvents({ type: "bounce", kosongsatu_id: row.id }).events), { matched: 0, ignored: 1 });
    assert.equal(s.emailLog()[0].status, "failed");
    assert.equal(s.emailLog()[0].bounce_type, null);
  } finally {
    s.db.close();
  }
});
test("receipts are emailed on request, and automatically once when the owner opts in", async () => {
  const f = await mailFixture();
  try {
    const { invoice } = issuedInvoice(f.store);
    const p = f.store.recordPayment(invoice.id, { amount: "40.00", paid_date: today(), method: "Bank transfer", reference: "TT-1" });
    await f.json(`/api/comms/receipts/${p.receipt_id}/email`, "POST", {});
    const m = f.transport.sent.at(-1);
    assert.match(m.subject, /^Receipt RC-/);
    assert.match(m.text, new RegExp(`Applied to: ${invoice.number}`));
    assert.equal(m.attachments[0].content.subarray(0, 4).toString(), "%PDF");
    await f.server.runJob("comms:notifications");
    const count = f.transport.sent.length;
    f.store.recordPayment(invoice.id, { amount: "10.00", paid_date: today(), method: "Bank transfer", reference: "TT-2" });
    await f.server.runJob("comms:notifications");
    assert.equal(f.transport.sent.length, count, "off by default");
    await f.json("/api/comms/settings", "PUT", { autoReceipts: true });
    f.store.recordPayment(invoice.id, { amount: "5.00", paid_date: today(), method: "Bank transfer", reference: "TT-3" });
    await f.server.runJob("comms:notifications");
    await f.server.runJob("comms:notifications");
    assert.equal(f.transport.sent.length, count + 1, "only the new receipt, once");
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM email_log WHERE kind='receipt' AND dedupe_key IS NOT NULL").get().n, 1);
  } finally {
    await f.close();
  }
});
test("reminders use the reminder templates and stay once per stage", async () => {
  const f = await mailFixture();
  try {
    const c = f.store.saveClient({ name: "Late client", email: "late@example.com" });
    const invoice = f.store.issue(
      f.store.saveDocument({ kind: "invoice", client_id: c.id, issue_date: addDays(today(), -10), due_date: addDays(today(), -1), items: [{ description: "Work", quantity: 1, rate: "100.00" }] }).id,
    );
    f.store.saveSettings({ remindersEnabled: true, reminderBeforeDays: 3, reminderAfterDays: "1,7" });
    await f.json("/api/comms/templates/reminder_after/en", "PUT", { subject: "Still due: {{number}} ({{days_overdue}} days)", body: "Pay {{balance}} please." });
    assert.equal((await f.json("/api/reminders/run", "POST", {})).sent, 1);
    assert.equal((await f.json("/api/reminders/run", "POST", {})).sent, 0);
    assert.equal(f.transport.sent.at(-1).subject, `Still due: ${invoice.number} (1 days)`);
  } finally {
    await f.close();
  }
});
