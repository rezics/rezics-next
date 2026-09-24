import { test, expect } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { activateMetadataWork, initializeFreshGraph, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { editMetadataWork, metadataWorkEditDigest, StaleWorkHead,
  workEditReceiptIri } from '../src/modules/work/edit.ts';
import { PendingWorkSeal, sealMetadataWorkAdmission } from '../src/modules/work/seal.ts';
import { cutoverRestoredGraphLineage } from '../src/modules/work/restore-lineage.ts';
import { initializeRelayCheckpoint, OutboxEpochChanged, OutboxGap, OutboxIncomplete, OutboxRecoveryHold,
  relayCoverage, RelayCheckpointConflict, relayMainOutboxOnce } from '../src/modules/outbox/relay.ts';

const root = resolve(import.meta.dir, '../../..');
process.env.FUSEKI_MAINTENANCE_TOKEN ??= '0'.repeat(64);
process.env.FUSEKI_COMMAND_TOKEN ??= '1'.repeat(64);

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('SYS04/SYS05/SYS12 partial: retained RDF outbox and durable handoff', async () => {
  const fusekiHome = Bun.env.REZICS_FUSEKI_HOME;
  const jenaHome = Bun.env.REZICS_JENA_HOME;
  const javaHome = Bun.env.REZICS_JAVA_HOME;
  if (!fusekiHome || !jenaHome || !javaHome) throw new Error('Set Jena/Fuseki/Java integration env');
  const state = join(root, '.temp', `main-outbox-${Bun.randomUUIDv7()}`);
  const base = join(state, 'fuseki');
  mkdirSync(join(base, 'databases/rezics/tdb2'), { recursive: true });
  mkdirSync(join(base, 'databases/rezics/lucene'), { recursive: true });
  copyFileSync(join(root, 'docs/operations/examples/fuseki-text.ttl'), join(base, 'fuseki-text.ttl'));
  const port = await freePort();
  const log = openSync(join(state, 'fuseki.log'), 'w');
  const server = spawn(join(fusekiHome, 'fuseki-server'), [
    '--localhost', `--port=${port}`, '--no-cors', '--timeout=10000', `--config=${join(base, 'fuseki-text.ttl')}`,
  ], { cwd: base, env: { ...process.env, JAVA_HOME: javaHome, FUSEKI_HOME: fusekiHome,
    FUSEKI_BASE: base, MAIN: 'main', JVM_ARGS: '-Xms128m -Xmx1g' }, stdio: ['ignore', log, log] });
  closeSync(log);
  const fuseki = new FusekiClient(`http://127.0.0.1:${port}/rezics`);
  const pgData = join(state, 'pgdata');
  const socketDirectory = join(root, '.temp', 'pg-sock');
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  let pool: Pool | undefined;
  let postgresStarted = false;
  let relayProcess: ChildProcess | undefined;
  try {
    for (let i = 0; i < 120; i++) {
      try { if ((await fuseki.query('ASK {}')).boolean === true) break; } catch { /* starting */ }
      if (i === 119) throw new Error('Fuseki did not start');
      await Bun.sleep(250);
    }
    execFileSync('initdb', ['-D', pgData, '-A', 'trust', '--no-instructions'], { cwd: state });
    const pgPort = await freePort();
    execFileSync('pg_ctl', ['-D', pgData, '-l', join(state, 'postgres.log'),
      '-o', `-h 127.0.0.1 -p ${pgPort} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
    postgresStarted = true;
    pool = new Pool({ host: '127.0.0.1', port: pgPort, user: process.env.USER, database: 'postgres' });
    await pool.query(readFileSync(join(root, 'services/main/migrations/relay/001_delivery.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/relay/002_coverage_scan.sql'), 'utf8'));
    await pool.query(readFileSync(join(root, 'services/main/migrations/relay/003_retained_batches.sql'), 'utf8'));
    const lineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '1' };
    const env: WorkActivationEnvironment = { fuseki, lineage,
      objectDirectory: join(state, 'objects'), candidateDirectory: join(state, 'candidates'),
      repositoryRoot: root, jenaHome, javaHome, python: 'python3' };
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
    expect((await relayMainOutboxOnce(fuseki, pool, 'first-handoff'))?.sequence).toBe('1');
    expect((await relayMainOutboxOnce(fuseki, pool, 'first-handoff'))?.sequence).toBe('2');
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
    const relayLog = openSync(join(state, 'relay.log'), 'w');
    relayProcess = spawn(process.execPath, [join(root, 'services/main/src/relay.ts')], {
      cwd: root,
      env: { ...process.env, FUSEKI_URL: `http://127.0.0.1:${port}/rezics`,
        MAIN_RELAY_DATABASE_URL: `postgres://127.0.0.1:${pgPort}/postgres?user=${process.env.USER}`,
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
      DELETE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 5 } }
      INSERT { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 6 }
        GRAPH <urn:rezics:graph:outbox> { <${emptyBatch}> a rv:OutboxBatch ;
          rv:dataEpoch "${lineage.dataEpoch}" ; rv:sequence 6 ; rv:eventCount 0 . } }
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
      DELETE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 6 } }
      INSERT { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 7 }
        GRAPH <urn:rezics:graph:outbox> { <${brokenBatch}> a rv:OutboxBatch ;
          rv:dataEpoch "${lineage.dataEpoch}" ; rv:sequence 7 ; rv:eventCount 1 ;
          rv:event <${missingEvent}> . } }
      WHERE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 6 } }`);
    const duplicateBatch = `urn:rezics:outbox:${Bun.randomUUIDv7()}`;
    await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH <urn:rezics:graph:outbox> { <${duplicateBatch}> a rv:OutboxBatch ;
        rv:dataEpoch "${lineage.dataEpoch}" ; rv:sequence 7 ; rv:eventCount 0 . }
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
    const newLineage = { dataEpoch: Bun.randomUUIDv7(), routingEpoch: '2' };
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
    await pool?.end();
    if (postgresStarted) execFileSync('pg_ctl', ['-D', pgData, '-m', 'fast', '-w', 'stop'], { cwd: state });
    server.kill('SIGTERM');
    if (server.exitCode === null) await new Promise<void>(resolveExit => server.once('exit', () => resolveExit()));
  }
}, 120_000);
