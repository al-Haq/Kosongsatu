import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { runMigrations } from "../server/migrate.mjs";
import { fixture } from "./helpers.mjs";
import { mailFixture, issued } from "./portal-helpers.mjs";
import { today, addDays } from "../server/domain.mjs";
import portal from "../server/ext/portal.mjs";

test("the primary billing contact and the client's main details stay the same", () => {
  const s = openDatabase(":memory:");
  const c = s.saveClient({ name: "Contact client", contact: "Aina", email: "aina@client.example", phone: "012" });
  let [primary] = s.contacts(c.id);
  assert.deepEqual([primary.name, primary.email, primary.phone, primary.role, primary.primary_billing], ["Aina", "aina@client.example", "012", "billing", 1]);
  s.saveClient({ ...c, contact: "Aina Ali", email: "accounts@client.example" }, c.id);
  [primary] = s.contacts(c.id);
  assert.equal(primary.email, "accounts@client.example", "client form updates the primary contact");
  assert.equal(s.contacts(c.id).length, 1);

  const tech = s.saveContact(c.id, { name: "Hafiz", email: "it@client.example", role: "technical", cc_invoices: true });
  s.saveContact(c.id, { primary_billing: true }, tech.id);
  const client = s.client(c.id);
  assert.deepEqual([client.contact, client.email], ["Hafiz", "it@client.example"], "new primary fills the client details");
  assert.equal(s.contact(tech.id).role, "billing");
  assert.equal(s.contact(primary.id).primary_billing, 0, "old primary demoted");
  assert.equal(s.contacts(c.id).filter((x) => x.primary_billing).length, 1);
  assert.throws(() => s.saveContact(c.id, { primary_billing: false }, tech.id), /another contact/);
  assert.throws(() => s.deleteContact(tech.id), /primary billing contact/);
  s.deleteContact(primary.id);
  assert.equal(s.contacts(c.id).length, 1);
  const audit = s.db.prepare("SELECT action FROM audit WHERE entity_id=? AND action LIKE 'client.contact.%'").all(c.id);
  assert.ok(audit.some((a) => a.action === "client.contact.saved") && audit.some((a) => a.action === "client.contact.deleted"));

  // Clearing the client's main details removes the primary contact; adding them back restores one.
  s.saveClient({ ...s.client(c.id), contact: "", email: "", phone: "" }, c.id);
  assert.equal(s.contacts(c.id).filter((x) => x.primary_billing).length, 0);
  s.saveContact(c.id, { name: "Spare", email: "spare@client.example" });
  s.saveClient({ ...s.client(c.id), email: "SPARE@client.example" }, c.id);
  assert.equal(s.contacts(c.id).length, 1, "a contact with the same email becomes the primary one");
  assert.equal(s.contacts(c.id)[0].primary_billing, 1);
});

test("contact details are validated", () => {
  const s = openDatabase(":memory:");
  const c = s.saveClient({ name: "Validation client", email: "main@client.example" });
  assert.throws(() => s.saveContact(c.id, {}), /name or an email/);
  assert.throws(() => s.saveContact(c.id, { email: "not-an-email" }), /valid email/);
  assert.throws(() => s.saveContact(c.id, { name: "X", role: "boss" }), /billing, technical or other/);
  assert.throws(() => s.saveContact(c.id, { name: "X", portal_access: true }), /needs an email/);
  assert.throws(() => s.saveContact(c.id, { name: "X", cc_invoices: true }), /need an email/);
  assert.throws(() => s.saveContact(c.id, { name: "Dup", email: "MAIN@client.example" }), (e) => e.status === 409);
  const other = s.saveClient({ name: "Other client" });
  const x = s.saveContact(other.id, { name: "Elsewhere", email: "x@other.example" });
  assert.throws(() => s.saveContact(c.id, { name: "Moved" }, x.id), /not found/, "a contact belongs to one client");
  assert.throws(() => s.saveContact(c.id, { name: "<b>ok</b>\u0007" }), /control character/);
});

test("invoices and statements go to the main email with copies for flagged contacts", async () => {
  const f = await mailFixture({ settings: { remindersEnabled: true, reminderBeforeDays: 3 } });
  try {
    const c = f.store.saveClient({ name: "Mail client", contact: "Aina", email: "aina@client.example" });
    f.store.saveContact(c.id, { name: "Boss", email: "boss@client.example", cc_invoices: true });
    f.store.saveContact(c.id, { name: "Tech", email: "tech@client.example", role: "technical" });
    f.store.saveContact(c.id, { name: "Same", email: "copy@client.example", cc_invoices: true });
    assert.deepEqual(await f.json(`/api/portal/clients/${c.id}/recipients`), {
      to: ["aina@client.example"],
      cc: ["boss@client.example", "copy@client.example"],
    });
    assert.deepEqual(f.server.ctx.services.portal.recipients(c.id).cc.length, 2);
    // Automatic reminders copy the flagged contacts too.
    issued(f.store, c, { due: addDays(today(), 3) });
    const run = await f.json("/api/reminders/run", "POST", {});
    assert.equal(run.sent, 1);
    const mail = f.transport.sent.at(-1);
    assert.deepEqual(mail.to, ["aina@client.example"]);
    assert.deepEqual(mail.cc, ["boss@client.example", "copy@client.example"]);
    // Other email kinds are not changed.
    const statement = await f.json(`/api/clients/${c.id}/statement/email`, "POST", { to: "aina@client.example" });
    assert.equal(statement.status, "sent");
    assert.equal(f.transport.sent.at(-1).cc, undefined);
  } finally {
    await f.close();
  }
});

test("owners manage contacts over the API; deleting a client removes its contacts", async () => {
  const f = await fixture();
  try {
    const c = await f.json("/api/clients", "POST", { name: "API client", email: "api@client.example", terms: 14 });
    const added = await f.json(`/api/portal/clients/${c.id}/contacts`, "POST", { name: "Ops", email: "ops@client.example", role: "technical", portal_access: true });
    assert.equal(added.portal_access, 1);
    const changed = await f.json(`/api/portal/contacts/${added.id}`, "PUT", { phone: "03-1234", cc_invoices: true });
    assert.equal(changed.phone, "03-1234");
    assert.equal(changed.cc_invoices, 1);
    assert.equal(changed.portal_access, 1, "fields left out are kept");
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.portal.contacts[c.id].length, 2);
    const primary = ws.ext.portal.contacts[c.id].find((x) => x.primary_billing);
    assert.equal((await f.auth(`/api/portal/contacts/${primary.id}`, "DELETE")).status, 409);
    assert.equal((await f.auth(`/api/portal/contacts/${added.id}`, "DELETE")).status, 200);
    assert.equal((await f.auth(`/api/portal/contacts/${added.id}`, "PUT", { name: "x" })).status, 404);
    assert.equal((await f.request(`/api/portal/clients/${c.id}`)).status, 401, "owner only");
    await f.json(`/api/clients/${c.id}`, "DELETE");
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM portal_contacts WHERE client_id=?").get(c.id).n, 0);
  } finally {
    await f.close();
  }
});

test("the migration gives existing clients a primary billing contact", () => {
  const s = openDatabase(":memory:");
  const a = s.saveClient({ name: "Old A", contact: "Ali", email: "ali@a.example" });
  const b = s.saveClient({ name: "Old B" });
  s.db.exec("DELETE FROM portal_contacts");
  s.db.prepare("DELETE FROM schema_migrations WHERE name='portal-002-primary-contacts'").run();
  assert.deepEqual(runMigrations(s.db, ":memory:", portal.migrations), ["portal-002-primary-contacts"]);
  assert.deepEqual(s.contacts(a.id).map((c) => [c.name, c.email, c.primary_billing]), [["Ali", "ali@a.example", 1]]);
  assert.equal(s.contacts(b.id).length, 0, "nothing to copy");
  assert.match(s.portalPepper(), /^[0-9a-f]{64}$/);
});
