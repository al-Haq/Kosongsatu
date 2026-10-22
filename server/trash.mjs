// Recently deleted: every user delete keeps a full copy for KEEP_DAYS so it can
// be restored. A copy holds the record, the rows that depend on it (found
// through the foreign keys, e.g. a project's milestones or a client's portal
// contacts), its attached files with their bytes, and the links the delete
// cleared on rows that stay (e.g. time entries released from a draft invoice).
// Restoring puts the rows back exactly as they were and re-links what nobody
// has changed since. Sign-in sessions, access tokens and the audit trail are
// never copied.
import { randomUUID } from "node:crypto";
import { check, now, AppError } from "./domain.mjs";
import { requestContext } from "./context.mjs";

export const KEEP_DAYS = 30;
export const TRASH_MIGRATION = `CREATE TABLE trash(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  what TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  label TEXT NOT NULL,
  link TEXT,
  rows TEXT NOT NULL,
  links TEXT NOT NULL DEFAULT '[]',
  keys TEXT NOT NULL,
  files INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  deleted_by TEXT NOT NULL,
  deleted TEXT NOT NULL,
  expires TEXT NOT NULL
);
CREATE INDEX trash_expires ON trash(expires);`;

// Never copied or restored: sign-in state, access tokens and links, the audit
// trail, bookkeeping tables, and webhook delivery history (it points at events
// that are cleaned up on their own schedule).
const SKIP =
  /^(sqlite_|audit$|idempotency$|trash$|schema_migrations$|sessions$|recovery_codes$|team_tokens$|portal_sessions$|portal_login_tokens$|portal_links$|event_cursors$|platform_webhook_deliveries$|platform_webhook_attempts$)/;
// Columns that change on every write and say nothing about the link itself.
const NOISE = new Set(["updated", "__rowid"]);

// Tables, keys and foreign keys, read once per database connection.
const schemas = new WeakMap();
function schemaOf(db) {
  if (schemas.has(db)) return schemas.get(db);
  const tables = {};
  const refs = {};
  for (const { name, sql } of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all()) {
    const info = db.prepare(`PRAGMA table_info("${name}")`).all();
    const pk = info.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    tables[name] = {
      cols: new Set(info.map((c) => c.name)),
      key: pk.length === 1 ? pk[0] : null,
      rowid: !/WITHOUT\s+ROWID/i.test(sql || ""),
      fks: [],
    };
  }
  for (const name of Object.keys(tables))
    for (const f of db.prepare(`PRAGMA foreign_key_list("${name}")`).all()) {
      const fk = { table: name, from: f.from, parent: f.table, to: f.to || tables[f.table]?.key };
      if (!fk.to) continue;
      tables[name].fks.push(fk);
      (refs[f.table] ||= []).push(fk);
    }
  const out = { tables, refs };
  schemas.set(db, out);
  return out;
}

// Rows go into JSON; file bytes as base64.
const encode = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      v instanceof Uint8Array ? { $b64: Buffer.from(v).toString("base64") } : typeof v === "bigint" ? Number(v) : v,
    ]),
  );
const decode = (row) =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v && typeof v === "object" && "$b64" in v ? Buffer.from(v.$b64, "base64") : v]));
const chunks = (list, n = 400) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const same = (a, b) => (a instanceof Uint8Array && b instanceof Uint8Array ? Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0 : a === b);

// The record and everything that points at it, parents first.
function capture(db, sch, table, rid) {
  const rows = [];
  const seen = new Set();
  const visit = (t, col, values) => {
    const info = sch.tables[t];
    if (!info || SKIP.test(t) || !values.length) return;
    const found = [];
    const pick = info.rowid ? `rowid AS "__rowid", *` : "*";
    for (const part of chunks(values))
      for (const row of db.prepare(`SELECT ${pick} FROM "${t}" WHERE "${col}" IN (${part.map(() => "?").join(",")})`).all(...part)) {
        const k = t + "#" + (info.rowid ? row.__rowid : row[info.key]);
        if (seen.has(k)) continue;
        seen.add(k);
        found.push(row);
        rows.push({ table: t, row });
      }
    for (const ref of sch.refs[t] || []) {
      const vals = [...new Set(found.map((r) => r[ref.to]).filter((v) => v !== null && v !== undefined))];
      visit(ref.table, ref.from, vals);
    }
  };
  visit(table, sch.tables[table].key, [rid]);
  // Files attached to any of these records (record ids are UUIDs).
  const ids = [...new Set(rows.filter((x) => x.table !== "files" && typeof x.row.id === "string").map((x) => x.row.id))];
  visit("files", "entity_id", ids);
  return rows;
}
// What the delete removed, and what it changed on rows that stay.
function settle(db, sch, captured) {
  const gone = [];
  const links = [];
  for (const x of captured) {
    const info = sch.tables[x.table];
    const where = info.rowid ? `rowid=?` : `"${info.key}"=?`;
    const at = info.rowid ? x.row.__rowid : x.row[info.key];
    const after = db.prepare(`SELECT * FROM "${x.table}" WHERE ${where}`).get(at);
    if (!after) {
      gone.push(x);
      continue;
    }
    const before = {};
    for (const [k, v] of Object.entries(x.row)) if (!NOISE.has(k) && k in after && !same(v, after[k])) before[k] = v;
    // The whole row as the delete left it, so a later change of any kind leaves it alone.
    const state = Object.fromEntries(Object.entries(after).filter(([k]) => !NOISE.has(k)));
    if (Object.keys(before).length && info.key) links.push({ table: x.table, key: info.key, id: x.row[info.key], before, after: state });
  }
  return { gone, links };
}

const KIND_NAMES = {
  invoice: "Invoice",
  quote: "Quotation",
  proforma: "Proforma",
  sales_order: "Sales order",
  delivery_order: "Delivery order",
};
const sen = (v) => "RM " + (Number(v || 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nameOf = (store, table, rid) => (rid ? store.db.prepare(`SELECT name FROM "${table}" WHERE id=?`).get(rid)?.name || "" : "");
const join = (...parts) => parts.filter(Boolean).join(" · ");

// What each delete is called on screen, where a restored record opens, and
// what happens to it on restore. `what(row)` names the kind of record.
export const TRACKED = {
  deleteDraft: {
    table: "documents",
    what: (r) => `${KIND_NAMES[r.kind] || "Document"} draft`,
    label: (r, s) => join(nameOf(s, "clients", r.client_id), r.kind === "delivery_order" ? "" : sen(r.total)),
    link: (r) => `document/${r.id}`,
  },
  deleteClient: { table: "clients", what: () => "Client", label: (r) => r.name, link: (r) => `client/${r.id}` },
  deleteService: { table: "services", what: () => "Service", label: (r) => r.name },
  deleteSchedule: {
    table: "schedules",
    what: () => "Recurring plan",
    label: (r, s) => join(r.title, nameOf(s, "clients", r.client_id)),
    link: (r) => `plan/${r.id}`,
    // A plan comes back paused so missed periods are not billed at once.
    restore: (s, r) => {
      s.db.prepare("UPDATE schedules SET active=0 WHERE id=?").run(r.id);
      return "It is paused. Check the next date, then resume it.";
    },
  },
  deleteOpportunity: { table: "sales_opportunities", what: () => "Sales opportunity", label: (r) => r.title },
  deleteVendor: {
    table: "books_vendors",
    what: () => "Vendor",
    label: (r) => r.name,
    check: (s, r) =>
      check(
        r.archived || !s.db.prepare("SELECT 1 FROM books_vendors WHERE lower(name)=lower(?) AND id!=? AND archived=0").get(r.name, r.id),
        `Another vendor is now called ${r.name}. Rename or archive it first.`,
        409,
      ),
  },
  deleteExpense: { table: "books_expenses", what: () => "Expense", label: (r) => join(r.description || r.vendor_name, sen(r.amount), r.date) },
  deleteRecurringCost: { table: "books_recurring", what: () => "Recurring cost", label: (r) => join(r.name, sen(r.amount)) },
  deleteProject: { table: "ops_projects", what: () => "Project", label: (r) => r.name, link: (r) => `project/${r.id}` },
  deleteMilestone: {
    table: "ops_milestones",
    what: () => "Milestone",
    label: (r, s) => join(r.name, nameOf(s, "ops_projects", r.project_id)),
    link: (r) => `project/${r.project_id}`,
  },
  deleteTime: {
    table: "ops_time_entries",
    what: () => "Time entry",
    label: (r) => join(`${(Number(r.hours100 || 0) / 100).toFixed(2)} h`, r.description, r.entry_date),
  },
  deleteWorkLog: {
    table: "ops_work_logs",
    what: () => "Work log entry",
    label: (r) => join(r.log_date, r.person),
    link: (r) => `document/${r.document_id}`,
  },
  deleteWorkPhoto: { table: "files", what: () => "Work photo", label: (r) => r.name, link: (r) => `document/${r.entity_id}` },
  removeAttachment: { table: "files", what: () => "Attachment", label: (r) => r.name, link: (r) => `document/${r.entity_id}` },
  removeFile: { table: "files", what: () => "File", label: (r) => r.name },
  deleteRecurringContract: {
    table: "recurring_contracts",
    what: () => "Contract",
    label: (r, s) => join(r.title, nameOf(s, "clients", r.client_id)),
    link: (r) => `contract/${r.id}`,
  },
  deleteContact: {
    table: "portal_contacts",
    what: () => "Client contact",
    label: (r, s) => join(r.name || r.email, nameOf(s, "clients", r.client_id)),
    link: (r) => `client/${r.client_id}`,
  },
  removeWebhook: {
    table: "platform_webhooks",
    what: () => "Webhook endpoint",
    label: (r) => r.url,
    // An endpoint comes back switched off so a burst of events is not sent unasked.
    restore: (s, r) => {
      s.db.prepare("UPDATE platform_webhooks SET active=0 WHERE id=?").run(r.id);
      return "It is switched off. Turn it on when you are ready.";
    },
  },
};
const PARENT_NAMES = {
  clients: "client",
  documents: "document",
  services: "service",
  ops_projects: "project",
  books_vendors: "vendor",
  books_categories: "expense category",
  books_bills: "supplier bill",
  recurring_contracts: "contract",
  portal_contacts: "client contact",
};

// Runs fn (the original delete) and keeps a copy of what it removed. Nested
// tracked deletes belong to the outer one, so one action makes one entry.
export function track(store, method, rid, fn) {
  const spec = TRACKED[method];
  if (!spec || store._binDepth) return fn();
  return store.tx(() => {
    store._binDepth = (store._binDepth || 0) + 1;
    try {
      const sch = schemaOf(store.db);
      const info = sch.tables[spec.table];
      const root = info && rid ? store.db.prepare(`SELECT * FROM "${spec.table}" WHERE "${info.key}"=?`).get(String(rid)) : null;
      if (!root) return fn();
      const label = String(spec.label(root, store) || "").slice(0, 300) || "Untitled";
      const captured = capture(store.db, sch, spec.table, root[info.key]);
      const out = fn();
      const { gone, links } = settle(store.db, sch, captured);
      if (!gone.some((x) => x.table === spec.table && x.row[info.key] === root[info.key])) return out;
      const rows = gone.map((x) => ({ table: x.table, row: encode(x.row) }));
      const files = gone.filter((x) => x.table === "files");
      const bid = randomUUID();
      const at = new Date();
      store.db
        .prepare(
          "INSERT INTO trash(id,kind,what,entity_id,label,link,rows,links,keys,files,bytes,deleted_by,deleted,expires) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          bid,
          method,
          spec.what(root),
          String(root[info.key]),
          label,
          spec.link?.(root) || null,
          JSON.stringify(rows),
          JSON.stringify(links.map((l) => ({ ...l, before: encode(l.before), after: encode(l.after) }))),
          " " + gone.filter((x) => sch.tables[x.table].key).map((x) => `${x.table}:${x.row[sch.tables[x.table].key]}`).join(" ") + " ",
          files.length,
          files.reduce((n, x) => n + (x.row.size || 0), 0),
          requestContext.getStore()?.actor || "system",
          at.toISOString(),
          new Date(at.getTime() + KEEP_DAYS * 86400000).toISOString(),
        );
      const ctx = requestContext.getStore();
      if (ctx) ctx.binId = bid;
      return out;
    } finally {
      store._binDepth -= 1;
    }
  });
}

// What lists show; the copy itself (rows, files) stays on the server.
const LIST = "id,kind,what,entity_id,label,link,files,bytes,deleted_by,deleted,expires";
const summary = (e) => {
  return {
    id: e.id,
    kind: e.kind,
    what: e.what,
    label: e.label,
    deleted: e.deleted,
    deleted_by: e.deleted_by.replace(/^owner:/, ""),
    actor: e.deleted_by,
    expires: e.expires,
    files: e.files,
    bytes: e.bytes,
  };
};

export function attachTrash(Store) {
  Object.assign(Store.prototype, {
    trashEntry(bid) {
      const e = this.db.prepare("SELECT * FROM trash WHERE id=?").get(String(bid));
      check(e, "This item is no longer in Recently deleted.", 404);
      return e;
    },
    // Newest first; `actor` limits the list to one person's deletions.
    trashList(actor = null) {
      const rows = actor
        ? this.db.prepare(`SELECT ${LIST} FROM trash WHERE deleted_by=? ORDER BY deleted DESC`).all(actor)
        : this.db.prepare(`SELECT ${LIST} FROM trash ORDER BY deleted DESC`).all();
      return rows.map(summary);
    },
    trashRestore(bid) {
      return this.tx(() => {
        const e = this.trashEntry(bid);
        const spec = TRACKED[e.kind] || {};
        const sch = schemaOf(this.db);
        const rows = JSON.parse(e.rows).map((x) => ({ table: x.table, row: decode(x.row) }));
        const root = rows[0]?.row;
        check(root, "This copy is empty and cannot be restored.", 409);
        // Every record a row belongs to must exist, here or in the database.
        const here = new Set(rows.flatMap((x) => Object.entries(x.row).map(([k, v]) => `${x.table}.${k}=${v}`)));
        for (const x of rows)
          for (const fk of sch.tables[x.table]?.fks || []) {
            const v = x.row[fk.from];
            if (v === null || v === undefined || here.has(`${fk.parent}.${fk.to}=${v}`)) continue;
            if (this.db.prepare(`SELECT 1 FROM "${fk.parent}" WHERE "${fk.to}"=?`).get(v)) continue;
            const other = this.db
              .prepare(`SELECT ${LIST} FROM trash WHERE id!=? AND keys LIKE ? ORDER BY deleted DESC LIMIT 1`)
              .get(e.id, `% ${fk.parent}:${v} %`);
            if (other) {
              const o = summary(other);
              throw new AppError(`Restore the ${o.what.toLowerCase()} “${o.label}” first. It is also in Recently deleted.`, 409);
            }
            throw new AppError(
              `The ${PARENT_NAMES[fk.parent] || "record"} this belonged to no longer exists, so it cannot be restored.`,
              409,
            );
          }
        spec.check?.(this, root);
        for (const x of rows) {
          const info = sch.tables[x.table];
          check(info, "This copy was made by an older version and cannot be restored.", 409);
          // A restored document never brings back an old client link.
          if (x.table === "documents") Object.assign(x.row, { token_hash: null, token_expires: null });
          const cols = Object.keys(x.row).filter((k) => k !== "__rowid" && info.cols.has(k));
          try {
            this.db
              .prepare(`INSERT INTO "${x.table}"(${cols.map((c) => `"${c}"`).join(",")}) VALUES(${cols.map(() => "?").join(",")})`)
              .run(...cols.map((c) => x.row[c]));
          } catch (err) {
            if (err instanceof AppError) throw err;
            throw new AppError("A newer record now uses the same details, so this cannot be restored.", 409);
          }
        }
        // Links the delete cleared come back where nobody has changed them since.
        let kept = 0;
        for (const l of JSON.parse(e.links)) {
          const before = decode(l.before),
            after = decode(l.after);
          const cur = sch.tables[l.table] ? this.db.prepare(`SELECT * FROM "${l.table}" WHERE "${l.key}"=?`).get(l.id) : null;
          if (!cur || !Object.entries(after).every(([k, v]) => same(cur[k], v))) {
            kept += 1;
            continue;
          }
          const cols = Object.keys(before).filter((k) => sch.tables[l.table].cols.has(k));
          this.db
            .prepare(`UPDATE "${l.table}" SET ${cols.map((c) => `"${c}"=?`).join(",")} WHERE "${l.key}"=?`)
            .run(...cols.map((c) => before[c]), l.id);
        }
        const note = [spec.restore?.(this, root), kept ? "Some linked items changed since the delete and stay as they are." : ""]
          .filter(Boolean)
          .join(" ");
        this.db.prepare("DELETE FROM trash WHERE id=?").run(e.id);
        const s = summary(e);
        this.audit("trash.restored", e.entity_id, `${s.what}: ${e.label}`, { deleted: e.deleted, deleted_by: e.deleted_by }, null);
        return { ...s, entity_id: e.entity_id, link: e.link, note };
      });
    },
    // Removes a copy for good (the original delete stays in the audit trail).
    trashPurge(bid) {
      return this.tx(() => {
        const e = this.trashEntry(bid);
        this.db.prepare("DELETE FROM trash WHERE id=?").run(e.id);
        const s = summary(e);
        this.audit("trash.purged", e.entity_id, `${s.what}: ${e.label}`);
      });
    },
    // Copies older than KEEP_DAYS are removed for good.
    trashExpire(at = now()) {
      const n = this.db.prepare("DELETE FROM trash WHERE expires<=?").run(at).changes;
      if (n) this.audit("trash.expired", null, `${n} deleted item(s) older than ${KEEP_DAYS} days removed for good`);
      return n;
    },
  });
  // Every tracked delete keeps a copy. Wrapped last, so the copy also holds
  // what other modules remove or unlink along with the record.
  for (const method of Object.keys(TRACKED)) {
    const original = Store.prototype[method];
    if (typeof original !== "function") continue;
    Store.prototype[method] = function (rid, ...rest) {
      return track(this, method, rid, () => original.call(this, rid, ...rest));
    };
  }
}
