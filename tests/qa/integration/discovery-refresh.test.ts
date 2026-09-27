import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { DiscoveryProjection, discoveryScopeKey } from '../../../services/main/src/modules/discovery/store.ts';
import { DiscoveryRefreshWorker } from '../../../services/main/src/modules/discovery/refresh.ts';
import { DISCOVERY_REFRESH_COST, DiscoveryRefreshStore } from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { RecommendationStale, RecommendationUnavailable } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { authorCreditTriples } from '../../../services/main/src/modules/work/author-credit.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { WorkReadUnavailable } from '../../../services/main/src/modules/work/read-session.ts';
import { startMediaStack } from './media-support.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
const native = () => `https://rezics.com/id/${randomUUID()}`;
interface Page { items: { id: string; rating: { mean: number }; primaryCredits: { key: string; ordinal: number; displayName: null }[] }[];
  nextCursor: string | null }

test('Discovery scheduled refresh: relay gating, automatic enrollment, restart, leases, Mine isolation and bounded work', async () => {
  const stack = await startMediaStack('discovery-refresh');
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    const a = await stack.member('a');
    const first = await stack.publicWork(a.actor, ['en'], 'First');
    await stack.publicWork(a.actor, ['en'], 'Second');
    await stack.privateWork(a.actor, 'Never discover');
    // Native projection fixture: ordering and truncation, not credit-adoption acceptance.
    const creditRows = [4, 1, 3, 0, 2].map(ordinal => authorCreditTriples({ work: first.work,
      credit: native(), revision: native(), expectedHead: native(), sourceKey: `/authors/OL${ordinal + 1}A`,
      sourceRoleKey: null, nativeOrdinal: ordinal, actingSubject: a.actor }, stack.env.lineage.dataEpoch, '1'));
    await stack.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> PREFIX schema: <https://schema.org/>
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${creditRows.map(row => row.current).join('\n')} }
        GRAPH ${iri(GRAPHS.revisions)} { ${creditRows.map(row => row.revision).join('\n')} } }`);
    const consumer = `discovery-${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, stack.env.lineage.dataEpoch);
    const drain = async () => {
      for (let i = 0; i < 200; i++) if (!await relayMainOutboxOnce(stack.fuseki, relay, consumer)) return;
      throw new Error('Fixture relay exceeded 200 batches');
    };
    const projection = new DiscoveryProjection(stack.accessPool);
    const store = new DiscoveryRefreshStore(stack.accessPool);
    const deps = { environment: stack.env, access: stack.access, media: stack.media,
      judgments: new AccessJudgments(stack.accessPool), account: { verify: async () => a.principal },
      discovery: projection, relayPosition: new RelayHandoffPositions(relay, consumer) };
    const app = createMainApp(stack.fuseki, deps);
    const read = (query = '') => app.handle(new Request(`http://main.local/v1/works${query}`));
    const worker = () => new DiscoveryRefreshWorker(deps, store, projection);
    const base = { scope: 'global' as const, realm: null, context: null, owner: null };
    const key = discoveryScopeKey(base);
    await store.enroll([base]);
    const due = async () => {
      await stack.accessPool.query("UPDATE access.discovery_refresh SET due_at = due_at - interval '1 minute'");
      await stack.accessPool.query("UPDATE access.discovery_refresh_catalog SET due_at = clock_timestamp() - interval '1 second'");
    };
    expect(await worker().tick()).toBe('relay-behind');
    expect((await read()).status).toBe(503);
    expect((await stack.accessPool.query('SELECT count(*) FROM access.discovery_generation')).rows[0].count).toBe('0');
    await drain();
    let maxQueries = 0, maxMs = 0, ticks = 0;
    const tick = async () => {
      await due();
      const before = (await stack.accessPool.query('SELECT coalesce(sum(work_count),0)::text AS count FROM access.discovery_generation')).rows[0].count;
      const queries = stack.fuseki.queries, started = performance.now();
      const outcome = await worker().tick(); // New process object each step exercises durable resume.
      const elapsed = performance.now() - started;
      const graphCalls = stack.fuseki.queries - queries;
      maxQueries = Math.max(maxQueries, graphCalls); maxMs = Math.max(maxMs, elapsed); ticks++;
      const after = (await stack.accessPool.query('SELECT coalesce(sum(work_count),0)::text AS count FROM access.discovery_generation')).rows[0].count;
      expect(BigInt(after) - BigInt(before)).toBeLessThanOrEqual(BigInt(DISCOVERY_REFRESH_COST.worksPerTick));
      expect(graphCalls).toBeLessThanOrEqual(DISCOVERY_REFRESH_COST.graphCalls);
      expect(elapsed).toBeLessThan(25_000); // Two sequential 10 s graph envelopes plus Access overhead.
      expect(outcome).not.toBe('retry');
      return outcome;
    };
    expect(await tick()).toBe('advanced');
    const obsolete = (await stack.accessPool.query('SELECT generation_id FROM access.discovery_generation')).rows[0].generation_id;
    // Write between checkpoints: the old partial population must never activate.
    const third = await stack.publicWork(a.actor, ['en'], 'Third');
    await drain();
    expect(await tick()).toBe('advanced');
    expect((await stack.accessPool.query('SELECT state FROM access.derived_generation WHERE id = $1', [obsolete])).rows[0].state)
      .toBe('cancelled');
    expect(await tick()).toBe('advanced');
    // Crash/outage after the last checkpoint: the exact ready generation survives.
    const activate = projection.activate.bind(projection);
    projection.activate = async () => { throw new WorkReadUnavailable('Fixture activation outage'); };
    try { await due(); expect(await worker().tick()).toBe('retry'); }
    finally { projection.activate = activate; }
    const ready = (await stack.accessPool.query(`SELECT g.id, g.state FROM access.discovery_refresh j
      JOIN access.derived_generation g ON g.id = j.generation_id WHERE j.scope_key = $1`, [key])).rows[0];
    expect(ready.state).toBe('ready');
    expect(await tick()).toBe('activated');
    expect((await stack.accessPool.query('SELECT active_generation FROM access.derived_generation_head WHERE scope_key = $1', [key])).rows[0].active_generation)
      .toBe(ready.id);
    for (let i = 0; i < 8 && (await read()).status !== 200; i++) await tick();
    const page = await json<Page>(await read('?limit=1'));
    expect(page.items[0]?.id).toBe(third.work);
    const all = await json<Page>(await read());
    expect(all.items).toHaveLength(3);
    expect(all.items.find(item => item.id === first.work)?.primaryCredits)
      .toEqual([0, 1, 2].map(ordinal => ({ id: expect.any(String), role: 'author', participantKind: 'external-reference',
        provider: 'open-library', key: `/authors/OL${ordinal + 1}A`, ordinal, agent: null, displayName: null, handle: null })));
    const active = (await stack.accessPool.query('SELECT active_generation FROM access.derived_generation_head WHERE scope_key = $1', [key])).rows[0].active_generation;
    expect(await tick()).toBe('current');
    expect((await stack.accessPool.query('SELECT active_generation FROM access.derived_generation_head WHERE scope_key = $1', [key])).rows[0].active_generation).toBe(active);

    // Access-only changes also refresh after the relay stays at the same cut.
    const b = await stack.member('b');
    expect((await read()).status).toBe(409);
    await due();
    const held = await store.claim();
    expect(held).not.toBeNull();
    expect(await store.claim()).toBeNull();
    await due();
    const replacement = await store.claim();
    expect(BigInt(replacement!.lease_epoch)).toBeGreaterThan(BigInt(held!.lease_epoch));
    await expect(store.finish(held!, null, 'current', 0, 0)).rejects.toBeInstanceOf(RecommendationStale);
    for (let i = 0; i < 8 && (await read()).status !== 200; i++) await tick();
    expect((await read()).status).toBe(200);
    expect((await read(`?cursor=${page.nextCursor}`)).status).toBe(409);
    await stack.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id');
    await expect(worker().tick()).rejects.toBeInstanceOf(RecommendationUnavailable);
    await stack.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id');

    // New standing Contexts enroll without operator registration or a browse side effect.
    await a.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const context = await json<{ context: string }>(await a.send('POST', '/v1/global-rating-contexts',
      { profile: 'global-rating-standing-context-v1', question: 'Quality?', actingSubject: a.actor }), 201);
    await a.grant(`rating:observe:${context.context}`, 'rating.observation.set');
    await json(await a.send('POST', '/v1/global-rating-observations', { profile: 'global-rating-standing-observation-v1',
      context: context.context, work: first.work, mainVersion: first.mainVersion, value: 4,
      expectedRevisionHead: null, actingSubject: a.actor }), 201);
    await a.grant('space:create:root', 'space.create');
    const realm = await json<{ realm: string }>(await a.send('POST', '/v1/spaces',
      { profile: 'space-realm-v1', name: 'Refresh Realm', capabilities: ['realm'], actingSubject: a.actor }), 201);
    const unrankedRealm = await json<{ realm: string }>(await a.send('POST', '/v1/spaces',
      { profile: 'space-realm-v1', name: 'Realm without ratings', capabilities: ['realm'], actingSubject: a.actor }), 201);
    await a.grant(`rating:context:${realm.realm}`, 'rating.context.create');
    const local = await json<{ context: string }>(await a.send('POST', '/v1/rating-contexts',
      { profile: 'realm-standing-rating-context-v1', realm: realm.realm, question: 'Realm quality?', actingSubject: a.actor }), 201);
    await a.grant(`rating:observe:${local.context}`, 'rating.observation.set');
    await json(await a.send('POST', '/v1/rating-observations', { profile: 'realm-standing-rating-observation-v1',
      context: local.context, work: third.work, mainVersion: third.mainVersion, value: 9,
      expectedRevisionHead: null, actingSubject: a.actor }), 201);
    await drain();
    const rankingQuery = `?sort=top-rated&context=${encodeURIComponent(context.context)}`;
    for (let i = 0; i < 32 && (await read(rankingQuery)).status !== 200; i++) await tick();
    expect((await json<Page>(await read(rankingQuery))).items.map(item => [item.id, item.rating.mean])).toEqual([[first.work, 4]]);
    const realmQuery = `?scope=realm&realm=${encodeURIComponent(realm.realm)}&sort=top-rated&context=${encodeURIComponent(local.context)}`;
    for (let i = 0; i < 32 && (await read(realmQuery)).status !== 200; i++) await tick();
    expect((await json<Page>(await read(realmQuery))).items.map(item => [item.id, item.rating.mean])).toEqual([[third.work, 9]]);
    const unrankedQuery = `?scope=realm&realm=${encodeURIComponent(unrankedRealm.realm)}`;
    for (let i = 0; i < 32 && (await read(unrankedQuery)).status !== 200; i++) await tick();
    expect((await json<Page>(await read(unrankedQuery))).items).toHaveLength(3);

    // A registered Mine population retains its exact Account owner on refresh.
    await store.enroll([{ ...base, scope: 'mine', context: context.context, owner: a.principalId }]);
    const mineQuery = `?scope=mine&context=${encodeURIComponent(context.context)}&actingSubject=${encodeURIComponent(a.actor)}`;
    const mine = () => app.handle(new Request(`http://main.local/v1/works${mineQuery}`, { headers: { authorization: 'Bearer a' } }));
    for (let i = 0; i < 32 && (await mine()).status !== 200; i++) await tick();
    expect((await json<Page>(await mine())).items.map(item => item.id)).toEqual([first.work]);
    const otherApp = createMainApp(stack.fuseki, { ...deps, account: { verify: async () => b.principal } });
    expect((await otherApp.handle(new Request(`http://main.local/v1/works${mineQuery}`, { headers: { authorization: 'Bearer b' } }))).status).toBe(503);
    await stack.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [a.principalId]);
    expect((await mine()).status).toBe(401);
    await due();
    const outcomes = await Promise.all([worker().tick(), worker().tick()]);
    expect(outcomes).not.toContain('retry');
    expect((await stack.accessPool.query('SELECT count(*) FROM access.discovery_entry WHERE generation_id = $1', [obsolete])).rows[0].count).toBe('0');
    const measurements = { ticks, maxQueries, maxMs: Math.ceil(maxMs), worksPerTick: 1 };
    await Bun.write(new URL(`../../../.temp/discovery-refresh-${Bun.env.REZICS_QA_RUN_ID}.json`, import.meta.url),
      JSON.stringify(measurements));
    console.log(`discovery refresh measured: ${JSON.stringify(measurements)}`);
  } finally { await relay.end(); await stack.stop(); }
}, 240_000);
