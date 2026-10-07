import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { exposureDeclarations } from '../src/modules/access/exposure-declarations.ts';
import { families, rateLimitBudgets, rateLimitFamily } from '../src/modules/rate-limit/budgets.ts';
import { rateLimitHook } from '../src/modules/rate-limit/hook.ts';
import { createRateLimitResolver } from '../src/modules/rate-limit/routes.ts';

test('route admission refuses missing and invalid declaration families', () => {
  for (const family of [undefined, null, '', 'wriet', 'READ', false, 0, {}, []]) {
    const resolve = createRateLimitResolver([
      { '/unclassified': { post: { rateLimitFamily: family } } },
    ]);
    expect(resolve('POST', '/unclassified')).toBeUndefined();
  }
  for (const family of families) {
    const resolve = createRateLimitResolver([
      { '/command': { post: { rateLimitFamily: family } } },
    ]);
    expect(resolve('POST', '/command')).toBe(family);
  }
  expect(
    createRateLimitResolver([{ '/read': { post: { rateLimitFamily: 'read' } } }])('POST', '/read'),
  ).toBeNull();
});

test('every route owner declares a valid admission family beside exposure', () => {
  const missing = exposureDeclarations.flatMap((owner) =>
    Object.entries(owner).flatMap(([path, methods]) =>
      Object.entries(methods).flatMap(([method, entry]) =>
        entry.rateLimitFamily === 'read' ||
        families.some((family) => family === entry.rateLimitFamily)
          ? []
          : [`${method.toUpperCase()} ${path}`],
      ),
    ),
  );
  expect(missing).toEqual([]);
});

test('route declaration matching preserves HEAD, ALL, WS and whole parameter segments', () => {
  const resolve = createRateLimitResolver([
    {
      '/objects/{id}': { get: { rateLimitFamily: 'read' }, post: { rateLimitFamily: 'write' } },
      '/objects/search': { get: { rateLimitFamily: 'search' } },
      '/mcp': { all: { rateLimitFamily: 'read' } },
      '/events': { ws: { rateLimitFamily: 'read' } },
      '/literal.+': { post: { rateLimitFamily: 'report' } },
    },
  ]);
  expect(resolve('HEAD', '/objects/123')).toBeNull();
  expect(resolve('POST', '/objects/123')).toBe('write');
  expect(resolve('POST', '/objects/:renamed')).toBe('write');
  expect(resolve('POST', '/objects/{renamed}')).toBe('write');
  expect(resolve('GET', '/objects/search')).toBe('search');
  expect(resolve('HEAD', '/objects/search')).toBe('search');
  for (const method of ['GET', 'POST', 'DELETE', '*']) expect(resolve(method, '/mcp')).toBeNull();
  expect(resolve('WS', '/events')).toBeNull();
  expect(resolve('GET', '/events')).toBeUndefined();
  expect(resolve('GET', '/mcp-lookalike')).toBeUndefined();
  expect(resolve('POST', '/objects/123/extra')).toBeUndefined();
  expect(resolve('POST', '/literal.+')).toBe('report');
  expect(resolve('POST', '/literalZZ')).toBeUndefined();
  expect(resolve('DELETE', '/objects/123')).toBeUndefined();
  expect(resolve('POST', '/unknown')).toBeUndefined();
});

test('route metadata preserves special budgets and read-only command exemptions', () => {
  expect(rateLimitFamily('GET', '/v1/me/library-imports/import/rows')).toBe('write');
  expect(rateLimitFamily('GET', '/v1/addresses/availability')).toBe('address');
  expect(rateLimitFamily('GET', '/v1/discovery/concepts')).toBe('search');
  expect(rateLimitFamily('POST', '/v1/private-queries')).toBe('search');
  expect(rateLimitFamily('POST', '/v1/resources/summaries')).toBeNull();
  expect(rateLimitFamily('POST', '/v1/rating-aggregates')).toBeNull();
  expect(rateLimitFamily('POST', '/v1/media/uploads')).toBe('upload');
  expect(rateLimitFamily('POST', '/v1/public-reports')).toBe('report');
  expect(rateLimitFamily('POST', '/v1/public-reports/case/correspondence')).toBe('correspondence');
  expect(rateLimitFamily('POST', '/v1/notification-providers/provider/events')).toBe('provider');
  for (const method of ['GET', 'POST', 'DELETE'])
    expect(rateLimitFamily(method, '/mcp')).toBeNull();
  expect(rateLimitFamily('GET', '/.well-known/oauth-protected-resource')).toBeNull();
  expect(rateLimitFamily('GET', '/.well-known/oauth-protected-resource/mcp')).toBeNull();
});

test('an undeclared operation denies before verification, counters or handler effects', async () => {
  let calls = 0;
  const unexpected = () => {
    calls++;
    throw new Error('Unclassified operation must deny first');
  };
  const app = new Elysia()
    .use(
      rateLimitHook(
        { verify: unexpected },
        {
          options: {
            secret: 'route-admission-counter-secret-at-least-32-characters',
            serviceClientIds: new Set(),
            trustedProxyPeers: new Set(),
            clientIpHeader: 'x-forwarded-for',
          },
          budgets: rateLimitBudgets(),
          store: { classify: unexpected, consume: unexpected },
        },
      ),
    )
    .post('/unclassified-operation', unexpected);
  const response = await app.handle(
    new Request('http://main.test/unclassified-operation', {
      method: 'POST',
      headers: { authorization: 'Bearer reader' },
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'rate_limit_unclassified' });
  expect(response.headers.get('retry-after')).toBe('5');
  expect(calls).toBe(0);
});
