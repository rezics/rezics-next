import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { DurableInitiatorRecord } from '../../src/access/durable-initiator.ts';
import { createCollectionBulkOperations } from '../../src/library/collection-bulk-operation.ts';
import { executeLibraryRemovalTarget, executeCollectionRemoveTarget, type TargetCommand, type BulkAdmission } from '../../src/library/bulk-contract.ts';
import { previewCollectionBulk, confirmCollectionBulk, pageCollectionBulkManifest, type CollectionBulkTarget } from '../../src/library/collection-bulk-store.ts';
import { createEntryCommands } from '../../src/library/entries.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { authenticateAccount, accountToken } from '../support/admitted-access.ts';
import { createCollectionBatchFixture, entryKey, type CollectionBatchFixture } from './support/collection-batch-fixture.ts';

let f: CollectionBatchFixture;
let entries: ReturnType<typeof createEntryCommands>;
let time = Date.now();
const clock = () => new Date(time);
const operations = () => createCollectionBulkOperations({ ...f, clock });
beforeAll(async () => {
  f = await createCollectionBatchFixture({ clock });
  f.owner.actor = await authenticateAccount(f.access, { pool: f.pool, deadline: Date.now() + 30000 }, {
    ...f.owner.actor,
    scopes: [...f.owner.actor.scopes, 'library_entry:list', 'library_entry:read', 'library_entry:update', 'library_entry:delete'],
  });
  f.owner.bearer = await accountToken(f.owner.actor);
  entries = createEntryCommands({ ...f, clock });
}, 120000);
afterAll(async () => { await f?.close(); });

async function capture(targets: CollectionBulkTarget[], request: BulkAdmission) {
  const accountId = f.owner.actor.accountId, route = routeOf(accountId)!, operationId = newId(route);
  const source = { route, id: operationId, sourceId: operationId, kind: 'library.collectionBulk' };
  // As in the native occurrence executor fixture, durable initiator transport is a component seam.
  // The manifest, effects, retained deletions, Access and native command receipts are real.
  const original: DurableInitiatorRecord = {
    operation: source, actor: f.owner.actor, initiatorAccountId: accountId,
    recordedTransactionId: newId(route), sourceDigest: 'a'.repeat(64),
    originalAccount: { minimumAuthnEpoch: '1', operatorAccountId: null }, originalDelegation: null,
    creation: { commandKind: 'library.collectionBulk.preview', idempotencyKey: operationId,
      requestDigest: 'b'.repeat(64), target: { route, id: accountId } },
  };
  const tx = await f.pool.connect();
  try {
    await tx.query('BEGIN');
    const key = { route, accountId, operationId, now: clock().toISOString() };
    const operation = await previewCollectionBulk(tx, {
      ...key, targets, request, initiator: original, transactionId: original.recordedTransactionId,
      creationReceipt: { partition: partitionOf(route), principalKind: 'account', principalId: accountId,
        commandKind: original.creation.commandKind, key: operationId, digest: original.creation.requestDigest },
    });
    await confirmCollectionBulk(tx, key);
    const rows = await pageCollectionBulkManifest(tx, key);
    await tx.query('COMMIT');
    return {
      operationId,
      commands: rows.map((row): TargetCommand => ({ source, sourceDigest: operation.sourceDigest,
        target: { ...row.target, operationId, ordinal: row.ordinal }, receipt: row.receipt,
        chunkIndex: 0, deadline: Date.now() + 30000 })),
      deps: { ...f, clock, readInitiator: async () => original,
        initiators: { restoreInitiator: async () => f.owner.actor } },
    };
  } finally { tx.release(); }
}
async function entryTarget(subjectId: string): Promise<CollectionBulkTarget> {
  const row = (await f.pool.query(`SELECT incarnation_id,revision,owner_write_seq::text AS seq
    FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
    [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, subjectId])).rows[0];
  return { kind: 'subject', subjectId, requestedSubjectId: null,
    expected: { kind: 'present', incarnation: row.incarnation_id, revision: row.revision, admissionSequence: row.seq } };
}
async function personal(count = 1) {
  const targets = [];
  for (let n = 0; n < count; n++) {
    const subjectId = await f.createSubject('game');
    await entries.putEntry(f.owner.actor, subjectId, { state: 'playing' }, entryKey());
    targets.push(await entryTarget(subjectId));
  }
  return capture(targets, { action: 'remove_from_library', selection: {
    kind: 'explicit', targets: targets.map(({ subjectId }) => ({ subjectId })),
  } });
}

test('reopened typed outcomes preserve the exact personal deletion and deadline, without restoring or leaking authority', async () => {
  const c = await personal(2), command = c.commands[0]!;
  const result = await executeLibraryRemovalTarget(c.deps, command);
  if (result.kind !== 'terminal') throw new Error('Missing native removal');
  const before = await f.inspect(f.owner.actor.accountId);
  const path = `/v1/libraryOperations/${c.operationId}/outcomes?limit=1`;
  const response = await f.send(f.owner.bearer, 'GET', path);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const page = await response.json();
  expect(page.outcomes[0]).toMatchObject({ subjectId: command.target.subjectId,
    deletion: result.evidence.deletion, memberDeletion: null });
  expect(Object.keys(page.outcomes[0]).sort()).toEqual([
    'ordinal', 'subjectId', 'memberId', 'state', 'reason', 'resultingMemberId', 'deletion', 'memberDeletion',
  ].sort());
  expect(await f.inspect(f.owner.actor.accountId)).toEqual(before);
  expect((await operations().outcomes(f.owner.actor, c.operationId, { cursor: page.next })).outcomes[0])
    .toMatchObject({ state: 'pending', deletion: null, memberDeletion: null });
  time += 3600000;
  expect(await executeLibraryRemovalTarget(c.deps, { ...command, deadline: Date.now() + 30000 })).toEqual(result);
  expect((await operations().outcomes(f.owner.actor, c.operationId, {})).outcomes[0]?.deletion)
    .toEqual(result.evidence.deletion);
  const other = await personal();
  await expect(operations().outcomes(f.owner.actor, other.operationId, { cursor: page.next })).rejects.toThrow();
  expect((await f.send('other', 'GET', path)).status).not.toBe(200);
  const withoutSubject = { ...f.owner.actor, scopes: f.owner.actor.scopes.filter((scope) => scope !== 'subject:read') };
  await expect(operations().outcomes(withoutSubject, c.operationId, {})).rejects.toThrow();
  await f.setLibraryOpen(false);
  await f.grantLibraryGate(f.owner.actor.accountId);
  await f.revokeLibraryGate(f.owner.actor.accountId);
  await expect(operations().outcomes(f.owner.actor, c.operationId, {})).rejects.toThrow();
  await f.setLibraryOpen(true);
  const expired = createCollectionBulkOperations({ ...f, clock: () => new Date(time + 49 * 3600000) });
  await expect(expired.outcomes(f.owner.actor, c.operationId, {})).rejects.toThrow();
});

test('skipped targets and missing or misbound stored evidence disclose no deletion', async () => {
  const c = await personal(), command = c.commands[0]!;
  await entries.putEntry(f.owner.actor, command.target.subjectId, { state: 'paused',
    revision: (command.target as { expected: { revision: number } }).expected.revision,
    incarnationId: (command.target as { expected: { incarnation: string } }).expected.incarnation }, entryKey());
  await executeLibraryRemovalTarget(c.deps, command);
  expect((await operations().outcomes(f.owner.actor, c.operationId, {})).outcomes[0])
    .toMatchObject({ state: 'conflict', deletion: null, memberDeletion: null });
  const applied = await personal(), original = applied.commands[0]!;
  await executeLibraryRemovalTarget(applied.deps, original);
  await f.pool.query(`UPDATE library.bulk_target SET evidence=jsonb_set(evidence,'{ordinal}','"1"')
    WHERE route=$1 AND operation_id=$2`, [original.source.route, applied.operationId]);
  expect((await operations().outcomes(f.owner.actor, applied.operationId, {})).outcomes[0]?.deletion).toBeNull();
  await f.pool.query('UPDATE library.bulk_target SET evidence=NULL WHERE route=$1 AND operation_id=$2',
    [original.source.route, applied.operationId]);
  expect((await operations().outcomes(f.owner.actor, applied.operationId, {})).outcomes[0]?.deletion).toBeNull();
});

test('occurrence receipts bind the selected duplicate and require independent current Collection disclosure', async () => {
  const collection = await f.make(), subjectId = await f.createSubject('game');
  const first = await f.add(collection.id, subjectId), second = await f.add(collection.id, subjectId);
  const row = (await f.pool.query(`SELECT member_revision::text AS revision,transaction_id,added_at::text
    FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=$3`,
    [routeOf(collection.id), collection.id, first.id])).rows[0];
  const c = await capture([{ kind: 'occurrence', subjectId, collectionId: collection.id, memberId: first.id,
    expected: { memberRevision: row.revision, transactionId: row.transaction_id, addedAt: row.added_at } }],
    { action: 'remove_from_collection', collectionId: collection.id,
      selection: { kind: 'occurrences', memberIds: [first.id] } });
  const result = await executeCollectionRemoveTarget(c.deps, c.commands[0]!);
  if (result.kind !== 'terminal') throw new Error('Missing native removal');
  const page = await operations().outcomes(f.owner.actor, c.operationId, {});
  expect(page.outcomes[0]).toMatchObject({ memberId: first.id, deletion: null,
    memberDeletion: result.evidence.memberDeletion });
  expect((await f.page(collection.id)).map((m) => m.id)).toEqual([second.id]);
  const withoutCollection = { ...f.owner.actor, scopes: f.owner.actor.scopes.filter((scope) => scope !== 'collection:read') };
  await expect(operations().outcomes(withoutCollection, c.operationId, {})).rejects.toThrow();
  await f.commands.deleteCollection(f.owner.actor, collection.id, (await f.current(collection.id)).revision, entryKey());
  await expect(operations().outcomes(f.owner.actor, c.operationId, {})).rejects.toThrow();
});
