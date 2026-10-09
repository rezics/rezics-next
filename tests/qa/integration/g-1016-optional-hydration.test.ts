import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Value } from 'typebox/value';
import { startMediaStack } from './media-support.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AlsoEnjoyedStore } from '../../../services/main/src/modules/also-enjoyed/store.ts';
import { alsoEnjoyedPage } from '../../../services/main/src/modules/also-enjoyed/contract.ts';
import { ProfilesAccess } from '../../../services/main/src/modules/profiles/access.ts';
import { AgentVanityHandles } from '../../../services/main/src/modules/agent/vanity.ts';
import { SerialStatisticsProjection } from '../../../services/main/src/modules/work/serial-projection.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import { RatingAggregateUnavailable } from '../../../services/main/src/modules/rating/aggregate.ts';
import { MediaUnavailable } from '../../../services/main/src/modules/media/store.ts';
import { WorkReadLimit, WorkReadUnavailable } from '../../../services/main/src/modules/work/read-session.ts';
import { GRAPHS, RV, iri } from '../../../services/main/src/modules/work/activate.ts';
import { metadataComponent } from '../../../services/main/src/modules/work/metadata-schema.ts';
import { RecommendationUnavailable } from '../../../services/main/src/modules/recommendation/derived-generation.ts';

async function json(response: Response, status = 200): Promise<Record<string, any>> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body);
}

test('G1016: typeahead and also enjoyed degrade optional owners per item, preserve traversal and recover', async () => {
  const f = await startMediaStack('g-1016-hydration', { profileCredits: true });
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  try {
    const authors = [await f.member('G1016 affected author'), await f.member('G1016 healthy author')];
    const source = await f.publicWork(authors[0]!.actor, ['en'], 'Recommendation source');
    const phrase = `g1016${randomUUID().replaceAll('-', '')}`;
    const works = [await f.publicWork(authors[0]!.actor, ['en'], `${phrase} affected`),
      await f.publicWork(authors[1]!.actor, ['en'], `${phrase} healthy`)];
    const workHead = async (work: string) => {
      const head = (await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:head ?head } }`)).results?.bindings[0]?.head?.value;
      if (!head) throw new Error('Work head is unavailable');
      return head;
    };
    const recordBook = async (actor: typeof authors[0], work: string) => {
      await actor!.grant(`work:edit:${work}`, 'work.edit');
      await json(await actor!.send('PUT', `/v1/works/${work.slice(-36)}/type`, {
        profile: 'work-type-v2', expectedHead: await workHead(work),
        types: ['https://schema.org/Book'], actingSubject: actor!.actor,
      }, randomUUID()));
    };
    await recordBook(authors[0], source.work);
    const metadata = { kind: 'header' as const, originalTitle: null, localized: [{ language: 'en',
      title: null, description: null, mainVersionLabel: null, tagline: 'Healthy recommendation facts' }] };
    for (const [index, work] of works.entries()) {
      const author = authors[index]!;
      await recordBook(author, work.work);
      await json(await author.send('PUT', `/v1/works/${work.work.slice(-36)}/metadata`, {
        profile: 'work-metadata-details-v1', expectedHead: null, actingSubject: author.actor, state: metadata,
      }, randomUUID()));
      const head = (await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(work.work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
      await json(await author.send('POST', `/v1/works/${work.work.slice(-36)}/agent-credits`, {
        profile: 'native-agent-credit-v1', credit: `https://rezics.com/id/${randomUUID()}`,
        agent: author.actor, role: 'author', expectedWorkHead: head, actingSubject: author.actor,
      }, randomUUID()), 201);
    }
    const writer = authors[0]!;
    await writer.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const { context } = await json(await writer.send('POST', '/v1/global-rating-contexts', {
      profile: 'global-rating-standing-context-v1', question: 'G1016 Quality', actingSubject: writer.actor,
    }, randomUUID()), 201);
    await writer.grant(`rating:observe:${context}`, 'rating.observation.set');
    for (const work of works) await json(await writer.send('POST', '/v1/global-rating-observations', {
      profile: 'global-rating-standing-observation-v1', context, work: work.work,
      mainVersion: work.mainVersion, value: 4, expectedRevisionHead: null, actingSubject: writer.actor,
    }, randomUUID()), 201);
    const store = new AlsoEnjoyedStore(f.accessPool, f.contentPool);
    const handles = new AgentVanityHandles(f.accessPool);
    const serial = new SerialStatisticsProjection(f.accessPool, relay, f.contentPool, f.env);
    const deps = { environment: f.env, access: f.access, media: f.media,
      profiles: new ProfilesAccess(f.accessPool), agentHandles: handles, serialStats: serial,
      personPreferences: f.composition.dependencies.personPreferences,
      templateSeek: f.templateSeek, alsoEnjoyed: store, account: { verify: async () => writer.principal } };
    const app = createMainApp(f.fuseki, deps);
    const suggest = () => app.handle(new Request(`http://main.local/v1/search/typeahead?prefix=${phrase}`));
    const recommend = (limit = 20, cursor?: string) => app.handle(new Request(
      `http://main.local/v1/works/${source.work.slice(-36)}/also-enjoyed?limit=${limit}`
      + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')));
    const baseline = await json(await recommend());
    expect(Value.Check(alsoEnjoyedPage, baseline)).toBe(true);
    expect(baseline.items.map((item: { id: string }) => item.id).sort()).toEqual(works.map(work => work.work).sort());
    for (const item of baseline.items) expect(item).toMatchObject({ rating: { mean: 4 },
      primaryCredits: [expect.objectContaining({ participantKind: 'agent' })], chapterCount: null });
    const typeahead = await json(await suggest());
    expect(typeahead.items).toHaveLength(2);
    const first = await json(await recommend(1));

    // The real serial projection is behind. An optional per-target sealed
    // rating inventory and author-handle read can lag independently as well.
    const inventory = f.access.readRatingAggregateInventory.bind(f.access);
    const handle = handles.current.bind(handles);
    f.access.readRatingAggregateInventory = async (selected, main, signal) => {
      const result = await inventory(selected, main, signal);
      return main === works[0]!.mainVersion ? { ...result,
        heads: result.heads.map(head => ({ ...head, revision: `https://rezics.com/id/${randomUUID()}` })) } : result;
    };
    handles.current = async agent => {
      if (agent === authors[0]!.actor) throw new WorkReadUnavailable('Handle projection behind');
      return handle(agent);
    };
    const degraded = await json(await recommend());
    expect(degraded.items.map((item: { id: string }) => item.id)).toEqual(baseline.items.map((item: { id: string }) => item.id));
    expect(degraded.items.find((item: { id: string }) => item.id === works[0]!.work))
      .toMatchObject({ rating: null, primaryCredits: [] });
    expect(degraded.items.find((item: { id: string }) => item.id === works[1]!.work))
      .toEqual(baseline.items.find((item: { id: string }) => item.id === works[1]!.work));
    const degradedTypeahead = await json(await suggest());
    expect(degradedTypeahead.items.map((item: { work: string }) => item.work))
      .toEqual(typeahead.items.map((item: { work: string }) => item.work));
    expect(degradedTypeahead.items.find((item: { work: string }) => item.work === works[0]!.work).authors).toEqual([]);
    expect(degradedTypeahead.items.find((item: { work: string }) => item.work === works[1]!.work))
      .toEqual(typeahead.items.find((item: { work: string }) => item.work === works[1]!.work));
    const continued = await json(await recommend(1, first.nextCursor));
    expect(continued.items[0].id).toBe(baseline.items[1].id);
    expect(continued.nextCursor).toBeNull();
    f.access.readRatingAggregateInventory = async (selected, main, signal) => {
      if (main === works[0]!.mainVersion) throw new RatingAggregateUnavailable('Target unavailable');
      return inventory(selected, main, signal);
    };
    expect((await json(await recommend())).items.find((item: { id: string }) => item.id === works[1]!.work).rating.mean).toBe(4);
    f.access.readRatingAggregateInventory = inventory;
    handles.current = handle;

    const nativeQuery = f.fuseki.query.bind(f.fuseki);
    f.fuseki.query = async (query, bytes) => {
      const result = await nativeQuery(query, bytes);
      if (query.includes('rv:metadataState')) for (const row of result.results?.bindings ?? []) {
        if (row.state && (row.work?.value === works[0]!.work
          || query.includes(metadataComponent(works[0]!.work, metadata)))) row.state.value = 'damaged';
      }
      return result;
    };
    const damaged = await json(await recommend());
    expect(damaged.items.find((item: { id: string }) => item.id === works[0]!.work).tagline).toBeNull();
    expect(damaged.items.find((item: { id: string }) => item.id === works[1]!.work).tagline.value).toBe('Healthy recommendation facts');
    f.fuseki.query = nativeQuery;
    const avatars = f.media.store.avatarRows.bind(f.media.store);
    const coverTargets = new Set(works.map(work => work.work));
    f.media.store.avatarRows = async (targets, context) => {
      if (targets.some(target => coverTargets.has(target))) throw new MediaUnavailable('Cover projection unavailable');
      return avatars(targets, context);
    };
    for (const item of (await json(await recommend())).items) expect(item.cover.kind).toBe('fallback');
    for (const item of (await json(await suggest())).items) expect(item.cover.kind).toBe('fallback');
    f.media.store.avatarRows = avatars;
    expect((await json(await recommend())).items).toEqual(baseline.items);
    expect((await json(await suggest())).items).toEqual(typeahead.items);

    f.fuseki.query = async (query, bytes) => {
      const result = await nativeQuery(query, bytes);
      if (query.includes('SELECT ?work ?id ?key ?ordinal ?agent')) for (const row of result.results?.bindings ?? []) {
        if (row.work?.value === works[0]!.work && row.agent) row.ordinal = { type: 'literal', value: '0' };
      }
      return result;
    };
    expect((await json(await suggest())).items.find((item: { work: string }) => item.work === works[0]!.work).authors).toEqual([]);
    expect((await json(await suggest())).items.find((item: { work: string }) => item.work === works[1]!.work))
      .toEqual(typeahead.items.find((item: { work: string }) => item.work === works[1]!.work));
    // Those same damaged identities cannot be ignored in author exclusions.
    await json(await recommend(), 503);
    f.fuseki.query = nativeQuery;

    // Membership and budgets remain required even when a failing read is used
    // elsewhere to decorate a card. Missing identities cannot weaken exclusions.
    const batch = serial.batch.bind(serial);
    serial.batch = async () => { throw new WorkReadLimit('Serial budget exceeded'); };
    await json(await recommend(), 422);
    serial.batch = batch;
    f.access.readRatingAggregateInventory = async (selected, main, signal) => {
      const result = await inventory(selected, main, signal);
      return main === works[0]!.mainVersion ? { ...result, heads: Array.from({ length: 101 }, () => result.heads[0]!) } : result;
    };
    await json(await recommend(), 422);
    f.access.readRatingAggregateInventory = inventory;
    handles.current = async () => { throw new WorkReadLimit('Author budget exceeded'); };
    await json(await suggest(), 422);
    handles.current = handle;
    await writer.grant(`work:edit:${source.work}`, 'work.edit');
    const sourceHead = (await f.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(source.work)} rv:head ?head } }`)).results!.bindings[0]!.head!.value;
    await json(await writer.send('POST', `/v1/works/${source.work.slice(-36)}/agent-credits`, {
      profile: 'native-agent-credit-v1', credit: `https://rezics.com/id/${randomUUID()}`,
      agent: writer.actor, role: 'author', expectedWorkHead: sourceHead, actingSubject: writer.actor,
    }, randomUUID()), 201);
    handles.current = async agent => {
      if (agent === writer.actor) throw new WorkReadUnavailable('Optional author still behind');
      return handle(agent);
    };
    expect((await json(await recommend())).items.map((item: { id: string }) => item.id)).toEqual([works[1]!.work]);
    handles.current = handle;
    store.candidates = async () => { throw new RecommendationUnavailable('Membership unavailable'); };
    await json(await recommend(), 503);
    // Live erasure still removes the title-based suggestion despite optional
    // author failures. This fence does not depend on a projection catching up.
    const affected = works[0]!.work;
    const variantId = `urn:rezics:variant:${randomUUID()}`;
    await writer.grant(`work:read:${affected}`, 'work.read');
    await writer.grant(`content:draft:${affected}`, 'content.draft');
    await writer.grant(`content:publish:${affected}`, 'content.publish');
    const saved = await json(await writer.send('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: affected, variantId,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr', expectedHead: null,
      body: `Erased body ${randomUUID()}`, actingSubject: writer.actor,
    }, randomUUID()), 201);
    const exact = (await f.content.readExactBatch([saved.revisionId], async ids => new Set(ids)))[0];
    if (exact?.status !== 'available') throw new Error('Content draft was not saved');
    await json(await writer.send('POST', '/v1/content-publications', {
      profile: 'content-publication-v1', preparationId: `g1016-${randomUUID()}`, revisionId: saved.revisionId,
      expectedDigest: exact.reference.byteDigest, expectedContentEpoch: saved.sourcePosition.dataEpoch,
      resourceId: affected, variantId, expectedPublicationHead: null, actingSubject: writer.actor,
    }, randomUUID()), 201);
    await writer.grant(`erasure:${affected}`, 'erasure.request');
    const erasure = await json(await writer.send('POST', '/v1/erasures', {
      profile: 'content-revision-erasure-v1', actingSubject: writer.actor,
      resourceId: affected, revisionIds: [saved.revisionId],
    }, randomUUID()));
    expect(erasure).toMatchObject({ suppression: 'suppressed' });
    expect(erasure.erasureEpoch).toMatch(/^[1-9][0-9]*$/);
    handles.current = async agent => {
      if (agent === authors[0]!.actor) throw new WorkReadUnavailable('Still behind');
      return handle(agent);
    };
    expect((await json(await suggest())).items.map((item: { work: string }) => item.work)).toEqual([works[1]!.work]);
  } finally { await relay.end(); await f.stop(); }
}, 240_000);
