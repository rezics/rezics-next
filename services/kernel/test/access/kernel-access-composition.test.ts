import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createAuthService } from '@rezics/auth';
import { bundledRelease } from '@rezics/definitions/bundled';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import * as accessModule from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { resolveResourceRoles, resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createKernel, createKernelAccessResolver, KernelAccessCompositionError } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import type { Access, ActionCatalogue } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createAuthDatabase } from '../support/auth-database.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { testRouteKey, testTokens } from '../support/test-kernel.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';

let db: GrowthDatabase;
let authPool: Pool | undefined;
let authDatabase: string | undefined;
beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
}, 120_000);
afterAll(async () => {
  await authPool?.end();
  if (authDatabase) await dropTestDatabase(db.admin, authDatabase);
  await db?.close();
});

test('the default kernel Access receives every mounted action and resolves the complete resource role catalogue once', async () => {
  const realCreateAccess = accessModule.createAccess;
  let installed: Access | undefined;
  const factory = spyOn(accessModule, 'createAccess').mockImplementation((config) => {
    installed = realCreateAccess(config);
    return installed;
  });
  try {
    const kernel = createKernel({ pool: db.pool, routeKey: testRouteKey() });
    expect(factory).not.toHaveBeenCalled();
    const mounted = actionCatalogue(kernel);
    const read = () => kernel.handle(new Request(`http://kernel.test/v1/contexts/${GLOBAL_CONTEXT}`));
    expect((await read()).status).toBe(200);
    expect((await read()).status).toBe(200);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]![0].actions).toEqual(mounted);
    const recognized = new Set<string>();
    for (const action of [...mounted.keys(), 'fixture:unmounted']) {
      const evidence = await installed!.prepare!(
        { kind: 'anonymous' },
        action,
        { route: 0, id: GLOBAL_CONTEXT },
        { pool: db.pool, deadline: Date.now() + 10_000 },
      );
      if (evidence !== null) recognized.add(action);
    }
    expect(recognized).toEqual(new Set(mounted.keys()));

    // Access adds the internal governance action; it has no mounted HTTP route.
    const known = new Map(mounted).set('gate:any', { anonymous: false });
    const roles = resourceRoleCatalogue(installed!);
    expect(roles).toEqual(resolveResourceRoles(known));
    for (const type of ['semantic.context', 'library.collection', 'community.realm', 'community.space'])
      expect(roles!.types.has(type)).toBe(true);
    for (const metadata of mounted.values())
      for (const type of metadata['x-resource-types'] ?? []) expect(roles!.types.has(type)).toBe(true);
  } finally {
    factory.mockRestore();
  }
});

test('a composing kernel refuses early Access resolution and uses its final catalogue instead of the caller subset', () => {
  let mounted: ActionCatalogue | undefined;
  const resolver = createKernelAccessResolver({
    pool: db.pool,
    tokens: testTokens(),
    clock: () => new Date(),
    composedActions: () => mounted,
  });
  const partial = { actions: new Map() };
  expect(() => resolver.resolveAccess(partial)).toThrow(KernelAccessCompositionError);
  expect(() => resolver.resolveAccess(partial)).toThrow('Access was resolved before kernel composition finished');
  mounted = actionCatalogue(createKernel({ pool: db.pool, routeKey: testRouteKey() }));
  const installed = resolver.resolveAccess(partial);
  expect(resourceRoleCatalogue(installed)).toEqual(
    resolveResourceRoles(new Map(mounted).set('gate:any', { anonymous: false })),
  );
  expect(resolver.resolveAccess(partial)).toBe(installed);
});

test('an explicitly supplied Access instance keeps its identity during composition', () => {
  const installed = accessModule.createAccess({ actions: new Map() });
  const resolver = createKernelAccessResolver({
    pool: db.pool,
    tokens: testTokens(),
    clock: () => new Date(),
    access: installed,
    composedActions: () => undefined,
  });
  expect(resolver.resolveAccess({ actions: new Map() })).toBe(installed);
});

test('an Auth-issued bearer with the Global Context creation grant creates a Context and receives its owner grant', async () => {
  authDatabase = `kernel_composition_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  authPool = new Pool({ connectionString: await createAuthDatabase(db.url, authDatabase) });
  const accountId = newId(0x7131);
  const issuer = 'https://kernel-composition.auth.test';
  const audience = 'https://kernel-composition.api.test';
  const signing = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'kernel-composition',
  };
  const approvals = new Set([accountId]);
  const auth = await createAuthService({
    database: authPool,
    issuer,
    audience,
    secret: 'kernel-composition-auth-secret-at-least-32-bytes',
    signing: { activeKid: signing.kid, privateKeys: [signing] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        const account = await readAccount(db.admin, routeOf(id)!, id);
        return (
          account && {
            accountId: id,
            kind: account.kind,
            state: account.state,
            authnEpoch: Number(account.minimumAuthnEpoch),
            automated: false,
          }
        );
      },
      async authorizeProvisioning(reference) {
        if (!approvals.delete(reference)) throw new Error('Missing fixture provisioning approval');
        return { accountId: reference };
      },
    }),
  });
  const scopes = ['context:create'];
  await auth.internal.registerClient({ clientId: 'web', firstParty: true, scopes });
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','pending',$2)`,
    [routeOf(accountId), accountId],
  );
  const email = `${accountId}@example.test`;
  const password = 'kernel composition test password';
  await auth.internal.provisionPassword({ authorization: accountId, email, password });
  await db.admin.query(`UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2`, [
    routeOf(accountId),
    accountId,
  ]);
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES (0,$1,$2,'context:create','(,)',$2)`,
    [GLOBAL_CONTEXT, accountId],
  );
  const post = (path: string, body: unknown, cookie = '') =>
    auth.handler(
      new Request(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      }),
    );
  const login = await post('/signin', { email, password, client_id: 'web', scope: scopes });
  expect(login.status).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const issued = await post('/token', {}, cookie);
  expect(issued.status).toBe(200);
  const bearer = ((await issued.json()) as { access_token: string }).access_token;
  const kernel = createKernel({
    pool: db.pool,
    routeKey: testRouteKey(),
    access: (config) =>
      accessModule.createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: (url, init) => auth.handler(new Request(url, init)),
        },
      }),
    writeRate: createWriteRateLimiter({ secret: 'kernel-composition-rate-secret-at-least-32-bytes' }),
  });
  const response = await kernel.handle(
    new Request('http://kernel.test/v1/contexts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(Bun.randomUUIDv7()),
      },
      body: JSON.stringify({ labels: { en: 'Kernel composition context' } }),
    }),
  );
  expect(response.status).toBe(201);
  const { context } = (await response.json()) as { context: { id: string } };
  const { rows } = await db.admin.query(
    `SELECT grant_role, subject_kind, subject_id FROM access.resource_role_grant
     WHERE route=$1 AND resource_id=$2`,
    [routeOf(context.id), context.id],
  );
  expect(rows).toEqual([{ grant_role: 'semantic.context.owner', subject_kind: 'identity', subject_id: accountId }]);
}, 120_000);
