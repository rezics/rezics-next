import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { conceptFilter } from '../../../services/main/src/modules/concept-page/contract.ts';
import { resolveFacet } from '../../../services/main/src/modules/facets/registry.ts';
import { seedHome, startHomeStack } from './feed-read-support.ts';

interface Item { id: string; name: string | null; concept: { id: string; name: { value: string } | null } | null;
  filter: unknown; facets: string[]; position: number | null; home: 'available' | 'unsupported'; revision: string }
interface Page { revision: string | null; items: Item[]; complete: boolean }
interface Receipt { action: string; id: string | null; filterRevision: string | null; revision: string; replayed: boolean }
interface FeedPage { items: { target: { work: string | null } }[]; nextCursor: string | null }

const language = resolveFacet('language')!.id;

test('G-431 Saved Filters: create, rename, pin, reorder, unpin and delete; a followed Concept owns its pinned filter; '
  + 'a pinned tab reads Home filtered by it', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the integration tier');
  const home = await startHomeStack('saved-filter');
  try {
    const seeded = await seedHome(home);
    const { call, json } = home;
    const a = home.author, token = home.reader.token, reader = seeded.reader;
    const signed = seeded.signed;
    const list = async () => json<Page>(await call('GET', signed('/v1/me/saved-filters?language=en'), undefined, token));
    const byId = (page: Page, id: string) => page.items.find(item => item.id === id)!;
    const create = (body: Record<string, unknown>, key = randomUUID()) => call('POST', '/v1/me/saved-filters',
      { profile: 'saved-filter-create-v1', actingSubject: reader, context: 'global', pinned: true, ...body }, token, key);
    const update = (id: string, body: Record<string, unknown>, key = randomUUID()) => call('PATCH',
      `/v1/me/saved-filters/${id}`, { profile: 'saved-filter-update-v1', actingSubject: reader, ...body }, token, key);
    const reorder = (pinned: string[], expectedRevision: string | null) => call('PUT', '/v1/me/saved-filters/order',
      { profile: 'saved-filter-order-v1', actingSubject: reader, expectedRevision, pinned }, token);
    // A delete has no body, so it names its idempotency key itself.
    const remove = (id: string, expectedRevision: string) => home.app.handle(new Request(`http://main.local${
      `/v1/me/saved-filters/${id}?actingSubject=${encodeURIComponent(reader)}&expectedRevision=${expectedRevision}`}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() } }));
    const follow = (target: string, following: boolean, expectedRevision: string | null) => call('POST', '/v1/follows',
      { profile: 'follow-command-v1', target, kind: 'concept', actingSubject: reader, following, expectedRevision }, token);
    const pinned = (page: Page) => page.items.filter(item => item.position !== null)
      .sort((x, y) => x.position! - y.position!).map(item => item.id);

    // Two accepted Concepts on two of Home's Works.
    await a.grant('classification:define:global', 'classification.proposition.define');
    await a.grant('classification:decide:global', 'classification.decision.set');
    const define = async (label: string) => json<{ concept: string; sense: string }>(await call('POST',
      '/v1/classification-propositions', { profile: 'classification-proposition-v1', label, actingSubject: a.actor },
      a.token), 201);
    const [fantasy, mystery] = [await define('Saved fantasy'), await define('Saved mystery')];
    const [tagged, other] = [seeded.works[3]!, seeded.works[4]!];
    for (const [work, term] of [[tagged, fantasy], [other, mystery]] as const) {
      await json(await call('POST', '/v1/classification-decisions', { profile: 'classification-direct-decision-v1',
        work: work.work, mainVersion: work.mainVersion, sense: term.sense, context: { kind: 'global' },
        outcome: 'accepted', expectedDecisionHead: null, actingSubject: a.actor }, a.token), 201);
    }
    await home.project();

    // Denied: Saved Filters are private to the person who controls the acting Agent.
    expect((await list()).items).toEqual([]);
    expect((await call('GET', signed('/v1/me/saved-filters'))).status).toBe(401);
    expect((await call('GET', `/v1/me/saved-filters?actingSubject=${encodeURIComponent(seeded.author)}`, undefined,
      token)).status).toBe(403);

    // Invalid: a filter no Facet admits, a pin Home cannot show, a name with spaces around it.
    const unknown = await create({ name: 'Genres', filter: { all: [{ facet: 'genre', any: [fantasy.concept] }] } });
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({ code: 'unknown_facet' });
    const books = { all: [{ facet: 'type', any: ['https://schema.org/Book'] }] };
    expect((await create({ name: 'Books', filter: books })).status).toBe(422);
    expect((await create({ name: ' English ', filter: { all: [{ facet: 'language', any: ['en'] }] } })).status).toBe(400);

    // Create: the current Filters saved as a tab keep exact DefinitionRefs; a replay returns its receipt.
    const key = randomUUID(), english = { name: 'English and Japanese',
      filter: { all: [{ facet: 'language', any: ['en', 'ja'] }] } };
    const created = await json<Receipt>(await create(english, key), 201);
    expect(created).toMatchObject({ action: 'created', replayed: false });
    expect(await json<Receipt>(await create(english, key))).toMatchObject({ id: created.id, replayed: true });
    expect((await create({ ...english, name: 'Other' }, key)).status).toBe(409);
    const unpinnedBooks = await json<Receipt>(await create({ name: 'Books', filter: books, pinned: false }), 201);
    let page = await list();
    expect(byId(page, created.id!)).toMatchObject({ name: 'English and Japanese', position: 0, home: 'available',
      concept: null, facets: [language], filter: { all: [{ facet: language, any: ['en', 'ja'] }] } });
    expect(byId(page, unpinnedBooks.id!)).toMatchObject({ position: null, home: 'unsupported' });

    // Following a Concept pins its one-Condition Filter, named by the Concept, in one step as onboarding does.
    const followed = await json<{ revision: string }>(await follow(fantasy.concept, true, null));
    await json(await call('POST', '/v1/me/follows/batch', { profile: 'follow-batch-v1', actingSubject: reader,
      targets: [{ target: mystery.concept, kind: 'concept' }] }, token));
    page = await list();
    const magic = page.items.find(item => item.concept?.id === fantasy.concept)!;
    const puzzles = page.items.find(item => item.concept?.id === mystery.concept)!;
    expect(magic).toMatchObject({ name: null, position: 1, home: 'available', filter: conceptFilter(fantasy.concept),
      concept: { id: fantasy.concept, name: { value: 'Saved fantasy' } } });
    expect(puzzles.position).toBe(2);
    expect(pinned(page)).toEqual([created.id, magic.id, puzzles.id]);

    // Rename: a stale revision is refused; a followed Concept's filter can return to its own label.
    expect((await update(magic.id, { expectedRevision: randomUUID(), name: 'Magic' })).status).toBe(409);
    const renamed = await json<Receipt>(await update(magic.id, { expectedRevision: magic.revision, name: 'Magic' }));
    expect(byId(await list(), magic.id)).toMatchObject({ name: 'Magic', revision: renamed.filterRevision });
    await json(await update(magic.id, { expectedRevision: renamed.filterRevision, name: null }));
    expect((await update(created.id!, { expectedRevision: byId(await list(), created.id!).revision, name: null }))
      .status).toBe(400);

    // Reorder: exactly the pinned set, under the inventory revision the reader saw.
    page = await list();
    expect((await reorder([puzzles.id, magic.id], page.revision)).status).toBe(409);
    expect((await reorder([puzzles.id, magic.id, created.id!], randomUUID())).status).toBe(409);
    await json(await reorder([puzzles.id, magic.id, created.id!], page.revision));
    expect(pinned(await list())).toEqual([puzzles.id, magic.id, created.id]);

    // Unpin and pin: positions stay contiguous; Home cannot pin what it cannot show.
    expect((await update(unpinnedBooks.id!, { expectedRevision: byId(page, unpinnedBooks.id!).revision, pinned: true }))
      .status).toBe(422);
    await json(await update(puzzles.id, { expectedRevision: byId(await list(), puzzles.id).revision, pinned: false }));
    expect(pinned(await list())).toEqual([magic.id, created.id]);
    await json(await update(puzzles.id, { expectedRevision: byId(await list(), puzzles.id).revision, pinned: true }));
    expect(pinned(await list())).toEqual([magic.id, created.id, puzzles.id]);

    // A pinned tab: Home's All feed through the filter, and nothing the filter does not name.
    const feed = async (query: string) => {
      const items: FeedPage['items'] = [];
      let cursor: string | null = null;
      for (let index = 0; index < 30; index++) {
        const read: FeedPage = await json<FeedPage>(await call('GET', signed(`/v1/feed?${query}${cursor
          ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), undefined, token));
        items.push(...read.items); cursor = read.nextCursor;
        if (!cursor) return items;
      }
      throw new Error('Saved Filter feed did not terminate');
    };
    const magicPosts = await feed(`scope=all&sort=new&savedFilter=${magic.id}`);
    expect(magicPosts.length).toBeGreaterThan(0);
    expect(magicPosts.every(item => item.target.work === tagged.work)).toBe(true);
    expect((await feed(`scope=all&sort=best&savedFilter=${puzzles.id}`)).every(item => item.target.work === other.work))
      .toBe(true);
    expect((await call('GET', signed(`/v1/feed?scope=all&savedFilter=${magic.id}&contentLanguages=en`), undefined,
      token)).status).toBe(400);
    expect((await call('GET', signed(`/v1/feed?scope=following&savedFilter=${magic.id}`), undefined, token)).status)
      .toBe(400);
    expect((await call('GET', `/v1/feed?scope=all&savedFilter=${magic.id}`)).status).toBe(400);
    const unsupported = await call('GET', signed(`/v1/feed?scope=all&savedFilter=${unpinnedBooks.id}`), undefined, token);
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toMatchObject({ code: 'unsupported_query_shape' });
    expect((await call('GET', `/v1/feed?scope=all&savedFilter=${magic.id}&actingSubject=${encodeURIComponent(
      seeded.author)}`, undefined, a.token)).status).toBe(404);

    // Delete: a followed Concept's filter goes with its follow; a named filter is deleted.
    page = await list();
    const refused = await remove(magic.id, byId(page, magic.id).revision);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'saved_filter_followed' });
    await json(await follow(fantasy.concept, false, followed.revision));
    page = await list();
    expect(page.items.some(item => item.concept?.id === fantasy.concept)).toBe(false);
    expect(pinned(page)).toEqual([created.id, puzzles.id]);
    await json(await remove(created.id!, byId(page, created.id!).revision));
    expect(pinned(await list())).toEqual([puzzles.id]);
    expect((await remove(created.id!, byId(page, created.id!).revision)).status).toBe(404);

    // Eight tabs at most: a later Concept follow keeps its filter, unpinned.
    for (let index = 0; index < 7; index++) {
      await json(await create({ name: `Tab ${index}`, filter: { all: [{ facet: 'language', any: ['en'] }] } }), 201);
    }
    const ninth = await create({ name: 'Ninth', filter: { all: [{ facet: 'language', any: ['ja'] }] } });
    expect(ninth.status).toBe(409);
    expect(await ninth.json()).toMatchObject({ code: 'home_tabs_full' });
    await json(await follow(fantasy.concept, true, (await json<{ revision: string | null }>(await call('GET',
      signed(`/v1/follows/${fantasy.concept.slice(-36)}?kind=concept`), undefined, token))).revision));
    page = await list();
    expect(pinned(page)).toHaveLength(8);
    expect(page.items.find(item => item.concept?.id === fantasy.concept)).toMatchObject({ position: null });
  } finally { await home.stop(); }
}, 300_000);
