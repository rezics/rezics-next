import { expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createKernelClient } from '@rezics/client';
import { fromPlainText, serializeDocument } from '@rezics/document';
import * as start from '../.storybook/react-start';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { admitKnowledgePrivateHead, createKnowledgePrivateDocument, reviseKnowledgePrivateDocument } =
  await import('../src/knowledge/private-knowledge');
const { admitKnowledgePublicResponse } = await import('../src/knowledge/public-read');
const { inspectKnowledgeReference } = await import('../src/knowledge/reference-read');
const { admitReferenceManifest, appendReferenceComponent, referenceIssues, repairReference, writeReference } =
  await import('../src/knowledge/reference-model');
const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const notebookId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const documentId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000012';
const otherRevision = '0192f3a0-6c1e-7b2a-9d4e-000000000013';
const authorization = 'Bearer exact-writer';
const address = { accountId, notebookId, documentId };
const request = { documentId, revisionId, locale: 'en' };
function problem() {
  const body = fromPlainText('Problem citing an exact theorem and definition.', 'blocks');
  const sourceBlockId = body.doc.content![0]!.attrs!.id as string;
  let draft = writeReference(
    { body, references: [] },
    {
      id: 'theorem',
      role: 'uses',
      sourceBlockId,
      target: { kind: 'revision', documentId, revisionId, sha256: 'a'.repeat(64), blockId: 'statement' },
    },
    'Theorem',
  );
  draft = writeReference(
    draft,
    {
      id: 'definition',
      role: 'cites',
      target: { kind: 'revision', documentId, revisionId: otherRevision, sha256: 'b'.repeat(64) },
    },
    'Definition',
  );
  return draft;
}
function dto(draft = problem()) {
  const source = serializeDocument(draft.body);
  return {
    document: {
      ...address,
      revisionId,
      publicationId: notebookId,
      title: 'Problem',
      language: 'en',
      licence: 'CC-BY-4.0',
      subjectIds: [notebookId],
      canonicalBytes: Buffer.from(source).toString('base64'),
      sha256: createHash('sha256').update(source).digest('hex'),
      references: draft.references,
      provenance: null,
      subjectId: notebookId,
      publishedAt: '2026-11-13T12:00:00.000Z',
      authorId: null,
    },
  };
}
function clientFor(handle: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  return {
    calls,
    client: createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const req = new Request(input, init);
        calls.push(req);
        return handle(req);
      }) as typeof fetch,
    }),
  };
}
test('exact theorem and definition manifest survives native create, reopen, revise and public projection', async () => {
  const draft = problem();
  const native = dto(draft);
  const bodies: unknown[] = [];
  const { client } = clientFor(async (req) => {
    bodies.push(await req.json());
    return Response.json(
      { documentId, notebookId, revisionId, placementId: notebookId, structureRevisionId: revisionId },
      { status: req.url.includes('revisions') ? 200 : 201 },
    );
  });
  await createKnowledgePrivateDocument(client, {
    ...draft,
    notebookId,
    structureRevisionId: revisionId,
    parentPlacementId: null,
    subjectId: notebookId,
    title: 'Problem',
    language: 'en',
    licence: 'CC-BY-4.0',
    authorization,
    idempotencyKey: documentId,
  });
  const reopened = await admitKnowledgePrivateHead(200, native, address);
  expect(reopened.state).toBe('ready');
  if (reopened.state !== 'ready') return;
  expect(reopened.head.references).toEqual(draft.references);
  expect(reopened.head.source).toBe(serializeDocument(draft.body));
  await reviseKnowledgePrivateDocument(client, {
    ...reopened.head,
    expectedHeadRevisionId: revisionId,
    authorization,
    idempotencyKey: otherRevision,
  });
  expect(bodies.map((body) => (body as { references: unknown }).references)).toEqual([
    draft.references,
    draft.references,
  ]);
  const published = admitKnowledgePublicResponse(200, native, request);
  expect(published.state).toBe('ready');
  if (published.state === 'ready') expect(published.document.references).toEqual(draft.references);
  const hidden = dto({ ...draft, references: draft.references.map((item) => ({ ...item, target: null })) });
  const disclosed = admitKnowledgePublicResponse(200, hidden, request);
  expect(disclosed.state).toBe('ready');
  if (disclosed.state === 'ready')
    expect(disclosed.document.references!.every((item) => item.target === null)).toBe(true);
});
test('copied source blocks remain stable; orphan, duplicate and missing-source repairs are deliberate', () => {
  const original = problem();
  const first = original.references[0]!;
  const edited = writeReference(original, { ...first, role: 'explains' }, 'An authored label, not fetched metadata');
  expect(edited.body.doc.content![0]).toEqual(original.body.doc.content![0]);
  expect(edited.references[0]!.id).toBe(first.id);
  expect(edited.references[0]!.target).toEqual(first.target);
  const orphan = {
    ...edited,
    body: { ...edited.body, doc: { ...edited.body.doc, content: edited.body.doc.content!.slice(0, 1) } },
  };
  expect(referenceIssues(orphan).map((issue) => issue.kind)).toEqual(['orphan', 'orphan']);
  let repaired = orphan;
  for (const issue of referenceIssues(orphan)) repaired = repairReference(repaired, issue);
  expect(admitReferenceManifest(repaired.body, repaired.references)).toEqual(edited.references);
  const duplicate = { ...edited, body: appendReferenceComponent(edited.body, first.id, 'Repeated') };
  const duplicateIssue = referenceIssues(duplicate)[0]!;
  expect(duplicateIssue.kind).toBe('duplicate');
  expect(referenceIssues(repairReference(duplicate, duplicateIssue))).toEqual([]);
  const missing = { ...edited, references: [{ ...first, sourceBlockId: 'removed-source' }, edited.references[1]!] };
  expect(referenceIssues(missing)[0]!.kind).toBe('source');
  expect(repairReference(missing, referenceIssues(missing)[0]!).references[0]!.target).toEqual(first.target);
});
test('HTTP boundary refuses oversized, malformed or mismatched manifests without losing a compatible draft', async () => {
  const draft = problem();
  expect(
    admitReferenceManifest(
      draft.body,
      Array.from({ length: 65 }, (_, i) => ({ ...draft.references[0], id: String(i) })),
    ),
  ).toBeNull();
  for (const references of [
    [...draft.references, draft.references[0]],
    [{ ...draft.references[0], role: 'proves' }],
    [{ ...draft.references[0], target: { kind: 'revision', documentId, revisionId, sha256: 'wrong' } }],
    [],
  ]) {
    expect(
      (await admitKnowledgePrivateHead(200, { document: { ...dto(draft).document, references } }, address)).state,
    ).toBe('unavailable');
    expect(admitKnowledgePublicResponse(200, { document: { ...dto(draft).document, references } }, request).state).toBe(
      'unavailable',
    );
  }
  expect(admitReferenceManifest(draft.body, draft.references)).toEqual(draft.references);
});
test('selected exact inspection sends one native query and never falls back on digest, revision, block or availability failure', async () => {
  const native = dto({ body: fromPlainText('Original theorem assumptions.', 'blocks'), references: [] });
  const target = { kind: 'revision' as const, documentId, revisionId, sha256: native.document.sha256 };
  let response = native;
  const { calls, client } = clientFor(() => Response.json(response));
  expect((await inspectKnowledgeReference(client, { target, locale: 'en', notebookId: null })).state).toBe('ready');
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).searchParams.get('revisionId')).toBe(revisionId);
  expect(calls[0]!.headers.get('authorization')).toBeNull();
  for (const exact of [
    { ...target, sha256: 'f'.repeat(64) },
    { ...target, blockId: 'missing-block' },
  ])
    expect((await inspectKnowledgeReference(client, { target: exact, locale: 'en', notebookId: null })).state).toBe(
      'unavailable',
    );
  response = { document: { ...native.document, revisionId: otherRevision } };
  expect((await inspectKnowledgeReference(client, { target, locale: 'en', notebookId: null })).state).toBe(
    'unavailable',
  );
  response = native;
  expect(
    (await inspectKnowledgeReference(client, { target, locale: 'en', notebookId }, { accountId, authorization })).state,
  ).toBe('ready');
  expect(calls).toHaveLength(5);
  expect(calls[4]!.headers.get('authorization')).toBe(authorization);
  expect(new URL(calls[4]!.url).pathname).toContain(`/accounts/${accountId}/knowledge/notebooks/${notebookId}/`);
  const unavailable = clientFor(() => new Response(null, { status: 404 }));
  expect((await inspectKnowledgeReference(unavailable.client, { target, locale: 'en', notebookId: null })).state).toBe(
    'not-found',
  );
  expect(unavailable.calls).toHaveLength(1);
});
