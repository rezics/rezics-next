import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { readAccountRealms } from '../../src/access/account-realms.ts';
import { createRealmMembership } from '../../src/community/membership.ts';
import { routeOf, newId } from '../../src/route/route.ts';
import type { Access, AccessRealmRoleReader, Actor } from '../../src/request/access.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
pool.options.max = 12;
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(47)]]) };
const actions = new Map([['realm:read', { anonymous: true }]]);
let realmRoleReader: AccessRealmRoleReader = async () => null;
const access: Access = admittedAccess({
  actions,
  realmRoleReader: (client, input) => realmRoleReader(client, input),
});
const membership = createRealmMembership({ pool, access });
realmRoleReader = membership.roleReader;

afterAll(async () => pool.end());

async function account(realms = true): Promise<string> {
  const id = newId(0x6200);
  await pool.query(
    `INSERT INTO access.account(route, account_id, kind, state, transaction_id, public_views, membership_inverse_complete)
     VALUES ($1, $2, 'actor', 'active', $2,
       jsonb_build_object('posts', true, 'reviews', true, 'collections', true, 'realms', $3::boolean), true)`,
    [routeOf(id), id, realms],
  );
  return id;
}

type RealmFixture = { id: string; route: number };
async function realm(creator: string, visibility: 'public' | 'protected' = 'public'): Promise<RealmFixture> {
  const route = 0x6201;
  const id = newId(route);
  const spaceId = newId(route);
  const spaceRevision = newId(route);
  const revision = newId(route);
  const contextId = newId(0x6202);
  const createdAt = new Date(Date.now() - 2_000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(
      `INSERT INTO community.space(route, space_id, state, head_revision_id, created_at, creator)
       VALUES ($1, $2, 'active', $3, $4, $5)`,
      [route, spaceId, spaceRevision, createdAt, creator],
    );
    await client.query(
      `INSERT INTO community.space_revision(route, space_id, revision_id, predecessor, title, summary, created_at, author)
       VALUES ($1, $2, $3, NULL, 'Account Realms test Space', '', $4, $5)`,
      [route, spaceId, spaceRevision, createdAt, creator],
    );
    await client.query(
      `INSERT INTO community.realm(route, realm_id, space_id, state, visibility, context_id, head_revision_id, created_at, creator)
       VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8)`,
      [route, id, spaceId, visibility, contextId, revision, createdAt, creator],
    );
    await client.query(
      `INSERT INTO community.realm_revision(route, realm_id, revision_id, predecessor, title, summary, visibility,
       context_id, created_at, author)
       VALUES ($1, $2, $3, NULL, 'Account Realms test Realm', '', $4, $5, $6, $7)`,
      [route, id, revision, visibility, contextId, createdAt, creator],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { id, route };
}

async function inverse(accountId: string, realmId: string): Promise<void> {
  await pool.query(
    `INSERT INTO access.membership_inverse(route, account_id, kind, group_id, reservation_id, transaction_id)
     VALUES ($1, $2, 'realm', $3, $4, $5)`,
    [routeOf(accountId), accountId, realmId, newId(routeOf(accountId)!), newId(routeOf(accountId)!)],
  );
}

async function member(accountId: string, realmId: string, from = new Date(Date.now() - 60_000)): Promise<void> {
  const route = routeOf(realmId)!;
  await pool.query(
    `INSERT INTO community.realm_member(route, realm_id, account_id, role, valid, reservation_id, transaction_id)
     VALUES ($1, $2, $3, 'member', tstzrange($4::timestamptz, NULL, '[)'), $5, $6)`,
    [route, realmId, accountId, from, newId(route), newId(route)],
  );
  await inverse(accountId, realmId);
}

async function allowRead(viewerId: string, realmId: string): Promise<void> {
  const route = routeOf(realmId)!;
  await pool.query(
    `INSERT INTO access.resource_grant(route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1, $2, $3, 'realm:read', '(,)', $4)`,
    [route, realmId, viewerId, newId(routeOf(viewerId)!)],
  );
}

async function actor(accountId: string) {
  return authenticateAccount(
    access,
    { pool, deadline: Date.now() + 30_000 },
    { accountId, clientId: 'account-realms-test', scopes: ['realm:read'] },
  );
}

function page(accountId: string, viewer: Actor, input: { limit?: number; cursor?: string } = {}) {
  return readAccountRealms(
    { pool, tokens, access, realmRoleReader },
    viewer,
    accountId,
    new Date(),
    Date.now() + 30_000,
    input,
  );
}

test('an opted-in account lists its current Realm memberships with their role', async () => {
  const target = await account();
  const current = await realm(target);
  await member(target, current.id);

  await expect(page(target, { kind: 'anonymous' })).resolves.toEqual({
    realms: [{ id: current.id, role: 'member' }],
    next: null,
  });
});

test('an account that does not show Realms lists nothing', async () => {
  const target = await account(false);
  const current = await realm(target);
  await member(target, current.id);

  await expect(page(target, { kind: 'anonymous' })).resolves.toEqual({ realms: [], next: null });
});

test('inverse rows the Realm does not confirm as current at T are skipped', async () => {
  const target = await account();
  const stale = await realm(target);
  const future = await realm(target);
  await inverse(target, stale.id);
  await member(target, future.id, new Date(Date.now() + 60_000));

  await expect(page(target, { kind: 'anonymous' })).resolves.toEqual({ realms: [], next: null });
});

test('a viewer who cannot read a Realm receives no Realm id', async () => {
  const target = await account();
  const viewer = await account();
  const hidden = await realm(target, 'protected');
  await member(target, hidden.id);
  const result = await page(target, await actor(viewer));

  expect(result).toEqual({ realms: [], next: null });
  expect(JSON.stringify(result)).not.toContain(hidden.id);
});

test('anonymous viewers see exactly the public Realm floor', async () => {
  const target = await account();
  const publicRealm = await realm(target, 'public');
  const protectedRealm = await realm(target, 'protected');
  await member(target, publicRealm.id);
  await member(target, protectedRealm.id);

  const result = await page(target, { kind: 'anonymous' }, { limit: 3 });
  expect(result.realms).toEqual([{ id: publicRealm.id, role: 'member' }]);
  expect(JSON.stringify(result)).not.toContain(protectedRealm.id);
});

test('a fenced or deleted account lists nothing', async () => {
  const fenced = await account();
  const removed = await account();
  const fencedRealm = await realm(fenced);
  const removedRealm = await realm(removed);
  await member(fenced, fencedRealm.id);
  await member(removed, removedRealm.id);
  await pool.query('UPDATE access.account SET authn_fenced = true WHERE route = $1 AND account_id = $2', [
    routeOf(fenced),
    fenced,
  ]);
  await pool.query("UPDATE access.account SET state = 'deleted' WHERE route = $1 AND account_id = $2", [
    routeOf(removed),
    removed,
  ]);

  await expect(page(fenced, { kind: 'anonymous' })).resolves.toEqual({ realms: [], next: null });
  await expect(page(removed, { kind: 'anonymous' })).resolves.toEqual({ realms: [], next: null });
});

test('the opaque cursor binds route, viewer, and query while continuing after skipped rows', async () => {
  const target = await account();
  const otherViewer = await account();
  const realms = await Promise.all([realm(target, 'protected'), realm(target), realm(target)]);
  realms.sort((left, right) => left.id.localeCompare(right.id));
  await member(target, realms[0]!.id);
  await member(target, realms[1]!.id);
  await member(target, realms[2]!.id);
  await allowRead(target, realms[1]!.id);
  await allowRead(target, realms[2]!.id);
  const viewer = await actor(target);
  const first = await page(target, viewer, { limit: 1 });

  expect(first.realms).toEqual([{ id: realms[1]!.id, role: 'member' }]);
  expect(first.next).toBeString();
  expect(first.next).not.toContain(realms[0]!.id);
  expect(first.next).not.toContain(realms[1]!.id);
  await expect(page(target, viewer, { limit: 1, cursor: first.next! })).resolves.toMatchObject({
    realms: [{ id: realms[2]!.id, role: 'member' }],
    next: null,
  });
  await expect(page(target, await actor(otherViewer), { limit: 1, cursor: first.next! })).rejects.toThrow();
  await expect(page(target, { kind: 'anonymous' }, { limit: 1, cursor: first.next! })).rejects.toThrow();
  await expect(page(target, viewer, { limit: 2, cursor: first.next! })).rejects.toThrow();

  const hiddenTarget = await account();
  await expect(page(hiddenTarget, viewer, { limit: 1, cursor: first.next! })).rejects.toThrow();
});
