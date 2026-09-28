import { expect, test } from 'bun:test';
import { OpenLibraryImportSearchUnavailable, searchOpenLibraryImport }
  from '../src/modules/library-import/open-library-search.ts';

test('G428: Open Library lookup sends only a bounded fixed-origin ISBN or title query', async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    return Response.json({ docs: [{ key: '/works/OL45804W', title: 'Frankenstein',
      author_name: ['Mary Shelley'], cover_i: 123 },
    { key: '/works/not-a-work', title: 'Invalid' }] });
  }) as typeof fetch;
  expect(await searchOpenLibraryImport({ isbn: '9780141439518' }, fetcher))
    .toEqual([{ workId: 'OL45804W', title: 'Frankenstein', authors: ['Mary Shelley'], coverId: 123 }]);
  expect(new URL(urls[0]!).searchParams.get('q')).toBe('isbn:9780141439518');
  await searchOpenLibraryImport({ title: 'Pride & Prejudice', author: 'Jane Austen' }, fetcher);
  const url = new URL(urls[1]!);
  expect([url.origin, url.searchParams.get('title'), url.searchParams.get('author'),
    url.searchParams.get('limit')]).toEqual(['https://openlibrary.org', 'Pride & Prejudice', 'Jane Austen', '6']);
});

test('G428: catalogue refusal and oversized responses fail without producing candidates', async () => {
  await expect(searchOpenLibraryImport({ title: 'Book' },
    (async () => new Response('', { status: 429 })) as unknown as typeof fetch))
    .rejects.toBeInstanceOf(OpenLibraryImportSearchUnavailable);
  await expect(searchOpenLibraryImport({ title: 'Book' },
    (async () => Response.json({ docs: [{ key: '/works/OL45804W', title: 'B'.repeat(70_000) }] })) as unknown as typeof fetch))
    .rejects.toBeInstanceOf(OpenLibraryImportSearchUnavailable);
  await expect(searchOpenLibraryImport({ title: '' }))
    .rejects.toBeInstanceOf(OpenLibraryImportSearchUnavailable);
});
