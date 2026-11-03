import { expect, test } from 'bun:test';
import {
  characterPersonQueryKey,
  characterPersonVisibleState,
  characterPersonHref,
  characterPersonRequest,
  parseCharacterPersonSearch,
} from '../src/search/character-person';
import { discoveryFailure, parseDiscoveryPage, type DiscoveryState } from '../src/search/discovery';

const work = '018f0000-0000-7000-8000-00a000000001';
const secondWork = '018f0000-0000-7000-8000-00a000000002';
const role = '018f0000-0000-7000-8000-00a000000003';

test('the character and person journey preserves applied URL state and builds same-statement inverse filters', () => {
  const parsed = parseCharacterPersonSearch(
    {
      mode: 'people',
      name: 'Aki',
      work: [work, secondWork],
      role,
      language: ['ja', 'en'],
      threshold: '1',
      sort: 'relevance',
      cursor: 'opaque-next',
    },
    'en',
  );
  expect(parsed.error).toBeUndefined();
  const request = characterPersonRequest(parsed.search);
  expect(request.filter).toEqual({
    and: [
      { type: { in: ['schema:Person'] } },
      {
        statement: {
          property: 'wdt:P725',
          inverse: true,
          in: [work, secondWork],
          qualifiers: [{ property: 'wdt:P3831', in: [role] }],
        },
      },
    ],
  });
  expect(request.languages).toEqual(['ja', 'en']);
  expect(request.spoilerThreshold).toBe(1);
  const url = new URL(characterPersonHref('ja', parsed.search, 'opaque-final'), 'https://rezics.test');
  expect(url.pathname).toBe('/ja/search/characters');
  expect(url.searchParams.getAll('work')).toEqual([work, secondWork]);
  expect(url.searchParams.getAll('language')).toEqual(['ja', 'en']);
  expect(url.searchParams.get('cursor')).toBe('opaque-final');
  expect(url.searchParams.get('threshold')).toBe('1');
});

test('character appearance filters use their own statement and malformed inputs remain repairable', () => {
  const character = parseCharacterPersonSearch({ mode: 'characters', work, role, threshold: '2' }, 'en');
  expect(character.error).toBeUndefined();
  expect(characterPersonRequest(character.search).filter).toEqual({
    and: [
      { type: { in: ['schema:Character'] } },
      {
        statement: {
          property: 'wdt:P453',
          inverse: true,
          in: [work],
          qualifiers: [{ property: 'wdt:P3831', in: [role] }],
        },
      },
    ],
  });
  expect(parseCharacterPersonSearch({ role }, 'en').error).toBe('role_requires_work');
  const invalid = parseCharacterPersonSearch({ mode: 'characters', work: 'not-a-uuid', threshold: '9' }, 'en');
  expect(invalid.error).toBe('invalid_input');
  expect(invalid.form.works).toBe('not-a-uuid');
  expect(invalid.form.threshold).toBe('9');
});

test('request replacement retires stale rows and a replaced release enters the repairable restart state', () => {
  const parsed = parseCharacterPersonSearch({ mode: 'people', work, name: 'Aki' }, 'en');
  const key = characterPersonQueryKey('en', 'anonymous', parsed.search);
  expect(characterPersonQueryKey('ja', 'anonymous', parsed.search)).not.toEqual(key);
  expect(characterPersonQueryKey('en', 'account:one', parsed.search)).not.toEqual(key);
  expect(
    characterPersonQueryKey('en', 'anonymous', { ...parsed.search, name: 'Mika' }),
  ).not.toEqual(key);

  const ready: DiscoveryState = {
    status: 'ready',
    page: { hits: [], kinds: { values: [], next: null }, next: null, as_of: '2026-11-04T00:00:00.000Z' },
  };
  expect(characterPersonVisibleState(parsed, true, { discovery: ready, restarted: false })).toEqual({
    status: 'loading',
  });
  expect(
    characterPersonVisibleState(parsed, false, {
      discovery: discoveryFailure(409, { code: 'search_restart_required' }),
      restarted: false,
    }),
  ).toEqual({ status: 'restart' });
});

test('the browser admits current subject contexts and rejects an unproven continuation shape', () => {
  const contexts = {
    credits: {
      items: [work, secondWork, role].map((id) => ({ id, labels: { en: `Work ${id}` }, aliases: { en: [`Alias ${id}`] } })),
      next: true,
    },
    appearances: { items: [], next: false },
  };
  const page = {
    hits: [
      {
        key: { owner: 'semantic', kind: 'schema:Person', route: 160, id: role },
        summary: {
          kind: 'subject',
          value: {
            id: role,
            type: 'schema:Person',
            types: ['schema:Person'],
            label: { language: 'en', value: 'Aki' },
            creativeWork: false,
            cover: null,
          },
        },
        labels: { en: 'Aki' },
        aliases: { en: ['Aki Sato'] },
        contexts,
      },
    ],
    kinds: { values: [], next: null },
    next: null,
    as_of: '2026-11-04T00:00:00.000Z',
  };
  expect(parseDiscoveryPage(page)?.hits[0]).toMatchObject({ contexts, labels: { en: 'Aki' }, aliases: { en: ['Aki Sato'] } });
  const invalid = structuredClone(page);
  invalid.hits[0]!.contexts.credits.items.pop();
  expect(parseDiscoveryPage(invalid)).toBeUndefined();
});
