// Timesheets, timer, projects and milestone billing (roadmap no. 68 and 69).
// Time and milestones are billed into draft invoices inside one transaction and
// linked to them, so nothing is billed twice. Deleting the draft (or voiding
// the invoice) releases them again; an issued invoice keeps them locked.
import {
  id,
  now,
  today,
  text,
  date,
  money,
  integer,
  check,
  addDays,
  currency,
  TAX_RATES,
} from "./domain.mjs";
export const PROJECT_STATUSES = ["planned", "active", "on_hold", "completed", "cancelled"];
export const MAX_RANGE_DAYS = 400;
// Hours to 2 decimals, stored as hundredths of an hour.
export function hours100(v) {
  check(typeof v === "string" || typeof v === "number", "Enter the hours worked.");
  const s = String(v).trim();
  check(/^\d{1,2}(\.\d{1,2})?$/.test(s), "Hours need at most 2 decimal places.");
  const [a, b = ""] = s.split(".");
  const n = Number(a) * 100 + Number(b.padEnd(2, "0"));
  check(n > 0 && n <= 2400, "Enter between 0.01 and 24 hours.");
  return n;
}
// Billable value of an entry, rounded like an invoice line.
export const timeValue = (e) => Math.round((e.rate * e.hours100) / 100);
const VALUE_SQL = "((rate*hours100+50)/100)";
const flag = (v) => v === true || v === "on" || v === "1" || v === 1 || v === "true";
const optional = (v) => (v === undefined ? undefined : v === null || v === "" ? null : v);
// Percentages to 2 decimals, stored as hundredths of a percent.
function percent100(v) {
  const s = String(v).trim();
  check(/^\d{1,3}(\.\d{1,2})?$/.test(s), "Use a percentage with at most 2 decimal places.");
  const [a, b = ""] = s.split(".");
  const n = Number(a) * 100 + Number(b.padEnd(2, "0"));
  check(n > 0 && n <= 10000, "Use a percentage between 0.01 and 100.");
  return n;
}
const label = (d) =>
  new Intl.DateTimeFormat("en-MY", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(d + "T00:00:00Z"),
  );
// The calendar day in Kuala Lumpur for an ISO timestamp.
export const klDate = (iso) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
export function milestoneAmount(m, project) {
  if (m.invoiced_amount != null && m.invoice_id) return m.invoiced_amount;
  return m.amount ?? Math.round(((project?.budget || 0) * (m.percent || 0)) / 10000);
}
export function attachWork(Store) {
  const original = {
    deleteDraft: Store.prototype.deleteDraft,
    void: Store.prototype.void,
    saveClient: Store.prototype.saveClient,
    deleteClient: Store.prototype.deleteClient,
    deleteService: Store.prototype.deleteService,
  };
  const project = (store, pid) => {
    const p = store.db.prepare("SELECT * FROM ops_projects WHERE id=?").get(pid);
    check(p, "Project not found.", 404);
    return p;
  };
  const milestone = (store, mid) => {
    const m = store.db.prepare("SELECT * FROM ops_milestones WHERE id=?").get(mid);
    check(m, "Milestone not found.", 404);
    return m;
  };
  const entry = (store, tid) => {
    const e = store.db.prepare("SELECT * FROM ops_time_entries WHERE id=?").get(tid);
    check(e, "Time entry not found.", 404);
    return e;
  };
  const activeClient = (store, cid, allowArchived = false) => {
    const c = store.client(cid);
    check(
      allowArchived || !c.archived,
      "This client is archived. Restore the client before adding new work.",
      409,
    );
    return c;
  };
  const invoiceState = (store, did) =>
    did ? store.db.prepare("SELECT state FROM documents WHERE id=?").get(did)?.state || null : null;
  // Milestones (other than `exceptId`), plus `extra`, must fit the project budget.
  const checkBudget = (store, p, budget, extra = null, exceptId = null) => {
    const list = store.db
      .prepare("SELECT * FROM ops_milestones WHERE project_id=? AND id IS NOT ?")
      .all(p.id, exceptId);
    if (extra) list.push(extra);
    check(
      budget > 0 || !list.some((m) => m.percent != null && !m.invoice_id),
      "Set a project budget before using percentage milestones.",
    );
    if (!budget) return;
    const total = list.reduce((s, m) => s + milestoneAmount(m, { budget }), 0);
    check(
      total <= budget,
      `Milestones would total ${currency(total)}, more than the project budget of ${currency(budget)}.`,
    );
  };
  // Releases time and milestones billed on a document (draft deleted or invoice voided).
  const release = (store, did, why) => {
    const time = store.db
      .prepare("UPDATE ops_time_entries SET invoice_id=NULL,updated=? WHERE invoice_id=?")
      .run(now(), did).changes;
    const ms = store.db
      .prepare("SELECT id,name FROM ops_milestones WHERE invoice_id=?")
      .all(did);
    store.db
      .prepare(
        "UPDATE ops_milestones SET invoice_id=NULL,invoiced_amount=NULL,status='ready',updated=? WHERE invoice_id=?",
      )
      .run(now(), did);
    if (time || ms.length)
      store.audit("billing.released", did, why, null, {
        time_entries: time,
        milestones: ms.map((m) => m.id),
      });
    return { time, milestones: ms.length };
  };
  Object.assign(Store.prototype, {
    // ---- Projects ----
    saveProject(b, pid) {
      return this.tx(() => {
        const old = pid ? project(this, pid) : null;
        const client_id = b.client_id || old?.client_id;
        activeClient(this, client_id, old && old.client_id === client_id);
        if (old && client_id !== old.client_id)
          check(
            !this.db.prepare("SELECT 1 FROM ops_time_entries WHERE project_id=?").get(pid) &&
              !this.db.prepare("SELECT 1 FROM ops_milestones WHERE project_id=? AND invoice_id IS NOT NULL").get(pid),
            "A project with time or invoices cannot change client.",
            409,
          );
        const pick = (key) => (b[key] === undefined ? old?.[key] ?? null : b[key] === "" || b[key] === null ? null : date(b[key]));
        const out = {
          id: pid || id(),
          client_id,
          name: text(b.name ?? old?.name, 160, true),
          description: text(b.description ?? old?.description ?? "", 1000),
          budget: b.budget === undefined ? old?.budget ?? 0 : b.budget === "" ? 0 : money(b.budget),
          start_date: pick("start_date"),
          end_date: pick("end_date"),
          status: text(b.status ?? old?.status ?? "active", 20, true),
          created: old?.created || now(),
          updated: now(),
        };
        check(PROJECT_STATUSES.includes(out.status), "Choose a valid project status.");
        check(!out.start_date || !out.end_date || out.end_date >= out.start_date, "The end date cannot be before the start date.");
        if (old) checkBudget(this, out, out.budget);
        this.db
          .prepare(
            "INSERT INTO ops_projects(id,client_id,name,description,budget,start_date,end_date,status,created,updated) VALUES(:id,:client_id,:name,:description,:budget,:start_date,:end_date,:status,:created,:updated) ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,name=excluded.name,description=excluded.description,budget=excluded.budget,start_date=excluded.start_date,end_date=excluded.end_date,status=excluded.status,updated=excluded.updated",
          )
          .run(out);
        this.audit("project.saved", out.id, out.name, old, out);
        return project(this, out.id);
      });
    },
    deleteProject(pid) {
      return this.tx(() => {
        const p = project(this, pid);
        check(
          !this.db.prepare("SELECT 1 FROM ops_time_entries WHERE project_id=?").get(pid) &&
            !this.db.prepare("SELECT 1 FROM ops_milestones WHERE project_id=? AND invoice_id IS NOT NULL").get(pid) &&
            !this.db.prepare("SELECT 1 FROM ops_timers WHERE project_id=?").get(pid),
          "This project has time or invoices. Mark it completed or cancelled instead.",
          409,
        );
        const ms = this.db.prepare("SELECT * FROM ops_milestones WHERE project_id=?").all(pid);
        this.db.prepare("DELETE FROM ops_milestones WHERE project_id=?").run(pid);
        this.db.prepare("DELETE FROM ops_projects WHERE id=?").run(pid);
        this.audit("project.deleted", pid, p.name, { ...p, milestones: ms }, null);
      });
    },
    // Budget, invoiced, paid and time for a project. Amounts are before SST;
    // paid is each linked invoice's paid share of the project's part of it.
    projectStats(pid) {
      const p = project(this, pid);
      const t = this.db
        .prepare(
          `SELECT count(*) entries, COALESCE(sum(hours100),0) hours, COALESCE(sum(CASE WHEN billable=1 THEN hours100 END),0) billable_hours, COALESCE(sum(CASE WHEN billable=1 AND invoice_id IS NULL THEN ${VALUE_SQL} END),0) unbilled, COALESCE(sum(CASE WHEN billable=1 AND invoice_id IS NULL THEN hours100 END),0) unbilled_hours FROM ops_time_entries WHERE project_id=?`,
        )
        .get(pid);
      const per = new Map();
      const add = (did, v) => per.set(did, (per.get(did) || 0) + v);
      const milestones = this.db.prepare("SELECT * FROM ops_milestones WHERE project_id=?").all(pid);
      for (const m of milestones) if (m.invoice_id) add(m.invoice_id, m.invoiced_amount || 0);
      for (const r of this.db
        .prepare(`SELECT invoice_id, sum(${VALUE_SQL}) v FROM ops_time_entries WHERE project_id=? AND invoice_id IS NOT NULL GROUP BY invoice_id`)
        .all(pid))
        add(r.invoice_id, r.v);
      let invoiced = 0,
        drafted = 0,
        paid = 0;
      const invoices = [];
      for (const [did, net] of per) {
        const d = this.document(did);
        if (d.state === "void") continue;
        invoices.push({ id: d.id, number: d.number, state: d.state, status: d.status, net, total: d.total, paid: d.paid });
        if (d.state === "draft") {
          drafted += net;
          continue;
        }
        invoiced += net;
        const due = d.adjusted_total ?? d.total;
        paid += due > 0 ? Math.round(net * Math.min(1, d.paid / due)) : 0;
      }
      const planned = milestones.reduce((s, m) => s + milestoneAmount(m, p), 0);
      return {
        budget: p.budget,
        planned,
        invoiced,
        drafted,
        paid,
        hours: t.hours,
        billable_hours: t.billable_hours,
        unbilled: t.unbilled,
        unbilled_hours: t.unbilled_hours,
        entries: t.entries,
        invoices,
      };
    },
    projectDetail(pid) {
      const p = project(this, pid);
      return {
        project: p,
        stats: this.projectStats(pid),
        milestones: this.milestones(pid),
        time: this.db
          .prepare("SELECT * FROM ops_time_entries WHERE project_id=? ORDER BY entry_date DESC,created DESC LIMIT 100")
          .all(pid)
          .map((e) => ({ ...e, value: timeValue(e), invoice_state: invoiceState(this, e.invoice_id) })),
      };
    },
    milestones(pid) {
      const p = project(this, pid);
      return this.db
        .prepare("SELECT * FROM ops_milestones WHERE project_id=? ORDER BY sort,due_date IS NULL,due_date,created")
        .all(pid)
        .map((m) => ({ ...m, effective: milestoneAmount(m, p), invoice_state: invoiceState(this, m.invoice_id) }));
    },
    // ---- Milestones ----
    saveMilestone(pid, b, mid) {
      return this.tx(() => {
        const old = mid ? milestone(this, mid) : null;
        const p = project(this, old?.project_id || pid);
        check(p.status !== "cancelled", "This project is cancelled.", 409);
        check(!old?.invoice_id, "This milestone is invoiced and locked.", 409);
        const usePercent = b.percent !== undefined && b.percent !== "" && b.percent !== null;
        const amount = b.amount ?? (old?.amount != null ? (old.amount / 100).toFixed(2) : "");
        check(usePercent || amount !== "", "Enter an amount or a percentage of the budget.");
        const out = {
          id: mid || id(),
          project_id: p.id,
          name: text(b.name ?? old?.name, 160, true),
          amount: usePercent ? null : money(amount),
          percent: usePercent ? percent100(b.percent) : null,
          tax_rate: integer(b.tax_rate ?? old?.tax_rate ?? 0, 0, 10),
          due_date: b.due_date === undefined ? old?.due_date ?? null : b.due_date ? date(b.due_date) : null,
          status: text(b.status ?? old?.status ?? "pending", 20, true),
          sort: old?.sort ?? this.db.prepare("SELECT COALESCE(max(sort),0)+1 n FROM ops_milestones WHERE project_id=?").get(p.id).n,
          created: old?.created || now(),
          updated: now(),
        };
        check(TAX_RATES.includes(out.tax_rate), "Choose an SST rate of 0, 5, 6, 8 or 10%.");
        check(["pending", "ready"].includes(out.status), "Choose pending or ready.");
        check(out.amount === null || out.amount > 0, "Enter a milestone amount greater than zero.");
        if (out.percent !== null) check(p.budget > 0, "Set a project budget before using percentage milestones.");
        checkBudget(this, p, p.budget, out, out.id);
        this.db
          .prepare(
            "INSERT INTO ops_milestones(id,project_id,name,amount,percent,tax_rate,due_date,status,sort,created,updated) VALUES(:id,:project_id,:name,:amount,:percent,:tax_rate,:due_date,:status,:sort,:created,:updated) ON CONFLICT(id) DO UPDATE SET name=excluded.name,amount=excluded.amount,percent=excluded.percent,tax_rate=excluded.tax_rate,due_date=excluded.due_date,status=excluded.status,updated=excluded.updated",
          )
          .run(out);
        this.audit("milestone.saved", out.id, `${p.name}: ${out.name}`, old, out);
        return milestone(this, out.id);
      });
    },
    setMilestoneReady(mid, ready) {
      return this.tx(() => {
        const m = milestone(this, mid);
        check(!m.invoice_id, "This milestone is invoiced and locked.", 409);
        const status = ready ? "ready" : "pending";
        this.db.prepare("UPDATE ops_milestones SET status=?,updated=? WHERE id=?").run(status, now(), mid);
        this.audit("milestone.status", mid, status, { status: m.status }, { status });
        return milestone(this, mid);
      });
    },
    deleteMilestone(mid) {
      return this.tx(() => {
        const m = milestone(this, mid);
        check(!m.invoice_id, "This milestone is invoiced. Delete the draft or void the invoice first.", 409);
        this.db.prepare("DELETE FROM ops_milestones WHERE id=?").run(mid);
        this.audit("milestone.deleted", mid, m.name, m, null);
      });
    },
    // One draft invoice line per milestone, created once.
    invoiceMilestone(mid, b = {}) {
      return this.tx(() => {
        const m = milestone(this, mid);
        const p = project(this, m.project_id);
        if (m.invoice_id) {
          const state = invoiceState(this, m.invoice_id);
          check(state === "void", "This milestone is already invoiced.", 409);
        }
        const c = activeClient(this, p.client_id);
        const amount = milestoneAmount({ ...m, invoice_id: null }, p);
        check(amount > 0, "This milestone has no amount to invoice.");
        const issue = b.issue_date ? date(b.issue_date) : today();
        const share = m.percent != null ? ` (${(m.percent / 100).toFixed(2).replace(/\.?0+$/, "")}% of budget)` : "";
        const d = this.saveDocument({
          kind: "invoice",
          client_id: c.id,
          issue_date: issue,
          due_date: addDays(issue, c.terms ?? 14),
          items: [
            {
              description: `${p.name}: ${m.name}${share}`.slice(0, 240),
              quantity: "1",
              rate: (amount / 100).toFixed(2),
              tax_rate: m.tax_rate,
            },
          ],
          notes: `Milestone billing for project ${p.name}.`,
        });
        this.db
          .prepare("UPDATE ops_milestones SET status='invoiced',invoice_id=?,invoiced_amount=?,updated=? WHERE id=?")
          .run(d.id, amount, now(), mid);
        this.audit("milestone.invoiced", mid, `${p.name}: ${m.name}`, { status: m.status, invoice_id: m.invoice_id }, { invoice_id: d.id, amount });
        return this.document(d.id);
      });
    },
    // ---- Time entries ----
    saveTime(b, tid) {
      return this.tx(() => {
        const old = tid ? entry(this, tid) : null;
        if (old)
          check(
            !old.invoice_id,
            "This time is on an invoice. Unlink it from the draft first; time on an issued invoice stays locked.",
            409,
          );
        const client_id = b.client_id || old?.client_id;
        const c = activeClient(this, client_id, old && old.client_id === client_id);
        const pick = (key) => (optional(b[key]) === undefined ? old?.[key] ?? null : optional(b[key]));
        const project_id = pick("project_id"),
          service_id = pick("service_id");
        if (project_id) {
          const p = project(this, project_id);
          check(p.client_id === client_id, "Choose a project for the same client.");
          check(p.status !== "cancelled" || old?.project_id === project_id, "This project is cancelled.", 409);
        }
        const service = service_id
          ? this.db.prepare("SELECT * FROM services WHERE id=?").get(service_id)
          : null;
        check(!service_id || service, "Service not found.", 404);
        const entry_date = date(b.entry_date ?? old?.entry_date ?? today());
        check(entry_date <= today(), "Time cannot be logged for a future date.");
        const billable = b.billable === undefined ? (old ? old.billable : 1) : flag(b.billable) ? 1 : 0;
        let rate;
        if (b.rate !== undefined && b.rate !== "" && b.rate !== null) rate = money(b.rate);
        else if (old && b.rate === undefined && old.service_id === service_id) rate = old.rate;
        else rate = service?.rate || c.ops_hourly_rate || 0;
        check(
          !billable || rate > 0,
          "Enter an hourly rate, choose a service with a rate, or set the client's default hourly rate.",
        );
        const out = {
          id: tid || id(),
          client_id,
          project_id,
          service_id,
          entry_date,
          description: text(b.description ?? old?.description, 240, true),
          hours100: b.hours === undefined && old ? old.hours100 : hours100(b.hours),
          billable,
          rate,
          source: old?.source || (b.source === "timer" ? "timer" : "manual"),
          created: old?.created || now(),
          updated: now(),
        };
        this.db
          .prepare(
            "INSERT INTO ops_time_entries(id,client_id,project_id,service_id,entry_date,description,hours100,billable,rate,source,created,updated) VALUES(:id,:client_id,:project_id,:service_id,:entry_date,:description,:hours100,:billable,:rate,:source,:created,:updated) ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,project_id=excluded.project_id,service_id=excluded.service_id,entry_date=excluded.entry_date,description=excluded.description,hours100=excluded.hours100,billable=excluded.billable,rate=excluded.rate,updated=excluded.updated",
          )
          .run(out);
        this.audit("time.saved", out.id, `${(out.hours100 / 100).toFixed(2)} h ${out.entry_date}`, old, out);
        const e = entry(this, out.id);
        return { ...e, value: timeValue(e) };
      });
    },
    deleteTime(tid) {
      return this.tx(() => {
        const e = entry(this, tid);
        check(!e.invoice_id, "This time is on an invoice and cannot be deleted.", 409);
        this.db.prepare("DELETE FROM ops_time_entries WHERE id=?").run(tid);
        this.audit("time.deleted", tid, e.description, e, null);
      });
    },
    timeEntries(q = {}) {
      const where = [],
        args = [];
      const to = q.to ? date(q.to) : today(),
        from = q.from ? date(q.from) : addDays(to, -6);
      check(from <= to && addDays(from, MAX_RANGE_DAYS) >= to, `Choose a period of up to ${MAX_RANGE_DAYS} days.`);
      if (!q.unbilled) {
        where.push("entry_date BETWEEN ? AND ?");
        args.push(from, to);
      } else where.push("billable=1 AND invoice_id IS NULL");
      if (q.client_id) {
        where.push("client_id=?");
        args.push(String(q.client_id));
      }
      if (q.project_id) {
        where.push("project_id=?");
        args.push(String(q.project_id));
      }
      return {
        from,
        to,
        entries: this.db
          .prepare(`SELECT * FROM ops_time_entries WHERE ${where.join(" AND ")} ORDER BY entry_date,created LIMIT 2000`)
          .all(...args)
          .map((e) => ({ ...e, value: timeValue(e), invoice_state: invoiceState(this, e.invoice_id) })),
      };
    },
    // Groups unbilled billable time into one new draft invoice, links the
    // entries to it and returns it. Runs in one transaction.
    invoiceTime(b) {
      return this.tx(() => {
        const c = activeClient(this, b.client_id);
        const p = b.project_id ? project(this, b.project_id) : null;
        check(!p || p.client_id === c.id, "Choose a project for the same client.");
        const args = [c.id];
        let sql = "SELECT * FROM ops_time_entries WHERE client_id=? AND billable=1 AND invoice_id IS NULL";
        if (p) {
          sql += " AND project_id=?";
          args.push(p.id);
        }
        if (b.to) {
          sql += " AND entry_date<=?";
          args.push(date(b.to));
        }
        let rows = this.db.prepare(sql + " ORDER BY entry_date,created").all(...args);
        if (b.entry_ids !== undefined) {
          check(
            Array.isArray(b.entry_ids) && b.entry_ids.length <= 1000 && b.entry_ids.every((x) => typeof x === "string"),
            "Choose the time entries to bill.",
          );
          const wanted = new Set(b.entry_ids);
          rows = rows.filter((r) => wanted.has(r.id));
          check(
            rows.length === wanted.size,
            "Some of the chosen time is already billed, not billable or for another client. Refresh and try again.",
            409,
          );
        }
        check(rows.length, "There is no unbilled billable time for this selection.", 409);
        const fallback = integer(b.tax_rate ?? 0, 0, 10);
        check(TAX_RATES.includes(fallback), "Choose an SST rate of 0, 5, 6, 8 or 10%.");
        const services = new Map(this.db.prepare("SELECT * FROM services").all().map((s) => [s.id, s]));
        const projects = new Map(
          this.db.prepare("SELECT id,name FROM ops_projects WHERE client_id=?").all(c.id).map((x) => [x.id, x]),
        );
        const taxOf = (r) => (r.service_id && services.get(r.service_id) ? services.get(r.service_id).tax_rate ?? 0 : fallback);
        const items = [];
        if (b.group === "entry") {
          for (const r of rows)
            items.push({
              description: `${label(r.entry_date)}: ${r.description}`.slice(0, 240),
              quantity: (r.hours100 / 100).toFixed(2),
              rate: (r.rate / 100).toFixed(2),
              tax_rate: taxOf(r),
            });
        } else {
          const groups = new Map();
          for (const r of rows) {
            const key = [r.project_id || "", r.service_id || "", r.rate, taxOf(r)].join("|");
            const g = groups.get(key) || { rows: [], first: r.entry_date, last: r.entry_date, hours: 0 };
            g.rows.push(r);
            g.hours += r.hours100;
            g.last = r.entry_date;
            groups.set(key, g);
          }
          for (const g of groups.values()) {
            const r = g.rows[0];
            const name = [services.get(r.service_id)?.name || "Professional services", projects.get(r.project_id)?.name]
              .filter(Boolean)
              .join(" - ");
            const period = g.first === g.last ? label(g.first) : `${label(g.first)} to ${label(g.last)}`;
            check(g.hours <= 9999999, "Too many hours on one line.");
            items.push({
              description: `${name} (${period})`.slice(0, 240),
              quantity: (g.hours / 100).toFixed(2),
              rate: (r.rate / 100).toFixed(2),
              tax_rate: taxOf(r),
            });
          }
        }
        check(
          items.length <= 50,
          "That is more than 50 invoice lines. Group by service and rate, or bill a shorter period.",
        );
        const issue = b.issue_date ? date(b.issue_date) : today();
        const hours = rows.reduce((s, r) => s + r.hours100, 0);
        const d = this.saveDocument({
          kind: "invoice",
          client_id: c.id,
          issue_date: issue,
          due_date: addDays(issue, c.terms ?? 14),
          items,
          notes: `Time billed: ${rows.length} ${rows.length === 1 ? "entry" : "entries"}, ${(hours / 100).toFixed(2)} hours, ${label(rows[0].entry_date)} to ${label(rows[rows.length - 1].entry_date)}${p ? `, project ${p.name}` : ""}.`.slice(0, 2000),
        });
        const link = this.db.prepare(
          "UPDATE ops_time_entries SET invoice_id=?,updated=? WHERE id=? AND invoice_id IS NULL",
        );
        let linked = 0;
        for (const r of rows) linked += link.run(d.id, now(), r.id).changes;
        check(linked === rows.length, "Some time was billed at the same moment. Try again.", 409);
        this.audit("time.invoiced", d.id, `${rows.length} entries, ${(hours / 100).toFixed(2)} h`, null, {
          entries: rows.map((r) => r.id),
        });
        return this.document(d.id);
      });
    },
    // Unlinks time and milestones from a draft so they can be billed again.
    unlinkBilling(did) {
      return this.tx(() => {
        const d = this.document(did);
        check(d.state === "draft", "Only a draft invoice can release its time and milestones.", 409);
        return release(this, did, "Unlinked from the draft by the owner");
      });
    },
    // ---- Timer (the start time lives on the server) ----
    timer() {
      return this.db.prepare("SELECT * FROM ops_timers WHERE id=1").get() || null;
    },
    startTimer(b) {
      return this.tx(() => {
        check(!this.timer(), "A timer is already running. Stop it first.", 409);
        const c = activeClient(this, b.client_id);
        const project_id = optional(b.project_id) || null,
          service_id = optional(b.service_id) || null;
        if (project_id) {
          const p = project(this, project_id);
          check(p.client_id === c.id && p.status !== "cancelled", "Choose an open project for the same client.");
        }
        if (service_id) check(this.db.prepare("SELECT 1 FROM services WHERE id=?").get(service_id), "Service not found.", 404);
        const t = {
          client_id: c.id,
          project_id,
          service_id,
          description: text(b.description || "", 240),
          billable: b.billable === undefined ? 1 : flag(b.billable) ? 1 : 0,
          rate: b.rate === undefined || b.rate === "" || b.rate === null ? null : money(b.rate),
          started: now(),
        };
        this.db
          .prepare(
            "INSERT INTO ops_timers(id,client_id,project_id,service_id,description,billable,rate,started) VALUES(1,:client_id,:project_id,:service_id,:description,:billable,:rate,:started)",
          )
          .run(t);
        this.audit("timer.started", c.id, t.description);
        return this.timer();
      });
    },
    stopTimer(b = {}) {
      return this.tx(() => {
        const t = this.timer();
        check(t, "No timer is running.", 404);
        const ms = Date.now() - Date.parse(t.started);
        const h = Math.max(1, Math.round(ms / 36000));
        check(
          h <= 2400,
          "The timer ran for more than 24 hours. Discard it and add the time by hand.",
          409,
        );
        const description = text(b.description ?? t.description ?? "", 240);
        check(description, "Add a short description of the work before stopping the timer.");
        const e = this.saveTime({
          entry_date: klDate(t.started),
          client_id: t.client_id,
          project_id: t.project_id || "",
          service_id: t.service_id || "",
          description,
          hours: (h / 100).toFixed(2),
          billable: !!t.billable,
          rate: b.rate ?? (t.rate == null ? "" : (t.rate / 100).toFixed(2)),
          source: "timer",
        });
        this.db.prepare("DELETE FROM ops_timers WHERE id=1").run();
        this.audit("timer.stopped", e.id, `${(h / 100).toFixed(2)} h`);
        return e;
      });
    },
    discardTimer() {
      return this.tx(() => {
        const t = this.timer();
        check(t, "No timer is running.", 404);
        this.db.prepare("DELETE FROM ops_timers WHERE id=1").run();
        this.audit("timer.discarded", t.client_id, t.started, t, null);
      });
    },
    workSummary() {
      const projects = this.db.prepare("SELECT * FROM ops_projects ORDER BY status='completed',status='cancelled',updated DESC").all();
      const docs = this.db.prepare("SELECT id,state FROM documents WHERE id=?");
      const links = {};
      const linkOf = (did) => (links[did] ||= { time: 0, hours100: 0, milestones: [] });
      for (const r of this.db
        .prepare("SELECT invoice_id, count(*) n, sum(hours100) h FROM ops_time_entries WHERE invoice_id IS NOT NULL GROUP BY invoice_id")
        .all()) {
        const l = linkOf(r.invoice_id);
        l.time = r.n;
        l.hours100 = r.h;
      }
      for (const m of this.db
        .prepare("SELECT m.id,m.name,m.invoice_id,p.name project FROM ops_milestones m JOIN ops_projects p ON p.id=m.project_id WHERE m.invoice_id IS NOT NULL")
        .all())
        linkOf(m.invoice_id).milestones.push({ id: m.id, name: m.name, project: m.project });
      for (const did of Object.keys(links)) links[did].state = docs.get(did)?.state || null;
      return {
        timer: this.timer(),
        projects: projects.map((p) => ({ ...p, stats: this.projectStats(p.id) })),
        milestones: this.db
          .prepare("SELECT m.*, p.client_id, p.name project FROM ops_milestones m JOIN ops_projects p ON p.id=m.project_id ORDER BY m.due_date IS NULL,m.due_date,m.created")
          .all()
          .map((m) => ({ ...m, effective: milestoneAmount(m, projects.find((p) => p.id === m.project_id)) })),
        unbilled: this.db
          .prepare(
            `SELECT client_id, project_id, count(*) entries, sum(hours100) hours, sum(${VALUE_SQL}) value, min(entry_date) first, max(entry_date) last FROM ops_time_entries WHERE billable=1 AND invoice_id IS NULL GROUP BY client_id, project_id ORDER BY client_id, project_id`,
          )
          .all(),
        links,
      };
    },
    // ---- Core hooks ----
    deleteDraft(did) {
      return this.tx(() => {
        if (this.db.prepare("SELECT state FROM documents WHERE id=?").get(did)?.state === "draft")
          release(this, did, "Draft deleted");
        return original.deleteDraft.call(this, did);
      });
    },
    void(idv, reason) {
      return this.tx(() => {
        const out = original.void.call(this, idv, reason);
        release(this, idv, "Invoice voided");
        return out;
      });
    },
    // A default hourly rate per client for timesheets (client form field).
    saveClient(b, idv) {
      return this.tx(() => {
        const out = original.saveClient.call(this, b, idv);
        if (b.ops_hourly_rate !== undefined) {
          const rate = b.ops_hourly_rate === "" || b.ops_hourly_rate === null ? 0 : money(b.ops_hourly_rate);
          if (rate !== (out.ops_hourly_rate || 0)) {
            this.db.prepare("UPDATE clients SET ops_hourly_rate=? WHERE id=?").run(rate, out.id);
            this.audit("client.hourly_rate", out.id, (rate / 100).toFixed(2), { ops_hourly_rate: out.ops_hourly_rate || 0 }, { ops_hourly_rate: rate });
          }
          return this.client(out.id);
        }
        return out;
      });
    },
    deleteClient(cid) {
      check(
        !this.db.prepare("SELECT 1 FROM ops_projects WHERE client_id=?").get(cid) &&
          !this.db.prepare("SELECT 1 FROM ops_time_entries WHERE client_id=?").get(cid) &&
          !this.db.prepare("SELECT 1 FROM ops_timers WHERE client_id=?").get(cid),
        "This client has projects or time entries. Archive the client instead.",
        409,
      );
      return original.deleteClient.call(this, cid);
    },
    deleteService(sid) {
      return this.tx(() => {
        check(
          !this.db.prepare("SELECT 1 FROM ops_timers WHERE service_id=?").get(sid),
          "A running timer uses this service. Stop it first.",
          409,
        );
        // Time entries keep their own rate, so the catalog link is only informational.
        this.db.prepare("UPDATE ops_time_entries SET service_id=NULL WHERE service_id=?").run(sid);
        return original.deleteService.call(this, sid);
      });
    },
  });
}
