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
