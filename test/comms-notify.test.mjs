import test from "node:test";
import assert from "node:assert/strict";
import { requestContext } from "../server/context.mjs";
import { today, addDays } from "../server/domain.mjs";
import { classify } from "../server/comms-notify.mjs";
import { fixture, issuedInvoice } from "./helpers.mjs";
import { quoteRevision } from "../server/portal-sign.mjs";
function fakeTransport() {
  const sent = [];
  return {
    sent,
    async sendMail(m) {
      sent.push(m);
      return { messageId: m.messageId, response: "250 Ok" };
    },
  };
}
async function notifyFixture() {
  const transport = fakeTransport();
  const f = await fixture({ app: { mailConfig: { from: "billing@example.com" }, mailTransport: transport } });
  // Start the cursor now, as the running server would.
  await f.server.runJob("comms:notifications");
  return { ...f, transport };
}
const quote = (store) => {
  const c = store.saveClient({ name: "Quote client", email: "q@example.com" });
  const q = store.issue(
    store.saveDocument({ kind: "quote", client_id: c.id, issue_date: today(), due_date: addDays(today(), 14), items: [{ description: "Scope", quantity: 1, rate: "900.00" }] }).id,
  );
  return { q, token: store.share(q.id).token };
};
test("audit actions map to notification types; the owner's own receipts are skipped", () => {
  assert.equal(classify({ action: "quotation.accepted" }), "quote_accepted");
  assert.equal(classify({ action: "receipt.received", actor: "owner:a@b" }), null);
  assert.equal(classify({ action: "receipt.received", actor: "gateway:billplz" }), "payment_received");
  assert.equal(classify({ action: "payment.slip.uploaded" }), "payment_reference");
  assert.equal(classify({ action: "einvoice.document.rejected" }), "einvoice_rejected");
  assert.equal(classify({ action: "myinvois.invalid" }), "einvoice_rejected");
  assert.equal(classify({ action: "document.issued" }), null);
});
test("client events become one notification each, with a bell count and mark-as-read", async () => {
  const f = await notifyFixture();
  try {
    const { q, token } = quote(f.store);
    const accept = await f.request(`/api/public/${token}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Aminah", revision: quoteRevision(f.store.publicDocument(token)) }) });
    assert.equal(accept.status, 200);
    const { invoice } = issuedInvoice(f.store);
    const link = f.store.share(invoice.id).token;
    await f.request(`/api/public/${link}`); // first view: optional type, off by default
    await f.request(`/api/public/${link}/payment-reference`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reference: "MBB-123" }) });
    requestContext.run({ actor: "owner:owner@example.com" }, () =>
      f.store.recordPayment(invoice.id, { amount: "10.00", paid_date: today(), method: "Bank transfer", reference: "OWN-1" }),
    );
    assert.deepEqual((await f.server.runJob("comms:notifications")).created, 2);
    assert.equal((await f.server.runJob("comms:notifications")).created, 0, "nothing twice");
    // Even if the event cursor were reset, the unique audit key stops repeats.
    f.store.db.prepare("UPDATE event_cursors SET last_id=0 WHERE consumer='comms-notifications'").run();
    assert.equal((await f.server.runJob("comms:notifications")).created, 0);
    const list = await f.json("/api/comms/notifications");
    assert.equal(list.unread, 2);
    assert.deepEqual(list.items.map((n) => n.title).sort(), [`Payment reference submitted for ${invoice.number}`, `Quotation ${q.number} accepted`].sort());
    assert.equal(list.items.find((n) => n.title.startsWith("Quotation")).route, `document/${q.id}`);
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.comms.notifications.unread, 2);
    const marked = await f.json("/api/comms/notifications/read", "POST", { ids: [list.items[0].id] });
    assert.deepEqual([marked.marked, marked.unread], [1, 1]);
    assert.equal((await f.json("/api/comms/notifications/read", "POST", { all: true })).unread, 0);
    assert.equal(f.transport.sent.length, 0, "no email unless the owner chose it");
  } finally {
    await f.close();
  }
});
test("chosen email and WhatsApp alerts reach the owner once; online payments are not announced twice", async () => {
  const f = await notifyFixture();
  const calls = [];
  f.server.ctx.services.whatsapp.client.fetcher = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.N" + calls.length }] }));
  };
  try {
    f.store.setSecret("WHATSAPP_ACCESS_TOKEN", "t");
    f.store.setSecret("WHATSAPP_PHONE_NUMBER_ID", "1098765432");
    await f.json("/api/comms/settings", "PUT", {
      ownerEmail: "boss@example.com",
      ownerWhatsApp: "0129998888",
      notify: { online_payment: { email: true, whatsapp: true }, payment_received: { email: true } },
      whatsapp: { templates: { owner_alert: { name: "owner_alert", language: "en", params: "title,summary" } } },
    });
    const { invoice } = issuedInvoice(f.store);
    // A gateway payment writes a receipt and an online payment event in one go.
    requestContext.run({ actor: "gateway:billplz" }, () =>
      f.store.tx(() => {
        const r = f.store.receive({ client_id: invoice.client_id, amount: "100.00", paid_date: today(), method: "Other", account: "BILLPLZ", reference: "Billplz abc", allocations: [{ invoice_id: invoice.id, amount: "100.00" }] });
        f.store.audit("online_payment.paid", invoice.id, "Billplz abc: 10000 sen", { state: "pending" }, { state: "paid", receipt_id: r.id, applied: 10000 });
      }),
    );
    const run = await f.server.runJob("comms:notifications");
    assert.deepEqual([run.created, run.delivered], [1, 2]);
    await f.server.runJob("comms:notifications");
    assert.equal(f.transport.sent.length, 1);
    assert.deepEqual(f.transport.sent[0].to, ["boss@example.com"]);
    assert.match(f.transport.sent[0].subject, /^Online payment received: RM/);
    assert.match(f.transport.sent[0].text, new RegExp(`http://localhost/#/document/${invoice.id}`));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].to, "60129998888");
    assert.equal(calls[0].template.name, "owner_alert");
    const n = f.store.db.prepare("SELECT email_state,wa_state FROM comms_notifications").get();
    assert.deepEqual({ ...n }, { email_state: "sent", wa_state: "sent" });
  } finally {
    await f.close();
  }
});
test("a bounced notification email is shown in the app but never emailed again", async () => {
  const f = await notifyFixture();
  try {
    await f.json("/api/comms/settings", "PUT", { notify: { email_bounced: { email: true } } });
    f.store.db
      .prepare("INSERT INTO email_log(id,kind,recipients,subject,status,created) VALUES('n1','notification','owner@example.com','x','sent',?)")
      .run(new Date().toISOString());
    f.store.audit("email.bounced", null, "owner@example.com: hard bounce", null, { email_id: "n1", type: "hard", email: "owner@example.com" });
    await f.server.runJob("comms:notifications");
    await f.server.runJob("comms:notifications");
    assert.equal(f.transport.sent.length, 0);
    assert.equal((await f.json("/api/comms/notifications")).items[0].title, "Email to owner@example.com bounced");
  } finally {
    await f.close();
  }
});
test("a restored copy sends nothing on its own and the export holds no secrets", async () => {
  const { default: comms } = await import("../server/ext/comms.mjs");
  const f = await notifyFixture();
  try {
    f.store.setSecret("WHATSAPP_ACCESS_TOKEN", "very-secret-token");
    f.store.saveSettings({ remindersEnabled: true });
    await f.json("/api/comms/settings", "PUT", {
      autoReceipts: true,
      notify: { quote_accepted: { email: true } },
      whatsapp: { reminders: true },
      collection: { enabled: true },
    });
    f.store.db
      .prepare("INSERT INTO comms_notifications(id,audit_id,type,title,email_state,created) VALUES('n1',999999,'quote_accepted','x','pending',?)")
      .run(new Date().toISOString());
    const backup = await f.json("/api/backup");
    assert.ok(backup.ext.comms.settings && Array.isArray(backup.ext.comms.templates));
    assert.ok(!JSON.stringify(backup).includes("very-secret-token"));
    comms.onRestore(f.store.db);
    const s = f.store.commsSettings();
    assert.deepEqual([s.autoReceipts, s.whatsapp.reminders, s.collection.enabled, s.notify.quote_accepted.email], [false, false, false, false]);
    assert.equal(f.store.settings().remindersEnabled, false);
    assert.equal(f.store.db.prepare("SELECT email_state FROM comms_notifications WHERE id='n1'").get().email_state, "skipped");
  } finally {
    await f.close();
  }
});
