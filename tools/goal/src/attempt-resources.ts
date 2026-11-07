import type { Database } from 'bun:sqlite';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { defaultPolicy } from './policy.ts';
import { inspectProcessIdentity, stopProcessesUnder } from './process.ts';
import type { TaskState } from './types.ts';

const execFileAsync = promisify(execFile);
const PAGE_BYTES = 4096;
const HOUR_MS = 3_600_000;
const REAP_LOG = 'reaped-resources.jsonl';
const LIST_FORMAT =
  '{{.ID}}\t{{.Names}}\t{{.Label "rezics.kernel.derived.pid"}}\t{{.Label "rezics.kernel.derived.start"}}\t{{.Label "rezics.kernel.derived.boot"}}\t{{.Label "rezics.worker.attempt"}}\t{{.Size}}';
const VOLUME_FORMAT =
  '{{.Name}}\t{{index .Labels "rezics.kernel.derived.pid"}}\t{{index .Labels "rezics.kernel.derived.start"}}\t{{index .Labels "rezics.kernel.derived.boot"}}\t{{.Mountpoint}}';

/** Shared stacks the controller never removes, even when a task id appears in a longer name. */
export const SHARED_KEEP_PREFIXES = [
  'rezics-dev-',
  'rezics-doctor-',
  'rezics-kernel-dev',
  'rezics-pagecheck-',
] as const;

export const TERMINAL_TASK_STATES: readonly TaskState[] = ['cancelled', 'stopped', 'integrated', 'merged'];

export type InventoryContainer = {
  id: string;
  name: string;
  pidLabel: string;
  startLabel: string;
  bootLabel: string;
  attemptLabel: string;
  sizeBytes: number;
};

export type InventoryVolume = {
  name: string;
  pidLabel: string;
  startLabel: string;
  bootLabel: string;
  sizeBytes: number;
};

export type LiveOwner = { start: string; boot: string };
export type ReapKind = 'process' | 'container' | 'volume';
export type ReapRecord = {
  at: number;
  owner: string;
  kind: ReapKind;
  name: string;
  id: string;
  sizeBytes: number;
};
export type ReapCounts = { processes: number; containers: number; volumes: number; bytes: number };

export type DockerInvoke = (args: string[]) => Promise<{ ok: boolean; stdout: string }>;
export type LiveOwnerLookup = (pid: string) => LiveOwner | null;
export type WorktreeProcesses = {
  list(directory: string): { pid: number; sizeBytes: number }[];
  stop(directory: string): Promise<number>;
};

export type ReapResourcesOptions = {
  owner: string;
  taskIds: readonly string[];
  stateDirectory: string;
  worktree?: string;
  reapProcesses?: boolean;
  reapDocker?: boolean;
  now?: number;
  graceMs?: number;
  procRoot?: string;
  containers?: { commandTimeoutMs: number; keep: string[] };
  docker?: DockerInvoke;
  ownerLive?: LiveOwnerLookup;
  processes?: WorktreeProcesses;
  log?: (line: string) => void;
};

export type TerminalTaskOwner = { id: string; state: string; worktree: string; workspace?: unknown };

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1_000,
  kib: 1024,
  mb: 1_000_000,
  mib: 1024 ** 2,
  gb: 1_000_000_000,
  gib: 1024 ** 3,
  tb: 1_000_000_000_000,
  tib: 1024 ** 4,
};

export function emptyReapCounts(): ReapCounts {
  return { processes: 0, containers: 0, volumes: 0, bytes: 0 };
}

export function keepPrefixes(policyKeep: readonly string[] = []): string[] {
  return [...new Set<string>([...SHARED_KEEP_PREFIXES, ...policyKeep])];
}

export function isKeptName(name: string, keep: readonly string[]): boolean {
  return keep.some((prefix) => name.startsWith(prefix));
}

export function nameOwnsTask(name: string, taskId: string): boolean {
  return (
    name === `rezics-walk-${taskId}` ||
    name.startsWith(`rezics-walk-${taskId}-`) ||
    name === `rezics-${taskId}` ||
    name.startsWith(`rezics-${taskId}-`)
  );
}

export function attemptOwnsTask(attemptLabel: string, taskId: string): boolean {
  return attemptLabel === taskId || attemptLabel.startsWith(`${taskId}/`);
}

/** A labelled throwaway database is abandoned when its pid is gone or the live pid has a different start or boot. */
export function derivedOwnerGone(
  labels: { pidLabel: string; startLabel: string; bootLabel: string },
  live: LiveOwner | null,
): boolean {
  if (!labels.pidLabel) return false;
  if (!live) return true;
  if (labels.startLabel && labels.startLabel !== live.start) return true;
  if (labels.bootLabel && labels.bootLabel !== live.boot) return true;
  return false;
}

export function resourceOwner(
  row: { name: string; pidLabel: string },
  taskIds: readonly string[],
  fallback: string,
): string {
  const matched = taskIds.find((taskId) => nameOwnsTask(row.name, taskId));
  if (matched) return matched;
  if (row.pidLabel) return `derived:${row.pidLabel}`;
  return fallback;
}

export function selectOwnedContainers(
  rows: readonly InventoryContainer[],
  taskIds: readonly string[],
  keep: readonly string[],
  ownerLive: LiveOwnerLookup,
): InventoryContainer[] {
  const ids = new Set(taskIds);
  return rows.filter((row) => {
    if (!row.id || !row.name || isKeptName(row.name, keep)) return false;
    if ([...ids].some((taskId) => nameOwnsTask(row.name, taskId) || attemptOwnsTask(row.attemptLabel, taskId)))
      return true;
    return derivedOwnerGone(row, ownerLive(row.pidLabel));
  });
}

export function selectOwnedVolumes(
  rows: readonly InventoryVolume[],
  taskIds: readonly string[],
  keep: readonly string[],
  ownerLive: LiveOwnerLookup,
): InventoryVolume[] {
  const ids = new Set(taskIds);
  return rows.filter((row) => {
    if (!row.name || isKeptName(row.name, keep)) return false;
    if ([...ids].some((taskId) => nameOwnsTask(row.name, taskId))) return true;
    return derivedOwnerGone(row, ownerLive(row.pidLabel));
  });
}

export function parseDockerSize(text: string): number {
  const token = text.trim().split(/\s+/)[0] ?? '';
  const match = /^([\d.]+)([kKmMgGtT]i?[bB]|[bB])?$/.exec(token);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * (SIZE_UNITS[(match[2] ?? 'B').toLowerCase()] ?? 1));
}

export function parseContainerList(stdout: string): InventoryContainer[] {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [id = '', names = '', pidLabel = '', startLabel = '', bootLabel = '', attemptLabel = '', ...sizeParts] =
        line.split('\t');
      return {
        id,
        name: names.split(',')[0] ?? '',
        pidLabel,
        startLabel,
        bootLabel,
        attemptLabel,
        sizeBytes: parseDockerSize(sizeParts.join('\t')),
      };
    })
    .filter((row) => row.id && row.name);
}

export function parseVolumeList(stdout: string): InventoryVolume[] {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name = '', pidLabel = '', startLabel = '', bootLabel = '', , size = ''] = line.split('\t');
      return { name, pidLabel, startLabel, bootLabel, sizeBytes: parseDockerSize(size) };
    })
    .filter((row) => row.name);
}

export function parseVolumeNames(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function processRssBytes(statm: string): number {
  const resident = Number(statm.trim().split(/\s+/)[1] ?? '');
  return Number.isSafeInteger(resident) && resident >= 0 ? resident * PAGE_BYTES : 0;
}

function procOwnerLive(procRoot: string): LiveOwnerLookup {
  return (pid) => {
    const value = Number(pid);
    if (!Number.isSafeInteger(value) || value < 1) return null;
    const identity = inspectProcessIdentity(value, procRoot);
    return identity ? { start: identity.start, boot: identity.boot } : null;
  };
}

function listWorktreeProcesses(directory: string, procRoot: string): { pid: number; sizeBytes: number }[] {
  const root = resolve(directory);
  const spared = new Set<number>();
  for (let pid = process.pid; pid > 1 && !spared.has(pid);) {
    spared.add(pid);
    try {
      pid = Number(readFileSync(`${procRoot}/${pid}/stat`, 'utf8').split(') ').pop()!.split(' ')[1]);
    } catch {
      break;
    }
  }
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return [];
  }
  const found: { pid: number; sizeBytes: number }[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name) || spared.has(Number(name))) continue;
    let cwd: string;
    try {
      cwd = readlinkSync(`${procRoot}/${name}/cwd`).replace(/ \(deleted\)$/, '');
    } catch {
      continue;
    }
    if (cwd !== root && !cwd.startsWith(`${root}/`)) continue;
    const identity = inspectProcessIdentity(Number(name), procRoot);
    if (!identity) continue;
    let sizeBytes = 0;
    try {
      sizeBytes = processRssBytes(readFileSync(`${procRoot}/${name}/statm`, 'utf8'));
    } catch {
      /* Size is diagnostic; a process without statm is still reaped. */
    }
    found.push({ pid: identity.pid, sizeBytes });
  }
  return found;
}

function defaultProcesses(
  procRoot: string,
  graceMs: number,
  processPolicy: typeof defaultPolicy.process,
): WorktreeProcesses {
  return {
    list: (directory) => listWorktreeProcesses(directory, procRoot),
    stop: (directory) => stopProcessesUnder(directory, graceMs, procRoot, processPolicy),
  };
}

async function defaultDocker(args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('docker', args, { encoding: 'utf8', timeout: timeoutMs });
    return { ok: true, stdout };
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return { ok: false, stdout: typeof stdout === 'string' ? stdout : '' };
  }
}

function confirmedNames(stdout: string, names: readonly string[]): string[] {
  const confirmations = new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return names.filter((name) => confirmations.has(name));
}

function logReap(record: ReapRecord, log: (line: string) => void): void {
  log(`reap ${record.kind} ${record.name} owner=${record.owner} size=${record.sizeBytes}`);
}

export function appendReapRecords(stateDirectory: string, records: readonly ReapRecord[]): void {
  if (!records.length) return;
  appendFileSync(join(stateDirectory, REAP_LOG), records.map((record) => `${JSON.stringify(record)}\n`).join(''));
}

export function readReapRecords(stateDirectory: string): ReapRecord[] {
  const path = join(stateDirectory, REAP_LOG);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const value = JSON.parse(line) as ReapRecord;
      return value && typeof value === 'object' ? [value] : [];
    });
}

export function reapedCountsLastHour(stateDirectory: string, now = Date.now()): ReapCounts {
  const counts = emptyReapCounts();
  for (const record of readReapRecords(stateDirectory)) {
    if (now - record.at > HOUR_MS) continue;
    counts.bytes += record.sizeBytes;
    if (record.kind === 'process') counts.processes += 1;
    else if (record.kind === 'container') counts.containers += 1;
    else counts.volumes += 1;
  }
  return counts;
}

function countsFrom(records: readonly ReapRecord[]): ReapCounts {
  const counts = emptyReapCounts();
  for (const record of records) {
    counts.bytes += record.sizeBytes;
    if (record.kind === 'process') counts.processes += 1;
    else if (record.kind === 'container') counts.containers += 1;
    else counts.volumes += 1;
  }
  return counts;
}

export function readTerminalTaskOwners(db: Database): TerminalTaskOwner[] {
  const marks = TERMINAL_TASK_STATES.map(() => '?').join(', ');
  return db
    .query(
      `SELECT json_extract(body, '$.id') AS id, json_extract(body, '$.state') AS state, json_extract(body, '$.worktree') AS worktree, json_extract(body, '$.workspace') AS workspace FROM worker_tasks WHERE json_extract(body, '$.state') IN (${marks})`,
    )
    .all(...TERMINAL_TASK_STATES)
    .map((row) => row as TerminalTaskOwner)
    .filter((row) => row.id && row.worktree);
}

async function listInventory(
  docker: DockerInvoke,
): Promise<{ containers: InventoryContainer[]; volumes: InventoryVolume[] }> {
  const listed = await docker(['ps', '-a', '-s', '--format', LIST_FORMAT]);
  const containers = listed.ok || listed.stdout ? parseContainerList(listed.stdout) : [];
  const volumeNames = await docker(['volume', 'ls', '-q']);
  const names = volumeNames.ok || volumeNames.stdout ? parseVolumeNames(volumeNames.stdout) : [];
  if (!names.length) return { containers, volumes: [] };
  const inspected = await docker(['volume', 'inspect', '--format', VOLUME_FORMAT, ...names]);
  return { containers, volumes: inspected.ok || inspected.stdout ? parseVolumeList(inspected.stdout) : [] };
}

async function removeSelected(
  docker: DockerInvoke,
  containers: readonly InventoryContainer[],
  volumes: readonly InventoryVolume[],
): Promise<{ containerIds: string[]; containerNames: string[]; volumeNames: string[] }> {
  const containerIds: string[] = [];
  const containerNames: string[] = [];
  if (containers.length) {
    const ids = containers.map((row) => row.id);
    const removed = await docker(['rm', '-f', '-v', ...ids]);
    const confirmed = new Set(
      removed.ok
        ? ids
        : confirmedNames(
            removed.stdout,
            containers.flatMap((row) => [row.id, row.name]),
          ),
    );
    for (const row of containers) {
      if (!confirmed.has(row.id) && !confirmed.has(row.name)) continue;
      containerIds.push(row.id);
      containerNames.push(row.name);
    }
  }
  const attached = new Set(containerNames);
  const leftover = volumes.filter((row) => !attached.has(row.name)).map((row) => row.name);
  const volumeNames = volumes.filter((row) => attached.has(row.name)).map((row) => row.name);
  if (leftover.length) {
    const removed = await docker(['volume', 'rm', '-f', ...leftover]);
    const confirmed = new Set(removed.ok ? leftover : confirmedNames(removed.stdout, leftover));
    volumeNames.push(...leftover.filter((name) => confirmed.has(name)));
  }
  return { containerIds, containerNames, volumeNames };
}

/**
 * Reap processes whose cwd is in the worktree, and containers and volumes named or labelled for the given tasks,
 * plus throwaway Kernel databases whose owner pid is gone. Shared keep prefixes are never selected.
 */
export async function reapOwnedResources(options: ReapResourcesOptions): Promise<ReapCounts> {
  const now = options.now ?? Date.now();
  const policy = options.containers ?? defaultPolicy.containers;
  const keep = keepPrefixes(policy.keep);
  const log = options.log ?? ((line) => console.log(line));
  const docker = options.docker ?? ((args) => defaultDocker(args, policy.commandTimeoutMs));
  const procRoot = options.procRoot ?? '/proc';
  const ownerLive = options.ownerLive ?? procOwnerLive(procRoot);
  const processes = options.processes ?? defaultProcesses(procRoot, options.graceMs ?? 1000, defaultPolicy.process);
  const records: ReapRecord[] = [];
  if (options.reapDocker !== false) {
    try {
      const inventory = await listInventory(docker);
      const containers = selectOwnedContainers(inventory.containers, options.taskIds, keep, ownerLive);
      const volumes = selectOwnedVolumes(inventory.volumes, options.taskIds, keep, ownerLive);
      const removed = await removeSelected(docker, containers, volumes);
      const removedContainerIds = new Set(removed.containerIds);
      const removedVolumeNames = new Set(removed.volumeNames);
      for (const row of containers) {
        if (!removedContainerIds.has(row.id)) continue;
        const record: ReapRecord = {
          at: now,
          owner: resourceOwner(row, options.taskIds, options.owner),
          kind: 'container',
          name: row.name,
          id: row.id,
          sizeBytes: row.sizeBytes,
        };
        records.push(record);
        logReap(record, log);
      }
      for (const row of volumes) {
        if (!removedVolumeNames.has(row.name)) continue;
        const record: ReapRecord = {
          at: now,
          owner: resourceOwner(row, options.taskIds, options.owner),
          kind: 'volume',
          name: row.name,
          id: row.name,
          sizeBytes: row.sizeBytes,
        };
        records.push(record);
        logReap(record, log);
      }
    } catch (error) {
      // Docker is diagnostic here: settlement and stop must still finish, and the five-minute sweep retries.
      log(`Could not reap containers for ${options.owner}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (options.reapProcesses !== false && options.worktree) {
    const listed = processes.list(options.worktree);
    await processes.stop(options.worktree);
    for (const processRow of listed) {
      const record: ReapRecord = {
        at: now,
        owner: options.owner,
        kind: 'process',
        name: String(processRow.pid),
        id: String(processRow.pid),
        sizeBytes: processRow.sizeBytes,
      };
      records.push(record);
      logReap(record, log);
    }
  }
  appendReapRecords(options.stateDirectory, records);
  return countsFrom(records);
}

/** Attempt-end cleanup: this task's walk/task-named resources, dead throwaway databases, and worktree processes. */
export async function reapAttemptResources(
  options: Omit<ReapResourcesOptions, 'taskIds' | 'owner'> & { taskId: string; owner?: string },
): Promise<ReapCounts> {
  const { taskId, ...rest } = options;
  return reapOwnedResources({ ...rest, owner: rest.owner ?? taskId, taskIds: [taskId] });
}

/** Five-minute sweep: terminal tasks' resources, and throwaway databases whose owner pid is gone. */
export async function sweepAbandonedResources(
  options: Omit<ReapResourcesOptions, 'taskIds' | 'owner' | 'worktree'> & { tasks: readonly TerminalTaskOwner[] },
): Promise<ReapCounts> {
  const terminal = options.tasks.filter((task) => (TERMINAL_TASK_STATES as readonly string[]).includes(task.state));
  const totals = emptyReapCounts();
  const add = (part: ReapCounts) => {
    totals.processes += part.processes;
    totals.containers += part.containers;
    totals.volumes += part.volumes;
    totals.bytes += part.bytes;
  };
  add(
    await reapOwnedResources({
      ...options,
      owner: 'sweep',
      taskIds: terminal.map((task) => task.id),
      reapProcesses: false,
    }),
  );
  for (const task of terminal) {
    if (task.workspace || !task.worktree) continue;
    add(
      await reapOwnedResources({
        ...options,
        owner: task.id,
        taskIds: [],
        worktree: task.worktree,
        reapProcesses: true,
        reapDocker: false,
      }),
    );
  }
  return totals;
}
