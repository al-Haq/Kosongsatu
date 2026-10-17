import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../server/db.mjs";
import { today, addDays, calculate } from "../server/domain.mjs";
import { scaleLines } from "../server/ops-po.mjs";
import { runMigrations } from "../server/migrate.mjs";
import { OPS_MIGRATIONS } from "../server/ext/ops.mjs";
import { fixture, PNG_1PX } from "./helpers.mjs";

function setup(items = [{ description: "Integration", quantity: 1, rate: "1000.00" }], discount = "0") {
  const s = openDatabase(":memory:");
  s.saveSettings({ registration: "TEST-1", address: "Test office", email: "test@example.com", sstNumber: "W10-1808-32000001" });
  const c = s.saveClient({ name: "PO customer" });
  const quote = () => {
    const q = s.issue(
      s.saveDocument({ kind: "quote", client_id: c.id, issue_date: today(), due_date: addDays(today(), 14), items, discount }).id,
    );
    return s.acceptOffline(q.id, { name: "Buyer", evidence: "Signed email" });
  };
  return { s, c, quote };
}
const po = (s, q, reference, amount, extra = {}) => s.registerPO({ quote_id: q.id, reference, amount, po_date: today(), ...extra });

test("partial POs share a quotation but together never exceed it", () => {
  const { s, quote } = setup();
  try {
    const q = quote();
    const a = po(s, q, "PO-A", "400.00");
    const b = po(s, q, "PO-B", "500.00");
    assert.throws(() => po(s, q, "PO-C", "100.01"), /exceeds/);
    po(s, q, "PO-C", "100.00");
    assert.throws(() => po(s, q, "PO-D", "0.01"), /exceeds/);
    assert.throws(() => po(s, q, "po-a", "1.00"), /already registered/, "references stay unique per customer");
    assert.throws(() => po(s, q, "PO-Z", "1.00", { po_date: addDays(today(), 1) }), /future/);
    assert.equal(s.sales().purchaseOrders.filter((p) => p.quote_id === q.id).length, 3);
    assert.equal(a.revision, 0);
    assert.equal(s.db.prepare("SELECT count(*) n FROM ops_po_revisions").get().n, 3);
    // The whole quotation can no longer be converted around its POs.
    assert.throws(() => s.convert(q.id), /partial customer POs/);
    assert.throws(() => s.invoiceFromQuote(q.id), /several customer POs/);
    assert.ok(b.id);
  } finally {
    s.db.close();
  }
});

test("a partial PO invoices exactly its own amount, once, with SST kept per line", () => {
  const items = [
    { description: "Network design", quantity: 1, rate: "3000.00", tax_rate: 8 },
    { description: "Hardware", quantity: 3, rate: "1234.57", tax_rate: 10 },
    { description: "Training", quantity: 2, rate: "333.33", tax_rate: 0 },
  ];
  const { s, quote } = setup(items, "150.00");
  try {
    const q = quote();
    const amounts = [Math.floor(q.total * 0.37), Math.floor(q.total * 0.41)];
    amounts.push(q.total - amounts[0] - amounts[1]);
    const pos = amounts.map((a, n) => po(s, q, "SPLIT-" + n, (a / 100).toFixed(2)));
    const invoices = pos.map((p) => s.invoiceFromQuote(q.id, p.id));
    for (const [n, d] of invoices.entries()) {
      assert.equal(d.kind, "invoice");
      assert.equal(d.state, "draft");
      assert.equal(d.total, amounts[n], "invoice total is the PO amount to the sen");
      assert.ok(d.notes.includes("SPLIT-" + n));
      assert.equal(d.source_quote, null);
      // Each line's SST is the line rate on the scaled line.
      for (const i of d.items) assert.equal(i.tax, Math.round((i.taxable * i.tax_rate) / 100));
      assert.deepEqual(new Set(d.items.map((i) => i.tax_rate)), new Set([8, 10, 0]));
    }
    assert.equal(invoices.reduce((t, d) => t + d.total, 0), q.total, "the POs bill the quotation exactly once");
    assert.equal(s.invoiceFromQuote(q.id, pos[0].id).id, invoices[0].id, "invoicing a PO again returns its draft");
    assert.equal(s.documents().filter((d) => d.kind === "invoice").length, 3);
    // A PO's draft may be edited but never above the PO.
    const d = invoices[0];
    const edit = (rate) =>
      s.saveDocument(
        {
          client_id: d.client_id,
          issue_date: d.issue_date,
          due_date: d.due_date,
          items: [{ description: "Edited", quantity: 1, rate }],
        },
        d.id,
      );
    assert.throws(() => edit(((amounts[0] + 1) / 100).toFixed(2)), /cannot be more than the PO/);
    edit(((amounts[0] - 500) / 100).toFixed(2));
    assert.equal(s.issue(d.id).state, "issued");
  } finally {
    s.db.close();
  }
});

test("scaling is exact for every split, or the closest total below the PO", () => {
  const rows = [
    [{ description: "A", quantity: 1, rate: "10000.00", tax_rate: 8 }],
    [{ description: "A", quantity: 1, rate: "0.05", tax_rate: 10 }],
    [
      { description: "A", quantity: 1, rate: "999.99", tax_rate: 6 },
      { description: "B", quantity: 7, rate: "13.13", tax_rate: 5 },
    ],
  ];
  for (const items of rows) {
    const q = calculate(items, "0");
    for (let p = 1; p <= q.total; p += Math.max(1, Math.floor(q.total / 397))) {
      const scaled = scaleLines(q.items, q.discount, p);
      const again = calculate(
        scaled.lines.map((l) => ({ description: l.description, quantity: "1", rate: (l.net / 100).toFixed(2), tax_rate: l.rate })),
        "0",
      );
      assert.equal(again.total, scaled.total);
      assert.ok(again.total <= p, "never more than the PO");
      assert.ok(p - again.total <= 1, `within a sen of ${p} (got ${again.total})`);
      if (items.length > 1) assert.equal(again.total, p, "two taxed lines can always reach the exact amount");
    }
  }
});

test("a full-value PO keeps the original conversion; partial POs refuse an existing full invoice", () => {
  const { s, quote } = setup();
  try {
    const q = quote();
    const full = po(s, q, "FULL-1", "1000.00");
    const d = s.invoiceFromQuote(q.id, full.id);
    assert.equal(d.source_quote, q.id);
    assert.equal(d.total, q.total);
    assert.throws(() => po(s, q, "MORE", "1.00"), /exceeds/);
    const q2 = quote();
    s.convert(q2.id);
    assert.throws(() => po(s, q2, "PART", "100.00"), /already has a full invoice/);
    po(s, q2, "FULL-2", "1000.00");
  } finally {
    s.db.close();
  }
});

test("amendments keep a revision history, respect invoicing and are audited", () => {
  const { s, quote } = setup();
  try {
    const q = quote();
    const a = po(s, q, "AMEND-1", "600.00");
    po(s, q, "AMEND-2", "300.00");
    assert.throws(() => s.amendPO(a.id, { reason: "", amount: "650.00" }), /Required/);
    assert.throws(() => s.amendPO(a.id, { reason: "No change", amount: "600.00" }), /Nothing changed/);
    assert.throws(() => s.amendPO(a.id, { reason: "Too big", amount: "700.01" }), /exceeds/);
    const r1 = s.amendPO(a.id, { reason: "Customer revised PO", amount: "700.00", reference: "AMEND-1A" });
    assert.equal(r1.revision, 1);
    assert.equal(r1.amount, 70000);
    // A draft invoice blocks an amount change unless the owner removes it.
    const d = s.invoiceFromQuote(q.id, a.id);
    assert.equal(d.total, 70000);
    assert.throws(() => s.amendPO(a.id, { reason: "Down", amount: "650.00" }), /draft invoice/);
    const r2 = s.amendPO(a.id, { reason: "Down", amount: "650.00", replace_draft: true });
    assert.equal(r2.invoice_id, null);
    assert.throws(() => s.document(d.id), /not found/);
    const d2 = s.invoiceFromQuote(q.id, a.id);
    assert.equal(d2.total, 65000);
    // Reference changes follow the draft's PO note.
    s.amendPO(a.id, { reason: "Typo", reference: "AMEND-1B" });
    assert.ok(s.document(d2.id).notes.includes("Customer PO: AMEND-1B"));
    s.issue(d2.id);
    assert.throws(() => s.amendPO(a.id, { reason: "Late change", amount: "600.00" }), /credit or debit note/);
    s.amendPO(a.id, { reason: "Date correction", po_date: addDays(today(), -1) });
    const detail = s.poDetail(a.id);
    assert.deepEqual(detail.revisions.map((r) => r.revision), [4, 3, 2, 1, 0]);
    assert.deepEqual(detail.revisions[3].changes, ["reference", "amount"]);
    assert.equal(detail.revisions[0].reason, "Date correction");
    assert.equal(s.db.prepare("SELECT count(*) n FROM audit WHERE action='customer_po.amended'").get().n, 4);
    assert.equal(detail.quote.ordered, 65000 + 30000);
  } finally {
    s.db.close();
  }
});

test("cancelled POs free their amount; void partial invoices can be billed again", () => {
  const { s, quote } = setup();
  try {
    const q = quote();
    const a = po(s, q, "CAN-1", "500.00");
    po(s, q, "CAN-2", "500.00");
    const d = s.invoiceFromQuote(q.id, a.id);
    s.issue(d.id);
    assert.throws(() => s.cancelPO(a.id, { reason: "Cancelled" }), /Void that invoice/);
    s.void(d.id, "Wrong period");
    const again = s.invoiceFromQuote(q.id, a.id);
    assert.notEqual(again.id, d.id);
    assert.equal(again.total, 50000);
    assert.throws(() => s.cancelPO(a.id, { reason: "Gone" }), /draft invoice/);
    s.cancelPO(a.id, { reason: "Gone", replace_draft: true });
    assert.throws(() => s.invoiceFromQuote(q.id, a.id), /cancelled/);
    assert.throws(() => s.amendPO(a.id, { reason: "x", amount: "1.00" }), /cancelled/);
    po(s, q, "CAN-3", "500.00");
    assert.throws(() => s.void(q.id, "Scope dropped"), /customer POs/);
  } finally {
    s.db.close();
  }
});

test("customer PO proposals and the automation rule handle partial and amended POs", () => {
  const { s, quote } = setup();
  try {
    const q = quote();
    const p = s.propose("customer_po", { quote_id: q.id, reference: "PROP-1", amount: "250.00", po_date: today() }, "test", "proposal-ops-po-0001");
    assert.throws(
      () => s.propose("customer_po", { quote_id: q.id, reference: "PROP-2", amount: "1000.01", po_date: today() }, "test", "proposal-ops-po-0002"),
      /exceeds/,
    );
    s.setRule("customer_po_invoice", true);
    const applied = s.reviewProposal(p.id, true);
    s.runAutomations();
    const row = s.sales().purchaseOrders.find((x) => x.id === applied.id);
    assert.equal(row.invoice_total, 25000);
    assert.equal(row.invoice_state, "draft");
    // Amending the amount removes the draft; the rule builds a new one.
    s.amendPO(row.id, { reason: "Revised", amount: "300.00", replace_draft: true });
    s.runAutomations();
    const after = s.sales().purchaseOrders.find((x) => x.id === row.id);
    assert.equal(after.invoice_total, 30000);
    assert.equal(s.documents().filter((d) => d.kind === "invoice" && d.state === "draft").length, 1);
    po(s, q, "PROP-3", "100.00");
    assert.throws(
      () => s.propose("invoice_from_quote", { quote_id: q.id }, "test", "proposal-ops-po-0003"),
      /several customer POs/,
    );
  } finally {
    s.db.close();
  }
});

test("the PO table rebuild keeps existing POs as revision 0 and drops the one-PO limit", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE clients(id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE services(id TEXT PRIMARY KEY);
CREATE TABLE documents(id TEXT PRIMARY KEY, total INTEGER);
CREATE TABLE customer_pos(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),quote_id TEXT NOT NULL UNIQUE REFERENCES documents(id),reference TEXT NOT NULL,reference_key TEXT NOT NULL,amount INTEGER NOT NULL,po_date TEXT NOT NULL,notes TEXT NOT NULL,invoice_id TEXT UNIQUE REFERENCES documents(id),created TEXT NOT NULL,UNIQUE(client_id,reference_key));
INSERT INTO clients VALUES('c','C');
INSERT INTO documents VALUES('q',100),('i',100);
INSERT INTO customer_pos VALUES('p','c','q','PO-1','PO-1',100,'2026-01-01','','i','2026-01-01T00:00:00Z');`);
  db.exec("PRAGMA foreign_keys=ON");
  runMigrations(db, ":memory:", OPS_MIGRATIONS.slice(0, 1));
  const row = db.prepare("SELECT * FROM customer_pos").get();
  assert.equal(row.invoice_id, "i");
  assert.equal(row.status, "open");
  assert.equal(row.revision, 0);
  assert.equal(db.prepare("SELECT reason FROM ops_po_revisions WHERE po_id='p'").get().reason, "Registered");
  db.prepare("INSERT INTO customer_pos(id,client_id,quote_id,reference,reference_key,amount,po_date,notes,created) VALUES('p2','c','q','PO-2','PO-2',1,'2026-01-01','','x')").run();
  assert.equal(db.prepare("SELECT count(*) n FROM customer_pos WHERE quote_id='q'").get().n, 2);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});

test("PO routes: register partial, amend, upload PO files and read history", async () => {
  const f = await fixture({ settings: { sstNumber: "W10-1808-32000001" } });
  try {
    const s = f.store;
    const c = s.saveClient({ name: "Route customer" });
    const q = s.issue(
      s.saveDocument({ kind: "quote", client_id: c.id, issue_date: today(), due_date: addDays(today(), 14), items: [{ description: "Work", quantity: 1, rate: "800.00" }] }).id,
    );
    await f.json(`/api/sales/quotes/${q.id}/accept`, "POST", { name: "Buyer", evidence: "Call note" });
    const created = await f.json("/api/sales/customer-pos", "POST", { quote_id: q.id, reference: "R-1", amount: "300.00", po_date: today() });
    const tooMuch = await f.auth("/api/sales/customer-pos", "POST", { quote_id: q.id, reference: "R-2", amount: "500.01", po_date: today() });
    assert.equal(tooMuch.status, 400);
    const inv = await f.json(`/api/sales/customer-pos/${created.id}/invoice`, "POST", {});
    assert.equal(inv.total, 30000);
    const amend = await f.auth(`/api/ops/pos/${created.id}/amend`, "POST", { reason: "Bigger", amount: "350.00" });
    assert.equal(amend.status, 409);
    const amended = await f.json(`/api/ops/pos/${created.id}/amend`, "POST", { reason: "Bigger", amount: "350.00", replace_draft: true });
    assert.equal(amended.revision, 1);
    const pdf = Buffer.from("%PDF-1.4\n% customer po\n");
    const up = await f.auth(`/api/ops/pos/${created.id}/files?name=po.pdf`, "POST", new Uint8Array(pdf), { "Content-Type": "application/octet-stream" });
    assert.equal(up.status, 201);
    const bad = await f.auth(`/api/ops/pos/${created.id}/files?name=x.html`, "POST", new Uint8Array(Buffer.from("<html>")), { "Content-Type": "application/octet-stream" });
    assert.equal(bad.status, 415);
    const img = await f.auth(`/api/ops/pos/${created.id}/files?name=scan.png`, "POST", new Uint8Array(PNG_1PX), { "Content-Type": "application/octet-stream" });
    assert.equal(img.status, 201);
    const detail = await f.json(`/api/ops/pos/${created.id}`);
    assert.equal(detail.files.length, 2);
    assert.equal(detail.revisions.length, 2);
    assert.equal(detail.po.files, 2);
    assert.equal((await f.request(`/api/ops/pos/${created.id}`)).status, 401, "owner only");
    const ws = await f.json("/api/workspace");
    assert.equal(ws.sales.purchaseOrders[0].files, 2);
    assert.equal(ws.sales.purchaseOrders[0].quote_total, 80000);
    const cancel = await f.json(`/api/ops/pos/${created.id}/cancel`, "POST", { reason: "Withdrawn" });
    assert.equal(cancel.status, "cancelled");
  } finally {
    await f.close();
  }
});
