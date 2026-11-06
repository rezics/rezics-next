import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { AuthService } from '@rezics/auth';
import { createPool } from '../../src/database/pool.ts';
import { resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import type { WriteRateLimiter } from '../../src/access/write-rate.ts';
import { defineRateLimit } from '../../src/http/rate-limit.ts';
import type { Access } from '../../src/request/access.ts';
import { createKernelRuntimeDefaults } from '../../src/server.ts';
import { createKernel, createKernelAccessResolver, type Kernel } from '../../src/http/kernel.ts';
import { actionCatalogue, mountedRouteCatalogue } from '../../src/http/request.ts';
import { configureTestReceiptKeys, testReceiptKeys } from './receipt-keys.ts';
import {
  registerTestClient,
  testAccess,
  testApp,
  testAuth,
  testKernel,
  testRouteKey,
  testTokens,
  writeTestReceipt,
} from './test-kernel.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
afterAll(() => pool.end());
const allowWrites: WriteRateLimiter = {
  async spend() {
    return { allowed: true };
  },
};

function routeContract(kernel: Kernel) {
  return mountedRouteCatalogue(kernel)
    .routes.map((route) => {
      const detail = route.hooks?.detail as Record<string, unknown>;
      return {
        method: route.method,
        path: route.path,
        action: detail['x-action'],
        resourceTypes: detail['x-resource-types'],
        exposure: detail['x-exposure'],
        rate: detail['x-rate-limit'],
      };
    })
    .sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
}

function productionComposition(): { kernel: Kernel; access: Access } {
  configureTestReceiptKeys(pool);
  const defaults = createKernelRuntimeDefaults({
    tokens: testTokens(),
    receiptKeys: testReceiptKeys(),
    auth: testAuth,
    writeRate: allowWrites,
  });
  const { auth: _auth, ...runtime } = defaults;
  const accessComposition = createKernelAccessResolver({
    pool,
    tokens: runtime.tokens,
    clock: runtime.clock,
    deadlineNow: runtime.deadlineNow,
    access: runtime.access,
  });
  const kernel = createKernel({ pool, routeKey: testRouteKey(), ...runtime, access: accessComposition.resolveAccess });
  return { kernel, access: accessComposition.resolveAccess({ actions: actionCatalogue(kernel) }) };
}

test('testKernel shares production routes, declarations, rate metadata and Access configuration', () => {
  const production = productionComposition();
  const testComposition = testKernel({ pool });

  expect(routeContract(testComposition)).toEqual(routeContract(production.kernel));
  expect([...actionCatalogue(testComposition)]).toEqual([...actionCatalogue(production.kernel)]);
  expect(resourceRoleCatalogue(testComposition.testAccess)).toEqual(resourceRoleCatalogue(production.access));
  expect(testComposition.testAccess.replayAuthorization?.('post:erase')).toBe('self-account-read');
  expect(testComposition.testAccess.replayAuthorization?.('post:erase')).toBe(
    production.access.replayAuthorization?.('post:erase'),
  );
});

test('testApp mounts the rate stage and testAccess binds the mounted action catalogue and resource types', async () => {
  const spends: { family: string; units: number | undefined }[] = [];
  const writeRate: WriteRateLimiter = {
    async spend(_context, family, units) {
      spends.push({ family, units });
      return { allowed: false, retryAfter: 12 };
    },
  };
  const detail = {
    operationId: 'fixture.report',
    'x-action': 'fixture:declare',
    security: [{ bearerAuth: [] }],
    'x-resource-types': ['content.report'],
    'x-exposure': 'public',
    'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
  };
  const app = testApp({ pool, writeRate }).post('/fixture/report', { detail }, () => 'unreachable');
  const actions = actionCatalogue(app);
  const access = testAccess({ pool, actions });
  const response = await app.handle(new Request('http://localhost/fixture/report', { method: 'POST' }));

  expect(response.status).toBe(429);
  expect(spends).toEqual([{ family: 'write', units: 1 }]);
  expect(resourceRoleCatalogue(access)?.declaredTypes).toEqual(new Map([['fixture:declare', ['content.report']]]));
  expect([...actions]).toEqual(
    [...resourceRoleCatalogue(access)!.declaredTypes!.entries()].map(([action, types]) => [
      action,
      { anonymous: false, 'x-resource-types': types },
    ]),
  );
});

test('named overrides preserve the mounted composition and client registration defaults to production scopes', async () => {
  const production = testKernel({ pool });
  const clockOverride = testKernel({ pool, clock: () => new Date('2026-01-01T00:00:00.000Z') });
  expect(routeContract(clockOverride)).toEqual(routeContract(production));
  expect([...actionCatalogue(clockOverride)]).toEqual([...actionCatalogue(production)]);
  expect(resourceRoleCatalogue(clockOverride.testAccess)).toEqual(resourceRoleCatalogue(production.testAccess));

  const actions = new Map([['fixture:override', { anonymous: false, 'x-resource-types': ['content.report'] }]]);
  const override = testKernel({ pool, actions });
  expect(routeContract(override)).toEqual(routeContract(production));
  expect(resourceRoleCatalogue(override.testAccess)?.declaredTypes).toEqual(
    new Map([['fixture:override', ['content.report']]]),
  );

  const registrations: unknown[] = [];
  const service = {
    internal: {
      async registerClient(input: unknown) {
        registrations.push(input);
      },
    },
  } as unknown as AuthService;
  await registerTestClient(service, { clientId: 'test-client', firstParty: true });
  const scopes = (registrations[0] as { scopes: string[] }).scopes;
  expect(scopes).toEqual([...actionCatalogue(production).keys()].sort());
});

test('receipt writer uses current principals and optionally records the production write basis', async () => {
  const accountId = randomUUID();
  const account = await writeTestReceipt({
    pool,
    partitionNo: 0,
    principal: { kind: 'account', id: accountId, clientId: 'test-client', requestedBy: 'test-requester' },
    writeBasis: true,
  });
  const anonymous = await writeTestReceipt({
    pool,
    partitionNo: 0,
    principal: { kind: 'anonymous' },
    position: 2,
  });

  expect(
    (
      await pool.query(
        `SELECT principal_kind,principal_id,actor_account_id,command_kind,epoch,position::integer,response,
          octet_length(request_digest) AS digest_length,created_at IS NOT NULL AS timestamped
        FROM core.receipt WHERE partition_no=$1 AND transaction_id=ANY($2::uuid[]) ORDER BY position`,
        [0, [account.transactionId, anonymous.transactionId]],
      )
    ).rows,
  ).toEqual([
    {
      principal_kind: 'account',
      principal_id: accountId,
      actor_account_id: accountId,
      command_kind: 'test.fixture',
      epoch: 1,
      position: 1,
      response: {},
      digest_length: 32,
      timestamped: true,
    },
    {
      principal_kind: 'anonymous',
      principal_id: '00000000-0000-0000-0000-000000000000',
      actor_account_id: null,
      command_kind: 'test.fixture',
      epoch: 1,
      position: 2,
      response: {},
      digest_length: 32,
      timestamped: true,
    },
  ]);
  expect(
    (
      await pool.query(
        `SELECT principal_kind,principal_id,actor_account_id,client_id,requested_by,epoch,position::integer,
          recorded_at IS NOT NULL AS timestamped
        FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=ANY($2::uuid[])`,
        [0, [account.transactionId, anonymous.transactionId]],
      )
    ).rows,
  ).toEqual([
    {
      principal_kind: 'account',
      principal_id: accountId,
      actor_account_id: accountId,
      client_id: 'test-client',
      requested_by: 'test-requester',
      epoch: 1,
      position: 1,
      timestamped: true,
    },
  ]);
});
