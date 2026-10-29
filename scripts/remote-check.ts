#!/usr/bin/env bun
// Runs a command against a copy of a workspace on a development check host, so the check's containers and test lanes
// stay off the machine the agents run on.
//
//   KERNEL_CHECK_REMOTE=<hosts file> bun scripts/remote-check.ts [--cwd <directory>] [--slots <n>] <workspace> -- <command...>
//
// The hosts file is local configuration: { "hosts": [{ name, address, identity, memoryMaxGiB, cpuQuotaPercent, slots }] }.
// The command runs in <directory> (relative to the workspace root, default the root) after `bun install`, inside the
// host's capped systemd slice, and its exit code is this script's exit code. A run holds <n> slots (default 1) on one
// host for as long as it lasts, which is how a heavy run keeps lighter ones from sharing its share of the host.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openDb } from '../tools/goal/src/db.ts';
import { recordFlow } from '../tools/goal/src/flow.ts';

export function recordRemoteCheckFlow(action: 'requested'|'acquired'|'released', env: NodeJS.ProcessEnv = process.env, at = new Date()): void {
  const taskId=env.GOAL_TASK_ID, attempt=Number(env.GOAL_ATTEMPT), waitFile=env.GOAL_CHECK_WAIT_FILE;
  if (!taskId || !waitFile || !Number.isSafeInteger(attempt) || attempt < 0) return;
  const stateDirectory=dirname(dirname(dirname(resolve(waitFile))));
  const db=openDb(join(stateDirectory,'goal.sqlite'));
  try { recordFlow(db,{taskId,attempt,stage:'check',action,at:at.toISOString()}); } finally { db.close(); }
}

export type Host = {
  name: string;
  address: string;
  identity: string;
  memoryMaxGiB: number;
  cpuQuotaPercent: number;
  slots: number;
};

export type RemoteCheck = {
  hosts: Host[];
  workspace: string;
  cwd?: string;
  command: string[];
  slots?: number;
  pollMs?: number;
};

const ROOT = '/srv/rezics-check';
const SLICE = 'rezics-check.slice';
const SLOT_BUSY = 75;

class Aborted extends Error {}

export function readHosts(file: string): Host[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { hosts?: unknown };
  if (!Array.isArray(parsed.hosts) || parsed.hosts.length === 0) throw new Error(`${file} lists no hosts`);
  return parsed.hosts.map((entry: Record<string, unknown>, index) => {
    const { name, address, identity, memoryMaxGiB, cpuQuotaPercent, slots } = entry;
    // An address starting with a dash would be read as an ssh option.
    if (typeof address !== 'string' || !/^[\w.-]+@[\w.:-]+$/.test(address))
      throw new Error(`host ${index}: bad address`);
    if (typeof name !== 'string' || !name) throw new Error(`host ${index}: name is required`);
    if (typeof identity !== 'string' || !identity) throw new Error(`host ${name}: identity is required`);
    if (typeof memoryMaxGiB !== 'number' || !(memoryMaxGiB > 0)) throw new Error(`host ${name}: bad memoryMaxGiB`);
    if (typeof cpuQuotaPercent !== 'number' || !(cpuQuotaPercent > 0))
      throw new Error(`host ${name}: bad cpuQuotaPercent`);
    if (!Number.isInteger(slots) || (slots as number) < 1) throw new Error(`host ${name}: bad slots`);
    return { name, address, identity, memoryMaxGiB, cpuQuotaPercent, slots: slots as number };
  });
}

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

const sshOptions = (host: Host): string[] => [
  '-i',
  host.identity,
  '-o',
  'IdentitiesOnly=yes',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=15',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=4',
];

/** Memory the slice can still use: what the host has available, bounded by the slice's cap less its current use. */
function probeScript(host: Host): string {
  const cap = Math.round(host.memoryMaxGiB * 2 ** 30);
  return `awk -v cap=${cap} 'BEGIN {
  while ((getline line < "/proc/meminfo") > 0) if (line ~ /^MemAvailable:/) { split(line, field, " "); available = field[2] * 1024 }
  getline used < "/sys/fs/cgroup/${SLICE}/memory.current"
  if (cap - used < available) available = cap - used
  printf "AVAILABLE %.0f\\n", available
}'`;
}

/** Holds a host's exclusive reservation while a multi-slot run collects its slots. */
function reservationScript(): string {
  return `# REMOTE_CHECK_RESERVATION
mkdir -p ${ROOT}/slots ${ROOT}/runs
exec 8>"${ROOT}/slots/reserve.lock"
flock 8
echo RESERVATION
exec cat >/dev/null`;
}

/** Takes a free slot while the connection lives: the lock goes with the session. */
function slotScript(host: Host, reserved: boolean): string {
  const mode = reserved ? 'REMOTE_CHECK_SLOT_RESERVED' : 'REMOTE_CHECK_SLOT_SINGLE';
  const reservation = reserved
    ? ''
    : `exec 8>"${ROOT}/slots/reserve.lock"
flock -s -n 8 || exit ${SLOT_BUSY}
`;
  const unlockReservation = reserved
    ? ''
    : `flock -u 8
exec 8>&-
`;
  return `mkdir -p ${ROOT}/slots ${ROOT}/runs
${mode}=1
${reservation}
i=0
while [ "$i" -lt ${host.slots} ]; do
  exec 9>"${ROOT}/slots/$i.lock"
  if flock -n 9; then
    for run in ${ROOT}/runs/*; do
      [ -d "$run" ] || continue
      if [ -n "$(find "$run" -maxdepth 0 -mmin +60)" ] && ! systemctl is-active --quiet "rezics-check-\${run##*/}.scope"; then rm -rf -- "$run"; fi
    done
    ${unlockReservation}echo "SLOT $i"
    exec cat >/dev/null
  fi
  i=$((i + 1))
done
exit ${SLOT_BUSY}`;
}

const dockerWrapper = readFileSync(join(import.meta.dir, 'check-host/docker'), 'utf8');

/**
 * The docker wrapper is written beside the run's files and comes first on the path, so every `docker` a workspace
 * starts is the one that adds the slice, whatever the workspace is.
 */
function runScript(id: string, directory: string, cwd: string, command: string[], hostName: string): string {
  const wrapperDirectory = `${directory}/.temp/check-host`;
  const systemdScript = `host=$REMOTE_CHECK_HOST
    install_started=$(date +%s%N)
    bun install --frozen-lockfile
    code=$?
    install_finished=$(date +%s%N)
    awk -v elapsed="$((install_finished - install_started))" -v host="$host" 'BEGIN { printf "remote-check: bun install %.3f s on %s\\n", elapsed / 1000000000, host }' >&2
    if [ "$code" -eq 0 ]; then
      cd "$1"
      code=$?
      shift
      if [ "$code" -eq 0 ]; then
        command_started=$(date +%s%N)
        "$@"
        code=$?
        command_finished=$(date +%s%N)
        awk -v elapsed="$((command_finished - command_started))" -v host="$host" 'BEGIN { printf "remote-check: command %.3f s on %s\\n", elapsed / 1000000000, host }' >&2
      fi
    fi
    peak=$(cat "/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.peak" 2>/dev/null) && echo "remote-check: peak memory of the run $((peak / 1048576)) MiB" >&2
    exit $code`;
  return `mkdir -p ${wrapperDirectory} && cat > ${wrapperDirectory}/docker <<'WRAPPER' && chmod +x ${wrapperDirectory}/docker || exit 1
${dockerWrapper}WRAPPER
export PATH=${wrapperDirectory}:/usr/local/bin:$PATH BUN_INSTALL_CACHE_DIR=${ROOT}/bun-cache PLAYWRIGHT_BROWSERS_PATH=${ROOT}/browsers KERNEL_CHECK_ON_REMOTE=1 REZICS_STACK_LEASE=off REMOTE_CHECK_HOST=${quote(hostName)}
cd ${directory} || exit 1
exec systemd-run --scope --quiet --collect --slice=${SLICE} --unit=rezics-check-${id} \\
  sh -c ${quote(systemdScript)} sh ${[cwd, ...command].map(quote).join(' ')}`;
}

function cleanupScript(id: string, directory: string): string {
  return `systemctl stop rezics-check-${id}.scope >/dev/null 2>&1
rm -rf -- ${directory}`;
}

/** Tracked and untracked files that exist, without Git's own data, installed packages and local scratch space. */
export function workspaceFiles(workspace: string): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: workspace,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed in ${workspace}: ${listed.stderr.toString()}`);
  const files = listed.stdout.toString().split('\0').filter(Boolean);
  return [...new Set(files)].filter((file) => {
    const parts = file.split('/');
    if (parts[0] === '.git' || parts[0] === '.temp' || parts.includes('node_modules')) return false;
    try {
      return lstatSync(resolve(workspace, file)).isFile() || lstatSync(resolve(workspace, file)).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

type Lease = { host: Host; release: () => Promise<void> };
type SessionLease = Lease & { exited: Promise<number>; isActive: () => boolean };

/** The promise's value, or null once the time is up; the timer never outlives the wait. */
async function within<T>(ms: number, promise: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<null>((done) => (timer = setTimeout(() => done(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });
  if (signal.aborted) throw new Aborted();
}

async function availableMemory(host: Host): Promise<number | null> {
  const child = Bun.spawn(['ssh', ...sshOptions(host), host.address, probeScript(host)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const match = output.match(/^AVAILABLE (\d+)$/m);
  return code === 0 && match ? Number(match[1]) : null;
}

function sessionLease(host: Host, holder: ReturnType<typeof Bun.spawn>): SessionLease {
  let ended = false;
  let released = false;
  const exited = holder.exited.then((code) => {
    ended = true;
    return code;
  });
  return {
    host,
    exited,
    isActive: () => !ended,
    release: async () => {
      if (released) return;
      released = true;
      // Closing stdin ends the remote `cat`, which releases the lock; the kill only covers a stuck connection.
      try {
        await holder.stdin.end();
      } catch {
        // The connection may already be gone.
      }
      if ((await within(10_000, exited)) === null) {
        try {
          holder.kill();
        } catch {
          // The connection may already have exited.
        }
      }
      await exited;
    },
  };
}

async function takeSession(
  host: Host,
  script: string,
  token: RegExp,
  signal: AbortSignal,
  reservation?: SessionLease,
): Promise<SessionLease | null> {
  if (signal.aborted) throw new Aborted();
  const holder = Bun.spawn(['ssh', ...sshOptions(host), host.address, script], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const lease = sessionLease(host, holder);
  const reader = holder.stdout.getReader();
  let accepted = false;
  const stop = () => {
    try {
      holder.kill('SIGTERM');
    } catch {
      // The session may already have exited.
    }
  };
  const reservationLost = () => {
    if (!accepted) stop();
  };
  signal.addEventListener('abort', stop, { once: true });
  if (reservation) void reservation.exited.then(reservationLost);
  try {
    let seen = '';
    while (!token.test(seen)) {
      if (signal.aborted) throw new Aborted();
      const chunk = await reader.read();
      if (chunk.done) {
        await lease.exited;
        if (signal.aborted) throw new Aborted();
        return null;
      }
      seen += new TextDecoder().decode(chunk.value);
    }
    if (signal.aborted) throw new Aborted();
    if (reservation && !reservation.isActive()) {
      await lease.release();
      return null;
    }
    accepted = true;
    return lease;
  } catch (error) {
    if (!accepted) {
      stop();
      await lease.exited;
    }
    if (signal.aborted) throw new Aborted();
    throw error;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

/** Tries a slot while taking a shared reservation for a single-slot run. */
async function takeSlot(
  host: Host,
  reserved: boolean,
  signal: AbortSignal,
  reservation?: SessionLease,
): Promise<Lease | null> {
  return takeSession(host, slotScript(host, reserved), /^SLOT \d+$/m, signal, reservation);
}

async function takeReservation(host: Host, signal: AbortSignal): Promise<SessionLease | null> {
  return takeSession(host, reservationScript(), /^RESERVATION$/m, signal);
}

/** Keeps every slot it gets while exclusively reserving the host for this multi-slot acquisition. */
async function takeReservedSlots(
  host: Host,
  count: number,
  pollMs: number,
  signal: AbortSignal,
  reservation: SessionLease,
  announceWait: () => void,
): Promise<Lease | null> {
  const held: Lease[] = [];
  const releaseAll = async (): Promise<void> => {
    await Promise.all(held.map((lease) => lease.release()));
  };
  try {
    while (held.length < count) {
      if (signal.aborted) throw new Aborted();
      if (!reservation.isActive()) {
        await releaseAll();
        await reservation.release();
        return null;
      }
      const lease = await takeSlot(host, true, signal, reservation);
      if (lease) {
        held.push(lease);
        continue;
      }
      if (!reservation.isActive()) {
        await releaseAll();
        await reservation.release();
        return null;
      }
      announceWait();
      await sleep(pollMs, signal);
    }
    await reservation.release();
    if (signal.aborted) throw new Aborted();
    return { host, release: releaseAll };
  } catch (error) {
    await releaseAll();
    await reservation.release();
    throw error;
  }
}

async function acquire(hosts: Host[], slots: number, pollMs: number, signal: AbortSignal): Promise<Lease> {
  let announced = false;
  const announceWait = (): void => {
    if (announced) return;
    console.error('remote-check: every check slot is busy; waiting for a free one');
    announced = true;
  };
  while (true) {
    const memory = await Promise.all(hosts.map(async (host) => ({ host, available: await availableMemory(host) })));
    if (signal.aborted) throw new Aborted();
    const ranked = memory
      .filter((entry): entry is { host: Host; available: number } => entry.available !== null)
      .sort((left, right) => right.available - left.available);
    for (const { host } of ranked) {
      if (slots === 1) {
        const lease = await takeSlot(host, false, signal);
        if (lease && signal.aborted) {
          await lease.release();
          throw new Aborted();
        }
        if (lease) return lease;
        continue;
      }
      const reservation = await takeReservation(host, signal);
      if (!reservation) continue;
      const lease = await takeReservedSlots(host, slots, pollMs, signal, reservation, announceWait);
      if (lease && signal.aborted) {
        await lease.release();
        throw new Aborted();
      }
      if (lease) return lease;
    }
    announceWait();
    await sleep(pollMs, signal);
  }
}

async function finished(child: ReturnType<typeof Bun.spawn>, signal: AbortSignal): Promise<number> {
  const stop = () => child.kill('SIGTERM');
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try {
    return await child.exited;
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

function reportDuration(phase: string, started: number, host: string): void {
  console.error(`remote-check: ${phase} ${((performance.now() - started) / 1000).toFixed(3)} s on ${host}`);
}

export async function remoteCheck(options: RemoteCheck, signal: AbortSignal): Promise<number> {
  const slots = options.slots ?? 1;
  // A host with fewer slots than the run needs can never serve it, so it is not asked and not waited for.
  const hosts = options.hosts.filter((host) => host.slots >= slots);
  if (hosts.length === 0) throw new Error(`No check host has ${slots} slots`);
  const files = workspaceFiles(options.workspace);
  const slotWaitStarted = performance.now();
  recordRemoteCheckFlow('requested');
  const lease = await acquire(hosts, slots, options.pollMs ?? 5000, signal);
  recordRemoteCheckFlow('acquired');
  const { host } = lease;
  reportDuration('slot wait', slotWaitStarted, host.name);
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const directory = `${ROOT}/runs/${id}`;
  try {
    const rsyncStarted = performance.now();
    const sync = Bun.spawn(
      [
        'rsync',
        '-lpt',
        '--mkpath',
        '--from0',
        '--files-from=-',
        '-e',
        ['ssh', ...sshOptions(host)].map(quote).join(' '),
        `${resolve(options.workspace)}/`,
        `${host.address}:${directory}/`,
      ],
      { stdin: new Blob([`${files.join('\0')}\0`]), stdout: 'inherit', stderr: 'inherit' },
    );
    const synced = await finished(sync, signal);
    reportDuration('rsync', rsyncStarted, host.name);
    if (signal.aborted) throw new Aborted();
    if (synced !== 0) throw new Error(`rsync to ${host.name} failed with exit code ${synced}`);

    console.error(`remote-check: running on ${host.name}`);
    const run = Bun.spawn(
      [
        'ssh',
        ...sshOptions(host),
        host.address,
        runScript(id, directory, options.cwd ?? '.', options.command, host.name),
      ],
      { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    );
    const code = await finished(run, signal);
    if (signal.aborted) throw new Aborted();
    return code;
  } finally {
    // The cleanup connection is not tied to the abort signal: it is what undoes an aborted run.
    const cleanup = Bun.spawn(['ssh', ...sshOptions(host), host.address, cleanupScript(id, directory)], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'inherit',
    });
    const cleaned = await within(60_000, cleanup.exited);
    if (cleaned !== 0) {
      cleanup.kill();
      console.error(`remote-check: could not remove ${directory} on ${host.name}`);
    }
    await lease.release();
    recordRemoteCheckFlow('released');
  }
}

function parse(argv: string[]): RemoteCheck {
  const hostsFile = process.env.KERNEL_CHECK_REMOTE;
  if (!hostsFile) throw new Error('KERNEL_CHECK_REMOTE must name the hosts file');
  let cwd: string | undefined;
  let slots: number | undefined;
  const rest = [...argv];
  while (rest[0]?.startsWith('--') && rest[0] !== '--') {
    const flag = rest.shift();
    if ((flag !== '--cwd' && flag !== '--slots') || rest.length === 0) throw new Error(`Unknown option: ${flag}`);
    const value = rest.shift()!;
    if (flag === '--cwd') cwd = value;
    else {
      slots = Number(value);
      if (!Number.isSafeInteger(slots) || slots < 1)
        throw new Error(`--slots must be a positive integer, received ${value}`);
    }
  }
  const workspace = rest.shift();
  const separator = rest.shift();
  if (!workspace || separator !== '--' || rest.length === 0) {
    throw new Error('Usage: remote-check.ts [--cwd <directory>] [--slots <n>] <workspace> -- <command...>');
  }
  if (!existsSync(workspace)) throw new Error(`Workspace does not exist: ${workspace}`);
  const pollMs = process.env.REMOTE_CHECK_POLL_MS === undefined ? undefined : Number(process.env.REMOTE_CHECK_POLL_MS);
  return {
    hosts: readHosts(hostsFile),
    workspace,
    command: rest,
    ...(cwd === undefined ? {} : { cwd }),
    ...(slots === undefined ? {} : { slots }),
    ...(pollMs === undefined ? {} : { pollMs }),
  };
}

if (import.meta.main) {
  const controller = new AbortController();
  let received: number | undefined;
  for (const [name, number] of [
    ['SIGINT', 2],
    ['SIGTERM', 15],
    ['SIGHUP', 1],
  ] as const) {
    process.on(name, () => {
      received ??= number;
      controller.abort();
    });
  }
  try {
    process.exitCode = await remoteCheck(parse(process.argv.slice(2)), controller.signal);
  } catch (error) {
    if (!(error instanceof Aborted)) console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
  if (received !== undefined) process.exitCode = 128 + received;
}
