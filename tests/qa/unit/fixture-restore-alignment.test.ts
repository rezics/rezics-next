import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureLocalDatasetModelGeneration, assertLocalModelOwner, type ModelBootstrapRuntime,
  custodyLocalModelArtifacts, type LocalModelBootstrapResult, type ModelBootstrapIntent,
  backfillLocalDatasetModelCustody } from '../../../scripts/datasets/model-bootstrap.ts';
import { alignFixtureModel } from '../../../scripts/fixture/align-model.ts';
import { fixtureCorpus } from '../../../scripts/fixture/corpus.ts';
import { manifestCore, manifestIdentity, type FixtureManifest } from '../../../scripts/fixture/manifest.ts';
import { fixtureModel } from '../../../scripts/fixture/model.ts';
import { ModelAlignmentTimeout, ModelWorkBudget } from '../../../scripts/fixture/model-deadline.ts';
import { fixtureOwners } from '../../../scripts/fixture/owners/index.ts';
import { restoreFixture, FixtureRestoreFailure, type FixtureRestoreRuntime,
  type FixtureRestoreEvidence } from '../../../scripts/fixture/restore.ts';
import { FusekiClient, type SparqlResult, type CommandEnvelope, type CommandResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { COMMAND_MODULE_VERSION } from '../../../services/main/src/infrastructure/profile.ts';
import { ACTIVE_GENERATION, ensureModelGeneration } from '../../../services/main/src/modules/semantic/command.ts';
import { readActiveModelGeneration, ModelGenerationChanged, type ActiveModelGeneration } from '../../../services/main/src/modules/semantic/generation-guard.ts';
import { PROFILES } from '../../../services/main/src/modules/semantic/schema.ts';
import { hash, RV, prepareWorkComponent } from '../../../services/main/src/modules/work/activate.ts';
import type { ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';

const root = resolve(import.meta.dir, '../../..');
const engines = { fuseki: { image: 'fuseki', id: 'fuseki' }, postgres: { image: 'postgres', id: 'postgres' },
  rustfs: { image: 'rustfs', id: 'rustfs' } };

function backup(seed?: string): FixtureManifest {
  const core = manifestCore(root, fixtureCorpus('small', seed, 6), fixtureOwners, engines);
  return { ...core, ...manifestIdentity(core), build: { startedAt: 'built', completedAt: 'built', elapsedMs: 1,
    phases: {}, textIndexGeneration: 'index', loads: {} }, backup: { project: 'backup', volumes: {} } };
}
function ownerFixture(create = true) {
  const project = `rezics-qa-model-${randomUUID().slice(0, 8)}`;
  const stack = join(root, '.temp/stack', project);
  const configure = () => { mkdirSync(stack, { recursive: true }); writeFileSync(join(stack, 'compose.env'), 'harness-owned'); };
  if (create) configure();
  const apps = { FUSEKI_URL: 'http://127.0.0.1:3030/rezics', FUSEKI_COMMAND_TOKEN: 'command',
    ACCOUNT_BASE_URL: 'http://127.0.0.1:3002',
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
  return { project, stack, apps, containers, configure, runtime: { docker: inspect, readEnv: () => apps,
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

class ModelObjects implements ImmutableObjects {
  readonly data = new Map<string, Uint8Array>();
  puts = 0;
  async put(bytes: Uint8Array): Promise<string> {
    this.puts++;
    const digest = hash(bytes);
    this.data.set(digest, new Uint8Array(bytes));
    return digest;
  }
  async get(digest: string): Promise<Uint8Array> {
    const bytes = this.data.get(digest);
    if (!bytes) throw new Error('model object absent');
    return bytes;
  }
}

class BootstrapGraph extends FusekiClient {
  readonly generations = new Map<string, ActiveModelGeneration>();
  readonly initialCommands: CommandEnvelope[] = [];
  readonly maintenanceUpdates: string[] = [];
  head?: string;
  foreignComponent = false;
  unknownEmptyRead = false;
  beforeCommit?: () => void;
  sequence = 0;
  constructor(readonly epoch: string, readonly routing: string) { super('http://unused.invalid'); }
  override async commandHealth() {
    return { moduleVersion: COMMAND_MODULE_VERSION, instanceId: 'bootstrap-fixture', publicSearchWriteEpoch: '0',
      publicSearchWriteActive: false, profiles: Object.fromEntries(Object.entries(profileRegistry).map(([id, profile]) => [id, profile.sha256])) };
  }
  private emptyGuardHolds(query: string): boolean {
    const generations = /FILTER NOT EXISTS\s*\{\s*GRAPH <urn:rezics:graph:revisions>\s*\{\s*\?\w+ a rv:ModelGeneration/.test(query);
    const components = /FILTER NOT EXISTS\s*\{\s*GRAPH <urn:rezics:graph:current>\s*\{\s*\?\w+ a rv:ModelComponent/.test(query);
    return !this.head && !this.generations.has(ACTIVE_GENERATION)
      && (!generations || this.generations.size === 0) && (!components || !this.foreignComponent);
  }
  override async query(query: string): Promise<SparqlResult> {
    const term = (value: string) => ({ type: 'uri', value });
    const rows = (values: Record<string, { type: string; value: string }>[]) => ({ results: { bindings: values } });
    if (query.includes('SELECT ?generation WHERE')) return rows(this.head ? [{ generation: term(this.head) }] : []);
    if (query.includes('SELECT ?manifest ?number')) {
      const active = this.head ? this.generations.get(this.head) : undefined;
      return rows(active ? [{ manifest: term(active.manifest), number: term(active.generationNumber),
        entailment: term(`${RV}NoEntailment`), digest: term(hash(JSON.stringify({ family: 'model-generation-v1',
          manifest: active.generation.slice('urn:rezics:model-generation:'.length) }))),
        ...(active.predecessor ? { predecessor: term(active.predecessor) } : {}) }] : []);
    }
    if (query.includes('SELECT ?epoch ?routing')) return rows([{ epoch: term(this.epoch), routing: term(this.routing), sequence: term(`${this.sequence}`) }]);
    if (query.includes('SELECT ?sequence')) return rows([{ sequence: term(`${this.sequence}`) }]);
    if (query.includes('FILTER NOT EXISTS')) {
      if (this.unknownEmptyRead) return {};
      const available = this.emptyGuardHolds(query);
      return { boolean: /ASK\s*\{\s*FILTER NOT EXISTS\s*\{\s*FILTER NOT EXISTS/.test(query) ? !available : available };
    }
    if (query.includes('generationHead')) return { boolean: this.head === ACTIVE_GENERATION && this.generations.has(ACTIVE_GENERATION) };
    if (query.includes(`<${ACTIVE_GENERATION}> ?p ?o`)) return { boolean: this.generations.has(ACTIVE_GENERATION) };
    throw new Error(`Unexpected model graph query: ${query.slice(0, 100)}`);
  }
  override async commandWithReceipt(command: CommandEnvelope): Promise<CommandResult> {
    this.beforeCommit?.();
    if (!this.emptyGuardHolds(command.update)) return { status: 'guard-unmatched' };
    this.initialCommands.push(command);
    const manifest = /rv:manifest <(urn:rezics:sha256:[a-f0-9]{64})>/.exec(command.update)?.[1];
    if (!manifest) throw new Error('Initial model command lacks its artifact manifest');
    this.sequence++;
    this.head = ACTIVE_GENERATION;
    this.generations.set(ACTIVE_GENERATION, { generation: ACTIVE_GENERATION, manifest,
      generationNumber: `${this.generations.size + 1}`, predecessor: null, entailmentProfile: 'NoEntailment', receipt: command.receipt });
    return { status: 'committed', position: { datasetId: 'product', dataEpoch: this.epoch, sequence: `${this.sequence}` } };
  }
  maintain(intent: ModelBootstrapIntent, update: string) {
    if (this.head !== intent.predecessor.generation || `${this.sequence}` !== intent.observedSequence)
      throw new Error('Maintenance predecessor/sequence CAS failed');
    expect(update).toContain(`rv:predecessor <${intent.predecessor.generation}>`);
    expect(update).toContain('rv:eventCount 0');
    this.sequence++;
    this.head = intent.generation;
    this.generations.set(intent.generation, { generation: intent.generation, manifest: intent.manifest,
      generationNumber: intent.generationNumber, predecessor: intent.predecessor.generation,
      entailmentProfile: 'NoEntailment', receipt: intent.receipt });
    this.maintenanceUpdates.push(update);
  }
}

test('round 2 finding 1: real model initialization refuses retained generations, foreign components and an unproven empty read', async () => {
  for (const state of ['retained-generation', 'foreign-component', 'unknown-read', 'concurrent-generation']) {
    const graph = new BootstrapGraph('epoch', 'routing');
    const objects = new ModelObjects();
    const retained: ActiveModelGeneration = { generation: `urn:rezics:model-generation:${'a'.repeat(64)}`,
      manifest: `urn:rezics:sha256:${'b'.repeat(64)}`, generationNumber: '1', predecessor: null,
      entailmentProfile: 'NoEntailment', receipt: 'old-receipt' };
    if (state === 'retained-generation') graph.generations.set(retained.generation, retained);
    if (state === 'foreign-component') graph.foreignComponent = true;
    if (state === 'unknown-read') graph.unknownEmptyRead = true;
    if (state === 'concurrent-generation') graph.beforeCommit = () => graph.generations.set(retained.generation, retained);
    await expect(ensureModelGeneration({ fuseki: graph, workObjects: objects, objectDirectory: '.temp/unused',
      lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } })).rejects.toBeInstanceOf(ModelGenerationChanged);
    expect(graph.head).toBeUndefined();
    expect(graph.initialCommands).toHaveLength(0);
    expect(graph.generations.has(ACTIVE_GENERATION)).toBe(false);
    if (state !== 'concurrent-generation') expect(objects.puts).toBe(0);
  }
});

test('round 2 finding 4: restore drives the real bootstrap from an empty model and an older retained active generation', async () => {
  const artifactsRoot = mkdtempSync(join(root, '.temp', 'restore-model-transition-'));
  try {
    for (const older of [false, true]) {
      const owner = ownerFixture(false);
      const manifest = backup(`model-transition-${randomUUID().slice(0, 12)}`);
      owner.apps.MAIN_DATA_EPOCH = manifest.lineage.dataEpoch;
      owner.apps.MAIN_ROUTING_EPOCH = manifest.lineage.routingEpoch;
      const graph = new BootstrapGraph(manifest.lineage.dataEpoch, manifest.lineage.routingEpoch);
      const objects = new ModelObjects();
      const oldGeneration = `urn:rezics:model-generation:${'a'.repeat(64)}`;
      const originalObjectDirectory = owner.apps.MAIN_OBJECT_DIRECTORY;
      const checkpoint = join(root, '.temp/datasets/model-bootstrap', hash(JSON.stringify([
        owner.apps.FUSEKI_URL, owner.apps.MAIN_DATA_EPOCH, ACTIVE_GENERATION])));
      const audits: string[] = [];
      try {
        manifest.modelGeneration = oldGeneration;
        if (older) {
          const digest = await prepareWorkComponent(objects, oldGeneration,
            { modelManifestSha256: 'a'.repeat(64), commandModule: COMMAND_MODULE_VERSION, entailment: 'none' }, PROFILES.generation);
          graph.generations.set(oldGeneration, { generation: oldGeneration, manifest: `urn:rezics:sha256:${digest}`,
            generationNumber: '1', predecessor: null, entailmentProfile: 'NoEntailment', receipt: 'old-receipt' });
          graph.head = oldGeneration;
          graph.sequence = 1;
        }
        const events: string[] = [];
        const inspectServices = owner.runtime.docker;
        const restore = restoreRuntime(manifest, events, artifactsRoot);
        restore.readApps = () => owner.apps;
        restore.runPhase = async <T>(name: string, work: () => T | Promise<T>): Promise<T> => {
          events.push(name);
          if (name === 'configure') { owner.configure(); return undefined as T; }
          if (['copy', 'start', 'ready'].includes(name)) return undefined as T;
          if (name === 'migrate') return [] as T;
          if (name === 'postgres-collation') return [] as T;
          if (name === 'smoke') return 6 as T;
          return work();
        };
        const runtime: Partial<ModelBootstrapRuntime> = { readEnv: owner.runtime.readEnv,
          fuseki: () => graph, readHead: readActiveModelGeneration,
          initialize: ensureModelGeneration, objects: () => objects,
          audit: async (_pool, input) => { audits.push(input.targetId); },
          docker: (args, timeout) => {
            if (args.includes('shacl.shacl')) return '@prefix sh: <http://www.w3.org/ns/shacl#> . [] sh:conforms true .';
            if (args.some(arg => arg.includes('tdb2.tdbupdate'))) {
              const mount = args.find(arg => arg.startsWith('type=bind,src='))!;
              const directory = /src=([^,]+)/.exec(mount)![1]!;
              const intent = JSON.parse(readFileSync(join(directory, 'intent.json'), 'utf8')) as ModelBootstrapIntent;
              graph.maintain(intent, readFileSync(join(directory, 'update.ru'), 'utf8'));
              return '';
            }
            if (args[0] === 'start' || args[0] === 'stop') return '';
            return inspectServices(args, timeout);
          },
        };
        restore.alignModel = (checkout, stack, apps, stored, options) => alignFixtureModel(checkout, stack, apps, stored,
          { ...options, runtime });
        const evidence = await restoreFixture(manifest.id, owner.project.slice('rezics-qa-'.length), fixtureOwners, restore);
        const active = await readActiveModelGeneration(graph);
        expect(active.generation).toBe(ACTIVE_GENERATION);
        expect(active.generationNumber).toBe(older ? '2' : '1');
        expect(active.predecessor).toBe(older ? oldGeneration : null);
        expect(evidence.modelAlignment?.currentGeneration).toBe(ACTIVE_GENERATION);
        expect(evidence.modelAlignment?.backupGeneration).toBe(oldGeneration);
        expect(graph.initialCommands).toHaveLength(older ? 0 : 1);
        expect(graph.maintenanceUpdates).toHaveLength(older ? 1 : 0);
        expect(audits).toEqual(older ? [ACTIVE_GENERATION] : []);
        if (older) expect(graph.generations.has(oldGeneration)).toBe(true);
        else expect(graph.initialCommands[0]!.update).toContain('rv:ModelGenerationRecordedEvent');
        expect(owner.apps.MAIN_OBJECT_DIRECTORY).toBe(originalObjectDirectory);
      } finally { owner.close(); rmSync(checkpoint, { recursive: true, force: true }); }
    }
  } finally { rmSync(artifactsRoot, { recursive: true, force: true }); }
});

test('round 2 finding 5: both maintenance entries use apps.env for a prepared persistent QA stack', async () => {
  const owner = ownerFixture();
  const reads: string[] = [];
  const objects = new ModelObjects();
  const dev = { ...owner.apps, ACCOUNT_OPERATOR_USER_IDS: 'operator', WEB_OAUTH_CLIENT_ID: 'web' };
  const runtime: Partial<ModelBootstrapRuntime> = { ...owner.runtime,
    readEnv: path => { reads.push(path); return path.endsWith('/dev.env') ? dev : owner.apps; }, objects: () => objects };
  try {
    const result = await ensureLocalDatasetModelGeneration(owner.stack, undefined, { runtime });
    expect(result.state).toBe('current');
    expect(reads.every(path => path.endsWith('/apps.env'))).toBe(true);
    reads.length = 0;
    const reachedGraph = new Error('ownership passed; graph construction reached');
    await expect(backfillLocalDatasetModelCustody({ buildDirectories: [] }, owner.stack,
      { ...runtime, fuseki: () => { throw reachedGraph; } })).rejects.toBe(reachedGraph);
    expect(reads.every(path => path.endsWith('/apps.env'))).toBe(true);
    expect(reads).toHaveLength(2);
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
      if (name === 'postgres-collation') return [] as T;
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
    expect(events).toEqual(['compatibility', 'configure', 'copy', 'start', 'postgres-collation', 'migrate', 'align-model', 'bootstrap', 'ready', 'smoke']);
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
      expect(events).toEqual(['compatibility', 'configure', 'copy', 'start', 'postgres-collation', 'migrate', 'align-model', 'cleanup']);
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
