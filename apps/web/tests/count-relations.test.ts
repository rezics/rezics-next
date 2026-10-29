import { expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { countFromLinks, formatCount, sumCounts } from '../src/features/count';

const sourceRoot = join(import.meta.dir, '..', 'src');

test('one formatter renders exact and lower-bound semantic counts in every locale', () => {
  for (const locale of ['en', 'ja', 'zh-Hant', 'es', 'fr', 'de', 'pt-BR', 'ko']) {
    expect(formatCount({ value: 1234, relation: 'exact' }, locale)).toBe(new Intl.NumberFormat(locale).format(1234));
    expect(formatCount({ value: 1234, relation: 'lower_bound' }, locale)).toBe(
      `${new Intl.NumberFormat(locale).format(1234)}+`,
    );
    expect(formatCount(undefined, locale)).toBe('');
  }
});

test('semantic link counts preserve exactness and raise the value to returned items', () => {
  expect(countFromLinks({ value: 2, exact: true }, 4)).toEqual({ value: 4, relation: 'exact' });
  expect(countFromLinks({ value: 7, exact: false }, 4)).toEqual({ value: 7, relation: 'lower_bound' });
  expect(countFromLinks(undefined, 4)).toBeUndefined();
});

test('sums require a count for every part and are exact only when all parts are exact', () => {
  expect(
    sumCounts([
      { value: 2, relation: 'exact' },
      { value: 3, relation: 'exact' },
    ]),
  ).toEqual({
    value: 5,
    relation: 'exact',
  });
  expect(
    sumCounts([
      { value: 2, relation: 'exact' },
      { value: 3, relation: 'lower_bound' },
    ]),
  ).toEqual({
    value: 5,
    relation: 'lower_bound',
  });
  expect(sumCounts([{ value: 2, relation: 'exact' }, undefined])).toBeUndefined();
});

test('home sections and subject tabs do not display counts from search previews', async () => {
  const [data, views, tabs, search] = await Promise.all(
    ['features/pages/data.tsx', 'features/pages/views.ts', 'features/pages/view-tabs.tsx', 'search/search.tsx'].map(
      (file) => readFile(join(sourceRoot, file), 'utf8'),
    ),
  );
  expect(data).not.toContain('home_section_count');
  expect(data).not.toMatch(/read\.total/);
  expect(views).not.toMatch(/read\.kind === 'search'[\s\S]{0,500}?count:/);
  expect(tabs).not.toMatch(/countText/);
  expect(search).not.toMatch(/\.sort\(/);
});

test('search results and facet choices do not render totals or facet counts', async () => {
  const search = await readFile(join(sourceRoot, 'search/search.tsx'), 'utf8');
  expect(search).not.toMatch(/total\s*:/);
  expect(search).not.toMatch(/\.count\b/);
  expect(search).not.toMatch(/relation\s*:/);
  const messagesRoot = join(import.meta.dir, '..', 'messages');
  const messages = await Promise.all(
    (await readdir(messagesRoot)).map((file) => readFile(join(messagesRoot, file), 'utf8')),
  );
  expect(messages.every((content) => !Object.hasOwn(JSON.parse(content), 'home_section_count'))).toBe(true);
});

test('plus signs for counts are constructed only by the shared formatter', async () => {
  async function files(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? files(path) : entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name) ? [path] : [];
      }),
    );
    return nested.flat();
  }
  const sources = await files(sourceRoot);
  const suffixes = await Promise.all(sources.map(async (file) => ({ file, text: await readFile(file, 'utf8') })));
  const plusBuilders = suffixes.filter(({ text }) => /\$\{[^}]+\}\s*\+\s*['"`]/.test(text));
  expect(plusBuilders.map(({ file }) => file)).toEqual([join(sourceRoot, 'features/count.ts')]);
});
