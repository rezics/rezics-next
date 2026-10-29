import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readSearchPage } from '../src/search/search-request.ts';

const root = join(import.meta.dir, '..');
async function source(path: string) {
  return readFile(join(root, path), 'utf8');
}

test('the search page offers relevance by default and a URL-backed Top rated sort', async () => {
  const [params, search, queries, sort, messages] = await Promise.all([
    source('src/search/search-params.ts'),
    source('src/search/search.tsx'),
    source('src/search/search-queries.ts'),
    source('src/search/sort.tsx'),
    source('messages/en.json'),
  ]);
  expect(params).toMatch(/sort/);
  expect(search).toMatch(/sort/);
  expect(search).toMatch(/rating/);
  expect(queries).toMatch(/queryKey: \['search', locale, params\]/);
  expect(queries).toMatch(/sort/);
  expect(sort).toMatch(/searchParams\.delete\('cursor'\)/);
  expect(sort).toMatch(/searchParams\.delete\('sort'\)/);
  expect(messages).toMatch(/Top rated/);
});

test('Top rated rows show public Global scores and leave unscored subjects blank', async () => {
  const [results, fake] = await Promise.all([
    source('src/search/results.tsx'),
    source('src/kernel/fake/a-search-rating.ts'),
  ]);
  expect(results).toMatch(/rating|score/i);
  expect(fake).toMatch(/rating|score/i);
});

test('stale Top rated cursors restart once and facet index errors retain retry controls', async () => {
  const [search, routes, request] = await Promise.all([
    source('src/search/search.tsx'),
    source('src/routes/search.tsx'),
    source('src/search/search-request.ts'),
  ]);
  expect(request).toMatch(/status !== 409/);
  expect(request).toMatch(/send\(firstPage\)/);
  expect(search).toMatch(/index_not_ready/);
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
  expect(results).not.toMatch(/ItemGroup|variant="outline"/);
});

test('the rating search read costs one request per page and two after a stale cursor', async () => {
  const relevanceCalls: unknown[] = [];
  await readSearchPage({ text: 'Kokoro' }, async (request) => {
    relevanceCalls.push(request);
    return { status: 200 };
  });
  expect(relevanceCalls).toHaveLength(1);

  const ratingCalls: Record<string, unknown>[] = [];
  const { response, restarted } = await readSearchPage(
    { text: 'Kokoro', sort: 'rating', cursor: 'outdated', filter: { type: { in: ['schema:Book'] } } },
    async (request) => {
      ratingCalls.push(request);
      return { status: ratingCalls.length === 1 ? 409 : 200 };
    },
  );
  expect(response.status).toBe(200);
  expect(restarted).toBe(true);
  expect(ratingCalls).toHaveLength(2);
  expect(ratingCalls[0]).toHaveProperty('cursor', 'outdated');
  expect(ratingCalls[1]).not.toHaveProperty('cursor');
  expect(ratingCalls[1]).toMatchObject({ text: 'Kokoro', sort: 'rating', filter: { type: { in: ['schema:Book'] } } });
});

test('every locale has native sort and stale-cursor copy', async () => {
  for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es']) {
    const messages = JSON.parse(await source(`messages/${locale}.json`)) as Record<string, string>;
    expect(messages.search_sort_rating).toBeTruthy();
    expect(messages.search_sort_relevance).toBeTruthy();
    expect(messages.search_stale_cursor_restarted).toBeTruthy();
  }
});
