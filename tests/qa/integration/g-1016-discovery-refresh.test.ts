import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { DiscoveryProjection, discoveryScopeKey } from '../../../services/main/src/modules/discovery/store.ts';
import { DiscoveryRefreshStore, DISCOVERY_REFRESH_COST } from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { DiscoveryRefreshWorker } from '../../../services/main/src/modules/discovery/refresh.ts';
import { DiscoveryRefreshInputs } from '../../../services/main/src/modules/discovery/source.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { RecommendationStale } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { automaticDiscovery } from '../../../services/main/src/modules/discovery/automation.ts';
import { startMediaStack } from './media-support.ts';

test('G1016: Discovery resumes one generation under steady appends after graph outbox pruning, and rejects unsafe gaps', async () => {
  const f = await startMediaStack('g-1016-refresh');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    const writer = await f.member('G1016 writer');
    const originals = [];
    for (let i = 0; i < 6; i++) originals.push(await f.publicWork(writer.actor, ['en'], `Original ${i}`));
    await writer.grant(`work:edit:${originals[0]!.work}`, 'work.edit');
    const consumer = `g1016-${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, f.env.lineage.dataEpoch);
    const drain = async () => {
      for (let i = 0; i < 100; i++) if (!await relayMainOutboxOnce(f.fuseki, relay, consumer)) return;
      throw new Error('Fixture relay exceeded its batch bound');
    };
    await drain();
    const inputs = new DiscoveryRefreshInputs(relay, consumer);
    const projection = new DiscoveryProjection(f.accessPool), store = new DiscoveryRefreshStore(f.accessPool);
    const basis = { scope: 'global' as const, realm: null, context: null, owner: null };
    const key = discoveryScopeKey(basis);
    const deps = { environment: f.env, access: f.access, discovery: projection,
      discoveryRefreshInputs: inputs, account: { verify: async () => writer.principal },
      relayPosition: new RelayHandoffPositions(relay, consumer) };
    await store.enroll([basis]);
    const originalCommit = projection.commitBatch.bind(projection);
    // One original per batch creates six durable checkpoints in this small
    // fixture. Projection reads, SQL rows and source fences remain real.
    projection.commitBatch = (operator, id, lease, checkpoint, result, position) => {
      const first = result.items[0];
      return originalCommit(operator, id, lease, checkpoint, result.items.length > 1
        ? { after: first!.work, complete: false, items: [first!] } : result, position);
    };
    let ticks = 0, maxCalls = 0, maxMs = 0;
    const tick = async () => {
      await f.accessPool.query(`UPDATE access.discovery_refresh SET due_at=clock_timestamp()-interval '1 second'
        WHERE scope_key=$1`, [key]);
      const before = f.fuseki.queries, started = performance.now();
      const outcome = await new DiscoveryRefreshWorker(deps, store, projection).tick();
      ticks++; maxCalls = Math.max(maxCalls, f.fuseki.queries - before);
      maxMs = Math.max(maxMs, performance.now() - started);
      expect(f.fuseki.queries - before).toBeLessThanOrEqual(DISCOVERY_REFRESH_COST.graphCalls);
      return outcome;
    };
    expect(await tick()).toBe('advanced');
    const pending = (await f.accessPool.query(`SELECT d.generation_id,d.source_sequence::text,d.checkpoint,
      i.checkpoint_sequence::text AS validated FROM access.discovery_generation d
      JOIN access.derived_generation g ON g.id=d.generation_id
      JOIN access.derived_generation_input i ON i.generation_id=g.id AND i.source='main-graph'
      WHERE g.state='building'`)).rows[0];
    let checkpoint = pending.checkpoint;
    const appended = [];
    for (let i = 0; i < 5; i++) {
      appended.push(await f.publicWork(writer.actor, ['en'], `Appended ${i}`));
      await drain();
      // Model the real graph's outbox retention boundary: the durable relay
      // handoff is the only remaining evidence for every intervening write.
      await f.fuseki.update(`DELETE WHERE { GRAPH ${iri(GRAPHS.outbox)} { ?s ?p ?o } }`);
      expect(await tick()).toBe('advanced');
      const row = (await f.accessPool.query(`SELECT d.generation_id,d.source_sequence::text,d.checkpoint,
        d.work_count::text,g.state,i.checkpoint_sequence::text AS validated
        FROM access.discovery_generation d JOIN access.derived_generation g ON g.id=d.generation_id
        JOIN access.derived_generation_input i ON i.generation_id=g.id AND i.source='main-graph'
        WHERE d.generation_id=$1`, [pending.generation_id])).rows[0];
      expect(row.generation_id).toBe(pending.generation_id);
      if (i < 4) {
        expect(row.source_sequence).toBe(pending.source_sequence);
        expect(row.checkpoint > checkpoint).toBe(true);
      } else {
        expect(BigInt(row.source_sequence)).toBeGreaterThan(BigInt(pending.source_sequence));
        expect(row.checkpoint).toBe('');
      }
      checkpoint = row.checkpoint;
      expect(BigInt(row.validated)).toBeGreaterThan(BigInt(pending.validated));
      pending.validated = row.validated;
      expect(Number(row.work_count)).toBe(i + 2);
    }
    const projected = (await f.accessPool.query(`SELECT work FROM access.discovery_entry
      WHERE generation_id=$1 AND work_type='' AND term='' ORDER BY work`, [pending.generation_id])).rows.map(row => row.work);
    expect(projected).toEqual(originals.map(work => work.work).sort());
    expect(projected.some((work: string) => appended.some(item => item.work === work))).toBe(false);
    expect((await f.accessPool.query(`SELECT state,count(*)::text AS count FROM access.derived_generation
      WHERE family='discovery' GROUP BY state`)).rows).toEqual([{ state: 'building', count: '1' }]);
    const measurements = { ticks, appendedWorks: appended.length, projectedWorks: projected.length,
      generations: 1, cancelled: 0, maxCalls, maxMs: Math.ceil(maxMs) };
    console.log(`G1016 Discovery measured: ${JSON.stringify(measurements)}`);
    await Bun.write(new URL(`../../../.temp/g-1016-refresh-${Bun.env.REZICS_QA_RUN_ID}.json`, import.meta.url), JSON.stringify(measurements));

    // The same generation reconciles its durable changed-Work journal after
    // the original scan, even when graph outbox coverage has been pruned.
    projection.commitBatch = originalCommit;
    expect(await tick()).toBe('activated');
    const active = (await f.accessPool.query(`SELECT d.generation_id,d.work_count::text,d.changed_works FROM access.discovery_generation d
      JOIN access.derived_generation_head h ON h.active_generation=d.generation_id WHERE h.scope_key=$1`, [key])).rows[0];
    expect(active.work_count).toBe('11');
    expect(active.changed_works).toEqual(appended.map(work => work.work).sort());

    // A moved multi-query read leaves both the population checkpoint and its
    // validation watermark untouched, releasing the step for the next tick.
    await f.publicWork(writer.actor, ['en'], 'Start another refresh');
    await drain();
    projection.commitBatch = (operator, id, lease, checkpoint, result, position) =>
      originalCommit(operator, id, lease, checkpoint, { ...result, complete: false }, position);
    expect(await tick()).toBe('advanced');
    projection.commitBatch = originalCommit;
    const building = (await f.accessPool.query(`SELECT d.generation_id,d.checkpoint,d.work_count::text,
      i.checkpoint_sequence::text AS validated FROM access.discovery_generation d
      JOIN access.derived_generation g ON g.id=d.generation_id
      JOIN access.derived_generation_input i ON i.generation_id=g.id AND i.source='main-graph'
      WHERE g.state='building'`)).rows[0];
    const nativeQuery = f.fuseki.query.bind(f.fuseki);
    let inject = true;
    f.fuseki.query = async (query, bytes) => {
      const result = await nativeQuery(query, bytes);
      if (inject && query.includes('SELECT ?epoch ?prior')) {
        inject = false;
        await f.publicWork(writer.actor, ['en'], 'Write during source scan');
      }
      return result;
    };
    expect(await tick()).toBe('retry');
    f.fuseki.query = nativeQuery;
    const unchanged = (await f.accessPool.query(`SELECT d.checkpoint,d.work_count::text,i.checkpoint_sequence::text AS validated,
      g.lease_expires_at<=clock_timestamp() AS released FROM access.discovery_generation d
      JOIN access.derived_generation g ON g.id=d.generation_id
      JOIN access.derived_generation_input i ON i.generation_id=g.id AND i.source='main-graph'
      WHERE d.generation_id=$1`, [building.generation_id])).rows[0];
    expect(unchanged).toEqual({ checkpoint: building.checkpoint, work_count: building.work_count,
      validated: building.validated, released: true });
    await drain();
    // Edits to original Works join the catch-up journal instead of cancelling
    // the scan. Reconciliation prevents mixed-position activation.
    const originalHead = (await f.fuseki.query(`SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(originals[0]!.work)} <https://rezics.com/vocab/head> ?head }
    } LIMIT 1`)).results!.bindings[0]!.head!.value;
    const edited = await writer.send('PUT', `/v1/works/${originals[0]!.work.slice(-36)}/type`, {
      profile: 'work-type-v3', expectedHead: originalHead,
      types: ['https://schema.org/Book'], actingSubject: writer.actor,
    }, randomUUID());
    expect(edited.status, await edited.text()).toBe(200);
    await drain();
    await f.fuseki.update(`DELETE WHERE { GRAPH ${iri(GRAPHS.outbox)} { ?s ?p ?o } }`);
    expect(await tick()).toBe('advanced');
    expect((await f.accessPool.query('SELECT state FROM access.derived_generation WHERE id=$1',
      [building.generation_id])).rows[0].state).toBe('building');
    expect(await tick()).toBe('activated');
    // A stale refresh claim cannot overwrite validation evidence.
    await f.accessPool.query(`UPDATE access.discovery_refresh SET due_at=clock_timestamp()-interval '1 second' WHERE scope_key=$1`, [key]);
    const old = await store.claim();
    await f.accessPool.query(`UPDATE access.discovery_refresh SET due_at=clock_timestamp()-interval '1 second' WHERE scope_key=$1`, [key]);
    await store.claim();
    await expect(store.validated(old!, await projection.view(automaticDiscovery(null), active.generation_id),
      '999')).rejects.toBeInstanceOf(RecommendationStale);
    // A missing batch remains a hard restart boundary, never an optimistic
    // partial relation. Corrupt only the isolated fixture's retained evidence.
    await relay.query('DELETE FROM relay.delivered_event WHERE data_epoch=$1 AND sequence=$2',
      [f.env.lineage.dataEpoch, pending.validated]);
    expect(await inputs.read({ dataEpoch: f.env.lineage.dataEpoch, sequence: pending.validated }, pending.source_sequence)).toBeNull();
  } finally { await relay.end(); await f.stop(); }
}, 240_000);
