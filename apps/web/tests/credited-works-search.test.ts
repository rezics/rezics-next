import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as v from 'valibot';
import { DiscoveryResults } from '../src/search/discovery-results';
import {
  characterPersonHref,
  characterPersonRequest,
  parseCharacterPersonSearch,
} from '../src/search/character-person';
import { editCharacterPersonSelection } from '../src/search/character-person-selection/model';
import { parseDiscoveryPage } from '../src/search/discovery';
import { queryShareUrl } from '../src/search/query-share';
import { subjectVisitReturn, subjectVisitReturnHref } from '../src/features/pages/subject-visit-navigation';

const work = '018f0000-0000-7000-8000-00a000000001';
const role = '018f0000-0000-7000-8000-00a000000003';
const person = '018f0000-0000-7000-8000-00a000000005';

/** Same grammar as search_.characters validateSearch plus loaderDeps parseCharacterPersonSearch. */
function installedSearch(href: string): Record<string, unknown> {
  const url = new URL(href, 'https://rezics.test');
  const raw: Record<string, unknown> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    raw[key] = values.length > 1 ? values : values[0];
  }
  return v.parse(v.objectWithRest({}, v.unknown()), raw);
}

test('credited-name requests carry the role on one credit and refine selected kind counts', () => {
  const parsed = parseCharacterPersonSearch(
    { mode: 'works', name: 'Aki', role, work: [work], kinds: ['schema:Book', 'wd:Q123'] },
    'en',
  );
  expect(parsed.error).toBeUndefined();
  expect(parsed.search).toMatchObject({
    mode: 'works',
    name: 'Aki',
    works: [],
    role,
    kinds: ['schema:Book', 'wd:Q123'],
  });
  expect(parsed.form.works).toBe('');
  expect(characterPersonRequest(parsed.search)).toMatchObject({
    representation: 'discovery-v1',
    limit: 20,
    descriptions: true,
    languages: ['en'],
    spoilerThreshold: 0,
    sort: 'name',
    kindPage: { limit: 8 },
    textField: 'credited_creator',
    text: 'Aki',
    filter: { and: [{ kind: { in: ['schema:Book', 'wd:Q123'] } }] },
    kindCountLeaf: 0,
    creditQualifiers: [{ property: 'wdt:P3831', value: role }],
  });
  const unqualified = characterPersonRequest(parseCharacterPersonSearch({ mode: 'works', name: 'Aki' }, 'en').search);
  expect(unqualified).not.toHaveProperty('creditQualifiers');
  expect(unqualified).not.toHaveProperty('filter');
  expect(parseCharacterPersonSearch({ mode: 'works', name: '  ' }, 'en').error).toBe('invalid_input');
  expect(parseCharacterPersonSearch({ name: 'Aki', role }, 'en').error).toBe('role_requires_work');
  expect(editCharacterPersonSelection({ works: [], role: '' }, { kind: 'role', id: role })).toEqual({
    works: [],
    role: '',
  });
  expect(editCharacterPersonSelection({ works: [], role: '' }, { kind: 'role', id: role }, 'works')).toEqual({
    works: [],
    role,
  });
});

test('a credited work shows the matched name, language and role, and links the credited Person', () => {
  const creditedHit = {
    key: { owner: 'semantic', kind: 'schema:CreativeWork', route: 160, id: work },
    summary: {
      kind: 'subject',
      value: {
        id: work,
        type: 'schema:CreativeWork',
        types: ['schema:CreativeWork'],
        label: { language: 'ja', value: '作品' },
        creativeWork: true,
        cover: null,
      },
    },
    labels: { ja: '作品' },
    creditMatch: {
      statementId: 'statement-one',
      property: 'wdt:P725',
      targetId: person,
      name: { language: 'ja', value: '別名' },
      qualifiers: [{ property: 'wdt:P3831', value: role }],
    },
  };
  const plainHit = { key: creditedHit.key, summary: creditedHit.summary, labels: creditedHit.labels };
  const render = (hits: unknown[], roles?: Record<string, { label: string }>) => {
    const page = parseDiscoveryPage({
      hits,
      kinds: { values: [], next: null },
      next: null,
      as_of: '2026-11-04T00:00:00.000Z',
    })!;
    const html = renderToStaticMarkup(
      createElement(DiscoveryResults, { locale: 'en', state: { status: 'ready', page }, creditRoleLabels: roles }),
    );
    return { page, text: html.replaceAll('<!-- -->', ''), html };
  };

  const { page, text, html } = render([creditedHit], { [role]: { label: 'Lead' } });
  expect(page.hits[0]).toMatchObject({ creditMatch: { targetId: person, name: { value: '別名' } } });
  expect(html).toContain(`href="/en/subjects/${work}/`);
  expect(html).toContain(`href="/en/subjects/${person}/`);
  expect(text).toContain('Credited as');
  expect(text).toContain('別名');
  expect(text).toContain('(ja)');
  expect(text).toContain('Role: Lead');
  expect(render([creditedHit]).text).toContain(`Role: ${role}`);
  const plain = render([plainHit]).text;
  expect(plain).toContain('作品');
  expect(plain).not.toContain('Credited as');
});

test('credited share links reopen works mode and subject visits return to the executed query', () => {
  const parameters = new URLSearchParams({
    mode: 'works',
    name: 'Aki',
    role,
    threshold: '1',
    sort: 'relevance',
  });
  parameters.append('language', 'ja');
  parameters.append('language', 'en');
  parameters.append('kinds', 'schema:Book');
  parameters.append('kinds', 'wd:Q123');
  const share = {
    viewer: 'signed-in' as const,
    action: 'allowed' as const,
    reason: 'ready' as const,
    document: {
      text: 'Aki',
      filter: null,
      languages: ['ja', 'en'],
      sort: 'relevance',
      textField: 'credited_creator' as const,
      creditQualifiers: [{ property: 'wdt:P3831', value: role }],
      spoilerThreshold: 1,
    },
    parameters: parameters.toString(),
    selections: [],
  };
  const shared = new URL(queryShareUrl('https://rezics.test', 'ja', share)!);
  expect(shared.pathname).toBe('/ja/search/characters');
  const replay = parseCharacterPersonSearch(
    {
      mode: shared.searchParams.get('mode'),
      name: shared.searchParams.get('name'),
      role: shared.searchParams.get('role'),
      threshold: shared.searchParams.get('threshold'),
      sort: shared.searchParams.get('sort'),
      language: shared.searchParams.getAll('language'),
      kinds: shared.searchParams.getAll('kinds'),
    },
    'ja',
  );
  expect(replay.error).toBeUndefined();
  expect(replay.search).toMatchObject({ mode: 'works', name: 'Aki', role, threshold: 1, sort: 'relevance' });
  expect(replay.search.kinds).toEqual(['schema:Book', 'wd:Q123']);
  expect(replay.search.languages).toEqual(['ja', 'en']);

  const executed = characterPersonHref('ja', { ...replay.search, cursor: 'page-two' }, 'page-two');
  const executedUrl = new URL(executed, 'https://rezics.test');
  expect(executedUrl.searchParams.getAll('language')).toEqual(['ja', 'en']);
  expect(executedUrl.searchParams.get('language')).not.toMatch(/^\[/);
  const subject = subjectVisitReturnHref({ id: work, label: 'work' }, 'ja', executed);
  const visit = new URL(subject, 'https://rezics.test');
  expect(visit.pathname).toMatch(new RegExp(`^/ja/subjects/${work}/`));
  expect(visit.searchParams.get('via')).toBe(executed);
  expect(subjectVisitReturn(visit.searchParams.get('via'), 'ja')).toBe(executed);
});

test('a credited ja/en query emits repeated languages and returns through the installed route', () => {
  const parsed = parseCharacterPersonSearch(
    {
      mode: 'works',
      name: 'Mika',
      role,
      language: ['ja', 'en'],
      kinds: ['schema:Book', 'wd:Q123'],
      sort: 'relevance',
      threshold: '1',
    },
    'en',
  );
  expect(parsed.error).toBeUndefined();
  const executed = characterPersonHref('ja', { ...parsed.search, cursor: 'page-two' }, 'page-two');
  const url = new URL(executed, 'https://rezics.test');
  expect(url.pathname).toBe('/ja/search/characters');
  expect(url.searchParams.getAll('language')).toEqual(['ja', 'en']);
  expect(url.searchParams.get('language')).not.toMatch(/^\[/);
  expect(url.searchParams.get('role')).toBe(role);
  expect(url.searchParams.getAll('kinds')).toEqual(['schema:Book', 'wd:Q123']);
  expect(url.searchParams.get('sort')).toBe('relevance');
  expect(url.searchParams.get('cursor')).toBe('page-two');
  const admitted = parseCharacterPersonSearch(installedSearch(executed), 'ja');
  expect(admitted.error).toBeUndefined();
  expect(admitted.search).toMatchObject({
    mode: 'works',
    name: 'Mika',
    role,
    languages: ['ja', 'en'],
    kinds: ['schema:Book', 'wd:Q123'],
    sort: 'relevance',
    threshold: 1,
    cursor: 'page-two',
  });

  const page = parseDiscoveryPage({
    hits: [
      {
        key: { owner: 'semantic', kind: 'schema:CreativeWork', route: 160, id: work },
        summary: {
          kind: 'subject',
          value: {
            id: work,
            type: 'schema:CreativeWork',
            types: ['schema:CreativeWork'],
            label: { language: 'ja', value: '作品' },
            creativeWork: true,
            cover: null,
          },
        },
        labels: { ja: '作品' },
      },
    ],
    kinds: { values: [], next: null },
    next: null,
    as_of: '2026-11-04T00:00:00.000Z',
  })!;
  const destination = subjectVisitReturnHref({ id: work, label: '作品' }, 'ja', executed);
  const html = renderToStaticMarkup(
    createElement(DiscoveryResults, {
      locale: 'ja',
      state: { status: 'ready', page },
      subjectHrefFor: (subject) => subjectVisitReturnHref(subject, 'ja', executed),
    }),
  );
  expect(html).toContain(destination.replaceAll('&', '&amp;'));
  const visit = new URL(destination, 'https://rezics.test');
  expect(visit.searchParams.get('via')).toBe(executed);
  expect(subjectVisitReturn(visit.searchParams.get('via'), 'ja')).toBe(executed);
  const returned = parseCharacterPersonSearch(installedSearch(visit.searchParams.get('via')!), 'ja');
  expect(returned.error).toBeUndefined();
  expect(returned.search).toEqual(admitted.search);
});
