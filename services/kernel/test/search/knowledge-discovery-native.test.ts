import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createKnowledgeDiscoverySource } from '../../src/content/index.ts';
import {
  createKnowledgeDiscoveryStore,
  knowledgeDiscoveryEffect,
} from '../../src/search/knowledge-discovery-native.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { postPublicationFixture } from '../content/support/post-publication-fixture.ts';
import { nativeOperator } from '../content/support/native-system.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof postPublicationFixture>>;
beforeAll(async () => {
  f = await postPublicationFixture();
});
afterAll(async () => {
  await f?.close();
});

const document = (title: string) => ({ title, body: fromPlainText(title), licence: 'MIT', subjectIds: [] });
async function operator(path: string, body?: unknown) {
  const response = await f.system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${nativeOperator(f.system).bearer}`,
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  return value;
}
async function selectionEvent(documentId: string): Promise<CloudEvent> {
  const row = (
    await f.pool.query<{ data: unknown; id: string; position: string }>(
      `SELECT id,position::text,data FROM core.outbox
     WHERE type='com.rezics.content.knowledge.publication.changed.v1' AND subject=$1
     ORDER BY position DESC,event_seq DESC LIMIT 1`,
      [documentId],
    )
  ).rows[0]!;
  return {
    specversion: '1.0',
    id: row.id,
    source: '/kernel',
    type: 'com.rezics.content.knowledge.publication.changed.v1',
    subject: documentId,
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    sequence: row.position,
    data: row.data,
  };
}

test('mounted Subject discovery keeps the Search gate, resolves only current exact public metadata and fences paused-index withdrawal', async () => {
  const { subject } = await f.command('/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Public Knowledge discovery' },
  });
  const notebook = await f.command('/v1/knowledge/notebooks', {
    subjectId: subject.id,
    title: 'Private outline title',
  });
  const selected = await f.command(`/v1/knowledge/notebooks/${notebook.notebookId}/documents`, {
    ...document('Published title'),
    expectedStructureRevisionId: notebook.structureRevisionId,
    parentPlacementId: null,
  });
  const sibling = await f.command(`/v1/knowledge/notebooks/${notebook.notebookId}/documents`, {
    ...document('Never published private sibling'),
    expectedStructureRevisionId: selected.structureRevisionId,
    parentPlacementId: null,
  });
  const selectPath = `/v1/knowledge/documents/${selected.documentId}/publication:select`;
  const publication = await f.command(
    selectPath,
    { expectedHeadRevisionId: selected.revisionId, expectedPublicationId: null, revisionId: selected.revisionId },
    200,
  );
  const oldEvent = await selectionEvent(selected.documentId);
  const source = createKnowledgeDiscoverySource({ pool: f.pool, access: f.system.access });
  const effect = knowledgeDiscoveryEffect({ pool: f.pool, source: () => source, deadlineNow: Date.now });
  await effect.run(oldEvent);
  await effect.run(oldEvent); // exact native redelivery is idempotent
  const store = createKnowledgeDiscoveryStore(f.pool, Date.now);
  expect(await store.cut(subject.id)).toBe('1');

  // A private working-head change cannot change the public list title, revision or ordering time.
  const privateHead = await f.command(
    `/v1/knowledge/documents/${selected.documentId}/revisions:revise`,
    {
      ...document('Private later head'),
      expectedHeadRevisionId: selected.revisionId,
    },
    200,
  );
  const path = `/v1/subjects/${subject.id}/knowledgeDocuments`;
  await operator('/v1/platform/exposure/search:close');
  expect((await f.call('GET', path, undefined, { anonymous: true })).status).toBe(403);
  await operator('/v1/platform/exposure/search:open');
  const listed = await f.call('GET', path, undefined, { anonymous: true });
  expect(listed.status, JSON.stringify(listed.value)).toBe(200);
  const response = await f.system.kernel.handle(new Request(`https://content.test${path}`));
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(listed.value.documents).toHaveLength(1);
  expect(listed.value.documents[0]).toMatchObject({
    subjectId: subject.id,
    documentId: selected.documentId,
    revisionId: selected.revisionId,
    publicationId: publication.publicationId,
    title: 'Published title',
  });
  expect(listed.value).toMatchObject({ state: 'ready', next: null });
  for (const privateValue of [notebook.notebookId, 'Private outline title', sibling.documentId, 'Private later head'])
    expect(JSON.stringify(listed.value)).not.toContain(privateValue);
  for (const key of ['canonicalBytes', 'authorId', 'notebookId', 'subjectIds', 'total'])
    expect(JSON.stringify(listed.value)).not.toContain(`"${key}"`);
  const exact = await f.call(
    'GET',
    `/v1/knowledge/documents/${selected.documentId}?revisionId=${listed.value.documents[0].revisionId}`,
    undefined,
    { anonymous: true },
  );
  expect(exact.status).toBe(200);
  expect(exact.value.document.publicationId).toBe(publication.publicationId);
  expect((await f.call('GET', `${path}?limit=21`, undefined, { anonymous: true })).status).toBe(400);
  expect((await f.call('GET', `${path}?cursor=invalid`, undefined, { anonymous: true })).status).toBe(400);

  const replacement = await f.command(
    selectPath,
    {
      expectedHeadRevisionId: privateHead.revisionId,
      expectedPublicationId: publication.publicationId,
      revisionId: privateHead.revisionId,
    },
    200,
  );
  // No effect applied: only the old association is indexed. It must not disclose the replaced selection.
  expect((await f.call('GET', path, undefined, { anonymous: true })).value.documents).toEqual([]);
  await effect.run(oldEvent); // a delayed old add cannot resurrect that row
  await effect.run(await selectionEvent(selected.documentId));
  expect(await store.cut(subject.id)).toBe('2');
  const firstKey = (await store.page(subject.id, null, 1))[0]!;
  const secondKey = (await store.page(subject.id, firstKey, 1))[0]!;
  expect(new Set([firstKey.publicationId, secondKey.publicationId])).toEqual(
    new Set([publication.publicationId, replacement.publicationId]),
  );
  expect(await store.page(subject.id, secondKey, 1)).toEqual([]);
  const replaced = await f.call('GET', path, undefined, { anonymous: true });
  expect(replaced.status).toBe(200);
  expect(replaced.value.documents).toHaveLength(1);
  expect(replaced.value.documents[0]).toMatchObject({
    publicationId: replacement.publicationId,
    revisionId: privateHead.revisionId,
    title: 'Private later head',
  });
  await f.command(
    selectPath,
    {
      expectedHeadRevisionId: privateHead.revisionId,
      expectedPublicationId: replacement.publicationId,
      revisionId: null,
    },
    200,
  );
  const withdrawn = await f.call('GET', path, undefined, { anonymous: true });
  expect(withdrawn.status).toBe(200);
  expect(withdrawn.value).toEqual({ state: 'ready', documents: [], next: null });
  expect(
    (await f.call('GET', `/v1/knowledge/documents/${selected.documentId}`, undefined, { anonymous: true })).status,
  ).toBe(404);
});

test('a selected revision referencing a now-hidden Subject is omitted even for its signed-in owner', async () => {
  const { subject } = await f.command('/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Knowledge target authority' },
  });
  const { subject: reference } = await f.command('/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Referenced public Subject' },
  });
  const notebook = await f.command('/v1/knowledge/notebooks', { subjectId: subject.id, title: 'Authority notebook' });
  const selected = await f.command(`/v1/knowledge/notebooks/${notebook.notebookId}/documents`, {
    ...document('Requires both public Subjects'),
    subjectIds: [reference.id],
    expectedStructureRevisionId: notebook.structureRevisionId,
    parentPlacementId: null,
  });
  const publication = await f.command(
    `/v1/knowledge/documents/${selected.documentId}/publication:select`,
    {
      expectedHeadRevisionId: selected.revisionId,
      expectedPublicationId: null,
      revisionId: selected.revisionId,
    },
    200,
  );
  const source = createKnowledgeDiscoverySource({ pool: f.pool, access: f.system.access });
  const candidate = await source.selected(selected.documentId, publication.publicationId, {
    deadline: Date.now() + 30_000,
  });
  expect(candidate).not.toBeNull();
  await knowledgeDiscoveryEffect({ pool: f.pool, source: () => source, deadlineNow: Date.now }).run(
    await selectionEvent(selected.documentId),
  );
  await operator(`/v1/subjects/${reference.id}:hide`, { reason: 'Knowledge reference admission' });
  expect(await source.current(candidate!, { deadline: Date.now() + 30_000 })).toEqual({ status: 'ready', value: null });
  const path = `/v1/subjects/${subject.id}/knowledgeDocuments`;
  for (const anonymous of [true, false]) {
    const listed = await f.call('GET', path, undefined, { anonymous });
    expect(listed.status, JSON.stringify(listed.value)).toBe(200);
    expect(listed.value.documents).toEqual([]);
  }
});
