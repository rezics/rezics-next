import { describe, expect, test } from 'bun:test';
import { activeFilterCount, feedQuery, feedSearch, interestFilter, interestKinds, kindAvailable, parseFeedState,
  withChange } from '../features/feed/state.ts';
import { relativeTime } from '../features/feed/time.ts';

const realm = 'https://rezics.com/id/01a0e430-e167-7384-9cb3-e3eba0e0cd3f';
const following = { tab: 'following', sort: 'best' } as const;

describe('home feed URL state', () => {
  test('signed out there is only All; a signed-in reader starts on their default view', () => {
    expect(parseFeedState({ tab: 'following' }, false).tab).toBe('all');
    expect(parseFeedState({}, true).tab).toBe('following');
    expect(parseFeedState({}, true, { tab: 'all', sort: 'new' })).toMatchObject({ tab: 'all', sort: 'new' });
  });

  test('Following has no Top: Main ranks Top only across REZICS', () => {
    expect(parseFeedState({ sort: 'top' }, true).sort).toBe('best');
    expect(parseFeedState({ tab: 'all', sort: 'top', t: 'month' }, true)).toMatchObject({ sort: 'top', window: 'month' });
    expect(withChange(parseFeedState({ tab: 'all', sort: 'top' }, true), { tab: 'following' }).sort).toBe('best');
  });

  test('unknown or malformed values are dropped instead of failing the page', () => {
    const state = parseFeedState({ tab: 'hot', sort: 'rising', t: 'decade', kind: 'podcasts',
      lang: 'en,klingon,ja,en', realm: [realm, 'not-an-iri', realm] }, true);
    expect(state).toEqual({ tab: 'following', sort: 'best', window: 'week', kind: null, languages: ['en', 'ja'],
      realms: [realm] });
  });

  test('a URL carries only what differs from the defaults, and reads back the same', () => {
    const state = parseFeedState({ tab: 'all', sort: 'top', t: 'month', kind: 'discussions', lang: ['ja', 'ko'],
      realm }, true);
    const search = feedSearch(state, following);
    expect(search).toBe(`?tab=all&sort=top&t=month&kind=discussions&lang=ja%2Cko&realm=${encodeURIComponent(realm)}`);
    expect(parseFeedState(new URLSearchParams(search), true)).toEqual(state);
    expect(feedSearch(parseFeedState({}, true), following)).toBe('');
  });

  test('switching tab or sort keeps every filter (advanced choices survive simple edits)', () => {
    const state = parseFeedState({ sort: 'new', lang: 'ja', realm }, true);
    const all = withChange(state, { tab: 'all' });
    expect(all).toMatchObject({ tab: 'all', sort: 'new', languages: ['ja'], realms: [realm] });
    expect(withChange(all, { sort: 'best' })).toMatchObject({ languages: ['ja'], realms: [realm] });
    expect(activeFilterCount(all)).toBe(2);
  });
});

describe('the feed query sent to Main', () => {
  test('an empty filter adds no hidden defaults', () => {
    const query = feedQuery(parseFeedState({}, false), { language: 'zh-Hans' });
    expect(query).toEqual({ scope: 'all', sort: 'best', language: 'zh-Hans' });
    expect(Object.keys(query)).not.toContain('contentLanguages');
    expect(Object.keys(query)).not.toContain('kinds');
  });

  test('personal views act as the session Agent; Top sends its window; filters pass through', () => {
    const agent = 'https://rezics.com/id/ef4ffe88-cffd-4b05-9c7f-590b8b3b6486';
    expect(feedQuery(parseFeedState({ tab: 'all', sort: 'top', t: 'all', lang: 'ja', realm }, true),
      { language: 'en', actingSubject: agent, cursor: 'c2' })).toEqual({ scope: 'all', sort: 'top', window: 'all',
      contentLanguages: ['ja'], realms: [realm], language: 'en', actingSubject: agent, cursor: 'c2' });
  });

  test('people choose from six kinds; each maps to Main or waits for its filter', () => {
    expect(interestKinds).toHaveLength(6);
    expect(feedQuery(parseFeedState({ kind: 'discussions' }, false), { language: 'en' }).kinds)
      .toEqual(['discussion', 'reply']);
    // Main's feed filters by activity, not by what a Work is: these need its proposed `interests` filter.
    expect(interestKinds.filter(kind => !kindAvailable(kind))).toEqual(['books', 'software', 'ai', 'recipes', 'media']);
    expect(feedQuery(parseFeedState({ kind: 'recipes' }, false), { language: 'en' }).kinds).toBeUndefined();
    expect(Object.keys(interestFilter)).toEqual([...interestKinds]);
  });
});

describe('relative time', () => {
  const now = Date.parse('2026-09-28T09:00:00.000Z');
  test('prints the same text from the server clock in any locale', () => {
    expect(relativeTime('2026-09-28T06:00:00.000Z', now, 'en')).toBe('3h ago');
    expect(relativeTime('2026-09-28T08:59:40.000Z', now, 'en')).toBe('now');
    expect(relativeTime('2026-09-21T09:00:00.000Z', now, 'zh-Hans', 'long')).toBe('上周');
  });
});
