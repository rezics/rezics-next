import { expect, mock, spyOn, test } from 'bun:test';
import { AwsClient } from 'aws4fetch';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { migrateAccount } from '../../../scripts/ops/migrate.ts';
import { docker } from '../../../scripts/operations/search-state.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { accountRecoveryCoverage } from '../../../services/account/src/recovery-coverage.ts';
import { CommandOutcomeUnknown, CommandRejected, FusekiClient, type CommandEnvelope, type CommandResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry, engageAccessRecoveryFence, type RegisteredAdmission, type VerifiedPrincipal }
  from '../../../services/main/src/modules/access/admission.ts';
import { proofRetirementSender } from '../../../services/main/src/modules/graph/slim-command.ts';
import { PostgresReceiptCustodyStore, ReceiptCustody, type CustodiedReceipt, type HistoricalReceiptSource, type PreparedCommand }
  from '../../../services/main/src/modules/outbox/receipt-custody.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch, relayCoverage, type CustodiedOutbox, type MainCloudEvent }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { reconcileRestoredErasures, releaseErasureRestoreHold, retainErasureCoverage,
  type RestoredOwners } from '../../../services/main/src/modules/erasure/reconcile.ts';
import { heldErasureMaintenanceClient } from '../../../services/main/src/modules/erasure/graph.ts';
import { restoredCustodyDigests } from '../../../services/main/src/modules/erasure/custody.ts';
import { ACTIVE_GENERATION, ensureModelGeneration }
  from '../../../services/main/src/modules/semantic/command.ts';
import { custodyModelGenerationArtifacts, readExactModelGeneration }
  from '../../../services/main/src/modules/semantic/model-custody.ts';
import { MODEL_COMPONENT, PROFILES } from '../../../services/main/src/modules/semantic/schema.ts';
import { DATASET, GRAPHS, RV, activateMetadataWork, hash, initializeFreshGraph, iri, lit,
  metadataWorkRequestDigest, prepareWorkComponent, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { setWorkMetadata } from '../../../services/main/src/modules/work/metadata-command.ts';
import { checkedEditionV2, checkedMetadataState, METADATA_DETAILS_V2, METADATA_PROFILE,
  type MetadataEditionState, type MetadataEditionStateV2 }
  from '../../../services/main/src/modules/work/metadata-schema.ts';
import { readWorkComponentState } from '../../../services/main/src/modules/work/history.ts';
import { setAdmittedWorkScalar } from '../../../services/main/src/modules/work/edit-admitted.ts';
import { PendingAdmittedWork } from '../../../services/main/src/modules/work/create-admitted.ts';
import { SCALAR_PREDICATE } from '../../../services/main/src/modules/work/scalar-value.ts';
import { accessStateCoverage } from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { captureGraphRecoveryCoverage, cutoverRestoredGraphLineage, readGraphRecoverySource, releaseRestoredGraphHold,
  type AuthenticatedRecoveryCoverage }
  from '../../../services/main/src/modules/work/restore-lineage.ts';
import { reconcileRetainedSlimMetadata, reconcileRetainedWorkEdit }
  from '../../../services/main/src/modules/work/reconcile-restored.ts';
import { freePort, fusekiSecrets, migrateAccess, pinnedImage, qaStack, rootCommand, standaloneFuseki,
  waitForFuseki, type QaStack, type StandaloneFuseki }
  from '../fault-recovery/search-ops-support.ts';
import { nativeId } from './context-fixture.ts';

const root = resolve(import.meta.dir, '../../..');
const defaultGraph = 'urn:x-arq:DefaultGraphNode';

/** Only the stopped isolated copy reconstructs a saved graph or a racing prestate. */
async function loadStoppedCopy(stack: QaStack, update: string) {
  stack.runner.stop();
  stack.runner.offline(`exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
cat > /tmp/slim-metadata-restore.ru <<'SLIM_METADATA_RESTORE'
${update}
SLIM_METADATA_RESTORE
java -Xmx512m -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar \\
  tdb2.tdbupdate --loc=/fuseki/databases/rezics/tdb2 --update=/tmp/slim-metadata-restore.ru`);
  await stack.runner.start();
  await waitForFuseki(stack.apps.FUSEKI_URL!);
}

/** Use the same physical PostgreSQL recovery path as the owner restore tests.
 * A promoted copy has replayed the original signed Account WAL floor. */
async function promotedPostgres(stack: QaStack, directory: string) {
  mkdirSync(directory, { recursive: true });
  const data = resolve(directory, 'data');
  const container = stack.compose(['ps', '-q', 'postgres']).output.trim();
  if (!/^[0-9a-f]{12,64}$/.test(container)) throw new Error('Isolated PostgreSQL container is unavailable');
  const remote = `/var/lib/postgresql/.temp/metadata-restore-${randomUUID()}`;
  try {
    execFileSync('docker', ['exec', '-u', 'postgres', container, 'sh', '-ec',
      `mkdir -p /var/lib/postgresql/.temp
PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5 pg_basebackup -h 127.0.0.1 -p 5432 -U postgres -w -D ${remote} -Fp -Xs --checkpoint=fast`],
    { cwd: root, env: stack.dockerEnv, timeout: 65_000 });
    execFileSync('docker', ['cp', `${container}:${remote}`, data], { cwd: root, env: stack.dockerEnv, timeout: 60_000 });
  } finally {
    execFileSync('docker', ['exec', '-u', 'postgres', container, 'rm', '-rf', remote],
      { cwd: root, env: stack.dockerEnv, timeout: 10_000 });
  }
  execFileSync('pg_verifybackup', ['--no-parse-wal', data], { cwd: root, timeout: 15_000 });
  appendFileSync(resolve(data, 'postgresql.auto.conf'), "\narchive_mode = off\nrestore_command = 'false'\n");
  writeFileSync(resolve(data, 'recovery.signal'), '');
  const port = await freePort();
  try {
    // TCP avoids PostgreSQL's short Unix-socket path limit in a nested worktree.
    execFileSync('pg_ctl', ['-D', data, '-l', resolve(directory, 'postgres.log'), '-o',
      `-h 127.0.0.1 -p ${port} -k ""`, '-t', '60', '-w', 'start'], { cwd: root, timeout: 65_000 });
  } catch (error) {
    const diagnosis = readFileSync(resolve(directory,'postgres.log'),'utf8').slice(-4000);
    try { execFileSync('pg_ctl', ['-D',data,'-m','immediate','-w','stop'], { cwd: root,timeout: 25_000,stdio: 'pipe' }); }
    catch { /* Retain the original startup diagnosis. */ }
    throw new Error(`Promoted isolated PostgreSQL startup failed: ${diagnosis}`,
      { cause: error });
  }
  const connection = (original: string) => {
    const url = new URL(original); url.hostname = '127.0.0.1'; url.port = String(port);
    return url.toString();
  };
  return { connection, stop: () => execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'],
    { cwd: root, timeout: 25_000 }) };
}

/** Keep a separately running original graph for the retained erasure owner.
 * Both copies use the product assembler; the copy occurs with its writer stopped. */
async function originalGraphCopy(stack: QaStack, volume: string) {
  docker(['volume', 'create', volume], stack.dockerEnv);
  stack.runner.stop();
  try {
    docker(['run', '--rm', '--user', '0', '--network', 'none', '--volume', `${stack.stateVolume}:/from:ro`,
      '--volume', `${volume}:/to`, '--entrypoint', 'sh', pinnedImage(), '-ec', 'cp -a /from/rezics /to/rezics'], stack.dockerEnv);
  } finally { await stack.runner.start(); }
  return standaloneFuseki(stack.dockerEnv, { name: `${volume}-server`, image: pinnedImage(), volume,
    secrets: fusekiSecrets(stack.composeEnv) });
}

async function facts(fuseki: FusekiClient, subjects?: readonly string[]) {
  return (await fuseki.query(`SELECT ?graph ?subject ?predicate ?object WHERE {
    ${subjects ? `VALUES ?subject { ${subjects.map(iri).join(' ')} }` : ''}
    { GRAPH ?graph { ?subject ?predicate ?object } }
    UNION { ?subject ?predicate ?object . BIND(<${defaultGraph}> AS ?graph) }
  } ORDER BY ?graph ?subject ?predicate ?object`)).results!.bindings;
}

/** C6's physical component occupies the default/current partition. Projection
 * journal generations remain separate retained facts, covered by full snapshots. */
async function componentFacts(fuseki: FusekiClient, subjects: readonly string[]) {
  return (await facts(fuseki, subjects)).filter(fact =>
    fact.graph!.value === defaultGraph || fact.graph!.value === GRAPHS.current);
}

interface Source {
  payloadSha256: string;
  payload: Buffer;
  prepared: PreparedCommand;
  terminal: CustodiedReceipt;
  outbox: { batchId: string; events: MainCloudEvent[] };
}

test('held product slim metadata restore preserves retired owner custody, exact local CAS and unequal diagnostic/Main positions', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through selected QA integration');
  const stack = qaStack(`metadata-restore-${randomUUID().slice(0, 12)}`);
  let accessPool: Pool | undefined, relayPool: Pool | undefined, historicalPool: Pool | undefined;
  let accountPool: Pool | undefined, contentPool: Pool | undefined;
  let postgres: Awaited<ReturnType<typeof promotedPostgres>> | undefined;
  let originalGraph: StandaloneFuseki | undefined;
  const originalVolume = `rezics-metadata-original-${randomUUID().slice(0, 12)}`;
  const recoveryDirectory = resolve(root, `.temp/pg-metadata-${randomUUID().slice(0, 8)}`);
  let env: WorkActivationEnvironment | undefined;
  try {
    await rootCommand(['stack:up', ...stack.args], 180_000);
    const apps = stack.apps, fuseki = stack.fuseki;
    expect(stack.composeEnv.REZICS_STACK_RAW_UPDATE).toBe('0');
    expect(stack.runner.exec('cat /fuseki/fuseki-text.ttl'))
      .toBe(readFileSync(resolve(root, 'infra/jena/fuseki-text.ttl'), 'utf8'));
    const rawUpdateClosed = async () => {
      const response = await fetch(new URL('update', apps.FUSEKI_URL!), { method: 'POST',
        headers: { authorization: `Bearer ${apps.FUSEKI_MAINTENANCE_TOKEN}`,
          'content-type': 'application/sparql-update' }, body: 'INSERT DATA { <urn:rezics:unsafe> <urn:rezics:unsafe> true }',
        signal: AbortSignal.timeout(10_000) });
      expect(response.status).toBe(404);
    };
    await rawUpdateClosed();
    await migrateAccess(apps.ACCESS_DATABASE_URL!);
    await migrateAccount(apps, root);
    accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    historicalPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 1, connectionTimeoutMillis: 30_000 });
    accountPool = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
    contentPool = new Pool({ connectionString: apps.CONTENT_DATABASE_URL });
    await migrateContent(contentPool);
    // The independent stack starts empty: install the real Account provider and
    // owner migrations before capturing the original recovery profile.
    await accountRecoveryCoverage(accountPool);
    expect((await contentPool.query('SELECT data_epoch,sequence FROM content.owner_control')).rows).toHaveLength(1);
    relayPool = new Pool({ connectionString: apps.MAIN_RELAY_DATABASE_URL });
    for (const file of schemaFiles(root, 'relay')) {
      await relayPool.query(readFileSync(resolve(root, 'services/main/migrations/relay', file), 'utf8'));
    }
    const objects = new S3ImmutableObjects({ endpoint: apps.MAIN_S3_ENDPOINT!, bucket: apps.MAIN_S3_BUCKET!,
      region: apps.MAIN_S3_REGION, accessKeyId: apps.MAIN_S3_ACCESS_KEY!, secretAccessKey: apps.MAIN_S3_SECRET_KEY!,
      prefix: 'semantic/work/' });
    await objects.initialize();
    const access = new AccessAdmissionRegistry(accessPool, apps.FUSEKI_TITLE_ADMISSION_KEY);
    access.configureBaseline(fuseki);
    let custodyStore = new PostgresReceiptCustodyStore(accessPool);
    let custody = new ReceiptCustody(custodyStore, objects, fuseki,
      apps.FUSEKI_TITLE_ADMISSION_KEY!, proofRetirementSender(apps.FUSEKI_URL!, apps.FUSEKI_COMMAND_TOKEN!));
    env = { fuseki, workObjects: objects, receiptCustody: custody, objectDirectory: apps.MAIN_OBJECT_DIRECTORY!,
      lineage: { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! } };
    await initializeFreshGraph(fuseki, env.lineage);
    await ensureModelGeneration(env);
    const actor = nativeId(), principalId = randomUUID();
    const principal: VerifiedPrincipal = { issuer: 'https://account.rezics.test', subject: principalId, emailVerified: true };
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1::uuid, $2, $1::text)`, [principalId, principal.issuer]);
    await accessPool.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [actor]);
    const title = 'Exact retired metadata custody';
    const bootstrapAdmission: RegisteredAdmission = { id: randomUUID(), principalId, actingSubject: actor,
      scope: 'work:create:root', action: 'work.create', idempotencyKey: randomUUID(),
      requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 600_000).toISOString(), state: 'claimed', dispatchEligible: true, replayed: false };
    const created = await activateMetadataWork(env, { title, admission: bootstrapAdmission });
    const work = created.work!;
    const scope = `work:edit:${work}`;
    await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
    await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.edit',now() + interval '1 hour')`, [randomUUID(), principalId, actor]);
    await accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,$3,'work.edit',now() + interval '1 hour')`, [randomUUID(), actor, scope]);
    const nativeCommand = fuseki.commandWithReceipt.bind(fuseki);
    fuseki.commandWithReceipt = async envelope => {
      const result = await nativeCommand(envelope);
      if (result.status === 'invalid') {
        const error = new CommandRejected(result);
        error.message = `Fixture metadata source rejected: ${JSON.stringify({ receipt: envelope.receipt, ...result })}`;
        throw error;
      }
      return result;
    };
    const request = new Request('http://main.local/v1/metadata');
    const deps = { environment: env, access, account: { verify: async () => principal } };
    const metadataSource = async (input: Parameters<typeof setWorkMetadata>[2]) => {
      try { return await setWorkMetadata(deps, request, input); }
      catch (error) {
        if (!(error instanceof PendingAdmittedWork)) throw error;
        // Reconcile an uncertain setup result with the same real owner identity.
        return await setWorkMetadata(deps, request, input);
      }
    };
    // Edition validation requires a recorded descriptive header on its owning Work.
    await metadataSource({ profile: 'work-metadata-details-v1', work, expectedHead: null,
      state: checkedMetadataState({ kind: 'header', originalTitle: { value: title, language: 'en' }, localized: [] }),
      actingSubject: actor, idempotencyKey: randomUUID() });
    const sourceEpoch = env.lineage.dataEpoch;
    // Allocate mixed native raw/slim commits at diagnostic 877,878,899,900 and Main 1..4.
    // Only this stopped disposable copy replaces its setup's older source cut.
    await loadStoppedCopy(stack, `PREFIX rv: <${RV}>
      CLEAR GRAPH ${iri(GRAPHS.outbox)} ;
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?old .
        ${iri(MAIN_RELAY_STREAM_SCOPE)} ?p ?o } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence 876 .
        ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:dataEpoch ${lit(sourceEpoch)} ;
          rv:streamSequence 0 ; rv:legacyThroughSequence 0 } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?old .
        OPTIONAL { ${iri(MAIN_RELAY_STREAM_SCOPE)} ?p ?o } } }`);
    const v1 = checkedMetadataState({ kind: 'edition', id: nativeId(), status: 'active',
      title: { value: 'Recorded V1 日本語', language: 'ja' }, contentLanguage: 'ja',
      editionStatement: 'First exact edition', publisher: 'Recorded publisher', publicationYear: 7,
      isbn13: '9780306406157' }) as MetadataEditionState;
    const v2 = checkedEditionV2({ kind: 'edition', id: nativeId(), status: 'active',
      title: { value: 'Recorded V2 multilingual', language: 'en-us' }, contentLanguages: ['en-US', 'sr-Latn', 'zh-Hans'],
      originalLanguages: ['sr-Latn', 'zh-Hans'], isTranslation: true, titleLanguage: 'en-US', tracklistLanguage: 'sr-Latn',
      editionStatement: 'Parallel languages', publisher: 'Exact second publisher', publicationYear: 2026, isbn13: null });
    expect(v2.contentLanguages).toEqual(['en-US', 'sr-Latn', 'zh-Hans']);
    expect(v2.originalLanguages).toEqual(['sr-Latn', 'zh-Hans']);
    expect(v2.titleLanguage).toBe('en-US');
    expect(v2.tracklistLanguage).toBe('sr-Latn');
    const sources: Source[] = [];
    const write = async (state: MetadataEditionState | MetadataEditionStateV2, expectedHead: string | null, profile: string) => {
      const result = await metadataSource({ profile, work, state, expectedHead,
        actingSubject: actor, idempotencyKey: randomUUID() });
      const found = (await accessPool!.query<{ payload_sha256: string; payload: Buffer;
        terminal: CustodiedReceipt; outbox: Source['outbox']; retired_at: Date | null }>(
      'SELECT payload_sha256,payload,terminal,outbox,retired_at FROM access.command_custody WHERE receipt = $1',
      [result.receipt])).rows[0]!;
      expect(found.retired_at).not.toBeNull();
      expect(await facts(fuseki, [result.receipt, result.revision])).toEqual([]);
      const prepared = JSON.parse(found.payload.toString('utf8')) as PreparedCommand;
      expect(prepared.state).toEqual(state);
      expect(found.terminal).toMatchObject({ receipt: result.receipt, revision: result.revision,
        sequence: ['877', '878', '900'][sources.length], streamSequence: ['1', '2', '4'][sources.length] });
      const source = { payloadSha256: found.payload_sha256, payload: found.payload, prepared,
        terminal: found.terminal, outbox: found.outbox };
      sources.push(source);
      return source;
    };
    const first = await write(v1, null, 'work-metadata-details-v1');
    await write({ ...v1, status: 'withdrawn' }, first.terminal.revision, 'work-metadata-details-v1');
    await loadStoppedCopy(stack, `PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:sequence 878 } }; INSERT DATA { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence 898 } }`);
    const rawKey = randomUUID();
    const raw = await setAdmittedWorkScalar(env, deps.account, access, request, { work,
      expectedHead: created.workRevision!, scalarValue: { kind: 'integer', lexical: '0' },
      actingSubject: actor, idempotencyKey: rawKey });
    expect(raw.sequence).toBe('899');
    const rawBatch = await readNextMainOutboxBatch(fuseki, sourceEpoch, '2', custody);
    expect(rawBatch).toMatchObject({ graphSequence: '899', sequence: '3' });
    const rawEvent = await readMainOutboxEnvelope(fuseki, rawBatch!, rawBatch!.eventIds[0]!, undefined, custody);
    expect(rawEvent.type).toBe('com.rezics.work.edited.v1');
    const third = await write(v2, null, 'work-metadata-details-v2');
    fuseki.commandWithReceipt = nativeCommand;
    const sourceGraph = await componentFacts(fuseki, [v1.id, v2.id]);
    const rawSubjects = [raw.revision, raw.receipt, rawBatch!.batchId, rawEvent.id];
    const sourceRawGraph = await facts(fuseki, rawSubjects);
    const originalSql = (await accessPool.query(`SELECT receipt,request_digest,payload_sha256,payload,revision,
      terminal,outbox,reconciled_at,retired_at,data_epoch,stream_sequence::text
      FROM access.command_custody ORDER BY receipt`)).rows;
    const sourceAdmissionIds = [...sources.map(source => source.terminal.admissionId), raw.admissionId];
    const originalAdmissions = (await accessPool.query(`SELECT id,acting_subject,scope_id,request_digest,authority_epoch,
      state,graph_receipt,graph_outcome,graph_data_epoch,graph_sequence FROM access.admission
      WHERE id=ANY($1::uuid[]) ORDER BY id`, [sourceAdmissionIds])).rows;
    expect(originalAdmissions).toHaveLength(4);
    expect(originalAdmissions.every(admission => admission.state === 'sealed')).toBe(true);
    const consumer = 'slim-metadata-restore';
    const events = [...sources.map(source => ({ event: source.outbox.events[0]!, batchId: source.outbox.batchId,
      sequence: source.terminal.streamSequence, diagnostic: source.terminal.sequence })),
    { event: rawEvent, batchId: rawBatch!.batchId, sequence: '3', diagnostic: '899' }];
    for (const { event, batchId, sequence, diagnostic } of events) {
      expect(event.data.sourcePosition.sequence).toBe(diagnostic);
      expect(event.data.relayPosition?.sequence).toBe(sequence);
      await relayPool.query(`INSERT INTO relay.delivered_batch (data_epoch,sequence,batch_id,routing_epoch,event_count)
        VALUES ($1,$2,$3,$4,1)`, [sourceEpoch, sequence, batchId, env.lineage.routingEpoch]);
      await relayPool.query(`INSERT INTO relay.delivered_event (source,event_id,data_epoch,sequence,envelope)
        VALUES ($1,$2,$3,$4,$5::jsonb)`, [event.source,event.id,sourceEpoch,sequence,JSON.stringify(event)]);
    }
    await relayPool.query('INSERT INTO relay.checkpoint (consumer,data_epoch,sequence) VALUES ($1,$2,4)', [consumer,sourceEpoch]);
    const coverage = await relayCoverage(relayPool,consumer);
    expect(coverage).toMatchObject({ dataEpoch: sourceEpoch, sequence: '4', batchCount: '4', eventCount: '4' });
    // Change an unrelated model artifact while preserving every recorded selected shape digest.
    const modelDirectory = resolve(root, 'generated/model');
    const model = JSON.parse(readFileSync(resolve(modelDirectory, 'manifest.json'), 'utf8')) as {
      commandModule: string; profiles: { id: string; file: string; sha256: string }[] };
    const selectedProfiles = new Set(sources.flatMap(source => source.prepared.envelope.validations.map(pin => pin.profile)));
    selectedProfiles.add('work-metadata-v1');
    const unrelated = model.profiles.find(profile => !selectedProfiles.has(profile.id))!;
    const unrelatedShape = Buffer.concat([readFileSync(resolve(modelDirectory,unrelated.file)),
      Buffer.from('\n# An unrelated profile artifact changed between source and restore.\n')]);
    const changedModelBytes = Buffer.from(JSON.stringify({ ...model, profiles: model.profiles.map(profile =>
      profile.id === unrelated.id ? { ...profile, sha256: hash(unrelatedShape) } : profile) }));
    const unrelatedRoot = `urn:rezics:model-generation:${hash(changedModelBytes)}`;
    expect(unrelatedRoot).not.toBe(ACTIVE_GENERATION);
    await custodyModelGenerationArtifacts(env, unrelatedRoot, changedModelBytes,
      file => file === unrelated.file ? unrelatedShape : readFileSync(resolve(modelDirectory,file)));
    const rootManifest = await prepareWorkComponent(objects,unrelatedRoot,
      { modelManifestSha256: unrelatedRoot.slice(-64),commandModule: model.commandModule,entailment: 'none' }, PROFILES.generation);
    await loadStoppedCopy(stack, `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ?oldModel } }
      INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ${iri(unrelatedRoot)} }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(unrelatedRoot)} a rv:ModelGeneration, rv:RevisionAnchor ;
          rv:component ${iri(MODEL_COMPONENT)} ; rv:predecessor ${iri(ACTIVE_GENERATION)} ; rv:generationNumber 2 ;
          rv:manifest ${iri(`urn:rezics:sha256:${rootManifest}`)} ; rv:commandModuleVersion ${lit(model.commandModule)} ;
          rv:entailmentProfile rv:NoEntailment ; rv:identityInference rv:Excluded ; rv:validationPosture rv:RejectOnViolation ;
          rv:operation ${iri(nativeId())} ; rv:modelRevision ${iri(PROFILES.generation)} ; rv:shapeRevision ${iri(PROFILES.generation)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(sourceEpoch)} ; rv:sequence 876 } }
      WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ?oldModel } }`);
    const sourceLineage = { ...env.lineage };
    const recoveryKey = hash(randomUUID());
    const fenceGeneration = await engageAccessRecoveryFence(accessPool);
    expect((await accessPool.query('SELECT open,generation::text FROM access.recovery_fence WHERE id')).rows)
      .toEqual([{ open: false,generation: fenceGeneration }]);
    const signedCut = await captureGraphRecoveryCoverage(fuseki, accountPool, accessPool, relayPool,
      consumer, contentPool, { directory: env.objectDirectory, workObjects: objects });
    expect(signedCut).toMatchObject({ priorDataEpoch: sourceEpoch, priorSequence: '900',
      relay: { sequence: '4', batchCount: '4', eventCount: '4' } });
    const sealedCoverage = JSON.stringify(sealRecoveryPayload(signedCut, recoveryKey, 'graph-recovery-coverage'));
    await retainRecoveryCoverageHead(relayPool, sealedCoverage, recoveryKey);
    await retainErasureCoverage(relayPool, consumer);
    originalGraph = await originalGraphCopy(stack, originalVolume);
    const originalFuseki = new FusekiClient(originalGraph.url, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    expect(await readGraphRecoverySource(originalFuseki)).toMatchObject({ ...sourceLineage, sequence: '900',
      relay: { sequence: '4' } });
    expect(await facts(originalFuseki, rawSubjects)).toEqual(sourceRawGraph);
    postgres = await promotedPostgres(stack, recoveryDirectory);
    await Promise.all([accessPool.end(), historicalPool.end(), accountPool.end(), contentPool.end()]);
    accessPool = new Pool({ connectionString: postgres.connection(apps.ACCESS_DATABASE_URL!), max: 1, connectionTimeoutMillis: 30_000 });
    historicalPool = new Pool({ connectionString: postgres.connection(apps.ACCESS_DATABASE_URL!), max: 1, connectionTimeoutMillis: 30_000 });
    accountPool = new Pool({ connectionString: postgres.connection(apps.ACCOUNT_DATABASE_URL!) });
    contentPool = new Pool({ connectionString: postgres.connection(apps.CONTENT_DATABASE_URL!) });
    custodyStore = new PostgresReceiptCustodyStore(accessPool);
    custody = new ReceiptCustody(custodyStore, objects, fuseki,
      apps.FUSEKI_TITLE_ADMISSION_KEY!, proofRetirementSender(apps.FUSEKI_URL!, apps.FUSEKI_COMMAND_TOKEN!));
    env.receiptCustody = custody;
    // Restore only an older saved physical graph. Production cutover creates
    // the lineage, hold and both recorded cut cursors from this real source cut.
    await loadStoppedCopy(stack, `PREFIX rv: <${RV}>
      DELETE WHERE { ${iri(v1.id)} ?p ?o };
      DELETE WHERE { ${iri(v2.id)} ?p ?o };
      DELETE WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:editionsRevision ?head } };
      DELETE WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(work)} <${SCALAR_PREDICATE}> ?value } };
      DELETE WHERE { GRAPH ${iri(GRAPHS.revisions)} { ${iri(raw.revision)} ?p ?o } };
      DELETE WHERE { GRAPH ${iri(GRAPHS.receipts)} { ${iri(raw.receipt)} ?p ?o } };
      DELETE WHERE { GRAPH ${iri(GRAPHS.outbox)} { ${iri(rawBatch!.batchId)} ?p ?o } };
      DELETE WHERE { GRAPH ${iri(GRAPHS.outbox)} { ${iri(rawEvent.id)} ?p ?o } };
      DELETE DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:head ${iri(raw.revision)} }
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence 900 . ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence 4 } };
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:head ${iri(created.workRevision!)} }
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence 876 . ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence 0 } }`);
    const savedSource = await readGraphRecoverySource(fuseki);
    expect(savedSource).toMatchObject({ sequence: '876', relay: { sequence: '0' } });
    const restoredEpoch = randomUUID(), restoredRouting = randomUUID(), marker = `urn:rezics:restore:${restoredEpoch}`;
    const cutover = { prior: { ...sourceLineage, sequence: savedSource.sequence },
      next: { dataEpoch: restoredEpoch, routingEpoch: restoredRouting } };
    expect(await cutoverRestoredGraphLineage(fuseki, cutover)).toEqual({ lineage: cutover.next, sequence: '0', replayed: false });
    expect(await cutoverRestoredGraphLineage(fuseki, cutover)).toEqual({ lineage: cutover.next, sequence: '0', replayed: true });
    env.lineage = { dataEpoch: restoredEpoch,routingEpoch: restoredRouting };
    expect(await componentFacts(fuseki,[v1.id,v2.id])).toEqual([]);
    const retainedModel = await readExactModelGeneration(env,unrelatedRoot);
    const health = await fuseki.commandHealth();
    for (const source of sources) for (const pin of source.prepared.envelope.validations) {
      expect(health.profiles[pin.profile]).toBe(pin.sha256);
      expect(retainedModel.shapes.find(shape => shape.profile === pin.profile)?.sha256).toBe(pin.sha256);
    }
    const checkoutAccess = accessPool.connect.bind(accessPool), checkoutRelay = relayPool.connect.bind(relayPool);
    const repair = async (sequence: string, rawSource = false, openFence = false) => {
      const relayClient = await checkoutRelay();
      let accessClient: PoolClient | undefined;
      try {
        await relayClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        accessClient = await checkoutAccess();
        await accessClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        // Roll back the fence's derived-source invalidation with this refusal.
        if (openFence) await accessClient.query('UPDATE access.recovery_fence SET open=true WHERE id');
        const forbidden = () => { throw new Error('Held repair must use the supplied owner clients without live custody reconciliation'); };
        const accessQueries = spyOn(accessClient, 'query'), relayQueries = spyOn(relayClient, 'query');
        const guards = [spyOn(accessPool!, 'connect').mockImplementation(forbidden),
          spyOn(accessPool!, 'query').mockImplementation(forbidden), spyOn(relayPool!, 'connect').mockImplementation(forbidden),
          spyOn(relayPool!, 'query').mockImplementation(forbidden), spyOn(accessClient, 'release').mockImplementation(forbidden),
          spyOn(relayClient, 'release').mockImplementation(forbidden), spyOn(custody, 'resolve').mockImplementation(forbidden),
          spyOn(custody, 'readCommitted').mockImplementation(forbidden), spyOn(custody, 'commit').mockImplementation(forbidden),
          spyOn(custody, 'retire').mockImplementation(forbidden)];
        try {
          return rawSource
            ? await reconcileRetainedWorkEdit(env!,accessPool!,relayPool!,signedCut.relay,sequence,accessClient,relayClient)
            : await reconcileRetainedSlimMetadata(env!,accessPool!,relayPool!,signedCut.relay,sequence,accessClient,relayClient);
        } finally {
          try {
            for (const queries of [accessQueries, relayQueries]) for (const call of queries.mock.calls) {
              expect(String(call[0]).trim()).toMatch(/^SELECT\b/i);
              expect(String(call[0])).not.toMatch(/(?:^|;)\s*(?:BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE)\b/i);
            }
            for (const guard of guards) expect(guard).not.toHaveBeenCalled();
          } finally {
            for (const guard of guards.reverse()) guard.mockRestore();
            accessQueries.mockRestore(); relayQueries.mockRestore();
          }
        }
      } finally {
        if (accessClient) { try { await accessClient.query('ROLLBACK'); } finally { accessClient.release(); } }
        try { await relayClient.query('ROLLBACK'); } finally { relayClient.release(); }
      }
    };
    const reconcile = (sequence: string) => repair(sequence);
    const reconcileRaw = () => repair('3', true);
    const held = await facts(fuseki);
    await expect(repair('1',false,true)).rejects.toThrow();
    expect(await facts(fuseki)).toEqual(held);
    const prematureErasures = mock(async () => { throw new Error('An incomplete signed restore cannot enter erasure release'); });
    await expect(releaseRestoredGraphHold(fuseki,accessPool,relayPool,env.lineage,{
      sealedCoverage,hmacKey:recoveryKey,accountPool,contentPool,
      objectStore:{directory:env.objectDirectory,workObjects:objects},releaseErasures:prematureErasures,
    })).rejects.toThrow();
    expect(prematureErasures).not.toHaveBeenCalled();
    expect(await facts(fuseki)).toEqual(held);
    await expect(reconcile('900')).rejects.toThrow();
    await expect(reconcile('4')).rejects.toThrow();
    expect(await facts(fuseki)).toEqual(held);
    const admissionId = first.terminal.admissionId;
    await accessPool.query('UPDATE access.admission SET authority_epoch=authority_epoch+1 WHERE id=$1',[admissionId]);
    await expect(reconcile('1')).rejects.toThrow();
    expect(await facts(fuseki)).toEqual(held);
    await accessPool.query('UPDATE access.admission SET authority_epoch=authority_epoch-1 WHERE id=$1',[admissionId]);
    const payloadManifest = JSON.parse(Buffer.from(await objects.get(first.prepared.manifest.slice(-64))).toString('utf8')) as { payload: string };
    const corruptDigest = payloadManifest.payload.slice(7), originalPayload = await objects.get(corruptDigest);
    const historicalStore = new PostgresReceiptCustodyStore(historicalPool);
    const historicalCustody = new ReceiptCustody(historicalStore, objects, fuseki,
      apps.FUSEKI_TITLE_ADMISSION_KEY!, proofRetirementSender(apps.FUSEKI_URL!, apps.FUSEKI_COMMAND_TOKEN!));
    const putObject = objects.put.bind(objects), discardObject = objects.discard.bind(objects);
    const borrowedTransaction = async (operation: (read: (sequence: string) => Promise<HistoricalReceiptSource | null>) => Promise<void>) => {
      const client = await historicalPool!.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        expect((await client.query('SELECT open FROM access.recovery_fence WHERE id FOR SHARE')).rows).toEqual([{ open: false }]);
        const identitySql = `SELECT pg_backend_pid()::text AS pid,txid_current()::text AS txid,
          current_setting('transaction_isolation') AS isolation`;
        const transaction = (await client.query(identitySql)).rows;
        const forbidden = () => { throw new Error('Historical custody must use only the borrowed Access transaction and immutable reads'); };
        const query = spyOn(client, 'query');
        const guards = [
          spyOn(historicalPool!, 'connect').mockImplementation(forbidden),
          spyOn(historicalPool!, 'query').mockImplementation(forbidden),
          spyOn(historicalStore, 'withReceipt').mockImplementation(forbidden),
          spyOn(historicalStore, 'receiptAt').mockImplementation(forbidden),
          spyOn(historicalCustody, 'readCommitted').mockImplementation(forbidden),
          spyOn(historicalCustody, 'resolve').mockImplementation(forbidden),
          spyOn(historicalCustody, 'read').mockImplementation(forbidden),
          spyOn(historicalCustody, 'commit').mockImplementation(forbidden),
          spyOn(historicalCustody, 'retire').mockImplementation(forbidden),
          spyOn(client, 'release').mockImplementation(forbidden),
          spyOn(fuseki, 'query').mockImplementation(forbidden),
          spyOn(fuseki, 'command').mockImplementation(forbidden),
          spyOn(fuseki, 'commandWithReceipt').mockImplementation(forbidden),
          spyOn(fuseki, 'commandHealth').mockImplementation(forbidden),
          spyOn(objects, 'put').mockImplementation(forbidden),
          spyOn(objects, 'discard').mockImplementation(forbidden),
        ];
        try {
          expect(historicalPool!.totalCount).toBe(1);
          expect(historicalPool!.idleCount).toBe(0);
          await operation(async sequence => {
            const before = query.mock.calls.length;
            try {
              return await historicalCustody.readHistorical({ dataEpoch: sourceEpoch, streamSequence: sequence }, client);
            } finally {
              expect(query.mock.calls.length - before).toBe(1);
              const sql = String(query.mock.calls[before]![0]).replace(/\s+/g, ' ').trim();
              expect(sql).toMatch(/^SELECT /);
              expect(sql).toContain('FROM access.command_custody WHERE data_epoch=$1 AND stream_sequence=$2 LIMIT 2');
              expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE|pg_advisory_lock)\b/i);
              expect(historicalPool!.waitingCount).toBe(0);
            }
          });
          for (const guard of guards) expect(guard).not.toHaveBeenCalled();
        } finally {
          for (const guard of guards.reverse()) guard.mockRestore();
          query.mockRestore();
        }
        // The borrowed connection is still in the caller's original transaction.
        expect((await client.query(identitySql)).rows).toEqual(transaction);
      } finally {
        try { await client.query('ROLLBACK'); } finally { client.release(); }
      }
    };
    await borrowedTransaction(async read => {
      for (const source of sources) {
        const manifestDigest = source.prepared.manifest.slice(-64);
        const manifest = JSON.parse(Buffer.from(await objects.get(manifestDigest)).toString('utf8')) as { payload: string };
        const historical = await read(source.terminal.streamSequence);
        const expected: CustodiedOutbox = { batch: { batchId: source.outbox.batchId, streamScope: MAIN_RELAY_STREAM_SCOPE,
          dataEpoch: sourceEpoch, sequence: source.terminal.streamSequence, graphSequence: source.terminal.sequence,
          routingEpoch: source.prepared.routingEpoch, eventIds: source.outbox.events.map(event => event.id),
          custodiedReceipt: source.terminal.receipt }, events: source.outbox.events };
        expect(historical?.outbox).toEqual(expected);
        expect(historical?.objectDigests).toEqual(new Set([source.payloadSha256, manifestDigest, manifest.payload.slice(7),
          ...source.prepared.envelope.validations.map(pin => pin.sha256)]));
      }
      const last = await read('4');
      expect(last?.outbox.batch).toMatchObject({ graphSequence: '900', sequence: '4' });
      expect(await read('3')).toBeNull();
      expect(await read('900')).toBeNull();
      const shapeDigest = first.prepared.envelope.validations[0]!.sha256;
      const shapeBytes = await objects.get(shapeDigest);
      await discardObject(shapeDigest);
      try { await expect(read('1')).rejects.toThrow(); }
      finally { expect(await putObject(shapeBytes)).toBe(shapeDigest); }
      expect((await read('1'))?.outbox.events).toEqual(first.outbox.events);
    });
    expect(await facts(fuseki)).toEqual(held);
    const signer = new AwsClient({ accessKeyId: apps.MAIN_S3_ACCESS_KEY!,secretAccessKey: apps.MAIN_S3_SECRET_KEY!,
      service: 's3',region: apps.MAIN_S3_REGION ?? 'us-east-1',retries: 0 });
    const corrupt = await signer.fetch(`${new URL(apps.MAIN_S3_ENDPOINT!).origin}/${apps.MAIN_S3_BUCKET}/semantic/work/sha256/${corruptDigest}`, {
      method: 'PUT',body: Buffer.from('corrupt committed payload'),headers: { 'content-type': 'application/octet-stream' } });
    expect(corrupt.ok).toBe(true);
    await borrowedTransaction(async read => { await expect(read('1')).rejects.toThrow(); });
    await expect(reconcile('1')).rejects.toThrow();
    expect(await facts(fuseki)).toEqual(held);
    await objects.discard(corruptDigest);
    expect(await objects.put(originalPayload)).toBe(corruptDigest);
    let interrupted: CommandEnvelope | undefined;
    fuseki.commandWithReceipt = async envelope => {
      interrupted = envelope;
      throw new CommandOutcomeUnknown('Interrupted before held metadata restore command');
    };
    await expect(reconcile('1')).rejects.toThrow();
    fuseki.commandWithReceipt = nativeCommand;
    expect(interrupted?.receipt).toStartWith('urn:rezics:name-migration:metadata-restore:');
    expect(await facts(fuseki)).toEqual(held);
    expect(interrupted!.validations.length).toBeGreaterThan(0);
    const mismatchedPin = await fuseki.command({ ...interrupted!, validations: interrupted!.validations.map(pin =>
      ({ ...pin,sha256:hash('unsafe selected profile replacement') })) });
    expect(mismatchedPin).toEqual({status:'unknown-profile'});
    expect(await facts(fuseki)).toEqual(held);
    for (const capability of [undefined,apps.FUSEKI_COMMAND_TOKEN]) {
      const denied = await fetch(new URL('command',apps.FUSEKI_URL!),{ method:'POST',
        headers: { 'content-type':'application/json',...(capability ? { authorization:`Bearer ${capability}` } : {}) },
        body:JSON.stringify(interrupted),signal:AbortSignal.timeout(35_000) });
      expect(denied.status).toBe(403);
    }
    expect(await facts(fuseki)).toEqual(held);
    fuseki.commandWithReceipt = async envelope => {
      const result = await nativeCommand(envelope);
      if (result.status !== 'committed') console.info('Restore native result:', JSON.stringify(result));
      return result;
    };
    try {
      expect(await reconcile('1')).toEqual({receipt:first.terminal.receipt,component:v1.id,revision:first.terminal.revision,replayed:false});
    } finally { fuseki.commandWithReceipt = nativeCommand; }
    expect((await fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> ASK {
      ${iri(v1.id)} rv:metadataHead ${iri(first.terminal.revision)} ; schema:name ${lit(v1.title.value)}@ja ;
        schema:datePublished "0007"^^<http://www.w3.org/2001/XMLSchema#gYear> }`)).boolean).toBe(true);
    const staleHead = nativeId();
    let staleStatus: CommandResult['status'] | undefined;
    fuseki.commandWithReceipt = async envelope => {
      await loadStoppedCopy(stack,`PREFIX rv: <${RV}> DELETE DATA { ${iri(v1.id)} rv:metadataHead ${iri(first.terminal.revision)} };
        INSERT DATA { ${iri(v1.id)} rv:metadataHead ${iri(staleHead)} }`);
      const stale = await facts(fuseki);
      const result = await nativeCommand(envelope);
      staleStatus = result.status;
      expect(await facts(fuseki)).toEqual(stale);
      return result;
    };
    await expect(reconcile('2')).rejects.toThrow();
    fuseki.commandWithReceipt = nativeCommand;
    expect(['guard-unmatched','invalid']).toContain(staleStatus);
    await loadStoppedCopy(stack,`PREFIX rv: <${RV}> DELETE DATA { ${iri(v1.id)} rv:metadataHead ${iri(staleHead)} };
      INSERT DATA { ${iri(v1.id)} rv:metadataHead ${iri(first.terminal.revision)} }`);
    const concurrent = await Promise.all([reconcile('2'),reconcile('2')]);
    expect(concurrent.map(result => result.replayed).sort()).toEqual([false,true]);
    const withdrawn = await componentFacts(fuseki,[v1.id]);
    expect(withdrawn.length).toBeLessThanOrEqual(64);
    expect(withdrawn.some(fact => fact.predicate!.value.startsWith('https://schema.org/'))).toBe(false);
    expect(withdrawn.some(fact => fact.object!.value === v1.title.value)).toBe(false);
    let lost: CommandEnvelope | undefined;
    fuseki.commandWithReceipt = async envelope => {
      expect(envelope.receipt).toBe(raw.receipt);
      const result = await nativeCommand(envelope);
      expect(result.status).toBe('committed');
      lost = envelope;
      throw new CommandOutcomeUnknown('Lost committed held metadata restore acknowledgment');
    };
    const recovered = await reconcileRaw();
    fuseki.commandWithReceipt = nativeCommand;
    expect(recovered).toEqual({receipt:raw.receipt,revision:raw.revision,replayed:false});
    expect(lost).toBeDefined();
    expect(await reconcile('4')).toEqual({receipt:third.terminal.receipt,component:v2.id,
      revision:third.terminal.revision,replayed:false});
    expect(await componentFacts(fuseki,[v1.id,v2.id])).toEqual(sourceGraph);
    // Template-index payloads are new-lineage cache derivations; the retained
    // raw receipt, revision, actor, pins and original event remain exact.
    expect((await facts(fuseki,rawSubjects)).filter(fact => fact.graph!.value !== 'urn:rezics:graph:template-index'))
      .toEqual(sourceRawGraph.filter(fact => fact.graph!.value !== 'urn:rezics:graph:template-index'));
    for (const component of [v1.id,v2.id]) expect((await componentFacts(fuseki,[component])).length).toBeLessThanOrEqual(64);
    for (const source of sources) {
      expect(await facts(fuseki,[source.terminal.receipt,source.terminal.revision])).toEqual([]);
      expect(await objects.get(source.payloadSha256)).toEqual(new Uint8Array(source.payload));
      const profile = 'contentLanguages' in source.prepared.state ? METADATA_DETAILS_V2 : METADATA_PROFILE;
      expect(await readWorkComponentState(env,`urn:rezics:sha256:${source.prepared.manifest.slice(-64)}`,source.terminal.component,profile))
        .toMatchObject({ revision:source.terminal.revision,intent:{work,state:source.prepared.state} });
    }
    expect((await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:dataEpoch ${lit(restoredEpoch)} ; rv:routingEpoch ${lit(restoredRouting)} ; rv:sequence 0 ; rv:restoreHold true .
      ${iri(marker)} rv:reconciledPriorSequence 900 ; rv:reconciledPriorMainSequence 4 .
      ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:streamSequence 0 } }`)).boolean).toBe(true);
    const finished = await facts(fuseki);
    expect(await fuseki.command(interrupted!)).toMatchObject({status:'committed',
      position:{datasetId:DATASET,dataEpoch:restoredEpoch,sequence:'0'}});
    expect(await fuseki.command(lost!)).toMatchObject({status:'committed',
      position:{datasetId:DATASET,dataEpoch:sourceEpoch,sequence:'899'}});
    expect(await fuseki.command({...lost!,digest:hash('changed original restore source')})).toEqual({status:'conflict'});
    expect(await fuseki.command({...interrupted!,update:`${interrupted!.update}\n# altered source template`})).toEqual({status:'conflict'});
    for (const source of sources) expect(await reconcile(source.terminal.streamSequence)).toEqual({
      receipt:source.terminal.receipt,component:source.terminal.component,revision:source.terminal.revision,replayed:true});
    expect(await reconcileRaw()).toEqual({receipt:raw.receipt,revision:raw.revision,replayed:true});
    expect(await facts(fuseki)).toEqual(finished);
    expect((await accessPool.query(`SELECT receipt,request_digest,payload_sha256,payload,revision,
      terminal,outbox,reconciled_at,retired_at,data_epoch,stream_sequence::text
      FROM access.command_custody ORDER BY receipt`)).rows).toEqual(originalSql);
    expect((await accessPool.query(`SELECT id,acting_subject,scope_id,request_digest,authority_epoch,
      state,graph_receipt,graph_outcome,graph_data_epoch,graph_sequence FROM access.admission
      WHERE id=ANY($1::uuid[]) ORDER BY id`, [sourceAdmissionIds])).rows).toEqual(originalAdmissions);
    expect(await relayCoverage(relayPool,consumer)).toEqual(coverage);
    expect((await accessPool.query('SELECT open FROM access.recovery_fence WHERE id')).rows).toEqual([{open:false}]);
    expect(await accessStateCoverage(accessPool)).toEqual({
      count:signedCut.accessStateCount,digest:signedCut.accessStateDigest });

    // This is the original signed frontier: never recapture after replay or
    // replace it with the diagnostic cursor interpreted as a Main position.
    const authority = { sealedCoverage, hmacKey: recoveryKey };
    const operationId = `owner:reconcile:${randomUUID()}`;
    const restoredOwners: RestoredOwners = {
      access: accessPool, content: contentPool, account: accountPool,
      objects: { directory: env.objectDirectory, workObjects: objects },
      graph: {
        fuseki, lineage: env.lineage, receiptCustody: custody,
        heldErasure: {
          originalSource: 'original-graph',
          cut: { dataEpoch: restoredEpoch, routingEpoch: restoredRouting, restoreCutover: marker,
            priorDataEpoch: sourceEpoch, priorSequence: savedSource.sequence },
          accessHoldGeneration: fenceGeneration,
          originalGraph: { fuseki: originalFuseki, lineage: sourceLineage },
          signingKey: apps.FUSEKI_TITLE_ADMISSION_KEY!,
          maintenance: heldErasureMaintenanceClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!),
        },
      },
    };
    const callbackCalls: { pid: string; txid: string; generation: string }[] = [];
    let activeReleaseClients: { accessClient: PoolClient; relayClient: PoolClient } | undefined;
    const evidence: AuthenticatedRecoveryCoverage = {
      ...authority, accountPool, contentPool, objectStore: restoredOwners.objects,
      releaseErasures: async (clients, releaseGraph) => {
        expect(clients.accessClient).toBe(activeReleaseClients?.accessClient);
        expect(clients.relayClient).toBe(activeReleaseClients?.relayClient);
        const row = (await clients.accessClient.query<{ pid: string; txid: string }>(
          'SELECT pg_backend_pid()::text AS pid,txid_current()::text AS txid')).rows[0]!;
        callbackCalls.push({ ...row, generation: clients.fenceGeneration });
        const reconciled = await reconcileRestoredErasures(relayPool!, restoredOwners, {
          operationId: `${operationId}:erasures`, consumer, replay: true, authority,
        }, clients);
        expect(reconciled.state).toBe('reconciled');
        expect(reconciled.holdReason).toBeNull();
        await releaseErasureRestoreHold(relayPool!, restoredOwners,
          reconciled.reconciliationId, clients.fenceGeneration, authority,
          { clients, beforeAccessRelease: releaseGraph });
      },
    };
    const release = async (releaseEvidence = evidence) => {
      const relayClient = await checkoutRelay();
      let accessClient: PoolClient | undefined;
      try {
        // Frozen Trust requires a fresh retained READ COMMITTED view. The
        // caller acquires the allocator before the Access fence and owns both.
        await relayClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await relayClient.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-relay-erasure-epoch',0))");
        accessClient = await checkoutAccess();
        await accessClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await accessClient.query('SELECT open,generation FROM access.recovery_fence WHERE id FOR UPDATE');
        const identitySql = 'SELECT pg_backend_pid()::text AS pid,txid_current()::text AS txid';
        const accessIdentity = (await accessClient.query(identitySql)).rows;
        const relayIdentity = (await relayClient.query(identitySql)).rows;
        const accessQueries = spyOn(accessClient, 'query'), relayQueries = spyOn(relayClient, 'query');
        const forbidden = () => { throw new Error('Borrowed release cannot checkout, end a caller transaction or reconcile live custody'); };
        const guards = [
          spyOn(accessPool!, 'connect').mockImplementation(forbidden),
          spyOn(accessPool!, 'query').mockImplementation(forbidden),
          spyOn(relayPool!, 'connect').mockImplementation(forbidden),
          spyOn(relayPool!, 'query').mockImplementation(forbidden),
          spyOn(accessClient, 'release').mockImplementation(forbidden),
          spyOn(relayClient, 'release').mockImplementation(forbidden),
          spyOn(custodyStore, 'withReceipt').mockImplementation(forbidden),
          spyOn(custodyStore, 'receiptAt').mockImplementation(forbidden),
          spyOn(custody, 'read').mockImplementation(forbidden),
          spyOn(custody, 'resolve').mockImplementation(forbidden),
          spyOn(custody, 'readCommitted').mockImplementation(forbidden),
          spyOn(custody, 'commit').mockImplementation(forbidden),
          spyOn(custody, 'retire').mockImplementation(forbidden),
        ];
        activeReleaseClients = { accessClient, relayClient };
        try {
          await releaseRestoredGraphHold(fuseki, accessPool!, relayPool!, env!.lineage,
            releaseEvidence, relayClient, accessClient);
        } finally {
          activeReleaseClients = undefined;
          try {
            for (const queries of [accessQueries, relayQueries]) for (const call of queries.mock.calls) {
              expect(String(call[0])).not.toMatch(/(?:^|;)\s*(?:BEGIN|COMMIT|ROLLBACK)\b/i);
            }
            for (const guard of guards) expect(guard).not.toHaveBeenCalled();
          } finally {
            for (const guard of guards.reverse()) guard.mockRestore();
            accessQueries.mockRestore(); relayQueries.mockRestore();
          }
          expect((await accessClient.query(identitySql)).rows).toEqual(accessIdentity);
          expect((await relayClient.query(identitySql)).rows).toEqual(relayIdentity);
        }
        await accessClient.query('COMMIT');
        await relayClient.query('COMMIT');
      } catch (error) {
        if (accessClient) await accessClient.query('ROLLBACK').catch(() => undefined);
        await relayClient.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        accessClient?.release();
        relayClient.release();
      }
    };
    const refusePair = async (options: { access: 'repeatable read' | 'read committed' | null;
      relay: 'repeatable read' | 'read committed' | null; message: string;
      callback?: AuthenticatedRecoveryCoverage['releaseErasures']; callbackChangesTransaction?: boolean }) => {
      const relayClient = await checkoutRelay();
      let accessClient: PoolClient | undefined;
      const beforeGraph = await facts(fuseki);
      try {
        if (options.relay) await relayClient.query(`BEGIN ISOLATION LEVEL ${options.relay.toUpperCase()}`);
        accessClient = await checkoutAccess();
        if (options.access) await accessClient.query(`BEGIN ISOLATION LEVEL ${options.access.toUpperCase()}`);
        const accessQueries = spyOn(accessClient, 'query'), relayQueries = spyOn(relayClient, 'query');
        const forbidden = () => { throw new Error('Refused paired release cannot checkout, release a client or dispatch native mutation'); };
        const guards = [spyOn(accessPool!, 'connect').mockImplementation(forbidden),
          spyOn(accessPool!, 'query').mockImplementation(forbidden), spyOn(relayPool!, 'connect').mockImplementation(forbidden),
          spyOn(relayPool!, 'query').mockImplementation(forbidden), spyOn(accessClient, 'release').mockImplementation(forbidden),
          spyOn(relayClient, 'release').mockImplementation(forbidden), spyOn(fuseki, 'command').mockImplementation(forbidden),
          spyOn(fuseki, 'commandWithReceipt').mockImplementation(forbidden),
          spyOn(custodyStore, 'withReceipt').mockImplementation(forbidden),
          spyOn(custody, 'resolve').mockImplementation(forbidden), spyOn(custody, 'read').mockImplementation(forbidden),
          spyOn(custody, 'readCommitted').mockImplementation(forbidden), spyOn(custody, 'commit').mockImplementation(forbidden),
          spyOn(custody, 'retire').mockImplementation(forbidden)];
        let refusal: unknown;
        try {
          await releaseRestoredGraphHold(fuseki,accessPool!,relayPool!,env!.lineage,
            options.callback ? { ...evidence, releaseErasures: options.callback } : evidence,
            relayClient,accessClient);
        } catch (error) {
          refusal = error;
        } finally {
          try {
            expect(() => { if (refusal) throw refusal; }).toThrow(options.message);
            const lifecycle = (queries: typeof accessQueries) => queries.mock.calls.map(call => String(call[0]).trim())
              .filter(sql => /^(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(sql));
            expect(lifecycle(relayQueries)).toEqual([]);
            expect(lifecycle(accessQueries)).toEqual(options.callbackChangesTransaction
              ? ['ROLLBACK','BEGIN ISOLATION LEVEL REPEATABLE READ'] : []);
            for (const guard of guards) expect(guard).not.toHaveBeenCalled();
          } finally {
            for (const guard of guards.reverse()) guard.mockRestore();
            accessQueries.mockRestore(); relayQueries.mockRestore();
          }
        }
        expect((await accessClient.query('SELECT open,generation::text FROM access.recovery_fence WHERE id')).rows)
          .toEqual([{ open:false,generation:fenceGeneration }]);
      } finally {
        if (accessClient) { try { await accessClient.query('ROLLBACK'); } finally { accessClient.release(); } }
        try { await relayClient.query('ROLLBACK'); } finally { relayClient.release(); }
      }
      expect(await facts(fuseki)).toEqual(beforeGraph);
    };
    const callbacksBeforeRefusal = callbackCalls.length;
    await refusePair({ access:null,relay:'read committed',
      message:'borrowed Access restore requires an active repeatable read transaction' });
    await refusePair({ access:'repeatable read',relay:null,
      message:'borrowed relay restore requires an active read committed transaction' });
    await refusePair({ access:'read committed',relay:'read committed',
      message:'borrowed Access restore requires an active repeatable read transaction' });
    await refusePair({ access:'repeatable read',relay:'repeatable read',
      message:'borrowed relay restore requires an active read committed transaction' });
    expect(callbackCalls).toHaveLength(callbacksBeforeRefusal);
    let changedTransactionCallbacks = 0;
    await refusePair({ access:'repeatable read',relay:'read committed',callbackChangesTransaction:true,
      message:'borrowed Access restore transaction changed',callback:async (clients,releaseGraph) => {
        changedTransactionCallbacks++;
        const reconciled = await reconcileRestoredErasures(relayPool!,restoredOwners,{
          operationId:`${operationId}:changed-transaction:erasures`,consumer,replay:true,authority,
        },clients);
        // Preserve the exact custody refusal when the owner's summary stays held.
        if (reconciled.state !== 'reconciled') await restoredCustodyDigests(accessPool!,
          restoredOwners.graph!,restoredOwners.objects!,clients.accessClient);
        expect(reconciled.holdReason).toBeNull();
        expect(reconciled.state).toBe('reconciled');
        // Lose the caller's original Access lock/snapshot, then enter a new
        // valid transaction. Root's retained identity must veto graph release.
        await clients.accessClient.query('ROLLBACK');
        await clients.accessClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await releaseErasureRestoreHold(relayPool!,restoredOwners,reconciled.reconciliationId,
          clients.fenceGeneration,authority,{clients,beforeAccessRelease:releaseGraph});
      } });
    expect(changedTransactionCallbacks).toBe(1);
    expect((await relayPool.query('SELECT operation_id FROM relay.owner_reconciliation WHERE operation_id=$1',
      [`${operationId}:changed-transaction:erasures`])).rows).toEqual([]);
    const releaseReceipt = `urn:rezics:receipt:restore-release:${hash(restoredEpoch)}`;
    const beforeRelease = await facts(fuseki);
    const interruptedCallbacks = callbackCalls.length;
    fuseki.commandWithReceipt = async envelope => {
      expect(envelope.receipt).toBe(releaseReceipt);
      throw new CommandOutcomeUnknown('Interrupted before native graph release');
    };
    try { await expect(release()).rejects.toThrow('recovery release outcome is unknown'); }
    finally { fuseki.commandWithReceipt = nativeCommand; }
    expect(callbackCalls.length).toBe(interruptedCallbacks + 1);
    expect(callbackCalls.at(-1)?.generation).toBe(fenceGeneration);
    expect(await facts(fuseki)).toEqual(beforeRelease);
    expect((await accessPool.query('SELECT open,generation::text FROM access.recovery_fence WHERE id')).rows)
      .toEqual([{ open: false, generation: fenceGeneration }]);
    expect((await relayPool.query('SELECT operation_id FROM relay.owner_reconciliation WHERE operation_id=$1',
      [`${operationId}:erasures`])).rows).toEqual([]);

    let lostRelease: CommandEnvelope | undefined;
    fuseki.commandWithReceipt = async envelope => {
      expect(envelope.receipt).toBe(releaseReceipt);
      const result = await nativeCommand(envelope);
      expect(result).toMatchObject({ status: 'committed',
        position: { datasetId: DATASET, dataEpoch: restoredEpoch, sequence: '0' } });
      lostRelease = envelope;
      throw new CommandOutcomeUnknown('Lost committed native graph release acknowledgment');
    };
    try { await release(); }
    finally { fuseki.commandWithReceipt = nativeCommand; }
    expect(lostRelease).toBeDefined();
    expect(lostRelease!.digest).toBe(hash(JSON.stringify({ family: 'restore-release-v2', lineage: env.lineage,
      priorDataEpoch: signedCut.priorDataEpoch, priorSequence: '900', priorMainSequence: '4',
      streamScope: MAIN_RELAY_STREAM_SCOPE })));
    expect(callbackCalls.length).toBe(interruptedCallbacks + 2);
    expect(callbackCalls.at(-1)?.generation).toBe(fenceGeneration);
    expect((await accessPool.query('SELECT open,generation::text FROM access.recovery_fence WHERE id')).rows)
      .toEqual([{ open: true, generation: (BigInt(fenceGeneration) + 1n).toString() }]);
    expect((await fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ${lit(restoredEpoch)} ; rv:routingEpoch ${lit(restoredRouting)} ; rv:sequence 0 .
        ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:dataEpoch ${lit(restoredEpoch)} ; rv:streamSequence 0 .
        ${iri(marker)} rv:priorSequence 876 ; rv:priorMainSequence 0 ;
          rv:reconciledPriorSequence 900 ; rv:reconciledPriorMainSequence 4 .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(releaseReceipt)} rv:requestDigest ${lit(lostRelease!.digest)} ;
          rv:dataEpoch ${lit(restoredEpoch)} ; rv:sequence 0 ;
          rv:priorMainSequence 4 ; rv:streamScope ${lit(MAIN_RELAY_STREAM_SCOPE)} .
      }
    }`)).boolean).toBe(true);
    const released = await facts(fuseki);
    expect(await fuseki.command(lostRelease!)).toMatchObject({ status: 'committed',
      position: { datasetId: DATASET, dataEpoch: restoredEpoch, sequence: '0' } });
    const lastCallbacks = callbackCalls.length;
    await expect(release()).rejects.toThrow('Access recovery fence is not held');
    expect(callbackCalls).toHaveLength(lastCallbacks);
    expect(await facts(fuseki)).toEqual(released);

    // Ordinary committed API replay preserves the original raw and retired
    // owner results after activation; it never redispatches a graph repair.
    const restoredAccess = new AccessAdmissionRegistry(accessPool, apps.FUSEKI_TITLE_ADMISSION_KEY);
    restoredAccess.configureBaseline(fuseki);
    const redispatch = spyOn(fuseki, 'commandWithReceipt').mockImplementation(async () => {
      throw new Error('An original committed API replay must not dispatch');
    });
    try {
      expect(await setAdmittedWorkScalar(env, deps.account, restoredAccess, request, { work,
        expectedHead: created.workRevision!, scalarValue: { kind: 'integer', lexical: '0' },
        actingSubject: actor, idempotencyKey: rawKey })).toEqual({ ...raw, replayed: true });
      for (const source of sources) {
        const key = (await accessPool.query<{ idempotency_key: string }>(
          'SELECT idempotency_key FROM access.admission WHERE id=$1', [source.terminal.admissionId])).rows[0]!.idempotency_key;
        const replay = await setWorkMetadata({ ...deps, access: restoredAccess }, request, {
          profile: 'contentLanguages' in source.prepared.state
            ? 'work-metadata-details-v2' : 'work-metadata-details-v1',
          work, state: source.prepared.state,
          expectedHead: source.terminal.predecessor === source.terminal.component ? null : source.terminal.predecessor ?? null,
          actingSubject: actor, idempotencyKey: key,
        });
        expect(replay).toMatchObject({ work, component: source.terminal.component,
          revision: source.terminal.revision, receipt: source.terminal.receipt, replayed: true,
          sourcePosition: { dataEpoch: sourceEpoch, sequence: source.terminal.sequence } });
      }
      expect(redispatch).not.toHaveBeenCalled();
    } finally { redispatch.mockRestore(); }
    expect(await facts(fuseki)).toEqual(released);
    expect((await accessPool.query(`SELECT receipt,request_digest,payload_sha256,payload,revision,
      terminal,outbox,reconciled_at,retired_at,data_epoch,stream_sequence::text
      FROM access.command_custody ORDER BY receipt`)).rows).toEqual(originalSql);
    expect((await accessPool.query(`SELECT id,acting_subject,scope_id,request_digest,authority_epoch,
      state,graph_receipt,graph_outcome,graph_data_epoch,graph_sequence FROM access.admission
      WHERE id=ANY($1::uuid[]) ORDER BY id`, [sourceAdmissionIds])).rows).toEqual(originalAdmissions);
    expect(await relayCoverage(relayPool, consumer)).toEqual(coverage);
    for (const source of sources) expect(await objects.get(source.payloadSha256)).toEqual(new Uint8Array(source.payload));
    await rawUpdateClosed();
  } finally {
    await accessPool?.end();
    await relayPool?.end();
    await historicalPool?.end();
    await accountPool?.end();
    await contentPool?.end();
    postgres?.stop();
    originalGraph?.remove();
    try { execFileSync('docker', ['volume', 'rm', originalVolume], { cwd: root, env: stack.dockerEnv, timeout: 20_000, stdio:'pipe' }); }
    catch (error) { if (originalGraph) throw error; }
    rmSync(recoveryDirectory,{recursive:true,force:true});
    if (env) rmSync(env.objectDirectory,{recursive:true,force:true});
    await rootCommand(['stack:reset',...stack.args],120_000);
  }
},600_000);
