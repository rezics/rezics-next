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
import { appendFileSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
  /** Called for each probe round that finds at least one responding host. */
  answered?: () => void;
  /** Called with the host's name once its slot is held and the command is about to start. */
  started?: (host: string) => void;
  /**
   * Workspace-relative files or directories copied back after the command ends, whatever its exit code, and before
   * the run directory is removed. A path that is not on the host is skipped.
   */
  returns?: string[];
};

/** What a try-once run reports: no host had a free slot, or the command ran there and exited with this code. */
export type TryOnce = { status: 'no-slot' } | { status: 'ran'; host: string; code: number };

export const ROOT = '/srv/rezics-check';
const SLICE = 'rezics-check.slice';
const SLOT_BUSY = 75;
const REMOTE_TRANSPORT_FAILURE = 75;
export const CHECK_SLOT_MEMORY_BYTES = 2.5 * 2 ** 30;
export const CHECK_SLOT_PROCESSORS = 2;
const MAX_WAIT_RECORD_MS = 60_000;

export class Aborted extends Error {}

export class RemoteTransportError extends Error {
  constructor(
    readonly host: string,
    readonly step: string,
  ) {
    super(`remote-check: connection to ${host} failed during ${step} before a result`);
    this.name = 'RemoteTransportError';
  }
}

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

/** Reports the resources the next check would share with, falling back to host memory when the slice is unreadable. */
function probeScript(host: Host): string {
  return `set -eu
processors=$(nproc)
load=$(awk 'NR == 1 { print $1; exit }' /proc/loadavg)
available=$(awk 'BEGIN { while ((getline line < "/proc/meminfo") > 0) if (line ~ /^MemAvailable:/) { split(line, field, " "); printf "%.0f\\n", field[2] * 1024; exit } }' 2>/dev/null || true)
case "$available" in ''|*[!0-9]*) available= ;; esac
slice_cgroup=$(systemctl show --property=ControlGroup --value ${SLICE} 2>/dev/null || true)
case "$slice_cgroup" in /*) ;; *) slice_cgroup= ;; esac
current=
maximum=
cpu_max=
if [ -n "$slice_cgroup" ]; then
  current=$(cat "/sys/fs/cgroup$slice_cgroup/memory.current" 2>/dev/null || true)
  maximum=$(cat "/sys/fs/cgroup$slice_cgroup/memory.max" 2>/dev/null || true)
  cpu_max=$(cat "/sys/fs/cgroup$slice_cgroup/cpu.max" 2>/dev/null || true)
fi
case "$current" in ''|*[!0-9]*) current= ;; esac
case "$maximum" in ''|*[!0-9]*) maximum= ;; esac
if [ -n "$current" ] && [ -n "$maximum" ]; then
  headroom=$((maximum - current))
  [ "$headroom" -ge 0 ] || headroom=0
  printf 'MEMORY_CURRENT %s\\nMEMORY_MAX %s\\nMEMORY_HEADROOM %s\\n' "$current" "$maximum" "$headroom"
else
  [ -n "$available" ] || exit 1
  printf 'MEMORY_CURRENT -\\nMEMORY_MAX -\\nMEMORY_HEADROOM %s\\n' "$available"
fi
slice_processors=
set -- $cpu_max
if [ "$#" -eq 2 ]; then
  case "$1:$2" in *[!0-9:]*|:*|*:) ;; *)
    if [ "$2" -gt 0 ]; then slice_processors=$(awk -v quota="$1" -v period="$2" 'BEGIN { printf "%.6f\\n", quota / period }'); fi
    ;;
  esac
fi
if [ -z "$slice_processors" ]; then
  slice_processors=$(awk -v quota="${host.cpuQuotaPercent}" 'BEGIN { printf "%.6f\\n", quota / 100 }')
fi
slots_used=0
i=0
while [ "$i" -lt ${host.slots} ]; do
  lock=${ROOT}/slots/$i.lock
  if [ -e "$lock" ]; then
    exec 9<"$lock"
    if flock -n 9; then flock -u 9; else slots_used=$((slots_used + 1)); fi
    exec 9<&-
  fi
  i=$((i + 1))
done
printf 'PROCESSORS %s\\nSLICE_PROCESSORS %s\\nLOAD %s\\nSLOTS_USED %s\\n' "$processors" "$slice_processors" "$load" "$slots_used"`;
}

/** Holds a host's exclusive reservation while a multi-slot run collects its slots. */
function reservationScript(wait = true): string {
  return `# REMOTE_CHECK_RESERVATION
mkdir -p ${ROOT}/slots ${ROOT}/runs
exec 8>"${ROOT}/slots/reserve.lock"
${wait ? 'flock 8' : `flock -n 8 || exit ${SLOT_BUSY}`}
echo RESERVATION
exec cat >/dev/null`;
}

/** Takes a free slot while the connection lives: the lock goes with the session. */
function slotScript(host: Host, reserved: boolean, slotLimit: number): string {
  const mode = reserved ? 'REMOTE_CHECK_SLOT_RESERVED' : 'REMOTE_CHECK_SLOT_SINGLE';
  const reservation = reserved
    ? ''
    : `exec 8>"${ROOT}/slots/reserve.lock"
flock -x -n 8 || exit ${SLOT_BUSY}
`;
  const unlockReservation = reserved
    ? ''
    : `flock -u 8
exec 8>&-
`;
  return `mkdir -p ${ROOT}/slots ${ROOT}/runs
${mode}=1
# REMOTE_CHECK_SLOT_LIMIT ${slotLimit}
${reservation}
occupied=0
i=0
while [ "$i" -lt ${host.slots} ]; do
  exec 9>"${ROOT}/slots/$i.lock"
  if flock -n 9; then flock -u 9; else occupied=$((occupied + 1)); fi
  exec 9>&-
  i=$((i + 1))
done
if [ "$occupied" -ge ${slotLimit} ]; then exit ${SLOT_BUSY}; fi
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
  const statusFile = `${directory}/exit-status`;
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
    printf '%s\\n' "$code" > ${quote(statusFile)}
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

/** Reads the command's recorded exit status when ssh itself reports 255. */
function statusScript(directory: string): string {
  return `# REMOTE_CHECK_STATUS\ncat -- ${quote(`${directory}/exit-status`)}`;
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

type WaitRecorder = { begin(): void; record(): void; stop(): void };

/** Records elapsed wait time in full-line appends, without allowing a reporting error to fail the check. */
function waitRecorder(file = process.env.GOAL_CHECK_WAIT_FILE): WaitRecorder {
  if (!file) return { begin() {}, record() {}, stop() {} };
  let started: number | undefined;
  let recordedThrough = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (started === undefined) return;
    const elapsed = Math.max(0, Math.floor(performance.now() - started) - recordedThrough);
    let remaining = elapsed;
    while (remaining > 0) {
      const increment = Math.min(remaining, MAX_WAIT_RECORD_MS);
      try {
        appendFileSync(file, `${increment}\n`);
      } catch {
        // The control-plane hint is best-effort and must never fail a check.
      }
      recordedThrough += increment;
      remaining -= increment;
    }
  };
  const schedule = (delay = MAX_WAIT_RECORD_MS) => {
    timer = setTimeout(() => {
      flush();
      schedule();
    }, delay);
    timer.unref?.();
  };
  return {
    begin() {
      if (started !== undefined) return;
      started = performance.now();
      schedule(100);
    },
    record: flush,
    stop() {
      if (started === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      flush();
    },
  };
}

type HostProbe = {
  processors: number;
  sliceProcessors: number;
  load: number;
  memoryHeadroom: number;
  slotsUsed: number;
};
type RankedHost = {
  host: Host;
  resourceSlots: number;
  freeSlots: number;
  slotLimit: number;
  memoryHeadroom: number;
};

function probeCapacity(host: Host, probe: HostProbe): number {
  let freeSlots = 0;
  for (let count = 1; count <= host.slots; count += 1) {
    if (
      probe.memoryHeadroom < count * CHECK_SLOT_MEMORY_BYTES ||
      probe.load + count * CHECK_SLOT_PROCESSORS > probe.sliceProcessors
    )
      break;
    freeSlots = count;
  }
  return freeSlots;
}

function rankHost(host: Host, probe: HostProbe): RankedHost {
  const resourceSlots = probeCapacity(host, probe);
  const freeSlots = Math.min(resourceSlots, Math.max(0, host.slots - probe.slotsUsed));
  const slotLimit = Math.min(host.slots, probe.slotsUsed + resourceSlots);
  return { host, resourceSlots, freeSlots, slotLimit, memoryHeadroom: probe.memoryHeadroom };
}

function parseProbe(output: string): HostProbe | null {
  const value = (name: string): string | null => output.match(new RegExp(`^${name} ([^\\r\\n]+)$`, 'm'))?.[1] ?? null;
  const processorValue = value('PROCESSORS');
  const sliceProcessorValue = value('SLICE_PROCESSORS');
  const loadValue = value('LOAD');
  const headroomValue = value('MEMORY_HEADROOM');
  const processors = Number(processorValue);
  const sliceProcessors = Number(sliceProcessorValue);
  const load = Number(loadValue);
  const memoryHeadroom = Number(headroomValue);
  const slotsUsedValue = value('SLOTS_USED');
  const slotsUsed = Number(slotsUsedValue);
  const current = value('MEMORY_CURRENT');
  const maximum = value('MEMORY_MAX');
  const sliceMemory = current !== null && maximum !== null && /^\d+$/.test(current) && /^\d+$/.test(maximum);
  const memoryFallback = current === '-' && maximum === '-';
  if (
    processorValue === null ||
    sliceProcessorValue === null ||
    loadValue === null ||
    headroomValue === null ||
    !Number.isSafeInteger(processors) ||
    processors < 1 ||
    !Number.isFinite(sliceProcessors) ||
    sliceProcessors < 0 ||
    !Number.isFinite(load) ||
    load < 0 ||
    !Number.isSafeInteger(memoryHeadroom) ||
    memoryHeadroom < 0 ||
    slotsUsedValue === null ||
    !Number.isSafeInteger(slotsUsed) ||
    slotsUsed < 0 ||
    slotsUsed > 1_000_000 ||
    (!sliceMemory && !memoryFallback)
  )
    return null;
  return { processors, sliceProcessors, load, memoryHeadroom, slotsUsed };
}

async function probeHost(host: Host): Promise<HostProbe | null> {
  const child = Bun.spawn(['ssh', ...sshOptions(host), host.address, probeScript(host)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return code === 0 ? parseProbe(output) : null;
}

function sessionLease(host: Host, holder: Bun.Subprocess<'pipe', 'pipe', 'ignore'>): SessionLease {
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

/** Takes the short exclusive reservation used to keep slot acquisition inside the probed limit. */
async function takeSlot(
  host: Host,
  reserved: boolean,
  slotLimit: number,
  signal: AbortSignal,
  reservation?: SessionLease,
): Promise<Lease | null> {
  return takeSession(host, slotScript(host, reserved, slotLimit), /^SLOT \d+$/m, signal, reservation);
}

async function takeReservation(host: Host, signal: AbortSignal, wait = true): Promise<SessionLease | null> {
  return takeSession(host, reservationScript(wait), /^RESERVATION$/m, signal);
}

/**
 * Keeps every slot it gets while exclusively reserving the host for this multi-slot acquisition. Without
 * `announceWait` it does not wait: one busy slot releases what it holds and returns null.
 */
async function takeReservedSlots(
  host: Host,
  count: number,
  capacity: number,
  pollMs: number,
  signal: AbortSignal,
  reservation: SessionLease,
  announceWait?: () => void,
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
      const lease = await takeSlot(host, true, capacity, signal, reservation);
      if (lease) {
        held.push(lease);
        continue;
      }
      if (!reservation.isActive()) {
        await releaseAll();
        await reservation.release();
        return null;
      }
      if (!announceWait) {
        await releaseAll();
        await reservation.release();
        return null;
      }
      announceWait();
      const probe = await probeHost(host);
      if (!probe || !reservation.isActive()) {
        await releaseAll();
        await reservation.release();
        return null;
      }
      const resourceSlots = probeCapacity(host, probe);
      const otherSlotsUsed = Math.max(0, probe.slotsUsed - held.length);
      capacity = Math.min(host.slots, otherSlotsUsed + resourceSlots);
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

/** Hosts that can admit slots, with the most resource-backed free slots first. */
async function rankedHosts(hosts: Host[], signal: AbortSignal): Promise<RankedHost[]> {
  const probes = await Promise.all(hosts.map(async (host) => ({ host, probe: await probeHost(host) })));
  if (signal.aborted) throw new Aborted();
  return (
    probes
      .filter((entry): entry is { host: Host; probe: HostProbe } => entry.probe !== null)
      .map(({ host, probe }) => rankHost(host, probe))
      // Equal slot counts prefer the host with more measured slice memory headroom.
      .sort((left, right) => right.freeSlots - left.freeSlots || right.memoryHeadroom - left.memoryHeadroom)
  );
}

/** One probe round. Responding hosts are ranked by resource-backed free slots. */
export async function answeringHosts(hosts: Host[]): Promise<Host[]> {
  return (await rankedHosts(hosts, new AbortController().signal)).map(({ host }) => host);
}

/** Tries every host's slots once, most resource-backed free slots first, and never waits for one. */
async function acquireOnce(hosts: Host[], slots: number, signal: AbortSignal): Promise<Lease | null> {
  for (const { host, freeSlots, slotLimit } of await rankedHosts(hosts, signal)) {
    if (freeSlots < slots) continue;
    let lease: Lease | null;
    if (slots === 1) lease = await takeSlot(host, false, slotLimit, signal);
    else {
      const reservation = await takeReservation(host, signal, false);
      if (!reservation) continue;
      lease = await takeReservedSlots(host, slots, slotLimit, 0, signal, reservation);
    }
    if (lease && signal.aborted) {
      await lease.release();
      throw new Aborted();
    }
    if (lease) return lease;
  }
  return null;
}

async function acquire(
  hosts: Host[],
  slots: number,
  pollMs: number,
  signal: AbortSignal,
  giveUpIfUnanswered = false,
  onAnswered?: () => void,
): Promise<Lease | null> {
  let announced = false;
  let answered = false;
  const wait = waitRecorder();
  const announceWait = (): void => {
    wait.begin();
    if (announced) return;
    console.error('remote-check: every check slot is busy; waiting for a free one');
    announced = true;
  };
  try {
    while (true) {
      const ranked = await rankedHosts(hosts, signal);
      if (ranked.length > 0) {
        answered = true;
        onAnswered?.();
      } else if (giveUpIfUnanswered && !answered) return null;
      for (const entry of ranked) {
        const { host, freeSlots, resourceSlots, slotLimit } = entry;
        if (slots === 1) {
          if (freeSlots < 1) continue;
          const lease = await takeSlot(host, false, slotLimit, signal);
          if (lease && signal.aborted) {
            await lease.release();
            throw new Aborted();
          }
          if (lease) return lease;
          continue;
        }
        let reservation = await takeReservation(host, signal, false);
        let waitedForReservation = false;
        if (!reservation) {
          announceWait();
          wait.record();
          reservation = await takeReservation(host, signal);
          waitedForReservation = true;
        }
        if (!reservation) continue;
        let current = entry;
        if (waitedForReservation) {
          const probe = await probeHost(host);
          if (!probe) {
            await reservation.release();
            continue;
          }
          current = rankHost(host, probe);
        }
        if (current.freeSlots < 1) {
          await reservation.release();
          continue;
        }
        const lease = await takeReservedSlots(host, slots, current.slotLimit, pollMs, signal, reservation, () => {
          announceWait();
          wait.record();
        });
        if (lease && signal.aborted) {
          await lease.release();
          throw new Aborted();
        }
        if (lease) return lease;
      }
      announceWait();
      wait.record();
      await sleep(pollMs, signal);
    }
  } finally {
    wait.stop();
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

function assertReturnPath(path: string): void {
  if (path === '' || path.startsWith('/') || path.split('/').includes('..') || /[\0\n]/.test(path)) {
    throw new Error(`return path must stay inside the workspace: ${path}`);
  }
}

/** One remote script lists which declared outputs exist, so a missing path is skipped instead of failing the copy. */
function returnsProbe(directory: string, paths: string[]): string {
  const body = paths
    .map((path) => {
      const full = `${directory}/${path}`;
      return `# PATH ${path}
if [ -e ${quote(full)} ] || [ -L ${quote(full)} ]; then printf 'PRESENT %s\\n' ${quote(path)}; else printf 'ABSENT %s\\n' ${quote(path)}; fi`;
    })
    .join('\n');
  return `REMOTE_CHECK_RETURNS
${body}`;
}

/** Copies declared outputs back in one rsync. Missing paths log one stderr line and are left out of that rsync. */
async function copyReturns(host: Host, directory: string, options: RemoteCheck, signal: AbortSignal): Promise<void> {
  const paths = options.returns ?? [];
  if (paths.length === 0) return;
  for (const path of paths) assertReturnPath(path);
  const probe = Bun.spawn(['ssh', ...sshOptions(host), host.address, returnsProbe(directory, paths)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const [probed, output] = await Promise.all([finished(probe, signal), new Response(probe.stdout).text()]);
  if (signal.aborted) throw new Aborted();
  if (probed !== 0) throw new Error(`could not read outputs on ${host.name}`);
  const present: string[] = [];
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const found = line.match(/^PRESENT (.*)$/);
    const missing = line.match(/^ABSENT (.*)$/);
    if (found) {
      seen.add(found[1]!);
      present.push(found[1]!);
    } else if (missing) {
      seen.add(missing[1]!);
      console.error(`remote-check: ${missing[1]} is not on ${host.name}, skipping`);
    }
  }
  for (const path of paths) {
    if (!seen.has(path)) console.error(`remote-check: ${path} is not on ${host.name}, skipping`);
  }
  if (present.length === 0) return;
  const started = performance.now();
  const sync = Bun.spawn(
    [
      'rsync',
      '-rlpt',
      '--mkpath',
      '--from0',
      '--files-from=-',
      '-e',
      ['ssh', ...sshOptions(host)].map(quote).join(' '),
      `${host.address}:${directory}/`,
      `${resolve(options.workspace)}/`,
    ],
    { stdin: new Blob([`${present.join('\0')}\0`]), stdout: 'inherit', stderr: 'inherit' },
  );
  const synced = await finished(sync, signal);
  reportDuration('rsync back', started, host.name);
  if (signal.aborted) throw new Aborted();
  if (synced !== 0) throw new Error(`rsync from ${host.name} failed with exit code ${synced}`);
}

/** Runs the command on the lease's host and always removes the run's directory and releases the lease. */
async function runLeased(
  lease: Lease,
  options: RemoteCheck,
  files: string[],
  slotWaitStarted: number,
  signal: AbortSignal,
): Promise<number> {
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
    if ([12, 30, 35, 255].includes(synced)) throw new RemoteTransportError(host.name, 'workspace upload');
    if (synced !== 0) throw new Error(`rsync to ${host.name} failed with exit code ${synced}`);

    console.error(`remote-check: running on ${host.name}`);
    options.started?.(host.name);
    const run = Bun.spawn(
      [
        'ssh',
        ...sshOptions(host),
        host.address,
        runScript(id, directory, options.cwd ?? '.', options.command, host.name),
      ],
      { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    );
    let code = await finished(run, signal);
    if (signal.aborted) throw new Aborted();
    if (code === 255) {
      const status = Bun.spawn(['ssh', ...sshOptions(host), host.address, statusScript(directory)], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const [statusCode, output] = await Promise.all([finished(status, signal), new Response(status.stdout).text()]);
      if (signal.aborted) throw new Aborted();
      const recorded = output.trim();
      const parsed = /^(?:0|[1-9]\d{0,2})$/.test(recorded) ? Number(recorded) : Number.NaN;
      if (statusCode !== 0 || !Number.isInteger(parsed) || parsed > 255) {
        throw new RemoteTransportError(host.name, 'remote command');
      }
      code = parsed;
    }
    await copyReturns(host, directory, options, signal);
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
  }
}

/** Hosts with enough slots for the run; a host with fewer can never serve it, so it is not asked and not waited for. */
function hostsWithSlots(options: RemoteCheck, slots: number): Host[] {
  return options.hosts.filter((host) => host.slots >= slots);
}

export async function remoteCheck(options: RemoteCheck, signal: AbortSignal): Promise<number> {
  const slots = options.slots ?? 1;
  const hosts = hostsWithSlots(options, slots);
  if (hosts.length === 0) throw new Error(`No check host has ${slots} slots`);
  const files = workspaceFiles(options.workspace);
  const slotWaitStarted = performance.now();
  const lease = await acquire(hosts, slots, options.pollMs ?? 5000, signal);
  if (!lease) throw new Error('remote-check: no check host answered');
  return await runLeased(lease, options, files, slotWaitStarted, signal);
}

/**
 * Like `remoteCheck`, but the first probe round that finds no host returns null instead of waiting. Once a host has
 * answered, a later silence keeps waiting for a slot. A run no host has enough slots for is still an error.
 */
export async function remoteCheckUnlessUnreachable(options: RemoteCheck, signal: AbortSignal): Promise<number | null> {
  const slots = options.slots ?? 1;
  const hosts = hostsWithSlots(options, slots);
  if (hosts.length === 0) throw new Error(`No check host has ${slots} slots`);
  const files = workspaceFiles(options.workspace);
  const slotWaitStarted = performance.now();
  const lease = await acquire(hosts, slots, options.pollMs ?? 5000, signal, true, options.answered);
  if (!lease) return null;
  return await runLeased(lease, options, files, slotWaitStarted, signal);
}

/**
 * Like `remoteCheck`, but each host's slot is tried once and a busy host is not waited for. The result says whether
 * the command ran, so a caller never reads "no slot" as an exit code. A run no host has enough slots for is "no-slot".
 */
export async function tryRemoteCheck(options: RemoteCheck, signal: AbortSignal): Promise<TryOnce> {
  const slots = options.slots ?? 1;
  const hosts = hostsWithSlots(options, slots);
  if (hosts.length === 0) return { status: 'no-slot' };
  const files = workspaceFiles(options.workspace);
  const slotWaitStarted = performance.now();
  const lease = await acquireOnce(hosts, slots, signal);
  if (!lease) return { status: 'no-slot' };
  return {
    status: 'ran',
    host: lease.host.name,
    code: await runLeased(lease, options, files, slotWaitStarted, signal),
  };
}

function parse(argv: string[]): RemoteCheck {
  const hostsFile = process.env.KERNEL_CHECK_REMOTE;
  if (!hostsFile) throw new Error('KERNEL_CHECK_REMOTE must name the hosts file');
  let cwd: string | undefined;
  let slots: number | undefined;
  let returns: string[] | undefined;
  const rest = [...argv];
  while (rest[0]?.startsWith('--') && rest[0] !== '--') {
    const flag = rest.shift();
    if (flag === '--returns') {
      const value = rest.shift();
      if (!value) throw new Error('--returns needs a path');
      returns ??= [];
      returns.push(value);
      continue;
    }
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
    ...(returns === undefined ? {} : { returns }),
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
    if (error instanceof RemoteTransportError) {
      console.error(error.message);
      process.exitCode = REMOTE_TRANSPORT_FAILURE;
    } else {
      if (!(error instanceof Aborted)) console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
  if (received !== undefined) process.exitCode = 128 + received;
}
