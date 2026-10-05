import { expect, test } from 'bun:test';
import { readChapterText } from './chapter-text-read.ts';
import { emptyBrowse } from './browse-state.ts';
import type { MainClient } from './types.ts';

test('chapter text uses the Work phrase contract and an independent bounded first page', async () => {
  let request: unknown;
  const book = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const post = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
  const main = { v1: { query: { async post(input: unknown) {
    request = input;
    return { error: null, data: { result: { profile: 'public-main-phrase-page-v1',
      total: 1, population: 1, sourcePosition: { sequence: '1' }, indexGeneration: 'index', next: null,
      results: [{ matchUnit: 'unit', work: book, mainVersion: book, types: ['https://schema.org/Book'],
        language: 'en', matchedField: 'body', title: { value: 'The Lantern Road', language: 'en' },
        matchedChapter: { post, book, title: 'At the harbour' } }],
    } } };
  } }, resources: { summaries: { async post() { return { error: null, data: { summaries: [] } }; } } } } } as unknown as MainClient;
  const read = await readChapterText(main, { ...emptyBrowse, q: 'lanternroad', cursor: 'resource-next-page' }, 'en');
  expect(request).toMatchObject({ context: 'global', scope: { kind: 'all' }, text: { phrase: 'lanternroad' },
    sort: 'relevance', page: { size: 10 } });
  expect((request as { page: unknown }).page).toEqual({ size: 10 });
  expect(read?.ok).toBe(true);
  if (read?.ok) {
    expect(read.page.hits[0]?.title?.value).toBe('The Lantern Road');
    expect(read.page.hits[0]?.reasons.chapter).toMatchObject({ title: 'At the harbour' });
    expect(read.page.hits[0]?.reasons.chapter?.href).toContain(`/read/${post.slice(-36)}?language=en`);
  }
});

test('chapter text makes no request without a phrase or below the Work phrase bound', async () => {
  const main = { v1: { query: { post() { throw new Error('Unexpected query'); } } } } as unknown as MainClient;
  expect(await readChapterText(main, emptyBrowse, 'en')).toBeNull();
  expect(await readChapterText(main, { ...emptyBrowse, q: 'a' }, 'en')).toBeNull();
});
