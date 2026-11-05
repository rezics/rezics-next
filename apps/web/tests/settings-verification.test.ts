import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { operationGroups } from '../src/kernel/exposure';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';
import { loadSettingsPage } from '../src/settings/preferences';
import { validateVerificationDraft, verificationCharacterCount } from '../src/settings/verification-validation';
import {
  readVerification,
  requestVerification,
  withdrawVerification,
  type VerificationInput,
} from '../src/settings/verification-core';

const request = {
  id: 'request-1',
  accountId: 'alice',
  accountKind: 'actor',
  requestedBy: 'alice',
  catalogueSubjectId: 'subject-1',
  statement: 'This is me.',
  links: [{ label: 'Homepage', url: 'https://example.test' }],
  state: 'pending',
  reason: null,
  problem: null,
  decisionReceiptId: null,
  decidedBy: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
} as const;

const requestAdvice = [{ action: 'account:update', operations: ['account.request_verification'] }];
const withdrawAdvice = [{ action: 'account:update', operations: ['account.withdraw_verification'] }];

function adviceFor(verificationRequest: { state: string } | null) {
  if (!verificationRequest || ['withdrawn', 'failed', 'rejected'].includes(verificationRequest.state))
    return requestAdvice;
  if (verificationRequest.state === 'pending') return withdrawAdvice;
  return [];
}

function statusOf(
  verificationRequest: typeof request | (typeof request & { state: string }) | null,
  viewerActions = adviceFor(verificationRequest),
) {
  return { verificationRequest, viewerActions };
}

function snapshotOf(
  verificationRequest: typeof request | (typeof request & { state: string }) | null,
  extra: {
    accountId?: string;
    subjectTitle?: string | null;
    viewerActions?: { action: string; operations: string[] }[];
  } = {},
) {
  return {
    accountId: extra.accountId ?? 'alice',
    ...statusOf(verificationRequest, extra.viewerActions ?? adviceFor(verificationRequest)),
    subjectTitle: extra.subjectTitle ?? null,
  };
}

function fakeClient(responses: { status: number; data?: unknown; error?: unknown }[]) {
  const calls: { operation: string; args: unknown[] }[] = [];
  const next = async (operation: string, ...args: unknown[]) => {
    calls.push({ operation, args });
    return responses.shift() ?? { status: 500, error: { value: { detail: 'Unexpected request' } } };
  };
  const client = {
    accounts: (_params: unknown) => ({
      verification: { get: (options: unknown) => next('read', options) },
      $requestVerification: { post: (body: unknown, options: unknown) => next('request', body, options) },
      $withdrawVerification: { post: (body: unknown, options: unknown) => next('withdraw', body, options) },
    }),
  };
  return { client, calls };
}

const input: VerificationInput = {
  subject: 'subject-1',
  statement: 'This is me.',
  links: [{ label: 'Homepage', url: 'https://example.test' }],
  idempotencyKey: '00000000-0000-4000-8000-000000000001',
};

test('Make verification form limits and supporting links actionable preserving the current native and draft/recovery contracts', async () => {
  const prefix = 'HTTPS://example.test/';
  for (const count of [1001, 2000]) {
    const exact = {
      ...input,
      statement: '😀'.repeat(count),
      links: [
        { label: '😀'.repeat(64), url: prefix + '😀'.repeat(2048 - prefix.length) },
        { label: '  Public profile  ', url: 'https://example.test/Profile?value=%2f#Original' },
        { label: 'Third', url: 'https://example.test/3' },
        { label: 'Fourth', url: 'https://example.test/4' },
        { label: 'Fifth', url: 'https://example.test/5' },
      ],
    };
    const before = structuredClone(exact);
    expect(verificationCharacterCount(exact.statement)).toBe(count);
    expect(verificationCharacterCount(exact.links[0]!.url)).toBe(2048);
    expect(validateVerificationDraft(exact)).toEqual([]);
    const receipt = { ...request, statement: exact.statement, links: exact.links };
    const { client, calls } = fakeClient([{ status: 201, data: { verificationRequest: receipt } }]);
    await expect(requestVerification(client as never, 'alice', 'Bearer token', exact)).resolves.toEqual({
      ok: true,
      verificationRequest: receipt,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toEqual({ subject: 'subject-1', statement: exact.statement, links: exact.links });
    expect(exact).toEqual(before);
  }
});

test('over-limit and unsafe verification drafts fail closed before native IO without changing any draft bytes', async () => {
  const badDrafts: VerificationInput[] = [
    { ...input, statement: '😀'.repeat(2001) },
    { ...input, statement: ' \n\t ' },
    { ...input, links: [{ label: '😀'.repeat(65), url: 'https://example.test' }] },
    { ...input, links: [{ label: ' \t ', url: 'https://example.test' }] },
    { ...input, links: Array.from({ length: 6 }, () => ({ ...input.links[0]! })) },
    ...[
      'https://example.test/' + '😀'.repeat(2028),
      'https://user:password@example.test/path',
      'https://user@example.test/path',
      'https://@example.test/path',
      'http://example.test',
      '//example.test',
      'https:example.test',
      'https:///example.test',
      'https://',
      ' https://example.test',
      'https://example.test/ ',
      'https://example.test/\npath',
      'https://example.test/\tpath',
      'https://example.test/\u007fpath',
      '',
    ].map((url) => ({ ...input, links: [{ label: 'Original label', url }] })),
  ];
  const { client, calls } = fakeClient([]);
  for (const draft of badDrafts) {
    const before = structuredClone(draft);
    expect(validateVerificationDraft(draft).length).toBeGreaterThan(0);
    await expect(requestVerification(client as never, 'alice', 'Bearer token', draft)).resolves.toMatchObject({
      ok: false,
      status: 0,
      outcome: 'refused',
    });
    expect(draft).toEqual(before);
  }
  expect(calls).toEqual([]);
});

test('verification validation counts original whitespace and combining code points without normalizing them', () => {
  const exact = { ...input, statement: ` ${'e\u0301'.repeat(999)}\n`, links: [] };
  expect(verificationCharacterCount(exact.statement)).toBe(2000);
  expect(validateVerificationDraft(exact)).toEqual([]);
  expect(validateVerificationDraft({ ...exact, statement: exact.statement + 'x' })).toEqual([
    { field: 'statement', code: 'statement-limit' },
  ]);
  expect(exact.statement).toBe(` ${'e\u0301'.repeat(999)}\n`);
});

test('verification controls are declared behind the agent_verification gate', () => {
  expect(operationGroups['agent_verification.request']).toBe('agent_verification');
  expect(operationGroups['agent_verification.withdraw']).toBe('agent_verification');
});

test('the settings server read does not fetch verification state', async () => {
  const paths: string[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      paths.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ spoilerLevel: 1, suitability: 'show', version: 1 });
    }) as typeof fetch,
  });
  const session = {
    async credential() {
      return { status: 'active', subject: 'alice', accessToken: 'page-token', csrfToken: 'A'.repeat(22) };
    },
    async signedIn() {
      return { signedIn: true, subject: 'alice', csrfToken: 'A'.repeat(22) };
    },
  };
  const env = {
    SITE_ORIGINS: 'https://site.example.test',
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.rezics.test',
    WEBSITE_SCOPES: 'openid account:read account:update',
    WEBSITE_CLIENT_ID: 'rezics-web-cost',
    WEBSITE_CLIENT_KEY: 'unused-by-this-read',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => session,
    } as unknown as DurableObjectNamespace<SessionStore>,
  } as Partial<SessionEnv>;
  const request = new Request('https://site.example.test/en/settings', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });

  await loadSettingsPage(client, request, env);
  expect(paths).toEqual(['GET /v1/accounts/alice/preferences']);
});

test('settings reads the current verification request once and uses the generated account response shape', async () => {
  const { client, calls } = fakeClient([{ status: 200, data: statusOf(request) }]);
  await expect(readVerification(client as never, 'alice', 'Bearer token')).resolves.toEqual(statusOf(request));
  expect(calls).toEqual([{ operation: 'read', args: [{ headers: { authorization: 'Bearer token' } }] }]);
});

test('an empty verification status with no admitted command is no request', async () => {
  const { client } = fakeClient([{ status: 200, data: { verificationRequest: null, viewerActions: [] } }]);
  await expect(readVerification(client as never, 'alice', 'Bearer token')).resolves.toEqual({
    verificationRequest: null,
    viewerActions: [],
  });
});

test('a missing viewerActions field is a malformed status, not no request', async () => {
  const { client } = fakeClient([{ status: 200, data: { verificationRequest: null } }]);
  await expect(readVerification(client as never, 'alice', 'Bearer token')).rejects.toThrow();
});

test('current verification reads accept explicit nullable requesters on retained terminal requests and reject malformed or foreign responses', async () => {
  const organizationRequest = {
    ...request,
    accountId: 'org-1',
    accountKind: 'organization',
    requestedBy: null,
  } as const;
  const retainedTerminalRequests = [
    { ...organizationRequest, state: 'rejected', reason: 'Request did not establish ownership.' },
    { ...organizationRequest, state: 'withdrawn' },
    {
      ...organizationRequest,
      state: 'failed',
      problem: { type: 'verification_unavailable', detail: 'Verification could not be completed.' },
    },
  ] as const;

  for (const verificationRequest of retainedTerminalRequests) {
    const { client } = fakeClient([{ status: 200, data: statusOf(verificationRequest) }]);
    await expect(readVerification(client as never, 'org-1', 'Bearer manager-token')).resolves.toEqual(
      statusOf(verificationRequest),
    );
  }

  const { requestedBy: _requestedBy, ...requestWithoutRequester } = organizationRequest;
  const invalidRequests = [
    requestWithoutRequester,
    { ...organizationRequest, requestedBy: undefined },
    { ...organizationRequest, requestedBy: 17 },
    { ...organizationRequest, accountId: 'another-org' },
  ];
  for (const verificationRequest of invalidRequests) {
    const { client } = fakeClient([{ status: 200, data: { verificationRequest } }]);
    await expect(readVerification(client as never, 'org-1', 'Bearer manager-token')).rejects.toThrow();
  }
});

test('a verification request sends the selected subject, statement, and labelled links exactly once', async () => {
  const { client, calls } = fakeClient([{ status: 201, data: { verificationRequest: request } }]);
  await expect(requestVerification(client as never, 'alice', 'Bearer token', input)).resolves.toEqual({
    ok: true,
    verificationRequest: request,
  });
  expect(calls).toEqual([
    {
      operation: 'request',
      args: [
        { subject: input.subject, statement: input.statement, links: input.links },
        { headers: { authorization: 'Bearer token', 'idempotency-key': JSON.stringify(input.idempotencyKey) } },
      ],
    },
  ]);
});

test('a request is not shown as sent for a response other than 201', async () => {
  const { client } = fakeClient([{ status: 200, data: { verificationRequest: request } }]);
  await expect(requestVerification(client as never, 'alice', 'Bearer token', input)).resolves.toMatchObject({
    ok: false,
    status: 200,
  });
});

test.each([400, 409, 422, 429])('a %i rejection retains the API detail and is not reported as sent', async (status) => {
  const { client } = fakeClient([{ status, error: { value: { detail: `specific ${status} message` } } }]);
  await expect(requestVerification(client as never, 'alice', 'Bearer token', input)).resolves.toEqual({
    ok: false,
    status,
    message: `specific ${status} message`,
  });
});

test('withdrawal calls the account command and displays the returned state', async () => {
  const withdrawn = { ...request, state: 'withdrawn' };
  const { client, calls } = fakeClient([{ status: 200, data: { verificationRequest: withdrawn } }]);
  await expect(withdrawVerification(client as never, 'alice', 'Bearer token', input.idempotencyKey)).resolves.toEqual({
    ok: true,
    verificationRequest: withdrawn,
  });
  expect(calls).toEqual([
    {
      operation: 'withdraw',
      args: [
        {},
        { headers: { authorization: 'Bearer token', 'idempotency-key': JSON.stringify(input.idempotencyKey) } },
      ],
    },
  ]);
});

test('verification request and withdrawal serialize the original key once through the actual client on explicit retry', async () => {
  for (const idempotencyKey of ['123e4567-e89b-42d3-a456-426614174000', '  command "quoted" \\ path  ', '123']) {
    const draft = Object.freeze({
      ...input,
      statement: '  Original e\u0301\nstatement  ',
      links: [{ label: '  Original label  ', url: 'HTTPS://example.test/Profile?value=%2f#Original' }],
      idempotencyKey,
    });
    const original = structuredClone(draft);
    for (const operation of ['request', 'withdraw'] as const) {
      const calls: Request[] = [];
      const client = createKernelClient('https://kernel.example.test', {
        fetch: (async (input, init) => {
          calls.push(new Request(input, init));
          return Response.json({ detail: 'Original native detail' }, { status: 503 });
        }) as typeof fetch,
      });
      for (const attempt of [1, 2]) {
        const result =
          operation === 'request'
            ? await requestVerification(client, 'alice', 'Bearer token', draft)
            : await withdrawVerification(client, 'alice', 'Bearer token', draft.idempotencyKey);
        expect(result).toEqual({ ok: false, status: 503, message: 'Original native detail' });
        expect(calls).toHaveLength(attempt);
        const sent = calls[attempt - 1]!;
        expect(sent.method).toBe('POST');
        expect(new URL(sent.url).pathname).toBe(`/v1/accounts/alice:$${operation}Verification`);
        expect(sent.headers.get('authorization')).toBe('Bearer token');
        const { idempotencyKeyOf } = await import('../../../services/kernel/src/http/request.ts');
        expect(idempotencyKeyOf(sent.headers.get('idempotency-key'))).toBe(idempotencyKey);
        expect(await sent.clone().json()).toEqual(
          operation === 'request'
            ? { subject: draft.subject, statement: '  Original e\u0301\nstatement  ', links: original.links }
            : {},
        );
        expect(draft).toEqual(original);
      }
      expect(calls[1]!.headers.get('idempotency-key')).toBe(calls[0]!.headers.get('idempotency-key'));
    }
  }
});

test('invalid subject, statement, or link counts are rejected before the command', async () => {
  const { client, calls } = fakeClient([]);
  await expect(
    requestVerification(client as never, 'alice', 'Bearer token', { ...input, subject: '', statement: 'x' }),
  ).resolves.toMatchObject({ ok: false, message: expect.any(String) });
  await expect(
    requestVerification(client as never, 'alice', 'Bearer token', { ...input, statement: 'x'.repeat(2001) }),
  ).resolves.toMatchObject({ ok: false, message: expect.any(String) });
  await expect(
    requestVerification(client as never, 'alice', 'Bearer token', {
      ...input,
      links: Array.from({ length: 6 }, (_, index) => ({ label: String(index), url: 'https://example.test' })),
    }),
  ).resolves.toMatchObject({ ok: false, message: expect.any(String) });
  expect(calls).toHaveLength(0);
});

// Recovery cases are additive: the native status and payload oracles above remain unchanged.
import {
  VerificationRecovery,
  canRequestVerification,
  canWithdrawVerification,
  verificationQueryKey,
  verificationWithdrawalObservation,
} from '../src/settings/verification-recovery';
import type { AgentVerificationRequest, VerificationCommandResult } from '../src/settings/verification-core';

test('a receipt waits for current readback and older requests or revisions cannot replace it', async () => {
  const pending = {
    ...request,
    id: 'new-request',
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-02-01T00:00:00Z',
  };
  const approved = { ...pending, state: 'approved' as const, updatedAt: '2026-02-02T00:00:00Z' };
  let current: AgentVerificationRequest | null = null;
  const controller = new VerificationRecovery('alice', {
    read: async () => snapshotOf(current, { subjectTitle: 'Agent' }),
    request: async () => ({ ok: true, verificationRequest: pending }),
    withdraw: async () => {
      throw new Error('Unexpected withdrawal');
    },
  });
  await controller.reload();
  await controller.submit(input);
  const attempt = controller.snapshot().attempt;
  expect(attempt?.receipt?.id).toBe(pending.id);
  expect(controller.snapshot().phase).toBe('uncertain');
  current = { ...request, state: 'approved' };
  await controller.reload();
  expect(controller.snapshot().current).toBeNull();
  expect(controller.snapshot().attempt).toBe(attempt);
  current = approved;
  await controller.reload();
  expect(controller.snapshot()).toMatchObject({
    phase: 'review',
    attempt: null,
    current: { verificationRequest: approved },
  });
  current = pending;
  await controller.reload();
  expect(controller.snapshot()).toMatchObject({ phase: 'unavailable', current: null });
  current = approved;
  await controller.reload();
  expect(controller.snapshot().current?.verificationRequest).toEqual(approved);
});

test('An uncertain verification request or withdrawal retries the exact original command and key, preserves later draft edits, and never claims native completion from transport failure', async () => {
  const pending: AgentVerificationRequest = { ...request, links: request.links.map((link) => ({ ...link })) };
  const approving = { ...pending, state: 'approving' as const };
  const { client, calls } = fakeClient([
    { status: 200, data: statusOf(null) },
    { status: 200, data: statusOf(pending) },
    { status: 200, data: statusOf(null) },
    { status: 201, data: { verificationRequest: pending } },
    { status: 200, data: statusOf(approving) },
  ]);
  const sent: VerificationInput[] = [];
  const controller = new VerificationRecovery('alice', {
    read: async (accountId) => ({
      accountId,
      ...(await readVerification(client as never, accountId, 'Bearer token')),
      subjectTitle: null,
    }),
    request: async (accountId, original) => {
      sent.push(original);
      if (sent.length === 1) throw new Error('Response lost after native commit');
      return requestVerification(client as never, accountId, 'Bearer token', original);
    },
    withdraw: async () => {
      throw new Error('Conflicting withdrawal must not run');
    },
  });
  await controller.reload();
  const draft = { subject: input.subject, statement: input.statement, links: input.links.map((link) => ({ ...link })) };
  await controller.submit(draft);
  expect(controller.snapshot().phase).toBe('uncertain');
  expect(controller.snapshot().current).toBeNull();
  const original = controller.snapshot().attempt;
  expect(Object.isFrozen(original?.input)).toBe(true);
  expect(Object.isFrozen(sent[0]!.links[0])).toBe(true);
  draft.subject = 'later-subject';
  draft.statement = 'Later unsent statement';
  draft.links[0]!.url = 'https://example.test/later';
  draft.links.push(
    ...Array.from({ length: 4 }, (_, index) => ({ label: `Later ${index}`, url: `https://example.test/${index}` })),
  );
  await controller.submit(draft);
  await controller.withdraw(true);
  await controller.reload();
  // Matching latest status and evidence cannot identify which command created this request.
  expect(controller.snapshot().attempt).toBe(original);
  expect(controller.snapshot().phase).toBe('uncertain');
  expect(sent).toHaveLength(1);
  await controller.retry();
  expect(sent).toHaveLength(1);
  await controller.reload();
  expect(controller.snapshot().attempt).toBe(original);
  await controller.retry();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(sent[0]);
  expect(sent[1]).toEqual({ ...input, idempotencyKey: expect.any(String) });
  expect(controller.snapshot().attempt).toBeNull();
  expect(controller.snapshot().current?.verificationRequest?.state).toBe('approving');
  expect(controller.snapshot().current?.verificationRequest?.state).not.toBe('approved');
  expect(draft).toMatchObject({ subject: 'later-subject', statement: 'Later unsent statement' });
  expect(draft.links).toHaveLength(5);
  expect(draft.links[0]!.url).toBe('https://example.test/later');
  expect(calls.map((call) => call.operation)).toEqual(['read', 'read', 'read', 'request', 'read']);
});

test('uncertain withdrawal keeps confirmation, original key and native failures until an identified withdrawn read', async () => {
  const pending: AgentVerificationRequest = { ...request, links: request.links.map((link) => ({ ...link })) };
  const withdrawn = { ...pending, state: 'withdrawn' as const };
  const { client, calls } = fakeClient([
    { status: 200, data: statusOf(pending) },
    { status: 200, data: statusOf(pending) },
    { status: 409, error: { value: { detail: 'The verification request is no longer pending' } } },
    { status: 200, data: statusOf(pending) },
    { status: 200, data: statusOf(withdrawn) },
    { status: 200, data: statusOf(null) },
    { status: 200, data: statusOf(withdrawn) },
  ]);
  const sent: { idempotencyKey: string }[] = [];
  const controller = new VerificationRecovery('alice', {
    read: async (accountId) => ({
      accountId,
      ...(await readVerification(client as never, accountId, 'Bearer token')),
      subjectTitle: null,
    }),
    request: async () => {
      throw new Error('Conflicting request must not run');
    },
    withdraw: async (accountId, original) => {
      sent.push(original);
      if (sent.length === 1) throw new Error('Withdrawal response lost');
      return withdrawVerification(client as never, accountId, 'Bearer token', original.idempotencyKey);
    },
  });
  await controller.reload();
  await controller.withdraw(false);
  expect(sent).toHaveLength(0);
  await controller.withdraw(true);
  await controller.reload();
  expect(controller.snapshot().phase).toBe('uncertain');
  expect(controller.snapshot().current?.verificationRequest).toEqual(pending);
  expect(controller.snapshot().attempt?.requestId).toBe('request-1');
  await controller.submit(input);
  await controller.retry();
  expect(controller.snapshot().failure).toEqual({
    status: 409,
    message: 'The verification request is no longer pending',
  });
  expect(controller.snapshot().attempt).not.toBeNull();
  await controller.reload();
  await controller.retry();
  // Even an ok command response cannot turn an absent current read into a withdrawal success.
  expect(controller.snapshot().phase).toBe('uncertain');
  expect(controller.snapshot().attempt).not.toBeNull();
  expect(sent).toHaveLength(3);
  expect(sent[1]).toBe(sent[0]);
  expect(sent[2]).toBe(sent[0]);
  await controller.reload();
  expect(controller.snapshot().attempt).toBeNull();
  expect(controller.snapshot().current?.verificationRequest?.state).toBe('withdrawn');
  expect(calls.map((call) => call.operation)).toEqual(['read', 'read', 'withdraw', 'read', 'withdraw', 'read', 'read']);
});

test('verification reads reject missing data and other accounts, and late commands cannot cross viewers', async () => {
  for (const value of [
    {},
    { verificationRequest: null },
    { verificationRequest: { ...request, accountId: 'bob' }, viewerActions: withdrawAdvice },
    { verificationRequest: request, viewerActions: [{ action: 'account:update', operations: [] }] },
    { verificationRequest: request, viewerActions: [{ action: 'account:update' }] },
    { verificationRequest: request, viewerActions: withdrawAdvice, extra: true },
  ]) {
    const { client } = fakeClient([{ status: 200, data: value }]);
    await expect(readVerification(client as never, 'alice', 'Bearer token')).rejects.toThrow();
  }
  let complete!: (result: VerificationCommandResult) => void;
  const reads: string[] = [];
  const io = {
    read: async (accountId: string) => {
      reads.push(accountId);
      return snapshotOf(null, { accountId });
    },
    request: () =>
      new Promise<VerificationCommandResult>((resolve) => {
        complete = resolve;
      }),
    withdraw: async (): Promise<VerificationCommandResult> => ({ ok: false, status: 403, message: 'Forbidden' }),
  };
  const alice = new VerificationRecovery('alice', io);
  await alice.reload();
  const sending = alice.submit(input);
  alice.deactivate();
  const bob = new VerificationRecovery('bob', io);
  await bob.reload();
  complete({ ok: true, verificationRequest: { ...request, links: request.links.map((link) => ({ ...link })) } });
  await sending;
  await alice.retry();
  expect(reads).toEqual(['alice', 'bob']);
  expect(bob.snapshot().attempt).toBeNull();
  expect(bob.snapshot().current?.accountId).toBe('bob');
  expect(bob.snapshot().current?.verificationRequest).toBeNull();
  expect(verificationQueryKey('alice')).not.toEqual(verificationQueryKey('bob'));
});

import { spyOn } from 'bun:test';
import {
  VerificationReadError,
  unwrapVerificationRead,
  type VerificationReadResult,
} from '../src/settings/verification-core';

function nativeVerificationClient(responses: Response[]) {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      calls.push(new Request(input, init));
      const response = responses.shift();
      if (!response) throw new Error('Unexpected native verification request');
      return response;
    }) as typeof fetch,
  });
  return { client, calls };
}

test.each(['read', 'request', 'withdraw'] as const)(
  'native verification %s preserves actual optional failure fields across private serialization',
  async (operation) => {
    const failure = {
      status: 503,
      message: 'Native service unavailable',
      code: 'overloaded',
      retryable: true,
      requestId: 'native-request-id',
      retryAfter: 'Sat, 31 Oct 2026 01:00:00 GMT',
    };
    const { client, calls } = nativeVerificationClient([
      Response.json(
        {
          status: failure.status,
          detail: failure.message,
          code: failure.code,
          retryable: failure.retryable,
          request_id: failure.requestId,
        },
        { status: failure.status, headers: { 'Retry-After': failure.retryAfter } },
      ),
    ]);
    if (operation === 'read') {
      let caught: unknown;
      try {
        await readVerification(client, 'alice', 'Bearer token');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(VerificationReadError);
      expect(caught).toBeInstanceOf(Error);
      const envelope: VerificationReadResult<never> = JSON.parse(
        JSON.stringify({ ok: false, failure: (caught as VerificationReadError).failure }),
      );
      expect(envelope).toEqual({ ok: false, failure });
      expect(() => unwrapVerificationRead(envelope)).toThrow(failure.message);
      try {
        unwrapVerificationRead(envelope);
      } catch (error) {
        expect((error as VerificationReadError).failure).toEqual(failure);
      }
    } else {
      const result =
        operation === 'request'
          ? await requestVerification(client, 'alice', 'Bearer token', input)
          : await withdrawVerification(client, 'alice', 'Bearer token', input.idempotencyKey);
      expect(JSON.parse(JSON.stringify(result))).toEqual({ ok: false, ...failure });
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer token');
  },
);

test('Keep native verification recovery delays actionable without weakening native identity, exact recovery or draft invariants', async () => {
  let now = Date.parse('2026-10-31T00:00:00.250Z');
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const { client, calls } = nativeVerificationClient([
      Response.json(statusOf(null)),
      Response.json(statusOf(null)),
      Response.json(
        { detail: 'Wait before replaying', code: 'rate_limited', request_id: 'refusal-id' },
        { status: 429, headers: { 'Retry-After': '2' } },
      ),
      Response.json(statusOf(null)),
      Response.json(statusOf(null)),
      Response.json({ verificationRequest: request }, { status: 201 }),
      Response.json(statusOf({ ...request, state: 'approving' })),
    ]);
    const sent: VerificationInput[] = [];
    const controller = new VerificationRecovery('alice', {
      read: async (accountId) => ({
        accountId,
        ...(await readVerification(client, accountId, 'Bearer token')),
        subjectTitle: 'Avery',
      }),
      request: async (accountId, original) => {
        sent.push(original);
        if (sent.length === 1) throw new Error('Original response lost');
        return requestVerification(client, accountId, 'Bearer token', original);
      },
      withdraw: async () => {
        throw new Error('Conflicting command must not run');
      },
    });
    await controller.reload();
    const draft = {
      subject: input.subject,
      statement: input.statement,
      links: input.links.map((link) => ({ ...link })),
    };
    await controller.submit(draft);
    const original = controller.snapshot().attempt;
    expect(controller.snapshot().failure).toBeUndefined();
    expect(controller.snapshot().commandRetryAt).toBe(0);
    expect(controller.snapshot().readRetryAt).toBe(0);
    draft.subject = 'later-subject';
    draft.statement = 'Later draft';
    draft.links[0]!.url = 'https://example.test/later';
    await controller.reload();
    await controller.retry();
    expect(controller.snapshot()).toMatchObject({
      phase: 'uncertain',
      current: null,
      failure: {
        status: 429,
        message: 'Wait before replaying',
        code: 'rate_limited',
        requestId: 'refusal-id',
        retryAfter: '2',
      },
      commandRetryAt: now + 2000,
    });
    expect(controller.snapshot().failure).not.toHaveProperty('retryable');
    expect(controller.snapshot().attempt).toBe(original);
    const deadline = controller.snapshot().commandRetryAt;
    now = deadline - 1;
    await controller.retry();
    await controller.reload();
    await controller.submit(draft);
    await controller.withdraw(true);
    expect(calls).toHaveLength(4);
    expect(controller.snapshot().commandRetryAt).toBe(deadline);
    expect(controller.snapshot().readRetryAt).toBe(0);
    now = deadline;
    expect(calls).toHaveLength(4); // Expiry itself never dispatches IO.
    await controller.reload();
    expect(controller.snapshot().attempt).toBe(original);
    expect(controller.snapshot().attempt?.receipt).toBeNull();
    expect(controller.snapshot().phase).toBe('uncertain');
    expect(controller.snapshot().commandRetryAt).toBe(deadline);
    await controller.retry();
    expect(sent).toHaveLength(3);
    expect(sent.every((value) => value === original?.input)).toBe(true);
    expect(sent[2]).toEqual({ ...input, idempotencyKey: expect.any(String) });
    expect(Object.isFrozen(sent[2]!.links[0])).toBe(true);
    expect(controller.snapshot().phase).toBe('review');
    expect(controller.snapshot().attempt).toBeNull();
    expect(controller.snapshot().current?.verificationRequest?.state).toBe('approving');
    expect(draft).toMatchObject({ subject: 'later-subject', statement: 'Later draft' });
    expect(draft.links[0]!.url).toBe('https://example.test/later');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST', 'GET', 'GET', 'POST', 'GET']);
    expect(calls[2]!.headers.get('idempotency-key')).toBe(calls[5]!.headers.get('idempotency-key'));
    expect(await calls[5]!.json()).toEqual({ subject: input.subject, statement: input.statement, links: input.links });
  } finally {
    clock.mockRestore();
  }
});

test('a failed final native status read retains the withdrawal receipt and exact deadline, including pending IO guards', async () => {
  let now = Date.parse('2026-10-31T00:00:00Z');
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const retryAfter = new Date(now + 3000).toUTCString();
    const withdrawn = { ...request, state: 'withdrawn' };
    const { client, calls } = nativeVerificationClient([
      Response.json(statusOf(request)),
      Response.json(statusOf(request)),
      Response.json({ verificationRequest: withdrawn }),
      Response.json(
        { detail: 'Current status unavailable', code: 'overloaded', retryable: true, request_id: 'read-id' },
        { status: 503, headers: { 'Retry-After': retryAfter } },
      ),
      Response.json(statusOf(withdrawn)),
    ]);
    let pauseRead = false;
    let finishRead!: () => void;
    const sent: { idempotencyKey: string }[] = [];
    const controller = new VerificationRecovery('alice', {
      read: async (accountId) => {
        if (pauseRead)
          await new Promise<void>((resolve) => {
            finishRead = resolve;
          });
        return {
          accountId,
          ...(await readVerification(client, accountId, 'Bearer token')),
          subjectTitle: 'Avery',
        };
      },
      request: async () => {
        throw new Error('Conflicting request must not run');
      },
      withdraw: async (accountId, original) => {
        sent.push(original);
        if (sent.length === 1) throw new Error('Original withdrawal response lost');
        return withdrawVerification(client, accountId, 'Bearer token', original.idempotencyKey);
      },
    });
    await controller.reload();
    await controller.withdraw(true);
    const original = controller.snapshot().attempt;
    await controller.reload();
    await controller.retry();
    const receipted = controller.snapshot().attempt;
    expect(receipted?.input).toBe(original?.input);
    expect(receipted?.requestId).toBe(request.id);
    expect(receipted?.receipt).toEqual(withdrawn);
    expect(Object.isFrozen(receipted?.receipt)).toBe(true);
    expect(controller.snapshot()).toMatchObject({
      phase: 'uncertain',
      current: null,
      failure: { status: 503, code: 'overloaded', retryable: true, requestId: 'read-id', retryAfter },
      readRetryAt: now + 3000,
    });
    const deadline = controller.snapshot().readRetryAt;
    now = deadline - 1;
    await controller.reload();
    await controller.retry();
    expect(controller.snapshot().attempt).toBe(receipted);
    expect(calls).toHaveLength(4);
    now = deadline;
    expect(calls).toHaveLength(4);
    pauseRead = true;
    const reading = controller.reload();
    expect(controller.snapshot().phase).toBe('reading');
    await controller.reload();
    await controller.retry();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(calls).toHaveLength(4);
    finishRead();
    await reading;
    expect(controller.snapshot().attempt).toBeNull();
    expect(controller.snapshot().current?.verificationRequest?.state).toBe('withdrawn');
    expect(controller.snapshot().phase).toBe('review');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'GET', 'POST', 'GET', 'GET']);
  } finally {
    clock.mockRestore();
  }
});

test('ordinary read Errors and invalid native retry timing never invent a delay or a successful null snapshot', async () => {
  const { client, calls } = nativeVerificationClient([
    Response.json(
      { detail: 'Read denied', code: 'forbidden', retryable: false },
      { status: 403, headers: { 'Retry-After': 'invalid' } },
    ),
    Response.json(statusOf(null)),
  ]);
  let reads = 0;
  const controller = new VerificationRecovery('alice', {
    read: async (accountId) => {
      if (++reads === 1) throw new Error('Ordinary read failure');
      if (reads === 4) throw new Error('rezics-platform-closed');
      return {
        accountId,
        ...(await readVerification(client, accountId, 'Bearer token')),
        subjectTitle: null,
      };
    },
    request: async () => {
      throw new Error('Unexpected command');
    },
    withdraw: async () => {
      throw new Error('Unexpected command');
    },
  });
  await controller.reload();
  expect(controller.snapshot()).toMatchObject({ phase: 'unavailable', current: null, readRetryAt: 0 });
  expect(controller.snapshot().failure).toBeUndefined();
  await controller.reload();
  expect(controller.snapshot()).toMatchObject({ phase: 'unavailable', current: null, readRetryAt: 0 });
  expect(controller.snapshot().failure).toEqual({
    status: 403,
    message: 'Read denied',
    code: 'forbidden',
    retryable: false,
    retryAfter: 'invalid',
  });
  await controller.reload();
  expect(controller.snapshot().current).toEqual(snapshotOf(null));
  expect(unwrapVerificationRead({ ok: true, value: controller.snapshot().current })).toBe(
    controller.snapshot().current,
  );
  expect(controller.snapshot().phase).toBe('idle');
  await controller.reload();
  expect(controller.snapshot().failure).toEqual({ status: 403, message: 'rezics-platform-closed' });
  expect(controller.snapshot().readRetryAt).toBe(0);
  expect(calls).toHaveLength(2);
});

test('native viewer advice admits request and withdraw independently of state-only inference', () => {
  expect(canRequestVerification(snapshotOf(null))).toBe(true);
  expect(canWithdrawVerification(snapshotOf(null))).toBe(false);
  expect(canRequestVerification(snapshotOf(null, { viewerActions: [] }))).toBe(false);
  expect(canRequestVerification(snapshotOf(request))).toBe(false);
  expect(canWithdrawVerification(snapshotOf(request))).toBe(true);
  expect(canWithdrawVerification(snapshotOf({ ...request, state: 'approving' }))).toBe(false);
  expect(canRequestVerification(snapshotOf({ ...request, state: 'approving' }))).toBe(false);
  expect(canRequestVerification(snapshotOf({ ...request, state: 'withdrawn' }))).toBe(true);
  expect(canWithdrawVerification(snapshotOf(request, { viewerActions: [] }))).toBe(false);
});

test('optional title failure keeps the admitted request and its advice', async () => {
  const { client } = fakeClient([{ status: 200, data: statusOf(request) }]);
  const status = await readVerification(client as never, 'alice', 'Bearer token');
  const current = { accountId: 'alice' as const, ...status, subjectTitle: null };
  expect(current.verificationRequest).toEqual(request);
  expect(canWithdrawVerification(current)).toBe(true);
  expect(canRequestVerification(current)).toBe(false);
});

test('a newer request, changed advice, or pending-to-approving transition invalidates withdrawal confirmation', () => {
  const pending = snapshotOf(request);
  const confirmation = verificationWithdrawalObservation(pending);
  expect(confirmation).toBe(verificationWithdrawalObservation(snapshotOf(request)));
  expect(confirmation).not.toBe(verificationWithdrawalObservation(snapshotOf({ ...request, id: 'request-2' })));
  expect(confirmation).not.toBe(verificationWithdrawalObservation(snapshotOf({ ...request, state: 'approving' })));
  expect(confirmation).not.toBe(verificationWithdrawalObservation(snapshotOf(request, { viewerActions: [] })));
  expect(verificationWithdrawalObservation(snapshotOf(null))).toBeNull();
});
