import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText, normalizeDocument } from '@rezics/document';
import { knowledgeMediaQuery, knowledgeMediaSource, type KnowledgeMediaSelection } from '@rezics/definitions/knowledge-media';
import { routeOf } from '../../src/route/route.ts';
import { postPublicationFixture } from './support/post-publication-fixture.ts';

setDefaultTimeout(180_000);
let fixture: Awaited<ReturnType<typeof postPublicationFixture>>;
beforeAll(async () => { fixture = await postPublicationFixture(); });
afterAll(async () => { await fixture?.close(); });

const input = (title: string, body = fromPlainText(title)) => ({ title, body, licence: 'MIT', subjectIds: [] });
const imageBody = (mediaId: string, title: string) => normalizeDocument({
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: { type: 'doc', content: [
    { type: 'paragraph', attrs: { id: 'caption' }, content: [{ type: 'text', text: title }] },
    { type: 'image', attrs: { id: 'illustration', src: knowledgeMediaSource(mediaId), alt: title } },
  ] },
});

async function workspace(subjectId: string, other = false) {
  const notebook = await fixture.call('POST', '/v1/knowledge/notebooks', { subjectId, title: 'Image notebook' }, { other });
  expect(notebook.status).toBe(201);
  const document = await fixture.call('POST', `/v1/knowledge/notebooks/${notebook.value.notebookId}/documents`, {
    ...input('Initial private source'),
    parentPlacementId: null,
    expectedStructureRevisionId: notebook.value.structureRevisionId,
  }, { other });
  expect(document.status).toBe(201);
  const ownerId = (other ? fixture.system.actors.other : fixture.author).actor.accountId;
  return {
    ...document.value,
    privatePath: `/v1/accounts/${ownerId}/knowledge/notebooks/${notebook.value.notebookId}/documents/${document.value.documentId}`,
  };
}

/** Injected prepared-image fixture only. Reservation uses the native HTTP route;
 * these rows stand in for completed image processing. This test proves native
 * Knowledge claims and disclosure, not completion, processing, or object bytes.
 */
async function preparedMedia(documentId: string, other = false) {
  const original = Buffer.from('prepared Knowledge original fixture');
  const sha256 = createHash('sha256').update(original).digest('hex');
  const reservation = await fixture.call('POST', '/v1/media', {
    purpose: 'knowledge-image', containerId: documentId,
    mediaType: 'image/png', byteCount: original.length, sha256,
  }, { other });
  expect(reservation.status, JSON.stringify(reservation.value)).toBe(201);
  expect(reservation.value.media.purpose).toBe('knowledge-image');
  const mediaId = reservation.value.media.id as string;
  const variantDigest = createHash('sha256').update('prepared Knowledge derivative fixture').digest('hex');
  await fixture.pool.query(
    `UPDATE content.media SET state='available', actual_byte_count=byte_count,
       sha256=$3, width=32, height=24 WHERE route=$1 AND media_id=$2`,
    [routeOf(mediaId), mediaId, sha256],
  );
  await fixture.pool.query(
    `INSERT INTO content.media_variant
       (route,media_id,format,width,height,media_type,byte_count,sha256,key,transaction_id)
     VALUES($1,$2,'webp',32,24,'image/webp',32,$3,$4,$2)`,
    [routeOf(mediaId), mediaId, variantDigest, `m/${mediaId}/webp-32`],
  );
  return { id: mediaId, variantDigest };
}

function download(mediaId: string, knowledge?: KnowledgeMediaSelection, options: { anonymous?: boolean; other?: boolean } = {}) {
  const query = new URLSearchParams({ variant: 'webp-32', ...(knowledge ? knowledgeMediaQuery(knowledge) : {}) });
  return fixture.call('GET', `/v1/media/${mediaId}:authorizeDownload?${query}`, undefined, options);
}
function presentations(mediaId: string, knowledge?: KnowledgeMediaSelection, anonymous = false) {
  return fixture.call('POST', '/v1/media/presentations', {
    ids: [mediaId], ...(knowledge ? { knowledge } : {}),
  }, { anonymous });
}
function sourceSha(document: Record<string, any>) {
  return createHash('sha256').update(Buffer.from(document.canonicalBytes, 'base64')).digest('hex');
}

test('prepared Knowledge images disclose only exact admitted sources and close after withdrawal or trash', async () => {
  const { subject } = await fixture.command('/v1/subjects', {
    type: 'skos:Concept', labels: { en: 'Knowledge image source' },
  });
  const document = await workspace(subject.id);
  const image = await preparedMedia(document.documentId);
  const initial = (await fixture.call('GET', document.privatePath)).value.document;
  const initialSelection: KnowledgeMediaSelection = {
    representation: 'authoring', documentId: document.documentId,
    revisionId: document.revisionId, sourceSha256: sourceSha(initial),
  };
  // A native reservation or exact document locator does not imply revision membership.
  expect((await download(image.id)).status).toBe(404);
  expect((await download(image.id, initialSelection)).status).toBe(404);
  expect((await presentations(image.id, initialSelection)).value.images).toEqual([]);

  const revision = await fixture.command(`/v1/knowledge/documents/${document.documentId}/revisions:revise`, {
    ...input('Image source A', imageBody(image.id, 'Image source A')),
    expectedHeadRevisionId: document.revisionId,
  }, 200);
  const privateSource = (await fixture.call('GET', document.privatePath)).value.document;
  const authoring: KnowledgeMediaSelection = {
    representation: 'authoring', documentId: document.documentId,
    revisionId: revision.revisionId, sourceSha256: sourceSha(privateSource),
  };
  expect((await download(image.id, authoring)).status).toBe(200);
  expect((await download(image.id, authoring, { anonymous: true })).status).toBe(404);
  expect((await download(image.id, authoring, { other: true })).status).toBe(404);
  expect((await download(image.id, { ...authoring, sourceSha256: image.variantDigest })).status).toBe(404);
  expect((await download(image.id, { ...authoring, revisionId: document.revisionId })).status).toBe(404);

  const foreignDocument = await workspace(subject.id, true);
  const foreignImage = await preparedMedia(foreignDocument.documentId, true);
  const foreignClaim = await fixture.call('POST', `/v1/knowledge/documents/${document.documentId}/revisions:revise`, {
    ...input('Foreign image', imageBody(foreignImage.id, 'Foreign image')),
    expectedHeadRevisionId: revision.revisionId,
  });
  expect(foreignClaim.status).toBe(409);

  const publishPath = `/v1/knowledge/documents/${document.documentId}/publication:select`;
  const publication = await fixture.command(publishPath, {
    expectedHeadRevisionId: revision.revisionId, expectedPublicationId: null, revisionId: revision.revisionId,
  }, 200);
  const publicSource: KnowledgeMediaSelection = {
    ...authoring, representation: 'public', publicationId: publication.publicationId,
  };
  const publicImage = await download(image.id, publicSource, { anonymous: true });
  expect(publicImage.status).toBe(200);
  expect(publicImage.value).toMatchObject({ sha256: image.variantDigest, publicCache: false });
  const page = await presentations(image.id, publicSource, true);
  expect(page.status).toBe(200);
  expect(page.value.images.map((item: { id: string }) => item.id)).toEqual([image.id]);
  expect((await download(image.id, { ...publicSource, publicationId: revision.revisionId }, { anonymous: true })).status).toBe(404);

  const working = await fixture.command(`/v1/knowledge/documents/${document.documentId}/revisions:revise`, {
    ...input('Private working B', imageBody(image.id, 'Private working B')),
    expectedHeadRevisionId: revision.revisionId,
  }, 200);
  const workingSource = (await fixture.call('GET', document.privatePath)).value.document;
  const workingSelection: KnowledgeMediaSelection = {
    representation: 'authoring', documentId: document.documentId,
    revisionId: working.revisionId, sourceSha256: sourceSha(workingSource),
  };
  expect((await download(image.id, {
    ...publicSource, revisionId: working.revisionId, sourceSha256: workingSelection.sourceSha256,
  }, { anonymous: true })).status).toBe(404);
  expect((await download(image.id, publicSource, { anonymous: true })).status).toBe(200);
  await fixture.command(publishPath, {
    expectedHeadRevisionId: working.revisionId, expectedPublicationId: publication.publicationId, revisionId: null,
  }, 200);
  expect((await download(image.id, publicSource, { anonymous: true })).status).toBe(404);
  expect((await presentations(image.id, publicSource, true)).value.images).toEqual([]);
  expect((await download(image.id, workingSelection)).status).toBe(200);

  const republished = await fixture.command(publishPath, {
    expectedHeadRevisionId: working.revisionId, expectedPublicationId: null, revisionId: working.revisionId,
  }, 200);
  const selectedAgain: KnowledgeMediaSelection = {
    ...workingSelection, representation: 'public', publicationId: republished.publicationId,
  };
  expect((await download(image.id, selectedAgain, { anonymous: true })).status).toBe(200);
  expect((await download(image.id, publicSource, { anonymous: true })).status).toBe(404);
  await fixture.command(`/v1/knowledge/documents/${document.documentId}:trash`, {
    expectedGeneration: '0', expectedStructureRevisionId: document.structureRevisionId,
  }, 200);
  expect((await download(image.id, selectedAgain, { anonymous: true })).status).toBe(404);
  expect((await presentations(image.id, selectedAgain, true)).value.images).toEqual([]);
});
