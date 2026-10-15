import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { today, addDays } from "../server/domain.mjs";
import { requestContext } from "../server/context.mjs";
const fixture = () => {
  const s = openDatabase(":memory:");
  s.saveSettings({
    registration: "TEST-ONLY",
    address: "Test office",
    email: "test@example.com",
  });
  const client = s.saveClient({ name: "Client A" });
  const invoice = (value = 100) =>
    s.issue(
      s.saveDocument({
        kind: "invoice",
        client_id: client.id,
        issue_date: today(),
        due_date: addDays(today(), 14),
        items: [{ description: "Test work", quantity: 1, rate: value }],
      }).id,
    );
  const cash = (value = 100, ref = "BANK-ONE") =>
    s.receive({
      client_id: client.id,
      amount: value,
      paid_date: today(),
      method: "Bank transfer",
      reference: ref,
      account: "MAIN",
    });
  return { s, client, invoice, cash };
};
test("one bank receipt can fund multiple invoices once; cross-invoice re-record is rejected", () => {
  const { s, invoice, cash } = fixture();
  try {
    const a = invoice(60),
      b = invoice(40),
      r = cash(100);
    s.allocate(r.id, { invoice_id: a.id, amount: 60 });
    s.allocate(r.id, { invoice_id: b.id, amount: 40 });
    assert.equal(s.receipt(r.id).available, 0);
    assert.equal(s.document(a.id).balance + s.document(b.id).balance, 0);
    assert.equal(s.receipts().length, 1);
    const c = invoice(100);
    assert.throws(() =>
      s.recordPayment(c.id, {
        amount: 100,
        paid_date: today(),
        method: "Bank transfer",
        reference: "BANK-ONE",
      }),
    );
    assert.throws(() => s.allocate(r.id, { invoice_id: c.id, amount: 0.01 }));
  } finally {
    s.db.close();
  }
});
test("unallocated cash is customer funds; allocations cannot cross clients", () => {
  const { s, client, invoice, cash } = fixture();
  try {
    const d = invoice(50),
      r = cash(100);
    s.allocate(r.id, { invoice_id: d.id, amount: 50 });
    assert.equal(s.receipt(r.id).available, 5000);
    const other = s.saveClient({ name: "Other client" });
    const e = s.issue(
      s.saveDocument({
        kind: "invoice",
        client_id: other.id,
        issue_date: today(),
        due_date: today(),
        items: [{ description: "Other", quantity: 1, rate: 50 }],
      }).id,
    );
    assert.throws(() => s.allocate(r.id, { invoice_id: e.id, amount: 50 }));
  } finally {
    s.db.close();
  }
});
test("paid invoice credit releases cash; debit reopens balance; refund consumes actual funds", () => {
  const { s, invoice, cash } = fixture();
  try {
    const d = invoice(100),
      r = cash(100);
    s.allocate(r.id, { invoice_id: d.id, amount: 100 });
    const a = s.adjustment(d.id, {
      kind: "credit",
      amount: 20,
      reason: "Scope reduced",
    });
    assert.equal(s.document(d.id).total, 10000);
    assert.equal(s.document(d.id).adjusted_total, 8000);
    assert.equal(s.document(d.id).paid, 8000);
    assert.equal(s.receipt(r.id).available, 2000);
    const refund = s.refund(r.id, {
      amount: 20,
      reference: "REFUND-1",
      reason: "Returned excess",
      paid_date: today(),
    });
    assert.equal(s.receipt(r.id).available, 0);
    assert.equal(s.receipt(r.id).refunded, 2000);
    assert.throws(() =>
      s.refund(r.id, {
        amount: 0.01,
        reference: "REFUND-2",
        reason: "Too much",
      }),
    );
    s.adjustment(d.id, { kind: "debit", amount: 10, reason: "Extra work" });
    assert.equal(s.document(d.id).balance, 1000);
    assert.throws(() => s.void(d.id, "Cannot silently void adjustments"));
  } finally {
    s.db.close();
  }
});
test("credit without prior cash does not create refundable funds", () => {
  const { s, invoice } = fixture();
  try {
    const d = invoice();
    s.adjustment(d.id, {
      kind: "credit",
      amount: 100,
      reason: "Cancelled work",
    });
    assert.equal(s.document(d.id).status, "Credited");
    assert.equal(s.document(d.id).balance, 0);
    assert.equal(s.receipts().length, 0);
    assert.throws(() =>
      s.adjustment(d.id, { kind: "credit", amount: 1, reason: "Excess" }),
    );
  } finally {
    s.db.close();
  }
});
test("reversed allocation releases funds; voiding a recording error preserves history and allows corrected receipt", () => {
  const { s, invoice } = fixture();
  try {
    const d = invoice();
    const p = s.recordPayment(d.id, {
      amount: 100,
      paid_date: today(),
      method: "Bank transfer",
      reference: "WRONG-ENTRY",
    });
    s.reverse(p.id, "Wrong allocation");
    assert.equal(s.document(d.id).balance, 10000);
    assert.equal(s.receipt(p.receipt_id).available, 10000);
    s.voidReceipt(p.receipt_id, "Cash was not actually received");
    const next = s.recordPayment(d.id, {
      amount: 100,
      paid_date: today(),
      method: "Bank transfer",
      reference: "WRONG-ENTRY",
    });
    assert.notEqual(next.receipt_id, p.receipt_id);
    assert.equal(s.receipts().filter((r) => !r.voided).length, 1);
  } finally {
    s.db.close();
  }
});
test("financial request retries are idempotent, mismatched reuse is rejected and failure rolls back", () => {
  const { s, cash } = fixture();
  try {
    const body = { amount: 100 };
    const a = s.idempotent("receipt", "key-1234567890123456", body, () =>
        cash(),
      ),
      b = s.idempotent("receipt", "key-1234567890123456", body, () => cash());
    assert.equal(a.id, b.id);
    assert.equal(s.receipts().length, 1);
    assert.throws(() =>
      s.idempotent("receipt", "key-1234567890123456", { amount: 101 }, () =>
        cash(),
      ),
    );
    assert.throws(() =>
      s.idempotent("bad", "key-9876543210987654", {}, () => {
        cash(10, "ROLLBACK");
        throw new Error("Fail");
      }),
    );
    assert.equal(s.receipts().length, 1);
  } finally {
    s.db.close();
  }
});
test("number prefix conflicts and missing legal identity are blocked before issuance", () => {
  const s = openDatabase(":memory:");
  try {
    assert.throws(() =>
      s.saveSettings({ invoicePrefix: "INV", quotePrefix: "INV" }),
    );
    assert.throws(() => s.saveSettings({ invoicePrefix: "CN" }));
    assert.throws(() =>
      s.saveSettings({ invoicePrefix: " INV ", quotePrefix: "INV" }),
    );
    const c = s.saveClient({ name: "Client" });
    const d = s.saveDocument({
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: today(),
      items: [{ description: "Work", quantity: 1, rate: 10 }],
    });
    assert.throws(() => s.issue(d.id), /registration/);
    assert.equal(s.document(d.id).state, "draft");
  } finally {
    s.db.close();
  }
});
test("recurring preserves anchor day across February and supports explicit month end", () => {
  const { s, client } = fixture();
  try {
    const service = s.saveService({ name: "Support", rate: 50, unit: "Month" });
    const run = s.saveSchedule({
      client_id: client.id,
      service_id: service.id,
      next_date: "2020-01-31",
    });
    s.runSchedule(run.id);
    assert.equal(
      s.db.prepare("SELECT next_date FROM schedules WHERE id=?").get(run.id)
        .next_date,
      "2020-02-29",
    );
    s.runSchedule(run.id);
    assert.equal(
      s.db.prepare("SELECT next_date FROM schedules WHERE id=?").get(run.id)
        .next_date,
      "2020-03-31",
    );
    const end = s.saveSchedule({
      client_id: client.id,
      service_id: service.id,
      next_date: "2020-04-30",
      month_end: true,
    });
    s.runSchedule(end.id);
    assert.equal(
      s.db.prepare("SELECT next_date FROM schedules WHERE id=?").get(end.id)
        .next_date,
      "2020-05-31",
    );
  } finally {
    s.db.close();
  }
});
test("audit records actor and changes and rejects update/delete", () => {
  const { s, client } = fixture();
  try {
    requestContext.run({ actor: "owner:test@example.com" }, () =>
      s.saveClient({ ...client, name: "Updated" }, client.id),
    );
    const a = s.db
      .prepare(
        "SELECT * FROM audit WHERE action='client.changed' ORDER BY id DESC LIMIT 1",
      )
      .get();
    assert.equal(a.actor, "owner:test@example.com");
    assert.equal(JSON.parse(a.before_data).name, "Client A");
    assert.equal(JSON.parse(a.after_data).name, "Updated");
    assert.throws(() => s.db.prepare("DELETE FROM audit").run());
    assert.throws(() =>
      s.db.prepare("UPDATE audit SET detail='changed'").run(),
    );
  } finally {
    s.db.close();
  }
});
test("bad submitted reference can be rejected and reversing its allocation returns it to review", () => {
  const { s, invoice } = fixture();
  try {
    const d = invoice(),
      link = s.share(d.id);
    const proof = s.proof(link.token, { reference: "BAD" });
    s.reviewProof(proof.id, "Not in bank");
    assert.equal(s.document(d.id).proofs[0].status, "rejected");
    const valid = s.proof(link.token, { reference: "GOOD" });
    const p = s.recordPayment(d.id, {
      amount: 100,
      paid_date: today(),
      method: "Bank transfer",
      reference: "GOOD",
      proof_id: valid.id,
    });
    s.reverse(p.id, "Wrong allocation");
    assert.equal(
      s.document(d.id).proofs.find((p) => p.id === valid.id).status,
      "pending",
    );
  } finally {
    s.db.close();
  }
});

test("refund bank references cannot be re-recorded against another customer receipt", () => {
  const { s, client: c } = fixture();
  try {
    const a = s.receive({
        client_id: c.id,
        amount: 100,
        paid_date: today(),
        method: "Bank transfer",
        reference: "IN-A",
      }),
      b = s.receive({
        client_id: c.id,
        amount: 100,
        paid_date: today(),
        method: "Bank transfer",
        reference: "IN-B",
      });
    s.refund(a.id, { amount: 10, reference: "OUT-SAME", reason: "Refund" });
    assert.throws(
      () =>
        s.refund(b.id, {
          amount: 10,
          reference: "out-same",
          reason: "Duplicate",
        }),
      /already recorded/,
    );
    assert.equal(s.receipt(b.id).available, 10000);
  } finally {
    s.db.close();
  }
});
