import { backup, DatabaseSync } from "node:sqlite";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  unlink,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { encrypt, decrypt, readKey } from "./mfa.mjs";
import { check, now } from "./domain.mjs";
export class BackupManager {
  constructor(store, { directory, key, keep = 7 } = {}) {
    this.store = store;
    this.directory = directory ? resolve(directory) : null;
    this.key = key ? readKey(key, "BACKUP_KEY") : null;
    this.keep = keep;
    this.running = false;
    this.lastSuccess = null;
    this.lastError = null;
  }
  status() {
    return {
      configured: !!(this.directory && this.key),
      running: this.running,
      lastSuccess: this.lastSuccess,
      lastError: this.lastError,
    };
  }
  async run() {
    check(
      this.directory && this.key,
      "Configure BACKUP_DIRECTORY and BACKUP_KEY on the server first.",
    );
    check(!this.running, "A backup is already running.", 409);
    this.running = true;
    const stamp = now().replace(/[:.]/g, "-"),
      base = `nawlogic-${stamp}`;
    let tempDir;
    const output = resolve(this.directory, base + ".nwlbackup");
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      tempDir = await mkdtemp(resolve(this.directory, ".backup-"));
      const temp = resolve(tempDir, "snapshot.sqlite");
      await backup(this.store.db, temp);
      const encrypted = encrypt(await readFile(temp), this.key);
      await writeFile(output, encrypted, { mode: 0o600, flag: "wx" });
      await unlink(temp);
      this.lastSuccess = now();
      this.lastError = null;
      this.store.audit("backup.created", null, basename(output));
      const files = (await readdir(this.directory))
        .filter((f) => /^nawlogic-.*\.nwlbackup$/.test(f))
        .sort()
        .reverse();
      for (const old of files.slice(this.keep))
        await unlink(resolve(this.directory, old));
      return {
        filename: basename(output),
        bytes: encrypted.length,
        created: this.lastSuccess,
      };
    } catch (e) {
      this.lastError =
        "Backup failed. Check server storage and encryption configuration.";
      throw e;
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
      this.running = false;
    }
  }
  start() {
    if (!this.status().configured) return;
    const run = () =>
      this.run().catch(() =>
        console.error("Scheduled backup failed. Check storage/configuration."),
      );
    run();
    this.timer = setInterval(run, 24 * 3600000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
export async function restoreBackup(input, output, key) {
  const bytes = decrypt(await readFile(input), readKey(key, "BACKUP_KEY"));
  check(
    bytes.subarray(0, 16).toString() === "SQLite format 3\0",
    "Backup is not a SQLite database.",
  );
  // The target must be NEW. Never overwrite a running or existing database.
  await mkdir(dirname(resolve(output)), { recursive: true, mode: 0o700 });
  await writeFile(output, bytes, { mode: 0o600, flag: "wx" });
  let db;
  try {
    db = new DatabaseSync(output);
    check(
      db.prepare("PRAGMA integrity_check").get().integrity_check === "ok",
      "Backup integrity check failed.",
    );
    check(
      db.prepare("PRAGMA foreign_key_check").all().length === 0,
      "Backup foreign-key check failed.",
    );
    db.exec(
      "BEGIN IMMEDIATE;DELETE FROM sessions;UPDATE documents SET token_hash=NULL,token_expires=NULL;COMMIT",
    );
    db.close();
    return {
      path: resolve(output),
      sessionsRevoked: true,
      clientLinksRevoked: true,
    };
  } catch (e) {
    db?.close();
    await unlink(output).catch(() => {});
    throw e;
  }
}
