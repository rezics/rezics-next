import { AuthenticationError } from '../../src/request/access.ts';
import { reinstateAccount, suspendAccount } from '../support/native-suspension-driver.ts';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { EVENT_TYPES } from '../../src/events/log.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { createCollectionCommands } from '../../src/library/collections.ts';
import type { Collection, CollectionMember } from '../../src/library/collection-model.ts';
import { listMembers, readCollection } from '../../src/library/collection-store.ts';
import { GENERATED_ORDINAL_KEY_LENGTH, MAX_ORDINAL_KEY_LENGTH, respacedKeys } from '../../src/library/ordinal.ts';
import { createAccess } from '../../src/access/index.ts';
import { accessCheck, type Access, type AccountActor, type Actor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { seedCollectionGrowthPopulation } from './support/collection-growth-population.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const route = 0x5c31;
const curatorScopes = [
  'collection:create',
  'collection:read',
  'collection:update',
  'collection:delete',
  'subject:read',
];
const pool = createPool(databaseUrl);
const key = () => randomUUID();
const anonymous: Actor = { kind: 'anonymous' };

let access: Access;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
let commands: ReturnType<typeof createCollectionCommands>;
let owner: AccountActor;
let other: AccountActor;
let unscoped: AccountActor;
let suspendedActor: AccountActor;
let suspendedId: string;
let subjectA: string;
let subjectB: string;
let growth: GrowthDatabase | undefined;
const routeKey = new Uint8Array(32).fill(92);

beforeAll(async () => {
  signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'library', alg: 'ES256' };
  access = createAccess({
    actions: new Map([
      ['collection:create', { anonymous: false, 'x-resource-types': ['library.collection'] }],
      ['collection:read', { anonymous: false }],
      ['collection:update', { anonymous: false }],
      ['collection:delete', { anonymous: false }],
      ['subject:read', { anonymous: true }],
    ]),
    auth: {
      issuer: 'https://auth.example.test',
      audience: 'https://api.rezics.test',
      jwksUrl: 'https://auth.example.test/jwks',
      fetch: async () => Response.json({ keys: [jwk] }),
    },
  });
  commands = createCollectionCommands({ pool, access });
  const ownerId = newId(route);
  const otherId = newId(route);
  suspendedId = newId(route);
  const unscopedId = newId(route);
  for (const id of [ownerId, otherId, suspendedId, unscopedId]) await insertAccount(pool, id);
  owner = await authenticate(ownerId, curatorScopes);
  other = await authenticate(otherId, curatorScopes);
  unscoped = await authenticate(unscopedId, ['subject:read']);
  suspendedActor = await authenticate(suspendedId, curatorScopes);
  await bootstrapRelease(pool, bundledRelease);
  subjectA = await makeSubject(owner, 'First subject');
  subjectB = await makeSubject(owner, 'Second subject');
});

beforeEach(async () => {
  owner = await authenticate(owner.accountId, curatorScopes);
  other = await authenticate(other.accountId, curatorScopes);
  unscoped = await authenticate(unscoped.accountId, ['subject:read']);
  suspendedActor = await authenticate(suspendedId, curatorScopes);
});

afterAll(async () => {
  await pool.end();
  if (growth) await growth.close();
});

async function insertAccount(target: Pool, id: string): Promise<void> {
  await target.query(
    `INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
     VALUES ($1, $2, 'actor', 'active', $2, false, 1, true)`,
    [routeOf(id), id],
  );
}

async function authenticate(id: string, scopes: readonly string[], target: Pool = pool): Promise<AccountActor> {
  const current = await target.query(
    'SELECT minimum_authn_epoch::text AS epoch FROM access.account WHERE route=$1 AND account_id=$2',
    [routeOf(id), id],
  );
  const token = await new SignJWT({
    client_id: 'web',
    scope: scopes.join(' '),
    authn_epoch: Number(current.rows[0].epoch),
    auth_time: Math.floor(Date.now() / 1000),
    amr: ['pwd'],
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'library', typ: 'at+jwt' })
    .setIssuer('https://auth.example.test')
    .setAudience('https://api.rezics.test')
    .setSubject(id)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signing.privateKey);
  return access.authenticate(token, { pool: target, deadline: Date.now() + 290_000 });
}

async function makeSubject(actor: AccountActor, label: string, target: Pool = pool): Promise<string> {
  const idempotencyKey = `collection-subject-${randomUUID()}`;
  const created = await createSubject(target, {
    actor,
    target: subjectTarget(routeKey, actor.accountId, idempotencyKey),
    idempotencyKey,
    digest: createHash('sha256').update(idempotencyKey).digest(),
    item: { type: 'schema:Book', labels: { en: label } },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return created.subject.id;
}

async function read(id: string, target: Pool = pool): Promise<Collection | null> {
  const idRoute = routeOf(id);
  if (idRoute === null) return null;
  return withConnection(target, (client) => readCollection(client, idRoute, id));
}

async function membersOf(id: string, target: Pool = pool): Promise<CollectionMember[]> {
  return withConnection(target, (client) => listMembers(client, routeOf(id)!, id, { after: null, limit: 5000 }));
}

async function footprint(target: Pool = pool) {
  const result = await target.query<{
    collections: number;
    members: number;
    events: number;
    receipts: number;
    grants: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM library.collection) AS collections,
       (SELECT count(*)::int FROM library.collection_member) AS members,
       (SELECT count(*)::int FROM core.outbox) AS events,
       (SELECT count(*)::int FROM core.receipt) AS receipts,
       (SELECT count(*)::int FROM access.resource_role_grant) AS grants`,
  );
  return result.rows[0]!;
}

async function commandEvents(partition: number, position: bigint) {
  const result = await pool.query<{ type: string; subject: string | null; data: Record<string, unknown> }>(
    'SELECT type, subject, data FROM core.outbox WHERE partition_no = $1 AND position = $2 ORDER BY event_seq',
    [partition, position.toString()],
  );
  for (const row of result.rows) {
    const schema = EVENT_TYPES[row.type as keyof typeof EVENT_TYPES];
    expect(schema, row.type).toBeDefined();
    expect(Value.Check(schema!, row.data)).toBe(true);
    expect(row.data.collectionId).toBe(row.subject);
  }
  return result.rows;
}

async function caught(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    return {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : '',
      code: error instanceof ProblemError ? error.code : null,
    };
  }
  throw new Error('expected a refusal');
}

async function allows(actor: AccountActor, action: string, id: string): Promise<boolean> {
  const resource = { route: routeOf(id)!, id };
  const check = await accessCheck(access, actor, action, resource, { pool, deadline: Date.now() + 5000 });
  return withConnection(pool, (client) => check(client));
}

test('an active account creates its collection and receives the owner role', async () => {
  const requestKey = key();
  const created = await commands.createCollection(
    owner,
    { title: 't'.repeat(200), description: 'd'.repeat(2000), visibility: 'private' },
    requestKey,
  );
  expect(created.replayed).toBe(false);
  expect(routeOf(created.value.id)).toBe(routeOf(owner.accountId));
  expect(created.value).toMatchObject({
    curatorAccountId: owner.accountId,
    title: 't'.repeat(200),
    description: 'd'.repeat(2000),
    visibility: 'private',
    state: 'active',
    revision: 1,
    memberCount: 0,
    orderEpoch: 0,
  });
  expect(await read(created.value.id)).toEqual(created.value);

  const grants = await pool.query<{ subject_id: string; grant_role: string }>(
    `SELECT subject_id, grant_role FROM access.resource_role_grant WHERE route = $1 AND resource_id = $2 ORDER BY grant_role`,
    [routeOf(created.value.id), created.value.id],
  );
  expect(grants.rows).toEqual([{ subject_id: owner.accountId, grant_role: 'library.collection.owner' }]);
  expect(await allows(owner, 'collection:read', created.value.id)).toBe(true);
  expect(await allows(owner, 'collection:update', created.value.id)).toBe(true);
  expect(await allows(owner, 'collection:delete', created.value.id)).toBe(true);
  expect(await allows(other, 'collection:update', created.value.id)).toBe(false);

  const events = await commandEvents(created.partition, created.position);
  expect(events.map((row) => row.type)).toEqual(['com.rezics.library.collection.updated.v1']);

  const beforeReplay = await footprint();
  const replay = await commands.createCollection(
    owner,
    { title: 't'.repeat(200), description: 'd'.repeat(2000), visibility: 'private' },
    requestKey,
  );
  expect(replay.replayed).toBe(true);
  expect(replay.value).toEqual(created.value);
  expect(await footprint()).toEqual(beforeReplay);

  const before = await footprint();
  await expect(
    commands.createCollection(owner, { title: 'Other title', visibility: 'private' }, requestKey),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(await footprint()).toEqual(before);
});

test('creating a public collection emits a listing change and other visibilities do not', async () => {
  const published = await commands.createCollection(owner, { title: 'Public', visibility: 'public' }, key());
  expect((await commandEvents(published.partition, published.position)).map((row) => row.type)).toEqual([
    'com.rezics.library.collection.updated.v1',
    'com.rezics.library.collection.listing.changed.v1',
  ]);
  const unlisted = await commands.createCollection(
    owner,
    { title: 'Unlisted', description: '', visibility: 'unlisted' },
    key(),
  );
  expect(unlisted.value.description).toBe('');
  expect((await commandEvents(unlisted.partition, unlisted.position)).map((row) => row.type)).toEqual([
    'com.rezics.library.collection.updated.v1',
  ]);
});

test('members keep first, after and last placement for repeated subjects', async () => {
  const created = await commands.createCollection(owner, { title: 'Order', visibility: 'private' }, key());
  const id = created.value.id;
  const first = await commands.addMember(owner, id, { subjectId: subjectA }, key());
  const leading = await commands.addMember(owner, id, { subjectId: subjectB, after: null }, key());
  const repeated = await commands.addMember(owner, id, { subjectId: subjectA, after: leading.value.id }, key());
  const trailing = await commands.addMember(owner, id, { subjectId: subjectB, note: 'n'.repeat(1000) }, key());
  expect((await membersOf(id)).map((member) => member.id)).toEqual([
    leading.value.id,
    repeated.value.id,
    first.value.id,
    trailing.value.id,
  ]);
  expect((await membersOf(id)).map((member) => member.subjectId)).toEqual([subjectB, subjectA, subjectA, subjectB]);
  expect(new Set((await membersOf(id)).map((member) => member.ordinalKey)).size).toBe(4);
  expect((await membersOf(id)).every((member) => member.ordinalKey.length <= MAX_ORDINAL_KEY_LENGTH)).toBe(true);

  const moved = await commands.moveMember(owner, id, trailing.value.id, { after: leading.value.id }, key());
  const promoted = await commands.moveMember(owner, id, repeated.value.id, { after: null }, key());
  expect((await membersOf(id)).map((member) => member.id)).toEqual([
    promoted.value.id,
    leading.value.id,
    moved.value.id,
    first.value.id,
  ]);
  await Bun.sleep(10);
  const noted = await commands.updateMemberNote(owner, id, promoted.value.id, { note: 'Kept' }, key());
  const cleared = await commands.updateMemberNote(owner, id, promoted.value.id, { note: '' }, key());
  const removed = await commands.removeMember(owner, id, first.value.id, key());
  const stored = await read(id);
  expect(noted.value.note).toBe('Kept');
  expect(cleared.value.note).toBe('');
  expect(removed.value.id).toBe(first.value.id);
  expect(stored).toMatchObject({ revision: 1, memberCount: 3, orderEpoch: 0 });
  expect(Date.parse(stored!.updatedAt)).toBeGreaterThan(Date.parse(created.value.updatedAt));
  expect((await membersOf(id)).map((member) => member.id)).toEqual([
    promoted.value.id,
    leading.value.id,
    moved.value.id,
  ]);
  const memberEvents = await commandEvents(removed.partition, removed.position);
  expect(memberEvents.map((row) => row.type)).toEqual(['com.rezics.library.collection.member.changed.v1']);
  expect(memberEvents[0]!.data).toEqual({ collectionId: id, memberId: first.value.id, subjectId: subjectA });
});

test('repeated inserts after one member stay within the ordinal limit and respace in the same command', async () => {
  const created = await commands.createCollection(owner, { title: 'Gap', visibility: 'private' }, key());
  const anchor = await commands.addMember(owner, created.value.id, { subjectId: subjectA }, key());
  expect(anchor.value.ordinalKey.length).toBeLessThanOrEqual(GENERATED_ORDINAL_KEY_LENGTH);
  let respacedBeforeTwoHundredth = false;
  for (let index = 0; index < 300; index += 1) {
    // Authentication evidence lasts five seconds, and this loop outlives one proof.
    if (index % 40 === 0) owner = await authenticate(owner.accountId, curatorScopes);
    if (index === 199) respacedBeforeTwoHundredth = (await read(created.value.id))!.orderEpoch > 0;
    const added = await commands.addMember(
      owner,
      created.value.id,
      { subjectId: subjectA, after: anchor.value.id },
      key(),
    );
    expect(added.value.ordinalKey.length).toBeLessThanOrEqual(GENERATED_ORDINAL_KEY_LENGTH);
    if (index === 199) {
      const midway = await membersOf(created.value.id);
      expect(midway).toHaveLength(201);
      expect(midway.every((member) => member.ordinalKey.length <= MAX_ORDINAL_KEY_LENGTH)).toBe(true);
      expect(midway.every((member) => member.ordinalKey.length <= GENERATED_ORDINAL_KEY_LENGTH)).toBe(true);
    }
  }
  expect(respacedBeforeTwoHundredth).toBe(true);
  const stored = await read(created.value.id);
  const members = await membersOf(created.value.id);
  expect(stored).toMatchObject({ revision: 1, memberCount: 301 });
  expect(stored!.orderEpoch).toBeGreaterThan(0);
  expect(members).toHaveLength(301);
  expect(
    members.every((member) => member.ordinalKey.length >= 1 && member.ordinalKey.length <= MAX_ORDINAL_KEY_LENGTH),
  ).toBe(true);
  expect(members.every((member) => member.ordinalKey.length <= GENERATED_ORDINAL_KEY_LENGTH)).toBe(true);
  expect(members[0]!.id).toBe(anchor.value.id);
  expect(new Set(members.map((member) => member.ordinalKey)).size).toBe(members.length);
});

test('only the curator changes a collection by revision, and a stale revision conflicts', async () => {
  const created = await commands.createCollection(owner, { title: 'Editable', visibility: 'private' }, key());
  const id = created.value.id;
  const renamed = await commands.updateCollection(owner, id, { revision: 1, title: 'Renamed' }, key());
  expect(renamed.value).toMatchObject({ title: 'Renamed', description: null, visibility: 'private', revision: 2 });
  expect((await commandEvents(renamed.partition, renamed.position)).map((row) => row.type)).toEqual([
    'com.rezics.library.collection.updated.v1',
  ]);

  const before = await read(id);
  const stale = await footprint();
  await expect(commands.updateCollection(owner, id, { revision: 1, title: 'Stale' }, key())).rejects.toMatchObject({
    code: 'conflict',
  });
  expect(await read(id)).toEqual(before);
  expect(await footprint()).toEqual(stale);

  const described = await commands.updateCollection(owner, id, { revision: 2, description: null }, key());
  expect(described.value).toMatchObject({ title: 'Renamed', description: null, revision: 3 });
  const published = await commands.updateCollection(owner, id, { revision: 3, visibility: 'public' }, key());
  expect((await commandEvents(published.partition, published.position)).map((row) => row.type)).toEqual([
    'com.rezics.library.collection.updated.v1',
    'com.rezics.library.collection.listing.changed.v1',
  ]);
  const titled = await commands.updateCollection(owner, id, { revision: 4, title: 'Still public' }, key());
  expect((await commandEvents(titled.partition, titled.position)).map((row) => row.type)).toEqual([
    'com.rezics.library.collection.updated.v1',
  ]);
  const concealed = await commands.updateCollection(owner, id, { revision: 5, visibility: 'unlisted' }, key());
  expect((await commandEvents(concealed.partition, concealed.position)).map((row) => row.type)).toEqual([
    'com.rezics.library.collection.updated.v1',
    'com.rezics.library.collection.listing.changed.v1',
  ]);
  const hidden = await commands.updateCollection(owner, id, { revision: 6, visibility: 'private' }, key());
  expect((await commandEvents(hidden.partition, hidden.position)).map((row) => row.type)).toEqual([
    'com.rezics.library.collection.updated.v1',
  ]);

  await expect(commands.deleteCollection(owner, id, 6, key())).rejects.toMatchObject({ code: 'conflict' });
  expect((await read(id))!.state).toBe('active');
  const removed = await commands.deleteCollection(owner, id, 7, key());
  expect(removed.value.state).toBe('deleted');
  expect((await commandEvents(removed.partition, removed.position)).map((row) => row.type)).toEqual([
    'com.rezics.library.collection.deleted.v1',
  ]);

  const live = await commands.createCollection(owner, { title: 'Going', visibility: 'public' }, key());
  const deleted = await commands.deleteCollection(owner, live.value.id, 1, key());
  expect((await commandEvents(deleted.partition, deleted.position)).map((row) => row.type)).toEqual([
    'com.rezics.library.collection.deleted.v1',
    'com.rezics.library.collection.listing.changed.v1',
  ]);
  expect(await read(live.value.id)).toMatchObject({ state: 'deleted' });
});

test('invalid collection fields change nothing', async () => {
  const before = await footprint();
  const samples: unknown[] = [
    { title: '', visibility: 'private' },
    { title: 't'.repeat(201), visibility: 'private' },
    { title: 'a\0b', visibility: 'private' },
    { title: 'Ok', visibility: 'secret' },
    { title: 'Ok', description: 'd'.repeat(2001), visibility: 'public' },
  ];
  for (const sample of samples) {
    await expect(
      commands.createCollection(owner, sample as { title: string; visibility: 'private' }, key()),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  }
  const created = await commands.createCollection(owner, { title: 'Notes', visibility: 'private' }, key());
  await expect(
    commands.addMember(owner, created.value.id, { subjectId: subjectA, note: 'n'.repeat(1001) }, key()),
  ).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(
    commands.updateCollection(owner, created.value.id, { revision: 0, title: 'No' }, key()),
  ).rejects.toMatchObject({
    code: 'invalid_request',
  });
  expect(await read(created.value.id)).toMatchObject({ title: 'Notes', revision: 1, memberCount: 0 });
  expect((await footprint()).collections).toBe(before.collections + 1);
});

test('the 5001st member is collection_full and changes nothing', async () => {
  const created = await commands.createCollection(owner, { title: 'Full', visibility: 'private' }, key());
  const id = created.value.id;
  const keys = respacedKeys(5000);
  const idRoute = routeOf(id)!;
  const memberIds = Array.from({ length: 5000 }, () => newId(idRoute));
  await withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const context = { transactionId: randomUUID(), time: new Date().toISOString() };
      await client.query(
        `UPDATE library.collection
         SET member_count = 5000, updated_at = $3::timestamptz, transaction_id = $4
         WHERE route = $1 AND collection_id = $2`,
        [idRoute, id, context.time, context.transactionId],
      );
      const inserted = await client.query(
        `INSERT INTO library.collection_member
           (route, collection_id, member_id, subject_id, note, ordinal_key, added_at, transaction_id)
         SELECT $1, $2, members.member_id, $3, NULL, members.ordinal_key, $5::timestamptz, $6
         FROM UNNEST($4::uuid[], $7::text[]) AS members(member_id, ordinal_key)`,
        [idRoute, id, subjectA, memberIds, context.time, context.transactionId, keys],
      );
      if (inserted.rowCount !== 5000) throw new Error('member seed failed');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  expect(await read(id)).toMatchObject({ memberCount: 5000, revision: 1 });
  const before = await read(id);
  const counts = await footprint();
  const outsider = await caught(commands.addMember(other, id, { subjectId: subjectA }, key()));
  expect(outsider).toMatchObject({ code: 'not_found' });
  await expect(commands.addMember(owner, id, { subjectId: subjectA }, key())).rejects.toMatchObject({
    code: 'collection_full',
  });
  expect(await read(id)).toEqual(before);
  expect(await footprint()).toEqual(counts);
  expect((await membersOf(id)).length).toBe(5000);
});

test('refused personas and another account change nothing, and private collections match unknown ones', async () => {
  const created = await commands.createCollection(owner, { title: 'Mine', visibility: 'private' }, key());
  const id = created.value.id;
  const published = await commands.createCollection(owner, { title: 'Shown', visibility: 'public' }, key());
  const quiet = await commands.createCollection(owner, { title: 'Quiet', visibility: 'unlisted' }, key());
  const unlisted = await commands.createCollection(owner, { title: 'Gone', visibility: 'unlisted' }, key());
  await commands.deleteCollection(owner, unlisted.value.id, 1, key());
  const unknown = newId(route);
  await suspendAccount(pool, suspendedId);
  const before = await footprint();
  const stored = await read(id);

  const unknownRefusal = await caught(commands.updateCollection(other, unknown, { revision: 1, title: 'Nope' }, key()));
  const malformed = await caught(
    commands.updateCollection(other, 'not-a-collection', { revision: 1, title: 'Nope' }, key()),
  );
  const hidden = await caught(commands.updateCollection(other, id, { revision: 1, title: 'Nope' }, key()));
  const deleted = await caught(
    commands.updateCollection(other, unlisted.value.id, { revision: 2, title: 'Nope' }, key()),
  );
  expect(hidden).toEqual(unknownRefusal);
  expect(malformed).toEqual(unknownRefusal);
  expect(deleted).toEqual(unknownRefusal);
  expect(unknownRefusal).toMatchObject({ code: 'not_found', message: 'Not Found' });

  const anonymousHidden = await caught(commands.updateCollection(anonymous, id, { revision: 1, title: 'Nope' }, key()));
  const anonymousUnknown = await caught(
    commands.updateCollection(anonymous, unknown, { revision: 1, title: 'Nope' }, key()),
  );
  expect(anonymousHidden).toEqual(anonymousUnknown);
  expect(anonymousHidden).toEqual(unknownRefusal);

  const suspendedHidden = await caught(commands.deleteCollection(suspendedActor, id, 1, key()));
  const suspendedUnknown = await caught(commands.deleteCollection(suspendedActor, unknown, 1, key()));
  expect(suspendedHidden).toEqual(suspendedUnknown);

  for (const collectionId of [published.value.id, quiet.value.id]) {
    const refusal = await caught(commands.updateCollection(other, collectionId, { revision: 1, title: 'Nope' }, key()));
    expect(refusal.code === 'not_found' || refusal.name === 'GrantDeniedError').toBe(true);
    if (refusal.code === 'not_found') expect(refusal).toEqual(unknownRefusal);
  }

  {
    const ownHidden = await caught(
      commands.updateCollection(suspendedActor, id, { revision: 1, title: 'Nope' }, key()),
    );
    const ownUnknown = await caught(
      commands.updateCollection(suspendedActor, unknown, { revision: 1, title: 'Nope' }, key()),
    );
    expect(ownHidden).toEqual(ownUnknown);
    await expect(
      commands.createCollection(suspendedActor, { title: 'Later', visibility: 'private' }, key()),
    ).rejects.toBeInstanceOf(AuthenticationError);
  }

  await expect(
    commands.createCollection(anonymous, { title: 'No', visibility: 'private' }, key()),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(
    commands.createCollection(unscoped, { title: 'No', visibility: 'private' }, key()),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  const withoutUpdate = await authenticate(owner.accountId, ['collection:create', 'collection:read', 'subject:read']);
  await expect(
    commands.updateCollection(withoutUpdate, id, { revision: 1, title: 'Scoped out' }, key()),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await read(id)).toEqual(stored);
  expect(await read(published.value.id)).toMatchObject({ title: 'Shown', revision: 1 });
  expect(await read(quiet.value.id)).toMatchObject({ title: 'Quiet', revision: 1, visibility: 'unlisted' });
  expect(await footprint()).toEqual(before);
  await reinstateAccount(pool, suspendedId);

  const replayKey = key();
  const replayed = await commands.createCollection(owner, { title: 'Replay me', visibility: 'private' }, replayKey);
  await suspendAccount(pool, owner.accountId);
  try {
    await expect(
      commands.createCollection(owner, { title: 'Replay me', visibility: 'private' }, replayKey),
    ).rejects.toBeInstanceOf(AuthenticationError);
    expect(await read(replayed.value.id)).toMatchObject({ title: 'Replay me', revision: 1 });
  } finally {
    await reinstateAccount(pool, owner.accountId);
  }
});

async function prepareGrowth(): Promise<{
  database: GrowthDatabase;
  actor: AccountActor;
  subjectId: string;
  collectionCommands: ReturnType<typeof createCollectionCommands>;
}> {
  if (growth) await growth.close();
  growth = undefined;
  const database = await openGrowthDatabase(databaseUrl);
  growth = database;
  await bootstrapRelease(database.pool, bundledRelease);
  const accountId = newId(route);
  await insertAccount(database.pool, accountId);
  const actor = await authenticate(accountId, curatorScopes, database.pool);
  const subjectId = await makeSubject(actor, 'Growth subject', database.pool);
  return { database, actor, subjectId, collectionCommands: createCollectionCommands({ pool: database.pool, access }) };
}

function equalStatements(samples: { cost: { statements: number } }[]): void {
  expect(new Set(samples.map((sample) => sample.cost.statements)).size).toBe(1);
  expect(samples[0]!.cost.statements).toBeGreaterThan(0);
}

test('create cost stays constant as unrelated collections grow', async () => {
  const prepared = await prepareGrowth();
  const report = await checkGrowth(prepared.database, {
    name: 'collection create',
    bounds: { rows: 'logarithmic', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) =>
      seedCollectionGrowthPopulation(database, scale, previous, prepared.actor.accountId, prepared.subjectId),
    operation: async (database, _scale, repetition) => {
      const actor = await authenticate(prepared.actor.accountId, curatorScopes, database.pool);
      await prepared.collectionCommands.createCollection(
        actor,
        { title: `Created ${repetition}`, visibility: 'private' },
        `growth-create-${repetition}`,
      );
    },
  });
  equalStatements([...report.samples]);
});

test('update cost stays constant as unrelated collections grow', async () => {
  const prepared = await prepareGrowth();
  const created = await prepared.collectionCommands.createCollection(
    prepared.actor,
    { title: 'Stable', visibility: 'private' },
    key(),
  );
  let revision = 1;
  const report = await checkGrowth(prepared.database, {
    name: 'collection update',
    bounds: { rows: 'logarithmic', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) =>
      seedCollectionGrowthPopulation(database, scale, previous, prepared.actor.accountId, prepared.subjectId),
    operation: async (database, _scale, repetition) => {
      const expected = revision;
      revision += 1;
      const actor = await authenticate(prepared.actor.accountId, curatorScopes, database.pool);
      await prepared.collectionCommands.updateCollection(
        actor,
        created.value.id,
        { revision: expected, title: `Updated ${repetition}` },
        `growth-update-${repetition}`,
      );
    },
  });
  equalStatements([...report.samples]);
});

test('add cost stays constant as unrelated collections grow', async () => {
  const prepared = await prepareGrowth();
  const created = await prepared.collectionCommands.createCollection(
    prepared.actor,
    { title: 'Members', visibility: 'private' },
    key(),
  );
  const report = await checkGrowth(prepared.database, {
    name: 'collection add',
    bounds: { rows: 'logarithmic', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) =>
      seedCollectionGrowthPopulation(database, scale, previous, prepared.actor.accountId, prepared.subjectId),
    operation: async (database, _scale, repetition) => {
      const actor = await authenticate(prepared.actor.accountId, curatorScopes, database.pool);
      await prepared.collectionCommands.addMember(
        actor,
        created.value.id,
        { subjectId: prepared.subjectId },
        `growth-add-${repetition}`,
      );
    },
  });
  equalStatements([...report.samples]);
});

test('move cost stays constant as unrelated collections grow', async () => {
  const prepared = await prepareGrowth();
  const created = await prepared.collectionCommands.createCollection(
    prepared.actor,
    { title: 'Movable', visibility: 'private' },
    key(),
  );
  const member = await prepared.collectionCommands.addMember(
    prepared.actor,
    created.value.id,
    { subjectId: prepared.subjectId },
    key(),
  );
  const report = await checkGrowth(prepared.database, {
    name: 'collection move',
    bounds: { rows: 'logarithmic', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) =>
      seedCollectionGrowthPopulation(database, scale, previous, prepared.actor.accountId, prepared.subjectId),
    operation: async (database, _scale, repetition) => {
      const actor = await authenticate(prepared.actor.accountId, curatorScopes, database.pool);
      await prepared.collectionCommands.moveMember(
        actor,
        created.value.id,
        member.value.id,
        { after: null },
        `growth-move-${repetition}`,
      );
    },
  });
  equalStatements([...report.samples]);
});

test('remove cost stays constant as unrelated collections grow', async () => {
  const prepared = await prepareGrowth();
  const created = await prepared.collectionCommands.createCollection(
    prepared.actor,
    { title: 'Removable', visibility: 'private' },
    key(),
  );
  const members: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    const member = await prepared.collectionCommands.addMember(
      prepared.actor,
      created.value.id,
      { subjectId: prepared.subjectId },
      `growth-seed-remove-${index}`,
    );
    members.push(member.value.id);
  }
  let cursor = 0;
  const report = await checkGrowth(prepared.database, {
    name: 'collection remove',
    bounds: { rows: 'logarithmic', blocks: 'logarithmic', statements: 'constant' },
    grow: (database, scale, previous) =>
      seedCollectionGrowthPopulation(database, scale, previous, prepared.actor.accountId, prepared.subjectId),
    operation: async (database, _scale, repetition) => {
      const memberId = members[cursor];
      cursor += 1;
      const actor = await authenticate(prepared.actor.accountId, curatorScopes, database.pool);
      await prepared.collectionCommands.removeMember(actor, created.value.id, memberId!, `growth-remove-${repetition}`);
    },
  });
  equalStatements([...report.samples]);
});
