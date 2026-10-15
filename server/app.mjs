import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.mjs";
import { check, AppError, hash, text } from "./domain.mjs";
import {
  sessionFrom,
  createSession,
  verifyPassword,
  cookie,
  passwordHash,
} from "./auth.mjs";
import { renderPdf } from "./pdf.mjs";
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
};
function safeDoc(d) {
  return {
    id: d.id,
    kind: d.kind,
    number: d.number,
    state: d.state,
    status: d.status,
    issue_date: d.issue_date,
    due_date: d.due_date,
    items: d.items,
    subtotal: d.subtotal,
    discount: d.discount,
    total: d.total,
    paid: d.paid,
    balance: d.balance,
    notes: d.notes,
    terms: d.terms,
    client: {
      name: d.client.name,
      address: d.client.address,
      contact: d.client.contact,
    },
    business: d.business,
    accepted_name: d.accepted_name,
    proofs: d.proofs.map((p) => ({
      reference: p.reference,
      status: p.status,
      created: p.created,
    })),
  };
}
const csvCell = (v) => {
  let s = String(v ?? "");
  if (/^[\s]*[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
};
export function createApp({
  store,
  appUrl = "http://localhost:3000",
  secure = false,
} = {}) {
  check(store, "Store required.");
  const allowedOrigin = new URL(appUrl).origin;
  const limits = new Map();
  const allow = (key, max, ms) => {
    const t = Date.now();
    if (limits.size > 5000) {
      for (const [k, v] of limits) if (v.until < t) limits.delete(k);
      if (limits.size > 5000)
        throw new AppError("Server busy. Try again shortly.", 429);
    }
    let e = limits.get(key);
    if (!e || e.until < t) e = { count: 0, until: t + ms };
    e.count++;
    limits.set(key, e);
    check(e.count <= max, "Too many attempts. Try again later.", 429);
  };
  const server = http.createServer(async (req, res) => {
    const headers = {
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
      "Cache-Control": "no-store",
    };
    if (secure) headers["Strict-Transport-Security"] = "max-age=31536000";
    res.setTimeout(20000);
    const send = (status, data, extra = {}) => {
      res.writeHead(status, {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
        ...extra,
      });
      res.end(
        Buffer.isBuffer(data) || typeof data === "string"
          ? data
          : JSON.stringify(data),
      );
    };
    try {
      check(
        ["GET", "POST", "PUT", "PATCH"].includes(req.method),
        "Method not allowed.",
        405,
      );
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      const method = req.method;
      if (method !== "GET")
        check(
          req.headers.origin === allowedOrigin,
          "Request origin is not allowed.",
          403,
        );
      const body = async () => {
        check(
          (req.headers["content-type"] || "").startsWith("application/json"),
          "JSON request required.",
          415,
        );
        let data = "";
        for await (const chunk of req) {
          data += chunk.toString();
          check(Buffer.byteLength(data) <= 128000, "Request too large.", 413);
        }
        try {
          const value = JSON.parse(data);
          check(
            value && typeof value === "object" && !Array.isArray(value),
            "JSON object required.",
          );
          return value;
        } catch (e) {
          if (e instanceof AppError) throw e;
          throw new AppError("Invalid JSON body.");
        }
      };
      if (path === "/api/health" && method === "GET")
        return send(200, { ok: true });
      if (path === "/api/login" && method === "POST") {
        allow("login:" + req.socket.remoteAddress, 10, 15 * 60000);
        const b = await body();
        const email = text(b.email || "", 160).toLowerCase();
        const owner = store.db
          .prepare("SELECT * FROM owners WHERE email=?")
          .get(email);
        // Perform a real KDF even for unknown users to avoid a cheap account timing oracle.
        const fallback = "00000000000000000000000000000000:" + "0".repeat(128);
        const valid = await verifyPassword(
          b.password,
          owner?.password || fallback,
        );
        check(owner && valid, "Email or password is incorrect.", 401);
        const s = createSession(store, owner.id);
        return send(
          200,
          { email: owner.email, csrf: s.csrf },
          { "Set-Cookie": cookie(s.token, secure) },
        );
      }
      if (path.startsWith("/api/public/")) {
        const match = path.match(
          /^\/api\/public\/([\w-]+)(?:\/(pdf|accept|payment-reference))?$/,
        );
        check(match, "Not found.", 404);
        const [, token, action] = match;
        allow("public:" + req.socket.remoteAddress, 120, 60000);
        if (method === "GET" && !action)
          return send(200, safeDoc(store.publicDocument(token, true)));
        if (method === "GET" && action === "pdf") {
          const d = store.publicDocument(token);
          return send(200, await renderPdf(d), {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${d.number}.pdf"`,
          });
        }
        if (method === "POST" && action === "accept") {
          allow("submit:" + req.socket.remoteAddress, 12, 60000);
          const b = await body();
          return send(200, safeDoc(store.accept(token, b.name)));
        }
        if (method === "POST" && action === "payment-reference") {
          allow("submit:" + req.socket.remoteAddress, 12, 60000);
          return send(201, store.proof(token, await body()));
        }
        throw new AppError("Not found.", 404);
      }
      if (path.startsWith("/api/")) {
        const session = sessionFrom(req, store);
        check(session, "Please sign in.", 401);
        if (method !== "GET")
          check(
            req.headers["x-csrf-token"] === session.csrf,
            "Session verification failed. Refresh and try again.",
            403,
          );
        if (path === "/api/session" && method === "GET")
          return send(200, { email: session.email, csrf: session.csrf });
        if (path === "/api/logout" && method === "POST") {
          store.db
            .prepare("DELETE FROM sessions WHERE hash=?")
            .run(session.hash);
          return send(
            200,
            { ok: true },
            { "Set-Cookie": cookie("", secure, true) },
          );
        }
        if (path === "/api/password" && method === "POST") {
          const b = await body();
          const owner = store.db
            .prepare("SELECT * FROM owners WHERE id=?")
            .get(session.owner_id);
          check(
            await verifyPassword(b.current, owner.password),
            "Current password is incorrect.",
            403,
          );
          const password = await passwordHash(b.password);
          store.tx(() => {
            store.db
              .prepare("UPDATE owners SET password=? WHERE id=?")
              .run(password, owner.id);
            store.db
              .prepare("DELETE FROM sessions WHERE owner_id=?")
              .run(owner.id);
            store.audit("password.changed", null);
          });
          return send(
            200,
            { ok: true },
            { "Set-Cookie": cookie("", secure, true) },
          );
        }
        if (path === "/api/workspace" && method === "GET")
          return send(200, store.workspace());
        if (path === "/api/settings" && method === "PUT")
          return send(200, store.saveSettings(await body()));
        if (path === "/api/backup" && method === "GET")
          return send(
            200,
            {
              schemaVersion: 1,
              exported: new Date().toISOString(),
              ...store.workspace(),
            },
            {
              "Content-Disposition":
                'attachment; filename="nawlogic-business-export.json"',
            },
          );
        if (path === "/api/invoices.csv" && method === "GET") {
          const lines = [
            [
              "Number",
              "Client",
              "Issue date",
              "Due date",
              "Total MYR",
              "Paid MYR",
              "Balance MYR",
              "Status",
            ],
            ...store
              .documents()
              .filter((d) => d.kind === "invoice")
              .map((d) => [
                d.number || "DRAFT",
                d.client.name,
                d.issue_date,
                d.due_date,
                (d.total / 100).toFixed(2),
                (d.paid / 100).toFixed(2),
                (d.balance / 100).toFixed(2),
                d.status,
              ]),
          ];
          return send(
            200,
            "\uFEFF" + lines.map((r) => r.map(csvCell).join(",")).join("\r\n"),
            {
              "Content-Type": "text/csv; charset=utf-8",
              "Content-Disposition":
                'attachment; filename="nawlogic-invoices.csv"',
            },
          );
        }
        const simple = path.match(/^\/api\/(clients|services)(?:\/([\w-]+))?$/);
        if (simple && ["POST", "PUT"].includes(method)) {
          const [, kind, idv] = simple;
          if (idv)
            check(
              store.db.prepare(`SELECT id FROM ${kind} WHERE id=?`).get(idv),
              "Record not found.",
              404,
            );
          const b = await body();
          return send(
            idv ? 200 : 201,
            kind === "clients"
              ? store.saveClient(b, idv)
              : store.saveService(b, idv),
          );
        }
        if (path === "/api/documents" && method === "POST")
          return send(201, store.saveDocument(await body()));
        const doc = path.match(
          /^\/api\/documents\/([\w-]+)(?:\/(issue|share|revoke|void|convert|payments|pdf))?$/,
        );
        if (doc) {
          const [, idv, action] = doc;
          if (method === "GET" && !action)
            return send(200, store.document(idv));
          if (method === "PUT" && !action)
            return send(200, store.saveDocument(await body(), idv));
          if (method === "GET" && action === "pdf") {
            const d = store.document(idv);
            return send(200, await renderPdf(d), {
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename="${d.number || "DRAFT"}.pdf"`,
            });
          }
          if (method === "POST" && action === "issue")
            return send(200, store.issue(idv));
          if (method === "POST" && action === "share") {
            const result = store.share(idv);
            return send(200, {
              url: `${allowedOrigin}/client/${result.token}`,
              expires: result.expires,
            });
          }
          if (method === "POST" && action === "revoke") {
            store.revoke(idv);
            return send(200, { ok: true });
          }
          if (method === "POST" && action === "void")
            return send(200, store.void(idv, (await body()).reason));
          if (method === "POST" && action === "convert")
            return send(200, store.convert(idv));
          if (method === "POST" && action === "payments")
            return send(201, store.recordPayment(idv, await body()));
        }
        const payment = path.match(
          /^\/api\/payments\/([\w-]+)\/(reverse|receipt)$/,
        );
        if (payment) {
          const [, pid, action] = payment;
          if (action === "reverse" && method === "POST") {
            store.reverse(pid, (await body()).reason);
            return send(200, { ok: true });
          }
          if (action === "receipt" && method === "GET") {
            const p = store.db
              .prepare("SELECT * FROM payments WHERE id=? AND reversed=0")
              .get(pid);
            check(p, "Active payment not found.", 404);
            const d = store.document(p.invoice_id);
            return send(200, await renderPdf(d, p), {
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename="receipt-${p.id.slice(0, 8)}.pdf"`,
            });
          }
        }
        if (path === "/api/schedules" && method === "POST")
          return send(201, store.saveSchedule(await body()));
        const sch = path.match(
          /^\/api\/schedules\/([\w-]+)\/(run|pause|resume)$/,
        );
        if (sch && method === "POST") {
          const [, sid, action] = sch;
          if (action === "run") return send(201, store.runSchedule(sid));
          check(
            store.db.prepare("SELECT id FROM schedules WHERE id=?").get(sid),
            "Schedule not found.",
            404,
          );
          store.db
            .prepare("UPDATE schedules SET active=? WHERE id=?")
            .run(action === "resume" ? 1 : 0, sid);
          store.audit("schedule." + action, sid);
          return send(200, { ok: true });
        }
        throw new AppError("Not found.", 404);
      }
      check(method === "GET", "Not found.", 404);
      const staticPath =
        path === "/" || /^\/client\/[\w-]+$/.test(path) ? "/index.html" : path;
      const file = resolve(publicDir, "." + decodeURIComponent(staticPath));
      check(
        file.startsWith(publicDir + sep) ||
          (file.startsWith(publicDir) && publicDir.endsWith(sep)),
        "Not found.",
        404,
      );
      const contentType = mime[extname(file)];
      check(contentType, "Not found.", 404);
      let bytes;
      try {
        bytes = await readFile(file);
      } catch {
        throw new AppError("Not found.", 404);
      }
      return send(200, bytes, { "Content-Type": contentType });
    } catch (e) {
      const status = e instanceof AppError ? e.status : 500;
      if (status === 500) console.error("Request failed:", e.message);
      if (!res.headersSent)
        send(status, {
          error:
            status === 500
              ? "Unexpected server error. Please try again."
              : e.message,
        });
      else res.end();
    }
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 15000;
  server.maxHeadersCount = 60;
  return server;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const store = openDatabase(
    process.env.DATABASE_PATH || "./data/nawlogic.sqlite",
  );
  const production = process.env.NODE_ENV === "production";
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 3000);
  const appUrl = process.env.APP_URL || `http://localhost:${port}`;
  if (production && (!process.env.APP_URL || !appUrl.startsWith("https://")))
    throw new Error("Production requires an explicit HTTPS APP_URL.");
  if (!store.db.prepare("SELECT id FROM owners LIMIT 1").get())
    throw new Error("No owner configured. Run npm run setup first.");
  const server = createApp({ store, appUrl, secure: production });
  server.listen(port, host, () => console.log(`Nawlogic Invoice: ${appUrl}`));
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () =>
      server.close(() => {
        store.db.close();
        process.exit(0);
      }),
    );
}
