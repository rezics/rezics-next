import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import { Pool } from 'pg';
import {
  SemanticModelGenerationV1GenerationShapeSchema,
  SemanticModelGenerationV1HeadShapeSchema,
} from '../../packages/model/src/generated/schemas.ts';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';
import { writeAudit } from '../../services/account/src/operators.ts';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects, type ImmutableObjects } from '../../services/main/src/infrastructure/immutable-objects.ts';
import {
  assertCommandProfiles,
  COMMAND_MODULE_VERSION,
} from '../../services/main/src/infrastructure/profile.ts';
import {
  ModelGenerationUnavailable,
  readActiveModelGeneration,
  type ActiveModelGeneration,
} from '../../services/main/src/modules/semantic/generation-guard.ts';
import { ensureModelGeneration } from '../../services/main/src/modules/semantic/command.ts';
import { MODEL_COMPONENT, PROFILES } from '../../services/main/src/modules/semantic/schema.ts';
import { backfillRetainedModelCustody, custodyModelGenerationArtifacts,
  type ModelCustodyBackfillCheckpoint } from '../../services/main/src/modules/semantic/model-custody.ts';
import {
  DATASET,
  GRAPHS,
  RV,
  iri,
  lit,
  prepareComponent,
  prepareWorkComponent,
  type GraphLineage,
  type WorkActivationEnvironment,
} from '../../services/main/src/modules/work/activate.ts';
import { readWorkComponentState } from '../../services/main/src/modules/work/history.ts';
import { checkedLocalDatabase, datasetAdminPath } from './bootstrap.ts';
import { readEnv } from '../dev/config.ts';
import { atomicJson, repository, sha256 } from './store.ts';
import { tryAcquireDirectoryLease, type AcquiredDirectoryLease } from '../qa/process/lease.ts';
import { ModelWorkBudget, modelWork } from '../fixture/model-deadline.ts';

function holdDirectory(lock: string, busy: string): AcquiredDirectoryLease {
  const lease = tryAcquireDirectoryLease(lock);
  if (lease === 'held') throw new Error(busy);
  return lease;
}

const PROFILE = 'semantic-model-generation-v1';
const JENA = '/opt/apache-jena-fuseki-6.2.0/fuseki-server.jar';
const REASON =
  'Human-authorized local fixture model configuration advance; no business data or old model artifacts changed';
const modelFile = join(repository, 'generated/model/manifest.json');
const shapeFile = join(repository, 'generated/model/shapes/semantic-model-generation-v1.ttl');

export interface ModelBootstrapIntent {
  format: 'rezics-local-dataset-model-bootstrap-v1';
  predecessor: ActiveModelGeneration;
  generation: string;
  modelManifestSha256: string;
  manifest: string;
  operation: string;
  receipt: string;
  digest: string;
  lineage: GraphLineage;
  observedSequence: string;
  generationNumber: string;
  commandModuleVersion: string;
}

export function checkedLocalModelEndpoint(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Model fixture bootstrap requires an explicitly ported loopback owner endpoint',
    );
  return value;
}

/** Profile validation is repeated by pinned Jena SHACL against explicit focus targets before any write. */
export function modelBootstrapCandidate(intent: ModelBootstrapIntent): string {
  if (
    !/^[a-f0-9]{64}$/.test(intent.modelManifestSha256) ||
    intent.generation !== `urn:rezics:model-generation:${intent.modelManifestSha256}` ||
    !/^urn:rezics:sha256:[a-f0-9]{64}$/.test(intent.manifest) ||
    intent.receipt !== `urn:rezics:receipt:${sha256(`${intent.generation}\0model-generation`)}` ||
    intent.digest !==
      sha256(
        JSON.stringify({ family: 'model-generation-v1', manifest: intent.modelManifestSha256 }),
      ) ||
    !/^https:\/\/rezics\.com\/id\/[a-f0-9-]{36}$/.test(intent.operation) ||
    !/^[1-9][0-9]*$/.test(intent.predecessor.generationNumber) ||
    BigInt(intent.generationNumber) !== BigInt(intent.predecessor.generationNumber) + 1n ||
    !/^(0|[1-9][0-9]*)$/.test(intent.observedSequence)
  )
    throw new Error('Invalid model maintenance intent');
  const generation = {
    '@id': intent.generation,
    'rdf:type': [`${RV}ModelGeneration`, `${RV}RevisionAnchor`],
    'rv:component': [MODEL_COMPONENT],
    'rv:generationNumber': [Number(intent.generationNumber)],
    'rv:predecessor': [intent.predecessor.generation],
    'rv:manifest': [intent.manifest],
    'rv:commandModuleVersion': [intent.commandModuleVersion],
    'rv:entailmentProfile': [`${RV}NoEntailment`],
    'rv:identityInference': [`${RV}Excluded`],
    'rv:validationPosture': [`${RV}RejectOnViolation`],
    'rv:operation': [intent.operation],
    'rv:modelRevision': [PROFILES.generation],
    'rv:shapeRevision': [PROFILES.generation],
    'rv:datasetId': [DATASET],
    'rv:dataEpoch': [intent.lineage.dataEpoch],
    'rv:sequence': [Number(BigInt(intent.observedSequence) + 1n)],
  };
  const head = {
    '@id': MODEL_COMPONENT,
    'rdf:type': [`${RV}ModelComponent`],
    'rv:generationHead': [intent.generation],
  };
  if (
    !Value.Check(SemanticModelGenerationV1GenerationShapeSchema, generation) ||
    !Value.Check(SemanticModelGenerationV1HeadShapeSchema, head) ||
    !Number.isSafeInteger(generation['rv:generationNumber'][0]) ||
    !Number.isSafeInteger(generation['rv:sequence'][0])
  ) {
    throw new Error('Model fixture candidate violates the generated generation/head schema');
  }
  return `PREFIX rv: <${RV}>
${iri(intent.predecessor.generation)} a rv:ModelGeneration .
${iri(MODEL_COMPONENT)} a rv:ModelComponent ; rv:generationHead ${iri(intent.generation)} .
${generationTriples(intent, `${BigInt(intent.observedSequence) + 1n}`)}\n`;
}

function generationTriples(intent: ModelBootstrapIntent, sequence: string): string {
  return `${iri(intent.generation)} a rv:ModelGeneration, rv:RevisionAnchor ; rv:component ${iri(MODEL_COMPONENT)} ;
    rv:generationNumber ${intent.generationNumber} ; rv:predecessor ${iri(intent.predecessor.generation)} ; rv:manifest ${iri(intent.manifest)} ;
    rv:commandModuleVersion ${lit(intent.commandModuleVersion)} ; rv:entailmentProfile rv:NoEntailment ;
    rv:identityInference rv:Excluded ; rv:validationPosture rv:RejectOnViolation ; rv:operation ${iri(intent.operation)} ;
    rv:modelRevision ${iri(PROFILES.generation)} ; rv:shapeRevision ${iri(PROFILES.generation)} ; rv:datasetId ${iri(DATASET)} ;
    rv:dataEpoch ${lit(intent.lineage.dataEpoch)} ; rv:sequence ${sequence} .`;
}

/** An explicitly offline fixture configuration change, not an interactive business admission.
 * Zero-event batches preserve the relay sequence contract without emitting the bootstrap-only
 * ModelGenerationRecordedEvent, whose existing receiver admits only generation 1. */
export function modelBootstrapUpdate(intent: ModelBootstrapIntent): string {
  modelBootstrapCandidate(intent);
  const batch = `urn:rezics:outbox:${sha256(intent.receipt)}`;
  return `PREFIX rv: <${RV}>
DELETE {
  GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
  GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ${iri(intent.predecessor.generation)} }
}
INSERT {
  GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
  GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ${iri(intent.generation)} }
  GRAPH ${iri(GRAPHS.revisions)} { ${generationTriples(intent, '?next')} }
  GRAPH ${iri(GRAPHS.receipts)} { ${iri(intent.receipt)} a rv:OperationReceipt ; rv:operation ${iri(intent.operation)} ;
    rv:requestDigest ${lit(intent.digest)} ; rv:outcome rv:Succeeded ; rv:expectedHead ${iri(intent.predecessor.generation)} ;
    rv:commandFamily "local-dataset-model-generation-bootstrap-v1" ; rv:maintenanceReason ${lit(REASON)} ;
    rv:component ${iri(MODEL_COMPONENT)} ; rv:revision ${iri(intent.generation)} ; rv:datasetId ${iri(DATASET)} ;
    rv:dataEpoch ${lit(intent.lineage.dataEpoch)} ; rv:sequence ?next . }
  GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(intent.lineage.dataEpoch)} ;
    rv:sequence ?next ; rv:eventCount 0 . }
}
WHERE {
  GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(intent.lineage.dataEpoch)} ;
    rv:routingEpoch ${lit(intent.lineage.routingEpoch)} ; rv:sequence ?n }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
  GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} a rv:ModelComponent ; rv:generationHead ${iri(intent.predecessor.generation)} }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ?otherHead
    FILTER(?otherHead != ${iri(intent.predecessor.generation)}) } }
  GRAPH ${iri(GRAPHS.revisions)} { ${iri(intent.predecessor.generation)} a rv:ModelGeneration ;
    rv:generationNumber ${intent.predecessor.generationNumber} ; rv:manifest ${iri(intent.predecessor.manifest)} }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ${iri(intent.generation)} ?p ?o } }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(intent.receipt)} ?p ?o } }
  FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} ?p ?o } }
  BIND(?n + 1 AS ?next)
}`;
}

function docker(args: string[], timeout = 30_000): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 1_048_576 }).trim();
}

interface LocalModelContainer {
  Id: string; Image: string;
  Config: { Env: string[]; Labels: Record<string, string> };
  Mounts: { Type: string; Name: string; Destination: string; RW: boolean }[];
  NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[]> };
}

export interface ModelBootstrapRuntime {
  docker: typeof docker;
  readEnv: typeof readEnv;
  assertProfiles: typeof assertCommandProfiles;
  readHead: typeof readActiveModelGeneration;
  initialize: typeof ensureModelGeneration;
  custody: typeof custodyModelGenerationArtifacts;
  objects: (env: Record<string, string>, signal: AbortSignal) => ImmutableObjects;
  fuseki: (env: Record<string, string>, signal?: AbortSignal) => FusekiClient;
  audit: typeof writeAudit;
}

const modelBootstrapRuntime: ModelBootstrapRuntime = {
  docker, readEnv, assertProfiles: assertCommandProfiles, readHead: readActiveModelGeneration,
  initialize: ensureModelGeneration, custody: custodyModelGenerationArtifacts,
  fuseki: (env, signal) => new FusekiClient(env.FUSEKI_URL!, env.FUSEKI_MAINTENANCE_TOKEN, env.FUSEKI_COMMAND_TOKEN, signal),
  audit: writeAudit,
  objects: (env, signal) => new S3ImmutableObjects({
    endpoint: checkedLocalModelEndpoint(env.MAIN_S3_ENDPOINT!), bucket: env.MAIN_S3_BUCKET!,
    region: env.MAIN_S3_REGION, accessKeyId: env.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: env.MAIN_S3_SECRET_KEY!, prefix: 'semantic/work/', readSignal: () => signal,
  }),
};

export interface ModelBootstrapOptions {
  signal?: AbortSignal;
  remaining?: () => number;
  runtime?: Partial<ModelBootstrapRuntime>;
}
export interface ModelArtifactEvidence { name: string; sha256: string }
export interface LocalModelBootstrapResult extends Record<string, unknown> {
  state: 'current' | 'completed'; generation: string;
  artifacts: ModelArtifactEvidence[]; artifactCount: number;
}

/** QA storage starts from apps.env; dev.env additionally contains process/UI inputs. */
export function modelStackEnvironmentFile(stack: string): string {
  return join(stack, basename(stack).startsWith('rezics-qa-') ? 'apps.env' : 'dev.env');
}

/** Match saved configuration, Compose labels, named volumes and owner endpoints
 * before every bootstrap, custody and audit write, including current-head paths. */
export function assertLocalModelOwner(stack: string, env: Record<string, string>,
  inspect: typeof docker = docker, savedEnvironment: typeof readEnv = readEnv): LocalModelContainer {
  const project = basename(stack);
  if (!/^rezics-(dev|qa-[a-z0-9-]+)$/.test(project)
    || basename(dirname(stack)) !== 'stack' || basename(dirname(dirname(stack))) !== '.temp'
    || !existsSync(join(stack, 'compose.env')))
    throw new Error('Model maintenance requires a harness-owned stack configuration');
  const saved = savedEnvironment(modelStackEnvironmentFile(stack));
  if (Object.entries(env).some(([key, value]) => saved[key] !== value))
    throw new Error('Model environment differs from the harness-owned stack');
  const contexts = JSON.parse(inspect(['context', 'inspect'])) as { Endpoints: { docker: { Host: string } } }[];
  if (!contexts[0]?.Endpoints.docker.Host.startsWith('unix://')
    || (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://')))
    throw new Error('Model fixture maintenance requires a local Unix Docker owner');
  let graph: LocalModelContainer | undefined;
  const services = [
    { service: 'fuseki', volume: 'fuseki_data', destination: '/fuseki/databases', port: '3030/tcp',
      endpoint: env.FUSEKI_URL!, credentials: [`FUSEKI_COMMAND_TOKEN=${env.FUSEKI_COMMAND_TOKEN}`] },
    { service: 'postgres', volume: 'postgres_data', destination: '/var/lib/postgresql', port: '5432/tcp',
      endpoint: env.ACCOUNT_DATABASE_URL!, credentials: [] },
    ...(env.MAIN_S3_ENDPOINT ? [{ service: 'rustfs', volume: 'rustfs_data', destination: '/data', port: '9000/tcp',
      endpoint: env.MAIN_S3_ENDPOINT, credentials: [`RUSTFS_ACCESS_KEY=${env.MAIN_S3_ACCESS_KEY}`,
        `RUSTFS_SECRET_KEY=${env.MAIN_S3_SECRET_KEY}`] }] : []),
  ];
  for (const owner of services) {
    const id = inspect(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`,
      '--filter', `label=com.docker.compose.service=${owner.service}`]);
    if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error(`Exactly one running local ${owner.service} owner is required`);
    const container = (JSON.parse(inspect(['inspect', id])) as LocalModelContainer[])[0];
    const endpoint = new URL(owner.endpoint);
    if (!container || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || !endpoint.port
      || container.Config.Labels['com.docker.compose.project'] !== project
      || container.Config.Labels['com.docker.compose.service'] !== owner.service
      || !container.Mounts.some(mount => mount.Type === 'volume' && mount.Name === `${project}_${owner.volume}`
        && mount.Destination === owner.destination && mount.RW)
      || owner.credentials.some(credential => !container.Config.Env.includes(credential))
      || !container.NetworkSettings.Ports[owner.port]?.some(port => ['127.0.0.1', '::1'].includes(port.HostIp)
        && port.HostPort === endpoint.port))
      throw new Error(`${owner.service} container differs from the configured harness owner`);
    if (owner.service === 'fuseki') graph = container;
  }
  if (!graph) throw new Error('Local graph owner is absent');
  return graph;
}

/** Report only shapes read/verified by successful custody and its manifest. */
export async function custodyLocalModelArtifacts(environment: WorkActivationEnvironment, generation: string,
  bytes: Uint8Array, readShape: (file: string) => Uint8Array,
  custody: typeof custodyModelGenerationArtifacts = custodyModelGenerationArtifacts, signal?: AbortSignal,
): Promise<ModelArtifactEvidence[]> {
  const artifacts: ModelArtifactEvidence[] = [];
  await modelWork(signal, () => custody(environment, generation, bytes, file => {
    signal?.throwIfAborted();
    const shape = readShape(file);
    artifacts.push({ name: file, sha256: sha256(shape) });
    return shape;
  }));
  return [...artifacts, { name: 'manifest.json', sha256: sha256(bytes) }];
}

async function finalizeModelBootstrap(
  env: Record<string, string>,
  fuseki: FusekiClient,
  intent: ModelBootstrapIntent,
  active: ActiveModelGeneration,
  directory: string,
  auditActor?: string,
  budget?: ModelWorkBudget,
  audit: typeof writeAudit = writeAudit,
): Promise<Record<string, unknown>> {
  if (
    active.generation !== intent.generation ||
    active.predecessor !== intent.predecessor.generation ||
    active.manifest !== intent.manifest ||
    active.generationNumber !== intent.generationNumber ||
    intent.lineage.dataEpoch !== env.MAIN_DATA_EPOCH ||
    intent.lineage.routingEpoch !== env.MAIN_ROUTING_EPOCH
  )
    throw new Error('Committed model bootstrap differs from its exact maintenance intent');
  const receipt = await modelWork(budget?.signal, () => fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(intent.receipt)} rv:requestDigest ${lit(intent.digest)} ; rv:outcome rv:Succeeded ;
      rv:operation ${iri(intent.operation)} ; rv:dataEpoch ${lit(intent.lineage.dataEpoch)} ; rv:sequence ?sequence . }
    GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${sha256(intent.receipt)}`)} a rv:OutboxBatch ;
      rv:dataEpoch ${lit(intent.lineage.dataEpoch)} ; rv:sequence ?sequence ; rv:eventCount 0 . }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(intent.predecessor.generation)} a rv:ModelGeneration ;
      rv:manifest ${iri(intent.predecessor.manifest)} ; rv:generationNumber ${intent.predecessor.generationNumber} . }
  } LIMIT 2`));
  const rows = receipt.results?.bindings ?? [],
    sequence = rows[0]?.sequence?.value;
  if (rows.length !== 1 || !sequence)
    throw new Error('Model bootstrap lost its predecessor or exact sequenced zero-event receipt');
  const actorPath = datasetAdminPath(env.ACCOUNT_ORIGIN ?? env.ACCOUNT_BASE_URL!);
  const actor = auditActor ?? (existsSync(actorPath)
    ? (JSON.parse(readFileSync(actorPath, 'utf8')) as { id?: string }).id
    : undefined);
  if (!actor)
    throw new Error(
      'Model bootstrap needs the existing dedicated dataset administrator audit identity',
    );
  const account = new Pool({ connectionString: checkedLocalDatabase(env.ACCOUNT_DATABASE_URL!),
    ...(budget ? { statement_timeout: budget.remaining(), connectionTimeoutMillis: budget.remaining() } : {}) });
  try {
    await modelWork(budget?.signal, () => audit(account, {
      actorId: actor,
      action: 'local_dataset_model_generation_bootstrapped',
      targetId: intent.generation,
      reason: REASON,
      before: intent.predecessor,
      after: { ...active, sequence, outbox: 'local-fixture-zero-event-batch' },
      requestId: randomUUID(),
    }));
  } finally {
    const closing = account.end();
    await modelWork(budget?.signal, () => closing);
  }
  const completed = {
    state: 'completed',
    ...active,
    sequence,
    intentPath: join(directory, 'intent.json'),
    reason: REASON,
    outbox: 'local-fixture-zero-event-batch',
    completedAt: new Date().toISOString(),
  };
  budget?.remaining();
  atomicJson(join(directory, 'completed.json'), completed);
  return completed;
}

export interface FixtureModelBootstrap {
  apps: Record<string, string>;
  /** The retained fixture import is the audited tool identity, not an Account user. */
  importOperation: string;
}

/** Storage-only fixture maintenance still uses the same local owner checks and
 * append-only Account audit; a fixture identity is confined to an isolated QA stack. */
export function fixtureModelAuditActor(stack: string, fixture: FixtureModelBootstrap): string {
  if (!/^rezics-qa-[a-z0-9-]+$/.test(basename(stack))
    || !/^urn:rezics:operation:fixture-[a-f0-9]{32}$/.test(fixture.importOperation))
    throw new Error('Fixture model alignment requires an isolated QA stack and fixture import identity');
  return fixture.importOperation;
}

/** Bulk imports have no semantic command to record their initial model head.
 * The owning bootstrap decides whether the model is empty; partial or retained
 * state still fails its existing guard rather than being repaired here. */
export async function localDatasetModelHead(environment: WorkActivationEnvironment, fixture: boolean,
  read: typeof readActiveModelGeneration = readActiveModelGeneration,
  initialize: typeof ensureModelGeneration = ensureModelGeneration,
  signal?: AbortSignal,
): Promise<{ active: ActiveModelGeneration; bootstrapped: boolean }> {
  try { return { active: await modelWork(signal, () => read(environment.fuseki)), bootstrapped: false }; }
  catch (error) {
    if (!fixture || !(error instanceof ModelGenerationUnavailable)) throw error;
    await modelWork(signal, () => initialize(environment));
    return { active: await modelWork(signal, () => read(environment.fuseki)), bootstrapped: true };
  }
}

export async function ensureLocalDatasetModelGeneration(
  stack = process.env.REZICS_DATASET_STACK ?? join(repository, '.temp/stack/rezics-dev'),
  fixture?: FixtureModelBootstrap,
  options: ModelBootstrapOptions = {},
): Promise<LocalModelBootstrapResult> {
  const deadline = Date.now() + 180_000;
  const budget = new ModelWorkBudget(options.remaining ?? (() => deadline - Date.now()), options.signal);
  try {
    return await budget.run(() => alignLocalDatasetModelGeneration(stack, fixture,
      { ...modelBootstrapRuntime, ...options.runtime }, budget));
  } finally { budget.close(); }
}

/** A running container can still be opening TDB2 after restart. Only readiness
 * is retried: profile compatibility and model admission keep their own errors.
 * The shared budget also bounds in-flight health requests and retry sleeps. */
export async function waitForModelOwner(fuseki: Pick<FusekiClient, 'commandHealth'>,
  budget: ModelWorkBudget): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await budget.run(() => fuseki.commandHealth());
      return;
    } catch (error) {
      budget.remaining();
      if (attempt === 30) throw error;
      await budget.run(() => Bun.sleep(500));
    }
  }
}

async function alignLocalDatasetModelGeneration(stack: string, fixture: FixtureModelBootstrap | undefined,
  runtime: ModelBootstrapRuntime, budget: ModelWorkBudget): Promise<LocalModelBootstrapResult> {
  const docker = (args: string[], timeout = 30_000) => {
    const result = runtime.docker(args, Math.min(timeout, budget.remaining()));
    budget.remaining();
    return result;
  };
  const auditActor = fixture ? fixtureModelAuditActor(stack, fixture) : undefined;
  const env = fixture?.apps ?? runtime.readEnv(modelStackEnvironmentFile(stack));
  const container = assertLocalModelOwner(stack, env, docker, runtime.readEnv);
  checkedLocalModelEndpoint(env.FUSEKI_URL!);
  const fuseki = runtime.fuseki(env, budget.signal);
  await waitForModelOwner(fuseki, budget);
  await budget.run(() => runtime.assertProfiles(fuseki));
  const bytes = readFileSync(modelFile),
    modelManifestSha256 = sha256(bytes);
  const generation = `urn:rezics:model-generation:${modelManifestSha256}`;
  const context = sha256(JSON.stringify([env.FUSEKI_URL, env.MAIN_DATA_EPOCH, generation]));
  const directory = join(repository, '.temp/datasets/model-bootstrap', context);
  const intentPath = join(directory, 'intent.json');
  const objects = env.MAIN_S3_ENDPOINT ? runtime.objects(env, budget.signal) : undefined;
  const workObjects: ImmutableObjects | undefined = objects ? {
    put: bytes => budget.run(() => objects.put(bytes, budget.signal)),
    get: (digest, maxBytes) => budget.run(() => objects.get(digest, maxBytes, budget.signal)),
  } : undefined;
  const environment = {
    fuseki,
    lineage: { dataEpoch: env.MAIN_DATA_EPOCH!, routingEpoch: env.MAIN_ROUTING_EPOCH! },
    objectDirectory: env.MAIN_OBJECT_DIRECTORY!,
    ...(workObjects ? { workObjects } : {}),
  };
  const { active: predecessor, bootstrapped } = await budget.run(() => localDatasetModelHead(environment,
    Boolean(fixture), runtime.readHead, runtime.initialize, budget.signal));
  if (predecessor.generation === generation) {
    // An existing head, including a lost maintenance response, needs the same
    // exact artifact custody as a newly activated generation.
    const artifacts = await budget.run(() => custodyLocalModelArtifacts(environment, generation, bytes,
      file => readFileSync(join(repository, 'generated/model', file)), runtime.custody, budget.signal));
    if (existsSync(intentPath) && !existsSync(join(directory, 'completed.json')))
      return { ...await budget.run(() => finalizeModelBootstrap(
        env,
        fuseki,
        JSON.parse(readFileSync(intentPath, 'utf8')) as ModelBootstrapIntent,
        predecessor,
        directory,
        auditActor,
        budget,
        runtime.audit,
      )), state: 'completed', generation, artifacts, artifactCount: artifacts.length };
    return { state: 'current', generation, generationNumber: predecessor.generationNumber, artifacts, artifactCount: artifacts.length,
      ...(bootstrapped ? { bootstrapped: true, receipt: predecessor.receipt } : {}) };
  }
  const auditActorPath = datasetAdminPath(env.ACCOUNT_ORIGIN ?? env.ACCOUNT_BASE_URL!);
  if (
    !auditActor && (!existsSync(auditActorPath) ||
    !(JSON.parse(readFileSync(auditActorPath, 'utf8')) as { id?: string }).id)
  )
    throw new Error(
      'Model bootstrap needs the existing dedicated dataset administrator audit identity',
    );
  checkedLocalDatabase(env.ACCOUNT_DATABASE_URL!);
  const location =
    await budget.run(() => fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?routing ?sequence ?hold WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ?routing ; rv:sequence ?sequence .
      OPTIONAL { ${iri(DATASET)} rv:restoreHold ?hold } }
  } LIMIT 2`));
  const rows = location.results?.bindings ?? [],
    row = rows[0];
  if (
    rows.length !== 1 ||
    row?.epoch?.value !== env.MAIN_DATA_EPOCH ||
    row.routing?.value !== env.MAIN_ROUTING_EPOCH ||
    !row.sequence?.value ||
    row.hold?.value === 'true'
  )
    throw new Error('Model maintenance requires matching open local graph lineage');
  const existing = await budget.run(() => fuseki.query(
    `ASK { GRAPH ${iri(GRAPHS.revisions)} { ${iri(generation)} ?p ?o } }`,
  ));
  if (existing.boolean)
    throw new Error(
      'Target model generation already has immutable history; refuse to overwrite or reactivate it implicitly',
    );
  await budget.run(() => readWorkComponentState(
    environment,
    predecessor.manifest,
    predecessor.generation,
    PROFILES.generation,
  ));
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, 'lock');
  const maintenance = holdDirectory(lock, `Model fixture maintenance already active; inspect ${lock} before retrying`);
  try {
    const artifacts = await budget.run(() => custodyLocalModelArtifacts(environment, generation, bytes,
      file => readFileSync(join(repository, 'generated/model', file)), runtime.custody, budget.signal));
    let intent: ModelBootstrapIntent;
    if (existsSync(intentPath))
      intent = JSON.parse(readFileSync(intentPath, 'utf8')) as ModelBootstrapIntent;
    else {
      const state = {
        modelManifestSha256,
        commandModule: COMMAND_MODULE_VERSION,
        entailment: 'none',
        maintenance: {
          profile: 'rezics-local-dataset-model-bootstrap-v1',
          predecessor: predecessor.generation,
          reason: REASON,
        },
      };
      const digest = workObjects
        ? await budget.run(() => prepareWorkComponent(workObjects, generation, state, PROFILES.generation))
        : prepareComponent(env.MAIN_OBJECT_DIRECTORY!, generation, state, PROFILES.generation);
      intent = {
        format: 'rezics-local-dataset-model-bootstrap-v1',
        predecessor,
        generation,
        modelManifestSha256,
        manifest: `urn:rezics:sha256:${digest}`,
        operation: `https://rezics.com/id/${Bun.randomUUIDv7()}`,
        receipt: `urn:rezics:receipt:${sha256(`${generation}\0model-generation`)}`,
        digest: sha256(
          JSON.stringify({ family: 'model-generation-v1', manifest: modelManifestSha256 }),
        ),
        lineage: environment.lineage,
        observedSequence: row.sequence.value,
        generationNumber: `${BigInt(predecessor.generationNumber) + 1n}`,
        commandModuleVersion: COMMAND_MODULE_VERSION,
      };
      atomicJson(intentPath, intent);
    }
    if (
      intent.predecessor.generation !== predecessor.generation ||
      intent.modelManifestSha256 !== modelManifestSha256 ||
      JSON.stringify(intent.lineage) !== JSON.stringify(environment.lineage)
    )
      throw new Error(
        'Model maintenance checkpoint no longer matches the live predecessor/lineage',
      );
    const candidate = modelBootstrapCandidate(intent),
      update = modelBootstrapUpdate(intent);
    const shapes = readFileSync(shapeFile, 'utf8');
    if (sha256(shapes) !== profileRegistry[PROFILE].sha256)
      throw new Error('Generation shape source differs from its reviewed registry digest');
    writeFileSync(join(directory, 'candidate.ttl'), candidate);
    writeFileSync(
      join(directory, 'shapes.ttl'),
      `${shapes}\n<${PROFILES.generation}/generation-shape> <http://www.w3.org/ns/shacl#targetNode> ${iri(generation)} .\n<${PROFILES.generation}/head-shape> <http://www.w3.org/ns/shacl#targetNode> ${iri(MODEL_COMPONENT)} .\n`,
    );
    writeFileSync(join(directory, 'update.ru'), update);
    const validation = docker(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--hostname',
        'localhost',
        '--mount',
        `type=bind,src=${directory},dst=/maintenance,readonly`,
        '--entrypoint',
        'java',
        container.Image,
        '-cp',
        JENA,
        'shacl.shacl',
        'validate',
        '--shapes=/maintenance/shapes.ttl',
        '--data=/maintenance/candidate.ttl',
      ],
      60_000,
    );
    if (!/sh:conforms\s+true/.test(validation) || /sh:conforms\s+false/.test(validation))
      throw new Error('Pinned Jena rejected the model generation/head candidate');
    writeFileSync(join(directory, 'validation.ttl'), validation);
    if (sha256(readFileSync(modelFile)) !== modelManifestSha256)
      throw new Error('Maintainer changed the model manifest during fixture preparation');
    let stopped = false;
    try {
      stopped = true;
      docker(['stop', '--time', '60', container.Id], 75_000);
      const result = docker(
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--hostname',
          'localhost',
          '--volumes-from',
          container.Id,
          '--mount',
          `type=bind,src=${directory},dst=/maintenance,readonly`,
          '--entrypoint',
          'sh',
          container.Image,
          '-ec',
          `exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
test -e /fuseki/databases/rezics/clean-stop
java -Xmx512m -cp ${JENA} tdb2.tdbupdate --loc=/fuseki/databases/rezics/tdb2 --update=/maintenance/update.ru
sync`,
        ],
        60_000,
      );
      writeFileSync(join(directory, 'owner-maintenance.log'), result);
    } finally {
      // Recovery still restarts an owner if its maintenance deadline expired.
      if (stopped) runtime.docker(['start', container.Id], 30_000);
    }
    await waitForModelOwner(fuseki, budget);
    const active = await budget.run(() => runtime.readHead(fuseki));
    if (
      active.generation !== generation ||
      active.predecessor !== predecessor.generation ||
      active.generationNumber !== intent.generationNumber ||
      active.manifest !== intent.manifest
    )
      throw new Error('Local owner maintenance did not commit the exact model head CAS');
    await budget.run(() => readWorkComponentState(
      environment,
      active.manifest,
      active.generation,
      PROFILES.generation,
    ));
    return { ...await budget.run(() => finalizeModelBootstrap(env, fuseki, intent, active, directory, auditActor, budget, runtime.audit)),
      state: 'completed', generation, artifacts, artifactCount: artifacts.length };
  } finally {
    maintenance.release();
  }
}

export interface ModelCustodyArguments {
  buildDirectories: string[]; checkpoint?: string; maxObjects?: number;
}

/** Original model artifact roots are positional data inputs, never credentials. */
export function modelCustodyArguments(args: string[]): ModelCustodyArguments {
  if (args[0] !== '--custody') throw new Error('Use --custody --build <original model artifact directory>');
  const result: ModelCustodyArguments = { buildDirectories: [] };
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if ((flag === '--build' || flag === '--checkpoint') && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      throw new Error('Model custody accepts filesystem paths; credentials come from the existing stack environment');
    }
    if (flag === '--build') result.buildDirectories.push(resolve(value));
    else if (flag === '--checkpoint' && result.checkpoint === undefined) result.checkpoint = resolve(value);
    else if (flag === '--max-objects' && result.maxObjects === undefined && /^[1-9][0-9]*$/.test(value)) {
      result.maxObjects = Number(value);
    } else throw new Error(`Unknown or repeated model custody option: ${flag}`);
  }
  if (!result.buildDirectories.length) throw new Error('Supply each original retained model build with --build');
  return result;
}

/** One read-only graph/object-custody turn through the existing operator entry.
 * Repeating the exact invocation resumes its checkpoint and total deadline. */
export async function backfillLocalDatasetModelCustody(options: ModelCustodyArguments,
  stack = process.env.REZICS_DATASET_STACK ?? join(repository, '.temp/stack/rezics-dev'),
  dependencies: Partial<ModelBootstrapRuntime> = {}) {
  const runtime = { ...modelBootstrapRuntime, ...dependencies };
  const env = runtime.readEnv(modelStackEnvironmentFile(stack));
  assertLocalModelOwner(stack, env, runtime.docker, runtime.readEnv);
  checkedLocalModelEndpoint(env.FUSEKI_URL!);
  const sourceKey = sha256(JSON.stringify([env.FUSEKI_URL, env.MAIN_S3_ENDPOINT ?? null,
    env.MAIN_S3_BUCKET ?? null, env.MAIN_OBJECT_DIRECTORY]));
  const checkpointPath = options.checkpoint ?? join(repository, '.temp/datasets/model-custody', `${sourceKey}.json`);
  const lock = `${checkpointPath}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const custody = holdDirectory(lock, `Model artifact custody is already running; inspect ${lock} before resuming`);
  try {
    const checkpoint = existsSync(checkpointPath)
      ? JSON.parse(readFileSync(checkpointPath, 'utf8')) as ModelCustodyBackfillCheckpoint : undefined;
    const fuseki = runtime.fuseki(env);
    const workObjects = env.MAIN_S3_ENDPOINT ? new S3ImmutableObjects({
      endpoint: checkedLocalModelEndpoint(env.MAIN_S3_ENDPOINT), bucket: env.MAIN_S3_BUCKET!,
      region: env.MAIN_S3_REGION, accessKeyId: env.MAIN_S3_ACCESS_KEY!, secretAccessKey: env.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/work/',
    }) : undefined;
    const completed = await backfillRetainedModelCustody({ fuseki,
      lineage: { dataEpoch: env.MAIN_DATA_EPOCH!, routingEpoch: env.MAIN_ROUTING_EPOCH! },
      objectDirectory: env.MAIN_OBJECT_DIRECTORY!, ...(workObjects ? { workObjects } : {}),
    }, { buildDirectories: options.buildDirectories, checkpoint, maxObjects: options.maxObjects, sourceKey },
    value => atomicJson(checkpointPath, value));
    return { state: completed.complete ? 'completed' : 'pending', ...completed, checkpointPath };
  } finally { custody.release(); }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    console.log(args.length ? await backfillLocalDatasetModelCustody(modelCustodyArguments(args))
      : await ensureLocalDatasetModelGeneration());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
