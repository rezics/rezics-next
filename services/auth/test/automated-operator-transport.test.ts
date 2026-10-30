import { expect, test } from 'bun:test';
import { AUTH_MANAGEMENT_CLIENT_ID, type SessionProof } from '@rezics/auth-contract';
import type { AuthService } from '../src/index.ts';
import { automatedOperatorTransport, type AutomatedCreationOperator } from '../src/automated-operator-transport.ts';
const operatorAccountId = '00000000-0000-4000-8000-000000000001';
const foreignId = '00000000-0000-4000-8000-000000000002';
const issuer = 'https://operator.auth.test';
const human: SessionProof = {
  account_id: foreignId,
  client_id: AUTH_MANAGEMENT_CLIENT_ID,
  scope: ['account:manage'],
  authn_epoch: 1,
  auth_time: 1,
  amr: ['pwd'],
};
const label = { id: operatorAccountId, kind: 'organization', handle: null, displayName: 'Operator' };
function fixture(proof = human, result: unknown = label) {
  const calls: unknown[] = [];
  const service = {
    verifier: { issuer },
    internal: { withFreshHuman: async (_: unknown, work: (human: SessionProof) => Promise<unknown>) => work(proof) },
  } as unknown as AuthService;
  const access = {
    async readAutomatedCreationOperator(input: unknown) {
      calls.push(input);
      return result as AutomatedCreationOperator | null;
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
  expect(await response.json()).toEqual(label);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ human, operatorAccountId });
  expect(Object.keys(f.calls[0] as object).sort()).toEqual(['deadline', 'human', 'operatorAccountId']);
  expect(await (await fixture(human, null).handler(request())).json()).toBeNull();
  expect(await (await fixture(human, { ...label, kind: 'actor' }).handler(request())).json()).toEqual({
    ...label,
    kind: 'actor',
  });
});
test('selected operator refuses identity substitution, browser bearers, wrong profiles and missing or unclosed sources', async () => {
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
  for (const proof of [
    { ...human, client_id: 'login' },
    { ...human, scope: ['account:manage', 'account:read'] },
    { ...human, scope: [] },
    { ...human, amr: ['operator'] },
  ])
    expect((await fixture(proof).handler(request())).status).toBe(403);
  for (const result of [
    undefined,
    { ...label, id: foreignId },
    { ...label, email: 'private' },
    { id: operatorAccountId, kind: 'actor' },
    { ...label, members: [] },
  ]) {
    const bad = result === undefined ? {} : result;
    expect((await fixture(human, bad).handler(request())).status).toBe(503);
  }
  expect((await automatedOperatorTransport(f.service, async () => new Response(), undefined)(request())).status).toBe(
    503,
  );
});
