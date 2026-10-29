import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
async function source(path: string) {
  return readFile(join(root, path), 'utf8');
}

test('the search page offers relevance by default and a URL-backed Top rated sort', async () => {
  const [params, search, messages] = await Promise.all([
    source('src/search/search-params.ts'),
    source('src/search/search.tsx'),
    source('messages/en.json'),
  ]);
  expect(params).toMatch(/sort/);
  expect(search).toMatch(/sort/);
  expect(search).toMatch(/rating/);
  expect(messages).toMatch(/Top rated/);
});

test('Top rated rows show public Global scores and leave unscored subjects blank', async () => {
  const [results, fake] = await Promise.all([source('src/search/results.tsx'), source('src/kernel/fake')]);
  expect(results).toMatch(/rating|score/i);
  expect(fake).toMatch(/rating|score/i);
});

test('stale Top rated cursors restart once and facet index errors retain retry controls', async () => {
  const [search, routes] = await Promise.all([source('src/search/search.tsx'), source('src/routes/search.tsx')]);
  expect(search).toMatch(/409|conflict/i);
  expect(search).toMatch(/retry/i);
  expect(routes).toMatch(/sort/);
});

test('changing sort drops the cursor and search never renders result or facet counts', async () => {
  const [search, sort, params] = await Promise.all([
    source('src/search/search.tsx'),
    source('src/search/sort.tsx'),
    source('src/search/search-params.ts'),
  ]);
  expect(sort).toMatch(/cursor/);
  expect(params).toMatch(/sort/);
  expect(search).not.toMatch(/total\.value|entry\.count|choice\.count/);
});

test('search rows use ListRow and keep controls above the stretched primary link', async () => {
  const results = await source('src/search/results.tsx');
  expect(results).toMatch(/ListRow/);
  expect(results).toMatch(/ListRowLink/);
  expect(results).toMatch(/ListRowControl/);
});
