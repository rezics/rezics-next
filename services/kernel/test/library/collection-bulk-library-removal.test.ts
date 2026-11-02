import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { captureDurableInitiator, durableInitiatorCommitment } from '../../src/access/durable-initiator-capture.ts';
import { commandAccessContext } from '../../src/access/command-admission.ts';
import {
  createInitiatorRestorer,
  type DurableInitiatorReader,
  type DurableInitiatorRecord,
} from '../../src/access/durable-initiator.ts';
import { noEffect, principalCommandIdentity } from '../../src/command/command.ts';
import { nativeReceiptKeyCandidates } from '../../src/command/receipt-key.ts';
import {
  executeLibraryRemovalTarget,
  type BulkDependencies,
  type SubjectTarget,
  type TargetCommand,
} from '../../src/library/bulk-contract.ts';
import { createLibraryCommandRunner } from '../../src/library/command-support.ts';
import {
  previewCollectionBulk,
  confirmCollectionBulk,
  pageCollectionBulkManifest,
} from '../../src/library/collection-bulk-store.ts';
import { admitEntryAttempt } from '../../src/library/entry-lifecycle.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { accountToken, authenticateAccount } from '../support/admitted-access.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
let deps: BulkDependencies;
const hash = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
const clock = () => new Date();
beforeAll(async () => {
  f = await createProfileEntryFixture();
  const claims = {
    accountId: f.owner.actor.accountId,
    clientId: f.owner.actor.clientId,
    scopes: [
      ...f.owner.actor.scopes,
      'copy:create',
      'progress_session:create',
      'collection:create',
      'collection:read',
      'collection:update',
    ],
  };
  f.owner.actor = await authenticateAccount(f.access, { pool: f.pool, deadline: Date.now() + 30000 }, claims);
  f.owner.bearer = await accountToken(claims);
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
  const readInitiator: DurableInitiatorReader = async (client, operation) => {
    const row = (
      await client.query(`SELECT initiator FROM library.bulk_operation WHERE route=$1 AND operation_id=$2`, [
        operation.route,
        operation.id,
      ])
    ).rows[0];
    const record = row?.initiator as DurableInitiatorRecord | undefined;
    if (!record || canonicalize(record.operation) !== canonicalize(operation)) return null;
    const receipt = (
      await client.query(
        `SELECT request_digest,response,transaction_id FROM core.receipt
      WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2 AND command_kind=$3 AND idempotency_key=ANY($4::text[])`,
        [
          partitionOf(operation.route),
          record.initiatorAccountId,
          record.creation.commandKind,
          nativeReceiptKeyCandidates(
            client,
            record.creation.commandKind,
            record.initiatorAccountId,
            record.creation.idempotencyKey,
          ),
        ],
      )
    ).rows[0];
    return receipt?.transaction_id === record.recordedTransactionId &&
      Buffer.from(receipt.request_digest).toString('hex') === record.creation.requestDigest &&
      receipt.response.durableInitiator === durableInitiatorCommitment(record)
      ? record
      : null;
  };
  deps = {
    pool: f.pool,
    access: f.access,
    tokens: f.tokens,
    clock,
    readInitiator,
    initiators: createInitiatorRestorer({
      pool: f.pool,
      access: f.access,
      readOperation: readInitiator,
      // Auth transport is a component seam; native capture, receipt verification and Access remain real.
      readConsent: async ({ actorAccountId, clientId }) =>
        actorAccountId === f.owner.actor.accountId && clientId === f.owner.actor.clientId
          ? { actorAccountId, clientId, scopes: f.owner.actor.scopes }
          : null,
    }),
    spendChunk: async () => ({ allowed: true }),
  };
}, 120000);
afterAll(async () => {
  await f?.close();
});

async function capture(subjectId: string): Promise<SubjectTarget> {
  const snapshot = await f.inspect();
  const row = snapshot.entries.find((item) => item.row.subject_id === subjectId)?.row;
  const seq = snapshot.ownerCounter[0]!.row.seq;
  return {
    kind: 'subject',
    operationId: '',
    ordinal: '',
    subjectId,
    requestedSubjectId: null,
    expected: row
      ? {
          kind: 'present',
          incarnation: row.incarnation_id,
          revision: row.revision,
          admissionSequence: String(row.owner_write_seq),
        }
      : { kind: 'absent', slotGeneration: String(seq) },
  };
}
async function preview(targets: SubjectTarget[]): Promise<TargetCommand[]> {
  const actor = f.owner.actor,
    route = routeOf(actor.accountId)!,
    operationId = newId(route);
  const source = { route, id: operationId, kind: 'library.collectionBulk', sourceId: operationId };
  const request = {
    action: 'remove_from_library' as const,
    selection: { kind: 'explicit' as const, targets: targets.map(({ subjectId }) => ({ subjectId })) },
  };
  const selected = targets.map(({ operationId: _id, ordinal: _ordinal, ...target }) => target);
  const input = { request, targets: selected },
    kind = 'library.collectionBulk.preview';
  const creation = {
    commandKind: kind,
    idempotencyKey: operationId,
    requestDigest: hash([principalCommandIdentity(actor), kind, input]),
    target: { route, id: actor.accountId },
  };
  const runner = createLibraryCommandRunner({ pool: f.pool, access: f.access });
  await runner.ownAccountPrepared(
    actor,
    {
      action: 'library_entry:delete',
      kind,
      requestKey: operationId,
      input,
      async prepare(attempt) {
        await admitEntryAttempt(deps, actor, 'library_entry:delete', attempt, Date.now() + 5000);
        return captureDurableInitiator(
          commandAccessContext({ pool: f.pool, deadline: Date.now() + 5000 }, attempt),
          actor,
        );
      },
    },
    async (tx, command, original) => {
      const initiator = {
        operation: source,
        initiatorAccountId: actor.accountId,
        actor,
        recordedTransactionId: command.transactionId,
        sourceDigest: hash(input),
        creation,
        ...original,
      };
      const key = { route, accountId: actor.accountId, operationId };
      const now = clock().toISOString();
      await previewCollectionBulk(tx, {
        ...key,
        request,
        targets: selected,
        initiator,
        transactionId: command.transactionId,
        now,
        creationReceipt: {
          partition: partitionOf(route),
          principalKind: 'account',
          principalId: actor.accountId,
          commandKind: kind,
          key: operationId,
          digest: creation.requestDigest,
        },
      });
      await confirmCollectionBulk(tx, { ...key, now });
      return noEffect({ durableInitiator: durableInitiatorCommitment(initiator) });
    },
  );
  const operation = (
    await f.pool.query('SELECT source_digest FROM library.bulk_operation WHERE route=$1 AND operation_id=$2', [
      route,
      operationId,
    ])
  ).rows[0];
  const rows = await pageCollectionBulkManifest(f.pool, { route, accountId: actor.accountId, operationId });
  return rows.map((row) => ({
    source,
    sourceDigest: operation.source_digest,
    target: { ...row.target, operationId, ordinal: row.ordinal } as SubjectTarget,
    receipt: row.receipt,
    chunkIndex: 0,
    deadline: Date.now() + 5000,
  }));
}
const attempt = (command: TargetCommand) =>
  executeLibraryRemovalTarget(deps, { ...command, deadline: Date.now() + 5000 });
async function put() {
  const subject = await f.createSubject('game');
  return (await f.commands.putEntry(f.owner.actor, subject, { state: 'playing' }, entryKey())).value.entry;
}

test('captured removal retains independent facts, native deletion event and original receipt/deadline across lost response', async () => {
  const entry = await put();
  expect(
    (await f.send('owner', 'POST', '/v1/copies', { subjectId: entry.subjectId, kind: 'physical', status: 'owned' }))
      .status,
  ).toBe(201);
  expect(
    (
      await f.send('owner', 'POST', '/v1/progressSessions', {
        subjectId: entry.subjectId,
        mode: 'scalar_amount',
        unit: 'minute',
      })
    ).status,
  ).toBe(201);
  const created = await f.send('owner', 'POST', '/v1/collections', {
    title: 'Independent occurrences',
    visibility: 'private',
  });
  expect(created.status).toBe(201);
  const collectionId = (await created.json()).collection.id;
  for (let n = 0; n < 2; n++)
    expect(
      (await f.send('owner', 'POST', `/v1/collections/${collectionId}/members`, { subjectId: entry.subjectId })).status,
    ).toBe(201);
  const members = async () =>
    (
      await f.pool.query(
        'SELECT to_jsonb(m) AS row FROM library.collection_member m WHERE route=$1 AND collection_id=$2 ORDER BY member_id',
        [routeOf(collectionId), collectionId],
      )
    ).rows;
  const occurrences = await members();
  const [command] = await preview([await capture(entry.subjectId)]);
  const before = await f.inspect();
  const result = await attempt(command!);
  expect(result.kind).toBe('terminal');
  if (result.kind !== 'terminal') throw new Error('Expected removal');
  expect(result.evidence.outcome).toBe('applied');
  const after = await f.inspect();
  const deletion = after.deletedEntries.find((item) => item.row.deletion_id === result.evidence.transactionId)!.row;
  expect(result.evidence.deletion).toMatchObject({
    deletionId: deletion.deletion_id,
    revision: deletion.deleted_revision,
  });
  expect(Date.parse(result.evidence.deletion!.restoreUntil)).toBe(Date.parse(deletion.restore_until));
  expect(Date.parse(deletion.restore_until) - Date.parse(deletion.deleted_at)).toBe(720 * 60 * 60 * 1000);
  expect(await members()).toEqual(occurrences);
  expect(after.entries.some((item) => item.row.subject_id === entry.subjectId)).toBe(false);
  for (const key of ['copies', 'sessions', 'entitlements', 'follows'] as const) expect(after[key]).toEqual(before[key]);
  expect(
    after.events
      .filter((item) => item.row.transaction_id === result.evidence.transactionId)
      .map((item) => item.row.type),
  ).toEqual(['com.rezics.library.entry.deleted.v1']);
  expect(await attempt(command!)).toEqual(result);
  expect(await f.inspect()).toEqual(after);
  await f.revokeLibraryGate(f.owner.actor.accountId);
  await f.setLibraryOpen(false);
  expect(await attempt(command!)).toEqual(result); // Private accounting after current authority loss.
  expect((await f.inspect()).deletedEntries).toEqual(after.deletedEntries);
  await f.setLibraryOpen(true);
}, 120000);

test('edited, recreated and absent ABA slots conflict individually while another captured entry completes', async () => {
  const edited = await put(),
    recreated = await put(),
    unchanged = await put();
  const absentId = await f.createSubject('game');
  const commands = await preview(
    await Promise.all([edited.subjectId, recreated.subjectId, absentId, unchanged.subjectId].map(capture)),
  );
  await f.commands.putEntry(
    f.owner.actor,
    edited.subjectId,
    { state: 'planned', revision: edited.revision, incarnationId: edited.incarnationId! },
    entryKey(),
  );
  await f.commands.deleteEntry(
    f.owner.actor,
    recreated.subjectId,
    recreated.revision,
    entryKey(),
    recreated.incarnationId!,
  );
  const replacement = await f.commands.putEntry(f.owner.actor, recreated.subjectId, { state: 'playing' }, entryKey());
  const transient = (await f.commands.putEntry(f.owner.actor, absentId, { state: 'planned' }, entryKey())).value.entry;
  await f.commands.deleteEntry(f.owner.actor, absentId, transient.revision, entryKey(), transient.incarnationId!);
  const results = [];
  for (const command of commands) results.push(await attempt(command));
  expect(
    results.map((result) => (result.kind === 'terminal' ? [result.evidence.outcome, result.evidence.reason] : result)),
  ).toEqual([
    ['conflict', 'revision_mismatch'],
    ['conflict', 'revision_mismatch'],
    ['conflict', 'revision_mismatch'],
    ['applied', null],
  ]);
  expect(await f.commands.readEntry(f.owner.actor, recreated.subjectId)).toEqual(replacement.value.entry);
  const fresh = await put(),
    [denied] = await preview([await capture(fresh.subjectId)]);
  await f.setLibraryOpen(false);
  const before = await f.inspect();
  expect(await attempt(denied!)).toEqual({ kind: 'stop', reason: 'authority_lost' });
  expect(await f.inspect()).toEqual(before);
  await f.setLibraryOpen(true);
}, 120000);
