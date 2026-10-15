import { test, expect, spyOn } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { cloneQaOwnerDatabases } from '../../../tests/qa/support/databases.ts';
import { createMainApp } from '../src/app.ts';
import { ContentProjectionWorker } from '../src/content-projection-worker.ts';
import { deliverRetainedContentEligibilityOnce } from '../src/modules/content-publication/eligibility-delivery.ts';
import { createRealmSpace, spaceCreationDigest } from '../src/modules/space/create.ts';
import { selectRealmLocal, realmSelectionDigest } from '../src/modules/work/select-realm.ts';
import { ZoneBrowseProjection } from '../src/modules/zone-browse/store.ts';
import { runMainRelay } from '../src/modules/outbox/worker.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { readEventSourceKeys } from '../src/modules/event/source.ts';
import { EventTemporalProjection } from '../src/modules/event/projection.ts';
import { activateMetadataWork, DATASET, initializeFreshGraph, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { editMetadataWork, metadataWorkEditDigest, StaleWorkHead,
  workEditReceiptIri } from '../src/modules/work/edit.ts';
import { PendingWorkSeal, sealMetadataWorkAdmission } from '../src/modules/work/seal.ts';
import { cutoverRestoredGraphLineage } from '../src/modules/work/restore-lineage.ts';
import { initializeRelayCheckpoint, OutboxEpochChanged, OutboxGap, OutboxIncomplete, OutboxRecoveryHold,
  relayCoverage, RelayCheckpointConflict, relayMainOutboxOnce } from '../src/modules/outbox/relay.ts';

const root = resolve(import.meta.dir, '../../..');

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('live handoff boundary did not complete')), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

test('restored owner cut remains readable with live workers at header, event and acknowledgement boundaries', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the isolated QA integration tier');
  const databases = await cloneQaOwnerDatabases(runId, ['access', 'content', 'relay'], 'owner');
  let source: Awaited<ReturnType<typeof startMediaStack>> | undefined;
  let restored: Awaited<ReturnType<typeof startMediaStack>> | undefined;
  let projection: ZoneBrowseProjection | undefined;
  let contentWorker: ContentProjectionWorker | undefined;
  let relayTask: Promise<void> | undefined;
  let running = true;
  const releaseHeader = Promise.withResolvers<void>(), releaseEvents = Promise.withResolvers<void>();
  try {
    source = await startMediaStack('retained-handoff-source', { ownerUrls: databases.urls });
    const consumer = source.composition.relayConsumer;
    if (!consumer) throw new Error('The restored proof requires the configured Main relay consumer');
    const actor = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const input = { name: 'Retained handoff Realm', actingSubject: actor };
    const created = await createRealmSpace(source.env, source.admission(actor, 'space:create:root', 'space.create',
      spaceCreationDigest(input)), input);
    if (created.outcome !== 'succeeded' || !created.realm) throw new Error('Realm creation failed');
    // Cross the decimal-width boundary: ordering a projected text sequence
    // can otherwise report batch 9 missing when batch 10 sorts first.
    for (let index = 0; index < 11; index++) await source.catalogueWork(actor, `Retained Work ${index}`);
    const work = await source.publicWork(actor, ['en'], 'Retained visible Work');
    const adoption = { context: { kind: 'realm-local' as const, id: created.realm },
      work: work.work, mainVersion: work.mainVersion, contribution: work.variants[0]!.contribution,
      publicationDecision: work.variants[0]!.decision, expectedSelectionHead: null,
      selectionBasis: 'realm-manager-review' as const, actingSubject: actor };
    expect((await selectRealmLocal(source.env, source.admission(actor, `publication:adopt:${created.realm}`,
      'publication.adopt', realmSelectionDigest(adoption)), adoption)).outcome).toBe('succeeded');
    await initializeRelayCheckpoint(source.composition.relayPool!, consumer, source.env.lineage.dataEpoch);
    const sourceProjection = new ZoneBrowseProjection(source.accessPool, source.composition.relayPool!, source.env, consumer);
    await sourceProjection.backfill();
    const checkpoint = sourceProjection.recoveryStatus().checkpoint;
    const lineage = { ...source.env.lineage };
    // Stop all owners before copying any of them. The fixed graph and immutable
    // objects receive no writes between this cut and its restored-reader proof.
    await source.stop();
    source = undefined;
    const ownerUrls = {
      access: await databases.snapshot('access', async () => {}),
      content: await databases.snapshot('content', async () => {}),
      relay: await databases.snapshot('relay', async () => {}),
    };
    restored = await startMediaStack('retained-handoff-restored', { ownerUrls });
    expect(restored.env.lineage).toEqual(lineage);
    const relay = restored.composition.relayPool!;
    projection = new ZoneBrowseProjection(restored.accessPool, relay, restored.env, consumer);
    await projection.backfill();
    expect(projection.recoveryStatus().checkpoint).toEqual(checkpoint);
    const app = createMainApp(restored.fuseki, { ...restored.composition.dependencies, zoneBrowse: projection });
    const header = Promise.withResolvers<void>(), events = Promise.withResolvers<void>();
    const contentPolls = [0, 0], browsePolls = [0, 0];
    const contentPolled = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const browsePolled = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const contentCaughtUp = Promise.withResolvers<void>(), browseCaughtUp = Promise.withResolvers<void>();
    const finalFrontier = Promise.withResolvers<void>();
    const statuses: number[] = [], faults: unknown[] = [], logs: string[] = [];
    let phase = 0, firstHeader = true, firstEvents = true;
    const boundaryPool = { query: async (sql: string, values?: unknown[]) => {
      const result = await relay.query(sql, values);
      if (firstHeader && sql.includes('INSERT INTO relay.delivered_batch')) {
        firstHeader = false;
        header.resolve();
        await releaseHeader.promise;
      }
      return result;
    } } as unknown as Pool;
    const errorLog = spyOn(console, 'error').mockImplementation(line => { logs.push(String(line)); });
    const tick = projection.tick.bind(projection);
    const tickSpy = spyOn(projection, 'tick').mockImplementation(async () => {
      if (phase === 2) await finalFrontier.promise;
      const count = await tick();
      if (phase < 2 && ++browsePolls[phase]! >= 3) browsePolled[phase]!.resolve();
      if (phase === 2) {
        const acknowledged = (await relay.query('SELECT sequence::text FROM relay.checkpoint WHERE consumer = $1', [consumer])).rows[0]!.sequence;
        if (projection!.recoveryStatus().checkpoint.sequence === acknowledged && acknowledged !== '0') browseCaughtUp.resolve();
      }
      return count;
    });
    const copy = restored;
    contentWorker = new ContentProjectionWorker(async () => {
      if (phase === 2) await finalFrontier.promise;
      await deliverRetainedContentEligibilityOnce(copy.env, copy.content, relay, consumer);
      const response = await app.handle(new Request(`http://main.local/v1/realms/${created.realm!.slice(-36)}/modules/browse`));
      statuses.push(response.status);
      if (response.status !== 200) throw new Error(await response.text());
      expect((await response.json() as { items: { id: string }[] }).items.map(item => item.id)).toEqual([work.work]);
      if (phase < 2 && ++contentPolls[phase]! >= 4) contentPolled[phase]!.resolve();
      if (phase === 2) {
        const acknowledged = (await relay.query('SELECT sequence::text FROM relay.checkpoint WHERE consumer = $1', [consumer])).rows[0]!.sequence;
        const progress = await copy.content.readEligibilityDeliveryProgress(MAIN_RELAY_STREAM_SCOPE, lineage.dataEpoch);
        if (progress.sequence === acknowledged && acknowledged !== '0') contentCaughtUp.resolve();
      }
      return null;
    }, 100, error => { faults.push(error); });
    try {
      relayTask = runMainRelay(async () => {
        const batch = await relayMainOutboxOnce(copy.fuseki, boundaryPool, consumer, {
          ownerOutbox: copy.env.receiptCustody,
          afterDelivery: async () => {
            if (!firstEvents) return;
            firstEvents = false;
            events.resolve();
            await releaseEvents.promise;
          },
        });
        if (!batch) running = false;
        return batch !== null;
      }, () => running, 100, { log: line => { logs.push(line); }, consumer });
      await bounded(header.promise);
      projection.start();
      contentWorker.start();
      await bounded(Promise.all([contentPolled[0]!.promise, browsePolled[0]!.promise]));
      expect(projection.recoveryStatus().checkpoint).toEqual(checkpoint);
      expect((await copy.content.readEligibilityDeliveryProgress(MAIN_RELAY_STREAM_SCOPE, lineage.dataEpoch)).sequence).toBe('0');
      phase = 1;
      releaseHeader.resolve();
      await bounded(events.promise);
      await bounded(Promise.all([contentPolled[1]!.promise, browsePolled[1]!.promise]));
      expect(projection.recoveryStatus().checkpoint).toEqual(checkpoint);
      expect((await copy.content.readEligibilityDeliveryProgress(MAIN_RELAY_STREAM_SCOPE, lineage.dataEpoch)).sequence).toBe('0');
      phase = 2;
      releaseEvents.resolve();
      await bounded(relayTask);
      finalFrontier.resolve();
      await bounded(Promise.all([contentCaughtUp.promise, browseCaughtUp.promise]));
      expect(statuses.length).toBeGreaterThanOrEqual(8);
      expect(statuses.every(status => status === 200)).toBe(true);
      expect(faults).toEqual([]);
      expect(logs.filter(line => line.includes('worker_fault') || line.includes('RelayCheckpointConflict'))).toEqual([]);
      const coverage = await relayCoverage(relay, consumer);
      expect(BigInt(coverage.sequence)).toBeGreaterThanOrEqual(12n);
      expect(projection.recoveryStatus().checkpoint.sequence).toBe(coverage.sequence);
      expect((await copy.content.readEligibilityDeliveryProgress(MAIN_RELAY_STREAM_SCOPE, lineage.dataEpoch)).sequence).toBe(coverage.sequence);
    } finally {
      running = false;
      releaseHeader.resolve(); releaseEvents.resolve();
      finalFrontier.resolve();
      await relayTask;
      await contentWorker.stop();
      await projection.stop();
      tickSpy.mockRestore(); errorLog.mockRestore();
    }
  } finally {
    running = false;
    releaseHeader.resolve(); releaseEvents.resolve();
    await relayTask;
    await contentWorker?.stop();
    await projection?.stop();
    await source?.stop();
    await restored?.stop();
    await databases.close();
  }
}, 120_000);

test('SYS04/SYS05/SYS12 partial: retained RDF outbox and durable handoff', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run this destructive source fixture alone through the integration QA tier');
  }
  const stack = await startMediaStack('outbox-handoff');
  const fuseki = stack.fuseki;
  const state = join(root, '.temp', `main-outbox-${Bun.randomUUIDv7()}`);
  mkdirSync(state, { recursive: true });
  const pool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  let relayProcess: ChildProcess | undefined;
  try {
    // This test owns one disposable QA project and exercises a source beginning at zero.
    await fuseki.resetDataset();
    await pool.query('TRUNCATE relay.delivered_event, relay.delivered_batch, relay.checkpoint CASCADE');
    const partitionLease = stack.env.partitionLease!;
    const route = await partitionLease.routes.current('graph', DATASET);
    const lineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: route.routingEpoch };
    const env: WorkActivationEnvironment = { ...stack.env, fuseki, lineage,
      partitionLease: { ...partitionLease, leaseEpoch: route.leaseEpoch },
      objectDirectory: join(state, 'objects'), candidateDirectory: join(state, 'candidates'),
      repositoryRoot: root, python: 'python3' };
    await initializeFreshGraph(fuseki, lineage);
    const createAdmission = { id: Bun.randomUUIDv7(), scope: 'work:create:root', action: 'work.create',
      idempotencyKey: 'outbox-create', requestDigest: metadataWorkRequestDigest('Outbox Work'),
      authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const created = await activateMetadataWork(env, { admission: createAdmission, title: 'Outbox Work' });
    const editIntent = (head: string, title: string) => ({ admission: {
      id: Bun.randomUUIDv7(), scope: `work:edit:${created.work}`, action: 'work.edit',
      authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestDigest: metadataWorkEditDigest(created.work, head, title),
    }, work: created.work, expectedHead: head, title });
    const firstEdit = await editMetadataWork(env, editIntent(created.workRevision, 'Outbox Work edited'));
    await initializeRelayCheckpoint(pool, 'first-handoff', lineage.dataEpoch);
    let publications = 0;
    const publishingPool = { query: async (sql: string, values?: unknown[]) => {
      const result = await pool.query(sql, values);
      if (sql.includes('INSERT INTO relay.delivered_batch')) {
        // Read while delivery is paused after publishing the header and before
        // ACK. This deterministically exposed the old header-before-members race.
        const source = await readEventSourceKeys(pool, { dataEpoch: lineage.dataEpoch,
          afterSequence: (BigInt(String(values![1])) - 1n).toString() });
        expect(source?.members).toBe(1);
        publications++;
      }
      return result;
    } } as unknown as Pool;
    expect((await relayMainOutboxOnce(fuseki, publishingPool, 'first-handoff'))?.sequence).toBe('1');
    expect((await relayMainOutboxOnce(fuseki, publishingPool, 'first-handoff'))?.sequence).toBe('2');
    expect(publications).toBe(2);
    const eventProjection = new EventTemporalProjection(stack.accessPool, pool, env);
    await fuseki.update(`INSERT DATA { GRAPH <urn:rezics:graph:control> {
      <${DATASET}> <https://rezics.com/vocab/restoreHold> true } }`);
    try { expect(await eventProjection.tick()).toBe(0); }
    finally {
      await fuseki.update(`DELETE DATA { GRAPH <urn:rezics:graph:control> {
        <${DATASET}> <https://rezics.com/vocab/restoreHold> true } }`);
    }
    expect(await eventProjection.tick()).toBeGreaterThan(0);
    expect(await relayMainOutboxOnce(fuseki, pool, 'first-handoff')).toBeNull();
    expect((await relayCoverage(pool, 'first-handoff')).eventCount).toBe('2');
    expect((await relayCoverage(pool, 'first-handoff')).batchCount).toBe('2');
    const delivered = await pool.query<{ envelope: Record<string, any> }>(
      'SELECT envelope FROM relay.delivered_event ORDER BY sequence');
    expect(delivered.rows).toHaveLength(2);
    expect(delivered.rows[0]!.envelope).toMatchObject({ specversion: '1.0',
      source: 'https://rezics.com/services/main', type: 'com.rezics.work.created.v1',
      data: { sourcePosition: { datasetId: 'product', dataEpoch: lineage.dataEpoch, sequence: '1' },
        ordinal: 0, receipt: { action: 'work.create', outcome: 'succeeded',
          work: created.work, workRevision: created.workRevision } } });
    expect(delivered.rows[0]!.envelope.data.receipt.workManifest).toMatch(/^urn:rezics:sha256:[0-9a-f]{64}$/);
    expect(delivered.rows[1]!.envelope).toMatchObject({ type: 'com.rezics.work.edited.v1',
      data: { receipt: { action: 'work.edit', outcome: 'succeeded',
        work: created.work, workRevision: firstEdit.revision, expectedHead: created.workRevision } } });
    const secondEdit = await editMetadataWork(env, editIntent(firstEdit.revision, 'Outbox Work again'));
    expect(secondEdit.sequence).toBe('3');
    const eventAtThree = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?event WHERE { GRAPH <urn:rezics:graph:outbox> {
        ?batch rv:dataEpoch "${lineage.dataEpoch}" ; rv:sequence 3 ; rv:event ?event . } }`);
    const thirdEvent = eventAtThree.results?.bindings[0]?.event?.value;
    if (!thirdEvent) throw new Error('third outbox event missing');
    const thirdReceipt = workEditReceiptIri(secondEdit.admissionId);
    const forgedReceipt = `urn:rezics:receipt:${'0'.repeat(64)}`;
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE DATA { GRAPH <urn:rezics:graph:outbox> { <${thirdEvent}> rv:receipt <${thirdReceipt}> } };
      INSERT DATA { GRAPH <urn:rezics:graph:outbox> { <${thirdEvent}> rv:receipt <${forgedReceipt}> } }`);
    await expect(relayMainOutboxOnce(fuseki, pool, 'first-handoff'))
      .rejects.toBeInstanceOf(OutboxIncomplete);
    expect((await pool.query<{ count: string }>('SELECT count(*) AS count FROM relay.delivered_event'))
      .rows[0]!.count).toBe('2');
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE DATA { GRAPH <urn:rezics:graph:outbox> { <${thirdEvent}> rv:receipt <${forgedReceipt}> } };
      INSERT DATA { GRAPH <urn:rezics:graph:outbox> { <${thirdEvent}> rv:receipt <${thirdReceipt}> } }`);
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE DATA { GRAPH <urn:rezics:graph:outbox> { <${thirdEvent}> rv:ordinal 0 } };
      INSERT DATA { GRAPH <urn:rezics:graph:outbox> { <${thirdEvent}> rv:ordinal 1 } }`);
    await expect(relayMainOutboxOnce(fuseki, pool, 'first-handoff'))
      .rejects.toBeInstanceOf(OutboxIncomplete);
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE DATA { GRAPH <urn:rezics:graph:outbox> { <${thirdEvent}> rv:ordinal 1 } };
      INSERT DATA { GRAPH <urn:rezics:graph:outbox> { <${thirdEvent}> rv:ordinal 0 } }`);
    await expect(relayMainOutboxOnce(fuseki, pool, 'first-handoff', {
      afterDelivery: async () => { throw new Error('simulated crash after durable handoff'); },
    })).rejects.toThrow('simulated crash');
    expect((await pool.query<{ count: string }>('SELECT count(*) AS count FROM relay.delivered_event'))
      .rows[0]!.count).toBe('3');
    expect((await pool.query<{ sequence: string }>("SELECT sequence FROM relay.checkpoint WHERE consumer = 'first-handoff'"))
      .rows[0]!.sequence).toBe('2');
    await expect(relayCoverage(pool, 'first-handoff'))
      .rejects.toBeInstanceOf(RelayCheckpointConflict);
    // A pre-stream crash retained the original envelope bytes. Replay must
    // deduplicate that row without changing its recovery digest.
    await pool.query("UPDATE relay.delivered_event SET envelope = envelope #- '{data,relayPosition}' WHERE sequence = 3");
    const legacyBody = (await pool.query("SELECT envelope::text AS body FROM relay.delivered_event WHERE sequence = 3"))
      .rows[0]!.body;
    const relayLog = openSync(join(state, 'relay.log'), 'w');
    relayProcess = spawn(process.execPath, [join(root, 'services/main/src/relay.ts')], {
      cwd: root,
      env: { ...process.env, FUSEKI_URL: Bun.env.FUSEKI_URL,
        MAIN_RELAY_DATABASE_URL: Bun.env.ACCOUNT_RELAY_DATABASE_URL,
        MAIN_RELAY_CONSUMER: 'first-handoff', MAIN_RELAY_INTERVAL_MS: '100' },
      stdio: ['ignore', relayLog, relayLog],
    });
    closeSync(relayLog);
    let resumedSequence = '';
    for (let i = 0; i < 100; i++) {
      resumedSequence = (await pool.query<{ sequence: string }>(
        "SELECT sequence FROM relay.checkpoint WHERE consumer = 'first-handoff'"))
        .rows[0]!.sequence;
      if (resumedSequence === '3') break;
      if (relayProcess.exitCode !== null) throw new Error(readFileSync(join(state, 'relay.log'), 'utf8'));
      await Bun.sleep(100);
    }
    expect(resumedSequence).toBe('3');
    expect((await pool.query("SELECT envelope::text AS body FROM relay.delivered_event WHERE sequence = 3"))
      .rows[0]!.body).toBe(legacyBody);
    relayProcess.kill('SIGTERM');
    if (relayProcess.exitCode === null) {
      await new Promise<void>(resolveExit => relayProcess!.once('exit', () => resolveExit()));
    }
    relayProcess = undefined;
    expect((await pool.query<{ count: string }>('SELECT count(*) AS count FROM relay.delivered_event'))
      .rows[0]!.count).toBe('3');
    expect((await relayCoverage(pool, 'first-handoff')).eventCount).toBe('3');
    await expect(editMetadataWork(env, editIntent(firstEdit.revision, 'Stale outbox edit')))
      .rejects.toBeInstanceOf(StaleWorkHead);
    expect((await relayMainOutboxOnce(fuseki, pool, 'first-handoff'))?.sequence).toBe('4');
    const cancelledAdmission = { id: Bun.randomUUIDv7(), principalId: Bun.randomUUIDv7(),
      actingSubject: `https://rezics.com/id/${Bun.randomUUIDv7()}`,
      scope: 'work:create:root', action: 'work.create', idempotencyKey: 'cancelled-outbox-work',
      requestDigest: metadataWorkRequestDigest('Cancelled outbox Work'), authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), state: 'registered' as const,
      dispatchEligible: false, replayed: false };
    expect((await sealMetadataWorkAdmission(env, cancelledAdmission)).sequence).toBe('5');
    expect((await relayMainOutboxOnce(fuseki, pool, 'first-handoff'))?.sequence).toBe('5');
    const terminalEvents = await pool.query<{ envelope: Record<string, any> }>(
      'SELECT envelope FROM relay.delivered_event WHERE sequence IN (4, 5) ORDER BY sequence');
    expect(terminalEvents.rows.map(row => row.envelope.type)).toEqual([
      'com.rezics.work.edit-rejected.v1', 'com.rezics.work.admission-cancelled.v1']);
    expect(terminalEvents.rows[0]!.envelope.data.receipt).toMatchObject({
      action: 'work.edit', outcome: 'cancelled', reason: 'stale-head' });
    expect(terminalEvents.rows[1]!.envelope.data.receipt).toMatchObject({
      action: 'work.create', outcome: 'cancelled', admissionId: cancelledAdmission.id });
    const emptyBatch = `urn:rezics:outbox:${Bun.randomUUIDv7()}`;
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 5 .
        <${MAIN_RELAY_STREAM_SCOPE}> rv:streamSequence 5 } }
      INSERT { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 6 .
        <${MAIN_RELAY_STREAM_SCOPE}> rv:streamSequence 6 }
        GRAPH <urn:rezics:graph:outbox> { <${emptyBatch}> a rv:OutboxBatch ;
          rv:dataEpoch "${lineage.dataEpoch}" ; rv:sequence 6 ; rv:eventCount 0 ;
          rv:streamScope "${MAIN_RELAY_STREAM_SCOPE}" ; rv:streamSequence 6 . } }
      WHERE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 5 } }`);
    await expect(relayMainOutboxOnce(fuseki, pool, 'first-handoff', {
      afterDelivery: async () => { throw new Error('simulated crash after empty header'); },
    })).rejects.toThrow('simulated crash after empty header');
    await expect(relayCoverage(pool, 'first-handoff'))
      .rejects.toBeInstanceOf(RelayCheckpointConflict);
    await pool.query('UPDATE relay.delivered_batch SET batch_id = $3 WHERE data_epoch = $1 AND sequence = $2',
      [lineage.dataEpoch, '6', `urn:rezics:outbox:${Bun.randomUUIDv7()}`]);
    await expect(relayMainOutboxOnce(fuseki, pool, 'first-handoff'))
      .rejects.toBeInstanceOf(OutboxIncomplete);
    await pool.query('UPDATE relay.delivered_batch SET batch_id = $3 WHERE data_epoch = $1 AND sequence = $2',
      [lineage.dataEpoch, '6', emptyBatch]);
    expect((await relayMainOutboxOnce(fuseki, pool, 'first-handoff'))?.eventIds).toEqual([]);
    const retainedEmpty = await pool.query<{ batch_id: string; event_count: number }>(
      'SELECT batch_id, event_count FROM relay.delivered_batch WHERE data_epoch = $1 AND sequence = 6',
      [lineage.dataEpoch]);
    expect(retainedEmpty.rows).toEqual([{ batch_id: emptyBatch, event_count: 0 }]);
    expect((await relayCoverage(pool, 'first-handoff')).batchCount).toBe('6');
    expect((await relayCoverage(pool, 'first-handoff')).eventCount).toBe('5');
    await pool.query('DELETE FROM relay.delivered_batch WHERE data_epoch = $1 AND sequence = 6',
      [lineage.dataEpoch]);
    await expect(relayCoverage(pool, 'first-handoff'))
      .rejects.toBeInstanceOf(RelayCheckpointConflict);
    await pool.query(`INSERT INTO relay.delivered_batch
      (data_epoch, sequence, batch_id, routing_epoch, event_count) VALUES ($1, 6, $2, $3, 0)`,
      [lineage.dataEpoch, emptyBatch, lineage.routingEpoch]);
    expect((await pool.query<{ sequence: string }>("SELECT sequence FROM relay.checkpoint WHERE consumer = 'first-handoff'"))
      .rows[0]!.sequence).toBe('6');
    const brokenBatch = `urn:rezics:outbox:${Bun.randomUUIDv7()}`;
    const missingEvent = `urn:rezics:event:${Bun.randomUUIDv7()}`;
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 6 .
        <${MAIN_RELAY_STREAM_SCOPE}> rv:streamSequence 6 } }
      INSERT { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 7 .
        <${MAIN_RELAY_STREAM_SCOPE}> rv:streamSequence 7 }
        GRAPH <urn:rezics:graph:outbox> { <${brokenBatch}> a rv:OutboxBatch ;
          rv:dataEpoch "${lineage.dataEpoch}" ; rv:sequence 7 ; rv:eventCount 1 ;
          rv:streamScope "${MAIN_RELAY_STREAM_SCOPE}" ; rv:streamSequence 7 ;
          rv:event <${missingEvent}> . } }
      WHERE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 6 } }`);
    const duplicateBatch = `urn:rezics:outbox:${Bun.randomUUIDv7()}`;
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <urn:rezics:graph:outbox> { <${duplicateBatch}> a rv:OutboxBatch ;
        rv:dataEpoch "${lineage.dataEpoch}" ; rv:sequence 7 ; rv:eventCount 0 ;
        rv:streamScope "${MAIN_RELAY_STREAM_SCOPE}" ; rv:streamSequence 7 . }
    }`);
    await expect(relayMainOutboxOnce(fuseki, pool, 'first-handoff'))
      .rejects.toBeInstanceOf(OutboxIncomplete);
    await fuseki.update(`DELETE WHERE { GRAPH <urn:rezics:graph:outbox> {
      <${duplicateBatch}> ?p ?o } }`);
    await expect(relayMainOutboxOnce(fuseki, pool, 'first-handoff'))
      .rejects.toBeInstanceOf(OutboxIncomplete);
    expect((await pool.query<{ sequence: string }>("SELECT sequence FROM relay.checkpoint WHERE consumer = 'first-handoff'"))
      .rows[0]!.sequence).toBe('6');
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE { GRAPH <urn:rezics:graph:outbox> { <${brokenBatch}> ?p ?o } }
      WHERE { GRAPH <urn:rezics:graph:outbox> { <${brokenBatch}> ?p ?o } }`);
    await expect(relayMainOutboxOnce(fuseki, pool, 'first-handoff')).rejects.toBeInstanceOf(OutboxGap);
    expect((await pool.query<{ sequence: string }>(
      "SELECT sequence FROM relay.checkpoint WHERE consumer = 'first-handoff'"))
      .rows[0]!.sequence).toBe('6');
    const newLineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: /^(0|[1-9][0-9]*)$/.test(route.routingEpoch)
      ? (BigInt(route.routingEpoch) + 1n).toString() : Bun.randomUUIDv7() };
    await cutoverRestoredGraphLineage(fuseki, { prior: { ...lineage, sequence: '7' }, next: newLineage });
    await expect(relayMainOutboxOnce(fuseki, pool, 'first-handoff'))
      .rejects.toBeInstanceOf(OutboxEpochChanged);
    await initializeRelayCheckpoint(pool, 'held-checkpoint', newLineage.dataEpoch);
    await expect(relayMainOutboxOnce(fuseki, pool, 'held-checkpoint'))
      .rejects.toBeInstanceOf(OutboxRecoveryHold);
    await expect(sealMetadataWorkAdmission({ ...env, lineage: newLineage }, {
      ...cancelledAdmission, id: Bun.randomUUIDv7(), idempotencyKey: 'held-cancellation',
    })).rejects.toBeInstanceOf(PendingWorkSeal);
  } finally {
    if (relayProcess) {
      relayProcess.kill('SIGTERM');
      if (relayProcess.exitCode === null) {
        await new Promise<void>(resolveExit => relayProcess!.once('exit', () => resolveExit()));
      }
    }
    await pool.end();
    await stack.stop();
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
