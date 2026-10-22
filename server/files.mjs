import { createHash } from "node:crypto";
import { id, now, check, text } from "./domain.mjs";
import { requestContext } from "./context.mjs";
// Stored files (logos, payment slips, PO scans, receipts, work photos).
// Files live inside the database so encrypted backups and restores include them.
export const FILE_MIGRATIONS = [
  {
    name: "core-001-files",
    sql: `CREATE TABLE files(
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size>0),
  sha256 TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','client')),
  data BLOB NOT NULL,
  created_by TEXT NOT NULL,
  created TEXT NOT NULL
 );
 CREATE INDEX files_entity_idx ON files(entity_type,entity_id,purpose);`,
  },
];
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
// The type is decided by the file's first bytes, never by the name or the browser.
export function sniff(data) {
  const b = Buffer.from(data);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP")
    return "image/webp";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}
export const FILE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};
const meta = ({ data, ...row }) => row;
export function attachFiles(Store) {
  // Deleting a record also deletes its files, inside the same transaction.
  for (const name of ["deleteDraft", "deleteClient", "deleteService", "deleteSchedule", "deleteOpportunity"]) {
    const original = Store.prototype[name];
    if (!original) continue;
    Store.prototype[name] = function (entityId, ...rest) {
      return this.tx(() => {
        const out = original.call(this, entityId, ...rest);
        this.deleteFilesFor(entityId);
        return out;
      });
    };
  }
  Object.assign(Store.prototype, {
    // Saves an uploaded file for one record. `accept` limits the allowed types,
    // e.g. ["image/png","image/jpeg"] for a logo.
    saveFile(b, { accept = Object.keys(FILE_EXTENSIONS), maxBytes = MAX_FILE_BYTES } = {}) {
      const data = Buffer.from(b.data || []);
      check(data.length > 0, "Choose a file to upload.");
      check(data.length <= maxBytes, `Files must be ${Math.floor(maxBytes / 1048576)} MB or smaller.`, 413);
      const mime = sniff(data);
      check(mime && accept.includes(mime), "Upload a PNG, JPEG, WEBP, GIF or PDF file of an allowed type.", 415);
      check(/^[a-z][a-z_]{1,29}$/.test(b.entity_type || ""), "Invalid file owner type.");
      check(/^[\w-]{1,80}$/.test(b.entity_id || ""), "Invalid file owner.");
      check(/^[a-z][a-z_]{1,29}$/.test(b.purpose || ""), "Invalid file purpose.");
      check(["private", "client"].includes(b.visibility || "private"), "Invalid file visibility.");
      const base = text(String(b.name || "upload").replace(/[\\/]/g, "_"), 120) || "upload";
      const name = base.replace(/\.[A-Za-z0-9]{1,5}$/, "") + "." + FILE_EXTENSIONS[mime];
      const row = {
        id: id(),
        entity_type: b.entity_type,
        entity_id: b.entity_id,
        purpose: b.purpose,
        name,
        mime,
        size: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        visibility: b.visibility || "private",
        data,
        created_by: requestContext.getStore()?.actor || "system",
        created: now(),
      };
      this.db
        .prepare(
          "INSERT INTO files(id,entity_type,entity_id,purpose,name,mime,size,sha256,visibility,data,created_by,created) VALUES(:id,:entity_type,:entity_id,:purpose,:name,:mime,:size,:sha256,:visibility,:data,:created_by,:created)",
        )
        .run(row);
      this.audit("file.uploaded", b.entity_id, `${b.purpose}: ${name}`, null, meta(row));
      return meta(row);
    },
    files(entity_type, entity_id, purpose = null) {
      return this.db
        .prepare(
          `SELECT id,entity_type,entity_id,purpose,name,mime,size,sha256,visibility,created_by,created FROM files WHERE entity_type=? AND entity_id=? ${purpose ? "AND purpose=?" : ""} ORDER BY created,id`,
        )
        .all(...[entity_type, entity_id, ...(purpose ? [purpose] : [])]);
    },
    file(fid) {
      const f = this.db.prepare("SELECT * FROM files WHERE id=?").get(fid);
      check(f, "File not found.", 404);
      return { ...f, data: Buffer.from(f.data) };
    },
    // Removes every file attached to a record that is being deleted.
    // Record ids are UUIDs, so the id alone identifies the owner.
    deleteFilesFor(entityId) {
      const rows = this.db
        .prepare("SELECT id,purpose,name FROM files WHERE entity_id=?")
        .all(entityId);
      if (!rows.length) return 0;
      this.db.prepare("DELETE FROM files WHERE entity_id=?").run(entityId);
      this.audit("file.deleted", entityId, `${rows.length} attached file(s) removed with the record`);
      return rows.length;
    },
    // A file the user deletes (DELETE /api/files/:id). Kept in Recently deleted.
    removeFile(fid) {
      return this.deleteFile(fid);
    },
    deleteFile(fid) {
      const f = this.file(fid);
      this.db.prepare("DELETE FROM files WHERE id=?").run(fid);
      this.audit("file.deleted", f.entity_id, `${f.purpose}: ${f.name}`, meta(f), null);
    },
  });
}
