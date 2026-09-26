import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareComponent } from '../../../services/main/src/modules/work/activate.ts';
import { fixtureCorpus, fixtureUuid, mainComponentState, workAt,
  workComponentState } from '../../../scripts/fixture/corpus.ts';
import { type FixtureManifestCore, manifestCore, manifestIdentity,
  restoreCompatibility } from '../../../scripts/fixture/manifest.ts';
import { fixtureOwners } from '../../../scripts/fixture/owners/index.ts';
import { componentObjects } from '../../../scripts/fixture/owners/objects.ts';

const root = resolve(import.meta.dir, '../../..');
const engines = {
  fuseki: { image: 'rezics/fuseki:6.2.0-cmd0.5.29-000000000000', id: `sha256:${'1'.repeat(64)}` },
  postgres: { image: `postgres:18.6-trixie@sha256:${'2'.repeat(64)}`, id: `sha256:${'3'.repeat(64)}` },
  rustfs: { image: `rustfs/rustfs:1.0.0@sha256:${'4'.repeat(64)}`, id: `sha256:${'5'.repeat(64)}` },
};
const core = (seed?: string) => manifestCore(root, fixtureCorpus('small', seed), fixtureOwners, engines);
const current = (manifest: FixtureManifestCore) => ({ owners: manifest.owners,
  migrations: { ...manifest.migrations }, engines: structuredClone(manifest.engines) });

test('fixture: the same seed and profile give the same manifest digest and fixture ID', () => {
  const first = core();
  const second = core();
  expect(manifestIdentity(second)).toEqual(manifestIdentity(first));
  expect(first.entities).toEqual({ works: 1_000, agents: 10 });
  expect(first.owners.graph!.counts).toEqual({ 'graph:current': 9_584, 'graph:revisions': 18_000 });
  expect(first.owners.objects!.counts).toEqual({ object: 4_000 });
  expect(first.owners.access!.counts).toEqual({ 'access.authority_subject': 10,
    'access.permission_grant': 1_000, 'access.scope_gate': 1_000 });
  const other = core('another-seed');
  expect(manifestIdentity(other).digest).not.toBe(manifestIdentity(first).digest);
  expect(other.owners.graph!.digest).not.toBe(first.owners.graph!.digest);
  expect(other.lineage).not.toEqual(first.lineage);
});

test('fixture: identities are deterministic version-8 UUIDs and never collide across kinds', () => {
  expect(fixtureUuid('seed', 'work:1')).toBe(fixtureUuid('seed', 'work:1'));
  expect(fixtureUuid('seed', 'work:1')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const corpus = fixtureCorpus('small', undefined, 2_000);
  const seen = new Set<string>();
  for (let index = 0; index < corpus.works; index++) {
    const work = workAt(corpus, index);
    for (const id of [work.work, work.mainVersion, work.workRevision, work.mainRevision,
      work.variant, work.contentRevision]) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  }
});

test('fixture: imported component objects are byte-identical to the Work command layout', () => {
  const directory = mkdtempSync(join(root, '.temp', 'fixture-objects-'));
  try {
    const corpus = fixtureCorpus('small');
    for (const index of [0, 1, 4, 999]) {
      const work = workAt(corpus, index);
      const objects = componentObjects(work);
      expect(objects.workManifest.digest).toBe(prepareComponent(directory, work.work, workComponentState(work)));
      expect(objects.mainManifest.digest).toBe(prepareComponent(directory, work.mainVersion,
        mainComponentState(work)));
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('fixture: restore compatibility applies only appended migrations and rejects stale owners', () => {
  const manifest = core();
  const same = restoreCompatibility(manifest, current(manifest));
  expect(same).toEqual({ compatible: true, reasons: [], pendingMigrations: [], engineChanged: false });

  const appended = current(manifest);
  appended.migrations['services/main/migrations/access/999_later.sql'] = 'f'.repeat(64);
  expect(restoreCompatibility(manifest, appended)).toMatchObject({ compatible: true,
    pendingMigrations: ['services/main/migrations/access/999_later.sql'] });

  const inserted = current(manifest);
  inserted.migrations['services/main/migrations/access/000_first.sql'] = 'f'.repeat(64);
  expect(restoreCompatibility(manifest, inserted).compatible).toBe(false);

  const changed = current(manifest);
  const [firstMigration] = Object.keys(changed.migrations);
  changed.migrations[firstMigration!] = '0'.repeat(64);
  expect(restoreCompatibility(manifest, changed).reasons).toEqual([`applied migration changed: ${firstMigration}`]);

  const generator = current(manifest);
  generator.owners = { ...generator.owners, graph: { ...generator.owners.graph!, generator: 'graph-v2' } };
  expect(restoreCompatibility(manifest, generator).reasons).toEqual(['owner graph generator changed']);

  const analyzer = current(manifest);
  analyzer.owners = { ...analyzer.owners, graph: { ...analyzer.owners.graph!,
    inputs: { ...analyzer.owners.graph!.inputs, 'infra/jena/fuseki-text.ttl': '0'.repeat(64) } } };
  expect(restoreCompatibility(manifest, analyzer).reasons).toEqual(['owner graph model inputs changed']);

  const module = current(manifest);
  module.engines.fuseki.id = `sha256:${'9'.repeat(64)}`;
  expect(restoreCompatibility(manifest, module)).toMatchObject({ compatible: true, engineChanged: true });

  const postgres = current(manifest);
  postgres.engines.postgres.id = `sha256:${'9'.repeat(64)}`;
  expect(restoreCompatibility(manifest, postgres).reasons).toEqual(['postgres engine changed']);
});
