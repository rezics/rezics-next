import { expect, test } from 'bun:test';
import { createKernelClient, type KernelClient } from '@rezics/client';
import { loadCopiesPage } from '../src/library/copies-read';
import { presentCopyListContext, copyListContextFromNativeRow } from '../src/library/copy-reading-context/read';

const id = (tail: string) => `019a1b2c-3d4e-7f00-8a00-${tail.padStart(12, '0')}`;
const subjectId = id('90');
const workId = id('91');
const authorId = id('92');
type CopyListResponse = NonNullable<Awaited<ReturnType<KernelClient['copies']['get']>>['data']>;

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
    creativeWork: true,
    cover: null,
  },
  context,
});

test('FULL rows retain Copy identity without Subject hydration while installed context delivery is incomplete', async () => {
  const calls: URL[] = [];
  const body = {
    copies: [
      nativeCopy(1, { state: 'available', work: [{ id: workId, labels: { en: 'Shared work' } }], facts }),
      nativeCopy(2, { state: 'unsupported', facts }),
    ],
    next: null,
  } satisfies CopyListResponse;
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

  expect(page.copies.map(({ location, source, note }) => [location, source, note])).toEqual([
    ['Shelf 1', 'Bookshop', 'Note 1'],
    ['Shelf 2', 'Bookshop', 'Note 2'],
  ]);
  expect(page.copies.map((copy) => copy.nativeReadingContext)).toEqual([
    { state: 'unavailable' },
    { state: 'unavailable' },
  ]);
});

test('per-row presentation retains different contexts and qualified facts for repeated Subjects', () => {
  const contexts = [
    { state: 'available', work: [{ id: workId, labels: { en: 'Shared work' } }], facts },
    { state: 'unsupported', facts },
  ] satisfies import('../src/library/copy-reading-context/types').NativeCopyListContext[];
  const release = {
    properties: {
      'schema:author': { datatype: 'wikibase-item', labels: { en: 'Author' }, relation: { group: 'credit' } },
      'schema:datePublished': { datatype: 'time', labels: { en: 'Publication date' } },
    },
  };
  const presented = contexts.map((context) => presentCopyListContext(context, release, 'en'));
  expect(presented[0]).toMatchObject({ state: 'available', work: [{ id: workId, label: 'Shared work' }] });
  expect(presented[1]).toMatchObject({ state: 'unsupported' });
  expect(presented[1]?.state === 'unsupported' && presented[1].facts).toContainEqual(
    expect.objectContaining({
      property: 'schema:author',
      label: 'Author',
      text: 'A. Writer',
      subject: expect.objectContaining({ id: authorId }),
    }),
  );
  expect(presented[1]?.state === 'unsupported' && presented[1].facts).toContainEqual(
    expect.objectContaining({ property: 'schema:datePublished', label: 'Publication date', text: 'April 1986' }),
  );
});

test('undeclared hidden payloads and absent context remain unavailable and ID-free', () => {
  expect(copyListContextFromNativeRow(nativeCopy(1, { state: 'withheld', work: [{ id: workId }] }))).toEqual({
    state: 'unavailable',
  });
  const { context: _context, ...copy } = nativeCopy(2, { state: 'missing' });
  expect(copyListContextFromNativeRow(copy)).toEqual({ state: 'unavailable' });
});
