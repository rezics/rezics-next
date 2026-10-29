#!/usr/bin/env bun
// Runs a command against a copy of a workspace on a development check host, so the check's containers and test lanes
// stay off the machine the agents run on.
// Runs share the host package cache through hardlinks. An in-place write into an installed package fails the run and
// removes its cache entry; patch dependencies through patchedDependencies in package.json, never at run time.
//
// A short run (one slot, estimated at no more than 120,000 ms, and not a gate) waits at most one short run per host.
// Each host keeps one slot as express capacity, so its ordinary capacity is one slot lower.
// Waiter order is gate, landing, multi-slot, ordinary. While a gate waits, non-gate runs leave its reserved slots
// free; while a landing waiter waits, ordinary and multi-slot runs leave its requested slots free. Short runs may
// still use the express slot. A waiter starts once the runs holding its slots when it began waiting have ended.
// A non-gate run requesting more than one slot reserves its slot count on the host where it can start soonest: among
// hosts with enough ordinary capacity and measured resource headroom to reach its request, it chooses the one with
// the fewest busy ordinary slots; if none can reach it yet, it chooses the least busy eligible host. Other non-gate
// runs leave those slots free, except that short runs may still use express. Multi-slot waiters on one host start in
// order. A waiting multi-slot run starts once the runs that held its slots when it began waiting have ended and the
// waiters ahead of it have started, when no gate is waiting there.
//
//   KERNEL_CHECK_REMOTE=<hosts file> bun scripts/remote-check.ts [--cwd <directory>] [--slots <n>] [--estimate-ms <n>] [--max-ms <n>] [--gate] <workspace> -- <command...>
//
// The hosts file is local configuration: { "hosts": [{ name, address, identity, memoryMaxGiB, cpuQuotaPercent, slots, processorsPerSlot }] }.
// The command runs in <directory> (relative to the workspace root, default the root) after `bun install`, inside the
// host's capped systemd slice, and its exit code is this script's exit code. A run holds <n> slots (default 1) on one
// host for as long as it lasts, which is how a heavy run keeps lighter ones from sharing its share of the host.
// Admission depends on free slots and held memory reservations, whatever the host's load average. Each run has a nested
// slice shared with its containers; its cpu.stat and memory.peak report CPU seconds, average cores and peak memory.
import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Host = {
  name: string;
  address: string;
  identity: string;
  memoryMaxGiB: number;
  cpuQuotaPercent: number;
  slots: number;
  fallback?: boolean;
  processorsPerSlot: number;
};

export type RemoteCheck = {
  hosts: Host[];
  workspace: string;
  cwd?: string;
  command: string[];
  slots?: number;
  /** Memory reservation in GiB; callers without a class weight retain the 2.5 GiB legacy reservation. */
  memoryGiB?: number;
  estimateMs?: number;
  maxMs?: number;
  /** Test seam for the client heartbeat cadence. */
  livenessIntervalMs?: number;
  /** Test seam for CPU progress reporting while the remote command is quiet. */
  progressIntervalMs?: number;
  /** Allows the promotion gate to use all but one slot of its host. */
  gate?: boolean;
  /** Admission class selected by REMOTE_CHECK_PRIORITY. */
  priority?: 'landing' | 'critical';
  pollMs?: number;
  /** Test seam for retry backoff; defaults to 100 ms. */
  retryBackoffMs?: number;
  /** Test seam for the queued slot status heartbeat. */
  waitRepeatMs?: number;
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
export function parseCommandPhases(contents: string): { durations: Record<string, number>; problems: string[] } {
  const open = new Map<string, number>();
  const durations: Record<string, number> = {};
  const problems: string[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line) continue;
    const match = line.match(/^([^\t\r\n]+)\t(start|end)\t(\d+)$/);
    if (!match) {
      problems.push(`line ${index + 1}: malformed`);
      continue;
    }
    const [, phase, edge, raw] = match;
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) {
      problems.push(`line ${index + 1}: malformed timestamp`);
      continue;
    }
    if (edge === 'start') {
      if (open.has(phase!)) problems.push(`line ${index + 1}: duplicate start for ${phase}`);
      else open.set(phase!, value);
    } else if (!open.has(phase!)) problems.push(`line ${index + 1}: unmatched end for ${phase}`);
    else {
      const started = open.get(phase!)!;
      open.delete(phase!);
      if (value < started) problems.push(`line ${index + 1}: end precedes start for ${phase}`);
      else durations[phase!] = (durations[phase!] ?? 0) + (value - started) / 1e9;
    }
  }
  for (const phase of open.keys()) problems.push(`unmatched start for ${phase}`);
  return { durations, problems };
}
let pinnedBun: { version: string; revision: string } | undefined;

/** Resolve the repository-pinned Bun only when a remote run is actually generated. */
function getPinnedBun(): { version: string; revision: string } {
  if (pinnedBun) return pinnedBun;
  const repositoryPackage = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as {
    packageManager?: string;
  };
  const version = repositoryPackage.packageManager?.startsWith('bun@') ? repositoryPackage.packageManager.slice(4) : '';
  const binary = join(import.meta.dir, '../node_modules/.bin/bun');
  if (!existsSync(binary)) throw new Error('Could not read pinned Bun revision; run bun install first');
  const result = Bun.spawnSync([binary, '--eval', 'console.log(Bun.revision)']);
  if (result.exitCode !== 0) throw new Error('Could not read pinned Bun revision; run bun install first');
  pinnedBun = { version, revision: result.stdout.toString().trim() };
  return pinnedBun;
}
const SLICE = 'rezics-check.slice';
const SLOT_BUSY = 75;
const REMOTE_TRANSPORT_FAILURE = 75;
export const REMOTE_DEADLINE_EXIT = 124;
const DEFAULT_MAX_MS = 3 * 60 * 60 * 1000;
const DEFAULT_LIVENESS_INTERVAL_MS = 60_000;
const SLOT_REQUEST_TOO_LARGE = 64;
const EXPRESS_SLOT_ESTIMATE_LIMIT_MS = 120_000;
export const CHECK_SLOT_MEMORY_BYTES = 2.5 * 2 ** 30;
export const CHECK_SLOT_PROCESSORS = 2;
export const CHECK_HOST_MIN_AVAILABLE_BYTES = 4 * 2 ** 30;
export const CHECK_HOST_MIN_TMP_BYTES = 4 * 2 ** 30;
export const CHECK_HOST_MIN_TMP_INODES = 65_536;
export const CHECK_HOST_MAX_LOAD_PER_PROCESSOR = 1.5;
const MAX_WAIT_RECORD_MS = 60_000;
export const BASE_REFRESH_INTERVAL_SECONDS = 30 * 60;
export const BASE_RETENTION_SECONDS = 2 * 60 * 60;
const RSYNC_COMPRESS_LEVEL = 3;

/** Shell guard for installed package files changed in place after installation. */
export function installedPackageCacheCheck(
  directory: string,
  hostName: string,
  cacheRoot = `${ROOT}/bun-cache`,
): string {
  const marker = `${directory}/.bun-install-complete`;
  const packageTree = `${directory}/node_modules/.bun`;
  return `
    modified_files=$(find ${quote(packageTree)} -type f -links +1 -newer ${quote(marker)} -print 2>/dev/null)
    if [ -n "$modified_files" ]; then
      modified_count=$(printf '%s\n' "$modified_files" | wc -l | tr -d ' ')
      printf 'remote-check: the run modified %s installed package files shared with the host package cache on %s:\n' "$modified_count" ${quote(hostName)} >&2
      run_root=${quote(directory)}
      cache_root=${quote(cacheRoot)}
      inode_file="$run_root/.modified-package-inodes.$$"
      cache_matches_file="$run_root/.modified-package-cache-matches.$$"
      : > "$inode_file"
      shown=0
      printf '%s\n' "$modified_files" | while IFS= read -r file; do
        [ -n "$file" ] || continue
        if [ "$shown" -lt 10 ]; then
          printf '  %s\n' "\${file#"$run_root"/}" >&2
          shown=$((shown + 1))
        fi
        inode=$(stat -c '%i' -- "$file")
        printf '%s\n' "$inode" >> "$inode_file"
      done
      find "$cache_root" -type f -printf '%i %p\n' 2>/dev/null | awk '
        NR == FNR { changed[$1] = 1; next }
        $1 in changed { print substr($0, index($0, " ") + 1) }
      ' "$inode_file" - > "$cache_matches_file"
      while IFS= read -r cache_file; do
        if [ -n "$cache_file" ]; then
          relative=\${cache_file#"$cache_root"/}
          first=\${relative%%/*}
          if [ "\${first#@}" != "$first" ]; then
            rest=\${relative#*/}
            entry="$cache_root/$first/\${rest%%/*}"
          else
            entry="$cache_root/$first"
          fi
          rm -rf -- "$entry"
        fi
      done < "$cache_matches_file"
      rm -f -- "$inode_file" "$cache_matches_file"
      if [ "$code" -eq 0 ]; then code=1; fi
    fi`;
}

export class Aborted extends Error {}

export class SlotRequestTooLarge extends Error {
  constructor(
    readonly cap: number,
    readonly requested: number,
  ) {
    super(`remote-check: requested ${requested} slots exceeds the cap of ${cap}; lower the run's concurrency to match`);
    this.name = 'SlotRequestTooLarge';
  }
}

export class RemoteTransportError extends Error {
  constructor(
    readonly host: string,
    readonly step: string,
    readonly code: number,
    readonly retryable = true,
  ) {
    super(`remote-check: connection to ${host} failed during ${step} before a result`);
    this.name = 'RemoteTransportError';
  }
}

export function validateEstimateMs(estimateMs: number | undefined): void {
  if (estimateMs !== undefined && (!Number.isSafeInteger(estimateMs) || estimateMs < 0)) {
    throw new Error(`--estimate-ms must be a non-negative safe integer, received ${estimateMs}`);
  }
}

function validateMaxMs(maxMs: number | undefined): void {
  if (maxMs !== undefined && (!Number.isSafeInteger(maxMs) || maxMs < 1)) {
    throw new Error(`--max-ms must be a positive safe integer, received ${maxMs}`);
  }
}

function validateMemoryGiB(memoryGiB: number | undefined): void {
  if (memoryGiB !== undefined && (!Number.isSafeInteger(memoryGiB) || memoryGiB < 1)) {
    throw new Error(`--memory-gib must be a positive integer, received ${memoryGiB}`);
  }
}

function isShortRun(slots: number, estimateMs: number | undefined, gate: boolean): boolean {
  return !gate && slots === 1 && estimateMs !== undefined && estimateMs <= EXPRESS_SLOT_ESTIMATE_LIMIT_MS;
}

export function readHosts(file: string): Host[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { hosts?: unknown };
  if (!Array.isArray(parsed.hosts) || parsed.hosts.length === 0) throw new Error(`${file} lists no hosts`);
  return parsed.hosts.map((entry: Record<string, unknown>, index) => {
    const { name, address, identity, memoryMaxGiB, cpuQuotaPercent, slots, fallback } = entry;
    const processorsPerSlot = entry.processorsPerSlot === undefined ? CHECK_SLOT_PROCESSORS : entry.processorsPerSlot;
    // An address starting with a dash would be read as an ssh option.
    if (typeof address !== 'string' || !/^[\w.-]+@[\w.:-]+$/.test(address))
      throw new Error(`host ${index}: bad address`);
    if (typeof name !== 'string' || !name) throw new Error(`host ${index}: name is required`);
    if (typeof identity !== 'string' || !identity) throw new Error(`host ${name}: identity is required`);
    if (typeof memoryMaxGiB !== 'number' || !(memoryMaxGiB > 0)) throw new Error(`host ${name}: bad memoryMaxGiB`);
    if (typeof cpuQuotaPercent !== 'number' || !(cpuQuotaPercent > 0))
      throw new Error(`host ${name}: bad cpuQuotaPercent`);
    if (!Number.isInteger(slots) || (slots as number) < 1) throw new Error(`host ${name}: bad slots`);
    if (fallback !== undefined && typeof fallback !== 'boolean') throw new Error(`host ${name}: bad fallback`);
    if (typeof processorsPerSlot !== 'number' || !Number.isFinite(processorsPerSlot) || processorsPerSlot <= 0)
      throw new Error(`host ${name}: bad processorsPerSlot`);
    return {
      name,
      address,
      identity,
      memoryMaxGiB,
      cpuQuotaPercent,
      slots: slots as number,
      ...(fallback ? { fallback: true } : {}),
      processorsPerSlot,
    };
  });
}

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

export function controlSocketDirectoryPath(
  runtimeDirectory: string | undefined,
  uid: number | undefined,
  fallbackId = process.pid,
): string {
  return runtimeDirectory ? join(runtimeDirectory, 'rezics-ssh') : `/tmp/rezics-ssh-${uid ?? fallbackId}`;
}

function controlSocketDirectory(): string {
  const getuid = process.getuid;
  if (typeof getuid !== 'function') throw new Error('remote-check: SSH control directories require a Unix user id');
  const uid = getuid.call(process);
  const directory = controlSocketDirectoryPath(process.env.XDG_RUNTIME_DIR, uid);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.uid !== uid) {
    throw new Error(`remote-check: SSH control directory is not a user-owned directory: ${directory}`);
  }
  if ((info.mode & 0o777) !== 0o700) chmodSync(directory, 0o700);
  return directory;
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
  '-o',
  'ControlMaster=auto',
  '-o',
  'ControlPersist=10m',
  '-o',
  `ControlPath=${join(controlSocketDirectory(), '%C')}`,
];

/** Reports the resources the next check would share with, falling back to host memory when the slice is unreadable. */
function probeScript(host: Host): string {
  return `set -eu
mkdir -p ${ROOT}/slots
processors=$(nproc)
load=$(awk 'NR == 1 { print $1; exit }' /proc/loadavg)
available=$(awk 'BEGIN { while ((getline line < "/proc/meminfo") > 0) if (line ~ /^MemAvailable:/) { split(line, field, " "); printf "%.0f\\n", field[2] * 1024; exit } }' 2>/dev/null || true)
case "$available" in ''|*[!0-9]*) available= ;; esac
tmp_bytes=$(df -P -B1 /tmp 2>/dev/null | awk 'NR == 2 { print $4; exit }' || true)
case "$tmp_bytes" in ''|*[!0-9]*) tmp_bytes= ;; esac
tmp_inodes=$(df -P -i /tmp 2>/dev/null | awk 'NR == 2 { print $4; exit }' || true)
case "$tmp_inodes" in ''|*[!0-9]*) tmp_inodes= ;; esac
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
printf 'AVAILABLE %s\\nTMP_BYTES %s\\nTMP_INODES %s\\n' "\${available:--}" "\${tmp_bytes:--}" "\${tmp_inodes:--}"
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
ordinary_slots_used=0
memory_reserved=0
i=0
while [ "$i" -lt ${Math.max(0, host.slots - 1)} ]; do
  lock=${ROOT}/slots/$i.lock
  if [ -e "$lock" ]; then
    exec 9<"$lock"
    if flock -n 9; then flock -u 9; else
      ordinary_slots_used=$((ordinary_slots_used + 1))
      reservation=${ROOT}/slots/$i.memory
      if [ -r "$reservation" ]; then read -r amount < "$reservation" || amount=0; case "$amount" in ''|*[!0-9]*) amount=0 ;; esac; memory_reserved=$((memory_reserved + amount)); fi
    fi
    exec 9<&-
  fi
  i=$((i + 1))
done
express_slot_used=0
express_name=express
express_lock=${ROOT}/slots/$express_name.lock
if [ -e "$express_lock" ]; then
  exec 9<"$express_lock"
  if flock -n 9; then flock -u 9; else
    express_slot_used=1
    reservation=${ROOT}/slots/express.memory
    if [ -r "$reservation" ]; then read -r amount < "$reservation" || amount=0; case "$amount" in ''|*[!0-9]*) amount=0 ;; esac; memory_reserved=$((memory_reserved + amount)); fi
  fi
  exec 9<&-
fi
gate_waiting=0
gate_marker=${ROOT}/slots/gate-wait.lock
if [ -e "$gate_marker" ]; then
  exec 7>"$gate_marker"
  if flock -n 7; then flock -u 7; else gate_waiting=1; fi
  exec 7<&-
fi
multi_waiting_slots=0
multi_waiting_id=-
multi_waiting_sequence=
exec 6>"${ROOT}/slots/multi-queue.lock"
flock -x 6
for multi_marker in ${ROOT}/slots/multi-wait-*.lock; do
  [ -e "$multi_marker" ] || continue
  exec 7<>"$multi_marker" || continue
  if flock -n 7; then
    rm -f -- "$multi_marker"
    flock -u 7
  else
    marker_slots=
    marker_started=
    marker_sequence=
    read -r marker_slots marker_started marker_sequence <&7 || true
    case "$marker_slots:$marker_started:$marker_sequence" in *[!0-9:]*|:*|*:) marker_slots=; marker_sequence= ;; esac
    if [ -n "$marker_slots" ]; then
      marker_id=\${multi_marker##*/multi-wait-}
      marker_id=\${marker_id%.lock}
      if [ -z "$multi_waiting_sequence" ] || [ "$marker_sequence" -lt "$multi_waiting_sequence" ]; then
        multi_waiting_slots=$marker_slots
        multi_waiting_id=$marker_id
        multi_waiting_sequence=$marker_sequence
      fi
    fi
  fi
  exec 7>&-
done
flock -u 6
exec 6>&-
landing_waiting_slots=0
landing_waiting_id=-
landing_waiting_started=
landing_waiting_sequence=
exec 6>"${ROOT}/slots/landing-queue.lock"
flock -x 6
for landing_marker in ${ROOT}/slots/landing-wait-*.lock; do
  [ -e "$landing_marker" ] || continue
  exec 7<>"$landing_marker" || continue
  if flock -n 7; then
    rm -f -- "$landing_marker"
    flock -u 7
  else
    marker_slots=
    marker_started=
    marker_sequence=
    read -r marker_slots marker_started marker_sequence <&7 || true
    case "$marker_slots:$marker_started:$marker_sequence" in *[!0-9:]*|:*|*:) marker_slots=; marker_sequence= ;; esac
    if [ -n "$marker_slots" ] && { [ -z "$landing_waiting_sequence" ] || [ "$marker_sequence" -lt "$landing_waiting_sequence" ]; }; then
      landing_waiting_slots=$marker_slots
      landing_marker_id=\${landing_marker##*/landing-wait-}
      landing_waiting_id=\${landing_marker_id%.lock}
      landing_waiting_started=$marker_started
      landing_waiting_sequence=$marker_sequence
    fi
  fi
  exec 7>&-
done
flock -u 6
exec 6>&-
printf 'PROCESSORS %s\\nSLICE_PROCESSORS %s\\nLOAD %s\\nMEMORY_RESERVED %s\\nORDINARY_SLOTS_USED %s\\nEXPRESS_SLOT_USED %s\\nGATE_WAITING %s\\nMULTI_SLOT_WAITING_SLOTS %s\\nMULTI_SLOT_WAITING_ID %s\\nLANDING_WAITING_SLOTS %s\\nLANDING_WAITING_ID %s\\n' "$processors" "$slice_processors" "$load" "$memory_reserved" "$ordinary_slots_used" "$express_slot_used" "$gate_waiting" "$multi_waiting_slots" "$multi_waiting_id" "$landing_waiting_slots" "$landing_waiting_id"`;
}

/** Holds a marker while a gate waits, so single-slot checks can prefer unmarked hosts. */
function gateMarkerScript(): string {
  return `# REMOTE_CHECK_GATE_MARKER
mkdir -p ${ROOT}/slots
exec 8>"${ROOT}/slots/gate-wait.lock"
flock -n 8 || exit ${SLOT_BUSY}
echo GATE_MARKER
exec cat >/dev/null`;
}

/** Holds a wait marker until a multi-slot run starts, gives up or is aborted. */
function multiSlotMarkerScript(id: string, slots: number): string {
  const marker = `${ROOT}/slots/multi-wait-${id}.lock`;
  return `# REMOTE_CHECK_MULTI_SLOT_MARKER
# REMOTE_CHECK_MULTI_SLOT_COUNT ${slots}
# REMOTE_CHECK_MULTI_SLOT_ID ${id}
set -eu
mkdir -p ${ROOT}/slots
exec 6>"${ROOT}/slots/multi-queue.lock"
flock -x 6
exec 8>${quote(marker)}
flock -n 8 || { flock -u 6; exit ${SLOT_BUSY}; }
trap 'rm -f -- ${quote(marker)}; exit 0' HUP INT TERM
sequence_file=${ROOT}/slots/multi-wait-sequence
sequence=0
if [ -e "$sequence_file" ]; then read -r sequence < "$sequence_file" || sequence=0; fi
case "$sequence" in ''|*[!0-9]*) sequence=0 ;; esac
sequence=$((sequence + 1))
printf '%s\\n' "$sequence" > "$sequence_file"
printf '%s %s %s\\n' ${slots} "$(date +%s%N)" "$sequence" >&8
flock -u 6
exec 6>&-
echo MULTI_SLOT_MARKER
cat >/dev/null
rm -f -- ${quote(marker)}`;
}

/** Holds a priority marker until a landing run starts, gives up or is aborted. */
function landingMarkerScript(id: string, slots: number, arrivalOrder: string): string {
  const marker = `${ROOT}/slots/landing-wait-${id}.lock`;
  return `# REMOTE_CHECK_LANDING_MARKER\n# REMOTE_CHECK_LANDING_COUNT ${slots}\n# REMOTE_CHECK_LANDING_ID ${id}\n# REMOTE_CHECK_LANDING_ARRIVAL ${arrivalOrder}\nset -eu\nmkdir -p ${ROOT}/slots\nexec 6>"${ROOT}/slots/landing-queue.lock"\nflock -x 6\nexec 8>${quote(marker)}\nflock -n 8 || { flock -u 6; exit ${SLOT_BUSY}; }\ntrap 'rm -f -- ${quote(marker)}; exit 0' HUP INT TERM\nsequence_file=${ROOT}/slots/landing-wait-sequence\nsequence=0\nif [ -e "$sequence_file" ]; then read -r sequence < "$sequence_file" || sequence=0; fi\ncase "$sequence" in ''|*[!0-9]*) sequence=0 ;; esac\nsequence=$((sequence + 1))\nprintf '%s\\n' "$sequence" > "$sequence_file"\nprintf '%s %s %s\\n' ${slots} ${arrivalOrder} "$sequence" >&8\nflock -u 6\nexec 6>&-\necho LANDING_MARKER\ncat >/dev/null\nrm -f -- ${quote(marker)}`;
}

/** Takes all requested slots together, or none. The host reservation protects only this short take. */
export function slotScript(
  host: Host,
  count: number,
  slotLimit: number,
  ordinaryCapacity: number,
  ordinaryAdmissionLimit: number,
  shortRun: boolean,
  estimateMs: number | undefined,
  gate: boolean,
  priority: 'landing' | 'critical' | undefined = undefined,
  multiWaiterId: string | undefined,
  memoryReservationBytes: number,
  landingWaiterId: string | undefined,
): string {
  const slotFdStart = 10;
  const ordinaryLocks = (start: number, end: number, action: 'count' | 'take' | 'skip'): string =>
    Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
      const slot = start + offset;
      const fd = slotFdStart + slot;
      const lockPath = `${ROOT}/slots/${slot}.lock`;
      return `exec ${fd}>"${lockPath}"
if flock -n ${fd}; then
  ${
    action === 'take'
      ? `if [ "$acquired" -lt ${count} ] && [ "$((ordinary_used + acquired))" -lt "$ordinary_admission_limit" ]; then
    acquired=$((acquired + 1))
    printf '%s\\n' ${memoryReservationBytes} > "${ROOT}/slots/${slot}.memory"
    reserved_slots="$reserved_slots ${slot}"
  else
    flock -u ${fd}
    exec ${fd}>&-
  fi`
      : `flock -u ${fd}
  exec ${fd}>&-`
  }
else
  ${action === 'count' ? 'occupied=$((occupied + 1))\n  ordinary_used=$((ordinary_used + 1))' : action === 'skip' ? 'occupied=$((occupied + 1))' : ':'}
  exec ${fd}>&-
fi`;
    }).join('\n');
  const countBusyOrdinary = ordinaryLocks(0, ordinaryCapacity, 'count');
  const takeOrdinary = ordinaryLocks(0, ordinaryCapacity, 'take');
  const countOtherOrdinary = ordinaryLocks(ordinaryCapacity, host.slots - 1, 'skip');
  const expressFd = slotFdStart + host.slots - 1;
  const expressTake = shortRun
    ? `if [ "$acquired" -lt ${count} ]; then
  exec ${expressFd}>"${ROOT}/slots/express.lock"
  if flock -n ${expressFd}; then
    if [ "$acquired" -lt ${count} ]; then
      acquired=$((acquired + 1))
      printf '%s\\n' ${memoryReservationBytes} > "${ROOT}/slots/express.memory"
      reserved_slots="$reserved_slots express"
    else
      flock -u ${expressFd}
      exec ${expressFd}>&-
    fi
  else
    occupied=$((occupied + 1))
    exec ${expressFd}>&-
  fi
fi`
    : '';
  const gateRemainder = ordinaryCapacity - Math.max(0, ordinaryCapacity - 1);
  const markerPolicy = `gate_waiting=0
gate_marker=${ROOT}/slots/gate-wait.lock
if [ -e "$gate_marker" ]; then
  exec 7<>"$gate_marker"
  if flock -n 7; then
    rm -f -- "$gate_marker"
    flock -u 7
  else
    gate_waiting=1
  fi
  exec 7>&-
fi
landing_waiting_slots=0
landing_waiting_id=-
landing_waiting_sequence=
for landing_marker in ${ROOT}/slots/landing-wait-*.lock; do
  [ -e "$landing_marker" ] || continue
  exec 7<>"$landing_marker" || continue
  if flock -n 7; then rm -f -- "$landing_marker"; flock -u 7; else
    marker_slots=; marker_started=; marker_sequence=
    read -r marker_slots marker_started marker_sequence <&7 || true
    case "$marker_slots:$marker_started:$marker_sequence" in *[!0-9:]*|:*|*:) marker_slots=; marker_sequence= ;; esac
    if [ -n "$marker_slots" ] && { [ -z "$landing_waiting_sequence" ] || [ "$marker_sequence" -lt "$landing_waiting_sequence" ]; }; then
      landing_waiting_slots=$marker_slots
      landing_marker_id=\${landing_marker##*/landing-wait-}; landing_waiting_id=\${landing_marker_id%.lock}
      landing_waiting_started=$marker_started
      landing_waiting_sequence=$marker_sequence
    fi
  fi
  exec 7>&-
done
multi_waiting_slots=0
multi_waiting_id=-
multi_waiting_sequence=
exec 6>"${ROOT}/slots/multi-queue.lock"
flock -x 6
for multi_marker in ${ROOT}/slots/multi-wait-*.lock; do
  [ -e "$multi_marker" ] || continue
  exec 7<>"$multi_marker" || continue
  if flock -n 7; then
    rm -f -- "$multi_marker"
    flock -u 7
  else
    marker_slots=
    marker_started=
    marker_sequence=
    read -r marker_slots marker_started marker_sequence <&7 || true
    case "$marker_slots:$marker_started:$marker_sequence" in *[!0-9:]*|:*|*:) marker_slots=; marker_sequence= ;; esac
    if [ -n "$marker_slots" ]; then
      marker_id=\${multi_marker##*/multi-wait-}
      marker_id=\${marker_id%.lock}
      if [ -z "$multi_waiting_sequence" ] || [ "$marker_sequence" -lt "$multi_waiting_sequence" ]; then
        multi_waiting_slots=$marker_slots
        multi_waiting_id=$marker_id
        multi_waiting_sequence=$marker_sequence
      fi
    fi
  fi
  exec 7>&-
done
ordinary_admission_limit=${ordinaryAdmissionLimit}
wait_behind_older_multi=0
wait_behind_older_landing=0
if [ "$gate_waiting" -eq 1 ]; then
  if [ ${gate ? 1 : 0} -eq 1 ]; then
    ordinary_admission_limit=${ordinaryCapacity}
  else
    ordinary_admission_limit=${gateRemainder}
  fi
elif [ "$landing_waiting_slots" -gt 0 ] && [ ${gate ? 0 : 1} -eq 1 ]; then
  if [ ${landingWaiterId ? quote(landingWaiterId) : "''"} = "$landing_waiting_id" ]; then
    ordinary_admission_limit=${ordinaryCapacity}
  else
    ordinary_admission_limit=0
    wait_behind_older_landing=1
  fi
elif [ ${gate ? 1 : 0} -eq 0 ] && [ "$multi_waiting_slots" -gt 0 ]; then
  if [ ${multiWaiterId ? quote(multiWaiterId) : "''"} = "$multi_waiting_id" ]; then
    ordinary_admission_limit=${ordinaryCapacity}
  else
    ordinary_admission_limit=$(( ${ordinaryCapacity} - multi_waiting_slots ))
    if [ ${count > 1 && multiWaiterId ? 1 : 0} -eq 1 ]; then wait_behind_older_multi=1; fi
  fi
fi`;
  return `mkdir -p ${ROOT}/slots ${ROOT}/runs
# Stop runs abandoned by a dead client before taking any slot.
now=$(date +%s)
for run in ${ROOT}/runs/*; do
  [ -d "$run" ] || continue
  alive="$run/.alive"
  age=
  if [ -f "$alive" ]; then
    touched=$(stat -c %Y "$alive" 2>/dev/null || echo "$now")
    age="$((now - touched))"
    if [ "$age" -gt 600 ]; then
      run_id=\${run##*/}
      run_slice=rezics-check-$(printf '%s' "$run_id" | tr '-' '_').slice
      run_directory=$run
      ${cleanupCommands(false)}
      echo "remote-check: stopped stale run $run_id (alive file age $age s)" >&2
    else
      continue
    fi
  fi
  # Older clients have no liveness file: retain their existing inactive-directory cleanup rule.
  if [ -n "$(find "$run" -maxdepth 0 -mmin +60)" ] && ! systemctl is-active --quiet "rezics-check-\${run##*/}.scope"; then
    run_id=\${run##*/}
    run_slice=rezics-check-$(printf '%s' "$run_id" | tr '-' '_').slice
    run_directory=$run
    ${cleanupCommands()}
  fi
done
for unit in $(systemctl list-units --all --type=slice --plain --no-legend 'rezics-check-*.slice' 2>/dev/null | awk '{print $1}'); do
  tasks=$(systemctl show --property=TasksCurrent --value "$unit" 2>/dev/null || echo 1)
  if [ "$tasks" = 0 ]; then systemctl stop "$unit" >/dev/null 2>&1 || true; fi
done
REMOTE_CHECK_SLOT_TAKE=1
# REMOTE_CHECK_SLOT_COUNT ${count}
# REMOTE_CHECK_MEMORY_RESERVATION_BYTES ${memoryReservationBytes}
# REMOTE_CHECK_ORDINARY_COUNT ${ordinaryCapacity}
# REMOTE_CHECK_SLOT_CLASS ${shortRun ? 'short' : 'ordinary'}
# REMOTE_CHECK_ESTIMATE_MS ${estimateMs ?? 'none'}
# REMOTE_CHECK_SLOT_LIMIT ${slotLimit}
# REMOTE_CHECK_ORDINARY_ADMISSION_LIMIT ${ordinaryAdmissionLimit}
# REMOTE_CHECK_GATE_REQUEST ${gate ? 1 : 0}
# REMOTE_CHECK_PRIORITY ${priority ?? 'ordinary'}
# REMOTE_CHECK_MULTI_SLOT_WAITER_ID ${multiWaiterId ?? '-'}
# REMOTE_CHECK_LANDING_WAITER_ID ${landingWaiterId ?? '-'}
exec 8>"${ROOT}/slots/reserve.lock"
flock -x -n 8 || exit ${SLOT_BUSY}
${markerPolicy}
held_memory=0
slot=0
while [ "$slot" -lt ${Math.max(0, host.slots - 1)} ]; do
  lock=${ROOT}/slots/$slot.lock
  if [ ! -e "$lock" ]; then slot=$((slot + 1)); continue; fi
  exec 9<"$lock"
  if flock -n 9; then flock -u 9; else
    read -r amount < "${ROOT}/slots/$slot.memory" 2>/dev/null || amount=0
    case "$amount" in ''|*[!0-9]*) amount=0 ;; esac
    held_memory=$((held_memory + amount))
  fi
  exec 9<&-
  slot=$((slot + 1))
done
express_name=express
express_lock=${ROOT}/slots/$express_name.lock
if [ -e "$express_lock" ]; then
  exec 9<"$express_lock"
  if flock -n 9; then flock -u 9; else
    read -r amount < "${ROOT}/slots/express.memory" 2>/dev/null || amount=0
    case "$amount" in ''|*[!0-9]*) amount=0 ;; esac
    held_memory=$((held_memory + amount))
  fi
  exec 9<&-
fi
memory_max_bytes=$(awk -v memory_gib="${host.memoryMaxGiB}" 'BEGIN { printf "%.0f", memory_gib * 1073741824 }')
if [ "$((held_memory + ${count} * ${memoryReservationBytes}))" -gt "$memory_max_bytes" ]; then exit ${SLOT_BUSY}; fi
live_run_slots=0
for run in ${ROOT}/runs/*; do
  [ -d "$run" ] || continue
  [ -f "$run/.remote-check-slot-count" ] || continue
  [ ! -e "$run/exit-status" ] || continue
  run_slots=$(cat "$run/.remote-check-slot-count" 2>/dev/null || echo 0)
  case "$run_slots" in ''|*[!0-9]*) continue ;; esac
  run_id=\${run##*/}
  run_slice=rezics-check-$(printf '%s' "$run_id" | tr '-' '_').slice
  tasks=$(systemctl show --property=TasksCurrent --value "$run_slice" 2>/dev/null || echo 0)
  case "$tasks" in ''|*[!0-9]*) tasks=0 ;; esac
  if systemctl is-active --quiet "$run_slice" && [ "$tasks" -gt 0 ]; then live_run_slots=$((live_run_slots + run_slots)); fi
done
if [ "$((live_run_slots + ${count}))" -gt ${slotLimit} ]; then exit ${SLOT_BUSY}; fi
occupied=0
acquired=0
reserved_slots=
ordinary_used=0
# REMOTE_CHECK_ORDINARY_BUSY_COUNT_PASS
${countBusyOrdinary}
if [ "$wait_behind_older_multi" -eq 1 ] || { [ "\${wait_behind_older_landing:-0}" -eq 1 ] && [ ${shortRun ? 0 : 1} -eq 1 ]; } || { [ ${priority !== undefined ? 1 : 0} -eq 1 ] && [ "$gate_waiting" -eq 1 ]; }; then exit ${SLOT_BUSY}; fi
${takeOrdinary}
${expressTake}
${countOtherOrdinary}
if [ "$acquired" -ne ${count} ] || [ "$((occupied + acquired))" -gt ${slotLimit} ]; then
  for slot in $reserved_slots; do rm -f -- "${ROOT}/slots/$slot.memory"; done
  exit ${SLOT_BUSY}
fi
flock -u 8
exec 8>&-
flock -u 6
exec 6>&-
mkdir -p ${ROOT}/bases
# Keep the parent slot descriptors open while base cleanup reuses descriptor 9.
(
exec 9>"${ROOT}/bases/.lock"
flock -x 9
current=$(readlink -f ${ROOT}/bases/current 2>/dev/null || true)
for base in ${ROOT}/bases/*; do
  [ -d "$base" ] || continue
  [ "$base" = "$current" ] && continue
  if [ -n "$(find "$base" -maxdepth 0 -mmin +${BASE_RETENTION_SECONDS / 60})" ]; then rm -rf -- "$base"; fi
done
flock -u 9
)
echo "SLOTS ${count}"
run_id=
run_directory=
run_slice=
if IFS= read -r run_id; then
  case "$run_id" in ''|*[!a-zA-Z0-9-]*) run_id= ;; esac
  if [ -n "$run_id" ]; then
    run_directory=${ROOT}/runs/$run_id
    run_slice=rezics-check-$(printf '%s' "$run_id" | tr '-' '_').slice
    mkdir -p "$run_directory"
    printf '%s\\n' ${count} > "$run_directory/.remote-check-slot-count"
  fi
fi
cleanup_orphan() {
  if [ -n "$run_id" ] && [ -n "$run_directory" ] && [ ! -e "$run_directory/exit-status" ]; then
    ${cleanupCommands()}
  fi
  for slot in $reserved_slots; do rm -f -- "${ROOT}/slots/$slot.memory"; done
}
trap cleanup_orphan EXIT
cat >/dev/null`;
}

const dockerWrapper = readFileSync(join(import.meta.dir, 'check-host/docker'), 'utf8');

function runSlice(id: string): string {
  return `rezics-check-${id.replaceAll('-', '_')}.slice`;
}

/** Both normal cleanup and the stale-directory sweep remove only containers labelled for this run. */
function cleanupCommands(removeDirectory = true): string {
  return `systemctl stop "rezics-check-$run_id.scope" >/dev/null 2>&1
docker ps -aq --filter "label=rezics.check.run=$run_id" | while IFS= read -r container; do
  [ -z "$container" ] || docker rm -f -v "$container" >/dev/null 2>&1
done
systemctl stop "$run_slice" >/dev/null 2>&1
${removeDirectory ? 'rm -rf -- "$run_directory"' : ''}`;
}

/**
 * The docker wrapper is written beside the run's files and comes first on the path, so every `docker` a workspace
 * starts is the one that adds the slice, whatever the workspace is.
 */
export function runScript(
  id: string,
  directory: string,
  cwd: string,
  command: string[],
  hostName: string,
  progressIntervalMs = DEFAULT_LIVENESS_INTERVAL_MS,
  priorityClass = 'ordinary',
): string {
  const { version: pinnedBunVersion, revision: pinnedBunRevision } = getPinnedBun();
  const wrapperDirectory = `${directory}/.temp/check-host`;
  const statusFile = `${directory}/exit-status`;
  const systemdScript = `host=$REMOTE_CHECK_HOST
    install_started=$(date +%s%N)
    expected_bun=${quote(pinnedBunVersion)}
    expected_revision=${quote(pinnedBunRevision)}
    case "$(uname -m)" in
      x86_64) build=x64; grep -q avx2 /proc/cpuinfo || build=x64-baseline ;;
      aarch64) build=aarch64 ;;
      *) echo "remote-check: unsupported check-host architecture $(uname -m)" >&2; exit 1 ;;
    esac
    # Cache the verified pinned runtime per host, version and build. Keep registry retries for transient TLS errors.
    pinned_cache=${ROOT}/pinned-bun/$expected_bun-$build
    cache_matches() { [ -x "$pinned_cache/package/bin/bun" ] && "$pinned_cache/package/bin/bun" --eval 'process.exit(Bun["revision"] === process.argv[1] ? 0 : 1)' "$expected_revision"; }
    if [ -n "\${REMOTE_CHECK_PINNED_BUN_PATH:-}" ]; then
      bun="$REMOTE_CHECK_PINNED_BUN_PATH"
      if ! "$bun" --eval 'process.exit(Bun["revision"] === process.argv[1] ? 0 : 1)' "$expected_revision"; then
        echo "remote-check: pinned Bun does not match packageManager $expected_bun" >&2
        exit 1
      fi
    else
      if ! cache_matches; then
        mkdir -p ${ROOT}/pinned-bun
        pinned_download=$(mktemp -d ${ROOT}/pinned-bun/.download.XXXXXX)
        if ! curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 "https://registry.npmjs.org/@oven/bun-linux-$build/-/bun-linux-$build-$expected_bun.tgz" | tar -xz -C "$pinned_download"; then
          rm -rf -- "$pinned_download"
          exit 1
        fi
        if ! "$pinned_download/package/bin/bun" --eval 'process.exit(Bun.revision === process.argv[1] ? 0 : 1)' "$expected_revision"; then
          echo "remote-check: downloaded Bun does not match packageManager $expected_bun" >&2
          rm -rf -- "$pinned_download"
          exit 1
        fi
        if ! mv -T "$pinned_download" "$pinned_cache" 2>/dev/null; then
          # A concurrent miss may have published first. Repair an invalid existing binary by atomic file rename;
          # moving a directory cannot replace a populated cache entry atomically.
          if ! cache_matches; then
            if ! mv -T "$pinned_download/package/bin/bun" "$pinned_cache/package/bin/bun"; then
              rm -rf -- "$pinned_download"
              exit 1
            fi
          fi
          rm -rf -- "$pinned_download"
        fi
        if ! cache_matches; then echo "remote-check: cached Bun does not match packageManager $expected_bun" >&2; exit 1; fi
      fi
      bun="$pinned_cache/package/bin/bun"
    fi
    mkdir -p ${quote(`${directory}/.temp/node-compile-cache`)}
    export NODE_COMPILE_CACHE=${quote(`${directory}/.temp/node-compile-cache`)}
    "$bun" install --frozen-lockfile
    code=$?
    if [ "$code" -eq 0 ]; then touch ${quote(`${directory}/.bun-install-complete`)}; fi
    install_finished=$(date +%s%N)
    awk -v elapsed="$((install_finished - install_started))" -v host="$host" 'BEGIN { printf "remote-check: bun install %.3f s on %s\\n", elapsed / 1000000000, host }' >&2
    if [ "$code" -eq 0 ]; then
      export PATH="$(dirname "$bun"):$PWD/node_modules/.bin:$PATH"
      cd "$1"
      code=$?
      shift
      if [ "$code" -eq 0 ]; then
        command_started=$(date +%s%N)
        touch ${quote(`${directory}/command-started`)}
        slice_cgroup=$(systemctl show --property=ControlGroup --value "$REZICS_CHECK_SLICE" 2>/dev/null)
        progress_pid=
        command_pid=
        stop_progress() {
          [ -z "$progress_pid" ] || kill "$progress_pid" 2>/dev/null || true
          [ -z "$progress_pid" ] || wait "$progress_pid" 2>/dev/null || true
          progress_pid=
        }
        trap 'stop_progress' EXIT
        trap 'stop_progress; if [ -n "$command_pid" ]; then kill "$command_pid" 2>/dev/null || true; wait "$command_pid" 2>/dev/null || true; fi' HUP INT TERM
        case "$slice_cgroup" in
          /*)
            cpu_stat="/sys/fs/cgroup$slice_cgroup/cpu.stat"
            progress_interval=${progressIntervalMs}
            progress_seconds=$(awk -v ms="$progress_interval" 'BEGIN { printf "%.3f", ms / 1000 }')
            (
              sleep_pid=
              stop_sleep() {
                [ -z "$sleep_pid" ] || kill "$sleep_pid" 2>/dev/null || true
                [ -z "$sleep_pid" ] || wait "$sleep_pid" 2>/dev/null || true
              }
              trap 'stop_sleep; exit 0' HUP INT TERM
              usage=$(awk '$1 == "usage_usec" { print $2 }' "$cpu_stat" 2>/dev/null)
              last_usage=\${usage:-0}
              while :; do
                sleep "$progress_seconds" &
                sleep_pid=$!
                wait "$sleep_pid" || break
                sleep_pid=
                usage=$(awk '$1 == "usage_usec" { print $2 }' "$cpu_stat" 2>/dev/null)
                case "$usage" in ''|*[!0-9]*) continue ;; esac
                if [ "$((usage - last_usage))" -ge 1000000 ]; then
                  cpu_seconds=$((usage / 1000000))
                  printf 'remote-check: running on %s, %s CPU seconds\\n' "$host" "$cpu_seconds" >&2
                  last_usage=$usage
                fi
              done
            ) &
            progress_pid=$!
            ;;
        esac
        "$@" &
        command_pid=$!
        wait "$command_pid"
        code=$?
        command_pid=
        stop_progress
        trap - EXIT HUP INT TERM
        command_finished=$(date +%s%N)
        awk -v elapsed="$((command_finished - command_started))" -v host="$host" 'BEGIN { printf "remote-check: command %.3f s on %s\\n", elapsed / 1000000000, host }' >&2
        ${installedPackageCacheCheck(directory, hostName)}
      fi
    fi
    run_finished=$(date +%s%N)
    if [ -r "$REZICS_CHECK_PHASES" ]; then
      awk -F '\t' 'NF != 3 || $1 == "" || ($2 != "start" && $2 != "end") || $3 !~ /^[0-9]+$/ { printf "remote-check: malformed command phase line %d\\n", NR > "/dev/stderr"; next }
        $2 == "start" { if ($1 in started) printf "remote-check: malformed command phase duplicate start %s\\n", $1 > "/dev/stderr"; else started[$1]=$3; next }
        !($1 in started) { printf "remote-check: malformed command phase unmatched end %s\\n", $1 > "/dev/stderr"; next }
        { printf "remote-check: command phase %s %.9f s\\n", $1, ($3-started[$1])/1000000000; delete started[$1] }
        END { for (phase in started) printf "remote-check: malformed command phase unmatched start %s\\n", phase > "/dev/stderr" }' "$REZICS_CHECK_PHASES"
    fi
    slice_cgroup=$(systemctl show --property=ControlGroup --value "$REZICS_CHECK_SLICE" 2>/dev/null)
    case "$slice_cgroup" in /*)
      usage=$(awk '$1 == "usage_usec" { print $2 }' "/sys/fs/cgroup$slice_cgroup/cpu.stat" 2>/dev/null)
      peak=$(cat "/sys/fs/cgroup$slice_cgroup/memory.peak" 2>/dev/null)
      if [ -n "$usage" ] && [ -n "$peak" ]; then
        awk -v usage="$usage" -v elapsed="$((run_finished - install_started))" -v peak="$peak" -v host="$host" 'BEGIN { seconds = elapsed / 1000000000; printf "remote-check: run used %.3f CPU seconds over %.3f s (%.2f cores), peak memory %d MiB on %s\\n", usage / 1000000, seconds, (seconds > 0 ? usage / 1000000 / seconds : 0), peak / 1048576, host }' >&2
      fi
      ;;
    esac
    printf '%s\\n' "$code" > ${quote(statusFile)}
    exit $code`;
  return `${refreshBaseScript(id, directory)}
mkdir -p ${wrapperDirectory} && cat > ${wrapperDirectory}/docker <<'WRAPPER' && chmod +x ${wrapperDirectory}/docker || exit 1
${dockerWrapper}WRAPPER
export PATH=${wrapperDirectory}:/usr/local/bin:$PATH BUN_INSTALL_CACHE_DIR=${ROOT}/bun-cache BUN_RUNTIME_TRANSPILER_CACHE_PATH=${directory}/bun-runtime-transpiler-cache PLAYWRIGHT_BROWSERS_PATH=${ROOT}/browsers KERNEL_CHECK_TIMINGS=${quote(`${directory}/.temp/kernel-check/timings`)} AUTH_CHECK_TIMINGS=${quote(`${directory}/.temp/auth-check/timings`)} KERNEL_CHECK_ON_REMOTE=1 REZICS_STACK_LEASE=off REMOTE_CHECK_HOST=${quote(hostName)} REZICS_CHECK_SLICE=${runSlice(id)} REZICS_CHECK_RUN=${id}
export REZICS_CHECK_PHASES=${quote(`${directory}/command-phases.tsv`)}
printf 'remote-check: run priority %s on %s\n' ${quote(priorityClass)} ${quote(hostName)} >&2
cd ${directory} || exit 1
touch ${quote(`${directory}/.alive`)}
# systemd 259 expands \${NAME} in --scope arguments by default, which broke the script's parameter expansions on c
# (842 failed runs from 10-28 18:36 UTC); older systemd has no such flag and does not expand.
expand_environment=
if systemd-run --help 2>/dev/null | grep -q -- '--expand-environment'; then expand_environment=--expand-environment=no; fi
exec systemd-run --scope --quiet --collect $expand_environment --slice=${runSlice(id)} --unit=rezics-check-${id} \\
  sh -c ${quote(systemdScript)} sh ${[cwd, ...command].map(quote).join(' ')}`;
}

function cleanupScript(id: string, directory: string): string {
  return `run_id=${quote(id)}
run_slice=${runSlice(id)}
run_directory=${quote(directory)}
${cleanupCommands()}`;
}

function heartbeatScript(directory: string): string {
  return `touch ${quote(`${directory}/.alive`)}`;
}

function stopRunScript(id: string): string {
  return `systemctl stop ${quote(runSlice(id))} >/dev/null 2>&1 || true`;
}

/** Serializes stale-base cleanup and reports the immutable current base used by this upload. */
function baseStateScript(): string {
  return `# REMOTE_CHECK_BASE_STATE
set -eu
mkdir -p ${ROOT}/bases
exec 9>"${ROOT}/bases/.lock"
flock -x 9
current=$(readlink -f ${ROOT}/bases/current 2>/dev/null || true)
for base in ${ROOT}/bases/*; do
  [ -d "$base" ] || continue
  [ "$base" = "$current" ] && continue
  if [ -n "$(find "$base" -maxdepth 0 -mmin +${BASE_RETENTION_SECONDS / 60})" ]; then rm -rf -- "$base"; fi
done
if [ -n "$current" ] && [ -d "$current" ]; then
  age=$(( $(date +%s) - $(stat -c %Y "$current") ))
  printf 'BASE %s\\nAGE %s\\n' "$current" "$age"
else
  printf 'BASE -\\nAGE -\\n'
fi
if rsync --version 2>/dev/null | grep -qi zstd; then echo ZSTD 1; else echo ZSTD 0; fi
flock -u 9`;
}

/** Refreshes only when the current immutable base is old enough; replacing the symlink is atomic. */
function refreshBaseScript(id: string, directory: string): string {
  return `# REMOTE_CHECK_BASE_REFRESH
set -eu
if [ -d ${quote(directory)} ]; then
mkdir -p ${ROOT}/bases
exec 9>"${ROOT}/bases/.lock"
flock -x 9
current=$(readlink -f ${ROOT}/bases/current 2>/dev/null || true)
refresh=0
if [ -z "$current" ] || [ ! -d "$current" ]; then refresh=1
else age=$(( $(date +%s) - $(stat -c %Y "$current") )); [ "$age" -ge ${BASE_REFRESH_INTERVAL_SECONDS} ] && refresh=1 || true
fi
if [ "$refresh" -eq 1 ]; then
  name="$(date +%s)-${id}"
  staging=${ROOT}/bases/.new-${id}
  target=${ROOT}/bases/$name
  rm -rf -- "$staging"
  mkdir -p "$staging"
  cp -a ${quote(directory)}/. "$staging"/
  mv -- "$staging" "$target"
  ln -s "$target" ${ROOT}/bases/.current-${id}
  mv -Tf ${ROOT}/bases/.current-${id} ${ROOT}/bases/current
fi
flock -u 9
fi`;
}

function localRsyncSupportsZstd(): boolean {
  const result = Bun.spawnSync(['rsync', '--version'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  return result.exitCode === 0 && /zstd/i.test(result.stdout.toString());
}

/** Reads the command's recorded exit status when ssh itself reports 255. */
function statusScript(directory: string): string {
  return `# REMOTE_CHECK_STATUS
if [ -e ${quote(`${directory}/exit-status`)} ]; then cat -- ${quote(`${directory}/exit-status`)}
elif [ -e ${quote(`${directory}/command-started`)} ]; then printf 'STARTED\\n'
else printf 'NOT_STARTED\\n'; fi`;
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
    if (
      parts[0] === '.git' ||
      parts[0] === '.temp' ||
      parts.includes('node_modules') ||
      parts.some((part) =>
        ['build', 'dist', 'out', 'coverage', '.next', '.turbo', 'playwright-report', 'test-results'].includes(part),
      )
    )
      return false;
    try {
      return lstatSync(resolve(workspace, file)).isFile() || lstatSync(resolve(workspace, file)).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

type Lease = { host: Host; release: () => Promise<void>; registerRun?: (id: string) => Promise<void> };
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

export type CheckWaitRecorder = { begin(): void; record(): void; stop(): void };

/** Records elapsed wait time in full-line appends, without allowing a reporting error to fail the check. */
export function checkWaitRecorder(file = process.env.GOAL_CHECK_WAIT_FILE): CheckWaitRecorder {
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
  availableMemory: number;
  tmpBytes: number;
  tmpInodes: number;
  memoryHeadroom: number;
  memoryReserved: number;
  memoryMaximum: number | null;
  ordinarySlotsUsed: number;
  expressSlotUsed: boolean;
  gateWaiting: boolean;
  multiWaitingSlots: number;
  multiWaitingId: string | null;
  landingWaitingSlots: number;
  landingWaitingId: string | null;
};
type RankedHost = {
  host: Host;
  capacity: number;
  ordinaryCapacity: number;
  ordinaryAdmissionLimit: number;
  gateCapacity: number;
  resourceSlots: number;
  freeSlots: number;
  slotLimit: number;
  memoryHeadroom: number;
  memoryReserved: number;
  gateWaiting: boolean;
  ordinarySlotsUsed: number;
  expressSlotUsed: boolean;
  landingWaitingSlots: number;
};

function hostCapacity(host: Host, probe: HostProbe): number {
  const processorSlots = Math.floor(probe.sliceProcessors / host.processorsPerSlot);
  return Math.min(host.slots, processorSlots);
}

function probeCapacity(capacity: number): number {
  return capacity;
}

function rankHost(
  host: Host,
  probe: HostProbe,
  slots: number,
  estimateMs: number | undefined,
  gate: boolean,
  priority: 'landing' | 'critical' | undefined = undefined,
  multiWaiterId?: string,
  memoryReservationBytes = CHECK_SLOT_MEMORY_BYTES,
  landingWaiterId?: string,
): RankedHost {
  const capacity = hostCapacity(host, probe);
  const ordinaryCapacity = Math.max(0, capacity - 1);
  const gateCapacity = Math.max(0, ordinaryCapacity - 1);
  const hasMultiWaiter = !probe.gateWaiting && probe.multiWaitingSlots > 0;
  const isOldestMultiWaiter = hasMultiWaiter && multiWaiterId !== undefined && probe.multiWaitingId === multiWaiterId;
  const waitsBehindOlderMulti = hasMultiWaiter && slots > 1 && multiWaiterId !== undefined && !isOldestMultiWaiter;
  const hasLandingWaiter = probe.landingWaitingSlots > 0;
  const isOldestLandingWaiter =
    hasLandingWaiter && landingWaiterId !== undefined && probe.landingWaitingId === landingWaiterId;
  const waitsBehindLanding = hasLandingWaiter && !gate && !isOldestLandingWaiter;
  const ordinaryAdmissionLimit = gate
    ? ordinaryCapacity
    : probe.gateWaiting
      ? ordinaryCapacity - gateCapacity
      : hasLandingWaiter
        ? isOldestLandingWaiter
          ? ordinaryCapacity
          : 0
        : hasMultiWaiter
          ? isOldestMultiWaiter
            ? ordinaryCapacity
            : ordinaryCapacity - probe.multiWaitingSlots
          : ordinaryCapacity;
  const resourceSlots = probeCapacity(capacity);
  const memoryMaximum = host.memoryMaxGiB * 2 ** 30;
  const shortRun = priority === undefined && isShortRun(slots, estimateMs, gate);
  let freeSlots: number;
  let slotLimit: number;
  if (shortRun) {
    const ordinaryFreeSlots = Math.min(resourceSlots, Math.max(0, ordinaryAdmissionLimit - probe.ordinarySlotsUsed));
    const expressFree = !probe.expressSlotUsed && resourceSlots > 0;
    const selected = selectSlotClass(ordinaryFreeSlots, expressFree, slots, estimateMs, gate);
    const occupied = probe.ordinarySlotsUsed + Number(probe.expressSlotUsed);
    freeSlots = selected === null ? 0 : Math.min(resourceSlots, Math.max(0, capacity - occupied));
    slotLimit = Math.min(capacity, occupied + resourceSlots);
  } else {
    const admissionLimit = gate ? (probe.gateWaiting ? ordinaryCapacity : gateCapacity) : ordinaryAdmissionLimit;
    freeSlots = Math.min(resourceSlots, Math.max(0, admissionLimit - probe.ordinarySlotsUsed));
    slotLimit = Math.min(admissionLimit, probe.ordinarySlotsUsed + resourceSlots);
  }
  if (probe.memoryReserved + slots * memoryReservationBytes > memoryMaximum) freeSlots = 0;
  if (waitsBehindOlderMulti) freeSlots = 0;
  if (
    (waitsBehindLanding && !shortRun) ||
    (priority === 'landing' && probe.gateWaiting) ||
    (priority === 'landing' && hasLandingWaiter && !isOldestLandingWaiter)
  )
    freeSlots = 0;
  return {
    host,
    capacity,
    ordinaryCapacity,
    ordinaryAdmissionLimit,
    gateCapacity,
    resourceSlots,
    freeSlots,
    slotLimit,
    memoryHeadroom: probe.memoryHeadroom,
    memoryReserved: probe.memoryReserved,
    gateWaiting: probe.gateWaiting,
    ordinarySlotsUsed: probe.ordinarySlotsUsed,
    expressSlotUsed: probe.expressSlotUsed,
    landingWaitingSlots: probe.landingWaitingSlots,
  };
}

function requestedSlotCap(ranked: RankedHost[], shortRun: boolean, requestedSlots: number): number {
  const eligible = ranked.filter(({ capacity, ordinaryCapacity }) => (shortRun ? capacity : ordinaryCapacity) > 0);
  const capacities = eligible.length > 0 ? eligible : ranked;
  const physicalCap = Math.max(1, Math.floor(Math.min(...capacities.map(({ capacity }) => capacity)) / 2));
  if (shortRun) return physicalCap;
  if (eligible.length === 0) return requestedSlots === 1 ? 0 : physicalCap;
  const ordinaryCap = Math.min(...eligible.map(({ ordinaryCapacity }) => ordinaryCapacity));
  return Math.min(physicalCap, ordinaryCap);
}

type SlotClass = 'ordinary' | 'express';

/** Selects a slot class, preferring ordinary capacity and reserving express for eligible short runs. */
export function selectSlotClass(
  ordinaryFreeSlots: number,
  expressFree: boolean,
  slots: number,
  estimateMs: number | undefined,
  gate = false,
): SlotClass | null {
  if (isShortRun(slots, estimateMs, gate)) {
    if (ordinaryFreeSlots > 0) return 'ordinary';
    return expressFree ? 'express' : null;
  }
  return ordinaryFreeSlots >= slots ? 'ordinary' : null;
}

function parseProbe(output: string): HostProbe | null {
  const value = (name: string): string | null => output.match(new RegExp(`^${name} ([^\\r\\n]+)$`, 'm'))?.[1] ?? null;
  const processorValue = value('PROCESSORS');
  const sliceProcessorValue = value('SLICE_PROCESSORS');
  const loadValue = value('LOAD');
  const availableValue = value('AVAILABLE');
  const tmpBytesValue = value('TMP_BYTES');
  const tmpInodesValue = value('TMP_INODES');
  const headroomValue = value('MEMORY_HEADROOM');
  const reservedValue = value('MEMORY_RESERVED');
  const processors = Number(processorValue);
  const sliceProcessors = Number(sliceProcessorValue);
  const load = Number(loadValue);
  const availableMemory = Number(availableValue);
  const tmpBytes = Number(tmpBytesValue);
  const tmpInodes = Number(tmpInodesValue);
  const memoryHeadroom = Number(headroomValue);
  const memoryReserved = Number(reservedValue);
  const ordinarySlotsUsedValue = value('ORDINARY_SLOTS_USED') ?? value('SLOTS_USED');
  const ordinarySlotsUsed = Number(ordinarySlotsUsedValue);
  const expressSlotUsedValue = value('EXPRESS_SLOT_USED') ?? '0';
  const expressSlotUsed = expressSlotUsedValue === '1';
  const current = value('MEMORY_CURRENT');
  const maximum = value('MEMORY_MAX');
  const sliceMemory = current !== null && maximum !== null && /^\d+$/.test(current) && /^\d+$/.test(maximum);
  const memoryFallback = current === '-' && maximum === '-';
  const gateWaitingValue = value('GATE_WAITING');
  const gateWaiting = gateWaitingValue === '1';
  const multiWaitingSlotsValue = value('MULTI_SLOT_WAITING_SLOTS');
  const multiWaitingSlots = Number(multiWaitingSlotsValue);
  const multiWaitingIdValue = value('MULTI_SLOT_WAITING_ID');
  const multiWaitingId = multiWaitingIdValue === '-' ? null : multiWaitingIdValue;
  const landingWaitingSlotsValue = value('LANDING_WAITING_SLOTS');
  const landingWaitingSlots = Number(landingWaitingSlotsValue);
  const landingWaitingIdValue = value('LANDING_WAITING_ID');
  const landingWaitingId = landingWaitingIdValue === '-' ? null : landingWaitingIdValue;
  if (
    processorValue === null ||
    sliceProcessorValue === null ||
    loadValue === null ||
    availableValue === null ||
    tmpBytesValue === null ||
    tmpInodesValue === null ||
    headroomValue === null ||
    reservedValue === null ||
    !Number.isSafeInteger(processors) ||
    processors < 1 ||
    !Number.isFinite(sliceProcessors) ||
    sliceProcessors < 0 ||
    !Number.isFinite(load) ||
    load < 0 ||
    !Number.isSafeInteger(availableMemory) ||
    availableMemory < 0 ||
    !Number.isSafeInteger(tmpBytes) ||
    tmpBytes < 0 ||
    !Number.isSafeInteger(tmpInodes) ||
    tmpInodes < 0 ||
    !Number.isSafeInteger(memoryHeadroom) ||
    memoryHeadroom < 0 ||
    !Number.isSafeInteger(memoryReserved) ||
    memoryReserved < 0 ||
    ordinarySlotsUsedValue === null ||
    !Number.isSafeInteger(ordinarySlotsUsed) ||
    ordinarySlotsUsed < 0 ||
    ordinarySlotsUsed > 1_000_000 ||
    (expressSlotUsedValue !== '0' && expressSlotUsedValue !== '1') ||
    (gateWaitingValue !== '0' && gateWaitingValue !== '1') ||
    multiWaitingSlotsValue === null ||
    !Number.isSafeInteger(multiWaitingSlots) ||
    multiWaitingSlots < 0 ||
    multiWaitingSlots > 1_000_000 ||
    multiWaitingIdValue === null ||
    (multiWaitingId !== null && !/^[a-zA-Z0-9-]+$/.test(multiWaitingId)) ||
    (multiWaitingSlots === 0) !== (multiWaitingId === null) ||
    landingWaitingSlotsValue === null ||
    !Number.isSafeInteger(landingWaitingSlots) ||
    landingWaitingSlots < 0 ||
    landingWaitingSlots > 1_000_000 ||
    landingWaitingIdValue === null ||
    (landingWaitingId !== null && !/^[a-zA-Z0-9-]+$/.test(landingWaitingId)) ||
    (landingWaitingSlots === 0) !== (landingWaitingId === null) ||
    (!sliceMemory && !memoryFallback)
  )
    return null;
  return {
    processors,
    sliceProcessors,
    load,
    availableMemory,
    tmpBytes,
    tmpInodes,
    memoryHeadroom,
    memoryReserved,
    memoryMaximum: sliceMemory ? Number(maximum) : null,
    ordinarySlotsUsed,
    expressSlotUsed,
    gateWaiting,
    multiWaitingSlots,
    multiWaitingId,
    landingWaitingSlots,
    landingWaitingId,
  };
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
    registerRun: async (id: string) => {
      holder.stdin.write(`${id}\n`);
      await holder.stdin.flush();
    },
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
  signal.addEventListener('abort', stop, { once: true });
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
    accepted = true;
    // Keep the session's input pipe live while the remote script holds its marker and reads until EOF.
    holder.stdin.write('\n');
    await holder.stdin.flush();
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

/** Takes one or more slots under a short host-wide reservation. */
async function takeSlots(
  host: Host,
  count: number,
  slotLimit: number,
  ordinaryCapacity: number,
  ordinaryAdmissionLimit: number,
  shortRun: boolean,
  estimateMs: number | undefined,
  gate: boolean,
  priority: 'landing' | 'critical' | undefined = undefined,
  multiWaiterId: string | undefined,
  memoryReservationBytes: number,
  landingWaiterId: string | undefined,
  signal: AbortSignal,
): Promise<Lease | null> {
  return takeSession(
    host,
    slotScript(
      host,
      count,
      slotLimit,
      ordinaryCapacity,
      ordinaryAdmissionLimit,
      shortRun,
      estimateMs,
      gate,
      priority,
      multiWaiterId,
      memoryReservationBytes,
      landingWaiterId,
    ),
    /^SLOTS? \d+$/m,
    signal,
  );
}

async function takeGateMarker(host: Host, signal: AbortSignal): Promise<SessionLease | null> {
  return takeSession(host, gateMarkerScript(), /^GATE_MARKER$/m, signal);
}

async function takeMultiSlotMarker(
  host: Host,
  id: string,
  slots: number,
  signal: AbortSignal,
): Promise<SessionLease | null> {
  return takeSession(host, multiSlotMarkerScript(id, slots), /^MULTI_SLOT_MARKER$/m, signal);
}

async function takeLandingMarker(
  host: Host,
  id: string,
  slots: number,
  arrivalOrder: string,
  signal: AbortSignal,
): Promise<SessionLease | null> {
  return takeSession(host, landingMarkerScript(id, slots, arrivalOrder), /^LANDING_MARKER$/m, signal);
}

/** Hosts that can admit slots, with the most resource-backed free slots first. */
async function rankedHosts(
  hosts: Host[],
  signal: AbortSignal,
  slots: number,
  estimateMs: number | undefined,
  gate: boolean,
  preferUngated = false,
  multiWaiterId?: string,
  loggedSkips: Map<string, string> = new Map(),
  loggedSkipLines: Set<string> = new Set(),
  memoryReservationBytes = CHECK_SLOT_MEMORY_BYTES,
  priority: 'landing' | 'critical' | undefined = undefined,
  landingWaiterId?: string,
): Promise<RankedHost[]> {
  const probes = await Promise.all(hosts.map(async (host) => ({ host, probe: await probeHost(host) })));
  if (signal.aborted) throw new Aborted();
  const skipped: Array<{ host: Host; probe: HostProbe }> = [];
  for (const entry of probes) {
    const probe = entry.probe;
    if (probe === null) continue;
    const limit = probe.sliceProcessors * CHECK_HOST_MAX_LOAD_PER_PROCESSOR;
    const reason =
      probe.load > limit
        ? `${entry.host.name}: load ${probe.load} exceeds limit ${limit}`
        : probe.availableMemory < CHECK_HOST_MIN_AVAILABLE_BYTES
          ? `${entry.host.name}: MemAvailable ${probe.availableMemory} bytes is under ${CHECK_HOST_MIN_AVAILABLE_BYTES} bytes`
          : probe.tmpBytes < CHECK_HOST_MIN_TMP_BYTES
            ? `${entry.host.name}: /tmp ${probe.tmpBytes} free bytes is under ${CHECK_HOST_MIN_TMP_BYTES} required bytes`
            : probe.tmpInodes < CHECK_HOST_MIN_TMP_INODES
              ? `${entry.host.name}: /tmp ${probe.tmpInodes} free inodes is under ${CHECK_HOST_MIN_TMP_INODES} required inodes`
              : undefined;
    if (!reason) continue;
    skipped.push({ host: entry.host, probe });
    loggedSkips.set(entry.host.name, reason);
    if (!loggedSkipLines.has(entry.host.name)) {
      console.error(`remote-check: skipped ${reason}`);
      loggedSkipLines.add(entry.host.name);
    }
  }
  return (
    probes
      .filter((entry): entry is { host: Host; probe: HostProbe } => entry.probe !== null)
      .filter(({ host, probe }) => !skipped.some(({ host: skippedHost }) => skippedHost.name === host.name))
      .map(({ host, probe }) =>
        rankHost(
          host,
          probe,
          slots,
          estimateMs,
          gate,
          priority,
          multiWaiterId,
          memoryReservationBytes,
          landingWaiterId,
        ),
      )
      // Equal slot counts prefer the host with more measured slice memory headroom.
      .sort(
        (left, right) =>
          (preferUngated ? Number(left.gateWaiting) - Number(right.gateWaiting) : 0) ||
          right.freeSlots - left.freeSlots ||
          right.memoryHeadroom - left.memoryHeadroom,
      )
  );
}

/** One probe round. Responding hosts are ranked by resource-backed free slots. */
export async function answeringHosts(hosts: Host[]): Promise<Host[]> {
  return (await rankedHosts(hosts, new AbortController().signal, 1, undefined, false)).map(({ host }) => host);
}

/** Tries every host's slots once, most resource-backed free slots first, and never waits for one. */
async function acquireOnce(
  hosts: Host[],
  requestedSlots: number,
  estimateMs: number | undefined,
  signal: AbortSignal,
  gate = false,
  memoryReservationBytes = CHECK_SLOT_MEMORY_BYTES,
  priority: 'landing' | 'critical' | undefined = undefined,
): Promise<Lease | null> {
  const landingWaiterId = priority !== undefined ? randomUUID() : undefined;
  const ranked = await rankedHosts(
    hosts,
    signal,
    requestedSlots,
    estimateMs,
    gate,
    false,
    undefined,
    new Map(),
    new Set(),
    memoryReservationBytes,
    priority,
    landingWaiterId,
  );
  let slots = requestedSlots;
  if (ranked.length > 0) {
    if (gate) {
      const largestAdmissible = Math.max(...ranked.map(({ gateCapacity }) => gateCapacity));
      if (largestAdmissible < 1)
        throw new Error('remote-check: no check host can run the gate while leaving one slot free');
      if (slots > largestAdmissible) {
        slots = largestAdmissible;
        console.error(
          `remote-check: gate requested ${requestedSlots} slots; using ${slots} to leave one slot of the host free`,
        );
      }
    } else {
      const cap = requestedSlotCap(
        ranked,
        priority === undefined && isShortRun(requestedSlots, estimateMs, gate),
        requestedSlots,
      );
      if (requestedSlots > cap) throw new SlotRequestTooLarge(cap, requestedSlots);
    }
  }
  for (const entry of startableHosts(ranked, slots, gate)) {
    const { host, freeSlots, slotLimit, ordinaryCapacity, ordinaryAdmissionLimit } = entry;
    if (freeSlots < slots) continue;
    const lease = await takeSlots(
      host,
      slots,
      slotLimit,
      ordinaryCapacity,
      ordinaryAdmissionLimit,
      priority === undefined && isShortRun(slots, estimateMs, gate),
      estimateMs,
      gate,
      priority,
      undefined,
      memoryReservationBytes,
      landingWaiterId,
      signal,
    );
    if (lease && signal.aborted) {
      await lease.release();
      throw new Aborted();
    }
    if (lease) return lease;
  }
  return null;
}

/** Uses fallback hosts only when no ordinary host can start this non-gate run in the current probe round. */
function startableHosts(ranked: RankedHost[], slots: number, gate: boolean): RankedHost[] {
  if (gate) return ranked;
  const startable = ranked.filter(({ freeSlots }) => freeSlots >= slots);
  const ordinary = startable.filter(({ host }) => !host.fallback);
  return ordinary.length > 0 ? ordinary : startable;
}

async function acquire(
  hosts: Host[],
  requestedSlots: number,
  estimateMs: number | undefined,
  pollMs: number,
  signal: AbortSignal,
  giveUpIfUnanswered = false,
  onAnswered?: () => void,
  gate = false,
  waitRepeatMs = 60_000,
  memoryReservationBytes = CHECK_SLOT_MEMORY_BYTES,
  priority: 'landing' | 'critical' | undefined = undefined,
): Promise<Lease | null> {
  let answered = false;
  let slots = requestedSlots;
  let warnedGateReduction = false;
  let marker: SessionLease | undefined;
  let markerHost: string | undefined;
  let landingMarker: SessionLease | undefined;
  let landingMarkerHost: string | undefined;
  const landingWaiterId = priority !== undefined && !gate ? randomUUID() : undefined;
  const landingArrivalOrder = landingWaiterId
    ? String(Math.floor((performance.timeOrigin + performance.now()) * 1_000))
    : undefined;
  const multiWaiterId = !gate && priority === undefined && slots > 1 ? randomUUID() : undefined;
  const priorityClass = gate ? 'gate' : (priority ?? (slots > 1 ? 'multi-slot' : 'ordinary'));
  const wait = checkWaitRecorder();
  const skippedHosts = new Map<string, string>();
  const loggedSkipLines = new Set<string>();
  let waitingHosts: RankedHost[] = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const printWaiting = (): void => {
    const state = waitingHosts.length
      ? waitingHosts
          .map(
            ({ host, freeSlots, slotLimit, memoryReserved }) =>
              `${host.name} ${freeSlots}/${slotLimit} free, memory ${memoryReserved / 2 ** 30} GiB reserved + ${(slots * memoryReservationBytes) / 2 ** 30} GiB requested of ${host.memoryMaxGiB} GiB`,
          )
          .join(', ')
      : 'no responding hosts';
    const reasons = [...skippedHosts.values()];
    console.error(
      `remote-check: every check slot is busy; waiting for a free one (${state}); priority ${priorityClass}${reasons.length ? `; skipped ${reasons.join('; ')}` : ''}`,
    );
  };
  const announceWait = (ranked: RankedHost[]): void => {
    wait.begin();
    waitingHosts = ranked;
    if (heartbeat) return;
    printWaiting();
    heartbeat = setInterval(printWaiting, waitRepeatMs);
  };
  try {
    while (true) {
      if (marker && !marker.isActive()) {
        await marker.release();
        marker = undefined;
        markerHost = undefined;
      }
      if (landingMarker && !landingMarker.isActive()) {
        await landingMarker.release();
        landingMarker = undefined;
        landingMarkerHost = undefined;
      }
      const ranked = await rankedHosts(
        hosts,
        signal,
        slots,
        estimateMs,
        gate,
        slots === 1,
        multiWaiterId,
        skippedHosts,
        loggedSkipLines,
        memoryReservationBytes,
        priority,
        landingWaiterId,
      );
      if (multiWaiterId && markerHost && !ranked.some(({ host }) => host.name === markerHost)) {
        if (marker) await marker.release();
        marker = undefined;
        markerHost = undefined;
      }
      if (ranked.length > 0) {
        answered = true;
        onAnswered?.();
        if (gate) {
          const largestAdmissible = Math.max(...ranked.map(({ gateCapacity }) => gateCapacity));
          if (largestAdmissible < 1) {
            throw new Error('remote-check: no check host can run the gate while leaving one slot free');
          }
          if (slots > largestAdmissible) {
            slots = largestAdmissible;
            if (!warnedGateReduction) {
              console.error(
                `remote-check: gate requested ${requestedSlots} slots; using ${slots} to leave one slot of the host free`,
              );
              warnedGateReduction = true;
            }
          }
        } else {
          const cap = requestedSlotCap(
            ranked,
            priority === undefined && isShortRun(requestedSlots, estimateMs, gate),
            requestedSlots,
          );
          if (requestedSlots > cap) throw new SlotRequestTooLarge(cap, requestedSlots);
        }
      } else if (giveUpIfUnanswered && !answered) return null;
      const globallyStartable = startableHosts(ranked, slots, gate);
      const markedHost = ranked.find(({ host }) => host.name === markerHost)?.host;
      if (multiWaiterId && markerHost && markedHost?.fallback && globallyStartable.some(({ host }) => !host.fallback)) {
        if (marker) await marker.release();
        marker = undefined;
        markerHost = undefined;
      }
      const markedLandingHost = ranked.find(({ host }) => host.name === landingMarkerHost)?.host;
      if (
        landingWaiterId &&
        landingMarkerHost &&
        markedLandingHost?.fallback &&
        globallyStartable.some(({ host }) => !host.fallback)
      ) {
        if (landingMarker) await landingMarker.release();
        landingMarker = undefined;
        landingMarkerHost = undefined;
      }
      const acquisitionHosts =
        landingWaiterId && landingMarkerHost
          ? ranked.filter(({ host }) => host.name === landingMarkerHost)
          : multiWaiterId && markerHost
            ? ranked.filter(({ host }) => host.name === markerHost)
            : ranked;
      const canStart = startableHosts(acquisitionHosts, slots, gate);
      for (const entry of canStart) {
        const { host, freeSlots, slotLimit, ordinaryCapacity, ordinaryAdmissionLimit } = entry;
        if (freeSlots < slots) continue;
        const lease = await takeSlots(
          host,
          slots,
          slotLimit,
          ordinaryCapacity,
          ordinaryAdmissionLimit,
          priority === undefined && isShortRun(slots, estimateMs, gate),
          estimateMs,
          gate,
          priority,
          multiWaiterId,
          memoryReservationBytes,
          landingWaiterId,
          signal,
        );
        if (lease && signal.aborted) {
          await lease.release();
          throw new Aborted();
        }
        if (lease) {
          if (marker) await marker.release();
          if (landingMarker) await landingMarker.release();
          return lease;
        }
      }
      if (gate && ranked.length > 0) {
        const candidates = ranked.filter(({ gateCapacity }) => gateCapacity >= slots);
        const target = candidates.find(({ host }) => host.name === markerHost) ?? candidates[0];
        if (target && target.host.name !== markerHost) {
          if (marker) await marker.release();
          marker = undefined;
          markerHost = target.host.name;
          marker = (await takeGateMarker(target.host, signal)) ?? undefined;
        }
      }
      if (landingWaiterId && ranked.length > 0 && !gate) {
        const eligible = ranked.filter(({ ordinaryCapacity }) => ordinaryCapacity >= slots);
        const currentlyReachable = eligible.filter(
          ({ resourceSlots, ordinarySlotsUsed }) => resourceSlots + ordinarySlotsUsed >= slots,
        );
        const candidates = (currentlyReachable.length > 0 ? currentlyReachable : eligible).sort(
          (left, right) =>
            left.ordinarySlotsUsed - right.ordinarySlotsUsed ||
            right.resourceSlots - left.resourceSlots ||
            right.memoryHeadroom - left.memoryHeadroom,
        );
        const target = ranked.find(({ host }) => host.name === landingMarkerHost) ?? candidates[0];
        if (target && target.host.name !== landingMarkerHost) {
          if (landingMarker) await landingMarker.release();
          landingMarkerHost = target.host.name;
          landingMarker =
            (await takeLandingMarker(target.host, landingWaiterId, slots, landingArrivalOrder!, signal)) ?? undefined;
        } else if (target && !landingMarker) {
          landingMarker =
            (await takeLandingMarker(target.host, landingWaiterId, slots, landingArrivalOrder!, signal)) ?? undefined;
        }
      }
      if (multiWaiterId && ranked.length > 0) {
        const eligible = ranked.filter(({ ordinaryCapacity }) => ordinaryCapacity >= slots);
        const currentlyReachable = eligible.filter(
          ({ resourceSlots, ordinarySlotsUsed, expressSlotUsed }) =>
            resourceSlots + ordinarySlotsUsed + Number(expressSlotUsed) >= slots,
        );
        const candidates = (currentlyReachable.length > 0 ? currentlyReachable : eligible).sort(
          (left, right) =>
            left.ordinarySlotsUsed - right.ordinarySlotsUsed ||
            right.resourceSlots - left.resourceSlots ||
            right.memoryHeadroom - left.memoryHeadroom,
        );
        const target = ranked.find(({ host }) => host.name === markerHost) ?? candidates[0];
        if (target && target.host.name !== markerHost) {
          if (marker) await marker.release();
          markerHost = target.host.name;
          marker = (await takeMultiSlotMarker(target.host, multiWaiterId, slots, signal)) ?? undefined;
        } else if (target && !marker) {
          marker = (await takeMultiSlotMarker(target.host, multiWaiterId, slots, signal)) ?? undefined;
        }
      }
      announceWait(ranked);
      wait.record();
      await sleep(pollMs, signal);
    }
  } finally {
    clearInterval(heartbeat);
    if (marker) await marker.release();
    if (landingMarker) await landingMarker.release();
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

async function finishedRsync(
  child: ReturnType<typeof Bun.spawn>,
  signal: AbortSignal,
): Promise<{ code: number; stderr: string }> {
  const stderrStream = child.stderr;
  let stderr = '';
  const forwardStderr = async (): Promise<void> => {
    if (!(stderrStream instanceof ReadableStream)) return;
    const reader = stderrStream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      process.stderr.write(value);
      stderr += decoder.decode(value, { stream: true });
    }
    stderr += decoder.decode();
  };
  const [code] = await Promise.all([finished(child, signal), forwardStderr()]);
  return { code, stderr };
}

function vanishedFileCount(stderr: string): number {
  return stderr.split('\n').filter((line) => line.includes('file has vanished')).length;
}

function reportVanishedFiles(direction: 'to' | 'from', host: string, count: number): void {
  console.error(`remote-check: rsync ${direction} ${host}: ${count} files vanished during transfer`);
}

function reportDuration(phase: string, started: number, host: string, bytesSent?: number): void {
  const bytes = bytesSent === undefined ? '' : `, ${bytesSent} bytes sent`;
  console.error(`remote-check: ${phase} ${((performance.now() - started) / 1000).toFixed(3)} s on ${host}${bytes}`);
}

function rsyncBytesSent(stderr: string): number | undefined {
  const match = stderr.match(/^sent\s+([\d,]+)\s+bytes\b/m);
  return match ? Number(match[1]!.replaceAll(',', '')) : undefined;
}

async function baseState(host: Host): Promise<{ base: string | null; zstd: boolean }> {
  const probe = Bun.spawn(['ssh', ...sshOptions(host), host.address, baseStateScript()], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const [code, output] = await Promise.all([probe.exited, new Response(probe.stdout).text()]);
  if (code !== 0) throw new RemoteTransportError(host.name, 'base lookup', 255);
  const base = output.match(/^BASE (.+)$/m)?.[1];
  const age = output.match(/^AGE (.+)$/m)?.[1];
  const zstd = output.match(/^ZSTD ([01])$/m)?.[1];
  if (
    base === undefined ||
    age === undefined ||
    zstd === undefined ||
    (base !== '-' && !base.startsWith(`${ROOT}/bases/`))
  ) {
    throw new Error(`remote-check: invalid base state from ${host.name}`);
  }
  return { base: base === '-' ? null : base, zstd: zstd === '1' };
}

function assertReturnPath(path: string): void {
  if (path === '' || path.startsWith('/') || path.split('/').includes('..') || /[\0\n]/.test(path)) {
    throw new Error(`return path must stay inside the workspace: ${path}`);
  }
}

/** One remote script lists which declared outputs exist, so a missing path is skipped instead of failing the copy. */
export function returnsProbe(directory: string, paths: string[]): string {
  const body = paths
    .map((path) => {
      const full = `${directory}/${path}`;
      return `# PATH ${path}
if [ -e ${quote(full)} ] || [ -L ${quote(full)} ]; then printf 'PRESENT %s\\n' ${quote(path)}; else printf 'ABSENT %s\\n' ${quote(path)}; fi`;
    })
    .join('\n');
  return `# REMOTE_CHECK_RETURNS
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
    { stdin: new Blob([`${present.join('\0')}\0`]), stdout: 'inherit', stderr: 'pipe' },
  );
  const { code: synced, stderr } = await finishedRsync(sync, signal);
  reportDuration('rsync back', started, host.name);
  if (signal.aborted) throw new Aborted();
  if (synced === 24) reportVanishedFiles('from', host.name, vanishedFileCount(stderr));
  else if (synced !== 0) throw new Error(`rsync from ${host.name} failed with exit code ${synced}`);
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
    await lease.registerRun?.(id);
    const base = await baseState(host);
    if (signal.aborted) throw new Aborted();
    const useZstd = base.zstd && localRsyncSupportsZstd();
    if (!useZstd) {
      console.error(`remote-check: rsync zstd unavailable on ${host.name}; using default compression`);
    }
    const rsyncStarted = performance.now();
    const compression = useZstd
      ? ['--compress', `--compress-choice=zstd`, `--compress-level=${RSYNC_COMPRESS_LEVEL}`]
      : ['--compress'];
    const sync = Bun.spawn(
      [
        'rsync',
        '-lpt',
        ...compression,
        '--stats',
        '--rsync-path=flock -s /srv/rezics-check/bases/.lock rsync',
        ...(base.base ? ['--checksum', `--copy-dest=${ROOT}/bases/current`] : []),
        '--mkpath',
        '--from0',
        '--files-from=-',
        '-e',
        ['ssh', ...sshOptions(host)].map(quote).join(' '),
        `${resolve(options.workspace)}/`,
        `${host.address}:${directory}/`,
      ],
      { stdin: new Blob([`${files.join('\0')}\0`]), stdout: 'inherit', stderr: 'pipe' },
    );
    const { code: synced, stderr } = await finishedRsync(sync, signal);
    reportDuration('rsync', rsyncStarted, host.name, rsyncBytesSent(stderr));
    if (signal.aborted) throw new Aborted();
    if ([10, 12, 30, 35, 255].includes(synced)) throw new RemoteTransportError(host.name, 'workspace upload', synced);
    if (synced === 24) reportVanishedFiles('to', host.name, vanishedFileCount(stderr));
    // rsync documents 24 as a vanished source file; generated outputs are excluded above, and remaining races
    // should not fail a check because the source snapshot is already best-effort.
    else if (synced !== 0) throw new Error(`rsync to ${host.name} failed with exit code ${synced}`);

    console.error(`remote-check: running on ${host.name}`);
    options.started?.(host.name);
    const run = Bun.spawn(
      [
        'ssh',
        ...sshOptions(host),
        host.address,
        runScript(
          id,
          directory,
          options.cwd ?? '.',
          options.command,
          host.name,
          options.progressIntervalMs,
          options.gate ? 'gate' : (options.priority ?? ((options.slots ?? 1) > 1 ? 'multi-slot' : 'ordinary')),
        ),
      ],
      { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    );
    const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
    const heartbeatMs = options.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS;
    let heartbeatStopped = false;
    const heartbeat = setInterval(() => {
      if (!heartbeatStopped) {
        const renew = Bun.spawn(['ssh', ...sshOptions(host), host.address, heartbeatScript(directory)], {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        });
      }
    }, heartbeatMs);
    let deadline = false;
    const commandResult = finished(run, signal);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineResult = new Promise<null>((resolve) => {
      deadlineTimer = setTimeout(() => resolve(null), maxMs);
    });
    let code: number;
    try {
      const completed = await Promise.race([commandResult.then((value) => value), deadlineResult]);
      if (completed === null) {
        deadline = true;
        console.error(`remote-check: deadline reached after ${maxMs} ms`);
        const stop = Bun.spawn(['ssh', ...sshOptions(host), host.address, stopRunScript(id)], {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        });
        await within(15_000, stop.exited);
        run.kill('SIGTERM');
        await run.exited;
        code = REMOTE_DEADLINE_EXIT;
      } else code = completed;
    } finally {
      heartbeatStopped = true;
      clearInterval(heartbeat);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
    if (signal.aborted) throw new Aborted();
    if (deadline) return REMOTE_DEADLINE_EXIT;
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
      if (
        statusCode !== 0 ||
        (!Number.isInteger(parsed) && recorded !== 'NOT_STARTED' && recorded !== 'STARTED') ||
        parsed > 255
      ) {
        throw new RemoteTransportError(host.name, 'remote command', 255, false);
      }
      if (recorded === 'NOT_STARTED') throw new RemoteTransportError(host.name, 'remote command startup', 255, true);
      if (recorded === 'STARTED') throw new RemoteTransportError(host.name, 'remote command', 255, false);
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

export async function remoteCheck(options: RemoteCheck, signal: AbortSignal): Promise<number> {
  validateEstimateMs(options.estimateMs);
  const slots = options.slots ?? 1;
  const hosts = options.hosts;
  const files = workspaceFiles(options.workspace);
  const slotWaitStarted = performance.now();
  const result = await runWithTransportRetries(options, hosts, files, slotWaitStarted, signal, false);
  if (result === null) throw new Error('remote-check: no check host answered');
  return result;
}

/** Retries only failures known to have happened before a remote command produced a result. */
async function runWithTransportRetries(
  options: RemoteCheck,
  hosts: Host[],
  files: string[],
  slotWaitStarted: number,
  signal: AbortSignal,
  giveUpIfUnanswered: boolean,
  onAnswered?: () => void,
): Promise<number | null> {
  validateMemoryGiB(options.memoryGiB);
  const slots = options.slots ?? 1;
  const memoryReservationBytes =
    options.memoryGiB === undefined ? CHECK_SLOT_MEMORY_BYTES : options.memoryGiB * 2 ** 30;
  const failedHosts = new Set<string>();
  let lastFailure: RemoteTransportError | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      const delay = (options.retryBackoffMs ?? 100) * 2 ** (attempt - 1);
      console.error(`remote-check: retrying transport failure on ${lastFailure!.host} with code ${lastFailure!.code}`);
      await sleep(delay, signal);
    }
    const preferred = hosts.filter((host) => !failedHosts.has(host.name));
    const retryHosts = attempt > 0 && preferred.length > 0 ? preferred : hosts;
    let lease: Lease | null;
    if (attempt === 0) {
      lease = await acquire(
        retryHosts,
        slots,
        options.estimateMs,
        options.pollMs ?? 5000,
        signal,
        giveUpIfUnanswered,
        onAnswered,
        options.gate ?? false,
        options.waitRepeatMs,
        memoryReservationBytes,
        options.priority,
      );
    } else {
      lease = await acquireOnce(
        retryHosts,
        slots,
        options.estimateMs,
        signal,
        options.gate ?? false,
        memoryReservationBytes,
        options.priority,
      );
      if (!lease && (!giveUpIfUnanswered || lastFailure !== undefined)) {
        lease = await acquire(
          hosts,
          slots,
          options.estimateMs,
          options.pollMs ?? 5000,
          signal,
          false,
          onAnswered,
          options.gate ?? false,
          options.waitRepeatMs,
          memoryReservationBytes,
          options.priority,
        );
      }
    }
    if (!lease) return null;
    try {
      return await runLeased(lease, options, files, slotWaitStarted, signal);
    } catch (error) {
      if (!(error instanceof RemoteTransportError) || !error.retryable || attempt === 2 || signal.aborted) throw error;
      lastFailure = error;
      failedHosts.add(error.host);
    }
  }
  throw lastFailure;
}

/**
 * Like `remoteCheck`, but the first probe round that finds no host returns null instead of waiting. Once a host has
 * answered, a later silence keeps waiting for a slot. A run no host has enough slots for is still an error.
 */
export async function remoteCheckUnlessUnreachable(options: RemoteCheck, signal: AbortSignal): Promise<number | null> {
  validateEstimateMs(options.estimateMs);
  const slots = options.slots ?? 1;
  const hosts = options.hosts;
  const files = workspaceFiles(options.workspace);
  const slotWaitStarted = performance.now();
  return await runWithTransportRetries(options, hosts, files, slotWaitStarted, signal, true, options.answered);
}

/**
 * Like `remoteCheck`, but each host's slot is tried once and a busy host is not waited for. The result says whether
 * the command ran, so a caller never reads "no slot" as an exit code. A run no host has enough slots for is "no-slot".
 */
export async function tryRemoteCheck(options: RemoteCheck, signal: AbortSignal): Promise<TryOnce> {
  validateEstimateMs(options.estimateMs);
  validateMemoryGiB(options.memoryGiB);
  const slots = options.slots ?? 1;
  const memoryReservationBytes =
    options.memoryGiB === undefined ? CHECK_SLOT_MEMORY_BYTES : options.memoryGiB * 2 ** 30;
  const hosts = options.hosts;
  const files = workspaceFiles(options.workspace);
  const slotWaitStarted = performance.now();
  const failedHosts = new Set<string>();
  let lastFailure: RemoteTransportError | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      console.error(`remote-check: retrying transport failure on ${lastFailure!.host} with code ${lastFailure!.code}`);
      await sleep((options.retryBackoffMs ?? 100) * 2 ** (attempt - 1), signal);
    }
    const preferred = hosts.filter((host) => !failedHosts.has(host.name));
    const lease = await acquireOnce(
      attempt > 0 && preferred.length > 0 ? preferred : hosts,
      slots,
      options.estimateMs,
      signal,
      options.gate ?? false,
      memoryReservationBytes,
      options.priority,
    );
    if (!lease) return { status: 'no-slot' };
    try {
      return {
        status: 'ran',
        host: lease.host.name,
        code: await runLeased(lease, options, files, slotWaitStarted, signal),
      };
    } catch (error) {
      if (!(error instanceof RemoteTransportError) || !error.retryable || attempt === 2 || signal.aborted) throw error;
      lastFailure = error;
      failedHosts.add(error.host);
    }
  }
  throw lastFailure;
}

function parse(argv: string[]): RemoteCheck {
  const hostsFile = process.env.KERNEL_CHECK_REMOTE;
  if (!hostsFile) throw new Error('KERNEL_CHECK_REMOTE must name the hosts file');
  const priorityValue = process.env.REMOTE_CHECK_PRIORITY;
  if (priorityValue !== undefined && priorityValue !== 'landing' && priorityValue !== 'critical') {
    throw new Error(`REMOTE_CHECK_PRIORITY must be landing or critical when set, received ${priorityValue}`);
  }
  let cwd: string | undefined;
  let slots: number | undefined;
  let memoryGiB: number | undefined;
  let estimateMs: number | undefined;
  let maxMs: number | undefined;
  let gate = false;
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
    if (flag === '--gate') {
      gate = true;
      continue;
    }
    if (flag === '--max-ms') {
      const value = rest.shift();
      if (value === undefined) throw new Error('--max-ms must be a positive safe integer, received no value');
      maxMs = Number(value);
      validateMaxMs(maxMs);
      continue;
    }
    if (flag === '--estimate-ms') {
      const value = rest.shift();
      if (value === undefined) throw new Error('--estimate-ms must be a non-negative safe integer, received no value');
      estimateMs = Number(value);
      validateEstimateMs(estimateMs);
      continue;
    }
    if ((flag !== '--cwd' && flag !== '--slots' && flag !== '--memory-gib') || rest.length === 0)
      throw new Error(`Unknown option: ${flag}`);
    const value = rest.shift()!;
    if (flag === '--cwd') cwd = value;
    else if (flag === '--slots') {
      slots = Number(value);
      if (!Number.isSafeInteger(slots) || slots < 1)
        throw new Error(`--slots must be a positive integer, received ${value}`);
    } else if (flag === '--memory-gib') {
      memoryGiB = Number(value);
      validateMemoryGiB(memoryGiB);
    }
  }
  const workspace = rest.shift();
  const separator = rest.shift();
  if (!workspace || separator !== '--' || rest.length === 0) {
    throw new Error(
      'Usage: remote-check.ts [--cwd <directory>] [--slots <n>] [--memory-gib <n>] [--estimate-ms <n>] [--gate] <workspace> -- <command...>',
    );
  }
  if (!existsSync(workspace)) throw new Error(`Workspace does not exist: ${workspace}`);
  const pollMs = process.env.REMOTE_CHECK_POLL_MS === undefined ? undefined : Number(process.env.REMOTE_CHECK_POLL_MS);
  const retryBackoffMs =
    process.env.REMOTE_CHECK_RETRY_BACKOFF_MS === undefined
      ? undefined
      : Number(process.env.REMOTE_CHECK_RETRY_BACKOFF_MS);
  const waitRepeatMs =
    process.env.REMOTE_CHECK_WAIT_REPEAT_MS === undefined ? undefined : Number(process.env.REMOTE_CHECK_WAIT_REPEAT_MS);
  if (waitRepeatMs !== undefined && (!Number.isSafeInteger(waitRepeatMs) || waitRepeatMs < 1))
    throw new Error('REMOTE_CHECK_WAIT_REPEAT_MS must be a positive integer');
  return {
    hosts: readHosts(hostsFile),
    workspace,
    command: rest,
    ...(cwd === undefined ? {} : { cwd }),
    ...(slots === undefined ? {} : { slots }),
    ...(memoryGiB === undefined ? {} : { memoryGiB }),
    ...(estimateMs === undefined ? {} : { estimateMs }),
    ...(maxMs === undefined ? {} : { maxMs }),
    ...(gate ? { gate } : {}),
    ...(priorityValue === undefined ? {} : { priority: priorityValue as 'landing' | 'critical' }),
    ...(returns === undefined ? {} : { returns }),
    ...(pollMs === undefined ? {} : { pollMs }),
    ...(retryBackoffMs === undefined ? {} : { retryBackoffMs }),
    ...(waitRepeatMs === undefined ? {} : { waitRepeatMs }),
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
      console.error('remote-check: transport failure marker');
      process.exitCode = REMOTE_TRANSPORT_FAILURE;
    } else if (error instanceof SlotRequestTooLarge) {
      console.error(error.message);
      process.exitCode = SLOT_REQUEST_TOO_LARGE;
    } else {
      if (!(error instanceof Aborted)) console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
  if (received !== undefined) process.exitCode = 128 + received;
}
