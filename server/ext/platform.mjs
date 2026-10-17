// Platform: outgoing webhooks, data import, installable app, invoices from plain language, hosting and one-command install.
// Feature module contract: see docs/PLUGINS.md. Owner guide: docs/features/platform.md.
import { randomUUID, createHash } from "node:crypto";
import { check, now, text } from "../domain.mjs";
import { verifyPassword } from "../auth.mjs";
import { verifySecondFactor } from "../mfa.mjs";
import { requestContext } from "../context.mjs";
import { Webhooks, EVENT_TYPES, WEBHOOK_MIGRATION } from "../platform-webhooks.mjs";
import { runImport, templateCsv, importHistory, IMPORT_KINDS, IMPORT_MIGRATION, MAX_IMPORT_BYTES } from "../platform-import.mjs";
import { parseQuickText, aiParse, whatsappReply } from "../platform-quick.mjs";

const OWNER_WHATSAPP = "PLATFORM_OWNER_WHATSAPP";
const QUICK_KINDS = ["invoice", "quote"];

// Password (and authenticator code) again before data can leave for a new URL.
async function confirmOwner(r, b) {
  r.allow("platform-confirm:" + r.session.owner_id, 10, 300000);
  const owner = r.ctx.store.db.prepare("SELECT password FROM owners WHERE id=?").get(r.session.owner_id);
  check(await verifyPassword(b.password, owner.password), "Current password is incorrect.", 403);
  check(verifySecondFactor(r.ctx.store, r.session.owner_id, b.code), "Authenticator or recovery code required/invalid.", 403);
}
function quickContext(store) {
  return {
    clients: store.db.prepare("SELECT id,name,terms,archived FROM clients ORDER BY name").all(),
    services: store.db.prepare("SELECT id,name,description,unit,rate,tax_rate,active FROM services WHERE active=1 ORDER BY name").all(),
    settings: store.settings(),
  };
}
// Saves a confirmed quick draft through the normal draft code. Never issues.
function saveQuickDraft(store, b, source = "app") {
  return store.tx(() => {
    check(QUICK_KINDS.includes(b.kind), "Choose invoice or quotation.");
    let clientId = b.client_id;
    if (!clientId) {
      const name = text(b.new_client_name || "", 160, true);
      clientId = store.saveClient({ name }).id;
    }
    check(Array.isArray(b.items), "Add at least one line.");
    const items = b.items.map((i) => ({
      description: i.description,
      quantity: String(i.quantity ?? "1"),
      rate: String(i.rate ?? "0"),
      tax_rate: Number(i.tax_rate || 0),
      ...(typeof i.service_id === "string" && /^[\w-]{1,80}$/.test(i.service_id) ? { service_id: i.service_id } : {}),
      ...(typeof i.unit === "string" && i.unit.length <= 30 ? { unit: i.unit } : {}),
    }));
    const d = store.saveDocument({
      kind: b.kind,
      client_id: clientId,
      issue_date: b.issue_date,
      due_date: b.due_date,
      items,
      discount: b.discount ?? "0",
      notes: b.notes || "",
    });
    const request = text(String(b.text || ""), 600);
    store.db
      .prepare("INSERT INTO platform_quick_requests(id,source,message_key,text,document_id,created) VALUES(?,?,?,?,?,?)")
      .run(randomUUID(), source, b.message_key || null, request, d.id, now());
    store.audit("quick_invoice.drafted", d.id, `${source}: ${request.slice(0, 160)}`);
    return d;
  });
}
const ownerNumbers = (store) =>
  String(store.config(OWNER_WHATSAPP) || "")
    .split(/[,;\n]+/)
    .map((n) => n.replace(/\D/g, "").replace(/^0/, "60"))
    .filter((n) => n.length >= 8);
// WhatsApp messages from the owner's own number that start with "Invois",
// "Invoice", "Quote" or "Sebut harga" become drafts. Returns the reply text,
// or null when the message is not for this module.
export async function handleWhatsApp(ctx, msg) {
  const store = ctx.store;
  const from = String(msg?.from ?? msg?.phone ?? msg?.wa_id ?? "").replace(/\D/g, "");
  const body = typeof msg?.text === "string" ? msg.text : msg?.text?.body ?? msg?.body;
  // The owner's number may be set here or in the messaging module (msg.fromOwner).
  const owner = msg?.fromOwner === true || ownerNumbers(store).includes(from);
  if (!from || typeof body !== "string" || !owner) return null;
  const s = quickContext(store);
  let draft;
  try {
    draft = parseQuickText(body.slice(0, 600), s);
  } catch {
    return null;
  }
  if (!draft.explicitKind) return null;
  const key = msg.id ? "whatsapp:" + String(msg.id).slice(0, 200) : null;
  if (key && store.db.prepare("SELECT 1 FROM platform_quick_requests WHERE message_key=?").get(key)) return null;
  const recent = store.db
    .prepare("SELECT count(*) n FROM platform_quick_requests WHERE source='whatsapp' AND created>?")
    .get(new Date(Date.now() - 3600000).toISOString()).n;
  if (recent >= 30) return draft.language === "ms" ? "Had 30 draf sejam dicapai. Cuba lagi nanti." : "Limit of 30 drafts an hour reached. Try again later.";
  if (!draft.understood) return whatsappReply(draft, "unknown");
  if (!draft.client && draft.clientChoices?.length) return whatsappReply(draft, "ambiguous");
  if (!draft.client) return whatsappReply(draft, "no-client");
  let d;
  try {
    d = requestContext.run({ actor: "whatsapp:owner" }, () =>
      saveQuickDraft(store, { ...draft, client_id: draft.client.id, text: body, message_key: key }, "whatsapp"),
    );
  } catch (e) {
    const why = e?.status ? e.message : "unexpected error";
    return draft.language === "ms" ? `Draf tidak disimpan: ${why}` : `The draft was not saved: ${why}`;
  }
  return whatsappReply({ ...draft, total: d.total }, "saved", `${ctx.appUrl}/#/document/${d.id}`);
}
// Excel often saves CSV as Windows-1252; fall back to Latin-1 when it is not UTF-8.
function decodeCsv(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return buf.toString("latin1");
  }
}

export default {
  name: "platform",
  // Staff may use the quick invoice box; webhooks and imports stay with the owner.
  access: {
    staff: [["POST", /^\/api\/platform\/quick\/(parse|draft)$/]],
  },
  migrations: [
    { name: "platform-001-webhooks", sql: WEBHOOK_MIGRATION },
    { name: "platform-002-imports", sql: IMPORT_MIGRATION },
    {
      name: "platform-003-quick-requests",
      sql: `CREATE TABLE platform_quick_requests(id TEXT PRIMARY KEY, source TEXT NOT NULL, message_key TEXT UNIQUE, text TEXT NOT NULL, document_id TEXT, created TEXT NOT NULL);
CREATE INDEX platform_quick_source ON platform_quick_requests(source,created);`,
    },
  ],
  secrets: [
    {
      name: OWNER_WHATSAPP,
      label: "Owner WhatsApp number for quick invoices",
      help: "Your own number in international format, e.g. 60123456789. Messages from it that start with Invois, Invoice, Quote or Sebut harga become drafts. Needs the WhatsApp connection.",
      secret: false,
    },
  ],
  init(ctx) {
    const webhooks = new Webhooks(ctx.store, { appUrl: ctx.appUrl });
    webhooks.ensureCursor();
    ctx.services.webhooks = webhooks;
    // The comms module provides WhatsApp; without it this stays off.
    const wa = ctx.services.whatsapp;
    // All inbound messages, so a number set only in this module also works;
    // handleWhatsApp ignores everything that is not from the owner.
    if (wa && typeof wa.onInbound === "function") wa.onInbound((msg) => handleWhatsApp(ctx, msg), { clients: true });
  },
  routes: {
    async owner(r) {
      if (!r.path.startsWith("/api/platform/")) return false;
      const { store, services } = r.ctx;
      const webhooks = services.webhooks;
      const p = r.path.slice("/api/platform".length);
      const m = r.method;
      // Webhooks
      if (p === "/webhooks" && m === "GET") return r.send(200, { webhooks: webhooks.list(), deliveries: webhooks.deliveries({ limit: 50 }), eventTypes: EVENT_TYPES }), true;
      if (p === "/webhooks" && m === "POST") {
        const b = await r.body();
        await confirmOwner(r, b);
        return r.send(201, await webhooks.create(b)), true;
      }
      let x = p.match(/^\/webhooks\/([\w-]{1,80})$/);
      if (x && m === "PUT") {
        const b = await r.body();
        if (b.url !== undefined && b.url !== webhooks.get(x[1]).url) await confirmOwner(r, b);
        return r.send(200, await webhooks.update(x[1], b)), true;
      }
      if (x && m === "DELETE") return webhooks.remove(x[1]), r.send(200, { ok: true }), true;
      x = p.match(/^\/webhooks\/([\w-]{1,80})\/(rotate|test|deliveries)$/);
      if (x && x[2] === "rotate" && m === "POST") {
        await confirmOwner(r, await r.body());
        return r.send(200, webhooks.rotate(x[1])), true;
      }
      if (x && x[2] === "test" && m === "POST") {
        r.allow("webhook-test:" + r.session.owner_id, 20, 600000);
        r.res.setTimeout(30000);
        return r.send(200, await webhooks.sendTest(x[1])), true;
      }
      if (x && x[2] === "deliveries" && m === "GET") return webhooks.get(x[1]), r.send(200, webhooks.deliveries({ webhookId: x[1], limit: 100 })), true;
      x = p.match(/^\/deliveries\/([\w-]{1,80})(\/retry)?$/);
      if (x && !x[2] && m === "GET") {
        const d = webhooks.delivery(x[1]);
        return r.send(200, { ...d, payload: webhooks.event(d.event_id) }), true;
      }
      if (x && x[2] && m === "POST") return r.send(200, webhooks.retry(x[1])), true;
      // Import
      x = p.match(/^\/import\/template\/([a-z]+)\.csv$/);
      if (x && m === "GET") {
        check(IMPORT_KINDS.includes(x[1]), "Template not found.", 404);
        return (
          r.send(200, templateCsv(x[1]), {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="nawlogic-${x[1]}-template.csv"`,
          }),
          true
        );
      }
      x = p.match(/^\/import\/([a-z]+)(\/preview)?$/);
      if (x && m === "POST") {
        check(IMPORT_KINDS.includes(x[1]), "Choose clients, services or invoices.", 404);
        r.allow("import:" + r.session.owner_id, 60, 600000);
        const csv = decodeCsv(await r.rawBody(MAX_IMPORT_BYTES));
        if (x[2]) return r.send(200, runImport(store, x[1], csv)), true;
        // The import must be the file that was previewed.
        const expected = r.url.searchParams.get("sha256") || "";
        check(/^[0-9a-f]{64}$/.test(expected), "Preview the file before importing it.");
        check(createHash("sha256").update(csv).digest("hex") === expected, "The file changed after the preview. Preview it again.", 409);
        const result = runImport(store, x[1], csv, { commit: true });
        return r.send(result.errors ? 422 : result.imported ? 201 : 200, result), true;
      }
      // Quick invoice
      if (p === "/quick/parse" && m === "POST") {
        r.allow("quick:" + r.session.owner_id, 120, 600000);
        const b = await r.body();
        const s = quickContext(store);
        if (b.ai === true) {
          check(b.consent === true, "Confirm sending this text and your client and service names to the AI provider.");
          r.allow("quick-ai:" + r.session.owner_id, 10, 600000);
          r.res.setTimeout(40000);
          const draft = await aiParse(r.ctx.assistant, text(b.text, 600, true), s);
          store.audit("quick_invoice.ai_used", null, new URL(r.ctx.assistant.config.base).origin);
          return r.send(200, { ...draft, source: "ai" }), true;
        }
        return r.send(200, { ...parseQuickText(b.text, s), source: "parser" }), true;
      }
      if (p === "/quick/draft" && m === "POST") {
        const b = await r.body();
        return r.send(201, r.write("platform.quick", b, () => saveQuickDraft(store, b))), true;
      }
      return false;
    },
  },
  jobs: [
    {
      name: "webhooks",
      every: 20000,
      delay: 10000,
      async run(ctx) {
        const w = ctx.services.webhooks;
        const queued = w.collect();
        const sent = await w.deliverDue();
        if (!w.lastPrune || Date.now() - w.lastPrune > 3600000) {
          w.prune();
          w.lastPrune = Date.now();
        }
        return { queued, ...sent };
      },
    },
  ],
  workspace(r) {
    const { store, services, assistant } = r.ctx;
    const wa = services.whatsapp;
    return {
      webhooks: services.webhooks.list(),
      deliveries: services.webhooks.deliveries({ limit: 30 }),
      eventTypes: EVENT_TYPES,
      imports: importHistory(store, 10),
      quick: {
        ai: !!assistant?.config,
        aiOrigin: assistant?.config ? new URL(assistant.config.base).origin : null,
        // Connected means the WhatsApp keys are set, not just that the module exists.
        whatsapp: !!(wa && typeof wa.onInbound === "function" && (wa.status?.().configured ?? true)),
        whatsappNumber: ownerNumbers(store).length > 0,
      },
    };
  },
  // Only the owner app is installable; client links are not.
  pageHead(r) {
    if (r.path !== "/") return "";
    return [
      '<link rel="manifest" href="/manifest.webmanifest" />',
      '<link rel="apple-touch-icon" href="/assets/icons/apple-touch-icon.png" />',
      '<meta name="mobile-web-app-capable" content="yes" />',
      '<meta name="apple-mobile-web-app-capable" content="yes" />',
      '<meta name="apple-mobile-web-app-title" content="Nawlogic" />',
      '<meta name="apple-mobile-web-app-status-bar-style" content="black" />',
    ].join("\n    ");
  },
  exportData(store) {
    return {
      webhooks: store.db
        .prepare("SELECT id,url,description,events,active,disabled_reason,created FROM platform_webhooks ORDER BY created")
        .all()
        .map((w) => ({ ...w, events: JSON.parse(w.events), active: !!w.active })),
      imports: importHistory(store, 100000),
    };
  },
  // A restored copy must not start posting business data again on its own.
  onRestore(db) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE name='platform_webhooks'").get()) return;
    db.prepare("UPDATE platform_webhooks SET active=0,disabled_reason=?,disabled_at=? WHERE active=1").run(
      "Turned off when the database was restored. Check the endpoint, then turn it on.",
      now(),
    );
    db.prepare("UPDATE platform_webhook_deliveries SET state='cancelled',last_error='Cancelled by restore' WHERE state IN ('pending','delivering')").run();
  },
};
