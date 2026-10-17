// Outgoing webhooks (roadmap no. 84). Business events from the audit stream are
// sent to the owner's HTTPS endpoints (n8n, Zapier, Make, own servers), signed
// with HMAC-SHA256, retried with exponential backoff for up to 24 hours.
// Destinations are checked against private, loopback, link-local and metadata
// addresses at every delivery, and the connection is pinned to the checked IP.
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AppError, check, now, text } from "./domain.mjs";
import { encrypt, decrypt } from "./mfa.mjs";

export const CONSUMER = "platform-webhooks";
export const EVENT_TYPES = [
  { type: "invoice.issued", label: "Invoice issued" },
  { type: "invoice.paid", label: "Invoice fully paid" },
  { type: "quotation.issued", label: "Quotation issued" },
  { type: "quotation.accepted", label: "Quotation accepted" },
  { type: "payment.received", label: "Payment received (receipt recorded)" },
  { type: "receipt.voided", label: "Receipt voided" },
  { type: "document.issued", label: "Other document issued (proforma, sales or delivery order)" },
  { type: "document.voided", label: "Document voided" },
  { type: "credit_note.issued", label: "Credit note issued" },
  { type: "debit_note.issued", label: "Debit note issued" },
  { type: "client.created", label: "Client created" },
  { type: "client.updated", label: "Client updated" },
];
const TYPES = new Set(EVENT_TYPES.map((e) => e.type));
export const MAX_WEBHOOKS = 10;
export const RETRY_WINDOW = 24 * 3600000;
const FIRST_RETRY = 60000;
const MAX_RETRY_GAP = 6 * 3600000;
// Failing continuously for this long (with at least this many attempts) turns an endpoint off.
const DISABLE_AFTER = 24 * 3600000;
const DISABLE_MIN_FAILURES = 10;
const TIMEOUT = 10000;
const USER_AGENT = "Nawlogic-Webhooks/1.0";

// ---------- destination checks (SSRF) ----------
const blockedV4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT (also Alibaba metadata 100.100.100.200)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
  ["168.63.129.16", 32], // Azure platform endpoint
])
  blockedV4.addSubnet(net, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6"); // global unicast only
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ["2001::", 23], // IETF protocol assignments (Teredo, benchmarking, ORCHID)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4
  ["3fff::", 20], // documentation
])
  blockedV6.addSubnet(net, prefix, "ipv6");
// Expands an IPv6 address into 16 bytes (handles "::" and a dotted IPv4 tail).
function ipv6Bytes(ip) {
  let s = ip.toLowerCase().split("%")[0];
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const p = tail[1].split(".").map(Number);
    s = s.slice(0, -tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head, rest = null] = s.split("::");
  const a = head ? head.split(":") : [];
  const b = rest === null ? [] : rest ? rest.split(":") : [];
  const groups = rest === null ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  return groups.flatMap((g) => {
    const v = parseInt(g || "0", 16);
    return [v >> 8, v & 255];
  });
}
// True only for addresses that are reachable on the public internet.
export function isPublicAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return !blockedV4.check(ip, "ipv4");
  if (family !== 6) return false;
  const b = ipv6Bytes(ip);
  const v4 = (o) => b.slice(o, o + 4).join(".");
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry an IPv4 address.
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) return isPublicAddress(v4(12));
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return isPublicAddress(v4(12));
  return globalV6.check(ip, "ipv6") && !blockedV6.check(ip, "ipv6");
}
const BLOCKED_HOSTS = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa|in-addr\.arpa|ip6\.arpa)$/i;
// Checks what can be checked without the network: HTTPS, no credentials, a public-looking host.
export function checkUrl(raw) {
  check(typeof raw === "string" && raw.trim().length > 0, "Enter the endpoint URL.");
  check(raw.length <= 500, "The URL must be 500 characters or fewer.");
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new AppError("Enter a valid URL, e.g. https://hooks.example.com/nawlogic.");
  }
  check(url.protocol === "https:", "Webhook URLs must use HTTPS.");
  check(!url.username && !url.password, "Do not put a user name or password in the URL. Use the signing secret instead.");
  check(!url.hash, "Remove the #fragment from the URL.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) check(isPublicAddress(host), "The URL points to a private or reserved address.");
  else {
    check(!BLOCKED_HOSTS.test(host), "The URL points to a private or local host name.");
    check(host.includes(".") && !host.endsWith("."), "Use a full public host name, e.g. hooks.example.com.");
  }
  return url;
}
// Resolves the host now and refuses private destinations; the returned address
// is the one the connection must use (so DNS cannot change in between).
export async function resolveDestination(raw, lookup = dnsLookup) {
  const url = checkUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
  else {
    try {
      addresses = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new AppError(`Could not find ${host} in DNS.`);
    }
  }
  check(Array.isArray(addresses) && addresses.length > 0, `Could not find ${host} in DNS.`);
  for (const a of addresses) check(isPublicAddress(a.address), `Blocked: ${host} resolves to a private or reserved address (${a.address}).`);
  return { url, address: addresses[0].address, family: addresses[0].family || isIP(addresses[0].address) };
}
// Default transport: one HTTPS POST to the checked address, certificate checked
// against the host name, no redirects, a short timeout and a small response cap.
// (`ca` exists only so tests can trust a local test certificate.)
export function httpsSend({ url, address, family, headers, body, timeout = TIMEOUT, ca }) {
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const req = https.request(
      {
        protocol: "https:",
        hostname: host,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        lookup: (name, options, cb) => (options?.all ? cb(null, [{ address, family }]) : cb(null, address, family)),
        servername: isIP(host) ? undefined : host,
        agent: false,
        timeout,
        ...(ca ? { ca } : {}),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size <= 2048) chunks.push(c);
          else res.destroy();
        });
        const finish = () => done(resolve, { status: res.statusCode, body: Buffer.concat(chunks).toString("utf8").slice(0, 2048) });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("Timed out")), timeout + 5000);
    req.on("timeout", () => req.destroy(new Error("Timed out")));
    req.on("error", (e) => done(reject, e));
    req.end(body);
  });
}

// ---------- signatures ----------
export const sign = (secret, timestamp, body) => createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
export const signatureHeader = (secret, timestamp, body) => `t=${timestamp},v1=${sign(secret, timestamp, body)}`;
// Reference check for receivers: valid signature and a timestamp within the tolerance.
export function verifySignature(secret, header, body, { tolerance = 300, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof header !== "string") return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(nowSeconds - t) > tolerance || !/^[0-9a-f]{64}$/.test(parts.v1 || "")) return false;
  return timingSafeEqual(Buffer.from(sign(secret, t, body), "hex"), Buffer.from(parts.v1, "hex"));
}

// ---------- event snapshots (no secrets, no share tokens, no bank details) ----------
function documentSnapshot(d, appUrl) {
  return {
    id: d.id,
    kind: d.kind,
    number: d.number || null,
    state: d.state,
    status: d.status,
    currency: d.currency || "MYR",
    issue_date: d.issue_date,
    due_date: d.due_date,
    client: { id: d.client_id, name: d.client?.name || "", email: d.client?.email || "", phone: d.client?.phone || "", tin: d.client?.tin || "", brn: d.client?.brn || "" },
    items: (d.items || []).map((i) => ({
      description: i.description,
      quantity: i.quantity,
      rate: i.rate,
      amount: i.amount,
      tax_rate: i.tax_rate || 0,
      tax: i.tax || 0,
      ...(i.unit ? { unit: i.unit } : {}),
      ...(i.sku ? { sku: i.sku } : {}),
    })),
    subtotal: d.subtotal,
    discount: d.discount,
    tax: d.tax || 0,
    total: d.total,
    adjusted_total: d.adjusted_total ?? d.total,
    paid: d.paid ?? 0,
    balance: d.balance ?? 0,
    ...(d.kind === "quote" ? { accepted_name: d.accepted_name || null } : {}),
    ...(d.source_quote ? { source_quote: d.source_quote } : {}),
    url: `${appUrl}/#/document/${d.id}`,
  };
}
function receiptSnapshot(r) {
  return {
    id: r.id,
    number: r.number,
    amount: r.amount,
    currency: r.currency || "MYR",
    fx_rate: r.fx_rate || "1",
    paid_date: r.paid_date,
    method: r.method,
    reference: r.reference,
    client: { id: r.client_id, name: r.client?.name || "", email: r.client?.email || "" },
    allocations: (r.allocations || []).filter((a) => !a.reversed).map((a) => ({ invoice_id: a.invoice_id, amount: a.applied ?? a.amount })),
    allocated: r.allocated,
    refunded: r.refunded,
    available: r.available,
    voided: !!r.voided,
  };
}
function clientSnapshot(c) {
  return {
    id: c.id,
    name: c.name,
    email: c.email || "",
    phone: c.phone || "",
    contact: c.contact || "",
    address: c.address || "",
    tin: c.tin || "",
    brn: c.brn || "",
    sst_number: c.sst_number || "",
    terms: c.terms,
    archived: !!c.archived,
    created: c.created,
  };
}
// Which webhook events one audit entry stands for. Imports never send events.
export function eventsFromAudit(store, row, appUrl) {
  if (String(row.actor || "").startsWith("import:")) return [];
  const doc = () => store.document(row.entity_id);
  switch (row.action) {
    case "document.issued": {
      const d = doc();
      const type = d.kind === "invoice" ? "invoice.issued" : d.kind === "quote" ? "quotation.issued" : "document.issued";
      return [{ type, entity_id: d.id, data: documentSnapshot(d, appUrl) }];
    }
    case "quotation.accepted":
    case "quotation.accepted.offline": {
      const d = doc();
      return [{ type: "quotation.accepted", entity_id: d.id, data: documentSnapshot(d, appUrl) }];
    }
    case "document.voided": {
      const d = doc();
      return [{ type: "document.voided", entity_id: d.id, data: { ...documentSnapshot(d, appUrl), reason: row.detail || "" } }];
    }
    case "payment.allocated": {
      const d = doc();
      if (d.kind !== "invoice" || d.state !== "issued" || d.balance > 0 || d.paid <= 0) return [];
      return [{ type: "invoice.paid", entity_id: d.id, data: documentSnapshot(d, appUrl), once: true }];
    }
    case "receipt.received":
      return [{ type: "payment.received", entity_id: row.entity_id, data: receiptSnapshot(store.receipt(row.entity_id)) }];
    case "receipt.voided":
      return [{ type: "receipt.voided", entity_id: row.entity_id, data: { ...receiptSnapshot(store.receipt(row.entity_id)), reason: row.detail || "" } }];
    case "invoice.credit.issued":
    case "invoice.debit.issued": {
      const number = JSON.parse(row.after_data || "{}").adjustment;
      const a = store.db.prepare("SELECT * FROM adjustments WHERE number=?").get(number);
      if (!a) return [];
      const d = doc();
      return [
        {
          type: a.kind === "credit" ? "credit_note.issued" : "debit_note.issued",
          entity_id: a.id,
          data: { id: a.id, number: a.number, kind: a.kind, amount: a.amount, currency: d.currency || "MYR", reason: a.reason, issue_date: a.issue_date, invoice: { id: d.id, number: d.number, adjusted_total: d.adjusted_total, balance: d.balance } },
        },
      ];
    }
    case "client.changed": {
      const c = store.db.prepare("SELECT * FROM clients WHERE id=?").get(row.entity_id);
      if (!c) return [];
      return [{ type: row.before_data ? "client.updated" : "client.created", entity_id: c.id, data: clientSnapshot(c) }];
    }
    default:
      return [];
  }
}

// ---------- the service ----------
const clip = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, n);
const newSecret = () => "whsec_" + randomBytes(32).toString("base64url");
const publicRow = (w) => ({
  id: w.id,
  url: w.url,
  description: w.description,
  events: JSON.parse(w.events),
  active: !!w.active,
  consecutive_failures: w.consecutive_failures,
  failing_since: w.failing_since,
  last_success: w.last_success,
  last_failure: w.last_failure,
  disabled_reason: w.disabled_reason,
  disabled_at: w.disabled_at,
  created: w.created,
  updated: w.updated,
});
export class Webhooks {
  constructor(store, { appUrl = "http://localhost:3000", lookup = dnsLookup, send = httpsSend, clock = () => Date.now() } = {}) {
    this.store = store;
    this.appUrl = appUrl;
    this.lookup = lookup;
    this.send = send;
    this.clock = clock;
  }
  get db() {
    return this.store.db;
  }
  // Starts the event cursor so history is never replayed to a new endpoint.
  ensureCursor() {
    this.store.auditSince(CONSUMER, 0);
  }
  list() {
    return this.db.prepare("SELECT * FROM platform_webhooks ORDER BY created").all().map(publicRow);
  }
  row(id) {
    const w = this.db.prepare("SELECT * FROM platform_webhooks WHERE id=?").get(id);
    check(w, "Webhook not found.", 404);
    return w;
  }
  get(id) {
    return publicRow(this.row(id));
  }
  validate(b, partial = false) {
    const out = {};
    if (!partial || b.url !== undefined) out.url = checkUrl(b.url).href;
    if (!partial || b.description !== undefined) out.description = text(b.description ?? "", 120);
    if (!partial || b.events !== undefined) {
      check(Array.isArray(b.events) && b.events.length > 0, "Choose at least one event.");
      check(b.events.every((e) => TYPES.has(e)), "Unknown event type.");
      out.events = JSON.stringify([...new Set(b.events)].sort());
    }
    return out;
  }
  // Returns the endpoint and its signing secret; the secret is never shown again.
  async create(b) {
    const v = this.validate(b);
    await resolveDestination(v.url, this.lookup);
    return this.store.tx(() => {
      check(this.db.prepare("SELECT count(*) n FROM platform_webhooks").get().n < MAX_WEBHOOKS, `Up to ${MAX_WEBHOOKS} webhook endpoints.`, 409);
      this.ensureCursor();
      // With no other active endpoint, nothing earlier is waiting to be sent: start from now.
      if (!this.db.prepare("SELECT 1 FROM platform_webhooks WHERE active=1").get())
        this.store.ackAudit(CONSUMER, this.db.prepare("SELECT COALESCE(max(id),0) n FROM audit").get().n);
      const secret = newSecret(),
        id = randomUUID(),
        t = now();
      this.db
        .prepare("INSERT INTO platform_webhooks(id,url,description,events,secret,active,created,updated) VALUES(?,?,?,?,?,1,?,?)")
        .run(id, v.url, v.description, v.events, encrypt(secret, this.store.mfaKey).toString("base64"), t, t);
      this.store.audit("webhook.created", id, v.url, null, { url: v.url, events: JSON.parse(v.events) });
      return { webhook: this.get(id), secret };
    });
  }
  async update(id, b) {
    const before = this.get(id);
    const v = this.validate(b, true);
    if (v.url && v.url !== before.url) await resolveDestination(v.url, this.lookup);
    return this.store.tx(() => {
      const fields = { ...v };
      if (b.active !== undefined) {
        check(typeof b.active === "boolean", "Choose on or off.");
        fields.active = b.active ? 1 : 0;
        if (b.active && !before.active) Object.assign(fields, { consecutive_failures: 0, failing_since: null, disabled_reason: null, disabled_at: null });
        if (!b.active && before.active) Object.assign(fields, { disabled_reason: "Turned off by the owner.", disabled_at: now() });
      }
      const keys = Object.keys(fields);
      if (!keys.length) return before;
      this.db
        .prepare(`UPDATE platform_webhooks SET ${keys.map((k) => `${k}=?`).join(",")},updated=? WHERE id=?`)
        .run(...keys.map((k) => fields[k]), now(), id);
      if (fields.active === 0) this.cancelPending(id);
      const after = this.get(id);
      this.store.audit("webhook.updated", id, after.url, before, after);
      return after;
    });
  }
  rotate(id) {
    this.row(id);
    const secret = newSecret();
    this.db.prepare("UPDATE platform_webhooks SET secret=?,updated=? WHERE id=?").run(encrypt(secret, this.store.mfaKey).toString("base64"), now(), id);
    this.store.audit("webhook.secret.rotated", id);
    return { webhook: this.get(id), secret };
  }
  remove(id) {
    const before = this.get(id);
    this.store.tx(() => {
      this.db.prepare("DELETE FROM platform_webhook_attempts WHERE delivery_id IN (SELECT id FROM platform_webhook_deliveries WHERE webhook_id=?)").run(id);
      this.db.prepare("DELETE FROM platform_webhook_deliveries WHERE webhook_id=?").run(id);
      this.db.prepare("DELETE FROM platform_webhooks WHERE id=?").run(id);
      this.store.audit("webhook.deleted", id, before.url, before, null);
    });
  }
  cancelPending(id) {
    this.db.prepare("UPDATE platform_webhook_deliveries SET state='cancelled',last_error=COALESCE(last_error,'Endpoint turned off') WHERE webhook_id=? AND state IN ('pending','delivering')").run(id);
  }
  // Turns audit entries into stored events and queued deliveries, then moves the cursor.
  collect(limit = 200) {
    return this.store.tx(() => {
      const rows = this.store.auditSince(CONSUMER, limit);
      if (!rows.length) return 0;
      const subs = this.db.prepare("SELECT id,events FROM platform_webhooks WHERE active=1").all().map((s) => ({ id: s.id, events: new Set(JSON.parse(s.events)) }));
      let queued = 0;
      const t = this.clock();
      for (const row of rows) {
        if (!subs.length) break;
        let events = [];
        try {
          events = eventsFromAudit(this.store, row, this.appUrl);
        } catch {
          events = []; // The record is gone (e.g. a deleted draft): nothing to send.
        }
        for (const e of events) {
          const targets = subs.filter((s) => s.events.has(e.type));
          if (!targets.length) continue;
          if (e.once && this.db.prepare("SELECT 1 FROM platform_webhook_events WHERE type=? AND entity_id=?").get(e.type, e.entity_id)) continue;
          if (this.db.prepare("SELECT 1 FROM platform_webhook_events WHERE audit_id=? AND type=?").get(row.id, e.type)) continue;
          const id = "evt_" + randomUUID().replace(/-/g, "");
          const payload = JSON.stringify({ id, type: e.type, created: row.created, data: e.data });
          this.db
            .prepare("INSERT INTO platform_webhook_events(id,type,audit_id,entity_id,payload,created) VALUES(?,?,?,?,?,?)")
            .run(id, e.type, row.id, e.entity_id, payload, now());
          for (const s of targets) {
            this.db
              .prepare("INSERT INTO platform_webhook_deliveries(id,webhook_id,event_id,state,next_attempt,deadline,created) VALUES(?,?,?,'pending',?,?,?)")
              .run(randomUUID(), s.id, id, t, t + RETRY_WINDOW, now());
            queued++;
          }
        }
      }
      this.store.ackAudit(CONSUMER, rows.at(-1).id);
      return queued;
    });
  }
  // Sends every delivery that is due, five at a time, within a time budget.
  async deliverDue({ limit = 50, budget = 60000 } = {}) {
    const started = this.clock();
    this.db.prepare("UPDATE platform_webhook_deliveries SET state='pending' WHERE state='delivering' AND last_attempt_at<?").run(started - 120000);
    const due = this.db
      .prepare("SELECT d.id FROM platform_webhook_deliveries d WHERE d.state='pending' AND d.next_attempt<=? ORDER BY d.next_attempt,d.rowid LIMIT ?")
      .all(started, limit)
      .map((r) => r.id);
    const result = { delivered: 0, retrying: 0, failed: 0, cancelled: 0 };
    for (let i = 0; i < due.length; i += 5) {
      if (this.clock() - started > budget) break;
      const outcomes = await Promise.all(due.slice(i, i + 5).map((id) => this.attempt(id)));
      for (const o of outcomes) if (o) result[o.state === "delivered" ? "delivered" : o.state === "pending" ? "retrying" : o.state] += 1;
    }
    return result;
  }
  // One delivery attempt. Returns the delivery's new state.
  async attempt(deliveryId) {
    const d = this.db
      .prepare("SELECT d.*,w.url,w.secret,w.active FROM platform_webhook_deliveries d JOIN platform_webhooks w ON w.id=d.webhook_id WHERE d.id=?")
      .get(deliveryId);
    if (!d || !["pending"].includes(d.state)) return null;
    if (!d.active && !d.test) {
      this.db.prepare("UPDATE platform_webhook_deliveries SET state='cancelled',last_error='Endpoint turned off' WHERE id=?").run(d.id);
      return { state: "cancelled" };
    }
    const start = this.clock();
    const attempt = d.attempts + 1;
    const claimed = this.db
      .prepare("UPDATE platform_webhook_deliveries SET state='delivering',attempts=?,last_attempt_at=? WHERE id=? AND state='pending'")
      .run(attempt, start, d.id);
    if (!claimed.changes) return null;
    const body = this.db.prepare("SELECT payload FROM platform_webhook_events WHERE id=?").get(d.event_id)?.payload;
    let status = null,
      error = null,
      response = "";
    try {
      check(body, "Event no longer stored.");
      let secret;
      try {
        secret = decrypt(Buffer.from(d.secret, "base64"), this.store.mfaKey).toString();
      } catch {
        throw new AppError("The signing secret cannot be read on this server. Rotate the secret.");
      }
      const dest = await resolveDestination(d.url, this.lookup);
      const timestamp = Math.floor(this.clock() / 1000);
      const type = JSON.parse(body).type;
      const res = await this.send({
        url: dest.url,
        address: dest.address,
        family: dest.family,
        body,
        timeout: TIMEOUT,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "Nawlogic-Event": type,
          "Nawlogic-Event-Id": d.event_id,
          "Nawlogic-Delivery": d.id,
          "Nawlogic-Signature": signatureHeader(secret, timestamp, body),
        },
      });
      status = Number(res?.status) || null;
      response = clip(res?.body, 500);
      if (!(status >= 200 && status < 300)) error = status ? `HTTP ${status}` : "No response status";
    } catch (e) {
      error = clip(e instanceof AppError ? e.message : e?.code === "CERT_HAS_EXPIRED" || /certificate/i.test(e?.message || "") ? "TLS certificate problem: " + (e.code || e.message) : e?.message || "Request failed", 300);
    }
    const t = this.clock();
    const stamp = new Date(t).toISOString();
    return this.store.tx(() => {
      this.db
        .prepare("INSERT INTO platform_webhook_attempts(delivery_id,attempt,status,error,duration_ms,response,created) VALUES(?,?,?,?,?,?,?)")
        .run(d.id, attempt, status, error, Math.max(0, t - start), response, now());
      if (!error) {
        this.db.prepare("UPDATE platform_webhook_deliveries SET state='delivered',last_status=?,last_error=NULL,delivered_at=? WHERE id=?").run(status, stamp, d.id);
        if (!d.test) this.db.prepare("UPDATE platform_webhooks SET consecutive_failures=0,failing_since=NULL,last_success=? WHERE id=?").run(stamp, d.webhook_id);
        return { state: "delivered", status, attempt };
      }
      // Test events are tried once; real events are retried with backoff until the deadline.
      const gap = Math.min(FIRST_RETRY * 2 ** (attempt - 1), MAX_RETRY_GAP);
      const next = Math.min(t + gap, d.deadline);
      const retry = !d.test && t < d.deadline && status !== 410;
      this.db
        .prepare("UPDATE platform_webhook_deliveries SET state=?,last_status=?,last_error=?,next_attempt=? WHERE id=?")
        .run(retry ? "pending" : "failed", status, error, retry ? next : d.next_attempt, d.id);
      if (!d.test) {
        const w = this.db.prepare("SELECT * FROM platform_webhooks WHERE id=?").get(d.webhook_id);
        const since = w.failing_since || stamp;
        const failures = w.consecutive_failures + 1;
        this.db.prepare("UPDATE platform_webhooks SET consecutive_failures=?,failing_since=?,last_failure=? WHERE id=?").run(failures, since, stamp, w.id);
        const gone = status === 410;
        if (w.active && (gone || (failures >= DISABLE_MIN_FAILURES && t - Date.parse(since) >= DISABLE_AFTER))) {
          const reason = gone ? "The endpoint answered 410 Gone." : `Failed for 24 hours (${failures} attempts in a row). Last error: ${error}.`;
          this.db.prepare("UPDATE platform_webhooks SET active=0,disabled_reason=?,disabled_at=?,updated=? WHERE id=?").run(reason, stamp, stamp, w.id);
          this.cancelPending(w.id);
          this.store.audit("webhook.disabled", w.id, reason, { active: 1 }, { active: 0 });
        }
      }
      return { state: retry ? "pending" : "failed", status, error, attempt, next_attempt: retry ? next : null };
    });
  }
  // Sends a test event now, whatever events the endpoint subscribes to.
  async sendTest(id) {
    const w = this.get(id);
    const eventId = "evt_" + randomUUID().replace(/-/g, "");
    const deliveryId = randomUUID();
    const t = this.clock();
    this.store.tx(() => {
      const payload = JSON.stringify({
        id: eventId,
        type: "webhook.test",
        created: now(),
        test: true,
        data: { message: "Test event from Nawlogic Invoice. No business record changed.", webhook_id: w.id },
      });
      this.db.prepare("INSERT INTO platform_webhook_events(id,type,audit_id,entity_id,payload,created) VALUES(?,?,NULL,?,?,?)").run(eventId, "webhook.test", w.id, payload, now());
      this.db
        .prepare("INSERT INTO platform_webhook_deliveries(id,webhook_id,event_id,state,next_attempt,deadline,test,created) VALUES(?,?,?,'pending',?,?,1,?)")
        .run(deliveryId, w.id, eventId, t, t, now());
      this.store.audit("webhook.test.sent", w.id, w.url);
    });
    return { delivery_id: deliveryId, ...(await this.attempt(deliveryId)) };
  }
  // Puts a failed or cancelled delivery back in the queue with a fresh 24-hour window.
  retry(deliveryId) {
    const d = this.db.prepare("SELECT d.*,w.active FROM platform_webhook_deliveries d JOIN platform_webhooks w ON w.id=d.webhook_id WHERE d.id=?").get(deliveryId);
    check(d, "Delivery not found.", 404);
    check(["failed", "cancelled"].includes(d.state), "Only failed or cancelled deliveries can be sent again.", 409);
    check(d.active, "Turn the endpoint on first.", 409);
    check(!d.test, "Send a new test event instead.", 409);
    const t = this.clock();
    this.db.prepare("UPDATE platform_webhook_deliveries SET state='pending',next_attempt=?,deadline=? WHERE id=?").run(t, t + RETRY_WINDOW, deliveryId);
    this.store.audit("webhook.delivery.retried", d.webhook_id, deliveryId);
    return this.delivery(deliveryId);
  }
  delivery(id) {
    const d = this.db
      .prepare("SELECT d.id,d.webhook_id,d.event_id,e.type,d.state,d.attempts,d.next_attempt,d.deadline,d.last_status,d.last_error,d.delivered_at,d.test,d.created FROM platform_webhook_deliveries d JOIN platform_webhook_events e ON e.id=d.event_id WHERE d.id=?")
      .get(id);
    check(d, "Delivery not found.", 404);
    return {
      ...d,
      test: !!d.test,
      next_attempt: d.state === "pending" ? new Date(d.next_attempt).toISOString() : null,
      attempts_log: this.db.prepare("SELECT attempt,status,error,duration_ms,response,created FROM platform_webhook_attempts WHERE delivery_id=? ORDER BY id").all(id),
    };
  }
  deliveries({ webhookId = null, limit = 30 } = {}) {
    return this.db
      .prepare(
        `SELECT d.id,d.webhook_id,d.event_id,e.type,d.state,d.attempts,d.next_attempt,d.last_status,d.last_error,d.delivered_at,d.test,d.created FROM platform_webhook_deliveries d JOIN platform_webhook_events e ON e.id=d.event_id ${webhookId ? "WHERE d.webhook_id=?" : ""} ORDER BY d.created DESC,d.rowid DESC LIMIT ?`,
      )
      .all(...(webhookId ? [webhookId, limit] : [limit]))
      .map((d) => ({ ...d, test: !!d.test, next_attempt: d.state === "pending" ? new Date(d.next_attempt).toISOString() : null }));
  }
  event(id) {
    const e = this.db.prepare("SELECT payload FROM platform_webhook_events WHERE id=?").get(id);
    check(e, "Event not found.", 404);
    return JSON.parse(e.payload);
  }
  // Keeps 30 days of finished deliveries and their events.
  prune(days = 30) {
    const before = new Date(this.clock() - days * 86400000).toISOString();
    this.store.tx(() => {
      this.db
        .prepare("DELETE FROM platform_webhook_attempts WHERE delivery_id IN (SELECT id FROM platform_webhook_deliveries WHERE created<? AND state IN ('delivered','failed','cancelled'))")
        .run(before);
      this.db.prepare("DELETE FROM platform_webhook_deliveries WHERE created<? AND state IN ('delivered','failed','cancelled')").run(before);
      this.db.prepare("DELETE FROM platform_webhook_events WHERE created<? AND id NOT IN (SELECT event_id FROM platform_webhook_deliveries)").run(before);
    });
  }
}

export const WEBHOOK_MIGRATION = `CREATE TABLE platform_webhooks(
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  events TEXT NOT NULL,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  failing_since TEXT,
  last_success TEXT,
  last_failure TEXT,
  disabled_reason TEXT,
  disabled_at TEXT,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE TABLE platform_webhook_events(
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  audit_id INTEGER,
  entity_id TEXT,
  payload TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE UNIQUE INDEX platform_event_audit ON platform_webhook_events(audit_id,type) WHERE audit_id IS NOT NULL;
CREATE INDEX platform_event_entity ON platform_webhook_events(type,entity_id);
CREATE TABLE platform_webhook_deliveries(
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES platform_webhooks(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES platform_webhook_events(id),
  state TEXT NOT NULL CHECK(state IN ('pending','delivering','delivered','failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL,
  deadline INTEGER NOT NULL,
  last_attempt_at INTEGER,
  last_status INTEGER,
  last_error TEXT,
  delivered_at TEXT,
  test INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  UNIQUE(webhook_id,event_id)
);
CREATE INDEX platform_delivery_due ON platform_webhook_deliveries(state,next_attempt);
CREATE TABLE platform_webhook_attempts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL REFERENCES platform_webhook_deliveries(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  status INTEGER,
  error TEXT,
  duration_ms INTEGER NOT NULL,
  response TEXT,
  created TEXT NOT NULL
);
CREATE INDEX platform_attempt_delivery ON platform_webhook_attempts(delivery_id);`;
