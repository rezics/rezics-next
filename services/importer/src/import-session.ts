import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { RecordBindings } from './record-bindings.ts';
import { closeExistingImporterState, openExistingImporterState, ResumeStateError } from './resume-state.ts';
import { RunStore, type Run, type SourceProjection } from './run-store.ts';

type Ownership = { pid: number; birth: string; capability: string };
export type ImportOwnership = Readonly<{ source: string; capability: string }>;
export type ImportSessionOptions = {
  instrumentDatabase?: (database: Database) => Database;
  existing?: boolean;
  descriptor?: FileHandle;
};
export type ActiveGenerationPeek = Readonly<{
  run: Run;
  status: 'staging' | 'ready' | 'finalizing' | 'unsupported';
  skipped: number;
}>;

// Linux start time is a process birth identity, including across PID reuse. A boot
// identity also prevents an old database owner from matching after a host reboot.
function processIdentity(pid: number): { birth: string; live: boolean } {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const start = fields[19];
  if (!start || !/^[0-9]+$/.test(start)) throw new Error('Process birth identity unavailable');
  return {
    birth: `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${start}`,
    live: !['Z', 'X', 'x'].includes(fields[0]!),
  };
}

function alive(owner: Ownership): boolean {
  try {
    const identity = processIdentity(owner.pid);
    return identity.live && identity.birth === owner.birth;
  } catch (error) {
    // Failure to inspect a live owner is not permission to steal its guard.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
}

/** Same-file, exact-source ownership protects RunStore's capability rotation. */
export class ImportSession {
  readonly store: RunStore<SourceProjection>;
  readonly bindings: RecordBindings;
  private readonly identity = processIdentity(process.pid).birth;
  private readonly held = new Map<string, ImportOwnership>();
  private readonly descriptor?: FileHandle;
  private closed = false;

  constructor(path: string | Database, options: ImportSessionOptions = {}) {
    this.store = new RunStore<SourceProjection>(path, {
      ...(options.instrumentDatabase ? { instrumentDatabase: options.instrumentDatabase } : {}),
      projectionMode: 'source-record',
      ...(options.existing ? { existing: true } : {}),
    });
    this.descriptor = options.descriptor;
    try {
      this.bindings = new RecordBindings(this.store.database);
      this.store.database.exec(`CREATE TABLE IF NOT EXISTS import_owners (
        source TEXT PRIMARY KEY, pid INTEGER NOT NULL, birth TEXT NOT NULL,
        capability TEXT NOT NULL) WITHOUT ROWID`);
    } catch (error) {
      this.store.close();
      throw error;
    }
  }

  /** Writable existing-state factory; a missing path does not create a database. */
  static async openExisting(path: string, options: ImportSessionOptions = {}): Promise<ImportSession> {
    const opened = await openExistingImporterState(path);
    try {
      const session = new ImportSession(opened.database, {
        ...options,
        existing: true,
        descriptor: opened.descriptor,
      });
      return session;
    } catch (error) {
      await closeExistingImporterState(opened);
      throw error instanceof ResumeStateError
        ? error
        : new ResumeStateError('unavailable', 'Importer state is damaged or unavailable.');
    }
  }

  acquire(source: string): ImportOwnership | 'busy' {
    if (this.closed) throw new Error('Import session is closed');
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(source)) throw new TypeError('Invalid import source');
    if (this.held.has(source)) return 'busy';
    const db = this.store.database;
    const ownership = db
      .transaction(() => {
        const prior = db
          .prepare('SELECT pid,birth,capability FROM import_owners WHERE source=?')
          .get(source) as Ownership | null;
        if (prior && alive(prior)) return 'busy' as const;
        const capability = randomBytes(24).toString('hex');
        db.prepare(`INSERT INTO import_owners(source,pid,birth,capability) VALUES(?,?,?,?)
        ON CONFLICT(source) DO UPDATE SET pid=excluded.pid,birth=excluded.birth,capability=excluded.capability`).run(
          source,
          process.pid,
          this.identity,
          capability,
        );
        return { source, capability };
      })
      .immediate();
    if (ownership !== 'busy') this.held.set(source, ownership);
    return ownership;
  }

  /** Only the holder may obtain and rotate the durable run's previous lease. */
  reopen(ownership: ImportOwnership): Run | null {
    this.check(ownership);
    const active = this.store.activeRun(ownership.source);
    return active ? this.store.reopen(active) : null;
  }

  /** Status under this owner; never rotates a staging generation's lease. */
  peekActive(ownership: ImportOwnership): ActiveGenerationPeek | null {
    this.check(ownership);
    const active = this.store.peekActive(ownership.source);
    if (!active) return null;
    const status =
      active.status === 'staging' || active.status === 'ready' || active.status === 'finalizing'
        ? active.status
        : 'unsupported';
    return { run: active.run, status, skipped: active.skipped };
  }

  private check(ownership: ImportOwnership): void {
    if (this.closed || this.held.get(ownership.source) !== ownership) throw new Error('Stale import ownership');
    const row = this.store.database
      .prepare('SELECT capability FROM import_owners WHERE source=?')
      .get(ownership.source) as { capability: string } | null;
    if (row?.capability !== ownership.capability) throw new Error('Stale import ownership');
  }

  release(ownership: ImportOwnership): void {
    this.check(ownership);
    this.store.database
      .prepare('DELETE FROM import_owners WHERE source=? AND capability=?')
      .run(ownership.source, ownership.capability);
    this.held.delete(ownership.source);
  }

  /** The coordinator waits for its operations before closing this handle. */
  close(): void {
    if (this.closed) return;
    for (const ownership of this.held.values()) this.release(ownership);
    this.bindings.close();
    this.store.close();
    this.closed = true;
    void this.descriptor?.close().catch(() => {});
  }
}
