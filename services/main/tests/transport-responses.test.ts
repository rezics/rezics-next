import { expect, test } from 'bun:test';
import { Elysia, t } from 'elysia';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { transportProblem, transportResponses } from '../src/transport-responses.ts';
import { exposureDeclarations } from '../src/modules/access/exposure-declarations.ts';
import { families, rateLimitBudgets } from '../src/modules/rate-limit/budgets.ts';
import { rateLimitHook } from '../src/modules/rate-limit/hook.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { bindPlatformExposure, platformExistenceHidden } from '../src/modules/access/exposure-routes.ts';
import { PlatformClosed, type ExposureDeclaration } from '../src/modules/access/exposure.ts';
import { problem } from '../src/routes/problems.ts';

const options = { secret: 'transport-budget-fixture-secret-at-least-32-bytes',
  serviceClientIds: new Set<string>(), trustedProxyPeers: new Set<string>(), clientIpHeader: 'x-forwarded-for' };
const principal = { issuer: 'https://account.test', subject: 'reader' };
const account = { verify: async () => principal };

async function declaredRefusal(response: Response, schemas: Record<number, TSchema>, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const body = await response.json();
  expect(body.code).toBe(code);
  expect(Value.Check(schemas[status]!, body)).toBe(true);
  expect(Value.Check(schemas[status]!, { ...body, code: 'undeclared_transport_code' })).toBe(false);
}

for (const family of families) test(`the actual ${family} hook answers with its declared literal budget variant`, async () => {
  const declarations = exposureDeclarations.flatMap(owner => Object.entries(owner)
    .flatMap(([path, methods]) => Object.entries(methods).map(([method, metadata]) => ({ path, method, metadata }))));
  const operation = declarations.find(entry => entry.metadata.rateLimitFamily === family)!;
  expect(operation).toBeDefined();
  const method = operation.method.toUpperCase();
  const path = operation.path.replace(/\{[^}]+\}/g, 'sample');
  const schemas = transportResponses(operation.metadata, { 200: t.String(),
    404: transportProblem(404, 'not_found') }, method);
  const app = new Elysia().use(rateLimitHook(account, { options, budgets: rateLimitBudgets(), store: {
    classify: async () => 'member', consume: async () => ({ allowed: false, retryAfter: 19 }),
  } })).all(path, { response: schemas }, () => path === '/v1/addresses/resolve'
    ? problem(404, 'not_found', 'Absent') : 'success');
  const response = await app.handle(new Request(`http://localhost${path}`, { method }));
  expect(response.headers.get('retry-after')).toBe('19');
  await declaredRefusal(response, schemas, 429, 'rate_limited');
});

test('counter and authentication failures retain their separate 503 and 401 literal schemas', async () => {
  for (const failure of ['counter', 'identity'] as const) {
    const metadata = { exposure: 'public', rateLimitFamily: 'write' } as const;
    const schemas = transportResponses(metadata, { 200: t.String() }, 'POST');
    const app = new Elysia().use(rateLimitHook({ verify: async () => {
      if (failure === 'identity') throw new AccountAssertionDenied();
      return principal;
    } }, { options, budgets: rateLimitBudgets(), store: {
      classify: async () => 'member', consume: async () => { throw new Error('counter unavailable'); },
    } })).post('/v1/works', { response: schemas }, () => 'success');
    const response = await app.handle(new Request('http://localhost/v1/works', {
      method: 'POST', headers: { authorization: 'Bearer fixture' },
    }));
    await declaredRefusal(response, schemas, failure === 'counter' ? 503 : 401,
      failure === 'counter' ? 'rate_limit_unavailable' : 'invalid_account_assertion');
  }
});

test('read exemptions and successful address resolutions neither declare nor consume a read budget', async () => {
  let calls = 0;
  const store = { classify: async () => 'member' as const,
    consume: async () => { calls++; return { allowed: false, retryAfter: 1 }; } };
  const read = transportResponses({ exposure: 'public', rateLimitFamily: 'read' }, { 200: t.String() }, 'POST');
  expect(read).not.toHaveProperty('429');
  const address = transportResponses({ exposure: 'public', rateLimitFamily: 'address' }, { 200: t.String() }, 'GET');
  expect(address).toHaveProperty('429');
  const app = new Elysia().use(rateLimitHook(account, { options, budgets: rateLimitBudgets(), store }))
    .post('/v1/resources/summaries', { response: read }, () => 'success')
    .get('/v1/addresses/resolve', { response: address }, () => 'success');
  for (const [method, path] of [['POST', '/v1/resources/summaries'], ['GET', '/v1/addresses/resolve']]) {
    expect((await app.handle(new Request(`http://localhost${path}`, { method }))).status).toBe(200);
  }
  expect(calls).toBe(0);
});

test('independent intake families do not acquire Account authentication responses', () => {
  for (const family of ['report', 'correspondence', 'provider'] as const) {
    const schemas = transportResponses({ exposure: 'public', rateLimitFamily: family }, {}, 'POST');
    expect(schemas).not.toHaveProperty('401');
    expect(schemas).toHaveProperty('429');
  }
});

test('platform refusals match declared variants and hidden resources answer like absent ones', async () => {
  for (const path of ['/v1/realms/example/member-ban', '/v1/realms/example/member-receipts/example/appeal', '/v1/platform-probe']) {
    const hidden = platformExistenceHidden('GET', path);
    const metadata: ExposureDeclaration = { exposure: 'platform:realm-appeals', rateLimitFamily: 'read' };
    const schemas = transportResponses(metadata, { 200: t.String() }, 'GET', hidden);
    const codes = JSON.stringify(schemas);
    if (hidden) expect(codes).not.toContain('platform_closed');
    for (const failure of ['anonymous', 'denied', 'invalid', 'unavailable', 'missing'] as const) {
      const app = new Elysia().get(path, { response: schemas }, () => problem(404, 'appeal_unavailable', 'Appeal is unavailable'))
        .use(bindPlatformExposure({ account: { verify: async () => {
          if (failure === 'invalid') throw new AccountAssertionDenied();
          return principal;
        } }, platformAccess: { groupOpened: () => false, require: async () => {
          if (failure === 'missing') return;
          if (failure === 'unavailable') throw new Error('Access unavailable');
          throw new PlatformClosed();
        } } }, [{ [path]: { get: metadata } }]));
      const response = await app.handle(new Request(`http://localhost${path}`, {
        ...(failure === 'anonymous' ? {} : { headers: { authorization: 'Bearer fixture' } }),
      }));
      const [status, code] = failure === 'invalid' ? [401, 'invalid_account_assertion']
        : failure === 'unavailable' ? [503, 'platform_access_unavailable']
          : failure === 'missing' || hidden ? [404, 'appeal_unavailable']
            : failure === 'anonymous' ? [401, 'unauthorized'] : [403, 'platform_closed'];
      // The public probe has no domain 404 declaration; it tests only the gate.
      if (failure === 'missing' && !hidden) continue;
      await declaredRefusal(response, schemas, status as number, code as string);
      if (hidden && (failure === 'anonymous' || failure === 'denied' || failure === 'missing')) {
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    }
  }
});

test('idempotency metadata adds the existing invalid-key and conflicting-intent variants', () => {
  const schemas = transportResponses({ exposure: 'public', rateLimitFamily: 'write', idempotencyKey: true }, {}, 'POST');
  expect(JSON.stringify(schemas[400])).toContain('invalid_idempotency_key');
  expect(JSON.stringify(schemas[409])).toContain('idempotency_conflict');
});
