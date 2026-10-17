// Simple inventory for selected catalog items (roadmap no. 71). Off by default.
// Stock is deducted when an invoice (or, if chosen, a delivery order) is
// issued, matching lines by service_id or sku, and put back when it is voided.
import { id, now, text, check } from "./domain.mjs";
import { requestContext } from "./context.mjs";
export const STOCK_TRIGGERS = ["invoice", "delivery_order"];
const actor = () => requestContext.getStore()?.actor || "system";
const skuKey = (v) => String(v || "").trim().toUpperCase();
// Quantities to 2 decimals, stored as hundredths of a unit.
export function qty100(v, { negative = false, zero = false } = {}) {
  check(typeof v === "string" || typeof v === "number", "Enter a quantity.");
  const s = String(v).trim();
  check(
    (negative ? /^-?\d{1,7}(\.\d{1,2})?$/ : /^\d{1,7}(\.\d{1,2})?$/).test(s),
    "Quantities need at most 2 decimal places.",
  );
  const sign = s.startsWith("-") ? -1 : 1;
  const [a, b = ""] = s.replace("-", "").split(".");
  const n = sign * (Number(a) * 100 + Number(b.padEnd(2, "0")));
  check(zero || n !== 0, "Enter a quantity other than zero.");
  return n === 0 ? 0 : n;
}
export function attachStock(Store) {
  const original = {
    issue: Store.prototype.issue,
    void: Store.prototype.void,
    deleteService: Store.prototype.deleteService,
  };
  const item = (store, sid) => {
    const row = store.db.prepare("SELECT * FROM ops_stock_items WHERE service_id=?").get(sid);
    check(row, "This item is not tracked in inventory.", 404);
    return row;
  };
  const move = (store, it, kind, quantity, reason, document_id = null) => {
    const balance = it.on_hand + quantity;
    store.db
      .prepare(
        "INSERT INTO ops_stock_movements(id,service_id,kind,quantity,balance,reason,document_id,actor,created) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(id(), it.service_id, kind, quantity, balance, reason, document_id, actor(), now());
    store.db
      .prepare("UPDATE ops_stock_items SET on_hand=?,updated=? WHERE service_id=?")
      .run(balance, now(), it.service_id);
    it.on_hand = balance;
  };
  Object.assign(Store.prototype, {
    opsSetting(key, fallback = null) {
      return this.db.prepare("SELECT value FROM ops_settings WHERE key=?").get(key)?.value ?? fallback;
    },
    inventorySettings() {
      return {
        enabled: this.opsSetting("inventory_enabled", "0") === "1",
        trigger: this.opsSetting("stock_trigger", "invoice"),
      };
    },
    saveInventorySettings(b) {
      return this.tx(() => {
        const old = this.inventorySettings();
        const next = {
          enabled: b.enabled === undefined ? old.enabled : b.enabled === true || b.enabled === "on",
          trigger: b.trigger === undefined ? old.trigger : String(b.trigger),
        };
        check(STOCK_TRIGGERS.includes(next.trigger), "Choose when stock is deducted.");
        const set = this.db.prepare(
          "INSERT INTO ops_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        );
        set.run("inventory_enabled", next.enabled ? "1" : "0");
        set.run("stock_trigger", next.trigger);
        this.audit("inventory.settings", null, next.enabled ? "Inventory on" : "Inventory off", old, next);
        return next;
      });
    },
    stockItems() {
      return this.db
        .prepare(
          "SELECT i.*, s.name, s.unit, s.rate, s.active service_active FROM ops_stock_items i JOIN services s ON s.id=i.service_id ORDER BY s.name",
        )
        .all()
        .map((i) => ({
          ...i,
          low: !!i.active && (i.on_hand <= 0 || (i.reorder_level > 0 && i.on_hand <= i.reorder_level)),
        }));
    },
    // Starts tracking a catalog item, with an optional opening quantity.
    trackStock(b) {
      return this.tx(() => {
        const s = this.db.prepare("SELECT * FROM services WHERE id=?").get(b.service_id);
        check(s, "Choose a catalog item.", 404);
        const old = this.db.prepare("SELECT * FROM ops_stock_items WHERE service_id=?").get(s.id);
        check(!old, "This item is already tracked.", 409);
        const sku = text(b.sku || "", 40);
        check(!sku || /^[\w.\-/]+$/.test(sku), "Use letters, numbers, dots, dashes or slashes for the SKU.");
        if (sku)
          check(
            !this.db.prepare("SELECT 1 FROM ops_stock_items WHERE sku_key=?").get(skuKey(sku)),
            "Another item already uses this SKU.",
            409,
          );
        const row = {
          service_id: s.id,
          sku,
          sku_key: skuKey(sku),
          on_hand: 0,
          reorder_level: b.reorder_level === undefined || b.reorder_level === "" ? 0 : qty100(b.reorder_level, { zero: true }),
          active: 1,
          created: now(),
          updated: now(),
        };
        this.db
          .prepare(
            "INSERT INTO ops_stock_items(service_id,sku,sku_key,on_hand,reorder_level,active,created,updated) VALUES(:service_id,:sku,:sku_key,:on_hand,:reorder_level,:active,:created,:updated)",
          )
          .run(row);
        const opening = b.opening === undefined || b.opening === "" ? 0 : qty100(b.opening, { zero: true });
        if (opening) move(this, row, "receive", opening, "Opening stock");
        this.audit("stock.tracked", s.id, s.name, null, row);
        return item(this, s.id);
      });
    },
    updateStock(sid, b) {
      return this.tx(() => {
        const old = item(this, sid);
        const sku = b.sku === undefined ? old.sku : text(b.sku, 40);
        check(!sku || /^[\w.\-/]+$/.test(sku), "Use letters, numbers, dots, dashes or slashes for the SKU.");
        if (sku && skuKey(sku) !== old.sku_key)
          check(
            !this.db.prepare("SELECT 1 FROM ops_stock_items WHERE sku_key=? AND service_id!=?").get(skuKey(sku), sid),
            "Another item already uses this SKU.",
            409,
          );
        const next = {
          sku,
          sku_key: skuKey(sku),
          reorder_level:
            b.reorder_level === undefined ? old.reorder_level : b.reorder_level === "" ? 0 : qty100(b.reorder_level, { zero: true }),
          active: b.active === undefined ? old.active : b.active === true || b.active === "on" ? 1 : 0,
        };
        this.db
          .prepare(
            "UPDATE ops_stock_items SET sku=:sku,sku_key=:sku_key,reorder_level=:reorder_level,active=:active,updated=:updated WHERE service_id=:service_id",
          )
          .run({ ...next, updated: now(), service_id: sid });
        this.audit("stock.item.changed", sid, sku, old, next);
        return item(this, sid);
      });
    },
    // Owner movements: receive stock, or adjust it up or down with a reason.
    moveStock(sid, b) {
      return this.tx(() => {
        const it = item(this, sid);
        check(it.active, "This item is no longer tracked. Turn tracking back on first.", 409);
        const kind = b.kind;
        check(["receive", "adjust"].includes(kind), "Choose receive or adjust.");
        const quantity = qty100(b.quantity, { negative: kind === "adjust" });
        const reason = text(b.reason || "", 300, kind === "adjust");
        move(this, it, kind, quantity, reason || "Stock received");
        this.audit("stock." + kind, sid, `${(quantity / 100).toFixed(2)} ${reason}`.trim(), null, {
          quantity,
          on_hand: it.on_hand,
        });
        return item(this, sid);
      });
    },
    stockDetail(sid) {
      return {
        item: this.stockItems().find((i) => i.service_id === sid) || item(this, sid),
        movements: this.db
          .prepare(
            "SELECT m.*, d.number document_number, d.kind document_kind FROM ops_stock_movements m LEFT JOIN documents d ON d.id=m.document_id WHERE m.service_id=? ORDER BY m.created DESC, m.rowid DESC LIMIT 200",
          )
          .all(sid),
      };
    },
    // Matches issued document lines to tracked items and deducts them once.
    deductStock(d) {
      const settings = this.inventorySettings();
      if (!settings.enabled || d.kind !== settings.trigger) return [];
      const items = this.db.prepare("SELECT * FROM ops_stock_items WHERE active=1").all();
      if (!items.length) return [];
      const byId = new Map(items.map((i) => [i.service_id, i])),
        bySku = new Map(items.filter((i) => i.sku_key).map((i) => [i.sku_key, i]));
      const totals = new Map();
      for (const line of d.items || []) {
        const it =
          (typeof line.service_id === "string" && byId.get(line.service_id)) ||
          (line.sku && bySku.get(skuKey(line.sku)));
        if (!it) continue;
        const q = Math.round(Number(line.quantity) * 100);
        if (!(q > 0)) continue;
        totals.set(it, (totals.get(it) || 0) + q);
      }
      const done = [];
      for (const [it, q] of totals) {
        if (
          this.db
            .prepare("SELECT 1 FROM ops_stock_movements WHERE document_id=? AND service_id=? AND kind='deduct'")
            .get(d.id, it.service_id)
        )
          continue;
        move(this, it, "deduct", -q, `Issued ${d.number || d.id}`, d.id);
        done.push({ service_id: it.service_id, quantity: q });
      }
      if (done.length) this.audit("stock.deducted", d.id, d.number || "", null, done);
      return done;
    },
    // Puts back what a document deducted, once, when it is voided.
    restoreStock(did, reason = "") {
      const rows = this.db
        .prepare(
          "SELECT * FROM ops_stock_movements m WHERE document_id=? AND kind='deduct' AND NOT EXISTS (SELECT 1 FROM ops_stock_movements r WHERE r.document_id=m.document_id AND r.service_id=m.service_id AND r.kind='reverse')",
        )
        .all(did);
      for (const m of rows) {
        const it = this.db.prepare("SELECT * FROM ops_stock_items WHERE service_id=?").get(m.service_id);
        move(this, it, "reverse", -m.quantity, `Voided${reason ? ": " + reason.slice(0, 200) : ""}`, did);
      }
      if (rows.length)
        this.audit("stock.reversed", did, reason, null, rows.map((m) => ({ service_id: m.service_id, quantity: -m.quantity })));
      return rows.length;
    },
    issue(idv) {
      return this.tx(() => {
        const out = original.issue.call(this, idv);
        this.deductStock(out);
        return out;
      });
    },
    void(idv, reason) {
      return this.tx(() => {
        const out = original.void.call(this, idv, reason);
        this.restoreStock(idv, typeof reason === "string" ? reason : "");
        return out;
      });
    },
    deleteService(sid) {
      return this.tx(() => {
        const tracked = this.db.prepare("SELECT 1 FROM ops_stock_items WHERE service_id=?").get(sid);
        if (tracked) {
          check(
            !this.db.prepare("SELECT 1 FROM ops_stock_movements WHERE service_id=?").get(sid),
            "This item has stock history. Mark it inactive instead.",
            409,
          );
          this.db.prepare("DELETE FROM ops_stock_items WHERE service_id=?").run(sid);
        }
        return original.deleteService.call(this, sid);
      });
    },
  });
}
