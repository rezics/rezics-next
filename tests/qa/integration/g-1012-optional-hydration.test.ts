import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { DiscoveryProjection } from '../../../services/main/src/modules/discovery/store.ts';
import { projectDiscoveryBatch } from '../../../services/main/src/modules/discovery/source.ts';
import { automaticDiscovery } from '../../../services/main/src/modules/discovery/automation.ts';
import { digest, RecommendationUnavailable } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { RankingGenerations } from '../../../services/main/src/modules/recommendation/ranking.ts';
import { workRead } from '../../../services/main/src/modules/work/read-session.ts';
import { SerialStatisticsProjection } from '../../../services/main/src/modules/work/serial-projection.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { MediaUnavailable } from '../../../services/main/src/modules/media/store.ts';
import { Value } from 'typebox/value';
import { discoveryPage } from '../../../services/main/src/modules/discovery/contract.ts';
import { publicPhrasePageResult } from '../../../services/main/src/api-contract.ts';
import { queryWorkStandingRatings } from '../../../services/main/src/modules/rating/global-aggregate.ts';
import { RatingAggregateUnavailable } from '../../../services/main/src/modules/rating/aggregate.ts';
import { metadataComponent } from '../../../services/main/src/modules/work/metadata-schema.ts';
import { AgentVanityHandles } from '../../../services/main/src/modules/agent/vanity.ts';
import { PersonPreferencesStore } from '../../../services/main/src/modules/preferences/store.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { RATING_PROJECTION_HEALTH_COST } from '../../../services/main/src/modules/rating/projection-health.ts';

async function json(response: Response, status = 200): Promise<Record<string, any>> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body);
}

test('G1012: search, Discover Works and sections survive lagging optional owners, retain traversal and recover', async () => {
  const started = performance.now();
  const f = await startMediaStack('g-1012-hydration', { profileCredits: true });
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    const member = await f.member('G1012 writer');
    const phrase = `g1012${randomUUID().replaceAll('-', '')}`;
    const works = [await f.publicWork(member.actor, ['en'], `${phrase} affected`),
      await f.publicWork(member.actor, ['en'], `${phrase} healthy`)];
    const metadata = { kind: 'header' as const, originalTitle: null, localized: [{ language: 'en',
      title: null, description: null, mainVersionLabel: null, tagline: 'Healthy card facts' }] };
    for (const work of works) {
      await member.grant(`work:edit:${work.work}`, 'work.edit');
      await json(await member.send('PUT', `/v1/works/${work.work.slice(-36)}/metadata`, {
        profile: 'work-metadata-details-v1', expectedHead: null, actingSubject: member.actor, state: metadata,
      }, randomUUID()));
      const head = (await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
      await json(await member.send('POST', `/v1/works/${work.work.slice(-36)}/agent-credits`, {
        profile: 'native-agent-credit-v1', credit: `https://rezics.com/id/${randomUUID()}`,
        agent: member.actor, role: 'author', expectedWorkHead: head, actingSubject: member.actor,
      }, randomUUID()), 201);
    }
    await member.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const { context } = await json(await member.send('POST', '/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1', question: 'G1012 Overall quality', actingSubject: member.actor,
    }, randomUUID()), 201);
    await member.grant(`rating:observe:${context}`, 'rating.observation.set');
    const observations = [];
    for (const work of works) observations.push(await json(await member.send('POST', '/v1/global-rating-observations', {
      profile: 'global-rating-standing-observation-v1', context, work: work.work,
      mainVersion: work.mainVersion, value: 4, expectedRevisionHead: null, actingSubject: member.actor,
    }, randomUUID()), 201));
    const projection = new DiscoveryProjection(f.accessPool);
    const recommendations = { page: async (_viewer: unknown, _basis: unknown, limit: number, cursor?: string) => {
      const start = Number(cursor ?? 0), selected = works.slice(start, start + limit);
      return { generation: randomUUID(), items: selected.map(work => ({ candidate: work.work })),
        continuation: start + limit < works.length ? String(start + limit) : null };
    } } as unknown as RankingGenerations;
    const serial = new SerialStatisticsProjection(f.accessPool, relay, f.contentPool, f.env);
    // Production composition supplies the name-policy and handle owners. Without
    // the name policy every agent name is withheld and a present author credit
    // is reported as an unavailable preview.
    const deps = { environment: f.env, access: f.access, media: f.media, discovery: projection, recommendations,
      profiles: new ProfilesAccess(f.accessPool),
      personPreferences: new PersonPreferencesStore(f.accessPool),
      agentHandles: new AgentVanityHandles(f.accessPool),
      account: { verify: async () => member.principal }, serialStats: serial };
    const build = (contexts: Array<string | null>) => workRead(deps, new Request('http://main.local/source'), {}, async session => {
      for (const selectedContext of contexts) {
        const basis = { scope: 'global' as const, realm: null, context: selectedContext, owner: null };
        const row = await projection.register(automaticDiscovery(null), basis, session.position,
          { idempotencyKey: randomUUID(), requestDigest: digest(basis) });
        const step = await projection.beginStep(automaticDiscovery(null), row.generation_id, '');
        const batch = await projectDiscoveryBatch(session, basis, '', { works: works.map(work => work.work).sort() });
        expect(batch.complete).toBe(true);
        await projection.commitBatch(automaticDiscovery(null), row.generation_id, step.lease, '', batch, session.position);
        await projection.activate(automaticDiscovery(null), row.generation_id, row.active_head, session.position,
          { idempotencyKey: randomUUID(), requestDigest: digest(row.generation_id) });
      }
    });
    await build([null, context]);
    expect(performance.now() - started).toBeLessThan(600_000);
    const app = createMainApp(f.fuseki, deps);
    const search = (pageSize = 20, continuation?: string) => app.handle(new Request('http://main.local/v1/queries/page', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        profile: 'public-main-phrase-page-v1', phrase, language: 'en', pageSize, continuation,
      }),
    }));
    const readWorks = (query = '') => app.handle(new Request(`http://main.local/v1/works${query}`));
    const sections = (cursor?: string) => app.handle(new Request('http://main.local/v1/discovery/sections?section=popular'
      + '&personalization=false&limit=1' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')));
    const health = () => app.handle(new Request('http://main.local/health/rating-ready'));
    const baseline = await json(await search());
    expect(Value.Check(publicPhrasePageResult, baseline)).toBe(true);
    expect(baseline.results).toHaveLength(2);
    // The real serial projection has not consumed this cut. Its empty map
    // means unknown counts, while metadata and exact sealed ratings still read.
    for (const item of baseline.results) expect(item).toMatchObject({ ratingStatus: 'available',
      rating: { mean: 4 }, chapterCount: null, unavailablePreviews: ['serial'] });
    const baselineWorks = await json(await readWorks());
    expect(Value.Check(discoveryPage, baselineWorks)).toBe(true);
    const firstSection = await json(await sections());
    expect(firstSection.items[0].page.items[0].work.rating).toMatchObject({ mean: 4 });
    f.fuseki.queries = 0;
    expect(await json(await health())).toMatchObject({ status: 'ready', sequenceLag: '0' });
    expect(f.fuseki.queries).toBe(RATING_PROJECTION_HEALTH_COST.graphCalls);

    // Advance the real source with a repeated value. Refresh base membership
    // only, leaving the immutable optional rating generation one event behind.
    await json(await member.send('POST', '/v1/global-rating-observations', {
      profile: 'global-rating-standing-observation-v1', context, work: works[0]!.work,
      mainVersion: works[0]!.mainVersion, value: 4, expectedRevisionHead: observations[0]!.observationRevision,
      actingSubject: member.actor,
    }, randomUUID()), 201);
    await build([null]);
    expect(await json(await health(), 503)).toMatchObject({ status: 'unavailable', sequenceLag: '1' });
    const lagged = await json(await sections());
    expect(lagged.items[0].page.items[0].id).toBe(firstSection.items[0].page.items[0].id);
    expect(lagged.items[0].page.items[0].work.rating).toBeNull();
    expect(lagged.items[0].page.items[0].work.primaryCredits).toHaveLength(1);
    const continuedSection = await json(await sections(lagged.items[0].page.nextCursor));
    expect(continuedSection.items[0].page.items[0].id).toBe(works[1]!.work);
    expect(continuedSection.items[0].page.complete).toBe(true);
    expect((await json(await readWorks())).items).toEqual(baselineWorks.items);
    const ranked = await json(await readWorks(`?context=${encodeURIComponent(context)}`));
    expect(ranked.stale).toBe(true);
    for (const item of ranked.items) expect(item).toMatchObject({ rating: null, unavailablePreviews: ['serial', 'credits', 'rating'] });
    const first = await json(await search(1));

    // One optional target's sealed inventory lags its live graph head. The
    // neighbouring target and continuation keep their authoritative relation.
    const inventory = f.access.readRatingAggregateInventory.bind(f.access);
    f.access.readRatingAggregateInventory = async (selected, main, signal) => {
      const result = await inventory(selected, main, signal);
      return main === works[0]!.mainVersion ? { ...result,
        heads: result.heads.map(head => ({ ...head, revision: `https://rezics.com/id/${randomUUID()}` })) } : result;
    };
    await expect(queryWorkStandingRatings(f.env, f.access, { context, kind: 'global', targets: works }))
      .rejects.toBeInstanceOf(RatingAggregateUnavailable);
    const degraded = await json(await search());
    expect(degraded.results.map((item: { work: string }) => item.work)).toEqual(baseline.results.map((item: { work: string }) => item.work));
    expect(degraded.results.find((item: { work: string }) => item.work === works[0]!.work))
      .toMatchObject({ rating: null, ratingStatus: 'unavailable', unavailablePreviews: ['serial', 'rating'] });
    expect(degraded.results.find((item: { work: string }) => item.work === works[1]!.work))
      .toEqual(baseline.results.find((item: { work: string }) => item.work === works[1]!.work));
    const continued = await json(await search(1, first.next));
    expect(continued.results[0].work).toBe(baseline.results[1].work);
    f.access.readRatingAggregateInventory = inventory;
    f.access.readRatingAggregateInventory = async (selected, main, signal) => {
      if (main === works[0]!.mainVersion) throw new RatingAggregateUnavailable('Target inventory unavailable');
      return inventory(selected, main, signal);
    };
    const missing = await json(await search());
    expect(missing.results.find((item: { work: string }) => item.work === works[0]!.work).ratingStatus).toBe('unavailable');
    expect(missing.results.find((item: { work: string }) => item.work === works[1]!.work).ratingStatus).toBe('available');
    f.access.readRatingAggregateInventory = inventory;
    f.access.readRatingAggregateInventory = async (selected, main, signal) => {
      const result = await inventory(selected, main, signal);
      return main === works[0]!.mainVersion ? { ...result, heads: Array.from({ length: 101 }, () => result.heads[0]!) } : result;
    };
    expect(await json(await search(), 422)).toMatchObject({ code: 'query_budget_exceeded' });
    f.access.readRatingAggregateInventory = inventory;
    const fence = f.access.checkRatingAggregateFence.bind(f.access);
    f.access.checkRatingAggregateFence = async () => false;
    for (const item of (await json(await search())).results) expect(item.ratingStatus).toBe('unavailable');
    f.access.checkRatingAggregateFence = fence;

    const nativeQuery = f.fuseki.query.bind(f.fuseki);
    f.fuseki.query = async (query, maxBytes) => {
      const result = await nativeQuery(query, maxBytes);
      if (query.includes('rv:metadataState')) {
        for (const row of result.results?.bindings ?? []) {
          if (row.state && (row.work?.value === works[0]!.work
            || query.includes(metadataComponent(works[0]!.work, metadata)))) row.state.value = 'damaged metadata';
        }
      }
      return result;
    };
    const serialDamaged = await json(await search());
    expect(serialDamaged.results.find((item: { work: string }) => item.work === works[0]!.work).tagline).toBeNull();
    expect(serialDamaged.results.find((item: { work: string }) => item.work === works[1]!.work).tagline.value).toBe('Healthy card facts');
    const discoverDamaged = await json(await readWorks());
    expect(discoverDamaged.items.find((item: { id: string }) => item.id === works[0]!.work).tagline).toBeNull();
    expect(discoverDamaged.items.find((item: { id: string }) => item.id === works[1]!.work).tagline.value).toBe('Healthy card facts');
    f.fuseki.query = nativeQuery;
    f.fuseki.query = async (query, maxBytes) => {
      const result = await nativeQuery(query, maxBytes);
      if (query.includes('SELECT ?work ?id ?key ?ordinal ?agent')) {
        for (const row of result.results?.bindings ?? []) {
          if (row.work?.value === works[0]!.work && row.agent) row.ordinal = { type: 'literal', value: '0' };
        }
      }
      return result;
    };
    const damagedCredits = await json(await search());
    expect(damagedCredits.results.find((item: { work: string }) => item.work === works[0]!.work))
      .toMatchObject({ primaryCredits: [], unavailablePreviews: ['serial', 'credits'] });
    expect(damagedCredits.results.find((item: { work: string }) => item.work === works[1]!.work).primaryCredits).toHaveLength(1);
    f.fuseki.query = nativeQuery;
    const page = projection.page.bind(projection);
    projection.page = async (...args) => (await page(...args)).map(row => row.work === works[0]!.work
      ? { ...row, payload: { ...row.payload, primaryCredits: [null] as never } } : row);
    const damagedDiscoveryCredits = await json(await readWorks());
    expect(damagedDiscoveryCredits.items.find((item: { id: string }) => item.id === works[0]!.work).primaryCredits).toEqual([]);
    expect(damagedDiscoveryCredits.items.find((item: { id: string }) => item.id === works[1]!.work).primaryCredits).toHaveLength(1);
    projection.page = page;

    const avatars = f.media.store.avatarRows.bind(f.media.store);
    f.media.store.avatarRows = async () => { throw new MediaUnavailable('Optional cover owner unavailable'); };
    for (const item of (await json(await search())).results) expect(item.cover.kind).toBe('fallback');
    for (const item of (await json(await readWorks())).items) expect(item.cover.kind).toBe('fallback');
    f.media.store.avatarRows = avatars;
    await build([context]);
    expect(await json(await health())).toMatchObject({ status: 'ready', sequenceLag: '0' });
    expect((await json(await search())).results).toEqual(baseline.results);
    expect((await json(await sections())).items[0].page.items[0].work.rating).toMatchObject({ mean: 4 });

    // Required membership owners retain their error boundary.
    projection.page = async () => { throw new RecommendationUnavailable('Membership unavailable'); };
    await json(await readWorks(), 503);
    recommendations.page = async () => { throw new RecommendationUnavailable('Ranking unavailable'); };
    await json(await sections(), 503);
  } finally { await relay.end(); await f.stop(); }
}, 600_000);
