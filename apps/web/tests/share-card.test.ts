import { expect, test } from 'bun:test';
import { createKernelClient, SESSION_HEADER, type SubjectRead } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import recordedPage from '../src/kernel/recorded/subject-page.json';
import recordedSubject from '../src/kernel/recorded/subject.json';
import type { SubjectPageData } from '../src/features/pages/subject';
import { projectShareCardPage, readShareCardPage } from '../src/media/share-card-page';
import { createShareCardRenderer } from '../src/media/share-card-renderer';
import {
  shareCardResponse,
  shareCardTarget,
  shareCardTitle,
  shareCardTitleLimit,
  type ShareCardProjection,
  type ShareCardTarget,
} from '../src/media/share-card';
import { shareCardImage } from '../src/shell/share-card';
import { pageHead } from '../src/shell/head';

const id = recordedSubject.subject.id;
const target = { id, locale: 'en' } as const;
const url = `https://rezics.invalid/en/cards/${id}.png`;

function pageFixture(title?: string): SubjectPageData {
  const page = structuredClone(recordedPage) as SubjectPageData;
  const read = structuredClone(recordedSubject) as SubjectRead;
  if (title !== undefined) read.subject.labels = { en: title };
  const planned = planReads(platformRegistry, page.document as CompositionDocument, { subject: id }).reads;
  for (const [key, readPlan] of Object.entries(planned))
    if (readPlan.kind === 'subject' && readPlan.id === id) page.reads[key] = { status: 200, body: read };
  return page;
}

async function renderer() {
  const [layout, raster, data] = await Promise.all([
    Bun.file(import.meta.resolve('satori/layout.wasm'))
      .arrayBuffer()
      .then(WebAssembly.compile),
    Bun.file(import.meta.resolve('@resvg/resvg-wasm/index_bg.wasm'))
      .arrayBuffer()
      .then(WebAssembly.compile),
    Bun.file(
      import.meta.resolve('@fontsource/source-serif-4/files/source-serif-4-latin-600-normal.woff'),
    ).arrayBuffer(),
  ]);
  return createShareCardRenderer({ layout, raster, fonts: () => [{ name: 'Share Serif', data, weight: 600 }] });
}

test('current anonymous-readable page data produces a bounded typographic PNG placeholder while missing or withdrawn targets never leak text', async () => {
  let status = 200;
  let page = pageFixture('Current public title');
  let reads = 0;
  let renders = 0;
  const client = createKernelClient('https://kernel.invalid', {
    fetch: async (input, init) => {
      reads++;
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe('/v1/pages:read');
      expect(request.method).toBe('POST');
      expect(request.headers.get('authorization')).toBeNull();
      expect(request.headers.get('cookie')).toBeNull();
      expect(request.headers.get(SESSION_HEADER)).toBeNull();
      expect(request.redirect).toBe('manual');
      expect(await request.json()).toEqual({ target: { subject: id }, languages: ['en'] });
      return Response.json(status === 200 ? page : { code: 'not_found' }, { status });
    },
  });
  const raster = await renderer();
  const source = {
    read: (current: ShareCardTarget) => readShareCardPage(client, current),
    render: async (current: Parameters<typeof raster>[0]) => {
      renders++;
      return raster(current);
    },
  };
  const first = await shareCardResponse(
    new Request(`${url}?title=Secret&slug=private&image=https://foreign.invalid`, {
      headers: { cookie: 'private=session', authorization: 'Bearer private' },
    }),
    source,
  );
  expect(first.status).toBe(200);
  expect(first.headers.get('content-type')).toBe('image/png');
  expect(first.headers.get('cache-control')).toBe('private, no-store');
  expect(first.headers.has('etag')).toBe(false);
  const bytes = new Uint8Array(await first.arrayBuffer());
  expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const dimensions = new DataView(bytes.buffer);
  expect([dimensions.getUint32(16), dimensions.getUint32(20)]).toEqual([1200, 630]);
  expect(bytes.byteLength).toBeLessThan(4 * 1024 * 1024);

  page = pageFixture('Renamed public title');
  const renamed = await shareCardResponse(
    new Request(url, { headers: { 'if-none-match': '*', 'if-modified-since': new Date().toUTCString() } }),
    source,
  );
  expect(renamed.status).toBe(200);
  expect(new Uint8Array(await renamed.arrayBuffer())).not.toEqual(bytes);
  for (const missing of [404, 403, 410, 451]) {
    status = missing;
    const withdrawn = await shareCardResponse(new Request(url, { headers: { 'if-none-match': '*' } }), source);
    expect(withdrawn.status).toBe(404);
    expect(withdrawn.headers.get('cache-control')).toBe('private, no-store');
    expect(await withdrawn.text()).toBe('Not found');
  }
  status = 200;
  expect((await shareCardResponse(new Request(url, { method: 'HEAD' }), source)).status).toBe(200);
  expect(reads).toBe(7);
  expect(renders).toBe(2);
});

test('concealed embedded reads, missing projections and redirects never manufacture public cards', () => {
  const page = pageFixture();
  const key = Object.keys(page.reads).find((key) => {
    const body = page.reads[key]!.body;
    return body && typeof body === 'object' && 'subject' in body;
  })!;
  page.reads[key] = { status: 404, body: { code: 'not_found', title: 'Must not escape' } };
  expect(projectShareCardPage({ kind: 'page', page }, target)).toEqual({ kind: 'missing' });
  page.reads[key] = { status: 503, body: { code: 'unavailable' } };
  expect(projectShareCardPage({ kind: 'page', page }, target)).toEqual({ kind: 'unavailable' });
  expect(projectShareCardPage({ kind: 'redirect', id }, target)).toEqual({ kind: 'unavailable' });
  expect(projectShareCardPage({ kind: 'page', page: { ...page, subject: null } }, target)).toEqual({
    kind: 'unavailable',
  });
});

test('unready or failed source and renderer return genuine no-store 503 without old text', async () => {
  const ready = projectShareCardPage({ kind: 'page', page: pageFixture() }, target);
  for (const read of [
    async (): Promise<ShareCardProjection> => ({ kind: 'unavailable' }),
    async (): Promise<ShareCardProjection> => {
      throw new Error('Old secret title');
    },
    async () => ready,
  ]) {
    const result = await shareCardResponse(new Request(url), {
      read,
      render: async () => {
        throw new Error('Old secret title');
      },
    });
    expect(result.status).toBe(503);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(await result.text()).toBe('Service unavailable');
  }
  const malformed = await shareCardResponse(new Request(url), {
    read: async () => ready,
    render: async () => new Uint8Array(24),
  });
  expect(malformed.status).toBe(503);
});

test('identity, locale, bounded Unicode text and methods have fixed public inputs', async () => {
  expect(shareCardTarget(new Request(url))).toEqual(target);
  expect(shareCardTarget(new Request(url.replace('/en/', '/xx/')))).toBeUndefined();
  expect(shareCardTarget(new Request(url.replace(id, 'a-title')))).toBeUndefined();
  const title = shareCardTitle('漢😀'.repeat(1000));
  expect(Array.from(title)).toHaveLength(shareCardTitleLimit);
  expect(title).toEndWith('…');
  expect(shareCardTitle('  A\n B\u0000 ')).toBe('A B');
  let reads = 0;
  const source = {
    read: async (): Promise<ShareCardProjection> => {
      reads++;
      return { kind: 'unavailable' };
    },
    render: async () => new Uint8Array(),
  };
  expect((await shareCardResponse(new Request(url, { method: 'POST' }), source)).status).toBe(405);
  expect((await shareCardResponse(new Request(url.replace(id, 'invalid')), source)).status).toBe(404);
  expect(reads).toBe(0);
});

test('optional head integration retains genuine covers and only selects a generated placeholder for a ready anonymous page', () => {
  const projection = projectShareCardPage({ kind: 'page', page: pageFixture() }, target);
  if (projection.kind !== 'ready') throw new Error('Expected current anonymous page projection');
  const { cover: _cover, ...withoutCover } = projection.page;
  const uncovered = { ...projection, page: withoutCover };
  // The optional helper is deliberately independent of Search's Subject head formula.
  const image = shareCardImage(uncovered);
  expect(image).toEqual({ url: `/en/cards/${id}.png`, width: 1200, height: 630, alt: projection.page.title });
  expect(pageHead({ image }, { origin: 'https://rezics.invalid', locale: 'en', path: '/' }).meta).toContainEqual({
    property: 'og:image',
    content: url,
  });
  for (const unavailable of [undefined, { kind: 'missing' }, { kind: 'unavailable' }] as const)
    expect(shareCardImage(unavailable)).toEqual({ url: '/cards/default.png', width: 1200, height: 630, alt: 'REZICS' });
  const cover = {
    media: id,
    width: 600,
    height: 900,
    placeholder: { thumbhash: '', color: '#334455' },
    variants: [{ format: 'webp' as const, width: 600 }],
    focalPoint: null,
    credit: null,
  };
  expect(shareCardImage({ ...projection, page: { ...projection.page, cover } }).url).toContain('/media/');
  expect(
    shareCardImage({ ...projection, page: { ...projection.page, cover: { ...cover, withheld: 'suitability' } } }).url,
  ).toBe(`/en/cards/${id}.png`);
});
