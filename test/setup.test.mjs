import test from "node:test";
import assert from "node:assert/strict";
import { fixture, issuedInvoice, PNG_1PX } from "./helpers.mjs";
import { member } from "./team-helpers.mjs";
import { MODULES, MODULE_KEYS, moduleOff, navModule, overviewModule, hiddenSettings, ownCompany } from "../public/ext/setup-modules.mjs";

const settingsOf = async (f) => (await f.json("/api/workspace")).settings;

test("modules: everything is on by default; the owner turns one off and on again, kept in settings", async () => {
  const f = await fixture();
  try {
    const before = await settingsOf(f);
    assert.ok(MODULE_KEYS.every((k) => !moduleOff(before, k)), "an existing install keeps every module");
    const off = await f.json("/api/ext/setup", "PUT", { modules: { books: false, orders: false } });
    assert.deepEqual(off.modules, { books: false, orders: false });
    const s = await settingsOf(f);
    assert.equal(s.modules.books, false);
    assert.ok(moduleOff(s, "books") && moduleOff(s, "orders") && !moduleOff(s, "tax"));
    // Saved on the server: another device (a fresh read) sees the same.
    assert.equal(f.store.settings().modules.books, false);
    // Other settings saves keep the choice.
    await f.json("/api/settings", "PUT", { phone: "03-1234 5678" });
    assert.equal((await settingsOf(f)).modules.books, false);
    // Back on: only "off" is stored, so nothing is left behind.
    const on = await f.json("/api/ext/setup", "PUT", { modules: { books: true } });
    assert.deepEqual(on.modules, { orders: false });
    const audit = f.store.db.prepare("SELECT detail FROM audit WHERE action='settings.modules.changed' ORDER BY id").all();
    assert.deepEqual(audit.map((a) => a.detail), ["Turned off: books, orders", "Turned off: orders"]);
  } finally {
    await f.close();
  }
});

test("modules: core pages and unknown names cannot be turned off; values must be true or false", async () => {
  const f = await fixture();
  try {
    for (const body of [{ modules: { invoices: false } }, { modules: { settings: false } }, { modules: { nope: false } }, { modules: { books: "off" } }, { modules: ["books"] }, {}]) {
      const res = await f.auth("/api/ext/setup", "PUT", body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal((await settingsOf(f)).modules, undefined);
  } finally {
    await f.close();
  }
});

test("checklist: hiding it and skipping optional steps persist on the server", async () => {
  const f = await fixture();
  try {
    const hidden = await f.json("/api/ext/setup", "PUT", { dismissed: true });
    assert.match(hidden.setup.dismissed, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal((await settingsOf(f)).setup.dismissed, hidden.setup.dismissed);
    const skip = await f.json("/api/ext/setup", "PUT", { skipped: { sst: true, gateway: true } });
    assert.deepEqual(skip.setup.skipped, ["sst", "gateway"]);
    assert.equal(skip.setup.dismissed, hidden.setup.dismissed, "hiding again keeps the first time");
    await f.json("/api/ext/setup", "PUT", { skipped: { gateway: false }, dismissed: false });
    assert.deepEqual(f.store.settings().setup, { dismissed: null, skipped: ["sst"] });
    // Required steps cannot be skipped.
    for (const step of ["mfa", "backup", "company", "nope"]) {
      const res = await f.auth("/api/ext/setup", "PUT", { skipped: { [step]: true } });
      assert.equal(res.status, 400, step);
    }
    assert.equal((await f.auth("/api/ext/setup", "PUT", { dismissed: "yes" })).status, 400);
  } finally {
    await f.close();
  }
});

test("only the owner changes modules and the checklist; staff, accountants and signed-out requests are refused", async () => {
  const f = await fixture();
  try {
    const staff = await member(f, "staff");
    const accountant = await member(f, "accountant");
    for (const who of [staff, accountant])
      for (const body of [{ modules: { books: false } }, { dismissed: true }, { skipped: { sst: true } }]) {
        const res = await who.auth("/api/ext/setup", "PUT", body);
        assert.equal(res.status, 403, who.email + " " + JSON.stringify(body));
      }
    const signedOut = await f.request("/api/ext/setup", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modules: { books: false } }),
    });
    assert.equal(signedOut.status, 401);
    const s = f.store.settings();
    assert.equal(s.modules, undefined);
    assert.equal(s.setup, undefined);
    // They still read the workspace, with the owner's choice in it.
    await f.json("/api/ext/setup", "PUT", { modules: { tax: false } });
    assert.equal((await staff.json("/api/workspace")).settings.modules.tax, false);
  } finally {
    await f.close();
  }
});

test("branding: signed out, only the business name and whether there is a logo", async () => {
  const f = await fixture({ settings: { phone: "03-5555 0101", bankAccount: "1234567890", bankName: "Test Bank", tin: "C1234567890" } });
  try {
    const get = () => f.request("/api/guest/setup/branding").then(async (r) => ({ status: r.status, body: await r.json() }));
    // A new workspace still has the default name: the sign-in page shows the Nawlogic brand.
    let r = await get();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { company: null, logo: null });
    f.store.saveSettings({ company: "Kedai Runcit Aminah Sdn Bhd" });
    r = await get();
    assert.deepEqual(Object.keys(r.body).sort(), ["company", "logo"]);
    assert.equal(r.body.company, "Kedai Runcit Aminah Sdn Bhd");
    const raw = JSON.stringify(r.body);
    for (const secret of ["billing@example.com", "Test office", "TEST-001", "1234567890", "03-5555", "C1234567890", "owner@example.com"])
      assert.ok(!raw.includes(secret), secret);
    // Only GET.
    const post = await f.request("/api/guest/setup/branding", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(post.status, 404);
    assert.equal((await f.request("/api/guest/setup/other")).status, 404);
  } finally {
    await f.close();
  }
});

test("branding: the logo is served signed out only while it is set; other files stay private", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("/api/guest/setup/logo")).status, 404);
    const up = await f.auth("/api/ext/documents/logo?name=logo.png", "POST", new Uint8Array(PNG_1PX), { "Content-Type": "application/octet-stream" });
    assert.equal(up.status, 201);
    const logo = await up.json();
    const brand = await (await f.request("/api/guest/setup/branding")).json();
    assert.equal(brand.logo, `/api/guest/setup/logo?v=${logo.id.slice(0, 8)}`);
    const res = await f.request(brand.logo);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.match(res.headers.get("content-security-policy"), /sandbox/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG_1PX);
    // The same file through the owner API still needs a session, and so do other files.
    assert.equal((await f.request(`/api/files/${logo.id}`)).status, 401);
    const { invoice } = issuedInvoice(f.store);
    const other = f.store.saveFile({ entity_type: "document", entity_id: invoice.id, purpose: "attachment", name: "private.png", data: PNG_1PX });
    assert.equal((await f.request(`/api/files/${other.id}`)).status, 401);
    assert.equal((await f.request(`/api/guest/setup/logo?id=${other.id}`)).status, 200, "the route serves the logo only, whatever is asked");
    // Removed in Settings > Documents: no longer public.
    assert.equal((await f.auth("/api/ext/documents/logo", "DELETE")).status, 200);
    assert.equal((await f.request("/api/guest/setup/logo")).status, 404);
    assert.equal((await (await f.request("/api/guest/setup/branding")).json()).logo, null);
  } finally {
    await f.close();
  }
});

test("client links never carry the owner's module choices or checklist state", async () => {
  const f = await fixture();
  try {
    await f.json("/api/ext/setup", "PUT", { modules: { books: false }, dismissed: true });
    const { invoice } = issuedInvoice(f.store);
    const { url } = await f.json(`/api/documents/${invoice.id}/share`, "POST", { days: 5 });
    const d = await (await f.request("/api/public/" + url.split("/client/")[1])).json();
    assert.ok(d.business.company);
    assert.equal(d.business.modules, undefined);
    assert.equal(d.business.setup, undefined);
  } finally {
    await f.close();
  }
});

test("module list: every module names its menu entries once, and the default name is not the business's own", () => {
  const nav = MODULES.flatMap((m) => m.nav);
  assert.equal(new Set(nav).size, nav.length);
  assert.equal(new Set(MODULE_KEYS).size, MODULE_KEYS.length);
  for (const core of ["overview", "invoices", "quotes", "clients", "services", "payments", "ledger", "settings", "team"]) assert.equal(navModule(core), null, core);
  assert.equal(navModule("expenses"), "books");
  assert.equal(overviewModule("tax"), "tax");
  assert.equal(overviewModule("team"), null);
  assert.deepEqual([...hiddenSettings({ modules: { books: false, ops: false } })], ["Books", "Operations"]);
  assert.equal(ownCompany({ company: "NAWLOGIC SYSTEMS SOLUTION" }), "");
  assert.equal(ownCompany({ company: "  Bayu Design  " }), "Bayu Design");
});
