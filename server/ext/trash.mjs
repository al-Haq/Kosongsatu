// Recently deleted: a 30-day copy of everything users delete, with restore.
// Feature module contract: see docs/PLUGINS.md. Owner guide: docs/features/trash.md.
import { check } from "../domain.mjs";
import { Webhooks } from "../platform-webhooks.mjs";
import { KEEP_DAYS, TRASH_MIGRATION, attachTrash, track } from "../trash.mjs";

const isOwner = (r) => !r.session.role || r.session.role === "owner";
const actor = (r) => "owner:" + r.session.email;
// The owner sees and restores everything; others only what they deleted themselves.
const mine = (r, e) => isOwner(r) || e.actor === actor(r);

export default {
  name: "trash",
  // Staff may restore what they deleted; removing a copy for good stays with the owner.
  access: {
    staff: [
      ["GET", /^\/api\/trash$/],
      ["POST", /^\/api\/trash\/[\w-]+\/restore$/],
    ],
  },
  migrations: [{ name: "trash-001-bin", sql: TRASH_MIGRATION }],
  attach(Store) {
    attachTrash(Store);
    // Webhook endpoints live outside the Store; their delete keeps a copy too.
    if (!Webhooks.prototype.remove.tracked) {
      const original = Webhooks.prototype.remove;
      Webhooks.prototype.remove = function (id) {
        return track(this.store, "removeWebhook", id, () => original.call(this, id));
      };
      Webhooks.prototype.remove.tracked = true;
    }
  },
  routes: {
    async owner(r) {
      const store = r.ctx.store;
      if (r.path === "/api/trash" && r.method === "GET")
        return r.send(200, { days: KEEP_DAYS, items: store.trashList(isOwner(r) ? null : actor(r)) }), true;
      const m = r.path.match(/^\/api\/trash\/([\w-]+)(\/restore)?$/);
      if (!m) return false;
      if (m[2] && r.method === "POST") {
        const e = store.trashList().find((x) => x.id === m[1]);
        check(e, "This item is no longer in Recently deleted.", 404);
        check(mine(r, e), "Only the workspace owner can restore what someone else deleted.", 403);
        return r.send(200, store.trashRestore(m[1])), true;
      }
      if (!m[2] && r.method === "DELETE") {
        check(isOwner(r), "Only the workspace owner can delete items for good.", 403);
        store.trashPurge(m[1]);
        return r.send(200, { ok: true }), true;
      }
      return false;
    },
  },
  jobs: [
    {
      name: "expire",
      every: 3600000,
      delay: 60000,
      run(ctx) {
        return { removed: ctx.store.trashExpire() };
      },
    },
  ],
  workspace(r) {
    if (r.session.role === "accountant") return { days: KEEP_DAYS, items: [], purge: false };
    return {
      days: KEEP_DAYS,
      purge: isOwner(r),
      items: r.ctx.store.trashList(isOwner(r) ? null : actor(r)),
    };
  },
};
