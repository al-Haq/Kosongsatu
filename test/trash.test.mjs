import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { today, addDays } from "../server/domain.mjs";
import { fixture, issuedInvoice, password, PNG_1PX } from "./helpers.mjs";
import { member } from "./team-helpers.mjs";

const audits = (store, action) => store.db.prepare("SELECT * FROM audit WHERE action=? ORDER BY id").all(action);
const raw = (f, path, bytes) => f.auth(path, "POST", new Uint8Array(bytes), { "Content-Type": "application/octet-stream" });
const draftFor = (store, client, b = {}) =>
  store.saveDocument({
    kind: "invoice",
    client_id: client.id,
    issue_date: today(),
    due_date: addDays(today(), 14),
    items: [{ description: "Website care", quantity: 1, rate: "450.00" }],
    ...b,
  });

test("a deleted draft and its attachment come back exactly, with Undo pointing at the copy", async () => {
  const f = await fixture();
  try {
    const client = f.store.saveClient({ name: "Kedai Runcit", email: "kedai@example.com" });
    const d = draftFor(f.store, client, { notes: "Bring the router" });
    const up = await (await raw(f, `/api/ext/documents/${d.id}/attachments?name=site.png`, PNG_1PX)).json();
    const del = await f.auth(`/api/documents/${d.id}`, "DELETE");
    assert.equal(del.status, 200);
    const bin = del.headers.get("x-bin-entry");
    assert.ok(bin, "the delete names the copy it kept");
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM documents WHERE id=?").get(d.id).n, 0);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM files WHERE id=?").get(up.id).n, 0, "the attachment went with it");

    const list = await f.json("/api/trash");
    assert.equal(list.days, 30);
    assert.equal(list.items.length, 1);
    const [item] = list.items;
    assert.deepEqual([item.id, item.what, item.label, item.files, item.deleted_by], [bin, "Invoice draft", "Kedai Runcit · RM 450.00", 1, "owner@example.com"]);
    assert.equal(Math.round((Date.parse(item.expires) - Date.parse(item.deleted)) / 86400000), 30);
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.trash.items[0].id, bin);
    assert.equal(ws.ext.trash.purge, true);

    const back = await f.json(`/api/trash/${bin}/restore`, "POST");
    assert.equal(back.link, `document/${d.id}`);
    const doc = f.store.document(d.id);
    assert.equal(doc.state, "draft");
    assert.equal(doc.total, 45000);
    assert.equal(doc.notes, "Bring the router");
    const file = f.store.file(up.id);
    assert.ok(file.data.equals(PNG_1PX), "file bytes are restored");
    assert.equal((await f.json("/api/trash")).items.length, 0);
    assert.equal(audits(f.store, "trash.restored").length, 1);
    assert.equal((await f.auth(`/api/trash/${bin}/restore`, "POST")).status, 404, "a copy restores once");
  } finally {
    await f.close();
  }
});

test("a record comes back only after what it belongs to", () => {
  const s = openDatabase(":memory:");
  try {
    const c = s.saveClient({ name: "Syarikat Maju", email: "m@example.com" });
    const d = draftFor(s, c);
    s.deleteDraft(d.id);
    s.deleteClient(c.id);
    const [client, draft] = s.trashList();
    assert.equal(client.what, "Client");
    assert.throws(() => s.trashRestore(draft.id), /Restore the client “Syarikat Maju” first/);
    s.trashRestore(client.id);
    s.trashRestore(draft.id);
    assert.equal(s.document(d.id).client_id, c.id);
    // Gone for good: the message says so instead of pointing at the bin.
    const d2 = draftFor(s, c);
    s.deleteDraft(d2.id);
    s.deleteDraft(d.id);
    s.deleteClient(c.id);
    s.trashPurge(s.trashList().find((x) => x.what === "Client").id);
    assert.throws(() => s.trashRestore(s.trashList()[0].id), /client this belonged to no longer exists/);
  } finally {
    s.db.close();
  }
});

test("restoring a draft re-links the billed milestone unless it was billed again since", () => {
  const s = openDatabase(":memory:");
  try {
    s.saveSettings({ registration: "TEST-1", address: "Test office", email: "t@example.com" });
    const c = s.saveClient({ name: "Projek Klien" });
    const p = s.saveProject({ client_id: c.id, name: "Rollout", budget: "10000.00", start_date: today() });
    const m = s.saveMilestone(p.id, { name: "Design", amount: "3000.00" });
    s.setMilestoneReady(m.id, true);
    const d = s.invoiceMilestone(m.id);
    const billed = s.milestones(p.id)[0];
    s.deleteDraft(d.id);
    assert.equal(s.milestones(p.id)[0].invoice_id, null, "the delete releases the milestone");
    const r = s.trashRestore(s.trashList()[0].id);
    const again = s.milestones(p.id)[0];
    assert.deepEqual([again.invoice_id, again.status], [d.id, billed.status]);
    assert.equal(r.note, "");
    // Billed on a new draft in the meantime: the restored draft does not take it back.
    s.deleteDraft(d.id);
    const d2 = s.invoiceMilestone(m.id);
    const r2 = s.trashRestore(s.trashList()[0].id);
    assert.equal(s.milestones(p.id)[0].invoice_id, d2.id);
    assert.match(r2.note, /changed since the delete/);
    // A project and its milestones are one copy.
    s.deleteDraft(d.id);
    s.deleteDraft(d2.id);
    s.deleteProject(p.id);
    const proj = s.trashList().find((x) => x.what === "Project");
    s.trashRestore(proj.id);
    assert.equal(s.milestones(p.id).length, 1);
  } finally {
    s.db.close();
  }
});

test("a recurring plan comes back paused and a webhook endpoint switched off", async () => {
  const f = await fixture();
  try {
    const client = f.store.saveClient({ name: "Langganan Sdn Bhd", email: "l@example.com" });
    const plan = f.store.saveSchedule({ client_id: client.id, lines: [{ description: "Retainer", rate: "1000.00" }], next_date: addDays(today(), -40) });
    assert.equal((await f.auth(`/api/schedules/${plan.id}`, "DELETE")).status, 200);
    const p = (await f.json("/api/trash")).items[0];
    assert.equal(p.what, "Recurring plan");
    const r = await f.json(`/api/trash/${p.id}/restore`, "POST");
    assert.match(r.note, /paused/);
    assert.equal(f.store.db.prepare("SELECT active FROM schedules WHERE id=?").get(plan.id).active, 0);

    const svc = f.server.ctx.services.webhooks;
    svc.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    const hook = await (await f.auth("/api/platform/webhooks", "POST", { url: "https://hooks.example.com/in", events: ["invoice.issued"], password })).json();
    const id = hook.webhook?.id || hook.id;
    const del = await f.auth(`/api/platform/webhooks/${id}`, "DELETE");
    assert.equal(del.status, 200);
    const w = await f.json(`/api/trash/${del.headers.get("x-bin-entry")}/restore`, "POST");
    assert.equal(w.what, "Webhook endpoint");
    assert.match(w.note, /switched off/);
    const row = f.store.db.prepare("SELECT url,active FROM platform_webhooks WHERE id=?").get(id);
    assert.deepEqual([row.url, row.active], ["https://hooks.example.com/in", 0]);
  } finally {
    await f.close();
  }
});

test("staff restore their own deletions; only the owner restores others' or deletes for good", async () => {
  const f = await fixture();
  try {
    const staff = await member(f, "staff");
    const accountant = await member(f, "accountant");
    const client = f.store.saveClient({ name: "Pelanggan Staf", email: "s@example.com" });
    const mineDraft = draftFor(f.store, client);
    const ownerDraft = draftFor(f.store, client);
    assert.equal((await staff.auth(`/api/documents/${mineDraft.id}`, "DELETE")).status, 200);
    assert.equal((await f.auth(`/api/documents/${ownerDraft.id}`, "DELETE")).status, 200);
    const seen = (await staff.json("/api/trash")).items;
    assert.equal(seen.length, 1, "staff see what they deleted");
    assert.equal(seen[0].deleted_by, staff.email);
    assert.equal((await f.json("/api/trash")).items.length, 2, "the owner sees everything");
    const ownerCopy = (await f.json("/api/trash")).items.find((x) => x.deleted_by === "owner@example.com");
    assert.equal((await staff.auth(`/api/trash/${ownerCopy.id}/restore`, "POST")).status, 403);
    assert.equal((await staff.auth(`/api/trash/${seen[0].id}`, "DELETE")).status, 403);
    assert.equal((await accountant.auth("/api/trash")).status, 403);
    assert.equal((await accountant.json("/api/workspace")).ext.trash.items.length, 0);
    await staff.json(`/api/trash/${seen[0].id}/restore`, "POST");
    assert.equal(f.store.document(mineDraft.id).state, "draft");
    assert.equal((await f.auth(`/api/trash/${ownerCopy.id}`, "DELETE")).status, 200);
    assert.equal((await f.json("/api/trash")).items.length, 0);
    assert.equal(audits(f.store, "trash.purged").length, 1);
  } finally {
    await f.close();
  }
});

test("copies expire after 30 days, internal replacements are not kept, and vendors keep unique names", () => {
  const s = openDatabase(":memory:");
  try {
    const c = s.saveClient({ name: "Tamat Tempoh" });
    s.deleteDraft(draftFor(s, c).id);
    assert.equal(s.trashExpire(), 0);
    assert.equal(s.trashExpire(addDays(today(), 31) + "T00:00:00.000Z"), 1);
    assert.equal(s.trashList().length, 0);
    assert.equal(audits(s, "trash.expired").length, 1);
    // A file the app replaces itself (deleteFile) is not a user delete.
    const f = s.saveFile({ entity_type: "settings", entity_id: "logo", purpose: "logo", name: "logo.png", data: PNG_1PX });
    s.deleteFile(f.id);
    assert.equal(s.trashList().length, 0);
    const g = s.saveFile({ entity_type: "settings", entity_id: "logo", purpose: "logo", name: "logo.png", data: PNG_1PX });
    s.removeFile(g.id);
    assert.equal(s.trashList()[0].what, "File");
    // Restoring a vendor never makes two active vendors with one name.
    const v = s.saveVendor({ name: "Parts Co" });
    s.deleteVendor(v.id);
    s.saveVendor({ name: "parts co" });
    assert.throws(() => s.trashRestore(s.trashList().find((x) => x.what === "Vendor").id), /Another vendor is now called Parts Co/);
  } finally {
    s.db.close();
  }
});

test("an expense deleted with a reason (POST …/delete) also offers Undo", async () => {
  const f = await fixture();
  try {
    const e = f.store.saveExpense({ date: today(), vendor_name: "Kedai Alat Tulis", category_id: "office", amount: "85.00", status: "paid", payment_method: "Cash" });
    const res = await f.auth(`/api/books/expenses/${e.id}/delete`, "POST", { reason: "Entered twice" });
    assert.equal(res.status, 200);
    const bin = res.headers.get("x-bin-entry");
    assert.ok(bin);
    const r = await f.json(`/api/trash/${bin}/restore`, "POST");
    assert.equal(r.what, "Expense");
    assert.equal(f.store.expense(e.id).amount, 8500);
  } finally {
    await f.close();
  }
});

test("an issued invoice can still only be voided, never deleted", async () => {
  const f = await fixture();
  try {
    const { invoice } = issuedInvoice(f.store);
    const res = await f.auth(`/api/documents/${invoice.id}`, "DELETE");
    assert.equal(res.status, 409);
    assert.equal(res.headers.get("x-bin-entry"), null);
    assert.equal((await f.json("/api/trash")).items.length, 0);
  } finally {
    await f.close();
  }
});
