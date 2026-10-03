import { expect, test } from 'bun:test';
import { Elysia, t } from 'elysia';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { rateLimitBudgets, type PrincipalClass } from '../src/modules/rate-limit/budgets.ts';
import { rateLimitHook, type MainRateLimit } from '../src/modules/rate-limit/hook.ts';

const options: MainRateLimit['options'] = {
  secret: 'g-1003-address-budget-fixture-secret',
  serviceClientIds: new Set(),
  trustedProxyPeers: new Set(),
  clientIpHeader: 'x-rezics-client-ip',
};

function fixture(principalClass: PrincipalClass = 'anonymous', unavailable = false) {
  const seen: Array<{ identity: string; family: string; maximum: number }> = [];
  let verifications = 0,
    classifications = 0;
  const app = new Elysia()
    .use(
      rateLimitHook(
        {
          async verify(request) {
            verifications++;
            if (request.headers.get('authorization') === 'Bearer invalid')
              throw new AccountAssertionDenied();
            return {
              issuer: 'account',
              subject: 'reader',
              accountExpiresAt: Date.now() / 1000 + 300,
            };
          },
        },
        {
          options,
          budgets: rateLimitBudgets(),
          store: {
            async classify() {
              classifications++;
              return principalClass;
            },
            async consume(identity, family, budget) {
              seen.push({ identity, family, maximum: budget.maximum });
              if (unavailable) throw new Error('Counters unavailable');
              return { allowed: false, retryAfter: 19 };
            },
          },
        },
      ),
    )
    .get(
      '/v1/addresses/resolve',
      {
        query: t.Object({ key: t.String({ minLength: 1 }) }),
      },
      ({ query }) => new Response(null, { status: Number(query.key) }),
    )
    .post('/v1/addresses/resolutions', () => 'batch')
    .get('/v1/addresses/availability', () => 'availability')
    .get('/v1/addresses/revisions/:revision', () => 'revision');
  const send = (path: string, method = 'GET', token?: string) =>
    app.handle(
      new Request(`http://main.local${path}`, {
        method,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    );
  return { seen, send, counts: () => ({ verifications, classifications }) };
}

test('G1003: hits, conditional hits, retirement and infrastructure errors never spend miss capacity', async () => {
  const f = fixture('anonymous', true);
  for (const status of [200, 304, 410, 503]) {
    for (const token of [undefined, 'reader']) {
      expect((await f.send(`/v1/addresses/resolve?key=${status}`, 'GET', token)).status).toBe(
        status,
      );
    }
  }
  expect(f.seen).toEqual([]);
  expect(f.counts()).toEqual({ verifications: 0, classifications: 0 });
});

test.each(['anonymous', 'new-account', 'member', 'trusted', 'service'] as const)(
  'G1003: missing and malformed addresses use the %s budget with Retry-After',
  async (principalClass) => {
    const f = fixture(principalClass);
    const token = principalClass === 'anonymous' ? undefined : 'reader';
    for (const key of ['400', '404', '422', '']) {
      const response = await f.send(`/v1/addresses/resolve?key=${key}`, 'GET', token);
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('19');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ code: 'rate_limited', family: 'address' });
    }
    expect(f.seen).toEqual(
      Array.from({ length: 4 }, () => ({
        identity: token ? JSON.stringify(['account', 'reader']) : 'anonymous:unknown',
        family: 'address',
        maximum: rateLimitBudgets()[principalClass].address.maximum,
      })),
    );
    expect(f.counts()).toEqual({ verifications: token ? 1 : 0, classifications: token ? 1 : 0 });
  },
);

test('G1003: misses fail closed on counter loss or an invalid bearer', async () => {
  const f = fixture('member', true);
  const outage = await f.send('/v1/addresses/resolve?key=404');
  expect(outage.status).toBe(503);
  expect(outage.headers.get('retry-after')).toBe('5');
  expect((await f.send('/v1/addresses/resolve?key=404', 'GET', 'invalid')).status).toBe(401);
  expect(f.seen).toHaveLength(1);
});

test('G1003: batch, availability and revision inventory retain pre-read address budgets', async () => {
  const f = fixture();
  for (const [method, path] of [
    ['POST', '/v1/addresses/resolutions'],
    ['GET', '/v1/addresses/availability'],
    ['GET', '/v1/addresses/revisions/revision'],
  ])
    expect((await f.send(path!, method)).status).toBe(429);
  expect(f.seen.map((item) => item.family)).toEqual(['address', 'address', 'address']);
});
