import { expect, test } from 'bun:test';
import { Elysia, t } from 'elysia';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { exposureDeclarations } from '../src/modules/access/exposure-declarations.ts';
import {
  anonymousPlatformAccess,
  exposureAllows,
  PlatformClosed,
  requireSelectedPlatformCapability,
} from '../src/modules/access/exposure.ts';
import {
  bindPlatformExposure,
  exposureOperationId,
} from '../src/modules/access/exposure-routes.ts';
import {
  assertRouteExposures,
  exposureSdkSource,
  platformClosedResponse,
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
  const app = new Elysia()
    .get('/undeclared', () => {
      calls++;
      return 'effect';
    })
    .use(bindPlatformExposure({ account: { verify: async () => principal } }, []));
  expect(() => assertRouteExposures(app.routes)).toThrow('no exposure declaration');
  const response = await app.handle(new Request('http://main.test/undeclared'));
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'platform_closed' });
  expect(calls).toBe(0);
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
  // Recipe create, change and read now use the existing Composition operations.
  // Approved public by trust-ops on 2026-10-07 within the first public Zone scope.
  expect(publicOperations).toContain('postV1ZonesByIdSite-publications');
  expect(publicOperations).toHaveLength(522);
  expect(publicOperations.filter((id) => libraryCopiesAndLoans.includes(id)).sort()).toEqual(
    libraryCopiesAndLoans,
  );
  expect(matrix.filter((entry) => entry.exposure !== 'public')).toHaveLength(244);
  expect(entries.filter((entry) => entry.method === 'ws')).toHaveLength(3);
  const sdk = exposureSdkSource(app.routes);
  expect(sdk).toContain('platformOperationOpen');
  expect(sdk).toContain('platform:saved-views');
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
  expect(platformFoundationOperations).toHaveLength(181);
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
