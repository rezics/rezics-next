import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadCompatibility } from '../../../scripts/load/compatibility.ts';
import {
  prepareWorkProfileCorpus,
  restoreWorkProfileCorpus,
  workProfileCorpusApi,
  workProfileCorpusId,
  type WorkProfileCorpusRecipe,
} from '../../../scripts/load/work-profile-corpus.ts';
import {
  rankedBilingualQuads,
  RANKED_BILINGUAL_MAINS,
} from '../support/ranked-bilingual-fixture.ts';
import { fixtureCorpus, publicUnitAt } from '../../../scripts/fixture/corpus.ts';
import { catalogueBackupProject } from '../../../scripts/load/catalogue-backup.ts';
import { manifestCore, manifestIdentity } from '../../../scripts/fixture/manifest.ts';
import { graphOwner } from '../../../scripts/fixture/owners/graph.ts';

const root = resolve(import.meta.dir, '../../..');
const fixed = {
  unrelatedWorks: 0,
  unrelatedPosts: 0,
  follows: 0,
  memberships: 0,
  historyDepth: 0,
  realmSize: 0,
  conceptVocabulary: 0,
};
const recipe: WorkProfileCorpusRecipe = {
  version: 'g1045-schema-v1',
  fixed,
  async initialize() {},
  async grow() {},
  async verify() {
    return { ...fixed, unrelatedWorks: 4 };
  },
};
const owners = [
  'services/account/migrations',
  'services/content/migrations',
  'services/main/migrations/access',
  'services/main/migrations/relay',
];
function temporary() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  return mkdtempSync(join(root, '.temp/g-1045-'));
}
function write(directory: string, path: string, body: string) {
  const file = join(directory, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

test('G1045: corpus and stopped-backup keys change at every owner migration and Fuseki model, but not application edits', () => {
  const directory = temporary();
  try {
    for (const path of Object.keys(loadCompatibility(root).files))
      write(directory, path, 'baseline');
    write(directory, 'services/account/src/auth.ts', 'Account provider schema');
    write(directory, 'infra/jena/Dockerfile', 'ARG FUSEKI_VERSION=6.2.0');
    const engine = { image: 'fixture:1', id: 'sha256:fixture' };
    const fixture = () =>
      manifestCore(directory, fixtureCorpus('small', 'g1045-schema', 10), [graphOwner], {
        postgres: engine,
        fuseki: engine,
        rustfs: engine,
      });
    const fixtureId = manifestIdentity(fixture()).id;
    const baseline = loadCompatibility(directory);
    const id = workProfileCorpusId(recipe, 'unrelatedWorks', 'small', baseline);
    const backup = catalogueBackupProject('g1045', 1000, baseline);
    write(directory, 'services/main/src/app.ts', 'code-only change');
    expect(loadCompatibility(directory)).toEqual(baseline);
    expect(manifestIdentity(fixture()).id).toBe(fixtureId);
    for (const owner of owners) {
      const path = `${owner}/9999_g1045_schema.sql`;
      write(directory, path, 'CREATE TABLE new_owner_relation(id text);');
      const current = loadCompatibility(directory);
      expect(current.digest).not.toBe(baseline.digest);
      expect(workProfileCorpusId(recipe, 'unrelatedWorks', 'small', current)).not.toBe(id);
      expect(catalogueBackupProject('g1045', 1000, current)).not.toBe(backup);
      expect(Object.hasOwn(fixture().migrations, path)).toBe(true);
      expect(manifestIdentity(fixture()).id).not.toBe(fixtureId);
      rmSync(join(directory, path));
    }
    write(directory, 'generated/model/manifest.json', 'new Fuseki model generation');
    const model = loadCompatibility(directory);
    expect(workProfileCorpusId(recipe, 'unrelatedWorks', 'small', model)).not.toBe(id);
    expect(catalogueBackupProject('g1045', 1000, model)).not.toBe(backup);
    expect(manifestIdentity(fixture()).id).not.toBe(fixtureId);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G1045: a previous schema cut is rebuilt under a new key and cannot be restored or relabelled as current', async () => {
  const directory = temporary();
  const current = loadCompatibility(root);
  const previous = { digest: '0'.repeat(64), files: { ...current.files } };
  delete previous.files['services/main/migrations/access/1031_admitted_read_rankings.sql'];
  delete previous.files['services/main/migrations/access/1038_realm_thread_ranking.sql'];
  const previousId = workProfileCorpusId(recipe, 'unrelatedWorks', 'small', previous);
  const old = {
    format: 'work-profile-corpus-v1' as const,
    id: previousId,
    recipe: recipe.version,
    dimension: 'unrelatedWorks' as const,
    scale: 'small' as const,
    dimensions: { ...fixed, unrelatedWorks: 4 },
    backup: previousId,
    preparationMs: 1,
    compatibility: previous,
  };
  let builds = 0,
    restores = 0;
  const driver = {
    async backup(id: string) {
      builds++;
      return id;
    },
    async restore() {
      restores++;
    },
  };
  const input = {
    recipe,
    api: workProfileCorpusApi('http://main.local', 'unused'),
    backups: driver,
    dimension: 'unrelatedWorks' as const,
    scale: 'small' as const,
    directory,
  };
  try {
    write(directory, `${previousId}.json`, JSON.stringify(old));
    const manifest = await prepareWorkProfileCorpus(input);
    expect(manifest.id).not.toBe(previousId);
    expect(manifest.compatibility).toEqual(current);
    expect(builds).toBe(1);
    expect(await prepareWorkProfileCorpus(input)).toEqual(manifest);
    expect(builds).toBe(1);
    expect(JSON.parse(readFileSync(join(directory, `${previousId}.json`), 'utf8'))).toEqual(old);
    await expect(restoreWorkProfileCorpus(old, 'g1045-new-target', driver)).rejects.toThrow(
      'compatibility changed',
    );
    expect(restores).toBe(0);
    write(
      directory,
      `${manifest.id}.json`,
      JSON.stringify({ ...manifest, compatibility: previous }),
    );
    await expect(prepareWorkProfileCorpus(input)).rejects.toThrow('Incompatible');
    expect(builds).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G1045: the prepared ranked background contains 100 distinct second-language selections and no synthetic receipts', () => {
  const corpus = { ...fixtureCorpus('medium', 'g556-ranked-v1', 22_004), publicUnits: 22_002 };
  const rows = rankedBilingualQuads(corpus),
    text = rows.map((row) => row.quad).join('');
  const selections = rows.filter(
    (row) => row.graph === 'current' && row.quad.includes('/vocab/selectionHead>'),
  );
  expect(selections).toHaveLength(RANKED_BILINGUAL_MAINS);
  expect(new Set(selections.map((row) => row.quad.split(' ')[0])).size).toBe(
    RANKED_BILINGUAL_MAINS,
  );
  expect(selections[0]!.quad).toContain(publicUnitAt(corpus, 1025).work.mainVersion);
  expect(selections.at(-1)!.quad).toContain(publicUnitAt(corpus, 1124).work.mainVersion);
  expect(
    rows.filter((row) => row.graph === 'public' && row.quad.includes('"fixture body"@fr')),
  ).toHaveLength(RANKED_BILINGUAL_MAINS);
  expect(text).not.toContain('OperationReceipt');
  expect(text).not.toContain('urn:rezics:graph:receipts');
});
