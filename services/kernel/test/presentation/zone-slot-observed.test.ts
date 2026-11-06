import { expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import { preparePageRead, readPage } from '../../src/presentation/reads.ts';
import { observeComposedSlot } from '../../src/presentation/http/slot-observed.ts';
import {
  admitObservedMembersPage,
  admitObservedSearchPage,
  uniqueCanonicalRows,
} from '../../src/presentation/slot-bodies.ts';
import { encodeSession } from '../../src/tokens/session.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const ring: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
const book = '018f0000-0000-7000-8000-00a000000001';
const alias = '018f0000-0000-7000-8000-00a000000001';
const summary = {
  id: book,
  type: 'schema:Book',
  types: ['schema:Book', 'schema:CreativeWork'],
  label: { value: 'Kokoro', language: 'en' },
  creativeWork: true,
  cover: null,
};
const search = {
  kind: 'search' as const,
  body: { filter: { statement: { property: 'schema:author', in: [book] } }, sort: 'name' as const, limit: 12 },
};

test('observed Zone TypeList slots skip Search and keep unique native order', async () => {
  const prepared = preparePageRead(search, ['en']);
  const body = {
    subjects: [
      { id: book, type: 'schema:Book', labels: { en: 'Kokoro' }, summary },
      { id: alias, type: 'schema:Book', labels: { en: 'Kokoro' }, summary },
    ],
    next: 'next_slot-2',
  };
  const unique = uniqueCanonicalRows(body.subjects);
  expect(unique.map((row) => row.id)).toEqual([book]);
  expect(admitObservedSearchPage(search, body)?.subjects).toEqual([
    { id: book, type: 'schema:Book', labels: { en: 'Kokoro' }, summary },
  ]);
  expect(admitObservedSearchPage(search, { ...body, subjects: unique })?.subjects).toHaveLength(1);
  const seen: string[] = [];
  const page = await readPage({
    dispatch: async (request) => {
      seen.push(new URL(request.url).pathname);
      return new Response(JSON.stringify({ code: 'not_found' }), { status: 404 });
    },
    incoming: new Request('http://kernel.test/v1/pages:read'),
    reads: { books: search },
    session: { ring, scope: 'anonymous' },
    languages: ['en'],
    observed: new Map([[prepared.canonical, { status: 200, body: { ...body, subjects: unique } }]]),
  });
  expect(seen).toEqual([]);
  expect(page.results.books).toEqual({ status: 200, body: { ...body, subjects: unique } });
  expect(canonicalize(prepared.descriptor)).toBe(prepared.canonical);
  expect(page.session ?? encodeSession(ring, 'anonymous', [])).toBeTruthy();
});

test('observed Zone Members slots unique aliases and admit an empty continuation', () => {
  const members = {
    kind: 'members' as const,
    source: { kind: 'collection' as const, id: book },
    sort: 'id' as const,
    limit: 12,
  };
  const duplicate = {
    members: [
      { kind: 'dynamic' as const, subjectId: book, summary },
      { kind: 'dynamic' as const, subjectId: alias, summary },
    ],
    next: 'next_members-2',
  };
  const unique = uniqueCanonicalRows(duplicate.members);
  expect(unique).toHaveLength(1);
  expect(admitObservedMembersPage(members, duplicate)?.members).toEqual([
    { kind: 'dynamic', subjectId: book, summary },
  ]);
  expect(admitObservedMembersPage(members, { ...duplicate, members: unique })?.members).toHaveLength(1);
  expect(admitObservedSearchPage(search, { subjects: [], next: null })).toEqual({ subjects: [], next: null });
  expect(admitObservedSearchPage(search, { subjects: [], next: 'next_sparse-2' })).toEqual({
    subjects: [],
    next: 'next_sparse-2',
  });
});

test('observed Zone slots keep withheld summaries and refuse leaked owner facts', () => {
  const withheld = {
    subjects: [{ id: book, type: 'schema:Book', labels: { en: 'Kokoro' }, summary: null }],
    next: null,
  };
  expect(observeComposedSlot(search, { status: 200, body: withheld })?.body).toEqual(withheld);
  expect(
    observeComposedSlot(search, {
      status: 200,
      body: {
        subjects: [{ id: book, type: 'schema:Book', labels: { en: 'Kokoro' }, summary, ownerId: book }],
        next: null,
      },
    }),
  ).toBeUndefined();
  expect(
    admitObservedMembersPage(
      {
        kind: 'members',
        source: { kind: 'collection', id: book },
        sort: 'id',
        limit: 12,
      },
      { members: [{ kind: 'dynamic', subjectId: book, summary: null, mounts: [] }], next: null },
    ),
  ).toBeUndefined();
});
