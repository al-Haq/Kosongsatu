// No. 50: several contacts per client (billing, technical, other) with
// "copy on invoices" and "portal access" flags. The primary billing contact
// and the client's main contact/email/phone always hold the same values.
import { id, now, check, text } from "./domain.mjs";

export const CONTACT_ROLES = ["billing", "technical", "other"];
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const flag = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true";

export function attachContacts(Store) {
  const originalSaveClient = Store.prototype.saveClient;
  Object.assign(Store.prototype, {
    saveClient(b, idv) {
      return this.tx(() => {
        const out = originalSaveClient.call(this, b, idv);
        this.syncPrimaryContact(out);
        return out;
      });
    },
    contacts(clientId) {
      return this.db
        .prepare(
          "SELECT * FROM portal_contacts WHERE client_id=? ORDER BY primary_billing DESC, role, lower(name), lower(email)",
        )
        .all(clientId);
    },
    contact(contactId) {
      const c = this.db.prepare("SELECT * FROM portal_contacts WHERE id=?").get(contactId);
      check(c, "Contact not found.", 404);
      return c;
    },
    // Client details changed (client form, API or import): mirror them on the primary contact.
    syncPrimaryContact(client) {
      const values = { name: client.contact || "", email: client.email || "", phone: client.phone || "" };
      const primary = this.db
        .prepare("SELECT * FROM portal_contacts WHERE client_id=? AND primary_billing=1")
        .get(client.id);
      if (!values.name && !values.email && !values.phone) {
        if (primary) {
          this.db.prepare("DELETE FROM portal_contacts WHERE id=?").run(primary.id);
          this.audit("client.contact.deleted", client.id, "Primary contact cleared in client details", primary, null);
        }
        return null;
      }
      if (primary) {
        if (primary.name === values.name && primary.email === values.email && primary.phone === values.phone)
          return primary;
        this.db
          .prepare("UPDATE portal_contacts SET name=?,email=?,phone=?,updated=? WHERE id=?")
          .run(values.name, values.email, values.phone, now(), primary.id);
        return this.contact(primary.id);
      }
      // An existing contact with the same email becomes the primary one.
      const same = values.email
        ? this.db
            .prepare("SELECT * FROM portal_contacts WHERE client_id=? AND lower(email)=lower(?)")
            .get(client.id, values.email)
        : null;
      if (same) {
        this.db
          .prepare("UPDATE portal_contacts SET primary_billing=1,role='billing',name=?,phone=?,updated=? WHERE id=?")
          .run(values.name || same.name, values.phone || same.phone, now(), same.id);
        return this.contact(same.id);
      }
      const row = {
        id: id(),
        client_id: client.id,
        ...values,
        role: "billing",
        primary_billing: 1,
        cc_invoices: 0,
        portal_access: 0,
        created: now(),
        updated: now(),
      };
      this.db
        .prepare(
          "INSERT INTO portal_contacts(id,client_id,name,email,phone,role,primary_billing,cc_invoices,portal_access,created,updated) VALUES(:id,:client_id,:name,:email,:phone,:role,:primary_billing,:cc_invoices,:portal_access,:created,:updated)",
        )
        .run(row);
      return row;
    },
    saveContact(clientId, b, contactId = null) {
      return this.tx(() => {
        const client = this.client(clientId);
        const before = contactId ? this.contact(contactId) : null;
        check(!before || before.client_id === clientId, "Contact not found.", 404);
        const c = {
          id: contactId || id(),
          client_id: clientId,
          name: text(b.name ?? before?.name ?? "", 120),
          email: text(b.email ?? before?.email ?? "", 160),
          phone: text(b.phone ?? before?.phone ?? "", 60),
          role: text(b.role ?? before?.role ?? "other", 20),
          primary_billing: b.primary_billing === undefined ? before?.primary_billing || 0 : flag(b.primary_billing) ? 1 : 0,
          cc_invoices: b.cc_invoices === undefined ? before?.cc_invoices || 0 : flag(b.cc_invoices) ? 1 : 0,
          portal_access: b.portal_access === undefined ? before?.portal_access || 0 : flag(b.portal_access) ? 1 : 0,
          created: before?.created || now(),
          updated: now(),
        };
        check(c.name || c.email, "Enter a name or an email for the contact.");
        check(!c.email || EMAIL.test(c.email), "Enter a valid email.");
        check(CONTACT_ROLES.includes(c.role), "Choose billing, technical or other.");
        check(!c.portal_access || c.email, "Portal access needs an email address for the sign-in link.");
        check(!c.cc_invoices || c.email, "Copies of invoices need an email address.");
        check(
          !before?.primary_billing || c.primary_billing,
          "Make another contact the primary billing contact instead.",
        );
        if (c.primary_billing) c.role = "billing";
        if (c.email)
          check(
            !this.db
              .prepare("SELECT 1 FROM portal_contacts WHERE client_id=? AND lower(email)=lower(?) AND id!=?")
              .get(clientId, c.email, c.id),
            "Another contact of this client already uses this email.",
            409,
          );
        check(
          this.db.prepare("SELECT count(*) n FROM portal_contacts WHERE client_id=? AND id!=?").get(clientId, c.id).n < 30,
          "A client can have at most 30 contacts.",
        );
        if (c.primary_billing)
          this.db
            .prepare("UPDATE portal_contacts SET primary_billing=0,updated=? WHERE client_id=? AND id!=? AND primary_billing=1")
            .run(now(), clientId, c.id);
        this.db
          .prepare(
            "INSERT INTO portal_contacts(id,client_id,name,email,phone,role,primary_billing,cc_invoices,portal_access,created,updated) VALUES(:id,:client_id,:name,:email,:phone,:role,:primary_billing,:cc_invoices,:portal_access,:created,:updated) ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,phone=excluded.phone,role=excluded.role,primary_billing=excluded.primary_billing,cc_invoices=excluded.cc_invoices,portal_access=excluded.portal_access,updated=excluded.updated",
          )
          .run(c);
        // Losing portal access, or a new email, ends that contact's portal sessions and links.
        if (before && (before.portal_access && !c.portal_access || before.email !== c.email)) {
          this.db.prepare("DELETE FROM portal_sessions WHERE contact_id=?").run(c.id);
          this.db.prepare("DELETE FROM portal_login_tokens WHERE contact_id=? AND used_at IS NULL").run(c.id);
        }
        this.audit("client.contact.saved", clientId, c.name || c.email, before, c);
        // The primary billing contact fills the client's main contact details.
        if (c.primary_billing && (client.contact !== c.name || client.email !== c.email || client.phone !== c.phone))
          this.saveClient({ ...client, contact: c.name, email: c.email, phone: c.phone }, clientId);
        return this.contact(c.id);
      });
    },
    deleteContact(contactId) {
      return this.tx(() => {
        const c = this.contact(contactId);
        check(
          !c.primary_billing,
          "This is the primary billing contact. Make another contact primary first, or clear the email in the client details.",
          409,
        );
        this.db.prepare("DELETE FROM portal_contacts WHERE id=?").run(contactId);
        this.audit("client.contact.deleted", c.client_id, c.name || c.email, c, null);
      });
    },
    // Who gets a client's invoices and statements: the main email, plus a copy
    // for every contact marked "copy on invoices". Mail allows 5 To and 5 Cc.
    clientRecipients(clientId) {
      const client = this.client(clientId);
      const to = client.email ? [client.email] : [];
      const seen = new Set(to.map((e) => e.toLowerCase()));
      const cc = [];
      for (const c of this.contacts(clientId))
        if (c.cc_invoices && c.email && !seen.has(c.email.toLowerCase())) {
          seen.add(c.email.toLowerCase());
          cc.push(c.email);
        }
      return { to, cc: cc.slice(0, 5) };
    },
  });
}
