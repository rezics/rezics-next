import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { createInitiatorRestorer } from '../../src/access/durable-initiator.ts';
import { withConnection } from '../../src/database/pool.ts';
import { runCollectionBulkPage } from '../../src/library/collection-bulk-work.ts';
import { pageCollectionBulkManifest, readCollectionBulk } from '../../src/library/collection-bulk-store.ts';
import { bulkPreviewSchema } from '../../src/library/bulk-schemas.ts';
import { routeOf } from '../../src/route/route.ts';
import { testTokens } from '../support/test-kernel.ts';
import {
  createCollectionBatchFixture,
  entryKey,
  type CollectionBatchFixture,
} from './support/collection-batch-fixture.ts';

let f: CollectionBatchFixture;
let owner: Awaited<ReturnType<CollectionBatchFixture['identity']>>;
let time = Date.now();
const clock = () => new Date(time);

beforeAll(async () => {
  f = await createCollectionBatchFixture({ clock });
  owner = await f.identity([
    'subject:create',
    'subject:read',
    'collection:create',
    'collection:read',
    'collection:update',
    'library_entry:read',
    'library_entry:list',
    'library_entry:update',
  ]);
}, 120000);

afterAll(async () => {
  await f?.close();
});

const dependencies = () => ({
  pool: f.pool,
  access: f.access,
  tokens: testTokens(),
  clock,
  readConsent: async () => ({
    actorAccountId: owner.actor.accountId,
    clientId: owner.actor.clientId,
    scopes: owner.actor.scopes,
  }),
});

test('preview captures only exact curated occurrences and confirmed replay preserves their native receipts', async () => {
  const collection = await f.make('private', owner);
  const subjectId = await f.createSubject('game');
  const first = await f.commands.addMember(owner.actor, collection.id, { subjectId, note: 'first' }, entryKey());
  const selectedSibling = await f.commands.addMember(
    owner.actor,
    collection.id,
    { subjectId, note: 'selected sibling' },
    entryKey(),
  );
  const unselectedSibling = await f.commands.addMember(
    owner.actor,
    collection.id,
    { subjectId, note: 'unselected sibling' },
    entryKey(),
  );
  const selectedIds = [first.value.id, selectedSibling.value.id];
  const request = {
    action: 'remove_from_collection',
    collectionId: collection.id,
    selection: { kind: 'occurrences', memberIds: selectedIds },
  } as const;
  expect(Value.Check(bulkPreviewSchema, request)).toBe(true);
  const before = await f.pool.query<{
    memberId: string;
    subjectId: string;
    memberRevision: string;
    transactionId: string;
    addedAt: string;
    deletionId: string | null;
  }>(
    `SELECT member_id AS "memberId",subject_id AS "subjectId",member_revision::text AS "memberRevision",
      transaction_id AS "transactionId",added_at::text AS "addedAt",deletion_id AS "deletionId"
     FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=ANY($3::uuid[])
     ORDER BY member_id`,
    [routeOf(collection.id), collection.id, selectedIds],
  );
  const idempotencyKey = entryKey();
  const response = await f.send(owner.bearer, 'POST', '/v1/libraryOperations', request, idempotencyKey);
  expect(response.status, await response.clone().text()).toBe(201);
  const created = (await response.json()) as {
    operation: { id: string; phase: string; counts: { capturedOccurrences: number; targets: number } };
  };
  const operationId = created.operation.id;
  expect(created.operation.phase).toBe('preview');
  expect(created.operation.counts).toMatchObject({ capturedOccurrences: 2, targets: 2 });
  const replay = await f.send(owner.bearer, 'POST', '/v1/libraryOperations', request, idempotencyKey);
  expect(((await replay.json()) as { operation: { id: string } }).operation.id).toBe(operationId);

  const key = { route: routeOf(owner.actor.accountId)!, operationId, accountId: owner.actor.accountId };
  const stored = await withConnection(f.pool, async (tx) => ({
    operation: (await readCollectionBulk(tx, key))!,
    rows: await pageCollectionBulkManifest(tx, key),
  }));
  expect(stored.operation.phase).toBe('preview');
  expect(stored.rows.map((row) => row.target)).toEqual(
    selectedIds.map((memberId) => {
      const row = before.rows.find((candidate) => candidate.memberId === memberId)!;
      return {
        kind: 'occurrence',
        collectionId: collection.id,
        memberId,
        subjectId: row.subjectId,
        expected: {
          memberRevision: row.memberRevision,
          transactionId: row.transactionId,
          addedAt: row.addedAt,
        },
      };
    }),
  );
  const unchanged = await f.pool.query(
    `SELECT member_id AS "memberId",deletion_id AS "deletionId",member_revision::text AS revision,
      transaction_id AS "transactionId",added_at::text AS "addedAt"
     FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=ANY($3::uuid[]) ORDER BY member_id`,
    [routeOf(collection.id), collection.id, selectedIds],
  );
  expect(unchanged.rows.map((row) => row.deletionId)).toEqual([null, null]);
  expect(unchanged.rows.map((row) => [row.revision, row.transactionId, row.addedAt])).toEqual(
    before.rows.map((row) => [row.memberRevision, row.transactionId, row.addedAt]),
  );

  await f.commands.updateMemberNote(
    owner.actor,
    collection.id,
    first.value.id,
    { note: 'edited after preview' },
    entryKey(),
  );
  const replacement = await f.commands.addMember(
    owner.actor,
    collection.id,
    { subjectId, note: 'added after preview' },
    entryKey(),
  );
  const confirmKey = entryKey();
  const confirmed = await f.send(owner.bearer, 'POST', `/v1/libraryOperations/${operationId}:confirm`, {}, confirmKey);
  expect(confirmed.status).toBe(200);
  const confirmReplay = await f.send(
    owner.bearer,
    'POST',
    `/v1/libraryOperations/${operationId}:confirm`,
    {},
    confirmKey,
  );
  expect(confirmReplay.status).toBe(200);

  const work = dependencies();
  await runCollectionBulkPage(work, { route: key.route, operationId });
  expect(await runCollectionBulkPage(work, { route: key.route, operationId })).toBe(false);
  const outcomes = await f.send(owner.bearer, 'GET', `/v1/libraryOperations/${operationId}/outcomes`);
  expect(
    (await outcomes.json()).outcomes.map((row: { state: string; reason: string | null }) => [row.state, row.reason]),
  ).toEqual([
    ['conflict', 'revision_mismatch'],
    ['applied', null],
  ]);
  const active = await f.pool.query<{ memberId: string }>(
    `SELECT member_id AS "memberId" FROM library.collection_member WHERE route=$1 AND collection_id=$2
     AND deletion_id IS NULL ORDER BY member_id`,
    [routeOf(collection.id), collection.id],
  );
  expect(active.rows.map((row) => row.memberId).sort()).toEqual(
    [first.value.id, unselectedSibling.value.id, replacement.value.id].sort(),
  );
  const deletion = await f.pool.query<{ deletionId: string; purgeAfter: string }>(
    `SELECT deletion_id AS "deletionId",purge_after::text AS "purgeAfter" FROM library.collection_member
     WHERE route=$1 AND collection_id=$2 AND member_id=$3`,
    [routeOf(collection.id), collection.id, selectedSibling.value.id],
  );
  expect(deletion.rows).toHaveLength(1);
  expect(deletion.rows[0]?.deletionId).toBeTruthy();
  const originalDeadline = deletion.rows[0]?.purgeAfter;
  time += 60_000;
  expect(await runCollectionBulkPage(work, { route: key.route, operationId })).toBe(false);
  const replayedDeletion = await f.pool.query<{ deletionId: string; purgeAfter: string }>(
    `SELECT deletion_id AS "deletionId",purge_after::text AS "purgeAfter" FROM library.collection_member
     WHERE route=$1 AND collection_id=$2 AND member_id=$3`,
    [routeOf(collection.id), collection.id, selectedSibling.value.id],
  );
  expect(replayedDeletion.rows).toEqual(deletion.rows);
  expect(replayedDeletion.rows[0]?.purgeAfter).toBe(originalDeadline);
}, 120000);
