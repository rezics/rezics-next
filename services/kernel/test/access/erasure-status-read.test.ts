import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import type { Access, Actor } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { ERASURE_PARTICIPANTS, readErasureStatus } from '../../src/access/erasure.ts';
import { readManagedErasureStatus } from '../../src/access/erasure-status-read.ts';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { resolveResourceRoles, resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import { admittedAccess, accountToken, authenticateAccount } from '../support/admitted-access.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

const pool = createPool(process.env.DATABASE_URL!);
// Preparation and final Global checks must work without nested checkouts.
pool.options.max = 1;
const action = 'account:read_erasure';
const barrier = new Date('2026-01-01T00:00:00.000Z');
const completedAt = new Date('2026-01-01T00:01:00.000Z');
let access: Access;
let kernel: ReturnType<typeof createKernel>;
const context = () => ({ deadline: Date.now() + 15_000 });

beforeAll(() => {
  kernel = createKernel({
    pool,
    routeKey: new Uint8Array(32).fill(37),
    receiptKeys: testReceiptKeys(),
    access(config) {
      access = admittedAccess(config);
      return access;
    },
  });
});
afterAll(() => pool.end());

async function person() {
  const accountId = newId(0x7351);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     VALUES($1,$2,'actor','active',$2)`,
    [routeOf(accountId), accountId],
  );
  return accountId;
}
async function role(accountId: string) {
  await pool.query(
    `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
     VALUES(0,$1,$2,'platform.governance','(,)',$2)`,
    [GLOBAL_CONTEXT.id, accountId],
  );
}
async function grant(accountId: string, heldAction: string, target = GLOBAL_CONTEXT) {
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES($1,$2,$3,$4,'(,)',$3)`,
    [target.route, target.id, accountId, heldAction],
  );
}
async function actor(accountId: string, scopes = [action], requestedBy: string | null = null) {
  return authenticateAccount(
    access,
    { pool, ...context() },
    { accountId, clientId: 'erasure-reader', scopes, requestedBy },
  );
}
async function governor() {
  const accountId = await person();
  await role(accountId);
  return { accountId, actor: await actor(accountId) };
}
async function root(state: 'pending' | 'complete' | 'retention-outstanding' = 'pending') {
  const accountId = await person();
  await pool.query("UPDATE access.account SET state='deleted',authn_fenced=true WHERE route=$1 AND account_id=$2", [
    routeOf(accountId),
    accountId,
  ]);
  await pool.query(
    `INSERT INTO access.erasure(route,account_id,version,at,completed_at,frontier,workflow_until)
     VALUES($1,$2,1,$3,$4,$5,NULL)`,
    [
      routeOf(accountId),
      accountId,
      barrier,
      state === 'pending' ? null : completedAt,
      state === 'pending' ? null : '[]',
    ],
  );
  const participants = state === 'pending' ? ['access'] : ERASURE_PARTICIPANTS[1];
  for (const participant of participants) {
    const retained =
      state === 'retention-outstanding' && participant === 'commerce'
        ? [
            {
              store: 'private_financial_store',
              fields: ['private_financial_field'],
              purpose: 'private purpose',
              expiresAt: '2027-01-01T00:00:00Z',
            },
          ]
        : [];
    await pool.query(
      `INSERT INTO access.erasure_acknowledgement(route,account_id,participant,outcome,retained)
       VALUES($1,$2,$3,$4,$5)`,
      [routeOf(accountId), accountId, participant, retained.length ? 'erased' : 'none', JSON.stringify(retained)],
    );
  }
  return accountId;
}
const read = (identity: Actor, accountId: string, selected = access) =>
  readManagedErasureStatus({ pool, access: selected }, identity, { accountId }, context());
async function refuses(operation: Promise<unknown>, code: string) {
  await expect(operation).rejects.toMatchObject({ name: 'ProblemError', code });
}

test('platform erasure progress read requires exact current direct Global authority before and final, returns only native minimal pending participant status and never invents completion', async () => {
  const accountId = await root();
  const ordinaryId = await person();
  await grant(ordinaryId, action, { route: routeOf(accountId)!, id: accountId });
  await grant(ordinaryId, 'account:read');
  await refuses(read(await actor(ordinaryId), accountId), 'forbidden');
  await refuses(read({ kind: 'anonymous' }, accountId), 'authentication_required');
  const governorAccount = await governor();
  await refuses(read(await actor(governorAccount.accountId, ['account:read']), accountId), 'forbidden');

  const native = await readErasureStatus(pool, accountId);
  expect(native?.state).toBe('pending');
  expect(await read(governorAccount.actor, accountId)).toEqual({
    accountId,
    state: 'pending',
    at: barrier.toISOString(),
    completedAt: null,
    pendingParticipants: ERASURE_PARTICIPANTS[1].filter((name) => name !== 'access'),
    retentionOutstanding: false,
    lateItems: false,
    effectsFrontier: true,
  });
  expect(await readErasureStatus(pool, accountId)).toEqual(native);

  let prepares = 0;
  const times: unknown[] = [];
  const deadlines: number[] = [];
  const revoked = deriveAccess(access, {
    async prepare(identity, requestedAction, resource, ctx) {
      expect(requestedAction).toBe(action);
      expect(resource).toEqual(GLOBAL_CONTEXT);
      times.push(ctx.time);
      deadlines.push(ctx.deadline);
      if (++prepares === 2) {
        await pool.query(
          `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
           VALUES(0,$1,$2,$3,'resource','(,)',$2)`,
          [GLOBAL_CONTEXT.id, governorAccount.accountId, action],
        );
      }
      return access.prepare!(identity, requestedAction, resource, ctx);
    },
  });
  await refuses(read(governorAccount.actor, accountId, revoked), 'forbidden');
  expect(prepares).toBe(2);
  expect(times[0]).toBeDefined();
  expect(times[1]).toBe(times[0]);
  expect(deadlines[1]).toBe(deadlines[0]);
  await refuses(read(governorAccount.actor, accountId), 'forbidden');
});

test('missing native root is null only after both Global checks; final revocation still denies', async () => {
  const governorAccount = await governor();
  const missing = newId(0x7351);
  expect(await read(governorAccount.actor, missing)).toBeNull();
  let prepares = 0;
  const revoked = deriveAccess(access, {
    async prepare(identity, requestedAction, resource, ctx) {
      if (++prepares === 2)
        await pool.query('DELETE FROM access.resource_role_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2', [
          GLOBAL_CONTEXT.id,
          governorAccount.accountId,
        ]);
      return access.prepare!(identity, requestedAction, resource, ctx);
    },
  });
  await refuses(read(governorAccount.actor, missing, revoked), 'forbidden');
  expect(prepares).toBe(2);
});

test('native complete and outstanding retention project only fixed names and booleans', async () => {
  const governorAccount = await governor();
  for (const state of ['complete', 'retention-outstanding'] as const) {
    const accountId = await root(state);
    const native = await readErasureStatus(pool, accountId);
    const projected = await read(governorAccount.actor, accountId);
    expect(projected).toEqual({
      accountId,
      state: native!.state,
      at: native!.at,
      completedAt: native!.completedAt,
      pendingParticipants: [],
      retentionOutstanding: state === 'retention-outstanding',
      lateItems: native!.outstanding.lateItems,
      effectsFrontier: native!.outstanding.effectsFrontier,
    });
    expect(JSON.stringify(projected)).not.toContain('private');
    expect(JSON.stringify(projected)).not.toContain('retained');
  }
});

test('current principal assignment, both grants, account floor and denial still govern the fixed Global read', async () => {
  const g = await governor();
  const principal = await person();
  const request = newId(routeOf(principal)!);
  await pool.query(
    `INSERT INTO access.principal_assignment(route,principal_id,request_id,assigned_actor_id,valid,transaction_id)
     VALUES($1,$2,$3,$4,'(,)',$3)`,
    [routeOf(principal), principal, request, g.accountId],
  );
  const delegated = await actor(g.accountId, [action], `urn:rezics:request:${principal}:${request}`);
  const accountId = await root();
  await refuses(read(delegated, accountId), 'forbidden');
  await role(principal);
  expect((await read(delegated, accountId))?.state).toBe('pending');
  await pool.query('DELETE FROM access.principal_assignment WHERE route=$1 AND principal_id=$2 AND request_id=$3', [
    routeOf(principal),
    principal,
    request,
  ]);
  await refuses(read(delegated, accountId), 'forbidden');
  await pool.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE route=$1 AND account_id=$2', [
    routeOf(g.accountId),
    g.accountId,
  ]);
  await refuses(read(g.actor, accountId), 'forbidden');
});

test('real mounted transport declares narrow metadata, private status and typed missing or unavailable responses', async () => {
  const declaration = kernel.routes.find((route) => route.path === '/v1/accounts/:accountId/erasureStatus');
  expect(declaration?.method).toBe('GET');
  expect(declaration?.hooks?.detail).toMatchObject({
    operationId: 'account.read_erasure_status',
    'x-action': action,
    'x-exposure': 'gate:account_erasure',
    security: [{ bearerAuth: [] }],
  });
  expect(actionCatalogue(kernel).get(action)).toEqual({ anonymous: false });
  expect(resourceRoleCatalogue(access)?.roles.get('platform.governance')).toContain(action);
  expect(resolveResourceRoles(new Map()).roles.get('platform.governance')).toBeUndefined();
  const g = await governor();
  const token = await accountToken({ accountId: g.accountId, clientId: 'erasure-reader', scopes: [action] });
  const accountId = await root();
  const response = await kernel.handle(
    new Request(`http://kernel.test/v1/accounts/${accountId}/erasureStatus`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual(await read(g.actor, accountId));
  const missing = await kernel.handle(
    new Request(`http://kernel.test/v1/accounts/${newId(0x7351)}/erasureStatus`, {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  expect(missing.status).toBe(404);
  const unavailable = deriveAccess(access, {
    async prepare() {
      throw new Error('secret SQL or locator');
    },
  });
  try {
    await read(g.actor, accountId, unavailable);
    throw new Error('Expected unavailable status');
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemError);
    expect(error).toMatchObject({ code: 'dependency_unavailable', detail: undefined });
    expect(String(error)).not.toContain('secret');
  }
});
