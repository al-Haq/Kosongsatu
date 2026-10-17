import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { mailFixture, portalClient, signedIn, issued, pay } from "./portal-helpers.mjs";
import { hash } from "../server/domain.mjs";

const send = (f, path, body) =>
  f.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("a fully paid invoice takes one rating from its client link", async () => {
  const f = await fixture();
  try {
    const c = f.store.saveClient({ name: "Happy client", email: "happy@client.example" });
    const d = issued(f.store, c, { rate: "300.00" });
    const { token } = f.store.share(d.id);
    const url = `/api/guest/portal/link/${token}/feedback`;
    let page = await (await f.request("/api/public/" + token)).json();
    assert.deepEqual(page.ext.portal.feedback, { eligible: false, submitted: false, rating: null });
    assert.equal((await send(f, url, { rating: 5 })).status, 409, "not before full payment");
    pay(f.store, d, "100.00");
    assert.equal((await send(f, url, { rating: 5 })).status, 409, "part-paid is not enough");
    pay(f.store, f.store.document(d.id));
    page = await (await f.request("/api/public/" + token)).json();
    assert.equal(page.ext.portal.feedback.eligible, true);
    for (const rating of [0, 6, "x", 2.5]) assert.equal((await send(f, url, { rating })).status, 400, "rating " + rating);
    const ok = await send(f, url, { rating: 4, comment: "Good job", consent: true, display_name: "Happy Co" });
    assert.equal(ok.status, 201);
    assert.equal((await send(f, url, { rating: 1 })).status, 409, "once per invoice");
    const row = f.store.feedbackFor(d.id);
    assert.deepEqual([row.rating, row.comment, row.consent, row.display_name, row.source, row.testimonial], [4, "Good job", 1, "Happy Co", "link", 0]);
    page = await (await f.request("/api/public/" + token)).json();
    assert.deepEqual(page.ext.portal.feedback, { eligible: false, submitted: true, rating: 4 });
    assert.equal(f.store.db.prepare("SELECT actor FROM audit WHERE action='feedback.received'").get().actor, "client-link");
  } finally {
    await f.close();
  }
});

test("testimonials need consent; the owner lists, averages and exports feedback", async () => {
  const f = await fixture();
  try {
    const c = f.store.saveClient({ name: "=Formula Client" });
    const a = issued(f.store, c),
      b = issued(f.store, c);
    pay(f.store, a);
    pay(f.store, b);
    const yes = f.store.submitFeedback(a.id, { rating: 5, comment: "=HYPERLINK(\"http://x\")", consent: "on" }, "link");
    const no = f.store.submitFeedback(b.id, { rating: 2, comment: "Slow", display_name: "Ignored without consent" }, "portal");
    assert.equal(no.display_name, "");
    assert.equal((await f.auth(`/api/portal/feedback/${no.id}`, "PUT", { testimonial: true })).status, 409);
    assert.equal((await f.json(`/api/portal/feedback/${yes.id}`, "PUT", { testimonial: true })).testimonial, 1);
    const list = await f.json("/api/portal/feedback");
    assert.equal(list.summary.count, 2);
    assert.equal(list.summary.average, 3.5);
    assert.equal(list.summary.testimonials, 1);
    assert.deepEqual(list.summary.counts, [0, 1, 0, 0, 1]);
    assert.equal(list.summary.by_client[c.id].average, 3.5);
    const csv = await (await f.auth("/api/portal/feedback.csv")).text();
    assert.match(csv, /"'=Formula Client"/, "formula cells neutralized");
    assert.match(csv, /"'=HYPERLINK/);
    const only = await (await f.auth("/api/portal/feedback.csv?testimonials=1")).text();
    assert.equal(only.trim().split("\r\n").length, 2, "header and the one testimonial");
    assert.equal((await f.request("/api/portal/feedback.csv")).status, 401);
    assert.ok(f.store.db.prepare("SELECT 1 FROM audit WHERE action='feedback.testimonial.on'").get());
    assert.throws(() => f.store.db.prepare("UPDATE portal_feedback SET testimonial=1 WHERE id=?").run(no.id), /CHECK/);
  } finally {
    await f.close();
  }
});

test("signed-in clients rate their own paid invoices in the portal", async () => {
  const f = await mailFixture();
  try {
    const { client, email } = await portalClient(f);
    const d = issued(f.store, client);
    pay(f.store, d);
    const g = await signedIn(f, email);
    assert.equal((await g.json(`/documents/${d.id}`)).ext.portal.feedback.eligible, true);
    assert.equal((await g.call(`/documents/${d.id}/feedback`, "POST", { rating: 3 })).status, 201);
    assert.equal(f.store.feedbackFor(d.id).source, "portal");
  } finally {
    await f.close();
  }
});

test("feedback request emails are opt-in, sent once per paid invoice and their link works once", async () => {
  const f = await mailFixture();
  const plain = await fixture();
  try {
    assert.equal((await plain.auth("/api/portal/settings", "PUT", { feedback_emails: true })).status, 409, "needs email");
    const c = f.store.saveClient({ name: "Request client", contact: "Aina", email: "aina@client.example" });
    const job = () => f.server.runJob("portal:feedback-requests");
    await job(); // starts the event cursor
    const early = issued(f.store, c);
    pay(f.store, early);
    assert.equal((await job()).sent, 0, "off by default");
    await f.json("/api/portal/settings", "PUT", { feedback_emails: true });
    assert.equal((await job()).sent, 0, "payments from before it was turned on are not asked");

    const d = issued(f.store, c, { rate: "200.00" });
    pay(f.store, d, "50.00");
    assert.equal((await job()).sent, 0, "part payment");
    pay(f.store, f.store.document(d.id));
    const r = await job();
    assert.equal(r.sent, 1);
    const mail = f.transport.sent.at(-1);
    assert.deepEqual(mail.to, ["aina@client.example"]);
    assert.match(mail.subject, /Thank you for your payment/);
    const token = mail.text.match(/\/portal\/feedback\/([\w-]{43})/)[1];
    assert.equal(f.store.db.prepare("SELECT status FROM portal_feedback_requests WHERE invoice_id=?").get(d.id).status, "sent");
    assert.equal(f.store.db.prepare("SELECT token_hash FROM portal_feedback_requests WHERE invoice_id=?").get(d.id).token_hash, hash(token));
    assert.equal(f.store.db.prepare("SELECT kind FROM email_log WHERE dedupe_key=?").get("portal-feedback:" + d.id).kind, "feedback");

    // Another payment event for the same invoice does not ask again.
    f.store.audit("payment.allocated", d.id, "replayed");
    assert.equal((await job()).sent, 0);
    assert.equal(f.transport.sent.filter((m) => /Thank you for your payment/.test(m.subject)).length, 1);

    const info = await f.json(`/api/guest/portal/feedback/${token}`);
    assert.equal(info.number, d.number);
    assert.equal(info.feedback.eligible, true);
    assert.equal(info.client, "Request client");
    assert.equal(Object.keys(info).includes("email"), false);
    const post = (b) => send(f, `/api/guest/portal/feedback/${token}`, b);
    assert.equal((await post({ rating: 5, comment: "Great" })).status, 201);
    assert.equal(f.store.feedbackFor(d.id).source, "email");
    assert.equal((await post({ rating: 1 })).status, 404, "the link is spent");
    assert.equal((await f.request(`/api/guest/portal/feedback/${"k".repeat(43)}`)).status, 404);

    const e = issued(f.store, c);
    pay(f.store, e);
    await job();
    const t2 = f.transport.sent.at(-1).text.match(/\/portal\/feedback\/([\w-]{43})/)[1];
    f.store.db.prepare("UPDATE portal_feedback_requests SET expires=? WHERE invoice_id=?").run(Date.now() - 1, e.id);
    assert.equal((await f.request(`/api/guest/portal/feedback/${t2}`)).status, 404, "expired");
  } finally {
    await f.close();
    await plain.close();
  }
});
