import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { decodeJwt, importJWK, SignJWT } from 'jose';
import { createPool } from '../../src/database/pool.ts';
import { accountProfileEditing, readEditableAccountProfile } from '../../src/access/account-edit-profile.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { testKernel, type TestKernel } from '../support/test-kernel.ts';
import { issuer, nativeFixture, scopes } from './native-account-bindings-fixture.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
pool.options.max = 1;
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: TestKernel;
type Person = Awaited<ReturnType<Awaited<ReturnType<typeof nativeFixture>>['person']>>;
let owner: Person;
let other: Person;
const links = [{ label: 'Home', url: 'https://example.test/profile' }];

async function call(accountId: string, bearer?: string, patch?: unknown) {
  const response = await kernel.handle(
    new Request(`https://kernel.test/v1/accounts/${accountId}${patch === undefined ? '/profile' : ''}`, {
      method: patch === undefined ? 'GET' : 'PATCH',
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(patch === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'idempotency-key': JSON.stringify(Bun.randomUUIDv7()),
            }),
      },
      ...(patch === undefined ? {} : { body: JSON.stringify(patch) }),
    }),
  );
  return { status: response.status, body: await response.json(), headers: response.headers };
}
async function signed(bearer: string, changes: Record<string, unknown>) {
  return new SignJWT({ ...decodeJwt<Record<string, unknown>>(bearer), ...changes })
    .setProtectedHeader({ alg: 'ES256', kid: auth.privateKey.kid, typ: 'at+jwt' })
    .sign(await importJWK(auth.privateKey, 'ES256'));
}
async function grant(subject: string, action: string, accountId: string) {
  await pool.query(
    `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,$4,'(,)',$2)`,
    [routeOf(accountId), accountId, subject, action],
  );
}

beforeAll(async () => {
  scopes.push('account:update', 'account:delegate');
  await bootstrapRelease(pool, bundledRelease);
  auth = await nativeFixture(pool);
  kernel = testKernel({
    pool,
    auth: {
      issuer,
      audience: 'https://ordinary.api.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => auth.host.service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  owner = await auth.person('editable-profile-owner');
  other = await auth.person('editable-profile-other');
});
afterAll(async () => {
  await auth?.close();
  await pool.end();
});

test('a handleless owner reads and reloads editable source fields without consuming a write', async () => {
  // Registration supplies a handle; fixture setup covers the nullable native account shape.
  await pool.query('UPDATE access.account SET handle=NULL WHERE route=$1 AND account_id=$2', [
    routeOf(owner.accountId),
    owner.accountId,
  ]);
  expect(
    (
      await call(owner.accountId, owner.bearer, {
        displayName: 'Owner',
        biography: 'Editing source',
        links,
        publicViews: { posts: false, reviews: true, collections: false, realms: false },
      })
    ).status,
  ).toBe(200);
  const before = await pool.query('SELECT count(*)::int AS count FROM core.receipt');
  const read = await call(owner.accountId, owner.bearer);
  expect(read.status).toBe(200);
  expect(read.headers.get('cache-control')).toBe('private, no-store');
  expect(read.body).toEqual({
    profile: {
      id: owner.accountId,
      kind: 'actor',
      handle: null,
      displayName: 'Owner',
      bio: 'Editing source',
      links,
      avatar: null,
      publicViews: { posts: false, reviews: true, collections: false, realms: false },
    },
    editing: accountProfileEditing(owner.accountId, { id: owner.accountId, kind: 'actor' }),
  });
  expect((await call(owner.accountId, owner.bearer, { biography: null })).status).toBe(200);
  expect((await call(owner.accountId, owner.bearer)).body.profile).toEqual({ ...read.body.profile, bio: null });
  const afterPatch = await pool.query('SELECT count(*)::int AS count FROM core.receipt');
  expect(afterPatch.rows[0].count).toBe(before.rows[0].count + 1);
  const context = { pool, deadline: Date.now() + 10_000 };
  const actor = await kernel.testAccess.authenticate(owner.bearer, context);
  expect(await readEditableAccountProfile(kernel.testAccess, { ...context, actor }, owner.accountId)).toEqual({
    profile: { ...read.body.profile, bio: null },
    editing: accountProfileEditing(owner.accountId, { id: owner.accountId, kind: 'actor' }),
  });
  expect((await pool.query('SELECT count(*)::int AS count FROM core.receipt')).rows).toEqual(afterPatch.rows);
  // Missing media resolves through Content to null, never to the stored URL.
  await pool.query('UPDATE access.account SET avatar=$3,avatar_url=$4 WHERE route=$1 AND account_id=$2', [
    routeOf(owner.accountId),
    owner.accountId,
    newId(routeOf(owner.accountId)!),
    'https://private.test/stored',
  ]);
  expect((await call(owner.accountId, owner.bearer)).body.profile.avatar).toBeNull();
});

test('the current operator reads a managed target with management scope and an exact live binding', async () => {
  const bot = await auth.automated('editable-profile-bot', other);
  expect(
    (
      await call(bot.accountId, other.bearer, {
        displayName: 'Managed',
        publicViews: { posts: false, realms: false },
      })
    ).status,
  ).toBe(200);
  const read = await call(bot.accountId, other.bearer);
  expect(read.status).toBe(200);
  expect(read.body.profile).toMatchObject({ id: bot.accountId, displayName: 'Managed', publicViews: { posts: false } });
  expect(read.body.editing).toEqual(accountProfileEditing(other.accountId, { id: bot.accountId, kind: 'actor' }));
  expect((await call(bot.accountId, await signed(other.bearer, { scope: 'account:update' }))).status).toBe(403);
  expect((await call(bot.accountId, owner.bearer)).status).toBe(403);
  // Old operator authority cannot authorize the new operator's subject.
  await pool.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(bot.accountId),
    bot.accountId,
    owner.accountId,
  ]);
  expect((await call(bot.accountId, other.bearer)).status).toBe(403);
  expect((await call(bot.accountId, owner.bearer)).status).toBe(200);
});

test('scope, principal and foreign authority independently deny without exposing a profile', async () => {
  const noScope = await signed(owner.bearer, { scope: 'account:manage' });
  const requestId = newId(routeOf(other.accountId)!);
  await grant(other.accountId, 'account:delegate', other.accountId);
  const context = { pool, deadline: Date.now() + 10_000 };
  const actor = await auth.access.authenticate(other.bearer, context);
  const assignment = await createDelegationCommands({ pool, access: auth.access, action: 'account:delegate' }).create(
    { ...context, actor },
    {
      principalId: other.accountId,
      assignedActorId: owner.accountId,
      requestId,
      valid: '(,)',
      key: Bun.randomUUIDv7(),
    },
  );
  const delegated = await signed(owner.bearer, { requested_by: assignment.value.requestedBy });
  for (const bearer of [undefined, noScope, other.bearer, delegated]) {
    const denied = await call(owner.accountId, bearer);
    expect(denied.status).toBe(bearer === undefined ? 401 : 403);
    expect(denied.body).not.toHaveProperty('profile');
    expect(JSON.stringify(denied.body)).not.toContain('Editing source');
  }
  await grant(other.accountId, 'account:update', owner.accountId);
  expect((await call(owner.accountId, delegated)).status).toBe(200);
  expect((await call(newId(0x1234), owner.bearer)).status).toBe(403);
  for (const state of ['pending', 'suspended', 'deleted']) {
    const id = newId(0x4567);
    await pool.query(
      `INSERT INTO access.account(route,account_id,kind,state,biography,transaction_id)
       VALUES ($1,$2,'actor',$3,'Hidden biography',$2)`,
      [routeOf(id), id, state],
    );
    const denied = await call(id, owner.bearer);
    expect(denied.status).toBe(403);
    expect(denied.body).not.toHaveProperty('profile');
  }
  await pool.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
    routeOf(owner.accountId),
    owner.accountId,
  ]);
  const fenced = await call(owner.accountId, owner.bearer);
  expect(fenced.status).toBe(401);
  expect(fenced.body).not.toHaveProperty('profile');
});
