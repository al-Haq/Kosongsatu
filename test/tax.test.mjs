import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { createOwner } from "../server/auth.mjs";
import { createApp } from "../server/app.mjs";
import { calculate, today, addDays } from "../server/domain.mjs";
function fixture(sstNumber = "W10-1808-32000001") {
  const s = openDatabase(":memory:");
  s.saveSettings({
    registration: "TEST-1",
    address: "Test office",
    email: "test@example.com",
    sstNumber,
  });
  const c = s.saveClient({ name: "Tax client", tin: "C1234567890" });
  return { s, c };
}
const lines = [
  { description: "Service", quantity: "1", rate: "1000.00", tax_rate: 8 },
  { description: "Goods", quantity: "1", rate: "500.00", tax_rate: 10 },
  { description: "Exempt", quantity: "1", rate: "250.00", tax_rate: 0 },
];
test("SST is charged per line after a pro-rata share of the discount", () => {
  const r = calculate(lines, "175.00");
  assert.equal(r.subtotal, 175000);
  assert.deepEqual(
    r.items.map((i) => [i.taxable, i.tax]),
    [
      [90000, 7200],
      [45000, 4500],
      [22500, 0],
    ],
  );
  assert.equal(r.tax, 11700);
  assert.equal(r.total, 175000 - 17500 + 11700);
});
test("discount rounding leftovers go to the largest line so taxable values add up", () => {
  const r = calculate(
    [
      { description: "A", quantity: "1", rate: "0.01", tax_rate: 6 },
      { description: "B", quantity: "1", rate: "0.01", tax_rate: 6 },
      { description: "C", quantity: "1", rate: "100.00", tax_rate: 6 },
    ],
    "33.33",
  );
  assert.equal(
    r.items.reduce((s, i) => s + i.taxable, 0),
    r.subtotal - r.discount,
  );
  assert.ok(r.items.every((i) => i.taxable >= 0));
});
test("unknown SST rates are rejected and documents without SST are unchanged", () => {
  assert.throws(
    () => calculate([{ description: "X", quantity: "1", rate: "10.00", tax_rate: 7 }]),
    /SST rate/,
  );
  const plain = calculate([{ description: "X", quantity: "2", rate: "10.00" }], "5.00");
  assert.equal(plain.tax, 0);
  assert.equal(plain.total, 1500);
});
test("charging SST needs the business SST registration number", () => {
  const { s, c } = fixture("");
  try {
    const doc = () =>
      s.saveDocument({
        kind: "invoice",
        client_id: c.id,
        issue_date: today(),
        due_date: addDays(today(), 14),
        items: lines,
      });
    assert.throws(doc, /SST registration number/);
    s.saveSettings({ ...s.settings(), sstNumber: "W10-1808-32000001" });
    assert.equal(doc().tax, 13000);
  } finally {
    s.db.close();
  }
});
test("services keep a default SST rate and reject invalid ones", () => {
  const { s } = fixture();
  try {
    assert.throws(() => s.saveService({ name: "Bad", rate: "10.00", tax_rate: 7 }), /SST rate/);
    const svc = s.saveService({ name: "Care", rate: "100.00", tax_rate: 8 });
    assert.equal(svc.tax_rate, 8);
  } finally {
    s.db.close();
  }
});
test("the SST report sums issued invoices by rate within the period", async () => {
  const { s, c } = fixture();
  await createOwner(s, "owner@example.com", "Test-only-password-28");
  const issued = s.issue(
    s.saveDocument({
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      items: lines,
    }).id,
  );
  s.saveDocument({
    kind: "invoice",
    client_id: c.id,
    issue_date: today(),
    due_date: addDays(today(), 14),
    items: lines,
  });
  const r = s.sstReport({});
  assert.equal(r.tax, issued.tax);
  assert.deepEqual(
    r.rates.map((x) => [x.rate, x.taxable, x.tax]),
    [
      [0, 25000, 0],
      [8, 100000, 8000],
      [10, 50000, 5000],
    ],
  );
  assert.equal(r.rows[0].client_tin, "C1234567890");
  assert.equal(s.sstReport({ from: addDays(today(), 1), to: addDays(today(), 2) }).tax, 0);
  assert.throws(() => s.sstReport({ from: today(), to: addDays(today(), -1) }), /period/);
  const server = createApp({ store: s, appUrl: "http://localhost" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + "/api/reports/sst.csv")).status, 401);
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "Test-only-password-28" }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const csv = await fetch(base + "/api/reports/sst.csv", { headers: { Cookie: cookie } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type"), /text\/csv/);
    const text = await csv.text();
    assert.match(text, new RegExp(issued.number));
    assert.match(text, /80\.00/);
  } finally {
    await new Promise((r) => server.close(r));
    s.db.close();
  }
});
test("a near-total discount never makes a line, its SST or the total negative", () => {
  const items = Array.from({ length: 50 }, (_, n) => ({
    description: "Line " + n,
    quantity: "1",
    rate: "1.00",
    tax_rate: 10,
  }));
  const r = calculate(items, "49.99");
  assert.ok(r.items.every((i) => i.taxable >= 0 && i.tax >= 0));
  assert.equal(r.items.reduce((s, i) => s + i.taxable, 0), 1);
  assert.ok(r.total > 0);
});
test("issuing a taxed draft needs the SST number at issue time", () => {
  const { s, c } = fixture();
  try {
    const d = s.saveDocument({
      kind: "invoice",
      client_id: c.id,
      issue_date: today(),
      due_date: addDays(today(), 14),
      items: lines,
    });
    s.saveSettings({ ...s.settings(), sstNumber: "" });
    assert.throws(() => s.issue(d.id), /SST registration number/);
  } finally {
    s.db.close();
  }
});
test("legacy invoices without per-line taxable values still net their discount in the report", () => {
  const { s, c } = fixture();
  try {
    const d = s.issue(
      s.saveDocument({
        kind: "invoice",
        client_id: c.id,
        issue_date: today(),
        due_date: addDays(today(), 14),
        items: [{ description: "Old", quantity: "1", rate: "100.00" }],
        discount: "10.00",
      }).id,
    );
    const items = d.items.map(({ taxable, tax, tax_rate, ...rest }) => rest);
    s.db.prepare("UPDATE documents SET items=? WHERE id=?").run(JSON.stringify(items), d.id);
    const r = s.sstReport({});
    assert.deepEqual(r.rates, [{ rate: 0, taxable: 9000, tax: 0 }]);
  } finally {
    s.db.close();
  }
});
