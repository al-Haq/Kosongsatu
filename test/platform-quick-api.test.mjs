import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { openDatabase } from "../server/db.mjs";
import platform, { handleWhatsApp } from "../server/ext/platform.mjs";

async function withClients(options) {
  const f = await fixture(options);
  const abc = f.store.saveClient({ name: "ABC Sdn Bhd", email: "a@example.com", terms: 30 });
  f.store.saveClient({ name: "Meranti Digital" });
  f.store.saveClient({ name: "Meranti Holdings" });
  f.store.saveService({ name: "Managed maintenance", rate: "750.00", unit: "Month" });
  return { ...f, abc };
}

test("quick invoice: parse, then save as a draft only after confirmation", async () => {
  const f = await withClients();
  try {
    const before = f.store.db.prepare("SELECT count(*) n FROM documents").get().n;
    const d = await f.json("/api/platform/quick/parse", "POST", { text: "Invois ABC Sdn Bhd, maintenance Oktober, RM1,500" });
    assert.equal(d.source, "parser");
    assert.equal(d.client.id, f.abc.id);
    assert.equal(d.items[0].rate, "1500.00");
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM documents").get().n, before, "parsing saves nothing");
    const amb = await f.json("/api/platform/quick/parse", "POST", { text: "Quote Meranti, setup RM500" });
    assert.equal(amb.clientChoices.length, 2);
    const res = await f.auth("/api/platform/quick/draft", "POST", { ...d, client_id: d.client.id, text: "Invois ABC Sdn Bhd, maintenance Oktober, RM1,500" }, { "Idempotency-Key": "quick-key-0000000001" });
    assert.equal(res.status, 201);
    const doc = await res.json();
    assert.equal(doc.state, "draft", "never issued automatically");
    assert.equal(doc.number, null);
    assert.equal(doc.total, 150000);
    assert.equal(doc.due_date, d.due_date);
    const retry = await f.auth("/api/platform/quick/draft", "POST", { ...d, client_id: d.client.id, text: "Invois ABC Sdn Bhd, maintenance Oktober, RM1,500" }, { "Idempotency-Key": "quick-key-0000000001" });
    assert.equal((await retry.json()).id, doc.id, "a retried save does not duplicate");
    assert.ok(f.store.db.prepare("SELECT 1 FROM audit WHERE action='quick_invoice.drafted' AND entity_id=?").get(doc.id));
    // A new client typed in the box can be added with the draft.
    const fresh = await f.json("/api/platform/quick/draft", "POST", {
      kind: "quote",
      new_client_name: "Syarikat Baru Enterprise",
      issue_date: d.issue_date,
      due_date: d.due_date,
      items: [{ description: "Setup", quantity: "1", rate: "500.00", tax_rate: 0 }],
    });
    assert.equal(fresh.kind, "quote");
    assert.equal(fresh.client.name, "Syarikat Baru Enterprise");
    // The normal draft rules still apply.
    const bad = await f.auth("/api/platform/quick/draft", "POST", { kind: "invoice", client_id: f.abc.id, issue_date: d.issue_date, due_date: d.issue_date, items: [] });
    assert.equal(bad.status, 400);
    const kind = await f.auth("/api/platform/quick/draft", "POST", { ...d, kind: "receipt", client_id: f.abc.id });
    assert.equal(kind.status, 400);
    assert.equal((await f.request("/api/platform/quick/parse", { method: "POST" })).status, 401, "sign-in required");
    const noCsrf = await f.request("/api/platform/quick/parse", { method: "POST", headers: { Cookie: f.cookie, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(noCsrf.status, 403, "CSRF check applies");
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.platform.quick.ai, false);
    assert.equal(ws.ext.platform.quick.whatsapp, false);
  } finally {
    await f.close();
  }
});

test("quick invoice: the AI model is used only when configured and with consent", async () => {
  const calls = [];
  const aiFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"invoice","client":"ABC Sdn Bhd","lines":[{"description":"Usual retainer","quantity":1,"rate":2000}]}' } }] }));
  };
  const f = await withClients({ app: { assistantConfig: { base: "https://ai.example/v1", model: "m1", key: "secret-key" }, aiFetch } });
  try {
    const noConsent = await f.auth("/api/platform/quick/parse", "POST", { text: "bill ABC the usual retainer", ai: true });
    assert.equal(noConsent.status, 400);
    assert.equal(calls.length, 0, "nothing sent without consent");
    const d = await f.json("/api/platform/quick/parse", "POST", { text: "bill ABC the usual retainer", ai: true, consent: true });
    assert.equal(d.source, "ai");
    assert.equal(d.client.id, f.abc.id);
    assert.equal(d.items[0].rate, "2000.00");
    assert.equal(calls[0].url, "https://ai.example/v1/chat/completions");
    assert.ok(f.store.db.prepare("SELECT 1 FROM audit WHERE action='quick_invoice.ai_used' AND detail='https://ai.example'").get());
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.platform.quick.aiOrigin, "https://ai.example");
    assert.ok(!JSON.stringify(ws.ext.platform).includes("secret-key"));
  } finally {
    await f.close();
  }
});

test("quick invoice: the AI route refuses when no model is configured", async () => {
  const f = await withClients();
  try {
    const res = await f.auth("/api/platform/quick/parse", "POST", { text: "bill ABC the usual", ai: true, consent: true });
    assert.equal(res.status, 503);
  } finally {
    await f.close();
  }
});

test("WhatsApp: drafts from the owner's own number only, once per message", async () => {
  const store = openDatabase(":memory:");
  const abc = store.saveClient({ name: "ABC Sdn Bhd", terms: 30 });
  store.saveClient({ name: "Meranti Digital" });
  store.saveClient({ name: "Meranti Holdings" });
  let handler = null;
  const ctx = { store, appUrl: "https://billing.example.com", services: { whatsapp: { onInbound: (fn) => (handler = fn) } } };
  platform.init(ctx);
  assert.equal(typeof handler, "function", "registered with the WhatsApp service");
  const msg = { id: "wamid.1", from: "60123456789", text: "Invois ABC Sdn Bhd, maintenance Oktober, RM1,500" };
  assert.equal(await handler(msg), null, "no owner number configured: ignored");
  store.setSecret("PLATFORM_OWNER_WHATSAPP", "012-345 6789");
  assert.equal(await handler({ ...msg, from: "60111111111" }), null, "someone else: ignored");
  assert.equal(await handler({ ...msg, text: "hello, are you there?" }), null, "not a billing command: left for others");
  const reply = await handler(msg);
  assert.match(reply, /^Invois draf untuk ABC Sdn Bhd \(RM1500\.00\) disimpan\. .*https:\/\/billing\.example\.com\/#\/document\//);
  const doc = store.documents().find((d) => d.client_id === abc.id);
  assert.equal(doc.state, "draft");
  assert.ok(store.db.prepare("SELECT 1 FROM audit WHERE action='quick_invoice.drafted' AND actor='whatsapp:owner'").get());
  assert.equal(await handler(msg), null, "a redelivered message is not drafted twice");
  assert.equal(store.documents().length, 1);
  assert.match(await handler({ id: "wamid.2", from: "60123456789", text: { body: "Quote Meranti setup RM500" } }), /^Which client\? 1\) Meranti/);
  assert.match(await handler({ id: "wamid.3", from: "60123456789", text: "Invoice Nobody Enterprise, setup RM500" }), /No client called "Nobody Enterprise"/);
  assert.match(await handler({ id: "wamid.4", from: "60123456789", text: "Invoice ABC for the usual" }), /could not read/);
  assert.equal(store.documents().length, 1, "only clear requests become drafts");
  // Without a WhatsApp service the module stays quiet.
  const quiet = { store, appUrl: "x", services: {} };
  platform.init(quiet);
  assert.equal(await handleWhatsApp(quiet, null), null);
});

test("quick invoices from WhatsApp accept the owner number from either module", async () => {
  const { handleWhatsApp } = await import("../server/ext/platform.mjs");
  const { openDatabase } = await import("../server/db.mjs");
  const store = openDatabase(":memory:");
  store.saveSettings({ registration: "R", address: "A", email: "a@example.com" });
  store.saveClient({ name: "ABC Sdn Bhd" });
  const ctx = { store, appUrl: "http://localhost", services: {} };
  // Not the owner: ignored.
  assert.equal(await handleWhatsApp(ctx, { id: "m1", from: "60111111111", text: "Invois ABC Sdn Bhd, maintenance Oktober, RM1,500" }), null);
  // Marked as the owner by the messaging module: becomes a draft.
  const reply = await handleWhatsApp(ctx, { id: "m2", from: "60122222222", fromOwner: true, text: "Invois ABC Sdn Bhd, maintenance Oktober, RM1,500" });
  assert.match(reply, /#\/document\//);
  assert.equal(store.documents().filter((d) => d.state === "draft").length, 1);
  store.db.close();
});
