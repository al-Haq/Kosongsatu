// Owner notifications. A job reads new audit entries (its own cursor), turns the
// interesting ones into notifications (one per audit entry, enforced by a unique
// key) and optionally emails or WhatsApps the owner once.
import { id, now } from "./domain.mjs";
import { formatMoney } from "./comms-templates.mjs";
import { templateComponents } from "./comms-whatsapp.mjs";
export const NOTIFY_TYPES = {
  payment_received: { label: "Payment received", hint: "Receipts from online payments, connectors or automations. Payments you record yourself are not notified.", inapp: true },
  online_payment: { label: "Online payment paid", hint: "A client paid online (FPX, card, DuitNow).", inapp: true },
  quote_accepted: { label: "Quotation accepted", hint: "A client accepted a quotation from their link.", inapp: true },
  payment_reference: { label: "Payment reference or slip submitted", hint: "A client says they paid. Check your bank before recording it.", inapp: true },
  document_viewed: { label: "Document opened", hint: "A client opened a document link for the first time.", inapp: false },
  email_bounced: { label: "Email bounced or marked as spam", hint: "Needs a bounce webhook from your mail provider.", inapp: true },
  einvoice_rejected: { label: "e-Invoice rejected", hint: "MyInvois rejected or invalidated an e-Invoice.", inapp: true },
};
export function classify(row) {
  const a = row.action;
  if (a === "receipt.received") return String(row.actor || "").startsWith("owner:") ? null : "payment_received";
  if (a === "online_payment.paid") return "online_payment";
  if (a === "quotation.accepted") return "quote_accepted";
  if (/^payment\.(reference|slip|proof)\.(submitted|uploaded)$/.test(a)) return "payment_reference";
  if (a === "document.viewed") return "document_viewed";
  if (a === "email.bounced" || a === "email.complained") return "email_bounced";
  if (/^(e-?invoice|myinvois)\.([\w-]+\.)?(rejected|invalid|invalidated)$/.test(a)) return "einvoice_rejected";
  return null;
}
const json = (v) => {
  try {
    return v ? JSON.parse(v) : {};
  } catch {
    return {};
  }
};
const docSafe = (store, did) => {
  try {
    return did ? store.document(did) : null;
  } catch {
    return null;
  }
};
// Title, body and in-app route for one audit entry, or null to skip it.
export function describe(store, row, type, batch = []) {
  if (type === "payment_received") {
    const r = store.receipt(row.entity_id);
    // Online payments are announced by their own event, not twice.
    const online =
      store.db.prepare("SELECT 1 FROM online_payments WHERE receipt_id=?").get(r.id) ||
      batch.some((b) => b.action === "online_payment.paid" && json(b.after_data).receipt_id === r.id);
    if (online) return null;
    const invoice = r.allocations.find((a) => a.applied > 0)?.invoice_id;
    return {
      title: `Payment received: ${formatMoney(r.amount)}`,
      body: [r.client.name, r.number, r.reference].filter(Boolean).join(" · "),
      entity_id: r.id,
      route: invoice ? `document/${invoice}` : "ledger",
    };
  }
  if (type === "email_bounced") {
    const after = json(row.after_data);
    const log = after.email_id ? store.db.prepare("SELECT kind,document_id,client_id FROM email_log WHERE id=?").get(after.email_id) : null;
    const target = log?.document_id ? `document/${log.document_id}` : log?.client_id ? `client/${log.client_id}` : "settings";
    return {
      title: `Email to ${after.email || "a client"} ${after.type === "complaint" ? "was marked as spam" : "bounced"}`,
      body: String(row.detail || "").slice(0, 300),
      entity_id: row.entity_id,
      route: target,
      // Never email about a bounced notification email (that could loop).
      noEmail: ["notification", "test"].includes(log?.kind),
    };
  }
  const d = docSafe(store, row.entity_id);
  if (type === "einvoice_rejected")
    return {
      title: d ? `e-Invoice rejected: ${d.number}` : "e-Invoice rejected",
      body: String(row.detail || "").slice(0, 300),
      entity_id: row.entity_id,
      route: d ? `document/${d.id}` : "settings",
    };
  if (!d) return null;
  const route = `document/${d.id}`;
  if (type === "online_payment") {
    const sen = Number(String(row.detail || "").match(/(\d+) sen/)?.[1] || 0);
    return {
      title: `Online payment received: ${formatMoney(sen || d.paid, d.currency)}`,
      body: `${d.number} · ${d.client.name}`,
      entity_id: d.id,
      route,
    };
  }
  if (type === "quote_accepted")
    return {
      title: `Quotation ${d.number} accepted`,
      body: `Accepted by ${String(row.detail || "the client").slice(0, 120)} · ${d.client.name} · ${formatMoney(d.total, d.currency)}`,
      entity_id: d.id,
      route,
    };
  if (type === "payment_reference")
    return {
      title: `Payment reference submitted for ${d.number}`,
      body: `${d.client.name} · balance ${formatMoney(d.balance, d.currency)}. Check your bank before recording the payment.`,
      entity_id: d.id,
      route,
    };
  if (type === "document_viewed")
    return { title: `${d.client.name} opened ${d.number}`, body: "First time the client link was opened.", entity_id: d.id, route };
  return null;
}
// Reads new audit entries and stores notifications. Returns how many were created.
export function collectNotifications(store, settings) {
  const rows = store.auditSince("comms-notifications", 200);
  if (!rows.length) return 0;
  let created = 0;
  store.tx(() => {
    for (const row of rows) {
      const type = classify(row);
      if (!type) continue;
      const pref = settings.notify[type] || {};
      if (!pref.inapp && !pref.email && !pref.whatsapp) continue;
      let n = null;
      try {
        n = describe(store, row, type, rows);
      } catch {
        n = null;
      }
      if (!n) continue;
      const res = store.db
        .prepare(
          "INSERT OR IGNORE INTO comms_notifications(id,audit_id,type,title,body,entity_id,route,inapp,email_state,wa_state,created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id(),
          row.id,
          type,
          n.title.slice(0, 200),
          n.body.slice(0, 600),
          n.entity_id || null,
          n.route || null,
          pref.inapp ? 1 : 0,
          pref.email && !n.noEmail ? "pending" : "none",
          pref.whatsapp ? "pending" : "none",
          now(),
        );
      created += res.changes;
    }
    store.ackAudit("comms-notifications", rows.at(-1).id);
  });
  return created;
}
// Sends the pending owner emails and WhatsApp messages, each at most once:
// a notification is claimed ("sending") before it goes out and never retried.
export async function deliverNotifications({ store, mailer, whatsapp, appUrl, settings, ownerEmail }) {
  const pending = store.db
    .prepare("SELECT * FROM comms_notifications WHERE email_state='pending' OR wa_state='pending' ORDER BY created LIMIT 25")
    .all();
  let sent = 0;
  for (const n of pending) {
    const link = n.route ? `${appUrl}/#/${n.route}` : appUrl;
    if (n.email_state === "pending" && store.db.prepare("UPDATE comms_notifications SET email_state='sending' WHERE id=? AND email_state='pending'").run(n.id).changes) {
      let state = "skipped";
      if (ownerEmail && mailer.status().configured)
        try {
          await mailer.deliver({
            kind: "notification",
            to: [ownerEmail],
            subject: n.title,
            body: `${n.title}\n\n${n.body}\n\nOpen in Nawlogic: ${link}`,
            button: { label: "Open in Nawlogic", url: link },
            track: false,
            dedupeKey: `notify:${n.audit_id}:email`,
          });
          state = "sent";
          sent++;
        } catch {
          state = "failed";
        }
      store.db.prepare("UPDATE comms_notifications SET email_state=? WHERE id=?").run(state, n.id);
    }
    if (n.wa_state === "pending" && store.db.prepare("UPDATE comms_notifications SET wa_state='sending' WHERE id=? AND wa_state='pending'").run(n.id).changes) {
      let state = "skipped";
      const mapping = settings.whatsapp.templates.owner_alert;
      if (settings.ownerWhatsApp && mapping && whatsapp.status().configured)
        try {
          await whatsapp.send({
            to: settings.ownerWhatsApp,
            kind: "notification",
            template: mapping.name,
            language: mapping.language,
            components: templateComponents(mapping, { title: n.title, summary: n.body, link }),
            summary: n.title,
            dedupeKey: `notify:${n.audit_id}:wa`,
          });
          state = "sent";
          sent++;
        } catch {
          state = "failed";
        }
      store.db.prepare("UPDATE comms_notifications SET wa_state=? WHERE id=?").run(state, n.id);
    }
  }
  return sent;
}
