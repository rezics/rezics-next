import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DiscoveryProjection, discoveryScopeKey } from '../../../services/main/src/modules/discovery/store.ts';
import { DiscoveryRefreshStore, DISCOVERY_REFRESH_COST } from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { DiscoveryRefreshWorker } from '../../../services/main/src/modules/discovery/refresh.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { RecommendationUnavailable } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { cloneOwners, meteredPool, requireQa } from './recommendation-support.ts';
import { startMediaStack } from './media-support.ts';

test('Discovery refresh expires already purged superseded generations and resumes a ready checkpoint', async () => {
  const owners = await cloneOwners(requireQa(), ['access', 'content', 'relay']);
  const f = await startMediaStack('discovery-retirement', { ownerUrls: owners.urls });
  const relay = new Pool({ connectionString: owners.urls.relay });
  try {
    const writer = await f.member('retirement writer');
    const work = await f.publicWork(writer.actor, ['en'], 'Retained public Work');
    const consumer = `discovery-${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, f.env.lineage.dataEpoch);
    for (let i = 0; i < 100; i++) {
      if (!await relayMainOutboxOnce(f.fuseki, relay, consumer)) break;
      if (i === 99) throw new Error('Fixture relay exceeded its batch bound');
    }
    const position = new RelayHandoffPositions(relay, consumer);
    const meter = meteredPool(f.accessPool);
    const projection = new DiscoveryProjection(meter.pool), store = new DiscoveryRefreshStore(meter.pool);
    const worker = new DiscoveryRefreshWorker({ environment: f.env, access: f.access,
      discovery: projection, relayPosition: position }, store, projection);
    const basis = { scope: 'global' as const, realm: null, context: null, owner: null };
    const key = discoveryScopeKey(basis);
    await store.enroll([basis]);
    await f.accessPool.query("UPDATE access.discovery_refresh_catalog SET due_at=clock_timestamp()+interval '1 hour'");
    const tick = async () => {
      await f.accessPool.query(`UPDATE access.discovery_refresh SET due_at=clock_timestamp()-interval '1 second'
        WHERE scope_key=$1`, [key]);
      const statements = meter.count(), queries = f.fuseki.queries;
      const outcome = await worker.tick();
      expect(meter.count() - statements).toBeLessThanOrEqual(DISCOVERY_REFRESH_COST.localStatements);
      expect(f.fuseki.queries - queries).toBeLessThanOrEqual(DISCOVERY_REFRESH_COST.graphCalls);
      return outcome;
    };
    const active = async () => (await f.accessPool.query(`SELECT active_generation FROM access.derived_generation_head
      WHERE family='discovery' AND scope_key=$1`, [key])).rows[0].active_generation as string;
    const invalidate = () => f.accessPool.query('INSERT INTO access.discovery_source_change DEFAULT VALUES');
    expect(await tick()).toBe('activated');
    const first = await active();
    // A safety-fence change requires independent storage instead of a delta.
    await invalidate();
    expect(await tick()).toBe('activated');
    await f.accessPool.query(`UPDATE access.derived_generation SET finished_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, [first]);
    await f.accessPool.query(`UPDATE access.discovery_retirement SET due_at=clock_timestamp()-interval '1 second' WHERE generation_id=$1`, [first]);
    await store.purge();
    expect((await f.accessPool.query('SELECT 1 FROM access.discovery_generation WHERE generation_id=$1', [first])).rows).toHaveLength(0);
    expect((await f.accessPool.query('SELECT state FROM access.derived_generation WHERE id=$1', [first])).rows[0].state).toBe('superseded');
    await invalidate();
    expect(await tick()).toBe('activated');
    await invalidate();
    // An outage after the final batch leaves a ready checkpoint, just as on the
    // shared stack. Its retry must activate without re-enqueuing purged data.
    const activate = projection.activate.bind(projection);
    const cause = Object.assign(new Error('activation interrupted'), { code: '08006' });
    projection.activate = async () => { throw new RecommendationUnavailable('Access owner is unavailable', { cause }); };
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await tick()).toBe('retry');
      expect(logged).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toEqual({
        level: 'error', event: 'worker_fault', 'rezics.worker.name': 'main.discovery.refresh',
        'error.class': 'RecommendationUnavailable', 'error.code': '08006',
      });
      expect(String(logged.mock.calls[0]?.[0])).not.toContain('activation interrupted');
    } finally { projection.activate = activate; logged.mockRestore(); }
    const pending = (await f.accessPool.query(`SELECT j.generation_id,g.state FROM access.discovery_refresh j
      JOIN access.derived_generation g ON g.id=j.generation_id WHERE j.scope_key=$1`, [key])).rows[0];
    expect(pending.state).toBe('ready');
    expect(await tick()).toBe('activated');
    expect(await active()).toBe(pending.generation_id);
    expect((await f.accessPool.query('SELECT state FROM access.derived_generation WHERE id=$1', [first])).rows[0].state).toBe('expired');
    expect((await f.accessPool.query('SELECT 1 FROM access.discovery_retirement WHERE generation_id=$1', [first])).rows).toHaveLength(0);
    expect(await tick()).toBe('current');
    const current = await projection.active(basis, (await position.read())!);
    expect(current.stale).toBe(false);
    const page = await projection.page(current, 'recent', '', '', 20);
    expect(page.map(item => item.work)).toContain(work.work);
  } finally { await relay.end(); await f.stop(); await owners.close(); }
}, 240_000);
