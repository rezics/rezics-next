import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { OwnerOperations } from '../../../services/main/src/modules/owner/operations.ts';
import { OutboxGap, initializeRelayCheckpoint, readNextMainOutboxBatch,
  relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { activateMetadataWork, GRAPHS, initializeFreshGraph, iri,
  metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';

test('SYS05: product rebuilds a broker-lost consumer inbox from verified retained relay', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.ACCOUNT_RELAY_DATABASE_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH) throw new Error('Run through the isolated integration tier');
  const directory = resolve('.temp', `owner-relay-gap-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL, max: 4 });
  const access = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 3 });
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const lineage = { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
    routingEpoch: Bun.env.MAIN_ROUTING_EPOCH };
  const consumer = `owner-gap:${randomUUID()}`;
  const relayConsumer = `owner-retained:${randomUUID()}`;
  try {
    await initializeFreshGraph(fuseki, lineage);
    await initializeRelayCheckpoint(relay, relayConsumer, lineage.dataEpoch);
    const created = [];
    for (let index = 0; index < 2; index++) {
      const title = `SYS05 retained event ${index} ${randomUUID()}`;
      created.push(await activateMetadataWork({ fuseki, lineage, objectDirectory: directory },
        { title, admission: { id: randomUUID(), scope: 'work:create:root',
          action: 'work.create', idempotencyKey: `gap-${randomUUID()}`,
          requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
          expiresAt: new Date(Date.now() + 60_000).toISOString() } }));
      expect((await relayMainOutboxOnce(fuseki, relay, relayConsumer))?.sequence)
        .toBe(created[index]!.sequence);
    }
    const first = created[0]!;
    const sourceBatch = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?batch ?event WHERE { GRAPH ${iri(GRAPHS.outbox)} {
        ?batch a rv:OutboxBatch ; rv:dataEpoch ${JSON.stringify(lineage.dataEpoch)} ;
          rv:sequence ${first.sequence} ; rv:event ?event . } }`);
    const row = sourceBatch.results?.bindings[0];
    if (!row?.batch || !row.event) throw new Error('source batch is absent');
    await fuseki.update(`DELETE WHERE { GRAPH ${iri(GRAPHS.outbox)} {
      ${iri(row.batch.value)} ?predicate ?object } };
      DELETE WHERE { GRAPH ${iri(GRAPHS.outbox)} {
      ${iri(row.event.value)} ?predicate ?object } }`);
    await expect(readNextMainOutboxBatch(fuseki, lineage.dataEpoch, '0'))
      .rejects.toBeInstanceOf(OutboxGap);
    const operations = new OwnerOperations(relay, { fuseki, lineage,
      objectDirectory: directory }, undefined, undefined, access);
    const app = createMainApp(fuseki, { ownerOperations: operations,
      account: { verify: async (request: Request, scopes: readonly string[]) => {
        if (request.headers.get('authorization') !== 'Bearer operator'
          || scopes[0] !== 'owner:operate') throw new Error('operator denied');
        return { issuer: 'https://owner.test', subject: 'operator' };
      } }, access: { activePrincipalId: async () => randomUUID() } } as unknown as MainWorkDependencies);
    const send = (afterSequence: string, throughSequence: string, key: string) =>
      app.handle(new Request('http://main.local/v1/owners/reconciliations', {
        method: 'POST', headers: { authorization: 'Bearer operator',
          'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ profile: 'owner-reconciliation-v1', kind: 'relay_gap',
          consumer, relayConsumer, dataEpoch: lineage.dataEpoch,
          afterSequence, throughSequence }) }));
    const key = `rebuild-${randomUUID()}`;
    const response = await send('0', created[1]!.sequence, key);
    expect(response.status).toBe(201);
    const result = await response.json() as { id: string; state: string; disposition: string };
    expect(result).toMatchObject({ state: 'reconciled', disposition: 'rebuilt' });
    expect((await send('0', created[1]!.sequence, key)).status).toBe(200);
    expect((await send('0', first.sequence, key)).status).toBe(409);
    const inbox = await access.query<{ sequence: string; envelope: { id: string } }>(
      `SELECT sequence::text, envelope FROM access.owner_consumer_replay
       WHERE consumer = $1 ORDER BY sequence, ordinal`, [consumer]);
    expect(inbox.rows.map(event => event.sequence)).toEqual(created.map(item => item.sequence));
    expect(inbox.rows.every(event => event.envelope.id.startsWith('urn:rezics:event:'))).toBe(true);
    const checkpoint = await access.query<{ sequence: string }>(
      'SELECT sequence::text FROM access.owner_consumer_checkpoint WHERE consumer = $1',
      [consumer]);
    expect(checkpoint.rows[0]?.sequence).toBe(created[1]!.sequence);
    const cuts = await relay.query<{ owner: string; status: string }>(
      'SELECT owner, status FROM relay.owner_reconciliation_cut WHERE reconciliation_id = $1',
      [result.id]);
    expect(cuts.rows).toEqual(expect.arrayContaining([
      { owner: 'access', status: 'matched' }, { owner: 'relay', status: 'matched' }]));
    const relayPlanner = await relay.connect();
    try {
      await relayPlanner.query('BEGIN');
      await relayPlanner.query('SET LOCAL enable_seqscan = off');
      const plan = (await relayPlanner.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS) SELECT sequence FROM relay.delivered_batch
         WHERE data_epoch = $1 AND sequence > 0 ORDER BY sequence LIMIT 100`,
        [lineage.dataEpoch])).rows.map(row => row['QUERY PLAN']).join('\n');
      expect(plan).toContain('delivered_batch_pkey');
      await relayPlanner.query('ROLLBACK');
    } finally { relayPlanner.release(); }
    const accessPlanner = await access.connect();
    try {
      await accessPlanner.query('BEGIN');
      await accessPlanner.query('SET LOCAL enable_seqscan = off');
      const plan = (await accessPlanner.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS) SELECT envelope FROM access.owner_consumer_replay
         WHERE consumer = $1 AND data_epoch = $2 AND sequence > 0
         ORDER BY sequence, ordinal LIMIT 100`,
        [consumer, lineage.dataEpoch])).rows.map(row => row['QUERY PLAN']).join('\n');
      expect(plan).toContain('owner_consumer_replay_position');
      await accessPlanner.query('ROLLBACK');
    } finally { accessPlanner.release(); }
    const held = await send(created[1]!.sequence,
      (BigInt(created[1]!.sequence) + 1n).toString(), `missing-${randomUUID()}`);
    expect(held.status).toBe(201);
    expect(await held.json()).toMatchObject({ state: 'held', disposition: 'gap' });
    expect((await access.query<{ sequence: string }>(
      'SELECT sequence::text FROM access.owner_consumer_checkpoint WHERE consumer = $1',
      [consumer])).rows[0]?.sequence).toBe(created[1]!.sequence);
  } finally {
    await Promise.allSettled([relay.end(), access.end()]);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
