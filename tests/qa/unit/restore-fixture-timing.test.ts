import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRestoreFixtureTiming,
  type RestoreFixturePhaseRecord,
} from '../support/restore-fixture-timing.ts';

function records(path: string): RestoreFixturePhaseRecord[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as RestoreFixturePhaseRecord);
}

test('restore fixture timing appends its start and end without a final flush', async () => {
  const directory = mkdtempSync(join(process.cwd(), '.temp', 'restore-fixture-timing-'));
  let clock = 100;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const timing = createRestoreFixtureTiming({
      artifactDirectory: directory,
      fixtureId: 'fixture-test',
      now: () => clock,
    });
    const running = timing.phase(
      'candidate.postgres-recovery',
      async () => {
        await blocked;
        return 'ready';
      },
      3,
    );
    expect(timing.filePath).toBe(join(directory, 'restore-fixture-timing-fixture-test.jsonl'));
    expect(records(timing.filePath!)).toEqual([
      {
        schema: 'restore-fixture-phase-v1',
        fixtureId: 'fixture-test',
        ordinal: 1,
        phase: 'candidate.postgres-recovery',
        status: 'start',
        elapsedMs: 0,
        operationOrdinal: 3,
      },
    ]);
    clock = 107;
    release();
    await expect(running).resolves.toBe('ready');
    expect(records(timing.filePath!)).toEqual([
      {
        schema: 'restore-fixture-phase-v1',
        fixtureId: 'fixture-test',
        ordinal: 1,
        phase: 'candidate.postgres-recovery',
        status: 'start',
        elapsedMs: 0,
        operationOrdinal: 3,
      },
      {
        schema: 'restore-fixture-phase-v1',
        fixtureId: 'fixture-test',
        ordinal: 1,
        phase: 'candidate.postgres-recovery',
        status: 'end',
        elapsedMs: 7,
        durationMs: 7,
        operationOrdinal: 3,
      },
    ]);
    expect('flush' in timing).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed restore fixture timing retains start, uses nonnegative durations and rethrows the original error', async () => {
  const directory = mkdtempSync(join(process.cwd(), '.temp', 'restore-fixture-timing-'));
  const error = new Error('private operation failure');
  let clock = 50;
  try {
    const timing = createRestoreFixtureTiming({
      artifactDirectory: directory,
      fixtureId: 'failed-fixture-test',
      now: () => clock,
    });
    const running = timing.phase(
      'completion.refusal.access-state',
      async () => {
        clock = 40;
        throw error;
      },
      1,
    );
    await expect(running).rejects.toBe(error);
    const result = records(timing.filePath!);
    expect(result.map(({ status }) => status)).toEqual(['start', 'failure']);
    expect(
      result.every(({ elapsedMs, durationMs }) => elapsedMs >= 0 && (durationMs ?? 0) >= 0),
    ).toBe(true);
    expect(result.map(({ elapsedMs }) => elapsedMs)).toEqual([0, 0]);
    expect(result.at(-1)).toMatchObject({
      fixtureId: 'failed-fixture-test',
      ordinal: 1,
      phase: 'completion.refusal.access-state',
      status: 'failure',
      durationMs: 0,
    });
    expect(JSON.stringify(result)).not.toContain('private operation failure');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
