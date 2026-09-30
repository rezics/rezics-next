import { expect, test } from 'bun:test';
import { auditCatalogs, catalogIssues, discoverCatalogs, flatten } from './check.ts';

const insert = (pattern: string) => ({
  $nativeI18n: 1 as const,
  op: 'insert',
  pattern,
  bindings: {},
});

const english = {
  title: 'Hello',
  count: insert('{{count}} items'),
};

test('fails when a translated key is deleted', () => {
  expect(catalogIssues({ en: english, 'zh-Hant': { count: insert('{{count}} 項') } })).toContain(
    'zh-Hant missing title',
  );
});

test('fails when a translation adds a key', () => {
  expect(
    catalogIssues({
      en: english,
      'zh-Hant': { ...english, extra: '多餘' },
    }),
  ).toContain('zh-Hant extra extra');
});

test('fails when a translation is empty', () => {
  expect(
    catalogIssues({
      en: english,
      'zh-Hant': { title: '  ', count: insert('{{count}} 項') },
    }),
  ).toContain('zh-Hant empty title');
});

test('fails when a placeholder is renamed', () => {
  expect(
    catalogIssues({
      en: english,
      'zh-Hant': { title: '你好', count: insert('{{total}} 項') },
    }),
  ).toContain('zh-Hant placeholder mismatch count');
});

test('fails when a placeholder sits outside insert()', () => {
  expect(
    catalogIssues({
      en: { title: 'Hello' },
      'zh-Hant': { title: '你好 {{name}}' },
    }),
  ).toContain('zh-Hant contains a placeholder outside insert() title');
});

test('fails when the English catalog has no keys', () => {
  expect(catalogIssues({ en: {}, 'zh-Hant': { title: '你好' } })).toContain(
    'english catalog has no keys',
  );
});

test('fails when a feature catalog is not in any other locale', () => {
  expect(catalogIssues({ en: { title: 'Hello' } }, undefined, true)).toContain(
    'english catalog is not in any other locale',
  );
});

test('fails when a resolved locale falls back to English for a key the catalog translates', () => {
  expect(
    catalogIssues(
      { en: english, 'zh-Hant': { title: '你好', count: insert('{{count}} 項') } },
      { 'zh-Hant': english },
    ),
  ).toContain('zh-Hant falls back to English for title');
});

test('accepts a complete locale, including plural inserts', () => {
  const count = {
    $nativeI18n: 1 as const,
    op: 'plural',
    cases: { one: insert('{{count}} item'), other: insert('{{count}} items') },
    value: 'count',
  };
  expect(
    catalogIssues({
      en: { title: 'Hello', count },
      'zh-Hant': {
        title: '你好',
        count: { ...count, cases: { one: insert('{{count}} 項'), other: insert('{{count}} 項') } },
      },
    }),
  ).toEqual([]);
  expect([...flatten(count).values()][0]?.names).toEqual(['count']);
});

test('discovers real catalogs and serves translations the locale files already contain', async () => {
  const catalogs = await discoverCatalogs();
  const byId = new Map(catalogs.map((catalog) => [catalog.id, catalog]));
  expect(byId.get('web/communities')?.loadError).toBeUndefined();
  expect(flatten(byId.get('web/communities')?.locales.en).size).toBeGreaterThan(50);
  expect(flatten(byId.get('web/post-composer')?.locales.en).size).toBeGreaterThan(20);
  expect(flatten(byId.get('accounts/account')?.locales.en).size).toBeGreaterThan(300);
  expect(flatten(byId.get('zone/fiction')?.locales.en).size).toBeGreaterThan(0);
  expect(flatten(byId.get('ui/copy')?.locales.en).size).toBeGreaterThan(10);
  expect(byId.has('web/search/typeahead-messages')).toBe(true);
  expect(byId.has('web/work-page/editions')).toBe(true);

  for (const id of ['web/work-page', 'web/settings', 'web/search', 'web/discover'] as const) {
    const catalog = byId.get(id);
    expect(catalog, id).toBeDefined();
    const unwired = catalogIssues(catalog!.locales, catalog!.resolved).filter((issue) =>
      issue.includes('falls back to English'),
    );
    expect(unwired, id).toEqual([]);
  }

  const complete = ['ui/copy', 'web/search/typeahead-messages', 'web/work-page/editions'] as const;
  for (const id of complete) {
    expect(catalogIssues(byId.get(id)!.locales, undefined, true), id).toEqual([]);
  }
  // The live tree still has gaps G-502 and G-503 fill. Wiring must already hold for every catalog.
  for (const catalog of catalogs) {
    if (catalog.loadError) continue;
    const unwired = catalogIssues(catalog.locales, catalog.resolved).filter((issue) =>
      issue.includes('falls back to English'),
    );
    expect(unwired, catalog.id).toEqual([]);
  }
});

test('the repository audit does not hide a gap inside an English merge', async () => {
  const issues = await auditCatalogs();
  // Empty strings stay visible. Missing keys, extras, placeholders and unwired locales do not hide in a merge.
  expect(issues.filter((issue) => !issue.includes(' empty '))).toEqual([]);
});
