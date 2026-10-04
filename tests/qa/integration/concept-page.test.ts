import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { CONCEPT_FACET } from '../../../services/main/src/modules/concept-page/contract.ts';
import { DISCOVERY_CONDITION_COST, DiscoveryProjection,
  discoveryConditionSql } from '../../../services/main/src/modules/discovery/store.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { startHomeStack } from './feed-read-support.ts';

const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const uuid = () => `https://rezics.com/id/${randomUUID()}`;
const short = (id: string) => id.slice(-36);
interface Generation { generation: string; checkpoint: string; complete: boolean; state: string }
interface ConceptRead { id: string; name: { value: string }; description: { value: string; language: string } | null;
  realm: string | null; facet: string; interpretations: string[]; broader: { id: string }[];
  narrower: { id: string; name: { value: string } }[]; moreNarrower: boolean; filter: unknown }
interface WorksPage { items: { id: string; match: { classification: { concept: string } | null } }[];
  values: { id: string; name: { value: string }; operator: string }[]; filter: unknown; stale: boolean;
  nextCursor: string | null; matches: { value: number; kind: string } }
interface FollowState { target: { id: string; kind: string; name: { value: string }; href: string };
  following: boolean | null; revision: string | null; followers: { value: number; kind: string } }
interface FollowReceipt { following: boolean; revision: string }

test('G-409 a Concept page lists Works through its Condition bar within its seek budget, and readers follow it',
  async () => {
    if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the integration tier');
    const home = await startHomeStack('concept-page');
    try {
      const { stack, author: a, reader: b } = home;
      const owner = new DiscoveryProjection(stack.accessPool);
      const app = createMainApp(stack.fuseki, { ...home.deps, discovery: owner,
        judgments: new AccessJudgments(stack.accessPool) });
      const call = (method: string, path: string, body?: unknown, token?: string, key = randomUUID()) => app.handle(
        new Request(`http://main.local${path}`, { method, headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }));
      const json = home.json;

      // Four public Works and three Concepts, accepted for everyone:
      // w1 Fantasy+Magic, w2 Fantasy, w3 Fantasy+Romance, w4 Magic.
      await a.grant(MANAGE_SCOPE, MANAGE_ACTION);
      await a.grant('classification:define:global', 'classification.proposition.define');
      await a.grant('classification:decide:global', 'classification.decision.set');
      const works = [];
      for (let index = 1; index <= 4; index++) works.push(await stack.publicWork(a.actor, ['en'], `Concept Work ${index}`));
      const [w1, w2, w3, w4] = works as [typeof works[number], typeof works[number], typeof works[number],
        typeof works[number]];
      const define = async (label: string) => json<{ concept: string; sense: string }>(await call('POST',
        '/v1/classification-propositions', { profile: 'classification-proposition-v1', label, actingSubject: a.actor },
        a.token), 201);
      const [fantasy, magic, romance] = [await define('Concept fantasy'), await define('Concept magic'),
        await define('Concept romance')];
      const accept = async (target: typeof w1, term: typeof fantasy) => json(await call('POST',
        '/v1/classification-decisions', { profile: 'classification-direct-decision-v1', work: target.work,
          mainVersion: target.mainVersion, sense: term.sense, context: { kind: 'global' }, outcome: 'accepted',
          expectedDecisionHead: null, actingSubject: a.actor }, a.token), 201);
      for (const [target, term] of [[w1, fantasy], [w1, magic], [w2, fantasy], [w3, fantasy], [w3, romance],
        [w4, magic]] as const) await accept(target, term);
      // Magic is narrower than Fantasy; a protected narrower Concept stays off the page.
      const hidden = uuid();
      await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX skos: <${SKOS}> INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${iri(fantasy.concept)} skos:definition "Stories of the impossible"@en, "Récits de l’impossible"@fr .
        ${iri(magic.concept)} skos:broader ${iri(fantasy.concept)} .
        ${iri(hidden)} a skos:Concept ; rv:conceptState rv:Active ; skos:prefLabel "Hidden"@en ;
          skos:broader ${iri(fantasy.concept)} ; rv:protectionHead ${iri(uuid())} . } }`);

      const build = async () => {
        let row = await json<Generation>(await call('POST', '/v1/discovery/generation-builds', {
          profile: 'discovery-generation-build-v1', actingSubject: a.actor,
          basis: { scope: 'global', realm: null, context: null } }, a.token));
        for (let steps = 0; !row.complete && steps < 20; steps++) {
          row = await json<Generation>(await call('POST', `/v1/discovery/generations/${row.generation}/advance`,
            { actingSubject: a.actor, expectedCheckpoint: row.checkpoint }, a.token));
        }
        expect(row).toMatchObject({ complete: true, state: 'ready' });
        const head = await json<{ activeHeadRevision: string | null }>(await call('GET',
          `/v1/discovery/generations/${row.generation}?actingSubject=${encodeURIComponent(a.actor)}`, undefined, a.token));
        await json(await call('POST', '/v1/discovery/generation-activations', {
          profile: 'discovery-generation-activation-v1', actingSubject: a.actor, generation: row.generation,
          expectedHeadRevision: head.activeHeadRevision }, a.token));
        return row;
      };
      await build();

      // What the Concept is: its definition in the reader's language, its narrower Concepts and its one Filter.
      const read = await json<ConceptRead>(await call('GET', `/v1/concepts/${short(fantasy.concept)}?language=fr`));
      expect(read).toMatchObject({ id: fantasy.concept, name: { value: 'Concept fantasy' }, realm: null,
        description: { value: 'Récits de l’impossible', language: 'fr' }, facet: CONCEPT_FACET,
        interpretations: [fantasy.sense], broader: [], moreNarrower: false,
        filter: { all: [{ facet: CONCEPT_FACET, any: [fantasy.concept] }] } });
      expect(read.narrower.map(item => [item.id, item.name.value])).toEqual([[magic.concept, 'Concept magic']]);
      expect((await json<ConceptRead>(await call('GET', `/v1/concepts/${short(magic.concept)}`))).broader
        .map(item => item.id)).toEqual([fantasy.concept]);
      for (const missing of [hidden, uuid(), w1.work]) {
        expect((await call('GET', `/v1/concepts/${short(missing)}`)).status).toBe(404);
      }

      // Its Works, and the Condition bar's combinations, in discovery's newest-first order.
      // Other files' Works may share the QA graph: read the whole population's order.
      const order: string[] = [];
      for (let cursor: string | null = null, pages = 0; pages < 20; pages++) {
        const population: { items: { id: string }[]; nextCursor: string | null } = await json(await call('GET',
          `/v1/works?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
        order.push(...population.items.map(item => item.id));
        if (!(cursor = population.nextCursor)) break;
      }
      expect(works.every(work => order.includes(work.work))).toBe(true);
      const listed = (...ids: string[]) => order.filter(id => ids.includes(id));
      const worksOf = async (query: string, concept = fantasy.concept, status = 200) => {
        const response = await call('GET', `/v1/concepts/${short(concept)}/works?${query}`);
        return status === 200 ? json<WorksPage>(response) : (expect(response.status).toBe(status), null);
      };
      const all = (await worksOf(''))!;
      expect(all.items.map(item => item.id)).toEqual(listed(w1.work, w2.work, w3.work));
      expect(all.items.every(item => item.match.classification?.concept === fantasy.concept)).toBe(true);
      expect(all).toMatchObject({ stale: false, nextCursor: null, matches: { value: 3, kind: 'exact' },
        values: [{ id: fantasy.concept, operator: 'include', name: { value: 'Concept fantasy' } }] });
      const q = (params: Record<string, string | string[]>) => Object.entries(params).flatMap(([key, value]) =>
        [value].flat().map(item => `${key}=${encodeURIComponent(item)}`)).join('&');
      const withMagic = (await worksOf(q({ include: magic.concept })))!;
      expect(withMagic.items.map(item => item.id)).toEqual([w1.work]);
      // With `all`, the rarer Magic drives the seek; a Work still lists as reached by the page's Concept or Magic.
      expect(withMagic.filter).toEqual({ all: [{ facet: CONCEPT_FACET, all: [fantasy.concept, magic.concept] }] });
      const anchoredAny = (await worksOf(q({ include: [magic.concept, romance.concept], match: 'any' })))!;
      expect(anchoredAny.items.map(item => item.id)).toEqual(listed(w1.work, w3.work));
      expect(anchoredAny.filter).toEqual({ all: [
        { facet: CONCEPT_FACET, all: [fantasy.concept] },
        { facet: CONCEPT_FACET, any: [magic.concept, romance.concept] },
      ] });
      expect((await worksOf(q({ include: magic.concept, match: 'any' })))!.items.map(item => item.id)).toEqual([w1.work]);
      expect((await worksOf(q({ exclude: romance.concept })))!.items.map(item => item.id))
        .toEqual(listed(w1.work, w2.work));
      const combined = (await worksOf(q({ include: magic.concept, match: 'any', exclude: romance.concept })))!;
      expect(combined.items.map(item => item.id)).toEqual([w1.work]);
      expect(combined.values.map(item => [item.id, item.operator])).toEqual([[fantasy.concept, 'include'],
        [magic.concept, 'include'], [romance.concept, 'exclude']]);
      expect((await worksOf(q({ include: [magic.concept, romance.concept] })))!.items).toEqual([]);

      // Pages resume where the last ended, and only under the same Condition and language.
      const seen: string[] = [];
      let page = (await worksOf(q({ limit: '1', match: 'any', include: [magic.concept, romance.concept] })))!;
      for (let steps = 0; steps < 6; steps++) {
        seen.push(...page.items.map(item => item.id));
        if (!page.nextCursor) break;
        expect(page.matches.kind).toBe('lower-bound');
        expect((await worksOf(q({ limit: '1', cursor: page.nextCursor }), fantasy.concept, 400))).toBeNull();
        page = (await worksOf(q({ limit: '1', match: 'any', include: [magic.concept, romance.concept], cursor: page.nextCursor })))!;
      }
      expect(seen).toEqual(listed(w1.work, w3.work));
      expect(page.matches).toEqual({ value: 2, kind: 'exact' });

      // Refused rather than empty: contradictions, unknown or hidden values, a personal scope, too many values.
      for (const query of [q({ include: magic.concept, exclude: magic.concept }), q({ exclude: fantasy.concept }),
        q({ include: fantasy.concept }), q({ scope: 'mine' }), q({ scope: 'realm' }),
        q({ include: Array.from({ length: 8 }, uuid) })]) await worksOf(query, fantasy.concept, 400);
      await worksOf(q({ include: hidden }), fantasy.concept, 404);
      await worksOf(q({ exclude: uuid() }), fantasy.concept, 404);
      await worksOf('', hidden, 404);
      await worksOf(q({ scope: 'realm', realm: uuid() }), fantasy.concept, 404);

      // A reader follows the Concept: its count is public, their follow is theirs alone.
      const reader = await home.provision('Concept reader', b.token);
      const signed = (path: string) => `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(reader)}`;
      const follow = (target: string, following: boolean, expectedRevision: string | null, kind = 'concept') =>
        call('POST', '/v1/follows', { profile: 'follow-command-v1', target, kind, actingSubject: reader, following,
          expectedRevision }, b.token);
      const state = async (signedIn = false) => json<FollowState>(await call('GET', signedIn
        ? signed(`/v1/follows/${short(fantasy.concept)}?kind=concept`) : `/v1/follows/${short(fantasy.concept)}?kind=concept`,
      undefined, signedIn ? b.token : undefined));
      expect(await state()).toMatchObject({ target: { id: fantasy.concept, kind: 'concept',
        name: { value: 'Concept fantasy' }, href: `/concepts/${short(fantasy.concept)}` }, following: null,
      followers: { value: 0, kind: 'exact' } });
      const followed = await json<FollowReceipt>(await follow(fantasy.concept, true, null));
      expect(followed.following).toBe(true);
      expect(await state(true)).toMatchObject({ following: true, revision: followed.revision,
        followers: { value: 1, kind: 'exact' } });
      expect((await state()).following).toBeNull();
      expect((await json<{ items: { id: string; kind: string; available: boolean; href: string }[] }>(await call('GET',
        signed('/v1/me/follows?kind=concept'), undefined, b.token))).items).toEqual([expect.objectContaining({
        id: fantasy.concept, kind: 'concept', available: true, href: `/concepts/${short(fantasy.concept)}` })]);
      expect((await follow(fantasy.concept, true, null)).status).toBe(409);
      expect((await follow(hidden, true, null)).status).toBe(404);
      expect((await follow(w1.work, true, null)).status).toBe(404);
      expect((await follow('open-library:OL21594A', true, null)).status).toBe(400);
      const unfollowed = await json<FollowReceipt>(await follow(fantasy.concept, false, followed.revision));
      expect(unfollowed.following).toBe(false);
      expect(await state(true)).toMatchObject({ following: false, followers: { value: 0, kind: 'exact' } });

      // A newer decision leaves the active generation stale: its matches are withheld until a rebuild.
      await accept(w4, fantasy);
      const stale = (await worksOf(''))!;
      expect(stale).toMatchObject({ stale: true, items: [], matches: { kind: 'lower-bound' } });
      await build();
      expect((await worksOf(''))!.items.map(item => item.id).sort()).toEqual([w1.work, w2.work, w3.work, w4.work].sort());

      // Measured seek budget at 20,000 Works: one drive term, a group and an exclusion, first and later pages.
      const planBuild = await json<Generation>(await call('POST', '/v1/discovery/generation-builds', {
        profile: 'discovery-generation-build-v1', actingSubject: a.actor,
        basis: { scope: 'global', realm: null, context: null } }, a.token));
      const [often, rare, never] = [uuid(), uuid(), uuid()];
      await stack.accessPool.query(`INSERT INTO access.discovery_entry
        (generation_id, work, work_type, term, recent_order, rating_count, rating_sum, payload)
        SELECT $1, 'https://rezics.com/id/00000000-0000-4000-8000-' || lpad(i::text,12,'0'), '', term, i, 0, 0,
          '{}'::jsonb FROM generate_series(1,20000) i
        CROSS JOIN LATERAL unnest(ARRAY['', CASE WHEN i % 2 = 0 THEN $2 END, CASE WHEN i % 50 = 0 THEN $3 END,
          CASE WHEN i % 3 = 0 THEN $4 END]) term WHERE term IS NOT NULL`,
      [planBuild.generation, often, rare, never]);
      await stack.accessPool.query('ANALYZE access.discovery_entry');
      const nodes = (node: Record<string, unknown>): Record<string, unknown>[] =>
        [node, ...((node.Plans ?? []) as Record<string, unknown>[]).flatMap(nodes)];
      for (const continued of [false, true]) {
        const explained = await stack.accessPool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
          ${discoveryConditionSql(1, true, continued)}`, [planBuild.generation, '0', '', [often], DISCOVERY_CONDITION_COST.window,
          ...continued ? ['10000', 'https://rezics.com/id/00000000-0000-4000-8000-000000010000'] : [], [rare], [never]]);
        const plan = explained.rows[0]['QUERY PLAN'][0].Plan;
        const planned = nodes(plan);
        // Global membership can use the narrower partial index added for topic
        // ranking; both indexes perform the same bounded per-Work probes.
        const membershipIndexes = ['discovery_entry_pkey', 'discovery_topic_work'];
        expect(planned.some(node => node['Index Name'] === 'discovery_recent_seek')).toBe(true);
        expect(planned.some(node => membershipIndexes.includes(String(node['Index Name'])))).toBe(true);
        expect(planned.some(node => ['Seq Scan', 'Sort', 'Hash'].includes(String(node['Node Type'])))).toBe(false);
        expect(Number(plan['Actual Rows'])).toBeLessThanOrEqual(DISCOVERY_CONDITION_COST.window);
        // Each drive row costs at most one probe per group and one for the exclusion.
        const probes = planned.filter(node => membershipIndexes.includes(String(node['Index Name'])))
          .reduce((sum, node) => sum + Number(node['Actual Loops'] ?? 0), 0);
        expect(probes).toBeLessThanOrEqual(2 * DISCOVERY_CONDITION_COST.window);
        console.log(`concept condition seek: ${JSON.stringify({ continued, rows: plan['Actual Rows'], probes,
          blocks: plan['Shared Hit Blocks'], ms: plan['Actual Total Time'] })}`);
      }
      const active = await owner.active({ scope: 'global', realm: null, context: null, owner: null },
        (await json<{ sourcePosition: { dataEpoch: string; sequence: string } }>(await call('GET', '/v1/works'))).sourcePosition);
      const synthetic = { ...active, generation_id: planBuild.generation, storage_generation: null, storage_version: '0' };
      const first = await owner.conditionPage(synthetic, '', { drive: [often], groups: [[rare]], excluded: [never] }, 20);
      // In 60 even Works only the multiples of 50 not of 3 match: 50 and 100 of 2..120.
      expect(first.rows.map(item => Number(item.order_key))).toEqual([50, 100]);
      expect(first.next).toEqual({ key: '120', work: 'https://rezics.com/id/00000000-0000-4000-8000-000000000120' });
      const rarest = await owner.conditionPage(synthetic, '', { drive: [rare], groups: [[often]], excluded: [never] }, 20);
      expect(rarest.rows.map(item => Number(item.order_key))).toEqual([50, 100, 200, 250, 350, 400, 500, 550, 650, 700,
        800, 850, 950, 1000, 1100, 1150, 1250, 1300, 1400, 1450]);
      await json(await call('POST', `/v1/discovery/generations/${planBuild.generation}/cancel`,
        { actingSubject: a.actor }, a.token));
    } finally { await home.stop(); }
  }, 300_000);
