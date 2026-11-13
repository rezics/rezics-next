import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText, normalizeDocument } from '@rezics/document';
import { KNOWLEDGE_REFERENCE_DEFINITION, type KnowledgeReference } from '../../src/content/knowledge-portable.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';

setDefaultTimeout(180_000);
let fixture: Awaited<ReturnType<typeof postPublicationFixture>>;
beforeAll(async () => {
  fixture = await postPublicationFixture();
});
afterAll(async () => {
  await fixture?.close();
});

function block(text: string, id: string, referenceId?: string) {
  return normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id },
          content: [
            { type: 'text', text },
            ...(referenceId
              ? [
                  {
                    type: 'extensionInline',
                    attrs: {
                      id: 'citation',
                      definition: KNOWLEDGE_REFERENCE_DEFINITION,
                      version: '1',
                      payload: { referenceId },
                      fallback: 'Public revision A',
                    },
                  },
                ]
              : []),
          ],
        },
      ],
    },
  });
}

const input = (title: string, body = fromPlainText(title), references: KnowledgeReference[] = []) => ({
  title,
  body,
  licence: 'MIT',
  language: 'en',
  subjectIds: [],
  references,
});

test('exact citations survive publication updates, close on withdrawal and reopen only on reselection', async () => {
  const { subject } = await fixture.command('/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Publication history' },
  });
  const notebook = await fixture.command('/v1/knowledge/notebooks', { subjectId: subject.id, title: 'Research' });
  const document = await fixture.command('/v1/knowledge/notebooks/' + notebook.notebookId + '/documents', {
    ...input('A', block('A body', 'a-block')),
    expectedStructureRevisionId: notebook.structureRevisionId,
    parentPlacementId: null,
  });
  const publicationPath = '/v1/knowledge/documents/' + document.documentId + '/publication:select';
  const revise = (head: string, title: string, body?: ReturnType<typeof block>, refs?: KnowledgeReference[]) =>
    fixture.command(
      '/v1/knowledge/documents/' + document.documentId + '/revisions:revise',
      { ...input(title, body, refs), expectedHeadRevisionId: head },
      200,
    );
  const publish = (head: string, publication: string | null, revision: string | null) =>
    fixture.command(
      publicationPath,
      {
        expectedHeadRevisionId: head,
        expectedPublicationId: publication,
        revisionId: revision,
      },
      200,
    );
  const read = (revision?: string) =>
    fixture.call(
      'GET',
      '/v1/knowledge/documents/' + document.documentId + (revision ? '?revisionId=' + revision : ''),
      undefined,
      { anonymous: true },
    );

  const privateP = await revise(document.revisionId, 'P');
  const publicationA = await publish(privateP.revisionId, null, document.revisionId);
  const a = await read(document.revisionId);
  const citation: KnowledgeReference = {
    id: 'cite-a',
    role: 'cites',
    sourceBlockId: 'b-block',
    target: {
      kind: 'revision',
      documentId: document.documentId,
      revisionId: document.revisionId,
      sha256: a.value.document.sha256,
      blockId: 'a-block',
    },
  };
  const revisionB = await revise(privateP.revisionId, 'B', block('B body', 'b-block', citation.id), [citation]);
  const publicationB = await publish(revisionB.revisionId, publicationA.publicationId, revisionB.revisionId);

  const liveB = await read();
  expect(liveB.value.document).toMatchObject({
    revisionId: revisionB.revisionId,
    publicationId: publicationB.publicationId,
  });
  expect(liveB.value.document.references).toEqual([citation]);
  expect((await read(document.revisionId)).value.document).toMatchObject({
    revisionId: document.revisionId,
    publicationId: publicationA.publicationId,
    sha256: a.value.document.sha256,
  });
  expect((await read(privateP.revisionId)).status).toBe(404);

  const exportA = await fixture.call(
    'GET',
    '/v1/knowledge/documents/' + document.documentId + '/export?revisionId=' + document.revisionId,
    undefined,
    { anonymous: true },
  );
  expect(exportA.value.selection).toMatchObject({
    revisionId: document.revisionId,
    publicationId: publicationA.publicationId,
    sha256: a.value.document.sha256,
  });
  const destination = await fixture.command('/v1/knowledge/notebooks', {
    subjectId: subject.id,
    title: 'Copies',
  });
  const copy = await fixture.command('/v1/knowledge/notebooks/' + destination.notebookId + '/documents:copy', {
    source: { representation: 'public', documentId: document.documentId, revisionId: document.revisionId },
    expectedStructureRevisionId: destination.structureRevisionId,
    parentPlacementId: null,
  });
  await fixture.command(
    '/v1/knowledge/documents/' + copy.documentId + '/publication:select',
    {
      expectedHeadRevisionId: copy.revisionId,
      expectedPublicationId: null,
      revisionId: copy.revisionId,
    },
    200,
  );
  const copied = await fixture.call('GET', '/v1/knowledge/documents/' + copy.documentId, undefined, {
    anonymous: true,
  });
  expect(copied.value.document.provenance).toEqual(exportA.value.selection);

  await publish(revisionB.revisionId, publicationB.publicationId, null);
  expect((await read(document.revisionId)).status).toBe(404);
  expect((await read(revisionB.revisionId)).status).toBe(404);
  expect(
    (await fixture.call('GET', '/v1/knowledge/documents/' + copy.documentId, undefined, { anonymous: true })).value
      .document.provenance,
  ).toBeNull();
  const republishedB = await publish(revisionB.revisionId, null, revisionB.revisionId);
  expect((await read(document.revisionId)).status).toBe(404);
  expect((await read(revisionB.revisionId)).value.document.publicationId).toBe(republishedB.publicationId);
  const reselectedA = await publish(revisionB.revisionId, republishedB.publicationId, document.revisionId);
  expect((await read(document.revisionId)).value.document.publicationId).toBe(reselectedA.publicationId);
});
