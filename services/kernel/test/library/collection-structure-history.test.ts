import { afterAll, beforeAll, expect, test } from 'bun:test';
import { runCommand, noEffect as commandNoEffect, authoritativeTimeValue } from '../../src/command/command.ts';
import { withConnection } from '../../src/database/pool.ts';
import { addCollectionMemberIfAbsentNative, createCollectionCommands } from '../../src/library/collections.ts';
import * as store from '../../src/library/collection-store.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let commands: ReturnType<typeof createCollectionCommands>;

beforeAll(async () => {
  f = await createProfileEntryFixture();
  owner = await f.identity([
    'subject:read',
    'collection:create',
    'collection:read',
    'collection:update',
    'collection:delete',
  ]);
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
  commands = createCollectionCommands({ pool: f.pool, access: f.access });
}, 120000);

afterAll(async () => {
  await f?.close();
});

async function make(visibility: 'private' | 'public' = 'private') {
  return (await commands.createCollection(owner.actor, { title: 'Structure history', visibility }, entryKey())).value;
}

async function add(collectionId: string, subjectId: string, note: string) {
  return (await commands.addMember(owner.actor, collectionId, { subjectId, note }, entryKey())).value;
}

async function history(collectionId: string) {
  const response = await f.send(owner.bearer, 'GET', `/v1/collections/${collectionId}/structure-history`);
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<{
    changes: {
      address: string;
      operation: string;
      occurrenceId: string;
      subjectContext: { state: string };
      before: { note: string | null } | null;
      after: { note: string | null } | null;
    }[];
    coverage: { historyBeforeTracking: string; hasPrunedGaps: boolean };
  }>;
}

test('private history journals actual occurrence edits once and preserves truthful coverage', async () => {
  const collection = await make();
  const subjectId = await f.createSubject('game');
  const first = await add(collection.id, subjectId, 'first note');
  const second = await add(collection.id, subjectId, 'second note');
  expect(first.id).not.toBe(second.id);

  const skipped = await runCommand(
    f.pool,
    { partition: partitionOf(routeOf(collection.id)!), deadline: Date.now() + 30000 },
    async (tx, context) => {
      const effect = await addCollectionMemberIfAbsentNative(tx, owner.actor, collection.id, subjectId, {
        transactionId: context.transactionId,
        time: authoritativeTimeValue(context.time),
      });
      return effect.state === 'no_effect' ? commandNoEffect(effect) : { value: effect, events: effect.events };
    },
  );
  expect(skipped.value.state).toBe('no_effect');

  const noteKey = entryKey();
  await commands.updateMemberNote(owner.actor, collection.id, first.id, { note: 'edited note' }, noteKey);
  const afterNote = await f.pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM library.collection_structure_history WHERE route=$1 AND collection_id=$2',
    [routeOf(collection.id), collection.id],
  );
  const replay = await commands.updateMemberNote(
    owner.actor,
    collection.id,
    first.id,
    { note: 'edited note' },
    noteKey,
  );
  expect(replay.replayed).toBe(true);
  expect(
    (
      await f.pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM library.collection_structure_history WHERE route=$1 AND collection_id=$2',
        [routeOf(collection.id), collection.id],
      )
    ).rows[0]?.count,
  ).toBe(afterNote.rows[0]?.count);

  await commands.moveMember(owner.actor, collection.id, first.id, { after: second.id }, entryKey());
  const removed = await commands.removeMember(owner.actor, collection.id, second.id, entryKey());
  await commands.restoreMember(
    owner.actor,
    collection.id,
    second.id,
    { deletionId: removed.value.deletionId, revision: removed.value.revision },
    entryKey(),
  );

  const page = await history(collection.id);
  expect(page.changes.map((change) => change.operation)).toEqual([
    'restored',
    'deleted',
    'moved',
    'note_changed',
    'added',
    'added',
  ]);
  expect(page.changes.every((change) => change.subjectContext.state === 'withheld')).toBe(true);
  const noteChange = page.changes.find((change) => change.operation === 'note_changed')!;
  expect(noteChange).toMatchObject({
    occurrenceId: first.id,
    before: { note: 'first note' },
    after: { note: 'edited note' },
  });
  expect(page.coverage).toMatchObject({
    historyBeforeTracking: 'collection_created_after_installation',
    hasPrunedGaps: false,
  });

  const compare = await f.send(
    owner.bearer,
    'GET',
    `/v1/collections/${collection.id}/structure-history/compare?addresses=${encodeURIComponent(noteChange.address)}`,
  );
  expect(compare.status, await compare.clone().text()).toBe(200);
  expect(await compare.json()).toMatchObject({ status: 'ready', changes: [{ occurrenceId: first.id }] });

  const beforeRespace = (await history(collection.id)).changes.length;
  await withConnection(f.pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('SET CONSTRAINTS library.collection_member_ordinal_key DEFERRED');
      const members = await client.query<{ memberId: string }>(
        'SELECT member_id::text AS "memberId" FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND deletion_id IS NULL ORDER BY ordinal_key,member_id',
        [routeOf(collection.id), collection.id],
      );
      await store.respaceMembers(
        client,
        routeOf(collection.id)!,
        collection.id,
        members.rows.map((member, index) => ({
          memberId: member.memberId,
          ordinalKey: `zz-history-${String(index).padStart(4, '0')}`,
        })),
        { transactionId: entryKey(), time: new Date().toISOString() },
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  expect((await history(collection.id)).changes).toHaveLength(beforeRespace);

  const rolledBackMemberId = newId(routeOf(collection.id)!);
  const beforeRollback = (await history(collection.id)).changes.length;
  await withConnection(f.pool, async (client) => {
    await client.query('BEGIN');
    await store.insertMember(
      client,
      routeOf(collection.id)!,
      collection.id,
      { id: rolledBackMemberId, subjectId, note: 'rolled back', ordinalKey: 'zzzz-history-rollback' },
      { transactionId: entryKey(), time: new Date().toISOString() },
    );
    await client.query('ROLLBACK');
  });
  expect((await history(collection.id)).changes).toHaveLength(beforeRollback);
});

test('same-home transfer and bounded batch removal journal both Collection sides atomically', async () => {
  const source = await make();
  const destination = await make();
  const subjectId = await f.createSubject('game');
  const member = await add(source.id, subjectId, 'keep this note');
  const sourceCurrent = await f.send(owner.bearer, 'GET', `/v1/collections/${source.id}`);
  const destinationCurrent = await f.send(owner.bearer, 'GET', `/v1/collections/${destination.id}`);
  const sourceRevision = (await sourceCurrent.json()).collection.revision as number;
  const destinationRevision = (await destinationCurrent.json()).collection.revision as number;
  const moved = await f.send(
    owner.bearer,
    'POST',
    `/v1/collections/${source.id}/members:move`,
    {
      revision: sourceRevision,
      memberIds: [member.id],
      destinationCollectionId: destination.id,
      destinationRevision,
      after: null,
    },
    entryKey(),
  );
  expect(moved.status, await moved.clone().text()).toBe(200);

  const transfer = await f.pool.query<{ collectionId: string; kind: string; memberId: string; transactionId: string }>(
    `SELECT collection_id::text AS "collectionId",change_kind AS kind,member_id::text AS "memberId",
            transaction_id::text AS "transactionId"
       FROM library.collection_structure_history
      WHERE route=$1 AND member_id=$2 AND change_kind IN ('transferred_in','transferred_out')
      ORDER BY collection_id,change_no`,
    [routeOf(source.id), member.id],
  );
  expect(transfer.rows).toHaveLength(2);
  expect(transfer.rows.find((row) => row.collectionId === source.id)?.kind).toBe('transferred_out');
  expect(transfer.rows.find((row) => row.collectionId === destination.id)?.kind).toBe('transferred_in');
  expect(new Set(transfer.rows.map((row) => row.transactionId)).size).toBe(1);

  const current = await f.send(owner.bearer, 'GET', `/v1/collections/${destination.id}`);
  const revision = (await current.json()).collection.revision as number;
  const removed = await f.send(
    owner.bearer,
    'POST',
    `/v1/collections/${destination.id}/members:batchRemove`,
    { revision, memberIds: [member.id] },
    entryKey(),
  );
  expect(removed.status, await removed.clone().text()).toBe(200);
  const changes = await history(destination.id);
  expect(changes.changes.map((change) => change.operation)).toEqual(['deleted', 'transferred_in']);
});

test('pre-installation coverage is unknown, pruning retires addresses, and public readers get no private history', async () => {
  const collection = await make();
  const subjectId = await f.createSubject('game');
  const member = await add(collection.id, subjectId, 'private note');
  await f.pool.query('DELETE FROM library.collection_structure_history_head WHERE route=$1 AND collection_id=$2', [
    routeOf(collection.id),
    collection.id,
  ]);
  await add(collection.id, await f.createSubject('game'), 'after tracking gap');
  const page = await history(collection.id);
  expect(page.coverage.historyBeforeTracking).toBe('unknown_before_installation');
  const selected = page.changes.find((change) => change.occurrenceId === member.id)!;

  await withConnection(f.pool, async (client) => {
    await client.query('BEGIN');
    await client.query('DELETE FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=$3', [
      routeOf(collection.id),
      collection.id,
      member.id,
    ]);
    await client.query('COMMIT');
  });
  const compare = await f.send(
    owner.bearer,
    'GET',
    `/v1/collections/${collection.id}/structure-history/compare?addresses=${encodeURIComponent(selected.address)}`,
  );
  expect(compare.status).toBe(200);
  expect(await compare.json()).toMatchObject({ status: 'retired', changes: [] });

  const currentOwnerView = await f.send(owner.bearer, 'GET', `/v1/collections/${collection.id}`);
  const collectionRevision = (await currentOwnerView.json()).collection.revision as number;
  const published = await f.send(owner.bearer, 'PATCH', `/v1/collections/${collection.id}`, {
    revision: collectionRevision,
    visibility: 'public',
  });
  expect(published.status, await published.clone().text()).toBe(200);

  const publicViewer = await f.identity(['collection:read']);
  const hidden = await f.send(publicViewer.bearer, 'GET', `/v1/collections/${collection.id}/structure-history`);
  expect(hidden.status).not.toBe(200);
  const visible = await f.send(publicViewer.bearer, 'GET', `/v1/collections/${collection.id}`);
  expect(visible.status).toBe(200);
  const body = await visible.json();
  expect(body).not.toHaveProperty('history');
  expect(body).not.toHaveProperty('structureHistory');
  expect(JSON.stringify(body)).not.toContain('private note');

  const minimized = await add(collection.id, await f.createSubject('game'), 'retained private note');
  await commands.removeMember(owner.actor, collection.id, minimized.id, entryKey());
  const minimizedAddress = (await history(collection.id)).changes.find(
    (change) => change.occurrenceId === minimized.id && change.operation === 'deleted',
  )!.address;
  await f.pool.query(
    `UPDATE library.collection_member
        SET note=NULL,added_at=NULL,deletion_revision=NULL,deleted_at=NULL,purge_after=NULL,deleted_ordinal_key=NULL
      WHERE route=$1 AND collection_id=$2 AND member_id=$3`,
    [routeOf(collection.id), collection.id, minimized.id],
  );
  const minimizedComparison = await f.send(
    owner.bearer,
    'GET',
    `/v1/collections/${collection.id}/structure-history/compare?addresses=${encodeURIComponent(minimizedAddress)}`,
  );
  expect(await minimizedComparison.json()).toMatchObject({ status: 'retired', changes: [] });

  const retiredOwnerCollection = await make('public');
  await add(retiredOwnerCollection.id, await f.createSubject('game'), 'erase with curator');
  await f.pool.query('UPDATE library.collection SET curator_account_id=NULL WHERE route=$1 AND collection_id=$2', [
    routeOf(retiredOwnerCollection.id),
    retiredOwnerCollection.id,
  ]);
  expect(
    (
      await f.pool.query('SELECT 1 FROM library.collection_structure_history WHERE route=$1 AND collection_id=$2', [
        routeOf(retiredOwnerCollection.id),
        retiredOwnerCollection.id,
      ])
    ).rowCount,
  ).toBe(0);
  const retiredHistory = await f.send(
    owner.bearer,
    'GET',
    `/v1/collections/${retiredOwnerCollection.id}/structure-history`,
  );
  expect(retiredHistory.status).not.toBe(200);
});
