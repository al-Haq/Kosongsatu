import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { createOwner } from "../server/auth.mjs";
import { createApp } from "../server/app.mjs";
import { today, addDays } from "../server/domain.mjs";
function fixture() {
  const s = openDatabase(":memory:");
  s.saveSettings({
    registration: "TEST-1",
    address: "Test office",
    email: "test@example.com",
  });
  const c = s.saveClient({ name: "Records client" });
  const draft = (kind = "invoice", client = c.id) =>
    s.saveDocument({
      kind,
      client_id: client,
      issue_date: today(),
      due_date: addDays(today(), 14),
      items: [{ description: "Work", quantity: "1.5", rate: "100.00" }],
      discount: "10.00",
    });
  return { s, c, draft };
}
test("drafts can be deleted with an audit entry; issued and linked documents cannot", () => {
  const { s, c, draft } = fixture();
  try {
    const d = draft();
    s.deleteDraft(d.id);
    assert.throws(() => s.document(d.id), /not found/);
    const audit = s.db
      .prepare("SELECT * FROM audit WHERE action='draft.deleted'")
      .get();
    assert.equal(audit.entity_id, d.id);
    assert.equal(JSON.parse(audit.before_data).total, d.total);
    const issued = s.issue(draft().id);
    assert.throws(() => s.deleteDraft(issued.id), /Only drafts/);
    const service = s.saveService({ name: "Care", rate: "50.00" });
    const sch = s.saveSchedule({
      client_id: c.id,
      service_id: service.id,
      next_date: today(),
    });
    const run = s.runSchedule(sch.id);
    assert.throws(() => s.deleteDraft(run.id), /recurring schedule/);
  } finally {
    s.db.close();
  }
});
test("clients with history are archived, not deleted; archived clients take no new records", () => {
  const { s, c, draft } = fixture();
  try {
    draft();
    assert.throws(() => s.deleteClient(c.id), /Archive the client instead/);
    s.archiveClient(c.id, true);
    assert.equal(s.client(c.id).archived, 1);
    assert.throws(() => draft(), /archived/);
    assert.throws(
      () => s.saveOpportunity({ client_id: c.id, title: "New work" }),
      /archived/,
    );
    s.archiveClient(c.id, false);
    assert.ok(draft().id);
    const empty = s.saveClient({ name: "Unused client" });
    s.deleteClient(empty.id);
    assert.throws(() => s.client(empty.id), /not found/);
  } finally {
    s.db.close();
  }
});
test("archiving a client with an active schedule is refused", () => {
  const { s, c } = fixture();
  try {
    const service = s.saveService({ name: "Care", rate: "50.00" });
    const sch = s.saveSchedule({
      client_id: c.id,
      service_id: service.id,
      next_date: addDays(today(), 3),
    });
    assert.throws(() => s.archiveClient(c.id, true), /Pause/);
    assert.throws(() => s.deleteService(service.id), /schedule uses/);
    s.deleteSchedule(sch.id);
    s.archiveClient(c.id, true);
    s.deleteService(service.id);
  } finally {
    s.db.close();
  }
});
test("schedules can be edited but not moved back over a billed period, and used schedules are kept", () => {
  const { s, c } = fixture();
  try {
    const service = s.saveService({ name: "Care", rate: "50.00" });
    const sch = s.saveSchedule({
      client_id: c.id,
      service_id: service.id,
      next_date: today(),
    });
    s.runSchedule(sch.id);
    assert.throws(
      () => s.updateSchedule(sch.id, { next_date: today() }),
      /after the last generated period/,
    );
    const later = addDays(today(), 40);
    const out = s.updateSchedule(sch.id, { next_date: later, terms: 7 });
    assert.equal(out.next_date, later);
    assert.equal(out.terms, 7);
    assert.throws(() => s.deleteSchedule(sch.id), /Pause it instead/);
  } finally {
    s.db.close();
  }
});
test("duplicate creates an editable draft with the same lines and amounts", () => {
  const { s, draft } = fixture();
  try {
    const original = s.issue(draft().id);
    const copy = s.duplicateDocument(original.id);
    assert.equal(copy.state, "draft");
    assert.equal(copy.number, null);
    assert.deepEqual(copy.items, original.items);
    assert.equal(copy.total, original.total);
    assert.equal(copy.issue_date, today());
  } finally {
    s.db.close();
  }
});
test("HTTP delete requires session, CSRF and origin", async () => {
  const { s, draft } = fixture();
  await createOwner(s, "owner@example.com", "Test-only-password-28");
  const server = createApp({ store: s, appUrl: "http://localhost" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@example.com",
        password: "Test-only-password-28",
      }),
    });
    const { csrf } = await login.json();
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const d = draft();
    const del = (headers) =>
      fetch(base + "/api/documents/" + d.id, { method: "DELETE", headers });
    assert.equal((await del({ Origin: "http://localhost", Cookie: cookie })).status, 403);
    assert.equal((await del({ Origin: "http://evil.example", Cookie: cookie, "X-CSRF-Token": csrf })).status, 403);
    assert.equal((await del({ Origin: "http://localhost" })).status, 401);
    assert.equal(
      (await del({ Origin: "http://localhost", Cookie: cookie, "X-CSRF-Token": csrf })).status,
      200,
    );
    assert.equal((await del({ Origin: "http://localhost", Cookie: cookie, "X-CSRF-Token": csrf })).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
    s.db.close();
  }
});
test("editing a clamped schedule without moving its date keeps the original anchor day", () => {
  const { s, c } = fixture();
  try {
    const service = s.saveService({ name: "Care", rate: "50.00" });
    const sch = s.saveSchedule({
      client_id: c.id,
      service_id: service.id,
      next_date: "2025-01-30",
    });
    s.runSchedule(sch.id);
    const feb = s.db.prepare("SELECT * FROM schedules WHERE id=?").get(sch.id);
    assert.equal(feb.next_date, "2025-02-28");
    const edited = s.updateSchedule(sch.id, { next_date: feb.next_date, terms: 30 });
    assert.equal(edited.anchor_day, 30);
    const moved = s.updateSchedule(sch.id, { next_date: "2025-03-15" });
    assert.equal(moved.anchor_day, 15);
  } finally {
    s.db.close();
  }
});
