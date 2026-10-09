import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { AccountAssertionDenied, AccountAssertionInsufficientScope, verifyRequestAccount,
  type VerifiedAccountAssertion } from '../src/modules/account/verify-assertion.ts';
import { rateLimitBudgets } from '../src/modules/rate-limit/budgets.ts';
import { rateLimitHook } from '../src/modules/rate-limit/hook.ts';
import { queryRoutes } from '../src/routes/query.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const workId = 'https://rezics.com/id/00000000-0000-4000-8000-000000000009';
const generation = 'urn:rezics:text-index-generation:00000000-0000-4000-8000-0000000000aa';
const lit = (value: string) => ({ type: 'literal' as const, value });
const uri = (value: string) => ({ type: 'uri' as const, value });

function granted(scopes: readonly string[]): VerifiedAccountAssertion {
  return { issuer: 'https://account.test', subject: 'reader', accountScopes: scopes, contentEvidence: {
    age: 'adult', country: 'US', accountEligible: true, adultAvailable: true,
    categories: { general: true, r15: true, r18: false, r18g: false } } };
}

function appFor(verify: MainWorkDependencies['account']['verify']) {
  const fuseki = {
    async commandHealth() {
      return { moduleVersion: 'test', instanceId: '00000000-0000-4000-8000-0000000000bb',
        publicSearchWriteEpoch: '2', publicSearchWriteActive: false, publicSearchDeltaAvailable: true, profiles: {} };
    },
    async searchDeltaSince() {
      return { available: true, ordinal: '1', dataEpoch: 'epoch', sequence: '1', generation,
        writeEpoch: '2', luceneGeneration: '1', qualifiedPopulation: '1', deltas: [] };
    },
    async query(body: string) {
      if (body.includes('rv:rankedText')) return { results: { bindings: [{ page: lit(JSON.stringify({
        hits: [{ id: `urn:rezics:search:name:${workId.slice(-36)}`, key: `urn:rezics:search:name:${workId.slice(-36)}`,
          score: '1', document: 1 }], more: false, commit: '1' })) }] } };
      if (body.includes('SELECT DISTINCT ?r')) return { results: { bindings: [{
        r: uri(workId), kind: lit('work'), summary: uri(workId),
        resourceType: uri('https://schema.org/CreativeWork'), workHead: uri(workId) }] } };
      if (body.includes('?epoch') && body.includes('?sequence')) {
        const row: Record<string, { type: string; value: string }> = { epoch: lit('epoch'), sequence: lit('1') };
        if (body.includes('?generation')) row.generation = uri(generation);
        if (body.includes('?population')) row.population = lit('1');
        return { results: { bindings: [row] } };
      }
      return { results: { bindings: [] } };
    },
  };
  const work = {
    environment: { fuseki, lineage: { dataEpoch: 'epoch', routingEpoch: '0' } },
    account: { verify },
    access: { assertRecoveryOpen: async () => undefined },
    discovery: {
      async active() { return { generation_id: '00000000-0000-4000-8000-000000000077', stale: false }; },
      async resourcePage() { return []; },
      async resourceMembership(_active: unknown, ids: string[]) { return new Set(ids); },
      async conceptCounts() { return []; },
      async resourceCardPayloads() { return new Map(); },
    },
  } as unknown as MainWorkDependencies;
  return new Elysia().use(rateLimitHook(work.account, {
    options: { secret: 'account-verify-once-secret-32-characters', serviceClientIds: new Set(),
      trustedProxyPeers: new Set(), clientIpHeader: 'x-forwarded-for' },
    budgets: rateLimitBudgets(),
    store: { async classify() { return 'member' as const; }, async consume() { return { allowed: true, retryAfter: 0 }; } },
  })).use(queryRoutes(fuseki as never, work));
}

const query = (limit: number, token = 'reader') => new Request('http://main.local/v1/query', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'accept-language': 'en' },
  body: JSON.stringify({ profile: 'resource-list-v1', context: 'global', scope: { kind: 'all' },
    sort: 'relevance', q: 'Catalogue', limit,
    filter: { all: [{ facet: 'type', any: ['https://schema.org/CreativeWork'] }] } }),
});

test('a signed resource page verifies the bearer once at page sizes 1, 16 and 64', async () => {
  let verifications = 0;
  const app = appFor(async () => { verifications++; return granted(['work:read']); });
  for (const limit of [1, 16, 64]) {
    const before = verifications;
    const response = await app.handle(query(limit));
    expect(response.status).toBe(200);
    expect(verifications - before).toBe(1);
  }
  const anonymous = await app.handle(new Request('http://main.local/v1/query', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'resource-list-v1', context: 'global', scope: { kind: 'all' },
      sort: 'relevance', q: 'Catalogue', limit: 16,
      filter: { all: [{ facet: 'type', any: ['https://schema.org/CreativeWork'] }] } }),
  }));
  expect(anonymous.status).toBe(200);
  expect(verifications).toBe(3);
});

test('the next request verifies again, so a revoked bearer is refused', async () => {
  let verifications = 0;
  let active = true;
  const app = appFor(async () => {
    verifications++;
    if (!active) throw new AccountAssertionDenied('revoked');
    return granted(['work:read']);
  });
  expect((await app.handle(query(1))).status).toBe(200);
  active = false;
  const revoked = await app.handle(query(1, 'reader'));
  expect(revoked.status).toBe(401);
  expect(verifications).toBe(2);
});

test('the rate-limit grant covers one attempt; a retry verifies again', async () => {
  let verifications = 0;
  const account = { verify: async () => { verifications++; return granted(['work:read']); } };
  const request = new Request('http://main.local/v1/works', { headers: { authorization: 'Bearer reader' } });
  await verifyRequestAccount(account, request, []);
  await verifyRequestAccount(account, request, ['work:read']);
  expect(verifications).toBe(1);
  await verifyRequestAccount(account, request, ['work:read']);
  expect(verifications).toBe(2);

  const direct = new Request('http://main.local/v1/works?retry=1', { headers: { authorization: 'Bearer reader' } });
  await verifyRequestAccount(account, direct, ['work:read']);
  expect(verifications).toBe(3);
  await verifyRequestAccount(account, direct, ['work:read']);
  expect(verifications).toBe(4);
});

test('a grant that omits work:read is refused from the admission already made', async () => {
  let verifications = 0;
  const app = appFor(async () => { verifications++; return granted([]); });
  const response = await app.handle(query(16, 'narrow'));
  expect(response.status).toBe(401);
  expect(verifications).toBe(1);
});

test('a verifier that publishes no grant is still asked for each distinct scope', async () => {
  const seen: string[][] = [];
  const request = new Request('http://main.local/v1/query', { headers: { authorization: 'Bearer reader' } });
  const account = { verify: async (_request: Request, scopes: readonly string[]) => {
    seen.push([...scopes]);
    if (scopes.includes('realm:adopt')) throw new AccountAssertionDenied('scope not consented');
    return { issuer: 'https://account.test', subject: 'reader' };
  } };
  await verifyRequestAccount(account, request, ['governance:decide']);
  await expect(verifyRequestAccount(account, request, ['realm:adopt'])).rejects.toBeInstanceOf(AccountAssertionDenied);
  expect(seen).toEqual([['governance:decide'], ['realm:adopt']]);
});

test('a published grant refuses a missing scope without asking Account again', async () => {
  let verifications = 0;
  const request = new Request('http://main.local/v1/query', { headers: { authorization: 'Bearer reader' } });
  const account = { verify: async () => { verifications++; return granted(['governance:decide']); } };
  await verifyRequestAccount(account, request, []);
  await expect(verifyRequestAccount(account, request, ['realm:adopt'])).rejects.toBeInstanceOf(AccountAssertionInsufficientScope);
  await verifyRequestAccount(account, request, ['governance:decide']);
  expect(verifications).toBe(1);
});
