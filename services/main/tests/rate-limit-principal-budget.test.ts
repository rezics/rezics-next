import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import type { Pool } from 'pg';
import { AccountAssertionDenied, type VerifiedAccountAssertion } from '../src/modules/account/verify-assertion.ts';
import { rateLimitBudgets, type PrincipalClass } from '../src/modules/rate-limit/budgets.ts';
import { rateLimitHook } from '../src/modules/rate-limit/hook.ts';
import { PostgresRateLimitStore, RATE_LIMIT_COST_V1, type RateLimitOptions } from '../src/modules/rate-limit/store.ts';

const options: RateLimitOptions = {
  secret: 'principal-budget-fixture-secret-at-least-32',
  serviceClientIds: new Set(['installed-importer']),
  trustedProxyPeers: new Set(),
  clientIpHeader: 'x-forwarded-for',
};

const person: VerifiedAccountAssertion = {
  issuer: 'https://account.test', subject: 'reader', accountClientId: 'installed-importer', accountAuthMode: 'consent',
};

interface ClassificationRow {
  found: boolean;
  active: boolean;
  newcomer: boolean;
  platform_administrator: boolean;
  agent_count: number;
  max_role_rows: number;
  trusted: boolean;
}

const memberRow: ClassificationRow = {
  found: true, active: true, newcomer: false, platform_administrator: false,
  agent_count: 0, max_role_rows: 0, trusted: false,
};

function scriptedPool(row: ClassificationRow | null, empty = false) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return { rows: empty || row === null ? [] : [row] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

test('verified search pays the caller class, including topic lookup, and classifies a token once', async () => {
  const budgets = rateLimitBudgets();
  for (const principalClass of ['anonymous', 'new-account', 'member', 'trusted', 'service'] as const) {
    const seen: { identity: string; family: string; maximum: number }[] = [];
    const app = new Elysia().use(rateLimitHook({ async verify() {
      return { issuer: 'account', subject: 'caller', accountExpiresAt: Date.now() / 1000 + 300 };
    } }, {
      options, budgets, store: {
        async classify(): Promise<PrincipalClass> { return principalClass; },
        async consume(identity, family, budget) {
          seen.push({ identity, family, maximum: budget.maximum });
          return { allowed: false, retryAfter: 9 };
        },
      },
    })).post('/v1/query', () => 'results');
    const response = await app.handle(new Request('http://localhost/v1/query', {
      method: 'POST', headers: principalClass === 'anonymous' ? {} : { authorization: 'Bearer caller' },
    }));
    expect(response.status).toBe(429);
    expect(seen).toEqual([{
      identity: principalClass === 'anonymous' ? 'anonymous:unknown' : JSON.stringify(['account', 'caller']),
      family: 'search', maximum: budgets[principalClass].search.maximum,
    }]);
  }

  const seen: { identity: string; family: string; maximum: number }[] = [];
  let verifications = 0, classifications = 0;
  const app = new Elysia().use(rateLimitHook({ async verify(request) {
    verifications++;
    if (request.headers.get('authorization') === 'Bearer invalid') throw new AccountAssertionDenied();
    return { issuer: 'account', subject: 'reader', accountExpiresAt: Date.now() / 1000 + 300 };
  } }, {
    options, budgets, store: {
      async classify(): Promise<PrincipalClass> { classifications++; return 'member'; },
      async consume(identity, family, budget) {
        seen.push({ identity, family, maximum: budget.maximum });
        return { allowed: true, retryAfter: 60 };
      },
    },
  })).post('/v1/query', () => 'results').get('/v1/discovery/concepts', () => 'topics');
  expect((await app.handle(new Request('http://localhost/v1/query', {
    method: 'POST', headers: { authorization: 'Bearer reader' },
  }))).status).toBe(200);
  expect((await app.handle(new Request('http://localhost/v1/discovery/concepts?q=topic', {
    headers: { authorization: 'Bearer reader' },
  }))).status).toBe(200);
  expect(verifications).toBe(1);
  expect(classifications).toBe(1);
  expect(seen).toEqual([
    { identity: JSON.stringify(['account', 'reader']), family: 'search', maximum: 120 },
    { identity: JSON.stringify(['account', 'reader']), family: 'search', maximum: 120 },
  ]);
  expect((await app.handle(new Request('http://localhost/v1/query', {
    method: 'POST', headers: { authorization: 'Bearer invalid' },
  }))).status).toBe(401);
  expect(classifications).toBe(1);
  expect(seen).toHaveLength(2);
});

test('service is only an allowlisted workload whose subject is the client, in one lookup', async () => {
  expect(RATE_LIMIT_COST_V1.classificationQueries).toBe(1);
  const workload = scriptedPool(memberRow);
  const workloadStore = new PostgresRateLimitStore(workload.pool, options);
  expect(await workloadStore.classify({
    issuer: person.issuer, subject: 'installed-importer', accountClientId: 'installed-importer', accountAuthMode: 'workload',
  })).toBe('service');
  expect(workload.calls).toHaveLength(0);

  const member = scriptedPool(memberRow);
  const store = new PostgresRateLimitStore(member.pool, options);
  expect(await store.classify(person)).toBe('member');
  expect(member.calls).toHaveLength(1);
  expect(member.calls[0]!.params).toEqual([
    person.issuer, person.subject,
    RATE_LIMIT_COST_V1.representations + 1, RATE_LIMIT_COST_V1.roleRowsPerRepresentation + 1,
  ]);
  expect(member.calls[0]!.sql).toContain('account_issuer');
  expect(member.calls[0]!.sql).toContain('access.read_platform_permissions(p.id)');
  expect(member.calls[0]!.sql).toContain("permission.action = 'platform:use:platform-admin'");

  const sameSubject = scriptedPool(memberRow);
  expect(await new PostgresRateLimitStore(sameSubject.pool, options).classify({
    ...person, subject: 'installed-importer', accountAuthMode: 'consent',
  })).toBe('member');
  expect(sameSubject.calls).toHaveLength(1);

  const mismatched = scriptedPool(memberRow);
  expect(await new PostgresRateLimitStore(mismatched.pool, options).classify({
    ...person, accountAuthMode: 'workload',
  })).toBe('member');
  expect(mismatched.calls).toHaveLength(1);

  const spoofed = scriptedPool({ ...memberRow, found: false });
  expect(await new PostgresRateLimitStore(spoofed.pool, options).classify({
    issuer: person.issuer, subject: 'spoofed-importer', accountClientId: 'spoofed-importer', accountAuthMode: 'workload',
  })).toBe('new-account');
  expect(spoofed.calls).toHaveLength(1);

  const unavailable = scriptedPool(null, true);
  await expect(new PostgresRateLimitStore(unavailable.pool, options).classify(person))
    .rejects.toThrow('Rate limit classification unavailable');
  await expect(new PostgresRateLimitStore(scriptedPool({ ...memberRow, agent_count: 65 }).pool, options).classify(person))
    .rejects.toThrow('Rate limit representation budget exceeded');
  await expect(new PostgresRateLimitStore(scriptedPool({
    ...memberRow, agent_count: 65, trusted: true,
  }).pool, options).classify(person)).rejects.toThrow('Rate limit representation budget exceeded');
  await expect(new PostgresRateLimitStore(scriptedPool({
    ...memberRow, agent_count: 1, max_role_rows: 65, trusted: true,
  }).pool, options).classify(person)).rejects.toThrow('Rate limit role budget exceeded');
  expect(await new PostgresRateLimitStore(scriptedPool({
    ...memberRow, platform_administrator: true, agent_count: 65,
  }).pool, options).classify(person)).toBe('trusted');
  expect(await new PostgresRateLimitStore(scriptedPool({
    ...memberRow, active: false, platform_administrator: true,
  }).pool, options).classify(person)).toBe('new-account');
  expect(await new PostgresRateLimitStore(scriptedPool({ ...memberRow, found: false }).pool, options).classify(person))
    .toBe('new-account');
  expect(await new PostgresRateLimitStore(scriptedPool({
    ...memberRow, newcomer: true, trusted: true, agent_count: 1, max_role_rows: 1,
  }).pool, options).classify(person)).toBe('trusted');
  expect(await new PostgresRateLimitStore(scriptedPool({ ...memberRow, newcomer: true }).pool, options).classify(person))
    .toBe('new-account');
});
