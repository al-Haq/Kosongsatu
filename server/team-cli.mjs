// Console commands for the team module (see docs/features/team.md):
//   node server/cli.mjs audit-verify [<id> <hash>]   verify the audit chain (and a recorded head)
//   node server/cli.mjs audit-head                   print the current chain head
//   node server/cli.mjs remote-backups               list off-site backup copies
//   node server/cli.mjs fetch-backup <file> <out>    download one off-site copy
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { verifyAuditChain, chainHead } from "./team-audit.mjs";
import { RemoteBackups, saveDownloaded } from "./team-backup.mjs";
import { storageConfig } from "./team-s3.mjs";

const databasePath = () => process.env.DATABASE_PATH || "./data/nawlogic.sqlite";

// Opens the database read-only: verifying needs no keys and changes nothing.
function readOnly() {
  const path = databasePath();
  if (!existsSync(path)) throw new Error(`Database not found at ${path}. Set DATABASE_PATH.`);
  return new DatabaseSync(path, { readOnly: true });
}

// Storage settings from the environment, or from the database's saved
// integration keys when it is available (needs its MFA key file).
async function remoteBackups() {
  const fromEnv = storageConfig((n) => process.env[n] || null);
  if (fromEnv || !existsSync(databasePath())) {
    if (!fromEnv)
      throw new Error("Set BACKUP_S3_BUCKET, BACKUP_S3_REGION, BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY (and BACKUP_S3_ENDPOINT for non-AWS storage).");
    return { remote: new RemoteBackups({ config: (n) => process.env[n] || null, db: null }), close() {} };
  }
  const { openDatabase } = await import("./db.mjs");
  const store = openDatabase(databasePath());
  return { remote: new RemoteBackups(store), close: () => store.db.close() };
}

// Prints a plain message instead of a stack trace and returns the exit code.
export async function runTeamCli(mode, args) {
  try {
    return await run(mode, args);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}

async function run(mode, args) {
  if (mode === "audit-verify" || mode === "audit-head") {
    const db = readOnly();
    try {
      if (mode === "audit-head") {
        console.log(JSON.stringify(chainHead(db), null, 2));
        return 0;
      }
      const expect = args[0] ? { id: args[0], hash: args[1] || "" } : null;
      const r = verifyAuditChain(db, expect);
      if (r.ok) {
        console.log(`Audit chain OK: ${r.checked} entries verified.`);
        console.log(`Head: entry ${r.head.id} ${r.head.hash} (${r.head.created || "empty"})`);
        if (r.recorded) console.log(`Recorded head entry ${r.recorded.id} matches.`);
        if (r.unsealed) console.log(`${r.unsealed} newest entries are not sealed yet; they are sealed with the next change.`);
        return 0;
      }
      console.error("Audit chain BROKEN: " + r.reason);
      if (r.broken) console.error(`First bad entry: ${r.broken.id} (${r.broken.action}, ${r.broken.created}). ${r.checked} entries before it verified.`);
      return 1;
    } finally {
      db.close();
    }
  }
  if (mode === "remote-backups" || mode === "fetch-backup") {
    const { remote, close } = await remoteBackups();
    try {
      if (mode === "remote-backups") {
        for (const o of await remote.list()) console.log(`${o.filename}\t${o.size} bytes\t${o.modified || ""}`);
        return 0;
      }
      const [filename, output] = args;
      if (!filename || !output) throw new Error("Usage: node server/cli.mjs fetch-backup <nawlogic-....nwlbackup> <output-file>");
      const saved = await saveDownloaded(await remote.download(filename), output);
      console.log(`Saved ${saved.bytes} bytes to ${saved.path}. Restore it with: npm run restore -- ${output} NEW-database.sqlite (needs the original BACKUP_KEY).`);
      return 0;
    } finally {
      close();
    }
  }
  throw new Error("Unknown command.");
}
