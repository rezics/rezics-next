import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import { SESSION_COOKIE } from '../src/session/cookies';

const viewer = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const address = {
  notebookId: '0192f3a0-6c1e-7b2a-9d4e-000000000010',
  documentId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
};
const lifecycle = {
  ...address,
  structureRevisionId: viewer,
  generation: '0',
  state: 'active',
  restoreUntil: null,
};
let identity: string | null = viewer;
let csrfToken = 'prepared-csrf';
let authorization = 'Bearer original-owner';
let sessionId = 'original-session';
const calls: Request[] = [];
const responseHeaders = new Map<string, string>();
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () =>
    new Request('https://site.test/en/knowledge', { headers: { cookie: `${SESSION_COOKIE}=${sessionId}` } }),
  setResponseHeader: (key: string, value: string) => responseHeaders.set(key, value),
}));
mock.module('cloudflare:workers', () => ({ env: { WEBSITE_CLIENT_KEY: 'private-boundary-test-key' } }));
mock.module('../src/session/request', () => ({
  prepareSession: async () => {},
  sessionSubject: () => identity,
  requestCsrfToken: () => csrfToken,
  viewerCredential: () => authorization,
}));
mock.module('../src/kernel/client', () => ({
  kernelClient: () =>
    createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        return Response.json(
          request.method === 'GET'
            ? lifecycle
            : {
                ...lifecycle,
                generation: '1',
                state: 'trashed',
                restoreUntil: '2099-12-01T00:00:00.000Z',
                complete: true,
                reason: null,
              },
        );
      }) as typeof fetch,
    }),
}));
const { readKnowledgeLifecycleVisit, changeKnowledgeLifecycleRequest } =
  await import('../src/knowledge/private-server');

test('lifecycle BFF derives owner, binds original command authority and retires replaced sessions before native access', async () => {
  const expected = { viewer, csrfToken };
  const result = await readKnowledgeLifecycleVisit({
    data: { address: { ...address, accountId: 'untrusted-owner' }, expected },
  });
  expect(result.state).toBe('ready');
  if (result.state !== 'ready') throw new Error('expected lifecycle preparation');
  expect(new URL(calls[0]!.url).pathname).toContain(`/accounts/${viewer}/knowledge/`);
  expect(responseHeaders.get('cache-control')).toBe('private, no-store');
  const data = {
    address,
    action: 'trash' as const,
    expectedStructureRevisionId: viewer,
    expectedGeneration: '0',
    idempotencyKey: viewer,
    ...result.binding,
  };
  authorization = 'Bearer refreshed-owner';
  expect(await changeKnowledgeLifecycleRequest({ data })).toMatchObject({ state: 'acknowledged' });
  expect(calls[1]!.headers.get('authorization')).toBe('Bearer original-owner');
  sessionId = 'replaced-session';
  expect(await changeKnowledgeLifecycleRequest({ data })).toEqual({ state: 'retired' });
  sessionId = 'original-session';
  csrfToken = 'replaced-csrf';
  expect(await changeKnowledgeLifecycleRequest({ data })).toEqual({ state: 'retired' });
  expect(await readKnowledgeLifecycleVisit({ data: { address, expected } })).toEqual({ state: 'retired' });
  csrfToken = expected.csrfToken;
  identity = address.documentId;
  expect(await changeKnowledgeLifecycleRequest({ data })).toEqual({ state: 'retired' });
  identity = null;
  expect(await changeKnowledgeLifecycleRequest({ data })).toEqual({ state: 'signed-out' });
  expect(calls).toHaveLength(2);
  for (const invalid of [
    { expectedGeneration: '01' },
    { expectedStructureRevisionId: 'latest' },
    { action: 'purge' },
    { idempotencyKey: '' },
    { address: {} },
  ])
    expect(() => changeKnowledgeLifecycleRequest({ data: { ...data, ...invalid } })).toThrow();
});
