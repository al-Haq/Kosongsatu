import { DatabaseSync } from "node:sqlite";
import { passwordHash } from "./auth.mjs";
import { BackupManager, restoreBackup } from "./recovery.mjs";
import { requestContext } from "./context.mjs";
import { now } from "./domain.mjs";
import { openDatabase } from "./db.mjs";
import { createOwner } from "./auth.mjs";
import { seedDemo } from "./seed.mjs";
import { createApp } from "./app.mjs";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
const mode = process.argv[2];
if (mode === "setup") {
  const store = openDatabase(
    process.env.DATABASE_PATH || "./data/nawlogic.sqlite",
  );
  try {
    if (store.db.prepare("SELECT id FROM owners LIMIT 1").get())
      throw new Error(
        "Owner already exists. Change the password from Settings.",
      );
    const rl = createInterface({ input: stdin, output: stdout });
    const email =
      process.env.ADMIN_EMAIL || (await rl.question("Owner email: "));
    // A generated password avoids terminal echo and shell history exposure.
    const password =
      process.env.ADMIN_PASSWORD || randomBytes(18).toString("base64url");
    await createOwner(store, email, password);
    rl.close();
    console.log("Owner created. Save this password in your password manager:");
    if (!process.env.ADMIN_PASSWORD) console.log(password);
    else
      console.log("(Password supplied through ADMIN_PASSWORD; not displayed.)");
    console.log(
      "Start with npm start. Change your password in Settings after signing in.",
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  } finally {
    store.db.close();
  }
} else if (mode === "backup") {
  const store = openDatabase(
    process.env.DATABASE_PATH || "./data/nawlogic.sqlite",
  );
  try {
    console.log(
      await new BackupManager(store, {
        directory: process.env.BACKUP_DIRECTORY,
        key: process.env.BACKUP_KEY,
      }).run(),
    );
  } finally {
    store.db.close();
  }
} else if (mode === "restore") {
  const input = process.argv[3],
    output = process.argv[4];
  if (!input || !output)
    throw new Error(
      "Usage: npm run restore -- backup.nwlbackup NEW-database.sqlite",
    );
  console.log(await restoreBackup(input, output, process.env.BACKUP_KEY));
} else if (mode === "recover") {
  const path = process.env.DATABASE_PATH || "./data/nawlogic.sqlite";
  const db = new DatabaseSync(path);
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const owner = db.prepare("SELECT * FROM owners LIMIT 1").get();
    if (!owner) throw new Error("Owner not found.");
    const answer = await rl.question(
      "Console recovery resets owner password, disables MFA and revokes sessions. Type the owner email to confirm: ",
    );
    if (answer.trim().toLowerCase() !== owner.email)
      throw new Error("Owner email did not match. No changes made.");
    const password = randomBytes(18).toString("base64url");
    const hashed = await passwordHash(password);
    db.exec("PRAGMA foreign_keys=ON;BEGIN IMMEDIATE");
    try {
      db.prepare(
        "UPDATE owners SET password=?,mfa_secret=NULL,mfa_pending=NULL,mfa_pending_expires=NULL,mfa_step=-1 WHERE id=?",
      ).run(hashed, owner.id);
      db.prepare("DELETE FROM sessions WHERE owner_id=?").run(owner.id);
      db.prepare("DELETE FROM recovery_codes WHERE owner_id=?").run(owner.id);
      if (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='integration_tokens'",
          )
          .get()
      )
        db.exec(
          "UPDATE integration_tokens SET revoked=1;UPDATE automation_rules SET enabled=0",
        );
      db.prepare(
        "INSERT INTO audit(action,entity_id,detail,created,actor) VALUES('owner.console_recovery',?,'Password reset; MFA disabled; sessions revoked',?,'local-console')",
      ).run(String(owner.id), now());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    console.log(
      "New one-time generated password (save privately):\n" +
        password +
        "\nSign in, change it, then re-enrol MFA.",
    );
  } finally {
    rl.close();
    db.close();
  }
} else if (mode === "demo") {
  if (process.env.NODE_ENV === "production")
    throw new Error("Demo must not run in production.");
  const store = openDatabase("./data/demo.sqlite");
  const email = "demo@nawlogic.local";
  const password = randomBytes(18).toString("base64url");
  // Each demo run rotates the disposable demo owner password and invalidates sessions.
  store.db.prepare("DELETE FROM sessions").run();
  store.db.prepare("DELETE FROM recovery_codes").run();
  store.db.prepare("DELETE FROM assistant_runs").run();
  store.db.prepare("UPDATE integration_tokens SET revoked=1").run();
  store.db.prepare("DELETE FROM owners").run();
  await createOwner(store, email, password);
  seedDemo(store);
  const port = Number(process.env.PORT || 3000);
  const appUrl = `http://localhost:${port}`;
  const server = createApp({ store, appUrl });
  server.listen(port, "127.0.0.1", () => {
    console.log(
      `Local demo: ${appUrl}\nEmail: ${email}\nTemporary password: ${password}\nDemo data persists separately in data/demo.sqlite. No real payments are connected.`,
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () =>
      server.close(() => {
        store.db.close();
        process.exit(0);
      }),
    );
} else {
  console.error("Use npm run setup or npm run demo.");
  process.exitCode = 1;
}
