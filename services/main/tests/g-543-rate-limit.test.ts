import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { rateLimitBudgets, rateLimitFamily, families } from '../src/modules/rate-limit/budgets.ts';
import type { RateLimitOptions } from '../src/modules/rate-limit/store.ts';
import { createMainApp } from '../src/app.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { compareMigrationPaths } from '../../../scripts/lib/migration-order.ts';
import { exposureDeclarations } from '../src/modules/access/exposure-declarations.ts';

const options: RateLimitOptions = { secret: 'g543-test-counter-secret-at-least-32-characters',
  serviceClientIds: new Set(['installed-importer']), trustedProxyPeers: new Set(['127.0.0.2']),
  clientIpHeader: 'x-forwarded-for' };

test('G-543: every current OpenAPI operation has an explicit policy and path boundaries protect safety budgets', () => {
  // Generation consumes these authored operations. The installed-route guard
  // below also covers routes added before their OpenAPI declaration exists.
  // Neither inventory needs schema rendering or a potentially stale artifact.
  const spec: { paths: Record<string, Record<string, unknown>> } = { paths: {} };
  for (const owner of exposureDeclarations) for (const [path, methods] of Object.entries(owner)) {
    spec.paths[path] = { ...spec.paths[path], ...methods };
  }
  let mutations = 0;
  const missing: string[] = [];
  for (const [path, methods] of Object.entries(spec.paths)) for (const method of Object.keys(methods)) {
    if (method === 'parameters') continue;
    if (rateLimitFamily(method.toUpperCase(), path) === undefined) missing.push(`${method.toUpperCase()} ${path}`);
    mutations++;
  }
  const migrations = resolve(import.meta.dir, '../migrations/access');
  let admittedFamilies: string[] = [];
  for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: migrations })].sort(compareMigrationPaths)) {
    const sql = readFileSync(join(migrations, file), 'utf8');
    if (!/CREATE TABLE access\.rate_limit_v1|ALTER TABLE access\.rate_limit_v1 ADD CONSTRAINT rate_limit_v1_family_check/.test(sql)) continue;
    const check = /CHECK\s*\(family IN\s*\(([^)]+)\)\)/.exec(sql);
    if (check) admittedFamilies = [...check[1]!.matchAll(/'([^']+)'/g)].map(match => match[1]!);
  }
  expect(admittedFamilies).toEqual(expect.arrayContaining([...families]));
  expect(missing).toEqual([]);
  expect(mutations).toBeGreaterThan(50);
  expect(rateLimitFamily('GET', '/v1/works')).toBeNull();
  expect(rateLimitFamily('POST', '/v1/query')).toBe('search');
  expect(rateLimitFamily('POST', '/v1/resources/summaries')).toBeNull();
  for (const path of ['/v1/rating-aggregates', '/v1/global-rating-aggregates', '/v1/rating-syntheses',
    '/v1/classification-resolutions', '/v1/statement-resolutions', '/v1/context-interpretations']) {
    expect(rateLimitFamily('POST', path)).toBeNull();
  }
  expect(rateLimitFamily('POST', '/v1/subscriptions/quotes')).toBe('write');
  expect(rateLimitFamily('POST', '/v1/new-unclassified-operation')).toBeUndefined();
  expect(rateLimitFamily('GET', '/v1/unclassified-read')).toBeUndefined();
  expect(rateLimitFamily('HEAD', '/v1/works')).toBeNull();
  expect(rateLimitFamily('GET', '/v1/me/platform-access')).toBeNull();
  expect(rateLimitFamily('HEAD', '/v1/me/platform-access')).toBeNull();
  expect(rateLimitFamily('POST', '/v1/queries')).toBe('search');
  expect(rateLimitFamily('POST', '/v1/queries/page')).toBe('search');
  expect(rateLimitFamily('PUT', '/v1/media/uploads/123/bytes')).toBe('upload');
  expect(rateLimitFamily('POST', '/v1/media/uploads-evil')).toBeUndefined();
  expect(rateLimitFamily('POST', '/v1/public-reports')).toBe('report');
  expect(rateLimitFamily('POST', '/v1/appeals')).toBeUndefined();
  expect(rateLimitFamily('POST', '/v1/rights/complaints')).toBe('report');
  expect(rateLimitFamily('POST', '/v1/public-reports/123/correspondence')).toBe('correspondence');
  expect(rateLimitFamily('POST', '/v1/cases/123/messages')).toBeUndefined();
  expect(() => rateLimitBudgets('{"member":{"write":{"maximum":0,"seconds":60}}}')).toThrow();
  expect(() => rateLimitBudgets('{"service":{"wriet":{"maximum":1,"seconds":60}}}')).toThrow();
});

test('every installed Main plugin group has the declared rate-limit hook', () => {
  const seen: string[] = [];
  const limit = { options, budgets: rateLimitBudgets(), store: {
    async classify() { return 'member' as const; },
    async consume(_identity: string, family: string) { seen.push(family); return { allowed: false, retryAfter: 31 }; },
  } };
  const work = { rateLimit: limit, mcp: { issuer: 'https://account.test/api/auth', resource: 'http://localhost' },
    account: { async verify() { return { issuer: 'account', subject: 'same' }; } } } as unknown as MainWorkDependencies;
  const app = createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'), work);
  // The guard must be present in every plugin group, including those composed
  // before domainRoutes. Merely testing a standalone plugin misses hook order.
  expect(app.routes.filter(route => rateLimitFamily(route.method, route.path) === undefined)
    .map(route => `${route.method} ${route.path}`)).toEqual([]);
  expect(app.routes.map(route => `${route.method} ${route.path}`)).toEqual(expect.arrayContaining([
    '* /mcp', 'GET /.well-known/oauth-protected-resource', 'GET /.well-known/oauth-protected-resource/mcp',
  ]));
  expect(rateLimitFamily('POST', '/mcp')).toBeNull();
  expect(rateLimitFamily('GET', '/mcp')).toBeNull();
  let guarded = 0;
  for (const route of app.routes) {
    expect(rateLimitFamily(route.method, route.path)).not.toBeUndefined();
    if (rateLimitFamily(route.method, route.path) === null) continue;
    const hooks = (route.hooks.beforeHandle ?? []) as Function[];
    expect(hooks.some(hook => hook.name === 'enforceRateLimit')).toBe(true);
    guarded++;
  }
  expect(guarded).toBeGreaterThan(50);
});
