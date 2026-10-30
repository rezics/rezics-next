#!/usr/bin/env bun
// Runs a command against a copy of a workspace on a development check host, so the check's containers and test lanes
// stay off the machine the agents run on.
// Runs share the host package cache through hardlinks. An in-place write into an installed package fails the run and
// removes its cache entry; patch dependencies through patchedDependencies in package.json, never at run time.
//
// A short run (one slot, estimated at no more than 120,000 ms, and not a gate) waits at most one short run per host.
// Each host keeps one slot as express capacity, so its ordinary capacity is one slot lower.
// Gates retain their reserved capacity. A fitting landing waiter gets its requested slots first for one configured
// poll; ordinary work can use the remaining capacity, and a stale or ineligible landing waiter cannot hold it back.
// Multi-slot waiters reserve their requested capacity after landing's opportunity. Short runs may still use express.

// Waiter order is gate, landing, multi-slot, ordinary. While a gate waits, non-gate runs leave its reserved slots
// free; a landing waiter gets one admission poll of first opportunity, then eligible work can backfill. Short runs may
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
// host's capped systemd slice, and its exit code is this script's exit code. The workspace uploads before a run takes
// <n> slots (default 1) on that host; those slots cover only the remote command, not upload, output retrieval or cleanup.
// Admission depends on free slots and held memory reservations, whatever the host's load average. Each run has a nested
// slice shared with its containers; its cpu.stat and memory.peak report CPU seconds, average cores and peak memory.
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
  /** An owner-published durable intent, independent of transport availability or a runner incarnation. */
  cancellation?: ExecutionCancellation;
  /** Trusted outer execution boundary; command stdout never supplies this value. */
  completed?: (receipt: RemotePhysicalRunReceipt) => void;
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
  /** Maximum time without transferred bytes before an upload or return copy is stopped. */
  transferTimeoutMs?: number;
  /** Bound for the selected host's control-connection probe. */
  controlProbeTimeoutMs?: number;
  /** Absolute bound for runtime selection, cache wait and dependency lifecycle work. */
  preparationTimeoutMs?: number;
  /** Hosts file to re-read on each admission wait round. */
  hostsFile?: string;
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

export type ExecutionCancellation = { file: string; id: string };
export type CancellationIntent = { schema: 1; id: string; signal: 1 | 2 | 15 };

/** Publish cancellation before signalling the owner. The first intent is immutable and survives detached waiters. */
export function requestExecutionCancellation(cancellation: ExecutionCancellation, signal: 1 | 2 | 15 = 15): void {
  const { file, id } = cancellation;
  if (!id || ![1, 2, 15].includes(signal)) throw new Error('Invalid execution cancellation');
  mkdirSync(dirname(file), { recursive: true });
  const pending = `${file}.${randomUUID()}.pending`;
  const descriptor = openSync(pending, 'wx', 0o600);
  try {
    writeSync(descriptor, JSON.stringify({ schema: 1, id, signal }));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    try {
      linkSync(pending, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const directory = openSync(dirname(file), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    unlinkSync(pending);
  }
}

export function executionCancellation(cancellation?: ExecutionCancellation): CancellationIntent | null {
  if (!cancellation) return null;
  try {
    const value = JSON.parse(readFileSync(cancellation.file, 'utf8'));
    if (value.schema !== 1 || value.id !== cancellation.id || ![1, 2, 15].includes(value.signal))
      throw new Error('Invalid execution cancellation intent');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error; // Fail closed on a corrupt intent; it cannot authorize fallback or a replacement command.
  }
}

export function executionCancellationFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): ExecutionCancellation | undefined {
  const file = env.REMOTE_CHECK_CANCELLATION_FILE;
  const id = env.REMOTE_CHECK_CANCELLATION_ID;
  if (file === undefined && id === undefined) return undefined;
  if (!file || !id) throw new Error('Both remote execution cancellation file and id are required');
  return { file, id };
}

/** Monitor only this execution's durable intent. Every command boundary also checks synchronously. */
export function observeExecutionCancellation(cancellation: ExecutionCancellation | undefined, parent?: AbortSignal) {
  const controller = new AbortController();
  const alreadyCancelled = executionCancellation(cancellation);
  const check = () => {
    if (parent?.aborted || executionCancellation(cancellation)) controller.abort();
    if (controller.signal.aborted) throw new Aborted();
  };
  const abort = () => controller.abort();
  parent?.addEventListener('abort', abort, { once: true });
  const timer = cancellation
    ? setInterval(() => {
        try {
          check();
        } catch {
          controller.abort();
        }
      }, 25)
    : undefined;
  if (parent?.aborted || alreadyCancelled) controller.abort();
  return {
    signal: controller.signal,
    check,
    close() {
      clearInterval(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

export type RemotePhysicalRunReceipt = {
  schema: 1;
  host: string;
  run: string;
  exitCode: number;
  lifetimeFailure: RunLifetimeFailure | null;
  resources: PhysicalResourceReceipt | null;
};

export type PhysicalResourceReceipt = {
  schema: 1;
  host: string;
  run: string;
  boot: string;
  supervisor: { pid: number; start: string; group: number };
  cgroup: { path: string; device: number; inode: number; invocation: string } | null;
  cadenceMs: 5000;
  startedMonoMs: number;
  commandStartedMonoMs: number | null;
  terminalMonoMs: number;
  samples: {
    monoMs: number;
    phase: 'preparation' | 'command' | 'terminal';
    usageUsec: number | null;
    memoryPeakBytes: number | null;
    intervalMs: number | null;
    cores: number | null;
    unavailable: string | null;
  }[];
  sampledMaxCores: number | null;
};

/** Structural validation is separate from provenance: only the owning SSH/IPC boundary may supply this receipt. */
export function parseRemotePhysicalRunReceipt(value: unknown): RemotePhysicalRunReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as RemotePhysicalRunReceipt;
  if (
    v.schema !== 1 ||
    typeof v.host !== 'string' ||
    !v.host ||
    typeof v.run !== 'string' ||
    !/^[a-zA-Z0-9-]+$/.test(v.run) ||
    !Number.isInteger(v.exitCode) ||
    v.exitCode < 0 ||
    v.exitCode > 255
  )
    return null;
  if (v.lifetimeFailure !== null) {
    const failure = parseRunLifetimeFailure(RUN_LIFETIME_FAILURE_MARKER + JSON.stringify(v.lifetimeFailure));
    if (!failure || failure.host !== v.host || failure.run !== v.run || v.exitCode !== 124) return null;
  }
  if (v.resources !== null) {
    const r = v.resources;
    const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    if (
      !r ||
      r.schema !== 1 ||
      r.host !== v.host ||
      r.run !== v.run ||
      typeof r.boot !== 'string' ||
      !r.supervisor ||
      !Number.isSafeInteger(r.supervisor.pid) ||
      typeof r.supervisor.start !== 'string' ||
      !Number.isSafeInteger(r.supervisor.group) ||
      r.cadenceMs !== 5000 ||
      !finite(r.startedMonoMs) ||
      !finite(r.terminalMonoMs) ||
      r.terminalMonoMs < r.startedMonoMs ||
      (r.commandStartedMonoMs !== null &&
        (!finite(r.commandStartedMonoMs) ||
          r.commandStartedMonoMs < r.startedMonoMs ||
          r.commandStartedMonoMs > r.terminalMonoMs)) ||
      !Array.isArray(r.samples) ||
      r.samples.length > 1444 ||
      (r.sampledMaxCores !== null && !finite(r.sampledMaxCores))
    )
      return null;
    if (
      r.cgroup !== null &&
      (!r.cgroup ||
        typeof r.cgroup.path !== 'string' ||
        !r.cgroup.path.startsWith('/') ||
        !Number.isSafeInteger(r.cgroup.device) ||
        !Number.isSafeInteger(r.cgroup.inode) ||
        !r.cgroup.invocation)
    )
      return null;
    let previous = r.startedMonoMs;
    for (const s of r.samples) {
      if (
        !finite(s.monoMs) ||
        s.monoMs < previous ||
        s.monoMs > r.terminalMonoMs ||
        !['preparation', 'command', 'terminal'].includes(s.phase) ||
        [s.usageUsec, s.memoryPeakBytes, s.intervalMs, s.cores].some((n) => n !== null && !finite(n)) ||
        (s.unavailable !== null && typeof s.unavailable !== 'string')
      )
        return null;
      previous = s.monoMs;
    }
  }
  return v;
}

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
  const result = Bun.spawnSync([binary, '--eval', 'console.log(Bun.revision)'], { timeout: 5_000 });
  if (result.exitCode !== 0) throw new Error('Could not read pinned Bun revision; run bun install first');
  pinnedBun = { version, revision: result.stdout.toString().trim() };
  return pinnedBun;
}
const SLICE = 'rezics-check.slice';
const SLOT_BUSY = 75;
const REMOTE_TRANSPORT_FAILURE = 75;
export const REMOTE_DEADLINE_EXIT = 124;
export const HARD_RUN_LIFETIME_MS = 2 * 60 * 60 * 1000;
// Admission's estimate saturation is separate from execution's effective deadline. Keep the generated shell and
// client ranking on the same finite bound when a landing marker has no usable estimate.
const DEFAULT_MAX_MS = HARD_RUN_LIFETIME_MS;
const FALLBACK_ESTIMATE_MS = 40 * 60 * 1000;
export const RUN_LIFETIME_FAILURE_MARKER = 'remote-check: infrastructure failure: remote run timed out ';
export type RunLifetimeFailure = {
  schema: 1;
  status: 'infrastructure-failure';
  phase: 'run-lifetime';
  host: string;
  run: string;
  limitMs: number;
  elapsedMs: number;
  command: string;
};

export function parseRunLifetimeFailure(output: string): RunLifetimeFailure | null {
  for (const line of output.split(/\r?\n/).reverse()) {
    const start = line.indexOf(RUN_LIFETIME_FAILURE_MARKER);
    if (start < 0) continue;
    try {
      const value = JSON.parse(line.slice(start + RUN_LIFETIME_FAILURE_MARKER.length));
      if (
        value.schema === 1 &&
        value.status === 'infrastructure-failure' &&
        value.phase === 'run-lifetime' &&
        typeof value.host === 'string' &&
        typeof value.run === 'string' &&
        typeof value.command === 'string' &&
        value.command.length <= 256 &&
        /^[a-zA-Z0-9-]+$/.test(value.run) &&
        Number.isSafeInteger(value.limitMs) &&
        value.limitMs > 0 &&
        value.limitMs <= HARD_RUN_LIFETIME_MS &&
        Number.isSafeInteger(value.elapsedMs) &&
        value.elapsedMs >= value.limitMs
      )
        return value;
    } catch {
      /* A native command's output is not an infrastructure receipt. */
    }
  }
  return null;
}
const DEFAULT_LIVENESS_INTERVAL_MS = 60_000;
export const DEFAULT_TRANSFER_TIMEOUT_MS = 120_000;
export const DEFAULT_PREPARATION_TIMEOUT_MS = 180_000;
const DEFAULT_CONTROL_PROBE_TIMEOUT_MS = 5_000;
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

function configuredTimeout(value: number | undefined, envName: string, fallback: number): number {
  const fromEnvironment = process.env[envName];
  const timeout = value ?? (fromEnvironment === undefined ? fallback : Number(fromEnvironment));
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error(`${envName} must be a positive safe integer`);
  return timeout;
}

function transferTimeout(options: RemoteCheck): number {
  return configuredTimeout(options.transferTimeoutMs, 'REMOTE_CHECK_TRANSFER_TIMEOUT_MS', DEFAULT_TRANSFER_TIMEOUT_MS);
}

function controlProbeTimeout(options: RemoteCheck): number {
  return configuredTimeout(
    options.controlProbeTimeoutMs,
    'REMOTE_CHECK_CONTROL_PROBE_TIMEOUT_MS',
    DEFAULT_CONTROL_PROBE_TIMEOUT_MS,
  );
}

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

/** Saturate before multiplying: every accepted safe estimate, including MAX_SAFE_INTEGER, stays finite. */
export function effectiveRunLifetimeMs(estimateMs?: number, maxMs?: number): number {
  validateEstimateMs(estimateMs);
  validateMaxMs(maxMs);
  const estimate = estimateMs || FALLBACK_ESTIMATE_MS;
  const derived = estimate >= HARD_RUN_LIFETIME_MS / 3 ? HARD_RUN_LIFETIME_MS : Math.max(1_000, estimate * 3);
  return Math.min(HARD_RUN_LIFETIME_MS, maxMs ?? HARD_RUN_LIFETIME_MS, derived);
}

function validateMemoryGiB(memoryGiB: number | undefined): void {
  if (memoryGiB !== undefined && (!Number.isSafeInteger(memoryGiB) || memoryGiB < 1)) {
    throw new Error(`--memory-gib must be a positive integer, received ${memoryGiB}`);
  }
}

function isShortRun(slots: number, estimateMs: number | undefined, gate: boolean): boolean {
  return !gate && slots === 1 && estimateMs !== undefined && estimateMs <= EXPRESS_SLOT_ESTIMATE_LIMIT_MS;
}

function landingOpportunityMs(estimateMs: number | null, pollMs: number): number {
  const finiteEstimate = Math.min(estimateMs ?? DEFAULT_MAX_MS, DEFAULT_MAX_MS);
  return Math.max(1, Math.min(Math.max(1, pollMs), Math.max(1, finiteEstimate)));
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

const sshOptions = (host: Host, connectionId?: string, standalone = false): string[] => [
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
  ...(standalone
    ? ['-o', 'ControlMaster=no', '-o', 'ControlPath=none']
    : [
        '-o',
        'ControlMaster=auto',
        '-o',
        'ControlPersist=10m',
        '-o',
        `ControlPath=${join(controlSocketDirectory(), connectionId ? `${connectionId}-%C` : '%C')}`,
      ]),
];

/** Reports the resources the next check would share with, falling back to host memory when the slice is unreadable. */
function probeScript(host: Host): string {
  return `set -eu
mkdir -p ${ROOT}/slots
marker_open_live() {
  marker_file=$1
  marker_attempt=0
  while [ "$marker_attempt" -lt 3 ]; do
    exec 7>&-
    exec 7<>"$marker_file" 2>/dev/null || return 1
    if flock -n 7; then
      marker_fd_identity=$(stat -Lc '%d:%i' "/proc/$$/fd/7" 2>/dev/null || true)
      marker_path_identity=$(stat -Lc '%d:%i' -- "$marker_file" 2>/dev/null || true)
      if [ -n "$marker_fd_identity" ] && [ "$marker_fd_identity" = "$marker_path_identity" ]; then
        rm -f -- "$marker_file"
        flock -u 7
        exec 7>&-
        return 1
      fi
      flock -u 7
    else
      marker_fd_identity=$(stat -Lc '%d:%i' "/proc/$$/fd/7" 2>/dev/null || true)
      marker_path_identity=$(stat -Lc '%d:%i' -- "$marker_file" 2>/dev/null || true)
      if [ -n "$marker_fd_identity" ] && [ "$marker_fd_identity" = "$marker_path_identity" ]; then return 0; fi
    fi
    exec 7>&-
    marker_attempt=$((marker_attempt + 1))
  done
  return 1
}
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
exec 6>"${ROOT}/slots/gate-queue.lock"
flock -x 6
if [ -e "$gate_marker" ]; then
  if marker_open_live "$gate_marker"; then gate_waiting=1; exec 7>&-; fi
fi
flock -u 6
exec 6>&-
multi_waiting_slots=0
multi_waiting_id=-
multi_waiting_sequence=
exec 6>"${ROOT}/slots/multi-queue.lock"
flock -x 6
for multi_marker in ${ROOT}/slots/multi-wait-*.lock; do
  [ -e "$multi_marker" ] || continue
  if marker_open_live "$multi_marker"; then
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
landing_waiting_estimate_ms=-1
landing_waiting_memory_bytes=${CHECK_SLOT_MEMORY_BYTES}
landing_waiting_sequence=
landing_opportunity_deadline=0
exec 6>"${ROOT}/slots/landing-queue.lock"
flock -x 6
for landing_marker in ${ROOT}/slots/landing-wait-*.lock; do
  [ -e "$landing_marker" ] || continue
  if marker_open_live "$landing_marker"; then
    marker_slots=
    marker_started=
    marker_sequence=
    marker_estimate_ms=
    marker_memory_bytes=
    read -r marker_slots marker_started marker_sequence marker_estimate_ms marker_memory_bytes <&7 || true
    case "$marker_slots:$marker_started:$marker_sequence" in *[!0-9:]*|:*|*:) marker_slots=; marker_sequence= ;; esac
    if [ -n "$marker_slots" ] && [ "\${#marker_started}" -gt 13 ]; then marker_started=$((marker_started / 1000)); fi
    case "$marker_estimate_ms" in ''|none|*[!0-9]*) marker_estimate_ms=-1 ;; esac
    case "$marker_memory_bytes" in ''|*[!0-9]*) marker_memory_bytes=${CHECK_SLOT_MEMORY_BYTES} ;; esac
    if [ -n "$marker_slots" ] && { [ -z "$landing_waiting_sequence" ] || [ "$marker_sequence" -lt "$landing_waiting_sequence" ]; }; then
      landing_waiting_slots=$marker_slots
      landing_marker_id=\${landing_marker##*/landing-wait-}
      landing_waiting_id=\${landing_marker_id%.lock}
      landing_waiting_started=$marker_started
      landing_waiting_estimate_ms=$marker_estimate_ms
      landing_waiting_memory_bytes=$marker_memory_bytes
      landing_waiting_sequence=$marker_sequence
    fi
  fi
  exec 7>&-
done
flock -u 6
exec 6>&-
printf 'PROCESSORS %s\\nSLICE_PROCESSORS %s\\nLOAD %s\\nMEMORY_RESERVED %s\\nORDINARY_SLOTS_USED %s\\nEXPRESS_SLOT_USED %s\\nGATE_WAITING %s\\nMULTI_SLOT_WAITING_SLOTS %s\\nMULTI_SLOT_WAITING_ID %s\\nLANDING_WAITING_SLOTS %s\\nLANDING_WAITING_ID %s\\nLANDING_WAITING_STARTED %s\\nLANDING_WAITING_ESTIMATE_MS %s\\nLANDING_WAITING_MEMORY_BYTES %s\\n' "$processors" "$slice_processors" "$load" "$memory_reserved" "$ordinary_slots_used" "$express_slot_used" "$gate_waiting" "$multi_waiting_slots" "$multi_waiting_id" "$landing_waiting_slots" "$landing_waiting_id" "\${landing_waiting_started:--}" "$landing_waiting_estimate_ms" "$landing_waiting_memory_bytes"`;
}

/** Holds a marker while a gate waits, so single-slot checks can prefer unmarked hosts. */
function gateMarkerScript(): string {
  return `# REMOTE_CHECK_GATE_MARKER
mkdir -p ${ROOT}/slots
exec 6>"${ROOT}/slots/gate-queue.lock"
flock -x 6
exec 8>>"${ROOT}/slots/gate-wait.lock"
flock -n 8 || { flock -u 6; exit ${SLOT_BUSY}; }
: > "${ROOT}/slots/gate-wait.lock"
flock -u 6
exec 6>&-
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
exec 8>>${quote(marker)}
flock -n 8 || { flock -u 6; exit ${SLOT_BUSY}; }
: > ${quote(marker)}
trap 'exit 0' HUP INT TERM
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
`;
}

/** Holds a priority marker until a landing run starts, gives up or is aborted. */
export function landingMarkerScript(
  id: string,
  slots: number,
  arrivalOrder: string,
  estimateMs: number | undefined,
  memoryReservationBytes: number,
): string {
  const marker = `${ROOT}/slots/landing-wait-${id}.lock`;
  return `# REMOTE_CHECK_LANDING_MARKER\n# REMOTE_CHECK_LANDING_COUNT ${slots}\n# REMOTE_CHECK_LANDING_ID ${id}\n# REMOTE_CHECK_LANDING_ARRIVAL ${arrivalOrder}\n# REMOTE_CHECK_LANDING_ESTIMATE_MS ${estimateMs ?? 'none'}\n# REMOTE_CHECK_LANDING_MEMORY_BYTES ${memoryReservationBytes}\nset -eu\nmkdir -p ${ROOT}/slots\nexec 6>"${ROOT}/slots/landing-queue.lock"\nflock -x 6\nexec 8>>${quote(marker)}\nflock -n 8 || { flock -u 6; exit ${SLOT_BUSY}; }\n: > ${quote(marker)}\ntrap 'exit 0' HUP INT TERM\nsequence_file=${ROOT}/slots/landing-wait-sequence\nsequence=0\nif [ -e "$sequence_file" ]; then read -r sequence < "$sequence_file" || sequence=0; fi\ncase "$sequence" in ''|*[!0-9]*) sequence=0 ;; esac\nsequence=$((sequence + 1))\nprintf '%s\\n' "$sequence" > "$sequence_file"\nprintf '%s %s %s %s %s\\n' ${slots} ${arrivalOrder} "$sequence" ${estimateMs ?? 'none'} ${memoryReservationBytes} >&8\nflock -u 6\nexec 6>&-\necho LANDING_MARKER\ncat >/dev/null\n`;
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
  multiWaiterId?: string,
  memoryReservationBytes = CHECK_SLOT_MEMORY_BYTES,
  landingWaiterId?: string,
  pollMs = 5000,
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
marker_open_live() {
  marker_file=$1
  marker_attempt=0
  while [ "$marker_attempt" -lt 3 ]; do
    exec 7>&-
    exec 7<>"$marker_file" 2>/dev/null || return 1
    if flock -n 7; then
      marker_fd_identity=$(stat -Lc '%d:%i' "/proc/$$/fd/7" 2>/dev/null || true)
      marker_path_identity=$(stat -Lc '%d:%i' -- "$marker_file" 2>/dev/null || true)
      if [ -n "$marker_fd_identity" ] && [ "$marker_fd_identity" = "$marker_path_identity" ]; then
        rm -f -- "$marker_file"
        flock -u 7
        exec 7>&-
        return 1
      fi
      flock -u 7
    else
      marker_fd_identity=$(stat -Lc '%d:%i' "/proc/$$/fd/7" 2>/dev/null || true)
      marker_path_identity=$(stat -Lc '%d:%i' -- "$marker_file" 2>/dev/null || true)
      if [ -n "$marker_fd_identity" ] && [ "$marker_fd_identity" = "$marker_path_identity" ]; then return 0; fi
    fi
    exec 7>&-
    marker_attempt=$((marker_attempt + 1))
  done
  return 1
}
exec 6>"${ROOT}/slots/gate-queue.lock"
flock -x 6
if [ -e "$gate_marker" ]; then
  if marker_open_live "$gate_marker"; then gate_waiting=1; exec 7>&-; fi
fi
flock -u 6
exec 6>&-
landing_waiting_slots=0
landing_waiting_id=-
landing_waiting_started=
landing_waiting_estimate_ms=-1
landing_waiting_memory_bytes=${CHECK_SLOT_MEMORY_BYTES}
landing_waiting_sequence=
exec 6>"${ROOT}/slots/landing-queue.lock"
flock -x 6
for landing_marker in ${ROOT}/slots/landing-wait-*.lock; do
  [ -e "$landing_marker" ] || continue
  if marker_open_live "$landing_marker"; then
    marker_slots=; marker_started=; marker_sequence=; marker_estimate_ms=; marker_memory_bytes=
    read -r marker_slots marker_started marker_sequence marker_estimate_ms marker_memory_bytes <&7 || true
    case "$marker_slots:$marker_started:$marker_sequence" in *[!0-9:]*|:*|*:) marker_slots=; marker_sequence= ;; esac
    if [ -n "$marker_slots" ] && [ "\${#marker_started}" -gt 13 ]; then marker_started=$((marker_started / 1000)); fi
    case "$marker_estimate_ms" in ''|none|*[!0-9]*) marker_estimate_ms=-1 ;; esac
    case "$marker_memory_bytes" in ''|*[!0-9]*) marker_memory_bytes=${CHECK_SLOT_MEMORY_BYTES} ;; esac
    if [ -n "$marker_slots" ] && { [ -z "$landing_waiting_sequence" ] || [ "$marker_sequence" -lt "$landing_waiting_sequence" ]; }; then
      landing_waiting_slots=$marker_slots
      landing_marker_id=\${landing_marker##*/landing-wait-}; landing_waiting_id=\${landing_marker_id%.lock}
      landing_waiting_started=$marker_started
      landing_waiting_estimate_ms=$marker_estimate_ms
      landing_waiting_memory_bytes=$marker_memory_bytes
      landing_waiting_sequence=$marker_sequence
    fi
  fi
  exec 7>&-
done
flock -u 6
exec 6>&-
multi_waiting_slots=0
multi_waiting_id=-
multi_waiting_sequence=
exec 6>"${ROOT}/slots/multi-queue.lock"
flock -x 6
for multi_marker in ${ROOT}/slots/multi-wait-*.lock; do
  [ -e "$multi_marker" ] || continue
  if marker_open_live "$multi_marker"; then
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
`;
  const admissionPolicy = `ordinary_admission_limit=${ordinaryAdmissionLimit}
wait_behind_older_multi=0
landing_priority_active=0
if [ "$gate_waiting" -eq 1 ]; then
  if [ ${gate ? 1 : 0} -eq 1 ]; then
    ordinary_admission_limit=${ordinaryCapacity}
  else
    ordinary_admission_limit=${gateRemainder}
  fi
elif [ ${gate ? 0 : 1} -eq 1 ] && [ "$landing_waiting_slots" -gt 0 ]; then
  if [ ${landingWaiterId ? quote(landingWaiterId) : "''"} = "$landing_waiting_id" ]; then
    ordinary_admission_limit=${ordinaryCapacity}
    landing_priority_active=1
  else
    landing_estimate_ms=$landing_waiting_estimate_ms
    case "$landing_estimate_ms" in ''|*[!0-9]*) landing_estimate_ms=${DEFAULT_MAX_MS} ;; esac
    [ "$landing_estimate_ms" -le ${DEFAULT_MAX_MS} ] || landing_estimate_ms=${DEFAULT_MAX_MS}
    landing_opportunity_ms=$landing_estimate_ms
    [ "$landing_opportunity_ms" -le ${pollMs} ] || landing_opportunity_ms=${pollMs}
    [ "$landing_opportunity_ms" -gt 0 ] || landing_opportunity_ms=1
    landing_now_ms=$(date +%s%3N)
    landing_age_ms=$((landing_now_ms - landing_waiting_started))
    [ "$landing_age_ms" -ge 0 ] || landing_age_ms=0
    landing_free_slots=$((${ordinaryCapacity} - ordinary_used))
    if [ "$landing_age_ms" -lt "$landing_opportunity_ms" ] && [ "$landing_free_slots" -ge "$landing_waiting_slots" ] && [ "$((held_memory + landing_waiting_memory_bytes))" -le "$memory_max_bytes" ]; then
      ordinary_admission_limit=$((${ordinaryCapacity} - landing_waiting_slots))
      landing_priority_active=1
    fi
  fi
fi
if [ ${gate ? 0 : 1} -eq 1 ] && [ "$gate_waiting" -eq 0 ] && [ "$landing_priority_active" -eq 0 ] && [ "$multi_waiting_slots" -gt 0 ]; then
  if [ ${multiWaiterId ? quote(multiWaiterId) : "''"} = "$multi_waiting_id" ]; then
    ordinary_admission_limit=${ordinaryCapacity}
  else
    ordinary_admission_limit=$(( ${ordinaryCapacity} - multi_waiting_slots ))
    if [ ${count > 1 && multiWaiterId ? 1 : 0} -eq 1 ]; then wait_behind_older_multi=1; fi
  fi
fi`;
  const body = `mkdir -p ${ROOT}/slots ${ROOT}/runs
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
${admissionPolicy}
if [ "$wait_behind_older_multi" -eq 1 ] || { [ ${priority !== undefined ? 1 : 0} -eq 1 ] && [ "$gate_waiting" -eq 1 ]; }; then exit ${SLOT_BUSY}; fi
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
  // dash treats exec 10>file as a command named "10"; Bash is provisioned on every supported check host and
  // preserves the inherited stdin, signals, exit code and multi-digit lock descriptors here.
  return `exec bash -c ${quote(body)}`;
}

const dockerWrapper = readFileSync(join(import.meta.dir, 'check-host/docker'), 'utf8');

function runSlice(id: string): string {
  return `rezics-check-${id.replaceAll('-', '_')}.slice`;
}

// A run can still be refreshing its base before entering systemd. Stop its identity-recorded host monitor first;
// that monitor reaps its tree before any lease/orphan cleanup advertises free capacity.
const supervisorStopProgram = String.raw`import json,os,signal,sys,time
from pathlib import Path
try:
    record=json.loads((Path(sys.argv[1])/'.remote-check-supervisor').read_text())
except FileNotFoundError:
    sys.exit(0)
def current(pid,started):
    try:
        fields=Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()
        return fields[19]==started and fields[0] not in ['Z','X']
    except FileNotFoundError:
        return False
pid=record['pid']; started=record['started']
if not current(pid,started): sys.exit(0)
try:
    descriptor=os.pidfd_open(pid)
    if current(pid,started): signal.pidfd_send_signal(descriptor,signal.SIGTERM)
    os.close(descriptor)
except ProcessLookupError:
    sys.exit(0)
end=time.monotonic()+12
while current(pid,started):
    if time.monotonic()>=end:
        raise RuntimeError('owned host supervisor did not stop and reap its run')
    time.sleep(.02)
`;

function stopSupervisor(directory: string): string {
  return `python3 -c ${quote(supervisorStopProgram)} ${directory}`;
}

/** Both normal cleanup and the stale-directory sweep remove only containers labelled for this run. */
function cleanupCommands(removeDirectory = true): string {
  return `${stopSupervisor('"$run_directory"')} || exit 1
systemctl stop "rezics-check-$run_id.scope" >/dev/null 2>&1
docker ps -aq --filter "label=rezics.check.run=$run_id" | while IFS= read -r container; do
  [ -z "$container" ] || docker rm -f -v "$container" >/dev/null 2>&1
done
systemctl stop "$run_slice" >/dev/null 2>&1
${removeDirectory ? 'rm -rf -- "$run_directory"' : ''}`;
}

/** Executed by the host Python 3 prerequisite, before selecting or downloading pinned Bun. */
export const dependencyPreparationProgram = String.raw`# Linux check-host dependency preparation. The supervising process is a subreaper in the run's systemd scope.
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time


def digest(path):
    value = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def inventory(root):
    result = {}
    # These belong to the transport/supervisor, or are disposable runtime caches, never lifecycle outputs.
    excluded = {'.git', '.alive', '.bun-install-complete', 'exit-status', 'command-started',
                'preparation-status.json', 'preparation-install.json', '.preparation-started',
                '.remote-check-supervisor', '.command-result', 'run-lifetime-status.json', 'bun-runtime-transpiler-cache',
                'physical-resources.json', '.resource-terminal-ready', '.resource-terminal-sampled',
                '.temp/check-host', '.temp/node-compile-cache'}
    for parent, directories, files in os.walk(root, followlinks=False):
        for name in sorted(directories + files):
            path = Path(parent) / name
            relative = path.relative_to(root).as_posix()
            if relative in excluded:
                if name in directories:
                    directories.remove(name)
                continue
            info = path.lstat()
            mode = stat.S_IMODE(info.st_mode)
            if path.is_symlink():
                target = os.readlink(path)
                if os.path.isabs(target) and target.startswith(str(root) + '/'):
                    target = os.path.relpath(target, path.parent)
                result[relative] = ['link', target]
                if name in directories:
                    directories.remove(name)
            elif path.is_dir():
                result[relative] = ['directory', mode]
            elif path.is_file():
                result[relative] = ['file', mode, digest(path)]
            else:
                raise RuntimeError('unsupported preparation output: ' + relative)
    return result


def remove(path):
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def copy_entries(source, destination, entries):
    for name, entry in sorted(entries.items(), key=lambda pair: (pair[0].count('/'), pair[0])):
        target = destination / name
        kind = entry[0]
        if kind == 'directory':
            if target.is_symlink() or (target.exists() and not target.is_dir()):
                remove(target)
            target.mkdir(parents=True, exist_ok=True)
            target.chmod(entry[1])
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            remove(target)
            if kind == 'link':
                target.symlink_to(entry[1])
            else:
                # Never share mutable package inodes between runs, the artifact cache or Bun's tarball cache.
                shutil.copy2(source / name, target)


def verified(entry, key):
    try:
        manifest = json.loads((entry / 'manifest.json').read_text())
        if manifest['key'] != key or manifest['schema'] != 2:
            return None
        if not isinstance(manifest['entries'], dict) or not isinstance(manifest['removed'], list) or not isinstance(manifest['nativeChecks'], list):
            return None
        if any(Path(name).is_absolute() or '..' in Path(name).parts
               for name in [*manifest['entries'], *manifest['removed']]):
            return None
        if inventory(entry / 'payload') != manifest['entries']:
            return None
        return manifest
    except (OSError, ValueError, KeyError, TypeError):
        return None


def verify_native_packages(root, entries):
    checks = []
    for name in entries:
        parts = Path(name).parts
        if not name.endswith('/package.json') or 'node_modules' not in parts:
            continue
        # Package fixtures and example manifests are not installed package identities.
        last_node_modules = len(parts) - 1 - tuple(reversed(parts)).index('node_modules')
        package_parts = parts[last_node_modules + 1:]
        if not (len(package_parts) == 2 or (len(package_parts) == 3 and package_parts[0].startswith('@'))):
            continue
        package = json.loads((root / name).read_text())
        package_root = (root / name).parent
        version = package.get('version', '')
        if package.get('name') == 'workerd':
            match = re.fullmatch(r'1\.(\d{4})(\d{2})(\d{2})\.\d+', version)
            if match is None:
                raise RuntimeError('unrecognized workerd version: ' + version)
            expected = 'workerd ' + '-'.join(match.groups())
            # workerd's own installer catches execution failures and can still exit successfully.
            actual = subprocess.check_output([str(package_root / 'bin/workerd'), '--version'], text=True, cwd=package_root).strip()
            if actual != expected:
                raise RuntimeError('workerd@' + version + ' binary version mismatch: ' + actual)
            checks.append({'name': 'workerd', 'version': version, 'binaryVersion': actual})
        elif package.get('name') == 'bun':
            if version.split('+')[0] != os.environ['REMOTE_CHECK_PREPARATION_VERSION']:
                raise RuntimeError('bun@' + version + ' does not match the pinned runtime')
            binary = package_root / package['bin']['bun']
            subprocess.run([str(binary), '--eval',
                            'process.exit(Bun.revision === process.argv[1] ? 0 : 1)',
                            os.environ['REMOTE_CHECK_PREPARATION_REVISION']], check=True, cwd=package_root)
            checks.append({'name': 'bun', 'version': version,
                           'revision': os.environ['REMOTE_CHECK_PREPARATION_REVISION']})
    return sorted(checks, key=lambda item: (item['name'], item['version']))


def native_entries(root, entries):
    # Only immutable registry native packages are reusable independently of checkout source. Workspace lifecycle
    # outputs remain in the source-keyed cache and are regenerated by frozen installation after any source edit.
    packages = []
    for name in entries:
        if not name.endswith('/package.json') or 'node_modules' not in Path(name).parts:
            continue
        try:
            package = json.loads((root / name).read_text())
            identity = package.get('name', '')
            if identity in ['workerd', 'bun'] or identity.startswith(('@cloudflare/workerd-', '@oven/bun-')):
                packages.append((root / name).parent)
        except (OSError, ValueError):
            pass
    selected = {}
    for name, value in entries.items():
        path = root / name
        if any(path == package or package in path.parents for package in packages):
            selected[name] = value
        elif value[0] == 'link':
            target = path.resolve()
            if any(target == package or package in target.parents for package in packages):
                selected[name] = value
    for name in list(selected):
        for parent in Path(name).parents:
            if parent.as_posix() != '.':
                selected[parent.as_posix()] = entries[parent.as_posix()]
    return selected


def publish_artifacts(root, entry, manifest):
    stage = Path(tempfile.mkdtemp(prefix='artifacts-', dir=root / '.temp/check-host'))
    try:
        (stage / 'payload').mkdir()
        copy_entries(root, stage / 'payload', manifest['entries'])
        (stage / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True))
        if verified(stage, manifest['key']) is None:
            raise RuntimeError('prepared artifact verification failed')
        # The per-key lock is held through verification/publication. Never remove a concurrent publisher's entry.
        if entry.exists():
            remove(entry)
        stage.rename(entry)
    finally:
        if stage.exists():
            remove(stage)


def install():
    root = Path.cwd()
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('installer subreaper unavailable')
    deadline = float(os.environ['REMOTE_CHECK_PREPARATION_DEADLINE'])
    if time.monotonic() >= deadline:
        raise RuntimeError('absolute preparation deadline exceeded')
    before = inventory(root)
    identity = {'schema': 2, 'inputs': before,
                'platform': [sys.platform, platform.machine(), platform.libc_ver()],
                'revision': os.environ['REMOTE_CHECK_PREPARATION_REVISION'],
                'build': os.environ['REMOTE_CHECK_PREPARATION_BUILD']}
    key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    cache = Path(os.environ['REMOTE_CHECK_PREPARATION_CACHE'])
    cache.mkdir(parents=True, exist_ok=True)
    entry = cache / key
    # The parent supervisor's absolute deadline includes lock wait, hashing, restore and publication.
    with open(cache / (key + '.lock'), 'a') as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(0.02)
        manifest = verified(entry, key)
        hit = manifest is not None
        stage = None
        native_hit = None
        try:
            if not hit:
                native_identity = dict(identity, inputs={name: value for name, value in before.items()
                    if Path(name).name in ['package.json', 'bun.lock', 'bun.lockb', 'bunfig.toml'] or name.startswith('patches/')})
                native_key = hashlib.sha256(json.dumps(native_identity, sort_keys=True).encode()).hexdigest()
                native_cache = cache / 'native'
                native_cache.mkdir(exist_ok=True)
                native_entry = native_cache / native_key
                with open(native_cache / (native_key + '.lock'), 'a') as native_lock:
                    while True:
                        try:
                            fcntl.flock(native_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                            break
                        except BlockingIOError:
                            time.sleep(0.02)
                    native_manifest = verified(native_entry, native_key)
                    native_hit = native_manifest is not None
                    if native_hit:
                        copy_entries(native_entry / 'payload', root, native_manifest['entries'])
                        if verify_native_packages(root, native_manifest['entries']) != sorted(native_manifest['nativeChecks'], key=lambda item: (item['name'], item['version'])):
                            raise RuntimeError('restored native package identity mismatch')
                    # No ignore-scripts: workspace/source lifecycle outputs are always rebuilt on a source-key miss.
                    completed = subprocess.run([os.environ['REMOTE_CHECK_REAL_BUN'], *sys.argv[2:]])
                    if completed.returncode:
                        return completed.returncode if completed.returncode > 0 else 128 - completed.returncode
                    native_outputs = native_entries(root, inventory(root))
                    native_checks = verify_native_packages(root, native_outputs)
                    if not native_hit:
                        publish_artifacts(root, native_entry, {'schema': 2, 'key': native_key,
                            'entries': native_outputs, 'removed': [], 'nativeChecks': native_checks})
                if owned_processes():
                    raise RuntimeError('installer left owned descendants')
                after = inventory(root)
                native_checks = verify_native_packages(root, after)
                outputs = {name: value for name, value in after.items() if before.get(name) != value}
                # Include parent directories so the payload has a complete independently verifiable inventory.
                for name in list(outputs):
                    for parent in Path(name).parents:
                        if parent.as_posix() != '.':
                            outputs[parent.as_posix()] = after[parent.as_posix()]
                removed = sorted(set(before) - set(after), key=lambda name: -name.count('/'))
                stage = Path(tempfile.mkdtemp(prefix='artifacts-', dir=root / '.temp/check-host'))
                (stage / 'payload').mkdir()
                copy_entries(root, stage / 'payload', outputs)
                manifest = {'schema': 2, 'key': key, 'entries': outputs, 'removed': removed, 'nativeChecks': native_checks}
                (stage / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True))
                if verified(stage, key) is None:
                    raise RuntimeError('prepared artifact verification failed')
                # Only this key's lock owner can replace an invalid entry. Valid publications remain immutable.
                if entry.exists():
                    remove(entry)
                stage.rename(entry)
                stage = None
            for name in manifest['removed']:
                remove(root / name)
            copy_entries(entry / 'payload', root, manifest['entries'])
            packages = []
            for name in manifest['entries']:
                if name.endswith('/package.json'):
                    try:
                        package = json.loads((root / name).read_text())
                        if package.get('name') and package.get('version'):
                            packages.append({'name': package['name'], 'version': package['version']})
                    except (OSError, ValueError):
                        pass
            receipt = {'cache': 'hit' if hit else 'miss', 'nativeCache': None if hit else ('hit' if native_hit else 'miss'),
                       'key': key, 'packages': packages, 'nativeChecks': manifest['nativeChecks']}
            (root / 'preparation-install.json').write_text(json.dumps(receipt, sort_keys=True))
            if time.monotonic() >= deadline:
                raise RuntimeError('absolute preparation deadline exceeded')
            (root / '.bun-install-complete').touch()
            print('remote-check: dependency artifacts ' + receipt['cache'] + ' ' + key, file=sys.stderr, flush=True)
            return 0
        finally:
            if stage is not None:
                remove(stage)


def owned_processes():
    # Walk only this physical run's children/threads, independent of other hosts' run history or process count.
    pending = [os.getpid()]
    seen = set()
    owned = {}
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        try:
            path = Path('/proc/' + str(pid))
            fields = (path / 'stat').read_text().rsplit(')', 1)[1].split()
            if pid != os.getpid():
                owned[pid] = fields[19]
            for task in (path / 'task').iterdir():
                try:
                    pending.extend(int(value) for value in (task / 'children').read_text().split())
                except (FileNotFoundError, ProcessLookupError):
                    pass
        except (FileNotFoundError, ProcessLookupError):
            pass
    return owned


def stop_owned(number):
    # pidfds plus a start-identity recheck prevent a PID reuse from signalling an unrelated process.
    for pid, started in owned_processes().items():
        descriptor = None
        try:
            descriptor = os.pidfd_open(pid)
            fields = Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')', 1)[1].split()
            if fields[19] == started:
                signal.pidfd_send_signal(descriptor, number)
        except (ProcessLookupError, FileNotFoundError):
            pass
        finally:
            if descriptor is not None:
                os.close(descriptor)


def active_packages(root):
    packages = {}
    for pid in owned_processes():
        try:
            cwd = Path(os.readlink('/proc/' + str(pid) + '/cwd'))
            cwd.relative_to(root)
            for path in [cwd, *cwd.parents]:
                if path == root:
                    break
                metadata = path / 'package.json'
                if metadata.is_file():
                    package = json.loads(metadata.read_text())
                    if package.get('name') and package.get('version'):
                        packages[(package['name'], package['version'])] = {
                            'name': package['name'], 'version': package['version']}
                    break
        except (OSError, ValueError):
            pass
    return list(packages.values())


def supervise():
    limit_ms, host, run, directory = sys.argv[2:6]
    root = Path(directory)
    started = time.monotonic()
    deadline = min(started + int(limit_ms) / 1000, float(os.environ.get('REMOTE_CHECK_HOST_PREPARATION_DEADLINE', 'inf')))
    (root / '.preparation-started').write_text(json.dumps({'deadline': deadline, 'limitMs': int(limit_ms)}))
    wall_started_ns = time.time_ns()
    # Without adoption and waitpid, double-forked installer children can survive their launcher or become zombies.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER, supported Linux check-host prerequisite.
        raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER')
    shim = root / '.temp/check-host/bun-prepare'
    shim.write_text('#!/bin/sh\nexec python3 ' + "'" + __file__.replace("'", "'\\''") + "' install \"$@\"\n")
    shim.chmod(0o755)
    env = dict(os.environ, REMOTE_CHECK_PREPARER_BIN=str(shim),
               REMOTE_CHECK_PREPARATION_CACHE=str(root.parent.parent / 'dependency-artifacts'),
               REMOTE_CHECK_PREPARATION_DEADLINE=str(deadline))
    child = subprocess.Popen(sys.argv[6:], env=env, start_new_session=True,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    selected = selectors.DefaultSelector()
    for stream, output in [(child.stdout, sys.stdout.buffer), (child.stderr, sys.stderr.buffer)]:
        selected.register(stream, selectors.EVENT_READ, output)
    interrupted = []
    for sig in [signal.SIGHUP, signal.SIGINT, signal.SIGTERM]:
        signal.signal(sig, lambda number, frame: interrupted.append(number))
    tail = bytearray()
    packages = []
    observed = []
    failure = None
    preparation_done = False
    code = None
    stopped_at = None
    while True:
        if not preparation_done and stopped_at is None:
            marker = root / '.bun-install-complete'
            preparation_done = marker.exists() and marker.stat().st_mtime_ns <= wall_started_ns + int(limit_ms) * 1000000
            packages = active_packages(root)
            if packages:
                observed = packages
            if not preparation_done and time.monotonic() >= deadline:
                failure = 'absolute preparation deadline exceeded'
        if interrupted:
            failure = 'signal ' + str(interrupted[0])
        if failure and stopped_at is None:
            stopped_at = time.monotonic()
            stop_owned(signal.SIGTERM)
        if stopped_at is not None and time.monotonic() - stopped_at >= 0.2:
            stop_owned(signal.SIGKILL)
        for event, unused in selected.select(0.02):
            block = os.read(event.fileobj.fileno(), 65536)
            if block:
                event.data.write(block)
                event.data.flush()
                if not preparation_done:
                    tail.extend(block)
                    del tail[:-8192]
            else:
                selected.unregister(event.fileobj)
                event.fileobj.close()
        code = child.poll()
        # Reap descendants adopted after their parents exit. Do not reap Popen's direct child before poll().
        if code is not None:
            while True:
                try:
                    adopted, status = os.waitpid(-1, os.WNOHANG)
                    if adopted == 0:
                        break
                except ChildProcessError:
                    break
            remaining = owned_processes()
            if remaining and stopped_at is None:
                if not preparation_done:
                    failure = failure or 'installer left owned descendants'
                stopped_at = time.monotonic()
                stop_owned(signal.SIGTERM)
            if not remaining and not selected.get_map():
                if stopped_at is None:
                    marker = root / '.bun-install-complete'
                    preparation_done = marker.exists() and marker.stat().st_mtime_ns <= wall_started_ns + int(limit_ms) * 1000000
                break
    if not preparation_done or failure:
        code = 128 + interrupted[0] if interrupted else 70
        receipt = {'status': 'infrastructure-failure', 'host': host, 'run': run, 'phase': 'command' if preparation_done else 'install/preparation',
                   'elapsedMs': round((time.monotonic() - started) * 1000),
                   'reason': failure or 'preparation exited ' + str(child.returncode),
                   'activePackages': packages, 'lastObservedPackages': observed,
                   'packageClassification': 'active' if packages else 'unknown',
                   'logTail': tail.decode(errors='replace')}
        (root / 'preparation-status.json').write_text(json.dumps(receipt, sort_keys=True))
        terminal_status(root).write_text(str(code) + '\n')
        print('remote-check: infrastructure failure ' + json.dumps(receipt, sort_keys=True), file=sys.stderr, flush=True)
    else:
        code = code if code >= 0 else 128 - code
    if os.environ.get('REMOTE_CHECK_HOST_LIFETIME') == '1':
        (root / '.resource-terminal-ready').touch()
        end = time.monotonic() + .15
        while not (root / '.resource-terminal-sampled').exists() and time.monotonic() < end:
            time.sleep(.005)
    return code


def terminal_status(root):
    return root / ('.command-result' if os.environ.get('REMOTE_CHECK_HOST_LIFETIME') == '1' else 'exit-status')


def durable(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.pending')
    with open(temporary, 'w') as output:
        output.write(value)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def emit_nonblocking(message):
    # Receipt delivery must never prevent killing/reaping a run with an unread SSH pipe.
    try:
        os.set_blocking(2, False)
        os.write(2, (message + '\n').encode()[:4096])
    except (BlockingIOError, BrokenPipeError, OSError):
        pass


def clean_run_resources(run):
    scope = 'rezics-check-' + run + '.scope'
    slice_name = 'rezics-check-' + run.replace('-', '_') + '.slice'
    def call(arguments):
        return subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3, text=True)
    call(['systemctl', 'stop', scope])
    containers = call(['docker', 'ps', '-aq', '--filter', 'label=rezics.check.run=' + run])
    for container in containers.stdout.split():
        if not re.fullmatch(r'[a-f0-9]{12,64}', container):
            raise RuntimeError('invalid owned container identity')
        call(['docker', 'rm', '-f', '-v', container])
    call(['systemctl', 'stop', slice_name])
    group = call(['systemctl', 'show', '--property=ControlGroup', '--value', slice_name]).stdout.strip()
    if group:
        path = Path('/sys/fs/cgroup') / group.lstrip('/') / 'cgroup.events'
        try:
            if 'populated 1' in path.read_text().splitlines():
                raise RuntimeError('owned run cgroup is still populated')
        except FileNotFoundError:
            pass  # systemd removed the empty cgroup.


RESOURCE_CGROUP_ROOT = '/sys/fs/cgroup'
RESOURCE_CGROUP_OVERRIDE = None  # Native fixtures replace source constants, never production environment policy.
RESOURCE_BOOT_FILE = '/proc/sys/kernel/random/boot_id'


class Resources:
    def __init__(self, host, run, root, started):
        self.root = root
        self.path = None
        self.identity = None
        self.previous = None
        self.next = started
        self.invalid = None
        fields = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()
        self.receipt = {'schema': 1, 'host': host, 'run': run,
            'boot': Path(RESOURCE_BOOT_FILE).read_text().strip(),
            'supervisor': {'pid': os.getpid(), 'start': fields[19], 'group': os.getpgrp()},
            'cgroup': None, 'cadenceMs': 5000, 'startedMonoMs': started * 1000,
            'commandStartedMonoMs': None, 'terminalMonoMs': started * 1000,
            'samples': [], 'sampledMaxCores': None}

    def bind(self):
        # Find the actual scope member among OUR descendants. No guessed unit/cwd/PID absence establishes custody.
        for pid, started in owned_processes().items():
            try:
                group = next(line[3:] for line in Path('/proc/'+str(pid)+'/cgroup').read_text().splitlines() if line.startswith('0::'))
                scope = 'rezics-check-' + self.receipt['run'] + '.scope'
                if RESOURCE_CGROUP_OVERRIDE is None and scope not in group.split('/'):
                    continue
                if RESOURCE_CGROUP_OVERRIDE is None:
                    # The observed run slice includes this scope and its labelled containers.
                    slice_name = 'rezics-check-' + self.receipt['run'].replace('-', '_') + '.slice'
                    components = group.split('/')
                    if slice_name not in components:
                        continue
                    group = '/'.join(components[:components.index(slice_name) + 1])
                path = Path(RESOURCE_CGROUP_OVERRIDE) if RESOURCE_CGROUP_OVERRIDE else Path(RESOURCE_CGROUP_ROOT) / group.lstrip('/')
                stat = path.stat()
                if RESOURCE_CGROUP_OVERRIDE:
                    invocation = (path / 'invocation').read_text().strip()
                else:
                    invocation = subprocess.run(['systemctl', 'show', '--property=InvocationID', '--value', scope],
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=0.1).stdout.strip()
                if not invocation:
                    return
                fields = Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()
                if fields[19] != started:
                    continue
                self.path = path
                self.identity = (stat.st_dev, stat.st_ino)
                self.receipt['cgroup'] = {'path': group if not RESOURCE_CGROUP_OVERRIDE else str(path),
                    'device': stat.st_dev, 'inode': stat.st_ino, 'invocation': invocation}
                return
            except (OSError, ValueError, StopIteration, subprocess.TimeoutExpired):
                return

    def sample(self, phase, force=False):
        now = time.monotonic()
        if not force and now < self.next:
            return
        self.next = now + 5
        if len(self.receipt['samples']) >= 1444:
            return
        if self.path is None:
            self.bind()
        row = {'monoMs': now * 1000, 'phase': phase, 'usageUsec': None, 'memoryPeakBytes': None,
               'intervalMs': None, 'cores': None, 'unavailable': None}
        try:
            if self.invalid:
                raise ValueError(self.invalid)
            if self.path is None:
                raise ValueError('owned cgroup not yet available')
            if Path(RESOURCE_BOOT_FILE).read_text().strip() != self.receipt['boot']:
                self.invalid = 'host boot changed'
                raise ValueError(self.invalid)
            stat = self.path.stat()
            if (stat.st_dev, stat.st_ino) != self.identity:
                self.invalid = 'cgroup generation changed'
                raise ValueError(self.invalid)
            if RESOURCE_CGROUP_OVERRIDE:
                invocation = (self.path / 'invocation').read_text().strip()
            else:
                invocation = subprocess.run(['systemctl', 'show', '--property=InvocationID', '--value',
                    'rezics-check-' + self.receipt['run'] + '.scope'], stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL, text=True, timeout=.1).stdout.strip()
            if invocation != self.receipt['cgroup']['invocation']:
                self.invalid = 'cgroup invocation changed'
                raise ValueError(self.invalid)
            # cgroup pseudo-files are tiny; bound reads explicitly. Missing/invalid counters are unavailable, never zero.
            with open(self.path / 'cpu.stat') as source:
                usage = int(next(line.split()[1] for line in source.read(4096).splitlines() if line.startswith('usage_usec ')))
            with open(self.path / 'memory.peak') as source:
                peak = int(source.read(128))
            if usage < 0 or peak < 0 or usage > 9007199254740991 or peak > 9007199254740991:
                raise ValueError('invalid counters')
            if self.previous:
                then, old_usage, old_peak = self.previous
                if usage < old_usage or peak < old_peak:
                    self.invalid = 'counter regression'
                    raise ValueError(self.invalid)
                row['intervalMs'] = (now - then) * 1000
                row['cores'] = (usage - old_usage) / 1000000 / (now - then)
                old_max = self.receipt['sampledMaxCores']
                self.receipt['sampledMaxCores'] = max(old_max or 0, row['cores'])
            row.update(usageUsec=usage, memoryPeakBytes=peak)
            self.previous = (now, usage, peak)
        except (OSError, ValueError, StopIteration, subprocess.TimeoutExpired) as error:
            row['unavailable'] = str(error)[:160]
            self.previous = None
        self.receipt['samples'].append(row)

    def finish(self):
        self.sample('terminal', True)
        self.receipt['terminalMonoMs'] = time.monotonic() * 1000
        contents = json.dumps(self.receipt, sort_keys=True)
        durable(self.root / 'physical-resources.json', contents)
        durable(self.root.parent.parent / 'receipts' / self.receipt['run'] / 'physical-resources.json', contents)


def lifetime():
    # This independent host monitor does no stream forwarding. Child stdout/stderr can block indefinitely without
    # blocking this monotonic deadline. Its detached session survives a caller/session group disappearing;
    # directly addressed abort signals still stop and reap the owned run.
    started = time.monotonic()
    limit_ms, host, run, directory, command, preparation_ms = sys.argv[2:8]
    limit_ms = int(limit_ms)
    if not 0 < limit_ms <= 7200000:
        raise RuntimeError('invalid host lifetime')
    root = Path(directory)
    preparation_deadline = started + int(preparation_ms) / 1000
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('host lifetime subreaper unavailable')
    try:
        os.setsid()
    except PermissionError:
        if os.getsid(0) != os.getpid():
            raise
    interrupted = []
    for sig in [signal.SIGHUP, signal.SIGTERM, signal.SIGINT]:
        signal.signal(sig, lambda number, frame: interrupted.append(number))
    fields = Path('/proc/' + str(os.getpid()) + '/stat').read_text().rsplit(')', 1)[1].split()
    durable(root / '.remote-check-supervisor', json.dumps({'pid': os.getpid(), 'started': fields[19], 'group': os.getpgrp()}))
    with os.fdopen(3) as source:
        script = source.read()
    child = subprocess.Popen(['sh', '-c', script], env=dict(os.environ, REMOTE_CHECK_HOST_LIFETIME='1',
        REMOTE_CHECK_HOST_PREPARATION_DEADLINE=str(preparation_deadline)), start_new_session=True)
    resources = None
    try:
        resources = Resources(host, run, root, started)
        resources.sample('preparation', True)
    except Exception:
        pass
    reason = None
    stopped_at = None
    packages = []
    while True:
        now = time.monotonic()
        try:
            command_started = root / 'command-started'
            if command_started.exists() and resources.receipt['commandStartedMonoMs'] is None:
                resources.receipt['commandStartedMonoMs'] = now * 1000
                resources.sample('command', True)
            resources.sample('command' if resources.receipt['commandStartedMonoMs'] is not None else 'preparation')
            if (root / '.resource-terminal-ready').exists() and not (root / '.resource-terminal-sampled').exists():
                resources.sample('terminal', True)
                (root / '.resource-terminal-sampled').touch()
        except Exception:
            pass  # Observation cannot change a command's verdict, custody or lifetime.
        if reason is None:
            if (now - started) * 1000 >= limit_ms:
                reason = 'run-lifetime'
            elif interrupted:
                reason = 'abort'
            elif not (root / '.bun-install-complete').exists():
                if now >= preparation_deadline:
                    reason = 'install/preparation'
                    packages = active_packages(root)
        if reason is not None and stopped_at is None:
            stopped_at = now
            try: resources.sample('terminal', True)
            except Exception: pass
            stop_owned(signal.SIGTERM)
        if stopped_at is not None and now - stopped_at >= 0.2:
            stop_owned(signal.SIGKILL)
        code = child.poll()
        if code is not None:
            while True:
                try:
                    if os.waitpid(-1, os.WNOHANG)[0] == 0:
                        break
                except ChildProcessError:
                    break
            remaining = owned_processes()
            if not remaining:
                break
            if reason is None:
                reason = 'owned-descendants'
        time.sleep(0.01)
    try: resources.finish()
    except Exception: pass
    if reason:
        # Containers started by a daemon are outside this process tree, but retain exact run labels and cgroup custody.
        clean_run_resources(run)
        elapsed = round((time.monotonic() - started) * 1000)
        receipt = {'schema': 1, 'status': 'infrastructure-failure', 'phase': reason, 'host': host, 'run': run,
                   'limitMs': limit_ms, 'elapsedMs': elapsed, 'command': command[:256]}
        code = 124 if reason == 'run-lifetime' else 128 + interrupted[0] if interrupted else 70
        if reason == 'install/preparation':
            receipt.update({'reason': 'absolute preparation deadline exceeded', 'activePackages': packages,
                            'packageClassification': 'active' if packages else 'unknown', 'logTail': ''})
        name = 'run-lifetime-status.json' if reason == 'run-lifetime' else 'preparation-status.json'
        contents = json.dumps(receipt, sort_keys=True)
        durable(root / name, contents)
        durable(root.parent.parent / 'receipts' / run / name, contents)
        emit_nonblocking(('remote-check: infrastructure failure: remote run timed out ' if reason == 'run-lifetime'
                          else 'remote-check: infrastructure failure ') + contents)
    else:
        code = code if code >= 0 else 128 - code
    # Terminal admission state is published only after the entire owned tree is reaped and timeout cgroups are empty.
    durable(root / 'exit-status', str(code) + '\n')
    return code


def local_command():
    # The same subreaper/pidfd custody protects an authorized local fallback from detached grandchildren.
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('local command subreaper unavailable')
    interrupted = []
    for sig in [signal.SIGHUP, signal.SIGINT, signal.SIGTERM]:
        signal.signal(sig, lambda number, frame: interrupted.append(number))
    parent = os.getppid()
    if ctypes.CDLL(None).prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
        raise RuntimeError('local command parent-death custody unavailable')
    if os.getppid() != parent or parent == 1:
        return 143
    child = subprocess.Popen(sys.argv[2:], start_new_session=True)
    stopped_at = None
    while True:
        code = child.poll()
        if (interrupted or code is not None) and stopped_at is None:
            stopped_at = time.monotonic()
            stop_owned(signal.SIGTERM)
        if stopped_at is not None and time.monotonic() - stopped_at >= .2:
            stop_owned(signal.SIGKILL)
        if code is not None:
            while True:
                try:
                    if os.waitpid(-1, os.WNOHANG)[0] == 0: break
                except ChildProcessError: break
            if not owned_processes():
                return 128 + interrupted[0] if interrupted else code if code >= 0 else 128 - code
        time.sleep(.01)


attempt_started = time.monotonic()
try:
    sys.exit(install() if sys.argv[1] == 'install' else lifetime() if sys.argv[1] == 'lifetime' else local_command() if sys.argv[1] == 'local' else supervise())
except Exception as error:
    stop_owned(signal.SIGKILL)
    while True:
        try:
            os.waitpid(-1, 0)
        except ChildProcessError:
            break
    if sys.argv[1] == 'supervise':
        root = Path(sys.argv[5])
        receipt = {'status': 'infrastructure-failure', 'host': sys.argv[3], 'run': sys.argv[4],
                   'phase': 'install/preparation', 'reason': str(error), 'activePackages': [],
                   'elapsedMs': round((time.monotonic() - attempt_started) * 1000),
                   'packageClassification': 'unknown'}
        (root / 'preparation-status.json').write_text(json.dumps(receipt))
        terminal_status(root).write_text('70\n')
    print('remote-check: infrastructure failure install/preparation: ' + str(error), file=sys.stderr, flush=True)
    sys.exit(70)
`;

/** Linux local commands use the host lifecycle's existing identity-safe subreaper, without remote placement or install. */
export function ownedLocalCommand(command: readonly string[]): string[] {
  return process.platform === 'linux'
    ? ['python3', '-c', dependencyPreparationProgram, 'local', ...command]
    : [...command];
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
  preparationTimeoutMs = configuredTimeout(
    undefined,
    'REMOTE_CHECK_PREPARATION_TIMEOUT_MS',
    DEFAULT_PREPARATION_TIMEOUT_MS,
  ),
  estimateMs?: number,
  maxMs?: number,
): string {
  const lifetimeMs = effectiveRunLifetimeMs(estimateMs, maxMs);
  const { version: pinnedBunVersion, revision: pinnedBunRevision } = getPinnedBun();
  const wrapperDirectory = `${directory}/.temp/check-host`;
  const statusFile = `${directory}/exit-status`;
  const systemdScript = `${refreshBaseScript(id, directory)}
set +e
host=$REMOTE_CHECK_HOST
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
    real_bun=$bun
    if [ -n "\${REMOTE_CHECK_PREPARER_BIN:-}" ]; then
      export REMOTE_CHECK_REAL_BUN="$bun" REMOTE_CHECK_PREPARATION_REVISION="$expected_revision" REMOTE_CHECK_PREPARATION_BUILD="$build" REMOTE_CHECK_PREPARATION_VERSION="$expected_bun"
      bun=$REMOTE_CHECK_PREPARER_BIN
    fi
    "$bun" install --frozen-lockfile
    code=$?
    bun=$real_bun
    unset REMOTE_CHECK_PREPARER_BIN REMOTE_CHECK_REAL_BUN REMOTE_CHECK_PREPARATION_REVISION REMOTE_CHECK_PREPARATION_BUILD REMOTE_CHECK_PREPARATION_VERSION REMOTE_CHECK_PREPARATION_CACHE REMOTE_CHECK_PREPARATION_DEADLINE
    if [ "$code" -eq 0 ]; then [ -f ${quote(`${directory}/.bun-install-complete`)} ] || touch ${quote(`${directory}/.bun-install-complete`)}; fi
    install_finished=$(date +%s%N)
    awk -v elapsed="$((install_finished - install_started))" -v host="$host" 'BEGIN { printf "remote-check: bun install %.3f s on %s\\n", elapsed / 1000000000, host }' >&2
    if [ "$code" -eq 0 ]; then
      export PATH="$(dirname "$bun"):$PWD/node_modules/.bin:$PATH"
      cd "$1"
      code=$?
      shift${process.env.KERNEL_CHECK_CONCURRENCY === undefined ? '' : `; export KERNEL_CHECK_CONCURRENCY=${quote(process.env.KERNEL_CHECK_CONCURRENCY)}`}
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
    terminal_status=${quote(statusFile)}
    if [ "\${REMOTE_CHECK_HOST_LIFETIME:-}" = 1 ]; then terminal_status=${quote(`${directory}/.command-result`)}; fi
    printf '%s\\n' "$code" > "$terminal_status"
    exit $code`;
  const script = `mkdir -p ${wrapperDirectory} && cat > ${wrapperDirectory}/docker <<'WRAPPER' && chmod +x ${wrapperDirectory}/docker || exit 1
${dockerWrapper}WRAPPER
printf '%s' ${quote(Buffer.from(dependencyPreparationProgram).toString('base64'))} | base64 -d > ${quote(`${wrapperDirectory}/prepare.py`)} || exit 70
export PATH=${wrapperDirectory}:/usr/local/bin:$PATH BUN_INSTALL_CACHE_DIR=${ROOT}/bun-cache BUN_RUNTIME_TRANSPILER_CACHE_PATH=${directory}/bun-runtime-transpiler-cache PLAYWRIGHT_BROWSERS_PATH=${ROOT}/browsers KERNEL_CHECK_TIMINGS=${quote(`${directory}/.temp/kernel-check/timings`)} AUTH_CHECK_TIMINGS=${quote(`${directory}/.temp/auth-check/timings`)} KERNEL_CHECK_ON_REMOTE=1 REZICS_STACK_LEASE=off REMOTE_CHECK_HOST=${quote(hostName)} REZICS_CHECK_SLICE=${runSlice(id)} REZICS_CHECK_RUN=${id}
export REZICS_CHECK_PHASES=${quote(`${directory}/command-phases.tsv`)}
printf 'remote-check: run priority %s on %s\n' ${quote(priorityClass)} ${quote(hostName)} >&2
cd ${directory} || exit 1
touch ${quote(`${directory}/.alive`)}
systemd_script=${quote(systemdScript)}
# systemd 259 expands \${NAME} in --scope arguments by default, which broke the script's parameter expansions on c
# (842 failed runs from 10-28 18:36 UTC); older systemd has no such flag and does not expand.
expand_environment=
if systemd-run --help 2>/dev/null | grep -q -- '--expand-environment'; then expand_environment=--expand-environment=no; fi
exec systemd-run --scope --quiet --collect $expand_environment --slice=${runSlice(id)} --unit=rezics-check-${id} \\
  python3 ${quote(`${wrapperDirectory}/prepare.py`)} supervise ${preparationTimeoutMs} ${quote(hostName)} ${quote(id)} ${quote(directory)} \\
  sh -c "$systemd_script" sh ${[cwd, ...command].map(quote).join(' ')}`;
  const executable = (command[0]?.split('/').at(-1) ?? 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '?').slice(0, 64);
  const subcommand = ['test', 'run', 'check', 'build', 'typecheck', 'verify', 'lint'].includes(command[1] ?? '')
    ? ` ${command[1]}`
    : '';
  const identity = `${executable}${subcommand} [${Math.max(0, command.length - 1)} arguments]`;
  // fd 3 carries the literal original script independently of command stdin. No second shell quoting pass touches argv.
  const delimiter = `REMOTE_CHECK_HOST_${id.replace(/[^a-zA-Z0-9]/g, '_')}`;
  return `# REMOTE_CHECK_RUN_LIFETIME_MS ${lifetimeMs}
exec python3 -c ${quote(`import base64; exec(base64.b64decode(${JSON.stringify(Buffer.from(dependencyPreparationProgram).toString('base64'))}))`)} lifetime ${lifetimeMs} ${quote(hostName)} ${quote(id)} ${quote(directory)} ${quote(identity)} ${preparationTimeoutMs} 3<<'${delimiter}'
${script}
${delimiter}`;
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
  const slice = quote(runSlice(id));
  return `systemctl stop ${slice} >/dev/null 2>&1 || true
${stopSupervisor(quote(`${ROOT}/runs/${id}`))} || exit 1
if systemctl is-active --quiet ${slice}; then exit 1; fi
printf 'STOPPED\\n'`;
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
  landingWaitingStarted: number | null;
  landingWaitingEstimateMs: number | null;
  landingWaitingMemoryBytes: number;
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
  pollMs = 5000,
): RankedHost {
  const capacity = hostCapacity(host, probe);
  const ordinaryCapacity = Math.max(0, capacity - 1);
  const gateCapacity = Math.max(0, ordinaryCapacity - 1);
  const hasMultiWaiter = !probe.gateWaiting && probe.multiWaitingSlots > 0;
  const isOldestMultiWaiter = hasMultiWaiter && multiWaiterId !== undefined && probe.multiWaitingId === multiWaiterId;
  const hasLandingWaiter = probe.landingWaitingSlots > 0;
  const isOldestLandingWaiter =
    hasLandingWaiter && landingWaiterId !== undefined && probe.landingWaitingId === landingWaiterId;
  const resourceSlots = probeCapacity(capacity);
  const memoryMaximum = host.memoryMaxGiB * 2 ** 30;
  const landingAgeMs =
    probe.landingWaitingStarted === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Date.now() - probe.landingWaitingStarted);
  const landingOpportunityActive =
    !gate &&
    !probe.gateWaiting &&
    hasLandingWaiter &&
    landingAgeMs < landingOpportunityMs(probe.landingWaitingEstimateMs, pollMs) &&
    probe.ordinarySlotsUsed <= ordinaryCapacity &&
    ordinaryCapacity - probe.ordinarySlotsUsed >= probe.landingWaitingSlots &&
    probe.memoryReserved + probe.landingWaitingMemoryBytes <= memoryMaximum;
  const waitsBehindOlderMulti =
    !probe.gateWaiting &&
    !landingOpportunityActive &&
    hasMultiWaiter &&
    slots > 1 &&
    multiWaiterId !== undefined &&
    !isOldestMultiWaiter;
  const ordinaryAdmissionLimit = gate
    ? ordinaryCapacity
    : probe.gateWaiting
      ? ordinaryCapacity - gateCapacity
      : landingOpportunityActive
        ? isOldestLandingWaiter
          ? ordinaryCapacity
          : Math.max(0, ordinaryCapacity - probe.landingWaitingSlots)
        : hasMultiWaiter
          ? isOldestMultiWaiter
            ? ordinaryCapacity
            : ordinaryCapacity - probe.multiWaitingSlots
          : ordinaryCapacity;
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
  if (priority !== undefined && probe.gateWaiting) freeSlots = 0;
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
  const landingWaitingStartedValue = value('LANDING_WAITING_STARTED');
  const landingWaitingStarted = landingWaitingStartedValue === '-' ? null : Number(landingWaitingStartedValue);
  const landingWaitingEstimateValue = value('LANDING_WAITING_ESTIMATE_MS');
  const landingWaitingEstimateMs = landingWaitingEstimateValue === '-1' ? null : Number(landingWaitingEstimateValue);
  const landingWaitingMemoryValue = value('LANDING_WAITING_MEMORY_BYTES');
  const landingWaitingMemoryBytes = Number(landingWaitingMemoryValue);
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
    landingWaitingStartedValue === null ||
    (landingWaitingStarted !== null && (!Number.isSafeInteger(landingWaitingStarted) || landingWaitingStarted < 0)) ||
    (landingWaitingSlots === 0) !== (landingWaitingStarted === null) ||
    landingWaitingEstimateValue === null ||
    (landingWaitingEstimateMs !== null &&
      (!Number.isSafeInteger(landingWaitingEstimateMs) || landingWaitingEstimateMs < 0)) ||
    landingWaitingMemoryValue === null ||
    !Number.isSafeInteger(landingWaitingMemoryBytes) ||
    landingWaitingMemoryBytes < 1 ||
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
    landingWaitingStarted,
    landingWaitingEstimateMs,
    landingWaitingMemoryBytes,
  };
}

async function probeHost(host: Host, uploadedDirectory?: string): Promise<HostProbe | null> {
  const placementHeartbeat = uploadedDirectory
    ? `# Keep this uploaded placement alive while admission waits; a missing workspace must be uploaded again.
[ -d ${quote(uploadedDirectory)} ] || exit 75
touch ${quote(`${uploadedDirectory}/.alive`)} || exit 75
`
    : '';
  const child = Bun.spawn(
    ['ssh', ...sshOptions(host, undefined, true), host.address, placementHeartbeat + probeScript(host)],
    {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    },
  );
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
        const stdin = holder.stdin;
        if (stdin && typeof stdin === 'object' && 'end' in stdin && typeof stdin.end === 'function') {
          await stdin.end();
        }
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
  connectionId?: string,
  noProgressTimeoutMs?: number,
  step = 'slot take',
): Promise<SessionLease | null> {
  if (signal.aborted) throw new Aborted();
  const holder = Bun.spawn(['ssh', ...sshOptions(host, connectionId), host.address, script], {
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
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let progressExpired = false;
  const armProgressTimer = () => {
    if (noProgressTimeoutMs === undefined) return;
    clearTimeout(progressTimer);
    progressTimer = setTimeout(() => {
      progressExpired = true;
      stop();
    }, noProgressTimeoutMs);
  };
  armProgressTimer();
  try {
    let seen = '';
    while (!token.test(seen)) {
      if (signal.aborted) throw new Aborted();
      const chunk = await reader.read();
      if (chunk.done) {
        const code = await lease.exited;
        if (signal.aborted) throw new Aborted();
        if (progressExpired) throw new RemoteTransportError(host.name, step, REMOTE_TRANSPORT_FAILURE);
        if (code === SLOT_BUSY) return null;
        if (code !== 0) throw new RemoteTransportError(host.name, step, code);
        return null;
      }
      armProgressTimer();
      seen += new TextDecoder().decode(chunk.value);
    }
    if (signal.aborted) throw new Aborted();
    if (progressExpired) throw new RemoteTransportError(host.name, step, REMOTE_TRANSPORT_FAILURE);
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
    if (progressExpired) throw new RemoteTransportError(host.name, step, REMOTE_TRANSPORT_FAILURE);
    throw error;
  } finally {
    clearTimeout(progressTimer);
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
  pollMs = 5000,
  connectionId?: string,
  transferTimeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS,
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
      pollMs,
    ),
    /^SLOTS? \d+$/m,
    signal,
    connectionId,
    transferTimeoutMs,
    'slot take',
  );
}

async function takeGateMarker(host: Host, signal: AbortSignal, connectionId?: string): Promise<SessionLease | null> {
  return takeSession(host, gateMarkerScript(), /^GATE_MARKER$/m, signal, connectionId);
}

async function takeMultiSlotMarker(
  host: Host,
  id: string,
  slots: number,
  signal: AbortSignal,
  connectionId?: string,
): Promise<SessionLease | null> {
  return takeSession(host, multiSlotMarkerScript(id, slots), /^MULTI_SLOT_MARKER$/m, signal, connectionId);
}

async function takeLandingMarker(
  host: Host,
  id: string,
  slots: number,
  arrivalOrder: string,
  estimateMs: number | undefined,
  memoryReservationBytes: number,
  signal: AbortSignal,
  connectionId?: string,
): Promise<SessionLease | null> {
  return takeSession(
    host,
    landingMarkerScript(id, slots, arrivalOrder, estimateMs, memoryReservationBytes),
    /^LANDING_MARKER$/m,
    signal,
    connectionId,
  );
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
  pollMs = 5000,

  uploadedPlacement?: { host: Placement; directory: string },
): Promise<RankedHost[]> {
  const probes = await Promise.all(
    hosts.map(async (host) => ({
      host,
      probe: await probeHost(
        host,
        uploadedPlacement?.host.address === host.address ? uploadedPlacement.directory : undefined,
      ),
    })),
  );
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
          pollMs,
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

type HostProvider = () => Host[];
type Placement = Pick<Host, 'name' | 'address' | 'identity'>;

/** Reads once per admission round and keeps the last complete valid configuration through partial rewrites. */
function liveHosts(initial: Host[], file?: string): HostProvider {
  let lastValid = initial;
  let reportedInvalidRewrite = false;
  return () => {
    if (!file) return lastValid;
    try {
      lastValid = readHosts(file);
    } catch (error) {
      if (!reportedInvalidRewrite) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`remote-check: could not reload hosts file ${file}; retaining last valid list: ${detail}`);
        reportedInvalidRewrite = true;
      }
    }
    return lastValid;
  };
}

function placementConfig(hosts: Host[]): string {
  return hosts.map(({ name, slots }) => `${name} ${slots} slots`).join(', ') || 'no configured hosts';
}

/** Chooses a responding upload target without taking an execution slot. */
async function selectPlacement(
  hosts: HostProvider,
  requestedSlots: number,
  estimateMs: number | undefined,
  gate: boolean,
  memoryReservationBytes: number,
  priority: 'landing' | 'critical' | undefined,
  signal: AbortSignal,
  pollMs: number,
  giveUpIfUnanswered: boolean,
  onAnswered?: () => void,
  excluded = new Set<string>(),
): Promise<Host | null> {
  let answered = false;
  const wait = checkWaitRecorder();
  let waiting = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let waitingState = 'no responding hosts';
  let waitingConfiguration = 'no configured hosts';
  const printWaiting = () => {
    console.error(
      `remote-check: waiting for an eligible check host (${waitingState}); configured ${waitingConfiguration}`,
    );
  };
  try {
    while (true) {
      if (signal.aborted) throw new Aborted();
      const current = hosts();
      const available = current.filter(({ name }) => !excluded.has(name));
      const ranked = await rankedHosts(
        available,
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
      );
      if (ranked.length > 0) {
        answered = true;
        onAnswered?.();
        if (gate) {
          const largest = Math.max(...ranked.map(({ gateCapacity }) => gateCapacity));
          if (largest < 1) throw new Error('remote-check: no check host can run the gate while leaving one slot free');
          if (requestedSlots > largest) {
            throw new SlotRequestTooLarge(largest, requestedSlots);
          }
        } else {
          const cap = requestedSlotCap(
            ranked,
            priority === undefined && isShortRun(requestedSlots, estimateMs, gate),
            requestedSlots,
          );
          if (requestedSlots > cap) throw new SlotRequestTooLarge(cap, requestedSlots);
        }
        const shortRun = priority === undefined && isShortRun(requestedSlots, estimateMs, gate);
        const viable = ranked.filter(({ ordinaryCapacity, gateCapacity, capacity }) =>
          gate
            ? gateCapacity >= requestedSlots
            : shortRun
              ? capacity >= requestedSlots
              : ordinaryCapacity >= requestedSlots,
        );
        if (viable.length > 0) {
          const immediatelyStartable = viable.filter(({ freeSlots }) => freeSlots >= requestedSlots);
          const startableOrdinary = immediatelyStartable.filter(({ host }) => !host.fallback);
          if (immediatelyStartable.length > 0)
            return (startableOrdinary.length ? startableOrdinary : immediatelyStartable)[0]!.host;
          const ordinary = viable.filter(({ host }) => !host.fallback);
          return (ordinary.length ? ordinary : viable)[0]!.host;
        }
      } else if (!answered && giveUpIfUnanswered) {
        return null;
      }
      if (!answered && ranked.length === 0 && giveUpIfUnanswered) return null;
      waiting = true;
      wait.begin();
      waitingState = ranked.length
        ? ranked.map(({ host, freeSlots, slotLimit }) => `${host.name} ${freeSlots}/${slotLimit} free`).join(', ')
        : 'no responding hosts';
      waitingConfiguration = placementConfig(current);
      if (!heartbeat) {
        printWaiting();
        heartbeat = setInterval(printWaiting, 60_000);
      }
      wait.record();
      await sleep(pollMs, signal);
    }
  } finally {
    clearInterval(heartbeat);
    if (waiting) wait.stop();
  }
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
  pollMs = 5000,

  connectionId?: string,
  transferTimeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS,
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
    pollMs,
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
      pollMs,

      connectionId,
      transferTimeoutMs,
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
  hostsForRound: HostProvider = () => hosts,
  placement?: Placement,
  connectionId?: string,
  transferTimeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS,
  uploadedDirectory?: string,
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
    ? String(Math.floor(performance.timeOrigin + performance.now()))
    : undefined;
  const multiWaiterId = !gate && priority === undefined && slots > 1 ? randomUUID() : undefined;
  const priorityClass = gate ? 'gate' : (priority ?? (slots > 1 ? 'multi-slot' : 'ordinary'));
  const wait = checkWaitRecorder();
  const skippedHosts = new Map<string, string>();
  const loggedSkipLines = new Set<string>();
  let waitingHosts: RankedHost[] = [];
  let waitingConfiguration = placementConfig(hosts);
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
      `remote-check: every check slot is busy; waiting for a free one (${state}); configured ${waitingConfiguration}; priority ${priorityClass}${reasons.length ? `; skipped ${reasons.join('; ')}` : ''}`,
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
      const currentHosts = hostsForRound();
      waitingConfiguration = placementConfig(currentHosts);
      const placementHost = placement
        ? currentHosts.find(
            ({ name, address, identity }) =>
              name === placement.name && address === placement.address && identity === placement.identity,
          )
        : undefined;
      if (placement && !placementHost) return null;
      const currentSkippedHosts = new Map<string, string>();
      const allRanked = await rankedHosts(
        currentHosts,
        signal,
        slots,
        estimateMs,
        gate,
        slots === 1,
        multiWaiterId,
        currentSkippedHosts,
        loggedSkipLines,
        memoryReservationBytes,
        priority,
        landingWaiterId,
        pollMs,
        placement && uploadedDirectory ? { host: placement, directory: uploadedDirectory } : undefined,
      );
      skippedHosts.clear();
      for (const [hostName, reason] of currentSkippedHosts) skippedHosts.set(hostName, reason);
      const ranked = placement
        ? allRanked.filter(
            ({ host }) =>
              host.name === placement.name &&
              host.address === placement.address &&
              host.identity === placement.identity,
          )
        : allRanked;
      if (placement && ranked.length === 0) return null;
      if (placement) {
        const target = ranked[0]!;
        const shortRun = priority === undefined && isShortRun(slots, estimateMs, gate);
        if (gate ? target.gateCapacity < slots : shortRun ? target.capacity < slots : target.ordinaryCapacity < slots)
          return null;
      }
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
          pollMs,
          connectionId,
          transferTimeoutMs,
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
          marker = (await takeGateMarker(target.host, signal, connectionId)) ?? undefined;
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
            (await takeLandingMarker(
              target.host,
              landingWaiterId,
              slots,
              landingArrivalOrder!,
              estimateMs,
              memoryReservationBytes,
              signal,
            )) ?? undefined;
        } else if (target && !landingMarker) {
          landingMarker =
            (await takeLandingMarker(
              target.host,
              landingWaiterId,
              slots,
              landingArrivalOrder!,
              estimateMs,
              memoryReservationBytes,
              signal,
            )) ?? undefined;
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
          marker = (await takeMultiSlotMarker(target.host, multiWaiterId, slots, signal, connectionId)) ?? undefined;
        } else if (target && !marker) {
          marker = (await takeMultiSlotMarker(target.host, multiWaiterId, slots, signal, connectionId)) ?? undefined;
        }
      }
      announceWait(allRanked);
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

async function stopAndReap(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    // It may have exited between the timeout and the signal.
  }
  if ((await within(1_000, child.exited)) === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may have exited while the signal was being sent.
    }
    await child.exited;
  }
}

async function boundedTextChild(
  child: ReturnType<typeof Bun.spawn>,
  signal: AbortSignal,
  noProgressMs: number,
  host: Host,
  step: string,
  retryable = true,
): Promise<[number, string]> {
  let output = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  let expire!: () => void;
  const timedOut = new Promise<void>((resolve) => {
    expire = resolve;
  });
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      expired = true;
      expire();
    }, noProgressMs);
  };
  const read = async (stream: typeof child.stdout): Promise<void> => {
    if (!(stream instanceof ReadableStream)) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      arm();
    }
    output += decoder.decode();
  };
  arm();
  const completion = Promise.all([finished(child, signal), read(child.stdout), read(child.stderr)]).then(
    ([code]) => code,
  );
  try {
    const result = await Promise.race([completion, timedOut.then(() => null)]);
    if (result === null) {
      await stopAndReap(child);
      await completion;
      if (signal.aborted) throw new Aborted();
      throw new RemoteTransportError(host.name, step, REMOTE_TRANSPORT_FAILURE, retryable);
    }
    return [result, output];
  } finally {
    clearTimeout(timer);
    if (expired && !child.killed) await stopAndReap(child);
  }
}

async function boundedSsh(
  host: Host,
  connectionId: string,
  script: string,
  step: string,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(['ssh', ...sshOptions(host, connectionId), host.address, script], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    child.stderr instanceof ReadableStream ? new Response(child.stderr).text() : Promise.resolve(''),
  ]).then(([stdout, stderr]) => stdout + stderr);
  const code = await within(timeoutMs, child.exited);
  if (code === null) {
    await stopAndReap(child);
    await output;
    throw new RemoteTransportError(host.name, step, REMOTE_TRANSPORT_FAILURE);
  }
  return { code, output: await output };
}

async function closeControlMaster(host: Host, connectionId: string): Promise<void> {
  const child = Bun.spawn(['ssh', '-O', 'exit', ...sshOptions(host, connectionId), host.address], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  if ((await within(1_000, child.exited)) === null) await stopAndReap(child);
}

/** Verifies a selected host's own master before any upload or run work uses it. */
async function probeControl(host: Host, initialId: string, timeoutMs: number): Promise<string> {
  let connectionId = initialId;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await boundedSsh(
        host,
        connectionId,
        `# REMOTE_CHECK_CONTROL_PROBE\nprintf 'REMOTE_CHECK_CONTROL_OK\\n'`,
        'control probe',
        timeoutMs,
      );
      if (result.code === 0 && result.output.includes('REMOTE_CHECK_CONTROL_OK')) return connectionId;
      throw new RemoteTransportError(host.name, 'control probe', result.code || REMOTE_TRANSPORT_FAILURE);
    } catch (error) {
      if (attempt === 1) {
        const code = error instanceof RemoteTransportError ? error.code : REMOTE_TRANSPORT_FAILURE;
        throw new RemoteTransportError(host.name, 'control probe', code, false);
      }
      await closeControlMaster(host, connectionId);
      connectionId = randomUUID().slice(0, 8);
    }
  }
  throw new RemoteTransportError(host.name, 'control probe', REMOTE_TRANSPORT_FAILURE);
}

async function finishedRsync(
  child: ReturnType<typeof Bun.spawn>,
  signal: AbortSignal,
  host: Host,
  step: string,
  noProgressMs: number,
  retryable = true,
): Promise<{ code: number; stderr: string }> {
  const stderrStream = child.stderr;
  let stderr = '';
  let progress = 0;
  let partial = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expire!: () => void;
  const timedOut = new Promise<void>((resolve) => {
    expire = resolve;
  });
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(expire, noProgressMs);
  };
  const observe = (chunk: string) => {
    partial += chunk;
    const lines = partial.split(/[\r\n]/);
    partial = lines.pop() ?? '';
    for (const line of [...lines, partial]) {
      const match = line.match(/^\s*([\d,]+)\s+\d{1,3}%/);
      if (!match) continue;
      const amount = Number(match[1]!.replaceAll(',', ''));
      if (Number.isFinite(amount) && amount > progress) {
        progress = amount;
        arm();
      }
    }
  };
  const forwardStderr = async (): Promise<void> => {
    if (!(stderrStream instanceof ReadableStream)) return;
    const reader = stderrStream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      process.stderr.write(value);
      const decoded = decoder.decode(value, { stream: true });
      stderr += decoded;
      observe(decoded);
    }
    stderr += decoder.decode();
  };
  arm();
  const completion = Promise.all([finished(child, signal), forwardStderr()]).then(([code]) => code);
  try {
    const code = await Promise.race([completion, timedOut.then(() => null)]);
    if (code === null) {
      await stopAndReap(child);
      await completion;
      if (signal.aborted) throw new Aborted();
      throw new RemoteTransportError(host.name, step, REMOTE_TRANSPORT_FAILURE, retryable);
    }
    return { code, stderr };
  } finally {
    clearTimeout(timer);
  }
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

async function baseState(
  host: Host,
  connectionId: string,
  timeoutMs: number,
): Promise<{ base: string | null; zstd: boolean }> {
  const { code, output } = await boundedSsh(host, connectionId, baseStateScript(), 'base lookup', timeoutMs);
  if (code !== 0) throw new RemoteTransportError(host.name, 'base lookup', code);
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
async function copyReturns(
  host: Host,
  directory: string,
  connectionId: string,
  options: RemoteCheck,
  signal: AbortSignal,
): Promise<void> {
  const paths = options.returns ?? [];
  if (paths.length === 0) return;
  for (const path of paths) assertReturnPath(path);
  const probe = Bun.spawn(['ssh', ...sshOptions(host, connectionId), host.address, returnsProbe(directory, paths)], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const transferLimit = transferTimeout(options);
  const [probed, output] = await boundedTextChild(probe, signal, transferLimit, host, 'returns probe', false);
  if (signal.aborted) throw new Aborted();
  if (probed !== 0) throw new RemoteTransportError(host.name, 'returns probe', probed, false);
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
      '--info=progress2',
      '--mkpath',
      '--from0',
      '--files-from=-',
      '-e',
      ['ssh', ...sshOptions(host, connectionId)].map(quote).join(' '),
      `${host.address}:${directory}/`,
      `${resolve(options.workspace)}/`,
    ],
    { stdin: new Blob([`${present.join('\0')}\0`]), stdout: 'inherit', stderr: 'pipe' },
  );
  const { code: synced, stderr } = await finishedRsync(sync, signal, host, 'returns copy', transferLimit, false);
  reportDuration('rsync back', started, host.name);
  if (signal.aborted) throw new Aborted();
  if (synced === 24) reportVanishedFiles('from', host.name, vanishedFileCount(stderr));
  else if (synced !== 0) throw new RemoteTransportError(host.name, 'returns copy', synced, false);
}

type PreparedRun = { host: Host; id: string; directory: string; connectionId: string };

/** Transfers the workspace before admission so upload work never owns execution capacity. */
async function uploadRun(
  host: Host,
  connectionId: string,
  id: string,
  options: RemoteCheck,
  files: string[],
  signal: AbortSignal,
): Promise<PreparedRun> {
  const directory = `${ROOT}/runs/${id}`;
  const transferLimit = transferTimeout(options);
  const base = await baseState(host, connectionId, transferLimit);
  if (signal.aborted) throw new Aborted();
  const useZstd = base.zstd && localRsyncSupportsZstd();
  if (!useZstd) console.error(`remote-check: rsync zstd unavailable on ${host.name}; using default compression`);
  const rsyncStarted = performance.now();
  const compression = useZstd
    ? ['--compress', '--compress-choice=zstd', `--compress-level=${RSYNC_COMPRESS_LEVEL}`]
    : ['--compress'];
  const sync = Bun.spawn(
    [
      'rsync',
      '-lpt',
      ...compression,
      '--stats',
      '--info=progress2',
      '--rsync-path=flock -s /srv/rezics-check/bases/.lock rsync',
      ...(base.base ? ['--checksum', `--copy-dest=${ROOT}/bases/current`] : []),
      '--mkpath',
      '--from0',
      '--files-from=-',
      '-e',
      ['ssh', ...sshOptions(host, connectionId)].map(quote).join(' '),
      `${resolve(options.workspace)}/`,
      `${host.address}:${directory}/`,
    ],
    { stdin: new Blob([`${files.join('\0')}\0`]), stdout: 'inherit', stderr: 'pipe' },
  );
  const { code: synced, stderr } = await finishedRsync(sync, signal, host, 'workspace upload', transferLimit);
  reportDuration('rsync', rsyncStarted, host.name, rsyncBytesSent(stderr));
  if (signal.aborted) throw new Aborted();
  if ([10, 12, 30, 35, 255].includes(synced)) throw new RemoteTransportError(host.name, 'workspace upload', synced);
  if (synced === 24) reportVanishedFiles('to', host.name, vanishedFileCount(stderr));
  else if (synced !== 0) throw new Error(`rsync to ${host.name} failed with exit code ${synced}`);
  return { host, id, directory, connectionId };
}

async function cleanupPreparedRun(prepared: PreparedRun): Promise<void> {
  const cleanup = Bun.spawn(
    [
      'ssh',
      ...sshOptions(prepared.host, prepared.connectionId),
      prepared.host.address,
      cleanupScript(prepared.id, prepared.directory),
    ],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
  );
  const cleaned = await within(60_000, cleanup.exited);
  if (cleaned !== 0) {
    await stopAndReap(cleanup);
    console.error(`remote-check: could not remove ${prepared.directory} on ${prepared.host.name}`);
  }
}

async function recoverRunLifetimeFailure(prepared: PreparedRun, workspace: string): Promise<RunLifetimeFailure | null> {
  const script = `# REMOTE_CHECK_RUN_LIFETIME_STATUS
file=${quote(`${ROOT}/receipts/${prepared.id}/run-lifetime-status.json`)}
[ -r "$file" ] || file=${quote(`${prepared.directory}/run-lifetime-status.json`)}
if [ -r "$file" ]; then printf '%s' ${quote(RUN_LIFETIME_FAILURE_MARKER)}; head -c 4096 "$file"; printf '\\n'; fi`;
  const result = await boundedSsh(prepared.host, prepared.connectionId, script, 'run lifetime receipt', 5_000);
  const receipt = result.code === 0 ? parseRunLifetimeFailure(result.output) : null;
  if (receipt && receipt.host === prepared.host.name && receipt.run === prepared.id) {
    const path = join(workspace, '.temp/remote-check/receipts', prepared.id);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'run-lifetime-status.json'), JSON.stringify(receipt) + '\n');
    // This recovery path is independent of the command's possibly blocked/lost output stream and returns copy.
    console.error(RUN_LIFETIME_FAILURE_MARKER + JSON.stringify(receipt));
    return receipt;
  }
  return null;
}

async function recoverResources(
  prepared: PreparedRun,
  workspace: string,
  code: number,
): Promise<PhysicalResourceReceipt | null> {
  const reader = `import json,sys
from pathlib import Path
path=Path(${JSON.stringify(`${ROOT}/receipts/${prepared.id}/physical-resources.json`)})
if not path.exists(): sys.exit(0)
with path.open() as source: value=json.loads(source.read(500000))
owner=json.loads(Path(${JSON.stringify(`${prepared.directory}/.remote-check-supervisor`)}).read_text())
assert value['boot']==Path('/proc/sys/kernel/random/boot_id').read_text().strip()
assert value['supervisor']=={'pid':owner['pid'],'start':owner['started'],'group':owner['group']}
print(json.dumps(value))`;
  const script = `# REMOTE_CHECK_PHYSICAL_RESOURCES\npython3 -c ${quote(reader)}`;
  try {
    const result = await boundedSsh(prepared.host, prepared.connectionId, script, 'physical resource receipt', 1000);
    if (result.code !== 0 || !result.output.trim()) return null;
    const resources = JSON.parse(result.output);
    const receipt = parseRemotePhysicalRunReceipt({
      schema: 1,
      host: prepared.host.name,
      run: prepared.id,
      exitCode: code,
      lifetimeFailure: null,
      resources,
    });
    if (!receipt) return null;
    const path = join(workspace, '.temp/remote-check/receipts', prepared.id);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'physical-resources.json'), JSON.stringify(resources) + '\n');
    return receipt.resources;
  } catch {
    return null;
  } // Sampling cannot change native exits, fallback, capacity or cleanup.
}

/** Executes only after upload and slot admission; releases the lease before returns and cleanup. */
async function runLeased(
  lease: Lease,
  prepared: PreparedRun,
  options: RemoteCheck,
  slotWaitStarted: number,
  signal: AbortSignal,
): Promise<number> {
  const { host, id, directory, connectionId } = prepared;
  let leaseReleased = false;
  let commandTerminal = false;
  let run: ReturnType<typeof Bun.spawn> | undefined;
  const releaseLease = async () => {
    if (leaseReleased) return;
    leaseReleased = true;
    await lease.release();
  };
  reportDuration('slot wait', slotWaitStarted, host.name);
  try {
    await lease.registerRun?.(id);
    assertExecutionAllowed(options, signal);
    console.error(`remote-check: running on ${host.name}`);
    options.started?.(host.name);
    assertExecutionAllowed(options, signal);
    run = Bun.spawn(
      [
        'ssh',
        ...sshOptions(host, connectionId),
        host.address,
        runScript(
          id,
          directory,
          options.cwd ?? '.',
          options.command,
          host.name,
          options.progressIntervalMs,
          options.gate ? 'gate' : (options.priority ?? ((options.slots ?? 1) > 1 ? 'multi-slot' : 'ordinary')),
          configuredTimeout(
            options.preparationTimeoutMs,
            'REMOTE_CHECK_PREPARATION_TIMEOUT_MS',
            DEFAULT_PREPARATION_TIMEOUT_MS,
          ),
          options.estimateMs,
          options.maxMs,
        ),
      ],
      { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
    );
    const maxMs = effectiveRunLifetimeMs(options.estimateMs, options.maxMs);
    const heartbeatMs = options.livenessIntervalMs ?? DEFAULT_LIVENESS_INTERVAL_MS;
    let heartbeatStopped = false;
    const heartbeat = setInterval(() => {
      if (!heartbeatStopped) {
        Bun.spawn(['ssh', ...sshOptions(host, connectionId), host.address, heartbeatScript(directory)], {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        });
      }
    }, heartbeatMs);
    const commandResult = finished(run, signal);
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineResult = new Promise<null>((resolve) => {
      // The host owns the deadline and receipt. This later controller guard only recovers a broken host monitor.
      deadlineTimer = setTimeout(() => resolve(null), maxMs + 1_000);
    });
    let code: number;
    try {
      const completed = await Promise.race([commandResult.then((value) => value), deadlineResult]);
      if (completed === null) {
        console.error(`remote-check: deadline reached after ${maxMs} ms`);
        const stopped = await boundedSsh(host, connectionId, stopRunScript(id), 'remote command stop', 15_000);
        if (stopped.code !== 0 || !stopped.output.includes('STOPPED'))
          throw new RemoteTransportError(
            host.name,
            'remote command stop',
            stopped.code || REMOTE_TRANSPORT_FAILURE,
            false,
          );
        run.kill('SIGTERM');
        await run.exited;
        commandTerminal = true;
        code = REMOTE_DEADLINE_EXIT;
      } else {
        code = completed;
        commandTerminal = completed !== 255;
      }
    } finally {
      heartbeatStopped = true;
      clearInterval(heartbeat);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
    assertExecutionAllowed(options, signal);
    if (code === 255) {
      const status = await boundedSsh(host, connectionId, statusScript(directory), 'remote command status', 15_000);
      assertExecutionAllowed(options, signal);
      const recorded = status.output.trim();
      const parsed = /^(?:0|[1-9]\d{0,2})$/.test(recorded) ? Number(recorded) : Number.NaN;
      if (
        status.code !== 0 ||
        (!Number.isInteger(parsed) && recorded !== 'NOT_STARTED' && recorded !== 'STARTED') ||
        parsed > 255
      ) {
        throw new RemoteTransportError(host.name, 'remote command', status.code || REMOTE_TRANSPORT_FAILURE, false);
      }
      if (recorded === 'NOT_STARTED') {
        commandTerminal = true;
        throw new RemoteTransportError(host.name, 'remote command startup', 255, true);
      }
      if (recorded === 'STARTED') {
        const stopped = await boundedSsh(host, connectionId, stopRunScript(id), 'remote command stop', 15_000);
        if (stopped.code !== 0 || !stopped.output.includes('STOPPED'))
          throw new RemoteTransportError(
            host.name,
            'remote command stop',
            stopped.code || REMOTE_TRANSPORT_FAILURE,
            false,
          );
        commandTerminal = true;
        throw new RemoteTransportError(host.name, 'remote command', 255, false);
      }
      code = parsed;
      commandTerminal = true;
    }
    assertExecutionAllowed(options, signal);
    await releaseLease();
    let lifetimeFailure: RunLifetimeFailure | null = null;
    if (code === REMOTE_DEADLINE_EXIT) {
      try {
        lifetimeFailure = await recoverRunLifetimeFailure(prepared, options.workspace);
      } catch (error) {
        console.error(
          `remote-check: could not retrieve run lifetime receipt; retained on ${host.name} for ${id}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    const resources = await recoverResources(prepared, options.workspace, code);
    const physical: RemotePhysicalRunReceipt = {
      schema: 1,
      host: host.name,
      run: id,
      exitCode: code,
      lifetimeFailure,
      resources,
    };
    try {
      options.completed?.(physical);
    } catch (error) {
      console.error(
        `remote-check: physical receipt consumer failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    try {
      await copyReturns(host, directory, connectionId, options, signal);
    } catch (error) {
      if (!lifetimeFailure || signal.aborted) throw error;
      console.error(
        `remote-check: returns failed after recorded run-lifetime infrastructure failure: ${error instanceof Error ? error.message : error}`,
      );
    }
    assertExecutionAllowed(options, signal);
    return code;
  } finally {
    if (!commandTerminal && run) {
      try {
        run.kill('SIGTERM');
      } catch {
        // The SSH client may already have exited; releasing the lease runs the host-side orphan stop first.
      }
      await run.exited;
    }
    try {
      await releaseLease();
    } finally {
      await cleanupPreparedRun(prepared);
    }
  }
}

export async function remoteCheck(options: RemoteCheck, signal: AbortSignal): Promise<number> {
  effectiveRunLifetimeMs(options.estimateMs, options.maxMs);
  assertExecutionAllowed(options, signal);
  getPinnedBun(); // Local runtime verification precedes placement/upload/admission, never a held host slot.
  const files = workspaceFiles(options.workspace);
  const result = await withExecutionCancellation(options, signal, (ownedSignal) =>
    runWithTransportRetries(options, options.hosts, files, ownedSignal, false),
  );
  if (result === null) throw new Error('remote-check: no check host answered');
  return result;
}

function assertExecutionAllowed(options: RemoteCheck, signal: AbortSignal): void {
  if (signal.aborted || executionCancellation(options.cancellation)) throw new Aborted();
}

async function withExecutionCancellation<T>(
  options: RemoteCheck,
  parent: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const observed = observeExecutionCancellation(options.cancellation, parent);
  try {
    observed.check();
    return await operation(observed.signal);
  } finally {
    observed.close();
  }
}

/** Retries only failures known to have happened before a remote command produced a result. */
async function runWithTransportRetries(
  options: RemoteCheck,
  initialHosts: Host[],
  files: string[],
  signal: AbortSignal,
  giveUpIfUnanswered: boolean,
  onAnswered?: () => void,
): Promise<number | null> {
  validateMemoryGiB(options.memoryGiB);
  const slots = options.slots ?? 1;
  const memoryReservationBytes =
    options.memoryGiB === undefined ? CHECK_SLOT_MEMORY_BYTES : options.memoryGiB * 2 ** 30;
  const hostsForRound = liveHosts(initialHosts, options.hostsFile);
  const failedHosts = new Set<string>();
  let transportAttempts = 0;
  let lastFailure: RemoteTransportError | undefined;
  let answered = false;
  while (transportAttempts < 3) {
    assertExecutionAllowed(options, signal);
    if (transportAttempts > 0) {
      const delay = (options.retryBackoffMs ?? 100) * 2 ** (transportAttempts - 1);
      console.error(`remote-check: retrying transport failure on ${lastFailure!.host} with code ${lastFailure!.code}`);
      await sleep(delay, signal);
    }
    const hostProvider: HostProvider = () => {
      const current = hostsForRound();
      const preferred = current.filter(({ name }) => !failedHosts.has(name));
      return preferred.length > 0 ? preferred : current;
    };
    const host = await selectPlacement(
      hostProvider,
      slots,
      options.estimateMs,
      options.gate ?? false,
      memoryReservationBytes,
      options.priority,
      signal,
      options.pollMs ?? 5000,
      giveUpIfUnanswered && !answered,
      () => {
        answered = true;
        onAnswered?.();
      },
    );
    if (!host) return null;
    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const prepared: PreparedRun = {
      host,
      id,
      directory: `${ROOT}/runs/${id}`,
      connectionId: randomUUID().slice(0, 8),
    };
    let managedByRun = false;
    try {
      prepared.connectionId = await probeControl(host, prepared.connectionId, controlProbeTimeout(options));
      await uploadRun(host, prepared.connectionId, id, options, files, signal);
      assertExecutionAllowed(options, signal);
      const slotWaitStarted = performance.now();
      const lease = await acquire(
        [host],
        slots,
        options.estimateMs,
        options.pollMs ?? 5000,
        signal,
        false,
        () => {
          answered = true;
          onAnswered?.();
        },
        options.gate ?? false,
        options.waitRepeatMs,
        memoryReservationBytes,
        options.priority,
        hostsForRound,
        host,
        prepared.connectionId,
        transferTimeout(options),
        prepared.directory,
      );
      if (!lease) {
        await cleanupPreparedRun(prepared);
        continue;
      }
      prepared.host = lease.host;
      managedByRun = true;
      return await runLeased(lease, prepared, options, slotWaitStarted, signal);
    } catch (error) {
      if (!managedByRun) await cleanupPreparedRun(prepared);
      assertExecutionAllowed(options, signal);
      if (!(error instanceof RemoteTransportError) || !error.retryable || transportAttempts === 2 || signal.aborted)
        throw error;
      lastFailure = error;
      failedHosts.add(error.host);
      transportAttempts += 1;
    }
  }
  throw lastFailure;
}

/** The first unresponsive-host round may hand local work to its caller; later loss keeps waiting. */
export async function remoteCheckUnlessUnreachable(options: RemoteCheck, signal: AbortSignal): Promise<number | null> {
  effectiveRunLifetimeMs(options.estimateMs, options.maxMs);
  assertExecutionAllowed(options, signal);
  getPinnedBun();
  const files = workspaceFiles(options.workspace);
  return await withExecutionCancellation(options, signal, (ownedSignal) =>
    runWithTransportRetries(options, options.hosts, files, ownedSignal, true, options.answered),
  );
}

/** Tries each available host once without waiting for a slot. */
export async function tryRemoteCheck(options: RemoteCheck, signal: AbortSignal): Promise<TryOnce> {
  return withExecutionCancellation(options, signal, (ownedSignal) => tryRemoteCheckOwned(options, ownedSignal));
}

async function tryRemoteCheckOwned(options: RemoteCheck, signal: AbortSignal): Promise<TryOnce> {
  effectiveRunLifetimeMs(options.estimateMs, options.maxMs);
  assertExecutionAllowed(options, signal);
  getPinnedBun();
  validateMemoryGiB(options.memoryGiB);
  const slots = options.slots ?? 1;
  const memoryReservationBytes =
    options.memoryGiB === undefined ? CHECK_SLOT_MEMORY_BYTES : options.memoryGiB * 2 ** 30;
  const files = workspaceFiles(options.workspace);
  const hostsForRound = liveHosts(options.hosts, options.hostsFile);
  const initial = hostsForRound();
  const ranked = await rankedHosts(
    initial,
    signal,
    slots,
    options.estimateMs,
    options.gate ?? false,
    false,
    undefined,
    new Map(),
    new Set(),
    memoryReservationBytes,
    options.priority,
  );
  if (ranked.length === 0) return { status: 'no-slot' };
  const cap = requestedSlotCap(
    ranked,
    options.priority === undefined && isShortRun(slots, options.estimateMs, options.gate ?? false),
    slots,
  );
  if (slots > cap) throw new SlotRequestTooLarge(cap, slots);
  const candidates = ranked.filter(({ host }) => !host.fallback);
  const host = (candidates.length ? candidates : ranked)[0]!.host;
  const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const prepared: PreparedRun = {
    host,
    id,
    directory: `${ROOT}/runs/${id}`,
    connectionId: randomUUID().slice(0, 8),
  };
  try {
    prepared.connectionId = await probeControl(host, prepared.connectionId, controlProbeTimeout(options));
    await uploadRun(host, prepared.connectionId, id, options, files, signal);
    assertExecutionAllowed(options, signal);
    const current = hostsForRound().find(
      ({ name, address, identity }) => name === host.name && address === host.address && identity === host.identity,
    );
    if (!current) {
      await cleanupPreparedRun(prepared);
      return { status: 'no-slot' };
    }
    const lease = await acquireOnce(
      [current],
      slots,
      options.estimateMs,
      signal,
      options.gate ?? false,
      memoryReservationBytes,
      options.priority,
      options.pollMs ?? 5000,

      prepared.connectionId,
      transferTimeout(options),
    );
    if (!lease) {
      await cleanupPreparedRun(prepared);
      return { status: 'no-slot' };
    }
    prepared.host = lease.host;
    return {
      status: 'ran',
      host: lease.host.name,
      code: await runLeased(lease, prepared, options, performance.now(), signal),
    };
  } catch (error) {
    await cleanupPreparedRun(prepared);
    throw error;
  }
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
  const cancellation = executionCancellationFromEnvironment();
  return {
    hosts: readHosts(hostsFile),
    ...(cancellation === undefined ? {} : { cancellation }),
    completed: cliPhysicalReceipt,
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
    hostsFile,
  };
}

function cliPhysicalReceipt(receipt: RemotePhysicalRunReceipt): void {
  cliReceipt({ receipt });
}

function cliReceipt(value: object): void {
  const fd = process.env.REMOTE_CHECK_RECEIPT_FD;
  const nonce = process.env.REMOTE_CHECK_RECEIPT_NONCE;
  if (fd === undefined && nonce === undefined) return;
  if (fd !== '3' || !nonce) throw new Error('Invalid remote-check receipt channel');
  writeSync(3, JSON.stringify({ nonce, ...value }) + '\n');
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
      cliReceipt({ transportFailure: { schema: 1, message: error.message } });
      process.exitCode = REMOTE_TRANSPORT_FAILURE;
    } else if (error instanceof SlotRequestTooLarge) {
      console.error(error.message);
      process.exitCode = SLOT_REQUEST_TOO_LARGE;
    } else {
      if (!(error instanceof Aborted)) console.error(error instanceof Error ? error.message : error);
      process.exitCode =
        error instanceof Aborted
          ? 128 + (executionCancellation(executionCancellationFromEnvironment())?.signal ?? received ?? 15)
          : 1;
    }
  }
  if (received !== undefined) process.exitCode = 128 + received;
}
