// WhatsApp Business Platform (Cloud API). Business-initiated messages use the
// owner's approved templates; free text is only possible within 24 hours of the
// other person's last message. Webhooks are checked with X-Hub-Signature-256
// (HMAC-SHA256 of the raw body with the Meta app secret).
import { createHmac, timingSafeEqual } from "node:crypto";
import { id, now, check, AppError } from "./domain.mjs";
import { whatsappText } from "./comms-templates.mjs";
export const WHATSAPP_BASE = "https://graph.facebook.com";
export const DEFAULT_GRAPH_VERSION = "v25.0";
export function whatsappConfiguration(get) {
  const token = get("WHATSAPP_ACCESS_TOKEN"),
    phoneId = get("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneId) return null;
  check(/^\d{5,25}$/.test(String(phoneId).trim()), "WHATSAPP_PHONE_NUMBER_ID must be the numeric phone number ID from Meta.");
  const version = String(get("WHATSAPP_API_VERSION") || DEFAULT_GRAPH_VERSION).trim();
  check(/^v\d{1,3}\.\d$/.test(version), "WHATSAPP_API_VERSION must look like v25.0.");
  return {
    token: String(token).trim(),
    phoneId: String(phoneId).trim(),
    version,
    appSecret: get("WHATSAPP_APP_SECRET") || null,
    verifyToken: get("WHATSAPP_VERIFY_TOKEN") || null,
  };
}
// International number without "+" (the format WhatsApp uses). Local Malaysian
// numbers such as 012-345 6789 become 60123456789.
export function normalizePhone(raw, country = "60") {
  let s = String(raw ?? "").replace(/[^\d+]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  else if (s.startsWith("00")) s = s.slice(2);
  else if (s.startsWith("0")) s = country + s.slice(1);
  else if (/^1\d{8,9}$/.test(s)) s = country + s;
  s = s.replace(/\D/g, "");
  return /^\d{8,15}$/.test(s) ? s : null;
}
export function signBody(raw, secret) {
  return "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
}
export function validSignature(raw, header, secret) {
  if (!secret || typeof header !== "string" || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const a = Buffer.from(signBody(raw, secret)),
    b = Buffer.from(header.toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
}
export function sameSecret(given, expected) {
  if (typeof given !== "string" || !expected) return false;
  const a = Buffer.from(given),
    b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}
// Template parameters from the owner's mapping. Entries are variable names
// ("number") for positional templates, or "param_name=variable" for named ones.
export function templateComponents(mapping, vars) {
  const entries = (mapping.params || []).map((p) => {
    const [left, right] = String(p).split("=");
    return right === undefined ? { name: null, variable: left.trim() } : { name: left.trim(), variable: right.trim() };
  });
  const components = [];
  if (entries.length)
    components.push({
      type: "body",
      parameters: entries.map((e) => ({
        type: "text",
        ...(e.name ? { parameter_name: e.name } : {}),
        // WhatsApp refuses empty parameters.
        text: whatsappText(vars[e.variable]) || "-",
      })),
    });
  if (mapping.button === "link_token" && vars.link_token)
    components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: vars.link_token }],
    });
  return components;
}
const RANK = { sending: 0, sent: 1, delivered: 2, read: 3 };
async function readJson(response) {
  const chunks = [];
  let size = 0;
  for await (const c of response.body || []) {
    size += c.length;
    if (size > 65536) break;
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}
export class WhatsApp {
  constructor(store, { fetcher = globalThis.fetch, config } = {}) {
    this.store = store;
    this.fetcher = fetcher;
    this.fixed = config !== undefined;
    this.fixedConfig = config ?? null;
    this.handlers = [];
  }
  config() {
    if (this.fixed) return this.fixedConfig;
    try {
      return whatsappConfiguration((n) => this.store.config(n));
    } catch {
      return null;
    }
  }
  status() {
    let error = null;
    if (!this.fixed)
      try {
        whatsappConfiguration((n) => this.store.config(n));
      } catch (e) {
        error = e.message;
      }
    const c = this.config();
    return {
      configured: !!c,
      phoneNumberId: c?.phoneId || null,
      version: c?.version || null,
      webhookReady: !!(c?.appSecret && c?.verifyToken),
      error,
    };
  }
  // Sends one message and logs it. With a dedupe key it goes out at most once
  // (a failed attempt may be retried).
  async send({ to, kind = "message", template = null, language = "en", components = [], text = null, summary = "", documentId = null, clientId = null, dedupeKey = null }) {
    const config = this.config();
    check(config, "WhatsApp is not connected. Add the WhatsApp keys in Settings > Integration keys.", 409);
    const number = normalizePhone(to);
    check(number, "Enter a valid WhatsApp number with the country code, e.g. 60123456789.");
    check(template || text, "Choose a template or message.");
    if (template) {
      check(/^[a-z0-9_]{1,512}$/.test(template), "Template names use lowercase letters, numbers and underscores.");
      check(/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language), "Use a WhatsApp language code such as en, en_US or ms.");
    }
    const body = (template ? summary || `Template ${template}` : String(text)).slice(0, 4000);
    const db = this.store.db;
    let rowId = id();
    const previous = dedupeKey ? db.prepare("SELECT id,status FROM comms_whatsapp WHERE dedupe_key=?").get(dedupeKey) : null;
    if (previous && previous.status !== "failed") return null;
    if (previous) {
      rowId = previous.id;
      db.prepare("UPDATE comms_whatsapp SET status='sending',error=NULL,body=?,updated=? WHERE id=?").run(body, now(), rowId);
    } else
      db.prepare(
        "INSERT INTO comms_whatsapp(id,direction,kind,document_id,client_id,number,template,language,body,status,dedupe_key,created,updated) VALUES(?,'out',?,?,?,?,?,?,?,'sending',?,?,?)",
      ).run(rowId, kind, documentId, clientId, number, template, template ? language : null, body, dedupeKey, now(), now());
    const payload = template
      ? {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: number,
          type: "template",
          template: { name: template, language: { code: language }, ...(components.length ? { components } : {}) },
        }
      : { messaging_product: "whatsapp", recipient_type: "individual", to: number, type: "text", text: { preview_url: true, body: body } };
    let reason = "WhatsApp did not accept the message.";
    try {
      const response = await this.fetcher(`${WHATSAPP_BASE}/${config.version}/${config.phoneId}/messages`, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: "Bearer " + config.token, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      const data = await readJson(response);
      const wamid = data?.messages?.[0]?.id;
      if (!response.ok || typeof wamid !== "string" || !/^[\w.=:+/-]{1,200}$/.test(wamid)) {
        const err = data?.error || {};
        if (err.code || err.message)
          reason = `WhatsApp error ${Number(err.code) || ""}: ${String(err.error_data?.details || err.message || "").slice(0, 200)}`.trim();
        throw new Error(reason);
      }
      db.prepare("UPDATE comms_whatsapp SET status='sent',wa_id=?,updated=? WHERE id=?").run(wamid, now(), rowId);
      this.store.audit("whatsapp.sent", documentId || clientId, `${kind}: ${number}`);
      return { id: rowId, status: "sent", wa_id: wamid };
    } catch (e) {
      if (e?.message && e.message.startsWith("WhatsApp error")) reason = e.message;
      db.prepare("UPDATE comms_whatsapp SET status='failed',error=?,updated=? WHERE id=?").run(reason, now(), rowId);
      this.store.audit("whatsapp.failed", documentId || clientId, `${kind}: ${number}`);
      throw new AppError(`${reason} The message was not sent.`, 502);
    }
  }
  // Has this number written to us in the last 24 hours (free-form replies allowed)?
  windowOpen(number) {
    const n = normalizePhone(number);
    if (!n) return false;
    return !!this.store.db
      .prepare("SELECT 1 FROM comms_whatsapp WHERE direction='in' AND number=? AND created>? LIMIT 1")
      .get(n, new Date(Date.now() - 23.5 * 3600000).toISOString());
  }
  onInbound(handler, { clients = false } = {}) {
    check(typeof handler === "function", "Inbound handler must be a function.");
    const entry = { handler, clients };
    this.handlers.push(entry);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== entry);
    };
  }
  // Applies a verified webhook body: delivery statuses and inbound messages.
  // Returns the new inbound messages (duplicates from Meta retries are dropped).
  receive(payload, ownerNumber = null) {
    const config = this.config();
    const owner = normalizePhone(ownerNumber);
    const inbound = [];
    let statuses = 0;
    if (!payload || payload.object !== "whatsapp_business_account") return { statuses, inbound };
    const clients = this.store.db.prepare("SELECT id,phone FROM clients WHERE phone!=''").all();
    for (const entry of Array.isArray(payload.entry) ? payload.entry.slice(0, 50) : [])
      for (const change of Array.isArray(entry?.changes) ? entry.changes.slice(0, 50) : []) {
        if (change?.field !== "messages" || !change.value) continue;
        const v = change.value;
        // Another phone number on the same Meta app is not ours to record.
        if (config && v.metadata?.phone_number_id && String(v.metadata.phone_number_id) !== config.phoneId) continue;
        for (const s of Array.isArray(v.statuses) ? v.statuses.slice(0, 200) : []) {
          if (typeof s?.id !== "string") continue;
          const row = this.store.db.prepare("SELECT id,status FROM comms_whatsapp WHERE wa_id=? AND direction='out'").get(s.id);
          if (!row) continue;
          statuses++;
          if (s.status === "failed") {
            if (RANK[row.status] >= RANK.delivered) continue;
            const err = Array.isArray(s.errors) ? s.errors[0] : null;
            const reason = err
              ? `WhatsApp error ${Number(err.code) || ""}: ${String(err.error_data?.details || err.title || err.message || "").slice(0, 200)}`
              : "WhatsApp could not deliver the message.";
            this.store.db.prepare("UPDATE comms_whatsapp SET status='failed',error=?,updated=? WHERE id=?").run(reason, now(), row.id);
            this.store.audit("whatsapp.failed", row.id, reason);
          } else if (s.status in RANK && RANK[s.status] > (RANK[row.status] ?? -1) && row.status !== "failed") {
            this.store.db.prepare("UPDATE comms_whatsapp SET status=?,updated=? WHERE id=?").run(s.status, now(), row.id);
          } else if (s.status in RANK && row.status === "failed" && RANK[s.status] >= RANK.delivered) {
            // Delivered after a reported failure: the later, stronger status wins.
            this.store.db.prepare("UPDATE comms_whatsapp SET status=?,error=NULL,updated=? WHERE id=?").run(s.status, now(), row.id);
          }
        }
        for (const m of Array.isArray(v.messages) ? v.messages.slice(0, 100) : []) {
          const from = normalizePhone(m?.from);
          if (!from || typeof m.id !== "string" || m.id.length > 200) continue;
          const text = String(
            m.text?.body ??
              m.button?.text ??
              m.interactive?.button_reply?.title ??
              m.interactive?.list_reply?.title ??
              `[${String(m.type || "message").slice(0, 20)}]`,
          ).slice(0, 4000);
          const client = clients.find((c) => normalizePhone(c.phone) === from);
          const inserted = this.store.db
            .prepare(
              "INSERT OR IGNORE INTO comms_whatsapp(id,direction,kind,client_id,number,body,status,wa_id,created,updated) VALUES(?,'in','inbound',?,?,?,'received',?,?,?)",
            )
            .run(id(), client?.id || null, from, text, m.id, now(), now());
          if (!inserted.changes) continue;
          const name = v.contacts?.find?.((c) => normalizePhone(c?.wa_id) === from)?.profile?.name;
          inbound.push({
            id: m.id,
            from,
            fromOwner: !!owner && owner === from,
            clientId: client?.id || null,
            name: typeof name === "string" ? name.slice(0, 120) : "",
            type: String(m.type || "text"),
            text,
            timestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : now(),
          });
        }
      }
    return { statuses, inbound };
  }
  // Calls the registered handlers. Owner messages go to every handler; client
  // messages only to handlers that asked for them. A handler may return text to
  // reply with (allowed, since the person just wrote to us).
  async dispatch(inbound) {
    for (const m of inbound)
      for (const { handler, clients } of this.handlers) {
        if (!m.fromOwner && !clients) continue;
        try {
          const reply = await handler({
            ...m,
            reply: (text) => this.send({ to: m.from, kind: "reply", text: String(text).slice(0, 4000), clientId: m.clientId }),
          });
          if (typeof reply === "string" && reply.trim())
            await this.send({ to: m.from, kind: "reply", text: reply.trim().slice(0, 4000), clientId: m.clientId });
        } catch (e) {
          console.error("WhatsApp inbound handler failed:", e?.message || e);
        }
      }
  }
  log({ documentId = null, limit = 50 } = {}) {
    return documentId
      ? this.store.db
          .prepare("SELECT id,direction,kind,document_id,client_id,number,template,body,status,error,created,updated FROM comms_whatsapp WHERE document_id=? ORDER BY created DESC LIMIT ?")
          .all(documentId, limit)
      : this.store.db
          .prepare("SELECT id,direction,kind,document_id,client_id,number,template,body,status,error,created,updated FROM comms_whatsapp ORDER BY created DESC LIMIT ?")
          .all(limit);
  }
}
