import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { AwsClient } from 'aws4fetch';
import { backfillLocalDatasetModelCustody, modelBootstrapUpdate } from '../../../scripts/datasets/model-bootstrap.ts';
import { atomicJson } from '../../../scripts/datasets/store.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable, S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { ObjectErasureConflict, protectedObjectDigests, replayObjectErasure } from '../../../services/main/src/modules/erasure/replay-objects.ts';
import { assertObjectRecoveryCoverage, captureObjectRecoveryCoverage, ObjectRecoveryConflict } from '../../../services/main/src/modules/owner/object-coverage.ts';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
import { readActiveModelGeneration } from '../../../services/main/src/modules/semantic/generation-guard.ts';
import { backfillRetainedModelCustody, ModelCustodyBackfillDeadline, readPinnedRevisionModel,
  type ModelCustodyBackfillCheckpoint } from '../../../services/main/src/modules/semantic/model-custody.ts';
import { MODEL_COMPONENT, PROFILES } from '../../../services/main/src/modules/semantic/schema.ts';
import { DATASET, GRAPHS, RV, hash, initializeFreshGraph, iri, lit, prepareWorkComponent,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { RevisionCorrupt, RevisionUnavailable } from '../../../services/main/src/modules/work/history.ts';
import { accessStateCoverage, captureGraphRecoveryCoverage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

class CountingObjects extends S3ImmutableObjects {
  puts = 0;
  override async put(bytes: Uint8Array): Promise<string> {
    this.puts++;
    return super.put(bytes);
  }
}

function originalBuild(directory: string, label: string, commandModule: string, nonce: string) {
  mkdirSync(join(directory, 'shapes'), { recursive: true, mode: 0o700 });
  const profiles = ['a', 'b'].map(part => {
    const id = `retained-${label}-${part}-v1`;
    const bytes = Buffer.from(`@prefix sh: <http://www.w3.org/ns/shacl#> .\n`
      + `<urn:rezics:test:model:${nonce}:${label}:${part}> a sh:NodeShape ; sh:nodeKind sh:IRI .\n`);
    const file = `shapes/${id}.ttl`;
    writeFileSync(join(directory, file), bytes);
    return { id, sha256: hash(bytes), file, bytes };
  });
  const bytes = Buffer.from(JSON.stringify({ commandModule,
    profiles: profiles.map(({ id, sha256, file }) => ({ id, sha256, file })) }));
  writeFileSync(join(directory, 'manifest.json'), bytes);
  return { directory, commandModule, profiles, bytes, sha256: hash(bytes),
    generation: `urn:rezics:model-generation:${hash(bytes)}` };
}

type OriginalBuild = ReturnType<typeof originalBuild>;

async function retainedState(env: WorkActivationEnvironment, build: OriginalBuild) {
  const digest = await prepareWorkComponent(env.workObjects!, build.generation, {
    modelManifestSha256: build.sha256, commandModule: build.commandModule, entailment: 'none',
  }, PROFILES.generation);
  return `urn:rezics:sha256:${digest}`;
}

/** Historical configuration fixtures use QA's existing raw-update endpoint.
 * Their artifact custody is deliberately absent; no product write is being qualified. */
async function seedRetainedGenerations(env: WorkActivationEnvironment, builds: OriginalBuild[]) {
  const first = builds[0]!;
  const manifest = await retainedState(env, first);
  const operation = `https://rezics.com/id/${randomUUID()}`;
  const receipt = `urn:rezics:receipt:${hash(`${first.generation}\0model-generation`)}`;
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const pinnedRevision = `https://rezics.com/id/${randomUUID()}`;
  await env.fuseki.update(`PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?prior } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence 1 }
      GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} a rv:ModelComponent ;
        rv:generationHead ${iri(first.generation)} }
      GRAPH ${iri(GRAPHS.revisions)} {
        ${iri(first.generation)} a rv:ModelGeneration, rv:RevisionAnchor ;
          rv:component ${iri(MODEL_COMPONENT)} ; rv:generationNumber 1 ; rv:manifest ${iri(manifest)} ;
          rv:commandModuleVersion ${lit(first.commandModule)} ; rv:entailmentProfile rv:NoEntailment ;
          rv:identityInference rv:Excluded ; rv:validationPosture rv:RejectOnViolation ;
          rv:operation ${iri(operation)} ; rv:modelRevision ${iri(PROFILES.generation)} ;
          rv:shapeRevision ${iri(PROFILES.generation)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence 1 .
        ${iri(pinnedRevision)} a rv:RevisionAnchor ; rv:modelGeneration ${iri(first.generation)} . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(hash(JSON.stringify({ family: 'model-generation-v1', manifest: first.sha256 })))} ;
        rv:operation ${iri(operation)} ; rv:outcome rv:Succeeded ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence 1 . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence 1 ; rv:eventCount 0 . }
    }
    WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?prior }
      FILTER(?prior = 0)
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} ?p ?o } } }`);
  for (const [index, build] of builds.slice(1).entries()) {
    const predecessor = await readActiveModelGeneration(env.fuseki);
    const nextManifest = await retainedState(env, build);
    await env.fuseki.update(modelBootstrapUpdate({
      format: 'rezics-local-dataset-model-bootstrap-v1', predecessor,
      generation: build.generation, modelManifestSha256: build.sha256, manifest: nextManifest,
      operation: `https://rezics.com/id/${randomUUID()}`,
      receipt: `urn:rezics:receipt:${hash(`${build.generation}\0model-generation`)}`,
      digest: hash(JSON.stringify({ family: 'model-generation-v1', manifest: build.sha256 })),
      lineage: env.lineage, observedSequence: String(index + 1), generationNumber: String(index + 2),
      commandModuleVersion: build.commandModule,
    }));
  }
  return pinnedRevision;
}

async function graphSnapshot(fuseki: FusekiClient) {
  return (await fuseki.query(`SELECT ?graph ?subject ?predicate ?object WHERE {
    VALUES ?graph { ${[GRAPHS.control, GRAPHS.current, GRAPHS.revisions, GRAPHS.receipts, GRAPHS.outbox].map(iri).join(' ')} }
    GRAPH ?graph { ?subject ?predicate ?object }
  } ORDER BY ?graph ?subject ?predicate ?object`)).results!.bindings;
}

test('exact original model custody backfills retained generations with bounded recovery and preserves historical pins', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_S3_ENDPOINT
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const nonce = randomUUID();
  const directory = resolve('.temp', `model-custody-backfill-${nonce}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['account', 'access', 'content', 'relay'], 'owner');
  const account = new Pool({ connectionString: databases.urls.account, max: 2 });
  const access = new Pool({ connectionString: databases.urls.access, max: 2 });
  const content = new Pool({ connectionString: databases.urls.content, max: 2 });
  const relay = new Pool({ connectionString: databases.urls.relay, max: 2 });
  const objectOptions = { endpoint: Bun.env.MAIN_S3_ENDPOINT, bucket: Bun.env.MAIN_S3_BUCKET!,
    region: Bun.env.MAIN_S3_REGION, accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!,
    secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!, prefix: 'semantic/work/' };
  const objects = new CountingObjects(objectOptions);
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const env: WorkActivationEnvironment = { fuseki, workObjects: objects,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(directory, 'objects') };
  const store = { directory: env.objectDirectory, workObjects: objects };
  const consumer = `model-custody:${nonce}`;
  let fence: string | undefined;
  try {
    await migrateContent(content);
    await objects.initialize();
    await initializeFreshGraph(fuseki, env.lineage);
    await initializeRelayCheckpoint(relay, consumer, env.lineage.dataEpoch);
    const builds = ['first', 'second', 'third'].map((label, index) =>
      originalBuild(join(directory, label), label, `0.5.${index + 1}`, nonce));
    const pinnedRevision = await seedRetainedGenerations(env, builds);
    expect((await readActiveModelGeneration(fuseki)).generation).toBe(builds[2]!.generation);
    const before = await graphSnapshot(fuseki);
    fence = await engageAccessRecoveryFence(access);
    const accessBefore = await accessStateCoverage(access);
    const capture = () => captureGraphRecoveryCoverage(fuseki, account, access, relay, consumer, content, store);
    await expect(capture()).rejects.toBeInstanceOf(ObjectRecoveryConflict);
    await expect(protectedObjectDigests(fuseki, store)).rejects.toBeInstanceOf(ObjectErasureConflict);
    await expect(readPinnedRevisionModel(env, pinnedRevision)).rejects.toBeInstanceOf(RevisionUnavailable);

    // A newer retained build is not an original source for either older digest.
    const deadlineAt = Date.now() + 120_000;
    await expect(backfillRetainedModelCustody(env, { buildDirectories: [builds[2]!.directory],
      maxObjects: 64, deadlineAt })).rejects.toBeInstanceOf(RevisionUnavailable);
    const firstScanned = [...builds].sort((a, b) => a.generation.localeCompare(b.generation))[0]!;
    const shape = firstScanned.profiles[0]!;
    writeFileSync(join(firstScanned.directory, shape.file), 'altered original shape');
    try {
      await expect(backfillRetainedModelCustody(env, { buildDirectories: builds.map(build => build.directory),
        maxObjects: 64, deadlineAt })).rejects.toBeInstanceOf(RevisionCorrupt);
    } finally { writeFileSync(join(firstScanned.directory, shape.file), shape.bytes); }
    await expect(capture()).rejects.toBeInstanceOf(ObjectRecoveryConflict);

    const checkpointPath = join(directory, 'checkpoint.json');
    const sourceKey = `qa-model-custody:${nonce}`;
    const options = { buildDirectories: builds.map(build => build.directory), deadlineAt, sourceKey };
    await expect(backfillRetainedModelCustody(env, { ...options, maxObjects: 1 }, checkpoint => {
      atomicJson(checkpointPath, checkpoint);
      if (checkpoint.objects === 1) throw new Error('checkpoint response lost after durable progress');
    })).rejects.toThrow('checkpoint response lost after durable progress');
    let checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8')) as ModelCustodyBackfillCheckpoint;
    expect(checkpoint).toMatchObject({ format: 'rezics-model-custody-backfill-v1', objects: 1,
      complete: false, deadlineAt, head: builds[2]!.generation });
    await expect(backfillRetainedModelCustody(env, { ...options, checkpoint, maxObjects: 1,
      now: () => deadlineAt })).rejects.toBeInstanceOf(ModelCustodyBackfillDeadline);
    expect(JSON.parse(readFileSync(checkpointPath, 'utf8'))).toEqual(checkpoint);

    // New handles resume the persisted cursor against the same real owners.
    const restartedObjects = new CountingObjects(objectOptions);
    const restarted: WorkActivationEnvironment = { ...env, workObjects: restartedObjects,
      fuseki: new FusekiClient(Bun.env.FUSEKI_URL) };
    let turns = 0;
    while (!checkpoint.complete) {
      const previous = checkpoint;
      checkpoint = await backfillRetainedModelCustody(restarted, { ...options, checkpoint, maxObjects: 1 },
        saved => atomicJson(checkpointPath, saved));
      expect(checkpoint.deadlineAt).toBe(deadlineAt);
      expect(checkpoint.objects - previous.objects).toBeGreaterThanOrEqual(0);
      expect(checkpoint.objects - previous.objects).toBeLessThanOrEqual(1);
      expect(++turns).toBeLessThanOrEqual(12);
    }
    expect(checkpoint).toMatchObject({ generations: 3, objects: 9, pending: null, complete: true });
    const puts = restartedObjects.puts;
    expect(await backfillRetainedModelCustody(restarted, { ...options, checkpoint, maxObjects: 64 })).toEqual(checkpoint);
    const replay = await backfillRetainedModelCustody(restarted, { ...options, maxObjects: 64 });
    expect(replay).toMatchObject({ generations: 3, objects: 9, complete: true });
    expect(restartedObjects.puts).toBe(puts);

    // Exercise the actual operator wrapper: credentials stay in the existing
    // stack environment, and only original build/checkpoint paths are inputs.
    const operatorStack = join(directory, 'operator-stack');
    mkdirSync(operatorStack, { recursive: true, mode: 0o700 });
    const operatorEnv = { FUSEKI_URL: Bun.env.FUSEKI_URL!, FUSEKI_MAINTENANCE_TOKEN: Bun.env.FUSEKI_MAINTENANCE_TOKEN!,
      FUSEKI_COMMAND_TOKEN: Bun.env.FUSEKI_COMMAND_TOKEN!, MAIN_DATA_EPOCH: env.lineage.dataEpoch,
      MAIN_ROUTING_EPOCH: env.lineage.routingEpoch, MAIN_OBJECT_DIRECTORY: env.objectDirectory,
      MAIN_S3_ENDPOINT: objectOptions.endpoint, MAIN_S3_BUCKET: objectOptions.bucket,
      MAIN_S3_REGION: objectOptions.region ?? 'us-east-1', MAIN_S3_ACCESS_KEY: objectOptions.accessKeyId,
      MAIN_S3_SECRET_KEY: objectOptions.secretAccessKey };
    writeFileSync(join(operatorStack, 'dev.env'), Object.entries(operatorEnv).map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
      { mode: 0o600 });
    const operatorCheckpoint = join(directory, 'operator-checkpoint.json');
    const operator = await backfillLocalDatasetModelCustody({ buildDirectories: options.buildDirectories,
      checkpoint: operatorCheckpoint, maxObjects: 64 }, operatorStack);
    expect(operator).toMatchObject({ state: 'completed', generations: 3, objects: 9,
      head: builds[2]!.generation, checkpointPath: operatorCheckpoint });
    expect(await backfillLocalDatasetModelCustody({ buildDirectories: options.buildDirectories,
      checkpoint: operatorCheckpoint, maxObjects: 64 }, operatorStack)).toEqual(operator);

    const exact = await readPinnedRevisionModel(restarted, pinnedRevision);
    expect(exact.generation).toBe(builds[0]!.generation);
    expect(exact.commandModule).toBe(builds[0]!.commandModule);
    expect(exact.manifest).toEqual(new Uint8Array(builds[0]!.bytes));
    expect(exact.shapes).toEqual(builds[0]!.profiles.map(profile => ({ profile: profile.id,
      sha256: profile.sha256, bytes: new Uint8Array(profile.bytes) })));
    expect(await graphSnapshot(fuseki)).toEqual(before);
    expect(await accessStateCoverage(access)).toEqual(accessBefore);

    const retained = new Set<string>();
    const coverage = await captureObjectRecoveryCoverage(fuseki, store, retained);
    const recovered = await capture();
    expect(recovered.objects).toEqual(coverage);
    expect(recovered.priorSequence).toBe('3');
    expect(recovered.relay.sequence).toBe('0');
    const protectedDigests = await protectedObjectDigests(fuseki, store);
    expect(protectedDigests).toEqual(retained);
    for (const build of builds) {
      expect(await objects.get(build.sha256)).toEqual(new Uint8Array(build.bytes));
      for (const digest of [build.sha256, ...build.profiles.map(profile => profile.sha256)]) {
        expect(protectedDigests.has(digest)).toBe(true);
        expect(await replayObjectErasure(store, `sha256:${digest}`, protectedDigests, true)).toBe('conflict');
      }
    }
    await assertObjectRecoveryCoverage(fuseki, store, coverage);
    const missing = builds[0]!.profiles[0]!;
    await objects.discard(missing.sha256);
    await expect(capture()).rejects.toBeInstanceOf(ObjectRecoveryConflict);
    await expect(protectedObjectDigests(fuseki, store)).rejects.toBeInstanceOf(ObjectErasureConflict);
    await expect(readPinnedRevisionModel(restarted, pinnedRevision)).rejects.toBeInstanceOf(RevisionUnavailable);
    expect(await backfillRetainedModelCustody(restarted, { ...options, maxObjects: 64 }))
      .toMatchObject({ generations: 3, objects: 9, complete: true });
    expect(await objects.get(missing.sha256)).toEqual(new Uint8Array(missing.bytes));
    await assertObjectRecoveryCoverage(fuseki, store, coverage);
    await capture();

    // The isolated fixture administrator can corrupt one retained key. The
    // immutable adapter and operator path must refuse those bytes, never overwrite them.
    const admin = new AwsClient({ accessKeyId: objectOptions.accessKeyId,
      secretAccessKey: objectOptions.secretAccessKey, service: 's3',
      region: objectOptions.region ?? 'us-east-1', retries: 0 });
    const corruptBytes = new Uint8Array(Buffer.from(`corrupt retained model shape ${nonce}`));
    const corruptPut = await admin.fetch(`${new URL(objectOptions.endpoint).origin}/${objectOptions.bucket}`
      + `/semantic/work/sha256/${missing.sha256}`, {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream',
        'content-length': String(corruptBytes.byteLength),
        'x-amz-checksum-sha256': Buffer.from(hash(corruptBytes), 'hex').toString('base64') },
      body: corruptBytes, aws: { allHeaders: true },
    });
    try {
      expect(corruptPut.ok).toBe(true);
      await expect(objects.get(missing.sha256)).rejects.toBeInstanceOf(ObjectIntegrityError);
      await expect(capture()).rejects.toMatchObject({ kind: 'corrupt' });
      await expect(protectedObjectDigests(fuseki, store)).rejects.toBeInstanceOf(ObjectErasureConflict);
      await expect(readPinnedRevisionModel(restarted, pinnedRevision)).rejects.toBeInstanceOf(RevisionCorrupt);
      await expect(backfillRetainedModelCustody(restarted, { ...options, maxObjects: 64 }))
        .rejects.toBeInstanceOf(RevisionCorrupt);
    } finally {
      await objects.discard(missing.sha256);
      expect(await backfillRetainedModelCustody(restarted, { ...options, maxObjects: 64 }))
        .toMatchObject({ generations: 3, objects: 9, complete: true });
    }
    expect(await objects.get(missing.sha256)).toEqual(new Uint8Array(missing.bytes));
    await assertObjectRecoveryCoverage(fuseki, store, coverage);
    expect((await capture()).objects).toEqual(coverage);
    expect((await readPinnedRevisionModel(restarted, pinnedRevision)).shapes).toEqual(exact.shapes);
    expect(await graphSnapshot(fuseki)).toEqual(before);
    // Unreferenced candidates still use the existing offline erasure path.
    const unused = await objects.put(Buffer.from(`unreferenced model candidate ${nonce}`));
    expect(await replayObjectErasure(store, `sha256:${unused}`, protectedDigests, true)).toBe('replayed');
    await expect(objects.get(unused)).rejects.toBeInstanceOf(ObjectUnavailable);
  } finally {
    if (fence) await releaseAccessRecoveryFence(access, fence);
    await Promise.all([account.end(), access.end(), content.end(), relay.end()]);
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 240_000);
