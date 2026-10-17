import test from "node:test";
import assert from "node:assert/strict";
import { fixture, password } from "./helpers.mjs";
import { member, signIn, fakeTransport, mailConfig } from "./team-helpers.mjs";
import { beginMfa, enableMfa, totp } from "../server/mfa.mjs";

const post = (f, path, body) =>
  f.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const linkFrom = (mail) => mail.text.match(/http:\/\/localhost\/reset\/([\w-]{43})/)?.[1];

test("without email the sign-in page explains console recovery and no reset link is made", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await (await f.request("/api/guest/team/options")).json(), { reset: false });
    const res = await post(f, "/api/guest/team/reset", { email: "owner@example.com" });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { ok: true, email: false });
    await f.server.ctx.services.team.idle();
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM team_tokens").get().n, 0);
  } finally {
    await f.close();
  }
});

test("reset requests answer the same whether or not the account exists", async () => {
  const transport = fakeTransport();
  const f = await fixture({ app: { mailConfig, mailTransport: transport } });
  try {
    assert.deepEqual(await (await f.request("/api/guest/team/options")).json(), { reset: true });
    const known = await post(f, "/api/guest/team/reset", { email: "Owner@Example.com" });
    const unknown = await post(f, "/api/guest/team/reset", { email: "nobody@example.com" });
    assert.equal(known.status, unknown.status);
    assert.deepEqual(await known.json(), await unknown.json());
    await f.server.ctx.services.team.idle();
    assert.equal(transport.sent.length, 1, "only the real account gets an email");
    assert.deepEqual(transport.sent[0].to, ["owner@example.com"]);
    // Pending invitations and disabled users get nothing either.
    await f.json("/api/team/users", "POST", { email: "pending@example.com", role: "staff" });
    await post(f, "/api/guest/team/reset", { email: "pending@example.com" });
    await f.server.ctx.services.team.idle();
    assert.equal(transport.sent.filter((m) => /^Reset/.test(m.subject)).length, 1);
    assert.equal((await post(f, "/api/guest/team/reset", { email: "not an email" })).status, 400);
  } finally {
    await f.close();
  }
});

test("reset requests are rate limited per email, for real and unknown accounts alike", async () => {
  const f = await fixture({ app: { mailConfig, mailTransport: fakeTransport() } });
  try {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(f, "/api/guest/team/reset", { email: "nobody@example.com" })).status);
    assert.deepEqual(statuses, [202, 202, 202, 429]);
    assert.equal((await post(f, "/api/guest/team/reset", { email: "owner@example.com" })).status, 202);
    assert.equal((await post(f, "/api/guest/team/reset", { email: "owner@example.com" })).status, 429, "per-IP limit");
    await f.server.ctx.services.team.idle();
  } finally {
    await f.close();
  }
});

test("a reset link works once, within 30 minutes, ends sessions, revokes owner connectors and keeps MFA", async () => {
  const transport = fakeTransport();
  const f = await fixture({ app: { mailConfig, mailTransport: transport } });
  try {
    const me = f.store.db.prepare("SELECT id FROM owners WHERE email='owner@example.com'").get().id;
    const keep = f.store.db.prepare("SELECT hash FROM sessions WHERE csrf=?").get(f.session.csrf).hash;
    const { secret } = beginMfa(f.store, me);
    enableMfa(f.store, me, totp(secret), keep);
    const connector = f.store.createConnector({ label: "n8n", scopes: ["business:read"], days: 30 });
    await post(f, "/api/guest/team/reset", { email: "owner@example.com" });
    await f.server.ctx.services.team.idle();
    const first = linkFrom(transport.sent[0]);
    assert.ok(first);
    assert.ok(!JSON.stringify(f.store.db.prepare("SELECT * FROM team_tokens").all()).includes(first), "stored hashed");
    const row = f.store.db.prepare("SELECT expires FROM team_tokens WHERE purpose='reset'").get();
    assert.ok(row.expires - Date.now() <= 30 * 60000 && row.expires - Date.now() > 29 * 60000);
    // A newer request replaces the older link.
    await post(f, "/api/guest/team/reset", { email: "owner@example.com" });
    await f.server.ctx.services.team.idle();
    const token = linkFrom(transport.sent[1]);
    assert.equal((await f.request("/api/guest/team/reset/" + first)).status, 404);
    const info = await (await f.request("/api/guest/team/reset/" + token)).json();
    assert.equal(info.email, "owner@example.com");
    assert.equal(info.mfa, true);
    assert.equal((await post(f, "/api/guest/team/reset/" + token, { password: "too-short" })).status, 400);
    const done = await post(f, "/api/guest/team/reset/" + token, { password: "Reset-new-password-55" });
    assert.equal(done.status, 200);
    assert.equal((await post(f, "/api/guest/team/reset/" + token, { password: "Reset-new-password-66" })).status, 404, "single use");
    assert.equal((await f.auth("/api/workspace")).status, 401, "all sessions ended");
    assert.equal(f.store.db.prepare("SELECT revoked FROM integration_tokens WHERE id=?").get(connector.id).revoked, 1);
    await assert.rejects(signIn(f, "owner@example.com", password), /incorrect/);
    await assert.rejects(signIn(f, "owner@example.com", "Reset-new-password-55"), /Authenticator/, "MFA still required");
    await signIn(f, "owner@example.com", "Reset-new-password-55", totp(secret, Date.now() / 1000 + 30));
    const audit = f.store.db.prepare("SELECT actor FROM audit WHERE action='password.reset'").get();
    assert.equal(audit.actor, "reset-link:owner@example.com");
  } finally {
    await f.close();
  }
});

test("expired and wrong-purpose links are refused; staff resets leave connectors alone", async () => {
  const transport = fakeTransport();
  const f = await fixture({ app: { mailConfig, mailTransport: transport } });
  try {
    const staff = await member(f, "staff");
    assert.equal((await f.request("/api/guest/team/reset/" + staff.token)).status, 404, "an invitation is not a reset link");
    const connector = f.store.createConnector({ label: "n8n", scopes: ["business:read"], days: 30 });
    await post(f, "/api/guest/team/reset", { email: staff.email });
    await f.server.ctx.services.team.idle();
    const token = linkFrom(transport.sent.at(-1));
    f.store.db.prepare("UPDATE team_tokens SET expires=? WHERE purpose='reset'").run(Date.now() - 1000);
    assert.equal((await post(f, "/api/guest/team/reset/" + token, { password: "Staff-reset-pass-77" })).status, 404);
    await post(f, "/api/guest/team/reset", { email: staff.email });
    await f.server.ctx.services.team.idle();
    const fresh = linkFrom(transport.sent.at(-1));
    assert.equal((await post(f, "/api/guest/team/reset/" + fresh, { password: "Staff-reset-pass-77" })).status, 200);
    assert.equal((await staff.auth("/api/workspace")).status, 401);
    assert.equal(f.store.db.prepare("SELECT revoked FROM integration_tokens WHERE id=?").get(connector.id).revoked, 0);
    await signIn(f, staff.email, "Staff-reset-pass-77");
    // A disabled user's link stops working.
    await post(f, "/api/guest/team/reset", { email: staff.email });
    await f.server.ctx.services.team.idle();
    const late = linkFrom(transport.sent.at(-1));
    await f.json(`/api/team/users/${staff.id}/disable`, "POST", {});
    assert.equal((await f.request("/api/guest/team/reset/" + late)).status, 404);
    // Guest POSTs still need the app's own origin.
    const foreign = await fetch(f.base + "/api/guest/team/reset", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" });
    assert.equal(foreign.status, 403);
  } finally {
    await f.close();
  }
});

test("the owner can get a reset link for a member: emailed to them when possible, otherwise shown to the owner", async () => {
  const f = await fixture();
  try {
    const staff = await member(f, "staff");
    const r = await f.json(`/api/team/users/${staff.id}/reset-link`, "POST", {});
    assert.equal(r.emailed, false);
    const token = r.link.split("/reset/")[1];
    assert.equal((await post(f, "/api/guest/team/reset/" + token, { password: "Owner-gave-link-88" })).status, 200);
    await signIn(f, staff.email, "Owner-gave-link-88");
    assert.ok(f.store.db.prepare("SELECT 1 FROM audit WHERE action='password.reset_link_created'").get(), "audited");
    const me = f.store.db.prepare("SELECT id FROM owners WHERE email='owner@example.com'").get().id;
    assert.equal((await f.auth(`/api/team/users/${me}/reset-link`, "POST", {})).status, 409, "not for yourself");
    const again = await signIn(f, staff.email, "Owner-gave-link-88");
    assert.equal((await again.auth(`/api/team/users/${me}/reset-link`, "POST", {})).status, 403);
  } finally {
    await f.close();
  }
  const transport = fakeTransport();
  const g = await fixture({ app: { mailConfig, mailTransport: transport } });
  try {
    const staff = await member(g, "staff");
    const r = await g.json(`/api/team/users/${staff.id}/reset-link`, "POST", {});
    assert.deepEqual([r.emailed, r.link], [true, undefined], "the owner never sees the link when it can be emailed");
    assert.ok(linkFrom(transport.sent.at(-1)));
    assert.deepEqual(transport.sent.at(-1).to, [staff.email]);
  } finally {
    await g.close();
  }
});
