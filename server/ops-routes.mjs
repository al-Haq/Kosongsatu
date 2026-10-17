// Owner and guest HTTP routes for the operations module (see server/ext/ops.mjs).
import { check, AppError } from "./domain.mjs";
import { requestContext } from "./context.mjs";
import { MAX_FILE_BYTES } from "./files.mjs";
const ID = "[\\w-]{1,80}";
const route = (pattern) => new RegExp("^/api/ops/" + pattern.replaceAll(":id", `(${ID})`) + "$");
const ROUTES = {
  time: route("time"),
  timeOne: route("time/:id"),
  timeInvoice: route("time/invoice"),
  timer: route("timer/(start|stop|discard)"),
  unlink: route("invoices/:id/unlink"),
  projects: route("projects"),
  project: route("projects/:id"),
  milestones: route("projects/:id/milestones"),
  milestone: route("milestones/:id"),
  milestoneAction: route("milestones/:id/(ready|pending|invoice)"),
  inventory: route("inventory"),
  stock: route("stock"),
  stockOne: route("stock/:id"),
  stockMove: route("stock/:id/movements"),
  po: route("pos/:id"),
  poAction: route("pos/:id/(amend|cancel)"),
  poFiles: route("pos/:id/files"),
  work: route("documents/:id/work"),
  photos: route("documents/:id/photos"),
  photo: route("photos/:id"),
  logs: route("documents/:id/logs"),
  log: route("logs/:id"),
  report: route("documents/:id/report"),
};
export async function ownerRoutes(r) {
  const { path, method, url } = r,
    store = r.ctx.store;
  if (!path.startsWith("/api/ops/")) return false;
  const q = (k) => url.searchParams.get(k);
  let m;
  const done = (status, data) => (r.send(status, data), true);
  // Time entries and timer
  if (path === "/api/ops/time" && method === "GET")
    return done(
      200,
      store.timeEntries({
        from: q("from") || undefined,
        to: q("to") || undefined,
        client_id: q("client_id") || undefined,
        project_id: q("project_id") || undefined,
        unbilled: q("unbilled") === "1",
      }),
    );
  if (path === "/api/ops/time" && method === "POST") {
    const b = await r.body();
    return done(201, r.write("ops.time.create", b, () => store.saveTime(b)));
  }
  if (ROUTES.timeInvoice.test(path) && method === "POST") {
    const b = await r.body();
    return done(201, r.write("ops.time.invoice", b, () => store.invoiceTime(b)));
  }
  if ((m = path.match(ROUTES.timeOne))) {
    if (method === "PUT") return done(200, store.saveTime(await r.body(), m[1]));
    if (method === "DELETE") return store.deleteTime(m[1]), done(200, { ok: true });
  }
  if ((m = path.match(ROUTES.timer)) && method === "POST") {
    const b = await r.body();
    if (m[1] === "start") return done(201, store.startTimer(b));
    if (m[1] === "stop") return done(201, store.stopTimer(b));
    return store.discardTimer(), done(200, { ok: true });
  }
  if ((m = path.match(ROUTES.unlink)) && method === "POST") return done(200, store.unlinkBilling(m[1]));
  // Projects and milestones
  if (path === "/api/ops/projects" && method === "POST") {
    const b = await r.body();
    return done(201, r.write("ops.project.create", b, () => store.saveProject(b)));
  }
  if ((m = path.match(ROUTES.milestones)) && method === "POST") {
    const b = await r.body();
    return done(201, r.write("ops.milestone.create:" + m[1], b, () => store.saveMilestone(m[1], b)));
  }
  if ((m = path.match(ROUTES.project))) {
    if (method === "GET") return done(200, store.projectDetail(m[1]));
    if (method === "PUT") return done(200, store.saveProject(await r.body(), m[1]));
    if (method === "DELETE") return store.deleteProject(m[1]), done(200, { ok: true });
  }
  if ((m = path.match(ROUTES.milestoneAction)) && method === "POST") {
    if (m[2] === "invoice") {
      const b = await r.body();
      return done(201, r.write("ops.milestone.invoice:" + m[1], b, () => store.invoiceMilestone(m[1], b)));
    }
    return done(200, store.setMilestoneReady(m[1], m[2] === "ready"));
  }
  if ((m = path.match(ROUTES.milestone))) {
    if (method === "PUT") return done(200, store.saveMilestone(null, await r.body(), m[1]));
    if (method === "DELETE") return store.deleteMilestone(m[1]), done(200, { ok: true });
  }
  // Inventory
  if (path === "/api/ops/inventory" && method === "GET")
    return done(200, { ...store.inventorySettings(), items: store.stockItems() });
  if (path === "/api/ops/inventory" && method === "PUT") return done(200, store.saveInventorySettings(await r.body()));
  if (path === "/api/ops/stock" && method === "POST") {
    const b = await r.body();
    return done(201, r.write("ops.stock.track", b, () => store.trackStock(b)));
  }
  if ((m = path.match(ROUTES.stockMove)) && method === "POST") {
    const b = await r.body();
    return done(201, r.write("ops.stock.move:" + m[1], b, () => store.moveStock(m[1], b)));
  }
  if ((m = path.match(ROUTES.stockOne))) {
    if (method === "GET") return done(200, store.stockDetail(m[1]));
    if (method === "PUT") return done(200, store.updateStock(m[1], await r.body()));
  }
  // Customer POs: details, amendments, cancellation and files
  if ((m = path.match(ROUTES.poAction)) && method === "POST") {
    const b = await r.body();
    if (m[2] === "amend") return done(200, r.write("ops.po.amend:" + m[1], b, () => store.amendPO(m[1], b)));
    return done(200, r.write("ops.po.cancel:" + m[1], b, () => store.cancelPO(m[1], b)));
  }
  if ((m = path.match(ROUTES.poFiles)) && method === "POST") {
    r.allow("upload:" + r.session.owner_id, 60, 600000);
    const data = await r.rawBody(MAX_FILE_BYTES);
    return done(201, store.savePOFile(m[1], { name: q("name") || "customer-po", data }));
  }
  if ((m = path.match(ROUTES.po)) && method === "GET") return done(200, store.poDetail(m[1]));
  // Proof of work
  if ((m = path.match(ROUTES.work)) && method === "GET") return done(200, store.proofOfWork(m[1]));
  if ((m = path.match(ROUTES.photos)) && method === "POST") {
    r.allow("upload:" + r.session.owner_id, 60, 600000);
    const data = await r.rawBody(MAX_FILE_BYTES);
    return done(
      201,
      store.addWorkPhoto(m[1], {
        kind: q("kind"),
        name: q("name") || "",
        visible: q("visible") === "1",
        data,
      }),
    );
  }
  if ((m = path.match(ROUTES.photo))) {
    if (method === "PUT") return done(200, store.setWorkPhotoVisibility(m[1], (await r.body()).visible === true));
    if (method === "DELETE") return store.deleteWorkPhoto(m[1]), done(200, { ok: true });
  }
  if ((m = path.match(ROUTES.logs)) && method === "POST") return done(201, store.saveWorkLog(m[1], await r.body()));
  if ((m = path.match(ROUTES.log))) {
    if (method === "PUT") return done(200, store.saveWorkLog(null, await r.body(), m[1]));
    if (method === "DELETE") return store.deleteWorkLog(m[1]), done(200, { ok: true });
  }
  if ((m = path.match(ROUTES.report)) && method === "PUT") return done(200, store.saveWorkReport(m[1], await r.body()));
  throw new AppError("Not found.", 404);
}
// Client-visible work photos for a client document link.
export async function guestRoutes(r) {
  const m = r.path.match(/^\/api\/guest\/ops\/work\/([\w-]{43})\/([\w-]{36})$/);
  if (!m) return false;
  check(r.method === "GET", "Not found.", 404);
  requestContext.getStore().actor = "client-link";
  r.allow("ops-work:" + r.ip, 120, 60000);
  const store = r.ctx.store;
  const d = store.publicDocument(m[1]);
  r.sendFile(store.publicWorkPhoto(d.id, m[2]), r.url);
  return true;
}
