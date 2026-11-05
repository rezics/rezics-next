import { expect, test } from 'bun:test';
import type { GateOutcomeRefusal } from './contracts.ts';
import { FAILURE_GUARDS, GUARDS, REFUSAL_GUARDS, type GuardId } from './guards.ts';
import { harness } from './test-support.ts';
import type { Attempt, AttemptRecord, FailureClass } from './types.ts';
import { runWorkerCommand } from './worker-commands.ts';

test('every attempt-ending failure and landing refusal has a non-empty priced guard', () => {
  const failures: Record<FailureClass, GuardId> = FAILURE_GUARDS;
  const refusals: Record<GateOutcomeRefusal['kind'], GuardId> = REFUSAL_GUARDS;
  for (const [id, guard] of Object.entries(GUARDS)) {
    expect(guard.defect.trim(), id).not.toBe('');
    expect(guard.owner.trim(), id).not.toBe('');
    expect(guard.since.trim(), id).not.toBe('');
    expect(guard.repair.trim(), id).not.toBe('');
  }
  expect(Object.keys(failures).length).toBeGreaterThan(0);
  expect(Object.keys(refusals).length).toBeGreaterThan(0);
});

test('flow report prices guard firings and flags unchanged next attempts for repair in place', async () => {
  const h = harness();
  try {
    const now = Date.now();
    const end = new Date(now - 2 * 24 * 60 * 60 * 1000);
    const records: AttemptRecord[] = [];
    const attempts: Attempt[] = [];
    const makeRecord = (
      taskId: string,
      attempt: number,
      startedAt: string,
      endedAt: string,
      outcome: AttemptRecord['outcome'],
      guardIds?: GuardId[],
    ) =>
      ({
        taskId,
        attempt,
        startedAt,
        endedAt,
        outcome,
        guardIds,
        tokens: { input: 100, cached: 40, output: 10 },
      }) as AttemptRecord;
    for (let index = 0; index < 20; index++) {
      const taskId = `guarded-${index}`;
      const endedAt = new Date(end.getTime() + index * 60_000).toISOString();
      const startedAt = new Date(Date.parse(endedAt) - 60 * 60_000).toISOString();
      records.push(makeRecord(taskId, 1, startedAt, endedAt, 'gate-failed', ['new-failure']));
      const nextStartedAt = endedAt;
      const nextEndedAt = new Date(Date.parse(nextStartedAt) + 30 * 60_000).toISOString();
      records.push(makeRecord(taskId, 2, nextStartedAt, nextEndedAt, 'passed'));
      attempts.push({ taskId, attempt: 2 } as Attempt);
    }
    const store = Object.assign(Object.create(h.store) as typeof h.store, {
      records: () => records,
      attempts: () => attempts,
    });
    const text: string[] = [];
    await runWorkerCommand('report', ['--flow'], {
      settings: h.settings,
      store,
      tasks: h.tasks,
      print: (value) => text.push(value),
      env: {},
    });
    expect(text[0]).toContain('Guard ledger (trailing 7 days):');
    expect(text[0]).toContain(
      'guard | defect | owner | since | firings | attempt h | next-attempt h | tokens | rewritten | landed | repair',
    );
    expect(text[0]).toContain('| 20 | 20.00 | 10.00 | 2200 | 0.0% | 100.0% | repairable in place:');
  } finally {
    h.dispose();
  }
});
