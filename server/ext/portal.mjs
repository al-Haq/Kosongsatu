// Client portal: client accounts, multiple contacts, credit limits, quotation e-signatures and client feedback.
// Feature module contract: see docs/PLUGINS.md. Owner guide: docs/features/portal.md.
import { randomBytes, randomUUID } from "node:crypto";
import { today, now, currency } from "../domain.mjs";
import { attachContacts } from "../portal-contacts.mjs";
import { attachCredit, HELD_KINDS } from "../portal-credit.mjs";
import { attachAccess } from "../portal-access.mjs";
import { attachSignatures } from "../portal-sign.mjs";
import { attachFeedback, PAYMENT_EVENTS, FEEDBACK_DAYS } from "../portal-feedback.mjs";
import { guestRoutes, ownerRoutes } from "../portal-routes.mjs";

const TABLES = `
CREATE TABLE portal_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE portal_clients(
  client_id TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  portal_enabled INTEGER NOT NULL DEFAULT 0,
  credit_limit INTEGER CHECK(credit_limit IS NULL OR credit_limit>=0),
  hold_days INTEGER CHECK(hold_days IS NULL OR hold_days BETWEEN 0 AND 365),
  on_hold INTEGER NOT NULL DEFAULT 0,
  hold_reason TEXT NOT NULL DEFAULT '',
  updated TEXT NOT NULL
);
CREATE TABLE portal_contacts(
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'other' CHECK(role IN ('billing','technical','other')),
  primary_billing INTEGER NOT NULL DEFAULT 0,
  cc_invoices INTEGER NOT NULL DEFAULT 0,
  portal_access INTEGER NOT NULL DEFAULT 0,
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX portal_contacts_client ON portal_contacts(client_id);
CREATE INDEX portal_contacts_email ON portal_contacts(lower(email));
CREATE UNIQUE INDEX portal_contacts_primary ON portal_contacts(client_id) WHERE primary_billing=1;
CREATE TABLE portal_login_tokens(
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES portal_contacts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('signin','invite')),
  expires INTEGER NOT NULL,
  used_at TEXT,
  created TEXT NOT NULL
);
CREATE INDEX portal_login_tokens_contact ON portal_login_tokens(contact_id,created);
CREATE TABLE portal_links(
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  expires INTEGER NOT NULL,
  revoked_at TEXT,
  last_used TEXT,
  created TEXT NOT NULL
);
CREATE TABLE portal_sessions(
  hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  contact_id TEXT REFERENCES portal_contacts(id) ON DELETE CASCADE,
  link_id TEXT REFERENCES portal_links(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires INTEGER NOT NULL,
  created TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  CHECK((contact_id IS NULL) <> (link_id IS NULL))
);
CREATE INDEX portal_sessions_client ON portal_sessions(client_id);
CREATE TABLE portal_signatures(
  document_id TEXT PRIMARY KEY REFERENCES documents(id),
  file_id TEXT NOT NULL,
  signer_name TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('draw','type')),
  source TEXT NOT NULL CHECK(source IN ('link','portal')),
  contact_id TEXT,
  ip_hash TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  document_hash TEXT NOT NULL,
  signed_at TEXT NOT NULL
);
CREATE TRIGGER portal_signatures_no_update BEFORE UPDATE ON portal_signatures BEGIN SELECT RAISE(ABORT,'Signatures are permanent.'); END;
CREATE TRIGGER portal_signatures_no_delete BEFORE DELETE ON portal_signatures BEGIN SELECT RAISE(ABORT,'Signatures are permanent.'); END;
CREATE TABLE portal_credit_overrides(
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  total INTEGER NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  used_at TEXT,
  created TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE INDEX portal_credit_overrides_document ON portal_credit_overrides(document_id);
CREATE TABLE portal_feedback(
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL UNIQUE REFERENCES documents(id),
  client_id TEXT NOT NULL REFERENCES clients(id),
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  consent INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT '',
  testimonial INTEGER NOT NULL DEFAULT 0 CHECK(testimonial=0 OR consent=1),
  source TEXT NOT NULL CHECK(source IN ('link','portal','email')),
  created TEXT NOT NULL,
  updated TEXT NOT NULL
);
CREATE INDEX portal_feedback_client ON portal_feedback(client_id);
CREATE TABLE portal_feedback_requests(
  invoice_id TEXT PRIMARY KEY REFERENCES documents(id),
  token_hash TEXT UNIQUE,
  expires INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sending','sent','failed')),
  error TEXT,
  created TEXT NOT NULL
);`;

const label = (v) =>
  new Date(v + "T00:00:00Z").toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// Sends one feedback request email per newly paid invoice (opt-in in Settings).
async function feedbackRequests(ctx) {
  const { store, mailer, appUrl } = ctx;
  const events = store.auditSince("portal:feedback", 200);
  let sent = 0,
    failed = 0;
  const settings = store.portalSettings();
  if (settings.feedback_emails && mailer.status().configured) {
    const ids = [...new Set(events.filter((e) => PAYMENT_EVENTS.includes(e.action) && e.entity_id).map((e) => e.entity_id))];
    for (const invoiceId of ids) {
      const req = store.feedbackRequest(invoiceId);
      if (!req) continue;
      const { invoice: d, client, token } = req;
      try {
        const r = await mailer.deliver({
          kind: "feedback",
          documentId: d.id,
          clientId: client.id,
          to: [client.email],
          subject: `Thank you for your payment: ${d.number}`,
          body: [
            `Dear ${client.contact || client.name},`,
            "",
            `Thank you. We have received full payment for invoice ${d.number} (${currency(d.adjusted_total ?? d.total)}).`,
            "",
            "Could you tell us how the work went? It takes one minute: a rating from 1 to 5 and an optional comment.",
            `${appUrl}/portal/feedback/${token}`,
            "",
            `The link works until ${label(new Date(Date.now() + FEEDBACK_DAYS * 86400000).toISOString().slice(0, 10))}.`,
            "",
            d.business.company,
          ].join("\n"),
          dedupeKey: "portal-feedback:" + d.id,
        });
        store.markFeedbackRequest(d.id, "sent");
        if (r) sent++;
      } catch {
        store.markFeedbackRequest(d.id, "failed", "The mail server did not accept the message.");
        failed++;
      }
    }
  }
  if (events.length) store.ackAudit("portal:feedback", events.at(-1).id);
  return { sent, failed, enabled: settings.feedback_emails };
}

export default {
  name: "portal",
  // Staff manage contacts and send portal links; turning the portal on,
  // credit limits, overrides and settings stay with the owner.
  access: {
    staff: [
      ["GET", /^\/api\/portal\/clients\/[\w-]+(\/recipients)?$/],
      ["POST", /^\/api\/portal\/clients\/[\w-]+\/(invite|links|contacts|sessions\/revoke)$/],
      ["POST", /^\/api\/portal\/links\/[\w-]+\/revoke$/],
      ["PUT", /^\/api\/portal\/contacts\/[\w-]+$/],
      ["DELETE", /^\/api\/portal\/contacts\/[\w-]+$/],
      ["GET", /^\/api\/portal\/documents\/[\w-]+\/credit$/],
      ["GET", /^\/api\/portal\/feedback(\.csv)?$/],
    ],
    accountant: [["GET", /^\/api\/portal\//]],
  },
  migrations: [
    { name: "portal-001-tables", sql: TABLES },
    {
      // A random key for hashing client IP addresses, and the existing main
      // contact of every client as its primary billing contact.
      name: "portal-002-primary-contacts",
      up(db) {
        db.prepare("INSERT OR IGNORE INTO portal_settings(key,value) VALUES('pepper',?)").run(randomBytes(32).toString("hex"));
        const insert = db.prepare(
          "INSERT INTO portal_contacts(id,client_id,name,email,phone,role,primary_billing,cc_invoices,portal_access,created,updated) VALUES(?,?,?,?,?,'billing',1,0,0,?,?)",
        );
        for (const c of db.prepare("SELECT id,contact,email,phone FROM clients").all())
          if (c.contact || c.email || c.phone)
            insert.run(randomUUID(), c.id, c.contact || "", c.email || "", c.phone || "", now(), now());
      },
    },
  ],
  secrets: [],
  attach(Store) {
    attachContacts(Store);
    attachCredit(Store);
    attachAccess(Store);
    attachSignatures(Store);
    attachFeedback(Store);
  },
  init(ctx) {
    const pending = new Set();
    ctx.services.portal = {
      // Who should receive a client's invoices: { to, cc } from the contacts.
      recipients: (clientId) => ctx.store.clientRecipients(clientId),
      track(p) {
        pending.add(p);
        p.finally(() => pending.delete(p));
      },
      // Resolves when background sign-in emails have been handed to the mailer.
      idle: () => Promise.allSettled([...pending]),
    };
    // Automatic payment reminders also go to contacts marked "copy on invoices".
    const mailer = ctx.mailer;
    const deliver = mailer.deliver.bind(mailer);
    mailer.deliver = (m) => {
      if (m?.kind !== "reminder" || !m.clientId) return deliver(m);
      let extra = [];
      try {
        extra = ctx.store.clientRecipients(m.clientId).cc;
      } catch {
        extra = [];
      }
      const seen = new Set([...(m.to || []), ...(m.cc || [])].map((e) => e.toLowerCase()));
      const cc = [...(m.cc || []), ...extra.filter((e) => !seen.has(e.toLowerCase()))].slice(
        0,
        Math.max(0, 5 - (m.to || []).length),
      );
      return deliver({ ...m, cc });
    };
  },
  routes: {
    owner: (r) => ownerRoutes(r),
    guest: (r) => guestRoutes(r, (p) => r.ctx.services.portal.track(p)),
  },
  jobs: [{ name: "feedback-requests", every: 600000, delay: 45000, run: feedbackRequests }],
  workspace(r) {
    const { store, mailer, appUrl } = r.ctx;
    const asOf = today();
    const invoices = new Map();
    for (const row of store.db.prepare("SELECT * FROM documents WHERE kind='invoice' AND state='issued'").all()) {
      const d = store.hydrate(row);
      if (!invoices.has(d.client_id)) invoices.set(d.client_id, []);
      invoices.get(d.client_id).push(d);
    }
    const clients = {},
      contacts = {};
    for (const { id } of store.db.prepare("SELECT id FROM clients").all()) {
      clients[id] = { ...store.creditStatus(id, asOf, invoices.get(id) || []), portal: store.portalAccount(id) };
      contacts[id] = [];
    }
    for (const c of store.db
      .prepare("SELECT * FROM portal_contacts ORDER BY primary_billing DESC, role, lower(name), lower(email)")
      .all())
      contacts[c.client_id]?.push(c);
    const drafts = {};
    for (const row of store.db
      .prepare(`SELECT * FROM documents WHERE state='draft' AND kind IN (${HELD_KINDS.map(() => "?").join(",")})`)
      .all(...HELD_KINDS)) {
      const d = store.hydrate(row);
      const c = store.creditCheck(d, clients[d.client_id]);
      drafts[d.id] = {
        blocked: c.blocked,
        message: c.message,
        reasons: c.reasons,
        projected: c.projected,
        override: c.override ? { reason: c.override.reason, created: c.override.created, actor: c.override.actor } : null,
      };
    }
    const signatures = Object.fromEntries(
      store.db.prepare("SELECT * FROM portal_signatures").all().map((s) => [s.document_id, s]),
    );
    return {
      origin: appUrl,
      mail: mailer.status().configured,
      settings: store.portalSettings(),
      clients,
      contacts,
      drafts,
      signatures,
      feedback: { summary: store.feedbackSummary(), items: store.feedbackList({ limit: 300 }) },
    };
  },
  // On the client link page: the signature (if any) and the feedback state.
  publicDocument(d, r) {
    const store = r.ctx.store;
    return {
      signature: d.kind === "quote" ? store.publicSignature(d.id) : null,
      feedback: store.publicFeedback(d),
    };
  },
  exportData(store) {
    return {
      contacts: store.db.prepare("SELECT * FROM portal_contacts ORDER BY client_id,created").all(),
      clients: store.db.prepare("SELECT * FROM portal_clients ORDER BY client_id").all(),
      access_links: store.db
        .prepare("SELECT id,client_id,label,expires,revoked_at,last_used,created FROM portal_links ORDER BY created")
        .all(),
      signatures: store.db.prepare("SELECT * FROM portal_signatures ORDER BY signed_at").all(),
      credit_overrides: store.db.prepare("SELECT * FROM portal_credit_overrides ORDER BY created").all(),
      feedback: store.db.prepare("SELECT * FROM portal_feedback ORDER BY created").all(),
    };
  },
  // A restored copy must not honour sessions, sign-in links or access links from the original.
  onRestore(db) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='portal_sessions'").get()) return;
    db.exec(
      `BEGIN IMMEDIATE;DELETE FROM portal_sessions;DELETE FROM portal_login_tokens;UPDATE portal_links SET revoked_at='${now()}' WHERE revoked_at IS NULL;UPDATE portal_feedback_requests SET token_hash=NULL;COMMIT`,
    );
  },
  seedDemo(store) {
    const find = (name) => store.db.prepare("SELECT * FROM clients WHERE name=?").get(name);
    const meranti = find("Meranti Digital (Demo)"),
      rimba = find("Rimba Retail (Demo)"),
      bayu = find("Bayu Design (Demo)");
    if (meranti) {
      const primary = store.contacts(meranti.id).find((c) => c.primary_billing);
      if (primary) store.saveContact(meranti.id, { portal_access: true }, primary.id);
      store.saveContact(meranti.id, { name: "Hafiz", email: "it@meranti.example", role: "technical", cc_invoices: true });
      store.setPortalEnabled(meranti.id, true);
    }
    if (rimba)
      // A 30-day hold rule shows the limit without blocking other modules' demo invoices.
      store.saveCreditSettings(rimba.id, { credit_limit: "5000.00", hold_days: 30, on_hold: false, portal_credit: "1" });
    if (bayu) {
      const paid = store.db
        .prepare("SELECT * FROM documents WHERE client_id=? AND kind='invoice' AND state='issued'")
        .all(bayu.id)
        .map((row) => store.hydrate(row))
        .find((d) => store.feedbackEligible(d));
      if (paid) {
        const f = store.submitFeedback(paid.id, { rating: 5, comment: "Quick, tidy work and clear updates.", consent: true, display_name: "Bayu Design" }, "link");
        store.setTestimonial(f.id, true);
      }
    }
  },
};
