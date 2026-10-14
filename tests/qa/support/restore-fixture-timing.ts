import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export type RestoreFixturePhaseStatus = 'start' | 'end' | 'failure';

export type RestoreFixturePhaseRecord = {
  schema: 'restore-fixture-phase-v1';
  fixtureId: string;
  ordinal: number;
  phase: string;
  status: RestoreFixturePhaseStatus;
  elapsedMs: number;
  durationMs?: number;
  operationOrdinal?: number;
};

export type RestoreFixturePhaseHandle = {
  readonly fixtureId: string;
  readonly ordinal: number;
  readonly phase: string;
  readonly operationOrdinal?: number;
  readonly startedAt: number;
  finished: boolean;
};

type RestoreFixtureTimingOptions = {
  artifactDirectory?: string;
  fixtureId?: string;
  now?: () => number;
  append?: (record: RestoreFixturePhaseRecord) => void;
};

const phasePattern = /^[a-z0-9._-]{1,96}$/;

/** Appends bounded lifecycle records immediately so a killed fixture keeps its last start. */
export function createRestoreFixtureTiming(options: RestoreFixtureTimingOptions = {}) {
  const fixtureId = options.fixtureId ?? randomUUID();
  const now = options.now ?? (() => performance.now());
  const origin = now();
  const artifactDirectory = options.artifactDirectory ?? process.env.REZICS_QA_ARTIFACT_DIR;
  const filePath = artifactDirectory
    ? join(artifactDirectory, `restore-fixture-timing-${fixtureId}.jsonl`)
    : undefined;
  let ordinal = 0;
  let lastElapsedMs = 0;
  const completedDurations = new Map<string, number>();

  if (filePath) mkdirSync(artifactDirectory!, { recursive: true });

  const append =
    options.append ??
    ((record: RestoreFixturePhaseRecord) => {
      if (filePath) appendFileSync(filePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    });

  const elapsed = (at: number) => {
    const elapsedMs = Math.max(lastElapsedMs, Math.max(0, at - origin));
    lastElapsedMs = elapsedMs;
    return elapsedMs;
  };

  const record = (
    handle: RestoreFixturePhaseHandle,
    status: RestoreFixturePhaseStatus,
    at: number,
  ) => {
    const durationMs = Math.max(0, at - handle.startedAt);
    if (status !== 'start') {
      completedDurations.set(handle.phase, (completedDurations.get(handle.phase) ?? 0) + durationMs);
    }
    append({
      schema: 'restore-fixture-phase-v1',
      fixtureId,
      ordinal: handle.ordinal,
      phase: handle.phase,
      status,
      elapsedMs: elapsed(at),
      ...(status === 'start' ? {} : { durationMs }),
      ...(handle.operationOrdinal === undefined
        ? {}
        : { operationOrdinal: handle.operationOrdinal }),
    });
  };

  const begin = (phase: string, operationOrdinal?: number): RestoreFixturePhaseHandle => {
    if (!phasePattern.test(phase)) throw new Error('invalid restore fixture phase label');
    if (
      operationOrdinal !== undefined &&
      (!Number.isSafeInteger(operationOrdinal) || operationOrdinal < 1)
    )
      throw new Error('invalid restore fixture operation ordinal');
    const handle: RestoreFixturePhaseHandle = {
      fixtureId,
      ordinal: ++ordinal,
      phase,
      ...(operationOrdinal === undefined ? {} : { operationOrdinal }),
      startedAt: now(),
      finished: false,
    };
    record(handle, 'start', handle.startedAt);
    return handle;
  };

  const finish = (handle: RestoreFixturePhaseHandle) => {
    if (handle.finished) return;
    handle.finished = true;
    record(handle, 'end', now());
  };

  const fail = (handle: RestoreFixturePhaseHandle) => {
    if (handle.finished) return;
    handle.finished = true;
    record(handle, 'failure', now());
  };

  const phase = async <T>(
    label: string,
    operation: () => T | Promise<T>,
    operationOrdinal?: number,
  ): Promise<T> => {
    const handle = begin(label, operationOrdinal);
    try {
      const result = await operation();
      finish(handle);
      return result;
    } catch (error) {
      try {
        fail(handle);
      } catch {
        // Preserve the operation's original error if writing the failure record also fails.
      }
      throw error;
    }
  };

  /** Snapshot only completed phases; repeated labels accumulate and failed
   * phases retain their spent time without changing the lifecycle records. */
  const durations = (): Record<string, number> => Object.fromEntries(completedDurations);

  return { fixtureId, filePath, begin, finish, fail, phase, durations };
}
