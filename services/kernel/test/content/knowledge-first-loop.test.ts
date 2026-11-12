import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { validateContentDocument } from '../../src/content/document.ts';
import {
  KNOWLEDGE_ANCESTOR_LIMIT,
  KNOWLEDGE_REFERENCE_LIMIT,
  knowledgeSubjectTargets,
} from '../../src/content/knowledge-model.ts';
import { admitsKnowledgeAncestorPath } from '../../src/content/knowledge-tree.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';

setDefaultTimeout(180_000);
let fixture: Awaited<ReturnType<typeof postPublicationFixture>>;

beforeAll(async () => {
  fixture = await postPublicationFixture();
});

afterAll(async () => {
  await fixture?.close();
});

function documentInput(text: string) {
  return {
    title: text,
    body: fromPlainText(text),
    licence: 'MIT',
    subjectIds: [],
  };
}

function canonicalBytes(input: ReturnType<typeof documentInput>) {
  return Buffer.from(
    validateContentDocument({ body: input.body, licence: input.licence, subjectIds: input.subjectIds }).canonicalBytes,
  );
}

test('one notebook keeps sibling documents private while its exact selected revision is public until withdrawal', async () => {
  const { subject } = await fixture.command('/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Knowledge first loop' },
  });
  expect(
    (
      await fixture.call('POST', '/v1/knowledge/notebooks', {
        subjectId: subject.id,
        title: '   ',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fixture.call('POST', '/v1/knowledge/notebooks', {
        subjectId: subject.id,
        title: '\0',
      })
    ).status,
  ).toBe(400);
  const notebook = await fixture.command('/v1/knowledge/notebooks', {
    subjectId: subject.id,
    title: 'Private research notebook',
  });
  const selectedV1Body = documentInput('Selected exact revision');
  const selectedV1 = await fixture.command(`/v1/knowledge/notebooks/${notebook.notebookId}/documents`, {
    ...selectedV1Body,
    expectedStructureRevisionId: notebook.structureRevisionId,
    parentPlacementId: null,
  });
  const siblingBody = documentInput('Private sibling');
  const sibling = await fixture.command(`/v1/knowledge/notebooks/${notebook.notebookId}/documents`, {
    ...siblingBody,
    expectedStructureRevisionId: selectedV1.structureRevisionId,
    parentPlacementId: null,
  });
  const selectedV2 = await fixture.command(
    `/v1/knowledge/documents/${selectedV1.documentId}/revisions:revise`,
    { ...documentInput('New private head'), expectedHeadRevisionId: selectedV1.revisionId },
    200,
  );

  const privateSiblingPath =
    `/v1/accounts/${fixture.author.actor.accountId}/knowledge/notebooks/${notebook.notebookId}` +
    `/documents/${sibling.documentId}`;
  const siblingPrivate = await fixture.call('GET', privateSiblingPath);
  expect(siblingPrivate.status).toBe(200);
  expect(Buffer.from(siblingPrivate.value.document.canonicalBytes, 'base64')).toEqual(canonicalBytes(siblingBody));
  expect((await fixture.call('GET', privateSiblingPath, undefined, { other: true })).status).toBe(404);
  expect(
    (
      await fixture.call(
        'POST',
        `/v1/knowledge/notebooks/${notebook.notebookId}/documents`,
        {
          ...documentInput('Foreign write'),
          expectedStructureRevisionId: sibling.structureRevisionId,
          parentPlacementId: null,
        },
        { other: true },
      )
    ).status,
  ).toBe(404);

  const selectPath = `/v1/knowledge/documents/${selectedV1.documentId}/publication:select`;
  const selectInput = {
    expectedHeadRevisionId: selectedV2.revisionId,
    expectedPublicationId: null,
    revisionId: selectedV1.revisionId,
  };
  const selectionKey = crypto.randomUUID();
  const selection = await fixture.call('POST', selectPath, selectInput, { key: selectionKey });
  expect(selection.status).toBe(200);
  const selectionReplay = await fixture.call('POST', selectPath, selectInput, { key: selectionKey });
  expect(selectionReplay.status).toBe(200);
  expect(selectionReplay.value).toEqual(selection.value);

  const exactRead = await fixture.call('GET', `/v1/knowledge/documents/${selectedV1.documentId}`, undefined, {
    anonymous: true,
  });
  expect(exactRead.status).toBe(200);
  expect(exactRead.value.document).toMatchObject({
    revisionId: selectedV1.revisionId,
    publicationId: selection.value.publicationId,
    subjectId: subject.id,
    authorId: null,
  });
  expect(exactRead.value.document).not.toHaveProperty('notebookId');
  expect(Buffer.from(exactRead.value.document.canonicalBytes, 'base64')).toEqual(canonicalBytes(selectedV1Body));
  expect(exactRead.value.document.revisionId).not.toBe(selectedV2.revisionId);
  expect(
    (await fixture.call('GET', `/v1/knowledge/documents/${selectedV1.documentId}?revisionId=${selectedV2.revisionId}`))
      .status,
  ).toBe(404);
  expect(
    (await fixture.call('GET', `/v1/knowledge/documents/${sibling.documentId}`, undefined, { anonymous: true })).status,
  ).toBe(404);

  // No Search consumer is run in this journey. The native read is current-source authoritative on its own.
  const withdrawPath = `/v1/knowledge/documents/${selectedV1.documentId}/publication:select`;
  const withdrawInput = {
    expectedHeadRevisionId: selectedV2.revisionId,
    expectedPublicationId: selection.value.publicationId,
    revisionId: null,
  };
  const withdrawn = await fixture.call('POST', withdrawPath, withdrawInput, { key: crypto.randomUUID() });
  expect(withdrawn.status).toBe(200);
  expect(withdrawn.value.publicationId).toBeNull();
  expect(
    (await fixture.call('GET', `/v1/knowledge/documents/${selectedV1.documentId}`, undefined, { anonymous: true }))
      .status,
  ).toBe(404);
  const staleWithdrawal = await fixture.call('POST', withdrawPath, withdrawInput, { key: crypto.randomUUID() });
  expect(staleWithdrawal.status).toBe(412);

  const noOpWithdrawalKey = crypto.randomUUID();
  const noOpWithdrawalInput = {
    expectedHeadRevisionId: selectedV2.revisionId,
    expectedPublicationId: null,
    revisionId: null,
  };
  const noOpWithdrawal = await fixture.call('POST', withdrawPath, noOpWithdrawalInput, { key: noOpWithdrawalKey });
  expect(noOpWithdrawal.status).toBe(200);
  expect(noOpWithdrawal.value.publicationId).toBeNull();
  const noOpWithdrawalReplay = await fixture.call('POST', withdrawPath, noOpWithdrawalInput, {
    key: noOpWithdrawalKey,
  });
  expect(noOpWithdrawalReplay.status).toBe(200);
  expect(noOpWithdrawalReplay.value).toEqual(noOpWithdrawal.value);

  const events = await fixture.pool.query<{ type: string; subject: string; data: Record<string, unknown> }>(
    `SELECT type,subject,data FROM core.outbox
     WHERE type LIKE 'com.rezics.content.knowledge.%' AND subject=ANY($1::text[])
     ORDER BY position,event_seq`,
    [[notebook.notebookId, selectedV1.documentId, sibling.documentId]],
  );
  expect(events.rows.map(({ type, subject }) => [type, subject])).toEqual([
    ['com.rezics.content.knowledge.notebook.created.v1', notebook.notebookId],
    ['com.rezics.content.knowledge.document.created.v1', selectedV1.documentId],
    ['com.rezics.content.knowledge.document.created.v1', sibling.documentId],
    ['com.rezics.content.knowledge.document.revised.v1', selectedV1.documentId],
    ['com.rezics.content.knowledge.publication.changed.v1', selectedV1.documentId],
    ['com.rezics.content.knowledge.publication.changed.v1', selectedV1.documentId],
  ]);
  expect(events.rows[0]!.data).toEqual({
    notebookId: notebook.notebookId,
    subjectId: subject.id,
    structureRevisionId: notebook.structureRevisionId,
  });
  expect(events.rows[1]!.data).toEqual({
    notebookId: notebook.notebookId,
    documentId: selectedV1.documentId,
    placementId: selectedV1.placementId,
    revisionId: selectedV1.revisionId,
    structureRevisionId: selectedV1.structureRevisionId,
  });
  expect(events.rows[3]!.data).toEqual({
    documentId: selectedV1.documentId,
    previousRevisionId: selectedV1.revisionId,
    revisionId: selectedV2.revisionId,
  });
  expect(events.rows.slice(4).map((event) => event.data.action)).toEqual(['selected', 'withdrawn']);
  expect(JSON.stringify(events.rows)).not.toContain('Private sibling');

  const receipts = await fixture.pool.query<{ command_kind: string; count: number }>(
    `SELECT command_kind,count(*)::int AS count FROM core.receipt
     WHERE principal_kind='account' AND principal_id=$1 AND command_kind LIKE 'content.knowledge.%'
     GROUP BY command_kind ORDER BY command_kind`,
    [fixture.author.actor.accountId],
  );
  expect(receipts.rows).toEqual([
    { command_kind: 'content.knowledge.document.create', count: 2 },
    { command_kind: 'content.knowledge.document.publication', count: 3 },
    { command_kind: 'content.knowledge.document.revise', count: 1 },
    { command_kind: 'content.knowledge.notebook.create', count: 1 },
  ]);
});

test('knowledge ancestry and current Subject checks stay within their declared bounds', () => {
  const route = routeOf(fixture.author.actor.accountId)!;
  const ancestors = Array.from({ length: KNOWLEDGE_ANCESTOR_LIMIT + 1 }, () => newId(route));
  const admitted = ancestors.map((placementId, index) => ({
    placementId,
    parentId: ancestors[index + 1] ?? null,
  }));
  expect(admitsKnowledgeAncestorPath(admitted)).toBe(true);
  expect(admitsKnowledgeAncestorPath([...admitted, { placementId: newId(route), parentId: null }])).toBe(false);
  expect(admitsKnowledgeAncestorPath([{ placementId: newId(route), parentId: newId(route) }])).toBe(false);

  const anchor = newId(route);
  const references = Array.from({ length: KNOWLEDGE_REFERENCE_LIMIT }, () => newId(route));
  expect(knowledgeSubjectTargets(anchor, references)).toHaveLength(KNOWLEDGE_REFERENCE_LIMIT + 1);
  expect(() => knowledgeSubjectTargets(anchor, [...references, newId(route)])).toThrow();
});
