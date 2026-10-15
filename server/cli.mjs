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
} else if (mode === "demo") {
  if (process.env.NODE_ENV === "production")
    throw new Error("Demo must not run in production.");
  const store = openDatabase("./data/demo.sqlite");
  const email = "demo@nawlogic.local";
  const password = randomBytes(18).toString("base64url");
  // Each demo run rotates the disposable demo owner password and invalidates sessions.
  store.db.prepare("DELETE FROM sessions").run();
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
