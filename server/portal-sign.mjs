// No. 52: e-signature on quotation acceptance. The client draws or types a
// signature and ticks agreement; the image, signer name, time, a keyed hash
// of the IP address, the browser and a fingerprint of the quotation are kept
// with the acceptance and printed on the quotation PDF.
import { createHash, createHmac } from "node:crypto";
import { now, check, text } from "./domain.mjs";
import { inspectSignaturePng, decodeSignature, SIGNATURE_LIMITS } from "./portal-png.mjs";

const label = (iso) =>
  new Intl.DateTimeFormat("en-MY", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kuala_Lumpur" }).format(new Date(iso));

// What the client agreed to, so a later change to the record would show.
// The version of a quotation the client was shown. An issued quotation can
// still be edited until it is accepted, so accepting or signing must name the
// version seen; a stale page is refused and asked to reload.
export const quoteRevision = (d) => quoteFingerprint(d).slice(0, 24);
export function checkRevision(d, revision) {
  check(
    typeof revision === "string" && revision === quoteRevision(d),
    "This quotation was changed after you opened it. Reload the page to see the latest version, then accept.",
    409,
  );
}
export function quoteFingerprint(d) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        number: d.number,
        client: d.client?.name,
        issue_date: d.issue_date,
        due_date: d.due_date,
        currency: d.currency || "MYR",
        items: d.items,
        subtotal: d.subtotal,
        discount: d.discount,
        tax: d.tax,
        total: d.total,
        terms: d.terms,
        notes: d.notes,
        // Also what an edit after issue can change that the client sees: the
        // deposit asked for, printed custom fields, the language and whether
        // attachments are listed.
        deposit: d.meta?.deposit || null,
        custom: d.meta?.custom || {},
        language: d.language || "en",
        list_attachments: !!d.meta?.list_attachments,
      }),
    )
    .digest("hex");
}

export function attachSignatures(Store) {
  const originalBlocks = Store.prototype.pdfBlocks,
    originalDeleteFile = Store.prototype.deleteFile;
  Object.assign(Store.prototype, {
    portalPepper() {
      return this.db.prepare("SELECT value FROM portal_settings WHERE key='pepper'").get().value;
    },
    // IP addresses are not kept; a keyed hash still lets the owner compare two events.
    ipFingerprint(ip) {
      return createHmac("sha256", this.portalPepper()).update(String(ip || "")).digest("hex");
    },
    signature(docId) {
      return this.db.prepare("SELECT * FROM portal_signatures WHERE document_id=?").get(docId) || null;
    },
    // Accepts a quotation with a signature, all in one transaction. `token` is a
    // client-link token or a portal reference; accept() checks it either way.
    signQuote(token, b, { ip, userAgent, source, contactId = null }) {
      const name = text(typeof b.name === "string" ? b.name : "", 120, true);
      check(b.agree === true, "Tick the box to confirm you agree to the quotation.");
      const method = b.method === "type" ? "type" : b.method === "draw" ? "draw" : null;
      check(method, "Draw or type your signature.");
      if (method === "type") {
        const typed = text(typeof b.typed === "string" ? b.typed : "", 120, true);
        check(typed.toLowerCase() === name.toLowerCase(), "Type your full name exactly as entered above.");
      }
      const image = inspectSignaturePng(decodeSignature(b.signature));
      return this.tx(() => {
        const d = this.publicDocument(token);
        check(d.kind === "quote", "Only quotations can be signed.", 409);
        check(!this.signature(d.id), "This quotation is already signed.", 409);
        checkRevision(d, b.revision);
        const accepted = this.accept(token, name);
        const file = this.saveFile(
          {
            entity_type: "document",
            entity_id: d.id,
            purpose: "signature",
            name: `signature-${d.number}.png`,
            data: image.png,
            visibility: "client",
          },
          { accept: ["image/png"], maxBytes: SIGNATURE_LIMITS.maxBytes * 2 },
        );
        const row = {
          document_id: d.id,
          file_id: file.id,
          signer_name: name,
          method,
          source,
          contact_id: contactId,
          ip_hash: this.ipFingerprint(ip),
          user_agent: String(userAgent || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 300),
          document_hash: quoteFingerprint(d),
          signed_at: now(),
        };
        this.db
          .prepare(
            "INSERT INTO portal_signatures(document_id,file_id,signer_name,method,source,contact_id,ip_hash,user_agent,document_hash,signed_at) VALUES(:document_id,:file_id,:signer_name,:method,:source,:contact_id,:ip_hash,:user_agent,:document_hash,:signed_at)",
          )
          .run(row);
        this.audit("quotation.signed", d.id, name, null, {
          method,
          source,
          file_id: file.id,
          ip_hash: row.ip_hash.slice(0, 16),
          document_hash: row.document_hash,
        });
        return { document: accepted, signature: row };
      });
    },
    // Client-safe view of a signature (no IP hash or browser details).
    publicSignature(docId) {
      const s = this.signature(docId);
      return s ? { signer_name: s.signer_name, method: s.method, signed_at: s.signed_at } : null;
    },
    async pdfBlocks(d) {
      const blocks = await originalBlocks.call(this, d);
      const s = d?.kind === "quote" && d.id ? this.signature(d.id) : null;
      if (!s) return blocks;
      let image = null;
      try {
        image = this.file(s.file_id).data;
      } catch {
        image = null;
      }
      return [
        ...blocks,
        {
          heading: "Acceptance",
          ...(image ? { image, imageWidth: 150, imageHeight: 60 } : {}),
          text: [
            `Accepted by ${s.signer_name} on ${label(s.signed_at)} (Malaysia time).`,
            `${s.method === "draw" ? "Drawn" : "Typed"} electronic signature through the ${s.source === "portal" ? "client portal" : "client link"}, with agreement to the scope, price and terms.`,
            `Quotation fingerprint: ${s.document_hash.slice(0, 16)}`,
          ].join("\n"),
        },
      ];
    },
    deleteFile(fid) {
      const f = this.db.prepare("SELECT entity_type,purpose FROM files WHERE id=?").get(fid);
      check(
        !(f && f.entity_type === "document" && f.purpose === "signature"),
        "Signatures on accepted quotations are kept permanently.",
        409,
      );
      return originalDeleteFile.call(this, fid);
    },
  });
}
