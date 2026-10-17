// No. 99: client feedback after payment. A fully paid invoice may receive one
// 1–5 rating with a short comment; with the client's consent the owner can
// show it as a testimonial. An optional email asks for feedback once.
import { randomBytes } from "node:crypto";
import { id, hash, now, check, text, integer } from "./domain.mjs";

const flag = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true";
export const FEEDBACK_DAYS = 30;
// Audit actions after which an invoice may have become fully paid.
export const PAYMENT_EVENTS = ["payment.allocated", "payment.recorded", "online_payment.paid", "invoice.credit.issued"];

export function attachFeedback(Store) {
  Object.assign(Store.prototype, {
    portalSetting(key, fallback = null) {
      return this.db.prepare("SELECT value FROM portal_settings WHERE key=?").get(key)?.value ?? fallback;
    },
    portalSettings() {
      return {
        feedback_emails: this.portalSetting("feedback_emails") === "1",
        feedback_emails_since: this.portalSetting("feedback_emails_since"),
      };
    },
    savePortalSettings(b) {
      return this.tx(() => {
        const before = this.portalSettings();
        if ("feedback_emails" in b) {
          const on = flag(b.feedback_emails);
          if (on !== before.feedback_emails) {
            const set = this.db.prepare(
              "INSERT INTO portal_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            );
            set.run("feedback_emails", on ? "1" : "0");
            if (on) set.run("feedback_emails_since", now());
          }
        }
        const after = this.portalSettings();
        if (after.feedback_emails !== before.feedback_emails)
          this.audit("portal.settings.changed", null, "Client portal settings", before, after);
        return after;
      });
    },
    feedbackEligible(d) {
      return d.kind === "invoice" && d.state === "issued" && d.paid > 0 && d.balance === 0;
    },
    feedbackFor(invoiceId) {
      return this.db.prepare("SELECT * FROM portal_feedback WHERE invoice_id=?").get(invoiceId) || null;
    },
    // What the client page needs: may they leave feedback, and did they already.
    publicFeedback(d) {
      if (d.kind !== "invoice") return null;
      const f = this.feedbackFor(d.id);
      return { eligible: this.feedbackEligible(d) && !f, submitted: !!f, rating: f?.rating ?? null };
    },
    submitFeedback(invoiceId, b, source) {
      return this.tx(() => {
        const d = this.document(invoiceId);
        check(this.feedbackEligible(d), "Feedback opens once the invoice is fully paid.", 409);
        check(!this.feedbackFor(d.id), "Feedback for this invoice was already received. Thank you.", 409);
        const consent = flag(b.consent);
        const row = {
          id: id(),
          invoice_id: d.id,
          client_id: d.client_id,
          rating: integer(b.rating, 1, 5),
          comment: text(typeof b.comment === "string" ? b.comment : "", 500),
          consent: consent ? 1 : 0,
          display_name: consent ? text(typeof b.display_name === "string" ? b.display_name : "", 80) : "",
          testimonial: 0,
          source,
          created: now(),
          updated: now(),
        };
        this.db
          .prepare(
            "INSERT INTO portal_feedback(id,invoice_id,client_id,rating,comment,consent,display_name,testimonial,source,created,updated) VALUES(:id,:invoice_id,:client_id,:rating,:comment,:consent,:display_name,:testimonial,:source,:created,:updated)",
          )
          .run(row);
        // An emailed feedback link is spent once feedback exists.
        this.db.prepare("UPDATE portal_feedback_requests SET token_hash=NULL WHERE invoice_id=?").run(d.id);
        this.audit("feedback.received", d.id, `${row.rating}/5${consent ? ", testimonial allowed" : ""}`, null, {
          rating: row.rating,
          consent: row.consent,
        });
        return row;
      });
    },
    setTestimonial(feedbackId, on) {
      return this.tx(() => {
        const f = this.db.prepare("SELECT * FROM portal_feedback WHERE id=?").get(feedbackId);
        check(f, "Feedback not found.", 404);
        check(typeof on === "boolean", "Choose on or off.");
        check(!on || f.consent, "The client did not allow this feedback to be shown.", 409);
        this.db.prepare("UPDATE portal_feedback SET testimonial=?,updated=? WHERE id=?").run(on ? 1 : 0, now(), f.id);
        this.audit(on ? "feedback.testimonial.on" : "feedback.testimonial.off", f.invoice_id, `${f.rating}/5`);
        return this.db.prepare("SELECT * FROM portal_feedback WHERE id=?").get(f.id);
      });
    },
    feedbackList({ testimonials = false, limit = 500 } = {}) {
      return this.db
        .prepare(
          `SELECT f.*,c.name client_name,d.number invoice_number FROM portal_feedback f JOIN clients c ON c.id=f.client_id JOIN documents d ON d.id=f.invoice_id ${testimonials ? "WHERE f.testimonial=1" : ""} ORDER BY f.created DESC LIMIT ?`,
        )
        .all(limit);
    },
    feedbackSummary() {
      const all = this.db.prepare("SELECT rating,client_id,testimonial FROM portal_feedback").all();
      const byClient = {};
      for (const f of all) {
        const c = (byClient[f.client_id] ||= { count: 0, total: 0 });
        c.count++;
        c.total += f.rating;
      }
      for (const c of Object.values(byClient)) c.average = Math.round((c.total / c.count) * 10) / 10;
      const counts = [1, 2, 3, 4, 5].map((r) => all.filter((f) => f.rating === r).length);
      return {
        count: all.length,
        average: all.length ? Math.round((all.reduce((s, f) => s + f.rating, 0) / all.length) * 10) / 10 : null,
        testimonials: all.filter((f) => f.testimonial).length,
        counts,
        by_client: byClient,
      };
    },
    // Creates the one feedback request for a newly paid invoice, or null when
    // it is not wanted: not fully paid, already asked, already rated, no email.
    feedbackRequest(invoiceId) {
      return this.tx(() => {
        const row = this.db.prepare("SELECT * FROM documents WHERE id=?").get(invoiceId);
        if (!row || row.kind !== "invoice") return null;
        const d = this.hydrate(row);
        if (!this.feedbackEligible(d) || this.feedbackFor(d.id)) return null;
        if (this.db.prepare("SELECT 1 FROM portal_feedback_requests WHERE invoice_id=?").get(d.id)) return null;
        const client = this.client(d.client_id);
        if (!client.email || client.archived) return null;
        const token = randomBytes(32).toString("base64url");
        this.db
          .prepare("INSERT INTO portal_feedback_requests(invoice_id,token_hash,expires,status,error,created) VALUES(?,?,?,'sending',NULL,?)")
          .run(d.id, hash(token), Date.now() + FEEDBACK_DAYS * 86400000, now());
        return { token, invoice: d, client };
      });
    },
    markFeedbackRequest(invoiceId, status, error = null) {
      this.db.prepare("UPDATE portal_feedback_requests SET status=?,error=? WHERE invoice_id=?").run(status, error, invoiceId);
    },
    // The invoice behind an emailed feedback link.
    feedbackByToken(token) {
      check(typeof token === "string" && /^[\w-]{43}$/.test(token), "This feedback link is invalid or has expired.", 404);
      const r = this.db
        .prepare("SELECT * FROM portal_feedback_requests WHERE token_hash=? AND expires>?")
        .get(hash(token), Date.now());
      check(r, "This feedback link is invalid, used or expired.", 404);
      return this.document(r.invoice_id);
    },
  });
}
