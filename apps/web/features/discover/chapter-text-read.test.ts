import { expect, test } from 'bun:test';
import { chapterProgress, readChapterText } from './chapter-text-read.ts';
import { emptyBrowse } from './browse-state.ts';
import type { MainClient } from './types.ts';
import type { SearchHit, SearchResultPage } from '../search/types.ts';

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
  const read = await readChapterText(main, { ...emptyBrowse, q: '"lanternroad"', cursor: 'resource-next-page' }, 'en');
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

test('chapter text makes no request without text or for empty explicit quotes', async () => {
  const main = { v1: { query: { post() { throw new Error('Unexpected query'); } } } } as unknown as MainClient;
  expect(await readChapterText(main, emptyBrowse, 'en')).toBeNull();
  expect(await readChapterText(main, { ...emptyBrowse, q: '""' }, 'en')).toBeNull();
});

test('chapter progress retains distinct MainVersions sharing Content and suppresses replayed representatives', () => {
  const hit = (mainVersion: string, chapter: string | null, matchUnit = 'shared-content'): SearchHit => ({
    matchUnit, mainVersion, work: `work-${mainVersion}`, types: ['https://schema.org/Book'], title: null,
    cover: null, authors: [], rating: null, tagline: null, completion: null,
    reasons: { language: 'en', field: chapter ? 'body' : 'title', matchedText: null, matchedLanguage: null,
      chapter: chapter ? { title: chapter, href: `/read/${mainVersion}` } : null, realm: null, classification: null },
  });
  const first: SearchResultPage = { total: 3, sequence: '1', indexGeneration: 'index', titles: false,
    hits: [hit('first-main', 'First placement'), hit('title-main', null)],
    next: { queryDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64),
      sourcePosition: { datasetId: 'product', dataEpoch: 'test', sequence: '1' }, indexGeneration: 'index',
      nextOffset: 2, expiresAt: 1 },
  };
  expect(chapterProgress([first])).toMatchObject({ checked: 2, complete: false });
  const progress = chapterProgress([first, { ...first, next: null,
    hits: [hit('first-main', 'First placement', 'replayed-unit'), hit('second-main', 'Second placement')] }]);
  expect(progress.hits.map(result => result.mainVersion)).toEqual(['first-main', 'second-main']);
  expect(progress.hits.map(result => result.reasons.chapter?.href)).toEqual(['/read/first-main', '/read/second-main']);
  expect(progress).toMatchObject({ checked: 3, total: 3, complete: true });
});
