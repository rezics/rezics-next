import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from '../fixture/corpus.ts';
import { retainedRuntimeFacts } from '../fixture/runtime-facts.ts';
import { preflightRetainedSources, retainedPreflightSummary } from './retained-preflight.ts';
import { retainedRequirementKinds, retainedRequirements } from './retained-requirements.ts';
import { RetainedSources, sourceKey, type RetainedSourceAdapter } from './retained-source.ts';
import { dispatchTest } from './test.ts';
import { needsRealmDiscussionSource, smallRecoveryFixtureConsumers } from './preparation-selection.ts';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dir, '../..');
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp/preflight-'));
  temporary.push(directory);
  let builds = 0, restores = 0;
  const adapter: RetainedSourceAdapter<{ ready: boolean }, never> = {
    specification: { producer: 'synthetic-source', version: '1', files: { producer: sha256('producer') },
      inputs: {}, compatibility: { image: 'pinned-image' } },
    async build(context) {
      builds++;
      writeFileSync(join(context.backup, 'owners'), 'complete backup');
      return { metadata: { ready: true }, rdfDigest: sha256('rdf'), ownerState: {},
        producerRevision: 'frozen-revision', qaIdentity: 'synthetic', phases: {} };
    },
    async verify() { return []; },
    async restore() { restores++; throw new Error('must not restore'); },
    async dispose() {}, async remove() {},
  };
  const sources = join(directory, 'sources'), store = new RetainedSources(sources);
  return { directory, sources, adapter, store, counts: () => ({ builds, restores }),
    report: () => preflightRetainedSources(root, [], [{ source: 'synthetic', build: 'task fixture:build -- --profile small',
      check: async () => (await store.preflight(adapter)).key }]) };
}

for (const kind of ['missing build', 'stale key', 'missing manifest', 'missing backup', 'collation drift', 'changed backup'] as const) {
  test(`${kind} refuses before the first test with the exact source and repair`, async () => {
    const f = fixture();
    if (kind !== 'missing build') await f.store.prepare(f.adapter);
    const source = join(f.sources, sourceKey(f.adapter.specification));
    if (kind === 'stale key') f.adapter.specification.files.producer = sha256('new frozen producer');
    if (kind === 'missing manifest') rmSync(join(source, 'manifest.json'));
    if (kind === 'missing backup') rmSync(join(source, 'backup'), { recursive: true });
    if (kind === 'changed backup') writeFileSync(join(source, 'backup/owners'), 'corrupt');
    if (kind === 'collation drift') {
      const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
      manifest.provenance.runtime.collation = 'glibc 2.41';
      writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest));
    }
    const before = f.counts();
    const result = await f.report();
    expect(result.ok).toBe(false);
    const message = retainedPreflightSummary(result);
    expect(message).toContain('synthetic');
    expect(message).toContain('Build/repair: task fixture:build -- --profile small');
    expect(message).toContain(kind === 'missing build' ? 'build is missing' : kind === 'missing manifest' ? 'manifest is missing'
      : kind === 'stale key' ? 'stale key: expected' : kind === 'collation drift' ? 'recorded glibc 2.41'
        : kind === 'missing backup' ? 'inventory refused' : 'backup file changed: owners');
    let tests = 0;
    await expect(dispatchTest(['scripts/qa/retained-preflight.test.ts'], {
      retainedPreflight: async () => { throw new Error(message); },
      runner: async () => { tests++; return 0; },
    })).rejects.toThrow(message);
    expect(tests).toBe(0);
    expect(f.counts()).toEqual(before);
    expect(result.elapsedMs).toBeLessThan(3_000);
  });
}

test('complete custody passes read-only in under three seconds', async () => {
  const f = fixture();
  await f.store.prepare(f.adapter);
  const names = readdirSync(f.sources);
  const result = await f.report();
  expect(result.ok).toBe(true);
  expect(result.sources[0]!.key).toBe(sourceKey(f.adapter.specification));
  expect(result.elapsedMs).toBeLessThan(3_000);
  expect(readdirSync(f.sources)).toEqual(names);
  expect(f.counts()).toEqual({ builds: 1, restores: 0 });
});

test('explicit BUILD replaces runtime-stale custody instead of reusing a refused source', async () => {
  const f = fixture();
  await f.store.prepare(f.adapter);
  const path = join(f.sources, sourceKey(f.adapter.specification), 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.provenance.runtime.postgres = 'old server';
  writeFileSync(path, JSON.stringify(manifest));
  expect((await f.report()).ok).toBe(false);
  expect((await f.store.prepare(f.adapter)).built).toBe(true);
  expect((await f.report()).ok).toBe(true);
  expect(f.counts()).toEqual({ builds: 2, restores: 0 });
});

test('database collation drift is refused even when the build host is unchanged', async () => {
  const f = fixture(), original = f.adapter.build;
  f.adapter.build = async context => {
    writeFileSync(join(context.backup, 'postgres-collations.json'), JSON.stringify([{ database: 'access', version: '0.01' }]));
    return original(context);
  };
  await f.store.prepare(f.adapter);
  expect(retainedPreflightSummary(await f.report())).toContain('database access, recorded 0.01, host');
  expect(retainedRuntimeFacts().collation).toContain('glibc');
});

test('selection discovers retained APIs through helpers without executing persona modules', () => {
  const write = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text);
  };
  const f = fixture();
  write(join(f.directory, 'tests/qa/integration/one.test.ts'), `throw new Error('test must not start');
    import './helper.ts';`);
  write(join(f.directory, 'tests/qa/integration/helper.ts'), `export { realmDiscussionSource } from '../support/realm-discussion-source.ts';`);
  write(join(f.directory, 'tests/qa/support/realm-discussion-source.ts'), `throw new Error('must not evaluate');`);
  expect(retainedRequirementKinds(f.directory, ['tests/qa/integration/one.test.ts'])).toEqual(['realm']);
  expect(retainedRequirements(f.directory, ['tests/qa/integration/one.test.ts'])[0]!.preparedByRun).toBeUndefined();
  expect(retainedRequirementKinds(root, ['tests/qa/integration/outcomes/realm/ranking.test.ts'])).toEqual(['realm']);
  expect(retainedRequirementKinds(root, ['tests/qa/integration/library-growth.test.ts'])).toEqual(['seed']);
  expect(retainedRequirementKinds(root, ['tests/qa/fault-recovery/work-profile-seed-build.test.ts'])).toEqual([]);
  expect(retainedRequirementKinds(root, ['tests/qa/fault-recovery/g-727-launch-drill.test.ts'])).toContain('fixture-small');
});

test('all selected sources report failures before dispatch can begin', async () => {
  const visited: string[] = [];
  const result = await preflightRetainedSources(root, [], ['one', 'two'].map(source => ({ source,
    build: `task build-${source}`, check() { visited.push(source); throw new Error(`${source} absent`); } })));
  expect(visited).toEqual(['one', 'two']);
  expect(result.sources.map(source => source.reason)).toEqual(['one absent', 'two absent']);
});

test('run-prepared sources are reported without checking absent custody', async () => {
  const requirement = retainedRequirements(root, ['tests/qa/fault-recovery/erasure-campaign-qualification.test.ts'])
    .find(item => item.source === 'fixture-small')!;
  expect(requirement.preparedByRun).toContain('before fault/recovery shards');
  let checked = false;
  const result = await preflightRetainedSources(root, [], [{ ...requirement,
    check() { checked = true; throw new Error('missing custody'); } }]);
  expect(result.ok).toBe(true);
  expect(checked).toBe(false);
  expect(retainedPreflightSummary(result)).toContain('fixture-small: prepared by run:');
});

test('a standalone ranking confirmation declares its source preparation before custody preflight', async () => {
  const files = ['tests/qa/integration/outcomes/realm/ranking.test.ts'];
  const requirements = retainedRequirements(root, files);
  expect(requirements).toHaveLength(1);
  expect(requirements[0]!.source).toBe('realm');
  expect(requirements[0]!.preparedByRun).toContain('before integration shards');
  let checks = 0;
  const result = await preflightRetainedSources(root, files, requirements.map(requirement => ({
    ...requirement,
    check() { checks++; throw new Error('missing custody before producer runs'); },
  })));
  expect(result.ok).toBe(true);
  expect(checks).toBe(0);
  expect(retainedPreflightSummary(result)).toContain('realm: prepared by run:');
});

const selectedFiles = [...new Bun.Glob('tests/qa/{integration,fault-recovery}/**/*.test.ts').scanSync({ cwd: root })].sort();

test('every run-prepared fixture passes preflight without pre-existing custody', async () => {
  const covered = new Set<string>();
  for (const file of selectedFiles) {
    const sources = [
      ...(Object.values(smallRecoveryFixtureConsumers([file], {})).some(Boolean) ? ['fixture-small'] : []),
      ...(needsRealmDiscussionSource([file]) ? ['realm'] : []),
    ];
    for (const source of sources) {
      const requirement = retainedRequirements(root, [file]).find(item => item.source === source);
      // A producer selected alone needs no retained data at all.
      if (!requirement && file === 'tests/qa/integration/realm-discussion-source.test.ts') continue;
      expect(requirement, `${file}: ${source}`).toBeDefined();
      expect(requirement!.preparedByRun, `${file}: ${source}`).toBeTruthy();
      let checks = 0;
      const report = await preflightRetainedSources(root, [file], [{ ...requirement!,
        check() { checks++; throw new Error('no custody exists before the run prepares it'); } }]);
      expect(report.ok, retainedPreflightSummary(report)).toBe(true);
      expect(checks).toBe(0);
      covered.add(source);
    }
  }
  expect([...covered].sort()).toEqual(['fixture-small', 'realm']);
});

// Only the expensive corpus producer is replaced. Task, CLI parsing and
// admission run unchanged, and publication/preflight use the real custody API.
const repairProducers: Record<string, { file: string; args: string[] }> = {
  owner: { file: 'tests/qa/fault-recovery/owner-restore-erasure-fixture.ts',
    args: ['--prepare-retained-source', '--evidence', '.temp/retained-source-owner.json'] },
  'owner-later': { file: 'tests/qa/fault-recovery/owner-restore-erasure-fixture.ts',
    args: ['--prepare-retained-source', '--evidence', '.temp/retained-source-owner-later.json', '--later-api-admission'] },
  'independent-recipe': { file: 'tests/qa/fault-recovery/independent-restore-support.ts',
    args: ['--prepare-retained-source', '--evidence', '.temp/retained-source-independent-recipe.json', '--recipe'] },
  'independent-authority': { file: 'tests/qa/fault-recovery/independent-restore-support.ts',
    args: ['--prepare-retained-source', '--evidence', '.temp/retained-source-independent-authority.json'] },
  'fixture-small': { file: 'scripts/fixture/cli.ts', args: ['build', '--profile', 'small'] },
  realm: { file: 'scripts/qa/test.ts', args: ['tests/qa/integration/realm-discussion-source.test.ts'] },
  seed: { file: 'scripts/qa/test.ts', args: ['tests/qa/fault-recovery/work-profile-seed-build.test.ts'] },
  content: { file: 'scripts/qa/test.ts', args: ['tests/qa/fault-recovery/retained-content-source-preparation.test.ts'] },
  audit: { file: 'scripts/qa/fixtures/audit-corpus.ts', args: ['prepare', '.temp/audit-corpus/recipe.json'] },
};
const repairRequirements = new Map(selectedFiles.flatMap(file => retainedRequirements(root, [file]))
  .map(requirement => [requirement.source, requirement]));

test('every retained source repair route has an executable canary', () => {
  expect([...repairRequirements.keys()].sort()).toEqual(Object.keys(repairProducers).sort());
});

for (const [source, producer] of Object.entries(repairProducers)) test(`printed ${source} repair runs and publishes ready custody`, async () => {
  const f = fixture();
  const producerPath = join(f.directory, producer.file);
  mkdirSync(join(producerPath, '..'), { recursive: true });
  expect(spawnSync('git', ['init', '-q', f.directory]).status).toBe(0);
  mkdirSync(join(f.directory, '.goalctl'));
  writeFileSync(join(f.directory, '.goalctl/settings.user.json'), '{"version":1}');
  if (producer.file !== 'scripts/qa/test.ts') {
    mkdirSync(join(f.directory, 'scripts/qa'), { recursive: true });
    writeFileSync(join(f.directory, 'scripts/qa/test.ts'), `
      import { dispatchTest } from ${JSON.stringify(join(root, 'scripts/qa/test.ts'))};
      process.exitCode = await dispatchTest(process.argv.slice(2));
    `);
  }
  writeFileSync(producerPath, `
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { RetainedSources } from ${JSON.stringify(join(root, 'scripts/qa/retained-source.ts'))};
    const args = process.argv.slice(2);
    if (JSON.stringify(args) !== ${JSON.stringify(JSON.stringify(producer.args))}) throw new Error('not the expected producer command: ' + JSON.stringify(args));
    const result = await new RetainedSources(${JSON.stringify(f.sources)}).prepare({
      specification: ${JSON.stringify(f.adapter.specification)},
      async build(context) {
        writeFileSync(join(context.backup, 'owners'), 'complete backup');
        return { metadata: { ready: true }, rdfDigest: ${JSON.stringify(sha256('rdf'))}, ownerState: {},
          producerRevision: 'frozen-revision', qaIdentity: 'synthetic', phases: {} };
      },
      async verify() { return []; }, async restore() { throw new Error('must not restore'); },
      async dispose() {}, async remove() {},
    });
    if (args.includes('--evidence')) writeFileSync(args[args.indexOf('--evidence') + 1], JSON.stringify(result));
  `);
  // The synthetic checkout supplies only the expensive producer. Task and the
  // goal command, including its slot selection, execute the production code.
  writeFileSync(join(f.directory, 'Taskfile.yml'), `version: '3'\ntasks:\n  goal:\n    cmds:\n      - '${process.execPath} ${join(root, 'scripts/goal/goalctl.ts')} {{.CLI_ARGS}}'\n`);
  const repair = repairRequirements.get(source)!.build;
  const refused = await preflightRetainedSources(root, [], [{ source, build: repair,
    check: async () => (await f.store.preflight(f.adapter)).key }]);
  expect(refused.ok).toBe(false);
  const command = retainedPreflightSummary(refused).split('Build/repair: ')[1]!.trim();
  // Repair routes simulate program authority in this synthetic checkout,
  // independently of the worker or manager running the canary.
  const child = Bun.spawn(command.split(' '), { cwd: f.directory, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, GOAL_ID: 'program', GOAL_SETTINGS_DIRECTORY: join(f.directory, '.goalctl'),
      GOAL_TURN_TOKEN: '', GOAL_TURN_STATE_DIR: '', GOAL_TASK_ID: '', GOAL_IN_SLOT: '1', GOAL_QA_HEAVY_RUN: '0' } });
  const [code, stdout, stderr] = await Promise.all([child.exited,
    new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, output: stdout + stderr }).toEqual({ code: 0, output: expect.any(String) });
  expect((await f.report()).ok).toBe(true);
}, 30_000);
