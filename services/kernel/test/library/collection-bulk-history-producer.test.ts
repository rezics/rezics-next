import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { DurableInitiatorRecord } from '../../src/access/durable-initiator.ts';
import { createLifecycleCommands } from '../../src/access/lifecycle.ts';
import { HistorySealedError } from '../../src/history/contract/errors.ts';
import { ACCOUNT_ROLE_BITS as R } from '../../src/history/contract/contracts.ts';
import { decodeLocator } from '../../src/history/contract/locator.ts';
import { commandHistoryKind } from '../../src/history/application/records.ts';
import {
  confirmCollectionBulk,
  pageCollectionBulkManifest,
  previewCollectionBulk,
  type CollectionBulkTarget,
} from '../../src/library/collection-bulk-store.ts';
import { executeCollectionAddTarget } from '../../src/library/collection-bulk-add.ts';
import { executeCollectionRemoveTarget } from '../../src/library/collection-bulk-remove.ts';
import type { BulkAdmission, BulkDependencies, TargetCommand } from '../../src/library/bulk-contract.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  createCollectionBatchFixture,
  batchScopes,
  entryKey,
  type CollectionBatchFixture,
} from './support/collection-batch-fixture.ts';
import { testTokens } from '../support/test-kernel.ts';

let f: CollectionBatchFixture;

beforeAll(async () => {
  f = await createCollectionBatchFixture();
}, 120_000);

afterAll(async () => {
  await f?.close();
});

async function capture(
  actor: AccountActor,
  request: BulkAdmission,
  targets: readonly CollectionBulkTarget[],
): Promise<{ command: TargetCommand; dependencies: BulkDependencies }> {
  const route = routeOf(actor.accountId)!;
  const operationId = newId(route);
  const source = { route, id: operationId, sourceId: operationId, kind: 'library.collectionBulk.operation' };
  const initiator: DurableInitiatorRecord = {
    operation: source,
    initiatorAccountId: actor.accountId,
    actor,
    recordedTransactionId: newId(route),
    sourceDigest: 'a'.repeat(64),
    originalDelegation: null,
    originalAccount: { minimumAuthnEpoch: String(actor.authnEpoch), operatorAccountId: null },
    creation: {
      commandKind: 'library.collectionBulk.preview',
      idempotencyKey: entryKey(),
      requestDigest: createHash('sha256').update(operationId).digest('hex'),
      target: { route, id: actor.accountId },
    },
  };
  const tx = await f.pool.connect();
  let sourceDigest = '';
  let command!: TargetCommand;
  try {
    await tx.query('BEGIN');
    const input = { route, accountId: actor.accountId, operationId };
    const operation = await previewCollectionBulk(tx, {
      ...input,
      request,
      targets,
      initiator,
      transactionId: initiator.recordedTransactionId,
      now: new Date().toISOString(),
      creationReceipt: {
        partition: partitionOf(route),
        principalKind: 'account',
        principalId: actor.accountId,
        commandKind: initiator.creation.commandKind,
        key: initiator.creation.idempotencyKey,
        digest: initiator.creation.requestDigest,
      },
    });
    sourceDigest = operation.sourceDigest;
    await confirmCollectionBulk(tx, { ...input, now: new Date().toISOString() });
    const [row] = await pageCollectionBulkManifest(tx, { ...input, limit: 1 });
    if (!row) throw new Error('Bulk target was not persisted');
    command = {
      source,
      sourceDigest,
      target: { ...row.target, operationId, ordinal: row.ordinal },
      receipt: row.receipt,
      identity: { clientId: actor.clientId, requestedBy: actor.requestedBy },
      chunkIndex: 0,
      deadline: Date.now() + 30_000,
    };
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
  const dependencies: BulkDependencies = {
    pool: f.pool,
    access: f.access,
    tokens: testTokens(),
    clock: () => new Date(),
    readInitiator: async () => initiator,
    initiators: {
      async restoreInitiator(input) {
        expect(input.operation).toEqual(source);
        return actor;
      },
    },
  };
  return { command, dependencies };
}

async function expectTargetHistory(
  actor: AccountActor,
  curatorId: string,
  transactionId: string,
  emitsEvent: boolean,
): Promise<void> {
  const partition = partitionOf(routeOf(curatorId)!);
  const receipt = (
    await f.pool.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM core.receipt
       WHERE partition_no=$1 AND transaction_id=$2 AND command_kind=$3`,
      [partition, transactionId, 'library.collectionBulk.target'],
    )
  ).rows[0];
  expect(receipt).toBeTruthy();
  const [namespace, version, token] = receipt!.idempotency_key.split('.');
  expect(namespace).toBe('rk1');
  const receiptToken = Buffer.from(token!, 'base64url').toString('hex');
  const outbox = await f.pool.query<{ position: string; event_seq: number }>(
    `SELECT position::text AS position,event_seq FROM core.outbox
     WHERE partition_no=$1 AND transaction_id=$2 ORDER BY event_seq`,
    [partition, transactionId],
  );
  const candidates = await f.pool.query<{
    account_id: string;
    roles: number;
    artifact_type: 'command-receipt/v1' | 'outbox-event/v1';
    locator: Buffer;
  }>(
    `SELECT account_id,roles,artifact_type,locator FROM core.history_locator
     WHERE partition_no=$1 AND account_route=ANY($2::integer[]) AND account_id=ANY($3::uuid[])`,
    [partition, [routeOf(actor.accountId), routeOf(curatorId)], [actor.accountId, curatorId]],
  );
  const receiptRoles = candidates.rows
    .filter(({ artifact_type, locator }) => {
      if (artifact_type !== 'command-receipt/v1') return false;
      const decoded = decodeLocator('command-receipt/v1', locator);
      return (
        decoded.artifactType === artifact_type &&
        decoded.principalId === actor.accountId &&
        decoded.commandKindId === 4000 &&
        decoded.keyVersion === Number(version) &&
        decoded.keyToken === receiptToken
      );
    })
    .map(({ account_id, roles }) => ({ account_id, roles }))
    .sort((a, b) => a.account_id.localeCompare(b.account_id));
  expect(receiptRoles).toEqual(
    [
      { account_id: actor.accountId, roles: R.actor | R.principal | R['acting-human'] },
      { account_id: curatorId, roles: R.owner },
    ].sort((a, b) => a.account_id.localeCompare(b.account_id)),
  );

  const eventRows = candidates.rows
    .filter(({ artifact_type, locator }) => {
      if (artifact_type !== 'outbox-event/v1') return false;
      const decoded = decodeLocator('outbox-event/v1', locator);
      return (
        decoded.artifactType === artifact_type &&
        outbox.rows.some((event) => decoded.position === BigInt(event.position) && decoded.eventSeq === event.event_seq)
      );
    })
    .map(({ account_id, roles }) => ({ account_id, roles }))
    .sort((a, b) => a.account_id.localeCompare(b.account_id));
  expect(eventRows).toEqual(
    emitsEvent
      ? [
          { account_id: actor.accountId, roles: R.actor | R.principal | R['acting-human'] },
          { account_id: curatorId, roles: R.owner },
        ].sort((a, b) => a.account_id.localeCompare(b.account_id))
      : [],
  );
}

test('remote add and remove receipts retain verified actor and curator roles with exact event scopes', async () => {
  expect(commandHistoryKind(4000)).toBe('library.collectionBulk.target');
  const actor = f.owner.actor;
  const curator = await f.identity(batchScopes, 1);
  const collection = (
    await f.commands.createCollection(
      curator.actor,
      { title: 'Remote bulk custody', visibility: 'private' },
      entryKey(),
    )
  ).value;
  await f.grant(collection.id, actor.accountId);
  const subjectId = await f.createSubject('game');
  await f.commands.addMember(curator.actor, collection.id, { subjectId }, entryKey());
  const route = routeOf(actor.accountId)!;
  const counter = await f.pool.query<{ seq: string | null }>(
    'SELECT seq::text AS seq FROM library.owner_write_counter WHERE route=$1 AND account_id=$2',
    [route, actor.accountId],
  );
  const target = {
    kind: 'subject' as const,
    collectionId: collection.id,
    subjectId,
    requestedSubjectId: null,
    expected: { kind: 'absent' as const, slotGeneration: counter.rows[0]?.seq ?? '0' },
  };
  const add = await capture(
    actor,
    {
      action: 'add_to_collection',
      collectionId: collection.id,
      selection: { kind: 'explicit', targets: [{ subjectId }] },
    },
    [target],
  );
  const added = await executeCollectionAddTarget(add.dependencies, add.command);
  expect(added.kind).toBe('terminal');
  if (added.kind !== 'terminal') throw new Error('Expected a committed Collection add receipt');
  expect(await executeCollectionAddTarget(add.dependencies, add.command)).toEqual(added);
  await expectTargetHistory(actor, curator.actor.accountId, added.evidence.transactionId!, false);

  const member = (
    await f.pool.query<{ memberId: string; revision: string; transactionId: string; addedAt: string }>(
      `SELECT member_id AS "memberId",member_revision::text AS revision,
        transaction_id AS "transactionId",added_at::text AS "addedAt"
       FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND subject_id=$3 AND deletion_id IS NULL`,
      [routeOf(collection.id), collection.id, subjectId],
    )
  ).rows[0]!;
  const remove = await capture(
    actor,
    {
      action: 'remove_from_collection',
      collectionId: collection.id,
      selection: { kind: 'occurrences', memberIds: [member.memberId] },
    },
    [
      {
        kind: 'occurrence',
        collectionId: collection.id,
        memberId: member.memberId,
        subjectId,
        expected: {
          memberRevision: member.revision,
          transactionId: member.transactionId,
          addedAt: member.addedAt,
        },
      },
    ],
  );
  const removed = await executeCollectionRemoveTarget(remove.dependencies, remove.command);
  expect(removed).toMatchObject({ kind: 'terminal', evidence: { outcome: 'applied' } });
  if (removed.kind !== 'terminal') throw new Error('Expected a committed Collection removal');
  expect(await executeCollectionRemoveTarget(remove.dependencies, remove.command)).toEqual(removed);
  await expectTargetHistory(actor, curator.actor.accountId, removed.evidence.transactionId!, true);
});

test('a sealed curator locator fence rolls back the remote target receipt and Collection effect', async () => {
  const actor = f.owner.actor;
  const curator = await f.identity(batchScopes, 2);
  const collection = (
    await f.commands.createCollection(
      curator.actor,
      { title: 'Fenced bulk custody', visibility: 'private' },
      entryKey(),
    )
  ).value;
  await f.grant(collection.id, actor.accountId);
  const subjectId = await f.createSubject('game');
  const command = await capture(
    actor,
    {
      action: 'add_to_collection',
      collectionId: collection.id,
      selection: { kind: 'explicit', targets: [{ subjectId }] },
    },
    [
      {
        kind: 'subject',
        collectionId: collection.id,
        subjectId,
        requestedSubjectId: null,
        expected: { kind: 'absent', slotGeneration: '0' },
      },
    ],
  );
  const curatorRoute = routeOf(curator.actor.accountId)!;
  const partition = partitionOf(routeOf(collection.id)!);
  await f.pool.query(
    `INSERT INTO core.history_seal(partition_no,account_route,account_id,barrier_id,phase)
     VALUES($1,$2,$3,$4,'sealed') ON CONFLICT(partition_no,account_route,account_id)
     DO UPDATE SET barrier_id=EXCLUDED.barrier_id,phase=EXCLUDED.phase`,
    [partition, curatorRoute, curator.actor.accountId, newId(curatorRoute)],
  );
  await expect(executeCollectionAddTarget(command.dependencies, command.command)).rejects.toBeInstanceOf(
    HistorySealedError,
  );
  expect(
    (
      await f.pool.query(
        `SELECT 1 FROM library.collection_member
         WHERE route=$1 AND collection_id=$2 AND subject_id=$3 AND deletion_id IS NULL`,
        [routeOf(collection.id), collection.id, subjectId],
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await f.pool.query(
        `SELECT 1 FROM core.receipt WHERE partition_no=$1 AND principal_id=$2
         AND command_kind='library.collectionBulk.target' AND request_digest=decode($3,'hex')`,
        [partition, actor.accountId, command.command.receipt.digest],
      )
    ).rowCount,
  ).toBe(0);
});

test('source erasure after capture prevents remote add and removal receipts and effects', async () => {
  const source = await f.identity([...batchScopes, 'account:delete'], 2);
  const curator = await f.identity(batchScopes, 1);
  const collection = (
    await f.commands.createCollection(
      curator.actor,
      { title: 'Erased source bulk custody', visibility: 'private' },
      entryKey(),
    )
  ).value;
  await f.grant(collection.id, source.actor.accountId);

  const addSubjectId = await f.createSubject('game', 'Late bulk add');
  const removeSubjectId = await f.createSubject('game', 'Late bulk removal');
  await f.commands.addMember(curator.actor, collection.id, { subjectId: removeSubjectId }, entryKey());
  const member = (
    await f.pool.query<{ memberId: string; revision: string; transactionId: string; addedAt: string }>(
      `SELECT member_id AS "memberId",member_revision::text AS revision,
        transaction_id AS "transactionId",added_at::text AS "addedAt"
       FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND subject_id=$3 AND deletion_id IS NULL`,
      [routeOf(collection.id), collection.id, removeSubjectId],
    )
  ).rows[0]!;
  const sourceRoute = routeOf(source.actor.accountId)!;
  const counter = await f.pool.query<{ seq: string | null }>(
    'SELECT seq::text AS seq FROM library.owner_write_counter WHERE route=$1 AND account_id=$2',
    [sourceRoute, source.actor.accountId],
  );
  const add = await capture(
    source.actor,
    {
      action: 'add_to_collection',
      collectionId: collection.id,
      selection: { kind: 'explicit', targets: [{ subjectId: addSubjectId }] },
    },
    [
      {
        kind: 'subject',
        collectionId: collection.id,
        subjectId: addSubjectId,
        requestedSubjectId: null,
        expected: { kind: 'absent', slotGeneration: counter.rows[0]?.seq ?? '0' },
      },
    ],
  );
  const remove = await capture(
    source.actor,
    {
      action: 'remove_from_collection',
      collectionId: collection.id,
      selection: { kind: 'occurrences', memberIds: [member.memberId] },
    },
    [
      {
        kind: 'occurrence',
        collectionId: collection.id,
        memberId: member.memberId,
        subjectId: removeSubjectId,
        expected: {
          memberRevision: member.revision,
          transactionId: member.transactionId,
          addedAt: member.addedAt,
        },
      },
    ],
  );

  await createLifecycleCommands({ pool: f.pool, access: f.access }).tombstone(
    { actor: source.actor, deadline: Date.now() + 30_000 },
    { accountId: source.actor.accountId, key: entryKey() },
  );
  const added = await executeCollectionAddTarget(add.dependencies, add.command);
  const removed = await executeCollectionRemoveTarget(remove.dependencies, remove.command);
  expect(added).toMatchObject({ kind: 'terminal', evidence: { outcome: 'denied' } });
  expect(removed).toMatchObject({ kind: 'terminal', evidence: { outcome: 'denied' } });

  expect(
    (
      await f.pool.query(
        `SELECT 1 FROM library.collection_member
         WHERE route=$1 AND collection_id=$2 AND subject_id=$3 AND deletion_id IS NULL`,
        [routeOf(collection.id), collection.id, addSubjectId],
      )
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await f.pool.query(
        `SELECT 1 FROM library.collection_member
         WHERE route=$1 AND collection_id=$2 AND member_id=$3 AND deletion_id IS NULL`,
        [routeOf(collection.id), collection.id, member.memberId],
      )
    ).rowCount,
  ).toBe(1);
  for (const command of [add.command, remove.command])
    expect(
      (
        await f.pool.query(
          `SELECT 1 FROM core.receipt WHERE partition_no=$1 AND principal_id=$2
           AND command_kind='library.collectionBulk.target' AND request_digest=decode($3,'hex')`,
          [command.receipt.partition, command.receipt.principalId, command.receipt.digest],
        )
      ).rowCount,
    ).toBe(0);
});
