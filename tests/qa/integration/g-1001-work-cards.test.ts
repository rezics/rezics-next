import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { DiscoveryProjection, discoveryResourceCardPayloadSql,
  discoveryScopeKey } from '../../../services/main/src/modules/discovery/store.ts';
import { automaticDiscovery } from '../../../services/main/src/modules/discovery/automation.ts';
import { DiscoveryRefreshWorker } from '../../../services/main/src/modules/discovery/refresh.ts';
import { DiscoveryRefreshStore } from '../../../services/main/src/modules/discovery/refresh-store.ts';
import { projectDiscoveryBatch } from '../../../services/main/src/modules/discovery/source.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { GRAPHS, DATASET, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import type { ResourceCard } from '../../../services/main/src/modules/query/resource-contract.ts';
import { RESOURCE_WORK_CARD_COST } from '../../../services/main/src/modules/query/resource-contract.ts';
import { Value } from 'typebox/value';
import { resourceListPage } from '../../../services/main/src/modules/query/resource-contract.ts';
import { resourceWork } from '../../../apps/web/features/discover/resource-card.tsx';
import { startMediaStack } from './media-support.ts';
import { isolateCardRatingContext } from './discovery-rating-context-fixture.ts';
import { digest } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { initializeRelayCheckpoint } from '../../../services/main/src/modules/outbox/relay.ts';
import { RelayHandoffPositions } from '../../../services/main/src/modules/outbox/relay-position.ts';

const native = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}
interface PlanNode {
  'Node Type': string; 'Relation Name'?: string; 'Actual Rows': number; 'Actual Loops': number;
  'Shared Hit Blocks'?: number; 'Shared Read Blocks'?: number; Plans?: PlanNode[];
  'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number;
}
function relationVisits(node: PlanNode): number {
  // Count only the storage node, not inclusive parent rows a second time.
  return (node['Relation Name'] === 'discovery_entry' ? (node['Actual Rows']
    + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * node['Actual Loops'] : 0)
    + (node.Plans ?? []).reduce((sum, child) => sum + relationVisits(child), 0);
}

test('G1001: real Query cards show bounded ordered authors and Global ratings without scanning credit/rating degree', async () => {
  const prepared = performance.now();
  const f = await startMediaStack('g-1001-cards', { profileCredits: true, library: true });
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const restoreContexts = await isolateCardRatingContext(f.fuseki);
  try {
    const [a, b, c] = await Promise.all(['Lin Mei', 'Jane Austen', '森圭'].map(name => f.member(name)));
    const jane = await json<{ agent: string }>(await b!.send('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Jane Austen',
    }, randomUUID()), 201);
    const work = await f.publicWork(a!.actor, ['en'], 'G1001 rainy library');
    const head = (await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(work.work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
    await a!.grant(`work:edit:${work.work}`, 'work.edit');
    const creditApp = createMainApp(f.fuseki, { environment: f.env, access: f.access,
      profiles: new ProfilesAccess(f.accessPool), account: { verify: async () => a!.principal } });
    for (const [index, author] of [a!.actor, jane.agent, c!.actor].entries()) {
      await json(await creditApp.handle(new Request(`http://main.local/v1/works/${work.work.slice(-36)}/agent-credits`, {
        method: 'POST', headers: { authorization: `Bearer ${a!.token}`, 'content-type': 'application/json',
          'idempotency-key': randomUUID() }, body: JSON.stringify({
        profile: 'native-agent-credit-v1', credit: native(index + 1), agent: author, role: 'author',
        expectedWorkHead: head, actingSubject: a!.actor,
      }) })), 201);
    }
    await a!.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const global = await json<{ context: string }>(await a!.send('POST', '/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1', question: 'Overall quality', actingSubject: a!.actor,
    }, randomUUID()), 201);
    for (const [member, value] of [[a!, 5], [b!, 3]] as const) {
      await member.grant(`rating:observe:${global.context}`, 'rating.observation.set');
      await json(await member.send('POST', '/v1/global-rating-observations', {
        profile: 'global-rating-standing-observation-v1', context: global.context, work: work.work,
        mainVersion: work.mainVersion, value, expectedRevisionHead: null, actingSubject: member.actor,
      }, randomUUID()), 201);
    }
    const projection = new DiscoveryProjection(f.accessPool);
    const deps = { environment: f.env, access: f.access, media: f.media, profiles: new ProfilesAccess(f.accessPool),
      discovery: projection, personPreferences: f.composition.dependencies.personPreferences,
      account: { verify: async () => a!.principal } };
    const app = createMainApp(f.fuseki, deps);
    const heads = new Map<string | null, string>();
    const buildSource = (degree: number) => workRead(deps, new Request('http://main.local/source'), {}, async session => {
      const built: string[] = [];
      for (const context of [null, global.context]) {
        const basis = { scope: 'global' as const, realm: null, context };
        const row = await projection.register(automaticDiscovery(null), basis, session.position,
          { idempotencyKey: randomUUID(), requestDigest: digest(basis) });
        const step = await projection.beginStep(automaticDiscovery(null), row.generation_id, '');
        const result = await projectDiscoveryBatch(session, basis, '', { works: [work.work] });
        expect(result.complete).toBe(true);
        // Commit the real Work first: version replacement deletes every posting
        // of its Work, including synthetic fanout installed before that batch.
        await projection.commitBatch(automaticDiscovery(null), row.generation_id, step.lease, '',
          { ...result, complete: false }, session.position);
        if (!context && degree) await f.accessPool.query(`INSERT INTO access.discovery_entry
          (generation_id, work, work_type, term, recent_order, rating_count, rating_sum, payload)
          SELECT $1,$2,'background','background-' || n,0,0,0,'{}'::jsonb
          FROM generate_series(1,$3::integer) n`, [row.generation_id, work.work, degree]);
        const finish = await projection.beginStep(automaticDiscovery(null), row.generation_id, result.after);
        await projection.commitBatch(automaticDiscovery(null), row.generation_id, finish.lease, result.after,
          { after: result.after, complete: true, items: [] }, session.position);
        const activated = await projection.activate(automaticDiscovery(null), row.generation_id,
          heads.get(context) ?? row.active_head, session.position,
          { idempotencyKey: randomUUID(), requestDigest: digest({ generation: row.generation_id }) });
        expect(activated.outcome).toBe('succeeded');
        heads.set(context, activated.headRevision);
        built.push(row.generation_id);
      }
      return { generations: built, position: session.position };
    });
    let source = await buildSource(0);
    expect(performance.now() - prepared).toBeLessThan(600_000);
    const queryRequest = (target: ReturnType<typeof createMainApp>, token?: string) =>
      target.handle(new Request('http://main.local/v1/query', {
        method: 'POST', headers: { 'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({
          profile: 'resource-list-v1', context: 'global', scope: { kind: 'all' }, sort: 'newest', limit: 1,
          filter: { all: [{ facet: 'type', any: ['https://schema.org/CreativeWork'] }] },
        }),
      }));
    const request = () => queryRequest(app);
    const inspect = async () => {
      const calls = f.fuseki.queries;
      const result = await json<{ result: { items: ResourceCard[] } }>(await request());
      const graphCalls = f.fuseki.queries - calls;
      expect(Value.Check(resourceListPage, result.result)).toBe(true);
      const card = result.result.items.find(card => card.id === work.work)!;
      expect(card.work!.primaryCredits.map(credit => credit.displayName)).toEqual(['Lin Mei', 'Jane Austen', '森圭']);
      expect(card.work!.creditCount).toEqual({ value: 3, kind: 'at-least' });
      expect(card.work!.rating).toMatchObject({ context: global.context, mean: 4, count: 2, scale: { max: 5 } });
      const tile = resourceWork(card);
      expect(tile.authors.map(author => author.name)).toEqual(['Lin Mei', 'Jane Austen', '森圭']);
      expect(tile.rating).toEqual({ mean: 4, count: 2, max: 5 });
      const explained = await f.accessPool.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) ${discoveryResourceCardPayloadSql}`,
        [source.generations, source.generations, source.generations.map(() => '0'), [work.work]],
      );
      const plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan;
      expect(relationVisits(plan)).toBe(2);
      expect((plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0)).toBeLessThanOrEqual(64);
      return { graphCalls, bytes: Buffer.byteLength(JSON.stringify(card)), visits: relationVisits(plan) };
    };
    const baseline = await inspect();
    // Background fanout/history deliberately bypass commands; command acceptance
    // and sealed ratings were proved above. The GET must never visit these facts.
    for (const degree of [300, 3000]) {
      const rows = Array.from({ length: degree }, (_, n) => {
        const credit = native(1000 + n), revision = native(100000 + n), agent = native(200000 + n);
        return { current: `${iri(credit)} a rv:NativeAgentCredit ; rv:work ${iri(work.work)} ;
          rv:agent ${iri(agent)} ; schema:roleName "author" ; rv:creditRevision ${iri(revision)} .`,
        revision: `${iri(revision)} a rv:NativeAgentCreditRevision ; rv:component ${iri(credit)} ;
          rv:work ${iri(work.work)} ; rv:agent ${iri(agent)} ; schema:roleName "author" .
          ${iri(native(300000 + n))} a rv:RatingObservationRevision ; rv:targetMainVersion ${iri(work.mainVersion)} .` };
      });
      for (let offset = 0; offset < rows.length; offset += 256) {
        const batch = rows.slice(offset, offset + 256);
        await f.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> INSERT DATA {
          GRAPH ${iri(GRAPHS.current)} { ${batch.map(row => row.current).join('\n')} }
          GRAPH ${iri(GRAPHS.revisions)} { ${batch.map(row => row.revision).join('\n')} } }`);
      }
      // Cost control: an intentionally expensive count really sees the larger degree.
      const counted = (await f.fuseki.query(`PREFIX rv: <${RV}> SELECT (COUNT(?credit) AS ?count) WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?credit a rv:NativeAgentCredit ; rv:work ${iri(work.work)} } }`))
        .results!.bindings[0]!.count!.value;
      expect(Number(counted)).toBe(degree + 3);
      // An unrelated projection degree challenges all four primary-key constraints.
      source = await buildSource(degree);
      await f.accessPool.query('ANALYZE access.discovery_entry');
      const expensive = await f.accessPool.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) SELECT count(*) FROM unnest($1::uuid[]) ids(id) CROSS JOIN LATERAL access.discovery_entries(ids.id)',
        [source.generations],
      );
      expect(relationVisits(expensive.rows[0]!['QUERY PLAN'][0]!.Plan)).toBeGreaterThanOrEqual(degree);
      expect(await inspect()).toEqual(baseline);
    }
    expect(baseline.graphCalls).toBeLessThanOrEqual(160);
    expect(baseline.bytes).toBeLessThanOrEqual(RESOURCE_WORK_CARD_COST.projectionBytes);
    // Missing/stale owner state is explicit and recovery restores the same card.
    const sequence = source.position.sequence;
    await f.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?old } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?old } BIND(?old + 1 AS ?next) }`);
    // Catalogue membership remains useful during projection lag. Optional
    // previews are withheld rather than discarding the Work or inventing zero.
    const lagging = await json<{ result: { stale: boolean; items: ResourceCard[] } }>(await request());
    expect(lagging.result.stale).toBe(true);
    expect(lagging.result.items.map(card => card.id)).toEqual([work.work]);
    expect(lagging.result.items[0]!.work).toEqual({ primaryCredits: [],
      creditCount: { value: 0, kind: 'at-least' }, rating: null });
    await f.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?old } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ${sequence} } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?old } }`);
    expect(await inspect()).toEqual(baseline);
    const privacySubject = encodeURIComponent(jane.agent);
    const preferences = await json<{ profileVisibility: 'public' | 'private'; followPolicy: 'everyone' | 'nobody';
      hideReadingActivity: boolean; contentLanguages: string[]; spoilerPolicy: 'hide-unread' | 'show'; version: number }>(
      await f.call('GET', `/v1/me/person-preferences?actingSubject=${privacySubject}`, { token: b!.token }));
    const changed = await json<{ profileVisibility: 'public' | 'private'; version: number }>(await b!.send(
      'PUT', '/v1/me/person-preferences', { actingSubject: jane.agent, expectedVersion: preferences.version,
        profileVisibility: 'private', followPolicy: preferences.followPolicy,
        hideReadingActivity: preferences.hideReadingActivity, contentLanguages: preferences.contentLanguages,
        spoilerPolicy: preferences.spoilerPolicy }, randomUUID()));
    expect(changed).toMatchObject({ profileVisibility: 'private', version: preferences.version + 1 });

    const laggingPrivacy = await json<{ result: { stale: boolean; items: ResourceCard[] } }>(await request());
    expect(laggingPrivacy.result.stale).toBe(true);
    expect(laggingPrivacy.result.items.map(card => card.id)).toEqual([work.work]);
    expect(laggingPrivacy.result.items[0]!.work!.primaryCredits).toEqual([]);

    const base = { scope: 'global' as const, realm: null, context: null, owner: null };
    const scopeKey = discoveryScopeKey(base);
    const refreshStore = new DiscoveryRefreshStore(f.accessPool);
    const consumer = `g-1001-${randomUUID()}`;
    await initializeRelayCheckpoint(relay, consumer, f.env.lineage.dataEpoch);
    const refreshDeps = { ...deps, relayPosition: new RelayHandoffPositions(relay, consumer) };
    const refreshWorker = new DiscoveryRefreshWorker(refreshDeps, refreshStore, projection);
    await refreshStore.enroll([base]);
    let refreshed: { result: { stale: boolean; items: ResourceCard[] } } | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      await f.accessPool.query(`UPDATE access.discovery_refresh SET due_at = clock_timestamp() - interval '1 minute'
        WHERE scope_key = $1`, [scopeKey]);
      const outcome = await refreshWorker.tick();
      expect(['advanced', 'activated', 'current']).toContain(outcome);
      refreshed = await json<{ result: { stale: boolean; items: ResourceCard[] } }>(await request());
      if (!refreshed.result.stale) break;
    }
    expect(refreshed?.result.stale).toBe(false);
    expect(refreshed?.result.items[0]!.work!.primaryCredits.map(credit => credit.displayName))
      .toEqual(['Lin Mei', '森圭']);

    const ownerApp = createMainApp(f.fuseki, { ...deps, account: { verify: async () => b!.principal } });
    const ownerRead = await json<{ result: { items: ResourceCard[] } }>(await queryRequest(ownerApp, b!.token));
    expect(ownerRead.result.items[0]!.work!.primaryCredits.map(credit => credit.displayName))
      .toEqual(['Lin Mei', 'Jane Austen', '森圭']);
  } finally { await relay.end(); await restoreContexts(); await f.stop(); }
}, 600_000);
