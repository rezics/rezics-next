import { expect, test } from 'bun:test';
import { AUTH_MANAGEMENT_CLIENT_ID, type SessionProof } from '@rezics/auth-contract';
import type { AuthService } from '../src/index.ts';
import { automatedOperatorTransport, type AutomatedCreationPage } from '../src/automated-operator-transport.ts';
const operatorAccountId = '00000000-0000-4000-8000-000000000001';
const foreignId = '00000000-0000-4000-8000-000000000002';
const issuer = 'https://operator.auth.test';
const human: SessionProof = {
  account_id: foreignId,
  client_id: AUTH_MANAGEMENT_CLIENT_ID,
  scope: ['account:manage'],
  authn_epoch: 1,
  auth_time: Math.floor(Date.now() / 1000),
  amr: ['pwd'],
};
const label = { id: operatorAccountId, kind: 'organization', handle: null, displayName: 'Operator' };
const rules = { minLength: 3, maxLength: 64, normalization: 'lowercase', pattern: '[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]' };
const page = (operator: unknown = label, readiness = 'review', action = 'confirm') => ({
  viewer: { accountId: human.account_id },
  readiness,
  operator,
  handleRules: rules,
  action,
});
function fixture(proof = human, result: unknown = page()) {
  const calls: unknown[] = [];
  const service = {
    verifier: { issuer },
    internal: {
      withFreshHuman: async (_: unknown, work: (human: SessionProof) => Promise<unknown>) => work(proof),
      accessTokenForProof: async () => 'native-token',
    },
  } as unknown as AuthService;
  const access = {
    async readAutomatedCreationPage(input: unknown) {
      calls.push(input);
      return result as AutomatedCreationPage;
    },
  };
  return {
    calls,
    service,
    handler: automatedOperatorTransport(service, async () => new Response(null, { status: 404 }), access),
  };
}
function request(body: unknown = { operatorAccountId }, headers = {}, query = '') {
  return new Request(`${issuer}/account-management/automated/operator${query}`, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
test('selected operator forwards only the native selection and real exact management proof with closed no-store labels', async () => {
  const f = fixture();
  const response = await f.handler(request());
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual(page());
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ human, operatorAccountId });
  expect(Object.keys(f.calls[0] as object).sort()).toEqual(['deadline', 'human', 'operatorAccountId']);
  expect(await (await fixture(human, page(null, 'refused', 'none')).handler(request())).json()).toEqual(
    page(null, 'refused', 'none'),
  );
  expect(await (await fixture(human, page({ ...label, kind: 'actor' })).handler(request())).json()).toEqual(
    page({ ...label, kind: 'actor' }),
  );
});
test('selected operator refuses identity substitution, browser bearers, operated callers and missing or unclosed sources', async () => {
  const f = fixture();
  for (const body of [
    { operatorAccountId, accountId: foreignId },
    { operatorAccountId, human },
    { operatorAccountId, scopes: ['account:read'] },
    {},
    { operatorAccountId: 'invalid' },
  ])
    expect((await f.handler(request(body))).status).toBe(400);
  for (const headers of [
    { origin: 'https://foreign.test' },
    { 'sec-fetch-site': 'cross-site' },
    { authorization: 'Bearer browser' },
    { 'content-type': 'text/plain' },
  ])
    expect((await f.handler(request({ operatorAccountId }, headers))).status).toBe(400);
  expect((await f.handler(request({ operatorAccountId }, {}, '?operatorAccountId=foreign'))).status).toBe(400);
  expect(f.calls).toHaveLength(0);
  expect((await fixture({ ...human, amr: ['operator'] }).handler(request())).status).toBe(403);
  for (const result of [
    undefined,
    { ...label, id: foreignId },
    { ...label, email: 'private' },
    { id: operatorAccountId, kind: 'actor' },
    { ...label, members: [] },
  ]) {
    const bad = result === undefined ? {} : page(result);
    expect((await fixture(human, bad).handler(request())).status).toBe(503);
  }
  expect((await automatedOperatorTransport(f.service, async () => new Response(), undefined)(request())).status).toBe(
    503,
  );
});

test('ordinary sessions receive only the native safe authentication advice and dependencies stay unavailable', async () => {
  const ordinary = { ...human, client_id: 'login', scope: [] };
  const safe = page(null, 'authentication-needed', 'authenticate');
  const f = fixture(ordinary, safe);
  expect(await (await f.handler(request())).json()).toEqual(safe);
  expect(f.calls).toHaveLength(1);
  for (const leaked of [
    page(),
    page(label, 'authentication-needed', 'authenticate'),
    { ...safe, viewer: { accountId: operatorAccountId } },
    { ...safe, action: 'confirm' },
  ])
    expect((await fixture(ordinary, leaked).handler(request())).status).toBe(503);
  const broken = fixture();
  broken.service.internal.accessTokenForProof = async () => {
    throw new Error('dependency unavailable');
  };
  expect((await broken.handler(request())).status).toBe(503);
  const select = page(null, 'select-operator', 'select-operator');
  expect(await (await fixture(human, select).handler(request({ operatorAccountId: null }))).json()).toEqual(select);
});
