import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fixtureRoot, root } from '../../../scripts/fixture/stack.ts';
import {
  acquireSeedBuildLock,
  buildSeedCommandCostComparison,
  buildSeedCommandCostReport,
  readRetainedSeed,
  seedVerificationCuts,
  seedDirectory,
  seedDirectoryForFixtureRoot,
  SEED_BUILD_COMMAND,
  seedApi,
  type SeedCommandCostRow,
  type SeedCommandMeasurement,
  type RetainedSeedCut,
}
  from '../support/seed-checkpoints.ts';
import { integrationResourceClass, qaResourceClasses } from '../../../scripts/qa/resource-classes.ts';
import { seedVerificationPlan, SEED_RESTORE_RUN_CEILING_MS } from '../../../scripts/qa/seed-verification.ts';

test('seed preparation follows reconciling writes with the original intent and key', async () => {
  const requests: Array<{ key: string | null; body: string }> = [];
  const stack = { main: { async handle(request: Request) {
    requests.push({ key: request.headers.get('idempotency-key'), body: await request.text() });
    return requests.length === 1 ? Response.json({ operationId: 'urn:operation:seed',
      status: 'reconciling', phase: 'publication-selection', result: null,
      retry: { allowed: true, afterMs: 0 } }, { status: 202 })
      : Response.json({ selection: 'urn:selection:seed' }, { status: 201 });
  } } } as Parameters<typeof seedApi>[0];
  const result = await seedApi(stack, 'token').command('seed:selection', {
    method: 'POST', path: '/v1/publication-selections', body: { expectedSelectionHead: null },
  });
  expect(result).toEqual({ selection: 'urn:selection:seed' });
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]!.key).toBe('seed:selection');
});

test('every cut selection preserves the two-copy isolation proof and allocates its exact restore count', () => {
  const cuts = (['small', 'medium', 'large'] as const).map(scale => ({ manifest: { scale } }) as RetainedSeedCut);
  expect(seedVerificationCuts({ cuts })).toEqual([cuts[0]!, ...cuts]);
  expect(seedVerificationCuts({ cuts }, 'all')).toEqual([cuts[0]!, ...cuts]);
  const previous = process.env.REZICS_SEED_VERIFY_CUT;
  try {
    for (const [index, scale] of ['small', 'medium', 'large'].entries()) {
      const selected = seedVerificationCuts({ cuts }, scale);
      expect(selected).toEqual([cuts[index]!, cuts[index]!]);
      process.env.REZICS_SEED_VERIFY_CUT = scale;
      const plan = seedVerificationPlan(scale);
      expect(plan.restoreCount).toBe(selected.length);
      expect(plan.restoreCount).toBe(2);
      expect(qaResourceClasses['seed-cut-restore'].budgetMs).toBe(selected.length * SEED_RESTORE_RUN_CEILING_MS);
    }
    for (const selection of [undefined, 'all']) {
      if (selection === undefined) delete process.env.REZICS_SEED_VERIFY_CUT;
      else process.env.REZICS_SEED_VERIFY_CUT = selection;
      const plan = seedVerificationPlan(selection);
      expect(plan.restoreCount).toBe(seedVerificationCuts({ cuts }, selection).length);
      expect(plan.restoreCount).toBe(4);
      expect(qaResourceClasses['seed-cut-restore'].budgetMs).toBe(4 * SEED_RESTORE_RUN_CEILING_MS);
    }
  } finally {
    if (previous === undefined) delete process.env.REZICS_SEED_VERIFY_CUT;
    else process.env.REZICS_SEED_VERIFY_CUT = previous;
  }
  expect(() => seedVerificationCuts({ cuts }, 'typo')).toThrow('REZICS_SEED_VERIFY_CUT');
  expect(() => seedVerificationCuts({ cuts: [] }, 'small')).toThrow('cut small is absent');
  const allocation = qaResourceClasses[integrationResourceClass(['tests/qa/integration/work-profile-seed-checkpoints.test.ts'])];
  expect(allocation.storage).toBe('scale');
});

function commandMeasurement(
  operation: string,
  totalLatencyMs: number,
  postgresStatements: number | null = 1,
  fusekiRequests: number | null = 1,
  additional: Partial<SeedCommandMeasurement['profile']> = {},
): SeedCommandMeasurement {
  return { operation, profile: { totalLatencyMs, postgresStatements, fusekiRequests,
    unclassifiedFetches: 0, unobserved: [], ...additional } };
}

function commandCostRow(operation: string, ms: number, sql: number, fuseki: number): SeedCommandCostRow {
  return { operation, count: 1, ms, sql, fuseki };
}

test('retained seed checkpoints use the shared fixture temp directory and follow fixture-root overrides', () => {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: root, encoding: 'utf8' });
  expect(common.status).toBe(0);
  const sharedFixtureRoot = join(dirname(common.stdout.trim()), '.temp', 'fixture');
  const activeFixtureRoot = process.env.REZICS_FIXTURE_ROOT
    ? resolve(process.env.REZICS_FIXTURE_ROOT) : sharedFixtureRoot;
  expect(seedDirectory).toBe(seedDirectoryForFixtureRoot(activeFixtureRoot));
  expect(seedDirectoryForFixtureRoot(join(root, '.temp', 'fixture-override', 'fixture')))
    .toBe(join(root, '.temp', 'fixture-override', 'work-profiles', 'seed-checkpoints'));
  expect(fixtureRoot).toBe(activeFixtureRoot);
});

test('routine seed restore rejects absent, partial and invalid preparation with the explicit build command', () => {
  mkdirSync('.temp/seed-checkpoint-read', { recursive: true });
  const directory = mkdtempSync('.temp/seed-checkpoint-read/check-');
  const path = join(directory, 'retained.json');
  try {
    expect(() => readRetainedSeed(path)).toThrow(`absent. Build them explicitly: ${SEED_BUILD_COMMAND}`);
    writeFileSync(path, JSON.stringify({ format: 'seed-checkpoints-v2', cuts: [] }));
    expect(() => readRetainedSeed(path)).toThrow(`incomplete. Build them explicitly: ${SEED_BUILD_COMMAND}`);
    writeFileSync(path, '{');
    expect(() => readRetainedSeed(path)).toThrow(`invalid. Build them explicitly: ${SEED_BUILD_COMMAND}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a second retained seed build reports its holder and exact stale-lock removal command', () => {
  mkdirSync('.temp', { recursive: true });
  const directory = mkdtempSync('.temp/seed-checkpoint-lock-');
  const lockPath = join(directory, '.build.lock');
  const release = acquireSeedBuildLock('holder-run', directory);
  try {
    expect(() => acquireSeedBuildLock('waiting-run', directory)).toThrow(
      `Seed checkpoint build lock exists for pid ${process.pid} and run ID "holder-run". If the holder has stopped, remove it with: rm -f -- '${lockPath}'`);
  } finally {
    release();
    rmSync(directory, { recursive: true, force: true });
  }

  const staleDirectory = mkdtempSync('.temp/seed-checkpoint-stale-');
  const stalePath = join(staleDirectory, '.build.lock');
  const stalePid = 2_147_483_647;
  writeFileSync(stalePath, JSON.stringify({ pid: stalePid, runId: 'stale-run', token: 'stale-token' }));
  try {
    expect(() => acquireSeedBuildLock('waiting-run', staleDirectory)).toThrow(
      `Seed checkpoint build lock exists for pid ${stalePid} and run ID "stale-run" (stale: process is not running). If the holder has stopped, remove it with: rm -f -- '${stalePath}'`);
    expect(existsSync(stalePath)).toBe(true);
  } finally { rmSync(staleDirectory, { recursive: true, force: true }); }
});

test('seed command cost reports calculate odd and even medians and sort by median latency', () => {
  const report = buildSeedCommandCostReport([
    commandMeasurement('GET /fast', 4, 2, 4),
    commandMeasurement('POST /slow', 8, 4, 2),
    commandMeasurement('GET /fast', 6, 4, 6),
    commandMeasurement('POST /slow', 11, 6, 4),
    commandMeasurement('POST /slow', 14, 8, 6),
  ]);
  expect(report.rows).toEqual([
    { operation: 'POST /slow', count: 3, ms: 11, sql: 6, fuseki: 4 },
    { operation: 'GET /fast', count: 2, ms: 5, sql: 3, fuseki: 5 },
  ]);
  expect(report.markdown).toContain('| API operation class | Count | Median time (ms) | SQL statements / command (median) | Fuseki calls / command (median) |');
  expect(report.markdown).toContain('| POST /slow | 3 | 11.0 | 6 | 4 |');
});

test('seed command cost reports keep each stage limited to its supplied commands', () => {
  const four = buildSeedCommandCostReport([commandMeasurement('POST /work', 10, 5, 2)]);
  const sixteen = buildSeedCommandCostReport([
    commandMeasurement('POST /work', 20, 7, 3),
    commandMeasurement('POST /work', 22, 9, 5),
  ]);
  const sixtyFour = buildSeedCommandCostReport([
    commandMeasurement('POST /work', 40, 11, 4),
    commandMeasurement('POST /work', 50, 13, 6),
  ]);
  expect(four.rows).toEqual([{ operation: 'POST /work', count: 1, ms: 10, sql: 5, fuseki: 2 }]);
  expect(sixteen.rows).toEqual([{ operation: 'POST /work', count: 2, ms: 21, sql: 8, fuseki: 4 }]);
  expect(sixtyFour.rows).toEqual([{ operation: 'POST /work', count: 2, ms: 45, sql: 12, fuseki: 5 }]);
});

test('seed command cost reports refuse incomplete request meters', () => {
  const incomplete = [
    commandMeasurement('GET /unknown-sql', 10, null, 1),
    commandMeasurement('GET /unknown-fuseki', 10, 1, null),
    commandMeasurement('GET /unclassified', 10, 1, 1, { unclassifiedFetches: 1 }),
    commandMeasurement('GET /missing-sql-descendants', 10, 1, 1, { unobserved: ['main SQL descendants'] }),
  ];
  for (const item of incomplete)
    expect(() => buildSeedCommandCostReport([item])).toThrow(`Incomplete existing request meters for ${item.operation}`);
});

test('seed command cost comparison flags time or SQL growth beyond 1.5 times the 4-Work median', () => {
  const comparison = buildSeedCommandCostComparison({
    '4': [
      commandCostRow('GET /time-growth', 10, 2, 1),
      commandCostRow('GET /sql-growth', 10, 2, 1),
      commandCostRow('GET /at-threshold', 10, 2, 1),
    ],
    '16': [
      commandCostRow('GET /time-growth', 13, 3, 2),
      commandCostRow('GET /sql-growth', 12, 3, 2),
      commandCostRow('GET /at-threshold', 12, 2, 1),
    ],
    '64': [
      commandCostRow('GET /time-growth', 16, 2, 1),
      commandCostRow('GET /sql-growth', 14, 4, 1),
      commandCostRow('GET /at-threshold', 15, 3, 1),
    ],
  });
  expect(comparison.rows.find(row => row.operation === 'GET /time-growth')?.grows).toBe(true);
  expect(comparison.rows.find(row => row.operation === 'GET /sql-growth')?.grows).toBe(true);
  expect(comparison.rows.find(row => row.operation === 'GET /at-threshold')?.grows).toBe(false);
  expect(comparison.rows.find(row => row.operation === 'GET /time-growth')).toMatchObject({
    at4: { ms: 10, sql: 2, fuseki: 1 },
    at16: { ms: 13, sql: 3, fuseki: 2 },
    at64: { ms: 16, sql: 2, fuseki: 1 },
    ratio64To4: 1.6,
  });
  expect(comparison.markdown).toContain('64/4 median time');
  expect(comparison.markdown).toContain('1.60x | GROWS |');
  expect(comparison.markdown).toContain('1.50x | — |');
});
