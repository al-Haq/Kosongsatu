import { encrypt, decrypt } from "./mfa.mjs";
import { now, check, text } from "./domain.mjs";
// Integration keys (SMTP, payment gateways, WhatsApp, MyInvois, storage) can be
// entered in Settings instead of server environment variables. Values are
// encrypted with the workspace key and are never returned to the browser.
// A server environment variable with the same name always takes precedence.
export const SECRET_MIGRATIONS = [
  {
    name: "core-002-secrets",
    sql: "CREATE TABLE secrets(name TEXT PRIMARY KEY, value TEXT NOT NULL, updated TEXT NOT NULL);",
  },
  {
    name: "core-003-event-cursors",
    sql: "CREATE TABLE event_cursors(consumer TEXT PRIMARY KEY, last_id INTEGER NOT NULL);",
  },
  {
    // Modules send more kinds of email (notifications, portal sign-in links,
    // password resets, reports), so the kind is no longer a fixed list.
    name: "core-004-email-kinds",
    foreignKeysOff: true,
    sql: `CREATE TABLE email_log_new(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 40),document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,recipients TEXT NOT NULL,subject TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('sending','sent','failed')),error TEXT,message_id TEXT,dedupe_key TEXT UNIQUE,created TEXT NOT NULL);
 INSERT INTO email_log_new SELECT id,kind,document_id,client_id,recipients,subject,status,error,message_id,dedupe_key,created FROM email_log;
 DROP TABLE email_log;
 ALTER TABLE email_log_new RENAME TO email_log;
 CREATE INDEX email_document_idx ON email_log(document_id);`,
  },
];
export function attachSecrets(Store) {
  Object.assign(Store.prototype, {
    // Environment first, then the encrypted value saved in Settings.
    config(name, env = process.env) {
      if (env[name] !== undefined && env[name] !== "") return env[name];
      return this.secret(name);
    },
    secret(name) {
      const row = this.db.prepare("SELECT value FROM secrets WHERE name=?").get(name);
      if (!row) return null;
      return decrypt(Buffer.from(row.value, "base64"), this.mfaKey).toString();
    },
    setSecret(name, value) {
      check(/^[A-Z][A-Z0-9_]{1,63}$/.test(name), "Invalid setting name.");
      if (value === null || value === "") {
        this.db.prepare("DELETE FROM secrets WHERE name=?").run(name);
        this.audit("secret.cleared", null, name);
        return;
      }
      value = text(String(value), 8000, true);
      this.db
        .prepare(
          "INSERT INTO secrets(name,value,updated) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated=excluded.updated",
        )
        .run(name, encrypt(value, this.mfaKey).toString("base64"), now());
      this.audit("secret.saved", null, name);
    },
    // Which settings are present, and where they come from. Never the values.
    secretStatus(names, env = process.env) {
      return names.map((n) => {
        const row = this.db.prepare("SELECT updated FROM secrets WHERE name=?").get(n);
        return {
          name: n,
          source: env[n] ? "server" : row ? "settings" : null,
          updated: row?.updated || null,
        };
      });
    },
    // Audit entries double as an event stream for notification and webhook modules.
    // A new consumer starts at the latest entry, so history is never replayed.
    auditSince(consumer, limit = 100) {
      let cursor = this.db
        .prepare("SELECT last_id FROM event_cursors WHERE consumer=?")
        .get(consumer)?.last_id;
      if (cursor === undefined) {
        cursor = this.db.prepare("SELECT COALESCE(max(id),0) n FROM audit").get().n;
        this.db.prepare("INSERT INTO event_cursors(consumer,last_id) VALUES(?,?)").run(consumer, cursor);
      }
      return this.db
        .prepare("SELECT * FROM audit WHERE id>? ORDER BY id LIMIT ?")
        .all(cursor, limit);
    },
    ackAudit(consumer, lastId) {
      this.db
        .prepare(
          "INSERT INTO event_cursors(consumer,last_id) VALUES(?,?) ON CONFLICT(consumer) DO UPDATE SET last_id=max(last_id,excluded.last_id)",
        )
        .run(consumer, lastId);
    },
    // Feature modules wrap this to add QR codes, signatures, photos or notes to
    // a document PDF. Each block: { heading, text?, qr?, image?, imageWidth? }.
    async pdfBlocks() {
      return [];
    },
  });
}
