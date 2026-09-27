import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { DiscoveryProjection, discoverySeekSql } from '../../../services/main/src/modules/discovery/store.ts';
import type { DiscoveryBasis } from '../../../services/main/src/modules/discovery/contract.ts';
import { MANAGE_ACTION, MANAGE_SCOPE, RecommendationStale } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';

async function json<T>(response: Response, status = 200): Promise<T> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return JSON.parse(body) as T;
}
interface Generation { generation: string; checkpoint: string; complete: boolean; state: string; replayed: boolean }
interface Page { items: { id: string; rating: { mean: number; count: number; sum: number } | null;
  primaryCredits: { ordinal: number; key: string; displayName: null }[];
  classifications: { sense: string; name: { value: string; language: string; basis: string } }[];
  match: { classification: { source: string; decision: string; name: { value: string; language: string } } | null } }[];
  matchedTerm: { sense: string; name: { value: string; language: string } } | null;
  nextCursor: string | null; matches: { value: number; kind: string }; count: { value: number; kind: string; total: null } }
const uuid = () => `https://rezics.com/id/${randomUUID()}`;

// Run this file alone: its restore/Access invalidation probes deliberately fence
// the entire dataset. tests/qa/integration is automatically registered by QA.
test('Discovery projection: native scoped reads, durable builds, disclosure, cursor and source fences', async () => {
  const stack = await startMediaStack('discovery');
  try {
    const a = await stack.member('a'), b = await stack.member('b'), outsider = await stack.member('outsider');
    await a.grant(MANAGE_SCOPE, MANAGE_ACTION);
    const first = await stack.publicWork(a.actor, ['en'], 'Discovery first');
    const second = await stack.publicWork(a.actor, ['en'], 'Discovery second');
    const third = await stack.publicWork(a.actor, ['en'], 'Discovery unrated');
    const hidden = await stack.privateWork(a.actor, 'Discovery private');
    await a.grant(`work:read:${hidden.work}`, 'work.read');
    const erased = await stack.publicWork(a.actor, ['en'], 'Discovery erased');
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT {
      GRAPH ${iri(GRAPHS.current)} { ${iri(first.work)} a <https://schema.org/Book> .
        ${iri(second.work)} a <https://schema.org/Recipe> . ${iri(third.work)} a <https://schema.org/DigitalDocument> . }
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:ErasedRevision }
    } WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(erased.work)} rv:head ?head } }`);
    await a.grant('space:create:root', 'space.create');
    const realm = await json<{ realm: string; space: string }>(await a.send('POST', '/v1/spaces',
      { profile: 'space-realm-v1', name: 'Discovery Realm', capabilities: ['realm'], actingSubject: a.actor }), 201);
    await a.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    await a.grant(`rating:context:${realm.realm}`, 'rating.context.create');
    const global = await json<{ context: string }>(await a.send('POST', '/v1/global-rating-contexts',
      { profile: 'global-rating-standing-context-v1', question: 'Global quality', actingSubject: a.actor }), 201);
    const local = await json<{ context: string }>(await a.send('POST', '/v1/rating-contexts',
      { profile: 'realm-standing-rating-context-v1', realm: realm.realm, question: 'Local quality', actingSubject: a.actor }), 201);
    const other = await json<{ context: string }>(await a.send('POST', '/v1/global-rating-contexts',
      { profile: 'global-rating-standing-context-v1', question: 'Would you recommend this?', actingSubject: a.actor }), 201);
    for (const [member, target, value, context, path, profile] of [
      [a, first, 5, global.context, 'global-rating-observations', 'global-rating-standing-observation-v1'],
      [b, first, 1, global.context, 'global-rating-observations', 'global-rating-standing-observation-v1'],
      [a, second, 4, global.context, 'global-rating-observations', 'global-rating-standing-observation-v1'],
      [a, first, 8, local.context, 'rating-observations', 'realm-standing-rating-observation-v1'],
      [a, second, 2, local.context, 'rating-observations', 'realm-standing-rating-observation-v1'],
    ] as const) {
      await member.grant(`rating:observe:${context}`, 'rating.observation.set');
      await json(await member.send('POST', `/v1/${path}`, { profile, context, work: target.work,
        mainVersion: target.mainVersion, value, expectedRevisionHead: null, actingSubject: member.actor }), 201);
    }
    for (const [scope, action] of [['classification:define:global', 'classification.proposition.define'],
      ['classification:decide:global', 'classification.decision.set'],
      [`classification:context:${realm.realm}`, 'classification.context.configure'],
      [`classification:decide:${realm.realm}`, 'classification.decision.set']] as const) await a.grant(scope, action);
    await json(await a.send('POST', '/v1/classification-contexts',
      { profile: 'classification-context-v1', realm: realm.realm, actingSubject: a.actor }), 201);
    const term = await json<{ sense: string; concept: string }>(await a.send('POST', '/v1/classification-propositions',
      { profile: 'classification-proposition-v1', label: 'Discovery adventure', actingSubject: a.actor }), 201);
    await stack.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(term.concept)} <http://www.w3.org/2004/02/skos/core#prefLabel> "Aventure"@fr . } }`);
    for (const target of [first, second]) await json(await a.send('POST', '/v1/classification-decisions', {
      profile: 'classification-direct-decision-v1', work: target.work, mainVersion: target.mainVersion,
      sense: term.sense, context: { kind: 'global' }, outcome: 'accepted', expectedDecisionHead: null, actingSubject: a.actor }), 201);
    await json(await a.send('POST', '/v1/classification-decisions', {
      profile: 'classification-direct-decision-v1', work: first.work, mainVersion: first.mainVersion,
      sense: term.sense, context: { kind: 'realm-classification', id: realm.realm }, outcome: 'rejected',
      expectedDecisionHead: null, actingSubject: a.actor }), 201);

    const owner = new DiscoveryProjection(stack.accessPool);
    const people = [a, b, outsider];
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      discovery: owner, media: stack.media, judgments: new AccessJudgments(stack.accessPool),
      account: { verify: async request => {
        const member = people.find(person => request.headers.get('authorization') === `Bearer ${person.token}`);
        if (!member) throw new AccountAssertionDenied('Unknown bearer');
        return member.principal;
      } } });
    const call = (path: string, body?: unknown, member = a, receipt = randomUUID()) => app.handle(new Request(
      `http://main.local${path}`, { method: body ? 'POST' : 'GET', headers: {
        authorization: `Bearer ${member.token}`, 'content-type': 'application/json', 'idempotency-key': receipt },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const get = (params: Record<string, string> = {}, member = a) => call(`/v1/works?${new URLSearchParams(params)}`, undefined, member);
    const base: DiscoveryBasis = { scope: 'global', realm: null, context: null };
    interface ContextPage { items: { context: string; question: string; scale: { min: number; max: number; step: number } }[];
      nextCursor: string | null }
    const contexts = await json<ContextPage>(await call('/v1/rating-contexts?limit=1'));
    const remainingContexts = await json<ContextPage>(await call(`/v1/rating-contexts?cursor=${contexts.nextCursor}`));
    expect([...contexts.items, ...remainingContexts.items].map(item => item.context).sort())
      .toEqual([global.context, other.context].sort());
    expect([...contexts.items, ...remainingContexts.items].find(item => item.context === global.context))
      .toMatchObject({ question: 'Global quality', scale: { min: 1, max: 5, step: 1 } });
    expect(await json<ContextPage>(await call(`/v1/rating-contexts?scope=realm&realm=${encodeURIComponent(realm.realm)}`)))
      .toMatchObject({ items: [{ context: local.context, question: 'Local quality', scale: { min: 1, max: 10, step: 1 } }] });
    expect((await call('/v1/rating-contexts?scope=realm')).status).toBe(400);
    expect((await call('/v1/rating-contexts?scope=mine')).status).toBe(400);
    expect((await call(`/v1/rating-contexts?scope=realm&realm=${encodeURIComponent(uuid())}`)).status).toBe(404);
    expect((await call(`/v1/rating-contexts?scope=realm&realm=${encodeURIComponent(realm.realm)}&cursor=${contexts.nextCursor}`)).status).toBe(400);
    const buildBody = (basis: DiscoveryBasis, member = a) =>
      ({ profile: 'discovery-generation-build-v1', actingSubject: member.actor, basis });
    const register = (basis: DiscoveryBasis, member = a, key = randomUUID()) =>
      call('/v1/discovery/generation-builds', buildBody(basis, member), member, key);
    const advance = (generation: Generation, member = a) => call(`/v1/discovery/generations/${generation.generation}/advance`,
      { actingSubject: member.actor, expectedCheckpoint: generation.checkpoint }, member);
    const activate = (generation: string, expectedHeadRevision: string | null = null, member = a) =>
      call('/v1/discovery/generation-activations', { profile: 'discovery-generation-activation-v1',
        actingSubject: member.actor, generation, expectedHeadRevision }, member);
    const build = async (basis: DiscoveryBasis, member = a, expected: string | null = null) => {
      let row = await json<Generation>(await register(basis, member));
      for (let steps = 0; !row.complete && steps < 10; steps++) row = await json<Generation>(await advance(row, member));
      expect(row.complete).toBe(true);
      expect(row.state).toBe('ready');
      await json(await activate(row.generation, expected, member));
      return row;
    };
    expect((await get()).status).toBe(503);
    expect((await register(base, outsider)).status).toBe(403);
    expect((await register(base, b)).status).toBe(403);
    const receipt = randomUUID();
    let pending = await json<Generation>(await register(base, a, receipt));
    expect(await json(await register(base, a, receipt))).toMatchObject({ generation: pending.generation, replayed: true });
    expect((await register({ ...base, context: global.context }, a, receipt)).status).toBe(409);
    expect((await activate(pending.generation)).status).toBe(409);
    const racers = await Promise.all([advance(pending), advance(pending)]);
    expect(racers.map(response => response.status).sort()).toEqual([200, 409]);
    pending = await json<Generation>(racers.find(response => response.status === 200)!);
    while (!pending.complete) pending = await json<Generation>(await advance(pending));
    await json(await activate(pending.generation));
    expect(await json(await call(`/v1/discovery/generations/${pending.generation}?actingSubject=${encodeURIComponent(a.actor)}`)))
      .toMatchObject({ activeHeadRevision: '1' });
    const globalRank = await build({ ...base, context: global.context });
    await build({ scope: 'realm', realm: realm.realm, context: local.context });
    await build({ scope: 'mine', realm: null, context: global.context });
    const bMine = await build({ scope: 'mine', realm: null, context: global.context }, b);
    expect((await call(`/v1/discovery/generations/${bMine.generation}?actingSubject=${encodeURIComponent(a.actor)}`)).status).toBe(404);

    const page = await json<Page>(await get({ limit: '1' }));
    expect(page.items.map(item => item.id)).toEqual([third.work]);
    expect(page.matches).toEqual({ value: 1, kind: 'lower-bound' });
    expect(page.count).toEqual({ value: 1, kind: 'exact-page', total: null });
    const rest = await json<Page>(await get({ cursor: page.nextCursor! }));
    expect(rest.items.map(item => item.id)).toEqual([second.work, first.work]);
    expect(rest.matches).toEqual({ value: 3, kind: 'exact' });
    expect(rest.nextCursor).toBeNull();
    expect((await get({ cursor: page.nextCursor!, language: 'ja' })).status).toBe(400);
    expect((await get({ cursor: 'bad' })).status).toBe(400);
    expect((await get({ limit: '21' })).status).toBe(400);
    expect((await get({ sort: 'top-rated' })).status).toBe(400);
    expect((await get({ scope: 'realm' })).status).toBe(400);
    expect((await get({ scope: 'realm', realm: uuid() })).status).toBe(404);
    expect((await get({ scope: 'mine', context: global.context })).status).toBe(400);
    expect((await get({ scope: 'mine', context: global.context, actingSubject: a.actor, term: term.sense })).status).toBe(400);
    expect((await get({ context: local.context })).status).toBe(404);
    expect((await get({ context: uuid() })).status).toBe(404);
    const filtered = await json<Page>(await get({ type: 'https://schema.org/Book', term: term.sense }));
    expect(filtered.items.map(item => item.id)).toEqual([first.work]);
    expect(filtered.items[0]?.match.classification).toMatchObject({ source: 'global' });
    expect(filtered.matchedTerm).toMatchObject({ sense: term.sense, name: { value: 'Discovery adventure', language: 'en' } });
    const translated = await json<Page>(await get({ term: term.sense, language: 'fr' }));
    expect(translated.matchedTerm).toMatchObject({ sense: term.sense, name: { value: 'Aventure', language: 'fr' } });
    expect(translated.items[0]?.classifications[0]?.name).toMatchObject({ value: 'Aventure', basis: 'requested' });
    expect(translated.items[0]?.primaryCredits).toEqual([]);
    expect((await json<Page>(await get({ term: uuid() }))).matches).toEqual({ value: 0, kind: 'exact' });
    const beforeReads = stack.fuseki.queries;
    const ranked = await json<Page>(await get({ sort: 'top-rated', context: global.context }));
    expect(stack.fuseki.queries - beforeReads).toBeLessThanOrEqual(8);
    expect(ranked.items.map(item => item.id)).toEqual([second.work, first.work]);
    expect(ranked.items.map(item => item.rating?.mean)).toEqual([4, 3]);
    const localPage = await json<Page>(await get({ sort: 'top-rated', scope: 'realm', realm: realm.realm, context: local.context }));
    expect(localPage.items.map(item => item.id)).toEqual([first.work, second.work]);
    expect((await json<Page>(await get({ scope: 'realm', realm: realm.realm, context: local.context,
      term: term.sense }))).items.map(item => item.id)).toEqual([second.work]);
    const mine = await json<Page>(await get({ sort: 'top-rated', scope: 'mine', context: global.context,
      actingSubject: a.actor, limit: '1' }));
    expect(mine.items.map(item => item.id)).toEqual([first.work]);
    expect(mine.items[0]?.rating?.mean).toBe(5);
    expect((await get({ sort: 'top-rated', scope: 'mine', context: global.context, actingSubject: b.actor,
      cursor: mine.nextCursor! }, b)).status).toBe(400);
    expect((await json<Page>(await get({ scope: 'mine', context: global.context, actingSubject: b.actor }, b)))
      .items.map(item => item.id)).toEqual([first.work]);
    expect((await app.handle(new Request(`http://main.local/v1/works?scope=mine&context=${encodeURIComponent(global.context)}`))).status).toBe(401);
    expect((await get()).headers.get('cache-control')).toBe('no-store');

    // Measured native index seeks: selective facets and deep cursors at 20k Works.
    // Synthetic rows exercise storage complexity only, never domain acceptance.
    const planBuild = await json<Generation>(await register(base));
    await stack.accessPool.query(`INSERT INTO access.discovery_entry
      (generation_id, work, work_type, term, recent_order, rating_count, rating_sum, payload)
      SELECT $1, 'https://rezics.com/id/00000000-0000-4000-8000-' || lpad(i::text,12,'0'),
        kind, term, i, 1, 1 + i % 5, '{}'::jsonb
      FROM generate_series(1,20000) i
      CROSS JOIN LATERAL unnest(ARRAY['', CASE WHEN i % 2 = 0
        THEN 'https://schema.org/Book' ELSE 'https://schema.org/Recipe' END]) kind
      CROSS JOIN LATERAL unnest(ARRAY['', CASE WHEN i % 100 = 0 THEN $2 ELSE $3 END]) term`,
    [planBuild.generation, term.sense, uuid()]);
    await stack.accessPool.query('ANALYZE access.discovery_entry');
    for (const sort of ['recent', 'top-rated'] as const) for (const type of ['', 'https://schema.org/Book']) {
      for (const filter of ['', term.sense]) for (const continued of [false, true]) {
      const explained = await stack.accessPool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${discoverySeekSql(sort, continued)}`,
        [planBuild.generation, type, filter, 21, ...(continued ? [sort === 'recent' ? '10000' : '-1',
          'https://rezics.com/id/00000000-0000-4000-8000-000000010000'] : [])]);
      const plan = explained.rows[0]['QUERY PLAN'][0].Plan;
      const nodes = (node: Record<string, unknown>): Record<string, unknown>[] =>
        [node, ...((node.Plans ?? []) as Record<string, unknown>[]).flatMap(nodes)];
      const all = nodes(plan);
      expect(all.some(node => node['Index Name'] === (sort === 'recent' ? 'discovery_recent_seek' : 'discovery_rating_seek'))).toBe(true);
      expect(all.some(node => node['Node Type'] === 'Sort' || node['Node Type'] === 'Seq Scan')).toBe(false);
      expect(Math.max(...all.map(node => Number(node['Actual Rows'] ?? 0)))).toBeLessThanOrEqual(21);
      expect(all.reduce((sum, node) => sum + Number(node['Rows Removed by Filter'] ?? 0), 0)).toBe(0);
      expect(all.filter(node => node['Index Name']).reduce((sum, node) => sum + Number(node['Index Searches'] ?? 0), 0)).toBe(1);
      console.log(`discovery seek: ${JSON.stringify({ sort, type, filter, continued, rows: plan['Actual Rows'],
        blocks: plan['Shared Hit Blocks'], ms: plan['Actual Total Time'] })}`);
      }
    }
    await json(await call(`/v1/discovery/generations/${planBuild.generation}/cancel`, { actingSubject: a.actor }));
    const leaseBuild = await json<Generation>(await register(base));
    const manager = { principal: a.principal, actingSubject: a.actor };
    const oldLease = await owner.beginStep(manager, leaseBuild.generation, '');
    await stack.accessPool.query(`UPDATE access.derived_generation SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = $1`, [leaseBuild.generation]);
    const newLease = await owner.beginStep(manager, leaseBuild.generation, '');
    expect(BigInt(newLease.lease)).toBeGreaterThan(BigInt(oldLease.lease));
    await expect(owner.commitStep(manager, leaseBuild.generation, oldLease.lease, '',
      { after: '', complete: true, item: null }, { dataEpoch: stack.env.lineage.dataEpoch,
        sequence: oldLease.row.source_sequence })).rejects.toBeInstanceOf(RecommendationStale);
    await owner.cancel(manager, leaseBuild.generation);
    const fenceBefore = (await stack.accessPool.query('SELECT revision FROM access.discovery_source_fence')).rows[0].revision;
    const rollback = await stack.accessPool.connect();
    try {
      await rollback.query('BEGIN');
      await rollback.query('UPDATE access.principal SET active = false WHERE id = $1', [outsider.principalId]);
      await rollback.query('ROLLBACK');
    } finally { rollback.release(); }
    expect((await stack.accessPool.query('SELECT revision FROM access.discovery_source_fence')).rows[0].revision).toBe(fenceBefore);
    // Actual Access invalidation during graph hydration withholds the response.
    const originalQuery = stack.fuseki.query.bind(stack.fuseki);
    let invalidated = false;
    stack.fuseki.query = async (sparql, maxBytes) => {
      const result = await originalQuery(sparql, maxBytes);
      if (!invalidated && sparql.includes('SELECT ?epoch ?sequence ?hold ?r')) {
        invalidated = true;
        await stack.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [outsider.principalId]);
      }
      return result;
    };
    try { expect((await get()).status).toBe(409); } finally { stack.fuseki.query = originalQuery; }
    expect(invalidated).toBe(true);
    expect((await get({ cursor: page.nextCursor! })).status).toBe(409);
    expect((await activate(globalRank.generation, '1')).status).toBe(409);
    await build(base, a, '1');
    expect((await get()).status).toBe(200);
    expect((await get({ cursor: page.nextCursor! })).status).toBe(409);

    // Post-cutover Statement classification and spoiler protection use the real
    // owner. Empty baseline inserts must not churn the discovery source fence.
    await a.grant('statement:migrate:root', 'statement.migrate');
    await a.grant('statement:migrate:root', 'statement.cutover');
    const migration = await json<{ pending: { application: string; decision: string }[] }>(
      await a.read('/v1/statement-migrations/v1/pending'));
    for (const item of migration.pending) await json(await a.send('POST',
      `/v1/statement-migrations/v1/${item.application.slice(-36)}`, { profile: 'statement-migration-v1',
        expectedDecision: item.decision, actingSubject: a.actor }), 201);
    await json(await a.send('POST', '/v1/statement-migrations/v1/cutover',
      { profile: 'statement-cutover-v1', actingSubject: a.actor }), 201);
    await a.grant('classification:decide:global', 'statement.decide');
    const hint = (value: string, expectedGeneration: string) => call(`/v1/concepts/${term.concept.slice(-36)}/spoiler-hints`,
      { profile: 'concept-spoiler-hint-v1', context: { kind: 'global' }, hint: value, expectedGeneration, actingSubject: a.actor });
    await json(await hint('not-spoiler', '0'), 201);
    await build(base, a, '2');
    expect((await json<Page>(await get({ term: term.sense }))).items.length).toBe(2);
    await json(await hint('major', '1'), 201);
    expect((await get({ term: term.sense })).status).toBe(409);
    await build(base, a, '3');
    expect((await json<Page>(await get({ term: term.sense }))).matches).toEqual({ value: 0, kind: 'exact' });
    const candidates: Generation[] = [];
    for (let i = 0; i < 2; i++) {
      let generation = await json<Generation>(await register(base));
      while (!generation.complete) generation = await json<Generation>(await advance(generation));
      candidates.push(generation);
    }
    const activationRace = await Promise.all(candidates.map(row => activate(row.generation, '4')));
    expect(activationRace.map(response => response.status).sort()).toEqual([200, 409]);
    // Private Realm and absent Realm remain indistinguishable, even to its creator.
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(realm.space)} rv:disclosure rv:Public } } INSERT { GRAPH ${iri(GRAPHS.current)} {
      ${iri(realm.space)} rv:disclosure rv:Private } } WHERE {}`);
    expect((await get({ scope: 'realm', realm: realm.realm, context: local.context })).status).toBe(404);
    expect((await call(`/v1/rating-contexts?scope=realm&realm=${encodeURIComponent(realm.realm)}`)).status).toBe(404);
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA {
      GRAPH ${iri(GRAPHS.control)} { <urn:rezics:dataset:product> rv:restoreHold true } }`);
    expect((await get()).status).toBe(503);
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA {
      GRAPH ${iri(GRAPHS.control)} { <urn:rezics:dataset:product> rv:restoreHold true } }`);
    // A normal graph write invalidates source positions and old cursors.
    await stack.publicWork(a.actor, ['en'], 'Discovery changed');
    expect((await get({ cursor: page.nextCursor! })).status).toBe(409);
    expect((await call(`/v1/rating-contexts?cursor=${contexts.nextCursor}`)).status).toBe(409);
  } finally { await stack.stop(); }
}, 240_000);
