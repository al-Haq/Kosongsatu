// Console commands for the team module (see docs/features/team.md):
//   node server/cli.mjs audit-verify [<id> <hash>]   verify the audit chain (and a recorded head)
//   node server/cli.mjs audit-head                   print the current chain head
//   node server/cli.mjs remote-backups               list off-site backup copies
//   node server/cli.mjs fetch-backup <file> <out>    download one off-site copy
//   node server/cli.mjs add-user <email> [owner|staff|accountant] [name]
//                                                    add an active user with a generated password
//   node server/cli.mjs set-email <current email> <new email>
//                                                    change a user's sign-in email
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
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

// Storage settings, each one from the environment first and otherwise from the
// database's saved integration keys, like the running app. Without a readable
// database (e.g. restoring on a new server) the environment alone is used.
export async function remoteBackups() {
  const env = (n) => process.env[n] || null;
  const envOnly = () => {
    if (!storageConfig(env))
      throw new Error("Set BACKUP_S3_BUCKET, BACKUP_S3_REGION, BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY (and BACKUP_S3_ENDPOINT for non-AWS storage).");
    return { remote: new RemoteBackups({ config: env, db: null }), close() {} };
  };
  if (!existsSync(databasePath())) return envOnly();
  const { openDatabase } = await import("./db.mjs");
  let store;
  try {
    store = openDatabase(databasePath());
  } catch (e) {
    // e.g. the MFA key file is missing; fall back to the environment if it is complete.
    if (storageConfig(env)) return envOnly();
    throw e;
  }
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
  if (mode === "set-email") {
    const [from, to] = args;
    if (!from || !to) throw new Error("Use: node server/cli.mjs set-email <current email> <new email>");
    if (!existsSync(databasePath())) throw new Error(`Database not found at ${databasePath()}. Set DATABASE_PATH.`);
    const { openDatabase } = await import("./db.mjs");
    const { requestContext } = await import("./context.mjs");
    const store = openDatabase(databasePath());
    try {
      const u = store.db.prepare("SELECT id FROM owners WHERE email=?").get(String(from).trim().toLowerCase());
      if (!u) throw new Error("No user with that email. No changes made.");
      const out = requestContext.run({ actor: "local-console" }, () => store.updateUser(u.id, { email: to }, null));
      console.log(`Sign-in email changed to ${out.email}. The password, MFA and role are unchanged.`);
      return 0;
    } finally {
      store.db.close();
    }
  }
  if (mode === "add-user") {
    const [email, role = "staff", ...name] = args;
    if (!email) throw new Error("Use: node server/cli.mjs add-user <email> [owner|staff|accountant] [name]");
    if (!existsSync(databasePath())) throw new Error(`Database not found at ${databasePath()}. Set DATABASE_PATH.`);
    const { openDatabase } = await import("./db.mjs");
    const { passwordHash } = await import("./auth.mjs");
    const { requestContext } = await import("./context.mjs");
    const store = openDatabase(databasePath());
    try {
      // A generated password avoids terminal echo and shell history exposure.
      const password = process.env.ADMIN_PASSWORD || randomBytes(18).toString("base64url");
      const u = await requestContext.run({ actor: "local-console" }, () =>
        store.createUser({ email, role, name: name.join(" ") }, password, passwordHash),
      );
      console.log(`User created: ${u.email} (${u.role}).`);
      if (process.env.ADMIN_PASSWORD) console.log("(Password supplied through ADMIN_PASSWORD; not displayed.)");
      else console.log("Password (shown once, save it privately):\n" + password);
      console.log("Sign in and change the password.");
      return 0;
    } finally {
      store.db.close();
    }
  }
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
