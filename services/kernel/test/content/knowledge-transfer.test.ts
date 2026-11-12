import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText, normalizeDocument, serializeDocument } from '@rezics/document';
import {
  canonicalKnowledgeJson,
  KNOWLEDGE_REFERENCE_DEFINITION,
  parseKnowledgeExport,
} from '../../src/content/knowledge-portable.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';

setDefaultTimeout(180_000);
let fixture: Awaited<ReturnType<typeof postPublicationFixture>>;
beforeAll(async () => {
  fixture = await postPublicationFixture();
});
afterAll(async () => {
  await fixture?.close();
});

function input(title: string) {
  return { title, body: fromPlainText(title), licence: 'MIT', language: 'en', subjectIds: [] };
}
function ownDocument(notebookId: string, documentId: string) {
  return `/v1/accounts/${fixture.author.actor.accountId}/knowledge/notebooks/${notebookId}/documents/${documentId}`;
}

test('exact owner export/copy and anonymous publication export share permitted selection without sibling or head disclosure', async () => {
  const { subject } = await fixture.command('/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Portable knowledge' },
  });
  const notebook = await fixture.command('/v1/knowledge/notebooks', {
    subjectId: subject.id,
    title: 'Private sources',
  });
  const target = await fixture.command(`/v1/knowledge/notebooks/${notebook.notebookId}/documents`, {
    ...input('Referenced theorem'),
    expectedStructureRevisionId: notebook.structureRevisionId,
    parentPlacementId: null,
  });
  const targetPublication = await fixture.command(
    `/v1/knowledge/documents/${target.documentId}/publication:select`,
    {
      expectedHeadRevisionId: target.revisionId,
      expectedPublicationId: null,
      revisionId: target.revisionId,
    },
    200,
  );
  const targetRead = await fixture.call('GET', `/v1/knowledge/documents/${target.documentId}`);
  const references = [
    {
      id: 'theorem-reference',
      role: 'cites' as const,
      sourceBlockId: 'statement',
      target: {
        kind: 'revision' as const,
        documentId: target.documentId,
        revisionId: target.revisionId,
        sha256: targetRead.value.document.sha256,
        blockId: JSON.parse(Buffer.from(targetRead.value.document.canonicalBytes, 'base64').toString()).doc.content[0]
          .attrs.id,
      },
    },
  ];
  references.push({
    ...references[0]!,
    id: 'missing-reference',
    target: { ...references[0]!.target, blockId: 'missing-block' },
  });
  const body = normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'statement' },
          content: [
            { type: 'text', text: 'Statement', marks: [{ type: 'link', attrs: { href: '#statement' } }] },
            {
              type: 'extensionInline',
              attrs: {
                id: 'citation',
                definition: KNOWLEDGE_REFERENCE_DEFINITION,
                version: '1',
                payload: { referenceId: 'theorem-reference' },
                fallback: 'Referenced theorem',
              },
            },
            {
              type: 'extensionInline',
              attrs: {
                id: 'missing-citation',
                definition: KNOWLEDGE_REFERENCE_DEFINITION,
                version: '1',
                payload: { referenceId: 'missing-reference' },
                fallback: 'Missing block',
              },
            },
          ],
        },
        {
          type: 'extensionBlock',
          attrs: {
            id: 'math',
            definition: 'example.math-source',
            version: '1',
            payload: { source: '\\forall x, x=x' },
            fallback: '\\forall x, x=x',
          },
        },
        { type: 'image', attrs: { id: 'figure', src: 'https://private.example/figure?token=secret' } },
      ],
    },
  });
  const source = await fixture.command(`/v1/knowledge/notebooks/${notebook.notebookId}/documents`, {
    ...input('Selected statement'),
    body,
    references,
    expectedStructureRevisionId: target.structureRevisionId,
    parentPlacementId: null,
  });
  const sibling = await fixture.command(`/v1/knowledge/notebooks/${notebook.notebookId}/documents`, {
    ...input('Hidden sibling'),
    expectedStructureRevisionId: source.structureRevisionId,
    parentPlacementId: null,
  });
  const head = await fixture.command(
    `/v1/knowledge/documents/${source.documentId}/revisions:revise`,
    {
      ...input('Hidden newer head'),
      expectedHeadRevisionId: source.revisionId,
    },
    200,
  );
  const published = await fixture.command(
    `/v1/knowledge/documents/${source.documentId}/publication:select`,
    {
      expectedHeadRevisionId: head.revisionId,
      expectedPublicationId: null,
      revisionId: source.revisionId,
    },
    200,
  );
  const ownPath = `${ownDocument(notebook.notebookId, source.documentId)}/export?revisionId=${source.revisionId}`;
  const own = await fixture.call('GET', ownPath);
  expect(own.status).toBe(200);
  const authoring = parseKnowledgeExport(own.value);
  expect(serializeDocument(authoring.snapshot)).toBe(serializeDocument(body));
  expect(authoring.references).toEqual(references);
  expect(authoring.representation).toBe('authoring');
  expect(authoring.selection.revisionId).toBe(source.revisionId);
  expect((await fixture.call('GET', ownPath, undefined, { other: true })).status).toBe(404);
  expect((await fixture.call('GET', ownPath, undefined, { anonymous: true })).status).toBe(404);
  expect((await fixture.call('GET', `${ownDocument(notebook.notebookId, source.documentId)}/export`)).status).toBe(400);

  const publicPath = `/v1/knowledge/documents/${source.documentId}/export?revisionId=${source.revisionId}`;
  const response = await fixture.system.kernel.handle(new Request(`https://content.test${publicPath}`));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const canonical = await response.text();
  const publicEnvelope = parseKnowledgeExport(JSON.parse(canonical));
  expect(canonical).toBe(canonicalKnowledgeJson(publicEnvelope));
  expect(publicEnvelope.representation).toBe('public');
  expect(publicEnvelope.selection.publicationId).toBe(published.publicationId);
  expect(publicEnvelope.references[0]).toEqual(references[0]);
  expect(publicEnvelope.references[1]!.target).toBeNull();
  expect(canonical).not.toContain('private.example');
  expect(canonical).not.toContain('Hidden newer head');
  expect(canonical).not.toContain(sibling.documentId);
  expect(canonical).not.toContain(notebook.notebookId);
  expect(canonical).not.toContain(fixture.author.actor.accountId);
  expect((await fixture.call('GET', publicPath)).value).toEqual(publicEnvelope);
  expect(
    (await fixture.call('GET', `/v1/knowledge/documents/${source.documentId}/export?revisionId=${head.revisionId}`))
      .status,
  ).toBe(404);
  expect((await fixture.call('GET', `/v1/knowledge/documents/${sibling.documentId}/export`)).status).toBe(404);

  const destination = await fixture.command('/v1/knowledge/notebooks', {
    subjectId: subject.id,
    title: 'Private copies',
  });
  const copyPath = `/v1/knowledge/notebooks/${destination.notebookId}/documents:copy`;
  const copyInput = {
    source: {
      representation: 'authoring',
      accountId: fixture.author.actor.accountId,
      notebookId: notebook.notebookId,
      documentId: source.documentId,
      revisionId: source.revisionId,
    },
    expectedStructureRevisionId: destination.structureRevisionId,
    parentPlacementId: null,
  };
  const key = crypto.randomUUID();
  const copies = await Promise.all([
    fixture.call('POST', copyPath, copyInput, { key }),
    fixture.call('POST', copyPath, copyInput, { key }),
  ]);
  expect(copies.map((copy) => copy.status)).toEqual([201, 201]);
  expect(copies[0]!.value).toEqual(copies[1]!.value);
  const copied = copies[0]!.value;
  expect(copied.documentId).not.toBe(source.documentId);
  expect(copied.revisionId).not.toBe(source.revisionId);
  const copyRead = await fixture.call('GET', ownDocument(destination.notebookId, copied.documentId));
  expect(copyRead.status).toBe(200);
  expect(copyRead.value.document.publicationId).toBeNull();
  const copiedBody = JSON.parse(Buffer.from(copyRead.value.document.canonicalBytes, 'base64').toString('utf8'));
  const paragraph = copiedBody.doc.content[0];
  const copiedReference = copyRead.value.document.references[0];
  expect(paragraph.attrs.id).not.toBe('statement');
  expect(paragraph.content[0].marks[0].attrs.href).toBe(`#${paragraph.attrs.id}`);
  expect(copiedReference.id).not.toBe(references[0]!.id);
  expect(copiedReference.sourceBlockId).toBe(paragraph.attrs.id);
  expect(copiedReference.target).toEqual(references[0]!.target);
  expect(copyRead.value.document.provenance).toEqual(authoring.selection);
  expect(copiedBody.doc.content[1].attrs.payload).toEqual(body.doc.content![1]!.attrs!.payload);
  expect((await fixture.call('GET', `/v1/knowledge/documents/${copied.documentId}`)).status).toBe(404);
  expect((await fixture.call('POST', copyPath, copyInput, { other: true })).status).toBe(404);
  expect((await fixture.call('POST', copyPath, copyInput, { anonymous: true })).status).toBe(401);
  expect((await fixture.call('POST', copyPath, copyInput)).status).toBe(412);
  expect(
    (
      await fixture.call(
        'POST',
        copyPath,
        { ...copyInput, expectedStructureRevisionId: copied.structureRevisionId },
        { key },
      )
    ).status,
  ).toBe(422);

  // Target withdrawal changes only the permitted projection, never the immutable selected source.
  await fixture.command(
    `/v1/knowledge/documents/${target.documentId}/publication:select`,
    {
      expectedHeadRevisionId: target.revisionId,
      expectedPublicationId: targetPublication.publicationId,
      revisionId: null,
    },
    200,
  );
  const withheld = await fixture.call('GET', publicPath, undefined, { anonymous: true });
  expect(withheld.status).toBe(200);
  const projected = parseKnowledgeExport(withheld.value);
  expect(projected.references[0]!.target).toBeNull();
  expect(JSON.stringify(projected)).not.toContain(target.documentId);
  expect(JSON.stringify(projected)).not.toContain('Referenced theorem');
  expect(projected.sha256).not.toBe(publicEnvelope.sha256);
  expect((await fixture.call('GET', ownPath)).value).toEqual(authoring);

  const publicCopyInput = {
    source: { representation: 'public', documentId: source.documentId, revisionId: source.revisionId },
    expectedStructureRevisionId: copied.structureRevisionId,
    parentPlacementId: copied.placementId,
  };
  const publicCopy = await fixture.command(copyPath, publicCopyInput);
  const publicCopyRead = await fixture.call('GET', ownDocument(destination.notebookId, publicCopy.documentId));
  expect(publicCopyRead.value.document.references[0].target).toBeNull();
  expect(Buffer.from(publicCopyRead.value.document.canonicalBytes, 'base64').toString()).not.toContain(
    'private.example',
  );
  expect(publicCopyRead.value.document.provenance).toEqual(projected.selection);
  const evidence = await fixture.pool.query<{ count: number; published: number }>(
    `SELECT count(*)::int AS count,count(current_publication_id)::int AS published FROM content.knowledge_document WHERE notebook_id=$1`,
    [destination.notebookId],
  );
  expect(evidence.rows).toEqual([{ count: 2, published: 0 }]);
  const receipts = await fixture.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM core.receipt WHERE principal_id=$1 AND command_kind='content.knowledge.document.copy'`,
    [fixture.author.actor.accountId],
  );
  expect(receipts.rows).toEqual([{ count: 2 }]);
  await fixture.command(
    `/v1/knowledge/documents/${source.documentId}/publication:select`,
    {
      expectedHeadRevisionId: head.revisionId,
      expectedPublicationId: published.publicationId,
      revisionId: null,
    },
    200,
  );
  expect((await fixture.call('GET', publicPath, undefined, { anonymous: true })).status).toBe(404);
  expect(
    (
      await fixture.call('POST', copyPath, {
        ...publicCopyInput,
        expectedStructureRevisionId: publicCopy.structureRevisionId,
      })
    ).status,
  ).toBe(404);
});
