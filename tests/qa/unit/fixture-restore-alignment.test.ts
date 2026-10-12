import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureLocalDatasetModelGeneration, assertLocalModelOwner, type ModelBootstrapRuntime,
  custodyLocalModelArtifacts, type LocalModelBootstrapResult } from '../../../scripts/datasets/model-bootstrap.ts';
import { alignFixtureModel } from '../../../scripts/fixture/align-model.ts';
import { fixtureCorpus } from '../../../scripts/fixture/corpus.ts';
import { manifestCore, manifestIdentity, type FixtureManifest } from '../../../scripts/fixture/manifest.ts';
import { fixtureModel } from '../../../scripts/fixture/model.ts';
import { ModelAlignmentTimeout, ModelWorkBudget } from '../../../scripts/fixture/model-deadline.ts';
import { fixtureOwners } from '../../../scripts/fixture/owners/index.ts';
import { restoreFixture, FixtureRestoreFailure, type FixtureRestoreRuntime,
  type FixtureRestoreEvidence } from '../../../scripts/fixture/restore.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';

const root = resolve(import.meta.dir, '../../..');
const engines = { fuseki: { image: 'fuseki', id: 'fuseki' }, postgres: { image: 'postgres', id: 'postgres' },
  rustfs: { image: 'rustfs', id: 'rustfs' } };

function backup(): FixtureManifest {
  const core = manifestCore(root, fixtureCorpus('small', undefined, 6), fixtureOwners, engines);
  return { ...core, ...manifestIdentity(core), build: { startedAt: 'built', completedAt: 'built', elapsedMs: 1,
    phases: {}, textIndexGeneration: 'index', loads: {} }, backup: { project: 'backup', volumes: {} } };
}
function ownerFixture() {
  const project = `rezics-qa-model-${randomUUID().slice(0, 8)}`;
  const stack = join(root, '.temp/stack', project);
  mkdirSync(stack, { recursive: true });
  writeFileSync(join(stack, 'compose.env'), 'harness-owned');
  const apps = { FUSEKI_URL: 'http://127.0.0.1:3030/rezics', FUSEKI_COMMAND_TOKEN: 'command',
    ACCOUNT_DATABASE_URL: 'postgres://account:password@127.0.0.1:5432/account',
    MAIN_S3_ENDPOINT: 'http://127.0.0.1:9000', MAIN_S3_BUCKET: 'semantic', MAIN_S3_ACCESS_KEY: 'access',
    MAIN_S3_SECRET_KEY: 'secret', MAIN_OBJECT_DIRECTORY: join(stack, 'objects'),
    MAIN_DATA_EPOCH: 'epoch', MAIN_ROUTING_EPOCH: 'routing' };
  const containers = new Map<string, { Id: string; Image: string; Config: { Env: string[]; Labels: Record<string, string> };
    Mounts: { Type: string; Name: string; Destination: string; RW: boolean }[];
    NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[]> } }>();
  for (const [index, [service, volume, destination, port]] of [
    ['fuseki', 'fuseki_data', '/fuseki/databases', '3030'],
    ['postgres', 'postgres_data', '/var/lib/postgresql', '5432'],
    ['rustfs', 'rustfs_data', '/data', '9000'],
  ].entries()) {
    const id = `${index + 1}`.repeat(12);
    containers.set(service!, { Id: id, Image: 'image', Config: {
      Env: ['FUSEKI_COMMAND_TOKEN=command', 'RUSTFS_ACCESS_KEY=access', 'RUSTFS_SECRET_KEY=secret'],
      Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service! } },
    Mounts: [{ Type: 'volume', Name: `${project}_${volume}`, Destination: destination!, RW: true }],
    NetworkSettings: { Ports: { [`${port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: port! }] } } });
  }
  const inspect: ModelBootstrapRuntime['docker'] = args => {
    if (args[0] === 'context') return JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///docker.sock' } } }]);
    if (args[0] === 'ps') return containers.get(args.at(-1)!.split('=').at(-1)!)?.Id ?? '';
    return JSON.stringify([...containers.values()].filter(container => container.Id === args[1]));
  };
  const active = { generation: fixtureModel(root).generation, manifest: `urn:rezics:sha256:${'1'.repeat(64)}`,
    generationNumber: '1', predecessor: null, entailmentProfile: 'NoEntailment' as const, receipt: 'receipt' };
  return { project, stack, apps, containers, runtime: { docker: inspect, readEnv: () => apps,
    assertProfiles: async () => {}, readHead: async () => active } satisfies Partial<ModelBootstrapRuntime>,
  close: () => rmSync(stack, { recursive: true, force: true }) };
}

test('finding 1: a fabricated stack and foreign owner volumes are refused before any model or custody write', async () => {
  const owner = ownerFixture();
  let writes = 0;
  const runtime: Partial<ModelBootstrapRuntime> = { ...owner.runtime,
    initialize: async () => { writes++; return 'generation'; },
    custody: async () => { writes++; }, objects: () => ({
      put: async () => { writes++; return 'digest'; }, get: async () => new Uint8Array(),
    }) };
  try {
    const fixture = { apps: owner.apps, importOperation: backup().importOperation };
    const fabricated = join(root, '.temp/stack', `rezics-qa-fabricated-${randomUUID()}`);
    await expect(ensureLocalDatasetModelGeneration(fabricated, fixture, { runtime })).rejects.toThrow('harness-owned stack');
    expect(writes).toBe(0);
    expect(assertLocalModelOwner(owner.stack, owner.apps, owner.runtime.docker, owner.runtime.readEnv).Id).toBe('1'.repeat(12));
    for (const service of ['fuseki', 'postgres', 'rustfs']) {
      const container = owner.containers.get(service)!;
      const original = container.Mounts[0]!.Name;
      container.Mounts[0]!.Name = 'rezics-dev_foreign-data';
      await expect(ensureLocalDatasetModelGeneration(owner.stack, fixture, { runtime })).rejects.toThrow('configured harness owner');
      expect(writes).toBe(0);
      container.Mounts[0]!.Name = original;
    }
  } finally { owner.close(); }
});

test('finding 3: alignment evidence equals the custody step artifact list and count', async () => {
  const manifest = backup();
  const bytes = readFileSync(join(root, 'generated/model/manifest.json'));
  const environment = { fuseki: new FusekiClient('http://127.0.0.1:3030/rezics'),
    objectDirectory: '.temp/unused', lineage: manifest.lineage };
  const artifacts = await custodyLocalModelArtifacts(environment, manifest.modelGeneration, bytes,
    () => new Uint8Array([1, 2, 3]), async (_env, _generation, _bytes, readShape) => {
      readShape('shapes/work-metadata-v1.ttl');
    });
  const installation: LocalModelBootstrapResult = { state: 'current', generation: manifest.modelGeneration,
    artifacts, artifactCount: artifacts.length };
  const evidence = await alignFixtureModel(root, '.temp/stack/rezics-qa-evidence', {}, manifest, {}, async () => installation);
  expect(evidence.artifacts).toEqual(artifacts);
  expect(evidence.artifactCount).toBe(installation.artifactCount);
  expect(evidence.artifacts.map(artifact => artifact.name)).toEqual(['shapes/work-metadata-v1.ttl', 'manifest.json']);
  expect(evidence.installation).toEqual(installation);
});

test('finding 4: a hanging upload is aborted within the supplied alignment budget with no later writes', async () => {
  const owner = ownerFixture();
  let uploads = 0;
  let uploadSignal: AbortSignal | undefined;
  const expires = Date.now() + 150;
  try {
    const run = ensureLocalDatasetModelGeneration(owner.stack,
      { apps: owner.apps, importOperation: backup().importOperation }, {
        remaining: () => expires - Date.now(), runtime: { ...owner.runtime, objects: () => ({
          put: async (_bytes, signal) => { uploads++; uploadSignal = signal; return new Promise<string>(() => {}); },
          get: async () => { throw new Error('read-back must not start'); },
        }) },
      });
    await expect(run).rejects.toBeInstanceOf(ModelAlignmentTimeout);
    expect(uploadSignal?.aborted).toBe(true);
    expect(uploads).toBe(1);
  } finally { owner.close(); }
});

function restoreRuntime(manifest: FixtureManifest, events: string[], artifactsRoot: string): Partial<FixtureRestoreRuntime> {
  return {
    artifactsRoot, readManifest: () => manifest, docker: () => ({}), projectRunning: () => false,
    volumeExists: name => name.startsWith('rezics-fixture-'), readApps: () => ({}),
    inputs: () => ({ owners: manifest.owners, migrations: manifest.migrations, engines: manifest.engines,
      modelGeneration: fixtureModel(root).generation }),
    runPhase: async <T>(name: string, work: () => T | Promise<T>): Promise<T> => {
      events.push(name);
      if (['configure', 'copy', 'start', 'ready'].includes(name)) return undefined as T;
      if (name === 'migrate') return ['newer.sql'] as T;
      if (name === 'smoke') return 6 as T;
      return work();
    },
    cleanup: () => { events.push('cleanup'); },
  };
}

test('finding 5: restore invokes alignment between migration and readiness and persists its exact evidence', async () => {
  const artifactsRoot = mkdtempSync(join(root, '.temp', 'restore-alignment-'));
  const manifest = backup();
  manifest.modelGeneration = 'urn:rezics:model-generation:backup';
  const original = structuredClone(manifest);
  const events: string[] = [];
  let alignmentBudget = 0;
  const installation: LocalModelBootstrapResult = { state: 'completed', generation: fixtureModel(root).generation,
    artifacts: [{ name: 'manifest.json', sha256: '1'.repeat(64) }], artifactCount: 1 };
  try {
    const runtime = restoreRuntime(manifest, events, artifactsRoot);
    runtime.alignModel = async (checkout, stack, apps, stored, options) => {
      events.push('bootstrap');
      alignmentBudget = options!.remaining!();
      expect(options!.signal).toBeInstanceOf(AbortSignal);
      return alignFixtureModel(checkout, stack, apps, stored, options, async () => installation);
    };
    const evidence = await restoreFixture(manifest.id, `align-${randomUUID().slice(0, 8)}`, fixtureOwners, runtime);
    expect(events).toEqual(['compatibility', 'configure', 'copy', 'start', 'migrate', 'align-model', 'bootstrap', 'ready', 'smoke']);
    expect(alignmentBudget).toBeGreaterThan(0);
    expect(alignmentBudget).toBeLessThanOrEqual(600_000);
    expect(evidence.modelAlignment).toEqual({ backupGeneration: manifest.modelGeneration,
      currentGeneration: installation.generation, artifacts: installation.artifacts, artifactCount: 1, installation });
    expect(JSON.parse(readFileSync(join(evidence.artifacts, 'run.json'), 'utf8')).modelAlignment).toEqual(evidence.modelAlignment);
    expect(manifest).toEqual(original);
  } finally { rmSync(artifactsRoot, { recursive: true, force: true }); }
});

test('finding 5: restore maps alignment errors and timeouts to typed failure evidence and disposes the copy before readiness', async () => {
  const artifactsRoot = mkdtempSync(join(root, '.temp', 'restore-alignment-failure-'));
  const manifest = backup();
  try {
    for (const timeout of [false, true]) {
      const events: string[] = [];
      const runtime = restoreRuntime(manifest, events, artifactsRoot);
      runtime.deadlineMs = 150;
      runtime.alignModel = async (checkout, stack, apps, stored, options) => alignFixtureModel(checkout, stack, apps, stored, options,
        async () => { if (timeout) return new Promise<LocalModelBootstrapResult>(() => {}); throw new Error('owner alignment failed'); });
      const target = `align-failure-${randomUUID().slice(0, 8)}`;
      let failure: unknown;
      try { await restoreFixture(manifest.id, target, fixtureOwners, runtime); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(FixtureRestoreFailure);
      const evidence = (failure as FixtureRestoreFailure).evidence;
      expect(evidence.failurePhase).toBe('align-model');
      expect(evidence.failureKind).toBe(timeout ? 'timeout' : 'error');
      expect(evidence.failure).toContain(timeout ? 'timed out during align-model' : 'owner alignment failed');
      expect(evidence.modelAlignment).toBeUndefined();
      expect(events).toEqual(['compatibility', 'configure', 'copy', 'start', 'migrate', 'align-model', 'cleanup']);
      const saved = JSON.parse(readFileSync(join(artifactsRoot, target, 'run.json'), 'utf8')) as FixtureRestoreEvidence;
      expect(saved.failurePhase).toBe('align-model');
      expect(saved.failureKind).toBe(evidence.failureKind);
      if (timeout) expect((failure as FixtureRestoreFailure).cause).toBeInstanceOf(ModelAlignmentTimeout);
    }
  } finally { rmSync(artifactsRoot, { recursive: true, force: true }); }
});

test('finding 4: an exhausted remaining callback is a typed alignment-phase timeout', () => {
  expect(() => new ModelWorkBudget(() => { throw new Error('preparation deadline exhausted'); }))
    .toThrow(ModelAlignmentTimeout);
});
