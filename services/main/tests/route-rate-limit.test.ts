import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { createMainApp } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { exposureDeclarations } from '../src/modules/access/exposure-declarations.ts';
import { families, rateLimitBudgets, rateLimitFamily } from '../src/modules/rate-limit/budgets.ts';
import { rateLimitHook } from '../src/modules/rate-limit/hook.ts';
import { createRateLimitResolver } from '../src/modules/rate-limit/routes.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

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

test('admission resolves every declared family from the route owner metadata', () => {
  const mismatches = exposureDeclarations.flatMap((owner) =>
    Object.entries(owner).flatMap(([path, methods]) =>
      Object.entries(methods).flatMap(([method, entry]) => {
        // Missing metadata is refused by the separate complete-inventory guard.
        if (entry.rateLimitFamily === undefined) return [];
        const verb = method === 'all' ? '*' : method.toUpperCase();
        const expected = entry.rateLimitFamily === 'read' ? null : entry.rateLimitFamily;
        const actual = rateLimitFamily(verb, path);
        return actual === expected ? [] : [{ method: verb, path, expected, actual }];
      }),
    ),
  );
  expect(mismatches).toEqual([]);
});

test('retired classification decisions and Statement migration operations stay absent', () => {
  const retired = [
    ['POST', '/v1/classification-decisions'],
    ['GET', '/v1/statement-migrations/v1/pending'],
    ['POST', '/v1/statement-migrations/v1/{id}'],
    ['POST', '/v1/statement-migrations/v1/cutover'],
  ] as const;
  const app = createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'), {
    mcp: { issuer: 'https://account.test', resource: 'https://main.test/mcp' },
  } as MainWorkDependencies);
  const installed = new Set(
    app.routes.map((route) => `${route.method} ${route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`),
  );
  expect(retired.filter(([method, path]) => installed.has(`${method} ${path}`))).toEqual([]);
  for (const [method, path] of retired) {
    expect(exposureDeclarations.some((owner) => owner[path]?.[method.toLowerCase()])).toBe(false);
    expect(rateLimitFamily(method, path)).toBeUndefined();
  }
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

test('rights and governance declarations retain command, report and read-only policies', () => {
  for (const path of ['/v1/governance/rule-queries', '/v1/rights/use-evaluations'])
    expect(rateLimitFamily('POST', path)).toBeNull();
  for (const path of ['/v1/reports', '/v1/rights/complaints'])
    expect(rateLimitFamily('POST', path)).toBe('report');
  for (const path of [
    '/v1/governance/rules',
    '/v1/governance/process-steps',
    '/v1/moderation/decisions',
    '/v1/rights/offerings',
    '/v1/rights/offerings/offering/changes',
    '/v1/rights/use-assessments',
    '/v1/rights/restrictions',
  ])
    expect(rateLimitFamily('POST', path)).toBe('write');
  for (const path of [
    '/v1/reports/report',
    '/v1/rights/offerings/offering',
    '/v1/rights/offerings/offering/revisions/revision',
  ]) {
    expect(rateLimitFamily('GET', path)).toBeNull();
    expect(rateLimitFamily('HEAD', path)).toBeNull();
  }
});

test('rights and governance read exemptions and report budgets survive Account loss', async () => {
  let verifications = 0,
    classifications = 0,
    effects = 0;
  const consumed: string[] = [];
  const app = new Elysia().use(
    rateLimitHook(
      {
        async verify() {
          verifications++;
          throw new Error('Account unavailable');
        },
      },
      {
        options: {
          secret: 'route-admission-counter-secret-at-least-32-characters',
          serviceClientIds: new Set(),
          trustedProxyPeers: new Set(),
          clientIpHeader: 'x-forwarded-for',
        },
        budgets: rateLimitBudgets(),
        store: {
          async classify() {
            classifications++;
            throw new Error('Classification unavailable');
          },
          async consume(_identity, family) {
            consumed.push(family);
            return { allowed: false, retryAfter: 19 };
          },
        },
      },
    ),
  );
  for (const path of [
    '/v1/governance/rule-queries',
    '/v1/rights/use-evaluations',
    '/v1/reports',
    '/v1/rights/complaints',
  ])
    app.post(path, () => {
      effects++;
      return 'effect';
    });
  for (const path of ['/v1/governance/rule-queries', '/v1/rights/use-evaluations']) {
    const response = await app.handle(
      new Request(`http://main.test${path}`, {
        method: 'POST',
        headers: { authorization: 'Bearer rejected' },
      }),
    );
    expect(response.status).toBe(200);
  }
  for (const path of ['/v1/reports', '/v1/rights/complaints']) {
    const response = await app.handle(
      new Request(`http://main.test${path}`, {
        method: 'POST',
        headers: { authorization: 'Bearer rejected' },
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('19');
    expect(await response.json()).toMatchObject({ family: 'report' });
  }
  expect(consumed).toEqual(['report', 'report']);
  expect({ verifications, classifications, effects }).toEqual({
    verifications: 0,
    classifications: 0,
    effects: 2,
  });
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
