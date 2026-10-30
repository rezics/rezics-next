import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { operationGroups } from '../src/kernel/exposure';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';
import { loadSettingsPage } from '../src/settings/preferences';
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
  const { client, calls } = fakeClient([{ status: 200, data: { verificationRequest: request } }]);
  await expect(readVerification(client as never, 'alice', 'Bearer token')).resolves.toEqual(request);
  expect(calls).toEqual([{ operation: 'read', args: [{ headers: { authorization: 'Bearer token' } }] }]);
});

test('an empty verification response is represented as no request', async () => {
  const { client } = fakeClient([{ status: 200, data: { verificationRequest: null } }]);
  await expect(readVerification(client as never, 'alice', 'Bearer token')).resolves.toBeNull();
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
        { headers: { authorization: 'Bearer token', 'idempotency-key': input.idempotencyKey } },
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
      args: [{}, { headers: { authorization: 'Bearer token', 'idempotency-key': input.idempotencyKey } }],
    },
  ]);
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
import { VerificationRecovery, verificationQueryKey } from '../src/settings/verification-recovery';
import type { AgentVerificationRequest, VerificationCommandResult } from '../src/settings/verification-core';

test('An uncertain verification request or withdrawal retries the exact original command and key, preserves later draft edits, and never claims native completion from transport failure', async () => {
  const pending: AgentVerificationRequest = { ...request, links: request.links.map((link) => ({ ...link })) };
  const approving = { ...pending, state: 'approving' as const };
  const { client, calls } = fakeClient([
    { status: 200, data: { verificationRequest: null } },
    { status: 200, data: { verificationRequest: pending } },
    { status: 201, data: { verificationRequest: pending } },
    { status: 200, data: { verificationRequest: approving } },
  ]);
  const sent: VerificationInput[] = [];
  const controller = new VerificationRecovery('alice', {
    read: async (accountId) => ({
      accountId,
      verificationRequest: await readVerification(client as never, accountId, 'Bearer token'),
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
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(sent[0]);
  expect(sent[1]).toEqual({ ...input, idempotencyKey: expect.any(String) });
  expect(controller.snapshot().attempt).toBeNull();
  expect(controller.snapshot().current?.verificationRequest?.state).toBe('approving');
  expect(controller.snapshot().current?.verificationRequest?.state).not.toBe('approved');
  expect(draft).toMatchObject({ subject: 'later-subject', statement: 'Later unsent statement' });
  expect(draft.links).toHaveLength(5);
  expect(draft.links[0]!.url).toBe('https://example.test/later');
  expect(calls.map((call) => call.operation)).toEqual(['read', 'read', 'request', 'read']);
});

test('uncertain withdrawal keeps confirmation, original key and native failures until an identified withdrawn read', async () => {
  const pending: AgentVerificationRequest = { ...request, links: request.links.map((link) => ({ ...link })) };
  const withdrawn = { ...pending, state: 'withdrawn' as const };
  const { client, calls } = fakeClient([
    { status: 200, data: { verificationRequest: pending } },
    { status: 200, data: { verificationRequest: null } },
    { status: 409, error: { value: { detail: 'The verification request is no longer pending' } } },
    { status: 200, data: { verificationRequest: withdrawn } },
    { status: 200, data: { verificationRequest: null } },
    { status: 200, data: { verificationRequest: withdrawn } },
  ]);
  const sent: { idempotencyKey: string }[] = [];
  const controller = new VerificationRecovery('alice', {
    read: async (accountId) => ({
      accountId,
      verificationRequest: await readVerification(client as never, accountId, 'Bearer token'),
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
  expect(controller.snapshot().current?.verificationRequest).toBeNull();
  expect(controller.snapshot().attempt?.requestId).toBe('request-1');
  await controller.submit(input);
  await controller.retry();
  expect(controller.snapshot().failure).toEqual({
    status: 409,
    message: 'The verification request is no longer pending',
  });
  expect(controller.snapshot().attempt).not.toBeNull();
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
  expect(calls.map((call) => call.operation)).toEqual(['read', 'read', 'withdraw', 'withdraw', 'read', 'read']);
});

test('verification reads reject missing data and other accounts, and late commands cannot cross viewers', async () => {
  for (const value of [{}, { verificationRequest: { ...request, accountId: 'bob' } }]) {
    const { client } = fakeClient([{ status: 200, data: value }]);
    await expect(readVerification(client as never, 'alice', 'Bearer token')).rejects.toThrow();
  }
  let complete!: (result: VerificationCommandResult) => void;
  const reads: string[] = [];
  const io = {
    read: async (accountId: string) => {
      reads.push(accountId);
      return { accountId, verificationRequest: null, subjectTitle: null };
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
