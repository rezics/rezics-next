import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { DiscoveryRefreshStore } from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { DiscoveryRefreshWorker } from '../../../services/main/src/modules/discovery/refresh.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { startMediaStack } from './media-support.ts';

test('Discovery incremental: appended Works preserve a partial pin and a moved read commits no rows', async () => {
  const stack = await startMediaStack('discovery-incremental');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    const member = await stack.member('writer');
    const originals = [await stack.publicWork(member.actor), await stack.publicWork(member.actor)];
    const consumer = `discovery-${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, stack.env.lineage.dataEpoch);
    const drain = async () => { for (let i = 0; i < 100; i++) if (!await relayMainOutboxOnce(stack.fuseki, relay, consumer)) return; };
    await drain();
    const projection = new DiscoveryProjection(stack.accessPool), store = new DiscoveryRefreshStore(stack.accessPool);
    const deps = { environment: stack.env, access: stack.access, account: { verify: async () => member.principal },
      relayPosition: new RelayHandoffPositions(relay, consumer) };
    const tick = async () => {
      await stack.accessPool.query("UPDATE access.discovery_refresh SET due_at = clock_timestamp() - interval '1 second'");
      return new DiscoveryRefreshWorker(deps, store, projection).tick();
    };
    // Force a legal checkpoint boundary within the small fixture's batch.
    const commit = projection.commitBatch.bind(projection);
    projection.commitBatch = (operator, id, lease, checkpoint, result, position) => commit(operator, id, lease, checkpoint,
      { items: result.items.slice(0, 1), after: result.items[0]!.work, complete: false }, position);
    expect(await tick()).toBe('advanced');
    projection.commitBatch = commit;
    const pinned = (await stack.accessPool.query('SELECT generation_id, source_sequence::text FROM access.discovery_generation')).rows[0];
    const appended = await stack.publicWork(member.actor);
    await drain();
    expect(await tick()).toBe('activated');
    const retained = (await stack.accessPool.query('SELECT source_sequence::text, work_count FROM access.discovery_generation WHERE generation_id = $1', [pinned.generation_id])).rows[0];
    expect(retained).toEqual({ source_sequence: pinned.source_sequence, work_count: '2' });
    expect((await stack.accessPool.query(`SELECT work FROM access.discovery_entry
      WHERE generation_id = $1 AND work_type = '' AND term = '' ORDER BY work`, [pinned.generation_id])).rows.map(row => row.work))
      .toEqual(originals.map(work => work.work).sort());

    // Mutate after the source SELECT returns, before workRead's final fence.
    const query = stack.fuseki.query.bind(stack.fuseki);
    let inject = true;
    stack.fuseki.query = async (sparql, bytes) => {
      const result = await query(sparql, bytes);
      if (inject && sparql.includes('SELECT DISTINCT ?work ?head ?main')) {
        inject = false;
        await stack.publicWork(member.actor);
      }
      return result;
    };
    expect(await tick()).toBe('retry');
    stack.fuseki.query = query;
    const pending = (await stack.accessPool.query(`SELECT d.generation_id, d.complete, d.work_count,
      g.lease_expires_at <= clock_timestamp() AS released FROM access.discovery_generation d
      JOIN access.derived_generation g ON g.id = d.generation_id WHERE g.state = 'building'`)).rows[0];
    expect(pending).toMatchObject({ complete: false, work_count: '2', released: true });
    expect((await stack.accessPool.query('SELECT count(*) FROM access.discovery_entry WHERE generation_id = $1 AND work = $2',
      [pending.generation_id, appended.work])).rows[0].count).toBe('0');
    await drain();
    expect(await tick()).toBe('activated');
    expect((await stack.accessPool.query('SELECT work_count FROM access.discovery_generation WHERE generation_id = $1', [pending.generation_id])).rows[0].work_count).toBe('3');
    expect(await tick()).toBe('activated');
    expect((await stack.accessPool.query(`SELECT d.work_count FROM access.discovery_generation d
      JOIN access.derived_generation_head h ON h.active_generation = d.generation_id`)).rows[0].work_count).toBe('4');
  } finally { await relay.end(); await stack.stop(); }
}, 120_000);
