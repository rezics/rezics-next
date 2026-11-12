import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import {
  knowledgeDocumentId,
  knowledgeExactRequest,
  knowledgeLiveRequest,
  knowledgeOtherRevisionId,
  knowledgePublicDto,
  knowledgePublicationText,
  knowledgeRevisionId,
  knowledgeSubjectId,
} from '../src/stories/knowledge-document-fixtures';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const {
  admitKnowledgePublicResponse,
  copyKnowledgeCitation,
  knowledgeCitationHref,
  knowledgeExactHref,
  knowledgeId,
  knowledgeLiveHref,
  knowledgeRevisionQuery,
  parseKnowledgeReadRequest,
  readKnowledgePublicDocument,
} = await import('../src/knowledge/public-read');
const { knowledgeDocumentRequest, knowledgeDocumentSearch } = await import('../src/knowledge/route');

function clientFor(handle: (request: Request) => Response | Promise<Response>, calls: Request[] = []) {
  return {
    calls,
    client: createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        return handle(request);
      }) as typeof fetch,
    }),
  };
}

test('route and query boundaries admit only native identifiers', () => {
  expect(knowledgeId(knowledgeDocumentId)).toBe(knowledgeDocumentId);
  expect(knowledgeId(knowledgeDocumentId.toUpperCase())).toBe(knowledgeDocumentId);
  expect(knowledgeId('not-a-uuid')).toBeNull();
  expect(knowledgeRevisionQuery(undefined)).toBeUndefined();
  expect(knowledgeRevisionQuery('')).toBeUndefined();
  expect(knowledgeRevisionQuery('latest')).toBeNull();
  expect(knowledgeDocumentSearch({})).toEqual({});
  expect(knowledgeDocumentSearch({ revisionId: knowledgeRevisionId })).toEqual({ revisionId: knowledgeRevisionId });
  expect(() => knowledgeDocumentSearch({ revisionId: 'latest' })).toThrow();
  expect(knowledgeDocumentRequest('bad', undefined, 'en')).toBeNull();
  expect(knowledgeDocumentRequest(knowledgeDocumentId, 'latest', 'en')).toBeNull();
  expect(parseKnowledgeReadRequest({ documentId: knowledgeDocumentId, revisionId: null, locale: 'en' })).toEqual(
    knowledgeLiveRequest,
  );
  expect(parseKnowledgeReadRequest({ documentId: knowledgeDocumentId, revisionId: 'latest', locale: 'en' })).toBeNull();
});

test('live and exact public reads admit the supplied canonical body once with anonymous no-store transport', async () => {
  const dto = knowledgePublicDto();
  const { calls, client } = clientFor((request) => {
    expect(request.method).toBe('GET');
    expect(request.cache).toBe('no-store');
    expect(request.redirect).toBe('manual');
    expect(request.headers.get('authorization')).toBeNull();
    return Response.json(dto);
  });
  const live = await readKnowledgePublicDocument(client, knowledgeLiveRequest);
  expect(live.state).toBe('ready');
  if (live.state !== 'ready') throw new Error('expected ready');
  const { parseDocument } = await import('@rezics/document');
  expect(live.document.body).toEqual(
    parseDocument(JSON.parse(Buffer.from(String(dto.document.canonicalBytes), 'base64').toString('utf8'))),
  );
  expect(JSON.stringify(live.document.body)).toContain(knowledgePublicationText);
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/knowledge/documents/${knowledgeDocumentId}`);
  expect(new URL(calls[0]!.url).searchParams.get('revisionId')).toBeNull();

  const exact = await readKnowledgePublicDocument(client, knowledgeExactRequest);
  expect(exact.state).toBe('ready');
  expect(calls).toHaveLength(2);
  expect(new URL(calls[1]!.url).searchParams.get('revisionId')).toBe(knowledgeRevisionId);
  expect(knowledgeLiveHref('en', knowledgeDocumentId)).toBe(`/en/knowledge/documents/${knowledgeDocumentId}`);
  expect(knowledgeExactHref('en', knowledgeDocumentId, knowledgeRevisionId)).toBe(
    `/en/knowledge/documents/${knowledgeDocumentId}?revisionId=${knowledgeRevisionId}`,
  );
  expect(knowledgeCitationHref('zh-Hant', live.document)).toBe(
    knowledgeExactHref('zh-Hant', knowledgeDocumentId, knowledgeRevisionId),
  );
});

test('native outcome states and malformed HTTP stay unavailable at the exact address', async () => {
  const live = knowledgeLiveRequest;
  const exact = knowledgeExactRequest;
  expect(admitKnowledgePublicResponse(404, {}, exact)).toEqual({ state: 'not-found', status: 404 });
  expect(admitKnowledgePublicResponse(401, {}, live)).toEqual({ state: 'denied', status: 401 });
  expect(admitKnowledgePublicResponse(403, {}, live)).toEqual({ state: 'denied', status: 403 });
  expect(admitKnowledgePublicResponse(503, {}, live)).toEqual({ state: 'unavailable', status: 503 });
  expect(admitKnowledgePublicResponse(200, knowledgePublicDto({ documentId: knowledgeSubjectId }), live)).toEqual({
    state: 'unavailable',
    status: 502,
  });
  expect(
    admitKnowledgePublicResponse(200, knowledgePublicDto({ revisionId: knowledgeOtherRevisionId }), exact),
  ).toEqual({ state: 'unavailable', status: 502 });
  const mismatched = admitKnowledgePublicResponse(
    200,
    knowledgePublicDto({ revisionId: knowledgeOtherRevisionId }),
    exact,
  );
  expect(mismatched.state).not.toBe('ready');
  expect(JSON.stringify(mismatched)).not.toContain(knowledgePublicationText);

  for (const body of [
    knowledgePublicDto({ canonicalBytes: '@@@' }),
    knowledgePublicDto({ canonicalBytes: Buffer.from('{', 'utf8').toString('base64') }),
    knowledgePublicDto({ sha256: 'gg' }),
    knowledgePublicDto({ title: '' }),
    knowledgePublicDto({ language: 1 }),
    knowledgePublicDto({ authorId: 'Anonymous' }),
    knowledgePublicDto({ publishedAt: 'soon' }),
    knowledgePublicDto({ subjectIds: ['bad'] }),
    'not-json',
    null,
    { document: null },
  ])
    expect(admitKnowledgePublicResponse(200, body, live).state).toBe('unavailable');

  const { client } = clientFor(() => Response.json({ document: { extra: true } }, { status: 200 }));
  expect(await readKnowledgePublicDocument(client, live)).toEqual({ state: 'unavailable', status: 502 });
  const missing = clientFor(() => new Response(null, { status: 404 }));
  expect(await readKnowledgePublicDocument(missing.client, exact)).toEqual({ state: 'not-found', status: 404 });
});

test('copy reports success, permission denial and missing clipboard', async () => {
  expect(await copyKnowledgeCitation('https://site.test/cite', null)).toBe('unavailable');
  expect(await copyKnowledgeCitation('https://site.test/cite', { writeText: async () => undefined })).toBe('success');
  expect(
    await copyKnowledgeCitation('https://site.test/cite', {
      writeText: async () => {
        throw Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
      },
    }),
  ).toBe('denied');
  expect(
    await copyKnowledgeCitation('https://site.test/cite', {
      writeText: async () => {
        throw new Error('offline');
      },
    }),
  ).toBe('unavailable');
});

test('the mounted reader binds one anonymous public_read with private no-store policy', async () => {
  const publicRead = await Bun.file(new URL('../src/knowledge/public-read.ts', import.meta.url)).text();
  expect(publicRead).toContain('client.knowledge.documents({ id: request.documentId }).get({');
  expect(publicRead).toContain("cache: 'no-store'");
  expect(publicRead).toContain("redirect: 'manual'");
  expect(publicRead).toContain('kernelClient(data.locale)');
  expect(publicRead).toContain("'private, no-store'");
  expect(publicRead).not.toContain('authorization');
  const route = await Bun.file(new URL('../src/routes/knowledge/documents/$id.tsx', import.meta.url)).text();
  expect(route).toContain("createFileRoute('/knowledge/documents/$id')");
  expect(route).toContain('staleTime: 0');
  expect(route).toContain('gcTime: 0');
  expect(route).toContain('shouldReload: true');
  expect(route).not.toContain('publicCache');
});
