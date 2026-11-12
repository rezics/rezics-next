import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  admitKnowledgeLifecycle,
  changeKnowledgeLifecycle,
  knowledgeRestoreExpired,
  readKnowledgeLifecycle,
  reviewKnowledgeLifecycle,
  type KnowledgeLifecycle,
} from '../src/knowledge/lifecycle';

const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const address = {
  notebookId: '0192f3a0-6c1e-7b2a-9d4e-000000000010',
  documentId: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
};
const active: KnowledgeLifecycle = {
  ...address,
  structureRevisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
  generation: '0',
  state: 'active',
  restoreUntil: null,
};
const trashed: KnowledgeLifecycle = {
  ...active,
  generation: '1',
  state: 'trashed',
  restoreUntil: '2099-12-01T00:00:00.000Z',
};
const binding = { viewer: accountId, csrfToken: 'csrf', credential: 'sealed-credential' };
const authorization = 'Bearer prepared-owner';
function native(respond: (request: Request) => Response | Promise<Response>) {
  return createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => respond(new Request(input, init))) as typeof fetch,
  });
}

test('lifecycle read uses the explicit owner address and admits metadata only', async () => {
  const client = native((request) => {
    expect(new URL(request.url).pathname).toBe(
      `/v1/accounts/${accountId}/knowledge/notebooks/${address.notebookId}/documents/${address.documentId}/lifecycle`,
    );
    expect(request.method).toBe('GET');
    expect(request.headers.get('authorization')).toBe(authorization);
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('manual');
    return Response.json({ ...trashed, title: 'must not enter lifecycle state', publicationId: 'untrusted' });
  });
  expect(await readKnowledgeLifecycle(client, { ...address, accountId, authorization })).toEqual({
    state: 'ready',
    lifecycle: trashed,
  });
  for (const change of [
    { notebookId: accountId },
    { documentId: accountId },
    { structureRevisionId: 'latest' },
    { generation: '-1' },
    { generation: '01' },
    { generation: 1 },
    { state: 'purged' },
    { restoreUntil: null },
    { restoreUntil: 'tomorrow' },
  ])
    expect(admitKnowledgeLifecycle({ ...trashed, ...change }, address)).toBeNull();
  expect(admitKnowledgeLifecycle({ ...active, restoreUntil: trashed.restoreUntil }, address)).toBeNull();
  expect(knowledgeRestoreExpired(trashed, Date.parse(trashed.restoreUntil!))).toBe(true);
  expect(knowledgeRestoreExpired(trashed, Date.parse(trashed.restoreUntil!) - 1)).toBe(false);
});

test('trash and restore send native CAS and preserve exact idempotency on replay', async () => {
  for (const action of ['trash', 'restore'] as const) {
    const intent = reviewKnowledgeLifecycle(action === 'trash' ? active : trashed, binding, action);
    const calls: string[] = [];
    const next = action === 'trash' ? trashed : { ...active, generation: '2' };
    const client = native(async (request) => {
      const body = await request.text();
      calls.push(body);
      expect(JSON.parse(body)).toEqual({
        expectedStructureRevisionId: intent.expectedStructureRevisionId,
        expectedGeneration: intent.expectedGeneration,
      });
      expect(new URL(request.url).pathname).toBe(`/v1/knowledge/documents/${address.documentId}:${action}`);
      expect(request.method).toBe('POST');
      expect(request.headers.get('authorization')).toBe(authorization);
      expect(JSON.parse(request.headers.get('idempotency-key')!)).toBe(intent.idempotencyKey);
      return Response.json({ ...next, complete: true, reason: null });
    });
    const result = await changeKnowledgeLifecycle(client, { ...intent, authorization });
    expect(result).toEqual({ state: 'acknowledged', receipt: { ...next, complete: true, reason: null } });
    expect(await changeKnowledgeLifecycle(client, { ...intent, authorization })).toEqual(result);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(calls[1]);
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.binding)).toBe(true);
  }
});

test('native subtree refusal is not completion; malformed success is uncertain and failures retain their meaning', async () => {
  const intent = reviewKnowledgeLifecycle(active, binding, 'trash');
  const run = (value: unknown, status = 200) =>
    changeKnowledgeLifecycle(
      native(() => Response.json(value, { status })),
      { ...intent, authorization },
    );
  expect(await run({ ...active, complete: false, reason: 'subtree_work_required' })).toMatchObject({
    state: 'acknowledged',
    receipt: { complete: false },
  });
  for (const value of [
    null,
    { ...active, complete: true, reason: null },
    { ...trashed, complete: false, reason: null },
    { ...trashed, notebookId: accountId, complete: true, reason: null },
  ])
    expect(await run(value)).toEqual({ state: 'uncertain' });
  for (const [status, state] of [
    [403, 'denied'],
    [404, 'not-found'],
    [412, 'conflict'],
    [503, 'unavailable'],
  ] as const)
    expect(await run({}, status)).toEqual({ state, status });
});
