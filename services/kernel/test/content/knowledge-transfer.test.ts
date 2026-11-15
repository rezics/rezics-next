import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import { fromPlainText, normalizeDocument, serializeDocument } from '@rezics/document';
import {
  canonicalKnowledgeJson,
  KNOWLEDGE_REFERENCE_DEFINITION,
  parseKnowledgeExport,
} from '../../src/content/knowledge-portable.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';
import { copyKnowledgeDocument, exportKnowledgeDocument } from '../../src/content/knowledge-transfer.ts';
import * as knowledgeReads from '../../src/content/knowledge-reads.ts';
import { routeOf } from '../../src/route/route.ts';
import { ACCESS_EVIDENCE_TTL_MS } from '../../src/access/evidence-deadline.ts';

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

async function pausePublicRead<T>(start: () => Promise<T>, mutateCaller: () => void | Promise<void>): Promise<T> {
  const original = knowledgeReads.readKnowledgePublicDocument;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reader = spyOn(knowledgeReads, 'readKnowledgePublicDocument').mockImplementation(async (...args) => {
    const selected = await original(...args);
    enter();
    await wait;
    return selected;
  });
  const pending = start();
  try {
    await Promise.race([
      entered,
      pending.then(() => {
        throw new Error('The native source read was not observed');
      }),
    ]);
    await mutateCaller();
    release();
    return await pending;
  } finally {
    release();
    await pending.catch(() => undefined);
    reader.mockRestore();
  }
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
    body: normalizeDocument({
      version: 'rezics-document-v1',
      profile: 'blocks',
      doc: {
        type: 'doc',
        content: [
          { type: 'paragraph', attrs: { id: 'theorem' }, content: [{ type: 'text', text: 'Referenced theorem' }] },
          {
            type: 'image',
            attrs: { id: 'private-theorem-figure', src: 'https://private.example/theorem?token=hidden' },
          },
        ],
      },
    }),
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
  const targetOwn = await fixture.call('GET', ownDocument(notebook.notebookId, target.documentId));
  expect(targetRead.value.document.sourceSha256).toBe(targetOwn.value.document.sha256);
  expect(targetRead.value.document.sha256).not.toBe(targetRead.value.document.sourceSha256);
  const references = [
    {
      id: 'theorem-reference',
      role: 'cites' as const,
      sourceBlockId: 'statement',
      target: {
        kind: 'revision' as const,
        documentId: target.documentId,
        revisionId: target.revisionId,
        sha256: targetRead.value.document.sourceSha256,
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
  if (publicEnvelope.selection.representation !== 'public') throw new Error('Expected the exact public selection');
  expect(publicEnvelope.selection.publicationId).toBe(published.publicationId);
  expect(publicEnvelope.selection.sourceSha256).toBe(authoring.selection.sha256);
  expect(publicEnvelope.selection.sha256).not.toBe(publicEnvelope.selection.sourceSha256);
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
  const publicCopyKey = crypto.randomUUID();
  const publicCopyResult = await fixture.call('POST', copyPath, publicCopyInput, { key: publicCopyKey });
  expect(publicCopyResult.status, JSON.stringify(publicCopyResult.value)).toBe(201);
  const publicCopy = publicCopyResult.value;
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
  const laterDestination = await fixture.command(`/v1/knowledge/notebooks/${destination.notebookId}/documents`, {
    ...input('A later independent destination edit'),
    expectedStructureRevisionId: publicCopy.structureRevisionId,
    parentPlacementId: null,
  });
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
        expectedStructureRevisionId: laterDestination.structureRevisionId,
      })
    ).status,
  ).toBe(404);
  const unavailableSource = spyOn(knowledgeReads, 'readKnowledgePublicDocument').mockImplementation(async () => {
    throw new Error('Receipt replay must not re-export the withdrawn source');
  });
  try {
    const replay = await fixture.call('POST', copyPath, publicCopyInput, { key: publicCopyKey });
    expect(replay).toEqual(publicCopyResult);
    const lifecycle = await fixture.call('GET', `${ownDocument(destination.notebookId, copied.documentId)}/lifecycle`);
    expect(lifecycle.status).toBe(200);
    await fixture.command(
      `/v1/knowledge/documents/${copied.documentId}:trash`,
      {
        expectedStructureRevisionId: laterDestination.structureRevisionId,
        expectedGeneration: lifecycle.value.generation,
      },
      200,
    );
    expect((await fixture.call('POST', copyPath, publicCopyInput, { key: publicCopyKey })).status).toBe(404);
  } finally {
    unavailableSource.mockRestore();
  }
});

test('export and copy retain their selected representation and destination when caller objects change during a native read', async () => {
  const { subject } = await fixture.command('/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Exact transfer intent' },
  });
  const notebookIntent = { subjectId: subject.id, title: 'Sources with an uncertain first acknowledgement' };
  const notebookKey = crypto.randomUUID();
  const firstNotebook = await fixture.call('POST', '/v1/knowledge/notebooks', notebookIntent, { key: notebookKey });
  expect(firstNotebook.status, JSON.stringify(firstNotebook.value)).toBe(201);
  const recoveredNotebook = await fixture.call('POST', '/v1/knowledge/notebooks', notebookIntent, { key: notebookKey });
  expect(recoveredNotebook).toEqual(firstNotebook);
  expect(
    (
      await fixture.call(
        'POST',
        '/v1/knowledge/notebooks',
        { ...notebookIntent, title: 'Changed intent' },
        { key: notebookKey },
      )
    ).status,
  ).toBe(422);
  const notebookCount = await fixture.pool.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM content.knowledge_notebook WHERE route=$1 AND owner_account_id=$2 AND subject_id=$3',
    [routeOf(fixture.author.actor.accountId), fixture.author.actor.accountId, subject.id],
  );
  expect(notebookCount.rows[0]?.count).toBe(1);
  const sourceNotebook = recoveredNotebook.value;
  const source = await fixture.command(`/v1/knowledge/notebooks/${sourceNotebook.notebookId}/documents`, {
    ...input('Selected source'),
    expectedStructureRevisionId: sourceNotebook.structureRevisionId,
    parentPlacementId: null,
  });
  const publication = await fixture.command(
    `/v1/knowledge/documents/${source.documentId}/publication:select`,
    {
      expectedHeadRevisionId: source.revisionId,
      expectedPublicationId: null,
      revisionId: source.revisionId,
    },
    200,
  );
  const destination = await fixture.command('/v1/knowledge/notebooks', { subjectId: subject.id, title: 'Destination' });
  const parent = await fixture.command(`/v1/knowledge/notebooks/${destination.notebookId}/documents`, {
    ...input('Independent parent'),
    expectedStructureRevisionId: destination.structureRevisionId,
    parentPlacementId: null,
  });
  const deps = {
    pool: fixture.pool,
    access: fixture.system.access,
    tokens: fixture.system.tokenKeys,
    routeKey: fixture.system.routeKey,
    clock: () => new Date(),
  };
  const sourceSelection = {
    representation: 'public' as const,
    documentId: source.documentId as string,
    revisionId: source.revisionId as string,
  };
  const exported = await pausePublicRead(
    async () => {
      const deadline = Date.now() + 120_000;
      const actor = await fixture.system.access.authenticate(fixture.author.bearer, { pool: fixture.pool, deadline });
      return exportKnowledgeDocument(deps, sourceSelection, { actor, deadline });
    },
    () => {
      Object.assign(sourceSelection, { representation: 'authoring' });
    },
  );
  expect(exported.value.representation).toBe('public');
  expect(exported.value.selection).toMatchObject({
    representation: 'public',
    publicationId: publication.publicationId,
  });
  const copyingInput = {
    source: {
      representation: 'public' as const,
      documentId: source.documentId as string,
      revisionId: source.revisionId as string,
    },
    expectedStructureRevisionId: parent.structureRevisionId as string,
    parentPlacementId: null as string | null,
  };
  const copied = await pausePublicRead(
    async () => {
      const deadline = Date.now() + 120_000;
      const actor = await fixture.system.access.authenticate(fixture.author.bearer, { pool: fixture.pool, deadline });
      return copyKnowledgeDocument(deps, actor, destination.notebookId, copyingInput, {
        deadline,
        idempotencyKey: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
      });
    },
    async () => {
      copyingInput.parentPlacementId = parent.placementId;
      await Bun.sleep(ACCESS_EVIDENCE_TTL_MS + 50);
    },
  );
  const location = await fixture.pool.query<{ parent_id: string | null }>(
    'SELECT parent_id FROM content.knowledge_placement WHERE route=$1 AND notebook_id=$2 AND document_id=$3',
    [routeOf(copied.value.documentId), destination.notebookId, copied.value.documentId],
  );
  expect(location.rows[0]?.parent_id).toBeNull();
  expect(copied.value.documentId).not.toBe(source.documentId);
});
