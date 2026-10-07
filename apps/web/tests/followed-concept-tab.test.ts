import { describe, expect, test } from 'bun:test';
import {
  addressConceptTab, appendConceptTabs, appendConceptWorks, applyConceptWorks, conceptFeedIdentity,
  conceptFeedPage, conceptFeedQuery, conceptTabList, conceptTabsFromFollows, conceptTabsThatFit,
  conceptWorksExhausted, CONCEPT_FEED_MAX_PAGE, CONCEPT_FEED_QUERY, filtersBesideTopics, readConceptFeed,
  readFirstConceptPage, tabFromFollowState, topicContinuation, topicFeedFrom, visibleConceptTabs, withOpenedConcept,
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

  test('Home keeps the first follows page and reaches every later topic from its cursor', async () => {
    const calls: (string | undefined)[] = [];
    const first = conceptTabList({ items: [follow(1), follow(2)], nextCursor: 'p2', complete: false });
    const listed = await readFirstConceptPage(async () => {
      calls.push('first');
      return { ok: true, data: first };
    });
    expect(calls).toEqual(['first']);
    expect(listed).toEqual({ tabs: conceptTabsFromFollows([follow(1), follow(2)]), nextCursor: 'p2', complete: false });
    const next = conceptTabList({ items: [follow(3), { ...follow(4), kind: 'realm' }], nextCursor: 'p3', complete: false });
    const empty = conceptTabList({ items: [], nextCursor: 'p4', complete: false });
    const more = appendConceptTabs(listed!.tabs, next, 'p2');
    expect(more.tabs.map(tab => tab.tab)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(more.cursor).toBe('p3');
    // An empty follows page is not the end while its cursor continues.
    expect(appendConceptTabs(more.tabs, empty, 'p3')).toEqual({ tabs: more.tabs, cursor: 'p4' });
    expect(conceptTabsThatFit({ available: 300, prefix: 100, more: 80, tabs: [80, 80, 80] }, false)).toBe(1);
    expect(conceptTabsThatFit({ available: 300, prefix: 100, more: 80, tabs: [80] }, true)).toBe(1);
    expect(conceptTabsThatFit({ available: 300, prefix: 100, more: 80, tabs: [80, 80] }, true)).toBe(1);
    const open = visibleConceptTabs(conceptTabsFromFollows([follow(1), follow(2), follow(3)]), 1, uuid(3));
    expect(open.map(tab => tab.tab)).toEqual([uuid(3)]);

    expect(await readFirstConceptPage(async () => ({ ok: false, failure: 'unavailable' }))).toBeNull();
    let moved = true;
    const retried = await readFirstConceptPage(async () => {
      if (moved) { moved = false; return { ok: false, failure: 'moved' }; }
      return { ok: true, data: conceptTabList({ items: [follow(4)], nextCursor: null, complete: true }) };
    });
    expect(retried?.tabs.map(tab => tab.tab)).toEqual([uuid(4)]);
    expect(await readFirstConceptPage(async () => ({ ok: false, failure: 'moved' }))).toBeNull();
  });

  test('a new read replaces the page, including a retry after the first read failed', () => {
    const failed = { ok: false as const, failure: 'unavailable' as const };
    const first = { ok: true as const, data: conceptFeedPage(envelope([work(1)], 'older'))! };
    const retried = { ok: true as const, data: conceptFeedPage(envelope([work(2)], null))! };
    expect(conceptFeedIdentity(failed)).not.toBe(conceptFeedIdentity(first));
    expect(conceptFeedIdentity(first)).not.toBe(conceptFeedIdentity(retried));
    expect(topicFeedFrom(failed)).toEqual({ items: [], cursor: null });
    expect(topicFeedFrom(retried).items.map(item => item.id)).toEqual([concept(202)]);
    expect(topicFeedFrom(retried).cursor).toBeNull();
  });

  test('an empty page with a cursor is not the end of the topic', () => {
    const empty = conceptFeedPage(envelope([], 'older'))!;
    expect(conceptWorksExhausted(empty.items, empty.nextCursor)).toBe(false);
    expect(appendConceptWorks([], empty, 'first')).toEqual({ items: [], cursor: 'older' });
    expect(conceptWorksExhausted([], null)).toBe(true);
    expect(conceptFeedPage(envelope([], null))!.complete).toBe(true);
  });

  test('a moved continuation starts again from the newest page instead of the rejected cursor', () => {
    expect(topicContinuation('moved')).toBe('restart');
    expect(topicContinuation('invalid')).toBe('restart');
    expect(topicContinuation('unavailable')).toBe('retry');
    const stale = conceptFeedPage(envelope([work(1)], 'dead'))!;
    const newest = conceptFeedPage(envelope([work(9)], null))!;
    const restarted = applyConceptWorks(stale.items, newest, null);
    expect(restarted).toEqual({ items: newest.items, cursor: null });
    expect(restarted.items.map(item => item.id)).not.toEqual(stale.items.map(item => item.id));
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
