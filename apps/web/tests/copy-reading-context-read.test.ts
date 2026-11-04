import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadCopiesPage } from '../src/library/copies-read';
import { presentCopyListContext, copyListContextFromNativeRow } from '../src/library/copy-reading-context/read';

const id = (tail: string) => `019a1b2c-3d4e-7f00-8a00-${tail.padStart(12, '0')}`;
const subjectId = id('90');
const workId = id('91');
const authorId = id('92');
const facts = {
  'schema:author': [{ kind: 'item', id: authorId, labels: { en: 'A. Writer' } }],
  'schema:datePublished': [{ kind: 'time', year: 1986, month: 4 }],
};
const nativeCopy = (number: number, context: object) => ({
  id: id(String(number)),
  subjectId,
  kind: 'print',
  status: 'shelf',
  revision: number,
  location: `Shelf ${number}`,
  source: 'Bookshop',
  acquiredOn: '2024-03-01',
  disposedOn: null,
  note: `Note ${number}`,
  subject: {
    id: subjectId,
    type: 'schema:Book',
    types: ['schema:Book'],
    label: { value: 'A book', language: 'en' },
    cover: null,
  },
  context,
});

test('FULL page context stays per copy, preserves qualified facts, and performs no Subject hydration', async () => {
  const calls: URL[] = [];
  const body = {
    copies: [
      nativeCopy(1, { state: 'available', work: [{ id: workId, labels: { en: 'Shared work' } }], facts }),
      nativeCopy(2, { state: 'unsupported', facts }),
    ],
    next: null,
    filterOptions: { kinds: [], statuses: [] },
  };
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input) => {
      calls.push(new URL(input instanceof Request ? input.url : String(input)));
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const page = await loadCopiesPage(
    client,
    new Request('https://site.test/en/library/copies', { headers: { authorization: 'Bearer owner' } }),
    {},
    {},
  );
  expect(calls.map((url) => url.pathname)).toEqual(['/v1/copies']);
  expect(calls[0]?.searchParams.get('view')).toBe('FULL');
  expect(page.copies.map(({ id: copyId, revision, kind, status }) => [copyId, revision, kind, status])).toEqual([
    [id('1'), 1, 'print', 'shelf'],
    [id('2'), 2, 'print', 'shelf'],
  ]);
  expect(new Set(page.copies.map((copy) => copy.idempotencyKey)).size).toBe(2);

  const release = {
    properties: {
      'schema:author': { datatype: 'wikibase-item', labels: { en: 'Author' }, relation: { group: 'credit' } },
      'schema:datePublished': { datatype: 'time', labels: { en: 'Publication date' } },
    },
  };
  const contexts = page.copies.map((copy) =>
    presentCopyListContext(copy.nativeReadingContext!, release, 'en'),
  );
  expect(contexts[0]).toMatchObject({ state: 'available', work: [{ id: workId, label: 'Shared work' }] });
  expect(contexts[1]).toMatchObject({ state: 'unsupported' });
  expect(contexts[1]?.state === 'unsupported' && contexts[1].facts).toContainEqual(
    expect.objectContaining({
      property: 'schema:author',
      label: 'Author',
      text: 'A. Writer',
      subject: expect.objectContaining({ id: authorId }),
    }),
  );
  expect(contexts[1]?.state === 'unsupported' && contexts[1].facts).toContainEqual(
    expect.objectContaining({ property: 'schema:datePublished', label: 'Publication date', text: 'April 1986' }),
  );
});

test('hidden native states with extra nested data fail closed without retaining IDs', () => {
  expect(copyListContextFromNativeRow({ context: { state: 'withheld', work: [{ id: workId }] } })).toEqual({
    state: 'unavailable',
  });
  expect(copyListContextFromNativeRow({})).toEqual({ state: 'unavailable' });
});
