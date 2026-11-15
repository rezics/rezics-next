import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText, normalizeDocument } from '@rezics/document';
import { KNOWLEDGE_REFERENCE_DEFINITION, type KnowledgeReference } from '../../src/content/knowledge-portable.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';
import { grantAccountActions } from './support/native-board-host.ts';
import { nativeGrantor } from './support/native-system.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';

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
  const { subject: historicalSubject } = await fixture.command('/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Original revision attachment' },
  });
  const document = await fixture.command('/v1/knowledge/notebooks/' + notebook.notebookId + '/documents', {
    ...input('A', block('A body', 'a-block')),
    subjectIds: [historicalSubject.id],
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
      sha256: a.value.document.sourceSha256,
      blockId: 'a-block',
    },
  };
  const revisionB = await revise(privateP.revisionId, 'B', block('B body', 'b-block', citation.id), [citation]);
  const publicationB = await publish(revisionB.revisionId, publicationA.publicationId, revisionB.revisionId);

  // A fresh selection can move the current pointer, while retaining each exact
  // same-generation publication identity and its existing citation binding.
  const reselectionKey = crypto.randomUUID();
  const reselection = {
    expectedHeadRevisionId: revisionB.revisionId,
    expectedPublicationId: publicationB.publicationId,
    revisionId: document.revisionId,
  };
  const sameGenerationA = await fixture.call('POST', publicationPath, reselection, { key: reselectionKey });
  expect(sameGenerationA.status).toBe(200);
  expect(sameGenerationA.value.publicationId).toBe(publicationA.publicationId);
  const unchangedA = await publish(revisionB.revisionId, publicationA.publicationId, document.revisionId);
  expect(unchangedA.publicationId).toBe(publicationA.publicationId);
  const sameGenerationB = await publish(revisionB.revisionId, publicationA.publicationId, revisionB.revisionId);
  expect(sameGenerationB.publicationId).toBe(publicationB.publicationId);
  const replayedA = await fixture.call('POST', publicationPath, reselection, { key: reselectionKey });
  expect(replayedA.status).toBe(200);
  expect(replayedA.value).toEqual(sameGenerationA.value);
  expect((await read()).value.document.publicationId).toBe(publicationB.publicationId);
  const publications = await fixture.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM content.knowledge_publication WHERE route=$1 AND document_id=$2`,
    [routeOf(document.documentId), document.documentId],
  );
  expect(publications.rows[0]!.count).toBe('2');

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
  const copyHead = await fixture.command(
    '/v1/knowledge/documents/' + copy.documentId + '/revisions:revise',
    { ...input('Independent copy'), expectedHeadRevisionId: copy.revisionId },
    200,
  );
  await fixture.command(
    '/v1/knowledge/documents/' + copy.documentId + '/publication:select',
    {
      expectedHeadRevisionId: copyHead.revisionId,
      expectedPublicationId: null,
      revisionId: copyHead.revisionId,
    },
    200,
  );
  const copied = await fixture.call('GET', '/v1/knowledge/documents/' + copy.documentId, undefined, {
    anonymous: true,
  });
  expect(copied.value.document.provenance).toEqual(exportA.value.selection);

  await grantAccountActions(
    fixture.system.kernel,
    nativeGrantor(fixture.system),
    { route: 0, id: GLOBAL_CONTEXT },
    fixture.author.actor.accountId,
    ['moderation:hide', 'moderation:takedown'],
  );
  await fixture.command(`/v1/subjects/${historicalSubject.id}:hide`, { reason: 'Withhold old attachment' }, 200);
  expect((await read()).status).toBe(200);
  expect((await read(document.revisionId)).status).toBe(404);
  const withheldCopy = await fixture.call('GET', '/v1/knowledge/documents/' + copy.documentId, undefined, {
    anonymous: true,
  });
  expect(withheldCopy.status).toBe(200);
  expect(withheldCopy.value.document.provenance).toBeNull();
  await fixture.command(`/v1/subjects/${historicalSubject.id}:restore`, { reason: 'Restore old attachment' }, 200);
  expect(
    (await fixture.call('GET', '/v1/knowledge/documents/' + copy.documentId, undefined, { anonymous: true })).value
      .document.provenance,
  ).toEqual(exportA.value.selection);

  await publish(revisionB.revisionId, publicationB.publicationId, null);
  expect((await read(document.revisionId)).status).toBe(404);
  expect((await read(revisionB.revisionId)).status).toBe(404);
  expect(
    (await fixture.call('GET', '/v1/knowledge/documents/' + copy.documentId, undefined, { anonymous: true })).value
      .document.provenance,
  ).toBeNull();
  const republishedB = await publish(revisionB.revisionId, null, revisionB.revisionId);
  expect(republishedB.publicationId).not.toBe(publicationB.publicationId);
  expect((await read(document.revisionId)).status).toBe(404);
  expect((await read(revisionB.revisionId)).value.document.publicationId).toBe(republishedB.publicationId);
  const reselectedA = await publish(revisionB.revisionId, republishedB.publicationId, document.revisionId);
  expect((await read(document.revisionId)).value.document.publicationId).toBe(reselectedA.publicationId);
});
