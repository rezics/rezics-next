import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { Database } from 'bun:sqlite';

/** One schema step owned by one module. A module's migrations must not reference another module's tables. */
export type Migration = { module: string; version: number; sql: string };

export const workspaceMigrations: readonly Migration[] = [
  {
    module: 'workspace',
    version: 1,
    sql: `
CREATE TABLE module_workspaces (module TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE workspace_owners (token TEXT PRIMARY KEY, module TEXT NOT NULL, task TEXT NOT NULL, attempt INTEGER NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL);
CREATE UNIQUE INDEX workspace_attempt ON workspace_owners(module, task, attempt);
CREATE INDEX workspace_active ON workspace_owners(module, state);
CREATE INDEX workspace_task_active ON workspace_owners(task, state);
CREATE TABLE workspace_operations (id TEXT PRIMARY KEY, module TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX workspace_pending_operations ON workspace_operations(module, state);
CREATE TABLE workspace_prepared (task TEXT NOT NULL, attempt INTEGER NOT NULL, module TEXT NOT NULL, source_commit TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task, attempt));
CREATE INDEX workspace_prepared_module ON workspace_prepared(module);
`,
  },
  {
    module: 'workspace',
    version: 2,
    sql: `DROP TABLE workspace_owners;
DROP TABLE workspace_operations;
DROP TABLE workspace_prepared;`,
  },
];

/** Opens the control-plane store: SQLite in WAL mode, independent of any product database. */
export function openDb(path: string, policy: ControlPolicy['storage'] = defaultPolicy.storage): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`PRAGMA busy_timeout = ${policy.sqliteBusyTimeoutMs}`);
  db.exec('PRAGMA journal_mode = WAL');
  // In WAL mode NORMAL survives a process crash and loses at most the last commits on power loss. FULL fsyncs every
  // commit, which costs 8.5 ms on the btrfs state directory against 0.12 ms.
  db.exec('PRAGMA synchronous = NORMAL');
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
