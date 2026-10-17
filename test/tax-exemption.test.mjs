import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { today, addDays } from "../server/domain.mjs";
import { fixture } from "./helpers.mjs";

function store() {
  const s = openDatabase(":memory:");
  s.saveSettings({ registration: "TEST-1", address: "Office", email: "t@example.com", sstNumber: "W10-1808-32000001" });
  return s;
}
const taxed = [{ description: "Support", quantity: "1", rate: "100.00", tax_rate: 8 }];
const draft = (s, c, extra = {}) =>
  s.saveDocument({ kind: "invoice", client_id: c.id, issue_date: today(), due_date: addDays(today(), 14), items: taxed, ...extra });

test("client exemption fields are validated and saved without touching other fields", () => {
  const s = store();
  try {
    assert.throws(() => s.saveClient({ name: "X", tax_fields: "1", tax_exempt: "on" }), /exemption reference/);
    assert.throws(() => s.saveClient({ name: "X", tax_fields: "1", tax_exempt_until: "2026-02-30" }), /calendar date/);
    assert.throws(() => s.saveClient({ name: "X", tax_fields: "1", tax_state: "99" }), /state/);
    assert.throws(() => s.saveClient({ name: "X", tax_fields: "1", tax_id_type: "NRIC", brn: "12" }), /NRIC/);
    const c = s.saveClient({ name: "Exempt Co", tax_fields: "1", tax_exempt: "on", tax_exempt_ref: "SC-2026-0099", tax_exempt_until: addDays(today(), 60) });
    assert.equal(c.tax_exempt, 1);
    assert.equal(c.tax_exempt_ref, "SC-2026-0099");
    // An API save without tax fields keeps them.
    const again = s.saveClient({ name: "Exempt Co renamed", email: "a@b.my" }, c.id);
    assert.equal(again.tax_exempt, 1);
    // The client form sends tax_fields, so an unticked box turns the exemption off.
    const off = s.saveClient({ name: "Exempt Co", tax_fields: "1", tax_exempt_ref: "SC-2026-0099" }, c.id);
    assert.equal(off.tax_exempt, 0);
    assert.ok(s.db.prepare("SELECT 1 FROM audit WHERE action='client.tax.changed'").get());
  } finally {
    s.db.close();
  }
});

test("documents for an exempt client charge no SST while the exemption is valid", () => {
  const s = store();
  try {
    const c = s.saveClient({ name: "Exempt", tax_fields: "1", tax_exempt: "on", tax_exempt_ref: "CJ5-001", tax_exempt_until: addDays(today(), 30) });
    const d = draft(s, c);
    assert.equal(d.tax, 0);
    assert.equal(d.items[0].tax_rate, 0);
    assert.equal(d.total, 10000);
    const meta = s.db.prepare("SELECT * FROM tax_doc_meta WHERE document_id=?").get(d.id);
    assert.equal(meta.exempt_ref, "CJ5-001");
    // Later than the expiry date: SST is charged again.
    const late = draft(s, c, { issue_date: addDays(today(), 31), due_date: addDays(today(), 45) });
    assert.equal(late.tax, 800);
    // No expiry date means no end.
    const open = s.saveClient({ name: "Open", tax_fields: "1", tax_exempt: "on", tax_exempt_ref: "B2B-1" });
    assert.equal(draft(s, open).tax, 0);
    const issued = s.issue(d.id);
    assert.equal(issued.client.tax_exempt_ref, "CJ5-001", "the exemption is locked in the client snapshot");
  } finally {
    s.db.close();
  }
});

test("issuing checks the exemption again", () => {
  const s = store();
  try {
    const c = s.saveClient({ name: "Later", tax_fields: "1" });
    const d = draft(s, c);
    assert.equal(d.tax, 800);
    s.saveClient({ name: "Later", tax_fields: "1", tax_exempt: "on", tax_exempt_ref: "SC-1" }, c.id);
    assert.throws(() => s.issue(d.id), /Save the draft again/);
    const saved = draft(s, s.client(c.id));
    assert.equal(saved.tax, 0);
    // The exemption expires before issue: issuing is refused until SST is charged again.
    s.db.prepare("UPDATE clients SET tax_exempt_until=? WHERE id=?").run(addDays(today(), -1), c.id);
    assert.throws(() => s.issue(saved.id), /no longer valid/);
  } finally {
    s.db.close();
  }
});

test("the PDF states the exemption and expired exemptions are listed for the owner", async () => {
  const f = await fixture({ settings: { sstNumber: "W10-1808-32000001" } });
  try {
    const c = f.store.saveClient({ name: "Exempt", tax_fields: "1", tax_exempt: "on", tax_exempt_ref: "SC-7788", tax_exempt_until: addDays(today(), 10) });
    const d = f.store.issue(draft(f.store, c).id);
    const blocks = await f.store.pdfBlocks(f.store.document(d.id));
    assert.deepEqual(blocks.map((b) => b.heading), ["SST exemption"]);
    assert.match(blocks[0].text, /SC-7788/);
    const pdf = await f.auth(`/api/documents/${d.id}/pdf`);
    assert.equal(pdf.status, 200);
    f.store.saveClient({ name: "Expired", tax_fields: "1", tax_exempt: "on", tax_exempt_ref: "OLD-1", tax_exempt_until: addDays(today(), -2) });
    const ws = await f.json("/api/workspace");
    assert.deepEqual(ws.ext.tax.exemptions.expired.map((x) => x.ref), ["OLD-1"]);
    assert.deepEqual(ws.ext.tax.exemptions.expiring.map((x) => x.ref), ["SC-7788"]);
    // The client page shows the exemption, never owner-only details.
    const link = await f.json(`/api/documents/${d.id}/share`, "POST", { days: 5 });
    const pub = await (await f.request("/api/public/" + link.url.split("/client/")[1])).json();
    assert.deepEqual(pub.ext.tax.exemption, { ref: "SC-7788", until: addDays(today(), 10) });
    assert.equal(pub.ext.tax.einvoice, null);
  } finally {
    await f.close();
  }
});
