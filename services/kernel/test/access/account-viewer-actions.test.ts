import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { decodeJwt, importJWK, SignJWT } from 'jose';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { compileViewerActionBindings } from '../../src/access/viewer-actions.ts';
import { viewerActionReadTime } from '../../src/access/read-bindings.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { prepareReadDecisions } from '../../src/access/check.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { testKernel, type TestKernel } from '../support/test-kernel.ts';
import { issuer, nativeFixture, scopes } from './native-account-bindings-fixture.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
// Every foreign preparation must release before target checkout.
pool.options.max = 1;
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: TestKernel;
type Person = Awaited<ReturnType<Awaited<ReturnType<typeof nativeFixture>>['person']>>;
let owner: Person;
let other: Person;

async function signed(bearer: string, changes: Record<string, unknown>) {
  return new SignJWT({ ...decodeJwt<Record<string, unknown>>(bearer), ...changes })
    .setProtectedHeader({ alg: 'ES256', kid: auth.privateKey.kid, typ: 'at+jwt' })
    .sign(await importJWK(auth.privateKey, 'ES256'));
}
async function grant(subject: string, action: string, id: string) {
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$3,$4,'(,)',$2)`,
    [routeOf(id), id, subject, action],
  );
}
async function actions(id: string, bearer?: string) {
  const response = await kernel.handle(
    new Request('https://kernel.test/v1/viewerActions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: JSON.stringify({ resources: [{ type: 'access.account', id }] }),
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  return (await response.json()).resources[0] as {
    type: string;
    id: string;
    error?: string;
    viewerActions?: { action: string; operations: string[] }[];
  };
}
function offers(result: Awaited<ReturnType<typeof actions>>, action: string, operation: string) {
  return (
    result.viewerActions?.some((entry) => entry.action === action && entry.operations.includes(operation)) ?? false
  );
}
async function profile(id: string, bearer: string) {
  return kernel.handle(
    new Request(`https://kernel.test/v1/accounts/${id}/profile`, {
      headers: { authorization: `Bearer ${bearer}` },
    }),
  );
}

beforeAll(async () => {
  scopes.push('account:read', 'account:update', 'account:delegate');
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
  owner = await auth.person('account-actions-owner');
  other = await auth.person('account-actions-other');
});
afterAll(async () => {
  await auth?.close();
  await pool.end();
});

test('the real Account viewer-action registry exposes only actually authorized mounted management operations and the current profile consumes them without fabricated UI authority', async () => {
  const bindings = compileViewerActionBindings(kernel.routes).get('access.account')!;
  expect(bindings.find((binding) => binding.operationId === 'account.update')?.accountAuthority).toBe('profile');
  const own = await actions(owner.accountId, owner.bearer);
  expect(offers(own, 'account:update', 'account.update')).toBe(true);
  expect(offers(own, 'account:update', 'account.read_editable_profile')).toBe(true);
  expect(offers(own, 'account:read', 'account.read_preferences')).toBe(true);
  expect(offers(own, 'account:update', 'account.set_preferences')).toBe(true);
  expect((await profile(owner.accountId, owner.bearer)).status).toBe(200);
  expect(offers(own, 'account:update', 'account.request_verification')).toBe(false);
  await grant(owner.accountId, 'gate:agent_verification', '00000000-0000-8000-8000-000000000000');
  const verification = await actions(owner.accountId, owner.bearer);
  expect(offers(verification, 'account:read', 'account.read_verification_request')).toBe(true);
  expect(offers(verification, 'account:update', 'account.request_verification')).toBe(true);
  const readOnly = await actions(owner.accountId, await signed(owner.bearer, { scope: 'account:read' }));
  expect(offers(readOnly, 'account:read', 'account.read_verification_request')).toBe(true);
  expect(offers(readOnly, 'account:update', 'account.request_verification')).toBe(false);
  const mounted = new Set(kernel.routes.map((route) => (route.hooks.detail as { operationId?: string })?.operationId));
  for (const entry of own.viewerActions ?? [])
    for (const operation of entry.operations) expect(mounted.has(operation)).toBe(true);
  for (const bearer of [undefined, other.bearer, await signed(owner.bearer, { scope: 'account:read' })]) {
    const denied = await actions(owner.accountId, bearer);
    expect(denied.error).toBeUndefined();
    expect(offers(denied, 'account:update', 'account.update')).toBe(false);
    expect(offers(denied, 'account:update', 'account.set_preferences')).toBe(false);
  }
  // A target grant enables the exact profile operation, never self-only settings.
  await grant(other.accountId, 'account:update', owner.accountId);
  const delegatedEditor = await actions(owner.accountId, other.bearer);
  expect(offers(delegatedEditor, 'account:update', 'account.update')).toBe(true);
  expect(offers(delegatedEditor, 'account:update', 'account.set_preferences')).toBe(false);
  expect((await profile(owner.accountId, other.bearer)).status).toBe(200);
});

test('principal authority independently denies a scoped owner until the exact native grant exists', async () => {
  const principal = await auth.person('account-actions-principal');
  await grant(principal.accountId, 'account:delegate', principal.accountId);
  const context = { pool, deadline: Date.now() + 10_000 };
  const actor = await auth.access.authenticate(principal.bearer, context);
  const assignment = await createDelegationCommands({ pool, access: auth.access, action: 'account:delegate' }).create(
    { ...context, actor },
    {
      principalId: principal.accountId,
      assignedActorId: owner.accountId,
      requestId: newId(routeOf(principal.accountId)!),
      valid: '(,)',
      key: Bun.randomUUIDv7(),
    },
  );
  const bearer = await signed(owner.bearer, { requested_by: assignment.value.requestedBy });
  expect(offers(await actions(owner.accountId, bearer), 'account:update', 'account.update')).toBe(false);
  expect((await profile(owner.accountId, bearer)).status).toBe(403);
  await grant(principal.accountId, 'account:update', owner.accountId);
  expect(offers(await actions(owner.accountId, bearer), 'account:update', 'account.update')).toBe(true);
  expect((await profile(owner.accountId, bearer)).status).toBe(200);
});

test('managed profiles use only the current operator anchor, its exact scope and the live relationship', async () => {
  const bot = await auth.automated('account-actions-bot', other);
  const managed = await actions(bot.accountId, other.bearer);
  expect(offers(managed, 'account:manage', 'account.update')).toBe(true);
  expect(offers(managed, 'account:update', 'account.update')).toBe(false);
  expect(offers(managed, 'account:update', 'account.set_preferences')).toBe(false);
  expect((await profile(bot.accountId, other.bearer)).status).toBe(200);
  for (const bearer of [owner.bearer, await signed(other.bearer, { scope: 'account:update' })]) {
    expect(offers(await actions(bot.accountId, bearer), 'account:manage', 'account.update')).toBe(false);
    expect((await profile(bot.accountId, bearer)).status).toBe(403);
  }
  const context = { pool, deadline: Date.now() + 10_000 };
  const actor = await kernel.testAccess.authenticate(other.bearer, context);
  const candidates = new Set(['account:read', 'account:update', 'account:manage']);
  const decisions = await prepareReadDecisions(kernel.testAccess, {
    actor,
    actions: candidates,
    typeActions: new Map([['access.account', candidates]]),
    context,
  });
  const prepared = await decisions.prepareAccountAuthority!([bot.accountId]);
  const time = viewerActionReadTime(kernel.testAccess, context);
  await pool.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(bot.accountId),
    bot.accountId,
    owner.accountId,
  ]);
  const stale = await withConnection(pool, (client) =>
    prepared.decide(client, { kind: 'profile', action: 'account:update', ids: [bot.accountId] }, time),
  );
  expect(stale[bot.accountId]?.allowed).toBe(false);
  expect(offers(await actions(bot.accountId, other.bearer), 'account:manage', 'account.update')).toBe(false);
  expect(offers(await actions(bot.accountId, owner.bearer), 'account:manage', 'account.update')).toBe(true);
  expect((await profile(bot.accountId, owner.bearer)).status).toBe(200);
  await grant(other.accountId, 'account:manage', owner.accountId);
  expect(offers(await actions(bot.accountId, other.bearer), 'account:manage', 'account.update')).toBe(true);
  await pool.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
    routeOf(owner.accountId),
    owner.accountId,
  ]);
  expect(offers(await actions(bot.accountId, other.bearer), 'account:manage', 'account.update')).toBe(false);
  expect((await profile(bot.accountId, other.bearer)).status).toBe(403);
  await pool.query('UPDATE access.account SET authn_fenced=false WHERE route=$1 AND account_id=$2', [
    routeOf(owner.accountId),
    owner.accountId,
  ]);
  await pool.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
    routeOf(bot.accountId),
    bot.accountId,
  ]);
  expect(await actions(bot.accountId, owner.bearer)).toEqual({
    type: 'access.account',
    id: bot.accountId,
    error: 'not_found',
  });
  expect((await profile(bot.accountId, owner.bearer)).status).toBe(403);
});

test('unknown, pending, fenced and deleted references conceal equally despite independent read grants', async () => {
  for (const state of ['unknown', 'pending', 'fenced', 'deleted']) {
    const id = newId(0x1256);
    if (state !== 'unknown')
      await pool.query(
        `INSERT INTO access.account(route,account_id,kind,state,authn_fenced,transaction_id)
       VALUES ($1,$2,'actor',$3,$4,$2)`,
        [routeOf(id), id, state === 'fenced' ? 'active' : state, state === 'fenced'],
      );
    await grant(owner.accountId, 'account:read', id);
    expect(await actions(id, owner.bearer)).toEqual({ type: 'access.account', id, error: 'not_found' });
    expect(await actions(id)).toEqual({ type: 'access.account', id, error: 'not_found' });
  }
});
