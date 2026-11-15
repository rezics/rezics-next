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
  let db: Database;
  try { db = new Database(path, { create: true, strict: true }); }
  catch (error) { return databaseFailure(path, 'open control store', error); }
  try {
  configureDatabaseBusyTimeout(db, policy);
  databaseStage(db, 'journal initialization', () => {
    const current = db.query('PRAGMA journal_mode').get() as { journal_mode: string };
    if (current.journal_mode !== 'wal') db.exec('PRAGMA journal_mode = WAL');
  });
  // In WAL mode NORMAL survives a process crash and loses at most the last commits on power loss. FULL fsyncs every
  // commit, which costs 8.5 ms on the btrfs state directory against 0.12 ms.
  databaseStage(db, 'connection pragmas', () => {
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
  });
  databaseStage(db, 'schema bootstrap', () => {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get())
      db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (module TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (module, version))');
  });
  return db;
  } catch (error) { db.close(); throw error; }
}

/** Side connections use the same bounded engine busy handling; no caller-level retry loop. */
export function configureDatabaseBusyTimeout(db: Database, policy: ControlPolicy['storage'] = defaultPolicy.storage): void {
  databaseStage(db, 'busy timeout initialization', () => db.exec(`PRAGMA busy_timeout = ${policy.sqliteBusyTimeoutMs}`));
}

export function openReadOnlyDb(path: string, policy: ControlPolicy['storage'] = defaultPolicy.storage): Database {
  let db: Database;
  try { db = new Database(path, { readonly: true, strict: true }); }
  catch (error) { return databaseFailure(path, 'open read-only connection', error); }
  try { configureDatabaseBusyTimeout(db, policy); return db; }
  catch (error) { db.close(); throw error; }
}

/** Keep the database and operation in terminal diagnostics instead of losing the failing owner frame. */
export function databaseStage<T>(db: Database, stage: string, work: () => T): T {
  try { return work(); }
  catch (error) { return databaseFailure(db.filename, stage, error); }
}

function databaseFailure(path: string, stage: string, error: unknown): never {
    if (!(error instanceof Error) || error.name !== 'SQLiteError') throw error;
    const contextual = new Error(`SQLite ${path} [${stage}]: ${error.message}`, { cause: error });
    for (const field of ['code', 'errno', 'byteOffset'] as const)
      if (field in error) Object.assign(contextual, { [field]: (error as unknown as Record<string, unknown>)[field] });
    contextual.name = error.name;
    throw contextual;
}

/** Applies each module's migrations once, in version order, in one transaction. */
export function migrate(db: Database, migrations: readonly Migration[]): void {
  const applied = db.query('SELECT 1 FROM schema_migrations WHERE module = ? AND version = ?');
  const record = db.query('INSERT INTO schema_migrations (module, version) VALUES (?, ?)');
  const ordered = [...migrations].sort((a, b) => a.module.localeCompare(b.module) || a.version - b.version);
  // Hot command/read paths must not reserve the single writer merely to confirm an unchanged schema.
  const pending = databaseStage(db, 'migration lookup', () => ordered.filter((step) => !applied.get(step.module, step.version)));
  if (!pending.length) return;
  databaseStage(db, `migrate ${pending.map((step) => `${step.module}@${step.version}`).join(',')}`, () => db.transaction(() => {
    for (const step of pending) {
      if (applied.get(step.module, step.version)) continue;
      db.exec(step.sql);
      record.run(step.module, step.version);
    }
  }).immediate());
}
