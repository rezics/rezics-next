import { expect, test } from 'bun:test';
import type { GateOutcomeRefusal } from './contracts.ts';
import { FAILURE_GUARDS, formatGuardLedger, guardLedger, GUARDS, REFUSAL_GUARDS, type GuardId } from './guards.ts';
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
  expect(GUARDS['dev-landing-transpile']).toMatchObject({
    owner: 'control-plane',
    since: '2026-11-05',
  });
  expect(GUARDS['dev-landing-transpile'].defect).toContain('const reassignment');
  expect(GUARDS['dev-landing-transpile'].repair).toContain('original worker session');
  expect(GUARDS['dev-landing-transpile'].repair).toContain('Cost target: <1000ms');
  expect(GUARDS['dev-landing-transpile'].repair).toContain('Measured disposable fixture: 7ms');
  expect(GUARDS['dev-landing-architecture']).toMatchObject({ owner: 'control-plane', since: '2026-11-06' });
  expect(GUARDS['dev-landing-architecture'].repair).toContain('Cost target: <15000ms');
  expect(GUARDS['dev-landing-architecture'].repair).toContain('Measured full base-delta check: 14.6s');
  expect(GUARDS['dev-landing-schema'].defect).toContain('regenerated schema dump');
  expect(GUARDS['dev-landing-schema'].repair).toContain('original worker session');
  expect(GUARDS['dev-landing-schema'].repair).toContain('Cost target: <30000ms');
  expect(GUARDS['dev-landing-schema'].repair).toContain('Measured fresh throwaway database: 9173ms');
  expect(GUARDS['dev-landing-kernel-import'].defect).toContain('TDZ import cycle');
  expect(GUARDS['dev-landing-kernel-import'].defect).toContain('query-key');
  expect(GUARDS['dev-landing-kernel-import'].repair).toContain('original worker session');
  expect(GUARDS['dev-landing-kernel-import'].repair).toContain('server.ts');
  expect(GUARDS['dev-landing-kernel-import'].repair).toContain('worker.ts');
  expect(GUARDS['dev-landing-kernel-import'].repair).toContain('Cost target: <60000ms');
  expect(GUARDS['dev-landing-kernel-import'].repair).toContain('Measured representative candidate: setup 37473ms');
  expect(GUARDS['undeclared-risk-area'].defect).toContain('undeclared production change');
  expect(GUARDS['scope-failed'].defect).toContain('matched a protected production risk area');
  expect(GUARDS['scope-failed'].defect).not.toContain('unsafe source change');
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

test('guard ledger preserves its seven-day window and immediate-next attempt semantics', () => {
  const now = Date.parse('2026-04-10T00:00:00.000Z');
  const hour = 60 * 60 * 1000;
  const at = (time: number) => new Date(time).toISOString();
  const lower = at(now - 7 * 24 * hour);
  const lowerMs = Date.parse(lower);
  const makeRecord = (
    taskId: string,
    attempt: number,
    startedAt: string,
    endedAt: string,
    outcome: AttemptRecord['outcome'],
    guardIds: GuardId[],
    input = 0,
    output = 0,
  ) =>
    ({
      taskId,
      attempt,
      startedAt,
      endedAt,
      outcome,
      guardIds,
      tokens: { input, cached: 99, output },
    }) as AttemptRecord;
  const records = [
    makeRecord(
      'duplicate',
      1,
      at(lowerMs - hour),
      lower,
      'gate-failed',
      ['environment', 'environment', 'unknown'] as GuardId[],
      3,
      5,
    ),
    makeRecord('duplicate', 1, at(lowerMs - 2 * hour), lower, 'gate-failed', ['environment'], 7, 11),
    makeRecord('duplicate', 2, at(now), at(now + 3 * hour), 'gate-failed', []),
    makeRecord('duplicate', 2, at(now), at(now + hour), 'verified', []),
    makeRecord('record-missing', 4, at(now - 2 * hour), at(now), 'gate-failed', ['new-failure'], 4, 6),
    makeRecord('attempt-missing', 1, at(now - hour / 2), at(now), 'gate-failed', ['question'], 2, 3),
    makeRecord('attempt-missing', 2, at(now), at(now + 2 * hour), 'passed', []),
    makeRecord('invalid-date', 1, 'not-a-date', 'also-not-a-date', 'gate-failed', ['blocker'], 2, 3),
    makeRecord('invalid-duration', 1, 'not-a-date', at(now), 'gate-failed', ['blocker'], 1, 2),
    makeRecord('negative-duration', 1, at(now + 60_000), at(now), 'gate-failed', ['blocker'], 4, 6),
    makeRecord('before-window', 1, at(lowerMs - 2), at(lowerMs - 1), 'gate-failed', ['early-stop']),
  ];
  const attempts = [
    { taskId: 'duplicate', attempt: 2, newBriefHash: 'first-entry' },
    { taskId: 'duplicate', attempt: 2 },
    { taskId: 'record-missing', attempt: 5, newBriefHash: 'no-record' },
  ] as Attempt[];
  const rows = guardLedger(records, attempts, now);
  const measuredIds = new Set<string>(['blocker', 'environment', 'new-failure', 'question']);
  const measured = rows.filter(({ id }) => measuredIds.has(id));

  expect(
    measured.map(({ id, firings, attemptHours, nextAttemptHours, tokens, rewrittenShare, landedShare, action }) => [
      id,
      firings,
      attemptHours,
      nextAttemptHours,
      tokens,
      rewrittenShare,
      landedShare,
      action,
    ]),
  ).toEqual([
    ['blocker', 2, 0, 0, 13, null, null, 'monitor'],
    ['environment', 2, 3, 2, 26, 0, 1, 'monitor'],
    ['new-failure', 1, 2, 0, 10, null, null, 'monitor'],
    ['question', 1, 0.5, 0, 5, null, null, 'monitor'],
  ]);
  expect(rows.map(({ id }) => id).sort()).toEqual((Object.keys(GUARDS) as GuardId[]).sort());
  expect(
    rows
      .filter(({ firings }) => !firings)
      .every((row) => !row.attemptHours && !row.tokens && row.rewrittenShare === null && row.landedShare === null),
  ).toBe(true);

  const output = formatGuardLedger(rows);
  expect(output.slice(0, 2)).toEqual([
    'Guard ledger (trailing 7 days):',
    '  guard | defect | owner | since | firings | attempt h | next-attempt h | tokens | rewritten | landed | repair',
  ]);
  expect(output).toHaveLength(Object.keys(GUARDS).length + 2);
  expect(output.slice(2, 6)).toEqual([
    `  blocker | ${GUARDS.blocker.defect} | ${GUARDS.blocker.owner} | ${GUARDS.blocker.since} | 2 | 0.00 | 0.00 | 13 | n/a | n/a | monitor: ${GUARDS.blocker.repair}`,
    `  environment | ${GUARDS.environment.defect} | ${GUARDS.environment.owner} | ${GUARDS.environment.since} | 2 | 3.00 | 2.00 | 26 | 0.0% | 100.0% | monitor: ${GUARDS.environment.repair}`,
    `  new-failure | ${GUARDS['new-failure'].defect} | ${GUARDS['new-failure'].owner} | ${GUARDS['new-failure'].since} | 1 | 2.00 | 0.00 | 10 | n/a | n/a | monitor: ${GUARDS['new-failure'].repair}`,
    `  question | ${GUARDS.question.defect} | ${GUARDS.question.owner} | ${GUARDS.question.since} | 1 | 0.50 | 0.00 | 5 | n/a | n/a | monitor: ${GUARDS.question.repair}`,
  ]);
});

test('guard ledger record and date reads stay constant as catalog memberships grow', () => {
  const size = 128;
  const now = Date.parse('2026-04-10T00:00:00.000Z');
  const startedAt = new Date(now - 60 * 60 * 1000).toISOString();
  const endedAt = new Date(now - 30 * 60 * 1000).toISOString();
  const guardIds = Object.keys(GUARDS) as GuardId[];
  const reads = { startedAt: 0, endedAt: 0, guardIds: 0 };
  const records = Array.from(
    { length: size },
    (_, index) =>
      new Proxy(
        {
          taskId: `growing-${index}`,
          attempt: 1,
          startedAt,
          endedAt,
          outcome: 'gate-failed',
          guardIds,
          tokens: { input: 3, cached: 99, output: 4 },
        } as unknown as AttemptRecord,
        {
          get(target, key, receiver) {
            if (key in reads) reads[key as keyof typeof reads]++;
            return Reflect.get(target, key, receiver);
          },
        },
      ),
  );

  const rows = guardLedger(records, [], now);
  expect(guardIds.length).toBeGreaterThan(1);
  expect(rows.every((row) => row.firings === size && row.attemptHours === size / 2 && row.tokens === size * 7)).toBe(
    true,
  );
  expect(reads).toEqual({ startedAt: size, endedAt: size, guardIds: size });
});
