import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { alignFixtureModel } from '../../../scripts/fixture/align-model.ts';
import { fixtureCorpus, workAt } from '../../../scripts/fixture/corpus.ts';
import { manifestCore, manifestIdentity, manifestCorpus, restoreCompatibility, type FixtureManifestCore } from '../../../scripts/fixture/manifest.ts';
import { fixtureModel, fixtureModelInputs, type FixtureModelManifest } from '../../../scripts/fixture/model.ts';
import { graphOwner, graphModelUse } from '../../../scripts/fixture/owners/graph.ts';
import { fixtureOwners } from '../../../scripts/fixture/owners/index.ts';
import { fixtureDirectory, PINNED_FIXTURE_IDS } from '../../../scripts/fixture/stack.ts';
import { fixtureModelAuditActor, localDatasetModelHead, type ModelArtifactEvidence,
  type LocalModelBootstrapResult } from '../../../scripts/datasets/model-bootstrap.ts';
import { ModelGenerationUnavailable, type ActiveModelGeneration } from '../../../services/main/src/modules/semantic/generation-guard.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { Pool } from 'pg';

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
    const profiles = graphOwner.modelProfiles!(fixtureCorpus('small', undefined, 6));
    const use = graphModelUse(fixtureCorpus('small', undefined, 6));
    const inputs = fixtureModelInputs(directory, use);
    expect(Object.keys(inputs).sort()).toEqual([
      ...profiles.map(profile => `profile:${profile.split('/').at(-1)}`),
      ...new Set(use.records.flatMap(record => record.types).map(type => `validation:${type}`)),
    ].sort());
    const before = fixtureModel(directory).generation;
    model.profiles.push({ id: 'unrelated-additive-v1', sha256: 'new-shape', file: 'shapes/unrelated-additive-v1.ttl' });
    model.artifacts['contexts/unrelated-additive-v1.jsonld'] = 'new-vocabulary';
    saveModel(directory, model);
    expect(fixtureModelInputs(directory, use)).toEqual(inputs);
    expect(fixtureModel(directory).generation).not.toBe(before);
    model.profiles = model.profiles.filter(profile => profile.id !== profiles[0]!.split('/').at(-1));
    saveModel(directory, model);
    expect(() => fixtureModelInputs(directory, use)).toThrow('Fixture model profile is absent');
  });
});

test('round 2 finding 2: an added matching canonical route or binding demand for a stored type is stale', async () => {
  await modelRoot((directory, model) => {
    const backup = core();
    const type = 'https://rezics.com/vocab/MainVersion';
    const id = 'metadata-hosting-route-v1';
    for (const change of ['route', 'demand']) {
      const changed = structuredClone(model);
      changed.profiles.push({ id, file: `shapes/${id}.ttl`, sha256: 'new-shape' });
      changed.artifacts[`contexts/${id}.jsonld`] = 'new-context';
      if (change === 'route') changed.canonical.find(entry => entry.type === type)!.routes.unshift({
        profile: id, shape: `https://rezics.com/definition/${id}/main-version-shape`,
        when: [{ path: 'https://rezics.com/vocab/hostingPolicy', value: 'https://rezics.com/vocab/MetadataOnly' }],
      });
      else changed.bindingDemands.push({ type, profile: id });
      saveModel(directory, changed);
      const now = current(backup);
      now.owners.graph!.inputs = graphOwner.compatibilityInputs(directory, fixtureCorpus('small', undefined, 6));
      now.modelGeneration = fixtureModel(directory).generation;
      expect(restoreCompatibility(backup, now)).toMatchObject({ compatible: false,
        reasons: [`owner graph model input changed: validation:${type}`] });
    }
  });
});

test('round 2 finding 2: an unrelated type or nonmatching hosting route stays additive', async () => {
  await modelRoot((directory, model) => {
    const backup = core();
    const changed = structuredClone(model);
    const id = 'private-hosting-route-v1';
    changed.profiles.push({ id, file: `shapes/${id}.ttl`, sha256: 'new-shape' });
    changed.artifacts[`contexts/${id}.jsonld`] = 'new-context';
    changed.canonical.find(entry => entry.type === 'https://rezics.com/vocab/MainVersion')!.routes.unshift({
      profile: id, shape: `https://rezics.com/definition/${id}/main-version-shape`,
      when: [{ path: 'https://rezics.com/vocab/hostingPolicy', value: 'https://rezics.com/vocab/Private' }],
    });
    changed.canonical.push({ type: 'urn:unrelated:type', routes: [{ profile: id, shape: 'urn:unrelated:shape', when: [] }] });
    changed.bindingDemands.push({ type: 'urn:unrelated:type', profile: id });
    saveModel(directory, changed);
    const now = current(backup);
    now.owners.graph!.inputs = graphOwner.compatibilityInputs(directory, fixtureCorpus('small', undefined, 6));
    now.modelGeneration = fixtureModel(directory).generation;
    expect(restoreCompatibility(backup, now)).toMatchObject({ compatible: true, reasons: [], pendingModelAlignment: true });
  });
});

test('round 2 finding 2: route matching uses literal lexical forms from emitted records', async () => {
  await modelRoot((directory, model) => {
    const backup = core();
    const id = 'imported-anchor-route-v1';
    const type = 'https://rezics.com/vocab/RevisionAnchor';
    model.profiles.push({ id, file: `shapes/${id}.ttl`, sha256: 'new-shape' });
    model.artifacts[`contexts/${id}.jsonld`] = 'new-context';
    model.canonical.push({ type, routes: [{ profile: id, shape: `https://rezics.com/definition/${id}/anchor-shape`,
      when: [{ path: 'https://rezics.com/vocab/sequence', value: '0' }] }] });
    saveModel(directory, model);
    const now = current(backup);
    now.owners.graph!.inputs = graphOwner.compatibilityInputs(directory, fixtureCorpus('small', undefined, 6));
    expect(restoreCompatibility(backup, now)).toMatchObject({ compatible: false,
      reasons: [`owner graph model input changed: validation:${type}`] });
  });
});

test('fixture compatibility records canonical type precedence for multi-typed stored records', async () => {
  await modelRoot((directory, model) => {
    const use = { profiles: ['work-metadata-v1'], records: [{
      types: ['https://schema.org/CreativeWork', 'https://rezics.com/vocab/MainVersion'],
      values: { 'https://rezics.com/vocab/hostingPolicy': ['https://rezics.com/vocab/MetadataOnly'] },
    }] };
    const before = fixtureModelInputs(directory, use);
    model.canonical.reverse();
    saveModel(directory, model);
    const after = fixtureModelInputs(directory, use);
    expect(after['validation:https://schema.org/CreativeWork'])
      .not.toBe(before['validation:https://schema.org/CreativeWork']);
    // Single-typed records still resolve through the same native route.
    const single = { ...use, records: [{ ...use.records[0]!, types: ['https://schema.org/CreativeWork'] }] };
    const reversed = fixtureModelInputs(directory, single);
    model.canonical.reverse();
    saveModel(directory, model);
    expect(fixtureModelInputs(directory, single)['validation:https://schema.org/CreativeWork'])
      .toBe(reversed['validation:https://schema.org/CreativeWork']);
  });
});

test('fixture: real manifests before an additive definition restore, with newer migrations alone or together', async () => {
  await modelRoot((directory, model) => {
    const backup = core();
    // Keep the real generated manifest bytes so only the added definition advances the head.
    writeFileSync(join(directory, 'generated/model/manifest.json'), readFileSync(join(root, 'generated/model/manifest.json')));
    expect(graphOwner.compatibilityInputs(directory, fixtureCorpus('small', undefined, 6))).toEqual(backup.owners.graph!.inputs);
    const appended = 'services/main/migrations/access/99999_newer.sql';
    for (const addModel of [false, true]) {
      if (addModel) {
        model.profiles.push({ id: 'unrelated-additive-v1', sha256: 'added', file: 'shapes/unrelated-additive-v1.ttl' });
        model.artifacts['shapes/unrelated-additive-v1.ttl'] = 'added';
        saveModel(directory, model);
      }
      for (const addMigration of [false, true]) {
        const now = current(backup);
        now.owners.graph!.inputs = graphOwner.compatibilityInputs(directory, fixtureCorpus('small', undefined, 6));
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

test('finding 2: a changed used canonical route, binding or binding demand is stale with the profile reason', async () => {
  await modelRoot((directory, model) => {
    const backup = core();
    const id = 'work-metadata-v1';
    for (const metadata of ['canonical', 'binding', 'demand']) {
      const changed = structuredClone(model);
      if (metadata === 'canonical') {
        const route = changed.canonical.flatMap(entry => entry.routes).find(route => route.profile === id)!;
        route.when = [{ path: 'https://rezics.com/vocab/hostingPolicy', value: 'https://rezics.com/vocab/MetadataOnly' }];
      } else if (metadata === 'binding') {
        changed.profiles.find(profile => profile.id === id)!.binding = { required: ['work'], optional: [], roles: ['work'] };
      } else changed.bindingDemands.push({ type: 'https://schema.org/CreativeWork', profile: id });
      saveModel(directory, changed);
      const now = current(backup);
      now.owners.graph!.inputs = graphOwner.compatibilityInputs(directory, fixtureCorpus('small', undefined, 6));
      now.modelGeneration = fixtureModel(directory).generation;
      const compatibility = restoreCompatibility(backup, now);
      expect(compatibility.compatible).toBe(false);
      expect(compatibility.reasons).toContain(`owner graph model input changed: profile:${id}`);
    }
  });
});

test('fixture: every used profile and vocabulary change is refused with its named input', async () => {
  await modelRoot((directory, model) => {
    const backup = core();
    for (const profile of graphOwner.modelProfiles!(fixtureCorpus('small', undefined, 6))) {
      const id = profile.split('/').at(-1)!;
      for (const kind of ['profile', 'vocabulary'] as const) {
        const changed = structuredClone(model);
        if (kind === 'profile') changed.profiles.find(profile => profile.id === id)!.sha256 = 'changed';
        else changed.artifacts[`contexts/${id}.jsonld`] = 'changed';
        saveModel(directory, changed);
        const now = current(backup);
        now.owners.graph!.inputs = graphOwner.compatibilityInputs(directory, fixtureCorpus('small', undefined, 6));
        now.modelGeneration = fixtureModel(directory).generation;
        expect(restoreCompatibility(backup, now)).toMatchObject({ compatible: false,
          reasons: [`owner graph model input changed: profile:${id}`] });
      }
    }
    const now = current(backup);
    now.owners.graph!.inputs.jena = 'next-version';
    expect(restoreCompatibility(backup, now).reasons).toEqual(['owner graph model input changed: jena']);
  });
});

test('finding 6: every profile declared by the emitted loader records has a compatibility fingerprint', async () => {
  const observed = new Set<string>();
  let bytes = '';
  const access = new Pool(), content = new Pool();
  try {
    await graphOwner.load(fixtureCorpus('small', 'profile-coverage', 6), {
      root, apps: {}, pools: { access, content }, recordModelProfile: profile => observed.add(profile),
      async fusekiOffline(_script, input) { if (input) for await (const chunk of input) bytes += chunk; return ''; },
    });
    expect(bytes).toContain('https://rezics.com/vocab/TextContribution');
    expect(bytes).toContain('https://rezics.com/vocab/PublicationDecision');
    expect([...observed].sort()).toEqual([...graphOwner.modelProfiles!(fixtureCorpus('small', undefined, 6))].sort());
    const inputs = graphOwner.compatibilityInputs(root, fixtureCorpus('small', undefined, 6));
    for (const profile of observed) expect(inputs[`profile:${profile.split('/').at(-1)}`]).toMatch(/^[a-f0-9]{64}$/);
  } finally { await Promise.all([access.end(), content.end()]); }
});

test('round 2 finding 3: the model inventory is derived from writer records without a separate profile array', () => {
  const use = graphModelUse(fixtureCorpus('small', undefined, 6));
  expect(graphOwner.modelProfiles!(fixtureCorpus('small', undefined, 6))).toEqual(use.profiles);
  const main = use.records.find(record => record.types.includes('https://rezics.com/vocab/MainVersion'))!;
  expect(main.values['https://rezics.com/vocab/hostingPolicy']).toEqual(['https://rezics.com/vocab/MetadataOnly']);
  expect(use.records.some(record => record.types.includes('https://rezics.com/vocab/TextContribution'))).toBe(true);
  expect(use.records.some(record => record.types.includes('https://rezics.com/vocab/PublicationDecision'))).toBe(true);
});

const retainedMedium = join(fixtureDirectory(PINNED_FIXTURE_IDS[0]), 'manifest.json');
test.skipIf(!existsSync(retainedMedium))('fixture: pinned retained medium manifest keeps its existing stale generator classification', () => {
  const backup = JSON.parse(readFileSync(retainedMedium, 'utf8')) as FixtureManifestCore;
  const now = current(backup);
  now.owners = Object.fromEntries(fixtureOwners.map(owner => [owner.name,
    { ...backup.owners[owner.name]!, generator: owner.generator, inputs: owner.compatibilityInputs(root, manifestCorpus(backup)) }]));
  const result = restoreCompatibility(backup, now);
  expect(result.compatible).toBe(false);
  expect(result.reasons).toEqual(['owner graph generator changed']);
}, 60_000);

test('fixture: restore reuses model bootstrap and records both generations and the installed artifacts', async () => {
  const backup = core();
  backup.modelGeneration = 'urn:rezics:model-generation:previous';
  const original = structuredClone(backup);
  const apps = { FUSEKI_URL: 'http://127.0.0.1:3030/rezics' };
  const model = fixtureModel(root);
  const stack = join(root, '.temp/stack/rezics-qa-alignment');
  const artifacts: ModelArtifactEvidence[] = [{ name: 'manifest.json', sha256: '1'.repeat(64) }];
  const evidence = await alignFixtureModel(root, stack, apps, backup, {}, async (directory, fixture) => {
    expect(directory).toBe(stack);
    expect(fixture).toEqual({ apps, importOperation: backup.importOperation });
    return { state: 'completed', generation: model.generation, sequence: '1', artifacts, artifactCount: artifacts.length };
  });
  expect(evidence).toEqual({ backupGeneration: backup.modelGeneration, currentGeneration: model.generation,
    artifacts, artifactCount: artifacts.length, installation: { state: 'completed', generation: model.generation,
      sequence: '1', artifacts, artifactCount: artifacts.length } });
  expect(backup).toEqual(original);
  const invalid: LocalModelBootstrapResult[] = [{ state: 'completed', generation: 'wrong', artifacts, artifactCount: artifacts.length },
    { state: 'current', generation: model.generation, artifacts, artifactCount: 999 }];
  for (const installation of invalid) {
    await expect(alignFixtureModel(root, stack, apps, backup, {}, async () => installation))
      .rejects.toThrow('did not install the current generation');
  }
  const failure = new Error('alignment failed');
  await expect(alignFixtureModel(root, stack, apps, backup, {}, async () => { throw failure; })).rejects.toBe(failure);
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

test('custom-seed validation cannot borrow the default small corpus or a previous cache entry', async () => {
  await modelRoot((directory, model) => {
    const corpus = fixtureCorpus('medium', 'custom-route', 1_002);
    const label = workAt(corpus, 1_001).title;
    const id = 'custom-seed-route-v1';
    model.profiles.push({ id, file: `shapes/${id}.ttl`, sha256: 'original' });
    model.artifacts[`contexts/${id}.jsonld`] = 'context';
    model.canonical.push({ type: 'https://schema.org/CreativeWork', routes: [{ profile: id,
      shape: `https://rezics.com/definition/${id}/shape`,
      when: [{ path: 'http://www.w3.org/2000/01/rdf-schema#label', value: label }] }] });
    saveModel(directory, model);
    const before = graphOwner.compatibilityInputs(directory, corpus);
    // Prime an unrelated corpus, then change only a route the requested seed uses.
    graphOwner.compatibilityInputs(directory, fixtureCorpus('small', undefined, 6));
    model.profiles.find(profile => profile.id === id)!.sha256 = 'planted-invalid-shape';
    saveModel(directory, model);
    expect(graphOwner.compatibilityInputs(directory, corpus)).not.toEqual(before);
  });
});

test('restore validation reconstructs custom dimensions and lineage from the retained manifest', () => {
  const corpus = { ...fixtureCorpus('small', 'custom-dimensions', 12), publicUnits: 2,
    lineage: { dataEpoch: 'retained-data', routingEpoch: 'retained-routing' }, importOperation: 'retained-import' };
  const manifest = manifestCore(root, corpus, fixtureOwners, engines);
  expect(manifestCorpus(manifest)).toEqual(corpus);
});
