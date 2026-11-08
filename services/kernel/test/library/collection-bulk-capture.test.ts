import { expect, test } from 'bun:test';
import type { AccountActor } from '../../src/request/access.ts';
import {
  captureCollectionBulkSource,
  CollectionBulkSourcePreparingError,
} from '../../src/library/collection-bulk-capture.ts';
import { CollectionBulkSelectionTooLarge } from '../../src/library/collection-bulk-store.ts';

const sourceId = '019a1b2c-3d4e-7f00-8a00-000000000001';
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-000000000002',
  clientId: 'bulk-capture-test',
  scopes: ['collection:read', 'library_entry:update'],
  requestedBy: null,
  authnEpoch: 1,
};
const subjectId = (n: number) => `019a1b2c-3d4e-7f00-8a00-${String(n).padStart(12, '0')}`;
const selection = {
  kind: 'query',
  sourceId,
  filter: '{ "state": "planned" }',
} as const;
const descriptor = (revision = 7) => ({
  id: sourceId,
  curatorAccountId: actor.accountId,
  title: 'Saved source',
  description: null,
  revision,
  membershipKind: 'dynamic' as const,
  visibility: 'private' as const,
  presentationKind: null,
  presentationKindSource: 'mixed' as const,
  cover: null,
  coverSource: 'none' as const,
});
type Reads = Parameters<typeof captureCollectionBulkSource>[0];
type MemberQuery = NonNullable<Parameters<Reads['readMembers']>[2]>;

function readsFor(
  rows: string[],
  options: {
    revision?: () => number;
    preparing?: boolean;
    readQueries?: MemberQuery[];
  } = {},
): Reads {
  return {
    async readCollection() {
      return descriptor(options.revision?.() ?? 7);
    },
    async readMembers(_actor, _sourceId, query: MemberQuery = {}) {
      options.readQueries?.push(query);
      if (options.preparing) return { preparing: true };
      const start = query.cursor == null ? 0 : Number(query.cursor);
      const page = rows.slice(start, start + (query.limit ?? 100));
      const end = start + page.length;
      return {
        members: page.map((subjectId) => ({ kind: 'dynamic' as const, subjectId })),
        next: end < rows.length ? String(end) : null,
      };
    },
  };
}

test('captures every Members page, canonical filter and unique subject operand', async () => {
  const members = [...Array.from({ length: 203 }, (_, index) => subjectId(index + 1)), subjectId(1), subjectId(2)];
  const readQueries: MemberQuery[] = [];
  const result = await captureCollectionBulkSource(
    readsFor(members, { readQueries }),
    actor,
    selection,
    Date.now() + 5000,
  );
  expect(result.subjects).toHaveLength(203);
  expect(result.source).toMatchObject({
    id: sourceId,
    revision: 7,
    filter: '{"state":"planned"}',
    sort: 'id',
    scannedCandidates: 205,
    selectedSubjects: 203,
  });
  expect(readQueries.map(({ cursor, sort }) => [cursor ?? null, sort])).toEqual([
    [null, 'id'],
    ['100', 'id'],
    ['200', 'id'],
  ]);
  expect(result.source.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
});

test('a stable exhausted empty source is a complete zero-target capture', async () => {
  const result = await captureCollectionBulkSource(readsFor([]), actor, selection, Date.now() + 5000);
  expect(result.subjects).toEqual([]);
  expect(result.source).toMatchObject({ scannedCandidates: 0, selectedSubjects: 0 });
});

test('refuses the 1,001st unique selected subject without returning a partial capture', async () => {
  await expect(
    captureCollectionBulkSource(
      readsFor(Array.from({ length: 1001 }, (_, index) => subjectId(index + 1))),
      actor,
      selection,
      Date.now() + 5000,
    ),
  ).rejects.toBeInstanceOf(CollectionBulkSelectionTooLarge);
});

test('source drift and incomplete Members preparation stay typed failures', async () => {
  let descriptorReads = 0;
  await expect(
    captureCollectionBulkSource(
      readsFor([], { revision: () => (descriptorReads++ === 0 ? 7 : 8) }),
      actor,
      selection,
      Date.now() + 5000,
    ),
  ).rejects.toMatchObject({ code: 'stale_cursor' });
  await expect(
    captureCollectionBulkSource(readsFor([], { preparing: true }), actor, selection, Date.now() + 5000),
  ).rejects.toBeInstanceOf(CollectionBulkSourcePreparingError);
});
