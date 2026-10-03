import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { DiscoveryProjection, discoveryResourceCardPayloadSql } from '../../../services/main/src/modules/discovery/store.ts';
import { automaticDiscovery } from '../../../services/main/src/modules/discovery/automation.ts';
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
import { digest } from '../../../services/main/src/modules/recommendation/derived-generation.ts';

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
  try {
    const [a, b, c] = await Promise.all(['Lin Mei', 'Jane Austen', '森圭'].map(name => f.member(name)));
    const work = await f.publicWork(a!.actor, ['en'], 'G1001 rainy library');
    const head = (await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(work.work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
    await a!.grant(`work:edit:${work.work}`, 'work.edit');
    const creditApp = createMainApp(f.fuseki, { environment: f.env, access: f.access,
      profiles: new ProfilesAccess(f.accessPool), account: { verify: async () => a!.principal } });
    for (const [index, author] of [a!, b!, c!].entries()) {
      await json(await creditApp.handle(new Request(`http://main.local/v1/works/${work.work.slice(-36)}/agent-credits`, {
        method: 'POST', headers: { authorization: `Bearer ${a!.token}`, 'content-type': 'application/json',
          'idempotency-key': randomUUID() }, body: JSON.stringify({
        profile: 'native-agent-credit-v1', credit: native(index + 1), agent: author.actor, role: 'author',
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
      discovery: projection, account: { verify: async () => a!.principal } };
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
        // Background rows are installed only while the generation is building;
        // ready rows remain immutable throughout the read measurements.
        if (!context && degree) await f.accessPool.query(`INSERT INTO access.discovery_entry
          (generation_id, work, work_type, term, recent_order, rating_count, rating_sum, payload)
          SELECT $1,$2,'background','background-' || n,0,0,0,'{}'::jsonb
          FROM generate_series(1,$3::integer) n`, [row.generation_id, work.work, degree]);
        await projection.commitBatch(automaticDiscovery(null), row.generation_id, step.lease, '', result, session.position);
        const activated = await projection.activate(automaticDiscovery(null), row.generation_id, heads.get(context) ?? null,
          session.position, { idempotencyKey: randomUUID(), requestDigest: digest({ generation: row.generation_id }) });
        heads.set(context, activated.headRevision);
        built.push(row.generation_id);
      }
      return { generations: built, position: session.position };
    });
    let source = await buildSource(0);
    expect(performance.now() - prepared).toBeLessThan(600_000);
    const request = () => app.handle(new Request('http://main.local/v1/query', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        profile: 'resource-list-v1', context: 'global', scope: { kind: 'all' }, sort: 'newest', limit: 1,
        filter: { all: [{ facet: 'type', any: ['https://schema.org/CreativeWork'] }] },
      }),
    }));
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
        [source.generations, [work.work]],
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
      await f.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> INSERT DATA {
        GRAPH ${iri(GRAPHS.current)} { ${rows.map(row => row.current).join('\n')} }
        GRAPH ${iri(GRAPHS.revisions)} { ${rows.map(row => row.revision).join('\n')} } }`);
      // Cost control: an intentionally expensive count really sees the larger degree.
      const counted = (await f.fuseki.query(`PREFIX rv: <${RV}> SELECT (COUNT(?credit) AS ?count) WHERE {
        GRAPH ${iri(GRAPHS.current)} { ?credit a rv:NativeAgentCredit ; rv:work ${iri(work.work)} } }`))
        .results!.bindings[0]!.count!.value;
      expect(Number(counted)).toBe(degree + 3);
      // An unrelated projection degree challenges all four primary-key constraints.
      source = await buildSource(degree);
      await f.accessPool.query('ANALYZE access.discovery_entry');
      const expensive = await f.accessPool.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF) SELECT count(*) FROM access.discovery_entry WHERE generation_id=ANY($1::uuid[])',
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
    // The existing read envelope retries a moved graph at most twice, then
    // returns unavailable; it must not turn the stale cards into an empty page.
    await json(await request(), 503);
    await f.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?old } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ${sequence} } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?old } }`);
    expect(await inspect()).toEqual(baseline);
    await f.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(b!.actor)} rv:profileDisclosure ?old } }
      INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(b!.actor)} rv:profileDisclosure rv:Private } }
      WHERE { OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ${iri(b!.actor)} rv:profileDisclosure ?old } } }`);
    const privateAuthor = await json<{ result: { items: ResourceCard[] } }>(await request());
    expect(privateAuthor.result.items[0]!.work!.primaryCredits.map(credit => credit.displayName))
      .toEqual(['Lin Mei', '森圭']);
  } finally { await f.stop(); }
}, 600_000);
