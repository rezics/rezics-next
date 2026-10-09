import { expect, test } from 'bun:test';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareFixture } from '../../scripts/fixture/prepare.ts';
import type { FixtureManifest } from '../../scripts/fixture/manifest.ts';
import { parseJUnit, testArgs, UNEXECUTED_FILE_TEST } from '../../scripts/qa/acceptance.ts';
import {
  acquireQaSlots,
  isolatedIntegrationFiles,
  recordedFileDurations,
  sourceIdentity,
} from '../../scripts/qa/core.ts';
import { completeFileResults, lastStartedTestFile } from '../../scripts/qa/file-results.ts';
import { planIntegrationShards } from '../../scripts/qa/integration-shards.ts';
import { integrationResourceClasses, queuedProjectsBudget } from '../../scripts/qa/resource-classes.ts';
import {
  clearIntegrationDataset,
  filesKeptAfterResetFailure,
  integrationOwnerResetStatements,
  integrationResetHarnessFailure,
  resetIntegrationState,
  WORK_SCOPE_REPAIR_GRAPH,
} from '../../scripts/qa/integration-reset.ts';
import { commandOnlyIntegrationFiles } from '../../scripts/qa/isolated-integration-files.ts';
import { qaStackEnvironment, scaleIntegrationFiles } from '../../scripts/qa/stack-environment.ts';

const root = resolve(import.meta.dir, '../..');
const scratch = join(root, '.temp');
mkdirSync(scratch, { recursive: true });
const suite = (file: string) =>
  `<testsuite name="${file}" file="${file}"><testcase name="one" file="${file}" time="1" /></testsuite>`;

test('G-955: integration balances all files onto bounded reusable stacks and preserves fresh-state boundaries', () => {
  const dedicated = new Set([
    ...commandOnlyIntegrationFiles,
    ...integrationResourceClasses.keys(),
    ...scaleIntegrationFiles,
    'tests/qa/integration/g-854-large-library.test.ts',
    'tests/qa/integration/g-852-zones.test.ts',
    'tests/qa/integration/g-556-ranked-large.test.ts',
    'tests/qa/integration/g-939-discovery.test.ts',
  ]);
  const fresh = [...isolatedIntegrationFiles].filter((file) => !dedicated.has(file)).slice(0, 15);
  const estimates = new Map([
    ...Array.from({ length: 24 }, (_, index) => [`shared-${index}.test.ts`, 30_000] as const),
    ...fresh.map((file) => [file, 20_000] as const),
    ...[...dedicated].map((file) => [file, 40_000] as const),
  ]);
  const plan = planIntegrationShards(estimates, 6);
  expect(plan).toHaveLength(6 + dedicated.size);
  expect(plan.flatMap((shard) => shard.files).sort()).toEqual([...estimates.keys()].sort());
  expect(planIntegrationShards(new Map([...estimates].reverse()), 6)).toEqual(plan);
  for (const shard of plan) {
    expect(shard.batches.flat().sort()).toEqual(shard.files);
    for (const batch of shard.batches) {
      if (batch.some((file) => isolatedIntegrationFiles.has(file))) expect(batch).toHaveLength(1);
    }
  }
  const totals = plan
    .slice(0, 6)
    .map((shard) => shard.files.reduce((sum, file) => sum + estimates.get(file)!, 0));
  expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(30_000);
  expect(plan.slice(6)).toEqual(
    [...dedicated]
      .sort()
      .map((file) => ({
        files: [file],
        batches: [[file]],
        resourceClass: integrationResourceClasses.get(file) ?? 'ordinary',
      })),
  );
});

test('G-955: fresh SQL state clones all four retained templates without modifying them', () => {
  expect(integrationOwnerResetStatements).toHaveLength(8);
  for (const owner of ['account', 'access', 'content', 'relay']) {
    expect(integrationOwnerResetStatements).toContain(`DROP DATABASE ${owner} WITH (FORCE)`);
    expect(integrationOwnerResetStatements).toContain(
      `CREATE DATABASE ${owner} WITH TEMPLATE ${owner}_tpl OWNER ${owner}`,
    );
  }
  expect(integrationOwnerResetStatements.some((sql) => /^DROP DATABASE \w+_tpl/.test(sql))).toBe(
    false,
  );
});

test('G-955: isolated batches get fresh lineage and bytes only after owner and graph reset succeed', async () => {
  const directory = mkdtempSync(join(scratch, 'g-955-reset-'));
  const objects = join(directory, 'objects'),
    candidates = join(directory, 'candidates');
  mkdirSync(objects);
  mkdirSync(candidates);
  writeFileSync(join(objects, 'prior-revision'), 'retained by prior file');
  writeFileSync(join(candidates, 'prior-candidate'), 'private candidate');
  const apps = {
    MAIN_OBJECT_DIRECTORY: objects,
    MAIN_CANDIDATE_DIRECTORY: candidates,
    MAIN_DATA_EPOCH: 'before',
    MAIN_ROUTING_EPOCH: 'before-route',
    FUSEKI_URL: 'same-stack',
  };
  const calls: string[] = [];
  try {
    await expect(
      resetIntegrationState(
        apps,
        {},
        {
          owners: async () => {
            throw new Error('owner reset failed');
          },
          graph: async () => {
            calls.push('graph');
          },
        },
      ),
    ).rejects.toThrow('owner reset failed');
    expect(calls).toEqual([]);
    expect(readFileSync(join(objects, 'prior-revision'), 'utf8')).toBe('retained by prior file');
    const next = await resetIntegrationState(
      apps,
      {},
      {
        owners: async () => {
          calls.push('owners');
        },
        graph: async (_apps, lineage) => {
          calls.push('graph');
          expect(lineage.dataEpoch).not.toBe('before');
          expect(readFileSync(join(objects, 'prior-revision'), 'utf8')).toBe(
            'retained by prior file',
          );
        },
      },
    );
    expect(calls).toEqual(['owners', 'graph']);
    expect(next.MAIN_DATA_EPOCH).not.toBe(apps.MAIN_DATA_EPOCH);
    expect(next.MAIN_ROUTING_EPOCH).not.toBe(apps.MAIN_ROUTING_EPOCH);
    expect(next.FUSEKI_URL).toBe(apps.FUSEKI_URL);
    expect(readdirSync(objects)).toEqual([]);
    expect(existsSync(candidates)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G-955: timeouts and setup failures report every unobserved file as a JUnit failure', () => {
  const files = ['a.test.ts', 'b.test.ts', 'c.test.ts'];
  const partial = completeFileResults(suite(files[0]!), files, 'integration', {
    interrupted: true,
  });
  expect(partial.missing).toEqual(['b.test.ts', 'c.test.ts']);
  const tests = parseJUnit(partial.xml, 'integration');
  expect(tests.map((item) => [item.file, item.failed])).toEqual([
    ['a.test.ts', false],
    ['b.test.ts', true],
    ['c.test.ts', true],
  ]);
  expect(
    parseJUnit(completeFileResults('', files, 'integration').xml, 'integration').every(
      (item) => item.failed,
    ),
  ).toBe(true);
  expect(
    completeFileResults(suite('a.test.ts'), files, 'integration', { filtered: true }).missing,
  ).toEqual([]);
  expect(
    completeFileResults('', files, 'integration', { filtered: true, interrupted: true }).missing,
  ).toEqual(files);
  const escaped = completeFileResults('', ['a&b.test.ts'], 'integration', {
    reason: 'missing "proof" & reporter',
  });
  expect(parseJUnit(escaped.xml, 'integration')[0]!.file).toBe('a&b.test.ts');
});

test('G-955: failed-only diagnosis reruns unexecuted files without an invented title filter', () => {
  const file = 'tests/qa/integration/also-enjoyed.test.ts';
  expect(
    testArgs('integration', {
      sourceRunId: 'prior',
      tiers: ['integration'],
      tests: [
        {
          file,
          name: UNEXECUTED_FILE_TEST,
          tier: 'integration',
          failed: true,
          skipped: false,
        },
      ],
    }),
  ).toEqual([file]);
  expect(testArgs('unit', undefined, { files: ['tests/qa/g-955-harness.test.ts'] })).toEqual([
    'tests/qa/g-955-harness.test.ts',
  ]);
});

test('G-955: a killed last file and files with only skipped cases cannot look completed', () => {
  const output =
    'a.test.ts:\n(pass) one [1ms]\n\nb.test.ts:\n(pass) earlier case [1ms]\nbun timed out';
  expect(lastStartedTestFile(output)).toBe('b.test.ts');
  const result = completeFileResults(
    suite('a.test.ts') + suite('b.test.ts'),
    ['a.test.ts', 'b.test.ts'],
    'integration',
    { interrupted: true, incompleteFiles: [lastStartedTestFile(output)!] },
  );
  expect(result.missing).toEqual(['b.test.ts']);
  expect(
    parseJUnit(result.xml, 'integration')
      .filter((test) => test.file === 'b.test.ts')
      .some((test) => test.failed),
  ).toBe(true);
  const skipped =
    '<testsuite file="a.test.ts"><testcase name="pending" file="a.test.ts"><skipped /></testcase></testsuite>';
  expect(completeFileResults(skipped, ['a.test.ts'], 'integration').missing).toEqual(['a.test.ts']);
});

test('G-955: source hashing streams beyond the former 64 MiB limit and hashes quoted untracked names', () => {
  const directory = mkdtempSync(join(scratch, 'g-955-source-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
  try {
    git(['init', '--quiet']);
    writeFileSync(join(directory, 'contract.json'), 'initial\n');
    git(['add', 'contract.json']);
    git([
      '-c',
      'user.name=QA fixture',
      '-c',
      'user.email=qa@example.test',
      'commit',
      '--quiet',
      '-m',
      'initial',
    ]);
    const initial = sourceIdentity(directory);
    const large = 'generated schema row\n'.repeat(3_400_000);
    expect(Buffer.byteLength(large)).toBeGreaterThan(64 * 1024 * 1024);
    writeFileSync(join(directory, 'contract.json'), large);
    const changed = sourceIdentity(directory);
    expect(changed.clean).toBe(false);
    expect(changed.fingerprint).not.toBe(initial.fingerprint);
    writeFileSync(join(directory, 'contract.json'), `${large}tail changed\n`);
    expect(sourceIdentity(directory).fingerprint).not.toBe(changed.fingerprint);
    writeFileSync(join(directory, 'contract.json'), 'initial\n');
    expect(sourceIdentity(directory)).toEqual(initial);
    const untracked = join(directory, 'a "quoted" name\n.test');
    writeFileSync(untracked, 'first');
    const one = sourceIdentity(directory);
    writeFileSync(untracked, 'second');
    expect(sourceIdentity(directory).fingerprint).not.toBe(one.fingerprint);
    writeFileSync(join(directory, '?? original'), 'tracked rename');
    git(['add', '?? original']);
    git([
      '-c',
      'user.name=QA fixture',
      '-c',
      'user.email=qa@example.test',
      'commit',
      '--quiet',
      '-m',
      'rename fixture',
    ]);
    git(['mv', '?? original', 'renamed.txt']);
    expect(sourceIdentity(directory).clean).toBe(false);
    expect(readdirSync(join(directory, '.temp'))).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);

test('G-955: successful single-file command durations include setup hooks in later shard plans', () => {
  const directory = mkdtempSync(join(scratch, 'g-955-history-'));
  try {
    const run = join(directory, '20261003t000000-aaaaaa');
    mkdirSync(join(run, 'logs'), { recursive: true });
    writeFileSync(join(run, 'integration.xml'), suite('a.test.ts'));
    writeFileSync(
      join(run, 'logs', 'integration-1-durations.json'),
      JSON.stringify({ 'a.test.ts': 25_000, 'b.test.ts': 33_000 }),
    );
    expect(Object.fromEntries(recordedFileDurations([directory], 'integration'))).toEqual({
      'a.test.ts': 25_000,
      'b.test.ts': 33_000,
    });
    writeFileSync(join(run, 'logs', 'integration-1-durations.json'), '{interrupted');
    expect(recordedFileDurations([directory], 'integration').get('a.test.ts')).toBe(1_000);
    writeFileSync(
      join(run, 'acceptance.json'),
      JSON.stringify({
        tiers: [
          {
            name: 'integration',
            shards: [
              { stage: 'stack', files: ['failed.test.ts'] },
              { stage: 'test', files: ['a.test.ts'] },
            ],
          },
        ],
      }),
    );
    writeFileSync(join(run, 'integration.xml'), suite('a.test.ts') + suite('failed.test.ts'));
    expect(Object.fromEntries(recordedFileDurations([directory], 'integration'))).toEqual({
      'a.test.ts': 1_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G-955: retained small backups are reused and absent/incompatible backups are built once within preparation time', async () => {
  const manifest = { id: 'fx-small-aaaaaaaaaaaa' } as FixtureManifest;
  let now = 1_000,
    builds = 0;
  const deps = {
    now: () => now,
    retained: () => undefined as FixtureManifest | undefined,
    build: async (profile: string, seed?: string, budget?: number) => {
      expect(profile).toBe('small');
      expect(seed).toBe('rezics-background-v1');
      expect(budget).toBe(600_000);
      builds++;
      now += 150_000;
      return manifest;
    },
  };
  expect(await prepareFixture('small', undefined, deps)).toEqual({
    fixture: manifest.id,
    profile: 'small',
    built: true,
    elapsedMs: 150_000,
    admissionWaitMs: 0,
    deadlineMs: 600_000,
  });
  expect(builds).toBe(1);
  expect(
    (await prepareFixture('small', undefined, { ...deps, retained: () => manifest })).built,
  ).toBe(false);
  expect(builds).toBe(1);
  await expect(
    prepareFixture('small', undefined, {
      ...deps,
      build: async () => {
        now += 600_001;
        return manifest;
      },
    }),
  ).rejects.toThrow('600 seconds');
  await expect(
    prepareFixture('small', undefined, {
      ...deps,
      build: async () => {
        throw new Error('owner load failed');
      },
    }),
  ).rejects.toThrow('owner load failed');
});

test('G-955: a file that imports other test files runs in its own process, so neither loses its tests', () => {
  const directory = join(root, 'tests/qa/integration');
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.test.ts'))) {
    if (!/['"]\.\/[\w-]+\.test\.ts['"]/.test(readFileSync(join(directory, name), 'utf8'))) continue;
    const file = `tests/qa/integration/${name}`;
    // Heavy files already own a project, and so a process, of their own.
    const own = isolatedIntegrationFiles.has(file) || integrationResourceClasses.has(file);
    expect([name, own]).toEqual([name, true]);
  }
});

test('G-955: a file that writes synthetic outbox batches gets a fresh project, so later relays see only real ones', () => {
  const directory = join(root, 'tests/qa/integration');
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.test.ts'))) {
    if (!/a rv:OutboxBatch/.test(readFileSync(join(directory, name), 'utf8'))) continue;
    const file = `tests/qa/integration/${name}`;
    const own = isolatedIntegrationFiles.has(file) || integrationResourceClasses.has(file);
    expect([name, own]).toEqual([name, true]);
  }
});

test('G-955: a file that drops owner schemas gets a fresh project, so later files keep migrated owners', () => {
  const directory = join(root, 'tests/qa/integration');
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.test.ts'))) {
    const source = readFileSync(join(directory, name), 'utf8');
    if (/DROP SCHEMA/.test(source) && /'(access|relay|content|account)'/.test(source))
      expect([name, isolatedIntegrationFiles.has(`tests/qa/integration/${name}`)]).toEqual([name, true]);
  }
});

test('G-955: queued fault/recovery projects get a wall deadline their own budgets can meet', () => {
  // The whole fault tier (40 projects of 360 s on two slots) passed in 1,091 s against a flat 360 s.
  const fault = queuedProjectsBudget(Array.from({ length: 40 }, () => 360_000), 2);
  expect(fault).toBeGreaterThan(1_091_000);
  expect(queuedProjectsBudget([360_000], 2)).toBe(360_000);
  expect(queuedProjectsBudget([360_000, 360_000], 4)).toBeGreaterThanOrEqual(360_000);
  expect(queuedProjectsBudget(Array.from({ length: 4 }, () => 360_000), 2)).toBeLessThan(fault);
  expect(() => queuedProjectsBudget([360_000], 0)).toThrow('Invalid QA slot count');
});

test('G-955: a file that imports a heavy integration file runs in that file\'s resource class', () => {
  const directory = join(root, 'tests/qa/integration');
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.test.ts'))) {
    const file = `tests/qa/integration/${name}`;
    const imported = [...readFileSync(join(directory, name), 'utf8')
      .matchAll(/^import '\.\/([\w-]+\.test\.ts)';$/gm)].map((match) => `tests/qa/integration/${match[1]}`);
    for (const heavy of imported.filter((path) => integrationResourceClasses.has(path)))
      expect([file, integrationResourceClasses.get(file)]).toEqual([file, integrationResourceClasses.get(heavy)]);
  }
});

test('G-955: all QA stacks inherit heap/direct-memory settings below their container limit', () => {
  const env = qaStackEnvironment({
    REZICS_FUSEKI_MEMORY_LIMIT: '7g',
    REZICS_FUSEKI_JVM_ARGS: '-Xmx1536m',
  });
  expect(env.REZICS_FUSEKI_MEMORY_LIMIT).toBe('2g');
  expect(env.REZICS_FUSEKI_JVM_ARGS).toBe('-Xms64m -Xmx512m -XX:MaxDirectMemorySize=128m');
  const override = qaStackEnvironment({
    REZICS_QA_FUSEKI_MEMORY_LIMIT: '3g',
    REZICS_QA_FUSEKI_JVM_ARGS: '-Xmx1g',
  });
  expect(override.REZICS_FUSEKI_MEMORY_LIMIT).toBe('3g');
  expect(override.REZICS_FUSEKI_JVM_ARGS).toBe('-Xmx1g');
  const compose = readFileSync(join(root, 'infra/dev/compose.qa.yaml'), 'utf8');
  expect(compose).toContain('mem_limit: ${REZICS_FUSEKI_MEMORY_LIMIT:-2g}');
  expect(compose).toContain(
    'JVM_ARGS: ${REZICS_FUSEKI_JVM_ARGS:--Xms64m -Xmx512m -XX:MaxDirectMemorySize=128m}',
  );
  expect(existsSync(join(root, '.temp'))).toBe(true);
});

test('repair state left by one file is absent when the next file starts', async () => {
  const maintenance = 'ab'.repeat(32);
  const command = 'cd'.repeat(32);
  const repair = WORK_SCOPE_REPAIR_GRAPH;
  const subject = 'urn:rezics:title-candidate:previous-file';
  const predicates = [
    'https://rezics.com/vocab/repairCursor',
    'https://rezics.com/vocab/labelCopyPhase',
    'https://rezics.com/vocab/labelCopyStep',
    'https://rezics.com/vocab/labelCopyGeneration',
    'https://rezics.com/vocab/retainedTitleCandidate',
  ];
  let quads = [
    ...predicates.map((predicate) => ({ graph: repair, predicate })),
    { graph: 'urn:rezics:graph:current', predicate: 'https://rezics.com/vocab/publicTitle' },
  ];
  let updates = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/update')) {
        updates += 1;
        return new Response('raw maintenance cannot remove the server-owned Work scope proof graph', { status: 400 });
      }
      if (path.endsWith('/query')) {
        const query = await request.text();
        const graph = query.includes(repair) ? repair : 'urn:rezics:graph:current';
        const bindings = quads.filter((quad) => quad.graph === graph).map((quad) => ({
          s: { type: 'uri', value: subject },
          p: { type: 'uri', value: quad.predicate },
          o: { type: 'literal', value: 'left-by-the-previous-file' },
        }));
        return Response.json({ head: { vars: ['s', 'p', 'o'] }, results: { bindings } });
      }
      if (!path.endsWith('/command')) return new Response('not found', { status: 404 });
      const authorization = request.headers.get('authorization');
      const body = await request.json() as { datasetReset?: unknown };
      if (authorization !== `Bearer ${maintenance}` || body.datasetReset === undefined
        || JSON.stringify(body) !== '{"datasetReset":{}}') {
        return Response.json({ status: 'forbidden' }, { status: 403 });
      }
      quads = [];
      return Response.json({ status: 'reset' });
    },
  });
  try {
    const fuseki = new FusekiClient(`http://127.0.0.1:${server.port}/data/`, maintenance, command);
    const ask = `SELECT ?p WHERE { GRAPH <${repair}> { ?s ?p ?o } }`;
    const left = await fuseki.query(ask);
    expect(left.results?.bindings.map((binding) => binding.p?.value).sort()).toEqual([...predicates].sort());
    await expect(new FusekiClient(`http://127.0.0.1:${server.port}/data/`, undefined, command).resetDataset())
      .rejects.toThrow('Fuseki maintenance capability is required');
    await expect(new FusekiClient(`http://127.0.0.1:${server.port}/data/`, command, command).resetDataset())
      .rejects.toThrow('Fuseki dataset reset capability rejected');
    expect(quads).toHaveLength(predicates.length + 1);
    await clearIntegrationDataset(fuseki);
    const next = await fuseki.query(ask);
    expect(next.results?.bindings ?? []).toEqual([]);
    const current = await fuseki.query('SELECT ?s WHERE { GRAPH <urn:rezics:graph:current> { ?s ?p ?o } }');
    expect(current.results?.bindings ?? []).toEqual([]);
    expect(updates).toBe(0);
    const source = readFileSync(join(root, 'scripts/qa/integration-reset.ts'), 'utf8');
    expect(source).toContain('clearIntegrationDataset');
    expect(source).not.toContain('CLEAR ALL');
    expect(source).not.toContain('.update(');
  } finally {
    await server.stop(true);
  }
});

test('a broken integration reset names the stack and keeps the file that already passed', () => {
  const passed = 'tests/qa/integration/g-896-content-sequence.test.ts';
  const pending = 'tests/qa/integration/g-894-progress-summary.test.ts';
  const stack = 'rezics-qa-20261008t183626-c1e5d6-1';
  const failure = integrationResetHarnessFailure({ stack, pendingFiles: [pending] });
  expect(failure.failedFiles).toEqual([]);
  expect(failure.message).toContain(`on stack ${stack}`);
  expect(failure.message).not.toContain(passed);
  expect(integrationResetHarnessFailure({ stack, pendingFiles: [pending], timedOut: true }).message)
    .toContain('timed out');
  const kept = filesKeptAfterResetFailure([passed, pending], [pending]);
  expect(kept).toEqual([passed]);
  const results = completeFileResults(suite(passed), kept, 'integration');
  expect(results.missing).toEqual([]);
  expect(parseJUnit(results.xml, 'integration').map((item) => [item.file, item.failed])).toEqual([
    [passed, false],
  ]);
  const cli = readFileSync(join(root, 'scripts/qa/cli.ts'), 'utf8');
  expect(cli).toContain('integrationResetHarnessFailure');
  expect(cli).toContain('filesKeptAfterResetFailure');
});

test('G-955: shard claims respect goalctl default capacity instead of inventing five extra slots', async () => {
  const directory = mkdtempSync(join(scratch, 'g-955-slots-'));
  try {
    const slots = await acquireQaSlots(directory, 8, {});
    expect(slots.count).toBe(3);
    expect(readdirSync(directory).sort()).toEqual(['0', '1', '2']);
    slots.release();
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
