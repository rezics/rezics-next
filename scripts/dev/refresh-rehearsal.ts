import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export interface RehearsalDatabase {
  url: string;
  dispose(): Promise<void>;
}

// One wall includes dump, restore and index creation. Two restore workers bound
// concurrent maintenance memory while avoiding serial index reconstruction.
const snapshotSeconds = 90;
const restoreJobs = 2;

/** Only classifications cross the diagnostic boundary. PostgreSQL stderr can
 * contain whole COPY rows, SQL, identifiers and credentials, even on success. */
export function rehearsalDiagnostic(line: string): string | undefined {
  if (/^REHEARSAL (dump|restore) (start|exit [0-9]{1,3})$/.test(line)) return line;
  if (/pg_dump:.*error:.*(lock timeout|lock-wait timeout|statement timeout)/i.test(line)) return 'dump: lock-timeout';
  if (/pg_dump:.*dumping contents of table/i.test(line)) return 'dump: table-data';
  if (/pg_dump:.*saving (database definition|encoding|standard_conforming_strings)/i.test(line)) return 'dump: metadata';
  if (/pg_restore:.*processing data for table/i.test(line)) return 'restore: table-data';
  if (/pg_restore:.*creating INDEX/i.test(line)) return 'restore: index';
  if (/pg_restore:.*creating (FK CONSTRAINT|CONSTRAINT)/i.test(line)) return 'restore: constraint';
  if (/pg_restore:.*creating/i.test(line)) return 'restore: schema';
  if (/pg_dump:.*error:/i.test(line)) return 'dump: error (details suppressed)';
  if (/pg_restore:.*error:/i.test(line)) return 'restore: error (details suppressed)';
  return undefined;
}

function dockerArgs(container: string, args: string[], seconds: number): string[] {
  return ['exec', '--user', 'postgres', container,
    'timeout', '--signal=TERM', '--kill-after=2s', `${seconds}s`, ...args];
}

function postgresCommand(container: string, step: string, args: string[], seconds = 5): void {
  const result = spawnSync('docker', dockerArgs(container, args, seconds), {
    encoding: 'utf8', timeout: (seconds + 4) * 1000, stdio: 'ignore',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Rehearsal database ${step} failed (exit ${result.status ?? 'timeout/error'}; budget ${seconds}s)`);
  }
}

/** One in-container process group owns the entire copy wall. A signal to the
 * host must stop that group, not merely disconnect docker exec. */
async function copyDatabase(container: string, database: string, scratch: string, user: string,
  signal: AbortSignal): Promise<void> {
  const started = Date.now();
  const pidFile = `/tmp/${scratch}.pid`;
  const archive = `/tmp/${scratch}.dump`;
  const child = spawn('docker', ['exec', '--user', 'postgres', container, 'bash', '-c',
    'umask 077; echo $$ > "$1"; shift; exec "$@"', '--', pidFile,
    'timeout', '--signal=TERM', '--kill-after=2s', `${snapshotSeconds}s`,
    'bash', '-c', `
      echo 'REHEARSAL dump start' >&2
      PGAPPNAME='${scratch}_dump' PGOPTIONS='-c default_transaction_read_only=on' pg_dump \
        --host=/var/run/postgresql --username="$3" --dbname="$1" \
        --format=custom --compress=0 --file="$4" --lock-wait-timeout=1000 --verbose
      status=$?; echo "REHEARSAL dump exit $status" >&2
      [ "$status" = 0 ] || exit "$status"
      echo 'REHEARSAL restore start' >&2
      PGAPPNAME='${scratch}_restore' pg_restore --host=/var/run/postgresql --username=postgres --dbname="$2" \
        --exit-on-error --verbose --jobs=${restoreJobs} "$4"
      status=$?; echo "REHEARSAL restore exit $status" >&2; exit "$status"
    `, '--', database, scratch, user, archive], { stdio: ['ignore', 'ignore', 'pipe'] });
  let last = 'copy: start';
  let pending = '';
  const evidence = new Set<string>();
  child.stderr.setEncoding('utf8');
  let discarding = false;
  const accept = (line: string) => {
    const safe = rehearsalDiagnostic(line);
    if (!safe) return;
    last = safe;
    if (!evidence.has(safe)) {
      evidence.add(safe);
      console.log(`Rehearsal copy +${Date.now() - started}ms ${safe}`);
    }
  };
  child.stderr.on('data', (chunk: string) => {
    // Bound even a malicious single diagnostic line. No raw stream is retained.
    for (const character of chunk) {
      if (character === '\n') {
        if (!discarding) accept(pending.trim());
        pending = '';
        discarding = false;
      } else if (!discarding) {
        if (pending.length < 4096) pending += character;
        else { pending = ''; discarding = true; }
      }
    }
  });
  let cancelling = false;
  let cancelFailed = false;
  const observe = setInterval(() => {
    // Fixed labels and counts only: no query text, rows, role or database names.
    const result = spawnSync('docker', dockerArgs(container, ['psql', '-XAt',
      '--host=/var/run/postgresql', '--username=postgres', '--dbname=postgres', '-c',
      `SELECT CASE WHEN application_name='${scratch}_dump' THEN 'dump' ELSE 'restore' END,
        CASE wait_event_type WHEN 'Lock' THEN 'lock' WHEN 'IO' THEN 'io'
          WHEN 'IPC' THEN 'ipc' WHEN 'Client' THEN 'client' ELSE 'running' END, count(*)
        FROM pg_stat_activity WHERE application_name IN ('${scratch}_dump','${scratch}_restore')
        GROUP BY 1,2`], 2), { encoding: 'utf8', timeout: 3_000, maxBuffer: 4096 });
    for (const line of (result.stdout ?? '').trim().split('\n')) {
      if (/^(dump|restore)\|(lock|io|ipc|client|running)\|[0-9]{1,3}$/.test(line))
        console.log(`Rehearsal copy +${Date.now() - started}ms wait=${line}`);
    }
  }, 5_000);
  const terminate = () => {
    if (cancelling) return;
    cancelling = true;
    console.log(`Rehearsal copy +${Date.now() - started}ms cancellation=${signal.aborted ? 'signal' : 'host-wall'}`);
    // timeout has its own process group with the recorded PID. Never signal a
    // process by name or any PostgreSQL backend outside this exact copy.
    try {
      postgresCommand(container, 'cancel copy', ['bash', '-c',
        'if [ -f "$1" ]; then read -r pid < "$1"; kill -TERM -- "-$pid" 2>/dev/null || true; sleep 2; kill -KILL -- "-$pid" 2>/dev/null || true; fi', '--', pidFile]);
    } catch { cancelFailed = true; }
    // The container group has its own termination above. Bound a broken Docker
    // transport too; disconnecting it alone is never the cleanup mechanism.
    child.kill('SIGKILL');
  };
  signal.addEventListener('abort', terminate, { once: true });
  const wall = setTimeout(terminate, (snapshotSeconds + 3) * 1000);
  try {
    if (signal.aborted) terminate();
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once('error', () => reject(new Error('Rehearsal copy could not start docker')));
      child.once('close', resolve);
    });
    const elapsed = Date.now() - started;
    console.log(`Rehearsal copy end elapsed=${elapsed}ms exit=${status} cancelled=${signal.aborted} timeout=${status === 124 || (cancelling && !signal.aborted)} last=${last}`);
    if (status !== 0 || signal.aborted || cancelling) {
      throw new Error(`Rehearsal database snapshot/restore failed (exit ${status}; budget ${snapshotSeconds}s; elapsed ${elapsed}ms; ${signal.aborted ? 'cancelled; ' : ''}${cancelFailed ? 'container cancellation failed; ' : ''}${[...evidence].join('; ')})`);
    }
  } finally {
    clearTimeout(wall);
    clearInterval(observe);
    signal.removeEventListener('abort', terminate);
    postgresCommand(container, 'copy bookkeeping cleanup', ['rm', '-f', pidFile, archive]);
  }
}

/** A full logical snapshot retains rows, functions, constraints, ownership,
 * grants and sequences. Rehearsal SQL runs only in this random disposable DB. */
export async function snapshotRefreshDatabase(container: string, sourceUrl: string): Promise<RehearsalDatabase> {
  if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error('Rehearsal requires one PostgreSQL container');
  const source = new URL(sourceUrl);
  const database = decodeURIComponent(source.pathname.slice(1));
  const user = decodeURIComponent(source.username);
  if (!database || !user || !['postgres:', 'postgresql:'].includes(source.protocol))
    throw new Error('Rehearsal requires an owner database URL');
  const scratch = `rezics_rehearsal_${randomBytes(12).toString('hex')}`;
  const controller = new AbortController();
  const drop = () => {
    try { postgresCommand(container, 'cleanup', ['dropdb', '--host=/var/run/postgresql',
      '--username=postgres', '--force', '--if-exists', scratch]); }
    finally { postgresCommand(container, 'copy bookkeeping cleanup',
      ['rm', '-f', `/tmp/${scratch}.pid`, `/tmp/${scratch}.dump`]); }
  };
  const removeHooks = () => {
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
  const onExit = () => {
    controller.abort();
    try { drop(); }
    catch (error) { console.error(`Rehearsal cleanup failed for disposable database ${scratch}: ${(error as Error).message}`); }
    finally { removeHooks(); }
  };
  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = true;
    controller.abort();
    onExit();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('exit', onExit);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const dispose = async () => { drop(); removeHooks(); };
  try {
    postgresCommand(container, 'create', ['createdb', '--host=/var/run/postgresql',
      '--username=postgres', '--template=template0', '--owner', user, scratch]);
    await copyDatabase(container, database, scratch, user, controller.signal);
    source.pathname = `/${scratch}`;
    return { url: source.toString(), dispose };
  } catch (error) {
    try { await dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], `${String(error)}; ${String(cleanup)}`); }
    throw error;
  }
}
