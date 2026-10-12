import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { DiscoveryRefreshStore } from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { DiscoveryRefreshWorker } from '../../../services/main/src/modules/discovery/refresh.ts';
import { DiscoveryRefreshInputs } from '../../../services/main/src/modules/discovery/source.ts';
import { DiscoveryProjection, discoveryScopeKey } from '../../../services/main/src/modules/discovery/store.ts';
import {
  initializeRelayCheckpoint,
  relayMainOutboxOnce,
  type CustodiedOutboxSource,
  type MainCloudEvent,
} from '../../../services/main/src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE, RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { WORK_READ_COST } from '../../../services/main/src/modules/work/read-contract.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../../../services/main/src/routes/dependencies.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { startMediaStack } from './media-support.ts';
import { requireQa } from './recommendation-support.ts';

const RETAINED_BATCHES = 16_000;
const DELTA_BATCHES = 256;

test('discovery refresh activates within its deadline with 16,000 retained relay batches', async () => {
  const owners = await cloneQaOwnerDatabases(requireQa(), ['access', 'content', 'relay'], 'privileged');
  const f = await startMediaStack('discovery-refresh-growth', { ownerUrls: owners.urls });
  const relay = new Pool({ connectionString: owners.urls.relay });
  try {
    const writer = await f.member('refresh writer');
    const original = await f.publicWork(writer.actor, ['en'], 'Before retained history');
    const consumer = `discovery-${randomUUID()}`;
    const dataEpoch = f.env.lineage.dataEpoch;
    const routingEpoch = f.env.lineage.routingEpoch;
    await initializeRelayCheckpoint(relay, consumer, dataEpoch);
    const position = new RelayHandoffPositions(relay, consumer);
    const projection = new DiscoveryProjection(f.accessPool);
    const store = new DiscoveryRefreshStore(f.accessPool);
    const inputs = new DiscoveryRefreshInputs(relay, consumer);
    let inputReads = 0;
    let changes: Awaited<ReturnType<DiscoveryRefreshInputs['read']>> | undefined;
    const deps: Partial<MainWorkDependencies> = {
      environment: f.env,
      access: f.access,
      discovery: projection,
      relayPosition: position,
      discoveryRefreshInputs: {
        async read(...args: Parameters<DiscoveryRefreshInputs['read']>) {
          inputReads++;
          changes = await inputs.read(...args);
          return changes;
        },
      },
    };
    const worker = new DiscoveryRefreshWorker(deps as MainWorkDependencies, store, projection);
    const basis = { scope: 'global' as const, realm: null, context: null, owner: null };
    const key = discoveryScopeKey(basis);
    await store.enroll([basis]);
    await f.accessPool.query("UPDATE access.discovery_refresh_catalog SET due_at=clock_timestamp()+interval '1 hour'");
    const tick = async () => {
      await f.accessPool.query(`UPDATE access.discovery_refresh SET due_at=clock_timestamp()-interval '1 second'
        WHERE scope_key=$1`, [key]);
      return worker.tick();
    };
    // Earlier files share the QA graph; finish its bounded pages before adding history.
    let outcome = await tick();
    for (let page = 1; outcome === 'advanced' && page < 100; page++) outcome = await tick();
    expect(outcome).toBe('activated');
    const initialPosition = await workRead(deps as MainWorkDependencies,
      new Request('http://main.internal/discovery-refresh'), {}, async session => session.position);
    const initial = await projection.active(basis, initialPosition);
    const appended = await f.publicWork(writer.actor, ['en'], 'After retained history');
    const current = await workRead(deps as MainWorkDependencies,
      new Request('http://main.internal/discovery-refresh'), {}, async session => session.position);
    expect(BigInt(current.sequence)).toBeGreaterThan(BigInt(initial.source_sequence));

    const namespace = randomUUID();
    const ownerOutbox: CustodiedOutboxSource = {
      async read(epoch, sequence) {
        if (epoch !== dataEpoch || BigInt(sequence) < 1n || BigInt(sequence) > BigInt(RETAINED_BATCHES)) return null;
        const historical = Number(sequence) <= RETAINED_BATCHES - DELTA_BATCHES;
        const graphSequence = historical ? initial.source_sequence : current.sequence;
        const batchId = `urn:rezics:refresh-history:${namespace}:batch:${sequence}`;
        const eventId = `urn:rezics:refresh-history:${namespace}:event:${sequence}`;
        const receiptId = `urn:rezics:refresh-history:${namespace}:receipt:${sequence}`;
        const event: MainCloudEvent = {
          specversion: '1.0',
          id: eventId,
          source: 'https://rezics.com/services/main',
          type: 'com.rezics.work.edited.v1',
          datacontenttype: 'application/json',
          data: {
            batchId,
            sourcePosition: { datasetId: 'product', dataEpoch, sequence: graphSequence },
            relayPosition: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch, sequence },
            routingEpoch,
            ordinal: 0,
            receipt: {
              id: receiptId,
              action: 'work.edit',
              outcome: 'succeeded',
              admissionId: namespace,
              requestDigest: 'a'.repeat(64),
              authorityEpoch: '1',
              scope: 'work:edit:fixture',
              work: historical ? original.work : appended.work,
            },
          },
        };
        return {
          batch: { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch, sequence, graphSequence,
            routingEpoch, batchId, eventIds: [eventId], custodiedReceipt: receiptId },
          events: [event],
        };
      },
    };
    // Supply only the source control response. Every retained header, envelope and
    // checkpoint is written by relayMainOutboxOnce's production retain/deliver path.
    const source = new FusekiClient(Bun.env.FUSEKI_URL!);
    source.query = async sparql => {
      if (!sparql.includes('SELECT ?controlSequence ?routing ?hold ?batch ?eventCount ?graphSequence')) {
        throw new Error('Unexpected query while retaining fixture custody');
      }
      return { results: { bindings: [{
        controlSequence: { type: 'literal', value: String(RETAINED_BATCHES) },
        routing: { type: 'literal', value: routingEpoch },
      }] } };
    };
    for (let sequence = 1; sequence <= RETAINED_BATCHES; sequence++) {
      const retained = await relayMainOutboxOnce(source, relay, consumer, { ownerOutbox });
      if (retained?.sequence !== String(sequence)) throw new Error('Fixture relay did not retain the next batch');
    }
    expect(await relayMainOutboxOnce(source, relay, consumer, { ownerOutbox })).toBeNull();
    expect((await relay.query<{ batches: string; events: string }>(`SELECT
      (SELECT count(*)::text FROM relay.delivered_batch WHERE data_epoch=$1) AS batches,
      (SELECT count(*)::text FROM relay.delivered_event WHERE data_epoch=$1) AS events`, [dataEpoch])).rows[0])
      .toEqual({ batches: String(RETAINED_BATCHES), events: String(RETAINED_BATCHES) });
    await relay.query('ANALYZE relay.delivered_batch');
    await relay.query('ANALYZE relay.delivered_event');

    inputReads = 0;
    const started = performance.now();
    outcome = await tick();
    const elapsedMs = performance.now() - started;
    console.info(JSON.stringify({ capability: 'discovery-refresh', retainedBatches: RETAINED_BATCHES,
      deltaBatches: DELTA_BATCHES, elapsedMs, deadlineMs: WORK_READ_COST.deadlineMs, outcome }));
    expect(outcome).toBe('activated');
    expect(elapsedMs).toBeLessThan(WORK_READ_COST.deadlineMs);
    expect(inputReads).toBe(1);
    expect(changes).toEqual({ works: [appended.work], created: [] });
    const active = await projection.active(basis, current);
    expect(active.generation_id).not.toBe(initial.generation_id);
    expect(active.covered_sequence).toBe(current.sequence);
    expect(active.stale).toBe(false);
    expect((await f.accessPool.query(`SELECT work FROM access.discovery_entry
      WHERE generation_id=$1 AND work=$2 AND work_type='' AND term=''`,
    [active.storage_generation ?? active.generation_id, appended.work])).rows)
      .toEqual([{ work: appended.work }]);
  } finally {
    await relay.end();
    await f.stop();
    await owners.close();
  }
}, 600_000);
