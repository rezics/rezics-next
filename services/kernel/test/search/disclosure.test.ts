import { expect, test } from 'bun:test';
import { checkHits, type FactClause, type Hit } from '../../src/search/disclosure/check.ts';
import { subjectPartition, type IndexedSubject, type SubjectSource } from '../../src/search/source.ts';
import { createFakeSource } from './support/fake-source.ts';

// Route 0x00a0 sits in partition 10; route 0x0123 in partition 18.
const id = (n: number, route = '00a0') => `018f0000-0000-7000-8000-${route}${String(n).padStart(8, '0')}`;
const author = id(90, '0123');
const other = id(91, '0123');
const book = (n: number, route = '00a0'): IndexedSubject => ({
  id: id(n, route),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: `Book ${n}` }],
  aliases: [],
  descriptions: [],
  statements: [{ property: 'schema:author', value: author }],
});
const hit = (subject: IndexedSubject, matched: string[] = []): Hit => ({
  id: subject.id,
  partition: subjectPartition(subject.id),
  securityRevision: subject.securityRevision,
  matched,
});
const none = new Map<string, FactClause>();

function recording(source: SubjectSource) {
  const reads: { partition: number; ids: string[] }[] = [];
  const wrapped: SubjectSource = {
    read: (partition, ids) => {
      reads.push({ partition, ids: [...ids].sort() });
      return source.read(partition, ids);
    },
    count: (partition) => source.count(partition),
  };
  return { reads, source: wrapped };
}

test('visible hits pass in their original order with the current subject state', async () => {
  const fake = createFakeSource();
  const a = book(1);
  const b = book(2, '0123');
  const c = book(3);
  for (const subject of [a, b, c]) fake.put(subject);
  fake.put({ ...a, labels: [{ language: 'en', value: 'Renamed' }] });
  const { reads, source } = recording(fake);
  const result = await checkHits(source, [hit(b), hit(a), hit(c)], none);
  expect(result.dropped).toBe(0);
  expect(result.passed.map((entry) => entry.hit.id)).toEqual([b.id, a.id, c.id]);
  expect(result.passed[1]!.subject.labels).toEqual([{ language: 'en', value: 'Renamed' }]);
  expect(reads.sort((x, y) => x.partition - y.partition)).toEqual([
    { partition: 10, ids: [a.id, c.id].sort() },
    { partition: 18, ids: [b.id] },
  ]);
});

test('hidden, taken-down, redirected, missing and re-secured hits are dropped', async () => {
  const fake = createFakeSource();
  const subjects = [1, 2, 3, 4, 5, 6].map((n) => book(n));
  const [kept, hidden, takenDown, redirected, missing, resecured] = subjects as [
    IndexedSubject,
    IndexedSubject,
    IndexedSubject,
    IndexedSubject,
    IndexedSubject,
    IndexedSubject,
  ];
  for (const subject of subjects) fake.put(subject);
  const hits = subjects.map((subject) => hit(subject));
  fake.put({ ...hidden, visibility: 'hidden' });
  fake.put({ ...takenDown, visibility: 'taken_down', securityRevision: 2 });
  fake.put({ ...redirected, redirect: kept.id });
  fake.remove(missing.id);
  fake.put({ ...resecured, securityRevision: 2 });
  const result = await checkHits(fake, hits, none);
  expect(result.passed.map((entry) => entry.hit.id)).toEqual([kept.id]);
  expect(result.dropped).toBe(5);
});

test('a hit that names another partition than its anchor is dropped without reading there', async () => {
  const fake = createFakeSource();
  const a = book(1);
  fake.put(a);
  const { reads, source } = recording(fake);
  expect(await checkHits(source, [{ ...hit(a), partition: 18 }], none)).toEqual({ passed: [], dropped: 1 });
  expect(reads).toEqual([]);
});

test('matched filter clauses must still hold on the current facts', async () => {
  const fake = createFakeSource();
  const subjects = [1, 2, 3, 4].map((n) => book(n));
  const [stillBy, nowByOther, nowRecipe, textOnly] = subjects as [
    IndexedSubject,
    IndexedSubject,
    IndexedSubject,
    IndexedSubject,
  ];
  for (const subject of subjects) fake.put(subject);
  fake.put({ ...nowByOther, statements: [{ property: 'schema:author', value: other }] });
  fake.put({ ...nowRecipe, type: 'schema:Recipe' });
  fake.put({ ...textOnly, type: 'schema:Recipe' });
  const clauses = new Map<string, FactClause>([
    ['f0', { facet: 'type', values: ['schema:Book'] }],
    ['f1', { facet: 'statement', property: 'schema:author', values: [author] }],
  ]);
  const result = await checkHits(
    fake,
    [hit(stillBy, ['t0', 'f0', 'f1']), hit(nowByOther, ['f1']), hit(nowRecipe, ['t0', 'f0']), hit(textOnly, ['t0'])],
    clauses,
  );
  expect(result.passed.map((entry) => entry.hit.id)).toEqual([stillBy.id, textOnly.id]);
  expect(result.dropped).toBe(2);
});

test('partitions are read once each with bounded concurrency', async () => {
  const fake = createFakeSource();
  const route = (partition: number) => (partition * 16).toString(16).padStart(4, '0');
  const subjects = Array.from({ length: 20 }, (_, index) => book(index + 1, route(Math.floor(index / 2) + 1)));
  for (const subject of subjects) fake.put(subject);
  let active = 0;
  let peak = 0;
  const partitions: number[] = [];
  const slow: SubjectSource = {
    read: async (partition, ids) => {
      partitions.push(partition);
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active -= 1;
      return fake.read(partition, ids);
    },
    count: (partition) => fake.count(partition),
  };
  const result = await checkHits(
    slow,
    subjects.map((subject) => hit(subject)),
    none,
    { concurrency: 3 },
  );
  expect(result.passed).toHaveLength(20);
  expect(partitions.sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(peak).toBe(3);
});

test('a failed read fails the whole check closed', async () => {
  const fake = createFakeSource();
  const a = book(1);
  const b = book(2, '0123');
  fake.put(a);
  fake.put(b);
  const failing: SubjectSource = {
    read: (partition, ids) =>
      partition === 18 ? Promise.reject(new Error('partition unavailable')) : fake.read(partition, ids),
    count: (partition) => fake.count(partition),
  };
  await expect(checkHits(failing, [hit(a), hit(b)], none)).rejects.toThrow('partition unavailable');
});
