import { expect, test } from 'bun:test';
import { Elysia, t } from 'elysia';
import { Value } from 'typebox/value';
import { problemResult } from '../src/api-contract.ts';
import { families, RATE_LIMIT_V1 } from '../src/modules/rate-limit/budgets.ts';
import { rateLimitHook } from '../src/modules/rate-limit/hook.ts';

const refusal = { type: 'about:blank', status: 429, code: 'rate_limited',
  title: 'Request budget exhausted' };

test('closed 429 Problem schemas accept budget families and other capacity refusals', () => {
  const schema = problemResult(429);
  expect(Value.Check(schema, refusal)).toBe(true);
  for (const family of families) expect(Value.Check(schema, { ...refusal, family })).toBe(true);
  expect(Value.Check(schema, { ...refusal, family: 1 })).toBe(false);
  expect(Value.Check(schema, { ...refusal, unexpected: true })).toBe(false);
  expect(Value.Check(problemResult(503), { ...refusal, status: 503, family: 'upload' })).toBe(false);
});

test.each([['/v1/me/library-imports', 'upload'], ['/v1/works', 'write']] as const)(
  'typed budget refusal survives the closed response validator for %s', async (path, family) => {
    let effects = 0;
    const app = new Elysia().onError(() => new Response('invalid refusal', { status: 500 }))
      .use(rateLimitHook({ verify: async () => { throw new Error('anonymous request'); } }, {
        budgets: RATE_LIMIT_V1,
        options: { secret: 'test-budget-secret', serviceClientIds: new Set(),
          trustedProxyPeers: new Set(), clientIpHeader: 'x-forwarded-for' },
        store: { classify: async () => 'member',
          consume: async () => ({ allowed: false, retryAfter: 60 }) },
      }))
      .post(path, { response: { 200: t.Null(), 429: problemResult(429) } }, () => { effects++; return null; });
    const response = await app.handle(new Request(`http://main.test${path}`, { method: 'POST' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toEqual({ ...refusal, family });
    expect(effects).toBe(0);
  },
);
