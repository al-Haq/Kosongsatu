// Backups configured from Settings, and off-site copies on S3-compatible storage.
// The encrypted .nwlbackup file is uploaded after each local backup; the storage
// provider only ever sees ciphertext. Without the backup key a copy cannot be
// restored, by anyone.
import { randomBytes } from "node:crypto";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { BackupManager } from "./recovery.mjs";
import { readKey } from "./mfa.mjs";
import { now, check, AppError } from "./domain.mjs";
import { S3Client, storageConfig, objectLocation } from "./team-s3.mjs";

export const BACKUP_MIGRATION = `
CREATE TABLE team_backup_uploads(id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, object_key TEXT, bytes INTEGER, status TEXT NOT NULL CHECK(status IN ('uploaded','failed')), error TEXT, created TEXT NOT NULL);
CREATE TABLE team_state(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated TEXT NOT NULL);
`;
const BACKUP_FILE = /^nawlogic-[\w.-]+\.nwlbackup$/;

// Fills in the backup key and directory saved in Settings when the server
// environment does not set them. The environment always wins.
export function configureBackups(manager, store = manager.store) {
  if (!store?.db?.isOpen) return manager;
  if (!manager.key) {
    const saved = store.secret?.("BACKUP_KEY");
    if (saved) {
      manager.key = readKey(saved, "BACKUP_KEY");
      manager.keySource = "app";
    }
  } else manager.keySource ||= "server";
  if (!manager.directory && manager.key && store.path && store.path !== ":memory:") {
    manager.directory = resolve(dirname(store.path), "backups");
    manager.directorySource = "default";
  } else if (manager.directory) manager.directorySource ||= "server";
  return manager;
}

const state = (db, key) => {
  const row = db.prepare("SELECT value FROM team_state WHERE key=?").get(key);
  return row ? JSON.parse(row.value) : null;
};
const setState = (db, key, value) =>
  db
    .prepare("INSERT INTO team_state(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated")
    .run(key, JSON.stringify(value), now());

export class RemoteBackups {
  constructor(store, { fetch, clock } = {}) {
    this.store = store;
    this.fetch = fetch || ((...a) => globalThis.fetch(...a));
    this.clock = clock || (() => new Date());
    this.running = false;
  }
  config() {
    return storageConfig((n) => this.store.config(n));
  }
  configured() {
    try {
      return !!this.config();
    } catch {
      return false;
    }
  }
  client() {
    const cfg = this.config();
    check(cfg, "Off-site storage is not set up. Add the bucket and access keys under Integration keys.", 409);
    return new S3Client(cfg, { fetch: this.fetch, now: this.clock });
  }
  status() {
    let cfg = null,
      error = null;
    try {
      cfg = this.config();
    } catch (e) {
      error = e.message;
    }
    const last = this.store.db.prepare("SELECT * FROM team_backup_uploads ORDER BY id DESC LIMIT 1").get() || null;
    const lastOk = this.store.db.prepare("SELECT * FROM team_backup_uploads WHERE status='uploaded' ORDER BY id DESC LIMIT 1").get() || null;
    return {
      configured: !!cfg,
      configError: error,
      provider: cfg ? (cfg.endpoint ? new URL(cfg.endpoint).host : "AWS S3") : null,
      location: cfg ? objectLocation(cfg).origin + objectLocation(cfg).path.replace(/\/$/, "") + "/" + cfg.prefix : null,
      bucket: cfg?.bucket || null,
      region: cfg?.region || null,
      prefix: cfg?.prefix ?? null,
      keep: cfg?.keep ?? null,
      lastAttempt: last,
      lastUpload: lastOk,
      lastTest: state(this.store.db, "backup.remote.test"),
      running: this.running,
    };
  }
  // Uploads one encrypted backup file, then removes remote copies beyond the
  // retention count. Only files named like Nawlogic backups are ever deleted.
  async upload(file) {
    const filename = basename(file);
    check(BACKUP_FILE.test(filename), "Only .nwlbackup files can be uploaded.");
    check(!this.running, "An off-site upload is already running.", 409);
    this.running = true;
    const db = this.store.db;
    try {
      const s3 = this.client();
      const cfg = s3.cfg;
      const body = await readFile(file);
      check(body.subarray(0, 4).toString() === "NWL2", "Refusing to upload a file that is not an encrypted backup.");
      const key = cfg.prefix + filename;
      await s3.put(key, body);
      db.prepare("INSERT INTO team_backup_uploads(filename,object_key,bytes,status,created) VALUES(?,?,?,'uploaded',?)").run(
        filename,
        key,
        body.length,
        now(),
      );
      this.store.audit("backup.uploaded", null, `${filename} → ${cfg.endpoint ? new URL(cfg.endpoint).host : "AWS S3"}/${cfg.bucket}`);
      let removed = [];
      try {
        removed = await this.prune(s3);
      } catch (e) {
        setState(db, "backup.remote.prune", { error: e.message, at: now() });
      }
      return { status: "uploaded", key, bytes: body.length, removed };
    } catch (e) {
      const message = e instanceof AppError ? e.message : "Off-site upload failed. Check the storage settings.";
      db.prepare("INSERT INTO team_backup_uploads(filename,status,error,created) VALUES(?,'failed',?,?)").run(filename, message, now());
      this.store.audit("backup.upload_failed", null, `${filename}: ${message}`);
      throw e instanceof AppError ? e : new AppError(message, 502);
    } finally {
      this.running = false;
    }
  }
  async prune(s3 = this.client()) {
    const cfg = s3.cfg;
    const copies = (await s3.list(cfg.prefix))
      .filter((o) => o.key.startsWith(cfg.prefix) && BACKUP_FILE.test(o.key.slice(cfg.prefix.length)))
      .sort((a, b) => (a.key < b.key ? 1 : -1));
    const removed = [];
    for (const old of copies.slice(cfg.keep)) {
      await s3.delete(old.key);
      removed.push(old.key);
    }
    if (removed.length) this.store.audit("backup.remote_pruned", null, `${removed.length} old off-site copies removed (keeping ${cfg.keep})`);
    return removed;
  }
  async list() {
    const s3 = this.client();
    return (await s3.list(s3.cfg.prefix))
      .filter((o) => BACKUP_FILE.test(o.key.slice(s3.cfg.prefix.length)))
      .sort((a, b) => (a.key < b.key ? 1 : -1))
      .map((o) => ({ ...o, filename: o.key.slice(s3.cfg.prefix.length) }));
  }
  async download(filename) {
    check(BACKUP_FILE.test(filename), "Give a backup file name such as nawlogic-2026-10-17T....nwlbackup.");
    const s3 = this.client();
    return s3.get(s3.cfg.prefix + filename);
  }
  // Writes, reads back, lists and deletes a small test object.
  async test() {
    const s3 = this.client();
    const key = s3.cfg.prefix + "nawlogic-connection-test.txt";
    const body = Buffer.from(`Nawlogic off-site backup test ${now()} ${randomBytes(6).toString("hex")}\n`);
    const started = Date.now();
    let step = "upload";
    try {
      await s3.put(key, body, "text/plain; charset=utf-8");
      step = "download";
      const back = await s3.get(key);
      check(back.equals(body), "The test file came back different from what was uploaded.", 502);
      step = "list";
      await s3.list(s3.cfg.prefix);
      step = "delete";
      await s3.delete(key);
      const result = { ok: true, at: now(), ms: Date.now() - started };
      setState(this.store.db, "backup.remote.test", result);
      this.store.audit("backup.remote_tested", null, "Upload, download, list and delete succeeded.");
      return result;
    } catch (e) {
      const result = {
        ok: false,
        at: now(),
        step,
        error: e instanceof AppError ? e.message : "The connection test failed.",
      };
      setState(this.store.db, "backup.remote.test", result);
      return result;
    }
  }
}

// After each local backup, upload it off-site. A failed upload never fails the
// local backup; it is recorded and shown in Settings.
let attached = false;
export function attachBackups() {
  if (attached) return;
  attached = true;
  const run = BackupManager.prototype.run,
    status = BackupManager.prototype.status,
    start = BackupManager.prototype.start;
  BackupManager.prototype.run = async function () {
    configureBackups(this);
    const out = await run.call(this);
    const remote = (this.remote ||= new RemoteBackups(this.store));
    if (remote.configured()) {
      try {
        const r = await remote.upload(resolve(this.directory, out.filename));
        out.remote = { status: "uploaded", key: r.key, removed: r.removed.length };
      } catch (e) {
        out.remote = { status: "failed", error: e.message };
      }
    }
    return out;
  };
  BackupManager.prototype.status = function () {
    configureBackups(this);
    return { ...status.call(this), keySource: this.keySource || null, offsite: !!this.remote?.configured() };
  };
  BackupManager.prototype.start = function () {
    this.startRequested = true;
    configureBackups(this);
    if (this.timer) return;
    return start.call(this);
  };
}

// The newest local backup file, for "upload again" after a failed upload.
export async function latestLocalBackup(manager) {
  if (!manager.directory) return null;
  let files;
  try {
    files = (await readdir(manager.directory)).filter((f) => BACKUP_FILE.test(f)).sort().reverse();
  } catch {
    return null;
  }
  if (!files.length) return null;
  const file = resolve(manager.directory, files[0]);
  return { filename: files[0], path: file, bytes: (await stat(file)).size };
}

export async function saveDownloaded(bytes, output) {
  check(bytes.subarray(0, 4).toString() === "NWL2", "The downloaded file is not a Nawlogic encrypted backup.");
  await writeFile(output, bytes, { mode: 0o600, flag: "wx" });
  return { path: resolve(output), bytes: bytes.length };
}
