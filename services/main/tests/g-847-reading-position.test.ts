import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ReadingBoundary, prefixVisible, type ReadingComposition } from '../src/modules/reading-position/boundary.ts';
import { ReadingPositionTraversal, type ReadingLocation } from '../src/modules/reading-position/traversal.ts';
import { ReadingPositionStore, REVELATION_COST, propertyRevelationRecord, type Revelation } from '../src/modules/reading-position/store.ts';
import { revelationReads } from '../src/modules/reading-position/read-registry.ts';
import { WorkReadSession, WorkReadInvalid, WorkReadMissing, WorkReadMoved } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { createMainApp } from '../src/app.ts';
import { bookResumeEnvironment, readingResumeOwner, type ResumeCompletion } from './reading-resume-owner.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const work = id(), volume1 = id(), volume2 = id(), chapter1 = id(), chapter2 = id(), chapter3 = id(), chapter4 = id();
const composition: ReadingComposition = { work, structures: [id(), id(), id()], works: [work, volume1, volume2],
  occurrences: [chapter1, chapter2, chapter3, chapter4].map((occurrence, i) => ({ occurrence,
    work: i < 3 ? volume1 : volume2, structure: id(), revision: id(), parent: id(),
    segmentKey: 's', orderKey: String(i), role: 'chapter', target: null })) };
const row = (record = id(), occurrence = chapter2): Revelation => ({ record, occurrence,
  recordKind: 'entity', continuityWork: work, receipt: 'publication-receipt' });
function fixture(selection: string, principal = false) {
  const rows = new Map<string, Revelation[]>(), lookedUp: number[] = [];
  let version = '1', own = true;
  let privateReads = 0;
  const store = { lookup: async (records: readonly string[]) => {
    lookedUp.push(records.length); return new Map(records.flatMap(record => rows.has(record) ? [[record, rows.get(record)!]] : []));
  }, required: async () => new Set(), generation: async () => version, privateSnapshot: async () => { privateReads++; return version; },
    completedPage: async () => ({ items: [chapter3], next: null }), finishedWorks: async () => new Set() };
  const structure = composition.structures[0]!, head = id(), generation = id();
  const book = bookResumeEnvironment({ work, structure, revision: head, generation,
    chapters: composition.occurrences.map((item, index) => ({ occurrence: item.occurrence,
      segmentKey: 'a', orderKey: String(index).padStart(4, '0') })) });
  const completions: ResumeCompletion[] = [{ issuer: 'https://qa.test', subject: 'reader', structure, revision: head,
    occurrence: chapter3, orderKey: 'a\u00020002' }];
  const deps = { readingPositions: store, access: { canReadAsBaselineMember: async () => own },
    progress: readingResumeOwner(completions), environment: book.environment } as unknown as MainWorkDependencies;
  const session = new WorkReadSession(deps, new Request(`http://main.local/v1/fixture?position=${encodeURIComponent(selection)}`),
    principal ? { actingSubject: id() } : {}, { dataEpoch: 'epoch', sequence: '1' });
  if (principal) session.principal = { issuer: 'https://qa.test', subject: 'reader', emailVerified: true };
  const boundary = new ReadingBoundary(session);
  const location = (resource: string): ReadingLocation | null => {
    const index = composition.occurrences.findIndex(item => item.occurrence === resource);
    if (index < 0) return null;
    const item = { ...composition.occurrences[index]!, segmentKey: 'a', orderKey: String(index).padStart(4, '0') };
    return { item, frames: [{ work, parent: work, after: item }] };
  };
  boundary.traversalFor = () => ({ root: work, requireWork: async () => {}, requireLocation: async () => {},
    recordsFor: async () => [], metadataFor: async () => ({ work, structure, revision: head, generation }),
    location: async (resource: string) => location(resource),
    works: async function* () { yield [{ work, structure, revision: head, generation }]; },
  }) as unknown as ReadingPositionTraversal;
  return { rows, boundary, lookedUp, privateReads: () => privateReads,
    move: () => { version = '2'; }, deny: () => { own = false; } };
}

test('G847: prefix uses composed occurrence order, includes the boundary and leaves untagged catalogue records alone', async () => {
  const early = row(), late = row(id(), chapter4), untagged = id();
  expect(prefixVisible(composition, chapter3, early)).toBe(true);
  expect(prefixVisible(composition, chapter2, early)).toBe(true);
  expect(prefixVisible(composition, chapter3, late)).toBe(false);
  expect(prefixVisible(composition, id(), early)).toBe(false);
  for (const [selection, principal, expected] of [
    ['mine', false, [untagged]], ['mine', true, [early.record, untagged]],
    [chapter1, false, [untagged]], [chapter2, false, [early.record, untagged]],
    ['all', false, [early.record, late.record, untagged]],
  ] as const) {
    const f = fixture(selection, principal);
    f.rows.set(early.record, [early]); f.rows.set(late.record, [late]);
    expect([...(await f.boundary.visible([early.record, late.record, untagged]))]).toEqual([...expected]);
  }
});

test('G847 R2 R3: unrelated positions and ineligible readers withhold only tagged records, without reading another Agent history', async () => {
  expect(() => fixture('50%')).toThrow(WorkReadInvalid);
  const foreign = fixture(id()); foreign.rows.set('record', [row('record')]);
  expect([...(await foreign.boundary.visible(['record', 'untagged']))]).toEqual(['untagged']);
  const revoked = fixture('mine', true); revoked.rows.set('record', [row('record')]); revoked.deny();
  expect([...(await revoked.boundary.visible(['record', 'untagged']))]).toEqual(['untagged']);
  expect(revoked.privateReads()).toBe(0);
  const unverified = fixture('mine', true); unverified.boundary.session.principal!.emailVerified = false;
  unverified.rows.set('record', [row('record')]);
  expect([...(await unverified.boundary.visible(['record', 'untagged']))]).toEqual(['untagged']);
  expect(unverified.privateReads()).toBe(0);
  const moved = fixture('mine', true); moved.rows.set('record', [row('record')]);
  await moved.boundary.visible(['record']); moved.move();
  await expect(moved.boundary.visible(['record'])).rejects.toBeInstanceOf(WorkReadMoved);
});

test('G847 D1 R2: a record can belong to two continuities; one unreadable continuity does not suppress its readable publication or other records', async () => {
  const f = fixture(chapter3), secret = id(), early = row(), late = row(id(), chapter4);
  f.rows.set(early.record, [{ ...early, continuityWork: secret }, early]);
  f.rows.set(late.record, [{ ...late, continuityWork: secret }]);
  const traversalFor = f.boundary.traversalFor;
  f.boundary.traversalFor = resource => {
    if (resource === secret) throw new WorkReadMissing('Work is unavailable');
    return traversalFor(resource);
  };
  expect([...(await f.boundary.visible([early.record, late.record, 'untagged']))]).toEqual([early.record, 'untagged']);
});

test('G847: lookups split and memoize at 50 records and preserve independent later aliases', async () => {
  const f = fixture('start'); const ids = Array.from({ length: 123 }, id);
  await f.boundary.visible(ids); await f.boundary.visible(ids);
  expect(f.lookedUp).toEqual([50, 50, 23]);
  const value = { kind: 'language-string', lexical: 'Hidden name', language: 'en' };
  const key = propertyRevelationRecord(work, 'https://schema.org/name', value);
  expect(propertyRevelationRecord(work, 'https://schema.org/name', { language: 'en', lexical: 'Hidden name', kind: 'language-string' })).toBe(key);
  expect(propertyRevelationRecord(work, 'https://schema.org/alternateName', value)).not.toBe(key);
  expect(propertyRevelationRecord(work, 'https://schema.org/name', { ...value, lexical: 'Known name' })).not.toBe(key);
  let calls = 0;
  const store = new ReadingPositionStore({ query: async () => { calls++; return { rows: [] }; } } as unknown as Pool);
  expect((await store.lookup(ids.slice(0, 50))).size).toBe(0);
  expect(calls).toBe(REVELATION_COST.lookupSql);
  await expect(store.lookup(ids)).rejects.toBeInstanceOf(WorkReadInvalid);
  expect(calls).toBe(1);
});

test('G847: current mounted owner inventories exactly match the executable revelation fixture registry', () => {
  const app = createMainApp({} as never, {} as MainWorkDependencies);
  const paths = app.routes.filter(route => route.method === 'GET' && (
    /^\/v1\/resources\/:resource\/(?:page|statements|relations)(?:\/.*)?$/.test(route.path)
    || /^\/v1\/collections\/:id(?:\/revisions\/:revision)?$/.test(route.path)
    || route.path.startsWith('/v1/zones/:id/routes')
    || /^\/v1\/semantic\/resources\/:id(?:\/revisions\/:revision)?$/.test(route.path)
    || route.path === '/v1/statements/:id'
    || /^\/v1\/relations\/:id(?:\/revisions\/:revision)?$/.test(route.path))).map(route => route.path).sort();
  expect(paths).toEqual(revelationReads.map(read => read.path).sort());
  expect(new Set(revelationReads.map(read => read.id)).size).toBe(revelationReads.length);
});
