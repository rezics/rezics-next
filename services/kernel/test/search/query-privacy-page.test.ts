import { expect, test } from 'bun:test';
import { subjectPartition, type IndexedSubject, type SubjectSource } from '../../src/search/source.ts';
import {
  discloseQueryPrivacyPage,
  queryPrivacyEmptyPage,
  queryPrivacyOrderUnchanged,
  replayQueryPrivacyPageCursor,
  type QueryPrivacyExaminedHit,
} from '../../src/search/query-privacy-page.ts';
import { admitQueryPrivacyCursor, queryPrivacyCurrentness } from '../../src/search/query-privacy.ts';
import { privacyBarrier, privacyHead, privacyHeads } from './support/query-privacy-heads.ts';

const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const subject = (n: number, patch: Partial<IndexedSubject> = {}): IndexedSubject => ({
  id: id(n),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: `Book ${n}` }],
  aliases: [],
  descriptions: [],
  statements: [{ property: 'schema:keywords', value: 'harem', facet: { kind: 'item' } }],
  ...patch,
});
const hit = (n: number, row?: IndexedSubject): QueryPrivacyExaminedHit => ({
  key: { owner: 'semantic', kind: 'schema:Book', id: id(n) },
  sort: [id(n)],
  ...(row ? { subject: row } : {}),
});

function sourceOf(rows: readonly IndexedSubject[]): SubjectSource {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    async read(partition, ids) {
      return {
        partition,
        position: 1n,
        subjects: ids.flatMap((value) => {
          const row = byId.get(value);
          return row && subjectPartition(row.id) === partition ? [row] : [];
        }),
      };
    },
    async count() {
      return { position: 1n, count: rows.length };
    },
  };
}

test('hidden and taken-down engine rows drop without reordering remaining hits', async () => {
  const visible = [subject(1), subject(3)];
  const examined = [hit(1, visible[0]), hit(2, subject(2, { visibility: 'hidden' })), hit(3, visible[1])];
  const page = await discloseQueryPrivacyPage({
    currentness: queryPrivacyCurrentness(privacyHeads()),
    examined,
    subjects: new Map([
      [examined[0]!, visible[0]!],
      [examined[2]!, visible[1]!],
    ]),
    limit: 3,
    exhausted: true,
  });
  expect(page.status).toBe('ready');
  expect(page.order).toEqual([id(1), id(3)]);
  expect(queryPrivacyOrderUnchanged([id(1), id(2), id(3)], page.order)).toBe(true);
  expect(page.dropped).toBe(1);
});

test('a public-to-private change between candidate read and hydration drops the withheld hit', async () => {
  const first = subject(1);
  const second = subject(2);
  const examined = [hit(1, first), hit(2, second)];
  const live = sourceOf([first, subject(2, { visibility: 'hidden', securityRevision: 8 })]);
  const page = await discloseQueryPrivacyPage({
    currentness: queryPrivacyCurrentness(privacyHeads()),
    examined,
    subjects: new Map([
      [examined[0]!, first],
      [examined[1]!, second],
    ]),
    limit: 2,
    exhausted: true,
    source: live,
  });
  expect(page.order).toEqual([id(1)]);
  expect(page.hits[0]!.projected.id).toBe(id(1));
});

test('nested label reads revalidate displayed fields from the current snapshot', async () => {
  const book = subject(1);
  const examined = [hit(1, book)];
  let nested = false;
  const live = sourceOf([
    subject(1, {
      statements: [],
      labels: [{ language: 'en', value: 'Current title' }],
    }),
  ]);
  const page = await discloseQueryPrivacyPage({
    currentness: queryPrivacyCurrentness(privacyHeads()),
    examined,
    subjects: new Map([[examined[0]!, book]]),
    limit: 1,
    exhausted: true,
    source: live,
    properties: ['schema:keywords'],
    async nested() {
      nested = true;
    },
  });
  expect(nested).toBe(true);
  expect(page.hits[0]!.projected.labels.en).toBe('Current title');
  expect(page.hits[0]!.projected.facts?.['schema:keywords'] ?? []).toEqual([]);
});

test('an empty current page is ready only when currentness holds', async () => {
  const ready = queryPrivacyEmptyPage(queryPrivacyCurrentness(privacyHeads()), true);
  expect(ready.status).toBe('ready');
  expect(ready.empty).toBe(true);
  expect(ready.useful).toBe(true);
  const withheld = queryPrivacyEmptyPage(queryPrivacyCurrentness(privacyHeads({ blocking: [privacyBarrier()] })), true);
  expect(withheld.status).toBe('preparing');
  expect(withheld.empty).toBe(false);
});

test('cursor replay after a relevant reduction restarts; trusted stale continues', () => {
  const admitted = admitQueryPrivacyCursor({ observation: 'obs', execution: 'exec', consumed: 1 });
  expect(replayQueryPrivacyPageCursor(admitted, queryPrivacyCurrentness(privacyHeads()))).toBe('continue');
  expect(
    replayQueryPrivacyPageCursor(admitted, queryPrivacyCurrentness(privacyHeads({ unacknowledged: [privacyHead()] }))),
  ).toBe('continue');
  expect(
    replayQueryPrivacyPageCursor(admitted, queryPrivacyCurrentness(privacyHeads({ blocking: [privacyBarrier()] }))),
  ).toBe('restart');
});

test('preparing currentness never becomes a successful empty substitute', async () => {
  const examined = [hit(1, subject(1))];
  const page = await discloseQueryPrivacyPage({
    currentness: queryPrivacyCurrentness(privacyHeads({ routingComplete: false })),
    examined,
    subjects: new Map([[examined[0]!, subject(1)]]),
    limit: 1,
    exhausted: true,
  });
  expect(page.status).toBe('preparing');
  expect(page.hits).toEqual([]);
  expect(page.empty).toBe(false);
});

test('sort keys of survivors stay in engine order after a withheld fact', async () => {
  const rows = [subject(1), subject(2, { statements: [] }), subject(3)];
  const examined = rows.map((row, index) => hit(index + 1, row));
  const page = await discloseQueryPrivacyPage({
    currentness: queryPrivacyCurrentness(privacyHeads()),
    examined,
    subjects: new Map(examined.map((candidate, index) => [candidate, rows[index]!])),
    limit: 3,
    exhausted: true,
  });
  expect(page.order).toEqual([id(1), id(2), id(3)]);
  expect(page.hits[1]!.subject.statements).toEqual([]);
});
