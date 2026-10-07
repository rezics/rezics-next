import { expect, spyOn, test } from 'bun:test';
import { AwsClient } from 'aws4fetch';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { CommandOutcomeUnknown, CommandRejected, FusekiClient, type CommandEnvelope, type CommandResult }
  from '../../../services/main/src/infrastructure/fuseki.ts';
import { S3ImmutableObjects } from '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission, type VerifiedPrincipal }
  from '../../../services/main/src/modules/access/admission.ts';
import { proofRetirementSender } from '../../../services/main/src/modules/graph/slim-command.ts';
import { PostgresReceiptCustodyStore, ReceiptCustody, type CustodiedReceipt, type HistoricalReceiptSource, type PreparedCommand }
  from '../../../services/main/src/modules/outbox/receipt-custody.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { relayCoverage, type CustodiedOutbox, type MainCloudEvent } from '../../../services/main/src/modules/outbox/relay.ts';
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
import { reconcileRetainedSlimMetadata }
  from '../../../services/main/src/modules/work/reconcile-restored.ts';
import { migrateAccess, qaStack, rootCommand, waitForFuseki, type QaStack }
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
    accessPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL });
    historicalPool = new Pool({ connectionString: apps.ACCESS_DATABASE_URL, max: 1, connectionTimeoutMillis: 1_000 });
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
    const custody = new ReceiptCustody(new PostgresReceiptCustodyStore(accessPool), objects, fuseki,
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
    // Edition validation requires a recorded descriptive header on its owning Work.
    await setWorkMetadata(deps, request, { profile: 'work-metadata-details-v1', work, expectedHead: null,
      state: checkedMetadataState({ kind: 'header', originalTitle: { value: title, language: 'en' }, localized: [] }),
      actingSubject: actor, idempotencyKey: randomUUID() });
    const sourceEpoch = env.lineage.dataEpoch;
    // Allocate real native edition commits at diagnostic 897..900 and Main 1..4.
    // Only this stopped disposable copy replaces its setup's older source cut.
    await loadStoppedCopy(stack, `PREFIX rv: <${RV}>
      CLEAR GRAPH ${iri(GRAPHS.outbox)} ;
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?old .
        ${iri(MAIN_RELAY_STREAM_SCOPE)} ?p ?o } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence 896 .
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
      const result = await setWorkMetadata(deps, request, { profile, work, state, expectedHead,
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
        sequence: String(897 + sources.length), streamSequence: String(1 + sources.length) });
      const source = { payloadSha256: found.payload_sha256, payload: found.payload, prepared,
        terminal: found.terminal, outbox: found.outbox };
      sources.push(source);
      return source;
    };
    const first = await write(v1, null, 'work-metadata-details-v1');
    await write({ ...v1, status: 'withdrawn' }, first.terminal.revision, 'work-metadata-details-v1');
    const third = await write(v2, null, 'work-metadata-details-v2');
    await write(checkedEditionV2({ ...v2, title: { value: 'Last exact retained V2', language: 'en-us' },
      publisher: 'Later retained publisher' }), third.terminal.revision, 'work-metadata-details-v2');
    fuseki.commandWithReceipt = nativeCommand;
    const sourceGraph = await componentFacts(fuseki, [v1.id, v2.id]);
    const originalSql = (await accessPool.query(`SELECT receipt,request_digest,payload_sha256,payload,revision,
      terminal,outbox,reconciled_at,retired_at,data_epoch,stream_sequence::text
      FROM access.command_custody ORDER BY receipt`)).rows;
    const sourceAdmissionIds = sources.map(source => source.terminal.admissionId);
    const originalAdmissions = (await accessPool.query(`SELECT id,acting_subject,scope_id,request_digest,authority_epoch,
      state,graph_receipt,graph_outcome,graph_data_epoch,graph_sequence FROM access.admission
      WHERE id=ANY($1::uuid[]) ORDER BY id`, [sourceAdmissionIds])).rows;
    expect(originalAdmissions).toHaveLength(4);
    expect(originalAdmissions.every(admission => admission.state === 'sealed')).toBe(true);
    const consumer = 'slim-metadata-restore';
    for (const source of sources) {
      const event = source.outbox.events[0]!;
      expect(event.data.sourcePosition.sequence).toBe(source.terminal.sequence);
      expect(event.data.relayPosition?.sequence).toBe(source.terminal.streamSequence);
      await relayPool.query(`INSERT INTO relay.delivered_batch (data_epoch,sequence,batch_id,routing_epoch,event_count)
        VALUES ($1,$2,$3,$4,1)`, [sourceEpoch, source.terminal.streamSequence, source.outbox.batchId, env.lineage.routingEpoch]);
      await relayPool.query(`INSERT INTO relay.delivered_event (source,event_id,data_epoch,sequence,envelope)
        VALUES ($1,$2,$3,$4,$5::jsonb)`, [event.source,event.id,sourceEpoch,source.terminal.streamSequence,JSON.stringify(event)]);
    }
    await relayPool.query('INSERT INTO relay.checkpoint (consumer,data_epoch,sequence) VALUES ($1,$2,4)', [consumer,sourceEpoch]);
    const coverage = await relayCoverage(relayPool,consumer);
    expect(coverage).toMatchObject({ dataEpoch: sourceEpoch, sequence: '4', batchCount: '4', eventCount: '4' });
    // Change an unrelated model artifact while preserving every recorded selected shape digest.
    const modelDirectory = resolve(root, 'generated/model');
    const model = JSON.parse(readFileSync(resolve(modelDirectory, 'manifest.json'), 'utf8')) as {
      commandModule: string; profiles: { id: string; file: string; sha256: string }[] };
    const selectedProfiles = new Set(sources.flatMap(source => source.prepared.envelope.validations.map(pin => pin.profile)));
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
    const restoredEpoch = randomUUID(), restoredRouting = randomUUID(), marker = `urn:rezics:restore:${restoredEpoch}`;
    await loadStoppedCopy(stack, `PREFIX rv: <${RV}>
      DELETE { ${iri(v1.id)} ?v1p ?v1o . ${iri(v2.id)} ?v2p ?v2o .
        GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:editionsRevision ?oldEdition .
          ${iri(MODEL_COMPONENT)} rv:generationHead ?oldModel }
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?oldEpoch ; rv:routingEpoch ?oldRouting ; rv:sequence ?oldSequence .
          ${iri(MAIN_RELAY_STREAM_SCOPE)} ?streamP ?streamO } }
      INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ${iri(unrelatedRoot)} }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(unrelatedRoot)} a rv:ModelGeneration, rv:RevisionAnchor ;
          rv:component ${iri(MODEL_COMPONENT)} ; rv:predecessor ${iri(ACTIVE_GENERATION)} ; rv:generationNumber 2 ;
          rv:manifest ${iri(`urn:rezics:sha256:${rootManifest}`)} ; rv:commandModuleVersion ${lit(model.commandModule)} ;
          rv:entailmentProfile rv:NoEntailment ; rv:identityInference rv:Excluded ; rv:validationPosture rv:RejectOnViolation ;
          rv:operation ${iri(nativeId())} ; rv:modelRevision ${iri(PROFILES.generation)} ; rv:shapeRevision ${iri(PROFILES.generation)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(sourceEpoch)} ; rv:sequence 896 }
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(restoredEpoch)} ; rv:routingEpoch ${lit(restoredRouting)} ;
          rv:sequence 0 ; rv:restoreCutover ${iri(marker)} ; rv:restoreHold true .
          ${iri(marker)} a rv:RestoreCutover ; rv:priorDataEpoch ${lit(sourceEpoch)} ; rv:priorSequence 896 ;
            rv:priorMainSequence 0 ; rv:dataEpoch ${lit(restoredEpoch)} .
          ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:dataEpoch ${lit(restoredEpoch)} ; rv:streamSequence 0 ; rv:legacyThroughSequence 0 } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?oldEpoch ; rv:routingEpoch ?oldRouting ; rv:sequence ?oldSequence .
        OPTIONAL { ${iri(MAIN_RELAY_STREAM_SCOPE)} ?streamP ?streamO } }
        OPTIONAL { ${iri(v1.id)} ?v1p ?v1o }
        OPTIONAL { ${iri(v2.id)} ?v2p ?v2o }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:editionsRevision ?oldEdition } }
        OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(MODEL_COMPONENT)} rv:generationHead ?oldModel } } }`);
    env.lineage = { dataEpoch: restoredEpoch,routingEpoch: restoredRouting };
    expect(await componentFacts(fuseki,[v1.id,v2.id])).toEqual([]);
    const retainedModel = await readExactModelGeneration(env,unrelatedRoot);
    const health = await fuseki.commandHealth();
    for (const source of sources) for (const pin of source.prepared.envelope.validations) {
      expect(health.profiles[pin.profile]).toBe(pin.sha256);
      expect(retainedModel.shapes.find(shape => shape.profile === pin.profile)?.sha256).toBe(pin.sha256);
    }
    const reconcile = (sequence: string) => reconcileRetainedSlimMetadata(env!,accessPool!,relayPool!,coverage,sequence);
    const held = await facts(fuseki);
    await expect(reconcile('1')).rejects.toThrow();
    expect(await facts(fuseki)).toEqual(held);
    await accessPool.query('UPDATE access.recovery_fence SET open=false WHERE id');
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
      expect(envelope.receipt).toStartWith('urn:rezics:name-migration:metadata-restore:');
      const result = await nativeCommand(envelope);
      expect(result.status).toBe('committed');
      lost = envelope;
      throw new CommandOutcomeUnknown('Lost committed held metadata restore acknowledgment');
    };
    const recovered = await reconcile('3');
    fuseki.commandWithReceipt = nativeCommand;
    expect(recovered).toEqual({receipt:third.terminal.receipt,component:v2.id,revision:third.terminal.revision,replayed:false});
    expect(lost).toBeDefined();
    expect(await reconcile('4')).toEqual({receipt:sources[3]!.terminal.receipt,component:v2.id,
      revision:sources[3]!.terminal.revision,replayed:false});
    expect(await componentFacts(fuseki,[v1.id,v2.id])).toEqual(sourceGraph);
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
    for (const envelope of [interrupted!,lost!]) expect(await fuseki.command(envelope)).toMatchObject({status:'committed',
      position:{datasetId:DATASET,dataEpoch:restoredEpoch,sequence:'0'}});
    expect(await fuseki.command({...lost!,digest:hash('changed original restore source')})).toEqual({status:'conflict'});
    expect(await fuseki.command({...lost!,update:`${lost!.update}\n# altered source template`})).toEqual({status:'conflict'});
    for (const source of sources) expect(await reconcile(source.terminal.streamSequence)).toEqual({
      receipt:source.terminal.receipt,component:source.terminal.component,revision:source.terminal.revision,replayed:true});
    expect(await facts(fuseki)).toEqual(finished);
    expect((await accessPool.query(`SELECT receipt,request_digest,payload_sha256,payload,revision,
      terminal,outbox,reconciled_at,retired_at,data_epoch,stream_sequence::text
      FROM access.command_custody ORDER BY receipt`)).rows).toEqual(originalSql);
    expect((await accessPool.query(`SELECT id,acting_subject,scope_id,request_digest,authority_epoch,
      state,graph_receipt,graph_outcome,graph_data_epoch,graph_sequence FROM access.admission
      WHERE id=ANY($1::uuid[]) ORDER BY id`, [sourceAdmissionIds])).rows).toEqual(originalAdmissions);
    expect(await relayCoverage(relayPool,consumer)).toEqual(coverage);
    expect((await accessPool.query('SELECT open FROM access.recovery_fence WHERE id')).rows).toEqual([{open:false}]);
    await rawUpdateClosed();
  } finally {
    await accessPool?.end();
    await relayPool?.end();
    await historicalPool?.end();
    if (env) rmSync(env.objectDirectory,{recursive:true,force:true});
    await rootCommand(['stack:reset',...stack.args],120_000);
  }
},360_000);
