import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { join } from 'node:path';
import {
  subjectPageQuery,
  subjectFrameQuery,
  subjectRelationsQuery,
  subjectRatingQuery,
  subjectReactionsQuery,
} from '../src/features/pages/subject-queries';
import {
  subjectLibraryQuery,
  subjectReaderQuery,
  subjectOwnReactionQuery,
  subjectOwnRatingQuery,
} from '../src/features/pages/subject-queries';

const id = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const anonymousPersonalScope = { reader: null, admission: 0, view: 'overview', cacheEpoch: 0 } as const;

test('public subject data is read through locale and view keyed public query factories', async () => {
  const queries = [
    subjectPageQuery(id, 'en', 'overview'),
    subjectFrameQuery('schema:Book', 'en'),
    subjectRelationsQuery(['schema:author'], 'en'),
    subjectReactionsQuery(id, 'en'),
    subjectRatingQuery(id, 'en'),
  ];
  expect(queries.map((query) => query.queryKey)).toEqual([
    ['subject-page', id, 'en', 'overview'],
    ['subject-frame', 'schema:Book', 'en'],
    ['subject-relations', ['schema:author'], 'en'],
    ['subject-reactions', id, 'en'],
    ['subject-rating', id, 'en'],
  ]);
  expect(queries.every((query) => query.staleTime === 60_000)).toBe(true);
  expect(queries.every((query) => typeof query.queryFn === 'function')).toBe(true);
});

test('personal subject data queries are disabled during server rendering', async () => {
  const queries = [
    subjectLibraryQuery(id, 'en'),
    subjectReaderQuery(id, 'en', anonymousPersonalScope),
    subjectOwnReactionQuery(id, 'en'),
    subjectOwnRatingQuery(id, 'en', anonymousPersonalScope),
  ];
  expect(queries.map((query) => query.queryKey)).toEqual([
    ['subject-library', id, 'en'],
    ['subject-reader', id, 'en', null, 0, 'overview', 0, 0, 0],
    ['subject-own-reaction', id, 'en', null, 0, 'overview', 0],
    ['subject-own-rating', id, 'en', null, 0, 'overview', 0, 0, 0],
  ]);
  expect(queries.every((query) => query.enabled === false)).toBe(true);
});

test('private Subject cache keys isolate route incarnations, removals and private query errors', () => {
  const scope = {
    reader: 'reader-a',
    admission: 4,
    view: 'overview',
    cacheEpoch: 2,
    errorEpoch: 3,
    incarnation: 9,
    scopeKey: 'subject-personal-scope',
  } as const;
  const readerKey = subjectReaderQuery(id, 'en', scope).queryKey;
  const ratingKey = subjectOwnRatingQuery(id, 'en', scope).queryKey;

  expect(readerKey).toEqual(['subject-reader', id, 'en', 'reader-a', 4, 'overview', 2, 3, 9]);
  expect(ratingKey).toEqual(['subject-own-rating', id, 'en', 'reader-a', 4, 'overview', 2, 3, 9]);
  expect(subjectReaderQuery(id, 'en', { ...scope, errorEpoch: 4 }).queryKey).not.toEqual(readerKey);
  expect(subjectOwnRatingQuery(id, 'en', { ...scope, errorEpoch: 4 }).queryKey).not.toEqual(ratingKey);
  expect(subjectReaderQuery(id, 'en', { ...scope, cacheEpoch: 3 }).queryKey).not.toEqual(readerKey);
  expect(subjectOwnRatingQuery(id, 'en', { ...scope, cacheEpoch: 3 }).queryKey).not.toEqual(ratingKey);
  expect(subjectReaderQuery(id, 'en', { ...scope, incarnation: 10 }).queryKey).not.toEqual(readerKey);
  expect(subjectOwnRatingQuery(id, 'en', { ...scope, incarnation: 10 }).queryKey).not.toEqual(ratingKey);
});

test('server-side public reads can be ensured without a request session', async () => {
  const client = new QueryClient();
  const reads: string[] = [];
  const queries = [subjectPageQuery(id, 'en', 'overview'), subjectFrameQuery('schema:Book', 'en')];
  for (const query of queries) {
    const ensured = {
      ...query,
      queryFn: async () => {
        reads.push(String(query.queryKey[0]));
        return { public: true };
      },
    };
    await client.ensureQueryData(ensured);
  }
  expect(reads).toEqual(['subject-page', 'subject-frame']);
  expect(
    client
      .getQueryCache()
      .getAll()
      .every((query) => query.state.data !== undefined),
  ).toBe(true);
});

test('the subject server loader only ensures public reads and personal reads are hydration gated', async () => {
  const route = await Bun.file(join(import.meta.dir, '../src/routes/subjects/$id_.$slug.tsx')).text();
  expect(route).toContain('context.queryClient.ensureQueryData(pageQuery)');
  expect(route).toContain('context.queryClient.ensureQueryData(subjectFrameQuery');
  expect(route).toContain('context.queryClient.ensureQueryData(subjectRelationsQuery');
  expect(route).toContain('useSuspenseQuery(subjectPageQuery');
  expect(route).toContain("enabled: session === 'signed-in'");
  expect(route).toContain('useSubjectPersonalReader');
  expect(route).toContain('useSubjectReactionReader');
  expect(route).toContain("view: 'overview'");
  expect(route).toContain('includeOwnRating: true');
  expect(route).not.toContain('loadSubjectLibrarySlot(');
  expect(route).not.toContain('loadReader(');
  expect(route).not.toContain('loadSubjectReactions(');
  expect(route).not.toContain('loadSubjectRatings(');
  const view = await Bun.file(join(import.meta.dir, '../src/routes/subjects/$id_.$slug_.$view.tsx')).text();
  expect(view).toMatch(/context\.queryClient\.ensureQueryData\(\s*subjectViewPagesQuery/);
  expect(view).toContain('useSubjectPersonalReader');
  expect(view).toContain('enabled: currentReader');
  expect(view).not.toContain('loadReader(');
  const relations = await Bun.file(join(import.meta.dir, '../src/routes/subjects/$id_.$slug_.relations.tsx')).text();
  expect(relations).toContain('context.queryClient.ensureQueryData(subjectPageQuery');
  expect(relations).toContain('context.queryClient.ensureQueryData(subjectRelationsQuery');
  expect(relations).toContain('useSubjectPersonalReader');
  expect(relations).toContain("view: 'relations'");
  expect(relations).not.toContain('loadReader(');
  const adapter = await Bun.file(join(import.meta.dir, '../src/features/pages/subject-personal-reader.tsx')).text();
  expect(adapter).toContain('subjectReaderQuery(subjectId, locale, queryScope, transport)');
  expect(adapter).toContain('subjectOwnRatingQuery(subjectId, locale, queryScope, transport)');
  expect(adapter).toContain('personalRead.enabled');
});

test('private reaction query partitions by its actual admitted reader and mounted observation', () => {
  const query = subjectOwnReactionQuery(id, 'en', {
    reader: 'alice',
    admission: 7,
    view: 'overview',
    cacheEpoch: 11,
    scopeKey: 'subject-observation',
    isCurrent: () => true,
    hasLiveObserver: () => true,
  });
  expect(query.queryKey).toEqual(['subject-own-reaction', id, 'en', 'alice', 7, 'overview', 11]);
  expect(query.retry).toBe(false);
  expect(query.meta).toEqual({ subjectReactionScope: 'subject-observation', subjectReactionCacheEpoch: 11 });
});
