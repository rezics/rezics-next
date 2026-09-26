import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { ContentCore } from '../../../services/content/src/core.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { engageAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { applyContentErasure } from '../../../services/main/src/modules/erasure/content.ts';
import { graphErasureSuppressed, suppressGraphContentRevisions }
  from '../../../services/main/src/modules/erasure/graph.ts';
import { markErasureSuppressed, journalErasure } from '../../../services/main/src/modules/erasure/journal.ts';
import { ErasureRestoreHold, reconcileRestoredErasures, releaseErasureRestoreHold,
  retainErasureCoverage } from '../../../services/main/src/modules/erasure/reconcile.ts';
import { initializeFreshGraph, prepareComponent, type GraphLineage }
  from '../../../services/main/src/modules/work/activate.ts';
import { captureGraphRecoveryCoverage, RestoreLineageConflict,
  type RecoveryCoverage } from '../../../services/main/src/modules/work/restore-lineage.ts';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { sealRecoveryPayload } from '../../../services/account/src/recovery-envelope.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import { offlineTextIndex } from '../../../scripts/operations/search-state.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';
import { ratingAccount } from '../support/rating-account.ts';
import { fusekiSecrets, pinnedImage, qaStack, standaloneFuseki }
  from './search-ops-support.ts';

const root = resolve(import.meta.dir, '../../..');
const recoveryKey = 'd7'.repeat(32);

test('SYS07: older Account, Access, Content, graph and object copies replay without resurrection', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  const dataEpoch = Bun.env.MAIN_DATA_EPOCH;
  const routingEpoch = Bun.env.MAIN_ROUTING_EPOCH;
  if (!runId || !dataEpoch || !routingEpoch || !Bun.env.FUSEKI_URL
    || !Bun.env.FUSEKI_MAINTENANCE_TOKEN || !Bun.env.FUSEKI_COMMAND_TOKEN) {
    throw new Error('Run through the isolated fault/recovery QA tier');
  }

  const databases = await cloneQaOwnerDatabases(runId, ['account', 'access', 'content', 'relay']);
  const qa = qaStack(runId);
  const stack = join(root, '.temp', 'stack', `rezics-qa-${runId}`);
  const apps = readEnv(join(stack, 'apps.env'));
  const account = await ratingAccount({ ...apps, ACCOUNT_DATABASE_URL: databases.urls.account },
    'openid access:manage');
  let accountClosed = false;
  const closeAccount = async () => {
    if (!accountClosed) {
      accountClosed = true;
      await account.close();
    }
  };
  const accountPool = new Pool({ connectionString: databases.urls.account, max: 2 });
  let access = new Pool({ connectionString: databases.urls.access, max: 2 });
  let contentPool = new Pool({ connectionString: databases.urls.content, max: 2 });
  const relay = new Pool({ connectionString: databases.urls.relay, max: 2 });
  const pools = new Set<Pool>([accountPool, access, contentPool, relay]);
  const temporary = join(root, '.temp', `sys-erasure-replay-${randomUUID()}`);
  const objects = join(temporary, 'objects');
  const restoredObjects = join(temporary, 'restored-objects');
  mkdirSync(objects, { recursive: true, mode: 0o700 });
  const lineage: GraphLineage = { dataEpoch, routingEpoch };
  const consumer = `sys07-${randomUUID()}`;
  const graphVolume = `rezics-sys07-${randomUUID().slice(0, 12)}`;
  const liveVolume = `rezics-sys07-live-${randomUUID().slice(0, 12)}`;
  const candidateName = `rezics-sys07-${randomUUID().slice(0, 12)}`;
  const liveName = `rezics-sys07-live-${randomUUID().slice(0, 12)}`;
  let live: Awaited<ReturnType<typeof standaloneFuseki>> | undefined;
  let candidate: Awaited<ReturnType<typeof standaloneFuseki>> | undefined;
  try {
    for (const name of [liveVolume, graphVolume]) {
      const volume = spawnSync('docker', ['volume', 'create', name], {
        env: qa.dockerEnv, encoding: 'utf8', timeout: 30_000 });
      if (volume.status !== 0) throw new Error(`cannot create isolated graph copy: ${volume.stderr}`);
    }
    live = await standaloneFuseki(qa.dockerEnv, {
      name: liveName, image: pinnedImage(), volume: liveVolume,
      secrets: fusekiSecrets(qa.composeEnv),
    });
    const fuseki = new FusekiClient(live.url,
      qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN, qa.composeEnv.FUSEKI_COMMAND_TOKEN);
    await migrateContent(contentPool);
    const resourceId = `https://rezics.com/id/${randomUUID()}`;
    const saved = await new ContentCore(contentPool).saveDraft({
      operationId: `sys07-before-erasure-${randomUUID()}`,
      variant: { id: `urn:rezics:variant:${randomUUID()}`,
        resourceId,
        language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
      expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
      provenance: { fixture: 'sys07-erasure-replay' },
      serializedJson: JSON.stringify({ body: 'older Content copy' }),
    });
    if (saved.outcome !== 'succeeded' || !saved.revisionId) {
      throw new Error('Content owner did not save the pre-erasure revision');
    }
    const revision = `urn:rezics:content:revision:${saved.revisionId}`;
    const unit = `urn:rezics:content:match-unit:${randomUUID()}`;
    const retainedUnit = `urn:rezics:content:match-unit:${randomUUID()}`;
    const retainedComponent = `urn:rezics:work:${randomUUID()}`;
    const objectBytes = Buffer.from('SYS07 private object from the older copy');
    const objectDigest = createHash('sha256').update(objectBytes).digest('hex');
    writeFileSync(join(objects, objectDigest), objectBytes, { mode: 0o600, flag: 'wx' });
    const retainedManifest = prepareComponent(objects, retainedComponent,
      { title: 'unrelated retained object' });

    await initializeFreshGraph(fuseki, lineage);
    live.runner.stop();
    live.runner.offline(`cat > /fuseki/databases/sys07-seed.nq <<'NQ'
<${unit}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://rezics.com/vocab/MatchUnit> <urn:rezics:search:public> .
<${unit}> <https://rezics.com/vocab/revision> <${revision}> <urn:rezics:search:public> .
<${unit}> <https://rezics.com/vocab/searchBody> "older forbidden lighthouse"@en <urn:rezics:search:public> .
<${retainedUnit}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://rezics.com/vocab/MatchUnit> <urn:rezics:search:public> .
<${retainedUnit}> <https://rezics.com/vocab/searchBody> "retained lighthouse"@en <urn:rezics:search:public> .
<${retainedComponent}> <https://rezics.com/vocab/manifest> <urn:rezics:sha256:${retainedManifest}> <urn:rezics:graph:revisions> .
NQ
java -Xmx2g -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar \
  tdb2.tdbloader --loader=phased --loc=/fuseki/databases/rezics/tdb2 \
  /fuseki/databases/sys07-seed.nq`);
    await live.runner.start();
    await offlineTextIndex(live.runner);
    await initializeRelayCheckpoint(relay, consumer, dataEpoch);
    const fence = await engageAccessRecoveryFence(access);
    await closeAccount();
    let coverage: RecoveryCoverage | undefined;
    for (let attempt = 0; attempt < 8 && !coverage; attempt++) {
      try { coverage = await captureGraphRecoveryCoverage(fuseki, accountPool, access, relay,
        consumer, contentPool, { directory: objects }); }
      catch (error) {
        if (!(error instanceof RestoreLineageConflict)
          || !error.message.includes('Account WAL frontier') || attempt === 7) throw error;
        await Bun.sleep(100);
      }
    }
    if (!coverage) throw new Error('stable recovery coverage was not captured');
    const sealedCoverage = JSON.stringify(sealRecoveryPayload(coverage,
      recoveryKey, 'graph-recovery-coverage'));
    await retainRecoveryCoverageHead(relay, sealedCoverage, recoveryKey);
    await retainErasureCoverage(relay, consumer);

    const accountBackup = await databases.snapshot('account', async () => {
      await closeAccount();
      await accountPool.end();
      pools.delete(accountPool);
    });
    const accessBackup = await databases.snapshot('access', async () => {
      await access.end();
      pools.delete(access);
    });
    const contentBackup = await databases.snapshot('content', async () => {
      await contentPool.end();
      pools.delete(contentPool);
    });
    cpSync(objects, restoredObjects, { recursive: true });
    live.runner.stop();
    const copied = spawnSync('docker', ['run', '--rm', '--network', 'none', '--user', '0:0',
      '--volume', `${liveVolume}:/from:ro`, '--volume', `${graphVolume}:/to`,
      '--entrypoint', 'sh', pinnedImage(), '-ec',
      'rm -rf /to/rezics && cp -a /from/rezics /to/rezics'],
    { env: qa.dockerEnv, encoding: 'utf8', timeout: 30_000 });
    if (copied.status !== 0) throw new Error(`older graph copy failed: ${copied.stderr}`);
    await live.runner.start();
    candidate = await standaloneFuseki(qa.dockerEnv, {
      name: candidateName, image: pinnedImage(), volume: graphVolume,
      secrets: fusekiSecrets(qa.composeEnv),
    }).catch(error => {
      const logs = spawnSync('docker', ['logs', candidateName], {
        env: qa.dockerEnv, encoding: 'utf8', timeout: 10_000 });
      throw new Error(`${String(error)}: ${(logs.stderr ?? '').slice(-2000)}`);
    });
    const oldGraph = new FusekiClient(candidate.url,
      qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN, qa.composeEnv.FUSEKI_COMMAND_TOKEN);

    contentPool = new Pool({ connectionString: databases.urls.content, max: 2 });
    pools.add(contentPool);
    const intent = await journalErasure(relay, {
      operationId: `sys07-erase-${randomUUID()}`,
      requestDigest: 'a'.repeat(64), kind: 'revision',
      principalId: randomUUID(), admissionId: randomUUID(), authorityEpoch: fence,
      targets: [
        { kind: 'content_revision', ref: saved.revisionId },
        { kind: 'object', ref: `sha256:${objectDigest}` },
      ],
    });
    await suppressGraphContentRevisions(fuseki, lineage, intent.erasureId,
      intent.erasureEpoch, [saved.revisionId]);
    await applyContentErasure(contentPool, { erasureId: intent.erasureId,
      erasureEpoch: intent.erasureEpoch, resourceId,
      revisionIds: [saved.revisionId] });
    unlinkSync(join(objects, objectDigest));
    await markErasureSuppressed(relay, intent.erasureId);

    const restored = {
      account: new Pool({ connectionString: accountBackup, max: 2 }),
      access: new Pool({ connectionString: accessBackup, max: 2 }),
      content: new Pool({ connectionString: contentBackup, max: 2 }),
      graph: { fuseki: oldGraph, lineage },
      objects: { directory: restoredObjects },
    };
    pools.add(restored.account);
    pools.add(restored.access);
    pools.add(restored.content);
    const restoredFence = await engageAccessRecoveryFence(restored.access);
    expect(existsSync(join(restoredObjects, objectDigest))).toBe(true);
    expect((await restored.content.query<{ serialized_bytes: Buffer | null }>(
      'SELECT serialized_bytes FROM content.revision WHERE id = $1', [saved.revisionId])).rows[0]
      ?.serialized_bytes).not.toBeNull();
    expect(await graphErasureSuppressed(restored.graph.fuseki, intent.erasureId,
      intent.erasureEpoch, [saved.revisionId])).toBe(false);
    const held = await reconcileRestoredErasures(relay, restored, {
      operationId: `sys07-unreplayed-${randomUUID()}`, consumer, replay: false,
      authority: { sealedCoverage, hmacKey: recoveryKey },
    });
    expect(held).toMatchObject({ state: 'held', counts: { conflict: 3 } });
    await expect(releaseErasureRestoreHold(relay, restored, held.reconciliationId,
      restoredFence, { sealedCoverage, hmacKey: recoveryKey }))
      .rejects.toBeInstanceOf(ErasureRestoreHold);

    const pass = await reconcileRestoredErasures(relay, restored, {
      operationId: `sys07-replay-${randomUUID()}`, consumer, replay: true,
      authority: { sealedCoverage, hmacKey: recoveryKey },
    });
    expect(pass).toMatchObject({ state: 'reconciled', counts: { replayed: 3, matched: 2 } });
    expect((await restored.content.query<{ availability: string }>(
      'SELECT availability FROM content.revision WHERE id = $1', [saved.revisionId])).rows[0])
      .toEqual({ availability: 'erased' });
    expect(existsSync(join(restoredObjects, objectDigest))).toBe(false);
    expect(existsSync(join(restoredObjects, retainedManifest))).toBe(true);
    expect(await graphErasureSuppressed(restored.graph.fuseki, intent.erasureId,
      intent.erasureEpoch, [saved.revisionId])).toBe(true);
    const indexed = await restored.graph.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?unit WHERE { GRAPH <urn:rezics:search:public> {
        ?unit rv:revision <${revision}> . } }`);
    expect(indexed.results?.bindings).toHaveLength(0);
    const retained = await restored.graph.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?body WHERE { GRAPH <urn:rezics:search:public> {
        <${retainedUnit}> rv:searchBody ?body . } }`);
    expect(retained.results?.bindings[0]?.body?.value).toBe('retained lighthouse');
    const replayReceipt = `urn:rezics:receipt:sys07-stale:${randomUUID()}`;
    const stale = await restored.graph.fuseki.commandWithReceipt({
      receipt: replayReceipt, digest: 'b'.repeat(64), deadlineMs: 10_000, validations: [],
      update: `PREFIX rv: <https://rezics.com/vocab/> INSERT {
        GRAPH <urn:rezics:graph:revisions> { <${unit}> rv:contentRevision <${revision}> . }
        GRAPH <urn:rezics:graph:receipts> { <${replayReceipt}> a rv:OperationReceipt . }
      } WHERE { }`,
    });
    expect(stale.status).toBe('invalid');
    writeFileSync(join(restoredObjects, objectDigest), objectBytes, { mode: 0o600, flag: 'wx' });
    await expect(releaseErasureRestoreHold(relay, restored, pass.reconciliationId,
      restoredFence, { sealedCoverage, hmacKey: recoveryKey }))
      .rejects.toBeInstanceOf(ErasureRestoreHold);
    unlinkSync(join(restoredObjects, objectDigest));
    await releaseErasureRestoreHold(relay, restored, pass.reconciliationId,
      restoredFence, { sealedCoverage, hmacKey: recoveryKey });
    expect((await restored.access.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true')).rows[0]?.open).toBe(true);
  } finally {
    candidate?.remove();
    live?.remove();
    spawnSync('docker', ['rm', '-f', candidateName], { env: qa.dockerEnv, timeout: 30_000 });
    spawnSync('docker', ['rm', '-f', liveName], { env: qa.dockerEnv, timeout: 30_000 });
    spawnSync('docker', ['volume', 'rm', '-f', graphVolume], { env: qa.dockerEnv, timeout: 30_000 });
    spawnSync('docker', ['volume', 'rm', '-f', liveVolume], { env: qa.dockerEnv, timeout: 30_000 });
    await closeAccount().catch(() => undefined);
    await Promise.allSettled([...pools].map(pool => pool.end()));
    await databases.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}, 300_000);
