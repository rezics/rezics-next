import { afterEach, expect, test } from 'bun:test';
import {
  parseTransferRequest,
  refreshTransferAdvice,
  readOperatorTransferPage,
  type TransferAttempt,
} from '../src/operator-transfer';
import { OPERATOR_TRANSFER_PAGE_PATH } from '../src/operator-transfer-page';

const actor = 'human-account';
const request = {
  version: 1 as const,
  previous: { subjectAccountId: 'subject', operatorAccountId: 'source', reservationId: 'reservation' },
  expectedVersion: '12',
  operatorAccountId: 'destination',
  sourceOperationKey: 'original-key',
};
const attempt: TransferAttempt = { accountId: actor, request, side: 'destination', phase: 'approve' };
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('imported transfer data cannot select the acting account', () => {
  expect(parseTransferRequest(JSON.stringify(request))).toEqual(request);
  expect(parseTransferRequest(JSON.stringify({ ...request, accountId: 'attacker' }))).toBeNull();
  expect(parseTransferRequest(JSON.stringify({ ...request, actorAccountId: 'attacker' }))).toBeNull();
});

test('destination advice is a read of the selected destination and never a command preflight', async () => {
  const calls: { path: string; body?: unknown }[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path === '/session')
      return Response.json({ account_id: actor, client_id: 'auth-management', scope: ['account:manage'] });
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    return Response.json({
      viewer: { kind: 'ready' },
      review: { kind: 'destination', destinationAccountId: request.operatorAccountId, action: 'allowed' },
    });
  }) as typeof fetch;

  expect(await refreshTransferAdvice(attempt)).toBeNull();
  expect(calls).toEqual([
    {
      path: OPERATOR_TRANSFER_PAGE_PATH,
      body: { kind: 'destination', request },
    },
  ]);
  expect(calls.some(({ path }) => path.includes('approve') || path.includes('execute'))).toBe(false);
});

test('unknown response fields fail closed and authentication continuation stays explicit', async () => {
  globalThis.fetch = (async () =>
    Response.json({ viewer: { kind: 'ready', accountId: actor }, review: { kind: 'readiness' } })) as typeof fetch;
  expect(await readOperatorTransferPage({ kind: 'readiness' })).toEqual({ kind: 'failure', reason: 'unavailable' });

  globalThis.fetch = (async () =>
    Response.json({
      viewer: { kind: 'authentication-required', continuation: 'operator-transfer' },
      review: { kind: 'unavailable' },
    })) as typeof fetch;
  expect(await readOperatorTransferPage({ kind: 'readiness' })).toMatchObject({
    viewer: { kind: 'authentication-required', continuation: 'operator-transfer' },
  });
});
