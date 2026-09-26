import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { activateMetadataWork, initializeFreshGraph, metadataWorkRequestDigest }
  from '../../../services/main/src/modules/work/activate.ts';
import { initializeRelayCheckpoint, relayCoverage, RelayCheckpointConflict,
  relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';

test('SYS04/SYS12: replay after delivery crash has one effect; empty and missing batches keep coverage honest',
  async () => {
    if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCOUNT_RELAY_DATABASE_URL || !Bun.env.FUSEKI_URL
      || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
      throw new Error('Run through the isolated QA integration tier');
    }
    const directory = resolve('.temp', `owner-outbox-${randomUUID()}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL, max: 2 });
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const lineage = { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
      routingEpoch: Bun.env.MAIN_ROUTING_EPOCH };
    const env = { fuseki, lineage, objectDirectory: directory };
    const consumer = `owner-outbox-${randomUUID()}`;
    try {
      await initializeFreshGraph(fuseki, lineage);
      const title = `Owner outbox ${randomUUID()}`;
      await activateMetadataWork(env, { title,
        admission: { id: randomUUID(), scope: 'work:create:root', action: 'work.create',
          idempotencyKey: `owner-outbox-${randomUUID()}`,
          requestDigest: metadataWorkRequestDigest(title), authorityEpoch: '0',
          expiresAt: new Date(Date.now() + 60_000).toISOString() } });
      await initializeRelayCheckpoint(relay, consumer, lineage.dataEpoch);
      await expect(relayMainOutboxOnce(fuseki, relay, consumer, {
        afterDelivery: async () => { throw new Error('crash before checkpoint ACK'); },
      })).rejects.toThrow('crash before checkpoint ACK');
      expect((await relay.query<{ sequence: string }>(
        'SELECT sequence::text FROM relay.checkpoint WHERE consumer = $1', [consumer]))
        .rows[0]?.sequence).toBe('0');
      expect((await relay.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM relay.delivered_event WHERE data_epoch = $1',
        [lineage.dataEpoch])).rows[0]?.count).toBe('1');
      await expect(relayCoverage(relay, consumer)).rejects.toBeInstanceOf(RelayCheckpointConflict);
      expect((await relayMainOutboxOnce(fuseki, relay, consumer))?.sequence).toBe('1');
      expect((await relay.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM relay.delivered_event WHERE data_epoch = $1',
        [lineage.dataEpoch])).rows[0]?.count).toBe('1');

      const empty = `urn:rezics:outbox:${randomUUID()}`;
      await fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
        DELETE { GRAPH <urn:rezics:graph:control> {
          <urn:rezics:dataset:product> rv:sequence 1 } }
        INSERT { GRAPH <urn:rezics:graph:control> {
          <urn:rezics:dataset:product> rv:sequence 2 }
          GRAPH <urn:rezics:graph:outbox> { <${empty}> a rv:OutboxBatch ;
            rv:dataEpoch "${lineage.dataEpoch}" ; rv:sequence 2 ; rv:eventCount 0 . } }
        WHERE { GRAPH <urn:rezics:graph:control> {
          <urn:rezics:dataset:product> rv:sequence 1 } }`);
      await expect(relayMainOutboxOnce(fuseki, relay, consumer, {
        afterDelivery: async () => { throw new Error('crash after empty batch'); },
      })).rejects.toThrow('crash after empty batch');
      await expect(relayCoverage(relay, consumer)).rejects.toBeInstanceOf(RelayCheckpointConflict);
      expect((await relayMainOutboxOnce(fuseki, relay, consumer))?.eventIds).toEqual([]);
      const coverage = await relayCoverage(relay, consumer);
      expect(coverage).toMatchObject({ sequence: '2', batchCount: '2', eventCount: '1' });
      const saved = (await relay.query<{ batch_id: string; routing_epoch: string;
        event_count: number }>(`SELECT batch_id, routing_epoch, event_count
        FROM relay.delivered_batch WHERE data_epoch = $1 AND sequence = 2`,
      [lineage.dataEpoch])).rows[0];
      if (!saved) throw new Error('retained empty batch is absent');
      await relay.query('DELETE FROM relay.delivered_batch WHERE data_epoch = $1 AND sequence = 2',
        [lineage.dataEpoch]);
      await expect(relayCoverage(relay, consumer)).rejects.toBeInstanceOf(RelayCheckpointConflict);
      await relay.query(`INSERT INTO relay.delivered_batch
        (data_epoch, sequence, batch_id, routing_epoch, event_count) VALUES ($1,2,$2,$3,$4)`,
      [lineage.dataEpoch, saved.batch_id, saved.routing_epoch, saved.event_count]);
      expect(await relayCoverage(relay, consumer)).toEqual(coverage);
    } finally {
      await relay.end();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
