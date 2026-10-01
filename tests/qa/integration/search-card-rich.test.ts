import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from './media-support.ts';
import { mainSelectionDigest, selectMainDefault }
  from '../../../services/main/src/modules/work/select-main.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../../../services/main/src/modules/work/activate.ts';

test('public phrase page hydrates current Work card fields after the bounded search relation', async () => {
  const stack = await startMediaStack('search-card-rich');
  try {
    const member = await stack.member('writer');
    const created = await stack.privateWork(member.actor, 'A named search card');
    const phrase = `richcard${randomUUID().replaceAll('-', '')}`;
    const source = await stack.contribution(created.work, member.actor, 'en', `${phrase} body`);
    const input = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work, contribution: source.contribution, publicationDecision: source.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: member.actor };
    const selection = await selectMainDefault(stack.env,
      stack.admission(member.actor, `publication:select:${created.mainVersion}`,
        'publication.select', mainSelectionDigest(input)), input);
    expect(selection.outcome).toBe('succeeded');
    const response = await stack.call('POST', '/v1/queries/page', { body: {
      profile: 'public-main-phrase-page-v1', phrase, language: 'en', pageSize: 20 } });
    expect(response.status).toBe(200);
    const page = await response.json() as { total: number; results: Array<{ work: string;
      title: { value: string }; cover: { kind: string }; primaryCredits: unknown[];
      rating: null; tagline: null; completionStatus: null }> };
    expect(page.total).toBe(1);
    expect(page.results).toMatchObject([{ work: created.work, title: { value: 'A named search card' },
      cover: { kind: 'fallback' }, primaryCredits: [], rating: null,
      tagline: null, completionStatus: null }]);
  } finally { await stack.stop(); }
});

async function json(response: Response, status = 200): Promise<Record<string, any>> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body);
}

test('CTX02/CTX09: one and twenty rich cards use the same graph budget and exact sealed ratings', async () => {
  const stack = await startMediaStack('search-card-batch');
  try {
    const member = await stack.member('writer');
    const phrase = `batchcards${randomUUID().replaceAll('-', '')}`;
    const works = [];
    for (let index = 0; index < 20; index++) {
      works.push(await stack.publicWork(member.actor, ['en'], `${phrase} ${index}`));
    }
    const realmInput = { name: phrase, actingSubject: member.actor };
    const realm = await createRealmSpace(stack.env, stack.admission(member.actor,
      'space:create:root', 'space.create', spaceCreationDigest(realmInput)), realmInput);
    expect(realm.outcome).toBe('succeeded');
    await member.grant(`rating:context:${realm.realm}`, 'rating.context.create');
    const { context } = await json(await member.send('POST', '/v1/rating-contexts', {
      profile: 'realm-standing-rating-context-v1', realm: realm.realm,
      question: 'Quality?', actingSubject: member.actor,
    }), 201);
    await member.grant(`rating:observe:${context}`, 'rating.observation.set');
    for (const [index, work] of works.slice(0, 3).entries()) {
      await json(await member.send('POST', '/v1/rating-observations', {
        profile: 'realm-standing-rating-observation-v1', context, work: work.work,
        mainVersion: work.mainVersion, value: index + 2, expectedRevisionHead: null, actingSubject: member.actor,
      }), 201);
    }
    const first = works[0]!;
    await member.grant(`work:edit:${first.work}`, 'work.edit');
    await json(await member.send('PUT', `/v1/works/${first.work.slice(-36)}/metadata`, {
      profile: 'work-metadata-details-v1', expectedHead: null, actingSubject: member.actor,
      state: { kind: 'header', originalTitle: null, completionStatus: 'completed', localized: [{
        language: 'en', title: null, description: null, mainVersionLabel: null, tagline: 'Exact page facts',
      }] },
    }));
    const deps = { environment: stack.env, access: stack.access, media: stack.media,
      account: { verify: async () => member.principal }, serialStats: {
        batch: async (ids: readonly string[]) => new Map(ids.map(id => [id,
          { chapterCount: 7, wordCount: 900, lastUpdatedAt: '2026-09-27T00:00:00.000Z' }])),
      } } as unknown as Parameters<typeof createMainApp>[1];
    const app = createMainApp(stack.fuseki, deps);
    const search = (pageSize: number) => app.handle(new Request('http://main.local/v1/queries/page', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        profile: 'public-realm-phrase-page-v1', context: { kind: 'realm-local', id: realm.realm },
        phrase, language: 'en', pageSize,
      }),
    }));
    await json(await search(1)); // qualify the shared native index before measuring page growth
    stack.fuseki.queries = 0;
    const one = await json(await search(1));
    const singleCalls = stack.fuseki.queries;
    stack.fuseki.queries = 0;
    const many = await json(await search(20));
    const pageCalls = stack.fuseki.queries;
    expect(pageCalls).toBe(singleCalls);
    expect(pageCalls).toBeLessThanOrEqual(8);
    expect(one.total).toBe(20);
    expect(many.total).toBe(20);
    expect(many.results).toHaveLength(20);
    expect(many.facets).toEqual(one.facets);
    for (const [index, work] of works.entries()) {
      const card = many.results.find((row: { work: string }) => row.work === work.work);
      expect(card).toMatchObject({ title: { value: work.title }, cover: { kind: 'fallback' },
        primaryCredits: [], chapterCount: 7, wordCount: 900,
        tagline: index === 0 ? { value: 'Exact page facts' } : null,
        completionStatus: index === 0 ? 'completed' : null,
        ratingStatus: index < 3 ? 'available' : 'unrated',
        rating: index < 3 ? { context, count: 1, mean: index + 2, sum: index + 2 } : null });
    }
    await Bun.write(`.temp/search-card-cost-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify({ singleCalls, pageCalls }));
    const nativeQuery = stack.fuseki.query.bind(stack.fuseki);
    stack.fuseki.query = async (query, maxBytes) => {
      const result = await nativeQuery(query, maxBytes);
      if (query.includes('?targetWork')) {
        const observation = result.results?.bindings.find(row => row.kind?.value === 'observation');
        if (observation) delete observation.head;
      }
      return result;
    };
    await json(await search(20), 503);
    stack.fuseki.query = nativeQuery;
    const fence = stack.access.checkRatingAggregateFence.bind(stack.access);
    stack.access.checkRatingAggregateFence = async () => false;
    await json(await search(20), 503);
    stack.access.checkRatingAggregateFence = fence;
    expect((await json(await search(20))).results).toEqual(many.results);
  } finally { await stack.stop(); }
}, 120_000);

test('CTX02/CTX09: cached card facts retry graph movement and still fence live title disclosure', async () => {
  const stack = await startMediaStack('search-card-fence');
  try {
    const member = await stack.member('writer');
    const phrase = `fencedcard${randomUUID().replaceAll('-', '')}`;
    const work = await stack.publicWork(member.actor, ['en'], `${phrase} before`);
    const nativeQuery = stack.fuseki.query.bind(stack.fuseki);
    let move = true, cardBatches = 0;
    stack.fuseki.query = async (query, maxBytes) => {
      const result = await nativeQuery(query, maxBytes);
      if (query.includes('?searchCardRead')) {
        cardBatches++;
        if (move) {
          move = false;
          await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
            DELETE { GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} rdfs:label ?old }
              GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence } }
            INSERT { GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} rdfs:label ${lit(`${phrase} after`)}@en }
              GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next } }
            WHERE { GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} rdfs:label ?old }
              GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?sequence }
              BIND(?sequence + 1 AS ?next) }`);
        }
      }
      return result;
    };
    const search = (app: ReturnType<typeof createMainApp>) => app.handle(new Request('http://main.local/v1/queries/page', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        profile: 'public-main-phrase-page-v1', phrase, language: 'en', pageSize: 20,
      }),
    }));
    expect((await json(await search(stack.main))).results)
      .toMatchObject([{ work: work.work, title: { value: `${phrase} after` } }]);
    expect(cardBatches).toBe(2);
    let summaryChecks = 0;
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      account: { verify: async () => member.principal }, governance: { store: {
        disclosure: { read: async (targets: readonly { resource: string }[], _viewer: unknown, channel: string) => {
          // Switch the live Disclosure owner after the first card summary was admitted.
          if (channel === 'summary' && cardBatches >= 3) summaryChecks++;
          return targets.map(target => summaryChecks >= 2 && target.resource === work.work
            ? channel === 'summary' ? 'tombstone' : 'hidden' : 'visible');
        } },
      } } } as unknown as Parameters<typeof createMainApp>[1]);
    const response = await search(app);
    const result = await response.text();
    expect([200, 503]).toContain(response.status);
    expect(result).not.toContain(`${phrase} after`);
    expect(summaryChecks).toBeGreaterThanOrEqual(2);
  } finally { await stack.stop(); }
}, 30_000);
