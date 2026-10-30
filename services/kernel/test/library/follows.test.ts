import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { Value } from 'typebox/value';
import type pg from 'pg';
import { readAccount, type Account } from '../../src/access/account-data.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { createAccess } from '../../src/access/permission.ts';
import { EVENT_TYPES, readBatch } from '../../src/events/log.ts';
import type { CollectionVisibility } from '../../src/library/collection-model.ts';
import * as collections from '../../src/library/collection-store.ts';
import { LibraryNotFoundError } from '../../src/library/command-support.ts';
import { createFollowCommands } from '../../src/library/follows.ts';
import * as followStore from '../../src/library/follow-store.ts';
import type { FollowTargetType } from '../../src/library/follow-model.ts';
import type { Access, AccountActor, Actor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { measure, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const FOLLOW_EVENT = 'com.rezics.library.follow.updated.v1';
const ownerRoute = 0x21a0;
const collectionRoute = 0x31c0;
const foreignCurator = newId(collectionRoute);
const routeKey = new Uint8Array(32).fill(47);
const scopes = ['follow:create', 'follow:delete', 'subject:read'] as const;

let database: GrowthDatabase;
let pool: pg.Pool;
let admin: pg.Pool;
let access: Access;
let now = Date.parse('2026-10-26T12:00:00.000Z');
const clock = () => new Date(now);
const tick = () => {
  now += 1000;
};

const accountIds = {
  owner: newId(ownerRoute),
  other: newId(ownerRoute),
  suspended: newId(ownerRoute),
  noScope: newId(ownerRoute),
};

function actor(accountId: string, actorScopes: readonly string[] = scopes): AccountActor {
  return {
    kind: 'account',
    accountId,
    clientId: 'library-follow-test',
    scopes: actorScopes,
    requestedBy: null,
    authnEpoch: 1,
  };
}

const owner = actor(accountIds.owner);
const other = actor(accountIds.other);
const suspended = actor(accountIds.suspended);
const noScope = actor(accountIds.noScope, ['subject:read']);
const anonymous: Actor = { kind: 'anonymous' };
const commands = () =>
  createFollowCommands({
    pool,
    access,
    clock,
  });

let followCommands: ReturnType<typeof createFollowCommands>;

function requestKey(): string {
  return `follow:${newId(ownerRoute)}`;
}

async function installAccount(accountId: string, state: 'active' | 'suspended'): Promise<Account> {
  await admin.query(
    `INSERT INTO access.account(route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch)
     VALUES ($1, $2, 'actor', $3, $4, false, 1)`,
    [ownerRoute, accountId, 'active', newId(ownerRoute)],
  );
  if (state === 'suspended') await suspendAccount(admin, accountId);
  const current = await readAccount(admin, ownerRoute, accountId);
  if (!current) throw new Error('Test account was not created');
  return current;
}

async function createReadableSubject(label: string = randomUUID()): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const key = `library-follow-${randomUUID()}`;
    const result = await createSubject(pool, {
      actor: owner,
      target: subjectTarget(routeKey, owner.accountId, key),
      idempotencyKey: key,
      digest: createHash('sha256').update(key).digest(),
      item: { type: 'schema:Book', labels: { en: label } },
      release: { digest: bundledDigest, release: bundledRelease },
      authorize: async () => true,
    });
    const subjectId = result.subject.id;
    if (partitionOf(routeOf(subjectId)!) !== partitionOf(ownerRoute)) return subjectId;
  }
  throw new Error('Subject partition matched the follower');
}

async function denyOwnerRead(subjectId: string): Promise<void> {
  const route = routeOf(subjectId);
  if (route === null) throw new Error('Test subject must have a route');
  await admin.query(
    `INSERT INTO access.resource_denial
       (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
     VALUES ($1, $2, $3, '', 'subject:read', 'resource', '(,)'::tstzrange, $4)`,
    [route, subjectId, owner.accountId, randomUUID()],
  );
}

async function insertCollection(visibility: CollectionVisibility, curatorAccountId: string) {
  const route = routeOf(curatorAccountId);
  if (route === null) throw new Error('Curator must carry a route');
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const row = await collections.insertCollection(
      client,
      route,
      {
        id: newId(route),
        curatorAccountId,
        title: 'Shelf',
        description: null,
        visibility,
      },
      { time: clock().toISOString(), transactionId: newId(route) },
    );
    await client.query('COMMIT');
    return row;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function tombstone(collectionId: string): Promise<void> {
  const route = routeOf(collectionId);
  if (route === null) throw new Error('Collection must carry a route');
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    expect(
      await collections.tombstoneCollection(client, route, collectionId, {
        time: clock().toISOString(),
        transactionId: newId(route),
      }),
    ).not.toBeNull();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedUnfollow(accountId: string, targetId: string, targetType: FollowTargetType): Promise<void> {
  const route = routeOf(accountId)!;
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    expect(
      await followStore.applyFollow(client, route, {
        accountId,
        targetId,
        targetType,
        intent: 'unfollow',
        reason: 'explicit',
        transactionId: newId(route),
        time: '2026-10-26T11:00:00.000Z',
      }),
    ).toBe(true);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function libraryFollow(subjectId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = await followCommands.followFromLibrary(client, ownerRoute, {
      accountId: owner.accountId,
      subjectId,
      transactionId: newId(ownerRoute),
      time: clock().toISOString(),
    });
    await client.query('COMMIT');
    return event;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function followEventRows(targetId: string): Promise<{ partition_no: number; subject: string; data: unknown }[]> {
  const result = await admin.query(
    `SELECT partition_no, subject, data
     FROM core.outbox
     WHERE type = $1 AND data->>'targetId' = $2
     ORDER BY partition_no, position, event_seq`,
    [FOLLOW_EVENT, targetId],
  );
  return result.rows;
}

async function refusal(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('expected a refusal');
}

function sameError(errors: Error[]): void {
  const first = errors[0];
  if (!first) throw new Error('expected a refusal');
  for (const error of errors) {
    expect(error).toBeInstanceOf(first.constructor);
    expect(error.name).toBe(first.name);
    expect(error.message).toBe(first.message);
  }
}

async function activity(): Promise<{ follows: number; events: number }> {
  const follows = await admin.query('SELECT count(*)::int AS count FROM library.follow');
  const events = await admin.query('SELECT count(*)::int AS count FROM core.outbox WHERE type = $1', [FOLLOW_EVENT]);
  return { follows: follows.rows[0].count, events: events.rows[0].count };
}

beforeAll(async () => {
  database = await openGrowthDatabase(databaseUrl);
  pool = database.pool;
  admin = database.admin;
  await bootstrapRelease(pool, bundledRelease);
  const accounts = new Map<string, Account>();
  accounts.set(accountIds.owner, await installAccount(accountIds.owner, 'active'));
  accounts.set(accountIds.other, await installAccount(accountIds.other, 'active'));
  accounts.set(accountIds.suspended, await installAccount(accountIds.suspended, 'suspended'));
  accounts.set(accountIds.noScope, await installAccount(accountIds.noScope, 'active'));
  access = createAccess({
    actions: new Map([['subject:read', { anonymous: true }]]),
    accountEvidence: (candidate) => accounts.get(candidate.accountId) ?? null,
  });
  followCommands = commands();
});

afterAll(async () => {
  if (database) await database.close();
});

test('an account follows, unfollows and refollows a readable subject in its own partition', async () => {
  const subjectId = await createReadableSubject('Followed book');
  const target = { targetId: subjectId, targetType: 'subject' as const };
  const followKey = requestKey();
  tick();
  const followed = await followCommands.follow(owner, target, followKey);
  expect(followed.changed).toBe(true);
  expect(followed.command).toMatchObject({ replayed: false, partition: partitionOf(ownerRoute) });
  expect(followed.follow).toMatchObject({
    accountId: owner.accountId,
    targetId: subjectId,
    targetType: 'subject',
    state: 'following',
    reason: 'explicit',
  });
  expect(await followCommands.readFollow(owner, subjectId)).toEqual(followed.follow);
  const stored = await admin.query(
    `SELECT route, account_id, target_type, state, reason FROM library.follow
     WHERE account_id = $1 AND target_id = $2`,
    [owner.accountId, subjectId],
  );
  expect(stored.rows).toEqual([
    {
      route: ownerRoute,
      account_id: owner.accountId,
      target_type: 'subject',
      state: 'following',
      reason: 'explicit',
    },
  ]);
  expect(await followEventRows(subjectId)).toEqual([
    { partition_no: partitionOf(ownerRoute), subject: owner.accountId, data: { targetId: subjectId } },
  ]);

  const replay = await followCommands.follow(owner, target, followKey);
  expect(replay.changed).toBe(false);
  expect(replay.command).toMatchObject({
    replayed: true,
    position: followed.command?.position,
    transactionId: followed.command?.transactionId,
  });
  expect(replay.follow).toEqual(followed.follow);
  expect(await followEventRows(subjectId)).toHaveLength(1);

  tick();
  const unfollowed = await followCommands.unfollow(owner, target, requestKey());
  expect(unfollowed.changed).toBe(true);
  expect(await followCommands.readFollow(owner, subjectId)).toMatchObject({
    state: 'unfollowed',
    reason: 'explicit',
  });
  expect(await followCommands.listFollows(owner, { cursor: null, limit: 100 })).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ targetId: subjectId })]),
  );

  tick();
  const refollowed = await followCommands.follow(owner, target, requestKey());
  expect(refollowed.changed).toBe(true);
  expect(await followCommands.readFollow(owner, subjectId)).toMatchObject({
    state: 'following',
    reason: 'explicit',
    accountId: owner.accountId,
  });
  const events = await followEventRows(subjectId);
  expect(events).toHaveLength(3);
  for (const event of events) {
    expect(event).toEqual({
      partition_no: partitionOf(ownerRoute),
      subject: owner.accountId,
      data: { targetId: subjectId },
    });
  }
  const schema = EVENT_TYPES[FOLLOW_EVENT];
  expect(Value.Check(schema, { targetId: subjectId })).toBe(true);
  expect(Value.Check(schema, { targetId: subjectId, state: 'following' })).toBe(false);
  expect(Value.Check(schema, {})).toBe(false);
  const seen: { type: string; subject?: string; data: unknown }[] = [];
  expect(
    await readBatch(pool, {
      consumer: 'library_follow',
      partition: partitionOf(ownerRoute),
      apply: async (envelopes) => {
        seen.push(...envelopes.flatMap((envelope) => envelope.events));
      },
    }),
  ).toMatchObject({ status: 'read' });
  expect(seen.filter((event) => event.type === FOLLOW_EVENT && event.subject === owner.accountId)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: FOLLOW_EVENT, subject: owner.accountId, data: { targetId: subjectId } }),
    ]),
  );
});

test('a collection follow is limited to an active public, unlisted, or curated shelf', async () => {
  const visible = await insertCollection('public', foreignCurator);
  const unlisted = await insertCollection('unlisted', foreignCurator);
  const curated = await insertCollection('private', owner.accountId);
  const removed = await insertCollection('public', foreignCurator);
  expect(partitionOf(routeOf(visible.id)!)).not.toBe(partitionOf(ownerRoute));
  await tombstone(removed.id);
  tick();
  for (const shelf of [visible, unlisted, curated]) {
    const followed = await followCommands.follow(owner, { targetId: shelf.id, targetType: 'collection' }, requestKey());
    expect(followed.changed).toBe(true);
    expect(followed.follow).toMatchObject({
      accountId: owner.accountId,
      targetId: shelf.id,
      targetType: 'collection',
      state: 'following',
      reason: 'explicit',
    });
    expect(followed.command?.partition).toBe(partitionOf(ownerRoute));
    expect(await followEventRows(shelf.id)).toEqual([
      { partition_no: partitionOf(ownerRoute), subject: owner.accountId, data: { targetId: shelf.id } },
    ]);
    tick();
  }
  const listed = await followCommands.listFollows(owner, { cursor: null, limit: 100 });
  const mine = listed.filter((row) => [visible.id, unlisted.id, curated.id].includes(row.targetId));
  expect(mine.map((row) => row.targetId)).toEqual([curated.id, unlisted.id, visible.id]);
  expect(listed.every((row) => row.accountId === owner.accountId && row.state === 'following')).toBe(true);
  const next = await followCommands.listFollows(owner, {
    cursor: { updatedAt: mine[0]!.updatedAt, targetId: mine[0]!.targetId },
    limit: 100,
  });
  expect(next.find((row) => row.targetId === curated.id)).toBeUndefined();
  expect(next.find((row) => row.targetId === unlisted.id)?.targetId).toBe(unlisted.id);

  tick();
  await followCommands.unfollow(owner, { targetId: curated.id, targetType: 'collection' }, requestKey());
  expect(
    (await followCommands.listFollows(owner, { cursor: null, limit: 100 })).some((row) => row.targetId === curated.id),
  ).toBe(false);
  expect(await followCommands.readFollow(owner, curated.id)).toMatchObject({
    state: 'unfollowed',
    reason: 'explicit',
  });
});

test('a membership step follows a space and never overrides an explicit unfollow', async () => {
  const spaceId = newId(collectionRoute);
  const stepKey = `community-join:${newId(ownerRoute)}:follow`;
  tick();
  const joined = await followCommands.followForMembership({ accountId: owner.accountId, spaceId, stepKey });
  expect(joined.changed).toBe(true);
  expect(joined.follow).toMatchObject({
    accountId: owner.accountId,
    targetId: spaceId,
    targetType: 'space',
    state: 'following',
    reason: 'membership',
  });
  expect(joined.command).toMatchObject({ replayed: false, partition: partitionOf(ownerRoute) });
  expect(await followEventRows(spaceId)).toEqual([
    { partition_no: partitionOf(ownerRoute), subject: owner.accountId, data: { targetId: spaceId } },
  ]);

  const redelivered = await followCommands.followForMembership({ accountId: owner.accountId, spaceId, stepKey });
  expect(redelivered.changed).toBe(false);
  expect(redelivered.command).toMatchObject({ replayed: true, position: joined.command?.position });
  expect(await followCommands.readFollow(owner, spaceId)).toEqual(joined.follow);
  expect(await followEventRows(spaceId)).toHaveLength(1);

  const again = await followCommands.followForMembership({
    accountId: owner.accountId,
    spaceId,
    stepKey: `community-join:${newId(ownerRoute)}:follow`,
  });
  expect(again.changed).toBe(false);
  expect(await followCommands.readFollow(owner, spaceId)).toEqual(joined.follow);
  expect(await followEventRows(spaceId)).toHaveLength(1);

  const declinedId = newId(collectionRoute);
  const declinedKey = `community-join:${newId(ownerRoute)}:follow`;
  await seedUnfollow(owner.accountId, declinedId, 'space');
  const before = await followCommands.readFollow(owner, declinedId);
  expect(before).toMatchObject({ state: 'unfollowed', reason: 'explicit', targetType: 'space' });
  const step = await followCommands.followForMembership({
    accountId: owner.accountId,
    spaceId: declinedId,
    stepKey: declinedKey,
  });
  expect(step.changed).toBe(false);
  expect(step.command).toBeNull();
  expect(await followCommands.readFollow(owner, declinedId)).toEqual(before);
  expect(await followEventRows(declinedId)).toEqual([]);
  const repeated = await followCommands.followForMembership({
    accountId: owner.accountId,
    spaceId: declinedId,
    stepKey: declinedKey,
  });
  expect(repeated.changed).toBe(false);
  expect(repeated.command).toBeNull();
  expect(await followCommands.readFollow(owner, declinedId)).toEqual(before);
  expect(await followEventRows(declinedId)).toEqual([]);
});

test('an implied library follow does not override an explicit unfollow', async () => {
  const subjectId = await createReadableSubject('Library book');
  tick();
  expect(await libraryFollow(subjectId)).toEqual({
    type: FOLLOW_EVENT,
    subject: owner.accountId,
    data: { targetId: subjectId },
  });
  expect(await followCommands.readFollow(owner, subjectId)).toMatchObject({
    state: 'following',
    reason: 'library',
    targetType: 'subject',
  });
  expect(await followEventRows(subjectId)).toEqual([]);

  tick();
  const explicit = await followCommands.follow(owner, { targetId: subjectId, targetType: 'subject' }, requestKey());
  expect(explicit.changed).toBe(true);
  expect(await followCommands.readFollow(owner, subjectId)).toMatchObject({ state: 'following', reason: 'explicit' });

  tick();
  await followCommands.unfollow(owner, { targetId: subjectId, targetType: 'subject' }, requestKey());
  const unfollowed = await followCommands.readFollow(owner, subjectId);
  expect(unfollowed).toMatchObject({ state: 'unfollowed', reason: 'explicit' });
  const events = (await followEventRows(subjectId)).length;
  expect(await libraryFollow(subjectId)).toBeNull();
  expect(await followCommands.readFollow(owner, subjectId)).toEqual(unfollowed);
  expect(await followEventRows(subjectId)).toHaveLength(events);
});

test('unknown, unreadable and private targets are refused alike and change nothing', async () => {
  const readableId = await createReadableSubject('Visible book');
  const unreadableId = await createReadableSubject('Denied book');
  await denyOwnerRead(unreadableId);
  const privateShelf = await insertCollection('private', foreignCurator);
  const deleted = await insertCollection('public', foreignCurator);
  await tombstone(deleted.id);
  const unknownSubjectId = newId(collectionRoute);
  const unknownCollectionId = newId(collectionRoute);
  const spaceId = newId(collectionRoute);
  const before = await activity();
  const errors = await Promise.all(
    [
      () => followCommands.follow(owner, { targetId: unknownSubjectId, targetType: 'subject' }, requestKey()),
      () => followCommands.follow(owner, { targetId: 'not-a-target', targetType: 'subject' }, requestKey()),
      () => followCommands.unfollow(owner, { targetId: unreadableId, targetType: 'subject' }, requestKey()),
      () => followCommands.follow(owner, { targetId: privateShelf.id, targetType: 'collection' }, requestKey()),
      () => followCommands.unfollow(owner, { targetId: deleted.id, targetType: 'collection' }, requestKey()),
      () => followCommands.follow(owner, { targetId: unknownCollectionId, targetType: 'collection' }, requestKey()),
      () => followCommands.follow(owner, { targetId: spaceId, targetType: 'space' }, requestKey()),
      () => followCommands.unfollow(owner, { targetId: spaceId, targetType: 'space' }, requestKey()),
      () => followCommands.follow(owner, { targetId: readableId, targetType: 'collection' }, requestKey()),
    ].map((run) => refusal(run)),
  );
  sameError(errors);
  expect(errors[0]).toBeInstanceOf(LibraryNotFoundError);
  expect(await activity()).toEqual(before);
  expect(await followCommands.readFollow(owner, readableId)).toBeNull();
  expect(await followCommands.readFollow(owner, privateShelf.id)).toBeNull();
});

test('suspended, anonymous and unauthorized actors change nothing at the module boundary', async () => {
  const subjectId = await createReadableSubject('Persona book');
  const privateShelf = await insertCollection('private', foreignCurator);
  const before = await activity();
  const people: Actor[] = [suspended, anonymous, noScope];
  const targets = [
    { targetId: subjectId, targetType: 'subject' as const },
    { targetId: newId(collectionRoute), targetType: 'subject' as const },
    { targetId: 'not-a-target', targetType: 'collection' as const },
    { targetId: privateShelf.id, targetType: 'collection' as const },
  ];
  const errors: Error[] = [];
  for (const person of people) {
    for (const target of targets) {
      errors.push(await refusal(() => followCommands.follow(person, target, requestKey())));
      errors.push(await refusal(() => followCommands.unfollow(person, target, requestKey())));
    }
  }
  errors.push(await refusal(() => followCommands.readFollow(anonymous, subjectId)));
  errors.push(await refusal(() => followCommands.listFollows(anonymous, { cursor: null, limit: 10 })));
  errors.push(
    await refusal(() =>
      followCommands.followForMembership({
        accountId: suspended.accountId,
        spaceId: newId(collectionRoute),
        stepKey: requestKey(),
      }),
    ),
  );
  sameError(errors);
  expect(errors[0]).toBeInstanceOf(GrantDeniedError);
  expect(await activity()).toEqual(before);
});

test("another account reads none of the owner's follows", async () => {
  const subjectId = await createReadableSubject('Private follow');
  const shelf = await insertCollection('public', foreignCurator);
  tick();
  await followCommands.follow(owner, { targetId: subjectId, targetType: 'subject' }, requestKey());
  tick();
  await followCommands.follow(owner, { targetId: shelf.id, targetType: 'collection' }, requestKey());
  expect(await followCommands.readFollow(other, subjectId)).toBeNull();
  expect(await followCommands.readFollow(other, shelf.id)).toBeNull();
  expect(await followCommands.readFollow(suspended, subjectId)).toBeNull();
  expect(await followCommands.listFollows(other, { cursor: null, limit: 100 })).toEqual([]);
  expect(
    (await followCommands.listFollows(suspended, { cursor: null, limit: 100 })).some(
      (row) => row.accountId === owner.accountId,
    ),
  ).toBe(false);

  tick();
  await followCommands.follow(other, { targetId: subjectId, targetType: 'subject' }, requestKey());
  const ownerView = await followCommands.readFollow(owner, subjectId);
  const otherView = await followCommands.readFollow(other, subjectId);
  expect(ownerView).toMatchObject({ accountId: owner.accountId, state: 'following' });
  expect(otherView).toMatchObject({ accountId: other.accountId, state: 'following' });
  expect(otherView).not.toEqual(ownerView);
  const otherList = await followCommands.listFollows(other, { cursor: null, limit: 100 });
  expect(otherList.every((row) => row.accountId === other.accountId)).toBe(true);
  expect(otherList.some((row) => row.targetId === shelf.id)).toBe(false);
  const rows = await admin.query(
    'SELECT account_id FROM library.follow WHERE route = $1 AND target_id = $2 ORDER BY account_id',
    [ownerRoute, subjectId],
  );
  expect(rows.rows.map((row) => row.account_id).sort()).toEqual([other.accountId, owner.accountId].sort());
});

test('statements per follow, membership step and page stay equal as unrelated follows grow', async () => {
  const scales = [1, 8, 64] as const;
  const followStatements: number[] = [];
  const membershipStatements: number[] = [];
  const pageStatements: number[] = [];
  let previous = 0;
  for (const scale of scales) {
    for (let index = previous; index < scale; index += 1) {
      const shelf = await insertCollection('public', owner.accountId);
      await followCommands.follow(owner, { targetId: shelf.id, targetType: 'collection' }, requestKey());
    }
    previous = scale;
    const shelf = await insertCollection('public', owner.accountId);
    const spaceId = newId(collectionRoute);
    const followed = await measure(database, () =>
      followCommands.follow(owner, { targetId: shelf.id, targetType: 'collection' }, requestKey()),
    );
    const stepped = await measure(database, () =>
      followCommands.followForMembership({
        accountId: owner.accountId,
        spaceId,
        stepKey: `community-join:${newId(ownerRoute)}:follow`,
      }),
    );
    const page = await measure(database, () => followCommands.listFollows(owner, { cursor: null, limit: 20 }));
    expect(followed.value.changed).toBe(true);
    expect(stepped.value.changed).toBe(true);
    expect(page.value.length).toBeGreaterThan(0);
    expect(page.value.length).toBeLessThanOrEqual(20);
    expect(page.value.every((row) => row.accountId === owner.accountId)).toBe(true);
    followStatements.push(followed.cost.statements);
    membershipStatements.push(stepped.cost.statements);
    pageStatements.push(page.cost.statements);
  }
  const followCost = followStatements[0]!;
  const membershipCost = membershipStatements[0]!;
  const pageCost = pageStatements[0]!;
  expect(followCost).toBeGreaterThan(0);
  expect(membershipCost).toBeGreaterThan(0);
  expect(pageCost).toBeGreaterThan(0);
  expect(followStatements).toEqual([followCost, followCost, followCost]);
  expect(membershipStatements).toEqual([membershipCost, membershipCost, membershipCost]);
  expect(pageStatements).toEqual([pageCost, pageCost, pageCost]);
}, 120_000);
