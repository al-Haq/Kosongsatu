import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { mailFixture, portalClient, guest, emailedToken, signedIn, issued, pay, signatureData } from "./portal-helpers.mjs";
import { portalCookie } from "../server/portal-routes.mjs";
import { hash, today, addDays } from "../server/domain.mjs";
import portal from "../server/ext/portal.mjs";
import { gatewayConfiguration, billplzSignature } from "../server/gateway.mjs";

test("magic links are hashed, single use, short lived and do not reveal accounts", async () => {
  const f = await mailFixture();
  try {
    const { client, email } = await portalClient(f);
    f.store.saveContact(client.id, { name: "No access", email: "noaccess@client.example" });
    const unknown = await emailedToken(f, "nobody@nowhere.example");
    const noAccess = await emailedToken(f, "noaccess@client.example");
    const valid = await emailedToken(f, email.toUpperCase());
    for (const r of [unknown, noAccess, valid]) assert.equal(r.res.status, 202);
    const bodies = await Promise.all([unknown, noAccess, valid].map((r) => r.res.json()));
    assert.deepEqual(bodies[0], bodies[2], "same answer with or without an account");
    assert.deepEqual(bodies[1], bodies[2]);
    assert.equal(unknown.mail, undefined);
    assert.equal(noAccess.mail, undefined);
    assert.ok(valid.token, "link emailed to the contact");
    assert.deepEqual(valid.mail.to, [email]);
    assert.match(valid.mail.text, /expires in 15 minutes/);
    const rows = f.store.db.prepare("SELECT * FROM portal_login_tokens").all();
    assert.ok(rows.every((r) => !JSON.stringify(r).includes(valid.token)), "only the hash is stored");
    assert.equal(rows[0].token_hash, hash(valid.token));
    assert.ok(rows[0].expires - Date.now() <= 15 * 60000 + 1000);

    const g = guest(f);
    assert.equal((await g.exchange(valid.token)).status, 200);
    assert.equal((await g.json("/session")).client.name, client.name);
    assert.equal((await guest(f).exchange(valid.token)).status, 401, "a link works once");
    assert.equal((await guest(f).exchange("x".repeat(43))).status, 401);
    assert.equal((await guest(f).exchange("short")).status, 401);

    const late = await emailedToken(f, email);
    f.store.db.prepare("UPDATE portal_login_tokens SET expires=? WHERE token_hash=?").run(Date.now() - 1, hash(late.token));
    const expired = await guest(f).exchange(late.token);
    assert.equal(expired.status, 401);
    assert.match((await expired.json()).error, /invalid, used or expired/);

    // A link sent before access was removed is spent and refused.
    const before = await emailedToken(f, email);
    const contact = f.store.contacts(client.id)[0];
    await f.json(`/api/portal/contacts/${contact.id}`, "PUT", { portal_access: false });
    assert.equal((await guest(f).exchange(before.token)).status, 401);
  } finally {
    await f.close();
  }
});

test("portal sessions use a strict cookie, a CSRF token and the origin check", async () => {
  const f = await mailFixture();
  try {
    const { client, email } = await portalClient(f);
    const invoice = issued(f.store, client);
    const g = guest(f);
    const { token } = await emailedToken(f, email);
    const res = await g.exchange(token);
    const set = res.headers.get("set-cookie");
    assert.match(set, /^nawlogic_portal=[\w-]{43}; Path=\/api\/guest\/portal; HttpOnly; SameSite=Strict; Max-Age=43200$/);
    assert.match(portalCookie("t", true), /; Secure$/, "Secure in production");
    assert.equal((await guest(f).call("/session")).status, 401, "no cookie, no session");

    const path = `/documents/${invoice.id}/payment-reference`;
    const body = JSON.stringify({ reference: "TRX-1" });
    const post = (headers) =>
      f.request("/api/guest/portal" + path, { method: "POST", headers: { Cookie: g.cookie, "Content-Type": "application/json", ...headers }, body });
    assert.equal((await post({})).status, 403, "missing CSRF token");
    assert.equal((await post({ "X-Portal-CSRF": "wrong" })).status, 403);
    assert.equal((await post({ "X-Portal-CSRF": g.csrf, Origin: "https://evil.example" })).status, 403, "cross-site origin");
    assert.equal((await post({ "X-Portal-CSRF": g.csrf })).status, 201);
    assert.equal(f.store.document(invoice.id).proofs.length, 1);
    assert.match(
      f.store.db.prepare("SELECT actor FROM audit WHERE action='payment.reference.submitted'").get().actor,
      /^portal:siti\./,
    );

    const out = await g.call("/signout", "POST", {});
    assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await g.call("/session")).status, 401, "signed out on the server");
    // The owner's session cookie gives no portal access, and the portal cookie no owner access.
    assert.equal((await f.request("/api/guest/portal/session", { headers: { Cookie: f.cookie } })).status, 401);
    const again = await signedIn(f, email);
    assert.equal((await f.request("/api/workspace", { headers: { Cookie: again.cookie } })).status, 401);
  } finally {
    await f.close();
  }
});

test("a client can never reach another client's records", async () => {
  const f = await mailFixture();
  try {
    const a = await portalClient(f, { name: "Alpha Sdn Bhd" });
    const b = await portalClient(f, { name: "Beta Sdn Bhd" });
    const mine = issued(f.store, a.client);
    const theirs = issued(f.store, b.client);
    const theirQuote = issued(f.store, b.client, { kind: "quote" });
    pay(f.store, theirs, "40.00");
    const theirReceipt = f.store.db.prepare("SELECT id FROM cash_receipts WHERE client_id=?").get(b.client.id).id;
    const theirNote = f.store.adjustment(theirs.id, { kind: "credit", amount: "10.00", reason: "Discount" });
    const draft = f.store.saveDocument({ kind: "invoice", client_id: a.client.id, issue_date: today(), due_date: today(), items: [{ description: "Draft", quantity: 1, rate: "5.00" }] });
    const voided = issued(f.store, a.client);
    f.store.void(voided.id, "Mistake");
    f.store.saveCreditSettings(a.client.id, { portal_credit: "1", credit_limit: "5000.00", on_hold: "on", hold_reason: "Secret owner note" });

    const g = await signedIn(f, a.email);
    const overview = await g.json("/overview");
    assert.deepEqual(overview.documents.map((d) => d.id), [mine.id], "only own issued documents");
    assert.deepEqual(overview.receipts, []);
    const text = JSON.stringify(overview);
    for (const secret of ["Secret owner note", "Beta Sdn Bhd", "credit_limit", b.email, "hold"])
      assert.ok(!text.includes(secret), "no owner-only or other-client data: " + secret);

    const attempts = [
      ["GET", `/documents/${theirs.id}`],
      ["GET", `/documents/${theirs.id}/pdf`],
      ["GET", `/documents/${theirQuote.id}/signature`],
      ["GET", `/documents/${draft.id}`],
      ["GET", `/documents/${voided.id}`],
      ["GET", `/receipts/${theirReceipt}/pdf`],
      ["GET", `/notes/${theirNote.id}/pdf`],
      ["POST", `/documents/${theirs.id}/payment-reference`, { reference: "X-1" }],
      ["POST", `/documents/${theirQuote.id}/accept`, { name: "Mallory", agree: true, method: "draw", signature: signatureData() }],
      ["POST", `/documents/${theirs.id}/feedback`, { rating: 1 }],
      ["POST", `/documents/${theirs.id}/checkout`, {}],
      ["GET", `/documents/..%2F${theirs.id}`],
    ];
    for (const [method, path, body] of attempts) {
      const res = await g.call(path, method, body);
      assert.equal(res.status, 404, `${method} ${path}`);
    }
    assert.equal(f.store.document(theirQuote.id).state, "issued");
    assert.equal(f.store.document(theirs.id).proofs.length, 0);
    assert.equal((await g.json(`/documents/${mine.id}`)).id, mine.id);
  } finally {
    await f.close();
  }
});

test("sign-in requests and token checks are rate limited", async () => {
  const f = await mailFixture();
  try {
    const { email } = await portalClient(f);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await emailedToken(f, email)).res.status);
    assert.deepEqual(statuses, [202, 202, 202, 202, 202, 429]);
    assert.equal(f.transport.sent.length, 3, "at most 3 links per address in 15 minutes, silently");
    let last;
    for (let i = 0; i < 21; i++) last = await guest(f).exchange("y".repeat(43));
    assert.equal(last.status, 429);
  } finally {
    await f.close();
  }
});

test("the owner controls access: turning off, signing out, archiving and removing access", async () => {
  const f = await mailFixture();
  try {
    const { client, contact, email } = await portalClient(f);
    let g = await signedIn(f, email);
    assert.equal((await g.call("/session")).status, 200);
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.portal.clients[client.id].portal.sessions, 1);

    await f.json(`/api/portal/clients/${client.id}/sessions/revoke`, "POST", {});
    assert.equal((await g.call("/session")).status, 401);

    g = await signedIn(f, email);
    await f.json(`/api/portal/clients/${client.id}/portal`, "PUT", { enabled: false });
    assert.equal((await g.call("/session")).status, 401);
    assert.equal((await emailedToken(f, email)).mail, undefined, "no links while the portal is off");
    await f.json(`/api/portal/clients/${client.id}/portal`, "PUT", { enabled: true });
    assert.equal((await g.call("/session")).status, 401, "old sessions stay ended");

    // The address has used its 3 sign-in emails for now; the owner's invite still works.
    const invite = await f.json(`/api/portal/clients/${client.id}/invite`, "POST", { contact_id: contact.id, copy: true });
    g = guest(f);
    assert.equal((await g.exchange(invite.url.split("/").pop())).status, 200);
    await f.json(`/api/clients/${client.id}/archive`, "POST", {});
    assert.equal((await g.call("/session")).status, 401, "archived clients cannot use the portal");
    await f.json(`/api/clients/${client.id}/restore`, "POST", {});
    assert.equal((await g.call("/session")).status, 200);

    await f.json(`/api/portal/contacts/${contact.id}`, "PUT", { portal_access: false });
    assert.equal((await g.call("/session")).status, 401);
    const audit = f.store.db.prepare("SELECT action FROM audit WHERE entity_id=? AND action LIKE 'portal.%'").all(client.id).map((r) => r.action);
    for (const a of ["portal.enabled", "portal.signed_in", "portal.sessions.revoked", "portal.disabled"]) assert.ok(audit.includes(a), a);
  } finally {
    await f.close();
  }
});

test("long-lived access links open the portal until revoked or expired", async () => {
  const f = await fixture();
  try {
    const client = f.store.saveClient({ name: "No email client" });
    assert.equal((await f.auth(`/api/portal/clients/${client.id}/links`, "POST", { days: 30 })).status, 409, "portal must be on");
    await f.json(`/api/portal/clients/${client.id}/portal`, "PUT", { enabled: true });
    const link = await f.json(`/api/portal/clients/${client.id}/links`, "POST", { label: "Office tablet", days: 90 });
    assert.match(link.url, /^http:\/\/localhost\/portal\/access\/[\w-]{43}$/);
    const token = link.url.split("/").pop();
    assert.ok(!JSON.stringify(f.store.db.prepare("SELECT * FROM portal_links").all()).includes(token));
    const g1 = guest(f),
      g2 = guest(f);
    assert.equal((await g1.exchange(token, "access")).status, 200);
    assert.equal((await g2.exchange(token, "access")).status, 200, "reusable until revoked");
    assert.equal((await g1.json("/session")).contact, null);
    assert.ok(f.store.db.prepare("SELECT last_used FROM portal_links").get().last_used);

    await f.json(`/api/portal/links/${link.id}/revoke`, "POST", {});
    assert.equal((await g1.call("/session")).status, 401, "revoking ends its sessions");
    assert.equal((await guest(f).exchange(token, "access")).status, 401);

    const old = await f.json(`/api/portal/clients/${client.id}/links`, "POST", { days: 1 });
    f.store.db.prepare("UPDATE portal_links SET expires=? WHERE id=?").run(Date.now() - 1, old.id);
    assert.equal((await guest(f).exchange(old.url.split("/").pop(), "access")).status, 401);
    assert.equal((await f.auth(`/api/portal/clients/${client.id}/links`, "POST", { days: 999 })).status, 400);
  } finally {
    await f.close();
  }
});

test("invites are emailed when mail is set up, or handed to the owner to copy", async () => {
  const f = await mailFixture();
  const plain = await fixture();
  try {
    const { client, contact } = await portalClient(f);
    const sent = await f.json(`/api/portal/clients/${client.id}/invite`, "POST", { contact_id: contact.id });
    assert.equal(sent.sent, true);
    const mail = f.transport.sent.at(-1);
    assert.deepEqual(mail.to, [contact.email]);
    const token = mail.text.match(/\/portal\/login\/([\w-]{43})/)[1];
    const row = f.store.db.prepare("SELECT * FROM portal_login_tokens WHERE token_hash=?").get(hash(token));
    assert.equal(row.purpose, "invite");
    assert.ok(row.expires - Date.now() > 70 * 3600000, "invites last 3 days");
    const copy = await f.json(`/api/portal/clients/${client.id}/invite`, "POST", { contact_id: contact.id, copy: true });
    assert.match(copy.url, /\/portal\/login\/[\w-]{43}$/);
    assert.equal((await guest(f).exchange(copy.url.split("/").pop())).status, 200);
    const other = f.store.saveContact(client.id, { name: "Tech", email: "tech@client.example" });
    assert.equal((await f.auth(`/api/portal/clients/${client.id}/invite`, "POST", { contact_id: other.id })).status, 409, "needs portal access");

    const p = await portalClient(plain);
    const r = await plain.json(`/api/portal/clients/${p.client.id}/invite`, "POST", { contact_id: p.contact.id });
    assert.equal(r.sent, false, "without email the owner copies the link");
    assert.equal((await guest(plain).exchange(r.url.split("/").pop())).status, 200);
    assert.equal((await plain.json("/api/guest/portal/config")).email_signin, false);
  } finally {
    await f.close();
    await plain.close();
  }
});

test("portal actions reuse the document logic without touching the client link", async () => {
  const f = await mailFixture({ settings: { bankAccount: "123", bankName: "Bank", bankHolder: "Nawlogic" } });
  try {
    const { client, email } = await portalClient(f);
    const quote = issued(f.store, client, { kind: "quote" });
    const invoice = issued(f.store, client, { rate: "250.00" });
    f.store.share(quote.id);
    const linkBefore = f.store.db.prepare("SELECT token_hash,token_expires FROM documents WHERE id=?").get(quote.id);
    const g = await signedIn(f, email);
    const d = await g.json(`/documents/${quote.id}`);
    assert.equal(d.kind, "quote");
    assert.equal(d.client.email, undefined, "client-safe fields only");
    assert.equal(f.store.document(quote.id).status, "Viewed");
    const accepted = await g.json(`/documents/${quote.id}/accept`, "POST", {
      name: "Siti Aminah",
      agree: true,
      method: "draw",
      signature: signatureData(),
    });
    assert.equal(accepted.state, "accepted");
    assert.deepEqual(f.store.db.prepare("SELECT token_hash,token_expires FROM documents WHERE id=?").get(quote.id), linkBefore);
    assert.ok(f.store.db.prepare("SELECT 1 FROM automation_events WHERE type='quote.accepted' AND entity_id=?").get(quote.id));
    assert.equal(f.store.signature(quote.id).source, "portal");
    assert.equal((await g.call(`/documents/${quote.id}/signature`)).headers.get("content-type"), "image/png");

    pay(f.store, invoice, "100.00");
    f.store.adjustment(invoice.id, { kind: "credit", amount: "50.00", reason: "Goodwill" });
    const overview = await g.json("/overview");
    assert.equal(overview.totals.outstanding, 10000);
    assert.equal(overview.receipts.length, 1);
    assert.equal(overview.notes.length, 1);
    for (const path of [
      `/documents/${invoice.id}/pdf`,
      `/receipts/${overview.receipts[0].id}/pdf`,
      `/notes/${overview.notes[0].id}/pdf`,
      `/statement.pdf?from=${addDays(today(), -30)}&to=${today()}`,
    ]) {
      const res = await g.call(path);
      assert.equal(res.status, 200, path);
      assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
    }
    const ref = await g.json(`/documents/${invoice.id}/payment-reference`, "POST", { reference: "IBG-778" });
    assert.equal(ref.reference, "IBG-778");
    assert.equal((await g.call(`/documents/${invoice.id}/checkout`, "POST", {})).status, 503, "online payment not configured");
  } finally {
    await f.close();
  }
});

test("a restored database does not honour portal sessions or links", async () => {
  const f = await fixture();
  try {
    const client = f.store.saveClient({ name: "Restore client" });
    await f.json(`/api/portal/clients/${client.id}/portal`, "PUT", { enabled: true });
    const link = await f.json(`/api/portal/clients/${client.id}/links`, "POST", { days: 30 });
    const g = guest(f);
    await g.exchange(link.url.split("/").pop(), "access");
    portal.onRestore(f.store.db);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM portal_sessions").get().n, 0);
    assert.ok(f.store.db.prepare("SELECT revoked_at FROM portal_links").get().revoked_at);
    assert.equal((await g.call("/session")).status, 401);
    const exported = await f.json("/api/backup");
    assert.ok(!JSON.stringify(exported.ext.portal).includes("token_hash"));
  } finally {
    await f.close();
  }
});

test("online payment from the portal returns to the portal and settles only this client's bill", async () => {
  const bills = new Map();
  let n = 0;
  const fetcher = async (url, init) => {
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith("/bills") && init.method === "POST") {
      const b = Object.fromEntries(new URLSearchParams(init.body));
      const bill = {
        id: "pbill" + ++n,
        collection_id: b.collection_id,
        amount: Number(b.amount),
        paid: false,
        state: "due",
        url: "https://www.billplz-sandbox.com/bills/pbill" + n,
        redirect_url: b.redirect_url,
      };
      bills.set(bill.id, bill);
      return json(200, bill);
    }
    const bill = bills.get(url.split("/bills/")[1]);
    return bill ? json(200, bill) : json(404, {});
  };
  const config = gatewayConfiguration({
    BILLPLZ_API_KEY: "k",
    BILLPLZ_COLLECTION_ID: "col1",
    BILLPLZ_X_SIGNATURE_KEY: "sig",
    BILLPLZ_SANDBOX: "true",
  });
  const f = await mailFixture({ app: { gatewayConfig: config, gatewayFetch: fetcher } });
  try {
    const a = await portalClient(f);
    const b = await portalClient(f);
    const invoice = issued(f.store, a.client, { rate: "250.00" });
    const other = issued(f.store, b.client, { rate: "99.00" });
    const g = await signedIn(f, a.email);
    assert.equal((await g.json(`/documents/${invoice.id}`)).online_payment, true);
    const { url } = await g.json(`/documents/${invoice.id}/checkout`, "POST", {});
    assert.match(url, /^https:\/\//);
    assert.equal(bills.get("pbill1").redirect_url, `http://localhost/portal/d/${invoice.id}`, "back to the portal page");
    Object.assign(bills.get("pbill1"), { paid: true, state: "paid", paid_amount: 25000 });
    const params = { "billplz[id]": "pbill1", "billplz[paid]": "true" };
    const signedParams = { ...params, "billplz[x_signature]": billplzSignature(params, "sig") };
    // A bill paid for one invoice cannot be claimed through another document.
    const mine = issued(f.store, a.client, { rate: "10.00" });
    assert.equal((await g.call(`/documents/${mine.id}/payment-return`, "POST", { params: signedParams })).status, 404);
    assert.equal((await g.call(`/documents/${other.id}/payment-return`, "POST", { params: signedParams })).status, 404);
    const forged = { ...params, "billplz[x_signature]": "0".repeat(64) };
    assert.equal((await g.call(`/documents/${invoice.id}/payment-return`, "POST", { params: forged })).status, 403);
    assert.equal((await g.json(`/documents/${invoice.id}/payment-return`, "POST", { params: signedParams })).state, "paid");
    assert.equal(f.store.document(invoice.id).balance, 0);
  } finally {
    await f.close();
  }
});
