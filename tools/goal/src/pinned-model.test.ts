import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, type RunningWorker } from './launch.ts';
import { makeRecord, readMeasurement } from './records.ts';
import { WorkerTasks } from './tasks.ts';
import { harness, markdown } from './test-support.ts';
import type { Pool, PoolReading, Profile } from './types.ts';

type Allowance = { usedPercent: number; resetsInHours: number; exhausted?: boolean };
type Launch = { profile: Profile; pool: string };

function addPool(h: ReturnType<typeof harness>, name: string, cli: Profile['cli'], poolClass: string): Pool {
  const base = h.settings.pools[0]!;
  const pool = {
    ...base,
    name,
    cli,
    classes: [poolClass],
    configDirectory: join(h.settings.stateDirectory, `${name}-account`),
    command: `${name}-worker`,
    allowanceKey: name,
  };
  h.settings.pools.push(pool);
  return pool;
}

function setRoutes(h: ReturnType<typeof harness>, first: Profile, fallbacks: Profile[], paced = true): void {
  const routing = JSON.parse(readFileSync(h.settings.routingFile, 'utf8')) as {
    classes: Record<
      string,
      { first: Profile; fallbacks?: Profile[]; maxSteps: number; maxMs: number; paced?: boolean }
    >;
    experiments: unknown[];
  };
  for (const route of Object.values(routing.classes)) {
    route.first = first;
    route.fallbacks = fallbacks;
    route.paced = paced;
  }
  routing.experiments = [];
  const file = join(h.settings.stateDirectory, 'pinned-model-routing.json');
  writeFileSync(file, JSON.stringify(routing));
  h.settings.routingFile = file;
}

function pinnedBrief(h: ReturnType<typeof harness>, model: string, effort: string): string {
  const file = join(h.settings.stateDirectory, `brief-${crypto.randomUUID()}.md`);
  writeFileSync(file, markdown.replace('waiting: []', `waiting: []\nmodel: ${model}\neffort: ${effort}`));
  return file;
}

function unpinnedBrief(h: ReturnType<typeof harness>): string {
  const file = join(h.settings.stateDirectory, `brief-${crypto.randomUUID()}.md`);
  writeFileSync(file, markdown);
  return file;
}

function workerTasks(
  h: ReturnType<typeof harness>,
  allowances: Record<string, Allowance>,
  launches: Launch[],
): WorkerTasks {
  const reader = (pool: Pool): PoolReading => {
    const value = allowances[pool.name] ?? { usedPercent: 0, resetsInHours: 100 };
    const now = Date.now();
    return {
      pool: pool.name,
      allowanceKey: pool.allowanceKey,
      at: new Date(now).toISOString(),
      observedAt: new Date(now).toISOString(),
      windows: [{ usedPercent: value.usedPercent, minutes: 10080, resetsAt: now + value.resetsInHours * 3_600_000 }],
      exhausted: value.exhausted ?? false,
      error: null,
    };
  };
  const fakeLaunch: typeof launch = async (_store, _task, attempt, pool): Promise<RunningWorker> => {
    launches.push({ profile: attempt.profile, pool: pool.name });
    return { attempt, exited: Promise.resolve({ code: 0, signal: null }) };
  };
  return new WorkerTasks(h.settings, h.store, reader, fakeLaunch);
}

function profile(cli: Profile['cli'], model: string, poolClass: string, effort: Profile['effort'] = 'high'): Profile {
  return { cli, model, effort, poolClass };
}

test('a brief pin starts on its exact model and effort despite the class route and pacing', async () => {
  const h = harness();
  const launches: Launch[] = [];
  try {
    const codex = h.settings.pools[0]!;
    const grok = addPool(h, 'grok', 'grok', 'grok');
    const cursor = addPool(h, 'cursor', 'cursor', 'cursor');
    const routed = profile(grok.cli, 'grok-4.7', 'grok');
    const paced = profile(cursor.cli, 'gpt-5.6-luna', 'cursor');
    setRoutes(h, routed, [paced]);
    const tasks = workerTasks(
      h,
      {
        [codex.name]: { usedPercent: 80, resetsInHours: 100 },
        [grok.name]: { usedPercent: 80, resetsInHours: 10 },
        [cursor.name]: { usedPercent: 0, resetsInHours: 1 },
      },
      launches,
    );

    const task = tasks.dispatch(pinnedBrief(h, 'gpt-6.1-sol', 'xhigh'));
    await tasks.retry(task.id);
    expect(launches[0]).toEqual({
      profile: profile('codex', 'gpt-6.1-sol', 'codex', 'xhigh'),
      pool: codex.name,
    });

    // The same quota readings would pace unpinned work toward Cursor, while its class route starts on Grok.
    const unpinned = tasks.dispatch(unpinnedBrief(h));
    await tasks.retry(unpinned.id);
    expect(launches[1]?.profile).toEqual(paced);
  } finally {
    h.dispose();
  }
});

test('a retry keeps a pin and a reshaped brief replaces the old attempt profile', async () => {
  const h = harness();
  const launches: Launch[] = [];
  try {
    const sol = profile('codex', 'gpt-6.1-sol', 'codex', 'high');
    const terra = profile('codex', 'gpt-6.1-terra', 'codex', 'high');
    setRoutes(h, sol, [terra], false);
    const tasks = workerTasks(h, {}, launches);
    const task = tasks.dispatch(pinnedBrief(h, sol.model, 'xhigh'));

    await tasks.retry(task.id);
    await tasks.retry(task.id);
    const reshaped = join(h.settings.stateDirectory, 'reshaped.md');
    writeFileSync(reshaped, markdown.replace('waiting: []', `waiting: []\nmodel: ${terra.model}\neffort: max`));
    await tasks.retry(task.id, { brief: reshaped });

    expect(h.store.attempts(task.id).map((attempt) => [attempt.profile.model, attempt.profile.effort])).toEqual([
      [sol.model, 'xhigh'],
      [sol.model, 'xhigh'],
      [terra.model, 'max'],
    ]);
    expect(launches.map((started) => [started.profile.model, started.profile.effort])).toEqual([
      [sol.model, 'xhigh'],
      [sol.model, 'xhigh'],
      [terra.model, 'max'],
    ]);
  } finally {
    h.dispose();
  }
});

test('a pinned task waits when every pool serving its model is exhausted, without falling back', async () => {
  const h = harness();
  const launches: Launch[] = [];
  try {
    const codex = h.settings.pools[0]!;
    const secondCodex = addPool(h, 'codex-two', 'codex', 'codex');
    const cursor = addPool(h, 'cursor', 'cursor', 'cursor');
    setRoutes(h, profile(cursor.cli, 'gpt-5.6-sol', 'cursor'), [profile('codex', 'gpt-6-luna', 'codex')]);
    const tasks = workerTasks(
      h,
      {
        [codex.name]: { usedPercent: 100, resetsInHours: 10, exhausted: true },
        [secondCodex.name]: { usedPercent: 100, resetsInHours: 10, exhausted: true },
        [cursor.name]: { usedPercent: 10, resetsInHours: 100 },
      },
      launches,
    );
    const task = tasks.dispatch(pinnedBrief(h, 'gpt-6.1-sol', 'xhigh'));

    await expect(tasks.retry(task.id)).rejects.toThrow('no allowed pool available for codex/codex');
    expect(launches).toEqual([]);
    expect(h.store.attempts(task.id)).toEqual([]);
    expect(h.store.task(task.id)).toMatchObject({ state: 'ready', currentAttempt: 0 });
  } finally {
    h.dispose();
  }
});

test('an unpinned task still uses route fallbacks, pacing and the three-failure model switch', async () => {
  const fallbackHarness = harness();
  const fallbackLaunches: Launch[] = [];
  try {
    const codex = fallbackHarness.settings.pools[0]!;
    const cursor = addPool(fallbackHarness, 'cursor', 'cursor', 'cursor');
    const first = profile('codex', 'gpt-6-luna', 'codex');
    const fallback = profile(cursor.cli, 'gpt-5.6-luna', 'cursor');
    setRoutes(fallbackHarness, first, [fallback], false);
    const tasks = workerTasks(
      fallbackHarness,
      {
        [codex.name]: { usedPercent: 100, resetsInHours: 10, exhausted: true },
        [cursor.name]: { usedPercent: 20, resetsInHours: 100 },
      },
      fallbackLaunches,
    );
    const task = tasks.dispatch(unpinnedBrief(fallbackHarness));
    await tasks.retry(task.id);
    expect(fallbackLaunches[0]?.profile).toEqual(fallback);
  } finally {
    fallbackHarness.dispose();
  }

  const pacingHarness = harness();
  const pacingLaunches: Launch[] = [];
  try {
    const codex = pacingHarness.settings.pools[0]!;
    const cursor = addPool(pacingHarness, 'cursor', 'cursor', 'cursor');
    const first = profile('codex', 'gpt-6-luna', 'codex');
    const fallback = profile(cursor.cli, 'gpt-5.6-luna', 'cursor');
    setRoutes(pacingHarness, first, [fallback], true);
    const tasks = workerTasks(
      pacingHarness,
      {
        [codex.name]: { usedPercent: 80, resetsInHours: 100 },
        [cursor.name]: { usedPercent: 0, resetsInHours: 1 },
      },
      pacingLaunches,
    );
    const task = tasks.dispatch(unpinnedBrief(pacingHarness));
    await tasks.retry(task.id);
    expect(pacingLaunches[0]?.profile).toEqual(fallback);
  } finally {
    pacingHarness.dispose();
  }

  const switchHarness = harness();
  const switchLaunches: Launch[] = [];
  try {
    const first = profile('codex', 'model-a', 'codex');
    const second = profile('codex', 'model-b', 'codex');
    setRoutes(switchHarness, first, [second], false);
    const tasks = workerTasks(switchHarness, {}, switchLaunches);
    const task = tasks.dispatch(unpinnedBrief(switchHarness));
    for (let attempt = 1; attempt <= 3; attempt++) {
      await tasks.retry(task.id);
      const current = switchHarness.store.attempt({ taskId: task.id, attempt });
      switchHarness.store.putRecord(
        makeRecord(switchHarness.store.task(task.id), current, readMeasurement(current), 'gate-failed'),
      );
    }
    await tasks.retry(task.id);
    expect(switchLaunches.map((started) => started.profile.model)).toEqual([
      'model-a',
      'model-a',
      'model-a',
      'model-b',
    ]);
  } finally {
    switchHarness.dispose();
  }
});
