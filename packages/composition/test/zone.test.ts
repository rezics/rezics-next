import { expect, test } from 'bun:test';
import { MAX_ZONE_PAGES, MAX_ZONE_SCOPE, UI_LOCALES, platformRegistry, validateZoneStarter } from '../src/index.ts';

const node = (type: string, id: string, props: Record<string, unknown> = {}) => ({ type, props: { id, ...props } });
const page = (...content: ReturnType<typeof node>[]) => ({ root: { props: {} }, content });
const labels = Object.fromEntries(UI_LOCALES.map((locale) => [locale, `Books (${locale})`]));
const home = { route: '', document: page(node('Heading', 'home', { text: 'Books', level: 2 })) };
const starter = (overrides: Record<string, unknown> = {}) => ({
  labels,
  pages: [home, { route: 'new/releases', document: page(node('Text', 'new', { text: 'New' })) }],
  scope: ['books/fiction'],
  ...overrides,
});
const filters = new Set(['books/fiction', 'books/poetry']);
const check = (value: unknown) => validateZoneStarter(platformRegistry, value, { filters });

test('a zone starter is labels, at most sixteen pages and a saved-filter scope', () => {
  expect(UI_LOCALES).toEqual(['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']);
  expect([MAX_ZONE_PAGES, MAX_ZONE_SCOPE]).toEqual([16, 16]);
  expect(check(starter())).toEqual([]);
  expect(check(starter({ pages: [home], scope: [] }))).toEqual([]);
  const sixteen = [home, ...Array.from({ length: 15 }, (_, i) => ({ route: `p${i + 10}`, document: page() }))];
  expect(check(starter({ pages: sixteen, scope: ['books/fiction', 'books/poetry'] }))).toEqual([]);
});

test('zone starter violations are reported at their pointers', () => {
  const { de: _de, ...withoutGerman } = labels;
  const value = starter({
    labels: { ...withoutGerman, ja: '<b>本</b>', xx: 'X' },
    pages: [
      { route: 'new/releases', document: page(node('Text', 'a', { text: 'A' })) },
      { route: '', document: page(node('Heading', 'b', { text: '<b>x</b>', level: 2 })) },
      { route: '/absolute', document: page() },
      { route: '/absolute', document: page(), extra: true },
    ],
    scope: ['books/fiction', 'books/fiction', 'books/unknown', 7],
  });
  expect(check(value)).toEqual([
    { pointer: '/labels/de', code: 'invalid' },
    { pointer: '/labels/ja', code: 'unsafe' },
    { pointer: '/labels/xx', code: 'invalid' },
    { pointer: '/pages/1/document/content/0/props/text', code: 'unsafe' },
    { pointer: '/pages/1/route', code: 'invalid' },
    { pointer: '/pages/2/route', code: 'invalid' },
    { pointer: '/pages/3', code: 'invalid' },
    { pointer: '/scope/1', code: 'duplicate' },
    { pointer: '/scope/2', code: 'invalid' },
    { pointer: '/scope/3', code: 'invalid' },
  ]);
  expect(
    check(
      starter({
        pages: [
          { route: 'a', document: page() },
          { route: 'a', document: page() },
        ],
      }),
    ),
  ).toEqual([
    { pointer: '/pages', code: 'invalid' },
    { pointer: '/pages/1/route', code: 'duplicate' },
  ]);
  expect(check(starter({ labels: { ...labels, en: '' } }))).toEqual([{ pointer: '/labels/en', code: 'invalid' }]);
  expect(check(value)).toEqual(check(structuredClone(value)));
});

test('oversized and malformed starters are refused before their parts', () => {
  const pages = Array.from({ length: MAX_ZONE_PAGES + 1 }, (_, i) => ({ route: i ? `p${i + 10}` : '', document: 1 }));
  expect(check(starter({ pages }))).toEqual([{ pointer: '/pages', code: 'limit' }]);
  const scope = Array.from({ length: MAX_ZONE_SCOPE + 1 }, () => 'unknown/id');
  expect(check(starter({ scope }))).toEqual([{ pointer: '/scope', code: 'limit' }]);
  for (const value of ['zone', null, [], 1]) expect(check(value)).toEqual([{ pointer: '', code: 'invalid' }]);
  const { scope: _scope, ...withoutScope } = starter();
  expect(check({ ...withoutScope, extra: 1 })).toEqual([
    { pointer: '/extra', code: 'invalid' },
    { pointer: '/scope', code: 'invalid' },
  ]);
  expect(check(starter({ labels: [], pages: {}, scope: 'books/fiction' }))).toEqual([
    { pointer: '/labels', code: 'invalid' },
    { pointer: '/pages', code: 'invalid' },
    { pointer: '/scope', code: 'invalid' },
  ]);
});
