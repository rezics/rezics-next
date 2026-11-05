import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { readAttempt, saveAttempt } from '../src/account-verification/attempt';
import {
  performOperation,
  readAccount,
  readPending,
  validOperation,
  type AgentVerificationRequest,
  type Operation,
} from '../src/account-verification/transport';
import {
  readVerification,
  requestVerification,
  withdrawVerification,
} from '../src/settings/verification-core';
import {
  canRequestVerification,
  canRetryVerification,
  canWithdrawVerification,
  VerificationRecovery,
  verificationWithdrawalObservation,
} from '../src/settings/verification-recovery';

const accountId = '0192f3a0-6c1e-7b2a-9d4e-000100000001';
const requestId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000200000001';
const request: AgentVerificationRequest = {
  id: requestId,
  accountId,
  accountKind: 'actor',
  requestedBy: accountId,
  catalogueSubjectId: subjectId,
  statement: 'Official domain challenge supplied for independent review.',
  links: [{ label: 'Official site', url: 'https://example.org' }],
  state: 'pending',
  reason: null,
  problem: null,
  decisionReceiptId: null,
  decidedBy: null,
  createdAt: '2026-10-30T08:00:00.000Z',
  updatedAt: '2026-10-30T08:00:00.000Z',
};

function clientFor(reply: (request: Request) => Promise<Response> | Response) {
  return createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => reply(new Request(input, init))) as typeof fetch,
  });
}

test('the bounded reviewer transport preserves the signed continuation and current bearer; a refusal reads no evidence summaries', async () => {
  const calls: Request[] = [];
  let denied = false;
  const client = clientFor((incoming) => {
    calls.push(incoming);
    const url = new URL(incoming.url);
    if (url.pathname === '/v1/verification-requests') {
      expect(url.searchParams.get('limit')).toBe('20');
      expect(url.searchParams.get('state')).toBe('pending');
      expect(url.searchParams.get('cursor')).toBe('signed/+cursor==');
      return denied
        ? Response.json({ code: 'forbidden' }, { status: 403 })
        : Response.json({ verificationRequests: [request], next: 'next/+signed==' });
    }
    if (url.pathname === '/v1/accounts')
      return Response.json({
        accounts: [{ id: accountId, displayName: 'Mira', handle: 'mira', state: 'active' }],
        next: null,
      });
    if (url.pathname === `/v1/subjects/${subjectId}`) return Response.json({ subject: { labels: { en: 'Mira' } } });
    throw new Error(`Unexpected read: ${url.pathname}`);
  });
  const page = await readPending(client, 'Bearer current-reviewer', 'signed/+cursor==');
  expect(page).toMatchObject({
    state: 'ready',
    value: { next: 'next/+signed==', requests: [{ request, account: { name: 'Mira' }, subject: { name: 'Mira' } }] },
  });
  expect(calls.every((call) => call.headers.get('authorization') === 'Bearer current-reviewer')).toBe(true);
  calls.length = 0;
  denied = true;
  expect(await readPending(client, 'Bearer revoked-reviewer', 'signed/+cursor==')).toEqual({ state: 'denied' });
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/v1/verification-requests']);
});

test('unavailable and unopened verification are distinct from an actually empty page', async () => {
  for (const [status, code, state] of [
    [503, 'partition_unavailable', 'unavailable'],
    [403, 'platform_closed', 'preparing'],
    [400, 'invalid_cursor', 'invalid'],
  ] as const) {
    const client = clientFor(() => Response.json({ code }, { status }));
    expect(await readPending(client, 'Bearer session')).toEqual({ state });
  }
  const client = clientFor(() => Response.json({ verificationRequests: [], next: null }));
  expect(await readPending(client, 'Bearer session')).toEqual({ state: 'ready', value: { requests: [], next: null } });
});

test('approval never proves publication; status uses the current public contract and keeps denied evidence concealed', async () => {
  let publicState: 'unknown' | 'unverified' | 'verified' = 'unknown';
  let privateDenied = false;
  const client = clientFor((incoming) => {
    const url = new URL(incoming.url);
    if (url.pathname.endsWith('/verification'))
      return privateDenied
        ? Response.json({ code: 'forbidden', verificationRequest: request }, { status: 403 })
        : Response.json({ verificationRequest: { ...request, state: 'approved' } });
    if (url.pathname === '/v1/openapi.json') return Response.json({ paths: {} });
    if (url.pathname === '/v1/accounts') {
      const identity = { id: accountId, handle: 'mira', displayName: 'Mira', state: 'active' };
      return Response.json({
        accounts: [
          {
            ...identity,
            ...(url.searchParams.has('handle') && publicState !== 'unknown'
              ? {
                  verified: publicState === 'verified',
                  subject: { id: subjectId, label: 'Mira', type: 'schema:Person' },
                }
              : {}),
          },
        ],
        next: null,
      });
    }
    throw new Error(`Unexpected read: ${url.pathname}`);
  });
  expect((await readAccount(client, 'Bearer owner', accountId)).publication).toEqual({ state: 'unavailable' });
  publicState = 'unverified';
  const pending = await readAccount(client, 'Bearer owner', accountId);
  expect(pending.latest).toMatchObject({ state: 'ready', value: { state: 'approved' } });
  expect(pending.publication).toEqual({ state: 'unverified' });
  publicState = 'verified';
  privateDenied = true;
  const current = await readAccount(client, 'Bearer other', accountId);
  expect(current.latest).toEqual({ state: 'denied' });
  expect(current.publication).toMatchObject({ state: 'verified', subject: { id: subjectId } });
  expect(current.reviewer).toBe(false);
});

test('a response loss and tab reload resume the exact original decision and key, even after the request leaves the pending page', async () => {
  const operation: Operation = {
    action: 'approve',
    targetId: requestId,
    reason: 'Official challenge independently checked.',
    key: crypto.randomUUID(),
  };
  const calls: { path: string; body: unknown; key: string | null; authorization: string | null }[] = [];
  const client = clientFor(async (incoming) => {
    calls.push({
      path: new URL(incoming.url).pathname,
      body: await incoming.json(),
      key: incoming.headers.get('idempotency-key'),
      authorization: incoming.headers.get('authorization'),
    });
    if (calls.length === 1) throw new TypeError('Response lost after native commit');
    return Response.json({ verificationRequest: { ...request, state: 'approving' } });
  });
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  saveAttempt(storage, 'viewer:review', operation);
  expect(await performOperation(client, 'Bearer current', operation)).toEqual({ state: 'uncertain' });
  const resumed = readAttempt(storage, 'viewer:review')!;
  expect(resumed).toEqual(operation);
  expect(await performOperation(client, 'Bearer refreshed-session', resumed)).toMatchObject({
    state: 'accepted',
    request: { state: 'approving' },
  });
  expect(calls[1]).toEqual({ ...calls[0], authorization: 'Bearer refreshed-session' });
  expect(calls[0]).toMatchObject({
    path: `/v1/verification-requests/${requestId}:approve`,
    body: { reason: operation.reason },
    key: operation.key,
    authorization: 'Bearer current',
  });
});

test('all remaining operations use the declared account/request methods with no replacement publication callback', async () => {
  const paths: string[] = [];
  const client = clientFor(async (incoming) => {
    const path = new URL(incoming.url).pathname;
    paths.push(path);
    const input = await incoming.json();
    if (path.endsWith(':reject')) return Response.json({ verificationRequest: { ...request, state: 'rejected' } });
    if (path.endsWith(':withdrawVerification')) {
      expect(input).toEqual({});
      return Response.json({ verificationRequest: { ...request, state: 'withdrawn' } });
    }
    return Response.json({ reversal: { kind: path.endsWith(':revokeVerification') ? 'revoked' : 'released' } });
  });
  for (const action of ['reject', 'withdraw', 'release', 'revoke'] as const) {
    const result = await performOperation(client, 'Bearer current', {
      action,
      targetId: action === 'reject' ? requestId : accountId,
      reason: action === 'reject' || action === 'revoke' ? 'Confirmed loss of representation.' : '',
      key: crypto.randomUUID(),
    });
    expect(result.state).toBe('accepted');
  }
  expect(paths).toEqual([
    `/v1/verification-requests/${requestId}:reject`,
    `/v1/accounts/${accountId}:withdrawVerification`,
    `/v1/accounts/${accountId}:releaseVerification`,
    `/v1/accounts/${accountId}:revokeVerification`,
  ]);
  const operation = { action: 'release', targetId: accountId, reason: '', key: crypto.randomUUID() };
  expect(validOperation({ ...operation, approved: true })).toBe(false);
  expect(validOperation({ ...operation, reason: 'unexpected' })).toBe(false);
  expect(validOperation({ ...operation, key: 'not-a-key' })).toBe(false);
});

test('an applicant reads current status, keeps original operands through uncertainty, and withdraws only the current native request', async () => {
  const draft = {
    subject: subjectId,
    statement: request.statement,
    links: request.links.map((link) => ({ ...link })),
  };
  const pendingAdvice = [{ action: 'account:update', operations: ['account.withdraw_verification'] }];
  const requestAdvice = [{ action: 'account:update', operations: ['account.request_verification'] }];
  const calls: string[] = [];
  let reads = 0;
  const client = clientFor((incoming) => {
    const url = new URL(incoming.url);
    calls.push(`${incoming.method} ${url.pathname}`);
    if (url.pathname === `/v1/accounts/${accountId}/verification`) {
      reads++;
      if (reads === 1)
        return Response.json({ verificationRequest: null, viewerActions: requestAdvice });
      if (reads === 2)
        return Response.json(
          { detail: 'Current status unavailable', code: 'overloaded', retryable: true, request_id: 'status-1' },
          { status: 503, headers: { 'Retry-After': '5' } },
        );
      if (reads === 3)
        return Response.json({ verificationRequest: request, viewerActions: pendingAdvice });
      return Response.json({
        verificationRequest: { ...request, state: 'withdrawn' },
        viewerActions: requestAdvice,
      });
    }
    if (url.pathname === `/v1/accounts/${accountId}:requestVerification`)
      return Response.json({ verificationRequest: request }, { status: 201 });
    if (url.pathname === `/v1/accounts/${accountId}:withdrawVerification`)
      return Response.json({ verificationRequest: { ...request, state: 'withdrawn' } });
    throw new Error(`Unexpected applicant path: ${url.pathname}`);
  });
  const sent: unknown[] = [];
  const controller = new VerificationRecovery(accountId, {
    read: async (currentAccountId) => ({
      accountId: currentAccountId,
      ...(await readVerification(client, currentAccountId, 'Bearer applicant')),
      subjectTitle: 'Mira',
    }),
    request: async (currentAccountId, input) => {
      sent.push(input);
      return requestVerification(client, currentAccountId, 'Bearer applicant', input);
    },
    withdraw: async (currentAccountId, input) =>
      withdrawVerification(client, currentAccountId, 'Bearer applicant', input.idempotencyKey),
  });
  await controller.reload();
  expect(canRequestVerification(controller.snapshot().current)).toBe(true);
  await controller.submit(draft);
  const original = controller.snapshot().attempt;
  expect(controller.snapshot()).toMatchObject({
    phase: 'uncertain',
    readStatus: 'error',
    attempt: { receipt: request, input: original?.input },
    failure: { status: 503, code: 'overloaded', retryable: true, requestId: 'status-1', retryAfter: '5' },
  });
  expect(canRetryVerification(controller.snapshot().attempt, controller.snapshot().current)).toBe(false);
  draft.statement = 'Later draft';
  await controller.retry();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toBe(original?.input);
  expect(JSON.stringify(original?.input)).toContain(request.statement);
  await controller.reload();
  expect(controller.snapshot()).toMatchObject({ phase: 'review', attempt: null, current: { verificationRequest: request } });
  expect(canWithdrawVerification(controller.snapshot().current)).toBe(true);
  const confirmation = verificationWithdrawalObservation(controller.snapshot().current);
  await controller.withdraw(false);
  expect(controller.snapshot().attempt).toBeNull();
  await controller.withdraw(true);
  expect(controller.snapshot().current?.verificationRequest?.state).toBe('withdrawn');
  expect(verificationWithdrawalObservation(controller.snapshot().current)).not.toBe(confirmation);
  expect(calls).toEqual([
    `GET /v1/accounts/${accountId}/verification`,
    `POST /v1/accounts/${accountId}:requestVerification`,
    `GET /v1/accounts/${accountId}/verification`,
    `GET /v1/accounts/${accountId}/verification`,
    `POST /v1/accounts/${accountId}:withdrawVerification`,
    `GET /v1/accounts/${accountId}/verification`,
  ]);
});
