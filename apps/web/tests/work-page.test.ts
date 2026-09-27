import { describe, expect, test } from 'bun:test';
import { messages } from '../features/work-page/messages.ts';
import { openLibraryAuthorKey } from '../features/work-page/credits.tsx';
import { failureOf } from '../features/work-page/read.ts';
import { idOf, mainScope, neighbourScope, parseScope, parseVersionQuery, parseWorkRef, tabOf, workHref }
  from '../features/work-page/route.ts';
import { scopeName } from '../features/work-page/scope-bar.tsx';

const work = '5f7a2c1e-8d3b-4c6a-9e2f-1b4d6a8c0e3f';
const realm = '7c3e9a1d-2b4f-4d6e-8a0c-5e7f9b1d3c2a';

describe('Work page addresses', () => {
  test('a ref is a Work UUID or a Main address slug; anything else is not a Work', () => {
    expect(parseWorkRef(work)).toEqual({ kind: 'id', id: work });
    expect(parseWorkRef('The-Cartographer')).toEqual({ kind: 'slug', slug: 'the-cartographer' });
    for (const ref of ['', 'a--b', '-lead', 'trail-', 'has space', 'x'.repeat(65), '%2e%2e', 'ünïcode']) {
      expect(parseWorkRef(ref)).toBeNull();
    }
  });

  test('tabs are separate URLs that keep the scope, and the Overview has no tab segment', () => {
    expect(workHref(work)).toBe(`/w/${work}`);
    expect(workHref(work, 'versions')).toBe(`/w/${work}/versions`);
    expect(workHref('slug', 'history', { kind: 'realm', realm })).toBe(`/w/slug/history?scope=realm&realm=${realm}`);
    expect(workHref(work, 'overview', { kind: 'mine' }, { context: 'c' })).toBe(`/w/${work}?scope=mine&context=c`);
    expect(workHref(work, 'versions', null, { kind: undefined, language: 'ja' })).toBe(`/w/${work}/versions?language=ja`);
    expect(tabOf(`/w/${work}`)).toBe('overview');
    expect(tabOf(`/w/${work}/discussion`)).toBe('discussion');
    expect(tabOf(`/w/${work}/unknown`)).toBe('overview');
  });

  test('IDs come only from native IRIs', () => {
    expect(idOf(`https://rezics.com/id/${work}`)).toBe(work);
    expect(idOf(`https://example.com/id/${work}`)).toBeNull();
    expect(idOf('https://rezics.com/id/not-a-uuid')).toBeNull();
  });
});

describe('Work page scope', () => {
  test('the URL selects Global, a Realm or Mine, and a malformed scope is reported, not widened to Global', () => {
    expect(parseScope({})).toEqual({ kind: 'global' });
    expect(parseScope({ scope: 'global' })).toEqual({ kind: 'global' });
    expect(parseScope({ scope: 'mine' })).toEqual({ kind: 'mine' });
    expect(parseScope({ scope: 'realm', realm })).toEqual({ kind: 'realm', realm });
    for (const params of [{ scope: 'realm' }, { scope: 'realm', realm: 'nope' }, { realm }, { scope: 'mine', realm },
      { scope: 'everyone' }, { scope: ['global', 'mine'] }]) {
      expect(parseScope(params)).toBeNull();
    }
  });

  test('Main receives the Realm as its IRI', () => {
    expect(mainScope({ kind: 'realm', realm })).toEqual({ scope: 'realm', realm: `https://rezics.com/id/${realm}` });
    expect(mainScope({ kind: 'mine' })).toEqual({ scope: 'mine' });
  });

  test('empty states offer the neighbouring scope: Realm and Mine offer Global, Global offers an adopting Realm', () => {
    expect(neighbourScope({ kind: 'realm', realm }, [realm])).toEqual({ kind: 'global' });
    expect(neighbourScope({ kind: 'mine' }, [])).toEqual({ kind: 'global' });
    expect(neighbourScope({ kind: 'global' }, [realm])).toEqual({ kind: 'realm', realm });
    expect(neighbourScope({ kind: 'global' }, [])).toBeNull();
  });

  test('a Realm Main cannot name is still named, by its short ID', () => {
    const view = { workRef: work, scope: { kind: 'realm' as const, realm }, realms: [] };
    expect(scopeName(view, messages.en, 'en')).toBe('Realm 7c3e9a1d');
    expect(scopeName({ ...view, realms: [{ id: realm, name: { value: '潮汐', language: 'zh-Hans',
      direction: 'ltr' as const, basis: 'requested' as const } }] }, messages['zh-CN'], 'zh-CN')).toBe('潮汐');
  });
});

describe('Work page reads', () => {
  test('version filters normalize a language tag and refuse malformed ones rather than dropping them', () => {
    expect(parseVersionQuery({})).toEqual({ kind: undefined, language: undefined, cursor: undefined });
    expect(parseVersionQuery({ kind: 'release', language: ' EN-gb ', cursor: 'abc' }))
      .toEqual({ kind: 'release', language: 'en-gb', cursor: 'abc' });
    expect(parseVersionQuery({ language: 'zh-Hans' })?.language).toBe('zh-Hans');
    expect(parseVersionQuery({ kind: '', language: '' })).toEqual({ kind: undefined, language: undefined, cursor: undefined });
    for (const params of [{ kind: 'draft' }, { language: 'english!' }, { language: 'e' }, { cursor: 'x'.repeat(2049) },
      { language: ['en', 'ja'] }]) {
      expect(parseVersionQuery(params)).toBeNull();
    }
  });

  test('Main statuses map to what a region can say and offer', () => {
    expect([404, 410, 401, 403, 409, 400, 422, 503, 500].map(failureOf))
      .toEqual(['missing', 'missing', 'sign-in', 'sign-in', 'moved', 'invalid', 'budget', 'unavailable', 'unavailable']);
  });

  test('Open Library author paths show and link their ID', () => {
    expect(openLibraryAuthorKey('/authors/OL2162284A')).toBe('OL2162284A');
    expect(openLibraryAuthorKey('OL1A')).toBe('OL1A');
  });
});
