import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkerJob, USAGE_LIMIT_RETRY_PAUSE_MS, REPEATED_USAGE_LIMIT_EXHAUSTION_MS } from './job.ts';
import { WorkerTasks } from './tasks.ts';
import { fixturePool, harness, reading } from './test-support.ts';
import { assessUsageLimitRefusal, withObservedExhaustion } from './usage.ts';
import type { Pool } from './types.ts';

type TimeoutParameters = Parameters<typeof setTimeout>;

function pauseControl(autoRelease: boolean) {
  const original = globalThis.setTimeout;
  const delays: number[] = [];
  const held: { fire: () => void; cancel: () => void }[] = [];
  globalThis.setTimeout = ((...args: TimeoutParameters) => {
    if (args[1] !== USAGE_LIMIT_RETRY_PAUSE_MS) return original(...args);
    delays.push(args[1]);
    const immediate = [...args] as unknown[];
    immediate[1] = 0;
    if (autoRelease) return original(...(immediate as unknown as TimeoutParameters));
    const timer = original(() => {}, 60_000);
    held.push({
      fire: () => {
        clearTimeout(timer);
        original(...(immediate as unknown as TimeoutParameters));
      },
      cancel: () => clearTimeout(timer),
    });
    return timer;
  }) as typeof setTimeout;
  return {
    delays,
    release() {
      const next = held.shift();
      if (!next) throw new Error('no usage-limit retry pause is waiting');
      next.fire();
    },
    restore() {
      for (const pause of held.splice(0)) pause.cancel();
      globalThis.setTimeout = original;
    },
  };
}

function sessionQuota(pool: Pool, primary: number, secondary: number): void {
  const directory = join(pool.configDirectory, 'sessions', '2026', '10', '28');
  mkdirSync(directory, { recursive: true });
  const now = Date.now();
  const log = (timestamp: number, primaryUsage: number, secondaryUsage: number) =>
    `${JSON.stringify({
      timestamp: new Date(timestamp).toISOString(),
      payload: {
        rate_limits: {
          primary: { used_percent: primaryUsage, window_minutes: 300, resets_at: (now + 3_600_000) / 1000 },
          secondary: { used_percent: secondaryUsage, window_minutes: 10080, resets_at: (now + 7 * 86_400_000) / 1000 },
        },
      },
    })}\n`;
  const older = join(directory, 'older.jsonl');
  writeFileSync(older, log(now - 600_000, 100, 100));
  const oldMtime = new Date(now - 600_000);
  utimesSync(older, oldMtime, oldMtime);
  writeFileSync(join(directory, 'latest.jsonl'), log(now, primary, secondary));
}

const refusal = `console.log(JSON.stringify({type:'turn.failed',error:{code:'usage_limit_exceeded',message:"You've hit your usage limit; try again later"}})); process.exit(1);`;
const success = `import {writeFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process';
writeFileSync('result.txt','accepted'); spawnSync('git',['add','result.txt']); spawnSync('git',['commit','-qm','Complete result']);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:5}}));`;

test('only a quota reading older than maxAgeMs treats a usage-limit refusal as exhausted when no window is full', () => {
  const pool = fixturePool();
  const now = Date.now();
  expect(assessUsageLimitRefusal(reading(pool, 10), null, pool, now)).toMatchObject({
    confirmedExhaustion: false,
    reason: 'allowance-left',
  });
  const stale = reading(pool, 10);
  stale.observedAt = new Date(now - pool.policy.maxAgeMs - 1).toISOString();
  expect(assessUsageLimitRefusal(stale, null, pool, now)).toMatchObject({
    confirmedExhaustion: true,
    reason: 'reading-stale',
  });
});

test('a usage-limit refusal with fresh allowance retries the same pool after a short pause and records both windows', async () => {
  const h = harness(`#!/usr/bin/env bun
if (process.env.GOAL_ATTEMPT === '1') { ${refusal} }
${success}
`);
  let pauses: ReturnType<typeof pauseControl> | undefined;
  try {
    const pool = h.settings.pools[0]!;
    sessionQuota(pool, 10, 10);
    const task = h.tasks.dispatch(h.briefFile);
    pauses = pauseControl(false);
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);

    const ref = { taskId: task.id, attempt: 1 };
    const event = h.store.events(task.id).find((item) => item.attempt === 1 && item.kind === 'usage-limit-refusal');
    const body = JSON.parse(event!.body) as { windows: { window: string }[]; disposition: string; pauseMs: number };
    expect(body.windows.map((window) => window.window)).toEqual(['primary', 'secondary']);
    expect(body.disposition).toBe('retry-same-pool');
    expect(body.pauseMs).toBe(USAGE_LIMIT_RETRY_PAUSE_MS);
    expect(pauses.delays).toEqual([USAGE_LIMIT_RETRY_PAUSE_MS]);
    expect(h.store.retryIntent(ref)?.options.excludePools).toBeUndefined();
    expect(existsSync(join(h.settings.stateDirectory, 'exhausted', `${pool.allowanceKey}.json`))).toBe(false);
    expect(h.store.task(task.id).currentAttempt).toBe(1);

    pauses.release();
    await job.drain();
    expect(h.store.attempts(task.id).map((attempt) => attempt.pool)).toEqual([pool.name, pool.name]);
  } finally {
    pauses?.restore();
    h.dispose();
  }
}, 15_000);

test('a usage-limit refusal with a used-up window marks and excludes that pool', async () => {
  const h = harness(`#!/usr/bin/env bun
if (process.env.GOAL_ATTEMPT === '1') { ${refusal} }
${success}
`);
  try {
    const pool = h.settings.pools[0]!;
    const alternate = {
      ...pool,
      name: 'alternate',
      configDirectory: join(h.settings.stateDirectory, 'alternate'),
      allowanceKey: 'alternate',
    };
    h.settings.pools.push(alternate);
    let poolReads = 0;
    const tasks = new WorkerTasks(h.settings, h.store, (candidate) => {
      if (candidate.name === pool.name) return reading(candidate, ++poolReads >= 2 ? 100 : 10);
      return reading(candidate, 20);
    });
    const task = tasks.dispatch(h.briefFile);
    const job = new WorkerJob(tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    await job.drain();

    const event = h.store.events(task.id).find((item) => item.attempt === 1 && item.kind === 'usage-limit-refusal');
    expect(JSON.parse(event!.body)).toMatchObject({ assessment: 'window-used-up', disposition: 'exclude-pool' });
    expect(existsSync(join(h.settings.stateDirectory, 'exhausted', `${pool.allowanceKey}.json`))).toBe(true);
    expect(h.store.attempts(task.id).map((attempt) => attempt.pool)).toEqual([pool.name, alternate.name]);
  } finally {
    h.dispose();
  }
});

test('three usage-limit refusals on one pool within an hour exclude it for one hour', async () => {
  const h = harness(`#!/usr/bin/env bun
if (Number(process.env.GOAL_ATTEMPT) <= 3) { ${refusal} }
${success}
`);
  const pauses = pauseControl(true);
  try {
    const pool = h.settings.pools[0]!;
    const alternate = {
      ...pool,
      name: 'alternate',
      configDirectory: join(h.settings.stateDirectory, 'alternate'),
      allowanceKey: 'alternate',
    };
    h.settings.pools.push(alternate);
    const tasks = new WorkerTasks(h.settings, h.store, (candidate) =>
      reading(candidate, candidate.name === pool.name ? 10 : 50),
    );
    const task = tasks.dispatch(h.briefFile);
    const job = new WorkerJob(tasks, { enqueue() {} }, { deliver() {} });
    await job.start(task.id);
    await job.drain();

    const attempts = h.store.attempts(task.id);
    expect(attempts.map((attempt) => attempt.pool)).toEqual([pool.name, pool.name, pool.name, alternate.name]);
    expect(pauses.delays).toEqual([USAGE_LIMIT_RETRY_PAUSE_MS, USAGE_LIMIT_RETRY_PAUSE_MS]);
    const refusals = h.store.events(task.id).filter((item) => item.kind === 'usage-limit-refusal');
    expect(refusals).toHaveLength(3);
    expect(JSON.parse(refusals[2]!.body)).toMatchObject({ refusalCount: 3, disposition: 'exclude-pool' });

    const marker = JSON.parse(
      readFileSync(join(h.settings.stateDirectory, 'exhausted', `${pool.allowanceKey}.json`), 'utf8'),
    ) as {
      observedAt: string;
      expiresAt: string;
    };
    const markedAt = Date.parse(marker.observedAt);
    expect(Date.parse(marker.expiresAt) - markedAt).toBe(REPEATED_USAGE_LIMIT_EXHAUSTION_MS);
    expect(
      withObservedExhaustion(
        reading(pool, 0),
        pool,
        h.settings.stateDirectory,
        markedAt + REPEATED_USAGE_LIMIT_EXHAUSTION_MS - 1,
      ).exhausted,
    ).toBe(true);
    expect(
      withObservedExhaustion(
        reading(pool, 0),
        pool,
        h.settings.stateDirectory,
        markedAt + REPEATED_USAGE_LIMIT_EXHAUSTION_MS + 1,
      ).exhausted,
    ).toBe(false);
  } finally {
    pauses.restore();
    h.dispose();
  }
});
