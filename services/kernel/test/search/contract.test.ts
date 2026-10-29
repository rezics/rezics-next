import { expect, test } from 'bun:test';
import { PROBLEMS } from '../../src/http/problem.ts';
import { decodeSearchCursor, encodeSearchCursor } from '../../src/search/cursor.ts';
import { bulkLines, documentActions, MISSING_NAME } from '../../src/search/document.ts';
import { subjectPartition, type IndexedSubject } from '../../src/search/source.ts';
import { createFakeSource } from './support/fake-source.ts';

// Route 0x00a0 sits in partition 10; route 0x0123 in partition 18.
const id = (n: number, route = '00a0') => `018f0000-0000-7000-8000-${route}${String(n).padStart(8, '0')}`;
const author = id(9, '0123');
const book: IndexedSubject = {
  id: id(1),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 3,
  labels: [
    { language: 'zh-Hant', value: '魔法禁書目錄' },
    { language: 'ja', value: 'とある魔術の禁書目録' },
  ],
  aliases: [
    { language: 'en', value: 'A Certain Magical Index' },
    { language: 'ja', value: 'とある魔術の禁書目録' },
  ],
  descriptions: [{ language: 'en', value: 'Light novel series' }],
  statements: [
    { property: 'schema:author', value: author },
    { property: 'schema:author', value: author },
  ],
};
const hidden: IndexedSubject = { ...book, id: id(2), visibility: 'hidden' };
const takenDown: IndexedSubject = { ...book, id: id(3), visibility: 'taken_down' };
const redirected: IndexedSubject = { ...book, id: id(4), redirect: book.id };
const unnamed: IndexedSubject = { ...book, id: id(5), labels: [], aliases: [], descriptions: [], statements: [] };

test('documents are built only from the anchor partition snapshot and versioned by its position', () => {
  expect(subjectPartition(book.id)).toBe(10);
  expect(subjectPartition(author)).toBe(18);
  const actions = documentActions({ partition: 10, position: 42n, subjects: [unnamed, book] }, [
    book.id,
    unnamed.id,
    book.id,
  ]);
  expect(actions).toEqual([
    {
      op: 'index',
      id: book.id,
      version: 42n,
      document: {
        id: book.id,
        partition: 10,
        type: 'schema:Book',
        security_revision: 3,
        names: ['魔法禁書目錄', 'とある魔術の禁書目録', 'A Certain Magical Index'],
        descriptions: ['Light novel series'],
        name_sort: 'とある魔術の禁書目録',
        statements: [`schema:author=${author}`],
        facts: [],
      },
    },
    {
      op: 'index',
      id: unnamed.id,
      version: 42n,
      document: {
        id: unnamed.id,
        partition: 10,
        type: 'schema:Book',
        security_revision: 3,
        names: [],
        descriptions: [],
        name_sort: MISSING_NAME,
        statements: [],
        facts: [],
      },
    },
  ]);
  expect(MISSING_NAME).toBe('\u{10FFFF}');
});

test('subjects that are not visible, redirected or missing become external-version deletes', () => {
  const missing = id(6);
  const actions = documentActions({ partition: 10, position: 7n, subjects: [hidden, takenDown, redirected] }, [
    hidden.id,
    takenDown.id,
    redirected.id,
    missing,
  ]);
  expect(actions).toEqual(
    [hidden.id, takenDown.id, redirected.id, missing].map((subject) => ({ op: 'delete', id: subject, version: 7n })),
  );
});

test('bulk lines carry external versions and refuse unsafe positions', () => {
  const actions = documentActions({ partition: 10, position: 9n, subjects: [book] }, [book.id, hidden.id]);
  const lines = bulkLines('rezics-subjects-g1', actions);
  expect(lines).toEqual([
    { index: { _index: 'rezics-subjects-g1', _id: book.id, version: 9, version_type: 'external' } },
    (actions[0] as { document: unknown }).document,
    { delete: { _index: 'rezics-subjects-g1', _id: hidden.id, version: 9, version_type: 'external' } },
  ]);
  const unsafe = documentActions({ partition: 10, position: 2n ** 53n, subjects: [] }, [book.id]);
  expect(() => bulkLines('rezics-subjects-g1', unsafe)).toThrow(RangeError);
});

test('search cursors round-trip sort values and bind the request and principal', async () => {
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
  const request = { text: '魔法', sort: 'relevance', page_size: 2 };
  const binding = { operation: 'subjects.search', request, principal: 'anonymous' };
  const after = [12.75, '魔法', book.id, null];
  const token = await encodeSearchCursor(ring, binding, { generation: 3, after });
  expect(await decodeSearchCursor(ring, binding, token)).toEqual({ ok: true, generation: 3, after });
  const reordered = { ...binding, request: { page_size: 2, sort: 'relevance', text: '魔法' } };
  expect(await decodeSearchCursor(ring, reordered, token)).toEqual({ ok: true, generation: 3, after });
  expect(await decodeSearchCursor(ring, { ...binding, request: { ...request, text: '魔' } }, token)).toEqual({
    ok: false,
    reason: 'invalid',
  });
  expect(await decodeSearchCursor(ring, { ...binding, principal: `account:${author}` }, token)).toEqual({
    ok: false,
    reason: 'invalid',
  });
  expect(await decodeSearchCursor(ring, { ...binding, operation: 'subjects.suggest' }, token)).toEqual({
    ok: false,
    reason: 'invalid',
  });
  expect(await decodeSearchCursor(ring, binding, `${token.slice(0, -2)}AA`)).toEqual({ ok: false, reason: 'invalid' });
  const issued = 1_800_000_000_000;
  const old = await encodeSearchCursor(ring, binding, { generation: 3, after: ['a'] }, issued);
  expect(await decodeSearchCursor(ring, binding, old, issued + 15 * 60_000 + 1)).toEqual({
    ok: false,
    reason: 'expired',
  });
});

test('search problem codes are in the catalogue', () => {
  expect(PROBLEMS.index_not_ready).toEqual({ status: 503, title: 'Search Index Not Ready', retryable: true });
  expect(PROBLEMS.search_restart_required).toEqual({ status: 409, title: 'Search Restart Required', retryable: false });
  expect(PROBLEMS.unsupported_query).toEqual({ status: 422, title: 'Unsupported Query', retryable: false });
});

test('the fake source answers one partition snapshot and counts only indexable subjects', async () => {
  const source = createFakeSource();
  for (const subject of [book, hidden, takenDown, redirected, unnamed]) source.put(subject);
  const other: IndexedSubject = {
    ...book,
    id: author,
    labels: [{ language: 'ja', value: '鎌池和馬' }],
    statements: [],
  };
  source.put(other);
  expect(await source.count(10)).toEqual({ position: 5n, count: 2 });
  expect(await source.count(18)).toEqual({ position: 1n, count: 1 });
  const snapshot = await source.read(10, [book.id, id(7), hidden.id]);
  expect(snapshot.partition).toBe(10);
  expect(snapshot.position).toBe(5n);
  expect(snapshot.subjects.map((subject) => subject.id).sort()).toEqual([book.id, hidden.id].sort());
  await expect(source.read(10, [author])).rejects.toThrow();
  source.remove(book.id);
  source.advance(18);
  expect(await source.count(10)).toEqual({ position: 6n, count: 1 });
  expect(await source.count(18)).toEqual({ position: 2n, count: 1 });
});
