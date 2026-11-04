import { expect, test } from 'bun:test';
import { managementOperationProfile, type SessionProof } from '@rezics/auth-contract';
import type { AuthService } from '../src/index.ts';
import {
  operatorTransferPageTransport,
  OPERATOR_TRANSFER_PAGE_PATH,
  type OperatorTransferPageAccess,
  type OperatorTransferPageRead,
} from '../src/operator-transfer-page.ts';

const issuer = 'https://transfer.auth.test';
const subject = '00000000-0000-8000-8000-000000000001';
const source = '00000000-0000-8000-8000-000000000002';
const destination = '00000000-0000-8000-8000-000000000003';
const reservation = '00000000-0000-8000-8000-000000000004';
const relation = {
  previous: { subjectAccountId: subject, operatorAccountId: source, reservationId: reservation },
  expectedVersion: '7',
};
const transfer = managementOperationProfile('transfer');
const profile = (client_id = transfer.client_id, scope = [...transfer.scope]): SessionProof => ({
  account_id: source,
  client_id,
  scope,
  authn_epoch: 1,
  auth_time: 1,
  amr: ['pwd'],
});

function fixture(
  proof = profile(),
  result: OperatorTransferPageRead = { kind: 'source', relation, action: 'allowed' },
  withAccess = true,
) {
  const calls: unknown[] = [];
  let tokenCalls = 0;
  const service = {
    verifier: { issuer },
    internal: {
      withFreshHuman: async (_: unknown, work: (proof: SessionProof) => Promise<unknown>) => work(proof),
      accessTokenForProof: async () => {
        tokenCalls++;
        return 'server-native-token';
      },
    },
  } as unknown as AuthService;
  const access: OperatorTransferPageAccess | undefined = withAccess
    ? {
        async readOperatorTransferPage(...args) {
          calls.push(args);
          return result;
        },
      }
    : undefined;
  const fallback = async () => new Response('fallback', { status: 418 });
  return {
    calls,
    get tokenCalls() {
      return tokenCalls;
    },
    handler: operatorTransferPageTransport(service, fallback, access),
  };
}
function request(body: unknown, headers: Record<string, string> = {}, query = '') {
  return new Request(`${issuer}${OPERATOR_TRANSFER_PAGE_PATH}${query}`, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
const handoff = {
  version: 1,
  previous: relation.previous,
  expectedVersion: relation.expectedVersion,
  operatorAccountId: destination,
  sourceOperationKey: 'source-operation-key',
};

test('the page transport keeps readiness safe and exposes only the selected closed native review', async () => {
  const ordinary = fixture(profile('login', []));
  const readiness = await ordinary.handler(request({ kind: 'readiness' }));
  expect(await readiness.json()).toEqual({
    viewer: { kind: 'authentication-required', continuation: 'operator-transfer' },
    review: { kind: 'unavailable' },
  });
  const privateAttempt = await ordinary.handler(request({ kind: 'source', subjectAccountId: subject }));
  const privateBody = await privateAttempt.json();
  expect(privateBody).toMatchObject({ viewer: { kind: 'authentication-required' } });
  expect(JSON.stringify(privateBody)).not.toContain('reservationId');
  expect(ordinary.calls).toHaveLength(0);
  expect(ordinary.tokenCalls).toBe(0);

  const admitted = fixture();
  const sourcePage = await admitted.handler(request({ kind: 'source', subjectAccountId: subject }));
  expect(sourcePage.headers.get('cache-control')).toBe('private, no-store');
  expect(await sourcePage.json()).toEqual({
    viewer: { kind: 'ready' },
    review: { kind: 'source', relation, action: 'allowed' },
  });
  expect(admitted.calls[0]).toEqual([
    'server-native-token',
    { kind: 'source', subjectAccountId: subject },
    expect.anything(),
  ]);
  expect(admitted.tokenCalls).toBe(2);

  const destinationPage = fixture(profile(), {
    kind: 'destination',
    destinationAccountId: destination,
    action: 'allowed',
  });
  const response = await destinationPage.handler(request({ kind: 'destination', request: handoff }));
  expect(await response.json()).toEqual({
    viewer: { kind: 'ready' },
    review: { kind: 'destination', destinationAccountId: destination, action: 'allowed' },
  });
  expect(destinationPage.calls[0]).toEqual([
    'server-native-token',
    { kind: 'destination', request: handoff },
    expect.anything(),
  ]);
});

test('closed transport rejects forged selection and reports absent bindings without exposing private data', async () => {
  const f = fixture();
  for (const body of [
    { kind: 'readiness', subjectAccountId: subject },
    { kind: 'source', subjectAccountId: subject, accountId: destination },
    { kind: 'destination', request: { ...handoff, actorAccountId: destination } },
    { kind: 'destination', request: { ...handoff, previous: { ...handoff.previous, operatorAccountId: 'bad' } } },
  ])
    expect((await f.handler(request(body))).status).toBe(400);
  for (const headers of [
    { origin: 'https://foreign.test' },
    { 'sec-fetch-site': 'cross-site' },
    { authorization: 'Bearer browser-token' },
    { 'content-type': 'text/plain' },
  ])
    expect((await f.handler(request({ kind: 'readiness' }, headers))).status).toBe(400);
  expect((await f.handler(request({ kind: 'readiness' }, {}, '?accountId=forged'))).status).toBe(400);
  expect(f.calls).toHaveLength(0);

  const missing = fixture(profile(), { kind: 'unavailable' }, false);
  expect(await (await missing.handler(request({ kind: 'source', subjectAccountId: subject }))).json()).toEqual({
    viewer: { kind: 'ready' },
    review: { kind: 'unavailable' },
  });
  expect(await (await missing.handler(new Request(`${issuer}/unrelated`))).text()).toBe('fallback');
});
