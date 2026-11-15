import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText, normalizeDocument } from '@rezics/document';
import { knowledgeMediaQuery, knowledgeMediaSource, type KnowledgeMediaSelection } from '@rezics/definitions/knowledge-media';
import { createContentMediaDriver, currentMediaScenario } from './media-driver.ts';
import { digest } from './support/media-fixtures.ts';
import type { ContentCredential } from './support/system.ts';

setDefaultTimeout(240_000);
let driver: Awaited<ReturnType<typeof createContentMediaDriver>>;
beforeAll(async () => { driver = await createContentMediaDriver(); });
afterAll(async () => { await driver?.close(); });

async function call(actor: ContentCredential | null, method: string, path: string, body?: unknown) {
  return currentMediaScenario().system.kernel.handle(new Request(`https://content.test${path}`, {
    method,
    headers: {
      ...(actor ? { authorization: `Bearer ${actor.bearer}` } : {}),
      ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
async function json(response: Response, status = 200): Promise<any> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text);
}
function imageDocument(mediaId: string) {
  return normalizeDocument({
    version: 'rezics-document-v1', profile: 'blocks',
    doc: { type: 'doc', content: [
      { type: 'paragraph', attrs: { id: 'description' }, content: [{ type: 'text', text: 'Processed Knowledge image' }] },
      { type: 'image', attrs: { id: 'image', src: knowledgeMediaSource(mediaId), alt: 'Native uploaded image' } },
    ] },
  });
}
function downloadPath(mediaId: string, variant: string, knowledge?: KnowledgeMediaSelection) {
  const query = new URLSearchParams({ variant, ...(knowledge ? knowledgeMediaQuery(knowledge) : {}) });
  return `/v1/media/${mediaId}:authorizeDownload?${query}`;
}

test('ordinary Knowledge upload completes through website Auth, processes real bytes and publishes an exact claimed derivative', async () => {
  const { system } = currentMediaScenario();
  const author = system.actors.author;
  const { subject } = await json(await call(author, 'POST', '/v1/subjects', {
    type: 'skos:Concept', labels: { en: 'Native Knowledge image pipeline' },
  }), 201);
  const notebook = await json(await call(author, 'POST', '/v1/knowledge/notebooks', {
    subjectId: subject.id, title: 'Private image workspace',
  }), 201);
  const document = await json(await call(author, 'POST', `/v1/knowledge/notebooks/${notebook.notebookId}/documents`, {
    title: 'Saved before upload', body: fromPlainText('Initial private working document'),
    licence: 'MIT', subjectIds: [], parentPlacementId: null,
    expectedStructureRevisionId: notebook.structureRevisionId,
  }), 201);

  const source = await driver.source('tiny');
  const foreignReservation = await driver.reserve('other', {
    requestId: crypto.randomUUID(), containerId: document.documentId,
    purpose: 'knowledge-image', type: source.type, length: source.bytes.length, sha256: source.sha256,
  });
  expect(foreignReservation.outcome).toBe('denied');
  const reservationRequestId = crypto.randomUUID();
  const reserved = await driver.reserve('author', {
    requestId: reservationRequestId, containerId: document.documentId,
    purpose: 'knowledge-image', type: source.type, length: source.bytes.length, sha256: source.sha256,
  });
  if (reserved.outcome !== 'permitted') throw new Error(`Knowledge image reservation: ${reserved.outcome}`);
  const mediaId = reserved.media.id;
  expect(reserved.media).toMatchObject({
    purpose: 'knowledge-image', containerId: document.documentId, uploaderId: author.actor.accountId, state: 'reserved',
  });
  await driver.placeOriginal(mediaId, source.bytes);
  const completion = {
    reservationRequestId, containerId: document.documentId,
    byteCount: source.bytes.length, sha256: source.sha256,
  };
  expect(await driver.complete('other-worker', { ...completion, requestId: crypto.randomUUID() })).toBe('denied');
  const completionRequestId = crypto.randomUUID();
  expect(await driver.complete('worker', { ...completion, requestId: completionRequestId })).toBe('permitted');
  const authentication = await driver.authenticationEvidence('worker', completionRequestId);
  expect(authentication.sub).toBe(author.actor.accountId);
  expect(authentication.clientId).toBe(authentication.registeredWebsiteClientId);
  expect(authentication.scopes).toContain('media:complete');
  expect(await driver.process('job', mediaId)).toBe('permitted');
  expect((await driver.inspect()).media.find((media) => media.id === mediaId)).toMatchObject({
    state: 'available', claimedAt: null, sha256: source.sha256,
  });
  const outputs = await driver.derivatives(mediaId);
  expect(outputs.length).toBeGreaterThan(0);
  const output = outputs[0]!;
  const decoded = await driver.decode(output.bytes);
  expect(decoded.metadata).toEqual([]);
  const variant = `${decoded.format}-${decoded.width}`;
  expect((await call(author, 'GET', downloadPath(mediaId, variant))).status).toBe(404);

  const revision = await json(await call(author, 'POST', `/v1/knowledge/documents/${document.documentId}/revisions:revise`, {
    title: 'Claimed native image', body: imageDocument(mediaId), licence: 'MIT', subjectIds: [],
    expectedHeadRevisionId: document.revisionId,
  }));
  expect((await driver.inspect()).media.find((media) => media.id === mediaId)?.claimedAt).not.toBeNull();
  const privatePath = `/v1/accounts/${author.actor.accountId}/knowledge/notebooks/${notebook.notebookId}/documents/${document.documentId}`;
  const privateSource = (await json(await call(author, 'GET', privatePath))).document;
  const authoring: KnowledgeMediaSelection = {
    representation: 'authoring', documentId: document.documentId, revisionId: revision.revisionId,
    sourceSha256: digest(Buffer.from(privateSource.canonicalBytes, 'base64')),
  };
  const own = await json(await call(author, 'GET', downloadPath(mediaId, variant, authoring)));
  expect(own).toMatchObject({ key: output.key, sha256: digest(output.bytes), byteCount: output.bytes.length });
  expect((await call(system.actors.other, 'GET', downloadPath(mediaId, variant, authoring))).status).toBe(404);

  const publicationPath = `/v1/knowledge/documents/${document.documentId}/publication:select`;
  const publication = await json(await call(author, 'POST', publicationPath, {
    expectedHeadRevisionId: revision.revisionId, expectedPublicationId: null, revisionId: revision.revisionId,
  }));
  const published: KnowledgeMediaSelection = {
    ...authoring, representation: 'public', publicationId: publication.publicationId,
  };
  const publicDocument = (await json(await call(null, 'GET', `/v1/knowledge/documents/${document.documentId}`))).document;
  expect(publicDocument.sourceSha256).toBe(authoring.sourceSha256);
  const publicPath = downloadPath(mediaId, variant, published);
  const publicResponse = await call(null, 'GET', publicPath);
  expect(publicResponse.headers.get('cache-control')).toMatch(/^private, /);
  expect(await json(publicResponse)).toMatchObject({
    key: output.key, sha256: digest(output.bytes), byteCount: output.bytes.length, publicCache: false,
  });
  expect((await call(null, 'GET', downloadPath(mediaId, variant, {
    ...published, sourceSha256: digest(output.bytes),
  }))).status).toBe(404);
  await json(await call(author, 'POST', publicationPath, {
    expectedHeadRevisionId: revision.revisionId, expectedPublicationId: publication.publicationId, revisionId: null,
  }));
  expect((await call(null, 'GET', publicPath)).status).toBe(404);
  expect((await call(author, 'GET', downloadPath(mediaId, variant, authoring))).status).toBe(200);
});
