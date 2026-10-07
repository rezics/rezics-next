import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool, type PoolClient } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { healthRoutes } from '../../../services/main/src/routes/health.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from
  '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry, AdmissionUnavailable, engageAccessRecoveryFence } from
  '../../../services/main/src/modules/access/admission.ts';
import { applyContentErasure } from '../../../services/main/src/modules/erasure/content.ts';
import { graphErasureSuppressed, heldErasureMaintenanceClient, probeHeldGraphErasureProof, readGraphErasureProof, suppressGraphContentRevisions,
  type HeldGraphErasureCut } from
  '../../../services/main/src/modules/erasure/graph.ts';
import { readRetainedNativeGraphSuppressionProof, type RestoredGraphCustody } from
  '../../../services/main/src/modules/erasure/custody.ts';
import { ensureRetentionDomain, journalErasure, markErasureSuppressed, readErasure,
  recordErasureInventory } from '../../../services/main/src/modules/erasure/journal.ts';
import { ErasureRestoreHold, reconcileRestoredErasures, releaseErasureRestoreHold,
  retainErasureCoverage, type BorrowedRestoreClients, type RestoredOwners } from '../../../services/main/src/modules/erasure/reconcile.ts';
import { PostgresReceiptCustodyStore, ReceiptCustody } from
  '../../../services/main/src/modules/outbox/receipt-custody.ts';
import { assertObjectRecoveryCoverage } from '../../../services/main/src/modules/owner/object-coverage.ts';
import { proofRetirementSender } from '../../../services/main/src/modules/graph/slim-command.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { ACTIVE_GENERATION, ensureModelGeneration, MODEL_MANIFEST_SHA256 } from
  '../../../services/main/src/modules/semantic/command.ts';
import { DATASET, GRAPHS, RV, hash, initializeFreshGraph, iri, lit, type WorkActivationEnvironment } from
  '../../../services/main/src/modules/work/activate.ts';
import { commitMetadata, readMetadataReceipt } from '../../../services/main/src/modules/work/metadata-command.ts';
import { checkedMetadataState, metadataDigest, type MetadataIntent } from
  '../../../services/main/src/modules/work/metadata-schema.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { captureGraphRecoveryCoverage, cutoverRestoredGraphLineage, readGraphRecoverySource,
  readRestoredGraphReleaseProof, RestoreLineageConflict, type RecoveryCoverage,
  type RestoredGraphReleaseExpectation } from
  '../../../services/main/src/modules/work/restore-lineage.ts';
import { accessStateTables } from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { assertContentRecoveryCoverage } from
  '../../../services/main/src/modules/work/content-recovery-coverage.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import { offlineTextIndex } from '../../../scripts/operations/search-state.ts';
import { authorCreditFixture, nativeId } from '../fixtures/author-credit.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { fusekiSecrets, pinnedImage, qaStack, standaloneFuseki } from './search-ops-support.ts';

class DirectoryObjects implements ImmutableObjects {
  constructor(readonly directory: string) { mkdirSync(directory, { recursive: true }); }
  async put(bytes: Uint8Array): Promise<string> {
    const digest = hash(bytes);
    writeFileSync(join(this.directory, digest), bytes);
    return digest;
  }
  async get(digest: string): Promise<Uint8Array> {
    let bytes: Buffer;
    try { bytes = readFileSync(join(this.directory, digest)); }
    catch { throw new ObjectUnavailable('exact fixture object is missing'); }
    if (hash(bytes) !== digest) throw new ObjectIntegrityError('exact fixture object differs');
    return bytes;
  }
}

test('OPS12: a consistent pre-erasure cut replays Content suppression and proves C6 command and model custody before release', async () => {
  const preparation = Date.now();
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the isolated fault/recovery QA tier');
  const root = resolve(import.meta.dir, '../../..');
  const qa = qaStack(runId);
  const apps = readEnv(join(qa.directory, 'apps.env'));
  const databases = await cloneQaOwnerDatabases(runId, ['account', 'access', 'content', 'relay']);
  const directory = join(root, '.temp', `erasure-custody-restore-${randomUUID()}`);
  const backupObjects = join(directory, 'pre-erasure-objects');
  const objects = new DirectoryObjects(join(directory, 'live-objects'));
  const pools = new Set<Pool>();
  const pool = (url: string) => { const value = new Pool({ connectionString: url, max: 1,
    connectionTimeoutMillis: 2000 });
    pools.add(value); return value; };
  const close = async (value: Pool) => { await value.end(); pools.delete(value); };
  let access = pool(databases.urls.access), content = pool(databases.urls.content);
  const account = pool(databases.urls.account), relay = pool(databases.urls.relay);
  const suffix = randomBytes(6).toString('hex');
  const volumes: string[] = [], containers: Awaited<ReturnType<typeof standaloneFuseki>>[] = [];
  const copies: string[] = [];
  const docker = (args: string[], timeout = 60_000) => {
    const result = spawnSync('docker', args, { env: qa.dockerEnv, encoding: 'utf8', timeout });
    if (result.status !== 0) throw new Error(`isolated custody fixture operation failed: ${result.stderr.slice(-1500)}`);
  };
  const volume = (label: string) => {
    const name = `rezics-custody-${suffix}-${label}`;
    volumes.push(name); docker(['volume', 'create', name]); return name;
  };
  const copyGraph = (from: string, to: string) => docker(['run', '--rm', '--network', 'none',
    '--user', '0:0', '--volume', `${from}:/from:ro`, '--volume', `${to}:/to`,
    '--entrypoint', 'sh', pinnedImage(), '-ec', 'cp -a /from/rezics /to/rezics']);
  const adminUrl = `postgres://postgres:${encodeURIComponent(qa.composeEnv.POSTGRES_PASSWORD!)}@127.0.0.1:${qa.composeEnv.POSTGRES_PORT}/postgres`;
  const admin = async (sql: string) => {
    const client = new Client({ connectionString: adminUrl }); await client.connect();
    try { await client.query(sql); } finally { await client.end(); }
  };
  let fixture: Awaited<ReturnType<typeof authorCreditFixture>> | undefined;
  try {
    const liveVolume = volume('live'), cutVolume = volume('cut');
    const live = await standaloneFuseki(qa.dockerEnv, { name: `rezics-custody-${suffix}-live`,
      image: pinnedImage(), volume: liveVolume, secrets: fusekiSecrets(qa.composeEnv) });
    containers.push(live);
    const native = new FusekiClient(live.url, qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN,
      qa.composeEnv.FUSEKI_COMMAND_TOKEN);
    const lineage = { dataEpoch: apps.MAIN_DATA_EPOCH!, routingEpoch: apps.MAIN_ROUTING_EPOCH! };
    await initializeFreshGraph(native, lineage);
    fixture = await authorCreditFixture({ ...apps, FUSEKI_URL: live.url,
      MAIN_OBJECT_DIRECTORY: objects.directory, ACCOUNT_DATABASE_URL: databases.urls.account,
      ACCESS_DATABASE_URL: databases.urls.access, CONTENT_DATABASE_URL: databases.urls.content },
    objects.directory, 'openid work:create work:edit work:read access:manage');
    const custody = new ReceiptCustody(new PostgresReceiptCustodyStore(access), objects, native,
      qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!, proofRetirementSender(live.url, qa.composeEnv.FUSEKI_COMMAND_TOKEN!));
    const env: WorkActivationEnvironment = { ...fixture.env, fuseki: native, workObjects: objects,
      receiptCustody: custody };
    await ensureModelGeneration(env);
    const key = randomUUID();
    const created = await fixture.json<{ work: string }>(await fixture.call('POST', '/v1/works',
      await fixture.catalogueBody({ profile: 'metadata-only-v1', title: 'Custody restore fixture',
        language: 'en', actingSubject: fixture.actor }, key), key), 201);
    await fixture.grant(`work:edit:${created.work}`, 'work.edit');
    const principal = await fixture.account.verifier.verify(new Request('http://main.local', {
      headers: { authorization: `Bearer ${fixture.account.tokenA}` },
    }), ['work:edit']);
    const header: MetadataIntent = { work: created.work, expectedHead: null,
      state: checkedMetadataState({ kind: 'header', originalTitle: { value: 'Custody restore fixture', language: 'en' },
        localized: [] }) };
    const headerAdmission = await fixture.access.register({ principal, actingSubject: fixture.actor,
      scope: `work:edit:${created.work}`, action: 'work.edit', idempotencyKey: randomUUID(),
      requestDigest: metadataDigest(header) });
    expect(await commitMetadata(env, await fixture.access.claim(headerAdmission.id,
      headerAdmission.requestDigest, principal), header)).toBe(true);
    const intent: MetadataIntent = { work: created.work, expectedHead: null,
      state: checkedMetadataState({ kind: 'edition', id: nativeId(), status: 'active',
        title: { value: 'Retained edition', language: 'en' }, contentLanguage: 'en',
        editionStatement: null, publisher: null, publicationYear: null, isbn13: null }) };
    const registered = await fixture.access.register({ principal, actingSubject: fixture.actor,
      scope: `work:edit:${created.work}`, action: 'work.edit', idempotencyKey: randomUUID(),
      requestDigest: metadataDigest(intent) });
    const claimed = await fixture.access.claim(registered.id, registered.requestDigest, principal);
    expect(await commitMetadata(env, claimed, intent)).toBe(true);
    const command = (await readMetadataReceipt(env, claimed.id))!;
    await custody.retire(command.receipt);
    const retainedCommand = (await access.query<{ payload_sha256: string; retired: boolean }>(
      'SELECT payload_sha256, retired_at IS NOT NULL AS retired FROM access.command_custody WHERE receipt = $1',
    [command.receipt])).rows[0]!;
    const historicalClient = await access.connect();
    const historical = await custody.readHistorical({ dataEpoch: command.dataEpoch,
      streamSequence: command.streamSequence }, historicalClient).finally(() => historicalClient.release());
    if (!historical) throw new Error('retired fixture command lacks exact historical custody');
    const originalRoots = [...historical.objectDigests];
    expect(originalRoots).toContain(retainedCommand.payload_sha256);
    expect(originalRoots.length).toBeGreaterThanOrEqual(4);
    expect(retainedCommand.retired).toBe(true);
    expect((await native.query(`PREFIX rv: <https://rezics.com/vocab/> ASK {
      GRAPH <urn:rezics:graph:receipts> { <${command.receipt}> a rv:CommitProof } }`)).boolean).toBe(false);
    const core = new ContentCore(content);
    const saved = await core.saveDraft({ operationId: randomUUID(), variant: {
      id: `urn:rezics:variant:${randomUUID()}`, resourceId: created.work,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
      provenance: { fixture: 'custody-restore' }, serializedJson: JSON.stringify({ body: 'pre-erasure secret' }) });
    if (saved.outcome !== 'succeeded' || !saved.revisionId) throw new Error('Content fixture save failed');
    const laterSaved = await core.saveDraft({ operationId: randomUUID(), variant: {
      id: `urn:rezics:variant:${randomUUID()}`, resourceId: created.work,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
      provenance: { fixture: 'custody-restore' }, serializedJson: JSON.stringify({ body: 'later erasure secret' }) });
    if (laterSaved.outcome !== 'succeeded' || !laterSaved.revisionId) throw new Error('later Content fixture save failed');
    const originalSaved = await core.saveDraft({ operationId: randomUUID(), variant: {
      id: `urn:rezics:variant:${randomUUID()}`, resourceId: created.work,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
      provenance: { fixture: 'custody-restore' }, serializedJson: JSON.stringify({ body: 'retained original secret' }) });
    if (originalSaved.outcome !== 'succeeded' || !originalSaved.revisionId) throw new Error('original Content fixture save failed');
    const revision = `urn:rezics:content:revision:${saved.revisionId}`;
    const unit = `urn:rezics:content:match-unit:${randomUUID()}`;
    // Seed the pre-erasure indexed reference in the stopped fixture, as the existing restore drill does.
    live.runner.stop();
    live.runner.offline(`cat > /fuseki/databases/custody-seed.nq <<'NQ'
<${unit}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://rezics.com/vocab/MatchUnit> <urn:rezics:search:public> .
<${unit}> <https://rezics.com/vocab/revision> <${revision}> <urn:rezics:search:public> .
<${unit}> <https://rezics.com/vocab/searchBody> "pre-erasure secret"@en <urn:rezics:search:public> .
NQ
java -Xmx1g -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar tdb2.tdbloader --loader=phased --loc=/fuseki/databases/rezics/tdb2 /fuseki/databases/custody-seed.nq`);
    await live.runner.start();
    await offlineTextIndex(live.runner);
    // The one cut includes an exact original suppression receipt. Its Content copy
    // still needs replay, so held proof reads exercise the historical tuple without
    // relying on a new native maintenance dispatch hook.
    const originalErasure = await journalErasure(relay, { operationId: randomUUID(), requestDigest: 'd3'.repeat(32),
      kind: 'revision', principalId: registered.principalId, admissionId: randomUUID(), authorityEpoch: '0',
      targets: [{ kind: 'content_revision', ref: originalSaved.revisionId }] });
    await suppressGraphContentRevisions(native, lineage, originalErasure.erasureId,
      originalErasure.erasureEpoch, [originalSaved.revisionId]);
    const originalProof = await readGraphErasureProof(native, lineage, originalErasure.erasureId,
      originalErasure.erasureEpoch, [originalSaved.revisionId]);
    await markErasureSuppressed(relay, originalErasure.erasureId);
    const consumer = `custody-restore:${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, lineage.dataEpoch);
    for (let batch = 0; batch < 32; batch++) {
      if (!await relayMainOutboxOnce(native, relay, consumer, { ownerOutbox: custody })) break;
      if (batch === 31) throw new Error('fixture relay drain exceeded its bound');
    }
    await fixture.close(); fixture = undefined;
    const fence = await engageAccessRecoveryFence(access);
    let coverage: RecoveryCoverage | undefined;
    for (let attempt = 0; attempt < 8 && !coverage; attempt++) {
      try { coverage = await captureGraphRecoveryCoverage(native, account, access, relay,
        consumer, content, { directory: objects.directory, workObjects: objects }); }
      catch (error) {
        if (!(error instanceof RestoreLineageConflict) || !error.message.includes('Account WAL frontier')
          || attempt === 7) throw error;
        await Bun.sleep(100);
      }
    }
    if (!coverage) throw new Error('fixture coverage unavailable');
    const capturedAccess = await accessStateTables(access);
    expect(capturedAccess.state).toEqual({ count: coverage.accessStateCount, digest: coverage.accessStateDigest });
    const recoveryKey = 'c8'.repeat(32);
    const authority = { sealedCoverage: JSON.stringify(sealRecoveryPayload(coverage, recoveryKey,
      'graph-recovery-coverage')), hmacKey: recoveryKey };
    await retainRecoveryCoverageHead(relay, authority.sealedCoverage, recoveryKey);
    await retainErasureCoverage(relay, consumer);
    const backup = {
      account: await databases.snapshot('account', () => close(account)),
      access: await databases.snapshot('access', () => close(access)),
      content: await databases.snapshot('content', () => close(content)),
    };
    cpSync(objects.directory, backupObjects, { recursive: true });
    live.runner.stop(); copyGraph(liveVolume, cutVolume); await live.runner.start();
    access = pool(databases.urls.access); content = pool(databases.urls.content);
    const manifest = JSON.parse(readFileSync(join(backupObjects, MODEL_MANIFEST_SHA256), 'utf8')) as {
      profiles: { sha256: string }[] };
    const shapeDigest = manifest.profiles[0]!.sha256;
    let cloneIndex = 0;
    const restore = async () => {
      const index = ++cloneIndex;
      const urls = {} as Record<keyof typeof backup, string>;
      for (const owner of ['account', 'access', 'content'] as const) {
        const name = `qa_custody_${suffix}_${owner}_${index}`;
        const template = new URL(backup[owner]).pathname.slice(1);
        if (!/^[a-z0-9_]+$/.test(template)) throw new Error('invalid fixture template');
        await admin(`CREATE DATABASE ${name} WITH TEMPLATE ${template} OWNER ${owner}`);
        copies.push(name); const url = new URL(backup[owner]); url.pathname = `/${name}`; urls[owner] = url.toString();
      }
      const restoredVolume = volume(`restore-${index}`); copyGraph(cutVolume, restoredVolume);
      const graph = await standaloneFuseki(qa.dockerEnv, { name: `rezics-custody-${suffix}-restore-${index}`,
        image: pinnedImage(), volume: restoredVolume, secrets: fusekiSecrets(qa.composeEnv) });
      containers.push(graph);
      const restoredDirectory = join(directory, `restored-objects-${index}`);
      cpSync(backupObjects, restoredDirectory, { recursive: true });
      const restoredObjects = new DirectoryObjects(restoredDirectory);
      const graphClient = new FusekiClient(graph.url, qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN,
        qa.composeEnv.FUSEKI_COMMAND_TOKEN);
      const restoredAccess = pool(urls.access);
      const restored: RestoredOwners = { account: pool(urls.account), access: restoredAccess, content: pool(urls.content),
        graph: { fuseki: graphClient, lineage,
          receiptCustody: new ReceiptCustody(new PostgresReceiptCustodyStore(restoredAccess), restoredObjects,
            graphClient, qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!, proofRetirementSender(graph.url,
              qa.composeEnv.FUSEKI_COMMAND_TOKEN!)) },
        objects: { directory: restoredDirectory, workObjects: restoredObjects } };
      // The sealed base cut is checked before any erasure replay changes its closure.
      if (!coverage?.objects || !coverage.content) throw new Error('fixture lacks retained owner coverage');
      await assertContentRecoveryCoverage(restored.content, graphClient, coverage.content);
      await assertObjectRecoveryCoverage(graphClient, restored.objects!, coverage.objects);
      const generation = await engageAccessRecoveryFence(restoredAccess);
      const registry = new AccessAdmissionRegistry(restoredAccess);
      const environment = { fuseki: graphClient, lineage, objectDirectory: restoredDirectory };
      const dependencies = { environment,
        account: { verify: async () => { throw new Error('held restore has no authentication server'); } }, access: registry };
      // A recovery owner stays quiesced until the outer outcome is durable.
      // Use the actual readiness routes without starting unrelated workers.
      const main = healthRoutes(graphClient, dependencies);
      const ready = () => main.handle(new Request('http://main.local/health/ready'));
      expect((await ready()).status).toBe(503);
      await expect(workRead(dependencies, new Request('http://main.local/v1/works'), {}, async () => 'private bytes'))
        .rejects.toBeInstanceOf(AdmissionUnavailable);
      expect((await new ContentCore(restored.content).readExactBatch([saved.revisionId!], async ids => new Set(ids)))[0]
        ?.status).toBe('available');
      return { restored, graph, restoredDirectory, generation, ready, environment, accessUrl: urls.access };
    };
    const withBorrowed = async <T>(restored: RestoredOwners,
      work: (clients: BorrowedRestoreClients) => Promise<T>, accessIsolation: 'read committed' | 'repeatable read' = 'read committed'): Promise<T> => {
      const relayClient = await relay.connect(), accessClient = await restored.access.connect();
      const transaction = async (client: PoolClient) => (await client.query<{ id: string }>(
        'SELECT txid_current()::text AS id')).rows[0]!.id;
      try {
        await relayClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await accessClient.query(`BEGIN ISOLATION LEVEL ${accessIsolation.toUpperCase()}`);
        await relayClient.query("SET LOCAL statement_timeout = '5s'");
        await accessClient.query("SET LOCAL statement_timeout = '5s'");
        const relayId = await transaction(relayClient), accessId = await transaction(accessClient);
        await relayClient.query('SAVEPOINT caller_relay');
        await accessClient.query('SAVEPOINT caller_access');
        const result = await work({ relayClient, accessClient });
        expect(await transaction(relayClient)).toBe(relayId);
        expect(await transaction(accessClient)).toBe(accessId);
        await relayClient.query('RELEASE SAVEPOINT caller_relay');
        await accessClient.query('RELEASE SAVEPOINT caller_access');
        await accessClient.query('COMMIT');
        await relayClient.query('COMMIT');
        return result;
      } catch (error) {
        await Promise.all([relayClient.query('ROLLBACK'), accessClient.query('ROLLBACK')]);
        throw error;
      } finally { accessClient.release(); relayClient.release(); }
    };
    const releaseHeldGraph = async (graph: RestoredGraphCustody, cut: HeldGraphErasureCut) => {
      // Exact existing restore-release family; the production outer owner supplies this callback.
      const receipt = `urn:rezics:receipt:restore-release:${hash(cut.dataEpoch)}`;
      const digest = hash(JSON.stringify({ family: 'restore-release-v2', lineage: graph.lineage,
        priorDataEpoch: cut.priorDataEpoch, priorSequence: cut.priorSequence,
        priorMainSequence: coverage!.relay.sequence, streamScope: 'urn:rezics:stream:main-rdf' }));
      expect((await graph.fuseki.commandWithReceipt({ receipt, digest, validations: [], deadlineMs: 10_000,
        update: `PREFIX rv: <${RV}>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        INSERT { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:requestDigest ${lit(digest)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(cut.dataEpoch)} ; rv:sequence 0 ;
          rv:priorMainSequence ${coverage!.relay.sequence} ;
          rv:streamScope "urn:rezics:stream:main-rdf" . } }
        WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(cut.dataEpoch)} ;
          rv:routingEpoch ${lit(cut.routingEpoch)} ; rv:sequence 0 ;
          rv:restoreCutover ${iri(cut.restoreCutover)} ; rv:restoreHold true .
          ${iri(cut.restoreCutover)} rv:priorDataEpoch ${lit(cut.priorDataEpoch)} ;
            rv:priorSequence ${cut.priorSequence} ;
            rv:priorMainSequence ${coverage!.relay.sequence} . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } } }` })).status).toBe('committed');
      expect((await graph.fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(cut.dataEpoch)} ; rv:sequence 0 .
          FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:requestDigest ${lit(digest)} ;
          rv:dataEpoch ${lit(cut.dataEpoch)} ; rv:sequence 0 ;
          rv:priorMainSequence ${coverage!.relay.sequence} ;
          rv:streamScope "urn:rezics:stream:main-rdf" . } }`)).boolean).toBe(true);
    };
    const assertDurableReconciliation = async (observer: Pool, id: string) => {
      const record = await observer.query<{ state: string; outcome_digest: string; completed: boolean }>(
        `SELECT state, outcome_digest, completed_at IS NOT NULL AS completed
         FROM relay.owner_reconciliation WHERE id = $1`, [id]);
      expect(record.rowCount).toBe(1);
      expect(record.rows[0]).toMatchObject({ state: 'reconciled', completed: true });
      expect(record.rows[0]!.outcome_digest).toMatch(/^[0-9a-f]{64}$/);
      expect((await observer.query(`SELECT owner FROM relay.owner_reconciliation_cut
        WHERE reconciliation_id = $1 AND status = 'matched' ORDER BY owner`, [id])).rows)
        .toEqual(['account', 'access', 'content', 'graph', 'object', 'relay'].sort().map(owner => ({ owner })));
    };
    const assertBothHeld = async (copy: Awaited<ReturnType<typeof restore>>, observer: Pool) => {
      expect((await observer.query(`SELECT open, generation::text AS generation
        FROM access.recovery_fence WHERE id = true`)).rows[0])
        .toEqual({ open: false, generation: copy.generation });
      expect((await copy.restored.graph!.fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)}
          rv:dataEpoch ${lit(copy.restored.graph!.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(copy.restored.graph!.lineage.routingEpoch)} ;
          rv:sequence 0 ; rv:restoreHold true . } }`)).boolean).toBe(true);
      expect((await copy.ready()).status).toBe(503);
    };
    const heldCopy = await restore();
    const next = { dataEpoch: randomUUID(), routingEpoch: /^(0|[1-9][0-9]*)$/.test(lineage.routingEpoch)
      ? String(BigInt(lineage.routingEpoch) + 1n) : randomUUID() };
    await cutoverRestoredGraphLineage(heldCopy.restored.graph!.fuseki,
      { prior: { ...lineage, sequence: coverage.priorSequence }, next });
    const heldGraph = heldCopy.restored.graph!;
    const cut = { ...next, restoreCutover: `urn:rezics:restore:${next.dataEpoch}`,
      priorDataEpoch: coverage.priorDataEpoch, priorSequence: coverage.priorSequence };
    heldGraph.lineage = next;
    heldCopy.environment.lineage = next;
    heldGraph.heldErasure = { cut, accessHoldGeneration: heldCopy.generation,
      signingKey: qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!,
      maintenance: heldErasureMaintenanceClient(heldCopy.graph.url, qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN!),
      originalSource: 'original-graph', originalGraph: { fuseki: native, lineage } };
    heldGraph.heldErasure.accessHoldGeneration = String(BigInt(heldCopy.generation) + 1n);
    await expect(withBorrowed(heldCopy.restored, clients => reconcileRestoredErasures(relay, heldCopy.restored,
      { operationId: randomUUID(), consumer, replay: true, authority }, clients)))
      .rejects.toThrow('restored Access recovery generation changed');
    heldGraph.heldErasure.accessHoldGeneration = heldCopy.generation;
    const capturedSequence = cut.priorSequence;
    cut.priorSequence = String(BigInt(capturedSequence) + 1n);
    await expect(withBorrowed(heldCopy.restored, clients => reconcileRestoredErasures(relay, heldCopy.restored,
      { operationId: randomUUID(), consumer, replay: true, authority }, clients)))
      .rejects.toThrow('captured Access generation or held graph cut changed');
    cut.priorSequence = capturedSequence;
    expect((await new ContentCore(heldCopy.restored.content).readExactBatch([originalSaved.revisionId],
      async ids => new Set(ids)))[0]?.status).toBe('available');
    await withBorrowed(heldCopy.restored, async clients => {
      const input = { operationId: randomUUID(), consumer, replay: true, authority };
      const result = await reconcileRestoredErasures(relay, heldCopy.restored, input, clients);
      expect(result.state).toBe('reconciled');
      expect(result.counts.replayed).toBe(1);
      expect(await readGraphErasureProof(heldGraph.fuseki, next, originalErasure.erasureId,
        originalErasure.erasureEpoch, [originalSaved.revisionId], { ...heldGraph.heldErasure!,
          revisionIds: [originalSaved.revisionId], original: originalProof })).toEqual(originalProof);
      expect(BigInt(originalProof.sequence)).toBeGreaterThan(0n);
      expect(originalProof.dataEpoch).toBe(lineage.dataEpoch);
      expect((await heldGraph.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ${lit(next.dataEpoch)} ; rv:sequence 0 ; rv:restoreHold true . } }`)).boolean).toBe(true);
      let callbacks = 0;
      await releaseErasureRestoreHold(relay, heldCopy.restored, result.reconciliationId,
        heldCopy.generation, authority, { clients, beforeAccessRelease: async () => {
          callbacks++;
          expect((await clients.accessClient.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open)
            .toBe(false);
          await releaseHeldGraph(heldGraph, cut);
        } });
      expect(callbacks).toBe(1);
      expect((await clients.accessClient.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(true);
    });
    expect((await new ContentCore(heldCopy.restored.content).readExactBatch([originalSaved.revisionId],
      async ids => new Set(ids)))[0]?.status).toBe('erased');
    heldCopy.graph.remove();
    await Promise.all([close(heldCopy.restored.account), close(heldCopy.restored.access), close(heldCopy.restored.content)]);

    const erase = await journalErasure(relay, { operationId: randomUUID(), requestDigest: 'e4'.repeat(32),
      kind: 'revision', principalId: registered.principalId, admissionId: randomUUID(), authorityEpoch: fence,
      targets: [{ kind: 'content_revision', ref: saved.revisionId }] });
    await suppressGraphContentRevisions(native, lineage, erase.erasureId, erase.erasureEpoch, [saved.revisionId]);
    const proof = await readGraphErasureProof(native, lineage, erase.erasureId, erase.erasureEpoch, [saved.revisionId]);
    await applyContentErasure(content, { erasureId: erase.erasureId, erasureEpoch: erase.erasureEpoch,
      resourceId: created.work, revisionIds: [saved.revisionId], graphProof: proof, preservationAccess: access });
    await markErasureSuppressed(relay, erase.erasureId);
    const backupLabel = `content:backup:custody:${suffix}`;
    await ensureRetentionDomain(relay, { label: backupLabel, owner: 'content', store: 'postgresql',
      custody: 'backup', expiresAt: new Date(Date.now() + 30 * 86_400_000) });
    await recordErasureInventory(relay, erase.erasureId, { owners: ['content'],
      liveRetentionReason: 'PostgreSQL prior rows and retained backup require separate retirement' });
    expect(await readErasure(relay, erase.erasureId)).toMatchObject({ suppression: 'suppressed', destruction: 'retained' });
    // Retain the actual post-cut native event before stopping its original graph.
    for (let batch = 0; batch < 8; batch++) {
      if (!await relayMainOutboxOnce(native, relay, consumer, { ownerOutbox: custody })) break;
      if (batch === 7) throw new Error('post-cut native relay drain exceeded its bound');
    }
    const retainedCopy = await restore(), retainedGraph = retainedCopy.restored.graph!;
    const retainedNext = { dataEpoch: randomUUID(), routingEpoch: /^(0|[1-9][0-9]*)$/.test(lineage.routingEpoch)
      ? String(BigInt(lineage.routingEpoch) + 1n) : randomUUID() };
    await cutoverRestoredGraphLineage(retainedGraph.fuseki,
      { prior: { ...lineage, sequence: coverage.priorSequence }, next: retainedNext });
    const retainedCut = { ...retainedNext, restoreCutover: `urn:rezics:restore:${retainedNext.dataEpoch}`,
      priorDataEpoch: coverage.priorDataEpoch, priorSequence: coverage.priorSequence };
    retainedGraph.lineage = retainedNext;
    retainedCopy.environment.lineage = retainedNext;
    const maintenance = heldErasureMaintenanceClient(retainedCopy.graph.url, qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN!);
    const nativeOutcomes: string[] = [];
    const nativePositions: { datasetId: string; dataEpoch: string; sequence: string }[] = [];
    let sends = 0, afterNativeOutcome: (() => Promise<void>) | undefined;
    retainedGraph.heldErasure = { cut: retainedCut, accessHoldGeneration: retainedCopy.generation,
      signingKey: qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!, originalSource: 'retained-native-event',
      maintenance: { command: async command => {
        sends++;
        const outcome = await maintenance.command(command);
        nativeOutcomes.push(outcome.status);
        if (outcome.status === 'committed') nativePositions.push(outcome.position);
        expect(outcome.status).toBe('committed');
        await afterNativeOutcome?.();
        return outcome;
      } } };
    const changeEvidence = async (client: PoolClient) => {
      const event = `urn:rezics:event:${hash(`${proof.receipt}\0event`)}`;
      const batch = `urn:rezics:outbox:${hash(`${proof.receipt}\0batch`)}`;
      expect((await client.query(`UPDATE relay.delivered_event
        SET envelope = jsonb_set(envelope, '{data,routingEpoch}', '"8"'::jsonb)
        WHERE stream_scope = 'urn:rezics:stream:main-rdf' AND source = 'https://rezics.com/services/main'
          AND event_id = $1`, [event])).rowCount).toBe(1);
      expect((await client.query(`UPDATE relay.delivered_batch SET routing_epoch = '8'
        WHERE stream_scope = 'urn:rezics:stream:main-rdf' AND batch_id = $1`, [batch])).rowCount).toBe(1);
    };
    live.runner.stop();
    const relayObserver = pool(databases.urls.relay), accessObserver = pool(retainedCopy.accessUrl);
    try {
      await expect(native.query('ASK {}', 1024)).rejects.toThrow();
      const retainedReconciliation = await withBorrowed(retainedCopy.restored, async clients => {
        const source = await readRetainedNativeGraphSuppressionProof(clients.relayClient,
          erase.erasureId, erase.erasureEpoch, [saved.revisionId]);
        expect(source.original).toEqual(proof);
        // A real proof read is interrupted by coherent retained-row corruption.
        // Only the fixture's caller mutates its own held transaction; HTTP results are unchanged.
        const read = retainedGraph.fuseki.query.bind(retainedGraph.fuseki);
        let changedBeforeSigning = false;
        await clients.relayClient.query('SAVEPOINT before_signing');
        retainedGraph.fuseki.query = async (query, limit) => {
          const result = await read(query, limit);
          if (!changedBeforeSigning && query.includes('SELECT ?graph ?subject ?predicate ?object')
            && query.includes(iri(proof.receipt))) {
            changedBeforeSigning = true;
            await changeEvidence(clients.relayClient);
          }
          return result;
        };
        try {
          const denied = await reconcileRestoredErasures(relay, retainedCopy.restored,
            { operationId: randomUUID(), consumer, replay: true, authority }, clients);
          expect(changedBeforeSigning).toBe(true);
          expect(denied.state).toBe('held');
          expect(sends).toBe(0);
          const changed = await readRetainedNativeGraphSuppressionProof(clients.relayClient,
            erase.erasureId, erase.erasureEpoch, [saved.revisionId]);
          expect(changed.original).toEqual(source.original);
          expect(changed.evidenceDigest).not.toBe(source.evidenceDigest);
          await expect(releaseErasureRestoreHold(relay, retainedCopy.restored, denied.reconciliationId,
            retainedCopy.generation, authority, { clients, beforeAccessRelease: async () => {
              throw new Error('changed evidence reached graph release');
            } })).rejects.toBeInstanceOf(ErasureRestoreHold);
        } finally {
          retainedGraph.fuseki.query = read;
          await clients.relayClient.query('ROLLBACK TO SAVEPOINT before_signing');
        }
        expect((await readRetainedNativeGraphSuppressionProof(clients.relayClient,
          erase.erasureId, erase.erasureEpoch, [saved.revisionId])).evidenceDigest).toBe(source.evidenceDigest);
        await clients.relayClient.query('SAVEPOINT after_outcome');
        afterNativeOutcome = () => changeEvidence(clients.relayClient);
        const deniedOutcome = await reconcileRestoredErasures(relay, retainedCopy.restored,
          { operationId: randomUUID(), consumer, replay: true, authority }, clients);
        expect(deniedOutcome.state).toBe('held');
        expect(sends).toBe(1);
        expect(nativeOutcomes).toEqual(['committed']);
        expect(nativePositions).toEqual([{ datasetId: DATASET, dataEpoch: retainedNext.dataEpoch, sequence: '0' }]);
        const changedOutcome = await readRetainedNativeGraphSuppressionProof(clients.relayClient,
          erase.erasureId, erase.erasureEpoch, [saved.revisionId]);
        expect(changedOutcome.original).toEqual(source.original);
        expect(changedOutcome.evidenceDigest).not.toBe(source.evidenceDigest);
        expect(await probeHeldGraphErasureProof(retainedGraph.fuseki, erase.erasureId,
          erase.erasureEpoch, [saved.revisionId], { ...retainedGraph.heldErasure!,
            revisionIds: [saved.revisionId], original: proof }, true)).toEqual(proof);
        expect((await clients.accessClient.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open)
          .toBe(false);
        afterNativeOutcome = undefined;
        await clients.relayClient.query('ROLLBACK TO SAVEPOINT after_outcome');
        const reconciled = await reconcileRestoredErasures(relay, retainedCopy.restored,
          { operationId: randomUUID(), consumer, replay: true, authority }, clients);
        expect(reconciled.state).toBe('reconciled');
        expect(sends).toBe(2);
        expect(nativeOutcomes).toEqual(['committed', 'committed']);
        expect(await readGraphErasureProof(retainedGraph.fuseki, retainedNext, erase.erasureId,
          erase.erasureEpoch, [saved.revisionId], { ...retainedGraph.heldErasure!,
            revisionIds: [saved.revisionId], original: proof })).toEqual(proof);
        await clients.relayClient.query('SAVEPOINT changed_release_evidence');
        let deniedReleaseCallbacks = 0;
        try {
          await changeEvidence(clients.relayClient);
          const changed = await readRetainedNativeGraphSuppressionProof(clients.relayClient,
            erase.erasureId, erase.erasureEpoch, [saved.revisionId]);
          expect(changed.original).toEqual(source.original);
          expect(changed.evidenceDigest).not.toBe(source.evidenceDigest);
          await expect(releaseErasureRestoreHold(relay, retainedCopy.restored, reconciled.reconciliationId,
            retainedCopy.generation, authority, { clients, beforeAccessRelease: async () => {
              deniedReleaseCallbacks++;
            } })).rejects.toThrow('prior reconciliation evidence differs from the current restore');
          expect(deniedReleaseCallbacks).toBe(0);
          expect((await clients.accessClient.query(`SELECT open, generation::text AS generation
            FROM access.recovery_fence WHERE id = true`)).rows[0])
            .toEqual({ open: false, generation: retainedCopy.generation });
          expect(sends).toBe(2);
        } finally { await clients.relayClient.query('ROLLBACK TO SAVEPOINT changed_release_evidence'); }
        expect((await readRetainedNativeGraphSuppressionProof(clients.relayClient,
          erase.erasureId, erase.erasureEpoch, [saved.revisionId])).evidenceDigest).toBe(source.evidenceDigest);
        return reconciled;
      });
      // Reconciliation is independently durable while graph and Access remain closed.
      await assertDurableReconciliation(relayObserver, retainedReconciliation.reconciliationId);
      await assertBothHeld(retainedCopy, accessObserver);
      // Retry reconstructs the same cut; object property order carries no authority.
      retainedGraph.heldErasure!.cut = { priorSequence: retainedCut.priorSequence,
        priorDataEpoch: retainedCut.priorDataEpoch, restoreCutover: retainedCut.restoreCutover,
        routingEpoch: retainedCut.routingEpoch, dataEpoch: retainedCut.dataEpoch };
      await withBorrowed(retainedCopy.restored, async clients => {
        let releases = 0;
        await releaseErasureRestoreHold(relay, retainedCopy.restored, retainedReconciliation.reconciliationId,
          retainedCopy.generation, authority, { clients, beforeAccessRelease: async () => {
            releases++;
            expect((await clients.accessClient.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open)
              .toBe(false);
            await releaseHeldGraph(retainedGraph, retainedCut);
          } });
        expect(releases).toBe(1);
        expect((await clients.accessClient.query('SELECT open FROM access.recovery_fence WHERE id')).rows[0].open).toBe(true);
      });
      expect((await new ContentCore(retainedCopy.restored.content).readExactBatch([saved.revisionId],
        async ids => new Set(ids)))[0]?.status).toBe('erased');

      // The same captured cut supplies an isolated, genuinely interrupted release.
      const interrupted = await restore(), interruptedGraph = interrupted.restored.graph!;
      const interruptedNext = { dataEpoch: randomUUID(), routingEpoch: retainedNext.routingEpoch };
      await cutoverRestoredGraphLineage(interruptedGraph.fuseki,
        { prior: { ...lineage, sequence: coverage.priorSequence }, next: interruptedNext });
      const interruptedCut = { ...interruptedNext, restoreCutover: `urn:rezics:restore:${interruptedNext.dataEpoch}`,
        priorDataEpoch: coverage.priorDataEpoch, priorSequence: coverage.priorSequence };
      interruptedGraph.lineage = interruptedNext;
      interrupted.environment.lineage = interruptedNext;
      const interruptedMaintenance = heldErasureMaintenanceClient(interrupted.graph.url,
        qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN!);
      const interruptedOutcomes: string[] = [];
      const interruptedPositions: { datasetId: string; dataEpoch: string; sequence: string }[] = [];
      let interruptedSends = 0;
      interruptedGraph.heldErasure = { cut: interruptedCut, accessHoldGeneration: interrupted.generation,
        signingKey: qa.composeEnv.FUSEKI_TITLE_ADMISSION_KEY!, originalSource: 'retained-native-event',
        maintenance: { command: async command => {
          interruptedSends++;
          const outcome = await interruptedMaintenance.command(command);
          interruptedOutcomes.push(outcome.status);
          if (outcome.status === 'committed') interruptedPositions.push(outcome.position);
          return outcome;
        } } };
      const interruptedObserver = pool(interrupted.accessUrl);
      try {
        const prior = await withBorrowed(interrupted.restored, clients => reconcileRestoredErasures(relay,
          interrupted.restored, { operationId: randomUUID(), consumer, replay: true, authority }, clients));
        expect(prior.state).toBe('reconciled');
        expect(interruptedSends).toBe(1);
        expect(interruptedOutcomes).toEqual(['committed']);
        expect(interruptedPositions).toEqual([{ datasetId: DATASET, dataEpoch: interruptedNext.dataEpoch, sequence: '0' }]);
        await assertDurableReconciliation(relayObserver, prior.reconciliationId);
        await assertBothHeld(interrupted, interruptedObserver);
        await interrupted.restored.access.query(`CREATE FUNCTION access.erasure_custody_release_interruption()
          RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF NOT OLD.open AND NEW.open THEN RAISE EXCEPTION 'fixture Access release interruption'; END IF;
          RETURN NEW; END $$`);
        try {
          await interrupted.restored.access.query(`CREATE TRIGGER erasure_custody_release_interruption
            BEFORE UPDATE OF open ON access.recovery_fence FOR EACH ROW
            EXECUTE FUNCTION access.erasure_custody_release_interruption()`);
          let committedGraphReleases = 0;
          await expect(withBorrowed(interrupted.restored, clients => releaseErasureRestoreHold(relay,
            interrupted.restored, prior.reconciliationId, interrupted.generation, authority,
            { clients, beforeAccessRelease: async () => {
              await releaseHeldGraph(interruptedGraph, interruptedCut);
              committedGraphReleases++;
            } }))).rejects.toThrow('fixture Access release interruption');
          // Every witness is outside the injected callback and aborted transactions.
          expect(committedGraphReleases).toBe(1);
          expect(interruptedSends).toBe(1);
          expect((await interruptedGraph.fuseki.query(`PREFIX rv: <${RV}> ASK {
            GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold ?hold } }`)).boolean).toBe(false);
          expect(await readGraphRecoverySource(interruptedGraph.fuseki)).toEqual({ ...interruptedNext,
            sequence: '0', relay: { streamScope: 'urn:rezics:stream:main-rdf',
              dataEpoch: interruptedNext.dataEpoch, sequence: '0' } });
          const receipt = `urn:rezics:receipt:restore-release:${hash(interruptedNext.dataEpoch)}`;
          const releaseDigest = hash(JSON.stringify({ family: 'restore-release-v2', lineage: interruptedNext,
            priorDataEpoch: interruptedCut.priorDataEpoch, priorSequence: interruptedCut.priorSequence,
            priorMainSequence: coverage.relay.sequence, streamScope: 'urn:rezics:stream:main-rdf' }));
          const facts = (await interruptedGraph.fuseki.query(`SELECT ?predicate ?object WHERE {
            GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?predicate ?object } } LIMIT 8`)).results?.bindings;
          expect(facts).toHaveLength(7);
          expect(Object.fromEntries(facts!.map(row => [row.predicate!.value, row.object!.value]))).toEqual({
            'http://www.w3.org/1999/02/22-rdf-syntax-ns#type': `${RV}OperationReceipt`,
            [`${RV}requestDigest`]: releaseDigest, [`${RV}datasetId`]: DATASET,
            [`${RV}dataEpoch`]: interruptedNext.dataEpoch, [`${RV}sequence`]: '0',
            [`${RV}priorMainSequence`]: coverage.relay.sequence,
            [`${RV}streamScope`]: 'urn:rezics:stream:main-rdf',
          });
          expect(facts!.every(row => row.predicate?.type === 'uri' && !row.object?.['xml:lang'])).toBe(true);
          for (const row of facts!) {
            const uri = ['http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${RV}datasetId`]
              .includes(row.predicate!.value);
            expect(row.object!.type).toBe(uri ? 'uri' : 'literal');
            if ([`${RV}sequence`, `${RV}priorMainSequence`].includes(row.predicate!.value)) {
              expect(row.object!.datatype).toBe('http://www.w3.org/2001/XMLSchema#integer');
            }
          }
          expect((await interruptedObserver.query(`SELECT open, generation::text AS generation
            FROM access.recovery_fence WHERE id = true`)).rows[0])
            .toEqual({ open: false, generation: interrupted.generation });
          expect((await interrupted.ready()).status).toBe(503);
          await assertDurableReconciliation(relayObserver, prior.reconciliationId);
        } finally {
          await interrupted.restored.access.query('DROP TRIGGER IF EXISTS erasure_custody_release_interruption ON access.recovery_fence');
          await interrupted.restored.access.query('DROP FUNCTION access.erasure_custody_release_interruption()');
        }
        // Without the durable caller's exact native expectation, retry stays closed.
        let retryCallbacks = 0;
        await expect(withBorrowed(interrupted.restored, clients => releaseErasureRestoreHold(relay,
          interrupted.restored, prior.reconciliationId, interrupted.generation, authority,
          { clients, beforeAccessRelease: async () => { retryCallbacks++; } })))
          .rejects.toThrow('captured Access generation or held graph cut changed');
        expect(retryCallbacks).toBe(0);
        expect(interruptedSends).toBe(1);
        expect(interruptedOutcomes).toEqual(['committed']);
        expect((await interruptedObserver.query(`SELECT open, generation::text AS generation
          FROM access.recovery_fence WHERE id = true`)).rows[0])
          .toEqual({ open: false, generation: interrupted.generation });
        expect((await interrupted.ready()).status).toBe(503);
        await assertDurableReconciliation(relayObserver, prior.reconciliationId);
        const main = { streamScope: coverage.relay.streamScope, dataEpoch: coverage.relay.dataEpoch,
          sequence: coverage.relay.sequence };
        const graphRelease: RestoredGraphReleaseExpectation = { lineage: interruptedNext,
          restoreCutover: interruptedCut.restoreCutover,
          saved: { dataEpoch: interruptedCut.priorDataEpoch, graphSequence: interruptedCut.priorSequence, main },
          effective: { dataEpoch: coverage.priorDataEpoch, graphSequence: coverage.priorSequence, main } };
        expect(await readRestoredGraphReleaseProof(interruptedGraph.fuseki, graphRelease))
          .toMatchObject({ receipt: { dataEpoch: interruptedNext.dataEpoch, sequence: '0' } });
        // Every denial leaves the native effect committed and Access captured/closed.
        await withBorrowed(interrupted.restored, async clients => {
          const options = { clients, graphRelease, beforeAccessRelease: async () => { retryCallbacks++; } };
          await expect(releaseErasureRestoreHold(relay, interrupted.restored, randomUUID(),
            interrupted.generation, authority, options)).rejects.toThrow('restore is not reconciled');
          await expect(releaseErasureRestoreHold(relay, interrupted.restored, prior.reconciliationId,
            String(BigInt(interrupted.generation) + 1n), authority, options))
            .rejects.toThrow('captured erasure generation');
          await expect(releaseErasureRestoreHold(relay, interrupted.restored, prior.reconciliationId,
            interrupted.generation, authority, { ...options, graphRelease: { ...graphRelease,
              saved: { ...graphRelease.saved, graphSequence: String(BigInt(interruptedCut.priorSequence) + 1n) } } }))
            .rejects.toThrow('expectation differs from the captured restore');
          for (const corruption of ['authority', 'journal', 'record', 'source'] as const) {
            await clients.relayClient.query('SAVEPOINT released_denial');
            try {
              if (corruption === 'authority') await clients.relayClient.query(`UPDATE relay.current_authority_coverage
                SET coverage_generation = coverage_generation + 1 WHERE id = true`);
              if (corruption === 'journal' || corruption === 'record') {
                const table = corruption === 'journal' ? 'erasure' : 'owner_reconciliation';
                await clients.relayClient.query(`ALTER TABLE relay.${table} DISABLE TRIGGER USER`);
                if (corruption === 'journal') await clients.relayClient.query(`UPDATE relay.erasure
                  SET request_digest = $2 WHERE id = $1`, [erase.erasureId, 'b'.repeat(64)]);
                else await clients.relayClient.query(`UPDATE relay.owner_reconciliation
                  SET outcome_digest = $2 WHERE id = $1`, [prior.reconciliationId, 'b'.repeat(64)]);
                await clients.relayClient.query(`ALTER TABLE relay.${table} ENABLE TRIGGER USER`);
              }
              if (corruption === 'source') await changeEvidence(clients.relayClient);
              await expect(releaseErasureRestoreHold(relay, interrupted.restored, prior.reconciliationId,
                interrupted.generation, authority, options)).rejects.toBeInstanceOf(ErasureRestoreHold);
            } finally { await clients.relayClient.query('ROLLBACK TO SAVEPOINT released_denial'); }
          }
        });
        expect(retryCallbacks).toBe(0);
        expect((await interruptedObserver.query(`SELECT open, generation::text AS generation
          FROM access.recovery_fence WHERE id = true`)).rows[0])
          .toEqual({ open: false, generation: interrupted.generation });
        expect((await interrupted.ready()).status).toBe(503);
        const retainedShape = readFileSync(join(interrupted.restoredDirectory, shapeDigest));
        unlinkSync(join(interrupted.restoredDirectory, shapeDigest));
        try {
          await expect(withBorrowed(interrupted.restored, clients => releaseErasureRestoreHold(relay,
            interrupted.restored, prior.reconciliationId, interrupted.generation, authority,
            { clients, graphRelease }))).rejects.toThrow('custody is unavailable or divergent');
        } finally { writeFileSync(join(interrupted.restoredDirectory, shapeDigest), retainedShape); }
        await withBorrowed(interrupted.restored, async clients => {
          await clients.accessClient.query("INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1::uuid,'https://changed-authority.test',$1::uuid::text)",
            [randomUUID()]);
          await expect(releaseErasureRestoreHold(relay, interrupted.restored, prior.reconciliationId,
            interrupted.generation, authority, { clients, graphRelease })).rejects.toThrow('current retained authority');
          await clients.accessClient.query('ROLLBACK TO SAVEPOINT caller_access');
        });
        expect(await accessStateTables(interrupted.restored.access)).toEqual(capturedAccess);
        await withBorrowed(interrupted.restored, clients => releaseErasureRestoreHold(relay,
          interrupted.restored, prior.reconciliationId, interrupted.generation, authority,
          { clients: { ...clients, graphRelease }, beforeAccessRelease: async () => { retryCallbacks++; } }));
        const releasedGeneration = String(BigInt(interrupted.generation) + 1n);
        expect((await interruptedObserver.query(`SELECT open, generation::text AS generation
          FROM access.recovery_fence WHERE id = true`)).rows[0])
          .toEqual({ open: true, generation: releasedGeneration });
        expect((await interrupted.ready()).status).toBe(200);
        expect(retryCallbacks).toBe(0);
        expect(interruptedSends).toBe(1);
        expect(interruptedOutcomes).toEqual(['committed']);
        await assertDurableReconciliation(relayObserver, prior.reconciliationId);
        await expect(withBorrowed(interrupted.restored, clients => releaseErasureRestoreHold(relay,
          interrupted.restored, prior.reconciliationId, interrupted.generation, authority,
          { clients, graphRelease }), 'repeatable read')).rejects.toThrow('fresh READ COMMITTED view');
        // The actual CAS appends derived invalidations. A caller needs durable
        // post-CAS authority evidence before an interrupted outer outcome can
        // complete; the original signed row digest cannot excuse these changes.
        const completedAccess = await accessStateTables(interrupted.restored.access);
        const invalidations = ['access.also_enjoyed_source_change', 'access.discovery_source_change'];
        expect(completedAccess.catalogDigest).toBe(capturedAccess.catalogDigest);
        expect(completedAccess.excluded).toEqual(capturedAccess.excluded);
        for (const table of invalidations) expect(completedAccess.tables[table]!.count)
          .toBe(String(BigInt(capturedAccess.tables[table]!.count) + 1n));
        expect(Object.fromEntries(Object.entries(completedAccess.tables).filter(([table]) => !invalidations.includes(table))))
          .toEqual(Object.fromEntries(Object.entries(capturedAccess.tables).filter(([table]) => !invalidations.includes(table))));
        // The denial remains read-only at captured+1; this trigger rejects CAS.
        await interrupted.restored.access.query(`CREATE FUNCTION access.erasure_custody_no_second_release()
          RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'already released Access must not be updated'; END $$`);
        try {
          await interrupted.restored.access.query(`CREATE TRIGGER erasure_custody_no_second_release
            BEFORE UPDATE ON access.recovery_fence FOR EACH ROW
            EXECUTE FUNCTION access.erasure_custody_no_second_release()`);
          await expect(withBorrowed(interrupted.restored, clients => releaseErasureRestoreHold(relay,
            interrupted.restored, prior.reconciliationId, interrupted.generation, authority,
            { clients, graphRelease, beforeAccessRelease: async () => { retryCallbacks++; } })))
            .rejects.toThrow('current retained authority');
        } finally {
          await interrupted.restored.access.query('DROP TRIGGER IF EXISTS erasure_custody_no_second_release ON access.recovery_fence');
          await interrupted.restored.access.query('DROP FUNCTION access.erasure_custody_no_second_release()');
        }
        expect(retryCallbacks).toBe(0);
        expect(interruptedSends).toBe(1);
        expect((await interruptedObserver.query(`SELECT open, generation::text AS generation
          FROM access.recovery_fence WHERE id = true`)).rows[0])
          .toEqual({ open: true, generation: releasedGeneration });
        expect(await readRestoredGraphReleaseProof(interruptedGraph.fuseki, graphRelease)).not.toBeNull();
        await assertDurableReconciliation(relayObserver, prior.reconciliationId);
      } finally {
        interrupted.graph.remove();
        await Promise.all([close(interruptedObserver), close(interrupted.restored.account),
          close(interrupted.restored.access), close(interrupted.restored.content)]);
      }
    } finally {
      await live.runner.start();
      retainedCopy.graph.remove();
      await Promise.all([close(relayObserver), close(accessObserver), close(retainedCopy.restored.account), close(retainedCopy.restored.access),
        close(retainedCopy.restored.content)]);
    }
    // Every negative is an isolated copy of the same held, consistent pre-erasure cut.
    for (const missing of [MODEL_MANIFEST_SHA256, shapeDigest, retainedCommand.payload_sha256]) {
      const copy = await restore();
      unlinkSync(join(copy.restoredDirectory, missing));
      const held = await reconcileRestoredErasures(relay, copy.restored, { operationId: randomUUID(),
        consumer, replay: true, authority });
      expect(held.state).toBe('held');
      await expect(releaseErasureRestoreHold(relay, copy.restored, held.reconciliationId, copy.generation, authority))
        .rejects.toBeInstanceOf(ErasureRestoreHold);
      expect((await copy.ready()).status).toBe(503);
      copy.graph.remove();
      await Promise.all([close(copy.restored.account), close(copy.restored.access), close(copy.restored.content)]);
    }
    const corrupt = await restore();
    writeFileSync(join(corrupt.restoredDirectory, shapeDigest), 'divergent legacy shape');
    expect((await reconcileRestoredErasures(relay, corrupt.restored, { operationId: randomUUID(),
      consumer, replay: true, authority })).state).toBe('held');
    corrupt.graph.remove();
    await Promise.all([close(corrupt.restored.account), close(corrupt.restored.access), close(corrupt.restored.content)]);

    const good = await restore();
    const unreplayed = await reconcileRestoredErasures(relay, good.restored, { operationId: randomUUID(),
      consumer, replay: false, authority });
    expect(unreplayed.state).toBe('held');
    const borrowed = <T>(work: (clients: BorrowedRestoreClients) => Promise<T>) => withBorrowed(good.restored, work);
    const operationId = randomUUID();
    const reconciled = await borrowed(clients => reconcileRestoredErasures(relay, good.restored, { operationId,
      consumer, replay: true, authority }, clients));
    expect(reconciled).toMatchObject({ state: 'reconciled', counts: { replayed: 3, matched: 7 } });
    expect(await borrowed(clients => reconcileRestoredErasures(relay, good.restored,
      { operationId, consumer, replay: true, authority }, clients)))
      .toEqual(reconciled);
    expect((await relay.query<{ operation_id: string }>(
      'SELECT operation_id FROM relay.owner_reconciliation WHERE id = $1', [reconciled.reconciliationId]))
      .rows[0]?.operation_id).toBe(`${operationId}:erasures`);
    expect(await graphErasureSuppressed(good.restored.graph!.fuseki, erase.erasureId, erase.erasureEpoch,
      [saved.revisionId])).toBe(true);
    expect((await new ContentCore(good.restored.content).readExactBatch([saved.revisionId], async ids => new Set(ids)))[0]
      ?.status).toBe('erased');
    expect((await good.ready()).status).toBe(503);
    // A new retained erasure invalidates the earlier reconciliation, even after its targets were replayed.
    const later = await journalErasure(relay, { operationId: randomUUID(), requestDigest: 'f5'.repeat(32),
      kind: 'revision', principalId: registered.principalId, admissionId: randomUUID(), authorityEpoch: fence,
      targets: [{ kind: 'content_revision', ref: laterSaved.revisionId }] });
    await suppressGraphContentRevisions(native, lineage, later.erasureId, later.erasureEpoch, [laterSaved.revisionId]);
    await applyContentErasure(content, { erasureId: later.erasureId, erasureEpoch: later.erasureEpoch,
      resourceId: created.work, revisionIds: [laterSaved.revisionId], preservationAccess: access });
    await markErasureSuppressed(relay, later.erasureId);
    await expect(borrowed(clients => releaseErasureRestoreHold(relay, good.restored, reconciled.reconciliationId,
      good.generation, authority, { clients, beforeAccessRelease: async () => {
        throw new Error('a stale journal must veto graph release');
      } }))).rejects.toThrow('a newer retained frontier needs reconciliation');
    const current = await borrowed(clients => reconcileRestoredErasures(relay, good.restored,
      { operationId: randomUUID(), consumer, replay: true, authority }, clients));
    expect(current.state).toBe('reconciled');
    // Cached reconciliation cannot excuse loss of exact command/model custody at release.
    for (const digest of originalRoots) {
      unlinkSync(join(good.restoredDirectory, digest));
      await expect(borrowed(clients => releaseErasureRestoreHold(relay, good.restored, current.reconciliationId,
        good.generation, authority, { clients, beforeAccessRelease: async () => {
          throw new Error('missing original custody must veto graph release');
        } }))).rejects.toBeInstanceOf(ErasureRestoreHold);
      writeFileSync(join(good.restoredDirectory, digest), readFileSync(join(backupObjects, digest)));
      writeFileSync(join(good.restoredDirectory, digest), 'corrupt retained original');
      await expect(borrowed(clients => releaseErasureRestoreHold(relay, good.restored, current.reconciliationId,
        good.generation, authority, { clients, beforeAccessRelease: async () => {
          throw new Error('corrupt original custody must veto graph release');
        } }))).rejects.toBeInstanceOf(ErasureRestoreHold);
      writeFileSync(join(good.restoredDirectory, digest), readFileSync(join(backupObjects, digest)));
    }
    // Object erasures cannot delete verified retired command, manifest, payload or selected shape roots.
    await borrowed(async clients => {
      for (const digest of originalRoots) {
        await clients.relayClient.query('SAVEPOINT protected_original');
        const aliasId = randomUUID();
        await clients.relayClient.query(`INSERT INTO relay.erasure (id, erasure_epoch, operation_id, request_digest,
          kind, authority, principal_id, admission_id, authority_epoch, suppression_status, suppressed_at)
          VALUES ($1::uuid, relay.next_erasure_epoch(), $1::text, $2, 'revision', 'access_admission',
            $3, $4, $5, 'suppressed', clock_timestamp())`,
        [aliasId, 'a3'.repeat(32), registered.principalId, randomUUID(), fence]);
        await clients.relayClient.query(`INSERT INTO relay.erasure_target
          (erasure_id, ordinal, owner, target_kind, target_ref) VALUES ($1, 1, 'object', 'object', $2)`,
        [aliasId, `sha256:${digest}`]);
        const alias = await reconcileRestoredErasures(relay, good.restored,
          { operationId: randomUUID(), consumer, replay: true, authority }, clients);
        expect(alias.state).toBe('held');
        expect(alias.counts.conflict).toBeGreaterThan(0);
        expect(readFileSync(join(good.restoredDirectory, digest)))
          .toEqual(readFileSync(join(backupObjects, digest)));
        await clients.relayClient.query('ROLLBACK TO SAVEPOINT protected_original');
        await clients.relayClient.query('RELEASE SAVEPOINT protected_original');
      }
    });
    let releaseCalls = 0;
    await borrowed(clients => releaseErasureRestoreHold(relay, good.restored, current.reconciliationId,
      good.generation, authority, { clients, beforeAccessRelease: async () => {
        releaseCalls++;
        expect((await clients.accessClient.query<{ open: boolean }>(
          'SELECT open FROM access.recovery_fence WHERE id = true')).rows[0]?.open).toBe(false);
      } }));
    expect(releaseCalls).toBe(1);
    expect((await good.ready()).status).toBe(200);
    expect((await good.restored.access.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true')).rows[0]?.open).toBe(true);
    expect(readFileSync(join(backupObjects, MODEL_MANIFEST_SHA256))).toEqual(readFileSync(join(objects.directory,
      MODEL_MANIFEST_SHA256)));
    // The retained cut still contains the body; suppression never claims destruction of this backup.
    const retainedContent = pool(backup.content);
    expect((await new ContentCore(retainedContent).readExactBatch([saved.revisionId], async ids => new Set(ids)))[0]
      ?.status).toBe('available');
    expect((await readErasure(relay, erase.erasureId)).dispositions.find(copy => copy.domain === backupLabel))
      .toMatchObject({ destruction: 'retained', evidenceDigest: null });
    expect(Date.now() - preparation).toBeLessThan(600_000);
    expect(ACTIVE_GENERATION).toBe(`urn:rezics:model-generation:${MODEL_MANIFEST_SHA256}`);
  } finally {
    await fixture?.close();
    for (const container of containers) container.remove();
    await Promise.allSettled([...pools].map(value => value.end()));
    for (const name of copies.reverse()) await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await databases.close();
    for (const name of volumes) spawnSync('docker', ['volume', 'rm', '-f', name], { env: qa.dockerEnv, timeout: 30_000 });
    rmSync(directory, { recursive: true, force: true });
  }
}, 420_000);
