import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { rateLimitBudgets, type PrincipalClass } from '../src/modules/rate-limit/budgets.ts';
import { rateLimitHook, type MainRateLimit } from '../src/modules/rate-limit/hook.ts';

const options: MainRateLimit['options'] = {
  secret: 'g-970-rate-limit-fixture-secret-at-least-32-characters',
  serviceClientIds: new Set(),
  trustedProxyPeers: new Set(),
  clientIpHeader: 'x-forwarded-for',
};

test('G-970: discovery, rating, reading, joining, membership and name reads survive counter loss', async () => {
  let verifications = 0, classifications = 0, counters = 0;
  const app = new Elysia().use(rateLimitHook({ async verify() {
    verifications++;
    throw new Error('Account unavailable');
  } }, {
    options, budgets: rateLimitBudgets(), store: {
      async classify() { classifications++; throw new Error('Access unavailable'); },
      async consume() { counters++; throw new Error('Counters unavailable'); },
    },
  }));
  const paths = [
    '/v1/discovery/sections', '/v1/rating-populations', '/v1/reading-positions/work',
    '/v1/realms/realm/join-page', '/v1/realms/realm/join-requests/basis',
    '/v1/realms/realm/join-requests', '/v1/realms/realm/join-requests/mine',
    '/v1/me/memberships', '/v1/me/follows', '/v1/me/follow-state',
    '/v1/collections/collection/name', '/v1/spaces/space', '/v1/spaces/space/settings',
  ];
  for (const path of paths) app.get(path, () => 'read');
  for (const path of paths) {
    for (const token of [undefined, 'Bearer reader']) {
      const response = await app.handle(new Request(`http://localhost${path}`, {
        headers: token ? { authorization: token } : {},
      }));
      expect(response.status).toBe(200);
    }
  }
  expect({ verifications, classifications, counters }).toEqual({ verifications: 0, classifications: 0, counters: 0 });
});

test('G-970: topic search charges anonymous peers and the verified reader class budget', async () => {
  const seen: { identity: string; family: string; maximum: number }[] = [];
  let verifications = 0, classifications = 0;
  const app = new Elysia().use(rateLimitHook({ async verify(request) {
    verifications++;
    if (request.headers.get('authorization') === 'Bearer invalid') throw new AccountAssertionDenied();
    return { issuer: 'account', subject: 'reader', accountExpiresAt: Date.now() / 1000 + 300 };
  } }, {
    options, budgets: rateLimitBudgets(), store: {
      async classify() { classifications++; return 'member' as const; },
      async consume(identity, family, budget) {
        seen.push({ identity, family, maximum: budget.maximum });
        return { allowed: false, retryAfter: 17 };
      },
    },
  })).get('/v1/discovery/concepts', () => 'topics');
  const anonymous = await app.handle(new Request('http://localhost/v1/discovery/concepts?q=topic'));
  expect(anonymous.status).toBe(429);
  expect(anonymous.headers.get('retry-after')).toBe('17');
  expect((await anonymous.json()).family).toBe('search');
  const signed = await app.handle(new Request('http://localhost/v1/discovery/concepts?q=topic', {
    headers: { authorization: 'Bearer reader' },
  }));
  expect(signed.status).toBe(429);
  expect((await signed.json()).family).toBe('search');
  const again = await app.handle(new Request('http://localhost/v1/discovery/concepts?q=topic', {
    headers: { authorization: 'Bearer reader' },
  }));
  expect(again.status).toBe(429);
  expect(seen).toEqual([
    { identity: 'anonymous:unknown', family: 'search', maximum: 30 },
    { identity: JSON.stringify(['account', 'reader']), family: 'search', maximum: 120 },
    { identity: JSON.stringify(['account', 'reader']), family: 'search', maximum: 120 },
  ]);
  expect(verifications).toBe(1);
  expect(classifications).toBe(1);
  const invalid = await app.handle(new Request('http://localhost/v1/discovery/concepts?q=topic', {
    headers: { authorization: 'Bearer invalid' },
  }));
  expect(invalid.status).toBe(401);
  expect(seen).toHaveLength(3);
  expect(classifications).toBe(1);
});

test('G-970: recent commands charge the verified principal write budget before an owner effect', async () => {
  const budgets = rateLimitBudgets();
  const commands = [
    ['POST', '/v1/realms/realm/join-requests'],
    ['POST', '/v1/realms/realm/join-requests/request/withdraw'],
    ['POST', '/v1/realms/realm/join-requests/request/decisions'],
    ['POST', '/v1/follows'], ['POST', '/v1/me/follows/batch'],
    ['POST', '/v1/me/membership-consents'], ['POST', '/v1/addresses/renames'],
    ['POST', '/v1/spaces'], ['PUT', '/v1/spaces/space/settings'],
    ['POST', '/v1/discovery/generation-builds'],
  ] as const;
  for (const principalClass of ['anonymous', 'new-account', 'member', 'trusted', 'service'] as const) {
    let verifications = 0, classifications = 0, effects = 0;
    const seen: { identity: string; family: string; maximum: number }[] = [];
    const app = new Elysia().use(rateLimitHook({ async verify() {
      verifications++;
      return { issuer: 'account', subject: 'caller', accountExpiresAt: Date.now() / 1000 + 300 };
    } }, {
      options, budgets, store: {
        async classify(): Promise<PrincipalClass> { classifications++; return principalClass; },
        async consume(identity, family, budget) {
          seen.push({ identity, family, maximum: budget.maximum });
          return { allowed: false, retryAfter: 19 };
        },
      },
    }));
    for (const [method, path] of commands) {
      const effect = () => { effects++; return 'effect'; };
      if (method === 'POST') app.post(path, effect);
      else app.put(path, effect);
    }
    for (const [method, path] of commands) {
      const response = await app.handle(new Request(`http://localhost${path}`, {
        method, headers: principalClass === 'anonymous' ? {} : { authorization: 'Bearer caller' },
      }));
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('19');
    }
    expect(seen).toEqual(commands.map(() => ({
      identity: principalClass === 'anonymous' ? 'anonymous:unknown' : JSON.stringify(['account', 'caller']),
      family: 'write', maximum: budgets[principalClass].write.maximum,
    })));
    expect(effects).toBe(0);
    expect(verifications).toBe(principalClass === 'anonymous' ? 0 : 1);
    expect(classifications).toBe(principalClass === 'anonymous' ? 0 : 1);
  }
});
