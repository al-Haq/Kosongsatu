import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import {
  money,
  calculate,
  date,
  nextMonth,
  today,
  addDays,
  status,
} from "../server/domain.mjs";
const fixture = () => {
  const store = openDatabase(":memory:");
  store.saveSettings({
    registration: "TEST-001",
    address: "Test office",
    email: "billing@example.com",
  });
  const client = store.saveClient({
    name: "Test client",
    email: "billing@example.com",
    terms: 14,
  });
  const draft = (
    kind = "invoice",
    items = [{ description: "Integration", quantity: 1, rate: "5000.00" }],
  ) =>
    store.saveDocument({
      kind,
      client_id: client.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      items,
    });
  return { store, client, draft };
};
test("money uses integer sen and rounds each line, rejects excessive precision", () => {
  assert.equal(money("0.10"), 10);
  assert.equal(
    calculate([{ description: "Time", quantity: "1.25", rate: "19.99" }]).total,
    2499,
  );
  assert.throws(() => money("1.001"));
  assert.throws(() => money("-1"));
  assert.throws(() => money(Infinity));
  assert.throws(() =>
    calculate([{ description: "Invalid", quantity: 0, rate: 10 }]),
  );
  assert.throws(() =>
    calculate([{ description: "A", quantity: 1, rate: 10 }], 11),
  );
});
test("calendar validation and month end clamping", () => {
  assert.throws(() => date("2026-02-30"));
  assert.throws(() => date("2026-99-99"));
  assert.equal(nextMonth("2026-01-31"), "2026-02-28");
  assert.equal(nextMonth("2028-01-31"), "2028-02-29");
});
test("issuing assigns unique numbers and locks client/business snapshots", () => {
  const { store, client, draft } = fixture();
  try {
    store.saveSettings({ bankAccount: "ORIGINAL" });
    const d = store.issue(draft().id);
    assert.equal(d.number.slice(-4), "0001");
    store.saveClient({ ...client, name: "Changed client" }, client.id);
    store.saveSettings({ bankAccount: "CHANGED" });
    const saved = store.document(d.id);
    assert.equal(saved.client.name, "Test client");
    assert.equal(saved.business.bankAccount, "ORIGINAL");
    assert.equal(store.issue(draft().id).number.slice(-4), "0002");
    assert.throws(() => store.issue(d.id));
    assert.throws(() =>
      store.saveDocument(
        { ...d, items: [{ description: "X", quantity: 1, rate: "1.00" }] },
        d.id,
      ),
    );
  } finally {
    store.db.close();
  }
});
test("partial payments, duplicate rejection, overpayment rejection and reversal preserve ledger", () => {
  const { store, draft } = fixture();
  try {
    const d = store.issue(draft().id);
    const p = {
      amount: "2000.00",
      paid_date: today(),
      method: "Bank transfer",
      reference: "BANK-1",
    };
    const r = store.recordPayment(d.id, p);
    assert.equal(store.document(d.id).balance, 300000);
    assert.equal(store.document(d.id).status, "Part-paid");
    assert.throws(() => store.recordPayment(d.id, p));
    assert.throws(() =>
      store.recordPayment(d.id, { ...p, reference: "BANK-2", amount: 3000.01 }),
    );
    assert.throws(() =>
      store.recordPayment(d.id, {
        ...p,
        reference: "BANK-2",
        paid_date: addDays(today(), 1),
      }),
    );
    store.reverse(r.id, "Wrong invoice");
    assert.equal(store.document(d.id).balance, 500000);
    assert.equal(store.document(d.id).payments[0].reversed, 1);
    store.recordPayment(d.id, { ...p, reference: "FULL", amount: 5000 });
    assert.equal(store.document(d.id).status, "Paid");
    assert.throws(() => store.void(d.id, "Paid invoice"));
  } finally {
    store.db.close();
  }
});
test("draft and void documents cannot accept payments", () => {
  const { store, draft } = fixture();
  try {
    const d = draft();
    const p = {
      amount: 1,
      paid_date: today(),
      method: "Cash",
      reference: "R1",
    };
    assert.throws(() => store.recordPayment(d.id, p));
    store.issue(d.id);
    store.void(d.id, "Cancelled");
    assert.throws(() => store.recordPayment(d.id, p));
  } finally {
    store.db.close();
  }
});
test("public links expire, rotate and revoke; void revokes access", () => {
  const { store, draft } = fixture();
  try {
    const d = store.issue(draft().id);
    const a = store.share(d.id);
    assert.equal(store.publicDocument(a.token).id, d.id);
    const b = store.share(d.id);
    assert.throws(() => store.publicDocument(a.token));
    store.db
      .prepare("UPDATE documents SET token_expires=0 WHERE id=?")
      .run(d.id);
    assert.throws(() => store.publicDocument(b.token));
    const c = store.share(d.id);
    store.revoke(d.id);
    assert.throws(() => store.publicDocument(c.token));
    const e = store.share(d.id);
    store.void(d.id, "Cancelled");
    assert.throws(() => store.publicDocument(e.token));
  } finally {
    store.db.close();
  }
});
test("quotation acceptance is recorded and conversion is idempotent", () => {
  const { store, draft } = fixture();
  try {
    const q = store.issue(draft("quote").id);
    assert.throws(() => store.convert(q.id));
    const { token } = store.share(q.id);
    store.accept(token, "Client signer");
    assert.equal(store.document(q.id).accepted_name, "Client signer");
    const a = store.convert(q.id),
      b = store.convert(q.id);
    assert.equal(a.id, b.id);
    assert.equal(a.total, q.total);
    assert.equal(a.source_quote, q.id);
    assert.throws(() => store.void(q.id, "Already converted"));
  } finally {
    store.db.close();
  }
});
test("expired quotations cannot be accepted", () => {
  const { store, client } = fixture();
  try {
    const q = store.saveDocument({
      kind: "quote",
      client_id: client.id,
      issue_date: addDays(today(), -10),
      due_date: addDays(today(), -1),
      items: [{ description: "Expired", quantity: 1, rate: 10 }],
    });
    store.issue(q.id);
    const { token } = store.share(q.id);
    assert.throws(() => store.accept(token, "Client"));
  } finally {
    store.db.close();
  }
});
test("payment references do not change paid balance until owner confirms", () => {
  const { store, draft } = fixture();
  try {
    const d = store.issue(draft().id);
    const { token } = store.share(d.id);
    const proof = store.proof(token, {
      reference: "BANKREF",
      note: "Please review",
    });
    assert.equal(store.document(d.id).paid, 0);
    assert.throws(() => store.proof(token, { reference: "BANKREF" }));
    store.recordPayment(d.id, {
      amount: 5000,
      paid_date: today(),
      method: "Bank transfer",
      reference: "BANKREF",
      proof_id: proof.id,
    });
    assert.equal(store.document(d.id).proofs[0].status, "confirmed");
  } finally {
    store.db.close();
  }
});
test("recurring creates one draft per period and refuses future runs", () => {
  const { store, client } = fixture();
  try {
    const service = store.saveService({
      name: "Maintenance",
      rate: 750,
      unit: "Month",
    });
    const schedule = store.saveSchedule({
      client_id: client.id,
      service_id: service.id,
      next_date: today(),
    });
    const d = store.runSchedule(schedule.id);
    assert.equal(d.state, "draft");
    assert.equal(d.total, 75000);
    assert.equal(
      store.db.prepare("SELECT count(*) n FROM schedule_runs").get().n,
      1,
    );
    assert.throws(() => store.runSchedule(schedule.id));
  } finally {
    store.db.close();
  }
});
test("overdue is based on remaining balance, paid invoice remains paid", () => {
  const d = {
    kind: "invoice",
    state: "issued",
    due_date: "2026-01-01",
    total: 500,
  };
  assert.equal(status(d, 100, "2026-02-01"), "Overdue");
  assert.equal(status(d, 500, "2026-02-01"), "Paid");
});

test("SQLite records survive closing and reopening the application store", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "nawlogic-persistence-"));
  let store;
  try {
    store = openDatabase(join(dir, "test.sqlite"));
    store.saveSettings({
      registration: "TEST-001",
      address: "Test office",
      email: "billing@example.com",
    });
    const c = store.saveClient({ name: "Persistent client" });
    const d = store.saveDocument({
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: today(),
      items: [{ description: "Work", quantity: 1, rate: 100 }],
    });
    store.issue(d.id);
    store.db.close();
    store = openDatabase(join(dir, "test.sqlite"));
    store.saveSettings({
      registration: "TEST-001",
      address: "Test office",
      email: "billing@example.com",
    });
    assert.equal(store.document(d.id).client.name, "Persistent client");
    assert.equal(store.document(d.id).total, 10000);
    assert.equal(store.document(d.id).state, "issued");
  } finally {
    store?.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
