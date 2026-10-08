import { afterAll, expect, mock, test } from 'bun:test';

const originalHeaders = { ...(await import('next/headers')) };
const originalHref = { ...(await import('../entity-page/href.ts')) };

type Query = Record<string, unknown>;
type PageAnswer = { data: unknown; error: { status: number } | null };
let answer: (query: Query) => Promise<PageAnswer> = async () => ({ data: null, error: null });

await mock.module('next/headers', () => ({
  ...originalHeaders,
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
await mock.module('../entity-page/href.ts', () => ({
  ...originalHref,
  followHref: (_main: unknown, _href: string, query: Query) => () => answer(query),
}));
afterAll(async () => {
  await mock.module('next/headers', () => originalHeaders);
  await mock.module('../entity-page/href.ts', () => originalHref);
});

const { readRecipeWorkPage } = await import('./read.ts');

const href = '/v1/recipes/works/00000000-0000-4000-8000-0000000000aa';
const first = {
  occurrences: [{ occurrence: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001' }],
  ingredients: [], measures: [], next: 'later',
};

test('a thrown first page is the recipe region unavailable, and does not reject the Work page', async () => {
  answer = () => Promise.reject(new Error('network'));
  await expect(readRecipeWorkPage(href)).resolves.toEqual({ ok: false, failure: 'unavailable' });
});

test('a thrown later page keeps the first page and the cursor to continue', async () => {
  let calls = 0;
  answer = query => {
    calls += 1;
    if (query.cursor) return Promise.reject(new Error('network'));
    return Promise.resolve({ data: first, error: null });
  };
  const result = await readRecipeWorkPage(href);
  expect(result.ok).toBe(true);
  if (!result.ok || !result.data) return;
  expect(result.data.next).toBe('later');
  expect(result.data.occurrences.map(item => item.occurrence)).toEqual([first.occurrences[0]!.occurrence]);
  expect(calls).toBe(2);
});
