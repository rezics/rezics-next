import { describe, expect, test } from 'bun:test';
import { activeFilterCount, feedQuery, feedSearch, parseFeedState, pinnedTab, withChange } from '../features/feed/state.ts';
import { relativeTime } from '../features/feed/time.ts';

const realm = 'https://rezics.com/id/01a0e430-e167-7384-9cb3-e3eba0e0cd3f';
const saved = '0192f3a0-6f1e-7c2d-9a4b-1c2d3e4f5a6b';
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

  test('unknown or malformed values are dropped instead of failing the page, including the retired kind', () => {
    const state = parseFeedState({ tab: 'hot', sort: 'rising', t: 'decade', kind: 'books',
      lang: 'en,klingon,ja,en', realm: [realm, 'not-an-iri', realm] }, true);
    expect(state).toEqual({ tab: 'following', filter: null, sort: 'best', window: 'week', languages: ['en', 'ja'],
      realms: [realm] });
  });

  test('a URL carries only what differs from the defaults, and reads back the same', () => {
    const state = parseFeedState({ tab: 'all', sort: 'top', t: 'month', lang: ['ja', 'ko'], realm }, true);
    const search = feedSearch(state, following);
    expect(search).toBe(`?tab=all&sort=top&t=month&lang=ja%2Cko&realm=${encodeURIComponent(realm)}`);
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

describe('pinned tabs', () => {
  test('G-431: a tab names a Saved Filter by its UUID, signed in only; its filter carries every Condition', () => {
    const state = parseFeedState({ tab: saved, lang: 'ja', realm, sort: 'top' }, true);
    expect(state).toEqual({ tab: 'pinned', filter: saved, sort: 'top', window: 'week', languages: [], realms: [] });
    expect(feedSearch(state, following)).toBe(`?tab=${saved}&sort=top`);
    expect(parseFeedState(new URLSearchParams(feedSearch(state, following)), true)).toEqual(state);
    expect(parseFeedState({ tab: saved }, false)).toMatchObject({ tab: 'all', filter: null });
    expect(parseFeedState({ tab: 'not-a-uuid' }, true)).toMatchObject({ tab: 'following', filter: null });
  });

  test('G-431: leaving a pinned tab leaves its filter; pinning keeps the sort and drops Home Filters', () => {
    const pinned = pinnedTab(parseFeedState({ sort: 'new', lang: 'ja' }, true), saved);
    expect(pinned).toMatchObject({ tab: 'pinned', filter: saved, sort: 'new', languages: [] });
    expect(withChange(pinned, { tab: 'following' })).toMatchObject({ tab: 'following', filter: null, sort: 'new' });
    expect(withChange({ ...pinned, sort: 'top' }, { tab: 'following' }).sort).toBe('best');
  });
});

describe('the feed query sent to Main', () => {
  test('an empty filter adds no hidden defaults', () => {
    const query = feedQuery(parseFeedState({}, false), { language: 'zh-Hans' });
    expect(query).toEqual({ scope: 'all', sort: 'best' });
    expect(Object.keys(query)).not.toContain('contentLanguages');
    expect(Object.keys(query)).not.toContain('kinds');
  });

  test('personal views act as the session Agent; Top sends its window; filters pass through', () => {
    const agent = 'https://rezics.com/id/ef4ffe88-cffd-4b05-9c7f-590b8b3b6486';
    expect(feedQuery(parseFeedState({ tab: 'all', sort: 'top', t: 'all', lang: 'ja', realm }, true),
      { language: 'en', actingSubject: agent, cursor: 'c2' })).toEqual({ scope: 'all', sort: 'top', window: 'all',
      contentLanguages: ['ja'], realms: [realm], actingSubject: agent, cursor: 'c2' });
  });

  test('G-431: a pinned tab reads All through its Saved Filter and sends no Conditions of its own', () => {
    const agent = 'https://rezics.com/id/ef4ffe88-cffd-4b05-9c7f-590b8b3b6486';
    expect(feedQuery(parseFeedState({ tab: saved, sort: 'top', lang: 'ja' }, true),
      { language: 'en', actingSubject: agent })).toEqual({ scope: 'all', sort: 'top', window: 'week',
      savedFilter: saved, actingSubject: agent });
    expect(feedQuery(parseFeedState({ kind: 'recipes' }, false), { language: 'en' })).toEqual({ scope: 'all',
      sort: 'best' });
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
