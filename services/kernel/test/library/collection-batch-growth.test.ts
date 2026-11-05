import { afterAll, beforeAll, expect, test } from 'bun:test';
import { deriveAccess } from '../../src/request/derived-access.ts';
import { createCollectionCommands } from '../../src/library/collections.ts';
import { memberNeighbors } from '../../src/library/collection-store.ts';
import { keyBetween } from '../../src/library/ordinal.ts';
import { syncSubjectListing, subjectCollections } from '../../src/library/listing.ts';
import { accountToken } from '../support/admitted-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { routeOf, newId } from '../../src/route/route.ts';
import {
  createCollectionBatchFixture,
  batchScopes,
  entryKey,
  type CollectionBatchFixture,
} from './support/collection-batch-fixture.ts';

let f: CollectionBatchFixture;
let time = Date.now();
beforeAll(async () => {
  f = await createCollectionBatchFixture({ clock: () => new Date(time) });
}, 120000);
afterAll(async () => {
  await f?.close();
});
async function pair(size = 2, visibility: 'private' | 'public' = 'private') {
  const source = await f.make(visibility),
    destination = await f.make(visibility);
  const subjectId = await f.createSubject('game');
  const members = [];
  for (let index = 0; index < size; index++) members.push(await f.add(source.id, subjectId, `note ${index}`));
  const current = await f.current(source.id);
  return { source: current, destination, members, subjectId };
}
function moveBody(p: Awaited<ReturnType<typeof pair>>, ids = p.members.map((member) => member.id)) {
  return {
    revision: p.source.revision,
    memberIds: ids,
    destinationCollectionId: p.destination.id,
    destinationRevision: p.destination.revision,
    after: null as string | null,
  };
}
async function post(
  id: string,
  method: 'move' | 'batchRemove',
  body: unknown,
  key = entryKey(),
  bearer = f.owner.bearer,
) {
  return f.send(bearer, 'POST', `/v1/collections/${id}/members:${method}`, body, key);
}
async function unchanged(
  ids: string[],
  before: Awaited<ReturnType<CollectionBatchFixture['snapshot']>>,
  response: Response,
  status: number,
) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await f.snapshot(ids)).toEqual(before);
}
for (const size of [1, 100])
  for (const visibility of ['private', 'public'] as const) {
    test(`batch ${size} ${visibility} removal retains exact 720-hour episodes, duplicate survivor, native Undo and replay`, async () => {
      const p = await pair(size + 1, visibility);
      const selected = p.members.slice(0, size);
      const key = entryKey();
      const body = { revision: p.source.revision, memberIds: selected.map((member) => member.id).reverse() };
      const response = await post(p.source.id, 'batchRemove', body, key);
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.collection.revision).toBe(p.source.revision + 1);
      expect(result.collection.memberCount).toBe(1);
      expect(result.removed).toHaveLength(size);
      expect(new Set(result.removed.map((item: { deletionId: string }) => item.deletionId)).size).toBe(size);
      const episodes = (
        await f.pool.query(
          'SELECT member_id,deletion_id,deletion_revision,extract(epoch FROM purge_after-deleted_at)::integer AS seconds,note,added_at,deleted_ordinal_key FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=ANY($3::uuid[]) ORDER BY member_id',
          [routeOf(p.source.id), p.source.id, body.memberIds],
        )
      ).rows;
      expect(episodes).toHaveLength(size);
      for (const episode of episodes) {
        expect(episode.seconds).toBe(720 * 3600);
        expect(Number(episode.deletion_revision)).toBe(result.collection.revision);
        expect(episode.note).toBe(selected.find((member) => member.id === episode.member_id)!.note);
      }
      const saved = await f.snapshot([p.source.id, p.destination.id]);
      expect(await (await post(p.source.id, 'batchRemove', body, key)).json()).toEqual(result);
      expect(await f.snapshot([p.source.id, p.destination.id])).toEqual(saved);
      expect((await post(p.source.id, 'batchRemove', { ...body, revision: body.revision + 1 }, key)).status).toBe(422);
      for (const removed of result.removed) {
        const restored = await f.send(
          f.owner.bearer,
          'POST',
          `/v1/collections/${p.source.id}/members/${removed.memberId}:restore`,
          { deletionId: removed.deletionId, revision: removed.revision },
        );
        expect(restored.status, await restored.clone().text()).toBe(200);
        const expected = selected.find((member) => member.id === removed.memberId)!;
        expect((await restored.json()).member).toEqual({
          id: expected.id,
          subjectId: expected.subjectId,
          note: expected.note,
          addedAt: expected.addedAt,
        });
      }
      expect((await f.page(p.source.id)).map((member) => member.id)).toEqual(p.members.map((member) => member.id));
      const stamp = (
        await f.pool.query('SELECT source_generation FROM library.collection WHERE route=$1 AND collection_id=$2', [
          routeOf(p.source.id),
          p.source.id,
        ])
      ).rows[0];
      expect(Number(stamp.source_generation)).toBe(size + 1 + 1 + size);
    }, 300000);
  }
for (const size of [1, 100])
  for (const [sourceVisibility, destinationVisibility] of [
    ['private', 'private'],
    ['public', 'private'],
    ['private', 'public'],
    ['public', 'public'],
  ] as const) {
    test(`transfer ${size} ${sourceVisibility}/${destinationVisibility} preserves source order and exact identity with one generation per parent`, async () => {
      const p = await pair(size + 1, sourceVisibility);
      if (destinationVisibility !== sourceVisibility) {
        const changed = await f.commands.updateCollection(
          f.owner.actor,
          p.destination.id,
          { revision: p.destination.revision, visibility: destinationVisibility },
          entryKey(),
        );
        p.destination = changed.value;
      }
      const head = await f.add(p.destination.id, p.subjectId, 'head');
      const tail = await f.add(p.destination.id, p.subjectId, 'tail');
      p.destination = { ...p.destination, ...(await f.current(p.destination.id)) };
      const selected = p.members.slice(0, size);
      const body = { ...moveBody(p, selected.map((member) => member.id).reverse()), after: head.id };
      const key = entryKey();
      const moved = await post(p.source.id, 'move', body, key);
      expect(moved.status, await moved.clone().text()).toBe(200);
      const result = await moved.json();
      expect(result.members).toEqual(
        selected.map(({ id, subjectId, note, addedAt }) => ({ id, subjectId, note, addedAt })),
      );
      expect(result.source.revision).toBe(p.source.revision + 1);
      expect(result.destination.revision).toBe(p.destination.revision + 1);
      expect((await f.page(p.source.id)).map((member) => member.id)).toEqual([p.members[size]!.id]);
      expect((await f.page(p.destination.id)).map((member) => member.id)).toEqual([
        head.id,
        ...selected.map((member) => member.id),
        tail.id,
      ]);
      const beforeReplay = await f.snapshot([p.source.id, p.destination.id]);
      expect(await (await post(p.source.id, 'move', body, key)).json()).toEqual(result);
      expect(await f.snapshot([p.source.id, p.destination.id])).toEqual(beforeReplay);
      expect((await post(p.source.id, 'move', { ...body, after: null }, key)).status).toBe(422);
      for (const collectionId of [p.source.id, p.destination.id])
        await syncSubjectListing({ pool: f.pool }, { subjectId: p.subjectId, collectionId });
      const listing = await subjectCollections(f.pool, p.subjectId, null, 100);
      expect(listing.length).toBe(Number(sourceVisibility === 'public') + Number(destinationVisibility === 'public'));
      const stamps = (
        await f.pool.query(
          'SELECT collection_id,source_generation FROM library.collection WHERE route=$1 AND collection_id=ANY($2::uuid[])',
          [routeOf(p.source.id), [p.source.id, p.destination.id]],
        )
      ).rows;
      expect(Number(stamps.find((row) => row.collection_id === p.source.id).source_generation)).toBe(
        p.members.length + 1,
      );
      expect(Number(stamps.find((row) => row.collection_id === p.destination.id).source_generation)).toBe(
        3 + Number(destinationVisibility !== sourceVisibility),
      );
    }, 300000);
  }

test('strict bodies reject malformed, duplicate and oversized selections without writing', async () => {
  const p = await pair();
  const ids = [p.source.id, p.destination.id];
  for (const method of ['batchRemove', 'move'] as const) {
    const valid = method === 'move' ? moveBody(p) : { revision: p.source.revision, memberIds: [p.members[0]!.id] };
    for (const patch of [
      { memberIds: [] },
      { memberIds: [p.members[0]!.id, p.members[0]!.id] },
      { memberIds: Array.from({ length: 101 }, () => newId(routeOf(p.source.id)!)) },
      { memberIds: ['bad'] },
      { memberIds: [1] },
      { revision: '1' },
      { revision: 1.5 },
      { extra: true },
      { memberIds: null },
    ]) {
      const before = await f.snapshot(ids);
      await unchanged(ids, before, await post(p.source.id, method, { ...valid, ...patch }), 400);
    }
  }
});
test('a single unknown, foreign or deleted occurrence, invalid placement or stale parent rolls back both sides', async () => {
  const p = await pair();
  const foreign = await f.add(p.destination.id, p.subjectId);
  const deleted = await f.add(p.source.id, p.subjectId);
  let source = await f.current(p.source.id);
  await f.commands.removeMember(f.owner.actor, p.source.id, deleted.id, source.revision, entryKey());
  p.source = await f.current(p.source.id);
  p.destination = { ...p.destination, ...(await f.current(p.destination.id)) };
  const ids = [p.source.id, p.destination.id];
  const valid = moveBody(p);
  for (const badId of [newId(routeOf(p.source.id)!), foreign.id, deleted.id]) {
    for (const method of ['move', 'batchRemove'] as const) {
      const before = await f.snapshot(ids);
      const body =
        method === 'move'
          ? { ...valid, memberIds: [p.members[0]!.id, badId] }
          : { revision: valid.revision, memberIds: [p.members[0]!.id, badId] };
      await unchanged(ids, before, await post(p.source.id, method, body), 404);
    }
  }
  for (const patch of [
    { revision: valid.revision - 1 },
    { destinationRevision: valid.destinationRevision - 1 },
    { after: p.members[0]!.id },
  ]) {
    const before = await f.snapshot(ids);
    await unchanged(ids, before, await post(p.source.id, 'move', { ...valid, ...patch }), 'after' in patch ? 404 : 409);
  }
  await unchanged(
    ids,
    await f.snapshot(ids),
    await post(p.source.id, 'move', { ...valid, destinationCollectionId: p.source.id }),
    400,
  );
});
test('actual current grants on both parents are required again on receipt replay', async () => {
  const p = await pair();
  const editor = await f.identity(batchScopes);
  await f.grant(p.source.id, editor.actor.accountId);
  const body = moveBody(p, [p.members[0]!.id]);
  await unchanged(
    [p.source.id, p.destination.id],
    await f.snapshot([p.source.id, p.destination.id]),
    await post(p.source.id, 'move', body, entryKey(), editor.bearer),
    404,
  );
  await f.grant(p.destination.id, editor.actor.accountId);
  const key = entryKey();
  expect((await post(p.source.id, 'move', body, key, editor.bearer)).status).toBe(200);
  for (const id of [p.destination.id, p.source.id]) {
    await f.grant(id, editor.actor.accountId, true);
    const before = await f.snapshot([p.source.id, p.destination.id]);
    await unchanged(
      [p.source.id, p.destination.id],
      before,
      await post(p.source.id, 'move', body, key, editor.bearer),
      404,
    );
    await f.grant(id, editor.actor.accountId);
  }
});
test('anonymous, suspended and same-owner reduced-scope credentials cannot mutate or replay', async () => {
  const p = await pair();
  const body = moveBody(p);
  const reduced = await accountToken({ ...f.owner.actor, scopes: ['collection:read', 'subject:read'] });
  const suspended = await f.identity(batchScopes);
  await f.suspend(suspended.actor.accountId);
  for (const [bearer, expected] of [
    ['anonymous', 401],
    [suspended.bearer, 401],
    [reduced, 403],
  ] as const) {
    await unchanged(
      [p.source.id, p.destination.id],
      await f.snapshot([p.source.id, p.destination.id]),
      await post(p.source.id, 'move', body, entryKey(), bearer),
      expected,
    );
    await unchanged(
      [p.source.id, p.destination.id],
      await f.snapshot([p.source.id, p.destination.id]),
      await post(
        p.source.id,
        'batchRemove',
        { revision: p.source.revision, memberIds: body.memberIds },
        entryKey(),
        bearer,
      ),
      expected,
    );
  }
});
test('cross-route transfer is explicitly unsupported, deleted parent remains terminal, and a hidden original cannot be moved or replayed', async () => {
  const p = await pair();
  let other = await f.identity(batchScopes);
  while (routeOf(other.actor.accountId) === routeOf(p.source.id)) other = await f.identity(batchScopes);
  const foreign = await f.make('private', other);
  expect(routeOf(foreign.id)).not.toBe(routeOf(p.source.id));
  await unchanged(
    [p.source.id, p.destination.id],
    await f.snapshot([p.source.id, p.destination.id]),
    await post(p.source.id, 'move', { ...moveBody(p), destinationCollectionId: foreign.id }),
    409,
  );
  const key = entryKey();
  const body = moveBody(p, [p.members[0]!.id]);
  expect((await post(p.source.id, 'move', body, key)).status).toBe(200);
  expect(
    (await f.send('steward', 'POST', `/v1/subjects/${p.subjectId}:hide`, { reason: 'Current batch disclosure' }))
      .status,
  ).toBe(200);
  const before = await f.snapshot([p.source.id, p.destination.id]);
  await unchanged([p.source.id, p.destination.id], before, await post(p.source.id, 'move', body, key), 404);
  const destination = await f.current(p.destination.id);
  expect(
    (await f.send(f.owner.bearer, 'DELETE', `/v1/collections/${p.destination.id}?revision=${destination.revision}`))
      .status,
  ).toBe(204);
  await unchanged(
    [p.source.id, p.destination.id],
    await f.snapshot([p.source.id, p.destination.id]),
    await post(p.source.id, 'move', body, key),
    404,
  );
});
test('batch deletion expires at its original exact 720-hour boundary', async () => {
  const p = await pair(1);
  const response = await post(p.source.id, 'batchRemove', {
    revision: p.source.revision,
    memberIds: [p.members[0]!.id],
  });
  expect(response.status).toBe(200);
  const removed = (await response.json()).removed[0];
  const deadline = (
    await f.pool.query(
      'SELECT purge_after::text AS deadline FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=$3',
      [routeOf(p.source.id), p.source.id, p.members[0]!.id],
    )
  ).rows[0].deadline;
  const previous = time;
  time = Date.parse(deadline);
  try {
    const restored = await f.send(
      f.owner.bearer,
      'POST',
      `/v1/collections/${p.source.id}/members/${removed.memberId}:restore`,
      { revision: removed.revision, deletionId: removed.deletionId },
    );
    expect(restored.status).toBe(409);
    expect((await restored.json()).code).toBe('member_restore_expired');
  } finally {
    time = previous;
  }
});

test('destination capacity is atomic and a full destination can still remove 100 exact occurrences', async () => {
  const p = await pair(100);
  for (let index = 0; index < 5000; index++) {
    if (index % 16 === 0) await f.refresh();
    await f.add(p.destination.id, p.subjectId, `capacity ${index}`);
  }
  p.destination = { ...p.destination, ...(await f.current(p.destination.id)) };
  const destinationMembers = await f.page(p.destination.id);
  const before = await f.snapshot([p.source.id, p.destination.id]);
  await unchanged(
    [p.source.id, p.destination.id],
    before,
    await post(p.source.id, 'move', { ...moveBody(p), memberIds: [p.members[0]!.id, destinationMembers[0]!.id] }),
    404,
  );
  const denied = await post(p.source.id, 'move', moveBody(p));
  await unchanged([p.source.id, p.destination.id], before, denied, 409);
  expect((await denied.json()).code).toBe('collection_full');
  const selected = (await f.page(p.destination.id)).slice(0, 100);
  const removed = await post(p.destination.id, 'batchRemove', {
    revision: p.destination.revision,
    memberIds: selected.map((member) => member.id),
  });
  expect(removed.status).toBe(200);
  p.destination = { ...p.destination, ...(await removed.json()).collection };
  expect((await post(p.source.id, 'move', moveBody(p))).status).toBe(200);
  expect((await f.current(p.destination.id)).memberCount).toBe(5000);
}, 300000);

test('native gap exhaustion rebalances the destination once while independent retained occurrences remain exact', async () => {
  const p = await pair(100);
  const retained = await f.add(p.destination.id, p.subjectId, 'independent retained occurrence');
  let destination = await f.current(p.destination.id);
  const deletion = await f.commands.removeMember(
    f.owner.actor,
    p.destination.id,
    retained.id,
    destination.revision,
    entryKey(),
  );
  const anchor = await f.add(p.destination.id, p.subjectId, 'placement anchor');
  // Stop at the first real native gap in which the selected block cannot fit.
  let exhausted = false;
  for (let index = 0; index < 210; index++) {
    const neighbors = await memberNeighbors(f.pool, routeOf(p.destination.id)!, p.destination.id, {
      kind: 'after',
      memberId: anchor.id,
    });
    expect(neighbors).not.toBeNull();
    let before = neighbors!.before;
    for (let count = 0; count < p.members.length; count++) {
      const next = keyBetween(before, neighbors!.after);
      if (next === null) {
        exhausted = true;
        break;
      }
      before = next;
    }
    if (exhausted) break;
    if (index % 16 === 0) await f.refresh();
    await f.add(p.destination.id, p.subjectId, `gap ${index}`, anchor.id);
  }
  expect(exhausted).toBe(true);
  const epoch = (
    await f.pool.query('SELECT order_epoch FROM library.collection WHERE route=$1 AND collection_id=$2', [
      routeOf(p.destination.id),
      p.destination.id,
    ])
  ).rows[0].order_epoch;
  p.destination = { ...p.destination, ...(await f.current(p.destination.id)) };
  const beforeOrder = await f.page(p.destination.id);
  const response = await post(p.source.id, 'move', { ...moveBody(p), after: anchor.id });
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await f.page(p.destination.id)).map((member) => member.id)).toEqual([
    anchor.id,
    ...p.members.map((member) => member.id),
    ...beforeOrder.slice(1).map((member) => member.id),
  ]);
  expect(
    (
      await f.pool.query('SELECT order_epoch FROM library.collection WHERE route=$1 AND collection_id=$2', [
        routeOf(p.destination.id),
        p.destination.id,
      ])
    ).rows[0].order_epoch,
  ).toBe(epoch + 1);
  const saved = (
    await f.pool.query(
      'SELECT deletion_id,note,deleted_ordinal_key FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=$3',
      [routeOf(p.destination.id), p.destination.id, retained.id],
    )
  ).rows[0];
  expect(saved.deletion_id).toBe(deletion.value.deletionId);
  expect(saved.note).toBe(retained.note);
  const oldSourceUndo = await f.send(
    f.owner.bearer,
    'POST',
    `/v1/collections/${p.source.id}/members/${p.members[0]!.id}:restore`,
    { deletionId: deletion.value.deletionId, revision: deletion.value.revision },
  );
  expect(oldSourceUndo.status).toBe(404);
}, 300000);

async function failFirstTransfer(
  fixture: CollectionBatchFixture,
  collectionId: string,
  body: Parameters<CollectionBatchFixture['commands']['transferMembers']>[2],
) {
  const connect = fixture.pool.connect.bind(fixture.pool);
  let changed = 0;
  // Inject on the native executor client; keep the actual authorization, command envelope and transaction.
  fixture.pool.connect = (async () => {
    const client = await connect();
    const query = client.query.bind(client);
    const release = client.release.bind(client);
    client.query = (async (...args: unknown[]) => {
      const result = await (query as (...args: unknown[]) => Promise<unknown>)(...args);
      if (typeof args[0] === 'string' && args[0].includes('SET collection_id=') && ++changed === 1)
        throw new Error('injected after first actual transfer');
      return result;
    }) as typeof client.query;
    client.release = (...args) => {
      client.query = query;
      client.release = release;
      release(...args);
    };
    return client;
  }) as typeof fixture.pool.connect;
  try {
    await expect(fixture.commands.transferMembers(fixture.owner.actor, collectionId, body, entryKey())).rejects.toThrow(
      'injected after first actual transfer',
    );
    expect(changed).toBe(1);
  } finally {
    fixture.pool.connect = connect;
  }
}
test('failure after the first actual row transfer rolls back parents, occurrences, receipt and outbox', async () => {
  const p = await pair();
  const before = await f.snapshot([p.source.id, p.destination.id]);
  await failFirstTransfer(f, p.source.id, moveBody(p));
  expect(await f.snapshot([p.source.id, p.destination.id])).toEqual(before);
});

// Every growing row below is produced by a real current command. Captures include Access, retention,
// receipt/outbox, actual listing producers, failed/replayed attempts and all native plans and wire bytes.
for (const size of [1, 100])
  for (const visibility of ['private', 'public'] as const) {
    test(`native selected batch ${size} ${visibility} work at 64/512/4096 live, retained and unrelated occurrences`, async () => {
      const db: GrowthDatabase = await openGrowthDatabase();
      let g: CollectionBatchFixture | undefined;
      try {
        g = await createCollectionBatchFixture({ pool: db.pool });
        const fixture = g;
        const subjectId = await fixture.createSubject('game');
        const backgroundSubjectId = await fixture.createSubject('game');
        const source = await fixture.make(visibility),
          destination = await fixture.make(visibility),
          unrelated = await fixture.make(visibility);
        const editor = await fixture.identity(batchScopes);
        await fixture.grant(source.id, editor.actor.accountId);
        const fullDestination = (size === 1 && visibility === 'public') || (size === 100 && visibility === 'private');
        if (fullDestination)
          for (let index = 0; index < 5000 - size; index++) {
            if (index % 16 === 0) await fixture.refresh();
            await fixture.add(destination.id, backgroundSubjectId, `full destination ${index}`);
          }
        const currentMembers: { id: string }[] = [];
        for (let index = 0; index < size + 1; index++)
          currentMembers.push(await fixture.add(source.id, subjectId, `selected ${index}`));
        const run = async () => {
          let from = await fixture.current(source.id),
            to = await fixture.current(destination.id);
          const members = currentMembers.slice(0, size);
          const body = {
            revision: from.revision,
            memberIds: members.map((member) => member.id).reverse(),
            destinationCollectionId: destination.id,
            destinationRevision: to.revision,
            after: null,
          };
          const key = entryKey();
          // Native destination denial, exact partial-invalid selection and a row-level fault are charged too.
          await expect(fixture.commands.transferMembers(editor.actor, source.id, body, entryKey())).rejects.toThrow();
          await expect(
            fixture.commands.transferMembers(
              fixture.owner.actor,
              source.id,
              { ...body, memberIds: [members[0]!.id, newId(routeOf(source.id)!)] },
              entryKey(),
            ),
          ).rejects.toThrow();
          await failFirstTransfer(fixture, source.id, body);
          const moved = await fixture.commands.transferMembers(fixture.owner.actor, source.id, body, key);
          expect(moved.value.members.map((member) => member.id)).toEqual(members.map((member) => member.id));
          const replay = await fixture.commands.transferMembers(fixture.owner.actor, source.id, body, key);
          expect(replay.replayed).toBe(true);
          expect(replay.position).toBe(moved.position);
          await expect(
            fixture.commands.transferMembers(
              fixture.owner.actor,
              source.id,
              { ...body, memberIds: [members[0]!.id, newId(routeOf(source.id)!)] },
              entryKey(),
            ),
          ).rejects.toThrow();
          from = await fixture.current(source.id);
          to = await fixture.current(destination.id);
          await fixture.commands.transferMembers(
            fixture.owner.actor,
            destination.id,
            {
              revision: to.revision,
              memberIds: members.map((member) => member.id),
              destinationCollectionId: source.id,
              destinationRevision: from.revision,
              after: null,
            },
            entryKey(),
          );
          from = await fixture.current(source.id);
          const removed = await fixture.commands.batchRemoveMembers(
            fixture.owner.actor,
            source.id,
            { revision: from.revision, memberIds: members.map((member) => member.id) },
            entryKey(),
          );
          for (const episode of removed.value.removed)
            await fixture.commands.restoreMember(fixture.owner.actor, source.id, episode.memberId, episode, entryKey());
          for (const collectionId of [source.id, destination.id])
            await syncSubjectListing({ pool: db.pool }, { subjectId, collectionId });
        };
        const report = await checkGrowth(db, {
          name: `selected occurrences ${size} ${visibility} ${fullDestination ? 'full destination' : 'growing destination'}`,
          scales: [64, 512, 4096],
          bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
          grow: async (_db, scale, previous) => {
            for (let index = previous; index < scale; index++) {
              if (index % 16 === 0) await fixture.refresh();
              await fixture.add(source.id, backgroundSubjectId, `source ${index}`);
              if (!fullDestination) await fixture.add(destination.id, backgroundSubjectId, `destination ${index}`);
              await fixture.add(unrelated.id, backgroundSubjectId, `unrelated ${index}`);
              for (const collectionId of [source.id, destination.id, unrelated.id]) {
                const retained = await fixture.add(collectionId, backgroundSubjectId, `retained ${index}`);
                const parent = await fixture.current(collectionId);
                await fixture.commands.removeMember(
                  fixture.owner.actor,
                  collectionId,
                  retained.id,
                  parent.revision,
                  entryKey(),
                );
              }
              await syncSubjectListing(
                { pool: db.pool },
                { subjectId: backgroundSubjectId, collectionId: unrelated.id },
              );
            }
          },
          prepare: async () => {
            await fixture.refresh();
            await fixture.refresh(editor);
          },
          operation: run,
          warmup: run,
        });
        expect(report.samples).toHaveLength(3);
      } finally {
        await g?.close();
        await db.close();
      }
    }, 3600000);
  }

test('a different curator on the exact same native route is explicitly unsupported even with both grants', async () => {
  const p = await pair();
  let other;
  do {
    other = await f.identity(batchScopes, routeOf(p.source.id)! >>> 4);
  } while (routeOf(other.actor.accountId) !== routeOf(p.source.id));
  const destination = await f.make('private', other);
  await f.grant(destination.id, f.owner.actor.accountId);
  await unchanged(
    [p.source.id, p.destination.id],
    await f.snapshot([p.source.id, p.destination.id]),
    await post(p.source.id, 'move', {
      ...moveBody(p),
      destinationCollectionId: destination.id,
      destinationRevision: destination.revision,
    }),
    409,
  );
}, 300000);

for (const hidden of ['original', 'terminal'] as const)
  test(`current hidden ${hidden} denies native transfer, removal and exact Undo`, async () => {
    const source = await f.make(),
      destination = await f.make();
    const a = await f.createSubject('game'),
      b = await f.createSubject('game');
    const member = await f.add(source.id, a > b ? a : b, 'redirected original occurrence');
    const live = await f.add(source.id, member.subjectId, 'live redirected original');
    const merged = await f.merge(a, b);
    expect(member.subjectId).toBe(merged.redirected);
    const current = await f.current(source.id);
    const removed = await post(source.id, 'batchRemove', { revision: current.revision, memberIds: [member.id] });
    expect(removed.status).toBe(200);
    const episode = (await removed.json()).removed[0];
    expect(
      (
        await f.send(
          'steward',
          'POST',
          `/v1/subjects/${hidden === 'original' ? merged.redirected : merged.survivor}:hide`,
          { reason: 'Current original and terminal source authorization' },
        )
      ).status,
    ).toBe(200);
    const ids = [source.id, destination.id];
    await unchanged(
      ids,
      await f.snapshot(ids),
      await f.send(f.owner.bearer, 'POST', `/v1/collections/${source.id}/members/${member.id}:restore`, {
        revision: episode.revision,
        deletionId: episode.deletionId,
      }),
      404,
    );
    // A different exact occurrence remains live; neither batch command may expose its hidden original/terminal.
    // The live occurrence was created before hiding in the source; Undo failure must not resurrect it.
    await unchanged(
      ids,
      await f.snapshot(ids),
      await post(source.id, 'move', {
        revision: current.revision + 1,
        memberIds: [live.id],
        destinationCollectionId: destination.id,
        destinationRevision: destination.revision,
        after: null,
      }),
      404,
    );
    await unchanged(
      ids,
      await f.snapshot(ids),
      await post(source.id, 'batchRemove', { revision: current.revision + 1, memberIds: [live.id] }),
      404,
    );
  }, 120000);

test('retained batch Undo refuses an occupied original ordinal without moving any current row', async () => {
  const p = await pair(2);
  const removed = await post(p.source.id, 'batchRemove', {
    revision: p.source.revision,
    memberIds: [p.members[0]!.id],
  });
  expect(removed.status).toBe(200);
  const episode = (await removed.json()).removed[0];
  await f.add(p.source.id, p.subjectId, 'occupies the original first gap', null);
  const ids = [p.source.id, p.destination.id];
  const response = await f.send(
    f.owner.bearer,
    'POST',
    `/v1/collections/${p.source.id}/members/${episode.memberId}:restore`,
    { revision: episode.revision, deletionId: episode.deletionId },
  );
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe('member_restore_occupied');
  const before = await f.snapshot(ids);
  await unchanged(
    ids,
    before,
    await post(p.source.id, 'batchRemove', {
      revision: (await f.current(p.source.id)).revision,
      memberIds: [p.members[1]!.id, episode.memberId],
    }),
    404,
  );
});

for (const side of ['source', 'destination'] as const)
  test(`native ${side} grant revocation after page preparation denies the whole transaction`, async () => {
    const p = await pair();
    const editor = await f.identity(batchScopes);
    await f.grant(p.source.id, editor.actor.accountId);
    await f.grant(p.destination.id, editor.actor.accountId);
    let revoked = false;
    const access = deriveAccess(f.access, {
      authorizePage: f.access.authorizePage!.bind(f.access),
      async preparePage(...args) {
        const evidence = await f.access.preparePage!(...args);
        if (!revoked) {
          revoked = true;
          await f.grant(p[side].id, editor.actor.accountId, true);
        }
        return evidence;
      },
    });
    const commands = createCollectionCommands({ pool: f.pool, access, clock: () => new Date(time) });
    const before = await f.snapshot([p.source.id, p.destination.id]);
    await expect(commands.transferMembers(editor.actor, p.source.id, moveBody(p), entryKey())).rejects.toThrow();
    expect(revoked).toBe(true);
    expect(await f.snapshot([p.source.id, p.destination.id])).toEqual(before);
  });

for (const side of ['source', 'destination'] as const)
  test(`native ${side} CAS changes after page preparation reject both mutations`, async () => {
    const p = await pair();
    let advanced = false;
    let before: Awaited<ReturnType<CollectionBatchFixture['snapshot']>>;
    const access = deriveAccess(f.access, {
      authorizePage: f.access.authorizePage!.bind(f.access),
      async preparePage(...args) {
        const evidence = await f.access.preparePage!(...args);
        if (!advanced) {
          advanced = true;
          await f.add(p[side].id, p.subjectId, 'concurrent actual occurrence');
          before = await f.snapshot([p.source.id, p.destination.id]);
        }
        return evidence;
      },
    });
    const commands = createCollectionCommands({ pool: f.pool, access, clock: () => new Date(time) });
    await expect(commands.transferMembers(f.owner.actor, p.source.id, moveBody(p), entryKey())).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(advanced).toBe(true);
    expect(await f.snapshot([p.source.id, p.destination.id])).toEqual(before!);
  });

for (const sourceVisibility of ['private', 'public'] as const)
  for (const destinationVisibility of ['private', 'public'] as const)
    test(`whole transfer and removal update actual empty ${sourceVisibility}/${destinationVisibility} public source truth exactly once`, async () => {
      const p = await pair(2, sourceVisibility);
      if (destinationVisibility !== sourceVisibility)
        p.destination = (
          await f.commands.updateCollection(
            f.owner.actor,
            p.destination.id,
            { revision: p.destination.revision, visibility: destinationVisibility },
            entryKey(),
          )
        ).value;
      const sync = async () => {
        for (const collectionId of [p.source.id, p.destination.id])
          await syncSubjectListing({ pool: f.pool }, { subjectId: p.subjectId, collectionId });
        const pairs = await subjectCollections(f.pool, p.subjectId, null, 100);
        const count = (
          await f.pool.query(
            'SELECT public_collection_count FROM library.subject_listing WHERE route=$1 AND subject_id=$2',
            [routeOf(p.subjectId), p.subjectId],
          )
        ).rows[0];
        expect(Number(count?.public_collection_count ?? 0)).toBe(pairs.length);
        return pairs;
      };
      expect((await sync()).length).toBe(Number(sourceVisibility === 'public'));
      const moved = await post(p.source.id, 'move', moveBody(p));
      expect(moved.status).toBe(200);
      const result = await moved.json();
      expect(result.source.memberCount).toBe(0);
      expect((await sync()).length).toBe(Number(destinationVisibility === 'public'));
      const key = entryKey(),
        body = { revision: result.destination.revision, memberIds: p.members.map((member) => member.id) };
      const removed = await post(p.destination.id, 'batchRemove', body, key);
      expect(removed.status).toBe(200);
      const episodes = (await removed.json()).removed;
      expect(await sync()).toHaveLength(0);
      expect((await post(p.destination.id, 'batchRemove', body, key)).status).toBe(200);
      expect(await sync()).toHaveLength(0);
      for (const episode of episodes)
        expect(
          (
            await f.send(
              f.owner.bearer,
              'POST',
              `/v1/collections/${p.destination.id}/members/${episode.memberId}:restore`,
              { deletionId: episode.deletionId, revision: episode.revision },
            )
          ).status,
        ).toBe(200);
      expect((await sync()).length).toBe(Number(destinationVisibility === 'public'));
    }, 120000);
