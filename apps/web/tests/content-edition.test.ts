import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { createKernelClient, SESSION_HEADER } from '@rezics/client';
import {
  createNativeEditionApi,
  nativeEditionApi,
  type EditionApi,
  type EditionMetadata,
  type EditionRevision,
} from '../src/content-editions/edition-api';
import {
  editionDocumentDigest,
  loadContentEdition,
  type ContentEditionState,
} from '../src/content-editions/edition-model';
import { ContentEditionReader } from '../src/content-editions/edition-view';
import { m } from '../src/paraglide/messages.js';

const id = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const creatorId = '0192f3a0-6c1e-7b2a-9d4e-000000000090';
const revisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const fixedText = 'These are the fixed purchased words, not today’s post.';
const body: DocumentSnapshot = {
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'fixed-p1' }, content: [{ type: 'text', text: fixedText }] },
      { type: 'image', attrs: { id: 'fixed-image', src: creatorId, alt: 'The fixed illustration' } },
    ],
  },
};
const html = (page: ContentEditionState, editionId = id) =>
  renderToStaticMarkup(createElement(ContentEditionReader, { editionId, page }));

async function fixture() {
  const metadata: EditionMetadata = {
    editionId: id,
    editionRevision: '2',
    state: 'published',
    targetSubjectId: subjectId,
    creatorAccountId: creatorId,
    revisionId,
    sha256: await editionDocumentDigest(body),
    licence: 'CC-BY-SA-4.0',
  };
  const revision: EditionRevision = {
    editionId: id,
    revisionId,
    sha256: metadata.sha256,
    licence: metadata.licence,
    body,
  };
  const calls: { path: string; authorization: string }[] = [];
  const api: EditionApi = {
    async readMetadata(editionId, authorization) {
      calls.push({ path: `/v1/contentEditions/${editionId}`, authorization });
      return { state: 'available', value: metadata };
    },
    async readRevision(editionId, authorization) {
      calls.push({ path: `/v1/contentEditions/${editionId}/revision`, authorization });
      return { state: 'available', value: revision };
    },
  };
  return { api, metadata, revision, calls };
}

test('owned fixed native edition route reads exact document version through protected API and shows honest unavailable refusal without alternate source or invented paid image URL', async () => {
  const { api, metadata, calls } = await fixture();
  const identityCalls: string[] = [];
  const ready = await loadContentEdition(api, id, 'Bearer actual-buyer', {
    subject: async (point) => {
      identityCalls.push(point);
      return { id: point, label: 'A readable subject' };
    },
    creator: async (point) => {
      identityCalls.push(point);
      return { id: point, name: 'Visible creator' };
    },
  });
  expect(ready.state).toBe('published');
  const rendered = html(ready);
  for (const text of [
    fixedText,
    metadata.licence,
    revisionId,
    metadata.sha256,
    'A readable subject',
    'Visible creator',
  ])
    expect(rendered).toContain(text);
  expect(rendered).toContain(`data-block-id="fixed-p1"`);
  expect(rendered).toContain(`/subjects/${subjectId}/`);
  expect(rendered).toContain(m.content_edition_image_unavailable());
  for (const forbidden of ['<img', '/media/', '/original', '<main', '<pre', '/posts/', '/accounts/', 'checkout'])
    expect(rendered).not.toContain(forbidden);
  expect(calls).toEqual([
    { path: `/v1/contentEditions/${id}`, authorization: 'Bearer actual-buyer' },
    { path: `/v1/contentEditions/${id}/revision`, authorization: 'Bearer actual-buyer' },
  ]);
  expect(identityCalls.sort()).toEqual([subjectId, creatorId].sort());

  const unknownIdentity = await loadContentEdition(api, id, 'Bearer actual-buyer', {
    subject: async () => ({ id: creatorId, label: 'Unrelated subject' }),
    creator: async () => {
      throw new Error('Identity unavailable');
    },
  });
  expect(unknownIdentity.state).toBe('published');
  expect(html(unknownIdentity)).toContain(fixedText);
  expect(html(unknownIdentity)).toContain(`>${m.content_edition_heading()}</h1>`);
  expect(html(unknownIdentity)).not.toContain('Unrelated subject');
  expect(html(unknownIdentity)).not.toContain('/subjects/');
  expect(html(ready, creatorId)).not.toContain(fixedText);

  const route = await Bun.file(new URL('../src/routes/editions/$id.tsx', import.meta.url)).text();
  expect(route).toContain("createFileRoute('/editions/$id')");
  expect(route).toContain('readContentEdition');
  expect(route).toContain('router.invalidate()');
  expect(route).toContain('gcTime: 0');
  expect(route).not.toContain('publicCache: true');
});

test('current denial, missing producer, withdrawal, malformed wire and mismatches discard all prior document facts; retry re-reads both exact sources', async () => {
  const { api, metadata, revision, calls } = await fixture();
  const concealed = (page: ContentEditionState) => {
    const rendered = html(page);
    for (const value of [
      fixedText,
      metadata.licence,
      revisionId,
      metadata.sha256,
      'data-slot="document-body"',
      '/media/',
      '/subjects/',
    ])
      expect(rendered).not.toContain(value);
    expect(page.state).not.toBe('published');
  };
  concealed(await loadContentEdition(api, id, null));
  expect(calls).toHaveLength(0);
  const pending = await loadContentEdition(nativeEditionApi, id, 'Bearer actual-buyer');
  expect(pending).toEqual({ state: 'unavailable', status: 503, reason: 'native-pending' });
  concealed(pending);
  expect(html(pending)).toContain(m.content_edition_unavailable());

  for (const value of [
    { ...metadata, editionId: creatorId },
    { ...metadata, extra: true },
    { ...metadata, state: 'draft' },
    { ...metadata, state: 'withdrawn' },
  ]) {
    const page = await loadContentEdition(
      { ...api, readMetadata: async () => ({ state: 'available', value }) as never },
      id,
      'Bearer actual-buyer',
    );
    concealed(page);
    expect(page.state).toBe(
      value.state === 'withdrawn' ? 'withdrawn' : value.state === 'draft' ? 'unavailable' : 'version-mismatch',
    );
  }
  expect(calls).toHaveLength(0); // No revision is fetched for an invalid or unpublished edition.

  for (const field of ['editionId', 'revisionId', 'sha256', 'licence'] as const) {
    const value = { ...revision, [field]: field === 'sha256' ? '0'.repeat(64) : 'different' };
    const page = await loadContentEdition(
      { ...api, readRevision: async () => ({ state: 'available', value }) },
      id,
      'Bearer actual-buyer',
    );
    expect(page.state).toBe('version-mismatch');
    concealed(page);
  }
  for (const value of [
    { ...revision, body: fromPlainText('A substituted current post') },
    { ...revision, extra: 'not in the closed schema' },
    { ...revision, body: { ...body, extra: true } },
  ]) {
    const page = await loadContentEdition(
      { ...api, readRevision: async () => ({ state: 'available', value }) as never },
      id,
      'Bearer actual-buyer',
    );
    expect(page.state).toBe('version-mismatch');
    concealed(page);
  }
  for (const stage of ['readMetadata', 'readRevision'] as const) {
    for (const status of [401, 403] as const) {
      const page = await loadContentEdition(
        { ...api, [stage]: async () => ({ state: 'refused', status }) },
        id,
        'Bearer actual-buyer',
      );
      expect(page).toEqual({ state: 'refused', status });
      expect(html(page)).toContain(m.content_edition_refused());
      concealed(page);
    }
    for (const failure of [
      async () => ({ state: 'unavailable', status: 404, reason: 'source' }) as const,
      async () => {
        throw new Error('Protected source disconnected');
      },
    ])
      concealed(await loadContentEdition({ ...api, [stage]: failure }, id, 'Bearer actual-buyer'));
  }
  calls.length = 0;
  concealed(
    await loadContentEdition(
      { ...api, readRevision: async () => ({ state: 'refused', status: 403 }) },
      id,
      'Bearer actual-buyer',
    ),
  );
  expect((await loadContentEdition(api, id, 'Bearer actual-buyer')).state).toBe('published');
  expect(calls.map((call) => call.path)).toEqual([
    `/v1/contentEditions/${id}`,
    `/v1/contentEditions/${id}`,
    `/v1/contentEditions/${id}/revision`,
  ]);
  concealed({ state: 'loading' });
});

test('the assigned real current-authorized journey binds its native source while privacy retry and request bounds remain meaningful', async () => {
  const { metadata, revision } = await fixture();
  const requests: Request[] = [];
  let denied = false;
  let current = metadata;
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(request.headers.get('authorization')).toBe('Bearer actual-buyer');
      expect(request.redirect).toBe('manual');
      expect(request.cache).toBe('no-store');
      expect(request.method).toBe('GET');
      if (new URL(request.url).pathname === `/v1/contentEditions/${id}`)
        return Response.json(current, {
          headers: { [SESSION_HEADER]: 'native-metadata', 'cache-control': 'private, no-store' },
        });
      expect(new URL(request.url).pathname).toBe(`/v1/contentEditions/${id}/revision`);
      expect(request.headers.get(SESSION_HEADER)).toBe('native-metadata');
      return denied
        ? Response.json({ code: 'forbidden' }, { status: 403 })
        : Response.json(revision, { headers: { 'cache-control': 'private, no-store' } });
    }) as typeof fetch,
  });
  const api = createNativeEditionApi(client);
  const context = {
    subject: async (point: string) => ({ id: point, label: 'Current selected subject' }),
    creator: async (point: string) => ({ id: point, name: 'Visible creator' }),
  };
  expect(await loadContentEdition(api, id, null, context)).toEqual({ state: 'refused', status: 401 });
  expect(requests).toHaveLength(0);
  const ready = await loadContentEdition(api, id, 'Bearer actual-buyer', context);
  expect(ready.state).toBe('published');
  expect(html(ready)).toContain(fixedText);
  expect(requests).toHaveLength(2);

  denied = true;
  const refused = await loadContentEdition(api, id, 'Bearer actual-buyer', context);
  expect(refused).toEqual({ state: 'refused', status: 403 });
  for (const value of [fixedText, metadata.sha256, metadata.licence, revisionId, '/subjects/'])
    expect(html(refused)).not.toContain(value);
  expect(requests).toHaveLength(4);

  denied = false;
  current = { ...metadata, editionRevision: '3', targetSubjectId: creatorId };
  const retried = await loadContentEdition(api, id, 'Bearer actual-buyer', context);
  expect(retried.state).toBe('published');
  expect(html(retried)).toContain(`/subjects/${creatorId}/`);
  expect(html(retried)).not.toContain(`/subjects/${subjectId}/`);
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual(
    Array.from({ length: 3 }, () => [`/v1/contentEditions/${id}`, `/v1/contentEditions/${id}/revision`]).flat(),
  );
  const binding = await Bun.file(new URL('../src/content-editions/edition-read.ts', import.meta.url)).text();
  expect(binding).toContain('createNativeEditionApi(client)');
  expect(binding).toContain('await prepareSession(request');
  expect(binding).toContain('viewerCredential(request)');
});

test('Native authorized document images in the real paid edition reader', async () => {
  const { metadata, revision } = await fixture();
  const { loadDocumentMedia } = await import('../src/content-editions/edition-media');
  const image: import('../src/content-editions/edition-media').DocumentImagePresentation = {
    id: creatorId,
    containerId: subjectId,
    digest: 'a'.repeat(64),
    width: 640,
    height: 320,
    variants: [
      { format: 'webp', width: 320, height: 160 },
      { format: 'webp', width: 640, height: 320 },
    ],
    placeholder: null,
    focalPoint: null,
    credit: {
      rightsHolder: 'Example illustrator',
      via: { name: 'Illustration source', url: 'https://example.com/illustration' },
      license: 'CC-BY-4.0',
      obligations: ['cc:Attribution'],
    },
  };
  let mediaState: 'allowed' | 'omitted' | 'failed' = 'allowed';
  let bodyDenied = false;
  let sourceMissing = false;
  const paths: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      paths.push(path);
      expect(request.headers.get('authorization')).toBe('Bearer actual-buyer');
      expect(request.redirect).toBe('manual');
      expect(request.cache).toBe('no-store');
      if (path === `/v1/contentEditions/${id}`)
        return Response.json(metadata, { headers: { [SESSION_HEADER]: 'current-edition-session' } });
      expect(request.headers.get(SESSION_HEADER)).toBe('current-edition-session');
      if (path === `/v1/contentEditions/${id}/revision`)
        return bodyDenied || sourceMissing
          ? Response.json({ code: 'unavailable' }, { status: bodyDenied ? 403 : 404 })
          : Response.json(revision);
      expect(path).toBe('/v1/media/presentations');
      expect(request.method).toBe('POST');
      expect(await request.json()).toEqual({ ids: [creatorId] });
      if (mediaState === 'failed') return Response.json({ code: 'unavailable' }, { status: 503 });
      return Response.json({ images: mediaState === 'allowed' ? [image] : [] });
    }) as typeof fetch,
  });
  const api = createNativeEditionApi(client);
  const context = {
    subject: async (point: string) => ({ id: point, label: 'A readable subject' }),
    creator: async (point: string) => ({ id: point, name: 'Visible creator' }),
    media: (ids: readonly string[], authorization: string) => loadDocumentMedia(client, ids, authorization),
  };
  const page = await loadContentEdition(api, id, 'Bearer actual-buyer', context);
  expect(page.state).toBe('published');
  if (page.state !== 'published') throw new Error('Expected the authorized fixed edition');
  expect(page.media).toEqual({ kind: 'ready', images: [image] });
  const rendered = html(page);
  expect(rendered).toContain('<img');
  expect(rendered).toContain('alt="The fixed illustration"');
  expect(rendered).toMatch(new RegExp(`/media/${creatorId}/webp-(320|640)`));
  expect(rendered).toContain('Example illustrator');
  expect(rendered).toContain('CC-BY-4.0');
  expect(rendered).toContain('Visible creator');
  expect(rendered).toContain('A readable subject');
  for (const forbidden of ['Bearer', '/original', '<main', '/posts/', 'objectKey', 'sourceUrl'])
    expect(rendered).not.toContain(forbidden);
  expect(paths).toEqual([`/v1/contentEditions/${id}`, `/v1/contentEditions/${id}/revision`, '/v1/media/presentations']);

  for (const state of ['omitted', 'failed'] as const) {
    mediaState = state;
    const fresh = await loadContentEdition(api, id, 'Bearer actual-buyer', context);
    expect(fresh.state).toBe('published');
    if (fresh.state !== 'published') throw new Error('Independent image failure must retain the authorized document');
    expect(fresh.media).toEqual(state === 'omitted' ? { kind: 'ready', images: [] } : { kind: 'unavailable' });
    const unavailable = html(fresh);
    expect(unavailable).toContain(fixedText);
    expect(unavailable).toContain(m.content_edition_image_unavailable());
    expect(unavailable).not.toContain('<img');
    expect(unavailable).not.toContain('Example illustrator');
  }
  expect(paths.filter((path) => path === '/v1/media/presentations')).toHaveLength(3);
  bodyDenied = true;
  const refused = await loadContentEdition(api, id, 'Bearer actual-buyer', context);
  expect(refused).toEqual({ state: 'refused', status: 403 });
  expect(html(refused)).not.toContain(fixedText);
  bodyDenied = false;
  sourceMissing = true;
  const missing = await loadContentEdition(api, id, 'Bearer actual-buyer', context);
  expect(missing.state).toBe('unavailable');
  expect(html(missing)).not.toContain(fixedText);
  expect(paths.filter((path) => path === '/v1/media/presentations')).toHaveLength(3);
});

test('edition image decoration uses one bounded batch of exact current document references without refill', async () => {
  const { api, metadata, revision } = await fixture();
  const image = (id: string): import('../src/content-editions/edition-media').DocumentImagePresentation => ({
    id,
    containerId: subjectId,
    digest: 'a'.repeat(64),
    width: 320,
    height: 160,
    variants: [{ format: 'webp', width: 320, height: 160 }],
    placeholder: null,
    focalPoint: null,
    credit: null,
  });
  const mediaCalls: { ids: readonly string[]; authorization: string }[] = [];
  const context = {
    subject: async () => null,
    creator: async () => null,
    media: async (ids: readonly string[], authorization: string) => {
      mediaCalls.push({ ids, authorization });
      return {
        kind: 'ready',
        images: new Map([
          [creatorId, image(creatorId)],
          [subjectId, image(subjectId)],
        ]),
      } as const;
    },
  };
  const withBody = async (body: DocumentSnapshot) => {
    const sha256 = await editionDocumentDigest(body);
    return loadContentEdition(
      {
        readMetadata: async () => ({ state: 'available', value: { ...metadata, sha256 } }),
        readRevision: async () => ({ state: 'available', value: { ...revision, sha256, body } }),
      },
      id,
      'Bearer actual-buyer',
      context,
    );
  };
  const repeated: DocumentSnapshot = {
    ...body,
    doc: {
      type: 'doc',
      content: [
        ...body.doc.content!,
        {
          type: 'blockquote',
          content: [
            { type: 'image', attrs: { id: 'nested-image', src: creatorId, alt: 'Repeated image' } },
            { type: 'image', attrs: { id: 'missing-image', src: revisionId, alt: 'Unavailable image' } },
            { type: 'image', attrs: { id: 'external-image', src: 'https://example.com/image.webp', alt: 'External' } },
          ],
        },
      ],
    },
  };
  const ready = await withBody(repeated);
  expect(mediaCalls).toEqual([{ ids: [creatorId, revisionId], authorization: 'Bearer actual-buyer' }]);
  expect(ready.state).toBe('published');
  if (ready.state !== 'published') throw new Error('Expected the fixed document');
  expect(ready.media).toEqual({ kind: 'ready', images: [image(creatorId)] });

  const many = (count: number): DocumentSnapshot => ({
    ...body,
    doc: {
      type: 'doc',
      content: Array.from({ length: count }, (_, index) => ({
        type: 'image',
        attrs: {
          id: `image-${index}`,
          src: `0192f3a0-6c1e-7b2a-9d4e-${String(index + 100).padStart(12, '0')}`,
          alt: `Illustration ${index + 1}`,
        },
      })),
    },
  });
  await withBody(many(32));
  expect(mediaCalls).toHaveLength(2);
  expect(mediaCalls[1]!.ids).toHaveLength(32);
  const overflow = await withBody(many(33));
  expect(overflow.state).toBe('published');
  if (overflow.state !== 'published') throw new Error('An image bound does not refuse the authorized text');
  expect(overflow.media).toEqual({ kind: 'unavailable' });
  await withBody(fromPlainText('A fixed text-only document'));
  expect(mediaCalls).toHaveLength(2);
  const mismatched = await loadContentEdition(
    { ...api, readRevision: async () => ({ state: 'available', value: { ...revision, sha256: '0'.repeat(64) } }) },
    id,
    'Bearer actual-buyer',
    context,
  );
  expect(mismatched.state).toBe('version-mismatch');
  expect(mediaCalls).toHaveLength(2);
});

test('native transport decodes closed owner responses and conceals malformed, changed, unavailable and unpublished sources without extra requests', async () => {
  const { metadata, revision } = await fixture();
  for (const scenario of [
    { metadata: { ...metadata, extra: true }, revision, state: 'version-mismatch', reads: 1 },
    { metadata: { ...metadata, state: 'draft' }, revision, state: 'unavailable', reads: 1 },
    { metadata: { ...metadata, state: 'withdrawn' }, revision, state: 'withdrawn', reads: 1 },
    {
      metadata,
      revision: { ...revision, body: fromPlainText('A newer current post') },
      state: 'version-mismatch',
      reads: 2,
    },
    { metadata, revision: { ...revision, extra: true }, state: 'version-mismatch', reads: 2 },
    { metadata, revision, status: 404, state: 'unavailable', reads: 2 },
    { metadata, revision, status: 503, state: 'unavailable', reads: 2 },
    { metadata, revision, status: 307, state: 'unavailable', reads: 2 },
  ]) {
    let reads = 0;
    const api = createNativeEditionApi(
      createKernelClient('https://kernel.test', {
        fetch: (async () => {
          reads++;
          return reads === 1
            ? Response.json(scenario.metadata)
            : Response.json(scenario.revision, { status: scenario.status ?? 200 });
        }) as typeof fetch,
      }),
    );
    const page = await loadContentEdition(api, id, 'Bearer actual-buyer');
    expect(page.state).toBe(scenario.state);
    expect(reads).toBe(scenario.reads);
    for (const value of [fixedText, metadata.sha256, metadata.licence, revisionId, 'data-slot="document-body"'])
      expect(html(page)).not.toContain(value);
  }
});
