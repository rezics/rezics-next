import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { principalCommandIdentity } from '../../src/command/command.ts';
import * as store from '../../src/library/entry-store.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});

test('every DAO fill allocates an owner-routed identity and legacy null reads and writes preserve null', async () => {
  const c = await f.pool.connect();
  const accountId = f.owner.actor.accountId,
    route = routeOf(accountId)!;
  const subjectId = newId(route);
  const context = { transactionId: newId(route), time: '2026-10-28T12:00:00.000Z' };
  try {
    await c.query('BEGIN');
    const first = await store.insertEntry(
      c,
      route,
      { accountId, subjectId, requestedSubjectId: null, state: 'planned' },
      context,
    );
    expect(routeOf(first.incarnationId!)).toBe(route);
    const updated = await store.updateEntryState(
      c,
      route,
      accountId,
      subjectId,
      1,
      'completed',
      context,
      undefined,
      first.incarnationId!,
    );
    expect(updated?.incarnationId).toBe(first.incarnationId);
    expect(await store.deleteEntry(c, route, accountId, subjectId, 2, first.incarnationId!)).toEqual(updated);
    const next = await store.insertEntry(
      c,
      route,
      { accountId, subjectId, requestedSubjectId: null, state: 'planned' },
      context,
    );
    expect(next.incarnationId).not.toBe(first.incarnationId);
    // Model an existing legacy row, without assigning an identity at observation time.
    await c.query('UPDATE library.entry SET incarnation_id=NULL WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
      route,
      accountId,
      subjectId,
    ]);
    expect((await store.readEntry(c, route, accountId, subjectId))?.incarnationId).toBeNull();
    expect(
      (await store.pageEntries(c, route, accountId, { after: null, state: null, limit: 100 })).find(
        (x) => x.subjectId === subjectId,
      )?.incarnationId,
    ).toBeNull();
    expect(
      await store.updateEntryState(
        c,
        route,
        accountId,
        subjectId,
        1,
        'completed',
        context,
        undefined,
        first.incarnationId!,
      ),
    ).toBeNull();
    expect(await store.deleteEntry(c, route, accountId, subjectId, 1, first.incarnationId!)).toBeNull();
    const legacy = await store.updateEntryState(c, route, accountId, subjectId, 1, 'completed', context);
    expect(legacy?.incarnationId).toBeNull();
    expect((await store.deleteEntry(c, route, accountId, subjectId, 2))?.incarnationId).toBeNull();
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('omitted guards keep the original digest and receipt JSON without synthesizing identity', async () => {
  const subjectId = await f.createSubject('game'),
    key = entryKey();
  const original = await f.commands.putEntry(f.owner.actor, subjectId, { state: 'playing' }, key);
  const input = { subjectId, requestedSubjectId: null, state: 'playing', revision: null };
  const oldDigest = createHash('sha256')
    .update(canonicalize([principalCommandIdentity(f.owner.actor), 'library.entry.put', input])!)
    .digest();
  // Seed a pre-ABI receipt outcome, retaining the native receipt namespace and original digest.
  const receipt = await f.pool.query(
    `UPDATE core.receipt SET response=response #- '{entry,incarnationId}'
     WHERE principal_id=$1 AND command_kind='library.entry.put' AND idempotency_key=$2
     RETURNING request_digest,response`,
    [f.owner.actor.accountId, key],
  );
  expect(receipt.rows).toHaveLength(1);
  expect(receipt.rows[0].request_digest).toEqual(oldDigest);
  const before = await f.inspect();
  const replay = await f.commands.putEntry(f.owner.actor, subjectId, { state: 'playing' }, key);
  expect(replay.replayed).toBe(true);
  expect(replay.value).toEqual(receipt.rows[0].response);
  expect(replay.value.entry).not.toHaveProperty('incarnationId');
  expect(await f.inspect()).toEqual(before);
  const response = await f.send('owner', 'PUT', '/v1/libraryEntries/' + subjectId, { state: 'playing' }, key);
  expect(response.status).toBe(201);
  expect((await response.json()).libraryEntry).not.toHaveProperty('incarnationId');
  expect((await f.commands.readEntry(f.owner.actor, subjectId)).incarnationId).toBe(original.value.entry.incarnationId);
});

test('guarded receipts bind the supplied guard and replay after refill without a fresh CAS or profile check', async () => {
  const subjectId = await f.createSubject('game'),
    path = '/v1/libraryEntries/' + subjectId;
  const first = await f.commands.putEntry(f.owner.actor, subjectId, { state: 'playing' }, entryKey());
  const input = { state: 'playing', revision: 1, incarnationId: first.value.entry.incarnationId! };
  const key = entryKey();
  const updated = await f.commands.putEntry(f.owner.actor, subjectId, input, key);
  const deleteKey = entryKey();
  await f.commands.deleteEntry(f.owner.actor, subjectId, 2, deleteKey, input.incarnationId);
  const replacement = await f.commands.putEntry(f.owner.actor, subjectId, { state: 'playing' }, entryKey());
  await f.activate(f.replacementDigest);
  try {
    const before = await f.inspect();
    expect(await f.commands.putEntry(f.owner.actor, subjectId, input, key)).toEqual({ ...updated, replayed: true });
    expect(
      (await f.send('owner', 'PUT', path, { ...input, incarnationId: replacement.value.entry.incarnationId }, key))
        .status,
    ).toBe(422);
    expect((await f.send('owner', 'PUT', path, { state: 'playing', revision: 1 }, key)).status).toBe(422);
    expect(
      (await f.send('owner', 'DELETE', path + '?revision=2&incarnationId=' + input.incarnationId, undefined, deleteKey))
        .status,
    ).toBe(204);
    expect(
      (
        await f.send(
          'owner',
          'DELETE',
          path + '?revision=2&incarnationId=' + replacement.value.entry.incarnationId,
          undefined,
          deleteKey,
        )
      ).status,
    ).toBe(422);
    expect(await f.inspect()).toEqual(before);
  } finally {
    await f.activate(f.originalDigest);
  }
});

test('HTTP rejects null malformed and create-only incarnation guards without writing', async () => {
  const subjectId = await f.createSubject('game'),
    path = '/v1/libraryEntries/' + subjectId;
  const before = await f.inspect();
  for (const input of [
    { state: 'playing', incarnationId: newId(routeOf(f.owner.actor.accountId)!) },
    { state: 'playing', revision: 1, incarnationId: null },
    { state: 'playing', revision: 1, incarnationId: 'invalid' },
  ])
    expect((await f.send('owner', 'PUT', path, input)).status).toBe(400);
  expect((await f.send('owner', 'DELETE', path + '?revision=1&incarnationId=invalid')).status).toBe(400);
  expect(await f.inspect()).toEqual(before);
});
