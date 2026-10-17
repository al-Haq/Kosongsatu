// Recurring billing: weekly to yearly schedules, multi-line plans, auto-issue and auto-send, late fees, contracts and retainers, monthly accountant report.
// Feature module contract: see docs/PLUGINS.md.
import { now, today, check, integer, AppError, addDays, text } from "../domain.mjs";
import { FREQUENCIES } from "../recurring-dates.mjs";
import { attachPlans, MODES, recipients } from "../recurring-plans.mjs";
import { attachContracts, RENEWALS } from "../recurring-contracts.mjs";
import { attachLateFees, LATE_FEE_DEFAULTS, normalizeLateFees, lateFeePolicy } from "../recurring-fees.mjs";
import { packData, packFiles, renderPackPdf, packCsv, zip } from "../recurring-pack.mjs";
import { processPeriod, sendRun, runDuePlans, runContracts, sendPack, runAccountantPack } from "../recurring-auto.mjs";

const HOUR = 3600000;
const CONFIG_DEFAULTS = {
  lateFees: LATE_FEE_DEFAULTS,
  pack: { enabled: false, email: "", day: 1 },
};
function normalizePack(b, current) {
  const out = { ...CONFIG_DEFAULTS.pack, ...current };
  if ("enabled" in b) out.enabled = b.enabled === true;
  if ("email" in b) out.email = recipients(b.email);
  if ("day" in b) out.day = integer(b.day, 1, 28);
  if (out.enabled) check(out.email, "Enter the accountant's email address.");
  return out;
}
// Existing monthly schedules become one-line plans; the service period now
// appears in the line text and plans can link to a contract.
const MIGRATIONS = [
  {
    name: "recurring-001-plans",
    foreignKeysOff: true,
    up(db) {
      db.exec(`
CREATE TABLE recurring_contracts(
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  title TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  value INTEGER NOT NULL DEFAULT 0 CHECK(value>=0),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  renewal TEXT NOT NULL DEFAULT 'manual' CHECK(renewal IN ('manual','notify','auto')),
  notice_days INTEGER NOT NULL DEFAULT 30,
  term_months INTEGER NOT NULL DEFAULT 12,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended','cancelled')),
  renewals INTEGER NOT NULL DEFAULT 0,
  notified_for TEXT,
  cancelled_on TEXT,
  cancel_reason TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created TEXT NOT NULL,
  updated TEXT NOT NULL,
  CHECK(end_date>=start_date)
);
CREATE INDEX recurring_contract_client_idx ON recurring_contracts(client_id);
CREATE TABLE recurring_contract_terms(
  contract_id TEXT NOT NULL REFERENCES recurring_contracts(id),
  term_no INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  source TEXT NOT NULL,
  created TEXT NOT NULL,
  PRIMARY KEY(contract_id,term_no),
  UNIQUE(contract_id,start_date)
);
CREATE TABLE schedules_new(
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  service_id TEXT REFERENCES services(id),
  title TEXT NOT NULL DEFAULT '',
  lines TEXT NOT NULL DEFAULT '[]',
  discount INTEGER NOT NULL DEFAULT 0 CHECK(discount>=0),
  notes TEXT NOT NULL DEFAULT '',
  terms_text TEXT,
  freq_unit TEXT NOT NULL DEFAULT 'month' CHECK(freq_unit IN ('week','month')),
  freq_interval INTEGER NOT NULL DEFAULT 1 CHECK(freq_interval BETWEEN 1 AND 12),
  next_date TEXT NOT NULL,
  end_date TEXT,
  terms INTEGER NOT NULL DEFAULT 14,
  anchor_day INTEGER,
  month_end INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'draft' CHECK(mode IN ('draft','issue','send')),
  include_link INTEGER NOT NULL DEFAULT 0,
  send_to TEXT NOT NULL DEFAULT '',
  contract_id TEXT REFERENCES recurring_contracts(id),
  active INTEGER NOT NULL DEFAULT 1,
  hold_period TEXT,
  last_error TEXT,
  last_error_step TEXT,
  last_error_at TEXT,
  created TEXT NOT NULL,
  updated TEXT
);
INSERT INTO schedules_new(id,client_id,service_id,next_date,terms,active,anchor_day,month_end,created,updated)
  SELECT id,client_id,service_id,next_date,terms,active,anchor_day,month_end,created,created FROM schedules;`);
      const service = db.prepare("SELECT * FROM services WHERE id=?");
      const set = db.prepare("UPDATE schedules_new SET title=?,lines=? WHERE id=?");
      for (const s of db.prepare("SELECT id,service_id FROM schedules_new").all()) {
        const v = s.service_id ? service.get(s.service_id) : null;
        if (!v) continue;
        set.run(
          v.name.slice(0, 120),
          JSON.stringify([
            {
              service_id: v.id,
              description: v.name.slice(0, 200),
              quantity: 1,
              rate: v.rate,
              tax_rate: v.tax_rate ?? 0,
              unit: v.unit || "",
            },
          ]),
          s.id,
        );
      }
      db.exec(`
DROP TABLE schedules;
ALTER TABLE schedules_new RENAME TO schedules;
CREATE INDEX schedule_client_idx ON schedules(client_id);
CREATE INDEX schedule_contract_idx ON schedules(contract_id);
ALTER TABLE schedule_runs ADD COLUMN created TEXT;
ALTER TABLE schedule_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE schedule_runs ADD COLUMN send_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE schedule_runs ADD COLUMN error TEXT;
ALTER TABLE schedule_runs ADD COLUMN error_step TEXT;
ALTER TABLE schedule_runs ADD COLUMN note TEXT;
ALTER TABLE schedule_runs ADD COLUMN updated TEXT;
ALTER TABLE clients ADD COLUMN late_fee_exempt INTEGER NOT NULL DEFAULT 0;
CREATE TABLE recurring_late_fees(
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES documents(id),
  charge_no INTEGER NOT NULL,
  amount INTEGER NOT NULL CHECK(amount>0),
  base INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('charged','failed')),
  adjustment_id TEXT REFERENCES adjustments(id),
  waiver_id TEXT REFERENCES adjustments(id),
  error TEXT,
  created TEXT NOT NULL,
  UNIQUE(invoice_id,charge_no)
);
CREATE TABLE recurring_fee_holds(invoice_id TEXT PRIMARY KEY REFERENCES documents(id), reason TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE recurring_config(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated TEXT NOT NULL);
CREATE TABLE recurring_packs(
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('auto','manual')),
  status TEXT NOT NULL CHECK(status IN ('sending','sent','failed')),
  recipients TEXT NOT NULL,
  error TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE UNIQUE INDEX recurring_pack_auto ON recurring_packs(month) WHERE source='auto';`);
    },
  },
];
export default {
  name: "recurring",
  migrations: MIGRATIONS,
  // Staff run plans and manage contracts; settings, late-fee waivers and
  // sending the accountant pack stay with the owner. Accountants read packs.
  access: {
    staff: [
      ["POST", /^\/api\/recurring\/schedules\/[\w-]+\/(run|retry|dismiss)$/],
      ["POST", /^\/api\/recurring\/runs\/[\w-]+\/send$/],
      ["POST", /^\/api\/recurring\/contracts$/],
      ["PUT", /^\/api\/recurring\/contracts\/[\w-]+$/],
      ["POST", /^\/api\/recurring\/contracts\/[\w-]+\/renew$/],
      ["GET", /^\/api\/recurring\/packs\//],
    ],
    accountant: [["GET", /^\/api\/recurring\/packs\//]],
  },
  secrets: [],
  attach(Store) {
    const originalClient = Store.prototype.saveClient;
    Object.assign(Store.prototype, {
      recurringConfig(key) {
        const row = this.db.prepare("SELECT value FROM recurring_config WHERE key=?").get(key);
        return { ...CONFIG_DEFAULTS[key], ...(row ? JSON.parse(row.value) : {}) };
      },
      saveRecurringConfig(b, asOf = today()) {
        return this.tx(() => {
          const before = { lateFees: this.recurringConfig("lateFees"), pack: this.recurringConfig("pack") };
          const after = { ...before };
          if (b.lateFees) after.lateFees = normalizeLateFees(b.lateFees, before.lateFees, asOf);
          if (b.pack) after.pack = normalizePack(b.pack, before.pack);
          const put = this.db.prepare(
            "INSERT INTO recurring_config(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated",
          );
          for (const k of Object.keys(CONFIG_DEFAULTS)) put.run(k, JSON.stringify(after[k]), now());
          this.audit("recurring.settings.changed", null, "Late fee and accountant pack settings", before, after);
          return after;
        });
      },
      // The client form sends recurring_fields=1 with the late fee checkbox.
      saveClient(b, idv) {
        return this.tx(() => {
          const out = originalClient.call(this, b, idv);
          const yes = (v) => [true, 1, "1", "on", "true"].includes(v);
          let exempt;
          if (String(b.recurring_fields ?? "") === "1" || "late_fee_exempt" in b) exempt = yes(b.late_fee_exempt);
          if (exempt !== undefined && !!out.late_fee_exempt !== exempt) {
            this.db.prepare("UPDATE clients SET late_fee_exempt=? WHERE id=?").run(exempt ? 1 : 0, out.id);
            this.audit(
              "client.late_fees",
              out.id,
              exempt ? "Late fees turned off for this client" : "Late fees apply to this client",
              { late_fee_exempt: out.late_fee_exempt },
              { late_fee_exempt: exempt ? 1 : 0 },
            );
          }
          return this.client(out.id);
        });
      },
    });
    attachPlans(Store);
    attachContracts(Store);
    attachLateFees(Store);
  },
  init(ctx) {
    ctx.services.recurring = {
      runDue: (options) => runDuePlans(ctx, options),
      packData: (month) => packData(ctx.store, month),
    };
  },
  routes: {
    async owner(r) {
      if (!r.path.startsWith("/api/recurring/")) return false;
      const { store } = r.ctx;
      const p = r.path.slice("/api/recurring".length),
        m = r.method;
      let x;
      if ((x = p.match(/^\/schedules\/([\w-]+)\/(run|retry|dismiss)$/)) && m === "POST") {
        const [, sid, action] = x;
        store.recurringPlan(sid);
        if (action === "dismiss") return r.send(200, store.recurringClearError(sid)), true;
        r.allow("recurring-run:" + r.session.owner_id, 60, 600000);
        if (action === "retry") store.recurringClearError(sid, { retry: true });
        const out = await processPeriod(r.ctx, sid, { asOf: today(), manual: true });
        return r.send(201, out), true;
      }
      if ((x = p.match(/^\/runs\/([\w-]+)\/send$/)) && m === "POST") {
        r.allow("email:" + r.session.owner_id, 30, 600000);
        const run = store.db.prepare("SELECT * FROM schedule_runs WHERE invoice_id=?").get(x[1]);
        check(run, "This invoice was not created by a recurring plan.", 404);
        return r.send(201, await sendRun(r.ctx, run.schedule_id, run.period, { manual: true })), true;
      }
      if (p === "/contracts" && m === "POST") {
        const b = await r.body();
        return r.send(201, r.write("recurring.contract.create", b, () => store.saveRecurringContract(b))), true;
      }
      if ((x = p.match(/^\/contracts\/([\w-]+)$/))) {
        if (m === "PUT") return r.send(200, store.saveRecurringContract(await r.body(), store.recurringContract(x[1]).id)), true;
        if (m === "DELETE") return store.deleteRecurringContract(x[1]), r.send(200, { ok: true }), true;
      }
      if ((x = p.match(/^\/contracts\/([\w-]+)\/(renew|cancel)$/)) && m === "POST") {
        const b = await r.body();
        if (x[2] === "renew") return r.send(200, store.renewRecurringContract(x[1])), true;
        return r.send(200, store.cancelRecurringContract(x[1], b.reason)), true;
      }
      if (p === "/settings" && m === "PUT") return r.send(200, store.saveRecurringConfig(await r.body())), true;
      if ((x = p.match(/^\/late-fees\/([\w-]+)\/(waive|hold)$/)) && m === "POST") {
        const b = await r.body();
        if (x[2] === "waive")
          return r.send(201, r.write("late-fee.waive:" + x[1], b, () => store.waiveLateFees(x[1], b.reason))), true;
        return r.send(200, store.holdLateFees(x[1], b.hold)), true;
      }
      if ((x = p.match(/^\/packs\/(\d{4}-\d{2})(?:\.(zip|pdf)|\/(invoices|receipts|sst)\.csv)$/)) && m === "GET") {
        const [, month, format, csvName] = x;
        check(month < today().slice(0, 7), "Choose a month that has ended.");
        const data = packData(store, month);
        if (csvName)
          return (
            r.send(200, packCsv(data)[csvName], {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition": `attachment; filename="${csvName}-${month}.csv"`,
            }),
            true
          );
        if (format === "pdf")
          return (
            r.send(200, await renderPackPdf(data), {
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename="accountant-pack-${month}.pdf"`,
            }),
            true
          );
        store.audit("accountant_pack.downloaded", null, month);
        return (
          r.send(200, zip(await packFiles(data)), {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="accountant-pack-${month}.zip"`,
          }),
          true
        );
      }
      if ((x = p.match(/^\/packs\/(\d{4}-\d{2})\/send$/)) && m === "POST") {
        r.allow("email:" + r.session.owner_id, 30, 600000);
        const b = await r.body();
        return r.send(201, await sendPack(r.ctx, x[1], { to: b.to ? recipients(b.to) : null })), true;
      }
      throw new AppError("Not found.", 404);
    },
  },
  // Each job checks hourly; every period, charge, notice and pack is handled at most once.
  jobs: [
    { name: "schedules", every: HOUR, delay: 20000, run: (ctx) => runDuePlans(ctx) },
    { name: "contracts", every: HOUR, delay: 25000, run: (ctx) => runContracts(ctx) },
    { name: "late-fees", every: HOUR, delay: 30000, run: (ctx) => ctx.store.runLateFees() },
    { name: "accountant-pack", every: HOUR, delay: 35000, run: (ctx) => runAccountantPack(ctx) },
  ],
  workspace(r) {
    const store = r.ctx.store,
      asOf = today();
    const lateFees = store.recurringConfig("lateFees");
    return {
      today: asOf,
      frequencies: Object.entries(FREQUENCIES).map(([key, f]) => ({ key, label: f.label, unit: f.unit, interval: f.interval })),
      modes: MODES,
      renewals: RENEWALS,
      plans: store.recurringPlans(asOf),
      contracts: store.recurringContracts(asOf),
      lateFees: { ...lateFees, policy: lateFeePolicy(lateFees) },
      exemptClients: store.db.prepare("SELECT id FROM clients WHERE late_fee_exempt=1").all().map((c) => c.id),
      holds: store.db.prepare("SELECT invoice_id FROM recurring_fee_holds").all().map((h) => h.invoice_id),
      charges: store.db
        .prepare(
          "SELECT f.invoice_id,f.charge_no,f.amount,f.status,f.error,f.created,a.number,w.number waiver_number FROM recurring_late_fees f LEFT JOIN adjustments a ON a.id=f.adjustment_id LEFT JOIN adjustments w ON w.id=f.waiver_id ORDER BY f.created DESC LIMIT 1000",
        )
        .all(),
      pack: store.recurringConfig("pack"),
      packs: store.db.prepare("SELECT * FROM recurring_packs ORDER BY created DESC LIMIT 24").all(),
      mail: r.ctx.mailer.status().configured,
    };
  },
  publicDocument(d, r) {
    return d.kind === "invoice" ? { lateFeePolicy: r.ctx.store.lateFeePolicyFor(d) } : {};
  },
  exportData(store) {
    return {
      plans: store.db.prepare("SELECT * FROM schedules ORDER BY created").all(),
      runs: store.db.prepare("SELECT * FROM schedule_runs ORDER BY schedule_id,period").all(),
      contracts: store.db.prepare("SELECT * FROM recurring_contracts ORDER BY created").all(),
      contractTerms: store.db.prepare("SELECT * FROM recurring_contract_terms ORDER BY contract_id,term_no").all(),
      lateFees: store.db.prepare("SELECT * FROM recurring_late_fees ORDER BY created").all(),
      lateFeeHolds: store.db.prepare("SELECT * FROM recurring_fee_holds ORDER BY created").all(),
      config: store.db.prepare("SELECT key,value,updated FROM recurring_config").all(),
      packs: store.db.prepare("SELECT * FROM recurring_packs ORDER BY created").all(),
    };
  },
  // A restored copy may be missing later runs, so nothing is issued, sent or charged
  // automatically until the owner turns it back on.
  onRestore(db) {
    try {
      db.exec(`UPDATE schedules SET mode='draft' WHERE mode<>'draft';
UPDATE recurring_config SET value=json_set(value,'$.enabled',json('false')) WHERE key IN ('lateFees','pack');`);
    } catch {
      // Backups taken before this module have no recurring tables to update.
    }
  },
  seedDemo(store) {
    const byName = (n) => store.db.prepare("SELECT * FROM clients WHERE name=?").get(n);
    const rimba = byName("Rimba Retail (Demo)"),
      bayu = byName("Bayu Design (Demo)");
    if (!rimba || !bayu) return;
    const t = today();
    const contract = store.saveRecurringContract({
      client_id: rimba.id,
      title: "Managed maintenance retainer",
      reference: "DEMO-RET-01",
      value: "9000.00",
      start_date: addDays(t, -345),
      end_date: addDays(t, 20),
      renewal: "notify",
      notice_days: 30,
      term_months: 12,
      notes: "Demonstration contract.",
      schedule_ids: store.db.prepare("SELECT id FROM schedules WHERE client_id=?").all(rimba.id).map((s) => s.id),
    });
    const maintenance = store.db.prepare("SELECT * FROM services WHERE name='Managed maintenance'").get();
    store.saveSchedule({
      client_id: bayu.id,
      title: text("Quarterly care plan", 120),
      frequency: "quarterly",
      next_date: addDays(t, 10),
      terms: 14,
      lines: [
        ...(maintenance ? [{ service_id: maintenance.id, quantity: 3 }] : []),
        { description: "Cloud backup monitoring", quantity: 1, rate: "120.00" },
      ],
      notes: "Demonstration plan. No real work or payment is represented.",
    });
    return contract;
  },
};
