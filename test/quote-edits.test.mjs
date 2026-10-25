// Issued quotations can still be edited until the client accepts them; the
// activity says what each save changed, and only the owner sees it.
import test from "node:test";
import assert from "node:assert/strict";
import { documentChanges, auditChanges } from "../public/ext/doc-changes.mjs";
import { today, addDays } from "../server/domain.mjs";
import { fixture } from "./helpers.mjs";
import { member } from "./team-helpers.mjs";
import { signatureData } from "./portal-helpers.mjs";

const line = (description, quantity, rate, extra = {}) => ({ description, quantity, rate, tax_rate: 0, ...extra });

test("the activity names what changed: rates, quantities, titles, descriptions, lines, dates, terms and totals", () => {
  const before = {
    client_id: "c1",
    issue_date: "2026-10-25",
    due_date: "2026-11-08",
    discount: 0,
    total: 2316000,
    terms: "50% deposit",
    notes: "",
    items: [line("Asus Vivobook 16", 6, 380000), line("Mouse", 6, 6000), line("Bag", 1, 9000), line("Less deposit", 1, -1000, { deposit_id: "x" })],
  };
  const after = {
    ...before,
    client_id: "c2",
    due_date: "2026-11-11",
    discount: 10000,
    total: 2330000,
    terms: "50% deposit, balance on delivery",
    items: [
      line("Asus Vivobook 16", 5, 386000, { details: "- 16GB RAM" }),
      line("Wireless mouse", 6, 6000),
      line("Setup", 1, 15000),
      line("Less deposit", 1, -2000, { deposit_id: "x" }),
    ],
  };
  const names = { c1: "Aizat Arshad & Co.", c2: "Vatex Sdn Bhd" };
  assert.deepEqual(documentChanges(before, after, { clientName: (id) => names[id], dueLabel: "Valid until" }), [
    "Client: Aizat Arshad & Co. → Vatex Sdn Bhd",
    "Valid until: 2026-11-08 → 2026-11-11",
    "Line 1 “Asus Vivobook 16”: quantity 6 → 5, rate 3,800.00 → 3,860.00, description added",
    "Line 2 “Mouse”: title “Mouse” → “Wireless mouse”",
    "Line 3 “Bag”: title “Bag” → “Setup”, rate 90.00 → 150.00",
    "Document discount: 0.00 → 100.00",
    "Terms and conditions changed",
    "Total: 23,160.00 → 23,300.00",
  ]);
  // A line retyped in the same place reads as a new title there.
  const moved = documentChanges(
    { ...before, items: [line("A", 1, 100), line("B", 1, 200), line("C", 1, 300)] },
    { ...before, items: [line("A", 1, 100), line("New", 2, 50), line("C", 1, 300)] },
  );
  assert.deepEqual(moved, ["Line 2 “B”: title “B” → “New”, quantity 1 → 2, rate 2.00 → 0.50"]);
  const added = documentChanges({ ...before, items: [line("A", 1, 100)] }, { ...before, items: [line("A", 1, 100), line("B", 2, 50)] });
  assert.deepEqual(added, ["Added line 2 “B”: 2 × 0.50"]);
  const removed = documentChanges({ ...before, items: [line("A", 1, 100), line("B", 2, 50)] }, { ...before, items: [line("B", 2, 50)] });
  assert.deepEqual(removed, ["Removed line “A” (1 × 1.00)"]);
  assert.deepEqual(documentChanges(null, { ...before, items: [line("A", 1, 100)], total: 100 }), ["Created with 1 line, total 1.00"]);
  assert.deepEqual(documentChanges(before, before), []);
  assert.equal(auditChanges({ action: "document.issued", after_data: "{}" }), null, "only document saves are compared");
});

test("an issued quotation can be edited until accepted: same number, client and issue date; the change is audited", async () => {
  const f = await fixture();
  try {
    const s = f.store;
    const c = s.saveClient({ name: "Aizat Arshad & Co.", email: "a@example.com" });
    const other = s.saveClient({ name: "Someone else", email: "x@example.com" });
    const body = (rate, extra = {}) => ({
      kind: "quote",
      client_id: c.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      items: [{ description: "Asus Vivobook 16", quantity: "6", rate }],
      terms: "Valid 14 days",
      ...extra,
    });
    const q = s.issue(s.saveDocument(body("3800.00")).id);
    // Over HTTP, as the editor sends it: another client and issue date are ignored.
    const res = await f.auth(
      `/api/documents/${q.id}`,
      "PUT",
      body("3860.00", { client_id: other.id, issue_date: addDays(today(), -3), due_date: addDays(today(), 17) }),
    );
    assert.equal(res.status, 200);
    const edited = await res.json();
    assert.equal(edited.number, q.number, "keeps its number");
    assert.equal(edited.state, "issued");
    assert.equal(edited.client_id, c.id, "the client stays as issued");
    assert.equal(edited.issue_date, q.issue_date, "the issue date stays as issued");
    assert.equal(edited.due_date, addDays(today(), 17), "validity can change");
    assert.equal(edited.total, 2316000);
    const row = s.db.prepare("SELECT * FROM audit WHERE action='document.revised' AND entity_id=?").get(q.id);
    assert.equal(row.detail, `${q.number} edited after issue`);
    assert.deepEqual(auditChanges(row, { dueLabel: "Valid until" }), [
      `Valid until: ${addDays(today(), 14)} → ${addDays(today(), 17)}`,
      "Line 1 “Asus Vivobook 16”: rate 3,800.00 → 3,860.00",
      "Total: 22,800.00 → 23,160.00",
    ]);
    // Once accepted it is locked, with a way forward.
    s.acceptOffline(q.id, { name: "Verified customer", evidence: "Customer email reference TEST-1" });
    const locked = await f.auth(`/api/documents/${q.id}`, "PUT", body("1.00"));
    assert.equal(locked.status, 409);
    assert.match((await locked.json()).error, /accepted quotation can't be edited\. Duplicate it/);
    // Issued invoices stay locked.
    const inv = s.issue(s.saveDocument({ ...body("1.00"), kind: "invoice" }).id);
    const invPut = await f.auth(`/api/documents/${inv.id}`, "PUT", { ...body("2.00"), kind: "invoice" });
    assert.equal(invPut.status, 409);
    assert.throws(() => s.reviseQuote(inv.id, body("2.00")), /locked/);
  } finally {
    await f.close();
  }
});

test("staff can edit an issued quotation; only the owner gets the activity history", async () => {
  const f = await fixture();
  try {
    const s = f.store;
    const c = s.saveClient({ name: "Client", email: "c@example.com" });
    const q = s.issue(
      s.saveDocument({
        kind: "quote",
        client_id: c.id,
        issue_date: today(),
        due_date: addDays(today(), 14),
        items: [{ description: "Work", quantity: "1", rate: "100.00" }],
      }).id,
    );
    const staff = await member(f, "staff");
    const accountant = await member(f, "accountant");
    const put = await staff.auth(`/api/documents/${q.id}`, "PUT", {
      kind: "quote",
      client_id: c.id,
      issue_date: q.issue_date,
      due_date: q.due_date,
      items: [{ description: "Work", quantity: "2", rate: "100.00" }],
    });
    assert.equal(put.status, 200, "staff may edit it");
    assert.equal((await accountant.auth(`/api/documents/${q.id}`, "PUT", {})).status, 403, "accountants are read-only");

    const owner = await f.json("/api/workspace");
    assert.ok(
      owner.audit.some((a) => a.action === "document.revised" && a.entity_id === q.id),
      "the owner sees who changed what",
    );
    for (const who of [staff, accountant]) {
      const ws = await who.json("/api/workspace");
      assert.deepEqual(ws.audit, [], "no history for other team members");
    }
    const exported = await accountant.json("/api/backup");
    assert.deepEqual(exported.audit, [], "nor in the accountant's data export");
    assert.ok((await f.json("/api/backup")).audit.length > 0, "the owner's export keeps it");
  } finally {
    await f.close();
  }
});

test("terms and conditions can be up to 4000 characters", async () => {
  const f = await fixture();
  try {
    const c = f.store.saveClient({ name: "Client" });
    const doc = (terms) => ({
      kind: "quote",
      client_id: c.id,
      issue_date: today(),
      due_date: today(),
      items: [{ description: "Work", quantity: 1, rate: "1.00" }],
      terms,
    });
    assert.equal(f.store.saveDocument(doc("T".repeat(4000))).terms.length, 4000);
    assert.throws(() => f.store.saveDocument(doc("T".repeat(4001))), /4000 characters/);
    f.store.saveSettings({ ...f.store.settings(), paymentTerms: "D".repeat(4000) });
    assert.equal(f.store.settings().paymentTerms.length, 4000, "the company default too");
  } finally {
    await f.close();
  }
});

test("a client can only accept the version they were shown: an edit made meanwhile asks them to reload", async () => {
  const f = await fixture();
  try {
    const s = f.store;
    const c = s.saveClient({ name: "Client", email: "c@example.com" });
    const body = (rate) => ({
      kind: "quote",
      client_id: c.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      items: [{ description: "Work", quantity: "1", rate }],
    });
    const q = s.issue(s.saveDocument(body("100.00")).id);
    const { token } = s.share(q.id);
    const shown = await (await f.request(`/api/public/${token}`)).json();
    assert.match(shown.revision, /^[0-9a-f]{24}$/);
    // The owner edits the price while the client reads the old one.
    s.reviseQuote(q.id, body("150.00"));
    const accept = (extra) =>
      f.request(`/api/public/${token}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Aminah", ...extra }),
      });
    for (const stale of [{ revision: shown.revision }, {}]) {
      const r = await accept(stale);
      assert.equal(r.status, 409);
      assert.match((await r.json()).error, /changed after you opened it\. Reload/);
    }
    assert.equal(s.document(q.id).state, "issued", "not accepted");
    // Signing from the link is held to the same rule.
    const sign = (revision) =>
      f.request(`/api/guest/portal/link/${token}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Aminah", agree: true, method: "draw", signature: signatureData(), revision }),
      });
    assert.equal((await sign(shown.revision)).status, 409);
    // After reloading, the new version is accepted.
    const fresh = await (await f.request(`/api/public/${token}`)).json();
    assert.notEqual(fresh.revision, shown.revision);
    assert.equal(fresh.total, 15000);
    assert.equal((await sign(fresh.revision)).status, 200);
    assert.equal(s.document(q.id).state, "accepted");
  } finally {
    await f.close();
  }
});
