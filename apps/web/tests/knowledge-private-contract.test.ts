import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { serializeDocument } from '@rezics/document';
import {
  admitKnowledgePrivateHead,
  createKnowledgePrivateDocument,
  createKnowledgePrivateNotebook,
  isKnowledgeId,
  parseKnowledgePrivateAddress,
  parseKnowledgePrivateSubjectSearch,
  readKnowledgePrivateHead,
  reviseKnowledgePrivateDocument,
  type KnowledgePrivateAddress,
} from '../src/knowledge/private-knowledge';
import {
  knowledgeBody,
  knowledgeDocumentId,
  knowledgeRevisionId,
  knowledgeSubjectId,
} from '../src/stories/knowledge-document-fixtures';

const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000098';
const notebookId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const documentId = knowledgeDocumentId;
const revisionId = knowledgeRevisionId;
const nextRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const structureRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000012';
const idempotencyKey = '0192f3a0-6c1e-7b2a-9d4e-000000000013';
const authorization = 'Bearer private-writer-token';
const address: KnowledgePrivateAddress = { notebookId, documentId };

async function privateDocument(overrides: Record<string, unknown> = {}) {
  const bytes = Buffer.from(serializeDocument(knowledgeBody()), 'utf8');
  return {
    document: {
      notebookId,
      documentId,
      revisionId,
      publicationId: null,
      title: 'A private note',
      language: 'en',
      canonicalBytes: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      licence: 'LicenseRef-rezics-terms',
      subjectIds: [knowledgeSubjectId],
      ...overrides,
    },
  };
}

function clientFor(respond: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return respond(request);
    }) as typeof fetch,
  });
  return { calls, client };
}

test('private route boundaries accept only explicit native UUID addresses', () => {
  expect(isKnowledgeId(documentId)).toBe(true);
  expect(parseKnowledgePrivateSubjectSearch({ subjectId: knowledgeSubjectId })).toEqual({
    subjectId: knowledgeSubjectId,
  });
  expect(parseKnowledgePrivateSubjectSearch({ subjectId: 'current' })).toBeNull();
  expect(parseKnowledgePrivateSubjectSearch({})).toBeNull();
  expect(parseKnowledgePrivateAddress(address)).toEqual(address);
  expect(parseKnowledgePrivateAddress({ notebookId, documentId: 'latest' })).toBeNull();
  expect(parseKnowledgePrivateAddress({ notebookId, documentId, accountId })).toEqual(address);
});

test('exact private head uses account-derived native route, no-store and canonical parser', async () => {
  const dto = await privateDocument();
  const { calls, client } = clientFor((request) => {
    expect(request.method).toBe('GET');
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('manual');
    expect(request.headers.get('authorization')).toBe(authorization);
    return Response.json(dto);
  });
  const result = await readKnowledgePrivateHead(client, { ...address, accountId, authorization });
  expect(result.state).toBe('ready');
  if (result.state !== 'ready') throw new Error('expected current private head');
  expect(result.head).toMatchObject({ accountId, ...address, revisionId, title: 'A private note' });
  expect(JSON.stringify(result.head.body)).toContain('selected public knowledge');
  expect(new URL(calls[0]!.url).pathname).toBe(
    `/v1/accounts/${accountId}/knowledge/notebooks/${notebookId}/documents/${documentId}`,
  );
  expect(await admitKnowledgePrivateHead(404, {}, { ...address, accountId })).toEqual({
    state: 'not-found',
    status: 404,
  });
  expect(await admitKnowledgePrivateHead(403, {}, { ...address, accountId })).toEqual({
    state: 'denied',
    status: 403,
  });
  expect(await admitKnowledgePrivateHead(503, {}, { ...address, accountId })).toEqual({
    state: 'unavailable',
    status: 503,
  });
  for (const bad of [
    await privateDocument({ documentId: notebookId }),
    await privateDocument({ notebookId: accountId }),
    await privateDocument({ canonicalBytes: 'not-base64' }),
    await privateDocument({ sha256: '0'.repeat(64) }),
    await privateDocument({ title: '' }),
    await privateDocument({ language: 1 }),
    await privateDocument({ publicationId: 'invalid' }),
    await privateDocument({ publicationId: undefined }),
    await privateDocument({ subjectIds: ['not-a-uuid'] }),
    { document: null },
  ]) {
    expect((await admitKnowledgePrivateHead(200, bad, { ...address, accountId })).state).toBe('unavailable');
  }
});

test('native command receipts anchor root creation and observed-head revision CAS', async () => {
  const requests: Request[] = [];
  const status = 201;
  const { client } = clientFor(async (request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === '/v1/knowledge/notebooks') return Response.json({ notebookId, structureRevisionId }, { status });
    if (path === `/v1/knowledge/notebooks/${notebookId}/documents`)
      return Response.json({ notebookId, documentId, revisionId, structureRevisionId: nextRevisionId }, { status });
    if (path === `/v1/knowledge/documents/${documentId}/revisions`)
      return Response.json({ documentId, revisionId: nextRevisionId }, { status: 200 });
    return new Response(null, { status: 404 });
  });

  const notebook = await createKnowledgePrivateNotebook(client, {
    subjectId: knowledgeSubjectId,
    title: 'Reviewed private notebook',
    idempotencyKey,
    authorization,
  });
  expect(notebook).toEqual({ state: 'acknowledged', receipt: { notebookId, structureRevisionId } });

  const creation = await createKnowledgePrivateDocument(client, {
    notebookId,
    structureRevisionId,
    subjectId: knowledgeSubjectId,
    title: 'Reviewed private note',
    language: 'en',
    body: knowledgeBody(),
    licence: 'LicenseRef-rezics-terms',
    idempotencyKey,
    authorization,
  });
  expect(creation).toEqual({
    state: 'acknowledged',
    receipt: { notebookId, documentId, revisionId, structureRevisionId: nextRevisionId },
  });
  const creationRequest = requests[1]!;
  expect(creationRequest.headers.get('authorization')).toBe(authorization);
  expect(creationRequest.headers.get('idempotency-key')).toBe(JSON.stringify(idempotencyKey));
  expect(await creationRequest.json()).toMatchObject({
    expectedStructureRevisionId: structureRevisionId,
    parentPlacementId: null,
    subjectIds: [knowledgeSubjectId],
  });

  const revision = await reviseKnowledgePrivateDocument(client, {
    documentId,
    expectedHeadRevisionId: revisionId,
    title: 'Reviewed private revision',
    language: 'en',
    body: knowledgeBody('A reviewed draft sent against the observed head.'),
    licence: 'LicenseRef-rezics-terms',
    subjectIds: [knowledgeSubjectId],
    idempotencyKey,
    authorization,
  });
  expect(revision).toEqual({
    state: 'acknowledged',
    receipt: { documentId, revisionId: nextRevisionId },
  });
  const revisionRequest = requests[2]!;
  expect(revisionRequest.headers.get('idempotency-key')).toBe(JSON.stringify(idempotencyKey));
  expect(await revisionRequest.json()).toMatchObject({
    expectedHeadRevisionId: revisionId,
    subjectIds: [knowledgeSubjectId],
  });

  const conflictClient = createKernelClient('https://kernel.test', {
    fetch: (async () => Response.json({ status: 412 }, { status: 412 })) as typeof fetch,
  });
  expect(
    await reviseKnowledgePrivateDocument(conflictClient, {
      documentId,
      expectedHeadRevisionId: revisionId,
      title: 'Retained draft',
      language: 'en',
      body: knowledgeBody(),
      licence: 'LicenseRef-rezics-terms',
      subjectIds: [knowledgeSubjectId],
      idempotencyKey,
      authorization,
    }),
  ).toEqual({ state: 'conflict', status: 412 });

  const missingReceipt = createKernelClient('https://kernel.test', {
    fetch: (async () => Response.json({ notebookId }, { status: 201 })) as typeof fetch,
  });
  expect(
    await createKnowledgePrivateNotebook(missingReceipt, {
      subjectId: knowledgeSubjectId,
      title: 'Unknown notebook command outcome',
      idempotencyKey,
      authorization,
    }),
  ).toEqual({ state: 'uncertain' });
});
