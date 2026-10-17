import test from "node:test";
import assert from "node:assert/strict";
import { today, addDays } from "../server/domain.mjs";
import { collectionTone } from "../server/comms-collect.mjs";
import { fixture, issuedInvoice } from "./helpers.mjs";
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
const AI = { base: "https://ai.example/v1", model: "test-model", key: "ai-key" };
function fakeAi(content) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  };
  return { calls, fetcher };
}
async function collectFixture({ ai = null } = {}) {
  const transport = fakeTransport();
  const f = await fixture({
    settings: { bankName: "Test Bank", bankAccount: "1234567890", bankHolder: "Nawlogic" },
    app: {
      mailConfig: { from: "billing@example.com" },
      mailTransport: transport,
      ...(ai ? { assistantConfig: AI, aiFetch: ai.fetcher } : {}),
    },
  });
  const c = f.store.saveClient({ name: "Slow Payer Sdn Bhd", email: "ap@slowpayer.example", contact: "Encik Rahman", phone: "" });
  const overdue = (days, rate = "500.00") =>
    f.store.issue(
      f.store.saveDocument({ kind: "invoice", client_id: c.id, issue_date: addDays(today(), -days - 14), due_date: addDays(today(), -days), items: [{ description: "Support", quantity: 1, rate }] }).id,
    );
  return { ...f, transport, client: c, overdue };
}
test("the tone escalates with days overdue and unanswered reminders", () => {
  assert.equal(collectionTone(3), "gentle");
  assert.equal(collectionTone(3, 2), "firm");
  assert.equal(collectionTone(20), "firm");
  assert.equal(collectionTone(20, 4), "final");
  assert.equal(collectionTone(45), "final");
});
test("follow-up drafts wait for approval; the edited text is sent once and logged", async () => {
  const f = await collectFixture();
  try {
    const d = f.overdue(20);
    const out = await f.json(`/api/comms/documents/${d.id}/follow-up`, "POST", {});
    assert.equal(out.generated_by, "template");
    assert.equal(f.transport.sent.length, 0, "nothing is sent before approval");
    const again = await f.auth(`/api/comms/documents/${d.id}/follow-up`, "POST", {});
    assert.equal(again.status, 409, "one pending draft per invoice");
    const p = (await f.json("/api/workspace")).automation.proposals.find((x) => x.id === out.proposal.id);
    assert.equal(p.kind, "collection_message");
    assert.equal(p.payload.tone, "firm");
    assert.match(p.summary, new RegExp(`Firm follow-up for ${d.number}`));
    assert.match(p.payload.message, /\{\{balance\}\}/, "facts stay as placeholders until sending");
    const bad = await f.auth(`/api/comms/collections/${p.id}/approve`, "POST", { message: "Pay {{amaun}} now" });
    assert.equal(bad.status, 400);
    assert.equal(f.transport.sent.length, 0);
    const edited = p.payload.message.replace("Could you please", "Kindly");
    const res = await f.json(`/api/comms/collections/${p.id}/approve`, "POST", { message: edited, subject: "Invoice {{number}}: {{days_overdue}} days overdue" });
    assert.equal(res.collection.state, "sent");
    assert.equal(f.transport.sent.length, 1);
    const m = f.transport.sent[0];
    assert.deepEqual(m.to, ["ap@slowpayer.example"]);
    assert.equal(m.subject, `Invoice ${d.number}: 20 days overdue`);
    assert.match(m.text, /^Dear Encik Rahman,/);
    assert.match(m.text, /Kindly arrange payment/);
    assert.match(m.text, /RM 500\.00|RM 500\.00/);
    assert.match(m.text, /1234567890/);
    assert.equal((await f.auth(`/api/comms/collections/${p.id}/approve`, "POST", {})).status, 409);
    await f.server.runJob("comms:notifications");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(f.transport.sent.length, 1, "approved once, sent once");
    const actions = f.store.db.prepare("SELECT action FROM audit WHERE action LIKE 'collection.%' ORDER BY id").all().map((a) => a.action);
    assert.deepEqual(actions, ["collection.edited", "collection.approved", "collection.sent"]);
  } finally {
    await f.close();
  }
});
test("approval from the AI review queue sends right after the approval", async () => {
  const f = await collectFixture();
  try {
    const d = f.overdue(5);
    const out = await f.json(`/api/comms/documents/${d.id}/follow-up`, "POST", {});
    const r = await f.json(`/api/automation/proposals/${out.proposal.id}/approve`, "POST", {});
    assert.equal(r.kind, "collection_message");
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(f.transport.sent.length, 1);
    assert.match(f.transport.sent[0].subject, /^Friendly reminder: invoice /);
    await f.server.runJob("comms:notifications");
    assert.equal(f.transport.sent.length, 1);
  } finally {
    await f.close();
  }
});
test("a follow-up for an invoice paid before sending is cancelled, not sent", async () => {
  const f = await collectFixture();
  try {
    const d = f.overdue(40);
    const out = await f.json(`/api/comms/documents/${d.id}/follow-up`, "POST", {});
    const p = f.store.db.prepare("SELECT payload FROM automation_proposals WHERE id=?").get(out.proposal.id);
    assert.equal(JSON.parse(p.payload).tone, "final");
    // Approve directly in the store (as an MCP-free owner would), then pay before the job runs.
    f.store._commsSend = null;
    const r = f.store.reviewProposal(out.proposal.id, true);
    f.store.recordPayment(d.id, { amount: "500.00", paid_date: today(), method: "Bank transfer", reference: "LATE-1" });
    await f.server.runJob("comms:notifications");
    assert.equal(f.transport.sent.length, 0);
    assert.equal(f.store.db.prepare("SELECT state FROM comms_collections WHERE id=?").get(r.id).state, "cancelled");
  } finally {
    await f.close();
  }
});
test("the AI model only sees tone, language and counts, and a bad answer falls back to the template", async () => {
  const good = fakeAi(JSON.stringify({ subject: "Gentle reminder for {{number}}", message: "We hope all is well. Invoice {{number}} is now {{days_overdue}} days overdue with {{balance}} outstanding. We would be grateful for your payment soon." }));
  const f = await collectFixture({ ai: good });
  try {
    await f.json("/api/comms/settings", "PUT", { collection: { useAi: true } });
    const d = f.overdue(4);
    const out = await f.json(`/api/comms/documents/${d.id}/follow-up`, "POST", {});
    assert.equal(out.generated_by, "ai");
    const sentToAi = JSON.stringify(good.calls[0].body);
    for (const secret of [d.number, "Slow Payer", "Rahman", "slowpayer", "1234567890", "500.00", "NAWLOGIC"])
      assert.ok(!sentToAi.includes(secret), `${secret} is not sent to the model`);
    assert.equal(good.calls[0].url, "https://ai.example/v1/chat/completions");
    const payload = JSON.parse(f.store.db.prepare("SELECT payload FROM automation_proposals WHERE id=?").get(out.proposal.id).payload);
    assert.match(payload.message, /^Dear \{\{contact_name\}\},\n\nWe hope all is well/);
    assert.match(payload.message, /\{\{company\}\}$/);
  } finally {
    await f.close();
  }
  const bad = fakeAi("Sure! Please pay invoice INV-1 at https://evil.example now.");
  const g = await collectFixture({ ai: bad });
  try {
    await g.json("/api/comms/settings", "PUT", { collection: { useAi: true } });
    const d = g.overdue(4);
    assert.equal((await g.json(`/api/comms/documents/${d.id}/follow-up`, "POST", {})).generated_by, "template");
  } finally {
    await g.close();
  }
});
test("the agent job prepares drafts only when switched on and never twice per stage", async () => {
  const f = await collectFixture();
  try {
    f.overdue(10);
    f.overdue(1);
    const { invoice: notDue } = issuedInvoice(f.store, { client: f.client });
    assert.equal((await f.server.runJob("comms:collections")).skipped, true);
    await f.json("/api/comms/settings", "PUT", { collection: { enabled: true, minDays: 3 } });
    assert.equal((await f.server.runJob("comms:collections")).prepared, 1, "1-day overdue and not-due invoices wait");
    assert.equal((await f.server.runJob("comms:collections")).prepared, 0);
    const pending = (await f.json("/api/workspace")).automation.proposals.filter((p) => p.kind === "collection_message");
    assert.equal(pending.length, 1);
    assert.notEqual(pending[0].payload.invoice_id, notDue.id);
    assert.equal(f.transport.sent.length, 0);
  } finally {
    await f.close();
  }
});
test("client links get WhatsApp previews without marking the document viewed", async () => {
  const f = await collectFixture();
  try {
    f.store.saveSettings({ company: 'Nawlogic "Systems" <Solution>' });
    const { invoice } = issuedInvoice(f.store, { client: f.client });
    const { token } = f.store.share(invoice.id);
    const html = await (await f.request(`/client/${token}`)).text();
    assert.match(html, new RegExp(`<meta property="og:title" content="Invoice ${invoice.number} from Nawlogic &quot;Systems&quot; &lt;Solution&gt;" />`));
    assert.match(html, /<meta property="og:description" content="Amount due RM.100\.00 · Due [^"]+ · View and pay online" \/>/);
    assert.match(html, new RegExp(`<meta property="og:url" content="http://localhost/client/${token}" />`));
    assert.match(html, /<meta property="og:image" content="http:\/\/localhost\/assets\/link-preview\.png" \/>/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
    assert.equal(f.store.document(invoice.id).viewed_at, null);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM audit WHERE action='document.viewed'").get().n, 0);
    assert.equal((await f.request("/assets/link-preview.png")).status, 200);
    f.store.revoke(invoice.id);
    const gone = await (await f.request(`/client/${token}`)).text();
    assert.doesNotMatch(gone, new RegExp(invoice.number));
    assert.doesNotMatch(gone, /og:url|Amount due/);
    assert.match(gone, /og:title" content="Document from Nawlogic/);
    const junk = await (await f.request("/client/not-a-token")).text();
    assert.doesNotMatch(junk, /og:url/);
    const plain = await (await f.request("/")).text();
    assert.doesNotMatch(plain, /og:title/, "only client links get preview tags");
  } finally {
    await f.close();
  }
});
