import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { OutboxGap, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { activateMetadataWork, GRAPHS, initializeFreshGraph, metadataWorkRequestDigest }
  from '../../../services/main/src/modules/work/activate.ts';

const RV = 'https://rezics.com/vocab/';
const OUTBOX = 'urn:rezics:graph:outbox';
const root = resolve(import.meta.dir, '../../..');

function rdfTerm(binding: { type: string; value: string; datatype?: string; 'xml:lang'?: string }): string {
  if (binding.type === 'uri') return `<${binding.value}>`;
  if (binding.type !== 'literal') throw new Error(`unsupported retained outbox term: ${binding.type}`);
  const lexical = JSON.stringify(binding.value);
  if (binding['xml:lang']) return `${lexical}@${binding['xml:lang']}`;
  if (binding.datatype) return `${lexical}^^<${binding.datatype}>`;
  return lexical;
}

test('SYS05: a retained outbox snapshot restores relay progress after a detected gap', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.ACCOUNT_RELAY_DATABASE_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated integration QA tier');
  }
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const pool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL, max: 3 });
  const state = mkdtempSync(join(root, '.temp', 'sys05-gap-'));
  const objectDirectory = join(state, 'objects');
  mkdirSync(objectDirectory, { recursive: true, mode: 0o700 });
  const consumer = `sys05-gap:${randomUUID()}`;
  const lineage = { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH };
  let batchId: string | undefined;
  let eventId: string | undefined;
  let snapshot: string[] = [];
  let dataEpoch = lineage.dataEpoch;
  let sequence = '0';
  let checkpointCreated = false;
  try {
    const control = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?routing ?sequence WHERE {
      GRAPH <${GRAPHS.control}> { <urn:rezics:dataset:product> rv:dataEpoch ?epoch ;
        rv:routingEpoch ?routing ; rv:sequence ?sequence . }
    }`);
    const current = control.results?.bindings ?? [];
    if (current.length === 0) {
      await initializeFreshGraph(fuseki, lineage);
      dataEpoch = lineage.dataEpoch;
    } else if (current.length !== 1 || !current[0]?.epoch || !current[0].routing || !current[0].sequence
      || current[0].epoch.value !== lineage.dataEpoch || current[0].routing.value !== lineage.routingEpoch) {
      throw new Error('SYS05 fixture graph lineage differs from its QA stack');
    } else {
      sequence = current[0].sequence.value;
      dataEpoch = current[0].epoch.value;
    }
    await pool.query('INSERT INTO relay.checkpoint (consumer, data_epoch, sequence) VALUES ($1, $2, $3)',
      [consumer, dataEpoch, sequence]);
    checkpointCreated = true;

    const title = `SYS05 gap recovery ${randomUUID()}`;
    const created = await activateMetadataWork({ fuseki, lineage, objectDirectory }, { title,
      admission: { id: randomUUID(), scope: 'work:create:root', action: 'work.create',
        idempotencyKey: `sys05-work-${randomUUID()}`, requestDigest: metadataWorkRequestDigest(title),
        authorityEpoch: '0', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const batchResult = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?batch ?event WHERE {
      GRAPH <${OUTBOX}> { ?batch a rv:OutboxBatch ; rv:dataEpoch ${JSON.stringify(dataEpoch)} ;
        rv:sequence ${created.sequence} ; rv:event ?event . }
    }`);
    const batchRows = batchResult.results?.bindings ?? [];
    if (batchRows.length !== 1 || !batchRows[0]?.batch || !batchRows[0].event) {
      throw new Error('SYS05 fixture has no exact Work outbox batch/event');
    }
    batchId = batchRows[0].batch.value;
    eventId = batchRows[0].event.value;
    const captured = await fuseki.query(`SELECT ?subject ?predicate ?object WHERE {
      GRAPH <${OUTBOX}> { VALUES ?subject { <${batchId}> <${eventId}> } ?subject ?predicate ?object . }
    }`);
    snapshot = (captured.results?.bindings ?? []).map(row => {
      if (!row.subject || !row.predicate || !row.object) throw new Error('incomplete retained outbox snapshot row');
      return `<${row.subject.value}> <${row.predicate.value}> ${rdfTerm(row.object)} .`;
    });
    if (snapshot.length < 4) throw new Error('SYS05 retained outbox snapshot is incomplete');

    await fuseki.update(`DELETE WHERE { GRAPH <${OUTBOX}> { <${batchId}> ?predicate ?object } };
      DELETE WHERE { GRAPH <${OUTBOX}> { <${eventId}> ?predicate ?object } }`);
    await expect(relayMainOutboxOnce(fuseki, pool, consumer)).rejects.toBeInstanceOf(OutboxGap);
    const afterGap = await pool.query<{ sequence: string }>(
      'SELECT sequence::text FROM relay.checkpoint WHERE consumer = $1', [consumer]);
    expect(afterGap.rows[0]?.sequence).toBe(sequence);

    await fuseki.update(`INSERT DATA { GRAPH <${OUTBOX}> { ${snapshot.join('\n')} } }`);
    const recovered = await relayMainOutboxOnce(fuseki, pool, consumer);
    expect(recovered).toMatchObject({ batchId, dataEpoch, sequence: created.sequence,
      routingEpoch: lineage.routingEpoch, eventIds: [eventId] });
    const afterRecovery = await pool.query<{ sequence: string }>(
      'SELECT sequence::text FROM relay.checkpoint WHERE consumer = $1', [consumer]);
    expect(afterRecovery.rows[0]?.sequence).toBe(created.sequence);
  } finally {
    if (batchId && eventId && snapshot.length) {
      await fuseki.update(`DELETE WHERE { GRAPH <${OUTBOX}> { <${batchId}> ?predicate ?object } };
        DELETE WHERE { GRAPH <${OUTBOX}> { <${eventId}> ?predicate ?object } }`);
      await fuseki.update(`INSERT DATA { GRAPH <${OUTBOX}> { ${snapshot.join('\n')} } }`);
    }
    if (checkpointCreated) await pool.query('DELETE FROM relay.checkpoint WHERE consumer = $1', [consumer]);
    await pool.end();
    rmSync(state, { recursive: true, force: true });
  }
});
