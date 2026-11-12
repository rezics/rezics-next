import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';

const viewer = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const calls: Request[] = [];
let identity: string | null = viewer;
let csrfToken = 'current-csrf';
let preparations = 0;
const headers = new Map<string, string>();
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => new Request('https://site.test/en/knowledge'),
  setResponseHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/session/request', () => ({
  prepareSession: async () => {
    preparations++;
  },
  sessionSubject: () => identity,
  viewerCredential: () => (identity ? 'Bearer prepared-current-owner' : null),
  requestCsrfToken: () => csrfToken,
}));
mock.module('../src/kernel/client', () => ({
  kernelClient: () =>
    createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        calls.push(new Request(input, init));
        return Response.json({ notebooks: [], next: null });
      }) as typeof fetch,
    }),
}));
const { readKnowledgeNavigationVisit } = await import('../src/knowledge/private-server');

test('private BFF prepares identity and derives the account; changed CSRF/viewer and signed-out never read native rows', async () => {
  const data = { request: { kind: 'owned' as const, accountId: 'untrusted-owner' }, expected: { viewer, csrfToken } };
  expect(await readKnowledgeNavigationVisit({ data })).toEqual({
    state: 'ready',
    page: { kind: 'owned', notebooks: [], next: null },
  });
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/accounts/${viewer}/knowledge/notebooks`);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer prepared-current-owner');
  expect(headers.get('cache-control')).toBe('private, no-store');
  csrfToken = 'replacement-csrf';
  expect(await readKnowledgeNavigationVisit({ data })).toEqual({ state: 'retired' });
  csrfToken = data.expected.csrfToken;
  identity = '0192f3a0-6c1e-7b2a-9d4e-000000000098';
  expect(await readKnowledgeNavigationVisit({ data })).toEqual({ state: 'retired' });
  identity = null;
  expect(await readKnowledgeNavigationVisit({ data })).toEqual({ state: 'signed-out' });
  expect(calls).toHaveLength(1);
  expect(preparations).toBe(4);
  expect(() =>
    readKnowledgeNavigationVisit({
      data: { request: { kind: 'outline', notebookId: 'title' }, expected: data.expected },
    }),
  ).toThrow('Invalid Knowledge navigation address');
});
