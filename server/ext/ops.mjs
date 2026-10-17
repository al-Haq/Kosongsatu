// Operations: partial and amended customer POs, timesheets, projects and milestones, inventory and proof of work.
// Feature module contract: see docs/PLUGINS.md. Owner guide: docs/features/ops.md.
import { attachPO } from "../ops-po.mjs";
import { attachWork, timeValue } from "../ops-work.mjs";
import { attachStock } from "../ops-stock.mjs";
import { attachProof } from "../ops-proof.mjs";
import { ownerRoutes, guestRoutes } from "../ops-routes.mjs";
import { today, addDays } from "../domain.mjs";
export const OPS_MIGRATIONS = [
  {
    // Several POs per quotation (partial POs) with revisions. The table is rebuilt
    // to drop UNIQUE(quote_id); existing POs become revision 0.
    name: "ops-001-partial-customer-pos",
    foreignKeysOff: true,
    sql: `CREATE TABLE customer_pos_next(
 id TEXT PRIMARY KEY,
 client_id TEXT NOT NULL REFERENCES clients(id),
 quote_id TEXT NOT NULL REFERENCES documents(id),
 reference TEXT NOT NULL,
 reference_key TEXT NOT NULL,
 amount INTEGER NOT NULL CHECK(amount>0),
 po_date TEXT NOT NULL,
 notes TEXT NOT NULL,
 invoice_id TEXT UNIQUE REFERENCES documents(id),
 created TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','cancelled')),
 updated TEXT,
 UNIQUE(client_id,reference_key)
);
INSERT INTO customer_pos_next(id,client_id,quote_id,reference,reference_key,amount,po_date,notes,invoice_id,created,updated)
 SELECT id,client_id,quote_id,reference,reference_key,amount,po_date,notes,invoice_id,created,created FROM customer_pos;
DROP TABLE customer_pos;
ALTER TABLE customer_pos_next RENAME TO customer_pos;
CREATE INDEX customer_po_quote_idx ON customer_pos(quote_id,status);
CREATE TABLE ops_po_revisions(
 po_id TEXT NOT NULL REFERENCES customer_pos(id),
 revision INTEGER NOT NULL,
 reference TEXT NOT NULL,
 amount INTEGER NOT NULL,
 po_date TEXT NOT NULL,
 notes TEXT NOT NULL,
 status TEXT NOT NULL,
 reason TEXT NOT NULL,
 changes TEXT NOT NULL DEFAULT '[]',
 actor TEXT NOT NULL,
 created TEXT NOT NULL,
 PRIMARY KEY(po_id,revision)
);
INSERT INTO ops_po_revisions(po_id,revision,reference,amount,po_date,notes,status,reason,changes,actor,created)
 SELECT id,0,reference,amount,po_date,notes,'open','Registered','[]','system',created FROM customer_pos;`,
  },
  {
    name: "ops-002-projects-time",
    sql: `ALTER TABLE clients ADD COLUMN ops_hourly_rate INTEGER NOT NULL DEFAULT 0;
CREATE TABLE ops_projects(
 id TEXT PRIMARY KEY,
 client_id TEXT NOT NULL REFERENCES clients(id),
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 budget INTEGER NOT NULL DEFAULT 0 CHECK(budget>=0),
 start_date TEXT,
 end_date TEXT,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('planned','active','on_hold','completed','cancelled')),
 created TEXT NOT NULL,
 updated TEXT NOT NULL
);
CREATE INDEX ops_project_client_idx ON ops_projects(client_id);
CREATE TABLE ops_milestones(
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES ops_projects(id),
 name TEXT NOT NULL,
 amount INTEGER CHECK(amount IS NULL OR amount>0),
 percent INTEGER CHECK(percent IS NULL OR (percent>0 AND percent<=10000)),
 tax_rate INTEGER NOT NULL DEFAULT 0,
 due_date TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','invoiced')),
 invoice_id TEXT UNIQUE REFERENCES documents(id),
 invoiced_amount INTEGER,
 sort INTEGER NOT NULL DEFAULT 0,
 created TEXT NOT NULL,
 updated TEXT NOT NULL,
 CHECK((amount IS NULL) <> (percent IS NULL))
);
CREATE INDEX ops_milestone_project_idx ON ops_milestones(project_id);
CREATE TABLE ops_time_entries(
 id TEXT PRIMARY KEY,
 client_id TEXT NOT NULL REFERENCES clients(id),
 project_id TEXT REFERENCES ops_projects(id),
 service_id TEXT REFERENCES services(id),
 entry_date TEXT NOT NULL,
 description TEXT NOT NULL,
 hours100 INTEGER NOT NULL CHECK(hours100>0 AND hours100<=2400),
 billable INTEGER NOT NULL DEFAULT 1,
 rate INTEGER NOT NULL DEFAULT 0 CHECK(rate>=0),
 invoice_id TEXT REFERENCES documents(id),
 source TEXT NOT NULL DEFAULT 'manual',
 created TEXT NOT NULL,
 updated TEXT NOT NULL
);
CREATE INDEX ops_time_client_idx ON ops_time_entries(client_id,invoice_id);
CREATE INDEX ops_time_date_idx ON ops_time_entries(entry_date);
CREATE INDEX ops_time_invoice_idx ON ops_time_entries(invoice_id);
CREATE INDEX ops_time_project_idx ON ops_time_entries(project_id);
CREATE TABLE ops_timers(
 id INTEGER PRIMARY KEY CHECK(id=1),
 client_id TEXT NOT NULL REFERENCES clients(id),
 project_id TEXT REFERENCES ops_projects(id),
 service_id TEXT REFERENCES services(id),
 description TEXT NOT NULL DEFAULT '',
 billable INTEGER NOT NULL DEFAULT 1,
 rate INTEGER,
 started TEXT NOT NULL
);`,
  },
  {
    name: "ops-003-inventory",
    sql: `CREATE TABLE ops_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO ops_settings(key,value) VALUES('inventory_enabled','0'),('stock_trigger','invoice');
CREATE TABLE ops_stock_items(
 service_id TEXT PRIMARY KEY REFERENCES services(id),
 sku TEXT NOT NULL DEFAULT '',
 sku_key TEXT NOT NULL DEFAULT '',
 on_hand INTEGER NOT NULL DEFAULT 0,
 reorder_level INTEGER NOT NULL DEFAULT 0 CHECK(reorder_level>=0),
 active INTEGER NOT NULL DEFAULT 1,
 created TEXT NOT NULL,
 updated TEXT NOT NULL
);
CREATE UNIQUE INDEX ops_stock_sku_idx ON ops_stock_items(sku_key) WHERE sku_key<>'';
CREATE TABLE ops_stock_movements(
 id TEXT PRIMARY KEY,
 service_id TEXT NOT NULL REFERENCES services(id),
 kind TEXT NOT NULL CHECK(kind IN ('receive','adjust','deduct','reverse')),
 quantity INTEGER NOT NULL CHECK(quantity<>0),
 balance INTEGER NOT NULL,
 reason TEXT NOT NULL DEFAULT '',
 document_id TEXT REFERENCES documents(id),
 actor TEXT NOT NULL,
 created TEXT NOT NULL
);
CREATE INDEX ops_movement_item_idx ON ops_stock_movements(service_id,created);
CREATE UNIQUE INDEX ops_movement_doc_idx ON ops_stock_movements(document_id,service_id,kind) WHERE document_id IS NOT NULL;`,
  },
  {
    name: "ops-004-proof-of-work",
    sql: `CREATE TABLE ops_work_logs(
 id TEXT PRIMARY KEY,
 document_id TEXT NOT NULL REFERENCES documents(id),
 log_date TEXT NOT NULL,
 person TEXT NOT NULL,
 notes TEXT NOT NULL,
 visible INTEGER NOT NULL DEFAULT 0,
 created TEXT NOT NULL,
 updated TEXT NOT NULL
);
CREATE INDEX ops_work_log_doc_idx ON ops_work_logs(document_id,log_date);
CREATE TABLE ops_work_reports(
 document_id TEXT PRIMARY KEY REFERENCES documents(id),
 report TEXT NOT NULL DEFAULT '',
 visible INTEGER NOT NULL DEFAULT 0,
 pdf INTEGER NOT NULL DEFAULT 1,
 updated TEXT NOT NULL
);`,
  },
];
export default {
  name: "ops",
  migrations: OPS_MIGRATIONS,
  // Staff do the day-to-day work (time, projects, POs, stock movements, proof
  // of work); inventory settings and project deletion stay with the owner.
  access: {
    staff: [
      ["GET", /^\/api\/ops\//],
      ["POST", /^\/api\/ops\//],
      ["PUT", /^\/api\/ops\/(?!inventory$)/],
      ["DELETE", /^\/api\/ops\/(time|milestones|photos|logs)\/[\w-]+$/],
    ],
    accountant: [["GET", /^\/api\/ops\//]],
  },
  secrets: [],
  attach(Store) {
    attachPO(Store);
    attachWork(Store);
    attachStock(Store);
    attachProof(Store);
  },
  init() {},
  routes: { owner: ownerRoutes, guest: guestRoutes },
  jobs: [],
  workspace(r) {
    const store = r.ctx.store;
    return {
      ...store.workSummary(),
      inventory: { ...store.inventorySettings(), items: store.stockItems() },
    };
  },
  publicDocument(d, r) {
    return { work: r.ctx.store.publicWork(d.id) };
  },
  exportData(store) {
    const all = (sql) => store.db.prepare(sql).all();
    return {
      poRevisions: all("SELECT * FROM ops_po_revisions ORDER BY po_id,revision"),
      projects: all("SELECT * FROM ops_projects ORDER BY created"),
      milestones: all("SELECT * FROM ops_milestones ORDER BY project_id,sort"),
      timeEntries: all("SELECT * FROM ops_time_entries ORDER BY entry_date,created").map((e) => ({ ...e, value: timeValue(e) })),
      timer: all("SELECT * FROM ops_timers"),
      inventory: store.inventorySettings(),
      stockItems: all("SELECT * FROM ops_stock_items ORDER BY service_id"),
      stockMovements: all("SELECT * FROM ops_stock_movements ORDER BY created"),
      workLogs: all("SELECT * FROM ops_work_logs ORDER BY document_id,log_date"),
      workReports: all("SELECT * FROM ops_work_reports"),
    };
  },
  seedDemo(store) {
    const client = store.db.prepare("SELECT * FROM clients ORDER BY created LIMIT 1").get();
    if (!client || store.db.prepare("SELECT 1 FROM ops_projects LIMIT 1").get()) return;
    store.saveClient({ ...client, ops_hourly_rate: "200.00" }, client.id);
    const consulting = store.db.prepare("SELECT id FROM services WHERE name='Technical consulting'").get();
    const p = store.saveProject({
      client_id: client.id,
      name: "Office network upgrade (Demo)",
      description: "Demonstration project. No real work is represented.",
      budget: "9000.00",
      start_date: addDays(today(), -21),
      end_date: addDays(today(), 30),
      status: "active",
    });
    const first = store.saveMilestone(p.id, { name: "Site survey and design", percent: "30", due_date: addDays(today(), -7) });
    store.setMilestoneReady(first.id, true);
    store.saveMilestone(p.id, { name: "Installation", percent: "50", due_date: addDays(today(), 14) });
    store.saveMilestone(p.id, { name: "Handover and training", amount: "1800.00", due_date: addDays(today(), 30) });
    for (const [days, hours, description] of [
      [-6, "3.5", "Site survey and cabling plan"],
      [-5, "2", "Switch configuration"],
      [-2, "1.25", "Firewall rules review"],
    ])
      store.saveTime({
        entry_date: addDays(today(), days),
        client_id: client.id,
        project_id: p.id,
        service_id: consulting?.id || "",
        description,
        hours,
        billable: true,
      });
  },
};
