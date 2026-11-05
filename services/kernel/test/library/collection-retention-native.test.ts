import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  pageDueCollectionDeletions,
  purgeExpiredCollectionPage,
  type CollectionDeletionKey,
} from '../../src/library/collection-retention.ts';
import { runCommand, type CommandTransaction, type AuthoritativeTime } from '../../src/command/command.ts';
import {
  createNativeLibrarySourceCustody,
  type NativeSourceIdentity,
  type NativeSourceFrontier,
} from '../../src/library/native-source-custody.ts';
import { recordPublicCollectionReduction } from '../../src/library/collections.ts';
import { readNativeCollectionMetadata } from '../../src/library/collection-source-native.ts';
import erasureProbe from '../../src/library/erasure-probe.sql';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let now = Date.now();
const clock = () => new Date(now);
beforeAll(async () => {
  f = await createProfileEntryFixture({ clock });
  owner = await f.identity([
    'subject:read',
    'collection:create',
    'collection:read',
    'collection:update',
    'collection:delete',
    'library_pin:update',
  ]);
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
}, 120000);
afterAll(async () => {
  await f?.close();
});

async function make(visibility: 'private' | 'public' = 'private') {
  const r = await f.send(owner.bearer, 'POST', '/v1/collections', {
    title: 'Retained original',
    description: 'private payload',
    visibility,
  });
  expect(r.status).toBe(201);
  return (await r.json()).collection;
}
async function current(id: string) {
  const r = await f.send(owner.bearer, 'GET', `/v1/collections/${id}`);
  expect(r.status).toBe(200);
  return (await r.json()).collection;
}
async function remove(id: string, revision: number, key = entryKey()) {
  const r = await f.send(owner.bearer, 'DELETE', `/v1/collections/${id}?revision=${revision}`, undefined, key);
  expect(r.status).toBe(204);
  const deletionId = r.headers.get('Library-Collection-Deletion-Id');
  if (!deletionId) throw new Error('Missing committed deletion episode');
  return { deletionId, revision: Number(r.headers.get('Library-Collection-Deletion-Revision')) };
}
async function locator(id: string): Promise<CollectionDeletionKey> {
  const row = (
    await f.pool.query<{ purgeAfter: string; deletionId: string; revision: number }>(
      'SELECT purge_after::text AS "purgeAfter", deletion_id::text AS "deletionId", revision FROM library.collection WHERE route=$1 AND collection_id=$2',
      [routeOf(id), id],
    )
  ).rows[0];
  if (!row) throw new Error('Missing retained Collection');
  return { ...row, route: routeOf(id)!, collectionId: id, accountId: owner.actor.accountId };
}
async function snapshot(id: string) {
  return (
    await f.pool.query('SELECT to_jsonb(c) AS row FROM library.collection c WHERE route=$1 AND collection_id=$2', [
      routeOf(id),
      id,
    ])
  ).rows;
}

test('exact Undo does not revive an independently deleted duplicate; D1 cannot restore or purge D3', async () => {
  const collection = await make(),
    id = collection.id;
  const subjectId = await f.createSubject('game');
  const added = [];
  for (const note of ['first', 'removed independently', 'last']) {
    const r = await f.send(owner.bearer, 'POST', `/v1/collections/${id}/members`, { subjectId, note });
    expect(r.status).toBe(201);
    added.push((await r.json()).member);
  }
  const removed = await f.send(
    owner.bearer,
    'DELETE',
    `/v1/collections/${id}/members/${added[1].id}?revision=${(await current(id)).revision}`,
  );
  expect(removed.status).toBe(204);
  const before = await current(id),
    receipt = entryKey();
  const first = await remove(id, before.revision, receipt),
    d1 = await locator(id);
  expect(await remove(id, before.revision, receipt)).toEqual(first);
  const restored = await f.send(owner.bearer, 'POST', `/v1/collections/${id}:restore`, first);
  expect(restored.status).toBe(200);
  const page = await f.send(owner.bearer, 'GET', `/v1/collections/${id}/members`);
  expect((await page.json()).members).toEqual([added[0], added[2]]);
  await remove(id, (await current(id)).revision);
  const d3 = await locator(id),
    beforeStale = await snapshot(id);
  expect(d3.deletionId).not.toBe(d1.deletionId);
  expect((await purgeExpiredCollectionPage({ pool: f.pool, clock }, d1)).status).toBe('stale');
  expect((await f.send(owner.bearer, 'POST', `/v1/collections/${id}:restore`, first)).status).toBe(409);
  const shelfBeforeReplay = (
      await f.pool.query(
        'SELECT generation_id,bucket,type_id,n::text FROM library.shelf_count WHERE route=$1 AND account_id=$2 ORDER BY generation_id,bucket,type_id',
        [d3.route, owner.actor.accountId],
      )
    ).rows,
    deletedEventsBeforeReplay = (
      await f.pool.query(
        "SELECT count(*)::text AS count FROM core.outbox WHERE subject=$1 AND type='com.rezics.library.collection.deleted.v1'",
        [id],
      )
    ).rows[0]?.count;
  expect(deletedEventsBeforeReplay).toBe('2');
  expect(await remove(id, before.revision, receipt)).toEqual(first);
  expect(await snapshot(id)).toEqual(beforeStale);
  expect(
    (
      await f.pool.query(
        'SELECT generation_id,bucket,type_id,n::text FROM library.shelf_count WHERE route=$1 AND account_id=$2 ORDER BY generation_id,bucket,type_id',
        [d3.route, owner.actor.accountId],
      )
    ).rows,
  ).toEqual(shelfBeforeReplay);
  expect(
    (
      await f.pool.query(
        "SELECT count(*)::text AS count FROM core.outbox WHERE subject=$1 AND type='com.rezics.library.collection.deleted.v1'",
        [id],
      )
    ).rows[0]?.count,
  ).toBe(deletedEventsBeforeReplay);
}, 120000);

test('due cleanup uses the original deadline, erases children before the head, and resumes exact pages', async () => {
  const row = await make(),
    subjectId = await f.createSubject('game');
  for (let i = 0; i < 65; i++) {
    const r = await f.send(owner.bearer, 'POST', `/v1/collections/${row.id}/members`, {
      subjectId,
      note: `original ${i}`,
    });
    expect(r.status).toBe(201);
  }
  const first = await remove(row.id, (await current(row.id)).revision),
    d1 = await locator(row.id);
  expect((await f.send(owner.bearer, 'POST', `/v1/collections/${row.id}:restore`, first)).status).toBe(200);
  await remove(row.id, (await current(row.id)).revision);
  const key = await locator(row.id),
    before = await snapshot(row.id);
  expect((await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).status).toBe('not_due');
  expect(await snapshot(row.id)).toEqual(before);
  now = Date.parse(key.purgeAfter);
  const keys = await pageDueCollectionDeletions(f.pool, {
    partition: partitionOf(key.route),
    cutoff: clock().toISOString(),
    after: null,
  });
  expect(keys).toContainEqual(key);
  expect(Buffer.byteLength(JSON.stringify(keys))).toBeLessThanOrEqual(4096);
  expect(await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).toEqual({ status: 'progress', removed: 64 });
  expect(await snapshot(row.id)).toEqual(before);
  expect((await purgeExpiredCollectionPage({ pool: f.pool, clock }, d1)).status).toBe('stale');
  expect(await snapshot(row.id)).toEqual(before);
  expect(
    (
      await f.send(owner.bearer, 'POST', `/v1/collections/${row.id}:restore`, {
        deletionId: key.deletionId,
        revision: key.revision,
      })
    ).status,
  ).toBe(409);
  expect(await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).toEqual({ status: 'progress', removed: 1 });
  expect(await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).toEqual({ status: 'purged', removed: 1 });
  expect(await snapshot(row.id)).toEqual([]);
  expect(
    (
      await f.pool.query('SELECT member_id FROM library.collection_member WHERE route=$1 AND collection_id=$2', [
        key.route,
        key.collectionId,
      ])
    ).rows,
  ).toEqual([]);
  expect((await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).status).toBe('stale');
}, 120000);

test('private pin cleanup advances its retained preference revision once and preserves other pins', async () => {
  const selected = await make(),
    other = await make();
  const first = await f.send(owner.bearer, 'PUT', `/v1/libraryPins/${selected.id}`, { revision: 0 });
  expect(first.status).toBe(200);
  const second = await f.send(owner.bearer, 'PUT', `/v1/libraryPins/${other.id}`, { revision: 1 });
  expect(second.status).toBe(200);
  const before = (
    await f.pool.query<{ revision: string; ids: string[] }>(
      'SELECT revision::text, collection_ids AS ids FROM library.collection_pins WHERE route=$1 AND account_id=$2',
      [routeOf(selected.id), owner.actor.accountId],
    )
  ).rows[0]!;
  expect(before.ids).toEqual([selected.id, other.id]);
  await remove(selected.id, (await current(selected.id)).revision);
  const key = await locator(selected.id);
  now = Date.parse(key.purgeAfter);
  expect(await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).toEqual({ status: 'progress', removed: 1 });
  const after = (
    await f.pool.query<{ revision: string; ids: string[] }>(
      'SELECT revision::text, collection_ids AS ids FROM library.collection_pins WHERE route=$1 AND account_id=$2',
      [routeOf(selected.id), owner.actor.accountId],
    )
  ).rows[0]!;
  expect(after).toEqual({ revision: String(Number(before.revision) + 1), ids: [other.id] });
}, 120000);

test('public custody stays explicitly retained until actual Source and destination disposition are bound', async () => {
  const row = await make('public');
  await remove(row.id, row.revision);
  const key = await locator(row.id),
    before = await snapshot(row.id);
  now += 720 * 3600 * 1000;
  expect(await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).toEqual({
    status: 'retained',
    removed: 0,
    custody: 'collection_source_and_destination_disposition',
  });
  expect(await snapshot(row.id)).toEqual(before);
  expect((await f.send('anonymous', 'GET', `/v1/collections/${row.id}`)).status).toBe(404);
}, 120000);

const retirementWork = () => ({
  deadline: Date.now() + 30000,
  allowance: {
    reservationId: entryKey(),
    remaining: {
      candidateKeys: 100,
      identityMetadataRows: 0,
      nativeRows: 10000,
      nativePoints: 256,
      witnessKeys: 0,
      statements: 100,
      bytes: 1024 * 1024,
      emptySeeks: 100,
    },
  },
});
async function captureForRetirement(collectionId: string) {
  const route = routeOf(collectionId)!;
  const metadata = await readNativeCollectionMetadata(f.pool, { route, collectionId }, retirementWork());
  if (!metadata.metadata) throw new Error('Missing native Collection');
  const identity: NativeSourceIdentity = {
    route,
    collectionId,
    accountId: owner.actor.accountId,
    incarnation: metadata.metadata.incarnation,
    generation: metadata.metadata.sourceGeneration,
    scope: 'curated',
    ownerEpoch: (await f.pool.query('SELECT epoch FROM core.partition WHERE partition_no=$1', [partitionOf(route)]))
      .rows[0].epoch,
    receivingEpoch: '1',
    effectKey: entryKey(),
  };
  const custody = createNativeLibrarySourceCustody({ pool: f.pool });
  let frontier: NativeSourceFrontier | null = null;
  for (let n = 0; n < 30; n++) {
    const page = await custody.capturePage({ ...retirementWork(), identity, frontier, limit: 100 });
    if (page.status !== 'pending') throw new Error(`Capture unavailable: ${page.reason}`);
    frontier = page.frontier;
    if (frontier.driver === 'done') {
      const completed = await custody.finishCapture({ ...retirementWork(), identity, frontier });
      if (completed.status !== 'complete') throw new Error('Missing native receipt');
      return { identity, captureId: completed.capture.captureId, custody };
    }
  }
  throw new Error('Finite capture did not finish');
}
async function custodyCommand<T>(
  identity: NativeSourceIdentity,
  action: (client: CommandTransaction, at: AuthoritativeTime) => Promise<T>,
) {
  return runCommand(
    f.pool,
    { partition: partitionOf(identity.route), clock, deadline: Date.now() + 30000 },
    async (client, context) => ({
      value: await action(client, context.time),
      events: [{ type: 'com.rezics.library.collection.updated.v1', data: { collectionId: identity.collectionId } }],
    }),
  );
}
async function finishPrivateCleanup(key: CollectionDeletionKey) {
  for (let n = 0; n < 20; n++) {
    const page = await purgeExpiredCollectionPage({ pool: f.pool, clock }, key);
    expect(page.removed).toBeLessThanOrEqual(100);
    if (page.status === 'purged') {
      expect(
        (
          await f.pool.query(
            "SELECT 1 FROM library.native_source_fence WHERE route=$1 AND kind='collection' AND owner_id=$2",
            [key.route, key.collectionId],
          )
        ).rows,
      ).toEqual([]);
      return;
    }
    expect(page.status).toBe('progress');
  }
  throw new Error('Finite private cleanup did not finish');
}

test('unheld native Source capture retires before default due private Collection cleanup, with stale episodes and provenance refused', async () => {
  const row = await make();
  const captured = await captureForRetirement(row.id);
  const first = await remove(row.id, row.revision),
    d1 = await locator(row.id);
  expect((await f.send(owner.bearer, 'POST', `/v1/collections/${row.id}:restore`, first)).status).toBe(200);
  await remove(row.id, (await current(row.id)).revision);
  const d3 = await locator(row.id);
  now += 720 * 3600 * 1000;
  expect((await purgeExpiredCollectionPage({ pool: f.pool, clock }, d1)).status).toBe('stale');
  const sourceGeneration = (
    await f.pool.query(
      'SELECT source_generation::text AS generation FROM library.collection WHERE route=$1 AND collection_id=$2',
      [d3.route, row.id],
    )
  ).rows[0].generation as string;
  const attempt = (identity: NativeSourceIdentity, key: CollectionDeletionKey) =>
    custodyCommand(captured.identity, (client, at) =>
      captured.custody.retireCapture({
        ...retirementWork(),
        client,
        at,
        identity,
        captureId: captured.captureId,
        sourceGeneration,
        episode: { kind: 'deleted', deletionId: key.deletionId, revision: key.revision, purgeAfter: key.purgeAfter },
      }),
    );
  expect((await attempt(captured.identity, d1)).value).toMatchObject({ status: 'blocked', reason: 'source' });
  expect((await attempt({ ...captured.identity, effectKey: entryKey() }, d3)).value.status).toBe('unavailable');
  expect(
    (await attempt({ ...captured.identity, incarnation: captured.identity.incarnation + 'x' }, d3)).value,
  ).toMatchObject({ status: 'blocked', reason: 'source' });
  expect(await purgeExpiredCollectionPage({ pool: f.pool, clock }, d3)).toEqual({ status: 'progress', removed: 2 });
  await finishPrivateCleanup(d3);
  expect(await snapshot(row.id)).toEqual([]);
  expect(
    (
      await custodyCommand(captured.identity, (client, at) =>
        captured.custody.readAndHold({
          ...retirementWork(),
          ...captured,
          client,
          at,
          holdId: entryKey(),
        }),
      )
    ).value.status,
  ).toBe('unavailable');
}, 120000);

test('live native holds survive generation changes and deletion; only committed release permits bounded child-before-parent retirement', async () => {
  const row = await make(),
    captured = await captureForRetirement(row.id);
  const holdIds = Array.from({ length: 81 }, () => entryKey());
  await custodyCommand(captured.identity, async (client, at) => {
    for (const holdId of holdIds)
      expect(
        (await captured.custody.readAndHold({ ...retirementWork(), ...captured, client, at, holdId })).status,
      ).toBe('held');
    return true;
  });
  await remove(row.id, row.revision);
  const key = await locator(row.id),
    before = await snapshot(row.id);
  now += 720 * 3600 * 1000;
  expect(await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).toEqual({
    status: 'retained',
    removed: 0,
    custody: 'native_source_capture',
  });
  expect(await snapshot(row.id)).toEqual(before);
  const sourceGeneration = (
    await f.pool.query(
      'SELECT source_generation::text AS generation FROM library.collection WHERE route=$1 AND collection_id=$2',
      [key.route, row.id],
    )
  ).rows[0].generation as string;
  const released = await custodyCommand(captured.identity, async (client, at) => {
    expect(
      (await captured.custody.readAndHold({ ...retirementWork(), ...captured, client, at, holdId: entryKey() })).status,
    ).toBe('unavailable');
    for (const holdId of holdIds)
      expect(
        (await captured.custody.releaseHold({ ...retirementWork(), ...captured, client, at, holdId })).status,
      ).toBe('released');
    return captured.custody.retireCapture({
      ...retirementWork(),
      ...captured,
      client,
      at,
      sourceGeneration,
      episode: { kind: 'deleted', deletionId: key.deletionId, revision: key.revision, purgeAfter: key.purgeAfter },
    });
  });
  expect(released.value).toMatchObject({ status: 'blocked', reason: 'release_uncommitted' });
  expect(await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).toEqual({ status: 'progress', removed: 80 });
  expect(
    (
      await f.pool.query('SELECT 1 FROM library.native_source_receipt WHERE route=$1 AND capture_id=$2', [
        key.route,
        captured.captureId,
      ])
    ).rows,
  ).toHaveLength(1);
  expect(await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).toEqual({ status: 'progress', removed: 3 });
  await finishPrivateCleanup(key);
  expect(await snapshot(row.id)).toEqual([]);
}, 120000);

test('unheld ever-public native capture stays retained and its whole custody family remains in the terminal probe', async () => {
  const row = await make('public'),
    captured = await captureForRetirement(row.id);
  await remove(row.id, row.revision);
  const key = await locator(row.id);
  now += 720 * 3600 * 1000;
  expect(await purgeExpiredCollectionPage({ pool: f.pool, clock }, key)).toEqual({
    status: 'retained',
    removed: 0,
    custody: 'collection_source_and_destination_disposition',
  });
  const sourceGeneration = (
    await f.pool.query(
      'SELECT source_generation::text AS generation FROM library.collection WHERE route=$1 AND collection_id=$2',
      [key.route, row.id],
    )
  ).rows[0].generation as string;
  const result = await custodyCommand(captured.identity, (client, at) =>
    captured.custody.retireCapture({
      ...retirementWork(),
      ...captured,
      client,
      at,
      sourceGeneration,
      episode: { kind: 'deleted', deletionId: key.deletionId, revision: key.revision, purgeAfter: key.purgeAfter },
    }),
  );
  expect(result.value).toMatchObject({ status: 'blocked', reason: 'public_custody' });
  expect(
    (
      await f.pool.query('SELECT 1 FROM library.native_source_capture WHERE route=$1 AND capture_id=$2', [
        key.route,
        captured.captureId,
      ])
    ).rows,
  ).toHaveLength(1);
  const pending = (await erasureProbe.run(f.pool, { route: key.route, account_id: key.accountId })).map(
    (row) => row.store,
  );
  for (const store of ['native_source_capture', 'native_source_receipt', 'native_source_hold', 'native_source_fence'])
    expect(pending).toContain(store);
}, 120000);

test('public Collection reductions keep head, log and unresolved coverage atomic for associated and standalone commands', async () => {
  const collection = await make('public');
  const id = collection.id,
    route = routeOf(id)!,
    partition = partitionOf(route);
  const subjectId = await f.createSubject('game');
  const member = await f.send(owner.bearer, 'POST', `/v1/collections/${id}/members`, { subjectId });
  expect(member.status).toBe(201);
  const memberId = (await member.json()).member.id;
  const log = async () =>
    (
      await f.pool.query(
        `SELECT h.owner_epoch,h.position::text,l.affected,l.impacts,p.through_position::text
     FROM semantic.public_filter_privacy_head h
     JOIN semantic.public_filter_privacy_log l USING(partition_no,owner_epoch,position)
     JOIN semantic.public_filter_privacy_pending p ON p.partition_no=h.partition_no
       AND p.input_key=$2 AND p.through_position=h.position
     WHERE h.partition_no=$1`,
        [partition, JSON.stringify(['scope', 'unresolved'])],
      )
    ).rows;
  const check = async () => {
    const rows = await log();
    expect(rows).toHaveLength(1);
    expect(rows[0].affected).toEqual([{ kind: 'collection', route, collection: id }]);
    expect(rows[0].impacts).toEqual([{ kind: 'dependency', locator: { kind: 'collection', route, collection: id } }]);
    expect(rows[0].position).toBe(rows[0].through_position);
  };
  // Native HTTP commands carry the actual Library request accounting association.
  expect(
    (
      await f.send(
        owner.bearer,
        'DELETE',
        `/v1/collections/${id}/members/${memberId}?revision=${(await current(id)).revision}`,
      )
    ).status,
  ).toBe(204);
  await check();
  expect(
    (
      await f.send(owner.bearer, 'PATCH', `/v1/collections/${id}`, {
        revision: (await current(id)).revision,
        visibility: 'private',
      })
    ).status,
  ).toBe(200);
  await check();
  expect(
    (
      await f.send(owner.bearer, 'PATCH', `/v1/collections/${id}`, {
        revision: (await current(id)).revision,
        visibility: 'public',
      })
    ).status,
  ).toBe(200);
  await remove(id, (await current(id)).revision);
  await check();
  const standalone = () =>
    runCommand(f.pool, { partition }, async (tx, command) => {
      await recordPublicCollectionReduction(tx, route, id, command.transactionId);
      return {
        value: null,
        events: [{ type: 'com.rezics.library.collection.updated.v1', subject: id, data: { collectionId: id } }],
      };
    });
  await standalone();
  await check();
  const before = await log();
  await expect(
    runCommand(f.pool, { partition }, async (tx, command) => {
      await recordPublicCollectionReduction(tx, route, id, command.transactionId);
      throw new Error('Rollback original Collection reduction');
    }),
  ).rejects.toThrow('Rollback original Collection reduction');
  expect(await log()).toEqual(before);
  await expect(
    runCommand(f.pool, { partition }, async (tx, command) => {
      await tx.query('UPDATE semantic.public_filter_privacy_head SET owner_epoch=owner_epoch+1 WHERE partition_no=$1', [
        partition,
      ]);
      await recordPublicCollectionReduction(tx, route, id, command.transactionId);
      return { value: null, events: [] };
    }),
  ).rejects.toThrow();
  expect(await log()).toEqual(before);
}, 120000);
