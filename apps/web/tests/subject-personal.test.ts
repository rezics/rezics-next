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
    subjectReaderQuery(id, 'en'),
    subjectOwnReactionQuery(id, 'en'),
    subjectOwnRatingQuery(id, 'en'),
  ];
  expect(queries.map((query) => query.queryKey)).toEqual([
    ['subject-library', id, 'en'],
    ['subject-reader', id, 'en'],
    ['subject-own-reaction', id, 'en'],
    ['subject-own-rating', id, 'en'],
  ]);
  expect(queries.every((query) => query.enabled === false)).toBe(true);
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
  expect(route).not.toContain('loadSubjectLibrarySlot(');
  expect(route).not.toContain('loadReader(');
  expect(route).not.toContain('loadSubjectReactions(');
  expect(route).not.toContain('loadSubjectRatings(');
  const view = await Bun.file(join(import.meta.dir, '../src/routes/subjects/$id_.$slug_.$view.tsx')).text();
  expect(view).toMatch(/context\.queryClient\.ensureQueryData\(\s*subjectViewPagesQuery/);
  expect(view).toContain('subjectReaderQuery');
  expect(view).not.toContain('loadReader(');
  const relations = await Bun.file(join(import.meta.dir, '../src/routes/subjects/$id_.$slug_.relations.tsx')).text();
  expect(relations).toContain('context.queryClient.ensureQueryData(subjectPageQuery');
  expect(relations).toContain('context.queryClient.ensureQueryData(subjectRelationsQuery');
  expect(relations).not.toContain('loadReader(');
});
