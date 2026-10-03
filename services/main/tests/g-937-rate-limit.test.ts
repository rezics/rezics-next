import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { rateLimitHook } from '../src/modules/rate-limit/hook.ts';
import { rateLimitBudgets, rateLimitFamily } from '../src/modules/rate-limit/budgets.ts';

test('G937: verified address misses consume budgets instead of the signed-in search exemption', async () => {
  const seen: { family: string; maximum: number }[] = [];
  const app = new Elysia()
    .use(
      rateLimitHook(
        {
          async verify() {
            return { issuer: 'test', subject: 'member', accountExpiresAt: Date.now() / 1000 + 300 };
          },
        },
        {
          budgets: rateLimitBudgets(),
          options: {
            secret: 'g-937-address-budget-fixture-secret',
            serviceClientIds: new Set(),
            trustedProxyPeers: new Set(),
            clientIpHeader: 'x-forwarded-for',
          },
          store: {
            async classify() {
              return 'member';
            },
            async consume(_identity, family, budget) {
              seen.push({ family, maximum: budget.maximum });
              return { allowed: false, retryAfter: 60 };
            },
          },
        },
      ),
    )
    .get('/v1/addresses/resolve', () => new Response(null, { status: 404 }));
  const response = await app.handle(
    new Request('http://localhost/v1/addresses/resolve', {
      headers: { authorization: 'Bearer member' },
    }),
  );
  expect(response.status).toBe(429);
  expect(seen).toEqual([{ family: 'address', maximum: 120 }]);
  expect(rateLimitFamily('POST', '/v1/addresses/resolutions')).toBe('address');
  expect(rateLimitFamily('GET', '/v1/addresses/revisions/revision')).toBe('address');
  expect(rateLimitFamily('GET', '/v1/addresses/current')).toBeNull();
  expect(rateLimitFamily('GET', '/v1/realms/by-handle/old')).toBeUndefined();
  expect(rateLimitFamily('GET', '/v1/addresses/work/old')).toBeUndefined();
});
