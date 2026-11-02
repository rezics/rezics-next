import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { DurableInitiatorRecord } from '../../src/access/durable-initiator.ts';
import { executeCollectionRemoveTarget, type BulkDependencies, type TargetCommand } from '../../src/library/bulk-contract.ts';
import { previewCollectionBulk, confirmCollectionBulk, pageCollectionBulkManifest } from '../../src/library/collection-bulk-store.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { testTokens } from '../support/test-kernel.ts';
import { createCollectionBatchFixture, entryKey, type CollectionBatchFixture } from './support/collection-batch-fixture.ts';

let f: CollectionBatchFixture;
let time = Date.now();
beforeAll(async () => { f = await createCollectionBatchFixture({ clock: () => new Date(time) }); }, 120000);
afterAll(async () => { await f?.close(); });

async function capture(collectionId: string, memberIds: string[]) {
  const route = routeOf(f.owner.actor.accountId)!;
  const operationId = newId(route);
  const source = { route, id: operationId, sourceId: operationId, kind: 'library.collectionBulk' };
  const original = {
    operation: source, initiatorAccountId: f.owner.actor.accountId, actor: f.owner.actor,
    recordedTransactionId: newId(route), sourceDigest: 'a'.repeat(64),
    originalAccount: { minimumAuthnEpoch: '1', operatorAccountId: null }, originalDelegation: null,
    creation: { commandKind: 'library.collectionBulk.preview', idempotencyKey: entryKey(),
      requestDigest: 'b'.repeat(64), target: { route, id: operationId } },
  } satisfies DurableInitiatorRecord;
  const rows = await f.pool.query(
    `SELECT member_id AS id, subject_id AS subject, member_revision::text AS revision,
      transaction_id AS transaction, added_at::text AS added
     FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=ANY($3::uuid[])`,
    [routeOf(collectionId), collectionId, memberIds],
  );
  const tx = await f.pool.connect();
  let commands: TargetCommand[];
  try {
    await tx.query('BEGIN');
    const input = { route, operationId, accountId: f.owner.actor.accountId, now: new Date(time).toISOString() };
    const operation = await previewCollectionBulk(tx, {
      ...input, transactionId: original.recordedTransactionId, initiator: original,
      request: { action: 'remove_from_collection', collectionId, selection: { kind: 'occurrences', memberIds } },
      creationReceipt: { partition: partitionOf(route), principalKind: 'account', principalId: input.accountId,
        commandKind: original.creation.commandKind, key: original.creation.idempotencyKey,
        digest: original.creation.requestDigest },
      targets: memberIds.map(id => {
        const row = rows.rows.find(row => row.id === id)!;
        return { kind: 'occurrence', collectionId, memberId: id, subjectId: row.subject, revision: Number(row.revision),
          expected: { memberRevision: row.revision, transactionId: row.transaction, addedAt: row.added } };
      }),
    });
    await confirmCollectionBulk(tx, input);
    commands = (await pageCollectionBulkManifest(tx, input)).map(row => ({
      source, sourceDigest: operation.sourceDigest, target: { ...row.target, operationId, ordinal: row.ordinal },
      receipt: row.receipt, chunkIndex: 0, deadline: Date.now() + 30000,
    }));
    await tx.query('COMMIT');
  } finally { tx.release(); }
  // The trusted operation-reader/restorer ports are component doubles. Effects still use native Access,
  // commands, receipts, tombstones and outbox; durable provenance itself has its own native suite.
  let restored = 0;
  const deps: BulkDependencies = { pool: f.pool, access: f.access, tokens: testTokens(), clock: () => new Date(time),
    readInitiator: async () => original,
    initiators: { async restoreInitiator(input) { expect(input.operation).toEqual(source); restored++; return f.owner.actor; } },
    spendChunk: async () => { throw new Error('The action must not introduce funding'); },
  };
  return { deps, commands: commands!, restored: () => restored };
}
async function member(collectionId: string, memberId: string) {
  return (await f.pool.query(`SELECT deletion_id, deletion_revision::text, purge_after::text, transaction_id,
    ordinal_key FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=$3`,
  [routeOf(collectionId), collectionId, memberId])).rows[0];
}

test('captured occurrence removal preserves an unselected duplicate, ordering, native event and explicit Undo', async () => {
  const collection = await f.make();
  const subject = await f.createSubject('game');
  const first = await f.add(collection.id, subject), second = await f.add(collection.id, subject);
  const third = await f.add(collection.id, await f.createSubject('game'));
  const before = await member(collection.id, second.id);
  const c = await capture(collection.id, [first.id]);
  const result = await executeCollectionRemoveTarget(c.deps, c.commands[0]!);
  expect(result.kind).toBe('terminal');
  if (result.kind !== 'terminal') throw new Error('Missing result');
  expect(result.evidence.outcome).toBe('applied');
  expect((await f.page(collection.id)).map(m => m.id)).toEqual([second.id, third.id]);
  expect(await member(collection.id, second.id)).toEqual(before);
  const events = await f.pool.query(`SELECT e.type,e.data FROM core.outbox e JOIN editorial.write_basis b
    USING(partition_no,epoch,position) WHERE e.partition_no=$1 AND b.transaction_id=$2`,
    [partitionOf(routeOf(collection.id)!), result.evidence.transactionId]);
  expect(events.rows).toContainEqual({ type: 'com.rezics.library.collection.member.changed.v1',
    data: { collectionId: collection.id, memberId: first.id, subjectId: subject } });
  const deletion = result.evidence.memberDeletion!;
  const terminal = await f.pool.query('SELECT state,evidence FROM library.bulk_target WHERE route=$1 AND operation_id=$2 AND ordinal=0',
    [c.commands[0]!.source.route, c.commands[0]!.source.id]);
  expect(terminal.rows).toEqual([{ state: 'applied', evidence: result.evidence }]);
  await f.commands.restoreMember(f.owner.actor, collection.id, first.id, deletion, entryKey());
  expect((await f.page(collection.id)).map(m => m.id)).toEqual([first.id, second.id, third.id]);
}, 120000);

test('changed, replaced and missing captured occurrences are skipped individually without selecting later duplicates', async () => {
  const collection = await f.make(), subject = await f.createSubject('game');
  const members = [await f.add(collection.id, subject), await f.add(collection.id, subject)];
  const c = await capture(collection.id, members.map(m => m.id));
  await f.commands.updateMemberNote(f.owner.actor, collection.id, members[0]!.id, 'changed after preview', entryKey());
  const later = await f.add(collection.id, subject);
  const results = [];
  for (const command of c.commands) results.push(await executeCollectionRemoveTarget(c.deps, command));
  expect(results.map(r => r.kind === 'terminal' && [r.evidence.outcome, r.evidence.reason]))
    .toEqual([['conflict', 'revision_mismatch'], ['applied', null]]);
  expect((await f.page(collection.id)).map(m => m.id)).toEqual([members[0]!.id, later.id]);
  const replacement = await capture(collection.id, [later.id]);
  const removed = await f.commands.removeMember(f.owner.actor, collection.id, later.id, (await f.current(collection.id)).revision, entryKey());
  await f.commands.restoreMember(f.owner.actor, collection.id, later.id, removed.value, entryKey());
  const skipped = await executeCollectionRemoveTarget(replacement.deps, replacement.commands[0]!);
  expect(skipped.kind === 'terminal' && skipped.evidence.outcome).toBe('conflict');
  const missing = await capture(collection.id, [later.id]);
  await f.commands.removeMember(f.owner.actor, collection.id, later.id, (await f.current(collection.id)).revision, entryKey());
  const absent = await executeCollectionRemoveTarget(missing.deps, missing.commands[0]!);
  expect(absent.kind === 'terminal' && absent.evidence.outcome).toBe('no_effect');
}, 120000);

test('lost response and exact replay preserve one removal receipt/deadline; authority refusal permits only private recovery', async () => {
  const curator = await f.identity([...f.owner.actor.scopes]);
  const collection = await f.make('private', curator), subject = await f.createSubject('game');
  await f.grant(collection.id, f.owner.actor.accountId);
  const first = await f.add(collection.id, subject), second = await f.add(collection.id, subject);
  const c = await capture(collection.id, [first.id, second.id]);
  const lost = await executeCollectionRemoveTarget(c.deps, c.commands[0]!);
  expect(lost.kind === 'terminal' && lost.evidence.outcome).toBe('applied');
  const saved = await member(collection.id, first.id);
  time += 60_000;
  expect(await executeCollectionRemoveTarget(c.deps, c.commands[0]!)).toEqual(lost);
  expect(c.restored()).toBe(2);
  // Real current Access refusal, even though the restorer component port returns the original actor.
  await f.grant(collection.id, f.owner.actor.accountId, true);
  expect(await executeCollectionRemoveTarget(c.deps, c.commands[0]!)).toEqual(lost);
  const refused = await executeCollectionRemoveTarget(c.deps, c.commands[1]!);
  expect(refused.kind === 'terminal' && refused.evidence.outcome).toBe('denied');
  expect(await member(collection.id, first.id)).toEqual(saved);
  expect((await member(collection.id, second.id)).deletion_id).toBeNull();
  const receipts = await f.pool.query('SELECT count(*)::integer AS count FROM core.receipt WHERE partition_no=$1 AND principal_id=$2 AND command_kind=$3',
    [c.commands[0]!.receipt.partition, f.owner.actor.accountId, c.commands[0]!.receipt.commandKind]);
  expect(receipts.rows[0].count).toBe(1);
}, 120000);
