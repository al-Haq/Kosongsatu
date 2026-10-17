// Proof of work on invoices and quotations (roadmap no. 97): before/after
// photos, a work log and a service report. Nothing is shown to the client
// until the owner marks it visible; the client page and the PDF only ever
// read client-visible items.
import { id, now, today, text, date, check } from "./domain.mjs";
export const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"];
// pdfkit draws PNG and JPEG only.
const PDF_TYPES = ["image/png", "image/jpeg"];
export const PHOTO_PURPOSES = { before: "work_before", after: "work_after" };
export const MAX_PHOTOS = 12;
export const MAX_PDF_PHOTOS = 4;
export const MAX_LOGS = 100;
const kindOf = (purpose) => (purpose === "work_before" ? "before" : "after");
const label = (d) =>
  new Intl.DateTimeFormat("en-MY", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(d + "T00:00:00Z"),
  );
export function attachProof(Store) {
  const original = {
    deleteDraft: Store.prototype.deleteDraft,
    pdfBlocks: Store.prototype.pdfBlocks,
  };
  const doc = (store, did, write = false) => {
    const d = store.db.prepare("SELECT id,kind,state,number FROM documents WHERE id=?").get(did);
    check(d, "Document not found.", 404);
    if (write) check(d.state !== "void", "This document is void. Proof of work can no longer change.", 409);
    return d;
  };
  const photo = (store, fid) => {
    const f = store.db
      .prepare(
        "SELECT id,entity_type,entity_id,purpose,name,mime,size,visibility,created FROM files WHERE id=? AND entity_type='document' AND purpose IN ('work_before','work_after')",
      )
      .get(fid);
    check(f, "Photo not found.", 404);
    return f;
  };
  const photos = (store, did) =>
    store.db
      .prepare(
        "SELECT id,purpose,name,mime,size,visibility,created FROM files WHERE entity_type='document' AND entity_id=? AND purpose IN ('work_before','work_after') ORDER BY purpose='work_after',created,id",
      )
      .all(did)
      .map((f) => ({ ...f, kind: kindOf(f.purpose) }));
  const report = (store, did) =>
    store.db.prepare("SELECT * FROM ops_work_reports WHERE document_id=?").get(did) || {
      document_id: did,
      report: "",
      visible: 0,
      pdf: 1,
      updated: null,
    };
  Object.assign(Store.prototype, {
    proofOfWork(did) {
      doc(this, did);
      return {
        report: report(this, did),
        photos: photos(this, did),
        logs: this.db
          .prepare("SELECT * FROM ops_work_logs WHERE document_id=? ORDER BY log_date,created")
          .all(did),
      };
    },
    addWorkPhoto(did, b) {
      return this.tx(() => {
        const d = doc(this, did, true);
        const purpose = PHOTO_PURPOSES[b.kind];
        check(purpose, "Choose a before or after photo.");
        check(photos(this, did).length < MAX_PHOTOS, `A document can hold up to ${MAX_PHOTOS} work photos.`, 409);
        const f = this.saveFile(
          {
            entity_type: "document",
            entity_id: d.id,
            purpose,
            name: b.name || `${b.kind}-photo`,
            data: b.data,
            visibility: b.visible ? "client" : "private",
          },
          { accept: PHOTO_TYPES },
        );
        return { ...f, kind: b.kind };
      });
    },
    setWorkPhotoVisibility(fid, visible) {
      return this.tx(() => {
        const f = photo(this, fid);
        doc(this, f.entity_id, true);
        const visibility = visible ? "client" : "private";
        if (visibility !== f.visibility) {
          this.db.prepare("UPDATE files SET visibility=? WHERE id=?").run(visibility, fid);
          this.audit("work.photo.visibility", f.entity_id, `${f.name}: ${visibility}`, { visibility: f.visibility }, { visibility });
        }
        return { ...photo(this, fid), kind: kindOf(f.purpose) };
      });
    },
    deleteWorkPhoto(fid) {
      return this.tx(() => {
        const f = photo(this, fid);
        doc(this, f.entity_id, true);
        this.deleteFile(fid);
      });
    },
    saveWorkLog(did, b, lid) {
      return this.tx(() => {
        const old = lid ? this.db.prepare("SELECT * FROM ops_work_logs WHERE id=?").get(lid) : null;
        if (lid) check(old, "Work log entry not found.", 404);
        const d = doc(this, old?.document_id || did, true);
        if (!old)
          check(
            this.db.prepare("SELECT count(*) n FROM ops_work_logs WHERE document_id=?").get(d.id).n < MAX_LOGS,
            `A document can hold up to ${MAX_LOGS} work log entries.`,
            409,
          );
        const out = {
          id: lid || id(),
          document_id: d.id,
          log_date: date(b.log_date ?? old?.log_date ?? today()),
          person: text(b.person ?? old?.person, 120, true),
          notes: text(b.notes ?? old?.notes, 1000, true),
          visible: b.visible === undefined ? old?.visible ?? 0 : b.visible === true || b.visible === "on" ? 1 : 0,
          created: old?.created || now(),
          updated: now(),
        };
        check(out.log_date <= today(), "Work log dates cannot be in the future.");
        this.db
          .prepare(
            "INSERT INTO ops_work_logs(id,document_id,log_date,person,notes,visible,created,updated) VALUES(:id,:document_id,:log_date,:person,:notes,:visible,:created,:updated) ON CONFLICT(id) DO UPDATE SET log_date=excluded.log_date,person=excluded.person,notes=excluded.notes,visible=excluded.visible,updated=excluded.updated",
          )
          .run(out);
        this.audit("work.log.saved", d.id, `${out.log_date} ${out.person}`, old, out);
        return this.db.prepare("SELECT * FROM ops_work_logs WHERE id=?").get(out.id);
      });
    },
    deleteWorkLog(lid) {
      return this.tx(() => {
        const old = this.db.prepare("SELECT * FROM ops_work_logs WHERE id=?").get(lid);
        check(old, "Work log entry not found.", 404);
        doc(this, old.document_id, true);
        this.db.prepare("DELETE FROM ops_work_logs WHERE id=?").run(lid);
        this.audit("work.log.deleted", old.document_id, `${old.log_date} ${old.person}`, old, null);
      });
    },
    saveWorkReport(did, b) {
      return this.tx(() => {
        const d = doc(this, did, true);
        const old = this.db.prepare("SELECT * FROM ops_work_reports WHERE document_id=?").get(d.id) || null;
        const bool = (v, fallback) => (v === undefined ? fallback : v === true || v === "on" ? 1 : 0);
        const out = {
          document_id: d.id,
          report: b.report === undefined ? old?.report ?? "" : text(b.report, 4000),
          visible: bool(b.visible, old?.visible ?? 0),
          pdf: bool(b.pdf, old?.pdf ?? 1),
          updated: now(),
        };
        this.db
          .prepare(
            "INSERT INTO ops_work_reports(document_id,report,visible,pdf,updated) VALUES(:document_id,:report,:visible,:pdf,:updated) ON CONFLICT(document_id) DO UPDATE SET report=excluded.report,visible=excluded.visible,pdf=excluded.pdf,updated=excluded.updated",
          )
          .run(out);
        this.audit("work.report.saved", d.id, out.visible ? "Visible to client" : "Private", old, out);
        return report(this, d.id);
      });
    },
    // Client-safe proof of work for a client document link.
    publicWork(did) {
      const r = report(this, did);
      return {
        report: r.visible && r.report ? r.report : "",
        photos: photos(this, did)
          .filter((f) => f.visibility === "client")
          .map((f) => ({ id: f.id, kind: f.kind, name: f.name })),
        logs: this.db
          .prepare("SELECT log_date,person,notes FROM ops_work_logs WHERE document_id=? AND visible=1 ORDER BY log_date,created")
          .all(did),
      };
    },
    // A client-visible work photo of this document, or 404.
    publicWorkPhoto(did, fid) {
      const f = this.db
        .prepare(
          "SELECT id FROM files WHERE id=? AND entity_type='document' AND entity_id=? AND purpose IN ('work_before','work_after') AND visibility='client'",
        )
        .get(fid, did);
      check(f, "Not found.", 404);
      return this.file(f.id);
    },
    async pdfBlocks(d) {
      const blocks = await original.pdfBlocks.call(this, d);
      if (!d?.id) return blocks;
      const r = report(this, d.id);
      if (!r.pdf) return blocks;
      const work = this.publicWork(d.id);
      const out = [];
      if (work.report) out.push({ heading: "Service report", text: work.report });
      const shown = this.db
        .prepare(
          `SELECT id,purpose,name FROM files WHERE entity_type='document' AND entity_id=? AND purpose IN ('work_before','work_after') AND visibility='client' AND mime IN (${PDF_TYPES.map(() => "?").join(",")}) ORDER BY purpose='work_after',created,id LIMIT ${MAX_PDF_PHOTOS}`,
        )
        .all(d.id, ...PDF_TYPES);
      for (const [n, f] of shown.entries())
        out.push({
          heading: n === 0 ? "Proof of work" : "",
          image: this.file(f.id).data,
          imageWidth: 150,
          imageHeight: 150,
          text: `${kindOf(f.purpose) === "before" ? "Before" : "After"}: ${f.name}`,
        });
      if (work.logs.length)
        out.push({
          heading: "Work log",
          text: work.logs
            .slice(0, 30)
            .map((l) => `${label(l.log_date)} / ${l.person}: ${l.notes}`)
            .join("\n"),
        });
      return [...blocks, ...out];
    },
    // A deleted draft takes its proof of work with it.
    deleteDraft(did) {
      return this.tx(() => {
        const d = this.db.prepare("SELECT state FROM documents WHERE id=?").get(did);
        if (d?.state === "draft") {
          for (const f of photos(this, did)) this.deleteFile(f.id);
          const logs = this.db.prepare("DELETE FROM ops_work_logs WHERE document_id=?").run(did).changes;
          const rep = this.db.prepare("DELETE FROM ops_work_reports WHERE document_id=?").run(did).changes;
          if (logs || rep) this.audit("work.removed", did, "Draft deleted", { logs, report: rep }, null);
        }
        return original.deleteDraft.call(this, did);
      });
    },
  });
}
