import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { serializeDocument } from '@rezics/document';
import { operationIsAdmitted } from '../src/kernel/exposure';
import {
  admitKnowledgeHistory,
  parseKnowledgeHistoryCursor,
  parseKnowledgeHistoryPair,
  readKnowledgeHistory,
  readKnowledgeHistoryComparison,
} from '../src/knowledge/history';
import {
  knowledgeBody,
  knowledgeDocumentId as documentId,
  knowledgeRevisionId as leftRevisionId,
  knowledgeOtherRevisionId as rightRevisionId,
  knowledgeSubjectId,
} from '../src/stories/knowledge-document-fixtures';

test('history and comparison require their own exact exposure admission', () => {
  for (const operation of ['knowledge_document.history', 'knowledge_document.compare'] as const) {
    expect(operationIsAdmitted(operation, undefined)).toBe(false);
    expect(operationIsAdmitted(operation, ['knowledge_document.private_read'])).toBe(false);
    expect(operationIsAdmitted(operation, [operation])).toBe(true);
  }
  expect(operationIsAdmitted('knowledge_document.history', ['knowledge_document.compare'])).toBe(false);
  expect(operationIsAdmitted('knowledge_document.compare', ['knowledge_document.history'])).toBe(false);
});

const input = {
  accountId: '0192f3a0-6c1e-7b2a-9d4e-000000000099',
  notebookId: '0192f3a0-6c1e-7b2a-9d4e-000000000010',
  documentId,
  authorization: 'Bearer private-history',
  leftRevisionId,
  rightRevisionId,
};
function body(revisionId: string) {
  const source = serializeDocument(knowledgeBody('Source remains exact: \\alpha + 漢字\n'));
  const bytes = Buffer.from(source);
  return {
    documentId,
    revisionId,
    title: 'Exact saved revision',
    language: 'en',
    licence: 'CC-BY-4.0',
    subjectIds: [knowledgeSubjectId],
    canonicalBytes: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    references: [
      {
        id: 'ref-1',
        role: 'cites',
        target: {
          kind: 'revision',
          documentId,
          revisionId: leftRevisionId,
          sha256: 'b'.repeat(64),
          blockId: 'source-block',
        },
      },
    ],
    provenance: null,
  };
}
function row(revisionId: string) {
  return {
    revisionId,
    title: revisionId,
    language: null,
    licence: 'CC-BY-4.0',
    sha256: 'a'.repeat(64),
    createdAt: '2026-11-01T12:00:00.000Z',
  };
}
function wire(respond: (request: Request) => Response) {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (url, init) => {
      const request = new Request(url, init);
      calls.push(request);
      return respond(request);
    }) as typeof fetch,
  });
  return { client, calls };
}

test('generated history reads one bounded metadata page, native order and opaque continuation without row requests', async () => {
  const cursor = 'opaque +/= token';
  const dto = { documentId, revisions: [row(rightRevisionId), row(leftRevisionId)], next: cursor };
  const { client, calls } = wire(() => Response.json(dto));
  expect(await readKnowledgeHistory(client, { ...input, cursor: null })).toEqual({ state: 'ready', page: dto });
  expect(await readKnowledgeHistory(client, { ...input, cursor })).toEqual({ state: 'ready', page: dto });
  expect(calls).toHaveLength(2);
  for (const [index, request] of calls.entries()) {
    const url = new URL(request.url);
    expect(url.pathname).toBe(
      `/v1/accounts/${input.accountId}/knowledge/notebooks/${input.notebookId}/documents/${documentId}/history`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual(index ? { limit: '20', cursor } : { limit: '20' });
    expect(request.headers.get('authorization')).toBe(input.authorization);
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('manual');
  }
  expect(admitKnowledgeHistory({ documentId, revisions: [], next: cursor }, documentId)).toMatchObject({
    state: 'ready',
    page: { revisions: [], next: cursor },
  });
  expect(admitKnowledgeHistory({ documentId, revisions: [], next: null }, documentId)).toMatchObject({
    state: 'ready',
    page: { revisions: [], next: null },
  });
});

test('comparison sends exact oriented operands once and preserves canonical source, digest and references', async () => {
  const left = body(rightRevisionId);
  const right = body(leftRevisionId);
  const { client, calls } = wire(() => Response.json({ documentId, left, right }));
  const result = await readKnowledgeHistoryComparison(client, {
    ...input,
    leftRevisionId: rightRevisionId,
    rightRevisionId: leftRevisionId,
  });
  expect(calls).toHaveLength(1);
  const url = new URL(calls[0]!.url);
  expect(url.pathname.endsWith('/compare')).toBe(true);
  expect(Object.fromEntries(url.searchParams)).toEqual({
    leftRevisionId: rightRevisionId,
    rightRevisionId: leftRevisionId,
  });
  expect(calls[0]!.headers.get('authorization')).toBe(input.authorization);
  expect(calls[0]!.cache).toBe('no-store');
  expect(result.state).toBe('ready');
  if (result.state !== 'ready') throw new Error('comparison missing');
  expect(result.comparison.left.source).toBe(Buffer.from(left.canonicalBytes, 'base64').toString('utf8'));
  expect(result.comparison.left.references).toEqual(left.references);
  expect(result.comparison.left.revisionId).toBe(rightRevisionId);
  expect(result.comparison.right.revisionId).toBe(leftRevisionId);
});

test('history and comparison refuse malformed external identities, bounds, digests and native authorization failures', async () => {
  expect(parseKnowledgeHistoryCursor('')).toBeUndefined();
  expect(parseKnowledgeHistoryCursor('x'.repeat(4097))).toBeUndefined();
  expect(parseKnowledgeHistoryPair({ leftRevisionId, rightRevisionId: leftRevisionId })).toBeNull();
  expect(parseKnowledgeHistoryPair({ leftRevisionId: 'current', rightRevisionId })).toBeNull();
  for (const dto of [
    { documentId: input.notebookId, revisions: [], next: null },
    { documentId, revisions: Array.from({ length: 21 }, () => row(leftRevisionId)), next: null },
    { documentId, revisions: [{ ...row(leftRevisionId), createdAt: 'today' }], next: null },
    { documentId, revisions: [], next: '' },
  ])
    expect(admitKnowledgeHistory(dto, documentId)).toMatchObject({ state: 'unavailable', status: 502 });
  for (const left of [
    body(rightRevisionId),
    { ...body(leftRevisionId), documentId: input.notebookId },
    { ...body(leftRevisionId), sha256: '0'.repeat(64) },
    {
      ...body(leftRevisionId),
      references: [{ id: 'bad', role: 'cites', target: { kind: 'revision', revisionId: 'latest' } }],
    },
  ]) {
    const { client } = wire(() => Response.json({ documentId, left, right: body(rightRevisionId) }));
    expect(await readKnowledgeHistoryComparison(client, input)).toMatchObject({ state: 'unavailable', status: 502 });
  }
  for (const [status, state] of [
    [401, 'denied'],
    [403, 'denied'],
    [404, 'not-found'],
    [409, 'stale'],
    [503, 'unavailable'],
  ] as const) {
    const { client, calls } = wire(() => Response.json({ code: 'native_refusal' }, { status }));
    expect(await readKnowledgeHistory(client, { ...input, cursor: null })).toMatchObject({ state, status });
    expect(await readKnowledgeHistoryComparison(client, input)).toMatchObject({ state, status });
    expect(calls).toHaveLength(2);
  }
});
