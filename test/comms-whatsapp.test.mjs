import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, signBody, validSignature, templateComponents } from "../server/comms-whatsapp.mjs";
import { today, addDays } from "../server/domain.mjs";
import { fixture, issuedInvoice } from "./helpers.mjs";
const APP_SECRET = "meta-app-secret-for-tests";
function fakeMeta({ fail = false } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (fail)
      return new Response(JSON.stringify({ error: { message: "(#132001) Template name does not exist in the translation", code: 132001, error_data: { details: "template name (invoice_link) does not exist in ms" } } }), { status: 400 });
    return new Response(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ input: "x", wa_id: "x" }], messages: [{ id: "wamid.TEST" + calls.length }] }), { status: 200 });
  };
  return { calls, fetcher };
}
async function waFixture(meta = fakeMeta()) {
  const f = await fixture({ settings: { bankName: "Test Bank", bankAccount: "1234567890", bankHolder: "Nawlogic" } });
  for (const [k, v] of Object.entries({
    WHATSAPP_ACCESS_TOKEN: "EAAG-test-token",
    WHATSAPP_PHONE_NUMBER_ID: "1098765432",
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: "verify-me-please",
  }))
    f.store.setSecret(k, v);
  const service = f.server.ctx.services.whatsapp;
  service.client.fetcher = meta.fetcher;
  return { ...f, meta, service };
}
const hookPost = (f, payload, secret = APP_SECRET) => {
  const raw = JSON.stringify(payload);
  return f.request("/api/hooks/comms/whatsapp", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { "X-Hub-Signature-256": signBody(raw, secret) } : {}) },
    body: raw,
  });
};
const change = (value) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "60300000000", phone_number_id: "1098765432" }, ...value } }] }],
});
test("phone numbers are normalised to the international WhatsApp format", () => {
  assert.equal(normalizePhone("012-345 6789"), "60123456789");
  assert.equal(normalizePhone("+60 12-345 6789"), "60123456789");
  assert.equal(normalizePhone("60123456789"), "60123456789");
  assert.equal(normalizePhone("0065 9123 4567"), "6591234567");
  assert.equal(normalizePhone("123456789"), "60123456789");
  assert.equal(normalizePhone("12"), null);
  assert.equal(normalizePhone(""), null);
});
test("webhook signatures are HMAC-SHA256 of the raw body and compared safely", () => {
  const raw = Buffer.from('{"a":"é"}');
  const sig = signBody(raw, "s3cret");
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  assert.equal(validSignature(raw, sig, "s3cret"), true);
  assert.equal(validSignature(raw, sig.toUpperCase().replace("SHA256", "sha256"), "s3cret"), true);
  assert.equal(validSignature(Buffer.from('{"a":"\\u00e9"}'), sig, "s3cret"), false, "re-serialised JSON fails");
  assert.equal(validSignature(raw, sig, "other"), false);
  assert.equal(validSignature(raw, "sha256=abc", "s3cret"), false);
  assert.equal(validSignature(raw, undefined, "s3cret"), false);
  assert.equal(validSignature(raw, sig, null), false);
});
test("template parameters follow the owner's mapping (positional, named and URL button)", () => {
  const vars = { contact_name: "Ali", number: "INV-1", balance: "RM 1.00", bank_details: "Bank\n123", link_token: "tok" };
  assert.deepEqual(templateComponents({ params: ["contact_name", "bank_details", "paid"], button: "link_token" }, vars), [
    { type: "body", parameters: [{ type: "text", text: "Ali" }, { type: "text", text: "Bank, 123" }, { type: "text", text: "-" }] },
    { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "tok" }] },
  ]);
  assert.deepEqual(templateComponents({ params: ["customer=contact_name", "invoice_no=number"], button: "" }, vars), [
    { type: "body", parameters: [{ type: "text", parameter_name: "customer", text: "Ali" }, { type: "text", parameter_name: "invoice_no", text: "INV-1" }] },
  ]);
});
test("the webhook verification answers Meta's challenge only with the verify token", async () => {
  const f = await waFixture();
  try {
    const base = "/api/hooks/comms/whatsapp?hub.mode=subscribe&hub.challenge=1158201444";
    assert.equal((await f.request(base + "&hub.verify_token=wrong")).status, 403);
    assert.equal((await f.request(base)).status, 403);
    const ok = await f.request(base + "&hub.verify_token=verify-me-please");
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "1158201444");
    assert.match(ok.headers.get("content-type"), /text\/plain/);
    const odd = await f.request("/api/hooks/comms/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me-please&hub.challenge=%3Cscript%3E");
    assert.equal(odd.status, 400);
  } finally {
    await f.close();
  }
});
test("documents go out as approved templates with a new link, and statuses update the log", async () => {
  const f = await waFixture();
  try {
    const c = f.store.saveClient({ name: "WA client", email: "wa@example.com", phone: "012-345 6789", contact: "Encik Ali" });
    const { invoice } = issuedInvoice(f.store, { client: c });
    const first = await f.auth(`/api/comms/documents/${invoice.id}/whatsapp`, "POST", {});
    assert.equal(first.status, 409, "needs a template mapping first");
    const bad = await f.auth("/api/comms/settings", "PUT", { whatsapp: { templates: { invoice_link: { name: "Invoice Link", language: "en" } } } });
    assert.equal(bad.status, 400);
    const badVar = await f.auth("/api/comms/settings", "PUT", { whatsapp: { templates: { invoice_link: { name: "invoice_link", language: "en", params: "contact_name,secret" } } } });
    assert.match((await badVar.json()).error, /Unknown value "secret"/);
    await f.json("/api/comms/settings", "PUT", {
      whatsapp: { templates: { invoice_link: { name: "invoice_link", language: "en", params: "contact_name,number,balance,due_date", button: "link_token" } } },
    });
    const sent = await f.json(`/api/comms/documents/${invoice.id}/whatsapp`, "POST", {});
    assert.equal(sent.status, "sent");
    const call = f.meta.calls[0];
    assert.equal(call.url, "https://graph.facebook.com/v25.0/1098765432/messages");
    assert.equal(call.init.headers.Authorization, "Bearer EAAG-test-token");
    assert.equal(call.init.redirect, "error");
    assert.equal(call.body.to, "60123456789");
    assert.equal(call.body.type, "template");
    assert.equal(call.body.template.name, "invoice_link");
    assert.deepEqual(call.body.template.language, { code: "en" });
    assert.deepEqual(call.body.template.components[0].parameters.map((p) => p.text), ["Encik Ali", invoice.number, "RM 100.00", call.body.template.components[0].parameters[3].text]);
    const token = call.body.template.components[1].parameters[0].text;
    assert.match(token, /^[\w-]{43}$/);
    assert.equal(f.store.publicDocument(token).id, invoice.id, "the token in the button is the live client link");
    // Delivery statuses arrive signed; out-of-order and duplicate statuses never go backwards.
    const status = (s) => change({ statuses: [{ id: "wamid.TEST1", status: s, timestamp: "1760000000", recipient_id: "60123456789" }] });
    assert.equal((await hookPost(f, status("delivered"), null)).status, 401);
    assert.equal((await hookPost(f, status("delivered"), "wrong-secret")).status, 401);
    assert.equal((await hookPost(f, status("delivered"))).status, 200);
    await hookPost(f, status("sent"));
    let row = f.store.db.prepare("SELECT * FROM comms_whatsapp WHERE wa_id='wamid.TEST1'").get();
    assert.equal(row.status, "delivered");
    await hookPost(f, status("read"));
    await hookPost(f, change({ statuses: [{ id: "wamid.TEST1", status: "failed", errors: [{ code: 131026, title: "Message undeliverable" }] }] }));
    row = f.store.db.prepare("SELECT * FROM comms_whatsapp WHERE wa_id='wamid.TEST1'").get();
    assert.equal(row.status, "read", "a late failure does not undo a read receipt");
    // Another number on the same Meta app is ignored.
    const other = change({ statuses: [{ id: "wamid.TEST1", status: "failed" }] });
    other.entry[0].changes[0].value.metadata.phone_number_id = "999999";
    await hookPost(f, other);
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.comms.whatsapp.configured, true);
    assert.equal(ws.ext.comms.whatsapp.log[0].status, "read");
    assert.ok(!JSON.stringify(ws.ext.comms).includes("EAAG-test-token"), "the access token never reaches the browser");
  } finally {
    await f.close();
  }
});
test("WhatsApp refusals are logged as failed with Meta's reason and the old link is kept", async () => {
  const f = await waFixture(fakeMeta({ fail: true }));
  try {
    const c = f.store.saveClient({ name: "WA client", phone: "0123456789", email: "" });
    const { invoice } = issuedInvoice(f.store, { client: c });
    const link = f.store.share(invoice.id);
    await f.json("/api/comms/settings", "PUT", { whatsapp: { templates: { invoice_link: { name: "invoice_link", language: "ms", params: "number", button: "link_token" } } } });
    const res = await f.auth(`/api/comms/documents/${invoice.id}/whatsapp`, "POST", {});
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /WhatsApp error 132001: template name/);
    assert.equal(f.store.db.prepare("SELECT status FROM comms_whatsapp").get().status, "failed");
    assert.equal(f.store.publicDocument(link.token).id, invoice.id, "the previous client link still works");
  } finally {
    await f.close();
  }
});
test("inbound owner messages reach onInbound handlers once, and handlers can reply", async () => {
  const f = await waFixture();
  try {
    await f.json("/api/comms/settings", "PUT", { ownerWhatsApp: "012-999 8888" });
    const seen = [],
      clientSeen = [];
    f.service.onInbound(async (m) => {
      seen.push(m);
      return "Got it";
    });
    const off = f.service.onInbound((m) => clientSeen.push(m), { clients: true });
    const message = (from, id, body) => change({ contacts: [{ profile: { name: "Owner" }, wa_id: from }], messages: [{ from, id, timestamp: "1760000000", type: "text", text: { body } }] });
    await hookPost(f, message("60129998888", "wamid.IN1", "invois ABC RM1500"));
    await hookPost(f, message("60129998888", "wamid.IN1", "invois ABC RM1500"));
    await hookPost(f, message("60111111111", "wamid.IN2", "hello"));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(seen.length, 1, "owner handlers see owner messages once");
    assert.deepEqual([seen[0].fromOwner, seen[0].text, seen[0].name], [true, "invois ABC RM1500", "Owner"]);
    assert.equal(clientSeen.length, 2, "handlers that ask for clients see every message");
    // Other modules' handlers (e.g. quick invoices) may reply as well.
    const reply = f.meta.calls.find((c) => c.body.type === "text" && c.body.text.body === "Got it");
    assert.deepEqual([reply.body.to, reply.body.text.body], ["60129998888", "Got it"]);
    assert.equal(f.service.windowOpen("60111111111"), true);
    off();
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM comms_whatsapp WHERE direction='in'").get().n, 2);
  } finally {
    await f.close();
  }
});
test("WhatsApp reminders are opt-in and go out once per stage", async () => {
  const f = await waFixture();
  try {
    const c = f.store.saveClient({ name: "Late WA", phone: "0123456789", email: "" });
    const d = f.store.issue(
      f.store.saveDocument({ kind: "invoice", client_id: c.id, issue_date: addDays(today(), -10), due_date: addDays(today(), -1), items: [{ description: "Work", quantity: 1, rate: "50.00" }] }).id,
    );
    f.store.saveSettings({ reminderBeforeDays: 3, reminderAfterDays: "1,7" });
    assert.equal((await f.server.runJob("comms:whatsapp-reminders")).skipped, true);
    await f.json("/api/comms/settings", "PUT", {
      whatsapp: { reminders: true, templates: { payment_reminder: { name: "payment_reminder", language: "en", params: "number,balance,days_overdue" } } },
    });
    assert.equal((await f.server.runJob("comms:whatsapp-reminders")).sent, 1);
    assert.equal((await f.server.runJob("comms:whatsapp-reminders")).sent, 0);
    assert.deepEqual(f.meta.calls[0].body.template.components[0].parameters.map((p) => p.text), [d.number, "RM 50.00", "1"]);
    assert.equal(f.store.db.prepare("SELECT dedupe_key FROM comms_whatsapp").get().dedupe_key, `wa-reminder:${d.id}:after-1`);
  } finally {
    await f.close();
  }
});
