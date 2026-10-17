// No. 49: client portal accounts. The owner turns the portal on for a client;
// contacts with portal access sign in with a one-time emailed link, or the
// owner hands out a long-lived access link. Both create a portal session that
// only ever sees that one client's issued documents.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { id, hash, now, check, text, integer, today } from "./domain.mjs";
import { inMYR } from "./portal-credit.mjs";

export const SIGNIN_MINUTES = 15;
export const INVITE_HOURS = 72;
export const SESSION_HOURS = 12;
export const LINK_DAYS = [30, 90, 180, 365];
const TOKEN = /^[\w-]{43}$/;
const newToken = () => randomBytes(32).toString("base64url");

// A capability for one document of one client. Store methods that take a
// client-link token (accept, proof, checkout) also take this object, so the
// portal reuses their checks without rotating the document's share token.
// JSON input can never carry a Symbol key, so it cannot be forged by a browser.
const REF = Symbol("portal document");
export const portalRef = (clientId, docId) => Object.freeze({ [REF]: { clientId, docId } });
export const isPortalRef = (v) => !!(v && typeof v === "object" && v[REF]);

export function attachAccess(Store) {
  const originalPublic = Store.prototype.publicDocument;
  Object.assign(Store.prototype, {
    publicDocument(token, markViewed = false) {
      const ref = isPortalRef(token) ? token[REF] : null;
      if (!ref) return originalPublic.call(this, token, markViewed);
      const row = this.db
        .prepare("SELECT id,viewed_at FROM documents WHERE id=? AND client_id=? AND state NOT IN ('draft','void')")
        .get(String(ref.docId), ref.clientId);
      check(row, "Document not found.", 404);
      if (markViewed && !row.viewed_at) {
        this.db.prepare("UPDATE documents SET viewed_at=? WHERE id=?").run(now(), row.id);
        this.audit("document.viewed", row.id, "Client portal");
      }
      return this.document(row.id);
    },
    portalEnabled(clientId) {
      const c = this.db.prepare("SELECT archived FROM clients WHERE id=?").get(clientId);
      return !!c && !c.archived && !!this.portalClient(clientId).portal_enabled;
    },
    setPortalEnabled(clientId, enabled) {
      return this.tx(() => {
        const c = this.client(clientId);
        check(typeof enabled === "boolean", "Choose on or off.");
        check(!enabled || !c.archived, "Restore the client before turning on the portal.", 409);
        const before = this.portalClient(clientId);
        if (!!before.portal_enabled === enabled) return before;
        const out = this.savePortalClient(clientId, { portal_enabled: enabled ? 1 : 0 });
        if (!enabled) this.endPortalAccess(clientId, false);
        this.audit(enabled ? "portal.enabled" : "portal.disabled", clientId, c.name, { portal_enabled: before.portal_enabled }, { portal_enabled: out.portal_enabled });
        return out;
      });
    },
    // Signs everyone out; turning the portal off also cancels unused links.
    endPortalAccess(clientId, sessionsOnly = true) {
      const n = this.db.prepare("DELETE FROM portal_sessions WHERE client_id=?").run(clientId).changes;
      if (!sessionsOnly) {
        this.db.prepare("DELETE FROM portal_login_tokens WHERE client_id=? AND used_at IS NULL").run(clientId);
        this.db.prepare("UPDATE portal_links SET revoked_at=? WHERE client_id=? AND revoked_at IS NULL").run(now(), clientId);
      }
      return n;
    },
    revokePortalSessions(clientId) {
      return this.tx(() => {
        this.client(clientId);
        const n = this.endPortalAccess(clientId);
        this.audit("portal.sessions.revoked", clientId, `${n} session(s) signed out`);
        return { revoked: n };
      });
    },
    portalAccount(clientId) {
      const cfg = this.portalClient(clientId);
      return {
        enabled: !!cfg.portal_enabled,
        sessions: this.db.prepare("SELECT count(*) n FROM portal_sessions WHERE client_id=? AND expires>?").get(clientId, Date.now()).n,
        invites: this.db
          .prepare("SELECT count(*) n FROM portal_login_tokens WHERE client_id=? AND used_at IS NULL AND expires>?")
          .get(clientId, Date.now()).n,
        links: this.db
          .prepare("SELECT id,label,expires,revoked_at,last_used,created FROM portal_links WHERE client_id=? ORDER BY created DESC LIMIT 20")
          .all(clientId),
      };
    },
    portalContactsWithAccess(clientId) {
      return this.contacts(clientId).filter((c) => c.portal_access && c.email);
    },
    loginToken(clientId, contact, purpose) {
      const token = newToken();
      const expires = Date.now() + (purpose === "invite" ? INVITE_HOURS * 3600000 : SIGNIN_MINUTES * 60000);
      this.db.prepare("DELETE FROM portal_login_tokens WHERE expires<?").run(Date.now() - 86400000);
      this.db
        .prepare(
          "INSERT INTO portal_login_tokens(token_hash,client_id,contact_id,email,purpose,expires,used_at,created) VALUES(?,?,?,?,?,?,NULL,?)",
        )
        .run(hash(token), clientId, contact.id, contact.email.toLowerCase(), purpose, expires, now());
      return { token, expires };
    },
    // Owner invite: a single-use sign-in link for one contact, valid 3 days.
    portalInvite(clientId, contactId) {
      return this.tx(() => {
        const client = this.client(clientId);
        check(this.portalEnabled(clientId), "Turn on the portal for this client first.", 409);
        const contact = this.contact(contactId);
        check(contact.client_id === clientId, "Contact not found.", 404);
        check(contact.portal_access && contact.email, "Give this contact portal access and an email first.", 409);
        const out = this.loginToken(clientId, contact, "invite");
        this.audit("portal.invite.created", clientId, contact.email);
        return { ...out, contact, client };
      });
    },
    // Self-service sign-in. Returns the links to send (possibly none); the
    // caller answers the same way either way so emails cannot be probed.
    portalSigninRequest(email) {
      email = typeof email === "string" ? email.trim().toLowerCase().slice(0, 160) : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return [];
      return this.tx(() => {
        const contacts = this.db
          .prepare(
            "SELECT p.* FROM portal_contacts p JOIN portal_clients a ON a.client_id=p.client_id JOIN clients c ON c.id=p.client_id WHERE lower(p.email)=? AND p.portal_access=1 AND a.portal_enabled=1 AND c.archived=0 LIMIT 10",
          )
          .all(email);
        const out = [];
        for (const contact of contacts) {
          // At most 3 sign-in links per contact in 15 minutes, whatever the source address.
          const recent = this.db
            .prepare("SELECT count(*) n FROM portal_login_tokens WHERE contact_id=? AND purpose='signin' AND created>?")
            .get(contact.id, new Date(Date.now() - SIGNIN_MINUTES * 60000).toISOString()).n;
          if (recent >= 3) continue;
          out.push({ ...this.loginToken(contact.client_id, contact, "signin"), contact, client: this.client(contact.client_id) });
        }
        if (out.length) this.audit("portal.signin.requested", null, `${out.length} link(s)`);
        return out;
      });
    },
    // Consumes a one-time link. Expired, used and unknown links look the same.
    portalVerify(token) {
      const invalid = "This sign-in link is invalid, used or expired. Request a new one.";
      check(typeof token === "string" && TOKEN.test(token), invalid, 401);
      // The link is spent as soon as it is presented, even if access was removed since.
      const out = this.tx(() => {
        const t = this.db.prepare("SELECT * FROM portal_login_tokens WHERE token_hash=?").get(hash(token));
        if (!t || t.used_at || t.expires <= Date.now()) return null;
        const used = this.db
          .prepare("UPDATE portal_login_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL")
          .run(now(), t.token_hash);
        if (used.changes !== 1) return null;
        const contact = this.db.prepare("SELECT * FROM portal_contacts WHERE id=?").get(t.contact_id);
        if (
          !contact ||
          contact.client_id !== t.client_id ||
          !contact.portal_access ||
          contact.email.toLowerCase() !== t.email ||
          !this.portalEnabled(t.client_id)
        )
          return null;
        const s = this.createPortalSession(t.client_id, { contact_id: contact.id });
        this.audit("portal.signed_in", t.client_id, contact.email);
        return { ...s, client_id: t.client_id, contact };
      });
      check(out, invalid, 401);
      return out;
    },
    // Long-lived access link for clients without email. Shown once; revocable.
    createPortalLink(clientId, b = {}) {
      return this.tx(() => {
        this.client(clientId);
        check(this.portalEnabled(clientId), "Turn on the portal for this client first.", 409);
        const days = integer(b.days ?? 90, 1, 365);
        const label = text(b.label || "", 80);
        const token = newToken();
        const row = { id: id(), client_id: clientId, token_hash: hash(token), label, expires: Date.now() + days * 86400000, created: now() };
        check(
          this.db.prepare("SELECT count(*) n FROM portal_links WHERE client_id=? AND revoked_at IS NULL AND expires>?").get(clientId, Date.now()).n < 10,
          "This client already has 10 active access links. Revoke one first.",
          409,
        );
        this.db
          .prepare("INSERT INTO portal_links(id,client_id,token_hash,label,expires,revoked_at,last_used,created) VALUES(:id,:client_id,:token_hash,:label,:expires,NULL,NULL,:created)")
          .run(row);
        this.audit("portal.link.created", clientId, `${label || "Access link"}: ${days} days`);
        return { id: row.id, token, expires: row.expires };
      });
    },
    revokePortalLink(linkId) {
      return this.tx(() => {
        const l = this.db.prepare("SELECT * FROM portal_links WHERE id=?").get(linkId);
        check(l, "Access link not found.", 404);
        if (!l.revoked_at) this.db.prepare("UPDATE portal_links SET revoked_at=? WHERE id=?").run(now(), linkId);
        this.db.prepare("DELETE FROM portal_sessions WHERE link_id=?").run(linkId);
        this.audit("portal.link.revoked", l.client_id, l.label || "Access link");
        return { ok: true };
      });
    },
    portalLinkSignin(token) {
      const invalid = "This portal link is invalid, revoked or expired. Ask for a new link.";
      check(typeof token === "string" && TOKEN.test(token), invalid, 401);
      return this.tx(() => {
        const l = this.db.prepare("SELECT * FROM portal_links WHERE token_hash=?").get(hash(token));
        check(l && !l.revoked_at && l.expires > Date.now() && this.portalEnabled(l.client_id), invalid, 401);
        this.db.prepare("UPDATE portal_links SET last_used=? WHERE id=?").run(now(), l.id);
        const s = this.createPortalSession(l.client_id, { link_id: l.id });
        this.audit("portal.link.used", l.client_id, l.label || "Access link");
        return { ...s, client_id: l.client_id };
      });
    },
    createPortalSession(clientId, { contact_id = null, link_id = null }) {
      const token = newToken(),
        csrf = randomBytes(24).toString("base64url");
      this.db.prepare("DELETE FROM portal_sessions WHERE expires<?").run(Date.now());
      this.db
        .prepare(
          "INSERT INTO portal_sessions(hash,client_id,contact_id,link_id,csrf,expires,created,last_seen) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(hash(token), clientId, contact_id, link_id, csrf, Date.now() + SESSION_HOURS * 3600000, now(), now());
      return { token, csrf };
    },
    // The session behind a portal cookie, or null. Access is re-checked on
    // every request: portal on, client active, contact or link still allowed.
    portalSession(token) {
      if (typeof token !== "string" || !TOKEN.test(token)) return null;
      const s = this.db.prepare("SELECT * FROM portal_sessions WHERE hash=? AND expires>?").get(hash(token), Date.now());
      if (!s || !this.portalEnabled(s.client_id)) return null;
      let contact = null;
      if (s.contact_id) {
        contact = this.db.prepare("SELECT * FROM portal_contacts WHERE id=?").get(s.contact_id);
        if (!contact || !contact.portal_access || contact.client_id !== s.client_id) return null;
      } else {
        const l = this.db.prepare("SELECT * FROM portal_links WHERE id=?").get(s.link_id);
        if (!l || l.revoked_at || l.expires <= Date.now() || l.client_id !== s.client_id) return null;
      }
      if (Date.now() - Date.parse(s.last_seen) > 300000)
        this.db.prepare("UPDATE portal_sessions SET last_seen=? WHERE hash=?").run(now(), s.hash);
      return { ...s, contact };
    },
    endPortalSession(sessionHash) {
      this.db.prepare("DELETE FROM portal_sessions WHERE hash=?").run(sessionHash);
    },
    // Everything a signed-in client may see. Client-safe fields only.
    portalOverview(clientId, asOf = today()) {
      const client = this.client(clientId);
      const b = this.settings();
      const docs = this.db
        .prepare(
          "SELECT * FROM documents WHERE client_id=? AND state NOT IN ('draft','void') ORDER BY issue_date DESC, created DESC",
        )
        .all(clientId)
        .map((row) => this.hydrate(row));
      const invoices = docs.filter((d) => d.kind === "invoice");
      const receipts = this.db
        .prepare("SELECT id FROM cash_receipts WHERE client_id=? AND voided=0 ORDER BY paid_date DESC, created DESC")
        .all(clientId)
        .map((r) => this.receipt(r.id));
      const notes = this.db
        .prepare(
          "SELECT a.id,a.kind,a.number,a.amount,a.issue_date,a.reason,d.number invoice_number,d.id invoice_id FROM adjustments a JOIN documents d ON d.id=a.invoice_id WHERE d.client_id=? ORDER BY a.issue_date DESC, a.created DESC",
        )
        .all(clientId);
      return {
        client: { name: client.name },
        business: {
          company: b.company,
          email: b.email,
          phone: b.phone,
          address: b.address,
          bankName: b.bankName,
          bankHolder: b.bankHolder,
          bankAccount: b.bankAccount,
        },
        totals: {
          outstanding: invoices.reduce((s, d) => s + inMYR(d, d.balance), 0),
          overdue: invoices.filter((d) => d.balance > 0 && d.due_date < asOf).reduce((s, d) => s + inMYR(d, d.balance), 0),
          open_invoices: invoices.filter((d) => d.balance > 0).length,
          credit_available: receipts.reduce((s, r) => s + inMYR(r, r.available), 0),
        },
        documents: docs.map((d) => ({
          id: d.id,
          kind: d.kind,
          number: d.number,
          status: d.status,
          state: d.state,
          issue_date: d.issue_date,
          due_date: d.due_date,
          currency: d.currency || "MYR",
          total: d.adjusted_total ?? d.total,
          balance: d.kind === "invoice" ? d.balance : null,
        })),
        receipts: receipts.map((r) => ({
          id: r.id,
          number: r.number,
          paid_date: r.paid_date,
          amount: r.amount,
          currency: r.currency || "MYR",
          method: r.method,
          refunded: r.refunded,
          available: r.available,
          invoices: r.allocations
            .filter((p) => p.applied > 0)
            .map((p) => ({ number: docs.find((d) => d.id === p.invoice_id)?.number || "", amount: p.applied })),
        })),
        notes,
      };
    },
    // A document of this client by ID. Drafts, voids and other clients' documents are "not found".
    portalDocument(clientId, docId, markViewed = false) {
      check(typeof docId === "string" && /^[\w-]{1,80}$/.test(docId), "Document not found.", 404);
      return this.publicDocument(portalRef(clientId, docId), markViewed);
    },
    portalAccept(clientId, docId, name) {
      return this.accept(portalRef(clientId, docId), name);
    },
    portalProof(clientId, docId, b) {
      return this.proof(portalRef(clientId, docId), b);
    },
    portalReceipt(clientId, receiptId) {
      const r = this.db.prepare("SELECT id,client_id,voided FROM cash_receipts WHERE id=?").get(String(receiptId));
      check(r && r.client_id === clientId && !r.voided, "Receipt not found.", 404);
      return this.receipt(r.id);
    },
    portalNote(clientId, noteId) {
      const row = this.db
        .prepare("SELECT a.* FROM adjustments a JOIN documents d ON d.id=a.invoice_id WHERE a.id=? AND d.client_id=?")
        .get(String(noteId), clientId);
      check(row, "Note not found.", 404);
      return { note: row, invoice: this.document(row.invoice_id) };
    },
  });
}

export const sameSecret = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
