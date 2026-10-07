import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from
  '../../../services/main/src/infrastructure/immutable-objects.ts';
import { AccessAdmissionRegistry, AdmissionUnavailable, engageAccessRecoveryFence } from
  '../../../services/main/src/modules/access/admission.ts';
import { applyContentErasure } from '../../../services/main/src/modules/erasure/content.ts';
import { graphErasureSuppressed, readGraphErasureProof, suppressGraphContentRevisions } from
  '../../../services/main/src/modules/erasure/graph.ts';
import { ensureRetentionDomain, journalErasure, markErasureSuppressed, readErasure,
  recordErasureInventory } from '../../../services/main/src/modules/erasure/journal.ts';
import { ErasureRestoreHold, reconcileRestoredErasures, releaseErasureRestoreHold,
  retainErasureCoverage, type RestoredOwners } from '../../../services/main/src/modules/erasure/reconcile.ts';
import { PostgresReceiptCustodyStore, ReceiptCustody } from
  '../../../services/main/src/modules/outbox/receipt-custody.ts';
import { assertObjectRecoveryCoverage } from '../../../services/main/src/modules/owner/object-coverage.ts';
import { proofRetirementSender } from '../../../services/main/src/modules/graph/slim-command.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { ACTIVE_GENERATION, ensureModelGeneration, MODEL_MANIFEST_SHA256 } from
  '../../../services/main/src/modules/semantic/command.ts';
import { hash, initializeFreshGraph, type WorkActivationEnvironment } from
  '../../../services/main/src/modules/work/activate.ts';
import { commitMetadata, readMetadataReceipt } from '../../../services/main/src/modules/work/metadata-command.ts';
import { checkedMetadataState, metadataDigest, type MetadataIntent } from
  '../../../services/main/src/modules/work/metadata-schema.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { captureGraphRecoveryCoverage, RestoreLineageConflict, type RecoveryCoverage } from
  '../../../services/main/src/modules/work/restore-lineage.ts';
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
  const pool = (url: string) => { const value = new Pool({ connectionString: url, max: 2 });
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
      if (!coverage?.objects) throw new Error('fixture lacks retained object coverage');
      await assertObjectRecoveryCoverage(graphClient, restored.objects!, coverage.objects);
      const generation = await engageAccessRecoveryFence(restoredAccess);
      const registry = new AccessAdmissionRegistry(restoredAccess);
      const dependencies = { environment: { fuseki: graphClient, lineage, objectDirectory: restoredDirectory },
        account: { verify: async () => { throw new Error('held restore has no authentication server'); } }, access: registry };
      const main = createMainApp(graphClient, dependencies);
      const ready = () => main.handle(new Request('http://main.local/health/ready'));
      expect((await ready()).status).toBe(503);
      await expect(workRead(dependencies, new Request('http://main.local/v1/works'), {}, async () => 'private bytes'))
        .rejects.toBeInstanceOf(AdmissionUnavailable);
      expect((await new ContentCore(restored.content).readExactBatch([saved.revisionId!], async ids => new Set(ids)))[0]
        ?.status).toBe('available');
      return { restored, graph, restoredDirectory, generation, ready };
    };
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
    const operationId = randomUUID();
    const reconciled = await reconcileRestoredErasures(relay, good.restored, { operationId,
      consumer, replay: true, authority });
    expect(reconciled).toMatchObject({ state: 'reconciled', counts: { replayed: 2, matched: 3 } });
    expect(await reconcileRestoredErasures(relay, good.restored, { operationId, consumer, replay: true, authority }))
      .toEqual(reconciled);
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
    await expect(releaseErasureRestoreHold(relay, good.restored, reconciled.reconciliationId,
      good.generation, authority)).rejects.toThrow('a newer retained frontier needs reconciliation');
    const current = await reconcileRestoredErasures(relay, good.restored, { operationId: randomUUID(),
      consumer, replay: true, authority });
    expect(current.state).toBe('reconciled');
    // Cached reconciliation cannot excuse loss of exact command/model custody at release.
    for (const digest of [shapeDigest, retainedCommand.payload_sha256]) {
      unlinkSync(join(good.restoredDirectory, digest));
      await expect(releaseErasureRestoreHold(relay, good.restored, current.reconciliationId,
        good.generation, authority)).rejects.toBeInstanceOf(ErasureRestoreHold);
      writeFileSync(join(good.restoredDirectory, digest), readFileSync(join(backupObjects, digest)));
    }
    await releaseErasureRestoreHold(relay, good.restored, current.reconciliationId, good.generation, authority);
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
