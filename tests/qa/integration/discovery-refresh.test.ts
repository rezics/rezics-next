import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { DiscoveryProjection, discoveryScopeKey } from '../../../services/main/src/modules/discovery/store.ts';
import { DiscoveryRefreshWorker } from '../../../services/main/src/modules/discovery/refresh.ts';
import { automaticDiscovery } from '../../../services/main/src/modules/discovery/automation.ts';
import { DISCOVERY_REFRESH_COST, DiscoveryRefreshStore } from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { RecommendationStale, RecommendationUnavailable } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { authorCreditTriples } from '../../../services/main/src/modules/work/author-credit.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { WorkReadUnavailable, workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { startMediaStack } from './media-support.ts';
import { DiscoveryRefreshInputs } from '../../../services/main/src/modules/discovery/source.ts';
import type { OwnedDiscoveryBasis } from '../../../services/main/src/modules/discovery/contract.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';
import { requireQa } from './recommendation-support.ts';
import { isolateDiscoveryProbeGraph } from './discovery-projection-fixture.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
const native = () => `https://rezics.com/id/${randomUUID()}`;
interface Page { items: { id: string; rating: { mean: number }; primaryCredits: { key: string; ordinal: number; displayName: null }[] }[];
  nextCursor: string | null }

test('Discovery scheduled refresh: native source proof, automatic enrollment, restart, leases, Mine isolation and bounded work', async () => {
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
    // Native delta proof admits the population before relay delivery. Interrupt
    // activation to retain the exact ready cut for the restart checks below.
    const initialActivate = projection.activate.bind(projection);
    projection.activate = async () => { throw new WorkReadUnavailable('Fixture activation outage'); };
    try { expect(await worker().tick()).toBe('retry'); }
    finally { projection.activate = initialActivate; }
    expect((await read()).status).toBe(503);
    expect((await stack.accessPool.query(`SELECT d.complete,g.state FROM access.discovery_generation d
      JOIN access.derived_generation g ON g.id=d.generation_id`)).rows)
      .toEqual([{ complete: true, state: 'ready' }]);
    await drain();
    let maxQueries = 0, maxMs = 0, ticks = 0;
    const scheduledWorker = worker();
    const tick = async () => {
      await due();
      const before = (await stack.accessPool.query('SELECT coalesce(sum(work_count),0)::text AS count FROM access.discovery_generation')).rows[0].count;
      const queries = stack.fuseki.queries, started = performance.now();
      const outcome = await scheduledWorker.tick(); // Preserve the scheduler's foreground/background burst.
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
    // Crash/outage after the last checkpoint: the exact ready generation survives.
    const activate = projection.activate.bind(projection);
    projection.activate = async () => { throw new WorkReadUnavailable('Fixture activation outage'); };
    try { await due(); expect(await worker().tick()).toBe('retry'); }
    finally { projection.activate = activate; }
    const ready = (await stack.accessPool.query(`SELECT g.id, g.state FROM access.discovery_refresh j
      JOIN access.derived_generation g ON g.id = j.generation_id WHERE j.scope_key = $1`, [key])).rows[0];
    expect(ready.state).toBe('ready');
    // A later write cannot cancel the completed, pinned population. Activate
    // that exact cut, then refresh only the newly public Work from the outbox.
    const third = await stack.publicWork(a.actor, ['en'], 'Third');
    await drain();
    expect(await tick()).toBe('activated');
    expect((await stack.accessPool.query('SELECT active_generation FROM access.derived_generation_head WHERE scope_key = $1', [key])).rows[0].active_generation)
      .toBe(ready.id);
    expect(await json(await read())).toMatchObject({ stale: true, items: expect.any(Array) });
    expect(await tick()).toBe('activated');
    const delta = (await stack.accessPool.query('SELECT changed_works FROM access.discovery_generation WHERE generation_id <> $1', [ready.id])).rows[0];
    expect(delta.changed_works).toEqual([third.work]);
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

    // New Accounts do not invalidate a population; leases still serialize its refresh.
    const b = await stack.member('b');
    expect(await json(await read())).toMatchObject({ stale: false });
    await due();
    const held = await store.claim();
    expect(held).not.toBeNull();
    expect(await store.claim()).toBeNull();
    await due();
    const replacement = await store.claim();
    expect(BigInt(replacement!.lease_epoch)).toBeGreaterThan(BigInt(held!.lease_epoch));
    await expect(store.finish(held!, null, 'current', 0, 0)).rejects.toBeInstanceOf(RecommendationStale);
    for (let i = 0; i < 8 && (await json<{ stale: boolean }>(await read())).stale; i++) await tick();
    expect((await read()).status).toBe(200);
    expect((await read(`?cursor=${page.nextCursor}`)).status).toBe(200);
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
    const obsolete = (await projection.register(automaticDiscovery(null), base,
      { dataEpoch: stack.env.lineage.dataEpoch, sequence: '0' },
      { idempotencyKey: 'purge-cancelled', requestDigest: 'a'.repeat(64) })).generation_id;
    await stack.accessPool.query(`INSERT INTO access.discovery_entry
      (generation_id, work, work_type, term, recent_order, rating_count, rating_sum, payload)
      SELECT $1, work, work_type, term, recent_order, rating_count, rating_sum, payload
      FROM access.discovery_entry WHERE generation_id = $2`, [obsolete, ready.id]);
    await projection.cancel(automaticDiscovery(null), obsolete);
    await stack.accessPool.query("UPDATE access.derived_generation SET finished_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [obsolete]);
    await stack.accessPool.query("UPDATE access.discovery_retirement SET due_at=clock_timestamp()-interval '1 hour' WHERE generation_id=$1", [obsolete]);
    for (let i = 0; i < 8; i++) await store.purge();
    expect((await stack.accessPool.query('SELECT count(*) FROM access.discovery_entry WHERE generation_id = $1', [obsolete])).rows[0].count).toBe('0');
    const measurements = { ticks, maxQueries, maxMs: Math.ceil(maxMs), worksPerTick: DISCOVERY_REFRESH_COST.worksPerTick };
    await Bun.write(new URL(`../../../.temp/discovery-refresh-${Bun.env.REZICS_QA_RUN_ID}.json`, import.meta.url),
      JSON.stringify(measurements));
    console.log(`discovery refresh measured: ${JSON.stringify(measurements)}`);
  } finally { await relay.end(); await stack.stop(); }
}, 240_000);

interface QueueState {
  generation_id: string | null;
  quarantine_basis: { sequence: string; graphVersion: string | null } | null;
  quarantine_reason: string | null;
  last_error: string | null;
  last_outcome: string;
  attempts: string;
  lease_epoch: string;
  due_at: Date;
  checkpoint: string | null;
}

test('refresh owners quarantine malformed source once, bound fleet probes, recover transient work and rearm repaired input', async () => {
  const basis: OwnedDiscoveryBasis = { scope: 'global', realm: null, context: null, owner: null };
  const key = discoveryScopeKey(basis);
  const owners = await cloneQaOwnerDatabases(requireQa(), ['access', 'content', 'relay'], 'privileged');
  const f = await startMediaStack('discovery-refresh-disposition', { ownerUrls: owners.urls });
  const relay = new Pool({ connectionString: owners.urls.relay });
  const query = f.fuseki.query.bind(f.fuseki);
  let head: string | undefined;
  let restoreGraph: (() => Promise<void>) | undefined;
  // Contradictory current revision evidence is a real fault in today's identity
  // projection. No media hydration or synthetic worker outcome produces it.
  const conflictingSequence = '9223372036854775808';
  const repair = async () => {
    if (head) await f.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE DATA { GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} rv:sequence ${conflictingSequence} } }`);
  };
  try {
    restoreGraph = await isolateDiscoveryProbeGraph(f.env);
    const writer = await f.member('refresh disposition writer');
    const work = await f.publicWork(writer.actor, ['en'], 'Retained refresh candidate');
    const hidden = await f.privateWork(writer.actor, 'Private refresh candidate');
    const heads = await query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} rv:head ?head } } LIMIT 2`);
    expect(heads.results!.bindings).toHaveLength(1);
    head = heads.results!.bindings[0]!.head!.value;
    const consumer = `refresh-disposition-${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, f.env.lineage.dataEpoch);
    const drain = async () => {
      for (let i = 0; i < 1000; i++) {
        if (!await relayMainOutboxOnce(f.fuseki, relay, consumer)) return;
      }
      throw new Error('Refresh fixture exceeded its relay preparation bound');
    };
    await drain();
    const positions = new RelayHandoffPositions(relay, consumer);
    const projection = new DiscoveryProjection(f.accessPool);
    let now = Date.now() + 60_000;
    const store = new DiscoveryRefreshStore(f.accessPool, () => new Date(now));
    const worker = new DiscoveryRefreshWorker({ ...f.composition.dependencies,
      alsoEnjoyed: undefined, relayPosition: positions, discoveryRefreshInputs: new DiscoveryRefreshInputs(relay, consumer),
    }, store, projection);
    await store.enroll([basis]);
    const state = async (): Promise<QueueState> => (await f.accessPool.query<QueueState>(`
      SELECT j.generation_id,j.quarantine_basis,j.quarantine_reason,j.last_error,j.last_outcome,
        j.attempts::text,j.lease_epoch::text,j.due_at,d.checkpoint
      FROM access.discovery_refresh j LEFT JOIN access.discovery_generation d ON d.generation_id=j.generation_id
      WHERE j.scope_key=$1`, [key])).rows[0]!;
    let claimedScope: string | undefined, populationReads = 0, fullClaims = 0, probeClaims = 0;
    let unavailable = false;
    const claim = store.claim.bind(store);
    store.claim = async background => {
      const job = await claim(background);
      claimedScope = job?.scope_key;
      if (job?.quarantine_basis) probeClaims++;
      else if (job?.scope_key === key) fullClaims++;
      return job;
    };
    f.fuseki.query = async (...args) => {
      if (claimedScope === key && args[0].includes('SELECT DISTINCT ?work ?head')) {
        populationReads++;
        if (unavailable) throw new WorkReadUnavailable('Fixture discovery transport is unavailable');
      }
      return query(...args);
    };
    const until = async (done: (row: QueueState) => boolean, advance: number = DISCOVERY_REFRESH_COST.probeMs) => {
      for (let i = 0; i < 200; i++) {
        now += advance;
        await worker.tick();
        const row = await state();
        if (done(row)) return row;
      }
      throw new Error('Refresh fixture did not reach its bounded owner outcome');
    };
    await f.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} { ${iri(head)} rv:sequence ${conflictingSequence} } }`);
    const failed = await until(row => row.quarantine_reason === 'basis-invalid');
    expect(failed.last_error).toBe('Discovery source is ambiguous');
    expect(failed.generation_id).not.toBeNull();
    expect(failed.attempts).toBe('0');
    expect(failed.quarantine_basis!.graphVersion, 'Native repairs must be observable without a receipt').not.toBeNull();
    const failedReads = populationReads, failedClaims = fullClaims;
    // Unchanged probes retain the same source disposition and generation checkpoint.
    for (let pass = 0; pass < 3; pass++) {
      const priorLease = (await state()).lease_epoch;
      now += DISCOVERY_REFRESH_COST.maximumRetryMs;
      await until(row => row.lease_epoch !== priorLease);
      expect(await state()).toMatchObject({ generation_id: failed.generation_id,
        checkpoint: failed.checkpoint, quarantine_basis: failed.quarantine_basis, attempts: '0' });
      expect(populationReads).toBe(failedReads);
      expect(fullClaims).toBe(failedClaims);
    }
    // All these invalid populations must share one probe allowance. Enrollment
    // and queue time are owner APIs; the fixture never edits scheduler SQL state.
    const invalid: OwnedDiscoveryBasis[] = Array.from({ length: 20 }, () => ({
      scope: 'realm', realm: null, context: native(), owner: null,
    }));
    await store.enroll(invalid);
    const invalidKeys = invalid.map(discoveryScopeKey);
    for (let i = 0; i < 200; i++) {
      now += 1000;
      await worker.tick();
      const count = (await f.accessPool.query<{ count: string }>(`SELECT count(*)::text FROM access.discovery_refresh
        WHERE scope_key=ANY($1::text[]) AND quarantine_basis IS NOT NULL`, [invalidKeys])).rows[0]!.count;
      if (Number(count) === invalid.length) break;
      if (i === 199) throw new Error('Background invalid populations were starved');
    }
    now += DISCOVERY_REFRESH_COST.maximumRetryMs;
    const probesBefore = probeClaims;
    for (let i = 0; i < 40; i++) await worker.tick();
    const probesInOneAllowance = probeClaims - probesBefore;
    expect(probesInOneAllowance).toBe(1);
    expect(populationReads).toBe(failedReads);
    expect(fullClaims).toBe(failedClaims);
    // Repair the retained evidence without changing its receipted source cut.
    // A fresh store/worker must rearm on the native stamp and reuse the build.
    await repair();
    const restoredStore = new DiscoveryRefreshStore(f.accessPool, () => new Date(now));
    const restoredWorker = new DiscoveryRefreshWorker({ ...f.composition.dependencies,
      alsoEnjoyed: undefined, relayPosition: positions, discoveryRefreshInputs: new DiscoveryRefreshInputs(relay, consumer),
    }, restoredStore, projection);
    let repaired: QueueState | undefined;
    for (let i = 0; i < 200; i++) {
      now += DISCOVERY_REFRESH_COST.probeMs;
      await restoredWorker.tick();
      const row = await state();
      if (row.last_outcome === 'activated') { repaired = row; break; }
    }
    expect(repaired).toMatchObject({ quarantine_basis: null, last_error: null, attempts: '0' });
    const active = (await f.accessPool.query<{ active_generation: string }>(`SELECT active_generation
      FROM access.derived_generation_head WHERE family='discovery' AND scope_key=$1`, [key])).rows[0]!.active_generation;
    expect(active).toBe(failed.generation_id!);
    const generation = (await f.accessPool.query<{ source_sequence: string }>(`SELECT source_sequence::text
      FROM access.discovery_generation WHERE generation_id=$1`, [active])).rows[0]!;
    expect(generation.source_sequence).toBe(failed.quarantine_basis!.sequence);
    const page = await f.main.handle(new Request('http://main.local/v1/works'));
    expect(page.status, await page.clone().text()).toBe(200);
    const body = await page.json() as { items: { id: string }[] };
    expect(body.items.some(item => item.id === hidden.work)).toBe(false);
    const ready = await projection.active(basis, { dataEpoch: f.env.lineage.dataEpoch, sequence: generation.source_sequence });
    expect((await f.accessPool.query(`SELECT work FROM access.discovery_entries($1,$2)
      WHERE generation_id=$1 AND work=$3 AND work_type='' AND term=''`,
    [ready.storage_generation ?? ready.generation_id, ready.storage_version ?? '0', work.work])).rows).toHaveLength(1);

    const appended = await f.publicWork(writer.actor, ['en'], 'Transient recovery candidate');
    await drain();
    unavailable = true;
    const transient = await until(row => row.last_outcome === 'retry' && row.attempts === '1');
    expect(transient.quarantine_basis).toBeNull();
    expect(transient.due_at.getTime() - now).toBe(DISCOVERY_REFRESH_COST.retryMs);
    now = transient.due_at.getTime() - 1;
    await worker.tick();
    expect((await state()).lease_epoch).toBe(transient.lease_epoch);
    now++;
    const second = await until(row => row.attempts === '2', 0);
    expect(second.due_at.getTime() - now).toBe(2 * DISCOVERY_REFRESH_COST.retryMs);
    expect(second.generation_id).toBe(transient.generation_id);
    expect(second.checkpoint).toBe(transient.checkpoint);
    unavailable = false;
    now = second.due_at.getTime();
    const recovered = await until(row => row.last_outcome === 'activated', DISCOVERY_REFRESH_COST.intervalMs);
    expect(recovered).toMatchObject({ quarantine_basis: null, attempts: '0' });
    expect((await f.accessPool.query(`SELECT active_generation FROM access.derived_generation_head
      WHERE family='discovery' AND scope_key=$1`, [key])).rows[0]!.active_generation).toBe(transient.generation_id);
    const currentPosition = await workRead(f.composition.dependencies,
      new Request('http://main.internal/discovery-refresh'), {}, async session => session.position);
    const current = await projection.active(basis, currentPosition);
    expect((await f.accessPool.query(`SELECT work FROM access.discovery_entries($1,$2)
      WHERE generation_id=$1 AND work=$3 AND work_type='' AND term=''`,
    [current.storage_generation ?? current.generation_id, current.storage_version ?? '0', appended.work])).rows).toHaveLength(1);
    console.info(JSON.stringify({ capability: 'discovery-refresh-maintenance', permanentFullClaims: failedClaims,
      permanentPopulationReads: failedReads, unchangedPopulationReads: 0, parkedPopulations: invalid.length + 1,
      probesInOneAllowance, transientAttempts: 2,
      personaJourney: false, queueClock: 'injected; graph, Access, projection and leases use production owners' }));
  } finally {
    f.fuseki.query = query;
    try { await repair(); }
    finally {
      try { await restoreGraph?.(); }
      finally { await relay.end(); await f.stop(); await owners.close(); }
    }
  }
}, 300_000);
