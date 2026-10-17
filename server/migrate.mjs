import { chmodSync } from "node:fs";
// Named migrations for feature modules. Each migration runs once, in order,
// inside its own transaction, and is recorded by name in schema_migrations.
// Unlike PRAGMA user_version, independent modules never compete for a number.
//
// A migration is { name, sql } or { name, up(db) }. Set foreignKeysOff: true
// for a table rebuild; foreign keys are checked again before it commits.
export function runMigrations(db, path, migrations) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied TEXT NOT NULL)",
  );
  const done = new Set(
    db
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((r) => r.name),
  );
  const pending = migrations.filter((m) => !done.has(m.name));
  if (!pending.length) return [];
  const names = new Set();
  for (const m of migrations) {
    if (names.has(m.name)) throw new Error(`Duplicate migration ${m.name}`);
    names.add(m.name);
  }
  // One private, recoverable snapshot precedes a batch of data migrations.
  if (
    path !== ":memory:" &&
    db.prepare("SELECT count(*) n FROM documents").get().n
  ) {
    const snapshot = `${path}.pre-${pending[0].name}-${Date.now()}.sqlite`;
    db.prepare("VACUUM INTO ?").run(snapshot);
    chmodSync(snapshot, 0o600);
  }
  for (const m of pending) {
    if (m.foreignKeysOff) db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (m.sql) db.exec(m.sql);
      if (m.up) m.up(db);
      if (m.foreignKeysOff) {
        const broken = db.prepare("PRAGMA foreign_key_check").all();
        if (broken.length)
          throw new Error(`Migration ${m.name} broke ${broken.length} references.`);
      }
      db.prepare("INSERT INTO schema_migrations(name,applied) VALUES(?,?)").run(
        m.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    } finally {
      if (m.foreignKeysOff) db.exec("PRAGMA foreign_keys=ON");
    }
  }
  return pending.map((m) => m.name);
}
