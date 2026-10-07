import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AccessExposure } from '../../../services/main/src/modules/access/exposure.ts';
import { CONCEPT_FACET, conceptFilter } from '../../../services/main/src/modules/concept-page/contract.ts';
import { resolveFacet } from '../../../services/main/src/modules/facets/registry.ts';
import { SAVED_FILTER_COST } from '../../../services/main/src/modules/saved-filter/contract.ts';
import { encodeSavedFilterCursor, SAVED_FILTER_CURSOR_STAMP, SAVED_FILTER_PINNED_AFTER,
  SAVED_FILTER_PINNED_PAGE, SAVED_FILTER_UNPINNED_OLDER_PAGE, SAVED_FILTER_UNPINNED_PAGE,
  SAVED_FILTER_UNPINNED_TIE_PAGE } from '../../../services/main/src/modules/saved-filter/store.ts';
import { seedHome, startHomeStack } from './feed-read-support.ts';

interface Item { id: string; name: string | null; concept: { id: string; name: { value: string } | null } | null;
  filter: unknown; facets: string[]; position: number | null; home: 'available' | 'unsupported'; revision: string }
interface Page { revision: string | null; items: Item[]; cursor: string | null; complete: boolean }
interface Receipt { action: string; id: string | null; filterRevision: string | null; revision: string; replayed: boolean }
interface FeedPage { items: { target: { work: string | null }; realm: { id: string } | null }[]; nextCursor: string | null }

const language = resolveFacet('language')!.id;

test('G-431 Saved Filters: create, rename, pin, reorder, unpin and delete; a followed Concept owns its pinned filter; '
  + 'a pinned tab reads Home filtered by it', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the integration tier');
  const home = await startHomeStack('saved-filter');
  try {
    const seeded = await seedHome(home);
    // The route stays platform:saved-views. This reader holds that use grant.
    Object.assign(home.deps, { platformAccess: new AccessExposure(home.stack.accessPool) });
    const useGrant = randomUUID();
    await home.stack.accessPool.query(`INSERT INTO access.principal_permission_grant
      (id, issuer_subject, principal_id, scope_id, action, valid_until)
      VALUES ($1, $2, $3, 'platform:access', 'platform:use:saved-views', 'infinity')`,
    [useGrant, home.reader.actor, home.reader.principalId]);
    await home.stack.accessPool.query(`INSERT INTO access.platform_grant_episode
      (id, principal_grant_id, issuer_subject, permission, scope_id, assigned_by_principal, receipt)
      VALUES ($1, $1, $2, 'platform:use:saved-views', 'platform:access', $3, $4)`,
    [useGrant, home.reader.actor, home.reader.principalId,
      `urn:rezics:access-receipt:${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`]);
    const { call, json } = home;
    const a = home.author, token = home.reader.token, reader = seeded.reader;
    const signed = seeded.signed;
    const list = async (cursor?: string | null) => json<Page>(await call('GET', signed(
      `/v1/me/saved-filters?language=en${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), undefined, token));
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
    // The first Work is also the Home community's pick; that Realm keeps no classification Context of its own.
    const [picked, tagged, other] = [seeded.works[0]!, seeded.works[3]!, seeded.works[4]!];
    for (const [work, term] of [[picked, fantasy], [tagged, fantasy], [other, mystery]] as const) {
      await json(await call('POST', '/v1/classification-decisions', { profile: 'classification-direct-decision-v1',
        work: work.work, mainVersion: work.mainVersion, sense: term.sense, context: { kind: 'global' },
        outcome: 'accepted', expectedDecisionHead: null, actingSubject: a.actor }, a.token), 201);
    }
    await home.project();

    // Denied: no session is the closed capability; another person's Agent is refused.
    const empty = await list();
    expect(empty.items).toEqual([]);
    expect(empty.cursor).toBeNull();
    expect(empty.complete).toBe(true);
    const unsigned = await call('GET', signed('/v1/me/saved-filters'));
    expect(unsigned.status).toBe(403);
    expect(await unsigned.json()).toMatchObject({ code: 'platform_closed' });
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
      profile: 'filter-document-v2',
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
    expect(magicPosts.some(item => item.target.work === tagged.work)).toBe(true);
    // A Realm without its own classification Context reads the Global decisions it inherits.
    expect(magicPosts.some(item => item.target.work === picked.work && item.realm?.id === seeded.realm.realm)).toBe(true);
    expect(magicPosts.every(item => [tagged.work, picked.work].includes(item.target.work!))).toBe(true);
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

    // One hundred and fifty filters, including one named after any stored count is gone.
    // A page of Concepts stays inside the summary batch. Rename and delete during the
    // walk neither duplicate nor skip a filter that remains.
    const owner = (await home.stack.accessPool.query<{ principal_id: string }>(
      'SELECT principal_id FROM access.saved_filter WHERE id = $1', [unpinnedBooks.id])).rows[0]!.principal_id;
    expect((await home.stack.accessPool.query(`SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'access' AND table_name = 'saved_filter_inventory' AND column_name = 'named_count'`))
      .rowCount).toBe(0);
    await home.stack.accessPool.query(`INSERT INTO access.saved_filter (id, principal_id, name, profile, document,
      facets, context, concept, pin_position, revision, created_at)
      SELECT gen_random_uuid(), $1, 'Inventory ' || g, 'filter-document-v2',
        jsonb_build_object('all', jsonb_build_array(jsonb_build_object(
          'facet', $2::text, 'any', jsonb_build_array('https://rezics.com/id/' || concept_id)))),
        ARRAY[$2::text], 'global', 'https://rezics.com/id/' || concept_id, NULL, gen_random_uuid(),
        timestamptz '2024-01-01+00' + (g || ' seconds')::interval
      FROM (SELECT g, gen_random_uuid()::text AS concept_id FROM generate_series(1, 139) AS g) seeded`,
    [owner, CONCEPT_FACET]);
    await home.stack.accessPool.query(`UPDATE access.saved_filter SET created_at = timestamptz '2024-06-01+00'
      WHERE id IN (SELECT id FROM access.saved_filter WHERE principal_id = $1 AND name LIKE 'Inventory %'
        ORDER BY id LIMIT 2)`, [owner]);
    await json<Receipt>(await create({ name: 'Past the old ceiling', pinned: false,
      filter: { all: [{ facet: 'language', any: ['en'] }] } }), 201);
    const tail = (await home.stack.accessPool.query<{ id: string; revision: string }>(
      `SELECT id, revision FROM access.saved_filter WHERE principal_id = $1 AND pin_position IS NULL
       ORDER BY created_at ASC, id ASC LIMIT 2`, [owner])).rows;
    // A Concept filter is removed by unfollowing. These two are ordinary named filters.
    await home.stack.accessPool.query('UPDATE access.saved_filter SET concept = NULL WHERE id = ANY($1::uuid[])',
      [tail.map(row => row.id)]);
    const duringWalk = tail[0]!, removed = tail[1]!;
    const seen: Item[] = [];
    const ids = new Set<string>();
    let cursor: string | null = null;
    let renamedName: string | null = null;
    const conceptCounts: number[] = [];
    for (let index = 0; index < 8; index++) {
      const walked = await list(cursor);
      expect(walked.items.length).toBeLessThanOrEqual(SAVED_FILTER_COST.page);
      expect(walked.complete).toBe(walked.cursor === null);
      const concepts = new Set(walked.items.flatMap(item => item.concept ? [item.concept.id] : []));
      expect(concepts.size).toBeLessThanOrEqual(SAVED_FILTER_COST.page);
      conceptCounts.push(concepts.size);
      for (const item of walked.items) {
        expect(ids.has(item.id)).toBe(false);
        ids.add(item.id);
        seen.push(item);
        if (item.id === duringWalk.id) renamedName = item.name;
      }
      if (index === 0) {
        expect(walked.items.some(item => item.id === duringWalk.id || item.id === removed.id)).toBe(false);
        await json(await update(duringWalk.id, { expectedRevision: duringWalk.revision, name: 'Renamed during the walk' }));
        await json(await remove(removed.id, removed.revision));
      }
      if (!walked.cursor) break;
      cursor = walked.cursor;
      if (index === 7) throw new Error('Saved Filter list did not terminate');
    }
    expect(ids.has(removed.id)).toBe(false);
    expect(renamedName).toBe('Renamed during the walk');
    expect(conceptCounts.some(count => count === SAVED_FILTER_COST.page)).toBe(true);
    const ordered = (await home.stack.accessPool.query<{ id: string }>(
      `SELECT id FROM access.saved_filter WHERE principal_id = $1
       ORDER BY pin_position NULLS LAST, created_at DESC, id`, [owner])).rows.map(row => row.id);
    expect(seen.map(item => item.id)).toEqual(ordered);
    let nulls = false, lastPin = -1;
    for (const item of seen) {
      if (item.position === null) nulls = true;
      else {
        expect(nulls).toBe(false);
        expect(item.position!).toBeGreaterThan(lastPin);
        lastPin = item.position!;
      }
    }

    const lastPinRow = (await home.stack.accessPool.query<{ id: string; pin_position: number; created_at_text: string }>(
      `SELECT id, pin_position, ${SAVED_FILTER_CURSOR_STAMP} AS created_at_text FROM access.saved_filter
       WHERE principal_id = $1 AND pin_position IS NOT NULL ORDER BY pin_position DESC LIMIT 1`, [owner])).rows[0]!;
    const afterPins = await list(encodeSavedFilterCursor(lastPinRow));
    expect(afterPins.items.every(item => item.position === null)).toBe(true);
    const firstUnpinned = (await home.stack.accessPool.query<{ id: string }>(
      `SELECT id FROM access.saved_filter WHERE principal_id = $1 AND pin_position IS NULL
       ORDER BY created_at DESC, id LIMIT 1`, [owner])).rows[0]!.id;
    expect(afterPins.items[0]?.id).toBe(firstUnpinned);
    const ties = (await home.stack.accessPool.query<{ id: string; pin_position: number | null; created_at_text: string }>(
      `SELECT id, pin_position, ${SAVED_FILTER_CURSOR_STAMP} AS created_at_text FROM access.saved_filter
       WHERE principal_id = $1 AND created_at = timestamptz '2024-06-01+00' ORDER BY id`, [owner])).rows;
    expect(ties).toHaveLength(2);
    const afterTie = await list(encodeSavedFilterCursor(ties[0]!));
    expect(afterTie.items[0]?.id).toBe(ties[1]!.id);
    expect(afterTie.items.some(item => item.id === ties[0]!.id || item.position !== null)).toBe(false);
    expect((await call('GET', signed('/v1/me/saved-filters?language=en&cursor=not-a-cursor'), undefined, token)).status)
      .toBe(400);

    const planner = await home.stack.accessPool.connect();
    try {
      await planner.query('SET enable_seqscan = off');
      await planner.query('SET enable_bitmapscan = off');
      // A sort would hide whether the listing index itself can order the page.
      await planner.query('SET enable_sort = off');
      const seek = async (sql: string, params: unknown[]) => {
        const plan = (await planner.query<{ 'QUERY PLAN': { Plan: Record<string, unknown> }[] }>(
          `EXPLAIN (FORMAT JSON) ${sql}`, params)).rows[0]!['QUERY PLAN'];
        const nodes: Record<string, unknown>[] = [];
        const visit = (node: Record<string, unknown>) => {
          nodes.push(node);
          for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) visit(child);
        };
        visit(plan[0]!.Plan);
        const shape = nodes.map(node => ({ type: node['Node Type'], index: node['Index Name'],
          sort: node['Sort Key'], cond: node['Index Cond'], filter: node['Filter'] }));
        if (shape.some(node => node.type === 'Sort')
          || !shape.some(node => node.type === 'Index Scan' && node.index === 'saved_filter_listing')) {
          throw new Error(`${sql.slice(sql.indexOf('WHERE'), sql.indexOf('ORDER'))} ${JSON.stringify(shape)}`);
        }
      };
      await seek(SAVED_FILTER_PINNED_PAGE, [owner, SAVED_FILTER_COST.page + 1]);
      await seek(SAVED_FILTER_PINNED_AFTER, [owner, 0, SAVED_FILTER_COST.page + 1]);
      await seek(SAVED_FILTER_UNPINNED_PAGE, [owner, SAVED_FILTER_COST.page + 1]);
      await seek(SAVED_FILTER_UNPINNED_OLDER_PAGE, [owner, '2024-06-01T00:00:00.000000Z', SAVED_FILTER_COST.page + 1]);
      await seek(SAVED_FILTER_UNPINNED_TIE_PAGE, [owner, '2024-06-01T00:00:00.000000Z', ties[0]!.id,
        SAVED_FILTER_COST.page + 1]);
    } finally {
      await planner.query('RESET enable_seqscan');
      await planner.query('RESET enable_bitmapscan');
      await planner.query('RESET enable_sort');
      planner.release();
    }
  } finally { await home.stop(); }
}, 300_000);
