import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { fixture, issuedInvoice, password } from "./helpers.mjs";
import { today } from "../server/domain.mjs";
import platform from "../server/ext/platform.mjs";
import https from "node:https";
import { isPublicAddress, checkUrl, resolveDestination, verifySignature, signatureHeader, eventsFromAudit, httpsSend, RETRY_WINDOW } from "../server/platform-webhooks.mjs";
import { quoteRevision } from "../server/portal-sign.mjs";

// Self-signed test certificate for hooks.example.com (valid until 2126). Test use only.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgmVf+5a5/MjYHIg3Y
2zNN/AXomHb/XpIZR+7SE2H4ACWhRANCAATZV9MivV1oHdakhLCBsSzt5mZnSb5Q
gYUN4gh7LYdmB7CSReAQNjlhzVLnTR7KnUeQ05A+fRKwlLBA72fqrUpP
-----END PRIVATE KEY-----`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBrTCCAVOgAwIBAgIUV0LEcGgbShXtt2iM+KEElyYJd4AwCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRaG9va3MuZXhhbXBsZS5jb20wIBcNMjYxMDE3MDUxNDUxWhgP
MjEyNjA5MjMwNTE0NTFaMBwxGjAYBgNVBAMMEWhvb2tzLmV4YW1wbGUuY29tMFkw
EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2VfTIr1daB3WpISwgbEs7eZmZ0m+UIGF
DeIIey2HZgewkkXgEDY5Yc1S500eyp1HkNOQPn0SsJSwQO9n6q1KT6NxMG8wHQYD
VR0OBBYEFDn7TFM85sJq2q0dcW3G+AeH78lKMB8GA1UdIwQYMBaAFDn7TFM85sJq
2q0dcW3G+AeH78lKMA8GA1UdEwEB/wQFMAMBAf8wHAYDVR0RBBUwE4IRaG9va3Mu
ZXhhbXBsZS5jb20wCgYIKoZIzj0EAwIDSAAwRQIgc5DMNhiwK1LKkuMQQKyqHvdh
RihvwWRB2JGnYPjwYRYCIQDQ8657yBHdSziGNKPVlSud5SdlfGktJMWIUQSjfkY7
MA==
-----END CERTIFICATE-----`;

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
// A fake receiver: records requests and answers with the given statuses in turn.
function receiver(statuses = [200]) {
  const calls = [];
  let n = 0;
  const send = async (req) => {
    calls.push(req);
    const status = statuses[Math.min(n++, statuses.length - 1)];
    if (status instanceof Error) throw status;
    return { status, body: status === 200 ? "ok" : "nope" };
  };
  return { calls, send };
}
async function setup(statuses) {
  const f = await fixture();
  const svc = f.server.ctx.services.webhooks;
  const r = receiver(statuses);
  let clock = Date.parse("2026-10-17T02:00:00Z");
  svc.lookup = async () => PUBLIC;
  svc.send = r.send;
  svc.clock = () => clock;
  const tick = (ms) => (clock += ms);
  const create = async (events = ["invoice.issued", "invoice.paid", "payment.received", "client.created"], url = "https://hooks.example.com/in") => {
    const res = await f.auth("/api/platform/webhooks", "POST", { url, events, description: "n8n", password });
    assert.equal(res.status, 201);
    return res.json();
  };
  return { ...f, svc, r, tick, now: () => clock, create };
}

test("only public addresses are allowed", () => {
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.100.100.200",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "192.0.2.10", "198.18.0.1", "168.63.129.16",
    "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1",
    "64:ff9b::a9fe:a9fe", "2001:db8::1", "2002:7f00:1::1", "ff02::1", "::127.0.0.1", "not-an-ip",
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "2a00:1450:4001::200e"])
    assert.equal(isPublicAddress(ip), true, ip);
});

test("URLs must be HTTPS without credentials and point to a public host", async () => {
  assert.equal(checkUrl("https://hooks.example.com/x?y=1").hostname, "hooks.example.com");
  for (const [url, why] of [
    ["http://hooks.example.com/x", /HTTPS/],
    ["https://user:pass@hooks.example.com/x", /user name or password/],
    ["https://localhost/x", /private or local/],
    ["https://n8n.internal/x", /private or local/],
    ["https://printer.local/x", /private or local/],
    ["https://intranet/x", /private or local/],
    ["https://billing/x", /full public host/],
    ["https://127.0.0.1/x", /private or reserved/],
    ["https://2130706433/x", /private or reserved/],
    ["https://0x7f.1/x", /private or reserved/],
    ["https://[::1]/x", /private or reserved/],
    ["https://[::ffff:169.254.169.254]/x", /private or reserved/],
    ["https://169.254.169.254/latest/meta-data", /private or reserved/],
    ["https://hooks.example.com/x#frag", /fragment/],
    ["ftp://hooks.example.com/", /HTTPS/],
    ["not a url", /valid URL/],
  ])
    assert.throws(() => checkUrl(url), why, url);
  // DNS is checked: every resolved address must be public.
  const ok = await resolveDestination("https://hooks.example.com/x", async () => PUBLIC);
  assert.equal(ok.address, "93.184.216.34");
  await assert.rejects(resolveDestination("https://evil.example.com/", async () => [...PUBLIC, { address: "10.0.0.5", family: 4 }]), /Blocked: .*10\.0\.0\.5/);
  await assert.rejects(resolveDestination("https://evil.example.com/", async () => [{ address: "::ffff:127.0.0.1", family: 6 }]), /Blocked/);
  await assert.rejects(resolveDestination("https://nx.example.com/", async () => { throw new Error("ENOTFOUND"); }), /Could not find/);
});

test("signatures use a timestamp and HMAC-SHA256 and reject replays", () => {
  const body = JSON.stringify({ id: "evt_1", type: "invoice.issued" });
  const t = 1_800_000_000;
  const header = signatureHeader("whsec_test", t, body);
  assert.match(header, /^t=1800000000,v1=[0-9a-f]{64}$/);
  assert.equal(verifySignature("whsec_test", header, body, { nowSeconds: t + 10 }), true);
  assert.equal(verifySignature("whsec_test", header, body + " ", { nowSeconds: t }), false, "body changed");
  assert.equal(verifySignature("whsec_other", header, body, { nowSeconds: t }), false, "wrong secret");
  assert.equal(verifySignature("whsec_test", header, body, { nowSeconds: t + 301 }), false, "too old: replay");
  assert.equal(verifySignature("whsec_test", "garbage", body, { nowSeconds: t }), false);
});

test("creating an endpoint needs the password; the secret is shown once", async () => {
  const f = await setup();
  try {
    assert.equal((await f.request("/api/platform/webhooks")).status, 401, "owner only");
    const denied = await f.auth("/api/platform/webhooks", "POST", { url: "https://hooks.example.com/in", events: ["invoice.issued"], password: "wrong-password-123" });
    assert.equal(denied.status, 403);
    const bad = await f.auth("/api/platform/webhooks", "POST", { url: "http://hooks.example.com/in", events: ["invoice.issued"], password });
    assert.equal(bad.status, 400);
    const unknownEvent = await f.auth("/api/platform/webhooks", "POST", { url: "https://hooks.example.com/in", events: ["everything"], password });
    assert.equal(unknownEvent.status, 400);
    f.svc.lookup = async () => [{ address: "192.168.1.10", family: 4 }];
    const privateDns = await f.auth("/api/platform/webhooks", "POST", { url: "https://hooks.example.com/in", events: ["invoice.issued"], password });
    assert.equal(privateDns.status, 400, "DNS pointing inside is refused at save time");
    f.svc.lookup = async () => PUBLIC;
    const { webhook, secret } = await f.create();
    assert.match(secret, /^whsec_[\w-]{43}$/);
    const list = await f.json("/api/platform/webhooks");
    assert.equal(list.webhooks.length, 1);
    assert.ok(!JSON.stringify(list).includes(secret), "never returned again");
    const ws = await f.json("/api/workspace");
    assert.ok(!JSON.stringify(ws).includes(secret));
    assert.ok(!JSON.stringify(ws.ext.platform.webhooks[0]).includes("secret"));
    const stored = f.store.db.prepare("SELECT secret FROM platform_webhooks").get().secret;
    assert.ok(!Buffer.from(stored, "base64").toString().includes(secret), "encrypted at rest");
    // Changing the URL needs the password again; other edits do not.
    assert.equal((await f.auth(`/api/platform/webhooks/${webhook.id}`, "PUT", { url: "https://other.example.com/x" })).status, 403);
    assert.equal((await f.auth(`/api/platform/webhooks/${webhook.id}`, "PUT", { description: "Zapier", events: ["invoice.issued"] })).status, 200);
    const rotated = await f.auth(`/api/platform/webhooks/${webhook.id}/rotate`, "POST", { password });
    assert.notEqual((await rotated.json()).secret, secret);
    const backup = await f.json("/api/backup");
    assert.equal(backup.ext.platform.webhooks.length, 1);
    assert.ok(!JSON.stringify(backup.ext.platform).includes("whsec_"));
  } finally {
    await f.close();
  }
});

test("events are queued from the audit stream, signed and delivered with safe payloads", async () => {
  const f = await setup();
  try {
    const before = issuedInvoice(f.store); // happened before the endpoint existed: never sent
    const { webhook, secret } = await f.create(["invoice.issued", "invoice.paid", "payment.received", "client.created", "client.updated"]);
    const { client, invoice } = issuedInvoice(f.store, { rate: "250.00" });
    await f.json(`/api/documents/${invoice.id}/share`, "POST", { days: 7 });
    f.store.saveClient({ ...client, email: "new@example.com" }, client.id);
    f.store.saveService({ name: "Not subscribed", rate: "1.00" });
    assert.ok(f.svc.collect() >= 3);
    assert.equal(f.svc.collect(), 0, "cursor moved: nothing queued twice");
    const out = await f.svc.deliverDue();
    assert.equal(out.delivered, f.r.calls.length);
    const types = f.r.calls.map((c) => c.headers["Nawlogic-Event"]);
    assert.deepEqual(types, ["client.created", "invoice.issued", "client.updated"]);
    assert.ok(!f.r.calls.some((c) => c.body.includes(before.invoice.id)), "history is not replayed");
    const issued = f.r.calls[1];
    assert.equal(issued.address, "93.184.216.34", "connection pinned to the checked address");
    assert.equal(issued.url.hostname, "hooks.example.com");
    const tSec = Math.floor(f.now() / 1000);
    assert.equal(verifySignature(secret, issued.headers["Nawlogic-Signature"], issued.body, { nowSeconds: tSec }), true);
    const payload = JSON.parse(issued.body);
    assert.equal(payload.type, "invoice.issued");
    assert.match(payload.id, /^evt_[0-9a-f]{32}$/);
    assert.equal(issued.headers["Nawlogic-Event-Id"], payload.id);
    assert.equal(payload.data.number, invoice.number);
    assert.equal(payload.data.total, 25000);
    assert.equal(payload.data.client.name, client.name);
    for (const secretish of ["token_hash", "token_expires", "business", "bankAccount", "client_snapshot", "proofs"]) assert.ok(!issued.body.includes(secretish), secretish);
    // Paying the invoice: a receipt event and one "fully paid" event.
    f.store.recordPayment(invoice.id, { amount: "100.00", paid_date: today(), method: "Bank transfer", reference: "WH-1" });
    f.svc.collect();
    f.store.recordPayment(invoice.id, { amount: "150.00", paid_date: today(), method: "Bank transfer", reference: "WH-2" });
    f.svc.collect();
    await f.svc.deliverDue();
    const later = f.r.calls.slice(3).map((c) => JSON.parse(c.body));
    // The receipt is recorded before it is applied, so "fully paid" comes last.
    assert.deepEqual(later.map((e) => e.type), ["payment.received", "payment.received", "invoice.paid"]);
    assert.equal(later[2].data.balance, 0);
    assert.equal(later[0].data.amount, 10000);
    const log = await f.json(`/api/platform/webhooks/${webhook.id}/deliveries`);
    assert.ok(log.every((d) => d.state === "delivered" && d.last_status === 200));
    const detail = await f.json(`/api/platform/deliveries/${log[0].id}`);
    assert.equal(detail.attempts_log.length, 1);
    assert.equal(detail.payload.id, detail.event_id);
  } finally {
    await f.close();
  }
});

test("failures retry with exponential backoff for 24 hours, then the endpoint is turned off", async () => {
  const f = await setup([500]);
  try {
    const { webhook } = await f.create(["invoice.issued"]);
    issuedInvoice(f.store);
    f.svc.collect();
    const gaps = [];
    let last = f.now();
    for (let i = 0; i < 40; i++) {
      await f.svc.deliverDue();
      const d = f.store.db.prepare("SELECT * FROM platform_webhook_deliveries").get();
      if (d.state !== "pending") break;
      gaps.push(d.next_attempt - last);
      f.tick(d.next_attempt - f.now());
      last = f.now();
    }
    assert.deepEqual(gaps.slice(0, 6), [60000, 120000, 240000, 480000, 960000, 1920000], "doubling from one minute");
    assert.ok(gaps.every((g) => g <= 6 * 3600000), "capped at six hours");
    const d = f.store.db.prepare("SELECT * FROM platform_webhook_deliveries").get();
    assert.equal(d.state, "failed");
    assert.equal(d.last_status, 500);
    assert.ok(f.now() - Date.parse("2026-10-17T02:00:00Z") <= RETRY_WINDOW, "no attempt after 24 hours");
    assert.equal(d.attempts, f.r.calls.length);
    assert.ok(d.attempts >= 10 && d.attempts <= 16);
    const w = (await f.json("/api/platform/webhooks")).webhooks[0];
    assert.equal(w.active, false, "turned off after failing for 24 hours");
    assert.match(w.disabled_reason, /Failed for 24 hours/);
    assert.ok(f.store.db.prepare("SELECT 1 FROM audit WHERE action='webhook.disabled' AND entity_id=?").get(webhook.id));
    // New events are not queued for a disabled endpoint.
    issuedInvoice(f.store);
    assert.equal(f.svc.collect(), 0);
    // Turning it back on resets the counters; the failed delivery can be sent again.
    f.svc.send = receiver([200]).send;
    await f.json(`/api/platform/webhooks/${webhook.id}`, "PUT", { active: true });
    const retried = await f.json(`/api/platform/deliveries/${d.id}/retry`, "POST", {});
    assert.equal(retried.state, "pending");
    await f.svc.deliverDue();
    assert.equal(f.store.db.prepare("SELECT state FROM platform_webhook_deliveries WHERE id=?").get(d.id).state, "delivered");
    const again = await f.auth(`/api/platform/deliveries/${d.id}/retry`, "POST", {});
    assert.equal(again.status, 409, "a delivered event is not resent");
  } finally {
    await f.close();
  }
});

test("410 Gone turns the endpoint off at once and cancels pending deliveries", async () => {
  const f = await setup([410]);
  try {
    await f.create(["invoice.issued"]);
    issuedInvoice(f.store);
    issuedInvoice(f.store);
    f.svc.collect();
    await f.svc.deliverDue({ limit: 1 });
    const states = f.store.db.prepare("SELECT state FROM platform_webhook_deliveries ORDER BY state").all().map((r) => r.state);
    assert.deepEqual(states, ["cancelled", "failed"]);
    assert.match(f.svc.list()[0].disabled_reason, /410/);
  } finally {
    await f.close();
  }
});

test("DNS is checked again at delivery time (rebinding is blocked)", async () => {
  const f = await setup([200]);
  try {
    await f.create(["invoice.issued"]);
    issuedInvoice(f.store);
    f.svc.collect();
    f.svc.lookup = async () => [{ address: "169.254.169.254", family: 4 }];
    const out = await f.svc.deliverDue();
    assert.equal(out.retrying, 1);
    assert.equal(f.r.calls.length, 0, "nothing was sent");
    const d = f.store.db.prepare("SELECT * FROM platform_webhook_deliveries").get();
    assert.match(d.last_error, /Blocked: .*169\.254\.169\.254/);
    // Network errors and timeouts are failures too.
    f.svc.lookup = async () => PUBLIC;
    f.svc.send = receiver([new Error("Timed out")]).send;
    f.tick(60000);
    await f.svc.deliverDue();
    assert.equal(f.store.db.prepare("SELECT last_error FROM platform_webhook_deliveries").get().last_error, "Timed out");
  } finally {
    await f.close();
  }
});

test("test events are sent at once, once, whatever the subscription", async () => {
  const f = await setup([200, 503]);
  try {
    const { webhook, secret } = await f.create(["client.created"]);
    const ok = await f.json(`/api/platform/webhooks/${webhook.id}/test`, "POST", {});
    assert.equal(ok.state, "delivered");
    const body = JSON.parse(f.r.calls[0].body);
    assert.equal(body.type, "webhook.test");
    assert.equal(body.test, true);
    assert.equal(verifySignature(secret, f.r.calls[0].headers["Nawlogic-Signature"], f.r.calls[0].body, { nowSeconds: Math.floor(f.now() / 1000) }), true);
    const failed = await f.json(`/api/platform/webhooks/${webhook.id}/test`, "POST", {});
    assert.equal(failed.state, "failed");
    assert.equal(failed.status, 503);
    f.tick(3600000);
    await f.svc.deliverDue();
    assert.equal(f.r.calls.length, 2, "a failed test is not retried");
    assert.equal(f.svc.get(webhook.id).consecutive_failures, 0, "tests do not count towards turning off");
  } finally {
    await f.close();
  }
});

test("other business events map to webhook types", async () => {
  const f = await setup();
  try {
    await f.create(["quotation.issued", "quotation.accepted", "document.voided", "receipt.voided", "credit_note.issued"]);
    const c = f.store.saveClient({ name: "Events client", email: "e@example.com" });
    const q = f.store.issue(
      f.store.saveDocument({ kind: "quote", client_id: c.id, issue_date: today(), due_date: today(), items: [{ description: "Q", quantity: 1, rate: "10.00" }] }).id,
    );
    const link = await f.json(`/api/documents/${q.id}/share`, "POST", { days: 7 });
    const token = link.url.split("/client/")[1];
    assert.equal((await f.request(`/api/public/${token}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Ali", revision: quoteRevision(f.store.publicDocument(token)) }) })).status, 200);
    const { invoice } = issuedInvoice(f.store, { client: c });
    f.store.adjustment(invoice.id, { kind: "credit", amount: "10.00", reason: "Goodwill" });
    const { invoice: other } = issuedInvoice(f.store, { client: c });
    f.store.void(other.id, "Mistake");
    const r = f.store.receive({ client_id: c.id, amount: "5.00", paid_date: today(), method: "Cash", reference: "CASH-9" });
    f.store.voidReceipt(r.id, "Wrong client");
    f.svc.collect();
    await f.svc.deliverDue();
    const events = f.r.calls.map((x) => JSON.parse(x.body));
    assert.deepEqual(events.map((e) => e.type), ["quotation.issued", "quotation.accepted", "credit_note.issued", "document.voided", "receipt.voided"]);
    assert.equal(events[1].data.accepted_name, "Ali");
    assert.equal(events[2].data.amount, 1000);
    assert.equal(events[3].data.reason, "Mistake");
    assert.equal(events[4].data.voided, true);
    assert.ok(!f.r.calls.some((x) => x.body.includes(token)), "share tokens never leave");
  } finally {
    await f.close();
  }
});

test("deleted records and imports produce no events; restore turns endpoints off", async () => {
  const f = await setup();
  try {
    await f.create(["client.created"]);
    assert.deepEqual(eventsFromAudit(f.store, { action: "client.changed", entity_id: "missing", actor: "owner:x" }, "http://x"), []);
    assert.deepEqual(eventsFromAudit(f.store, { action: "document.issued", entity_id: "x", actor: "import:owner:x" }, "http://x"), []);
    const csv = "name,email\nImported Co,imp@example.com\n";
    const sha = (await (await f.auth("/api/platform/import/clients/preview", "POST", new Uint8Array(Buffer.from(csv)))).json()).sha256;
    assert.equal((await f.auth(`/api/platform/import/clients?sha256=${sha}`, "POST", new Uint8Array(Buffer.from(csv)))).status, 201);
    f.store.saveClient({ name: "Typed in" });
    f.svc.collect();
    await f.svc.deliverDue();
    assert.deepEqual(f.r.calls.map((c) => JSON.parse(c.body).data.name), ["Typed in"], "the imported client sent nothing");
    // Restore hook.
    issuedInvoice(f.store);
    f.store.saveClient({ name: "Pending one" });
    f.svc.collect();
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE x(y)");
    platform.onRestore(db); // tables missing: nothing to do
    platform.onRestore(f.store.db);
    assert.equal(f.svc.list()[0].active, false);
    assert.match(f.svc.list()[0].disabled_reason, /restored/);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM platform_webhook_deliveries WHERE state='pending'").get().n, 0);
  } finally {
    await f.close();
  }
});

test("the background job collects, delivers and prunes old deliveries", async () => {
  const f = await setup();
  try {
    await f.create(["invoice.issued"]);
    issuedInvoice(f.store);
    const result = await f.server.runJob("platform:webhooks");
    assert.equal(result.queued, 1);
    assert.equal(result.delivered, 1);
    f.store.db.prepare("UPDATE platform_webhook_deliveries SET created='2020-01-01T00:00:00.000Z'").run();
    f.store.db.prepare("UPDATE platform_webhook_events SET created='2020-01-01T00:00:00.000Z'").run();
    f.svc.prune();
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM platform_webhook_deliveries").get().n, 0);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM platform_webhook_events").get().n, 0);
    const jobs = await f.json("/api/jobs");
    assert.ok(jobs.some((j) => j.name === "platform:webhooks"));
    // Up to ten endpoints; deleting removes its log.
    const id = f.svc.list()[0].id;
    assert.equal((await f.auth(`/api/platform/webhooks/${id}`, "DELETE")).status, 200);
    assert.equal(f.svc.list().length, 0);
    assert.equal((await f.auth(`/api/platform/webhooks/${id}`, "DELETE")).status, 404);
  } finally {
    await f.close();
  }
});

test("the HTTPS transport connects to the checked address, checks the certificate and never follows redirects", async () => {
  const seen = [];
  const server = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ host: req.headers.host, sni: req.socket.servername, body, sig: req.headers["nawlogic-signature"], path: req.url });
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "https://169.254.169.254/" });
        return res.end();
      }
      res.writeHead(201, { "Content-Type": "text/plain" });
      res.end("x".repeat(5000));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const url = new URL(`https://hooks.example.com:${port}/in?a=1`);
    // hooks.example.com is never looked up: the request goes to the pinned address.
    const ok = await httpsSend({ url, address: "127.0.0.1", family: 4, headers: { "Nawlogic-Signature": "t=1,v1=x" }, body: '{"a":1}', ca: TEST_CERT });
    assert.equal(ok.status, 201);
    assert.ok(ok.body.length <= 2048, "response body is capped");
    assert.deepEqual(seen[0], { host: `hooks.example.com:${port}`, sni: "hooks.example.com", body: '{"a":1}', sig: "t=1,v1=x", path: "/in?a=1" });
    const redirect = await httpsSend({ url: new URL(`https://hooks.example.com:${port}/redirect`), address: "127.0.0.1", family: 4, headers: {}, body: "{}", ca: TEST_CERT });
    assert.equal(redirect.status, 302, "a redirect is a failed delivery, not followed");
    assert.equal(seen.length, 2);
    // Without trusting the test certificate the connection is refused.
    await assert.rejects(httpsSend({ url, address: "127.0.0.1", family: 4, headers: {}, body: "{}" }), /self-signed|certificate/i);
    // A certificate for another name is refused even when trusted.
    await assert.rejects(
      httpsSend({ url: new URL(`https://other.example.com:${port}/`), address: "127.0.0.1", family: 4, headers: {}, body: "{}", ca: TEST_CERT }),
      /altnames|does not match|hostname/i,
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
