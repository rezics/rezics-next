import { Database } from 'bun:sqlite';

/** One schema step owned by one module. A module's migrations must not reference another module's tables. */
export type Migration = { module: string; version: number; sql: string };

/** Opens the control-plane store: SQLite in WAL mode, independent of any product database. */
export function openDb(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (module TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (module, version))',
  );
  return db;
}

/** Applies each module's migrations once, in version order, in one transaction. */
export function migrate(db: Database, migrations: readonly Migration[]): void {
  const applied = db.query('SELECT 1 FROM schema_migrations WHERE module = ? AND version = ?');
  const record = db.query('INSERT INTO schema_migrations (module, version) VALUES (?, ?)');
  const ordered = [...migrations].sort((a, b) => a.module.localeCompare(b.module) || a.version - b.version);
  db.transaction(() => {
    for (const step of ordered) {
      if (applied.get(step.module, step.version)) continue;
      db.exec(step.sql);
      record.run(step.module, step.version);
    }
  }).immediate();
}
