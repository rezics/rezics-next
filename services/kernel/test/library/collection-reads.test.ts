import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../src/access/index.ts';
import { PROBLEMS, ProblemError } from '../../src/http/problem.ts';
import { createCollectionReads, type CollectionView } from '../../src/library/collection-reads.ts';
import type { Collection, CollectionMember, CollectionVisibility } from '../../src/library/collection-model.ts';
import { createCollectionCommands } from '../../src/library/collections.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { libraryWorkModule } from '../../src/library/work-module.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { syncSubjectListing } from '../../src/library/listing.ts';
import type { Access, AccountActor, Actor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject, subjectTarget } from '../../src/semantic/subject.ts';
import { decodeCursor, encodeCursor } from '../../src/tokens/cursor.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

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
const anonymous: Actor = { kind: 'anonymous' };
const tokens: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(11)]]) };
const routeKey = new Uint8Array(32).fill(92);
const key = () => randomUUID();

let growth: GrowthDatabase;
let pool: Pool;
let workClient: Awaited<ReturnType<typeof createWorkClient>>;
let worker: Awaited<ReturnType<typeof composeWork>>;
let access: Access;
let signing: Awaited<ReturnType<typeof generateKeyPair>>;
let commands: ReturnType<typeof createCollectionCommands>;
let ordered: ReturnType<typeof createCollectionCommands>;
let reads: ReturnType<typeof createCollectionReads>;
let owner: AccountActor;
let other: AccountActor;
let unscoped: AccountActor;
let suspendedActor: AccountActor;
let subjectA: string;
let subjectB: string;
let now = Date.parse('2026-06-01T00:00:00.000Z');

const clock = () => new Date(now);

beforeAll(async () => {
  growth = await openGrowthDatabase(databaseUrl);
  pool = growth.pool;
  workClient = await createWorkClient(pool.options.connectionString!);
  worker = await composeWork([libraryWorkModule], {
    databaseUrl: pool.options.connectionString!,
    pool,
    client: workClient,
    env: {},
  });
  await worker.launch();
  signing = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'library', alg: 'ES256' };
  access = createAccess({
    actions: new Map([
      ['collection:create', { anonymous: false, 'x-resource-types': ['library.collection'] }],
      ['collection:read', { anonymous: true }],
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
  ordered = createCollectionCommands({ pool, access, clock });
  reads = createCollectionReads({ pool, access, tokens });
  const ownerId = newId(route);
  const otherId = newId(route);
  const suspendedId = newId(route);
  for (const id of [ownerId, otherId, suspendedId]) await insertAccount(id);
  owner = await authenticate(ownerId, curatorScopes);
  other = await authenticate(otherId, curatorScopes);
  unscoped = await authenticate(ownerId, ['subject:read']);
  suspendedActor = await authenticate(suspendedId, curatorScopes);
  await bootstrapRelease(pool, bundledRelease);
  subjectA = await makeSubject(owner, 'First subject');
  subjectB = await makeSubject(owner, 'Second subject');
});

beforeEach(async () => {
  await pool.query(
    `UPDATE access.account SET state = 'active', authn_fenced = false WHERE account_id = ANY($1::uuid[])`,
    [[owner.accountId, other.accountId, suspendedActor.accountId]],
  );
  owner = await authenticate(owner.accountId, curatorScopes);
  other = await authenticate(other.accountId, curatorScopes);
  unscoped = await authenticate(owner.accountId, ['subject:read']);
  suspendedActor = await authenticate(suspendedActor.accountId, curatorScopes);
});

afterAll(async () => {
  await worker?.shutdown();
  await workClient?.close();
  if (growth) await growth.close();
});

async function insertAccount(id: string): Promise<void> {
  await pool.query(
    `INSERT INTO access.account
       (route, account_id, kind, state, transaction_id, authn_fenced, minimum_authn_epoch, membership_inverse_complete)
     VALUES ($1, $2, 'actor', 'active', $2, false, 1, true)`,
    [routeOf(id), id],
  );
}

async function authenticate(id: string, scopes: readonly string[]): Promise<AccountActor> {
  const token = await new SignJWT({
    client_id: 'web',
    scope: scopes.join(' '),
    authn_epoch: 1,
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
  return access.authenticate(token, { pool, deadline: Date.now() + 180_000 });
}

async function makeSubject(actor: AccountActor, label: string): Promise<string> {
  const idempotencyKey = `collection-read-subject-${randomUUID()}`;
  const created = await createSubject(pool, {
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

async function setState(id: string, state: 'active' | 'suspended'): Promise<void> {
  await pool.query(`UPDATE access.account SET state = $2 WHERE account_id = $1`, [id, state]);
}

async function denySubjectRead(subjectId: string, accountId: string): Promise<void> {
  await growth.admin.query(
    `INSERT INTO access.resource_denial
       (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
     VALUES ($1, $2, $3, '', 'subject:read', 'resource', '(,)'::tstzrange, $4)`,
    [routeOf(subjectId), subjectId, accountId, randomUUID()],
  );
}

function advance(): void {
  now += 60_000;
}

async function create(
  actor: AccountActor,
  draft: { title: string; visibility: CollectionVisibility; description?: string | null },
  options?: { clocked?: boolean; advance?: boolean },
): Promise<Collection> {
  if (options?.clocked) {
    if (options.advance !== false) advance();
    return (await ordered.createCollection(actor, draft, key())).value;
  }
  return (await commands.createCollection(actor, draft, key())).value;
}

async function add(
  actor: AccountActor,
  collectionId: string,
  subjectId: string,
  draft: { after?: string | null; note?: string | null } = {},
): Promise<CollectionMember> {
  const created = await commands.addMember(
    actor,
    collectionId,
    {
      subjectId,
      ...(draft.after !== undefined ? { after: draft.after } : {}),
      ...(draft.note !== undefined ? { note: draft.note } : {}),
    },
    key(),
  );
  return created.value;
}

function viewOf(collection: Collection): CollectionView {
  return {
    id: collection.id,
    curatorAccountId: collection.curatorAccountId,
    title: collection.title,
    presentationKind: null,
    presentationKindSource: collection.memberCount === 0 ? 'empty' : 'pending',
    cover: null,
    coverSource: collection.memberCount === 0 ? 'none' : 'pending',
    description: collection.description,
    visibility: collection.visibility,
    revision: collection.revision,
    memberCount: collection.memberCount,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  };
}

function memberOf(member: CollectionMember) {
  return { id: member.id, subjectId: member.subjectId, note: member.note, addedAt: member.addedAt };
}

function byNewest(left: { updatedAt: string; id: string }, right: { updatedAt: string; id: string }): number {
  const time = right.updatedAt.localeCompare(left.updatedAt);
  return time === 0 ? right.id.localeCompare(left.id) : time;
}

async function refusal(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (!(error instanceof ProblemError)) throw error;
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      detail: error.detail,
      errors: error.errors,
      status: PROBLEMS[error.code].status,
    };
  }
  throw new Error('expected a refusal');
}

const hiddenRefusal = {
  name: 'ProblemError',
  code: 'not_found',
  message: 'Not Found',
  detail: undefined,
  errors: undefined,
  status: 404,
} as const;

test('public and unlisted Collections read for anyone and a private one matches unknown', async () => {
  const published = await create(owner, { title: 'Published', visibility: 'public', description: 'Shown' });
  const quiet = await create(owner, { title: 'Quiet', visibility: 'unlisted' });
  const hidden = await create(owner, { title: 'Hidden', visibility: 'private' });
  const removed = await create(owner, { title: 'Removed', visibility: 'public' });
  await commands.deleteCollection(owner, removed.id, removed.revision, key());
  const unknown = newId(route);
  const malformed = ['not-a-collection', '', '123', 'ffffffff-ffff-ffff-ffff-ffffffffffff'];
  const readers = [owner, other, unscoped, anonymous] as const;

  for (const reader of readers) {
    expect(await reads.readCollection(reader, published.id)).toEqual(viewOf(published));
    expect(await reads.readCollection(reader, quiet.id)).toEqual(viewOf(quiet));
  }
  expect(await reads.readCollection(owner, hidden.id)).toEqual(viewOf(hidden));
  expect(Object.keys(await reads.readCollection(owner, hidden.id)).sort()).toEqual([
    'cover',
    'coverSource',
    'createdAt',
    'curatorAccountId',
    'description',
    'id',
    'memberCount',
    'presentationKind',
    'presentationKindSource',
    'revision',
    'title',
    'updatedAt',
    'visibility',
  ]);

  const unknownRefusal = await refusal(reads.readCollection(owner, unknown));
  expect(unknownRefusal).toEqual(hiddenRefusal);
  expect(JSON.stringify(unknownRefusal)).not.toContain(hidden.id);
  for (const reader of [other, unscoped, anonymous]) {
    expect(await refusal(reads.readCollection(reader, hidden.id))).toEqual(unknownRefusal);
    expect(await refusal(reads.readCollection(reader, removed.id))).toEqual(unknownRefusal);
    expect(await refusal(reads.listMembers(reader, hidden.id, { cursor: 'tampered-cursor' }))).toEqual(
      await refusal(reads.listMembers(reader, unknown)),
    );
  }
  expect(await refusal(reads.readCollection(owner, removed.id))).toEqual(unknownRefusal);
  for (const id of malformed) {
    expect(await refusal(reads.readCollection(owner, id))).toEqual(unknownRefusal);
    expect(await refusal(reads.readCollection(anonymous, id))).toEqual(unknownRefusal);
  }

  const ownPublic = await create(suspendedActor, { title: 'Suspended public', visibility: 'public' });
  const ownQuiet = await create(suspendedActor, { title: 'Suspended quiet', visibility: 'unlisted' });
  const ownHidden = await create(suspendedActor, { title: 'Suspended hidden', visibility: 'private' });
  await setState(suspendedActor.accountId, 'suspended');
  try {
    // collection-source.md: no valid suspended bearer exists. Known-ID public readability
    // is anonymous authority, whereas active-unfenced curator discovery hides suspension.
    expect(await reads.readCollection(anonymous, ownPublic.id)).toEqual(viewOf(ownPublic));
    expect(await reads.readCollection(anonymous, ownQuiet.id)).toEqual(viewOf(ownQuiet));
    expect(await refusal(reads.readCollection(anonymous, ownHidden.id))).toEqual(unknownRefusal);
    expect(await reads.listCollections(anonymous, { curatorAccountId: suspendedActor.accountId })).toEqual({
      collections: [],
      next: null,
    });
  } finally {
    await setState(suspendedActor.accountId, 'active');
  }
});

test('a curator lists every active Collection and everyone else lists only public ones', async () => {
  const curatorId = newId(route);
  await insertAccount(curatorId);
  const curator = await authenticate(curatorId, curatorScopes);
  const created: Collection[] = [];
  const shelf = (title: string, visibility: CollectionVisibility, advance = true) =>
    create(curator, { title, visibility }, { clocked: true, advance });
  for (let index = 0; index < 15; index += 1) created.push(await shelf(`Filler ${index}`, 'public'));
  const publicOld = await shelf('Old public', 'public');
  const quiet = await shelf('Unlisted shelf', 'unlisted');
  const hidden = await shelf('Private shelf', 'private');
  const tieA = await shelf('Tie A', 'public');
  const tieB = await shelf('Tie B', 'public', false);
  const publicNew = await shelf('New public', 'public');
  const removed = await shelf('Deleted shelf', 'private');
  await commands.deleteCollection(curator, removed.id, removed.revision, key());
  created.push(publicOld, quiet, hidden, tieA, tieB, publicNew);

  const active = created.filter((collection) => collection.id !== removed.id).sort(byNewest);
  const listed = active.filter((collection) => collection.visibility === 'public').sort(byNewest);
  expect(tieA.updatedAt).toBe(tieB.updatedAt);
  expect(active.map((collection) => collection.id)).toContain(hidden.id);
  expect(active.map((collection) => collection.id)).toContain(quiet.id);
  expect(listed.map((collection) => collection.id)).not.toContain(hidden.id);
  expect(listed.map((collection) => collection.id)).not.toContain(quiet.id);

  async function walk(viewer: Actor, expected: Collection[]) {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await reads.listCollections(viewer, {
        curatorAccountId: curatorId,
        limit: 1,
        ...(cursor === null ? {} : { cursor }),
      });
      expect(page.collections).toHaveLength(Math.min(1, expected.length - seen.length));
      for (const collection of page.collections) {
        expect(collection).toEqual(viewOf(expected[seen.length]!));
        expect(Object.keys(collection)).not.toContain('orderEpoch');
        expect(Object.keys(collection)).not.toContain('state');
        seen.push(collection.id);
      }
      expect(page.collections).not.toContainEqual(expect.objectContaining({ id: removed.id }));
      cursor = page.next;
    } while (cursor);
    expect(seen).toEqual(expected.map((collection) => collection.id));
  }

  await walk(curator, active);
  for (const viewer of [other, anonymous, unscoped, suspendedActor]) await walk(viewer, listed);

  const first = await reads.listCollections(curator, { curatorAccountId: curatorId });
  expect(first.collections).toEqual(active.slice(0, 20).map(viewOf));
  expect(first.next).toBeTruthy();
  const second = await reads.listCollections(curator, { curatorAccountId: curatorId, cursor: first.next });
  expect(second.collections).toEqual(active.slice(20).map(viewOf));
  expect(second.next).toBeNull();
  const explicit = await reads.listCollections(curator, { curatorAccountId: curatorId, limit: 20, cursor: null });
  expect(explicit.collections).toEqual(first.collections);

  const ownerBinding = {
    operation: 'library.collection.list',
    parameters: { curatorAccountId: curatorId, fullView: true },
  };
  const publicBinding = {
    operation: 'library.collection.list',
    parameters: { curatorAccountId: curatorId, fullView: false },
  };
  const decoded = decodeCursor(tokens, ownerBinding, first.next!);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  const stale = encodeCursor(tokens, ownerBinding, { epoch: decoded.epoch + 1, after: decoded.after });
  expect(await refusal(reads.listCollections(curator, { curatorAccountId: curatorId, cursor: stale }))).toMatchObject({
    code: 'stale_cursor',
    status: 409,
  });
  const publicPage = await reads.listCollections(anonymous, { curatorAccountId: curatorId, limit: 1 });
  expect(
    await refusal(reads.listCollections(anonymous, { curatorAccountId: curatorId, cursor: first.next })),
  ).toMatchObject({ code: 'invalid_cursor', status: 400 });
  expect(
    await refusal(reads.listCollections(curator, { curatorAccountId: curatorId, cursor: publicPage.next })),
  ).toMatchObject({ code: 'invalid_cursor', status: 400 });
  expect(await refusal(reads.listCollections(curator, { curatorAccountId: curatorId, cursor: '' }))).toMatchObject({
    code: 'invalid_cursor',
  });
  expect(
    await refusal(reads.listCollections(curator, { curatorAccountId: curatorId, cursor: `${first.next}x` })),
  ).toMatchObject({ code: 'invalid_cursor' });
  expect(
    await refusal(reads.listCollections(curator, { curatorAccountId: curatorId, cursor: 'x'.repeat(4097) })),
  ).toMatchObject({ code: 'invalid_cursor' });
  expect(decodeCursor(tokens, publicBinding, publicPage.next!).ok).toBe(true);
  expect(await refusal(reads.listCollections(curator, { curatorAccountId: 'not-an-account' }))).toEqual(hiddenRefusal);
  expect(await reads.listCollections(other, { curatorAccountId: newId(route) })).toEqual({
    collections: [],
    next: null,
  });
  await expect(reads.listCollections(curator, { curatorAccountId: curatorId, limit: 0 })).rejects.toThrow(RangeError);
  await expect(reads.listCollections(curator, { curatorAccountId: curatorId, limit: 101 })).rejects.toThrow(RangeError);
  await expect(
    reads.listCollections(curator, { curatorAccountId: curatorId, surprise: true } as { curatorAccountId: string }),
  ).rejects.toThrow(TypeError);
});

test('member pages follow ordinal order, omit unreadable subjects, and keep a cursor past them', async () => {
  const shelf = await create(owner, { title: 'Ordered', visibility: 'public' });
  const first = await add(owner, shelf.id, subjectA, { note: 'Original' });
  const repeated = await add(owner, shelf.id, subjectA, { note: 'Again' });
  const middle = await add(owner, shelf.id, subjectB, { after: first.id, note: null });
  const third = await add(owner, shelf.id, subjectA, { note: 'Third' });
  const expected = [first, middle, repeated, third];
  expect(new Set(expected.map((member) => member.subjectId)).size).toBe(2);
  expect(expected.filter((member) => member.subjectId === subjectA)).toHaveLength(3);

  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await reads.listMembers(owner, shelf.id, { limit: 2, ...(cursor === null ? {} : { cursor }) });
    expect(page.members.length).toBeGreaterThan(0);
    expect(page.members.length).toBeLessThanOrEqual(2);
    for (const member of page.members) {
      expect(member).toEqual(memberOf(expected[seen.length]!));
      expect(Object.keys(member).sort()).toEqual(['addedAt', 'id', 'note', 'subjectId']);
      seen.push(member.id);
    }
    expect(JSON.stringify(page)).not.toContain('ordinalKey');
    expect(JSON.stringify(page)).not.toContain('orderEpoch');
    cursor = page.next;
  } while (cursor);
  expect(seen).toEqual(expected.map((member) => member.id));

  for (let index = expected.length; index < 21; index += 1) await add(owner, shelf.id, subjectB);
  const implicit = await reads.listMembers(owner, shelf.id);
  const explicit = await reads.listMembers(owner, shelf.id, { limit: 20, cursor: null });
  expect(implicit.members).toHaveLength(20);
  expect(implicit.members).toEqual(explicit.members);
  expect(implicit.next).toBeTruthy();
  const rest = await reads.listMembers(owner, shelf.id, { cursor: implicit.next });
  expect(rest.members).toHaveLength(1);
  expect(rest.next).toBeNull();
  const whole = await reads.listMembers(owner, shelf.id, { limit: 100 });
  expect([...implicit.members, ...rest.members]).toEqual(whole.members);

  const concealed = await makeSubject(owner, 'Denied member subject');
  const mixed = await create(owner, { title: 'Mixed subjects', visibility: 'public' });
  const denied = await add(owner, mixed.id, concealed, { note: 'Secret subject' });
  const visible = await add(owner, mixed.id, subjectA, { note: 'Visible subject' });
  await denySubjectRead(concealed, owner.accountId);
  const ownerFirst = await reads.listMembers(owner, mixed.id, { limit: 1 });
  expect(ownerFirst.members).toEqual([]);
  expect(ownerFirst.next).toBeTruthy();
  expect(await reads.listMembers(owner, mixed.id, { limit: 1, cursor: ownerFirst.next })).toEqual({
    members: [memberOf(visible)],
    next: null,
  });
  expect(await reads.listMembers(owner, mixed.id, { limit: 10 })).toEqual({ members: [memberOf(visible)], next: null });
  expect(await reads.listMembers(anonymous, mixed.id, { limit: 10 })).toEqual({
    members: [memberOf(denied), memberOf(visible)],
    next: null,
  });
  expect((await reads.listMembers(other, mixed.id, { limit: 1 })).members).toEqual([memberOf(denied)]);

  const privateShelf = await create(owner, { title: 'Private members', visibility: 'private' });
  await add(owner, privateShelf.id, subjectA);
  const unknown = newId(route);
  expect(await reads.listMembers(owner, privateShelf.id, { limit: 10 })).toMatchObject({
    members: [expect.objectContaining({ subjectId: subjectA })],
    next: null,
  });
  expect(await refusal(reads.listMembers(other, privateShelf.id))).toEqual(
    await refusal(reads.listMembers(other, unknown)),
  );
  expect(await refusal(reads.listMembers(anonymous, privateShelf.id, { cursor: 'not-a-cursor' }))).toEqual(
    await refusal(reads.listMembers(anonymous, unknown, { cursor: 'not-a-cursor' })),
  );

  expect(await refusal(reads.listMembers(owner, shelf.id, { cursor: '' }))).toMatchObject({
    code: 'invalid_cursor',
    status: 400,
  });
  expect(await refusal(reads.listMembers(owner, shelf.id, { cursor: 'tampered' }))).toMatchObject({
    code: 'invalid_cursor',
  });
  const page = await reads.listMembers(owner, shelf.id, { limit: 1 });
  const binding = { operation: 'library.collection.members', parameters: { collectionId: shelf.id } };
  const decoded = decodeCursor(tokens, binding, page.next!);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  const forged = encodeCursor(tokens, binding, { epoch: decoded.epoch + 3, after: decoded.after });
  expect(await refusal(reads.listMembers(owner, shelf.id, { cursor: forged }))).toMatchObject({
    code: 'stale_cursor',
    status: 409,
  });
  const otherShelf = await create(owner, { title: 'Other cursor', visibility: 'public' });
  await add(owner, otherShelf.id, subjectA);
  await add(owner, otherShelf.id, subjectB);
  const foreign = (await reads.listMembers(owner, otherShelf.id, { limit: 1 })).next;
  expect(foreign).toBeTruthy();
  expect(await refusal(reads.listMembers(owner, shelf.id, { cursor: foreign }))).toMatchObject({
    code: 'invalid_cursor',
  });
  await expect(reads.listMembers(owner, shelf.id, { limit: 0 })).rejects.toThrow(RangeError);
  await expect(reads.listMembers(owner, shelf.id, { limit: 101 })).rejects.toThrow(RangeError);
  await expect(reads.listMembers(owner, shelf.id, { limit: 1.5 })).rejects.toThrow(RangeError);
  await expect(reads.listMembers(owner, shelf.id, { limit: 100 })).resolves.toBeDefined();
  await expect(reads.listMembers(owner, shelf.id, { surprise: true } as unknown as { limit: number })).rejects.toThrow(
    TypeError,
  );
});

test('a cursor from before a respacing is stale_cursor', async () => {
  const shelf = await create(owner, { title: 'Respaced', visibility: 'private' });
  const anchor = await add(owner, shelf.id, subjectA, { note: 'Anchor' });
  const tail = await add(owner, shelf.id, subjectA, { note: 'Tail' });
  const oldPage = await reads.listMembers(owner, shelf.id, { limit: 1 });
  expect(oldPage.members).toEqual([memberOf(anchor)]);
  expect(oldPage.next).toBeTruthy();
  const inserted: CollectionMember[] = [];
  let epoch = 0;
  for (let index = 0; index < 320 && epoch === 0; index += 1) {
    inserted.unshift(await add(owner, shelf.id, subjectA, { after: anchor.id }));
    const stored = await pool.query<{ order_epoch: number }>(
      'SELECT order_epoch FROM library.collection WHERE collection_id = $1',
      [shelf.id],
    );
    epoch = stored.rows[0]?.order_epoch ?? 0;
  }
  expect(epoch).toBeGreaterThan(0);
  expect(await refusal(reads.listMembers(owner, shelf.id, { cursor: oldPage.next, limit: 1 }))).toMatchObject({
    code: 'stale_cursor',
    status: 409,
  });
  const seen: ReturnType<typeof memberOf>[] = [];
  let cursor: string | null = null;
  do {
    const page = await reads.listMembers(owner, shelf.id, { limit: 100, ...(cursor === null ? {} : { cursor }) });
    seen.push(...page.members);
    cursor = page.next;
  } while (cursor);
  expect(seen.map((member) => member.id)).toEqual([anchor.id, ...inserted.map((member) => member.id), tail.id]);
  expect(seen[0]).toEqual(memberOf(anchor));
});

test("a subject's public Collections page shows only Collections that are public right now", async () => {
  const subjectId = await makeSubject(owner, 'Listed subject');
  const alpha = await create(owner, { title: 'Alpha shelf', visibility: 'public' });
  const beta = await create(owner, { title: 'Beta shelf', visibility: 'public' });
  await add(owner, alpha.id, subjectId);
  await add(owner, alpha.id, subjectId);
  await add(owner, beta.id, subjectId);
  await syncSubjectListing({ pool }, { subjectId, collectionId: alpha.id });
  await syncSubjectListing({ pool }, { subjectId, collectionId: beta.id });
  const ranked = [alpha, beta].sort((left, right) => left.id.localeCompare(right.id));
  const hidden = ranked[0]!;
  const shown = ranked[1]!;
  const prior = await reads.listSubjectCollections(owner, subjectId, { limit: 1 });
  const concealed = await commands.updateCollection(
    owner,
    hidden.id,
    { revision: hidden.revision, visibility: 'private' },
    key(),
  );
  const pair = await pool.query(
    'SELECT multiplicity FROM library.subject_collection WHERE route = $1 AND subject_id = $2 AND collection_id = $3',
    [routeOf(subjectId), subjectId, hidden.id],
  );
  expect(pair.rows).toHaveLength(1);

  expect(await refusal(reads.listSubjectCollections(owner, subjectId, { limit: 1 }))).toMatchObject({
    code: 'dependency_unavailable',
  });
  // The command is source-local; the maintained count becomes visible after native publication.
  const event = (
    await pool.query(
      "SELECT * FROM core.outbox WHERE subject=$1 AND type='com.rezics.library.collection.listing.changed.v1' ORDER BY position DESC LIMIT 1",
      [hidden.id],
    )
  ).rows[0]!;
  const notification: CloudEvent = {
    specversion: '1.0',
    id: event.id,
    source: `urn:rezics:log:${event.partition_no}.${event.epoch}`,
    type: event.type,
    subject: hidden.id,
    time: event.recorded_at.toISOString(),
    sequence: String(event.position).padStart(19, '0'),
    datacontenttype: 'application/json',
    data: event.data,
  };
  await (
    await workClient.enqueue(
      {
        workflowName: 'effect',
        queueName: 'effects',
        workflowID: randomUUID(),
        queuePartitionKey: String(event.partition_no),
      },
      'library_collection_listing',
      notification,
    )
  ).getResult();
  await workClient.retrieveWorkflow(notification.id).getResult();

  const view = (collection: Collection, multiplicity: number) => ({
    id: collection.id,
    curatorAccountId: collection.curatorAccountId,
    title: collection.id === hidden.id ? concealed.value.title : collection.title,
    multiplicity,
  });
  const first = await reads.listSubjectCollections(owner, subjectId, { limit: 1 });
  expect(first).toEqual({
    collections: [view(shown, shown.id === alpha.id ? 2 : 1)],
    count: { value: 1, exact: true },
    next: null,
  });
  const second = await reads.listSubjectCollections(anonymous, subjectId, { limit: 1, cursor: prior.next });
  expect(second).toEqual({
    collections: [view(shown, shown.id === alpha.id ? 2 : 1)],
    count: { value: 1, exact: true },
    next: null,
  });
  expect(Object.keys(second.collections[0]!).sort()).toEqual(['curatorAccountId', 'id', 'multiplicity', 'title']);
  expect(JSON.stringify(second)).not.toContain(hidden.id);

  const unknown = newId(routeOf(subjectId)!);
  expect(await refusal(reads.listSubjectCollections(owner, unknown))).toEqual(hiddenRefusal);
  expect(await refusal(reads.listSubjectCollections(owner, 'not-a-subject'))).toEqual(hiddenRefusal);
  const denied = await makeSubject(owner, 'Denied listed subject');
  const visible = await create(owner, { title: 'Still public', visibility: 'public' });
  await add(owner, visible.id, denied);
  await syncSubjectListing({ pool }, { subjectId: denied, collectionId: visible.id });
  await denySubjectRead(denied, owner.accountId);
  expect(await refusal(reads.listSubjectCollections(owner, denied))).toEqual(
    await refusal(reads.listSubjectCollections(owner, unknown)),
  );
  expect(await reads.listSubjectCollections(anonymous, denied)).toEqual({
    collections: [view(visible, 1)],
    count: { value: 1, exact: true },
    next: null,
  });

  expect(await refusal(reads.listSubjectCollections(owner, subjectId, { cursor: 'tampered' }))).toMatchObject({
    code: 'invalid_cursor',
    status: 400,
  });
  const binding = { operation: 'library.subject.collections', parameters: { subjectId } };
  const decoded = decodeCursor(tokens, binding, prior.next!);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) return;
  const stale = encodeCursor(tokens, binding, { epoch: decoded.epoch + 1, after: decoded.after });
  expect(await refusal(reads.listSubjectCollections(owner, subjectId, { cursor: stale }))).toMatchObject({
    code: 'stale_cursor',
    status: 409,
  });
  const foreign = encodeCursor(
    tokens,
    { operation: 'library.subject.collections', parameters: { subjectId: denied } },
    { epoch: decoded.epoch, after: decoded.after },
  );
  expect(await refusal(reads.listSubjectCollections(anonymous, subjectId, { cursor: foreign }))).toMatchObject({
    code: 'invalid_cursor',
  });
  await expect(reads.listSubjectCollections(owner, subjectId, { limit: 0 })).rejects.toThrow(RangeError);
  await expect(reads.listSubjectCollections(owner, subjectId, { limit: 101 })).rejects.toThrow(RangeError);
});

test('reads keep the same statement count as unrelated Collections, members and pairs grow', async () => {
  const subjectId = await makeSubject(owner, 'Growth subject');
  const hidden = await create(owner, { title: 'Growth private', visibility: 'private' });
  const listed = await create(owner, { title: 'Growth public', visibility: 'public' });
  await add(owner, hidden.id, subjectA, { note: 'First' });
  await add(owner, hidden.id, subjectB, { note: 'Second' });
  await add(owner, listed.id, subjectId);
  await syncSubjectListing({ pool }, { subjectId, collectionId: listed.id });
  const stableRead = await reads.readCollection(owner, hidden.id);
  const stableMembers = (await reads.listMembers(owner, hidden.id, { limit: 1 })).members;
  const stableSubject = await reads.listSubjectCollections(owner, subjectId, { limit: 1 });
  expect(stableMembers).toHaveLength(1);
  expect(stableSubject.next).toBeNull();
  expect(stableSubject.collections).toHaveLength(1);

  const collectionRoute = 0x2468;
  const subjectRoute = 0x1357;
  const readCounts: number[] = [];
  const memberCounts: number[] = [];
  const subjectCounts: number[] = [];
  let previous = 0;
  for (const scale of [1, 8, 64]) {
    await growth.admin.query(
      `WITH source AS (
         SELECT n,
           ('10000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n::bigint), 8, '0'))::uuid AS collection_id,
           ('20000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n::bigint), 8, '0'))::uuid AS member_id,
           ('30000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n::bigint), 8, '0'))::uuid AS curator_id,
           ('40000000-0000-7000-8000-' || lpad(to_hex($2::int), 4, '0') || lpad(to_hex(n::bigint), 8, '0'))::uuid AS subject_id
         FROM generate_series($3::int, $4::int) AS n
       )
       INSERT INTO library.collection
         (route, collection_id, curator_account_id, title, description, visibility, state, revision, member_count,
          order_epoch, created_at, updated_at, transaction_id)
       SELECT $1, collection_id, curator_id, 'Unrelated', NULL, 'public', 'active', 1, 1, 0,
              $5::timestamptz, $5::timestamptz, collection_id
       FROM source`,
      [collectionRoute, subjectRoute, previous + 1, scale, '2026-01-01T00:00:00.000Z'],
    );
    await growth.admin.query(
      `WITH source AS (
         SELECT n,
           ('10000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n::bigint), 8, '0'))::uuid AS collection_id,
           ('20000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n::bigint), 8, '0'))::uuid AS member_id,
           ('40000000-0000-7000-8000-' || lpad(to_hex($2::int), 4, '0') || lpad(to_hex(n::bigint), 8, '0'))::uuid AS subject_id
         FROM generate_series($3::int, $4::int) AS n
       )
       INSERT INTO library.collection_member
         (route, collection_id, member_id, subject_id, note, ordinal_key, added_at, transaction_id)
       SELECT $1, collection_id, member_id, subject_id, NULL, 'a0', $5::timestamptz, member_id
       FROM source`,
      [collectionRoute, subjectRoute, previous + 1, scale, '2026-01-01T00:00:00.000Z'],
    );
    await growth.admin.query(
      `WITH source AS (
         SELECT n,
           ('10000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n::bigint), 8, '0'))::uuid AS collection_id,
           ('40000000-0000-7000-8000-' || lpad(to_hex($2::int), 4, '0') || lpad(to_hex(n::bigint), 8, '0'))::uuid AS subject_id
         FROM generate_series($3::int, $4::int) AS n
       )
       INSERT INTO library.subject_collection
         (route, subject_id, collection_id, collection_route, multiplicity, updated_at, transaction_id)
       SELECT $2, subject_id, collection_id, $1, 1, $5::timestamptz, collection_id
       FROM source`,
      [collectionRoute, subjectRoute, previous + 1, scale, '2026-01-01T00:00:00.000Z'],
    );
    previous = scale;
    await reads.readCollection(owner, hidden.id);
    await reads.listMembers(owner, hidden.id, { limit: 1 });
    await reads.listSubjectCollections(owner, subjectId, { limit: 1 });
    const read = await capture(growth, () => reads.readCollection(owner, hidden.id));
    const members = await capture(growth, () => reads.listMembers(owner, hidden.id, { limit: 1 }));
    const subject = await capture(growth, () => reads.listSubjectCollections(owner, subjectId, { limit: 1 }));
    expect(read.value).toEqual(stableRead);
    expect(members.value.members).toEqual(stableMembers);
    expect(subject.value).toEqual(stableSubject);
    readCounts.push(read.capture.statements.length);
    memberCounts.push(members.capture.statements.length);
    subjectCounts.push(subject.capture.statements.length);
  }
  expect(readCounts).toHaveLength(3);
  expect(memberCounts).toHaveLength(3);
  expect(subjectCounts).toHaveLength(3);
  expect(new Set(readCounts).size).toBe(1);
  expect(new Set(memberCounts).size).toBe(1);
  expect(new Set(subjectCounts).size).toBe(1);
  expect(readCounts[0]).toBeGreaterThan(0);
  expect(memberCounts[0]).toBeGreaterThan(0);
  expect(subjectCounts[0]).toBeGreaterThan(0);
});
