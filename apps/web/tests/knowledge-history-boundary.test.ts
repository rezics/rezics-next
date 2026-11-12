import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
const viewer = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const address = {
  notebookId: '0192f3a0-6c1e-7b2a-9d4e-000000000010',
  documentId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
};
const pair = {
  leftRevisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
  rightRevisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000012',
};
let identity: string | null = viewer;
let csrfToken = 'current-csrf';
const headers = new Map<string, string>();
const calls: Request[] = [];
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => new Request('https://site.test/en/knowledge'),
  setResponseHeader: (name: string, value: string) => headers.set(name, value),
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/session/request', () => ({
  prepareSession: async () => {},
  sessionSubject: () => identity,
  viewerCredential: () => 'Bearer prepared-author',
  requestCsrfToken: () => csrfToken,
}));
mock.module('../src/kernel/client', () => ({
  kernelClient: () =>
    createKernelClient('https://kernel.test', {
      fetch: (async (url, init) => {
        calls.push(new Request(url, init));
        return Response.json({ code: 'not_found' }, { status: 404 });
      }) as typeof fetch,
    }),
}));
const { readKnowledgeHistoryVisit, readKnowledgeHistoryComparisonVisit } =
  await import('../src/knowledge/private-server');

test('prepared history BFF derives account and rejects replaced viewer/CSRF, sign-out and invalid operands before native reads', async () => {
  const expected = { viewer, csrfToken };
  const data = { address: { ...address, accountId: 'untrusted-owner' }, expected, cursor: 'opaque +/= cursor', pair };
  expect(await readKnowledgeHistoryVisit({ data })).toMatchObject({ state: 'not-found' });
  expect(await readKnowledgeHistoryComparisonVisit({ data })).toMatchObject({ state: 'not-found' });
  expect(calls).toHaveLength(2);
  expect(headers.get('cache-control')).toBe('private, no-store');
  expect(new URL(calls[0]!.url).pathname).toContain(`/accounts/${viewer}/knowledge/`);
  expect(new URL(calls[0]!.url).searchParams.get('cursor')).toBe(data.cursor);
  expect(calls[1]!.headers.get('authorization')).toBe('Bearer prepared-author');
  csrfToken = 'replaced-csrf';
  expect(await readKnowledgeHistoryVisit({ data })).toEqual({ state: 'retired' });
  expect(await readKnowledgeHistoryComparisonVisit({ data })).toEqual({ state: 'retired' });
  csrfToken = expected.csrfToken;
  identity = pair.rightRevisionId;
  expect(await readKnowledgeHistoryVisit({ data })).toEqual({ state: 'retired' });
  identity = null;
  expect(await readKnowledgeHistoryComparisonVisit({ data })).toEqual({ state: 'signed-out' });
  expect(calls).toHaveLength(2);
  expect(() => readKnowledgeHistoryVisit({ data: { ...data, cursor: '' } })).toThrow(
    'Invalid Knowledge history cursor',
  );
  expect(() =>
    readKnowledgeHistoryComparisonVisit({ data: { ...data, pair: { ...pair, rightRevisionId: pair.leftRevisionId } } }),
  ).toThrow('Invalid Knowledge comparison pair');
});
