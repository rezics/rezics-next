import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
import { S3ImmutableObjects } from '../../services/main/src/infrastructure/immutable-objects.ts';
import {
  assertCommandProfiles,
  COMMAND_MODULE_VERSION,
} from '../../services/main/src/infrastructure/profile.ts';
import {
  readActiveModelGeneration,
  type ActiveModelGeneration,
} from '../../services/main/src/modules/semantic/generation-guard.ts';
import { MODEL_COMPONENT, PROFILES } from '../../services/main/src/modules/semantic/schema.ts';
import {
  DATASET,
  GRAPHS,
  RV,
  iri,
  lit,
  prepareComponent,
  prepareWorkComponent,
  type GraphLineage,
} from '../../services/main/src/modules/work/activate.ts';
import { readWorkComponentState } from '../../services/main/src/modules/work/history.ts';
import { checkedLocalDatabase, datasetAdminPath } from './bootstrap.ts';
import { readEnv } from '../dev/config.ts';
import { atomicJson, repository, sha256 } from './store.ts';

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

async function finalizeModelBootstrap(
  env: Record<string, string>,
  fuseki: FusekiClient,
  intent: ModelBootstrapIntent,
  active: ActiveModelGeneration,
  directory: string,
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
  const receipt = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?sequence WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(intent.receipt)} rv:requestDigest ${lit(intent.digest)} ; rv:outcome rv:Succeeded ;
      rv:operation ${iri(intent.operation)} ; rv:dataEpoch ${lit(intent.lineage.dataEpoch)} ; rv:sequence ?sequence . }
    GRAPH ${iri(GRAPHS.outbox)} { ${iri(`urn:rezics:outbox:${sha256(intent.receipt)}`)} a rv:OutboxBatch ;
      rv:dataEpoch ${lit(intent.lineage.dataEpoch)} ; rv:sequence ?sequence ; rv:eventCount 0 . }
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(intent.predecessor.generation)} a rv:ModelGeneration ;
      rv:manifest ${iri(intent.predecessor.manifest)} ; rv:generationNumber ${intent.predecessor.generationNumber} . }
  } LIMIT 2`);
  const rows = receipt.results?.bindings ?? [],
    sequence = rows[0]?.sequence?.value;
  if (rows.length !== 1 || !sequence)
    throw new Error('Model bootstrap lost its predecessor or exact sequenced zero-event receipt');
  const actorPath = datasetAdminPath(env.ACCOUNT_ORIGIN ?? env.ACCOUNT_BASE_URL!);
  const actor = existsSync(actorPath)
    ? (JSON.parse(readFileSync(actorPath, 'utf8')) as { id?: string }).id
    : undefined;
  if (!actor)
    throw new Error(
      'Model bootstrap needs the existing dedicated dataset administrator audit identity',
    );
  const account = new Pool({ connectionString: checkedLocalDatabase(env.ACCOUNT_DATABASE_URL!) });
  try {
    await writeAudit(account, {
      actorId: actor,
      action: 'local_dataset_model_generation_bootstrapped',
      targetId: intent.generation,
      reason: REASON,
      before: intent.predecessor,
      after: { ...active, sequence, outbox: 'local-fixture-zero-event-batch' },
      requestId: randomUUID(),
    });
  } finally {
    await account.end();
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
  atomicJson(join(directory, 'completed.json'), completed);
  return completed;
}

export async function ensureLocalDatasetModelGeneration(
  stack = process.env.REZICS_DATASET_STACK ?? join(repository, '.temp/stack/rezics-dev'),
): Promise<Record<string, unknown>> {
  const env = readEnv(join(stack, 'dev.env'));
  checkedLocalModelEndpoint(env.FUSEKI_URL!);
  const fuseki = new FusekiClient(
    env.FUSEKI_URL!,
    env.FUSEKI_MAINTENANCE_TOKEN,
    env.FUSEKI_COMMAND_TOKEN,
  );
  await assertCommandProfiles(fuseki);
  const bytes = readFileSync(modelFile),
    modelManifestSha256 = sha256(bytes);
  const generation = `urn:rezics:model-generation:${modelManifestSha256}`;
  const predecessor = await readActiveModelGeneration(fuseki);
  const context = sha256(JSON.stringify([env.FUSEKI_URL, env.MAIN_DATA_EPOCH, generation]));
  const directory = join(repository, '.temp/datasets/model-bootstrap', context);
  const intentPath = join(directory, 'intent.json');
  if (predecessor.generation === generation) {
    if (existsSync(intentPath) && !existsSync(join(directory, 'completed.json')))
      return finalizeModelBootstrap(
        env,
        fuseki,
        JSON.parse(readFileSync(intentPath, 'utf8')) as ModelBootstrapIntent,
        predecessor,
        directory,
      );
    return { state: 'current', generation, generationNumber: predecessor.generationNumber };
  }
  const auditActorPath = datasetAdminPath(env.ACCOUNT_ORIGIN ?? env.ACCOUNT_BASE_URL!);
  if (
    !existsSync(auditActorPath) ||
    !(JSON.parse(readFileSync(auditActorPath, 'utf8')) as { id?: string }).id
  )
    throw new Error(
      'Model bootstrap needs the existing dedicated dataset administrator audit identity',
    );
  checkedLocalDatabase(env.ACCOUNT_DATABASE_URL!);
  const location =
    await fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?routing ?sequence ?hold WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ?routing ; rv:sequence ?sequence .
      OPTIONAL { ${iri(DATASET)} rv:restoreHold ?hold } }
  } LIMIT 2`);
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
  const existing = await fuseki.query(
    `ASK { GRAPH ${iri(GRAPHS.revisions)} { ${iri(generation)} ?p ?o } }`,
  );
  if (existing.boolean)
    throw new Error(
      'Target model generation already has immutable history; refuse to overwrite or reactivate it implicitly',
    );
  const project = basename(stack);
  if (!/^rezics-(dev|qa-[a-z0-9-]+)$/.test(project))
    throw new Error('Model maintenance needs a repository-managed local fixture stack');
  const contexts = JSON.parse(docker(['context', 'inspect'])) as {
    Endpoints: { docker: { Host: string } };
  }[];
  if (
    !contexts[0]?.Endpoints.docker.Host.startsWith('unix://') ||
    (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://'))
  )
    throw new Error('Model fixture maintenance requires a local Unix Docker owner');
  const containerId = docker([
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--filter',
    'label=com.docker.compose.service=fuseki',
  ]);
  if (!/^[a-f0-9]{12,64}$/.test(containerId))
    throw new Error('Exactly one running local Fuseki owner is required');
  const container = JSON.parse(docker(['inspect', containerId]))[0] as {
    Id: string;
    Image: string;
    Config: { Env: string[] };
    Mounts: { Type: string; Destination: string; RW: boolean }[];
    NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[]> };
  };
  if (
    !container.Mounts.some(
      (mount) => mount.Type === 'volume' && mount.Destination === '/fuseki/databases' && mount.RW,
    ) ||
    !container.Config.Env.includes(`FUSEKI_COMMAND_TOKEN=${env.FUSEKI_COMMAND_TOKEN}`) ||
    !container.NetworkSettings.Ports['3030/tcp']?.some(
      (port) =>
        ['127.0.0.1', '::1'].includes(port.HostIp) &&
        port.HostPort === new URL(env.FUSEKI_URL!).port,
    )
  )
    throw new Error('Fuseki container differs from the configured local graph owner');
  const workObjects = env.MAIN_S3_ENDPOINT
    ? new S3ImmutableObjects({
        endpoint: checkedLocalModelEndpoint(env.MAIN_S3_ENDPOINT),
        bucket: env.MAIN_S3_BUCKET!,
        region: env.MAIN_S3_REGION,
        accessKeyId: env.MAIN_S3_ACCESS_KEY!,
        secretAccessKey: env.MAIN_S3_SECRET_KEY!,
        prefix: 'semantic/work/',
      })
    : undefined;
  const environment = {
    fuseki,
    lineage: { dataEpoch: env.MAIN_DATA_EPOCH!, routingEpoch: env.MAIN_ROUTING_EPOCH! },
    objectDirectory: env.MAIN_OBJECT_DIRECTORY!,
    ...(workObjects ? { workObjects } : {}),
  };
  await readWorkComponentState(
    environment,
    predecessor.manifest,
    predecessor.generation,
    PROFILES.generation,
  );
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, 'lock');
  try {
    mkdirSync(lock);
  } catch {
    throw new Error(`Model fixture maintenance already active; inspect ${lock} before retrying`);
  }
  try {
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
        ? await prepareWorkComponent(workObjects, generation, state, PROFILES.generation)
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
      if (stopped) docker(['start', container.Id], 30_000);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await fuseki.commandHealth();
        break;
      } catch (error) {
        if (attempt === 30) throw error;
        await Bun.sleep(500);
      }
    }
    const active = await readActiveModelGeneration(fuseki);
    if (
      active.generation !== generation ||
      active.predecessor !== predecessor.generation ||
      active.generationNumber !== intent.generationNumber ||
      active.manifest !== intent.manifest
    )
      throw new Error('Local owner maintenance did not commit the exact model head CAS');
    await readWorkComponentState(
      environment,
      active.manifest,
      active.generation,
      PROFILES.generation,
    );
    return finalizeModelBootstrap(env, fuseki, intent, active, directory);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    if (process.argv.slice(2).length)
      throw new Error('Model fixture bootstrap takes no arguments; use REZICS_DATASET_STACK');
    console.log(await ensureLocalDatasetModelGeneration());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
