import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { alignFixtureModel } from '../../../scripts/fixture/align-model.ts';
import { fixtureCorpus } from '../../../scripts/fixture/corpus.ts';
import { manifestCore, manifestIdentity, restoreCompatibility, type FixtureManifestCore } from '../../../scripts/fixture/manifest.ts';
import { fixtureModel, fixtureModelInputs, type FixtureModelManifest } from '../../../scripts/fixture/model.ts';
import { graphOwner } from '../../../scripts/fixture/owners/graph.ts';
import { fixtureOwners } from '../../../scripts/fixture/owners/index.ts';
import { fixtureDirectory, PINNED_FIXTURE_IDS } from '../../../scripts/fixture/stack.ts';
import { fixtureModelAuditActor, localDatasetModelHead } from '../../../scripts/datasets/model-bootstrap.ts';
import { ModelGenerationUnavailable, type ActiveModelGeneration } from '../../../services/main/src/modules/semantic/generation-guard.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';

const root = resolve(import.meta.dir, '../../..');
const engines = {
  fuseki: { image: 'fuseki', id: 'command-image' },
  postgres: { image: 'postgres', id: 'postgres-image' },
  rustfs: { image: 'rustfs', id: 'rustfs-image' },
};
const core = () => manifestCore(root, fixtureCorpus('small', undefined, 6), fixtureOwners, engines);
const current = (manifest: FixtureManifestCore) => ({ owners: structuredClone(manifest.owners),
  migrations: { ...manifest.migrations }, engines: structuredClone(manifest.engines),
  modelGeneration: manifest.modelGeneration });

function modelRoot(run: (directory: string, model: FixtureModelManifest) => void | Promise<void>) {
  const directory = mkdtempSync(join(root, '.temp', 'fixture-model-'));
  const model = structuredClone(fixtureModel(root).manifest);
  for (const path of ['infra/jena/Dockerfile', 'infra/jena/fuseki-text.ttl']) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), readFileSync(join(root, path)));
  }
  saveModel(directory, model);
  return Promise.resolve().then(() => run(directory, model))
    .finally(() => rmSync(directory, { recursive: true, force: true }));
}
function saveModel(directory: string, model: FixtureModelManifest) {
  mkdirSync(join(directory, 'generated/model'), { recursive: true });
  writeFileSync(join(directory, 'generated/model/manifest.json'), JSON.stringify(model));
}

test('fixture: model compatibility derives only the loader-declared shapes and vocabulary', async () => {
  await modelRoot((directory, model) => {
    const profiles = graphOwner.modelProfiles!;
    const inputs = fixtureModelInputs(directory, profiles);
    expect(Object.keys(inputs).sort()).toEqual(profiles.flatMap(profile => {
      const id = profile.split('/').at(-1)!;
      return [`profile:${id}`, `vocabulary:${id}`];
    }).sort());
    const before = fixtureModel(directory).generation;
    model.profiles.push({ id: 'unrelated-additive-v1', sha256: 'new-shape', file: 'shapes/unrelated-additive-v1.ttl' });
    model.artifacts['contexts/unrelated-additive-v1.jsonld'] = 'new-vocabulary';
    saveModel(directory, model);
    expect(fixtureModelInputs(directory, profiles)).toEqual(inputs);
    expect(fixtureModel(directory).generation).not.toBe(before);
    model.profiles = model.profiles.filter(profile => profile.id !== profiles[0]!.split('/').at(-1));
    saveModel(directory, model);
    expect(() => fixtureModelInputs(directory, profiles)).toThrow('Fixture model profile is absent');
  });
});

test('fixture: real manifests before an additive definition restore, with newer migrations alone or together', async () => {
  await modelRoot((directory, model) => {
    const backup = core();
    // Keep the real generated manifest bytes so only the added definition advances the head.
    writeFileSync(join(directory, 'generated/model/manifest.json'), readFileSync(join(root, 'generated/model/manifest.json')));
    expect(graphOwner.compatibilityInputs(directory)).toEqual(backup.owners.graph!.inputs);
    const appended = 'services/main/migrations/access/99999_newer.sql';
    for (const addModel of [false, true]) {
      if (addModel) {
        model.profiles.push({ id: 'unrelated-additive-v1', sha256: 'added', file: 'shapes/unrelated-additive-v1.ttl' });
        model.artifacts['shapes/unrelated-additive-v1.ttl'] = 'added';
        saveModel(directory, model);
      }
      for (const addMigration of [false, true]) {
        const now = current(backup);
        now.owners.graph!.inputs = graphOwner.compatibilityInputs(directory);
        now.modelGeneration = fixtureModel(directory).generation;
        expect(manifestIdentity({ ...backup, modelGeneration: now.modelGeneration })).toEqual(manifestIdentity(backup));
        if (addMigration) now.migrations[appended] = 'newer';
        expect(restoreCompatibility(backup, now)).toEqual({ compatible: true, reasons: [],
          pendingMigrations: addMigration ? [appended] : [], engineChanged: false,
          pendingModelAlignment: addModel });
      }
    }
  });
});

test('fixture: every used profile and vocabulary change is refused with its named input', async () => {
  await modelRoot((directory, model) => {
    const backup = core();
    for (const profile of graphOwner.modelProfiles!) {
      const id = profile.split('/').at(-1)!;
      for (const kind of ['profile', 'vocabulary'] as const) {
        const changed = structuredClone(model);
        if (kind === 'profile') changed.profiles.find(profile => profile.id === id)!.sha256 = 'changed';
        else changed.artifacts[`contexts/${id}.jsonld`] = 'changed';
        saveModel(directory, changed);
        const now = current(backup);
        now.owners.graph!.inputs = graphOwner.compatibilityInputs(directory);
        now.modelGeneration = fixtureModel(directory).generation;
        expect(restoreCompatibility(backup, now)).toMatchObject({ compatible: false,
          reasons: [`owner graph model input changed: ${kind}:${id}`] });
      }
    }
    const now = current(backup);
    now.owners.graph!.inputs.jena = 'next-version';
    expect(restoreCompatibility(backup, now).reasons).toEqual(['owner graph model input changed: jena']);
  });
});

const retainedMedium = join(fixtureDirectory(PINNED_FIXTURE_IDS[0]), 'manifest.json');
test.skipIf(!existsSync(retainedMedium))('fixture: pinned retained medium manifest keeps its existing stale generator classification', () => {
  const backup = JSON.parse(readFileSync(retainedMedium, 'utf8')) as FixtureManifestCore;
  const now = current(backup);
  now.owners = Object.fromEntries(fixtureOwners.map(owner => [owner.name,
    { ...backup.owners[owner.name]!, generator: owner.generator, inputs: owner.compatibilityInputs(root) }]));
  const result = restoreCompatibility(backup, now);
  expect(result.compatible).toBe(false);
  expect(result.reasons).toEqual(['owner graph generator changed']);
});

test('fixture: restore reuses model bootstrap and records both generations and the installed artifacts', async () => {
  const backup = core();
  backup.modelGeneration = 'urn:rezics:model-generation:previous';
  const original = structuredClone(backup);
  const apps = { FUSEKI_URL: 'http://127.0.0.1:3030/rezics' };
  const model = fixtureModel(root);
  const stack = join(root, '.temp/stack/rezics-qa-alignment');
  const evidence = await alignFixtureModel(root, stack, apps, backup, async (directory, fixture) => {
    expect(directory).toBe(stack);
    expect(fixture).toEqual({ apps, importOperation: backup.importOperation });
    return { state: 'completed', generation: model.generation, sequence: '1' };
  });
  expect(evidence).toEqual({ backupGeneration: backup.modelGeneration, currentGeneration: model.generation,
    artifacts: model.manifest.artifacts, installation: { state: 'completed', generation: model.generation, sequence: '1' } });
  expect(backup).toEqual(original);
  for (const installation of [{ state: 'completed', generation: 'wrong' },
    { state: 'pending', generation: model.generation }]) {
    await expect(alignFixtureModel(root, stack, apps, backup, async () => installation))
      .rejects.toThrow('did not install the current generation');
  }
  const failure = new Error('alignment failed');
  await expect(alignFixtureModel(root, stack, apps, backup, async () => { throw failure; })).rejects.toBe(failure);
});

test('fixture: fixture audit identities cannot authorize shared-stack model maintenance', () => {
  const fixture = { apps: {}, importOperation: core().importOperation };
  expect(fixtureModelAuditActor('rezics-qa-alignment', fixture)).toBe(fixture.importOperation);
  for (const stack of ['rezics-dev', 'unmanaged'])
    expect(() => fixtureModelAuditActor(stack, fixture)).toThrow('isolated QA stack');
  expect(() => fixtureModelAuditActor('rezics-qa-alignment', { ...fixture, importOperation: 'arbitrary-user' }))
    .toThrow('fixture import identity');
});

test('fixture: an unrecorded model uses the owner bootstrap, while partial state and shared maintenance stay refused', async () => {
  const environment = { fuseki: new FusekiClient('http://127.0.0.1:3030/rezics'),
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, objectDirectory: '.temp/model-head' };
  const active: ActiveModelGeneration = { generation: fixtureModel(root).generation,
    manifest: `urn:rezics:sha256:${'1'.repeat(64)}`, generationNumber: '1', predecessor: null,
    entailmentProfile: 'NoEntailment', receipt: 'receipt' };
  let initialized = false;
  const missing = new ModelGenerationUnavailable('model head is absent');
  const read = async () => {
    if (!initialized) throw missing;
    return active;
  };
  const initialize = async () => { initialized = true; return active.generation; };
  await expect(localDatasetModelHead(environment, false, read, initialize)).rejects.toBe(missing);
  expect(initialized).toBe(false);
  await expect(localDatasetModelHead(environment, true, read, initialize))
    .resolves.toEqual({ active, bootstrapped: true });
  await expect(localDatasetModelHead(environment, true, read, async () => { throw new Error('must not initialize twice'); }))
    .resolves.toEqual({ active, bootstrapped: false });
  initialized = false;
  const partial = new Error('owner refuses bootstrap over partial model state');
  await expect(localDatasetModelHead(environment, true, read, async () => { throw partial; })).rejects.toBe(partial);
  const unavailable = new Error('graph unavailable');
  await expect(localDatasetModelHead(environment, true, async () => { throw unavailable; }, initialize)).rejects.toBe(unavailable);
  expect(initialized).toBe(false);
});
