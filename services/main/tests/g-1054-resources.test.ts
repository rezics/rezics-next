import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { planIntegrationShards } from '../../../scripts/qa/integration-shards.ts';
import {
  assertQaResourceAllocation,
  integrationResourceClass,
  integrationResourceClasses,
  integrationTierBudget,
  qaResourceClasses,
} from '../../../scripts/qa/resource-classes.ts';
import { qaStackEnvironment } from '../../../scripts/qa/stack-environment.ts';
import { workProfileProbe } from '../../../tests/qa/support/work-profile-probe.ts';
import { runWorkProfileChild } from '../../../tests/qa/support/work-profile-child.ts';

const targets = [
  'g-1021-reading-cost',
  'g-1025-home-cost',
  'g-1025-ranking-cost',
  'g-1034-realm-ranking',
].map((name) => `tests/qa/integration/${name}.test.ts`);

test('G1054: heavy files own allocated projects even after ten ordinary files with one free slot', () => {
  const prior = Array.from(
    { length: 10 },
    (_, index) => `tests/qa/integration/ordinary-${index}.test.ts`,
  );
  for (const slots of [1, 2, 3]) {
    const plans = planIntegrationShards(
      new Map([...prior, ...targets].map((file) => [file, 1000])),
      slots,
    );
    expect(plans.flatMap((plan) => plan.files).sort()).toEqual([...prior, ...targets].sort());
    for (const file of targets) {
      const plan = plans.find((plan) => plan.files.includes(file))!;
      expect(plan.files).toEqual([file]);
      expect(plan.resourceClass).toBe('large-tmpfs');
      const allocation = qaResourceClasses[plan.resourceClass];
      const env = qaStackEnvironment({}, allocation.storage, plan.resourceClass);
      expect(env.REZICS_QA_STACK_MODE).toBe('test');
      expect(env.REZICS_FUSEKI_MEMORY_LIMIT).toBe('7g');
      expect(allocation.budgetMs).toBe(600_000);
    }
  }
  expect(() => integrationResourceClass(targets)).toThrow('own project');
  expect(() => integrationResourceClass([targets[0]!, prior[0]!])).toThrow('own project');
});

test('G1054: every registered heavy recipe has a storage allocation, refuses undersizing and keeps scale overrides', () => {
  for (const [file, name] of integrationResourceClasses) {
    const [plan] = planIntegrationShards(new Map([[file, 1000]]), 1);
    expect(plan!.resourceClass).toBe(name);
    const allocation = qaResourceClasses[name];
    expect(qaStackEnvironment({}, allocation.storage, name).REZICS_QA_STACK_MODE).toBe(
      allocation.storage,
    );
    expect(() =>
      qaStackEnvironment({ REZICS_QA_FUSEKI_MEMORY_LIMIT: '2g' }, allocation.storage, name),
    ).toThrow('at least 7 GiB');
    expect(
      qaStackEnvironment({ REZICS_QA_FUSEKI_MEMORY_LIMIT: '8192m' }, allocation.storage, name)
        .REZICS_FUSEKI_MEMORY_LIMIT,
    ).toBe('8192m');
  }
  expect(
    qaStackEnvironment({ REZICS_QA_STACK_MODE: 'scale' }, undefined, 'ordinary')
      .REZICS_FUSEKI_MEMORY_LIMIT,
  ).toBe('7g');
  expect(integrationTierBudget(['ordinary'], 1)).toBe(480_000);
  expect(integrationTierBudget(['large-tmpfs'], 1)).toBe(600_000);
  expect(
    integrationTierBudget(
      Array.from({ length: 4 }, () => 'large-tmpfs'),
      1,
    ),
  ).toBe(3_840_000);
  expect(
    integrationTierBudget(
      Array.from({ length: 4 }, () => 'large-tmpfs'),
      3,
    ),
  ).toBeLessThan(3_840_000);
});

test('G1054: live allocation rejects an undersized or wrong-storage Compose overlay before fixture writes', () => {
  const tmpfs = [{ Type: 'tmpfs', Destination: '/fuseki/databases' }];
  const disk = [{ Type: 'volume', Destination: '/fuseki/databases' }];
  expect(() =>
    assertQaResourceAllocation('large-tmpfs', { memory: 2 * 1024 ** 3, mounts: tmpfs }),
  ).toThrow('below');
  expect(() =>
    assertQaResourceAllocation('large-tmpfs', { memory: 7 * 1024 ** 3, mounts: disk }),
  ).toThrow('storage');
  expect(() =>
    assertQaResourceAllocation('catalogue-disk', { memory: 7 * 1024 ** 3, mounts: tmpfs }),
  ).toThrow('storage');
  assertQaResourceAllocation('large-tmpfs', { memory: 7 * 1024 ** 3, mounts: tmpfs });
  assertQaResourceAllocation('catalogue-disk', { memory: 7 * 1024 ** 3, mounts: disk });
});

test('G1054: concurrent calibrations keep separate loopback ports, sinks, SQL descendants and traces', async () => {
  const results = await Promise.all([1, 4, 9, 2].map((loops) => workProfileProbe(loops)));
  expect(new Set(results.map((result) => result.profile.traceId)).size).toBe(4);
  for (const [index, loops] of [1, 4, 9, 2].entries()) {
    const { result, profile } = results[index]!;
    expect(result.rows).toHaveLength(loops);
    expect(profile.fusekiRequests).toBe(loops);
    expect(profile.postgresStatements).toBe(loops);
    expect(profile.accountCalls).toBe(1);
    expect(result.account.traceparent.split('-')[1]).toBe(profile.traceId);
  }
}, 60_000);

test('G1054: a stalled profile child is killed and reaped before the deadline failure returns', async () => {
  mkdirSync('.temp', { recursive: true });
  const directory = mkdtempSync(resolve('.temp/g-1054-child-'));
  const pidFile = resolve(directory, 'pid');
  try {
    await expect(
      runWorkProfileChild('packages/observability/tests/work-profile-supervision-child.ts', {
        timeoutMs: 2000,
        env: { WORK_PROFILE_PID_FILE: pidFile },
      }),
    ).rejects.toThrow('exceeded 2000ms');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(workProfileProbe(0)).rejects.toThrow('1..100');
    const next = await workProfileProbe(1);
    expect(next.profile.request.status).toBe(200);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);

test('G1054: unavailable calibration reports its failing owner and releases the child before another probe', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('unavailable', { status: 503 }),
  });
  try {
    await expect(
      runWorkProfileChild('packages/observability/tests/work-profile-child.ts', {
        env: {
          WORK_PROFILE_REAL: '1',
          WORK_PROFILE_LOOPS: '1',
          WORK_PROFILE_TRACEPARENT: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
          FUSEKI_URL: `${server.url.origin}/rezics/`,
          OTEL_SDK_DISABLED: 'true',
        },
      }),
    ).rejects.toThrow('HTTP 500: {"phase":"Fuseki calibration","errorType":"Error"}');
    expect((await workProfileProbe(1)).profile.request.status).toBe(200);
  } finally {
    await server.stop(true);
  }
}, 15_000);
