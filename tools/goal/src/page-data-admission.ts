import {
  existsSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  renameSync,
  watch as watchFs,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { inspectProcessSnapshot, type ProcessIdentity } from './process.ts';
import type { Task } from './types.ts';

export type PageDataSeedExecution<T> = { status: 'completed'; value: T } | { status: 'admission-deferred' };
export type PageDataSeedAdmission = {
  isPaused: () => boolean;
  watch: (onChange: () => void) => () => void;
};

export type PageDataCapacityLifecycle = {
  currentAttempt: number;
  taskState: string;
  attemptState?: string;
};
export type PageDataAdmissionStore = {
  tasks: () => readonly Task[];
  /** Missing lifecycle evidence is ambiguous and never proves a waiting source writer. */
  capacityLifecycle?: (taskId: string) => PageDataCapacityLifecycle | undefined;
};

export type PageDataAdmissionObservation = {
  at: string;
  stage: string;
  phase: 'before' | 'after';
  pressurePaused: boolean;
  waitingSourceWriters: string[];
};
export type PageDataPreparationStageTrace = {
  stage: string;
  inputKey: string;
  status: 'reused' | 'completed' | 'deferred' | 'incomplete';
  startedAt?: string;
  completedAt?: string;
  work?: string[];
};
export type PageDataPreparationDeferral = {
  reason: 'live-source-writer' | 'host-pressure' | 'seed-publication-incomplete';
  stage: string;
  journalFrontier: string;
  waitingSourceWriters?: string[];
};
export type PageDataPreparationTrace = {
  version: 1;
  identity: string;
  sourceHead?: string;
  sourceTree?: string;
  status: 'ready' | 'deferred' | 'incomplete';
  stages: PageDataPreparationStageTrace[];
  admission: PageDataAdmissionObservation[];
  frontier?: string;
  deferral?: PageDataPreparationDeferral;
  seedJournal?: { path: string; state: 'absent' | 'retained' | 'complete' };
};

export type PageDataPreparationStageResult =
  | { status: 'completed'; work?: string[] }
  | { status: 'admission-deferred'; reason?: 'host-pressure'; work?: string[] }
  | { status: 'incomplete'; work?: string[] };
export type PageDataPreparationStage = {
  id: string;
  inputKey: string;
  /** Validate output state as well as the source identity before reusing a completed stage. */
  isComplete?: () => boolean;
  run: () => Promise<PageDataPreparationStageResult>;
};

type AdmissionObservation = { pressurePaused: boolean; waitingSourceWriters: string[] };
type PreparationState = {
  version: 1;
  identity: string;
  completed: Record<string, string>;
  frontier?: string;
  deferral?: PageDataPreparationDeferral;
};
type PreparationOptions = {
  file: string;
  identity: string;
  sourceHead?: string;
  sourceTree?: string;
  admission: {
    observe: () => AdmissionObservation;
  };
  now?: () => Date;
};

const MAX_CAPACITY_TICKETS_PER_LANE = 256;
const MAX_CAPACITY_TICKET_BYTES = 8192;
const sourceTaskStates = new Set(['ready', 'held', 'running', 'landing', 'stopped', 'integrated', 'merged']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateProcessIdentity(value: unknown): ProcessIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) < 1 ||
    typeof value.start !== 'string' ||
    !/^\d+$/.test(value.start) ||
    typeof value.boot !== 'string' ||
    value.boot.length === 0 ||
    value.boot.length > 128 ||
    !Number.isSafeInteger(value.group) ||
    Number(value.group) < 1
  )
    return undefined;
  return { pid: Number(value.pid), start: value.start, boot: value.boot, group: Number(value.group) };
}

function exactCapacityTicketName(name: string, identity: ProcessIdentity, taskId: string): boolean {
  const suffix = `-${taskId}`;
  if (!name.endsWith(suffix)) return false;
  const owner = name.slice(0, -suffix.length);
  return new RegExp(`^\\d{15}\\.\\d{8}-${identity.pid}$`, 'u').test(owner);
}

function ticketIsCurrentSourceWriter(
  value: unknown,
  name: string,
  tasks: ReadonlyMap<string, Task>,
  store: PageDataAdmissionStore,
): string | undefined {
  if (!isRecord(value)) return undefined;
  const identity = validateProcessIdentity(value);
  const taskId = typeof value.taskId === 'string' ? value.taskId : '';
  const attempt = Number.isSafeInteger(value.attempt) ? Number(value.attempt) : -1;
  const operation = value.operation;
  if (
    !identity ||
    taskId.length === 0 ||
    attempt < 1 ||
    (operation !== 'start' && operation !== 'resume') ||
    !exactCapacityTicketName(name, identity, taskId)
  )
    return undefined;

  let snapshot: ReturnType<typeof inspectProcessSnapshot>;
  try {
    snapshot = inspectProcessSnapshot(identity.pid, '/proc');
  } catch {
    return undefined;
  }
  if (
    !snapshot ||
    snapshot.dead ||
    snapshot.identity.start !== identity.start ||
    snapshot.identity.boot !== identity.boot ||
    snapshot.identity.group !== identity.group
  )
    return undefined;

  const task = tasks.get(taskId);
  const lifecycle = store.capacityLifecycle?.(taskId);
  if (
    !task ||
    task.brief.kind === 'verification' ||
    task.brief.paths.length === 0 ||
    !lifecycle ||
    task.currentAttempt !== lifecycle.currentAttempt ||
    task.state !== lifecycle.taskState
  )
    return undefined;

  if (operation === 'resume') {
    return attempt === lifecycle.currentAttempt &&
      lifecycle.taskState === 'running' &&
      lifecycle.attemptState === 'waiting'
      ? taskId
      : undefined;
  }

  const currentPending =
    attempt === lifecycle.currentAttempt &&
    lifecycle.attemptState === 'pending' &&
    sourceTaskStates.has(lifecycle.taskState);
  const nextStart =
    attempt === lifecycle.currentAttempt + 1 && sourceTaskStates.has(lifecycle.taskState);
  return currentPending || nextStart ? taskId : undefined;
}

function readLiveUnadmittedSourceWriters(stateDirectory: string, store?: PageDataAdmissionStore): string[] {
  if (!store?.capacityLifecycle) return [];
  const taskMap = new Map(store.tasks().map((task) => [task.id, task]));
  for (const lane of ['capacity-queue', 'urgent-capacity-queue']) {
    const queue = join(stateDirectory, lane);
    let names: string[];
    let directory: ReturnType<typeof opendirSync>;
    try {
      directory = opendirSync(queue);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    names = [];
    try {
      while (names.length < MAX_CAPACITY_TICKETS_PER_LANE) {
        const entry = directory.readSync();
        if (!entry) break;
        names.push(entry.name);
      }
    } finally {
      directory.closeSync();
    }
    for (const name of names) {
      if (name.endsWith('.admitted')) continue;
      const path = join(queue, name);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.size > MAX_CAPACITY_TICKET_BYTES) continue;
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        const taskId = ticketIsCurrentSourceWriter(parsed, name, taskMap, store);
        if (taskId) return [taskId];
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || error instanceof SyntaxError) continue;
        throw error;
      }
    }
  }
  return [];
}

/** Read the existing launch-capacity brake and explicit live writer tickets; this module never writes either. */
export function pageDataAdmission(stateDirectory: string, store?: PageDataAdmissionStore) {
  const pressureFile = join(stateDirectory, 'capacity-pressure.json');
  const isPaused = () => {
    try {
      const stat = lstatSync(pressureFile);
      if (!stat.isFile() || stat.size > MAX_CAPACITY_TICKET_BYTES) return false;
      const value: unknown = JSON.parse(readFileSync(pressureFile, 'utf8'));
      return isRecord(value) && value.paused === true;
    } catch {
      return false;
    }
  };
  return {
    isPaused,
    watch: (onChange: () => void) => {
      const watcher = watchFs(stateDirectory, { persistent: false }, (_event, filename) => {
        if (!filename || filename.toString() === 'capacity-pressure.json') onChange();
      });
      return () => watcher.close();
    },
    observe: (): AdmissionObservation => ({
      pressurePaused: isPaused(),
      waitingSourceWriters: readLiveUnadmittedSourceWriters(stateDirectory, store),
    }),
  };
}

/** Compatibility name retained for the existing cross-media seed boundary. */
export function pageDataSeedAdmission(stateDirectory: string, store?: PageDataAdmissionStore) {
  return pageDataAdmission(stateDirectory, store);
}

/** Keep the existing seed-only cancellation boundary so a live pressure update yields its owned process group. */
export async function runPageDataSeedWithAdmission<T>(
  admission: PageDataSeedAdmission,
  run: (signal: AbortSignal) => Promise<PageDataSeedExecution<T>>,
): Promise<PageDataSeedExecution<T>> {
  const controller = new AbortController();
  const check = () => {
    if (!controller.signal.aborted && admission.isPaused()) controller.abort();
  };
  const unwatch = admission.watch(check);
  try {
    check();
    if (controller.signal.aborted) return { status: 'admission-deferred' };
    return await run(controller.signal);
  } finally {
    unwatch();
  }
}

function readPreparationState(file: string, identity: string): PreparationState {
  if (!existsSync(file)) return { version: 1, identity, completed: {} };
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > 256 * 1024) throw new Error(`Page-data preparation journal is invalid: ${file}`);
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.identity !== 'string' ||
    !isRecord(parsed.completed) ||
    Object.entries(parsed.completed).some(([key, value]) => key.length === 0 || typeof value !== 'string') ||
    (parsed.frontier !== undefined && typeof parsed.frontier !== 'string') ||
    (parsed.deferral !== undefined &&
      (!isRecord(parsed.deferral) ||
        typeof parsed.deferral.reason !== 'string' ||
        typeof parsed.deferral.stage !== 'string' ||
        typeof parsed.deferral.journalFrontier !== 'string'))
  )
    throw new Error(`Page-data preparation journal is invalid: ${file}`);
  if (parsed.identity !== identity) return { version: 1, identity, completed: {} };
  return parsed as unknown as PreparationState;
}

function writePreparationState(file: string, state: PreparationState): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

/** Run each idempotent boundary once per input identity and checkpoint only successful stage completion. */
export function pageDataPreparation(options: PreparationOptions) {
  const now = options.now ?? (() => new Date());
  const state = readPreparationState(options.file, options.identity);
  const trace: PageDataPreparationTrace = {
    version: 1,
    identity: options.identity,
    ...(options.sourceHead ? { sourceHead: options.sourceHead } : {}),
    ...(options.sourceTree ? { sourceTree: options.sourceTree } : {}),
    status: 'ready',
    stages: [],
    admission: [],
    ...(state.frontier ? { frontier: state.frontier } : {}),
  };

  const persist = () => writePreparationState(options.file, state);
  const recordObservation = (stage: string, phase: 'before' | 'after') => {
    const observed = options.admission.observe();
    const item: PageDataAdmissionObservation = {
      at: now().toISOString(),
      stage,
      phase,
      pressurePaused: observed.pressurePaused,
      waitingSourceWriters: observed.waitingSourceWriters,
    };
    trace.admission.push(item);
    return item;
  };
  const run = async (stages: readonly PageDataPreparationStage[]) => {
    for (const stage of stages) {
      if (state.completed[stage.id] === stage.inputKey && (stage.isComplete?.() ?? true)) {
        trace.stages.push({ stage: stage.id, inputKey: stage.inputKey, status: 'reused' });
        continue;
      }

      const before = recordObservation(stage.id, 'before');
      if (before.waitingSourceWriters.length > 0) {
        recordObservation(stage.id, 'after');
        const deferral: PageDataPreparationDeferral = {
          reason: 'live-source-writer',
          stage: stage.id,
          journalFrontier: stage.id,
          waitingSourceWriters: before.waitingSourceWriters,
        };
        state.frontier = stage.id;
        state.deferral = deferral;
        trace.stages.push({ stage: stage.id, inputKey: stage.inputKey, status: 'deferred' });
        trace.status = 'deferred';
        trace.frontier = stage.id;
        trace.deferral = deferral;
        persist();
        return 'deferred' as const;
      }

      const startedAt = now().toISOString();
      state.frontier = stage.id;
      delete state.deferral;
      persist();
      const result = await stage.run();
      const after = recordObservation(stage.id, 'after');
      if (result.status === 'admission-deferred') {
        const deferral: PageDataPreparationDeferral = {
          reason: result.reason ?? 'host-pressure',
          stage: stage.id,
          journalFrontier: stage.id,
          ...(after.waitingSourceWriters.length ? { waitingSourceWriters: after.waitingSourceWriters } : {}),
        };
        state.frontier = stage.id;
        state.deferral = deferral;
        trace.stages.push({
          stage: stage.id,
          inputKey: stage.inputKey,
          status: 'deferred',
          startedAt,
          completedAt: now().toISOString(),
          ...(result.work?.length ? { work: result.work } : {}),
        });
        trace.status = 'deferred';
        trace.frontier = stage.id;
        trace.deferral = deferral;
        persist();
        return 'deferred' as const;
      }
      if (result.status === 'incomplete') {
        const deferral: PageDataPreparationDeferral = {
          reason: 'seed-publication-incomplete',
          stage: stage.id,
          journalFrontier: stage.id,
        };
        state.frontier = stage.id;
        state.deferral = deferral;
        trace.stages.push({
          stage: stage.id,
          inputKey: stage.inputKey,
          status: 'incomplete',
          startedAt,
          completedAt: now().toISOString(),
          ...(result.work?.length ? { work: result.work } : {}),
        });
        trace.status = 'incomplete';
        trace.frontier = stage.id;
        trace.deferral = deferral;
        persist();
        return 'incomplete' as const;
      }

      state.completed[stage.id] = stage.inputKey;
      delete state.frontier;
      delete state.deferral;
      trace.stages.push({
        stage: stage.id,
        inputKey: stage.inputKey,
        status: 'completed',
        startedAt,
        completedAt: now().toISOString(),
        ...(result.work?.length ? { work: result.work } : {}),
      });
      persist();
    }
    trace.status = 'ready';
    delete state.frontier;
    delete state.deferral;
    persist();
    delete trace.frontier;
    delete trace.deferral;
    return 'ready' as const;
  };

  return { run, trace };
}
