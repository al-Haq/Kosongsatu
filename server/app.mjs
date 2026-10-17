import { Assistant } from "./assistant.mjs";
import { Mailer } from "./mailer.mjs";
import { Gateway } from "./gateway.mjs";
import { renderStatementPdf } from "./statement.mjs";
import { TOOL_DEFINITIONS } from "./automation.mjs";
import { z } from "zod";
import http from "node:http";
import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./db.mjs";
import { PLUGINS, SECRETS, JOBS } from "./plugins.mjs";
import { MAX_FILE_BYTES } from "./files.mjs";
import { check, AppError, hash, text } from "./domain.mjs";
import {
  sessionFrom,
  createSession,
  verifyPassword,
  cookie,
  passwordHash,
} from "./auth.mjs";
import { renderPdf, renderReceiptPdf, renderAdjustmentPdf } from "./pdf.mjs";
import { requestContext } from "./context.mjs";
import { BackupManager } from "./recovery.mjs";
import {
  mfaStatus,
  beginMfa,
  enableMfa,
  disableMfa,
  verifySecondFactor,
} from "./mfa.mjs";
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
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
    adjusted_total: d.adjusted_total,
    credit: d.credit,
    debit: d.debit,
    adjustments: d.adjustments,
    collection_status: d.collection_status,
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
// TRUST_PROXY is the number of reverse proxies in front of the app that append
// to X-Forwarded-For. Leave it unset when Node is reachable directly.
export function proxyHops(value) {
  if (value === undefined || value === "" || value === "false") return 0;
  if (value === "true") return 1;
  const n = Number(value);
  check(Number.isInteger(n) && n >= 0 && n <= 5, "TRUST_PROXY must be true, false or 0-5.");
  return n;
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
  assistantConfig,
  aiFetch,
  mailConfig,
  mailTransport,
  gatewayConfig,
  gatewayFetch,
  trustProxy = 0,
  backupConfig = {
    directory: process.env.BACKUP_DIRECTORY,
    key: process.env.BACKUP_KEY,
  },
} = {}) {
  check(store, "Store required.");
  const allowedOrigin = new URL(appUrl).origin;
  const limits = new Map();
  const ipOf = (req) => {
    const peer = req.socket.remoteAddress;
    if (!trustProxy) return peer;
    // Only the last trustProxy entries were written by our own proxies; anything
    // further left is client-supplied and must not be used.
    const list = String(req.headers["x-forwarded-for"] || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    const ip = list[list.length - trustProxy];
    return ip && isIP(ip) ? ip : peer;
  };
  const backups = new BackupManager(store, backupConfig);
  const mailer = new Mailer(store, {
    ...(mailConfig !== undefined ? { config: mailConfig } : {}),
    ...(mailTransport ? { transport: mailTransport } : {}),
  });
  const gateway = new Gateway(store, {
    ...(gatewayConfig !== undefined ? { config: gatewayConfig } : {}),
    ...(gatewayFetch ? { fetcher: gatewayFetch } : {}),
  });
  const assistant = new Assistant(store, {
    ...(assistantConfig !== undefined ? { config: assistantConfig } : {}),
    ...(aiFetch ? { fetcher: aiFetch } : {}),
  });
  // Shared services for feature modules (see docs/PLUGINS.md).
  const ctx = {
    store,
    appUrl: allowedOrigin,
    secure,
    mailer,
    gateway,
    assistant,
    backups,
    services: {},
  };
  for (const p of PLUGINS) p.init?.(ctx);
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
  const server = http.createServer((req, res) =>
    requestContext.run({ actor: "anonymous" }, async () => {
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
      // Stored files are served with a locked-down policy; only images and
      // PDFs exist, and PDFs download unless ?inline=1 is asked for.
      const sendFile = (f, url) => {
        const inline = f.mime.startsWith("image/") || url?.searchParams.get("inline") === "1";
        res.writeHead(200, {
          ...headers,
          "Content-Type": f.mime,
          "Content-Length": f.data.length,
          "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${f.name.replace(/[^\w.-]/g, "_")}"`,
        });
        res.end(f.data);
      };
      try {
        check(
          ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(req.method),
          "Method not allowed.",
          405,
        );
        const url = new URL(req.url, "http://localhost");
        const path = url.pathname;
        const method = req.method;
        // Webhooks under /api/hooks/ come from other servers and must authenticate
        // themselves (signatures or secret tokens); browsers never call them.
        if (
          method !== "GET" &&
          !path.startsWith("/api/integrations/") &&
          !path.startsWith("/api/hooks/") &&
          path !== "/api/payments/billplz/callback"
        )
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
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            check(size <= 128000, "Request too large.", 413);
            chunks.push(chunk);
          }
          const data = Buffer.concat(chunks).toString("utf8");
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
        // Raw request bodies, e.g. file uploads. The caller decides the allowed types.
        const rawBody = async (limit = MAX_FILE_BYTES) => {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            check(size <= limit, "Upload is too large.", 413);
            chunks.push(chunk);
          }
          return Buffer.concat(chunks);
        };
        // The request as feature modules see it.
        const r = {
          req,
          res,
          url,
          path,
          method,
          ip: ipOf(req),
          body,
          rawBody,
          send,
          allow,
          ctx,
          sendFile,
          session: null,
          write: null,
        };
        if (path.startsWith("/api/hooks/") || path.startsWith("/api/public/") || path.startsWith("/api/guest/"))
          for (const p of PLUGINS)
            if (await p.routes?.guest?.(r)) return;
        if (path.startsWith("/api/integrations/")) {
          allow("connector-ip:" + ipOf(req), 120, 60000);
          const raw = req.headers.authorization || "";
          check(
            raw.startsWith("Bearer "),
            "Connector bearer token required.",
            401,
          );
          const token = store.connector(raw.slice(7));
          allow("connector:" + token.id, 60, 60000);
          requestContext.getStore().actor =
            "connector:" + token.label + ":" + token.id;
          store.db
            .prepare("UPDATE integration_tokens SET last_used=? WHERE id=?")
            .run(new Date().toISOString(), token.id);
          if (path === "/api/integrations/tools" && method === "GET")
            return send(200, {
              tools: TOOL_DEFINITIONS.filter((t) =>
                token.scopes.includes(t.scope),
              ).map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: z.toJSONSchema(t.schema),
              })),
            });
          const match = path.match(/^\/api\/integrations\/tools\/([a-z_]+)$/);
          if (match && method === "POST")
            return send(
              200,
              store.toolCall(match[1], await body(), {
                scopes: token.scopes,
                source: "connector:" + token.id,
              }),
            );
          throw new AppError("Integration endpoint not found.", 404);
        }
        if (path === "/api/payments/billplz/callback" && method === "POST") {
          // Server-to-server notification from Billplz, authenticated by its X Signature.
          allow("gateway:" + ipOf(req), 120, 60000);
          requestContext.getStore().actor = "gateway:billplz";
          check(
            (req.headers["content-type"] || "").startsWith(
              "application/x-www-form-urlencoded",
            ),
            "Form request required.",
            415,
          );
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            check(size <= 16000, "Request too large.", 413);
            chunks.push(chunk);
          }
          const params = Object.fromEntries(
            new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
          );
          const notice = gateway.verify(params);
          try {
            await gateway.settle(notice.id, notice.paidAt);
          } catch (e) {
            // A validly signed notice for a bill this app did not create needs no retries.
            if (e.status !== 404) throw e;
          }
          return send(200, "OK", { "Content-Type": "text/plain; charset=utf-8" });
        }
        if (path === "/api/health" && method === "GET")
          return send(200, { ok: true });
        if (path === "/api/login" && method === "POST") {
          allow("login:" + ipOf(req), 10, 15 * 60000);
          const b = await body();
          const email = text(b.email || "", 160).toLowerCase();
          const owner = store.db
            .prepare("SELECT * FROM owners WHERE email=?")
            .get(email);
          // Perform a real KDF even for unknown users to avoid a cheap account timing oracle.
          const fallback =
            "00000000000000000000000000000000:" + "0".repeat(128);
          const valid = await verifyPassword(
            b.password,
            owner?.password || fallback,
          );
          check(owner && valid, "Email or password is incorrect.", 401);
          // Team members can be disabled by the owner (see server/ext/team.mjs).
          check(!owner.disabled, "This account is disabled. Ask the workspace owner.", 403);
          check(
            verifySecondFactor(store, owner.id, b.code),
            "Authenticator or recovery code is required/invalid.",
            401,
          );
          requestContext.getStore().actor = "owner:" + owner.email;
          store.audit("owner.signed_in", String(owner.id));
          const s = createSession(store, owner.id);
          return send(
            200,
            { email: owner.email, csrf: s.csrf },
            { "Set-Cookie": cookie(s.token, secure) },
          );
        }
        if (path.startsWith("/api/public/")) {
          const match = path.match(
            /^\/api\/public\/([\w-]+)(?:\/(pdf|accept|payment-reference|checkout|payment-return))?$/,
          );
          check(match, "Not found.", 404);
          const [, token, action] = match;
          requestContext.getStore().actor = "client-link";
          allow("public:" + ipOf(req), 120, 60000);
          if (method === "GET" && !action) {
            const d = store.publicDocument(token, true);
            return send(200, {
              ...safeDoc(d),
              online_payment:
                gateway.status().configured &&
                !!(d.client.email || d.client.phone || store.settings().email),
              // Client-safe extras from feature modules (never owner-only data).
              ext: Object.fromEntries(
                await Promise.all(
                  PLUGINS.filter((p) => p.publicDocument).map(async (p) => [
                    p.name,
                    await p.publicDocument(d, r),
                  ]),
                ),
              ),
            });
          }
          if (method === "POST" && action === "checkout") {
            allow("checkout:" + ipOf(req), 10, 60000);
            return send(200, await gateway.checkout(token, allowedOrigin));
          }
          if (method === "POST" && action === "payment-return") {
            // The browser comes back with signed billplz[...] query values; the
            // payment is confirmed with the provider before anything is recorded.
            allow("submit:" + ipOf(req), 12, 60000);
            const d = store.publicDocument(token);
            const b = await body();
            const params = Object.fromEntries(
              Object.entries(b.params || {})
                .filter(([k, v]) => /^billplz\[[a-z_]+\]$/.test(k) && typeof v === "string")
                .slice(0, 10),
            );
            const { id: billId, paidAt } = gateway.verify(params);
            check(
              store.db
                .prepare("SELECT 1 FROM online_payments WHERE bill_id=? AND invoice_id=?")
                .get(billId, d.id),
              "Payment not found.",
              404,
            );
            const r = await gateway.settle(billId, paidAt);
            return send(200, { state: r.state });
          }
          if (method === "GET" && action === "pdf") {
            const d = store.publicDocument(token);
            return send(200, await renderPdf(d, null, await store.pdfBlocks(d)), {
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename="${d.number}.pdf"`,
            });
          }
          if (method === "POST" && action === "accept") {
            allow("submit:" + ipOf(req), 12, 60000);
            const b = await body();
            return send(200, safeDoc(store.accept(token, b.name)));
          }
          if (method === "POST" && action === "payment-reference") {
            allow("submit:" + ipOf(req), 12, 60000);
            return send(201, store.proof(token, await body()));
          }
          throw new AppError("Not found.", 404);
        }
        if (path.startsWith("/api/")) {
          const session = sessionFrom(req, store);
          check(session, "Please sign in.", 401);
          requestContext.getStore().actor = "owner:" + session.email;
          const write = (scope, payload, fn) =>
            store.idempotent(
              scope,
              req.headers["idempotency-key"],
              payload,
              fn,
            );
          if (method !== "GET")
            check(
              req.headers["x-csrf-token"] === session.csrf,
              "Session verification failed. Refresh and try again.",
              403,
            );
          r.session = session;
          r.write = write;
          // Modules may restrict owner routes (e.g. read-only roles).
          for (const p of PLUGINS) await p.routes?.authorize?.(r);
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
            check(
              verifySecondFactor(store, session.owner_id, b.code),
              "Authenticator or recovery code is required/invalid.",
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
              store.db.prepare("UPDATE integration_tokens SET revoked=1").run();
              store.audit("password.changed", null);
            });
            return send(
              200,
              { ok: true },
              { "Set-Cookie": cookie("", secure, true) },
            );
          }
          if (path === "/api/sales/opportunities" && method === "POST") {
            const b = await body();
            return send(
              201,
              write("sales.create", b, () => store.saveOpportunity(b)),
            );
          }
          const sale = path.match(/^\/api\/sales\/opportunities\/([\w-]+)$/);
          if (sale && method === "PUT")
            return send(200, store.saveOpportunity(await body(), sale[1]));
          const acceptance = path.match(
            /^\/api\/sales\/quotes\/([\w-]+)\/accept$/,
          );
          if (acceptance && method === "POST")
            return send(200, store.acceptOffline(acceptance[1], await body()));
          if (path === "/api/sales/customer-pos" && method === "POST") {
            const b = await body();
            return send(
              201,
              write("po.create", b, () => store.registerPO(b)),
            );
          }
          const poInvoice = path.match(
            /^\/api\/sales\/customer-pos\/([\w-]+)\/invoice$/,
          );
          if (poInvoice && method === "POST") {
            const po = store.db
              .prepare("SELECT * FROM customer_pos WHERE id=?")
              .get(poInvoice[1]);
            check(po, "Customer PO not found.", 404);
            return send(200, store.invoiceFromQuote(po.quote_id, po.id));
          }
          if (path === "/api/automation/proposals" && method === "POST") {
            const b = await body();
            return send(
              201,
              store.propose(
                b.kind,
                b.data,
                "owner:" + session.email,
                b.request_key,
              ),
            );
          }
          const review = path.match(
            /^\/api\/automation\/proposals\/([\w-]+)\/(approve|reject)$/,
          );
          if (review && method === "POST") {
            const b = await body();
            return send(
              200,
              store.reviewProposal(
                review[1],
                review[2] === "approve",
                b.reason,
              ),
            );
          }
          const rule = path.match(/^\/api\/automation\/rules\/([\w-]+)$/);
          if (rule && method === "PUT") {
            store.setRule(rule[1], (await body()).enabled);
            return send(200, { ok: true });
          }
          if (path === "/api/automation/run" && method === "POST")
            return send(
              200,
              requestContext.run({ actor: "automation:owner-triggered" }, () =>
                store.runAutomations(),
              ),
            );
          const retry = path.match(
            /^\/api\/automation\/runs\/([\w-]+)\/retry$/,
          );
          if (retry && method === "POST")
            return send(200, store.retryAutomation(retry[1]));
          if (path === "/api/automation/connectors" && method === "POST") {
            allow("connector-create:" + session.owner_id, 8, 300000);
            const b = await body();
            const owner = store.db
              .prepare("SELECT password FROM owners WHERE id=?")
              .get(session.owner_id);
            check(
              await verifyPassword(b.password, owner.password),
              "Current password is incorrect.",
              403,
            );
            check(
              verifySecondFactor(store, session.owner_id, b.code),
              "Authenticator or recovery code required/invalid.",
              403,
            );
            return send(201, store.createConnector(b));
          }
          const connector = path.match(
            /^\/api\/automation\/connectors\/([\w-]+)\/revoke$/,
          );
          if (connector && method === "POST") {
            store.revokeConnector(connector[1]);
            return send(200, { ok: true });
          }
          if (path === "/api/assistant/chat" && method === "POST") {
            allow("assistant:" + session.owner_id, 10, 600000);
            res.setTimeout(120000);
            return send(
              200,
              await assistant.run(session.owner_id, await body()),
            );
          }
          if (path === "/api/workspace" && method === "GET")
            return send(200, {
              ...store.workspace(),
              finance: store.finance(),
              security: mfaStatus(store, session.owner_id),
              backupStatus: backups.status(),
              sales: store.sales(),
              automation: store.automationState(),
              connectors: store.connectorTokens(),
              assistant: assistant.status(),
              mail: mailer.status(),
              gateway: gateway.status(),
              onlinePayments: gateway.list(),
              emailLog: store.emailLog(),
              assistantRuns: store.db
                .prepare(
                  "SELECT id,prompt,response,state,tool_log,created FROM assistant_runs WHERE owner_id=? ORDER BY created DESC LIMIT 20",
                )
                .all(session.owner_id),
              secrets: store.secretStatus(SECRETS.map((x) => x.name)).map((x, i) => ({
                ...x,
                label: SECRETS[i].label,
                help: SECRETS[i].help || "",
                plugin: SECRETS[i].plugin,
                secret: SECRETS[i].secret !== false,
              })),
              ext: Object.fromEntries(
                await Promise.all(
                  PLUGINS.filter((p) => p.workspace).map(async (p) => [p.name, await p.workspace(r)]),
                ),
              ),
            });
          if (path === "/api/settings" && method === "PUT")
            return send(200, store.saveSettings(await body()));
          if (path === "/api/backup" && method === "GET")
            return send(
              200,
              {
                schemaVersion: 7,
                exported: new Date().toISOString(),
                ...store.workspace(),
                finance: store.finance(),
                sales: store.sales(),
                automation: store.automationState(),
                onlinePayments: gateway.list(100000),
                files: store.db
                  .prepare("SELECT id,entity_type,entity_id,purpose,name,mime,size,sha256,visibility,created FROM files ORDER BY created")
                  .all(),
                ext: Object.fromEntries(
                  await Promise.all(
                    PLUGINS.filter((p) => p.exportData).map(async (p) => [p.name, await p.exportData(store)]),
                  ),
                ),
                audit: store.db
                  .prepare("SELECT * FROM audit ORDER BY id")
                  .all(),
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
                  ((d.adjusted_total ?? d.total) / 100).toFixed(2),
                  (d.paid / 100).toFixed(2),
                  (d.balance / 100).toFixed(2),
                  d.status,
                ]),
            ];
            return send(
              200,
              "\uFEFF" +
                lines.map((r) => r.map(csvCell).join(",")).join("\r\n"),
              {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition":
                  'attachment; filename="nawlogic-invoices.csv"',
              },
            );
          }
          if (path === "/api/reports/sst" && method === "GET")
            return send(
              200,
              store.sstReport({
                from: url.searchParams.get("from") || undefined,
                to: url.searchParams.get("to") || undefined,
              }),
            );
          if (path === "/api/reports/sst.csv" && method === "GET") {
            const r = store.sstReport({
              from: url.searchParams.get("from") || undefined,
              to: url.searchParams.get("to") || undefined,
            });
            const lines = [
              ["Invoice", "Issue date", "Client", "Client TIN", "SST rate %", "Taxable MYR", "SST MYR"],
              ...r.rows.map((x) => [
                x.number,
                x.issue_date,
                x.client,
                x.client_tin,
                x.rate,
                (x.taxable / 100).toFixed(2),
                (x.tax / 100).toFixed(2),
              ]),
              [],
              ["Rate summary"],
              ...r.rates.map((x) => ["", "", "", "", x.rate, (x.taxable / 100).toFixed(2), (x.tax / 100).toFixed(2)]),
              [],
              ["Credit/debit notes in period (no SST breakdown; review manually)"],
              ...r.notes.map((n) => [n.number, n.issue_date, n.invoice, "", n.kind, (n.amount / 100).toFixed(2), ""]),
            ];
            return send(
              200,
              "\uFEFF" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n"),
              {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="sst-${r.from}-${r.to}.csv"`,
              },
            );
          }
          if (path === "/api/recovery/status" && method === "GET")
            return send(200, backups.status());
          if (path === "/api/recovery/backup" && method === "POST") {
            // A run may also upload the backup off-site, which can take minutes.
            res.setTimeout(11 * 60000);
            return send(201, await backups.run());
          }
          const mfa = path.match(/^\/api\/mfa\/(status|begin|enable|disable)$/);
          if (mfa) {
            const action = mfa[1];
            if (action === "status" && method === "GET")
              return send(200, mfaStatus(store, session.owner_id));
            if (method === "POST") {
              allow("mfa:" + session.owner_id, 8, 5 * 60000);
              const b = await body();
              const owner = store.db
                .prepare("SELECT * FROM owners WHERE id=?")
                .get(session.owner_id);
              check(
                await verifyPassword(b.password, owner.password),
                "Current password is incorrect.",
                403,
              );
              if (action === "begin")
                return send(200, beginMfa(store, owner.id));
              if (action === "enable")
                return send(
                  200,
                  enableMfa(store, owner.id, b.code, session.hash),
                );
              if (action === "disable") {
                check(
                  verifySecondFactor(store, owner.id, b.code),
                  "Authenticator or recovery code is invalid.",
                  403,
                );
                disableMfa(store, owner.id, session.hash);
                return send(200, { ok: true });
              }
            }
          }
          if (path === "/api/receipts" && method === "POST") {
            const b = await body();
            return send(
              201,
              write("receipt.create", b, () => store.receive(b)),
            );
          }
          const receipt = path.match(
            /^\/api\/receipts\/([\w-]+)\/(allocate|refund|void|review|pdf)$/,
          );
          if (receipt) {
            const [, rid, action] = receipt;
            if (method === "GET" && action === "pdf") {
              const r = store.receipt(rid);
              check(!r.voided, "Receipt was voided.", 409);
              return send(200, await renderReceiptPdf(r), {
                "Content-Type": "application/pdf",
                "Content-Disposition": `attachment; filename="${r.number}.pdf"`,
              });
            }
            if (method === "POST") {
              const b = await body();
              if (action === "allocate")
                return send(
                  201,
                  write("allocate:" + rid, b, () => store.allocate(rid, b)),
                );
              if (action === "refund")
                return send(
                  201,
                  write("refund:" + rid, b, () => store.refund(rid, b)),
                );
              if (action === "void") {
                store.voidReceipt(rid, b.reason);
                return send(200, { ok: true });
              }
              if (action === "review")
                return send(200, store.resolveLegacy(rid, b.reason));
            }
          }
          const note = path.match(
            /^\/api\/(adjustments|refunds)\/([\w-]+)\/pdf$/,
          );
          if (note && method === "GET") {
            const row = store.db
              .prepare(`SELECT * FROM ${note[1]} WHERE id=?`)
              .get(note[2]);
            check(row, "Note not found.", 404);
            let d;
            if (note[1] === "adjustments") d = store.document(row.invoice_id);
            else {
              const r = store.receipt(row.receipt_id);
              d = { number: r.number, business: r.business, client: r.client };
              row.kind = "refund";
            }
            return send(200, await renderAdjustmentPdf(d, row), {
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename="${row.number}.pdf"`,
            });
          }
          if (path === "/api/bank/preview" && method === "POST")
            return send(200, store.previewBank(await body()));
          if (path === "/api/bank/import" && method === "POST") {
            const b = await body();
            return send(
              201,
              write("bank.import", b, () => store.importBank(b)),
            );
          }
          const bank = path.match(
            /^\/api\/bank\/([\w-]+)\/(match|unmatch|exclude|receive)$/,
          );
          if (bank && method === "POST") {
            const b = await body();
            if (bank[2] === "receive")
              return send(
                201,
                write("bank.receive:" + bank[1], b, () =>
                  store.recordBankReceipt(bank[1], b),
                ),
              );
            if (bank[2] === "match")
              return send(200, store.matchBank(bank[1], b));
            if (bank[2] === "unmatch") store.resetBank(bank[1], b.reason);
            else store.ignoreBank(bank[1], b.reason);
            return send(200, { ok: true });
          }
          const proof = path.match(/^\/api\/proofs\/([\w-]+)\/reject$/);
          if (proof && method === "POST") {
            store.reviewProof(proof[1], (await body()).reason);
            return send(200, { ok: true });
          }
          const statement = path.match(
            /^\/api\/clients\/([\w-]+)\/statement(?:\/(pdf|email))?$/,
          );
          if (statement && statement[2] === "pdf" && method === "GET") {
            const s = store.statement(statement[1], {
              from_date: url.searchParams.get("from") || undefined,
              to_date: url.searchParams.get("to") || undefined,
            });
            return send(200, await renderStatementPdf(s), {
              "Content-Type": "application/pdf",
              "Content-Disposition": `attachment; filename="statement-${s.to}.pdf"`,
            });
          }
          if (statement && !statement[2] && method === "GET")
            return send(
              200,
              store.statement(statement[1], {
                from_date: url.searchParams.get("from") || undefined,
                to_date: url.searchParams.get("to") || undefined,
              }),
            );
          if (statement && statement[2] === "email" && method === "POST") {
            allow("email:" + session.owner_id, 30, 600000);
            return send(
              201,
              await mailer.sendStatement(statement[1], await body()),
            );
          }
          const online = path.match(/^\/api\/online-payments\/([\w-]+)\/check$/);
          if (online && method === "POST") {
            const row = store.db
              .prepare("SELECT bill_id FROM online_payments WHERE id=?")
              .get(online[1]);
            check(row, "Payment not found.", 404);
            return send(200, await gateway.settle(row.bill_id));
          }
          if (path === "/api/reminders/run" && method === "POST")
            return send(200, await mailer.runReminders());
          const archive = path.match(
            /^\/api\/clients\/([\w-]+)\/(archive|restore)$/,
          );
          if (archive && method === "POST")
            return send(
              200,
              store.archiveClient(archive[1], archive[2] === "archive"),
            );
          const removable = path.match(
            /^\/api\/(clients|services|documents|schedules|sales\/opportunities)\/([\w-]+)$/,
          );
          if (removable && method === "DELETE") {
            const [, kind, rid] = removable;
            ({
              clients: () => store.deleteClient(rid),
              services: () => store.deleteService(rid),
              documents: () => store.deleteDraft(rid),
              schedules: () => store.deleteSchedule(rid),
              "sales/opportunities": () => store.deleteOpportunity(rid),
            })[kind]();
            return send(200, { ok: true });
          }
          const scheduleEdit = path.match(/^\/api\/schedules\/([\w-]+)$/);
          if (scheduleEdit && method === "PUT")
            return send(
              200,
              store.updateSchedule(scheduleEdit[1], await body()),
            );
          const simple = path.match(
            /^\/api\/(clients|services)(?:\/([\w-]+))?$/,
          );
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
              write(`${kind}:${idv || "create"}`, b, () =>
                kind === "clients"
                  ? store.saveClient(b, idv)
                  : store.saveService(b, idv),
              ),
            );
          }
          if (path === "/api/documents" && method === "GET") {
            // Paged, searchable document list for integrations and large workspaces.
            const q = (url.searchParams.get("q") || "").toLowerCase().slice(0, 120);
            const kind = url.searchParams.get("kind");
            const state = url.searchParams.get("state");
            const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
            const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
            const all = store
              .documents()
              .filter(
                (d) =>
                  (!kind || d.kind === kind) &&
                  (!state || d.state === state) &&
                  (!q ||
                    `${d.number || ""} ${d.client.name} ${d.client.email || ""}`
                      .toLowerCase()
                      .includes(q)),
              );
            return send(200, {
              total: all.length,
              limit,
              offset,
              items: all.slice(offset, offset + limit).map((d) => ({
                id: d.id,
                kind: d.kind,
                number: d.number,
                state: d.state,
                status: d.status,
                client: { id: d.client_id, name: d.client.name },
                issue_date: d.issue_date,
                due_date: d.due_date,
                total: d.total,
                balance: d.balance,
              })),
            });
          }
          if (path === "/api/documents" && method === "POST") {
            const b = await body();
            return send(
              201,
              write("document.create", b, () => store.saveDocument(b)),
            );
          }
          const doc = path.match(
            /^\/api\/documents\/([\w-]+)(?:\/(issue|share|revoke|void|convert|payments|adjustments|pdf|duplicate|email))?$/,
          );
          if (doc) {
            const [, idv, action] = doc;
            if (method === "GET" && !action)
              return send(200, store.document(idv));
            if (method === "PUT" && !action)
              return send(200, store.saveDocument(await body(), idv));
            if (method === "GET" && action === "pdf") {
              const d = store.document(idv);
              return send(200, await renderPdf(d, null, await store.pdfBlocks(d)), {
                "Content-Type": "application/pdf",
                "Content-Disposition": `attachment; filename="${d.number || "DRAFT"}.pdf"`,
              });
            }
            if (method === "POST" && action === "issue")
              return send(
                200,
                write("issue:" + idv, {}, () => store.issue(idv)),
              );
            if (method === "POST" && action === "share") {
              const b = await body();
              const result = store.share(idv, b.days ?? 30);
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
            if (method === "POST" && action === "email") {
              allow("email:" + session.owner_id, 30, 600000);
              return send(
                201,
                await mailer.sendDocument(
                  idv,
                  await body(),
                  (token) => `${allowedOrigin}/client/${token}`,
                ),
              );
            }
            if (method === "POST" && action === "duplicate")
              return send(
                201,
                write("duplicate:" + idv, {}, () =>
                  store.duplicateDocument(idv),
                ),
              );
            if (method === "POST" && action === "convert")
              return send(200, store.convert(idv));
            if (method === "POST" && action === "payments") {
              const b = await body();
              return send(
                201,
                write("payment:" + idv, b, () => store.recordPayment(idv, b)),
              );
            }
            if (method === "POST" && action === "adjustments") {
              const b = await body();
              return send(
                201,
                write("adjustment:" + idv, b, () => store.adjustment(idv, b)),
              );
            }
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
              return send(
                200,
                await renderReceiptPdf(store.receipt(p.receipt_id)),
                {
                  "Content-Type": "application/pdf",
                  "Content-Disposition": `attachment; filename="receipt-${p.id.slice(0, 8)}.pdf"`,
                },
              );
            }
          }
          if (path === "/api/schedules" && method === "POST") {
            const b = await body();
            return send(
              201,
              write("schedule.create", b, () => store.saveSchedule(b)),
            );
          }
          const sch = path.match(
            /^\/api\/schedules\/([\w-]+)\/(run|pause|resume)$/,
          );
          if (sch && method === "POST") {
            const [, sid, action] = sch;
            if (action === "run")
              return send(
                201,
                write("schedule.run:" + sid, {}, () => store.runSchedule(sid)),
              );
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
          if (path === "/api/files" && method === "POST") {
            // Raw upload: the body is the file; details travel in the query string.
            allow("upload:" + session.owner_id, 60, 600000);
            const data = await rawBody();
            return send(
              201,
              store.saveFile({
                entity_type: url.searchParams.get("entity_type"),
                entity_id: url.searchParams.get("entity_id"),
                purpose: url.searchParams.get("purpose"),
                name: url.searchParams.get("name") || "upload",
                visibility: url.searchParams.get("visibility") || "private",
                data,
              }),
            );
          }
          if (path === "/api/files" && method === "GET")
            return send(
              200,
              store.files(
                url.searchParams.get("entity_type") || "",
                url.searchParams.get("entity_id") || "",
                url.searchParams.get("purpose") || null,
              ),
            );
          const fileRoute = path.match(/^\/api\/files\/([\w-]+)$/);
          if (fileRoute && method === "GET") return sendFile(store.file(fileRoute[1]), url);
          if (fileRoute && method === "DELETE") {
            store.deleteFile(fileRoute[1]);
            return send(200, { ok: true });
          }
          const secretRoute = path.match(/^\/api\/secrets\/([A-Z][A-Z0-9_]{1,63})$/);
          if (secretRoute && method === "PUT") {
            // Integration keys need the password again, like connector tokens.
            allow("secret:" + session.owner_id, 20, 600000);
            const b = await body();
            const known = SECRETS.find((x) => x.name === secretRoute[1]);
            check(known, "Unknown setting.", 404);
            const owner = store.db
              .prepare("SELECT password FROM owners WHERE id=?")
              .get(session.owner_id);
            check(
              await verifyPassword(b.password, owner.password),
              "Current password is incorrect.",
              403,
            );
            check(
              verifySecondFactor(store, session.owner_id, b.code),
              "Authenticator or recovery code required/invalid.",
              403,
            );
            store.setSecret(known.name, b.value ?? null);
            return send(200, store.secretStatus([known.name])[0]);
          }
          if (path === "/api/jobs" && method === "GET")
            return send(200, Object.values(jobState));
          const jobRoute = path.match(/^\/api\/jobs\/([a-z]+:[a-z0-9-]+)\/run$/);
          if (jobRoute && method === "POST") {
            check(jobs.has(jobRoute[1]), "Job not found.", 404);
            return send(200, await server.runJob(jobRoute[1]));
          }
          for (const p of PLUGINS) if (await p.routes?.owner?.(r)) return;
          throw new AppError("Not found.", 404);
        }
        check(method === "GET", "Not found.", 404);
        // Browser pages: the workspace, client links and guest pages from modules
        // (e.g. /portal/<token>). Anything with a file extension is a static asset.
        const page =
          path === "/" || /^\/[a-z][a-z-]{1,30}\/[\w-]{1,100}(\/[\w-]{1,100})?$/.test(path);
        const staticPath = page ? "/index.html" : path;
        let decoded;
        try {
          decoded = decodeURIComponent(staticPath);
        } catch {
          throw new AppError("Not found.", 404);
        }
        const file = resolve(publicDir, "." + decoded);
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
        if (page) {
          // Modules may add <head> tags, e.g. link previews for shared invoices.
          const heads = (
            await Promise.all(PLUGINS.map((p) => p.pageHead?.(r)))
          ).filter(Boolean);
          if (heads.length)
            bytes = Buffer.from(
              bytes.toString("utf8").replace("</head>", heads.join("\n") + "\n  </head>"),
            );
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
    }),
  );
  server.backups = backups;
  server.ctx = ctx;
  // Background jobs from feature modules. A job never overlaps itself.
  const jobs = new Map(JOBS.map((j) => [j.name, j]));
  const jobState = Object.fromEntries(
    JOBS.map((j) => [j.name, { name: j.name, every: j.every, running: false, lastRun: null, lastError: null, lastResult: null }]),
  );
  server.runJob = async (name) => {
    const job = jobs.get(name),
      state = jobState[name];
    check(job, "Job not found.", 404);
    if (state.running) return { skipped: true };
    state.running = true;
    try {
      const result = await requestContext.run({ actor: "job:" + name }, () => job.run(ctx));
      state.lastResult = result ?? null;
      state.lastError = null;
      return result ?? { ok: true };
    } catch (e) {
      state.lastError = e instanceof AppError ? e.message : "Job failed; see server log.";
      console.error(`Job ${name} failed:`, e.message);
      throw e;
    } finally {
      state.running = false;
      state.lastRun = new Date().toISOString();
    }
  };
  const jobTimers = [];
  let automationTimer, reminderTimer;
  server.startAutomations = () => {
    if (automationTimer) return;
    const run = () =>
      requestContext.run({ actor: "automation:worker" }, () => {
        try {
          store.runAutomations();
        } catch {
          console.error(
            "Automation worker failed; inspect database/server status.",
          );
        }
      });
    run();
    automationTimer = setInterval(run, 30000);
    automationTimer.unref();
    // Reminders are opt-in in Settings; each invoice/stage is sent at most once.
    const remind = () =>
      mailer
        .runReminders()
        .catch(() => console.error("Reminder run failed; check mail settings."));
    remind();
    reminderTimer = setInterval(remind, 3600000);
    reminderTimer.unref();
    for (const job of JOBS) {
      const tick = () => server.runJob(job.name).catch(() => {});
      const first = setTimeout(tick, job.delay ?? 15000);
      first.unref();
      const timer = setInterval(tick, job.every);
      timer.unref();
      jobTimers.push(first, timer);
    }
  };
  server.on("close", () => {
    backups.stop();
    if (automationTimer) clearInterval(automationTimer);
    if (reminderTimer) clearInterval(reminderTimer);
    for (const t of jobTimers) clearInterval(t);
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
  // A run left "running" by a previous process can never finish; mark it failed so it can be reviewed.
  store.db
    .prepare(
      "UPDATE assistant_runs SET state='failed',response='Interrupted by server restart' WHERE state='running'",
    )
    .run();
  const server = createApp({
    store,
    appUrl,
    secure: production,
    trustProxy: proxyHops(process.env.TRUST_PROXY),
  });
  server.listen(port, host, () => {
    console.log(`Nawlogic Invoice: ${appUrl}`);
    server.backups.start();
    server.startAutomations();
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () =>
      server.close(() => {
        store.db.close();
        process.exit(0);
      }),
    );
}
