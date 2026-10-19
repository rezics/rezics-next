import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { constants } from 'node:os';
import { randomBytes } from 'node:crypto';

export interface RehearsalDatabase {
  url: string;
  dispose(): Promise<void>;
}

// One wall includes dump, restore and index creation. Two restore workers bound
// concurrent maintenance memory while avoiding serial index reconstruction.
const snapshotSeconds = 90;
const restoreJobs = 2;
// The owner has thousands of schema objects. Committing every restored SQL
// command spends the copy wall waiting on WAL flushes. PostgreSQL 18 batches
// objects without one unbounded transaction or changing shared durability.
const restoreTransactionObjects = 128;

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

/** A transport failure and child exit are independent: spawnSync can report
 * status zero together with ETIMEDOUT. Never retain its message, path or SQL. */
export function rehearsalProcessEvidence(result: Pick<SpawnSyncReturns<string>, 'status' | 'signal' | 'error' | 'stderr'>) {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const invocationCodes = ['ETIMEDOUT', 'ENOENT', 'EACCES', 'EPERM', 'ENOBUFS', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'];
  const stderr = result.stderr ?? '';
  const stderrClasses: string[] = [];
  if (/permission denied|access is denied|operation not permitted/i.test(stderr)) stderrClasses.push('permission');
  if (/No such (object|container|volume)\b/i.test(stderr)) stderrClasses.push('object-absent');
  if (/Cannot connect to the Docker daemon|Is the docker daemon running|connection refused|error during connect/i.test(stderr))
    stderrClasses.push('daemon-unavailable');
  if (/context deadline exceeded|i\/o timeout|request canceled|Client\.Timeout/i.test(stderr)) stderrClasses.push('transport-timeout');
  if (/connection reset|unexpected EOF|broken pipe/i.test(stderr)) stderrClasses.push('transport-disconnected');
  const phases = [...new Set(stderr.split('\n').filter(line => /^REHEARSAL cleanup (terminate|drop|done)$/.test(line)))];
  return {
    status: result.status !== null && Number.isInteger(result.status) && result.status >= 0 && result.status <= 255 ? result.status : null,
    signal: result.signal && Object.hasOwn(constants.signals, result.signal) ? result.signal : null,
    hostInvocationError: result.error ? (code && invocationCodes.includes(code) ? code : 'other') : null,
    stderrClasses: stderrClasses.length ? stderrClasses : stderr && !phases.length ? ['unclassified'] : [],
    phases,
  };
}

function dockerArgs(container: string, args: string[], seconds: number): string[] {
  return ['exec', '--user', 'postgres', container,
    'timeout', '--signal=TERM', '--kill-after=2s', `${seconds}s`, ...args];
}

function postgresCommand(container: string, step: string, args: string[], seconds = 5): void {
  const started = Date.now();
  const result = spawnSync('docker', dockerArgs(container, args, seconds), {
    encoding: 'utf8', timeout: (seconds + 4) * 1000, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 16_384,
  });
  if (result.error || result.status !== 0) {
    const evidence = rehearsalProcessEvidence(result);
    throw new Error(`Rehearsal database ${step} failed (exit ${evidence.status ?? 'none'}; signal ${evidence.signal ?? 'none'}; invocation ${evidence.hostInvocationError ?? 'none'}; stderr ${evidence.stderrClasses.join(',') || 'none'}; elapsed ${Date.now() - started}ms; budget ${seconds}s${evidence.phases.length ? `; ${evidence.phases.join('; ')}` : ''})`);
  }
}

/** One in-container process group owns the entire copy wall. A signal to the
 * host must stop that group, not merely disconnect docker exec. */
async function copyDatabase(container: string, database: string, scratch: string, user: string,
  signal: AbortSignal, copy: { quiescent: boolean }): Promise<void> {
  const started = Date.now();
  const state = `/tmp/${scratch}.copy`;
  const archive = `/tmp/${scratch}.dump`;
  // Creation precedes docker exec. Launch and cancellation serialize on gate;
  // deleting allowed revokes even an exec that has not started its shell yet.
  postgresCommand(container, 'arm copy', ['bash', '-ec',
    'umask 077; mkdir "$1"; touch "$1/allowed"', '--', state]);
  copy.quiescent = false;
  const child = spawn('docker', ['exec', '--user', 'postgres', container, 'bash', '-c',
    `umask 077
      while ! mkdir "$1/gate" 2>/dev/null; do
        [ -d "$1" ] || exit 125
        sleep 0.05
      done
      [ -f "$1/allowed" ] || { rmdir "$1/gate"; exit 125; }
      echo $$ > "$1/pid"
      shift; exec "$@"`, '--', state,
    'timeout', '--signal=TERM', '--kill-after=2s', `${snapshotSeconds}s`,
    // Release only after timeout owns its process group. Cancellation cannot
    // observe a published shell PID before that ownership is established.
    'bash', '-ec', 'rmdir "$1/gate"; shift; exec "$@"', '--', state,
    'bash', '-c', `
      # PostgreSQL is PID 1 in its container. Reap children on group signals:
      # an orphaned exec child would otherwise be mistaken for a crashed backend.
      trap 'trap "" TERM INT; wait; exit 124' TERM INT
      echo 'REHEARSAL dump start' >&2
      PGAPPNAME='${scratch}_dump' PGOPTIONS='-c default_transaction_read_only=on' pg_dump \
        --host=/var/run/postgresql --username="$3" --dbname="$1" \
        --format=custom --compress=0 --file="$4" --lock-wait-timeout=1000 --verbose
      status=$?; echo "REHEARSAL dump exit $status" >&2
      [ "$status" = 0 ] || exit "$status"
      echo 'REHEARSAL restore start' >&2
      PGAPPNAME='${scratch}_restore' pg_restore --host=/var/run/postgresql --username=postgres --dbname="$2" \
        --exit-on-error --verbose --jobs=${restoreJobs} --transaction-size=${restoreTransactionObjects} "$4"
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
        CASE WHEN wait_event IN ('WALSync','WALWrite','DataFileRead','DataFileWrite','DataFileExtend','DataFileSync')
          THEN lower(wait_event) ELSE CASE wait_event_type WHEN 'Lock' THEN 'lock' WHEN 'IO' THEN 'io'
          WHEN 'IPC' THEN 'ipc' WHEN 'Client' THEN 'client' ELSE 'running' END END, count(*)
        FROM pg_stat_activity WHERE application_name IN ('${scratch}_dump','${scratch}_restore')
        GROUP BY 1,2`], 2), { encoding: 'utf8', timeout: 3_000, maxBuffer: 4096 });
    for (const line of (result.stdout ?? '').trim().split('\n')) {
      if (/^(dump|restore)\|(lock|io|ipc|client|running|walsync|walwrite|datafileread|datafilewrite|datafileextend|datafilesync)\|[0-9]{1,3}$/.test(line))
        console.log(`Rehearsal copy +${Date.now() - started}ms wait=${line}`);
    }
  }, 5_000);
  const quiesce = () => {
    if (copy.quiescent || cancelFailed) return;
    // timeout has its own process group with the recorded PID. Never signal a
    // process by name or any PostgreSQL backend outside this exact copy.
    try {
      postgresCommand(container, 'cancel copy', ['bash', '-c',
        `while ! mkdir "$1/gate" 2>/dev/null; do
          [ -d "$1" ] || exit 1
          sleep 0.05
        done
        rm -f "$1/allowed"
        if [ -f "$1/pid" ]; then
          read -r pid < "$1/pid"
          case "$pid" in ''|*[!0-9]*) exit 1;; esac
          [ "$pid" -gt 1 ] || exit 1
          if [ ! -r "/proc/$pid/stat" ]; then
            ! kill -0 -- "-$pid" 2>/dev/null; exit $?
          fi
          read -r current command state parent group rest < "/proc/$pid/stat"
          [ "$current" = "$pid" ] && [ "$command" = '(timeout)' ] && [ "$group" = "$pid" ] || exit 1
          kill -TERM -- "-$pid" 2>/dev/null || true
          # Keep supervisors alive to reap their children. Killing the whole
          # group with KILL orphans exec children to PostgreSQL PID 1, which
          # treats a signalled untracked child as a server crash.
          for attempt in {1..20}; do
            alive=false
            for stat in /proc/[0-9]*/stat; do
              read -r member command state parent group rest < "$stat" 2>/dev/null || continue
              [ "$group" = "$pid" ] && [ "$state" != Z ] && [ "$state" != X ] || continue
              alive=true
              if [ "$attempt" -gt 10 ] && [ "$member" != "$pid" ]; then
                children=''
                read -r children < "/proc/$member/task/$member/children" 2>/dev/null || true
                [ -n "$children" ] || kill -KILL "$member" 2>/dev/null || true
              fi
            done
            [ "$alive" = false ] && exit 0
            sleep 0.1
          done
          exit 1
        fi`, '--', state]);
      copy.quiescent = true;
    } catch { cancelFailed = true; }
    // The container group has its own termination above. Bound a broken Docker
    // transport too; disconnecting it alone is never the cleanup mechanism.
    child.kill('SIGKILL');
  };
  const terminate = () => {
    if (cancelling) return;
    cancelling = true;
    console.log(`Rehearsal copy +${Date.now() - started}ms cancellation=${signal.aborted ? 'signal' : 'host-wall'}`);
    quiesce();
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
    quiesce();
    if (!copy.quiescent) throw new Error('Rehearsal container cancellation unconfirmed; disposable copy bookkeeping retained');
    postgresCommand(container, 'copy bookkeeping cleanup', ['rm', '-rf', state, archive]);
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
  const copy = { quiescent: true };
  const drop = () => {
    if (!copy.quiescent) throw new Error('Rehearsal copy termination unconfirmed; disposable database and bookkeeping retained');
    // Wait for termination acknowledgement before DROP's backend check. The
    // same five-second wall covers both operations and only this random copy's
    // sessions qualify, including a migration interrupted inside a transaction.
    try { postgresCommand(container, 'cleanup', ['bash', '-e', '-c', `
      trap 'trap "" TERM INT; wait; exit 124' TERM INT
      export PGAPPNAME='${scratch}_cleanup'
      echo 'REHEARSAL cleanup terminate' >&2
      psql -XAt --host=/var/run/postgresql --username=postgres --dbname=postgres \\
        --set=ON_ERROR_STOP=1 -c "SELECT pg_terminate_backend(pid, 1000) FROM pg_stat_activity WHERE datname='$1' AND pid<>pg_backend_pid()" >/dev/null
      echo 'REHEARSAL cleanup drop' >&2
      dropdb --host=/var/run/postgresql --username=postgres --force --if-exists "$1"
      echo 'REHEARSAL cleanup done' >&2
    `, '--', scratch]); }
    finally { postgresCommand(container, 'copy bookkeeping cleanup',
      ['rm', '-rf', `/tmp/${scratch}.copy`, `/tmp/${scratch}.dump`]); }
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
  const dispose = async () => {
    try { drop(); } finally { removeHooks(); }
  };
  try {
    postgresCommand(container, 'create', ['createdb', '--host=/var/run/postgresql',
      '--username=postgres', '--template=template0', '--owner', user, scratch]);
    await copyDatabase(container, database, scratch, user, controller.signal, copy);
    source.pathname = `/${scratch}`;
    return { url: source.toString(), dispose };
  } catch (error) {
    try { await dispose(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], `${String(error)}; ${String(cleanup)}`); }
    throw error;
  }
}
