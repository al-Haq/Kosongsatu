// Disposable workspace for browser tests: in-memory database, demo data and a
// known owner. Never use these credentials anywhere else.
import { openDatabase } from "../server/db.mjs";
import { createOwner } from "../server/auth.mjs";
import { createApp } from "../server/app.mjs";
import { seedDemo } from "../server/seed.mjs";
const port = Number(process.env.E2E_PORT || 4173);
const store = openDatabase(":memory:");
seedDemo(store);
store.saveSettings({
  registration: "202601000001 (E2E)",
  address: "Level 1, Test Tower, Kuala Lumpur",
  email: "billing@example.com",
  bankName: "Test Bank",
  bankAccount: "1234567890",
  bankHolder: "Nawlogic E2E",
});
await createOwner(store, "owner@example.com", "E2E-only-password-28");
const server = createApp({
  store,
  appUrl: `http://localhost:${port}`,
  mailConfig: null,
  gatewayConfig: null,
  assistantConfig: null,
});
server.listen(port, "127.0.0.1", () => console.log(`E2E workspace on http://localhost:${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
