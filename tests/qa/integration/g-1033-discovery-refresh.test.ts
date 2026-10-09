import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { DiscoveryProjection, discoveryScopeKey } from '../../../services/main/src/modules/discovery/store.ts';
import { DiscoveryRefreshStore, DISCOVERY_REFRESH_COST } from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { DiscoveryRefreshWorker } from '../../../services/main/src/modules/discovery/refresh.ts';
import { automaticDiscovery } from '../../../services/main/src/modules/discovery/automation.ts';
import { DISCOVERY_REFRESH_HEALTH_COST, discoveryRefreshHealthSql } from '../../../services/main/src/modules/discovery/refresh-health.ts';
import { RankingGenerations } from '../../../services/main/src/modules/recommendation/ranking.ts';
import { RankingBuildWorker } from '../../../services/main/src/modules/recommendation/build-worker.ts';
import { graphZeroCandidates, graphZeroSnapshot } from '../../../services/main/src/modules/recommendation/zero-candidates.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { WorkReadUnavailable } from '../../../services/main/src/modules/work/read-session.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { backfillPublicNames } from '../../../services/main/src/modules/search/names.ts';
import type { OwnedDiscoveryBasis } from '../../../services/main/src/modules/discovery/contract.ts';
import { meteredPool, requireQa } from './recommendation-support.ts';
import { startMediaStack } from './media-support.ts';
import { waitForRealmDirectory } from './support/realm-directory.ts';
import { measureGraphReads } from './support/graph-reads.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

const native = () => `https://rezics.com/id/${randomUUID()}`;
interface Health { status: string; generation: string | null;
  refresh: { items: { scopeKey: string; status: string; reason: string }[]; truncated: boolean } }

test('G1033: deleted and ineligible Realm bases are skipped beside healthy public projections and ranking', async () => {
  const owners = await cloneQaOwnerDatabases(requireQa(), ['access', 'content', 'relay'], 'privileged');
  const f = await startMediaStack('g-1033-isolation', { ownerUrls: owners.urls });
  const relay = new Pool({ connectionString: owners.urls.relay });
  try {
    const writer = await f.member('G1033 writer');
    const work = await f.publicWork(writer.actor, ['en'], 'G1033 public Work');
    await writer.grant('space:create:root', 'space.create');
    const realms: { realm: string; space: string }[] = [];
    for (const name of ['Deleted Realm', 'Private Realm', 'Zone only']) {
      const response = await writer.send('POST', '/v1/spaces', {
        profile: 'space-realm-v1', name, capabilities: ['realm'], actingSubject: writer.actor,
      }, randomUUID());
      expect(response.status, await response.clone().text()).toBe(201);
      realms.push(await response.json() as { realm: string; space: string });
    }
    const consumer = `g1033-${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, f.env.lineage.dataEpoch);
    await backfillPublicNames(f.env);
    for (let i = 0; i < 100; i++) {
      if (!await relayMainOutboxOnce(f.fuseki, relay, consumer)) break;
      if (i === 99) throw new Error('G1033 relay exceeded its fixture bound');
    }
    const position = new RelayHandoffPositions(relay, consumer);
    const projection = new DiscoveryProjection(f.accessPool), store = new DiscoveryRefreshStore(f.accessPool);
    const publicBasis: OwnedDiscoveryBasis = { scope: 'global', realm: null, context: null, owner: null };
    const realmBases: OwnedDiscoveryBasis[] = realms.map(({ realm }) => ({ scope: 'realm', realm, context: null, owner: null }));
    const rejected: OwnedDiscoveryBasis[] = [...realmBases,
      { ...publicBasis, context: native() }, // A withdrawn standing rating Context.
      { scope: 'realm', realm: null, context: null, owner: null },
      { scope: 'mine', realm: null, context: native(), owner: randomUUID() }];
    // An existing partial generation remains dormant rather than activating
    // after its Realm is deleted. It can resume if eligibility returns later.
    const pending = await projection.register(automaticDiscovery(null), realmBases[0]!, (await position.read())!,
      { idempotencyKey: randomUUID(), requestDigest: 'a'.repeat(64) });
    await f.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(realms[0]!.realm)} ?p ?o } }`);
    // A private Realm is the Space settings command. The member was not
    // provisioned, so it lacks the controller mandate that command accepts
    // as owner authority. Drain the receipt so the eligibility probe reads
    // that visibility at a caught-up cut.
    await writer.grant(`agent:control:${writer.actor}`, 'agent.control');
    const spaceId = realms[1]!.space.slice(-36);
    const settingsResponse = await writer.read(`/v1/spaces/${spaceId}/settings`);
    const current = await settingsResponse.json() as { generation: string; settings: {
      visibility: 'public' | 'private'; listing: 'listed' | 'unlisted';
      history: 'everything' | 'from-admission'; admission: 'open' | 'request' | 'invitation' } };
    expect(settingsResponse.status, JSON.stringify(current)).toBe(200);
    const changed = await writer.send('PUT', `/v1/spaces/${spaceId}/settings`, {
      actingSubject: writer.actor, expectedGeneration: current.generation, reason: 'Private Realm',
      settings: { ...current.settings, visibility: 'private' },
    }, randomUUID());
    expect(changed.status, await changed.text()).toBe(201);
    for (let i = 0; i < 100; i++) {
      if (!await relayMainOutboxOnce(f.fuseki, relay, consumer)) break;
      if (i === 99) throw new Error('G1033 relay exceeded its fixture bound');
    }
    await f.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/>
      DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(realms[2]!.realm)} a rv:Realm } }
      INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(realms[2]!.realm)} a rv:Zone } }
      WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(realms[2]!.realm)} a rv:Realm } }`);
    // Deleting the Realm and retyping it as a Zone bypass graph receipts.
    // Discard any earlier directory snapshot so the worker rebuilds that source.
    await f.access.realmDirectory.invalidate();
    await store.enroll([publicBasis, ...rejected]);
    await f.accessPool.query(`UPDATE access.discovery_refresh_catalog SET due_at=clock_timestamp()+interval '1 hour'`);
    const deps = { environment: f.env, access: f.access, media: f.media, discovery: projection,
      account: { verify: async () => writer.principal }, relayPosition: position };
    const deferred = new DiscoveryRefreshWorker(deps, store, projection);
    // Eligibility probes own the due basis. Global/background lanes decide
    // scheduler priority independently of the oldest Realm's due timestamp.
    const dueOnly = (basis: OwnedDiscoveryBasis) => f.accessPool.query(`UPDATE access.discovery_refresh
      SET due_at=CASE WHEN scope_key=$1 THEN clock_timestamp()-interval '1 hour'
        ELSE greatest(due_at,clock_timestamp()+interval '1 minute') END`, [discoveryScopeKey(basis)]);
    for (const [index, basis] of rejected.entries()) {
      const key = discoveryScopeKey(basis);
      await dueOnly(basis);
      const measured = await measureGraphReads(() => deferred.tick());
      expect(measured.value).toBe(index === 4 ? 'basis-invalid' : index === 5 ? 'inactive' : 'basis-unavailable');
      expect(measured.calls).toBeLessThanOrEqual(DISCOVERY_REFRESH_COST.graphCalls);
      const job = (await f.accessPool.query(`SELECT last_outcome,attempts::text,
        due_at-clock_timestamp()>interval '4 minutes' AS parked FROM access.discovery_refresh WHERE scope_key=$1`, [key])).rows[0];
      expect(job).toMatchObject({ parked: true, attempts: '0' });
    }
    expect((await f.accessPool.query(`SELECT state FROM access.derived_generation WHERE id=$1`, [pending.generation_id])).rows[0].state)
      .toBe('building');
    // The next claim reaches public work without accelerating deferred bases.
    await dueOnly(publicBasis);
    expect(await deferred.tick()).toBe('activated');
    expect((await f.accessPool.query(`SELECT active_generation FROM access.derived_generation_head
      WHERE family='discovery' AND scope_key=$1`, [discoveryScopeKey(publicBasis)])).rows).toHaveLength(1);

    const rankings = new RankingGenerations({ access: f.accessPool, relay, dataEpoch: f.env.lineage.dataEpoch,
      cursorKey: new Uint8Array(32), zeroSnapshot: () => graphZeroSnapshot(f.env), zeroCandidates: graphZeroCandidates(f.env),
      canReadWork: (principal, actor, target) => f.access.canReadWork(principal, actor, target) });
    const app = createMainApp(f.fuseki, { ...deps, recommendations: rankings });
    const rankingWorker = new RankingBuildWorker(f.accessPool, rankings);
    rankingWorker.enablePublicRefresh();
    let ready: Health | undefined;
    for (let i = 0; i < 40; i++) {
      await rankingWorker.tick();
      const response = await app.handle(new Request('http://main.local/health/discovery-ready'));
      const health = await response.json() as Health;
      if (response.status === 200) { ready = health; break; }
    }
    expect(ready).toMatchObject({ status: 'ready', generation: expect.any(String), refresh: { truncated: false } });
    expect(ready!.refresh.items.map(item => item.scopeKey).sort()).toEqual(rejected.map(discoveryScopeKey).sort());
    expect(ready!.refresh.items.every(item => item.status === 'skipped')).toBe(true);
    await waitForRealmDirectory(f.env, () => app.handle(new Request('http://main.local/v1/realms')));
    const sections = await app.handle(new Request('http://main.local/v1/discovery/sections'));
    expect(sections.status, await sections.clone().text()).toBe(200);
    const body = await sections.json() as { items: { id: string; page: { items: { id: string }[] } }[] };
    expect(body.items.find(item => item.id === 'popular')!.page.items.map(item => item.id)).toContain(work.work);

    // A transient source outage uses only this basis's exponentially increasing
    // due time. Its persisted generation and another job survive every retry.
    const inspect = store.inspect.bind(store);
    store.inspect = async job => {
      if (job.scope_key === discoveryScopeKey(publicBasis)) throw new WorkReadUnavailable('G1033 transient source outage');
      return inspect(job, (await position.read())!);
    };
    for (const seconds of [30, 60]) {
      await dueOnly(publicBasis);
      expect(await deferred.tick()).toBe('retry');
      const delay = (await f.accessPool.query(`SELECT extract(epoch FROM due_at-clock_timestamp()) AS seconds
        FROM access.discovery_refresh WHERE scope_key=$1`, [discoveryScopeKey(publicBasis)])).rows[0].seconds;
      expect(Number(delay)).toBeGreaterThan(seconds - 3);
      expect(Number(delay)).toBeLessThanOrEqual(seconds);
    }
    expect((await projection.refreshHealth()).items).toContainEqual(expect.objectContaining({
      scopeKey: discoveryScopeKey(publicBasis), status: 'blocked', reason: 'retry' }));
    expect((await app.handle(new Request('http://main.local/health/discovery-ready'))).status).toBe(200);
    // While public source work backs off, a previously missing Realm becomes
    // eligible and gets the very next claim; its old checkpoint can resume.
    await f.fuseki.update(`PREFIX rv: <https://rezics.com/vocab/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(realms[0]!.realm)} a rv:Realm ;
        rv:realmState rv:Active ; rv:space ${iri(realms[0]!.space)} } }`);
    await dueOnly(realmBases[0]!);
    expect(await deferred.tick()).toBe('activated');
    expect((await f.accessPool.query(`SELECT active_generation FROM access.derived_generation_head
      WHERE family='discovery' AND scope_key=$1`, [discoveryScopeKey(realmBases[0]!)])).rows[0].active_generation)
      .toBe(pending.generation_id);
    store.inspect = inspect;
    await dueOnly(publicBasis);
    expect(await deferred.tick()).toBe('current');
    expect((await f.accessPool.query(`SELECT attempts::text FROM access.discovery_refresh WHERE scope_key=$1`,
      [discoveryScopeKey(publicBasis)])).rows[0].attempts).toBe('0');

    // Even a fresh active generation must recheck Realm eligibility. A policy
    // disappearing without advancing the fixture's cut cannot bypass admission.
    await f.fuseki.update(`DELETE WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(realms[0]!.realm)} ?p ?o } }`);
    await dueOnly(realmBases[0]!);
    expect(await deferred.tick()).toBe('basis-unavailable');

    // An apparent missing Realm at a moving graph is not stable ineligibility:
    // workRead's final fence changes this attempt into a short source retry.
    const query = f.fuseki.query.bind(f.fuseki);
    let inject = true;
    f.fuseki.query = async (sparql, bytes) => {
      const result = await query(sparql, bytes);
      if (inject && sparql.includes('SELECT ?space ?realmRevision') && sparql.includes(iri(realms[0]!.realm))) {
        inject = false;
        await f.publicWork(writer.actor, ['en'], 'G1033 concurrent public Work');
      }
      return result;
    };
    try {
      await dueOnly(realmBases[0]!);
      expect(await deferred.tick()).toBe('retry');
      expect(inject).toBe(false);
      const job = (await f.accessPool.query(`SELECT last_outcome,due_at<clock_timestamp()+interval '1 second' AS short_retry
        FROM access.discovery_refresh WHERE scope_key=$1`, [discoveryScopeKey(realmBases[0]!)])).rows[0];
      expect(job).toEqual({ last_outcome: 'retry', short_retry: true });
    } finally { f.fuseki.query = query; }
    for (let i = 0; i < 100; i++) {
      if (!await relayMainOutboxOnce(f.fuseki, relay, consumer)) break;
      if (i === 99) throw new Error('G1033 concurrent relay exceeded its fixture bound');
    }
    await dueOnly(realmBases[0]!);
    expect(await deferred.tick()).toBe('basis-unavailable');

    const meter = meteredPool(f.accessPool), bounded = new DiscoveryProjection(meter.pool);
    const healthRead = await measureGraphReads(() => bounded.refreshHealth());
    expect(healthRead.value.items).toHaveLength(rejected.length);
    expect(meter.count()).toBeLessThanOrEqual(DISCOVERY_REFRESH_HEALTH_COST.accessStatements);
    expect(healthRead.calls).toBe(0);
    // Many healthy bases must not make an empty/short diagnostic window scan
    // the entire catalogue. Test the actual production SQL and existing index.
    await f.accessPool.query(`INSERT INTO access.discovery_refresh(scope_key,basis,due_at,last_outcome)
      SELECT md5('g1033-'||i::text)||md5(i::text),$1::jsonb,clock_timestamp()+interval '100 milliseconds','current'
      FROM generate_series(1,10000) i`, [publicBasis]);
    await f.accessPool.query('ANALYZE access.discovery_refresh');
    const plan = (await f.accessPool.query(`EXPLAIN (ANALYZE,FORMAT JSON) ${discoveryRefreshHealthSql}`,
      [DISCOVERY_REFRESH_HEALTH_COST.candidates + 1])).rows[0]['QUERY PLAN'];
    expect(JSON.stringify(plan)).toContain('discovery_refresh_due');
    expect(JSON.stringify(plan)).toContain('Index Cond');
    expect((await bounded.refreshHealth()).items).toHaveLength(rejected.length);
  } finally { await relay.end(); await f.stop(); await owners.close(); }
}, 240_000);
