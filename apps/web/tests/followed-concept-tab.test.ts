import { describe, expect, test } from 'bun:test';
import {
  addressConceptTab, appendConceptWorks, collectConceptTabs, conceptFeedPage, conceptFeedQuery,
  conceptTabsFromFollows, CONCEPT_FEED_MAX_PAGE, CONCEPT_FEED_QUERY, filtersBesideTopics,
  readConceptFeed, tabFromFollowState, withOpenedConcept,
} from '../features/home/followed-concept-feed.ts';
const concept = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const uuid = (n: number) => concept(n).slice(-36);
const name = (value: string, language = 'en') => ({ value, language, direction: 'ltr' as const, basis: 'requested' });

const follow = (n: number, extra: Record<string, unknown> = {}) => ({
  id: concept(n), kind: 'concept', available: true, revision: uuid(100 + n), name: name(`Topic ${n}`), ...extra,
});

const work = (n: number, topic = 1) => ({ id: concept(200 + n), concept: concept(topic), name: name(`Work ${n}`) });

const envelope = (items: unknown[], nextCursor: string | null) => ({
  profile: 'query-v1', template: CONCEPT_FEED_QUERY,
  result: { profile: 'template-result-v1', query: CONCEPT_FEED_QUERY, revision: 1, items,
    nextCursor, complete: nextCursor === null, sourcePosition: { dataEpoch: '1', sequence: '1' },
    count: { value: items.length, kind: 'exact-page', total: null } },
});

describe('followed topic tabs', () => {
  test('a followed Concept is a tab in list order, and nothing else on the page is', () => {
    const tabs = conceptTabsFromFollows([
      follow(1),
      { ...follow(2), kind: 'work' },
      { ...follow(3), available: false, name: null },
      follow(1),
      { id: 'not-a-concept', kind: 'concept', available: true, revision: uuid(9), name: name('Nope') },
      follow(4, { name: name('仙侠', 'zh-Hans') }),
    ]);
    expect(tabs.map(tab => tab.tab)).toEqual([uuid(1), uuid(3), uuid(4)]);
    expect(tabs[0]).toMatchObject({ id: concept(1), name: { value: 'Topic 1', language: 'en' }, revision: uuid(101) });
    expect(tabs[1]!.name).toBeNull();
    expect(tabs[2]!.name).toEqual({ value: '仙侠', language: 'zh-Hans', direction: 'ltr' });
  });

  test('the tab reads the public template, one Concept at a time, seek-paged', () => {
    expect(conceptFeedQuery(concept(1))).toEqual({
      profile: 'template-query-v1', query: CONCEPT_FEED_QUERY, revision: 1,
      parameters: { roots: [concept(1)] },
    });
    expect(conceptFeedQuery(concept(1), { cursor: 'next', language: 'zh-Hans' })).toEqual({
      profile: 'template-query-v1', query: CONCEPT_FEED_QUERY, revision: 1,
      parameters: { roots: [concept(1)] }, presentation: { language: 'zh-Hans' }, cursor: 'next',
    });
    expect(conceptFeedQuery(concept(1), { limit: CONCEPT_FEED_MAX_PAGE })!.limit).toBe(64);
    expect(conceptFeedQuery(concept(1), { limit: 65 })).toBeNull();
    expect(conceptFeedQuery(concept(1), { limit: 0 })).toBeNull();
    expect(conceptFeedQuery(uuid(1))).toBeNull();
    expect(conceptFeedQuery(concept(1), { cursor: '' })).toBeNull();
    const body = conceptFeedQuery(concept(1), { cursor: 'next' })!;
    expect(body).not.toHaveProperty('page');
    expect(body).not.toHaveProperty('savedFilter');
    expect(body.parameters.roots).toEqual([concept(1)]);
  });

  test('the page keeps the server order and refuses another operation or a cursor that disagrees', () => {
    const page = conceptFeedPage(envelope([work(2), work(1)], 'older'));
    expect(page).toEqual({
      items: [
        { id: concept(202), concept: concept(1), name: { value: 'Work 2', language: 'en', direction: 'ltr' } },
        { id: concept(201), concept: concept(1), name: { value: 'Work 1', language: 'en', direction: 'ltr' } },
      ],
      nextCursor: 'older', complete: false,
    });
    expect(conceptFeedPage(envelope([], null))).toEqual({ items: [], nextCursor: null, complete: true });
    expect(conceptFeedPage({ profile: 'template-result-v1', query: 'https://rezics.com/query/work-credits',
      revision: 1, items: [], nextCursor: null, complete: true })).toBeNull();
    expect(conceptFeedPage({ items: [work(1)], nextCursor: null })).toBeNull();
    expect(conceptFeedPage(envelope([work(1)], 'older')) && conceptFeedPage({
      ...envelope([work(1)], 'older').result, complete: true })).toBeNull();
    expect(conceptFeedPage(envelope([{ id: concept(201) }], null))).toBeNull();
  });

  test('a further page appends unseen works and does not ask for the same cursor again', () => {
    const first = conceptFeedPage(envelope([work(2), work(1)], 'older'))!;
    const second = conceptFeedPage(envelope([work(1), work(3)], null))!;
    expect(appendConceptWorks(first.items, second, 'older')).toEqual({
      items: [...first.items, second.items[1]!], cursor: null,
    });
    const stuck = conceptFeedPage(envelope([work(4)], 'older'))!;
    expect(appendConceptWorks(first.items, stuck, 'older').cursor).toBeNull();
  });

  test('an address is a followed topic only when the list says so, and an unfinished list stays unconfirmed', () => {
    const listed = { tabs: conceptTabsFromFollows([follow(1), follow(2)]), complete: true };
    expect(addressConceptTab(listed, uuid(1)).kind).toBe('selected');
    expect(addressConceptTab(listed, uuid(9))).toEqual({ kind: 'absent' });
    expect(addressConceptTab({ ...listed, complete: false }, uuid(9))).toEqual({ kind: 'unconfirmed' });
    expect(addressConceptTab(null, uuid(1))).toEqual({ kind: 'unconfirmed' });
    expect(addressConceptTab(listed, 'not-a-uuid')).toEqual({ kind: 'absent' });
  });

  test('follow state confirms one topic the list had not reached, and a topic that is not followed stays absent', () => {
    const confirmed = tabFromFollowState({ following: true, revision: uuid(7),
      target: { id: concept(8), kind: 'concept', name: name('Cozy') } }, uuid(8));
    expect(confirmed).toMatchObject({ id: concept(8), tab: uuid(8), name: { value: 'Cozy' } });
    expect(withOpenedConcept(conceptTabsFromFollows([follow(1)]), confirmed).map(tab => tab.tab)).toEqual([uuid(1), uuid(8)]);
    expect(tabFromFollowState({ following: true, revision: null,
      target: { id: concept(8), kind: 'concept', name: name('Cozy') } }, uuid(8))?.revision).toBe('');
    expect(tabFromFollowState({ following: false, revision: uuid(7),
      target: { id: concept(8), kind: 'concept', name: name('Cozy') } }, uuid(8))).toBeNull();
    expect(tabFromFollowState({ following: true, revision: uuid(7),
      target: { id: concept(8), kind: 'work', name: name('Cozy') } }, uuid(8))).toBeNull();
  });

  test('the follows list is seek-paged, a failed first page is unread, and a moved list is read once more', async () => {
    const pages = [
      { items: [follow(1)], nextCursor: 'p2', complete: false },
      { items: [follow(2), { ...follow(3), kind: 'realm' }], nextCursor: null, complete: true },
    ];
    const cursors: (string | undefined)[] = [];
    const listed = await collectConceptTabs(async cursor => {
      cursors.push(cursor);
      const page = pages[cursors.length - 1]!;
      return { ok: true, data: page };
    });
    expect(cursors).toEqual([undefined, 'p2']);
    expect(listed).toEqual({ tabs: conceptTabsFromFollows([follow(1), follow(2)]), complete: true });

    expect(await collectConceptTabs(async () => ({ ok: false, failure: 'unavailable' }))).toBeNull();

    let moved = true;
    const retried = await collectConceptTabs(async () => {
      if (moved) { moved = false; return { ok: false, failure: 'moved' }; }
      return { ok: true, data: { items: [follow(4)], nextCursor: null, complete: true } };
    });
    expect(retried?.tabs.map(tab => tab.tab)).toEqual([uuid(4)]);

    expect(await collectConceptTabs(async () => ({ ok: false, failure: 'moved' }))).toBeNull();

    const partial = await collectConceptTabs(async cursor => cursor
      ? { ok: false, failure: 'unavailable' }
      : { ok: true, data: { items: [follow(1)], nextCursor: 'p2', complete: false } });
    expect(partial).toEqual({ tabs: conceptTabsFromFollows([follow(1)]), complete: false });
  });

  test('a topic tab does not depend on Saved Filters, and it replaces only the filter that named that topic', () => {
    const topics = conceptTabsFromFollows([follow(1)]);
    const filters = [
      { id: 'filter-1', concept: { id: concept(1) } },
      { id: 'filter-2', concept: null },
      { id: 'filter-3', concept: { id: concept(2) } },
    ];
    expect(filtersBesideTopics(filters, topics).map(filter => filter.id)).toEqual(['filter-2', 'filter-3']);
    expect(conceptFeedQuery(concept(1))).not.toHaveProperty('savedFilter');
  });

  test('the read asks the template and keeps a page whose works are all that topic', async () => {
    const calls: unknown[] = [];
    const main = { v1: { query: { post: (body: unknown) => {
      calls.push(body);
      return Promise.resolve({ data: envelope([work(1), work(2, 9)], null), error: null });
    } } } };
    const mixed = await readConceptFeed(main as never, concept(1), 'en');
    expect(mixed).toEqual({ ok: false, failure: 'invalid' });
    expect(calls).toEqual([conceptFeedQuery(concept(1), { language: 'en' })]);

    const ok = await readConceptFeed({ v1: { query: { post: () => Promise.resolve({
      data: envelope([work(2), work(1)], 'older'), error: null }) } } } as never, concept(1));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.data.items.map(item => item.id)).toEqual([concept(202), concept(201)]);

    const refused = await readConceptFeed({ v1: { query: { post: () => Promise.resolve({
      data: null, error: { status: 403, value: { code: 'platform_closed' } } }) } } } as never, concept(1));
    expect(refused).toMatchObject({ ok: false, failure: 'closed' });
  });
});
