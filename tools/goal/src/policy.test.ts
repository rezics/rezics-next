import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import defaults from '../defaults.json';
import { checkSettings, readControlPolicy } from './config.ts';
import { capacityAvailable } from './launch.ts';
import { harness } from './test-support.ts';
import { toolRetryDelay } from './attempt-progress.ts';

test('local policy overrides individual leaves and validates configurable notifier bounds', () => {
  const h = harness();
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    local.policy = {
      backlog: { lowWater: 3 },
      host: { startupTimeoutMs: 90 },
      process: { exitPollMs: 7 },
      validation: { hourlyReportMaxTimeoutMs: 200001 },
      worker: { toolRetryBackoffMs: [0, 7], toolRetryWindowMs: 5000 },
      workerResources: { minimumMemoryFraction: 0.5 },
      containers: { maxAgeHours: 0.5 },
      appServer: { requestTimeoutMs: 25 },
    };
    local.integration = { hourlyReportTimeoutMs: 200001 };
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    const settings = checkSettings({ cwd: h.root, env: {} });
    expect(settings.policy).toEqual({
      ...defaults.policy,
      backlog: { ...defaults.policy.backlog, lowWater: 3 },
      host: { ...defaults.policy.host, startupTimeoutMs: 90 },
      process: { ...defaults.policy.process, exitPollMs: 7 },
      validation: { ...defaults.policy.validation, hourlyReportMaxTimeoutMs: 200001 },
      worker: { ...defaults.policy.worker, toolRetryBackoffMs: [0, 7], toolRetryWindowMs: 5000 },
      workerResources: { ...defaults.policy.workerResources, minimumMemoryFraction: 0.5 },
      containers: { ...defaults.policy.containers, maxAgeHours: 0.5 },
      appServer: { ...defaults.policy.appServer, requestTimeoutMs: 25 },
    });
    // The fixture environment normally disables delays; inspect the actual local policy without launching a worker.
    const retrySettings = settings;
    const task = h.tasks.dispatch(h.briefFile),
      ref = { taskId: task.id, attempt: 0 };
    const now = Date.now();
    const fixtureEnvironment = process.env.REZICS_GOAL_TEST_ENVIRONMENT;
    delete process.env.REZICS_GOAL_TEST_ENVIRONMENT;
    try {
      expect(
        [0, 1, 2, 6000].map((elapsed) => toolRetryDelay(h.store, retrySettings, ref, 'same', now + elapsed)),
      ).toEqual([0, 7, 7, 0]);
    } finally {
      if (fixtureEnvironment === undefined) delete process.env.REZICS_GOAL_TEST_ENVIRONMENT;
      else process.env.REZICS_GOAL_TEST_ENVIRONMENT = fixtureEnvironment;
    }
    local.integration.hourlyReportTimeoutMs++;
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(() => checkSettings({ cwd: h.root, env: {} })).toThrow('at most 200001');
    for (const invalid of [{ capacity: { maxWorkers: 0 } }, { backlog: { lowWater: 1.5 } }, { typo: 1 }])
      expect(() => readControlPolicy(invalid)).toThrow('policy.');
  } finally {
    h.dispose();
  }
});

test('fractional and retry-list policies reject invalid leaves and copy schedules', () => {
  for (const invalid of [
    { host: { startupLogBytes: 0 } },
    { host: { retryFailures: 1.5 } },
    { host: { maxBackoffMs: 1 } },
    { process: { exitPollMs: Number.MAX_SAFE_INTEGER + 1 } },
    { workerResources: { minimumMemoryFraction: 0 } },
    { workerResources: { minimumMemoryFraction: 1.1 } },
    { containers: { maxAgeHours: -1 } },
    { containers: { maxAgeHours: Infinity } },
    { worker: { toolRetryBackoffMs: [] } },
    { worker: { toolRetryBackoffMs: [NaN] } },
    { worker: { toolRetryBackoffMs: [-1] } },
    { worker: { toolRetryBackoffMs: [0.5] } },
    { worker: { settlementBackoffMs: [0] } },
    { worker: { settlementBackoffMs: ['1'] } },
  ])
    expect(() => readControlPolicy(invalid)).toThrow('policy.');
  const input = [0, 5];
  const policy = readControlPolicy({ worker: { toolRetryBackoffMs: input }, workerResources: { memoryReserveGiB: 0 } });
  input[0] = 99;
  expect(policy.worker.toolRetryBackoffMs).toEqual([0, 5]);
  expect(policy.workerResources.memoryReserveGiB).toBe(0);
});

test('host admission uses configured defaults and retains the capacity file override and opt-in', () => {
  const h = harness();
  try {
    const policy = readControlPolicy({ capacity: { maxWorkers: 1, minAvailableMiB: 0 } }).capacity;
    const store = { runningAttemptsCount: () => 1 } as typeof h.store;
    expect(capacityAvailable(store, h.settings.stateDirectory, policy)).toBe(true);
    const file = join(h.settings.stateDirectory, 'capacity.json');
    writeFileSync(file, '{}');
    expect(capacityAvailable(store, h.settings.stateDirectory, policy)).toBe(false);
    writeFileSync(file, JSON.stringify({ maxWorkers: 2 }));
    expect(capacityAvailable(store, h.settings.stateDirectory, policy)).toBe(true);
  } finally {
    h.dispose();
  }
});
