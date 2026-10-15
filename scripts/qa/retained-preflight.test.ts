import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from '../fixture/corpus.ts';
import { retainedRuntimeFacts } from '../fixture/runtime-facts.ts';
import { preflightRetainedSources, retainedPreflightSummary } from './retained-preflight.ts';
import { retainedRequirementKinds } from './retained-requirements.ts';
import { RetainedSources, sourceKey, type RetainedSourceAdapter } from './retained-source.ts';
import { dispatchTest } from './test.ts';

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
