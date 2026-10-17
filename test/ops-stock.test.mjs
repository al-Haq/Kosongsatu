import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../server/db.mjs";
import { today, addDays } from "../server/domain.mjs";
import { qty100 } from "../server/ops-stock.mjs";
import { fixture } from "./helpers.mjs";

function setup() {
  const s = openDatabase(":memory:");
  s.saveSettings({ registration: "TEST-1", address: "Test office", email: "test@example.com" });
  const c = s.saveClient({ name: "Stock client" });
  const router = s.saveService({ name: "Router", rate: "350.00", unit: "Unit" });
  const cable = s.saveService({ name: "Cable", rate: "2.50", unit: "Metre" });
  return { s, c, router, cable };
}
// The documents module adds service_id / sku to lines and a delivery_order kind;
// here they are written straight into a draft before issuing.
function draft(s, c, lines) {
  const d = s.saveDocument({
    kind: "invoice",
    client_id: c.id,
    issue_date: today(),
    due_date: addDays(today(), 14),
    items: lines.map((l) => ({ description: l.description || "Item", quantity: l.quantity, rate: "10.00" })),
  });
  const items = s.document(d.id).items.map((i, n) => ({ ...i, ...lines[n] }));
  s.db.prepare("UPDATE documents SET items=? WHERE id=?").run(JSON.stringify(items), d.id);
  return d.id;
}
const onHand = (s, sid) => s.db.prepare("SELECT on_hand FROM ops_stock_items WHERE service_id=?").get(sid).on_hand;

test("stock quantities keep 2 decimals", () => {
  assert.equal(qty100("12.5"), 1250);
  assert.equal(qty100("-3", { negative: true }), -300);
  assert.throws(() => qty100("-3"));
  assert.throws(() => qty100("0"));
  assert.equal(qty100("0", { zero: true }), 0);
  assert.throws(() => qty100("1.005"));
});

test("inventory is off by default and only selected items are tracked", () => {
  const { s, c, router } = setup();
  try {
    assert.deepEqual(s.inventorySettings(), { enabled: false, trigger: "invoice" });
    s.trackStock({ service_id: router.id, sku: "RTR-01", opening: "10", reorder_level: "3" });
    const id = draft(s, c, [{ quantity: 2, service_id: router.id }]);
    s.issue(id);
    assert.equal(onHand(s, router.id), 1000, "nothing moves while inventory is off");
    assert.throws(() => s.trackStock({ service_id: router.id }), /already tracked/);
    assert.throws(() => s.saveInventorySettings({ trigger: "quote" }), /when stock/);
  } finally {
    s.db.close();
  }
});

test("issuing deducts matched lines once; voiding reverses once", () => {
  const { s, c, router, cable } = setup();
  try {
    s.saveInventorySettings({ enabled: true });
    s.trackStock({ service_id: router.id, sku: "RTR-01", opening: "10", reorder_level: "3" });
    s.trackStock({ service_id: cable.id, sku: "cab-cat6", opening: "100" });
    const id = draft(s, c, [
      { quantity: 2, service_id: router.id },
      { quantity: 1, service_id: router.id },
      { quantity: 25.5, sku: "CAB-CAT6 " },
      { quantity: 4, sku: "UNKNOWN" },
      { quantity: 1 },
    ]);
    s.issue(id);
    assert.equal(onHand(s, router.id), 700);
    assert.equal(onHand(s, cable.id), 7450);
    const doc = s.document(id);
    assert.deepEqual(s.deductStock(doc), [], "a second deduction for the same document does nothing");
    assert.equal(onHand(s, router.id), 700);
    s.void(id, "Order cancelled");
    assert.equal(onHand(s, router.id), 1000);
    assert.equal(onHand(s, cable.id), 10000);
    assert.equal(s.restoreStock(id), 0, "reversal happens once");
    const kinds = s.stockDetail(router.id).movements.map((m) => m.kind);
    assert.deepEqual(kinds.sort(), ["deduct", "receive", "reverse"]);
    assert.ok(s.db.prepare("SELECT 1 FROM audit WHERE action='stock.reversed' AND entity_id=?").get(id));
  } finally {
    s.db.close();
  }
});

test("with delivery orders chosen, invoices leave stock alone", () => {
  const { s, c, router } = setup();
  try {
    s.saveInventorySettings({ enabled: true, trigger: "delivery_order" });
    s.trackStock({ service_id: router.id, opening: "5" });
    s.issue(draft(s, c, [{ quantity: 1, service_id: router.id }]));
    assert.equal(onHand(s, router.id), 500);
    const dd = draft(s, c, [{ quantity: 2, service_id: router.id }]);
    const d = s.document(dd);
    s.deductStock({ ...d, kind: "delivery_order", number: "DO-1" });
    assert.equal(onHand(s, router.id), 300);
  } finally {
    s.db.close();
  }
});

test("receive, adjust with a reason, low stock and protected catalog items", () => {
  const { s, c, router } = setup();
  try {
    s.saveInventorySettings({ enabled: true });
    s.trackStock({ service_id: router.id, opening: "4", reorder_level: "3" });
    s.moveStock(router.id, { kind: "receive", quantity: "2" });
    assert.throws(() => s.moveStock(router.id, { kind: "adjust", quantity: "-1" }), /Required/);
    s.moveStock(router.id, { kind: "adjust", quantity: "-4", reason: "Damaged in storage" });
    assert.equal(onHand(s, router.id), 200);
    assert.equal(s.stockItems()[0].low, true);
    // Stock can go below zero (issuing an invoice is never blocked) and shows as low.
    s.issue(draft(s, c, [{ quantity: 5, service_id: router.id }]));
    assert.equal(onHand(s, router.id), -300);
    assert.throws(() => s.deleteService(router.id), /stock history/);
    s.updateStock(router.id, { active: false });
    assert.throws(() => s.moveStock(router.id, { kind: "receive", quantity: "1" }), /no longer tracked/);
    const lone = s.saveService({ name: "Spare", rate: "1.00" });
    s.trackStock({ service_id: lone.id });
    s.deleteService(lone.id);
    assert.equal(s.db.prepare("SELECT count(*) n FROM ops_stock_items WHERE service_id=?").get(lone.id).n, 0);
  } finally {
    s.db.close();
  }
});

test("inventory routes", async () => {
  const f = await fixture();
  try {
    const svc = f.store.saveService({ name: "Switch", rate: "500.00" });
    await f.json("/api/ops/inventory", "PUT", { enabled: true, trigger: "invoice" });
    await f.json("/api/ops/stock", "POST", { service_id: svc.id, sku: "SW-8", opening: "1", reorder_level: "2" });
    const dup = await f.auth("/api/ops/stock", "POST", { service_id: svc.id });
    assert.equal(dup.status, 409);
    const key = { "Idempotency-Key": "ops-stock-move-00000000001" };
    const move = { kind: "receive", quantity: "3", reason: "Supplier DO 55" };
    await f.auth(`/api/ops/stock/${svc.id}/movements`, "POST", move, key);
    await f.auth(`/api/ops/stock/${svc.id}/movements`, "POST", move, key);
    const detail = await f.json(`/api/ops/stock/${svc.id}`);
    assert.equal(detail.item.on_hand, 400, "a retried movement is applied once");
    const ws = await f.json("/api/workspace");
    assert.equal(ws.ext.ops.inventory.enabled, true);
    assert.equal(ws.ext.ops.inventory.items[0].sku, "SW-8");
  } finally {
    await f.close();
  }
});
