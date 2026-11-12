import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createPool } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { accessCommandAuthorization, AuthenticationError, type AccountActor } from '../../src/request/access.ts';
import { runCommand } from '../../src/command/command.ts';
import { actionCatalogue, requestDigest } from '../../src/http/request.ts';
import { createLifecycleCommands, LifecycleDeniedError } from '../../src/access/lifecycle.ts';
import { INTERNAL_ACTIONS } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { delegatedAssignmentFixture } from './delegated-auth-fixture.ts';
import { configureTestReceiptKeys, testReceiptKeys } from '../support/receipt-keys.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = createPool(url);
const receiptKeys = testReceiptKeys();
configureTestReceiptKeys(pool, receiptKeys);
configureTestReceiptKeys(admin, receiptKeys);
let assignments: Awaited<ReturnType<typeof delegatedAssignmentFixture>>;
beforeAll(async () => {
  assignments = await delegatedAssignmentFixture(admin, receiptKeys);
}, 60_000);
afterAll(async () => {
  await assignments?.close();
  await pool.end();
  await admin.end();
});
const keys = await generateKeyPair('ES256', { extractable: true });
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'self', alg: 'ES256' };
const issuer = 'https://auth.example.test';
const audience = 'https://api.example.test';
const declarations = ['account:leave', 'account:delete', 'account:read', 'account:update'].map((action) => ({
  method: 'POST',
  path: `/${action.split(':')[1]}`,
  hooks: {
    detail: {
      'x-action': action,
      operationId: action.replace(':', '.'),
      security: [{ bearerAuth: [] }],
      ...(['account:leave', 'account:delete'].includes(action)
        ? { 'x-replay-authorization': 'self-account-read' }
        : {}),
    },
  },
}));
const catalogue = actionCatalogue({ routes: declarations }, INTERNAL_ACTIONS);
const access = createAccess({
  actions: catalogue,
  auth: {
    issuer,
    audience,
    jwksUrl: `${issuer}/jwks`,
    fetch: async () => Response.json({ keys: [jwk] }),
  },
});
class Denied extends Error {}
let trace: string[] = [];
pool.on('connect', (client) => {
  const query = client.query.bind(client);
  client.query = ((...args: Parameters<typeof query>) => {
    const sql = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string }).text ?? '');
    if (sql.includes('AS allowed')) trace.push('authorize');
    if (sql.includes('FROM core.receipt')) trace.push('receipt');
    return query(...args);
  }) as typeof client.query;
});
let sequence = 0;
async function fixture(action = 'account:leave', delegated = false) {
  const route = 0xa100 + 16 * sequence++;
  const accountId = newId(route);
  const otherId = newId(route + 1);
  const principalId = newId(route + 2);
  const assignmentId = newId(route + 2);
  const target = { route, id: accountId };
  const receiptKey = Bun.randomUUIDv7();
  for (const id of [accountId, otherId, principalId])
    await admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$3)`,
      [routeOf(id), id, Bun.randomUUIDv7()],
    );
  if (delegated)
    await assignments.create({
      principalId,
      requestId: assignmentId,
      assignedActorId: accountId,
      valid: '(,)',
    });
  const grant = (resource: string, subject: string, permission: string) =>
    admin.query(
      `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,'(,)',$5)`,
      [routeOf(resource), resource, subject, permission, Bun.randomUUIDv7()],
    );
  for (const subject of delegated ? [accountId, principalId] : [accountId]) {
    await grant(accountId, subject, action);
    await grant(accountId, subject, 'account:read');
  }
  const revoke = (resource: string, subject: string, permission: string) =>
    admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action=$4', [
      routeOf(resource),
      resource,
      subject,
      permission,
    ]);
  const authenticate = async (scope = `${action} account:read`) => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      client_id: 'web',
      scope,
      authn_epoch: 1,
      auth_time: now,
      amr: ['pwd'],
      ...(delegated ? { requested_by: `urn:rezics:request:${principalId}:${assignmentId}` } : {}),
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'self', typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(accountId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);
    return access.authenticate(token, { pool, deadline: Date.now() + 2000 });
  };
  let bodies = 0;
  const run = async (actor: AccountActor, key = receiptKey) => {
    const authorization = await accessCommandAuthorization(
      access,
      actor,
      action,
      target,
      { pool, deadline: Date.now() + 2000 },
      () => new Denied(),
    );
    return runCommand(
      pool,
      {
        partition: partitionOf(route),
        basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
        receipt: {
          actorAccountId: actor.accountId,
          kind: action.replace(':', '.'),
          key,
          digest: requestDigest(action.replace(':', '.'), actor, target),
        },
        authorization,
      },
      async (tx) => {
        bodies++;
        await tx.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND action=$3', [
          route,
          accountId,
          action,
        ]);
        return {
          value: { secret: 'own receipt', accountId },
          events: [{ type: 'com.rezics.test.left.v1', data: { accountId } }],
        };
      },
    );
  };
  const snapshot = async () =>
    (
      await admin.query(
        `SELECT position::text,
      (SELECT jsonb_agg(r ORDER BY idempotency_key) FROM core.receipt r WHERE partition_no=$1) AS receipts,
      (SELECT jsonb_agg(o ORDER BY position,event_seq) FROM core.outbox o WHERE partition_no=$1) AS events
     FROM core.partition WHERE partition_no=$1`,
        [partitionOf(route)],
      )
    ).rows[0];
  return { accountId, otherId, principalId, route, authenticate, run, snapshot, grant, revoke, bodies: () => bodies };
}

test('only an explicit catalogue declaration derives the self-account-read metadata', () => {
  expect(catalogue.get('account:leave')).toEqual({ anonymous: false, replay: 'self-account-read' });
  expect(catalogue.get('account:delete')).toEqual({ anonymous: false, replay: 'self-account-read' });
  expect(() =>
    actionCatalogue({
      routes: [
        {
          method: 'POST',
          path: '/bad',
          hooks: {
            detail: {
              'x-action': 'account:leave',
              operationId: 'account.leave',
              security: [{ bearerAuth: [] }],
              'x-replay-authorization': true,
            },
          },
        },
      ],
    }),
  ).toThrow('unsupported x-replay-authorization');
  expect(() =>
    actionCatalogue(
      {
        routes: [
          {
            method: 'POST',
            path: '/delete',
            hooks: {
              detail: {
                'x-action': 'account:delete',
                operationId: 'account.delete',
                security: [{ bearerAuth: [] }],
              },
            },
          },
        ],
      },
      INTERNAL_ACTIONS,
    ),
  ).toThrow('different replay authorization');
  expect(() =>
    actionCatalogue({
      routes: [
        declarations[0]!,
        {
          ...declarations[0]!,
          hooks: {
            detail: {
              'x-action': 'account:leave',
              operationId: 'account.other',
              security: [{ bearerAuth: [] }],
            },
          },
        },
      ],
    }),
  ).toThrow('different replay authorization');
});

test('declared self-revocation retrieves only its existing receipt through the own-account read formula', async () => {
  const f = await fixture();
  const first = await f.run(await f.authenticate());
  const before = await f.snapshot();
  trace = [];
  expect(await f.run(await f.authenticate())).toEqual({ ...first, replayed: true });
  expect(trace).toEqual(['authorize', 'authorize', 'receipt']);
  expect(f.bodies()).toBe(1);
  expect(await f.snapshot()).toEqual(before);
  trace = [];
  await expect(f.run(await f.authenticate(), Bun.randomUUIDv7())).rejects.toBeInstanceOf(Denied);
  expect(trace).toEqual(['authorize', 'authorize', 'receipt']);
  expect(f.bodies()).toBe(1);
  expect(await f.snapshot()).toEqual(before);
});

test('the internal account-delete declaration retains its exact self-read replay', async () => {
  const f = await fixture('account:delete');
  const first = await f.run(await f.authenticate());
  const before = await f.snapshot();
  trace = [];
  expect(await f.run(await f.authenticate())).toEqual({ ...first, replayed: true });
  expect(trace).toEqual(['authorize', 'authorize', 'receipt']);
  expect(f.bodies()).toBe(1);
  expect(await f.snapshot()).toEqual(before);
});

test('a suggestive unknown action name never gets alternate replay authority', async () => {
  const f = await fixture('account:remove');
  await f.run(await f.authenticate());
  const before = await f.snapshot();
  trace = [];
  await expect(f.run(await f.authenticate())).rejects.toBeInstanceOf(Denied);
  expect(trace).not.toContain('receipt');
  expect(f.bodies()).toBe(1);
  expect(await f.snapshot()).toEqual(before);
});

test('read authority for another account cannot enable self replay, nor can a missing read scope', async () => {
  const f = await fixture();
  await f.run(await f.authenticate());
  const before = await f.snapshot();
  await f.revoke(f.accountId, f.accountId, 'account:read');
  await f.grant(f.otherId, f.accountId, 'account:read');
  trace = [];
  await expect(f.run(await f.authenticate())).rejects.toBeInstanceOf(Denied);
  expect(trace).not.toContain('receipt');
  await f.grant(f.accountId, f.accountId, 'account:read');
  trace = [];
  await expect(f.run(await f.authenticate('account:leave'))).rejects.toBeInstanceOf(Denied);
  expect(trace).not.toContain('receipt');
  expect(f.bodies()).toBe(1);
  expect(await f.snapshot()).toEqual(before);
});

test('the self-read exception still intersects the principal grant', async () => {
  const f = await fixture('account:leave', true);
  await f.run(await f.authenticate());
  const before = await f.snapshot();
  await f.revoke(f.accountId, f.principalId, 'account:read');
  trace = [];
  await expect(f.run(await f.authenticate())).rejects.toBeInstanceOf(Denied);
  expect(trace).not.toContain('receipt');
  expect(await f.snapshot()).toEqual(before);
});

for (const change of ['deleted', 'fenced', 'epoch'])
  test(`self replay does not revive ${change} authentication`, async () => {
    const f = await fixture();
    await f.run(await f.authenticate());
    const before = await f.snapshot();
    await admin.query(
      `UPDATE access.account SET ${change === 'deleted' ? "state='deleted'" : change === 'fenced' ? 'authn_fenced=true' : 'minimum_authn_epoch=2'} WHERE route=$1 AND account_id=$2`,
      [f.route, f.accountId],
    );
    await expect(f.authenticate()).rejects.toBeInstanceOf(AuthenticationError);
    expect(await f.snapshot()).toEqual(before);
  });

test('the actual public lifecycle binding authorizes matching replays with installed JWT Access', async () => {
  const f = await fixture('account:update');
  const commands = createLifecycleCommands({ pool, access });
  const input = { accountId: f.accountId, key: Bun.randomUUIDv7(), patch: { displayName: 'one update' } };
  const context = async () => ({
    actor: await f.authenticate(),
    account: await readAccount(admin, f.route, f.accountId),
    deadline: Date.now() + 2000,
  });
  const first = await commands.updateAccount(await context(), input);
  const before = await f.snapshot();
  trace = [];
  expect(await commands.updateAccount(await context(), input)).toEqual({ ...first, replayed: true });
  expect(trace).toEqual(['authorize', 'receipt']);
  await f.revoke(f.accountId, f.accountId, 'account:update');
  trace = [];
  await expect(commands.updateAccount(await context(), input)).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(trace).not.toContain('receipt');
  expect(await f.snapshot()).toEqual(before);
});

for (const operation of ['approval', 'consumption'])
  test(`public operator ${operation} reauthorizes before a matching receipt`, async () => {
    const { createOperatorCommands, OperatorDeniedError } = await import('../../src/access/operator.ts');
    const f = await fixture('account:update');
    const operators = createOperatorCommands({ pool, access, actions: catalogue, managementAction: 'account:update' });
    const held = await operators.reserveResponsibility({
      operatorAccountId: f.accountId,
      subjectAccountId: f.otherId,
      key: Bun.randomUUIDv7(),
    });
    await operators.recordOperatorRelation({
      ...held.value,
      expectedOperatorAccountId: null,
      expectedVersion: '0',
      key: Bun.randomUUIDv7(),
    });
    const context = async () => ({
      actor: await f.authenticate(),
      account: await readAccount(admin, f.route, f.accountId),
      deadline: Date.now() + 2000,
    });
    const input = {
      operatorAccountId: f.accountId,
      subjectAccountId: f.otherId,
      purpose: 'session' as const,
      key: Bun.randomUUIDv7(),
    };
    const opening = await operators.authorizeOpening(await context(), input);
    const consumption = { ...input, receiptId: opening.value.receiptId, key: Bun.randomUUIDv7() };
    if (operation === 'consumption') await operators.consumeOpening(await context(), consumption);
    const before = await f.snapshot();
    if (operation === 'approval') {
      trace = [];
      expect(await operators.authorizeOpening(await context(), input)).toEqual({ ...opening, replayed: true });
      expect(trace).toEqual(['authorize', 'receipt']);
      expect(await f.snapshot()).toEqual(before);
    }
    await f.revoke(f.accountId, f.accountId, 'account:update');
    trace = [];
    await expect(
      operation === 'approval'
        ? operators.authorizeOpening(await context(), input)
        : operators.consumeOpening(await context(), consumption),
    ).rejects.toBeInstanceOf(OperatorDeniedError);
    expect(trace).toEqual(['authorize']);
    expect(await f.snapshot()).toEqual(before);
  });
