import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export interface RehearsalDatabase {
  url: string;
  dispose(): Promise<void>;
}

// Copy only owners with pending files. Each copy/restore has one 90-second
// wall, including indexes, rather than an unbounded process or in-memory dump.
// timeout runs inside the container: killing docker exec alone leaves its
// server-side process running. The pinned PostgreSQL image supplies these tools.
const snapshotSeconds = 90;

function postgresCommand(container: string, step: string, args: string[], seconds = 5): void {
  const result = spawnSync('docker', ['exec', '--user', 'postgres', container,
    'timeout', '--signal=TERM', '--kill-after=2s', `${seconds}s`, ...args], {
    encoding: 'utf8', timeout: (seconds + 4) * 1000,
    // COPY and constraint errors can contain business rows. Never capture or
    // report these streams; the phase and status are sufficient to fail closed.
    stdio: 'ignore',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Rehearsal database ${step} failed (exit ${result.status ?? 'timeout/error'}; budget ${seconds}s)`);
  }
}

/** A full logical snapshot retains data, functions, constraints, ownership,
 * grants and sequence state. pg_dump takes shared locks compatible with live
 * DML; rehearsal DDL and nextval/setval run only in the disposable database.
 * The same cluster retains roles, extensions and transaction-ID meaning. */
export async function snapshotRefreshDatabase(container: string, sourceUrl: string): Promise<RehearsalDatabase> {
  if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error('Rehearsal requires one PostgreSQL container');
  const source = new URL(sourceUrl);
  const database = decodeURIComponent(source.pathname.slice(1));
  const user = decodeURIComponent(source.username);
  if (!database || !user || !['postgres:', 'postgresql:'].includes(source.protocol))
    throw new Error('Rehearsal requires an owner database URL');
  const scratch = `rezics_rehearsal_${randomBytes(12).toString('hex')}`;
  const drop = () => postgresCommand(container, 'cleanup', ['dropdb', '--host=/var/run/postgresql',
    '--username=postgres', '--force', '--if-exists', scratch]);
  const removeHooks = () => {
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
  const onExit = () => {
    try { drop(); }
    catch { console.error(`Rehearsal cleanup failed for disposable database ${scratch}`); }
    finally { removeHooks(); }
  };
  const onSignal = (signal: NodeJS.Signals) => {
    // Default signal termination bypasses exit hooks. Force closes connections
    // only inside this exact random copy, including its pending migration.
    // Cleanup keeps the five-second container budget and nine-second host wall.
    onExit();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('exit', onExit);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const dispose = async () => {
    drop();
    removeHooks();
  };
  try {
    postgresCommand(container, 'create', ['createdb', '--host=/var/run/postgresql',
      '--username=postgres', '--template=template0', '--owner', user, scratch]);
    postgresCommand(container, 'snapshot/restore', ['bash', '-o', 'pipefail', '-c', `
      PGOPTIONS='-c default_transaction_read_only=on' pg_dump \
        --host=/var/run/postgresql --username="$3" --dbname="$1" \
        --format=custom --lock-wait-timeout=1000 |
      pg_restore --host=/var/run/postgresql --username=postgres --dbname="$2" --exit-on-error
    `, '--', database, scratch, user], snapshotSeconds);
    source.pathname = `/${scratch}`;
    return { url: source.toString(), dispose };
  } catch (error) {
    try { await dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], `${String(error)}; ${String(cleanup)}`); }
    throw error;
  }
}
