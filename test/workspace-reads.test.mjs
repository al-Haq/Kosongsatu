// The workspace reads every document once per load: all documents are worked
// out together, with the rows they need read in bulk, and kept for the other
// modules of the same load only.
import test from "node:test";
import assert from "node:assert/strict";
import { today, addDays } from "../server/domain.mjs";
import { fixture } from "./helpers.mjs";

const plain = (x) => JSON.parse(JSON.stringify(x));

// Documents with every kind of related row: payments, a credit note that
// releases money, a refund, instalments, a conversion and an attachment.
function variety(s) {
  const c = s.saveClient({ name: "Mixed Client", email: "mixed@example.com" });
  const line = (rate) => [{ description: "Work", quantity: 1, rate }];
  const doc = (kind, rate, extra = {}) =>
    s.saveDocument({ kind, client_id: c.id, issue_date: today(), due_date: addDays(today(), 30), items: line(rate), ...extra });
  const draft = doc("invoice", "10.00");
  s.addAttachment(draft.id, { name: "po.pdf", data: Buffer.from("%PDF-1.4\n%test\n"), visibility: "private" });
  const quote = s.issue(doc("quote", "300.00").id);
  // Accepted by the client on the link; set directly to keep the setup short.
  s.db.prepare("UPDATE documents SET state='accepted' WHERE id=?").run(quote.id);
  s.convert(quote.id);
  const paid = s.issue(doc("invoice", "200.00").id);
  s.recordPayment(paid.id, { amount: "120.00", paid_date: today(), method: "Bank transfer", reference: "P-1" });
  s.recordPayment(paid.id, { amount: "80.00", paid_date: today(), method: "Cash", reference: "P-2" });
  s.adjustment(paid.id, { kind: "credit", amount: "50.00", reason: "Discount" });
  s.refund(s.receipts().find((r) => r.available > 0).id, { amount: "50.00", paid_date: today(), reference: "RF-1", reason: "Refund" });
  const split = s.issue(doc("invoice", "400.00").id);
  s.setInstalments(split.id, [
    { due_date: addDays(today(), 10), amount: "150.00" },
    { due_date: addDays(today(), 40), amount: "250.00" },
  ]);
  for (let i = 0; i < 30; i++) s.issue(doc("invoice", `${10 + i}.00`).id);
}

test("all documents at once are worked out exactly as one at a time, in a few queries", async () => {
  const f = await fixture();
  try {
    const s = f.store;
    variety(s);
    let queries = 0;
    const prepare = s.db.prepare.bind(s.db);
    s.db.prepare = (sql) => (queries++, prepare(sql));
    const all = s.documents();
    const bulk = queries;
    s.db.prepare = prepare;
    assert.ok(all.length >= 35);
    assert.ok(all.some((d) => d.attachments.length && d.payments.length === 0));
    assert.ok(all.some((d) => d.instalments.length === 2));
    assert.ok(all.some((d) => d.links.children.length && d.kind === "quote"));
    assert.ok(all.some((d) => d.payments.some((p) => p.released > 0)));
    // The same documents, field for field, as reading each one on its own.
    assert.deepEqual(plain(all), plain(all.map((d) => s.document(d.id))));
    assert.ok(bulk < 30, `one bulk read per kind of row, not per document (${bulk} queries for ${all.length} documents)`);
  } finally {
    await f.close();
  }
});

test("documents are kept for one workspace load only, and a write clears them", async () => {
  const f = await fixture();
  try {
    const s = f.store;
    variety(s);
    const invoice = s.documents().find((d) => d.kind === "invoice" && d.state === "issued" && d.balance > 0);
    await s.cachedReads(async () => {
      const first = s.documents();
      assert.equal(s.documents(), first, "worked out once");
      assert.equal(s.document(invoice.id), first.find((d) => d.id === invoice.id));
      s.recordPayment(invoice.id, { amount: "1.00", paid_date: today(), method: "Cash", reference: "MID-LOAD" });
      const after = s.documents();
      assert.notEqual(after, first, "a write clears what was kept");
      assert.equal(after.find((d) => d.id === invoice.id).paid, invoice.paid + 100);
    });
    assert.notEqual(s.documents(), s.documents(), "outside a load nothing is kept");
    // Over HTTP the load is unchanged.
    const ws = await f.json("/api/workspace");
    assert.equal(ws.documents.find((d) => d.id === invoice.id).paid, invoice.paid + 100);
  } finally {
    await f.close();
  }
});
