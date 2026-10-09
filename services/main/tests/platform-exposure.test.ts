import { expect, test } from 'bun:test';
import { Elysia, t } from 'elysia';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { exposureDeclarations } from '../src/modules/access/exposure-declarations.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import {
  anonymousPlatformAccess,
  exposureAllows,
  PLATFORM_OPEN_GROUPS,
  PlatformClosed,
  qaStackPlatformOpenGroups,
  readPlatformOpenGroups,
  requireSelectedPlatformCapability,
} from '../src/modules/access/exposure.ts';
import {
  bindPlatformExposure,
  exposureOperationId,
  platformExistenceHidden,
} from '../src/modules/access/exposure-routes.ts';
import {
  assertRouteExposures,
  exposureSdkSource,
  platformClosedResponse,
  platformUnauthenticatedResponse,
} from '../../../scripts/api/exposure.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { platformFoundationOperations } from './platform-foundation.ts';

const principal = { issuer: 'https://account.test', subject: 'reader' };
const viewer = {
  groups: ['saved-views'],
  operations: ['postV1RecommendationsPages'],
  generation: '1',
};

test('public, group and individual exposure leave missing declarations closed', () => {
  expect(exposureAllows('public', 'read', anonymousPlatformAccess())).toBe(true);
  expect(exposureAllows('platform:saved-views', 'read', viewer)).toBe(true);
  expect(exposureAllows('platform:recommendations', 'postV1RecommendationsPages', viewer)).toBe(
    true,
  );
  expect(exposureAllows('platform:events', 'read', viewer)).toBe(false);
  expect(exposureAllows(undefined, 'postV1RecommendationsPages', viewer)).toBe(false);
});

test('OpenAPI retains the resource refusal when documenting a platform refusal', () => {
  const resource = { type: 'object', properties: { code: { const: 'resource_denied' } } };
  const result = platformClosedResponse({
    description: 'Resource refused',
    content: { 'application/json': { schema: resource } },
  });
  expect(result.description).toContain('Resource refused');
  expect(result.content).not.toHaveProperty('application/json');
  expect(result.content['application/problem+json'].schema).toMatchObject({
    anyOf: [resource, { properties: { code: { const: 'platform_closed' } } }],
  });
});

test('undeclared routes fail the static gate and deny before their handler', async () => {
  let calls = 0;
  let grants = 0;
  // Closed on purpose: a QA stack that opens every group must not change this case.
  const app = new Elysia()
    .get('/undeclared', () => {
      calls++;
      return 'effect';
    })
    .use(bindPlatformExposure({
      account: { verify: async () => principal },
      platformAccess: {
        groupOpened: () => false,
        require: async () => {
          grants++;
          throw new PlatformClosed();
        },
      },
    }, []));
  expect(() => assertRouteExposures(app.routes)).toThrow('no exposure declaration');
  const anonymous = await app.handle(new Request('http://main.test/undeclared'));
  expect(anonymous.status).toBe(401);
  expect(await anonymous.json()).toMatchObject({ code: 'unauthorized' });
  expect(grants).toBe(0);
  const signed = await app.handle(new Request('http://main.test/undeclared', {
    headers: { authorization: 'Bearer reader' },
  }));
  expect(signed.status).toBe(403);
  expect(await signed.json()).toMatchObject({ code: 'platform_closed' });
  expect(calls).toBe(0);
  // A missing declaration is closed without reading grants.
  expect(grants).toBe(0);
});

test('opening exposure still requires the handler resource authority', async () => {
  let calls = 0;
  const app = new Elysia()
    .get('/closed', () => {
      calls++;
      return new Response(null, { status: 403 });
    })
    .use(
      bindPlatformExposure(
        {
          account: { verify: async () => principal },
          platformAccess: {
            require: async (_principal, exposure, operationId) => {
              if (!exposureAllows(exposure, operationId, viewer)) throw new PlatformClosed();
            },
          },
        },
        [{ '/closed': { get: { exposure: 'platform:saved-views' } } }],
      ),
    );
  const response = await app.handle(
    new Request('http://main.test/closed', { headers: { authorization: 'Bearer reader' } }),
  );
  expect(response.status).toBe(403);
  expect(calls).toBe(1);
});

test('server-selected query templates and edit commands cannot be opened by a body field', async () => {
  const owner = {
    require: async (_principal: unknown, exposure: unknown) => {
      if (exposure !== 'public') throw new PlatformClosed();
    },
  };
  let effects = 0;
  const app = new Elysia()
    .error(({ error }) =>
      error instanceof PlatformClosed
        ? Response.json({ code: error.code }, { status: 403 })
        : undefined,
    )
    .post('/v1/query', { body: t.Object({ exposure: t.String() }) }, async () => {
      await requireSelectedPlatformCapability(owner, principal, {
        exposure: 'platform:saved-views',
        operationId: 'postV1Query',
      });
      effects++;
      return {};
    })
    .post('/v1/content-edits', { body: t.Object({ exposure: t.String() }) }, async () => {
      await requireSelectedPlatformCapability(owner, principal, {
        exposure: 'platform:events',
        operationId: 'postV1Content-edits',
      });
      effects++;
      return {};
    });
  for (const path of ['/v1/query', '/v1/content-edits']) {
    const response = await app.handle(
      new Request(`http://main.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exposure: 'public' }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'platform_closed' });
  }
  expect(effects).toBe(0);
});

test('every served Main route, including transports, has a reviewed exposure', () => {
  const app = createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'), {
    mcp: { issuer: 'https://account.test', resource: 'https://main.test/mcp' },
  } as MainWorkDependencies);
  assertRouteExposures(app.routes);
  const entries = exposureDeclarations.flatMap((owner) =>
    Object.entries(owner).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => ({ path, method, ...operation })),
    ),
  );
  const matrix = entries.filter(
    (entry) =>
      /^\/v[12]\//.test(entry.path) &&
      entry.method !== 'ws' &&
      entry.path !== '/v1/me/platform-access',
  );
  const publicOperations = matrix
    .filter((entry) => entry.exposure === 'public')
    .map((entry) => exposureOperationId(entry.method, entry.path));
  const libraryCopiesAndLoans = [
    'deleteV1MeLibrary-copiesById',
    'getV1MeLibrary-loans',
    'getV1WorksByIdCopies',
    'patchV1MeLibrary-copiesById',
    'postV1MeLibrary-copies',
    'postV1MeLibrary-loans',
    'postV1MeLibrary-loansByIdExtend',
    'postV1MeLibrary-loansByIdReturn',
  ];
  // Recipe reads use Composition; Work versions, adoptions and credits use the public query transport.
  // Approved public by trust-ops on 2026-10-07 within the first public Zone scope.
  expect(publicOperations).toContain('postV1ZonesByIdSite-publications');
  // Trust-ops approved public on 2026-10-07 13:14 UTC: first Bangumi/progress scope, bearer, read family, signed-in reader's data only.
  expect(publicOperations).toContain('getV1CompositionsByIdProgress');
  expect(matrix.find(entry => entry.path === '/v1/compositions/{id}/progress' && entry.method === 'get'))
    .toMatchObject({ exposure: 'public', rateLimitFamily: 'read', bearer: true });
  // Trust-ops approved public on 2026-10-07 23:32 UTC: Library import status, bearer, work:read, read family, the signed-in reader's own upload only; polling never starts or accepts a new job.
  expect(publicOperations).toContain('getV1MeLibrary-importsByIdApply');
  expect(matrix.find(entry => entry.path === '/v1/me/library-imports/{id}/apply' && entry.method === 'get'))
    .toMatchObject({ exposure: 'public', rateLimitFamily: 'read', bearer: true });
  // Trust approved the credits facade with optional bearer reads.
  expect(publicOperations).toContain('getV1WorksByIdCredits');
  expect(matrix.find(entry => entry.path === '/v1/works/{id}/credits' && entry.method === 'get'))
    .toMatchObject({ exposure: 'public', rateLimitFamily: 'read', bearer: false });
  // Recipe timings add one public write, reviewed with the measures route it extends.
  expect(publicOperations).toContain('postV1RecipesByIdTimings');
  // Trust-ops approved public on 2026-10-08 11:10 UTC (cross-Space Realm attachment review): a current Realm steward withdraws a cross-Space attachment, bearer, write family, idempotency key.
  expect(publicOperations).toContain('postV1ZonesByIdRealm-attachment-withdrawals');
  expect(matrix.find(entry => entry.path === '/v1/zones/{id}/realm-attachment-withdrawals' && entry.method === 'post'))
    .toMatchObject({ exposure: 'public', rateLimitFamily: 'write', bearer: true });
  // Launch-declared public within the first public scope under trust-ops' standing consent (2026-10-07): a Realm's stewards list the Zones attached to it, optional bearer, read family; others read it as a missing Realm.
  expect(publicOperations).toContain('getV1RealmsByRealmZone-attachments');
  expect(matrix.find(entry => entry.path === '/v1/realms/{realm}/zone-attachments' && entry.method === 'get'))
    .toMatchObject({ exposure: 'public', rateLimitFamily: 'read' });
  expect(publicOperations).toHaveLength(525);
  expect(publicOperations.filter((id) => libraryCopiesAndLoans.includes(id)).sort()).toEqual(
    libraryCopiesAndLoans,
  );
  // Closed sanction-appeal read and write. Trust-ops keeps platform:realm-appeals shut until a later grant opens it.
  const closedOperations = matrix
    .filter((entry) => entry.exposure !== 'public')
    .map((entry) => exposureOperationId(entry.method, entry.path));
  expect(closedOperations).toHaveLength(247);
  expect(closedOperations).toContain('getV1RealmsByRealmMember-receiptsByReceiptIdAppeal');
  expect(closedOperations).toContain('postV1RealmsByRealmMember-receiptsByReceiptIdAppeal');
  // Closed own-ban read. The controller sees that ban; every other caller gets the same absence.
  // Trust-ops keeps platform:realm-appeals shut until a later grant opens it.
  expect(closedOperations).toContain('getV1RealmsByRealmMember-ban');
  expect(matrix.find((entry) => entry.path === '/v1/realms/{realm}/member-ban' && entry.method === 'get'))
    .toMatchObject({ exposure: 'platform:realm-appeals', rateLimitFamily: 'read', bearer: true });
  expect(
    matrix.find(
      (entry) =>
        entry.path === '/v1/realms/{realm}/member-receipts/{receiptId}/appeal' &&
        entry.method === 'get',
    ),
  ).toMatchObject({ exposure: 'platform:realm-appeals', rateLimitFamily: 'read', bearer: true });
  expect(
    matrix.find(
      (entry) =>
        entry.path === '/v1/realms/{realm}/member-receipts/{receiptId}/appeal' &&
        entry.method === 'post',
    ),
  ).toMatchObject({
    exposure: 'platform:realm-appeals',
    rateLimitFamily: 'write',
    bearer: true,
    idempotencyKey: true,
  });
  expect(entries.filter((entry) => entry.method === 'ws')).toHaveLength(3);
  const sdk = exposureSdkSource(app.routes);
  expect(sdk).toContain('platformOperationOpen');
  expect(sdk).toContain('platform:saved-views');
  expect(sdk).toContain('platformClosedAnonymousStatus = 401');
});

test('operation IDs retain OpenAPI parameter and hyphen spelling', () => {
  expect(exposureOperationId('GET', '/v1/me/saved-filters/:id')).toBe('getV1MeSaved-filtersById');
});

test('the complete lockout foundation remains public on a stack with no platform-use grants', async () => {
  const work = {
    account: { verify: async () => principal },
    platformAccess: {
      require: async () => {
        throw new PlatformClosed();
      },
    },
  } as unknown as MainWorkDependencies;
  const app = createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'), work);
  const declarations = new Map(
    exposureDeclarations.flatMap((owner) =>
      Object.entries(owner).flatMap(([path, methods]) =>
        Object.entries(methods).map(
          ([method, entry]) => [`${method.toUpperCase()} ${path}`, entry.exposure] as const,
        ),
      ),
    ),
  );
  expect(platformFoundationOperations).toHaveLength(178);
  for (const [method, path] of platformFoundationOperations) {
    expect(declarations.get(`${method} ${path}`)).toBe('public');
    const concrete = path.replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000001');
    const response = await app.handle(
      new Request(`http://main.test${concrete}`, {
        method,
        headers: {
          authorization: 'Bearer reader',
          ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method !== 'GET' ? { body: '{}' } : {}),
      }),
    );
    expect(await response.text()).not.toContain('platform_closed');
  }
  const anonymous = await app.handle(new Request('http://main.test/health/live'));
  expect(anonymous.status).toBe(200);
});

const closedGate = () => {
  let grants = 0;
  const platformAccess = {
    groupOpened: () => false,
    require: async () => {
      grants++;
      throw new PlatformClosed();
    },
  };
  const app = new Elysia()
    .get('/closed', () => 'open')
    .get('/v1/realms/:realm/member-ban', () => 'ban')
    .get('/v1/realms/:realm/member-receipts/:receiptId/appeal', () => 'appeal')
    .use(bindPlatformExposure({
      account: {
        verify: async (request) => {
          if (request.headers.get('authorization') === 'Bearer bad')
            throw new AccountAssertionDenied('Bearer required');
          return principal;
        },
      },
      platformAccess,
    }, [{
      '/closed': { get: { exposure: 'platform:saved-views' } },
      '/v1/realms/{realm}/member-ban': { get: { exposure: 'platform:realm-appeals' } },
      '/v1/realms/{realm}/member-receipts/{receiptId}/appeal': { get: { exposure: 'platform:realm-appeals' } },
    }]));
  return { app, grants: () => grants };
};

test('a closed operation answers 401 before a grant check when the caller is anonymous', async () => {
  const gate = closedGate();
  const missing = await gate.app.handle(new Request('http://main.test/closed'));
  expect(missing.status).toBe(401);
  expect(await missing.json()).toMatchObject({ code: 'unauthorized' });
  const invalid = await gate.app.handle(new Request('http://main.test/closed', {
    headers: { authorization: 'Bearer bad' },
  }));
  expect(invalid.status).toBe(401);
  expect(await invalid.json()).toMatchObject({ code: 'invalid_account_assertion' });
  expect(gate.grants()).toBe(0);
});

test('an authenticated caller without the grant still receives platform_closed', async () => {
  const gate = closedGate();
  const response = await gate.app.handle(new Request('http://main.test/closed', {
    headers: { authorization: 'Bearer reader' },
  }));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'platform_closed' });
  expect(gate.grants()).toBe(1);
});

test('an open platform group returns 200 without a grant check', async () => {
  let grants = 0;
  const app = new Elysia()
    .get('/closed', () => 'open')
    .use(bindPlatformExposure({
      account: { verify: async () => principal },
      platformAccess: {
        groupOpened: (exposure) => exposure === 'platform:saved-views',
        require: async () => {
          grants++;
          throw new PlatformClosed();
        },
      },
    }, [{ '/closed': { get: { exposure: 'platform:saved-views' } } }]));
  const response = await app.handle(new Request('http://main.test/closed', {
    headers: { 'x-rezics-platform-open-groups': '*' },
  }));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('open');
  expect(grants).toBe(0);
});

test('a missing platform owner follows the open-groups setting', async () => {
  const previous = process.env[PLATFORM_OPEN_GROUPS];
  const had = Object.hasOwn(process.env, PLATFORM_OPEN_GROUPS);
  process.env[PLATFORM_OPEN_GROUPS] = '*';
  try {
    await requireSelectedPlatformCapability(undefined, principal, {
      exposure: 'platform:dataset-dumps',
      operationId: 'postV1Exports',
    });
  } finally {
    if (had) process.env[PLATFORM_OPEN_GROUPS] = previous;
    else delete process.env[PLATFORM_OPEN_GROUPS];
  }
  await expect(requireSelectedPlatformCapability(undefined, principal, {
    exposure: 'platform:dataset-dumps',
    operationId: 'postV1Exports',
  })).rejects.toBeInstanceOf(PlatformClosed);
});

test('a request cannot open a closed platform group', async () => {
  const gate = closedGate();
  const response = await gate.app.handle(new Request('http://main.test/closed', {
    headers: {
      authorization: 'Bearer reader',
      'x-rezics-platform-open-groups': '*',
      [PLATFORM_OPEN_GROUPS]: '*',
    },
  }));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'platform_closed' });
});

test('closed ban and appeal reads stay 404 for anonymous and ungranted callers', async () => {
  const gate = closedGate();
  const ban = await gate.app.handle(new Request('http://main.test/v1/realms/00000000-0000-4000-8000-000000000001/member-ban'));
  expect(ban.status).toBe(404);
  expect(await ban.json()).toMatchObject({ code: 'appeal_unavailable' });
  const appeal = await gate.app.handle(new Request(
    'http://main.test/v1/realms/00000000-0000-4000-8000-000000000001/member-receipts/00000000-0000-4000-8000-000000000002/appeal',
  ));
  expect(appeal.status).toBe(404);
  expect(await appeal.json()).toMatchObject({ code: 'appeal_unavailable' });
  const signed = await gate.app.handle(new Request(
    'http://main.test/v1/realms/00000000-0000-4000-8000-000000000001/member-ban',
    { headers: { authorization: 'Bearer reader' } },
  ));
  expect(signed.status).toBe(404);
  expect(await signed.json()).toMatchObject({ code: 'appeal_unavailable' });
  const invalid = await gate.app.handle(new Request(
    'http://main.test/v1/realms/00000000-0000-4000-8000-000000000001/member-receipts/00000000-0000-4000-8000-000000000002/appeal',
    { headers: { authorization: 'Bearer bad' } },
  ));
  expect(invalid.status).toBe(401);
  expect(platformExistenceHidden('GET', '/v1/realms/{realm}/member-ban')).toBe(true);
  expect(platformExistenceHidden('POST', '/v1/realms/{realm}/member-receipts/{receiptId}/appeal')).toBe(false);
});

test('the open-groups setting accepts only an environment value', () => {
  expect(readPlatformOpenGroups({})).toBeUndefined();
  expect(readPlatformOpenGroups({ [PLATFORM_OPEN_GROUPS]: '' })).toBeUndefined();
  expect(readPlatformOpenGroups({ [PLATFORM_OPEN_GROUPS]: '*' })).toBe('*');
  expect(readPlatformOpenGroups({ [PLATFORM_OPEN_GROUPS]: 'saved-views, events' })).toEqual([
    'saved-views',
    'events',
  ]);
  expect(() => readPlatformOpenGroups({ [PLATFORM_OPEN_GROUPS]: 'Saved' })).toThrow(PLATFORM_OPEN_GROUPS);
  let reads = 0;
  const read = (path: string) => {
    reads++;
    expect(path).toContain('/.temp/stack/rezics-qa-run1/apps.env');
    return `${PLATFORM_OPEN_GROUPS}=*\nMAIN_PORT=1\n`;
  };
  expect(qaStackPlatformOpenGroups({
    NODE_ENV: 'production', REZICS_QA_RUN_ID: 'run1',
  }, read, '/work')).toBeUndefined();
  expect(qaStackPlatformOpenGroups({ REZICS_QA_RUN_ID: '../secrets' }, read, '/work')).toBeUndefined();
  expect(reads).toBe(0);
  expect(qaStackPlatformOpenGroups({ REZICS_QA_RUN_ID: 'run1' }, read, '/work')).toBe('*');
  expect(reads).toBe(1);
  const closed = platformUnauthenticatedResponse();
  expect(closed.description).toContain('Authentication required');
  expect(closed.content['application/problem+json'].schema).toMatchObject({
    anyOf: [
      { properties: { status: { const: 401 }, code: { const: 'unauthorized' } } },
      { properties: { code: { const: 'invalid_account_assertion' } } },
    ],
  });
});
