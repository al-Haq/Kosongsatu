import test from "node:test";
import assert from "node:assert/strict";
import { today, addDays } from "../server/domain.mjs";
import { gatewayConfiguration } from "../server/gateway.mjs";
import { Mailer } from "../server/mailer.mjs";
import { openDatabase } from "../server/db.mjs";
import { fixture, issuedInvoice, PNG_1PX } from "./helpers.mjs";

const raw = (f, path, bytes, headers = {}) =>
  f.auth(path, "POST", new Uint8Array(bytes), { "Content-Type": "application/octet-stream", ...headers });

test("owner routes need a session and the CSRF token", async () => {
  const f = await fixture();
  try {
    const { invoice } = issuedInvoice(f.store);
    const anon = await f.request(`/api/ext/documents/${invoice.id}/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "delivery_order" }),
    });
    assert.equal(anon.status, 401);
    const noCsrf = await f.request(`/api/ext/documents/${invoice.id}/convert`, {
      method: "POST",
      headers: { Cookie: f.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ to: "delivery_order" }),
    });
    assert.equal(noCsrf.status, 403);
    const upload = await f.request(`/api/ext/documents/logo`, { method: "POST", headers: { Cookie: f.cookie }, body: PNG_1PX });
    assert.equal(upload.status, 403);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM documents WHERE kind='delivery_order'").get().n, 0);
  } finally {
    await f.close();
  }
});

test("conversions and deposit invoices through the API are idempotent", async () => {
  const f = await fixture();
  try {
    const c = await f.json("/api/clients", "POST", { name: "Klien", email: "k@example.com", currency: "USD", language: "ms" });
    assert.deepEqual([c.currency, c.language], ["USD", "ms"]);
    const draft = await f.json("/api/documents", "POST", {
      kind: "proforma",
      client_id: c.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      currency: c.currency,
      fx_rate: "4.45",
      items: [{ description: "Work", quantity: 1, rate: "100.00", discount_percent: "10" }],
    });
    assert.deepEqual([draft.currency, draft.language, draft.total], ["USD", "ms", 9000]);
    const pf = await f.json(`/api/documents/${draft.id}/issue`, "POST", {});
    assert.match(pf.number, /^PF-/);
    const key = { "Idempotency-Key": "convert-proforma-0001" };
    const send = () =>
      f.auth(`/api/ext/documents/${pf.id}/convert`, "POST", { to: "invoice" }, key).then((r) => r.json());
    const a = await send(),
      b = await send();
    assert.equal(a.id, b.id);
    assert.equal(a.kind, "invoice");
    const again = await f.json(`/api/ext/documents/${pf.id}/convert`, "POST", { to: "invoice" });
    assert.equal(again.id, a.id, "a second conversion opens the same invoice");
    const bad = await f.auth(`/api/ext/documents/${pf.id}/convert`, "POST", { to: "quote" });
    assert.equal(bad.status, 400);
    const q = await f.json("/api/documents", "POST", {
      kind: "quote",
      client_id: c.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      currency: "USD",
      fx_rate: "4.45",
      deposit_type: "percent",
      deposit_value: "40",
      items: [{ description: "Build", quantity: 1, rate: "1000.00" }],
    });
    await f.json(`/api/documents/${q.id}/issue`, "POST", {});
    f.store.acceptOffline(q.id, { name: "A", evidence: "B" });
    const dep = await f.json(`/api/ext/documents/${q.id}/deposit-invoice`, "POST", {});
    assert.equal(dep.total, 40000);
    assert.equal((await f.json(`/api/ext/documents/${q.id}/deposit-invoice`, "POST", {})).id, dep.id);
  } finally {
    await f.close();
  }
});

test("instalment plans through the API, with validation", async () => {
  const f = await fixture();
  try {
    const { invoice } = issuedInvoice(f.store, { rate: "300.00" });
    const bad = await f.auth(`/api/ext/documents/${invoice.id}/instalments`, "PUT", {
      instalments: [{ due_date: addDays(today(), 5), amount: "100" }, { due_date: addDays(today(), 9), amount: "100" }],
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /add up/);
    const d = await f.json(`/api/ext/documents/${invoice.id}/instalments`, "PUT", {
      instalments: [
        { due_date: addDays(today(), 5), amount: "100" },
        { due_date: addDays(today(), 35), amount: "200" },
      ],
    });
    assert.equal(d.next_due_date, addDays(today(), 5));
    const ws = await f.json("/api/workspace");
    assert.equal(ws.documents.find((x) => x.id === invoice.id).instalments.length, 2);
    assert.equal(typeof ws.ext.documents.cjkFont, "boolean");
    const cleared = await f.json(`/api/ext/documents/${invoice.id}/instalments`, "DELETE");
    assert.equal(cleared.instalments.length, 0);
  } finally {
    await f.close();
  }
});

test("attachments: owner upload, client download only when visible and only with the link", async () => {
  const f = await fixture();
  try {
    const { invoice } = issuedInvoice(f.store);
    const other = issuedInvoice(f.store).invoice;
    const res = await raw(f, `/api/ext/documents/${invoice.id}/attachments?name=photo.png&visibility=client`, PNG_1PX);
    assert.equal(res.status, 201);
    const shared = await res.json();
    const hidden = await (await raw(f, `/api/ext/documents/${invoice.id}/attachments?name=internal.png`, PNG_1PX)).json();
    const foreign = await (await raw(f, `/api/ext/documents/${other.id}/attachments?name=x.png&visibility=client`, PNG_1PX)).json();
    assert.equal(hidden.visibility, "private");
    const html = await raw(f, `/api/ext/documents/${invoice.id}/attachments?name=x.html`, Buffer.from("<script>alert(1)</script>"));
    assert.equal(html.status, 415);
    const { url } = await f.json(`/api/documents/${invoice.id}/share`, "POST", { days: 7 });
    const token = url.split("/client/")[1];
    const get = (path) => f.request(path);
    const ok = await get(`/api/guest/documents/${token}/files/${shared.id}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.match(ok.headers.get("content-security-policy"), /sandbox/);
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG_1PX);
    assert.equal((await get(`/api/guest/documents/${token}/files/${hidden.id}`)).status, 404, "private files stay private");
    assert.equal((await get(`/api/guest/documents/${token}/files/${foreign.id}`)).status, 404, "another document's file");
    assert.equal((await get(`/api/guest/documents/${"x".repeat(43)}/files/${shared.id}`)).status, 404, "wrong token");
    // The client document JSON lists only the visible attachment.
    const pub = await (await get(`/api/public/${token}`)).json();
    assert.deepEqual(pub.ext.documents.attachments.map((a) => a.id), [shared.id]);
    // Visibility can change; revoking the link stops downloads.
    await f.json(`/api/ext/documents/attachments/${hidden.id}`, "PUT", { visibility: "client" });
    assert.equal((await get(`/api/guest/documents/${token}/files/${hidden.id}`)).status, 200);
    await f.json(`/api/documents/${invoice.id}/revoke`, "POST", {});
    assert.equal((await get(`/api/guest/documents/${token}/files/${shared.id}`)).status, 404);
    // At most 10 attachments per document.
    for (let n = 0; n < 8; n++) await raw(f, `/api/ext/documents/${invoice.id}/attachments?name=p${n}.png`, PNG_1PX);
    assert.equal((await raw(f, `/api/ext/documents/${invoice.id}/attachments?name=p11.png`, PNG_1PX)).status, 409);
    assert.equal((await f.auth(`/api/ext/documents/attachments/${shared.id}`, "DELETE")).status, 200);
    assert.equal(f.store.document(invoice.id).attachments.length, 9);
  } finally {
    await f.close();
  }
});

test("business logo: PNG/JPEG only, shown on client links through the token", async () => {
  const f = await fixture();
  try {
    const gif = await raw(f, "/api/ext/documents/logo?name=x.gif", Buffer.from("GIF89a" + "0".repeat(30)));
    assert.equal(gif.status, 415);
    const big = await raw(f, "/api/ext/documents/logo?name=x.png", Buffer.alloc(1024 * 1024 + 10));
    assert.equal(big.status, 413);
    const logo = await (await raw(f, "/api/ext/documents/logo?name=brand.png", PNG_1PX)).json();
    assert.equal(f.store.settings().logoFileId, logo.id);
    const { invoice } = issuedInvoice(f.store);
    const { url } = await f.json(`/api/documents/${invoice.id}/share`, "POST", {});
    const token = url.split("/client/")[1];
    const pub = await (await f.request(`/api/public/${token}`)).json();
    assert.equal(pub.ext.documents.logo, true);
    const img = await f.request(`/api/guest/documents/${token}/logo`);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.equal((await f.request(`/api/guest/documents/${"y".repeat(43)}/logo`)).status, 404);
    assert.equal((await f.auth("/api/ext/documents/logo", "DELETE")).status, 200);
    assert.equal(f.store.settings().logoFileId, null);
  } finally {
    await f.close();
  }
});

test("client links get currency, language and plans, never internal fields or owner data", async () => {
  const f = await fixture();
  try {
    await f.json("/api/settings", "PUT", {
      customFields: [
        { label: "Project", show: "pdf" },
        { label: "Margin note", show: "internal" },
      ],
    });
    const [project, internal] = f.store.settings().customFields;
    const c = f.store.saveClient({ name: "Klien", email: "k@example.com" });
    const d = await f.json("/api/documents", "POST", {
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      currency: "SGD",
      fx_rate: "3.4",
      language: "ms",
      ["cf_" + project.id]: "P-77",
      ["cf_" + internal.id]: "TOP-SECRET-MARGIN",
      items: [{ description: "Work", quantity: 1, rate: "100.00" }],
    });
    await f.json(`/api/documents/${d.id}/issue`, "POST", {});
    const { url } = await f.json(`/api/documents/${d.id}/share`, "POST", {});
    const body = await (await f.request("/api/public/" + url.split("/client/")[1])).text();
    const pub = JSON.parse(body);
    assert.deepEqual([pub.currency, pub.language], ["SGD", "ms"]);
    assert.deepEqual(pub.ext.documents.custom, [{ label: "Project", value: "P-77" }]);
    assert.ok(!body.includes("TOP-SECRET-MARGIN") && !body.includes("Margin note"));
    assert.equal(pub.meta, undefined);
    assert.equal(pub.fx_rate, undefined);
    assert.equal(pub.business.customFields, undefined);
    // Settings: invalid template values are refused.
    assert.equal((await f.auth("/api/settings", "PUT", { pdfAccent: "javascript:alert(1)" })).status, 400);
    const ok = await f.json("/api/settings", "PUT", { pdfLayout: "compact", pdfShowBank: false });
    assert.deepEqual([ok.pdfLayout, ok.pdfShowBank], ["compact", false]);
    // Item codes on services.
    const svc = await f.json("/api/services", "POST", { name: "Router", rate: "1", sku: "rt-9" });
    assert.equal(svc.sku, "RT-9");
    assert.equal((await f.auth("/api/services", "POST", { name: "Other", rate: "1", sku: "RT-9" })).status, 409);
    // Invoice CSV converts to MYR and lists the currency.
    const csv = await (await f.auth("/api/invoices.csv")).text();
    assert.match(csv, /"Currency"/);
    assert.match(csv, /"340\.00".*"SGD","3\.4","100\.00"/);
  } finally {
    await f.close();
  }
});

test("online payment is offered for MYR invoices only", async () => {
  const config = gatewayConfiguration({
    BILLPLZ_API_KEY: "k",
    BILLPLZ_COLLECTION_ID: "c",
    BILLPLZ_X_SIGNATURE_KEY: "s",
    BILLPLZ_SANDBOX: "true",
  });
  let calls = 0;
  const f = await fixture({ app: { gatewayConfig: config, gatewayFetch: async () => (calls++, { ok: false, json: async () => ({}) }) } });
  try {
    const c = f.store.saveClient({ name: "USD client", email: "u@example.com" });
    const d = f.store.issue(
      f.store.saveDocument({ kind: "invoice", client_id: c.id, issue_date: today(), due_date: addDays(today(), 14), currency: "USD", fx_rate: "4.4", items: [{ description: "W", quantity: 1, rate: "10" }] }).id,
    );
    const { token } = f.store.share(d.id);
    const pub = await (await f.request("/api/public/" + token)).json();
    assert.equal(pub.online_payment, false);
    const res = await f.request(`/api/public/${token}/checkout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(res.status, 409);
    assert.equal(calls, 0, "the provider is never called");
  } finally {
    await f.close();
  }
});

test("reminders follow instalment due dates, once per instalment and stage", async () => {
  const s = openDatabase(":memory:");
  try {
    s.saveSettings({ registration: "T-1", address: "Office", email: "t@example.com", remindersEnabled: true, reminderBeforeDays: 3, reminderAfterDays: "1" });
    const c = s.saveClient({ name: "Client", email: "client@example.com" });
    const d = s.issue(
      s.saveDocument({ kind: "invoice", client_id: c.id, issue_date: today(), due_date: addDays(today(), 60), items: [{ description: "W", quantity: 1, rate: "900.00" }] }).id,
    );
    s.setInstalments(d.id, [
      { due_date: addDays(today(), 3), amount: "300.00" },
      { due_date: addDays(today(), 33), amount: "600.00" },
    ]);
    const sent = [];
    const mailer = new Mailer(s, { config: { from: "b@example.com" }, transport: { sendMail: async (m) => (sent.push(m), { messageId: "x" }) } });
    assert.equal((await mailer.runReminders()).sent, 1, "3 days before the first instalment, not the invoice due date");
    // The template's {{amount_due}} is the next instalment, and {{due_date}} its date.
    assert.match(sent[0].text, /amount due is RM\s?300\.00/);
    assert.equal((await mailer.runReminders()).sent, 0, "at most once");
    assert.ok(s.db.prepare("SELECT 1 FROM email_log WHERE dedupe_key=?").get(`reminder:${d.id}:${addDays(today(), 3)}:before-3`));
    // Once the first instalment is paid, the next date applies.
    s.recordPayment(d.id, { amount: "300.00", paid_date: today(), method: "Cash", reference: "I-1" });
    assert.equal(s.document(d.id).next_due_date, addDays(today(), 33));
    assert.equal((await mailer.runReminders(addDays(today(), 30))).sent, 1);
    assert.match(sent[1].text, /amount due is RM\s?600\.00/);
  } finally {
    s.db.close();
  }
});
