import { afterEach, expect, test } from 'bun:test';
import {
  OPERATOR_MANAGEMENT_PROFILE,
  OPERATOR_RELATION_PATH,
  parseTransferRequest,
  prepareTransfer,
  reauthenticateTransfer,
  submitTransferAttempt,
  type TransferAttempt,
  type TransferRequest,
} from '../src/operator-transfer';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const request: TransferRequest = {
  version: 1,
  previous: {
    operatorAccountId: 'source-operator',
    subjectAccountId: 'operated-account',
    reservationId: 'source-reservation',
  },
  expectedVersion: '12',
  operatorAccountId: 'destination-operator',
  sourceOperationKey: 'source-key',
};
const destination = (): TransferAttempt => ({
  accountId: 'destination-human',
  request: structuredClone(request),
  side: 'destination',
  phase: 'approve',
});
const source = (): TransferAttempt => ({
  accountId: 'source-human',
  request: structuredClone(request),
  side: 'source',
  acceptance: 'opaque-native-acceptance',
  phase: 'approve',
});

// Page protocol evidence only. Native authority/DBOS and mounted production
// transport remain the original acceptance debt; these fixtures do not prove it.
test('Complete native destination acceptance and operator transfer journey preserves exact native authority current-account binding explicit confirmation and unavailable states', async () => {
  let person = 'destination-human';
  let changed = false;
  const calls: { path: string; body: any }[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    expect(init?.credentials).toBe('same-origin');
    expect(init?.cache).toBe('no-store');
    if (path === '/session')
      return Response.json({
        account_id: person,
        client_id: OPERATOR_MANAGEMENT_PROFILE.client_id,
        scope: ['account:manage'],
      });
    const body = JSON.parse(String(init?.body));
    calls.push({ path, body });
    if (path === OPERATOR_RELATION_PATH)
      return Response.json(
        changed
          ? {
              previous: {
                operatorAccountId: request.operatorAccountId,
                subjectAccountId: request.previous.subjectAccountId,
                reservationId: 'new-reservation',
              },
              expectedVersion: '13',
            }
          : { previous: request.previous, expectedVersion: request.expectedVersion },
      );
    if (path === '/account-operations/approve')
      return Response.json({
        reference: person === 'destination-human' ? 'opaque-native-acceptance' : 'source-approval',
        expiresAt: '2030-01-01T00:00:00Z',
      });
    if (path === '/account-operations/execute') {
      changed = true;
      return Response.json({ accountId: request.previous.subjectAccountId });
    }
    throw new Error(`Unexpected path ${path}`);
  }) as typeof fetch;
  const accept = destination();
  expect(await submitTransferAttempt(accept, () => true)).toEqual({
    kind: 'accepted',
    reference: 'opaque-native-acceptance',
  });
  expect(calls.some((call) => call.path.endsWith('/execute'))).toBe(false);
  expect(calls.find((call) => call.path.endsWith('/approve'))?.body).toEqual({
    operationKey: request.sourceOperationKey,
    operation: {
      kind: 'transfer-acceptance',
      previous: request.previous,
      expectedVersion: '12',
      operatorAccountId: request.operatorAccountId,
      sourceOperationKey: request.sourceOperationKey,
    },
  });
  person = 'source-human';
  const transfer = source();
  expect((await submitTransferAttempt(transfer, () => true)).kind).toBe('current');
  expect(calls.find((call) => call.path.endsWith('/execute'))?.body).toEqual({
    operationKey: request.sourceOperationKey,
    reference: 'source-approval',
    operation: {
      kind: 'transfer',
      previous: request.previous,
      expectedVersion: '12',
      operatorAccountId: request.operatorAccountId,
      acceptance: 'opaque-native-acceptance',
    },
  });
  expect(transfer.phase).toBe('readback');
  const count = calls.length;
  expect(await submitTransferAttempt(accept, () => true)).toEqual({ kind: 'failure', reason: 'account-changed' });
  expect(calls).toHaveLength(count);
});

test('lost execution response retains the exact key operation and approval; retry never approves again and acknowledgement needs readback', async () => {
  let approves = 0;
  const executions: unknown[] = [];
  const attempt = source();
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path === '/session')
      return Response.json({
        account_id: attempt.accountId,
        client_id: OPERATOR_MANAGEMENT_PROFILE.client_id,
        scope: ['account:manage'],
      });
    if (path === OPERATOR_RELATION_PATH) return Response.json({ previous: request.previous, expectedVersion: '12' });
    if (path.endsWith('/approve')) {
      approves++;
      return Response.json({ reference: 'saved-reference', expiresAt: '2030-01-01T00:00:00Z' });
    }
    executions.push(JSON.parse(String(init?.body)));
    if (executions.length === 1) throw new TypeError('lost response');
    return Response.json({ accountId: request.previous.subjectAccountId });
  }) as typeof fetch;
  expect(await submitTransferAttempt(attempt, () => true)).toMatchObject({ kind: 'failure', reason: 'uncertain' });
  expect(attempt).toMatchObject({ reference: 'saved-reference', phase: 'execute' });
  expect(await submitTransferAttempt(attempt, () => true)).toEqual({ kind: 'failure', reason: 'uncertain' });
  expect(approves).toBe(1);
  expect(executions[1]).toEqual(executions[0]);
});

test('stale step-up retains the account tuple key and opaque reference and requires another submit', async () => {
  const attempt = source();
  let fresh = false;
  let approvals = 0;
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (path === '/session')
      return Response.json({
        account_id: attempt.accountId,
        client_id: OPERATOR_MANAGEMENT_PROFILE.client_id,
        scope: ['account:manage'],
      });
    if (path === OPERATOR_RELATION_PATH) return Response.json({ previous: request.previous, expectedVersion: '12' });
    if (path === '/signin') {
      expect(JSON.parse(String(init?.body))).toEqual({
        email: 'human@example.test',
        password: 'secret',
        ...OPERATOR_MANAGEMENT_PROFILE,
      });
      fresh = true;
      return Response.json({});
    }
    approvals++;
    return fresh
      ? Response.json({ reference: 'ref', expiresAt: '2030-01-01T00:00:00Z' })
      : Response.json({ error: 'step_up_required' }, { status: 401 });
  }) as typeof fetch;
  const original = structuredClone(attempt);
  expect(await submitTransferAttempt(attempt, () => true)).toMatchObject({ reason: 'step-up' });
  expect(attempt).toEqual(original);
  expect(await reauthenticateTransfer(attempt.accountId, 'human@example.test', 'secret')).toBeNull();
  expect(approvals).toBe(1);
  expect(attempt).toEqual(original);
});

test('missing version unavailable reader and stale native conflict never create guessed authority', async () => {
  const attempt = source();
  let response = Response.json({ previous: request.previous });
  let mutations = 0;
  globalThis.fetch = (async (input) => {
    if (String(input) === '/session')
      return Response.json({
        account_id: attempt.accountId,
        client_id: OPERATOR_MANAGEMENT_PROFILE.client_id,
        scope: ['account:manage'],
      });
    if (String(input) === OPERATOR_RELATION_PATH) return response.clone();
    mutations++;
    return Response.json({ error: 'account_operation_denied' }, { status: 409 });
  }) as typeof fetch;
  expect(
    await prepareTransfer(request.previous.subjectAccountId, request.operatorAccountId, attempt.accountId),
  ).toEqual({ kind: 'failure', reason: 'unavailable' });
  response = new Response(null, { status: 404 });
  expect(await submitTransferAttempt(attempt, () => true)).toMatchObject({ reason: 'unavailable' });
  expect(mutations).toBe(0);
  response = Response.json({ previous: request.previous, expectedVersion: '13' });
  expect(await submitTransferAttempt(attempt, () => true)).toEqual({ kind: 'failure', reason: 'conflict' });
  expect(mutations).toBe(0);
  response = Response.json({ previous: request.previous, expectedVersion: '12' });
  expect(await submitTransferAttempt(attempt, () => true)).toEqual({
    kind: 'failure',
    reason: 'conflict',
    status: 409,
    code: 'account_operation_denied',
  });
  expect(parseTransferRequest(JSON.stringify({ ...request, authorization: 'fake' }))).toBeNull();
  expect(parseTransferRequest(JSON.stringify({ ...request, returnTo: 'https://elsewhere.test' }))).toBeNull();
  expect(
    parseTransferRequest(JSON.stringify({ ...request, previous: { ...request.previous, actor: 'fake' } })),
  ).toBeNull();
});
