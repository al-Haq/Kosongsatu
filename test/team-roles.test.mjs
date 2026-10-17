import test from "node:test";
import assert from "node:assert/strict";
import { fixture, issuedInvoice, password } from "./helpers.mjs";
import { member, signIn, memberPassword, fakeTransport, mailConfig } from "./team-helpers.mjs";
import { accessRules, allowed } from "../server/team-roles.mjs";
import { beginMfa, enableMfa, totp } from "../server/mfa.mjs";

const ROLE_DENIED = /access does not include this/;
// Allowed means the role check let it through; the route may still refuse the input.
async function outcome(res) {
  if (res.status !== 403) return "allowed";
  const body = await res.json().catch(() => ({}));
  return ROLE_DENIED.test(body.error || "") ? "denied" : "allowed";
}

test("role matrix: owner everything, staff day-to-day billing, accountant read-only, unclassified routes denied", async () => {
  const f = await fixture();
  try {
    const staff = await member(f, "staff");
    const accountant = await member(f, "accountant");
    const { invoice, client } = issuedInvoice(f.store);
    const draft = f.store.saveDocument({ kind: "invoice", client_id: client.id, issue_date: invoice.issue_date, due_date: invoice.due_date, items: [{ description: "x", quantity: 1, rate: "1.00" }] });
    const receipt = f.store.receive({ client_id: client.id, amount: "10.00", paid_date: invoice.issue_date, method: "Bank transfer", reference: "MATRIX-1" });
    const O = "owner", S = "staff", A = "accountant";
    const matrix = [
      ["GET", "/api/workspace", null, [O, S, A]],
      ["GET", "/api/session", null, [O, S, A]],
      ["GET", "/api/documents", null, [O, S, A]],
      ["GET", `/api/documents/${invoice.id}`, null, [O, S, A]],
      ["GET", `/api/documents/${invoice.id}/pdf`, null, [O, S, A]],
      ["GET", `/api/receipts/${receipt.id}/pdf`, null, [O, S, A]],
      ["GET", "/api/invoices.csv", null, [O, S, A]],
      ["GET", "/api/reports/sst.csv", null, [O, S, A]],
      ["GET", `/api/clients/${client.id}/statement`, null, [O, S, A]],
      ["GET", "/api/backup", null, [O, A]],
      ["GET", "/api/mfa/status", null, [O, S, A]],
      ["POST", "/api/mfa/begin", { password: "wrong" }, [O, S, A]],
      ["POST", "/api/team/password", { current: "wrong", password: "x" }, [O, S, A]],
      ["GET", "/api/team/audit/verify", null, [O, A]],
      ["GET", "/api/team/audit/head", null, [O, A]],
      ["POST", "/api/documents", { kind: "invoice" }, [O, S]],
      ["PUT", `/api/documents/${draft.id}`, { kind: "invoice" }, [O, S]],
      ["POST", `/api/documents/${draft.id}/issue`, {}, [O, S]],
      ["POST", `/api/documents/${invoice.id}/share`, { days: 5 }, [O, S]],
      ["POST", `/api/documents/${invoice.id}/payments`, {}, [O, S]],
      ["POST", `/api/documents/${invoice.id}/void`, { reason: "" }, [O]],
      ["POST", `/api/documents/${invoice.id}/adjustments`, {}, [O]],
      ["POST", "/api/clients", { name: "" }, [O, S]],
      ["PUT", `/api/clients/${client.id}`, { name: "" }, [O, S]],
      ["DELETE", `/api/clients/${client.id}`, null, [O]],
      ["POST", "/api/services", { name: "" }, [O, S]],
      ["DELETE", "/api/services/nope", null, [O]],
      ["POST", "/api/receipts", {}, [O, S]],
      ["POST", `/api/receipts/${receipt.id}/allocate`, {}, [O, S]],
      ["POST", `/api/receipts/${receipt.id}/refund`, {}, [O]],
      ["POST", `/api/receipts/${receipt.id}/void`, { reason: "" }, [O]],
      ["POST", "/api/bank/preview", { csv: "" }, [O, S]],
      ["POST", "/api/bank/x/exclude", { reason: "" }, [O]],
      ["PUT", "/api/settings", {}, [O]],
      ["PUT", "/api/secrets/BACKUP_S3_BUCKET", { value: "b" }, [O]],
      ["POST", "/api/automation/connectors", {}, [O]],
      ["POST", "/api/automation/proposals", {}, [O]],
      ["POST", "/api/assistant/chat", {}, [O]],
      ["GET", "/api/recovery/status", null, [O]],
      ["POST", "/api/recovery/backup", {}, [O]],
      ["GET", "/api/jobs", null, [O]],
      ["DELETE", "/api/files/nope", null, [O]],
      ["GET", "/api/team/users", null, [O]],
      ["POST", "/api/team/users", {}, [O]],
      ["POST", "/api/team/backup/test", {}, [O]],
      ["POST", "/api/team/backup/key", {}, [O]],
      // Not classified by anyone: owner gets the normal answer, everyone else is refused.
      ["GET", "/api/unclassified/report", null, [O]],
      ["POST", "/api/unclassified/write", {}, [O]],
    ];
    // Read-only and denied checks first, the owner last (some owner calls change state).
    for (const [who, client] of [[A, accountant], [S, staff], [O, f]]) {
      for (const [method, path, body, roles] of matrix) {
        const res = await client.auth(path, method, body || undefined);
        const got = await outcome(res);
        assert.equal(got, roles.includes(who) ? "allowed" : "denied", `${who} ${method} ${path} → ${res.status}`);
      }
    }
    // Staff writes are recorded with their own identity.
    await staff.json("/api/clients", "POST", { name: "Staff client", email: "c@example.com" });
    const row = f.store.db.prepare("SELECT actor FROM audit WHERE action='client.saved' ORDER BY id DESC LIMIT 1").get();
    assert.equal(row.actor, "owner:" + staff.email);
    // The browser learns the role from the workspace; only owners see the user list.
    const ws = await staff.json("/api/workspace");
    assert.equal(ws.ext.team.me.role, "staff");
    assert.equal(ws.ext.team.users, undefined);
    assert.equal((await accountant.json("/api/workspace")).ext.team.audit.hash.length, 64);
    assert.equal((await f.json("/api/workspace")).ext.team.users.length, 3);
  } finally {
    await f.close();
  }
});

test("other modules classify their own routes for staff and accountants", () => {
  const rules = accessRules([{ access: { accountant: [["get", /^\/api\/books\/report$/]], staff: [["POST", /^\/api\/books\/expenses$/]] } }]);
  assert.equal(allowed(rules, "accountant", "GET", "/api/books/report"), true);
  assert.equal(allowed(rules, "accountant", "POST", "/api/books/expenses"), false);
  assert.equal(allowed(rules, "staff", "POST", "/api/books/expenses"), true);
  assert.equal(allowed(rules, "staff", "GET", "/api/books/report"), false);
  assert.equal(allowed(rules, "owner", "DELETE", "/api/anything"), true);
  assert.equal(allowed(rules, "nobody", "GET", "/api/workspace"), false);
});

test("invitations are one-time links; email is sent when configured, otherwise the link is copied", async () => {
  const transport = fakeTransport();
  const f = await fixture({ app: { mailConfig, mailTransport: transport } });
  try {
    const invite = await f.json("/api/team/users", "POST", { email: "New.Person@Example.com", role: "accountant", name: "New Person" });
    assert.equal(invite.emailed, true);
    assert.equal(invite.user.status, "Invited");
    assert.equal(invite.user.email, "new.person@example.com");
    const token = invite.link.split("/invite/")[1];
    assert.match(token, /^[\w-]{43}$/);
    assert.equal(transport.sent.length, 1);
    assert.ok(transport.sent[0].text.includes(invite.link));
    assert.deepEqual(transport.sent[0].to, ["new.person@example.com"]);
    // Only the hash of the link is stored.
    assert.ok(!JSON.stringify(f.store.db.prepare("SELECT * FROM team_tokens").all()).includes(token));
    // Not usable before accepting: no password works.
    await assert.rejects(signIn(f, "new.person@example.com", password), /incorrect/);
    const info = await (await f.request("/api/guest/team/invite/" + token)).json();
    assert.equal(info.role, "accountant");
    assert.equal(info.email, "new.person@example.com");
    const weak = await f.request("/api/guest/team/invite/" + token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "short" }) });
    assert.equal(weak.status, 400, "password policy applies");
    const accept = await f.request("/api/guest/team/invite/" + token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: memberPassword }) });
    assert.equal(accept.status, 200);
    const again = await f.request("/api/guest/team/invite/" + token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: memberPassword }) });
    assert.equal(again.status, 404, "an invitation works once");
    const s = await signIn(f, "new.person@example.com");
    const u = (await f.json("/api/team/users")).find((x) => x.email === "new.person@example.com");
    assert.equal(u.status, "Active");
    assert.ok(u.last_sign_in, "last sign-in is recorded");
    assert.equal((await s.json("/api/session")).email, "new.person@example.com");
    // Duplicates and bad input are refused.
    assert.equal((await f.auth("/api/team/users", "POST", { email: "new.person@example.com", role: "staff" })).status, 409);
    assert.equal((await f.auth("/api/team/users", "POST", { email: "x@example.com", role: "admin" })).status, 400);
    assert.equal((await f.auth("/api/team/users", "POST", { email: "not-an-email", role: "staff" })).status, 400);
  } finally {
    await f.close();
  }
});

test("without email the owner copies the link; resending replaces it; pending invitations can be removed", async () => {
  const f = await fixture();
  try {
    const first = await f.json("/api/team/users", "POST", { email: "later@example.com", role: "staff" });
    assert.equal(first.emailed, false);
    assert.match(first.link, /^http:\/\/localhost\/invite\/[\w-]{43}$/);
    const second = await f.json(`/api/team/users/${first.user.id}/invite`, "POST", {});
    assert.notEqual(second.link, first.link);
    assert.equal((await f.request("/api/guest/team/invite/" + first.link.split("/invite/")[1])).status, 404, "old link stops working");
    assert.equal((await f.request("/api/guest/team/invite/" + second.link.split("/invite/")[1])).status, 200);
    // Expired links stop working.
    f.store.db.prepare("UPDATE team_tokens SET expires=? WHERE owner_id=?").run(Date.now() - 1, first.user.id);
    assert.equal((await f.request("/api/guest/team/invite/" + second.link.split("/invite/")[1])).status, 404);
    assert.equal((await f.request("/api/guest/team/invite/not-a-token")).status, 404);
    assert.equal((await f.auth(`/api/team/users/${first.user.id}`, "DELETE")).status, 200);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM owners WHERE email='later@example.com'").get().n, 0);
    // Active users are disabled, not removed, so their history keeps its meaning.
    const active = await member(f, "staff");
    assert.equal((await f.auth(`/api/team/users/${active.id}`, "DELETE")).status, 409);
  } finally {
    await f.close();
  }
});

test("the last owner cannot be demoted or disabled; disabling ends sessions at once", async () => {
  const f = await fixture();
  try {
    const me = f.store.db.prepare("SELECT id FROM owners WHERE email='owner@example.com'").get().id;
    assert.equal((await f.auth(`/api/team/users/${me}`, "PUT", { role: "staff" })).status, 409);
    assert.equal((await f.auth(`/api/team/users/${me}/disable`, "POST", {})).status, 409);
    // A pending owner invitation does not count as a second owner.
    const pending = await f.json("/api/team/users", "POST", { email: "pending-owner@example.com", role: "owner" });
    assert.equal(pending.user.role, "owner");
    assert.equal((await f.auth(`/api/team/users/${me}`, "PUT", { role: "accountant" })).status, 409);
    const second = await member(f, "owner");
    // Now there are two owners: the second one can be demoted, but not both.
    const demoted = await f.json(`/api/team/users/${second.id}`, "PUT", { role: "staff" });
    assert.equal(demoted.role, "staff");
    assert.equal(await outcome(await second.auth("/api/settings", "PUT", {})), "denied", "role change applies to the live session");
    await f.json(`/api/team/users/${second.id}`, "PUT", { role: "owner" });
    // Disable: their session ends immediately and they cannot sign in.
    const staff = await member(f, "staff");
    assert.equal((await staff.auth("/api/workspace")).status, 200);
    const disabled = await f.json(`/api/team/users/${staff.id}/disable`, "POST", {});
    assert.equal(disabled.status, "Disabled");
    assert.equal((await staff.auth("/api/workspace")).status, 401);
    await assert.rejects(signIn(f, staff.email), /disabled/);
    await f.json(`/api/team/users/${staff.id}/enable`, "POST", {});
    const back = await signIn(f, staff.email);
    // Staff cannot manage users or other people's MFA.
    assert.equal(await outcome(await back.auth(`/api/team/users/${me}/disable`, "POST", {})), "denied");
    assert.equal(await outcome(await back.auth(`/api/team/users/${me}/reset-mfa`, "POST", {})), "denied");
    const audit = f.store.db.prepare("SELECT action FROM audit WHERE action LIKE 'user.%'").all().map((r) => r.action);
    for (const a of ["user.invited", "user.joined", "user.role_changed", "user.disabled", "user.enabled"]) assert.ok(audit.includes(a), a);
  } finally {
    await f.close();
  }
});

test("own password changes end own sessions; only owners revoke connector tokens", async () => {
  const f = await fixture();
  try {
    const staff = await member(f, "staff");
    const connector = f.store.createConnector({ label: "n8n", scopes: ["business:read"], days: 30 });
    assert.equal((await staff.auth("/api/team/password", "POST", { current: "wrong-password-123", password: "Another-password-456" })).status, 403);
    const changed = await staff.auth("/api/team/password", "POST", { current: memberPassword, password: "Another-password-456" });
    assert.equal(changed.status, 200);
    assert.equal((await staff.auth("/api/workspace")).status, 401, "sessions ended");
    assert.equal(f.store.db.prepare("SELECT revoked FROM integration_tokens WHERE id=?").get(connector.id).revoked, 0);
    await signIn(f, staff.email, "Another-password-456");
    // The core route stays owner-only, because it revokes every connector.
    assert.equal(await outcome(await (await signIn(f, staff.email, "Another-password-456")).auth("/api/password", "POST", {})), "denied");
    await f.json("/api/team/password", "POST", { current: password, password: "Owner-new-password-789" });
    assert.equal(f.store.db.prepare("SELECT revoked FROM integration_tokens WHERE id=?").get(connector.id).revoked, 1);
  } finally {
    await f.close();
  }
});

test("MFA is per user, setup returns a scannable QR code, and the owner can reset a member's authenticator", async () => {
  const f = await fixture();
  try {
    const staff = await member(f, "staff");
    const setup = await staff.json("/api/mfa/begin", "POST", { password: memberPassword });
    assert.match(setup.uri, /^otpauth:\/\/totp\/Nawlogic%3Astaff-[a-z0-9]+%40example\.com\?secret=[A-Z2-7]+&issuer=Nawlogic/);
    assert.match(setup.qr, /^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(setup.qr.split(",")[1], "base64").toString();
    assert.match(svg, /^<svg[^>]+viewBox/);
    await staff.json("/api/mfa/enable", "POST", { password: memberPassword, code: totp(setup.secret) });
    await assert.rejects(signIn(f, staff.email), /Authenticator/);
    await signIn(f, staff.email, memberPassword, totp(setup.secret, Date.now() / 1000 + 30));
    // The owner's own MFA is untouched.
    assert.equal((await f.json("/api/mfa/status")).enabled, false);
    assert.equal((await f.auth(`/api/team/users/${staff.id}/reset-mfa`, "POST", { password: "wrong" })).status, 403);
    const after = await f.json(`/api/team/users/${staff.id}/reset-mfa`, "POST", { password });
    assert.equal(after.mfa, false);
    await signIn(f, staff.email);
    // Owner with MFA must give a code to reset someone else's.
    const me = f.store.db.prepare("SELECT id FROM owners WHERE email='owner@example.com'").get().id;
    const own = beginMfa(f.store, me);
    enableMfa(f.store, me, totp(own.secret), f.store.db.prepare("SELECT hash FROM sessions WHERE csrf=?").get(f.session.csrf).hash);
    assert.equal((await f.auth(`/api/team/users/${staff.id}/reset-mfa`, "POST", { password })).status, 403);
  } finally {
    await f.close();
  }
});

test("module routes follow each module's role rules", async () => {
  const { accessRules, allowed } = await import("../server/team-roles.mjs");
  const { PLUGINS } = await import("../server/plugins.mjs");
  const rules = accessRules(PLUGINS);
  const cases = [
    ["staff", "POST", "/api/ops/time", true],
    ["staff", "PUT", "/api/ops/inventory", false],
    ["staff", "DELETE", "/api/ops/projects/abc", false],
    ["accountant", "GET", "/api/ops/projects/abc", true],
    ["accountant", "POST", "/api/ops/time", false],
    ["staff", "POST", "/api/recurring/schedules/abc/run", true],
    ["staff", "PUT", "/api/recurring/settings", false],
    ["staff", "POST", "/api/recurring/late-fees/abc/waive", false],
    ["accountant", "GET", "/api/recurring/packs/2026-09.zip", true],
    ["accountant", "POST", "/api/recurring/packs/2026-09/send", false],
    ["staff", "POST", "/api/portal/clients/abc/contacts", true],
    ["staff", "PUT", "/api/portal/clients/abc/credit", false],
    ["staff", "POST", "/api/portal/documents/abc/credit-override", false],
    ["accountant", "GET", "/api/portal/feedback.csv", true],
    ["accountant", "DELETE", "/api/portal/contacts/abc", false],
    ["staff", "POST", "/api/books/expenses", true],
    ["staff", "GET", "/api/books/reports/pnl", false],
    ["staff", "POST", "/api/books/bills/abc/void", false],
    ["accountant", "GET", "/api/books/exports/xero/invoices.csv", true],
    ["accountant", "POST", "/api/books/expenses", false],
    ["staff", "POST", "/api/comms/documents/abc/whatsapp", true],
    ["staff", "PUT", "/api/comms/settings", false],
    ["staff", "PUT", "/api/comms/templates/invoice/en", false],
    ["accountant", "GET", "/api/comms/notifications", true],
    ["accountant", "POST", "/api/comms/receipts/abc/email", false],
    ["staff", "POST", "/api/ext/documents/abc/deposit-invoice", true],
    ["staff", "POST", "/api/ext/documents/logo", false],
    ["staff", "POST", "/api/platform/quick/draft", true],
    ["staff", "POST", "/api/platform/webhooks", false],
    ["accountant", "POST", "/api/platform/quick/draft", false],
    ["staff", "POST", "/api/tax/einvoices", true],
    ["staff", "PUT", "/api/tax/settings", false],
    ["staff", "POST", "/api/tax/einvoices/abc/cancel", false],
    ["accountant", "GET", "/api/tax/sst02.csv", true],
    ["staff", "POST", "/api/payments/bank/import", true],
    ["staff", "PUT", "/api/payments/providers/stripe", false],
    ["accountant", "POST", "/api/payments/bank/import", false],
  ];
  for (const [role, method, path, expected] of cases)
    assert.equal(allowed(rules, role, method, path), expected, `${role} ${method} ${path}`);
});
