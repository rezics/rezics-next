import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  admitKnowledgeDiscovery,
  knowledgeDiscoveryExactHref,
  knowledgeDiscoveryWire,
  parseKnowledgeDiscoveryCursor,
  parseKnowledgeDiscoveryRequest,
  readKnowledgeDiscovery,
} from '../src/knowledge/discovery';
import {
  knowledgeDiscoverySearch,
  parseKnowledgeDiscoveryReturn,
  parseKnowledgeDiscoveryReturnPath,
} from '../src/knowledge/discovery-visit';
import {
  knowledgeDocumentId,
  knowledgeLicence,
  knowledgePublicationId,
  knowledgeRevisionId,
  knowledgeSubjectId,
  knowledgeTitle,
} from '../src/stories/knowledge-document-fixtures';

const cursor = 'opaque +/= token';
const visitHref = `/en/subjects/${knowledgeSubjectId}/selected-public-knowledge`;
const row = {
  subjectId: knowledgeSubjectId,
  documentId: knowledgeDocumentId,
  publicationId: knowledgePublicationId,
  revisionId: knowledgeRevisionId,
  publishedAt: '2026-10-30T12:00:00.000Z',
  title: knowledgeTitle,
  language: 'en',
  licence: knowledgeLicence,
  sha256: 'a'.repeat(64),
};

function wire(respond: (request: Request) => Response) {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (url, init) => {
      const request = new Request(url, init);
      calls.push(request);
      return respond(request);
    }) as typeof fetch,
  });
  return { client, calls };
}

test('generated discovery reads one bounded public page with native order, titles and exact destinations', async () => {
  const dto = {
    state: 'ready',
    documents: [row, { ...row, documentId: knowledgeRevisionId, title: 'Second' }],
    next: cursor,
  };
  const { client, calls } = wire(() => Response.json(dto));
  const first = await readKnowledgeDiscovery(client, {
    subjectId: knowledgeSubjectId,
    cursor: null,
    locale: 'en',
  });
  const continued = await readKnowledgeDiscovery(
    client,
    { subjectId: knowledgeSubjectId, cursor, locale: 'en' },
    'Bearer viewer',
  );
  expect(first).toEqual({
    state: 'ready',
    page: {
      documents: [
        { ...row, publishedAt: '2026-10-30T12:00:00.000Z' },
        { ...row, documentId: knowledgeRevisionId, title: 'Second', publishedAt: '2026-10-30T12:00:00.000Z' },
      ],
      next: cursor,
    },
  });
  expect(continued.state).toBe('ready');
  expect(calls).toHaveLength(2);
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/subjects/${knowledgeSubjectId}/knowledgeDocuments`);
  expect(Object.fromEntries(new URL(calls[0]!.url).searchParams)).toEqual({ limit: '20' });
  expect(Object.fromEntries(new URL(calls[1]!.url).searchParams)).toEqual({ limit: '20', cursor });
  expect(calls[0]!.cache).toBe('no-store');
  expect(calls[0]!.redirect).toBe('manual');
  expect(calls[0]!.headers.get('authorization')).toBeNull();
  expect(calls[1]!.headers.get('authorization')).toBe('Bearer viewer');
  expect(knowledgeDiscoveryWire(null)).toEqual({ limit: 20 });
  expect(knowledgeDiscoveryExactHref('en', row, visitHref)).toBe(
    `/en/knowledge/documents/${knowledgeDocumentId}?revisionId=${knowledgeRevisionId}&returnTo=${encodeURIComponent(visitHref)}`,
  );
  expect(JSON.stringify(first)).not.toContain('author');
  expect(JSON.stringify(first)).not.toContain('canonicalBytes');
  expect(JSON.stringify(first)).not.toContain('notebook');
});

test('HTTP outcomes distinguish ready-empty, sparse continuation, preparing, denial, unavailable and restart', () => {
  const request = { subjectId: knowledgeSubjectId };
  expect(admitKnowledgeDiscovery(200, { state: 'ready', documents: [], next: null }, request)).toEqual({
    state: 'ready',
    page: { documents: [], next: null },
  });
  expect(admitKnowledgeDiscovery(200, { state: 'ready', documents: [], next: cursor }, request)).toEqual({
    state: 'ready',
    page: { documents: [], next: cursor },
  });
  expect(admitKnowledgeDiscovery(202, { state: 'preparing', next: cursor }, request)).toEqual({
    state: 'preparing',
    next: cursor,
  });
  expect(admitKnowledgeDiscovery(401, {}, request)).toEqual({ state: 'denied', status: 401 });
  expect(admitKnowledgeDiscovery(403, {}, request)).toEqual({ state: 'denied', status: 403 });
  expect(admitKnowledgeDiscovery(409, {}, request)).toEqual({ state: 'restart', status: 409 });
  expect(admitKnowledgeDiscovery(503, {}, request)).toEqual({ state: 'unavailable', status: 503 });
});

test('HTTP input refuses malformed identities, oversize pages, invented authors and private return coordinates', () => {
  const request = { subjectId: knowledgeSubjectId };
  expect(parseKnowledgeDiscoveryCursor('')).toBeNull();
  expect(parseKnowledgeDiscoveryCursor('x'.repeat(4865))).toBeUndefined();
  expect(parseKnowledgeDiscoveryRequest({ subjectId: knowledgeSubjectId, cursor: null, locale: 'en' })).toEqual({
    subjectId: knowledgeSubjectId,
    cursor: null,
    locale: 'en',
  });
  expect(parseKnowledgeDiscoveryRequest({ subjectId: 'latest', cursor: null, locale: 'en' })).toBeNull();
  for (const body of [
    { state: 'ready', documents: Array.from({ length: 21 }, () => row), next: null },
    { state: 'ready', documents: [{ ...row, authorId: knowledgeSubjectId }], next: null },
    { state: 'ready', documents: [{ ...row, canonicalBytes: 'eee' }], next: null },
    { state: 'ready', documents: [{ ...row, subjectId: knowledgeDocumentId }], next: null },
    { state: 'preparing', next: null },
    { state: 'ready', documents: [], next: '' },
  ])
    expect(admitKnowledgeDiscovery(200, body, request).state).toBe('unavailable');
  expect(parseKnowledgeDiscoveryReturn(visitHref, 'en', knowledgeSubjectId)).toBe(visitHref);
  expect(parseKnowledgeDiscoveryReturn(`https://evil.test${visitHref}`, 'en', knowledgeSubjectId)).toBeNull();
  expect(
    parseKnowledgeDiscoveryReturn(
      `/en/knowledge/notebooks/${knowledgeSubjectId}/documents/${knowledgeDocumentId}`,
      'en',
      knowledgeSubjectId,
    ),
  ).toBeNull();
  expect(parseKnowledgeDiscoveryReturn(`${visitHref}?authorization=secret`, 'en', knowledgeSubjectId)).toBeNull();
  expect(parseKnowledgeDiscoveryReturnPath(visitHref, 'zh-Hant')).toBeNull();
  expect(knowledgeDiscoverySearch({ returnTo: visitHref })).toEqual({ returnTo: visitHref });
  expect(knowledgeDiscoverySearch({ returnTo: 'x'.repeat(2049) })).toEqual({});
});
