// Feature modules. Each one owns its tables, Store methods, routes, jobs and
// Settings keys, so features can be built and reviewed independently.
// The contract is described in docs/PLUGINS.md.
import documents from "./ext/documents.mjs";
import recurring from "./ext/recurring.mjs";
import tax from "./ext/tax.mjs";
import payments from "./ext/payments.mjs";
import comms from "./ext/comms.mjs";
import portal from "./ext/portal.mjs";
import books from "./ext/books.mjs";
import ops from "./ext/ops.mjs";
import team from "./ext/team.mjs";
import platform from "./ext/platform.mjs";
import setup from "./ext/setup.mjs";
import trash from "./ext/trash.mjs";
import { runMigrations } from "./migrate.mjs";
import { FILE_MIGRATIONS, attachFiles } from "./files.mjs";
import { SECRET_MIGRATIONS, attachSecrets } from "./secrets.mjs";
export const PLUGINS = [
  documents,
  recurring,
  tax,
  payments,
  comms,
  portal,
  books,
  ops,
  team,
  platform,
  setup,
  // Last: its delete wrappers must sit outside every other module's.
  trash,
];
for (const p of PLUGINS)
  for (const m of p.migrations || [])
    if (!m.name.startsWith(p.name + "-"))
      throw new Error(`Migration ${m.name} must start with "${p.name}-".`);
export function migratePlugins(db, path) {
  return runMigrations(db, path, [
    ...FILE_MIGRATIONS,
    ...SECRET_MIGRATIONS,
    ...PLUGINS.flatMap((p) => p.migrations || []),
  ]);
}
export function attachPlugins(Store) {
  attachFiles(Store);
  attachSecrets(Store);
  for (const p of PLUGINS) p.attach?.(Store);
}
// Settings keys a module accepts: [{ name: "SMTP_HOST", label, help, plugin }].
export const SECRETS = PLUGINS.flatMap((p) =>
  (p.secrets || []).map((s) => ({ ...s, plugin: p.name })),
);
export const JOBS = PLUGINS.flatMap((p) =>
  (p.jobs || []).map((j) => ({ ...j, name: `${p.name}:${j.name}` })),
);
