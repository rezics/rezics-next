import { afterEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import recording from '../src/kernel/recorded/definitions-release.json';
import { DiscoveryResults } from '../src/search/discovery-results';
import {
  characterPersonSelectionMetadata,
  editCharacterPersonSelection,
} from '../src/search/character-person-selection/model';
import {
  ConditionEntityLookupError,
  searchConditionEntities,
  resolveConditionEntityLabels,
} from '../src/search/condition-entity';
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
  expect(JSON.parse(url.searchParams.get('work')!)).toEqual([work, secondWork]);
  expect(JSON.parse(url.searchParams.get('language')!)).toEqual(['ja', 'en']);
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
  expect(characterPersonQueryKey('en', 'anonymous', { ...parsed.search, name: 'Mika' })).not.toEqual(key);

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
      items: [work, secondWork, role].map((id) => ({
        id,
        labels: { en: `Work ${id}` },
        aliases: { en: [`Alias ${id}`] },
      })),
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
  expect(parseDiscoveryPage(page)?.hits[0]).toMatchObject({
    contexts,
    labels: { en: 'Aki' },
    aliases: { en: ['Aki Sato'] },
  });
  const invalid = structuredClone(page);
  invalid.hits[0]!.contexts.credits.items.pop();
  expect(parseDiscoveryPage(invalid)).toBeUndefined();
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('a released work and labelled role become exact operands and a current typed result opens natively', async () => {
  const metadata = characterPersonSelectionMetadata({ ...recording.release, digest: 'current-release' })!;
  expect(metadata.workTargets).toContain('schema:Book');
  expect(metadata.workTargets).toContain('wd:Q689445');
  expect(metadata.roleTargets.people).toEqual(['skos:Concept']);
  expect(metadata.roleTargets.characters).toEqual([]); // P453 itself does not admit P3831 in this release.
  const roleTwin = '018f0000-0000-7000-8000-00a000000004';
  const context = {
    locale: 'ja',
    languages: ['zh-Hant', 'ja'],
    release: metadata.release,
    available: true,
    workContext: true,
  };
  const calls: URL[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input), 'https://rezics.test');
    calls.push(url);
    const roles = JSON.parse(url.searchParams.get('filter')!).type.in.includes('skos:Concept');
    return Response.json({
      as_of: '2026-11-04T00:00:00.000Z',
      types: roles
        ? { 'skos:Concept': { ja: '概念' } }
        : { 'schema:Book': { ja: '本' }, 'wd:Q689445': { ja: 'ビジュアルノベル' } },
      subjects: (roles ? [role, roleTwin] : [work, secondWork]).map((id, index) => ({
        id,
        type: roles ? 'skos:Concept' : index ? 'wd:Q689445' : 'schema:Book',
        labels: { ja: roles ? '主役' : '同名', 'zh-Hant': roles ? '主角' : '同名作品' },
        summary: null,
        ...(!roles
          ? {
              workContext: {
                subjectId: id,
                status: 'available',
                creator: {
                  id: role,
                  property: 'wdt:P50',
                  label: { value: '作者', language: 'ja' },
                  role: { value: '著者', language: 'ja' },
                },
              },
            }
          : {}),
      })),
    });
  }) as typeof fetch;
  const signal = new AbortController().signal;
  const works = await searchConditionEntities('同名', metadata.workTargets, context, signal);
  expect(works.map((item) => item.id)).toEqual([work, secondWork]);
  expect(works[0]!.title).toContain('同名作品');
  expect(works[0]!.title).toContain('著者: 作者');
  expect(works[1]!.typeLabel).toBe('ビジュアルノベル');
  const roles = await searchConditionEntities('主', metadata.roleTargets.people, context, signal);
  expect(roles.map((item) => item.id)).toEqual([role, roleTwin]);
  expect(roles[0]!.title).toContain('主角');
  expect(roles[0]!.title).not.toBe(roles[1]!.title);
  expect(calls[0]!.searchParams.getAll('language')).toEqual(['zh-Hant', 'ja']);
  expect(calls[0]!.searchParams.get('release')).toBe('current-release');
  let selection = editCharacterPersonSelection({ works: [], role: '' }, { kind: 'work', id: works[1]!.id });
  selection = editCharacterPersonSelection(selection, { kind: 'role', id: roles[0]!.id });
  const parsed = parseCharacterPersonSearch(
    { mode: 'people', work: selection.works, role: selection.role, language: ['zh-Hant', 'ja'] },
    'ja',
  );
  expect(characterPersonRequest(parsed.search).filter).toMatchObject({
    and: [
      { type: { in: ['schema:Person'] } },
      {
        statement: {
          property: 'wdt:P725',
          inverse: true,
          in: [secondWork],
          qualifiers: [{ property: 'wdt:P3831', in: [role] }],
        },
      },
    ],
  });
  const hit = {
    key: { owner: 'semantic', kind: 'schema:Person', route: 160, id: role },
    summary: {
      kind: 'subject',
      value: {
        id: role,
        type: 'schema:Person',
        types: ['schema:Person'],
        label: { value: '声優', language: 'ja' },
        creativeWork: false,
        cover: null,
      },
    },
    labels: { ja: '声優' },
  };
  const page = parseDiscoveryPage({
    hits: [hit],
    kinds: { values: [], next: null },
    next: null,
    as_of: '2026-11-04T00:00:00.000Z',
  })!;
  expect(page.hits).toHaveLength(1);
  const html = renderToStaticMarkup(
    createElement(DiscoveryResults, { locale: 'ja', state: { status: 'ready', page } }),
  );
  expect(html).toContain('声優');
  expect(html).toContain(role);
  expect(html).toContain('href=');
  expect(editCharacterPersonSelection(selection, { kind: 'remove-work', index: 0 })).toEqual({ works: [], role: '' });
  expect(editCharacterPersonSelection(selection, { kind: 'work', id: work }).role).toBe('');
});

test('shared operands keep exact identities through renamed or missing labels; abort and refusal cannot supply choices', async () => {
  const context = { locale: 'ja', release: 'current-release', available: true };
  const calls: URL[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input), 'https://rezics.test');
    calls.push(url);
    const id = url.searchParams.get('id');
    return Response.json(
      id === work
        ? { state: 'ready', id, labels: { ja: '改題' }, type: 'schema:Book', typeLabels: { ja: '本' } }
        : { state: 'withheld', id },
    );
  }) as typeof fetch;
  const labels = await resolveConditionEntityLabels(
    [work, secondWork, 'malformed'],
    ['schema:Book'],
    context,
    new AbortController().signal,
  );
  expect(labels.labels[work]?.label).toBe('改題');
  expect(labels.withheld).toEqual([secondWork]);
  expect(calls.every((url) => url.searchParams.has('id') && !url.searchParams.has('q'))).toBe(true);
  const parsed = parseCharacterPersonSearch({ work: [work, secondWork] }, 'ja');
  expect(
    JSON.parse(new URL(characterPersonHref('ja', parsed.search), 'https://rezics.test').searchParams.get('work')!),
  ).toEqual([work, secondWork]);
  let complete!: (value: Response) => void;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      complete = resolve;
    })) as typeof fetch;
  const controller = new AbortController();
  const pending = searchConditionEntities('同', ['schema:Book'], context, controller.signal);
  controller.abort();
  complete(Response.json({ subjects: [], types: {}, as_of: '2026-11-04T00:00:00.000Z' }));
  await expect(pending).rejects.toThrow();
  let reads = 0;
  globalThis.fetch = (async () => {
    reads++;
    return Response.json({ code: 'forbidden' }, { status: 403 });
  }) as typeof fetch;
  await expect(
    searchConditionEntities('同', ['schema:Book'], context, new AbortController().signal),
  ).rejects.toMatchObject({ failure: 'credentials' });
  expect(reads).toBe(1); // No anonymous or Global fallback.
  globalThis.fetch = (async () => Response.json({ code: 'semantic_not_ready' }, { status: 503 })) as typeof fetch;
  await expect(
    searchConditionEntities('同', ['schema:Book'], context, new AbortController().signal),
  ).rejects.toMatchObject({ failure: 'preparing' });
  await expect(
    searchConditionEntities('同', ['schema:Book'], { ...context, available: false }, new AbortController().signal),
  ).rejects.toBeInstanceOf(ConditionEntityLookupError);
});
