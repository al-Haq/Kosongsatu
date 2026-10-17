// Bounce and complaint reports from mail providers, normalised to one shape:
// { provider, type: "hard" | "soft" | "complaint" | "delivered", email, detail,
//   logId, messageId, providerId }.
// Supported: a documented generic JSON format, Amazon SES (through SNS), Postmark,
// Mailgun and SendGrid. Matching uses the X-Kosongsatu-Id / provider metadata,
// then the Message-ID, then the provider's own message ID.
import { now, id, check } from "./domain.mjs";
const clip = (v, n = 300) =>
  String(v ?? "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .trim()
    .slice(0, n);
const address = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  return /^[^\s@<>"]+@[^\s@<>"]+$/.test(s) && s.length <= 160 ? s : "";
};
const idText = (v) => {
  const s = String(v ?? "").trim().replace(/^<|>$/g, "");
  return s && s.length <= 300 ? s : null;
};
const metaId = (obj) => {
  if (!obj || typeof obj !== "object") return null;
  for (const [k, v] of Object.entries(obj))
    if (/^kosongsatu[-_]?id$/i.test(k) && typeof v === "string") return idText(v);
  return null;
};
function generic(e) {
  const kind = String(e.type || e.event || "").toLowerCase();
  const type =
    kind === "complaint" || kind === "spam"
      ? "complaint"
      : kind === "bounce" || kind === "bounced"
        ? e.permanent === false || e.soft === true
          ? "soft"
          : "hard"
        : kind === "soft_bounce"
          ? "soft"
          : kind === "delivered"
            ? "delivered"
            : null;
  if (!type) return [];
  return [
    {
      provider: "generic",
      type,
      email: address(e.email || e.recipient),
      detail: clip(e.reason || e.detail || e.description),
      logId: idText(e.kosongsatu_id),
      messageId: idText(e.message_id),
      providerId: idText(e.provider_id),
    },
  ];
}
function ses(message) {
  const type = message.notificationType || message.eventType;
  const mail = message.mail || {};
  const headers = Array.isArray(mail.headers) ? mail.headers : [];
  const logId = idText(headers.find((h) => /^x-kosongsatu-id$/i.test(h?.name || ""))?.value);
  const base = {
    provider: "ses",
    logId,
    messageId: idText(mail.commonHeaders?.messageId),
    providerId: idText(mail.messageId),
  };
  if (type === "Bounce") {
    const b = message.bounce || {};
    const kind = b.bounceType === "Permanent" ? "hard" : "soft";
    return (b.bouncedRecipients || []).map((r) => ({
      ...base,
      type: kind,
      email: address(r.emailAddress),
      detail: clip(r.diagnosticCode || `${b.bounceType || ""} ${b.bounceSubType || ""}`),
    }));
  }
  if (type === "Complaint") {
    const c = message.complaint || {};
    return (c.complainedRecipients || []).map((r) => ({
      ...base,
      type: "complaint",
      email: address(r.emailAddress),
      detail: clip(c.complaintFeedbackType ? `Marked as spam (${c.complaintFeedbackType})` : "Marked as spam"),
    }));
  }
  if (type === "Delivery")
    return (message.delivery?.recipients || []).map((r) => ({ ...base, type: "delivered", email: address(r), detail: "" }));
  return [];
}
const POSTMARK_HARD = ["HardBounce", "BadEmailAddress", "ManuallyDeactivated"];
function postmark(e) {
  const base = {
    provider: "postmark",
    email: address(e.Email || e.Recipient),
    logId: metaId(e.Metadata),
    messageId: null,
    providerId: idText(e.MessageID),
  };
  if (e.RecordType === "Bounce") {
    if (e.Type === "AutoResponder") return [];
    return [
      {
        ...base,
        type: POSTMARK_HARD.includes(e.Type) || e.Inactive === true ? "hard" : "soft",
        detail: clip([e.Description, e.Details].filter(Boolean).join(" ")),
      },
    ];
  }
  if (e.RecordType === "SpamComplaint") return [{ ...base, type: "complaint", detail: "Marked as spam" }];
  if (e.RecordType === "Delivery") return [{ ...base, type: "delivered", detail: "" }];
  return [];
}
function mailgun(data) {
  const ev = data["event-data"] || {};
  const status = ev["delivery-status"] || {};
  const base = {
    provider: "mailgun",
    email: address(ev.recipient),
    logId: metaId(ev["user-variables"]),
    messageId: idText(ev.message?.headers?.["message-id"]),
    providerId: null,
  };
  if (ev.event === "failed")
    return [
      {
        ...base,
        type: ev.severity === "permanent" ? "hard" : "soft",
        detail: clip(status.description || status.message || ev.reason),
      },
    ];
  if (ev.event === "complained") return [{ ...base, type: "complaint", detail: "Marked as spam" }];
  if (ev.event === "delivered") return [{ ...base, type: "delivered", detail: "" }];
  return [];
}
function sendgrid(e) {
  const base = {
    provider: "sendgrid",
    email: address(e.email),
    logId: idText(e.kosongsatu_id),
    messageId: idText(e["smtp-id"]),
    providerId: idText(String(e.sg_message_id || "").split(".")[0]),
  };
  if (e.event === "bounce")
    return [{ ...base, type: e.type === "blocked" ? "soft" : "hard", detail: clip(e.reason || e.status) }];
  if (e.event === "dropped") return [{ ...base, type: "hard", detail: clip(e.reason || "Dropped") }];
  if (e.event === "spamreport") return [{ ...base, type: "complaint", detail: "Marked as spam" }];
  if (e.event === "delivered") return [{ ...base, type: "delivered", detail: "" }];
  return [];
}
// Reads one webhook body. Returns { events, confirm } where confirm is an Amazon
// SNS subscription that the owner must open once.
export function parseMailEvents(payload) {
  check(payload && typeof payload === "object", "Unrecognised event format.");
  if (payload.Type === "SubscriptionConfirmation" && typeof payload.SubscribeURL === "string") {
    const url = payload.SubscribeURL;
    check(
      /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\/\?/.test(url) && url.length < 2000,
      "Unexpected subscription address.",
    );
    return { events: [], confirm: { url, topic: clip(payload.TopicArn, 300) } };
  }
  if (payload.Type === "Notification" && typeof payload.Message === "string") {
    let inner;
    try {
      inner = JSON.parse(payload.Message);
    } catch {
      check(false, "Unrecognised event format.");
    }
    return { events: ses(inner || {}), confirm: null };
  }
  if (payload.notificationType || payload.eventType) return { events: ses(payload), confirm: null };
  if (payload.RecordType) return { events: postmark(payload), confirm: null };
  if (payload["event-data"]) return { events: mailgun(payload), confirm: null };
  const list = Array.isArray(payload) ? payload : Array.isArray(payload.events) ? payload.events : [payload];
  check(list.length <= 500, "Too many events in one request.");
  const events = list.flatMap((e) =>
    e && typeof e === "object" ? (e.sg_message_id || e["smtp-id"] ? sendgrid(e) : generic(e)) : [],
  );
  return { events, confirm: null };
}
const RANK = { soft: 1, hard: 2, complaint: 3 };
// Finds the sent email an event is about.
function findLog(db, e) {
  if (e.logId) {
    const row = db.prepare("SELECT * FROM email_log WHERE id=?").get(e.logId);
    if (row) return row;
  }
  if (e.messageId) {
    const row = db
      .prepare("SELECT * FROM email_log WHERE lower(trim(message_id,'<>'))=? ORDER BY created DESC LIMIT 1")
      .get(e.messageId.toLowerCase());
    if (row) return row;
  }
  if (e.providerId) {
    const row = db.prepare("SELECT * FROM email_log WHERE provider_id=? ORDER BY created DESC LIMIT 1").get(e.providerId);
    if (row) return row;
  }
  return null;
}
// Records events against the email log. Bounces and complaints mark the email and
// the address; SMTP rejections are already "failed" and are not touched.
export function applyMailEvents(store, events) {
  let matched = 0,
    ignored = 0;
  for (const e of events) {
    if (e.type === "delivered") {
      ignored++;
      continue;
    }
    const row = findLog(store.db, e);
    if (!row || row.status !== "sent") {
      ignored++;
      continue;
    }
    matched++;
    const email = e.email || row.recipients.split(",")[0].trim().toLowerCase();
    store.tx(() => {
      const current = store.db.prepare("SELECT bounce_type FROM email_log WHERE id=?").get(row.id).bounce_type;
      if (current && RANK[current] >= RANK[e.type]) return;
      store.db
        .prepare("UPDATE email_log SET bounced=COALESCE(bounced,?),bounce_type=?,bounce_detail=? WHERE id=?")
        .run(now(), e.type, e.detail || null, row.id);
      store.db
        .prepare(
          "INSERT INTO comms_address_events(id,email,type,detail,email_id,provider,created) VALUES(?,?,?,?,?,?,?)",
        )
        .run(id(), email, e.type, e.detail || "", row.id, e.provider, now());
      store.audit(
        e.type === "complaint" ? "email.complained" : "email.bounced",
        row.document_id || row.client_id,
        `${email}: ${e.type === "complaint" ? "marked as spam" : e.type + " bounce"}${e.detail ? " - " + e.detail.slice(0, 160) : ""}`,
        null,
        { email_id: row.id, type: e.type, email },
      );
    });
  }
  return { matched, ignored };
}
