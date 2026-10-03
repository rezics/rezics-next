import { uuidToSid } from '@rezics/model/address';
import { describe, expect, test } from 'bun:test';
import { messages } from '../features/work-page/messages.ts';
import { openLibraryAuthorKey } from '../features/work-page/credits.tsx';
import { failureOf } from '../features/work-page/read.ts';
import { paragraphs } from '../features/work-page/format.ts';
import {
  defaultReaderSettings,
  parsePosition,
  parseReaderSettings,
  serializeReaderSettings,
} from '../features/work-page/reader-settings.ts';
import {
  chapterHref,
  idOf,
  mainScope,
  neighbourScope,
  parseContentsQuery,
  parseHistoryQuery,
  parseReaderLanguage,
  parseScope,
  parseVersionQuery,
  parseWorkRef,
  shortId,
  tabOf,
  workHref,
} from '../features/work-page/route.ts';
import { scopeName } from '../features/work-page/scope-labels.ts';

const work = '5f7a2c1e-8d3b-4c6a-9e2f-1b4d6a8c0e3f';
const realm = '7c3e9a1d-2b4f-4d6e-8a0c-5e7f9b1d3c2a';

describe('Work page addresses', () => {
  test('a ref is a Work UUID or a Main address slug; anything else is not a Work', () => {
    expect(parseWorkRef(work)).toEqual({ kind: 'id', id: work });
    expect(parseWorkRef('The-Cartographer')).toEqual({ kind: 'alias', key: 'The-Cartographer' });
    expect(parseWorkRef('春の物語')).toEqual({ kind: 'alias', key: '春の物語' });
    expect(parseWorkRef(uuidToSid(work))).toEqual({ kind: 'id', id: work });
    for (const ref of ['', 'a/b', 'a\\b', 'a?b', 'a#b', 'a\u0000b', 'x'.repeat(513)]) {
      expect(parseWorkRef(ref)).toBeNull();
    }
  });

  test('tabs are separate URLs that keep the scope, and the Overview has no tab segment', () => {
    expect(workHref(work)).toBe(`/w/${uuidToSid(work)}`);
    expect(workHref(work, 'versions')).toBe(`/w/${uuidToSid(work)}/versions`);
    expect(workHref('slug', 'history', { kind: 'realm', realm })).toBe(
      `/w/slug/history?scope=realm&realm=${realm}`,
    );
    expect(workHref(work, 'overview', { kind: 'mine' }, { context: 'c' })).toBe(
      `/w/${uuidToSid(work)}?scope=mine&context=c`,
    );
    expect(workHref(work, 'versions', null, { kind: undefined, language: 'ja' })).toBe(
      `/w/${uuidToSid(work)}/versions?language=ja`,
    );
    expect(tabOf(`/w/${uuidToSid(work)}`)).toBe('overview');
    expect(tabOf(`/w/${uuidToSid(work)}/discussion`)).toBe('discussion');
    // Pages live under the interface locale.
    expect(tabOf(`/zh-Hans/w/${work}/versions`)).toBe('versions');
    expect(tabOf(`/en/w/${work}`)).toBe('overview');
    expect(tabOf(`/w/${uuidToSid(work)}/unknown`)).toBe('overview');
  });

  test('short IDs use the random tail, since UUIDv7s minted together share their head', () => {
    expect(shortId('https://rezics.com/id/01a0e3d0-dca8-7736-a626-f53097e68dce')).toBe('97e68dce');
    expect(shortId('https://rezics.com/id/01a0e3d0-dca8-7737-ac65-b7444eb96b02')).toBe('4eb96b02');
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
    for (const params of [
      { scope: 'realm' },
      { scope: 'realm', realm: 'nope' },
      { realm },
      { scope: 'mine', realm },
      { scope: 'everyone' },
      { scope: ['global', 'mine'] },
    ]) {
      expect(parseScope(params)).toBeNull();
    }
  });

  test('Main receives the Realm as its IRI', () => {
    expect(mainScope({ kind: 'realm', realm })).toEqual({
      scope: 'realm',
      realm: `https://rezics.com/id/${realm}`,
    });
    expect(mainScope({ kind: 'mine' })).toEqual({ scope: 'mine' });
  });

  test('empty states offer the neighbouring scope: Realm and Mine offer Global, Global offers an adopting Realm', () => {
    expect(neighbourScope({ kind: 'realm', realm }, [realm])).toEqual({ kind: 'global' });
    expect(neighbourScope({ kind: 'mine' }, [])).toEqual({ kind: 'global' });
    expect(neighbourScope({ kind: 'global' }, [realm])).toEqual({ kind: 'realm', realm });
    expect(neighbourScope({ kind: 'global' }, [])).toBeNull();
  });

  test('a community Main cannot name is still named, by its short ID', () => {
    const view = { workRef: work, scope: { kind: 'realm' as const, realm }, realms: [] };
    expect(scopeName(view, messages.en, 'en')).toBe('Community 9b1d3c2a');
    expect(
      scopeName(
        {
          ...view,
          realms: [
            {
              id: realm,
              name: {
                value: '潮汐',
                language: 'zh-Hans',
                direction: 'ltr' as const,
                basis: 'requested' as const,
              },
            },
          ],
        },
        messages['zh-Hans'],
        'zh-Hans',
      ),
    ).toBe('潮汐');
  });
});

describe('Work page reads', () => {
  test('version filters normalize a language tag and refuse malformed ones rather than dropping them', () => {
    expect(parseVersionQuery({})).toEqual({
      kind: undefined,
      language: undefined,
      cursor: undefined,
    });
    expect(parseVersionQuery({ kind: 'release', language: ' EN-gb ', cursor: 'abc' })).toEqual({
      kind: 'release',
      language: 'en-gb',
      cursor: 'abc',
    });
    expect(parseVersionQuery({ language: 'zh-Hans' })?.language).toBe('zh-Hans');
    expect(parseVersionQuery({ kind: '', language: '' })).toEqual({
      kind: undefined,
      language: undefined,
      cursor: undefined,
    });
    for (const params of [
      { kind: 'draft' },
      { language: 'english!' },
      { language: 'e' },
      { cursor: 'x'.repeat(2049) },
      { language: ['en', 'ja'] },
    ]) {
      expect(parseVersionQuery(params)).toBeNull();
    }
  });

  test('Main statuses map to what a region can say and offer', () => {
    expect([404, 410, 401, 403, 409, 400, 422, 503, 500].map(failureOf)).toEqual([
      'missing',
      'missing',
      'sign-in',
      'sign-in',
      'moved',
      'invalid',
      'budget',
      'unavailable',
      'unavailable',
    ]);
  });

  test('Open Library author paths show and link their ID', () => {
    expect(openLibraryAuthorKey('/authors/OL2162284A')).toBe('OL2162284A');
    expect(openLibraryAuthorKey('OL1A')).toBe('OL1A');
  });
});

describe('Work page contents, history and reader', () => {
  const part = 'b5c7d9e1-f3a5-4b7c-9d1e-000000000001';

  test('contents levels, history kinds and reader languages are refused when malformed, never widened', () => {
    expect(parseContentsQuery({ parent: part, language: 'ZH-Hans', cursor: 'c' })).toEqual({
      parent: part,
      language: 'zh-Hans',
      cursor: 'c',
    });
    expect(parseContentsQuery({})).toEqual({
      parent: undefined,
      language: undefined,
      cursor: undefined,
    });
    for (const params of [
      { parent: 'nope' },
      { language: 'not a tag' },
      { parent: [part, part] },
    ]) {
      expect(parseContentsQuery(params)).toBeNull();
    }
    expect(parseHistoryQuery({ kind: 'reply-placement' })).toEqual({
      kind: 'reply-placement',
      cursor: undefined,
    });
    expect(parseHistoryQuery({ kind: 'everything' })).toBeNull();
    expect(parseHistoryQuery({ kind: ['metadata-revision'] })).toBeNull();
    expect(parseReaderLanguage({})).toBeUndefined();
    expect(parseReaderLanguage({ language: 'JA' })).toBe('ja');
    expect(parseReaderLanguage({ language: '../x' })).toBeNull();
  });

  test('a chapter address names the chapter and keeps an explicit content language', () => {
    expect(chapterHref('slug', part)).toBe(`/w/slug/read/${part}`);
    expect(chapterHref(work, part, 'ja')).toBe(`/w/${uuidToSid(work)}/read/${part}?language=ja`);
  });

  test('reading settings survive a round trip and fall back per field', () => {
    const settings = { size: 3, width: 'wide' as const, face: 'sans' as const };
    expect(parseReaderSettings(serializeReaderSettings(settings))).toEqual(settings);
    expect(parseReaderSettings(undefined)).toEqual(defaultReaderSettings);
    expect(parseReaderSettings('size=99&width=huge&face=comic')).toEqual(defaultReaderSettings);
    expect(parseReaderSettings('size=0')).toEqual({ ...defaultReaderSettings, size: 0 });
  });

  test('a stored position is a paragraph index; anything else is ignored', () => {
    expect(parsePosition('p:12')).toBe(12);
    for (const value of [null, undefined, '', 'p:', 'p:-1', 'scroll:0.4', 'p:1234567'])
      expect(parsePosition(value)).toBeNull();
  });

  test('Content text is one paragraph per line', () => {
    expect(paragraphs('One.\n\nTwo.\n  \nThree.')).toEqual(['One.', 'Two.', 'Three.']);
  });
});
