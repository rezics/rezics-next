import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentAdapter, withAgentAdapter } from './agents.ts';
import { readControlPolicy } from './policy.ts';
import { measureLog, measureSessionFile, reportedApproaches } from './records.ts';
import { readRouting, parseRouting } from './routing.ts';
import { readPool, assessUsageLimitRefusal } from './usage.ts';
import { pace, refreshCodexSchedule } from './pacing.ts';
import { workerPrompt, workerCheckProtocol } from './launch.ts';
import { brief, fixturePool, temporaryDirectory } from './test-support.ts';
import type { PoolReading, Task } from './types.ts';

const routeFile = join(import.meta.dir, '../routing.json');

test('local route budgets merge per class while explicit caller routes retain precedence', () => {
  const policy = readControlPolicy({ routing: { implementation: { maxSteps: 7, maxMs: 50 } } });
  const routed = readRouting(routeFile, policy.routing);
  expect(routed.classes.implementation).toMatchObject({ maxSteps: 7, maxMs: 50 });
  expect(routed.classes.research).toMatchObject({ maxSteps: 200, maxMs: 3600000 });
  routed.classes.implementation.maxMs = 999;
  expect(parseRouting(routed, policy.routing).classes.implementation.maxMs).toBe(999);
  expect(() =>
    parseRouting(
      {
        ...routed,
        classes: {
          ...routed.classes,
          implementation: {
            ...routed.classes.implementation,
            maxMs: null,
          },
        },
      },
      policy.routing,
    ),
  ).toThrow('maxMs');
});

test('provider policy reaches readers, streamed usage and observation freshness', () => {
  const policy = readControlPolicy({
    provider: { usageContextObjects: 1, observationClockSkewMs: 5 },
    records: { sessionReadBufferBytes: 7, legacyApproachCharacters: 3, legacyResultCharacters: 4 },
  });
  const pool = fixturePool('/unused');
  const reading: PoolReading = {
    pool: pool.name,
    allowanceKey: pool.allowanceKey,
    at: new Date(100).toISOString(),
    observedAt: new Date(106).toISOString(),
    exhausted: false,
    error: null,
    windows: [{ usedPercent: 1, resetsAt: null, minutes: 300 }],
  };
  withAgentAdapter(
    {
      ...agentAdapter(pool.cli),
      readAllowance: (_pool, _now, received) => {
        expect(received).toBe(policy.provider);
        return reading;
      },
    },
    () => expect(readPool(pool, 100, policy.provider)).toBe(reading),
  );
  expect(assessUsageLimitRefusal(reading, null, pool, 100, policy.provider).reason).toBe('reading-stale');
  const event = JSON.stringify({
    type: 'token_usage_record',
    input_tokens: 1,
    payload: {
      usage: { input_tokens: 1 },
      model: 'nested-model',
    },
  });
  expect(measureLog(event, { policy }).usage?.model).toBeNull();
  const temporary = temporaryDirectory();
  try {
    const path = join(temporary.path, 'session.jsonl');
    writeFileSync(path, event);
    expect(measureSessionFile(path, { policy })?.measurement.usage?.model).toBeNull();
    expect(measureSessionFile(path)?.measurement.usage?.model).toBe('nested-model');
    const bounded = readControlPolicy({ records: { sessionRecordBytes: 5 } });
    expect(measureSessionFile(path, { policy: bounded })).toBeNull();
  } finally {
    temporary.close();
  }
  expect(reportedApproaches('APPROACH: abcdef\nOUTCOME: ghijkl', undefined, policy.records)).toEqual([
    { approach: 'abc', result: 'ghij' },
  ]);
});

test('pacing uses configured refresh cadence and minimum reset duration', () => {
  const temporary = temporaryDirectory();
  const policy = readControlPolicy({ pacing: { scheduleRefreshMs: 5, minimumResetMs: 3600000 } }).pacing;
  let calls = 0;
  const fetch = () => {
    calls++;
    return '{"data":{}}';
  };
  try {
    refreshCodexSchedule(temporary.path, 100, fetch, policy);
    refreshCodexSchedule(temporary.path, 104, fetch, policy);
    expect(calls).toBe(1);
    refreshCodexSchedule(temporary.path, 105, fetch, policy);
    expect(calls).toBe(2);
    const pool = fixturePool('/unused');
    const reading: PoolReading = {
      pool: pool.name,
      allowanceKey: pool.allowanceKey,
      at: new Date(100).toISOString(),
      observedAt: new Date(100).toISOString(),
      error: null,
      exhausted: false,
      windows: [{ usedPercent: 50, resetsAt: 101, minutes: 300 }],
    };
    expect(pace(reading, pool, 100, undefined, policy)?.hoursToReset).toBe(1);
  } finally {
    temporary.close();
  }
});

test('worker prompts and verification guidance reflect caller policy without changing later callers', () => {
  const policy = readControlPolicy({
    guidance: { longCommandWaitMs: 5000, summaryWords: 40, blockerWords: 30, toolFailureRetries: 4 },
  });
  const task = { worktree: '/missing', branch: 'worker/test', brief: brief() } as Task;
  const prompt = workerPrompt(task, undefined, undefined, [], '/main', undefined, '/state', policy);
  for (const text of [
    'at least 5 seconds',
    'yield_time_ms: 5000',
    'Summary at most 40 words',
    'Blocker detail at most 30 words',
    'persisting after 4 retries',
  ])
    expect(prompt).toContain(text);
  expect(workerCheckProtocol('/missing')).toContain('at least 300 seconds');
});
