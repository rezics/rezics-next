import { startDevServer } from './support/dev-server.ts';
import { afterAll, expect, mock, test } from 'bun:test';
import { slug } from '@rezics/definitions/slug';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { planReads, platformRegistry, type View, type CompositionDocument } from '@rezics/composition';
import { validateViewCursor } from '../src/features/pages/view-cursor.ts';

// The page modules reach server functions, so they load only after the workers runtime is stubbed.
mock.module('cloudflare:workers', () => ({ env: {} }));
const { holderItems } = await import('../src/features/pages/overview.tsx');
const { loadViewPages, SubjectViewPage } = await import('../src/features/pages/subject-frame.tsx');
const { pageContext } = await import('../src/features/pages/subject.tsx');

const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';

type RequestRecord = { method: string; path: string; search: URLSearchParams; body?: unknown };

function clientWith(requests: RequestRecord[], listSize?: number, pageNext?: string) {
  const fake = createFakeKernelFetch(fixtures as never);
  return createKernelClient('https://kernel.invalid', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.clone().json() : undefined;
      requests.push({
        method: request.method,
        path: url.pathname,
        search: url.searchParams,
        ...(body !== undefined ? { body } : {}),
      });
      if (listSize !== undefined && request.method === 'GET' && url.pathname.endsWith('/links')) {
        return Response.json({
          links: Array.from(
            { length: Math.min(listSize, Number(url.searchParams.get('limit') ?? 24)) },
            (_, index) => ({
              subject: `0192f3a0-6c1e-7b2a-9d4e-${String(index + 1).padStart(12, '0')}`,
            }),
          ),
          count: { value: listSize + 1, exact: false },
          next: 'next-from-owner',
        });
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/v1/pages:read' &&
        body &&
        typeof body === 'object' &&
        body.continuation?.cursor === 'refuse'
      ) {
        return Response.json({ code: 'invalid_cursor' }, { status: 400 });
      }
      const response = await fake(request);
      if (request.method === 'POST' && url.pathname === '/v1/pages:read') {
        const target = (body as { target?: { view?: string } } | undefined)?.target;
        const cursor = (body as { continuation?: { cursor?: string } } | undefined)?.continuation?.cursor;
        if (target?.view === 'editions' && (pageNext !== undefined || (listSize !== undefined && cursor))) {
          const page = await response.clone().json();
          for (const read of Object.values(page.reads as Record<string, { body?: Record<string, unknown> }>)) {
            if (read.body && Array.isArray(read.body.links)) {
              if (listSize !== undefined && cursor) {
                read.body.links = Array.from({ length: Math.min(listSize, 24) }, (_, index) => ({
                  subject: `0192f3a0-6c1e-7b2a-9d4e-${String(index + 1).padStart(12, '0')}`,
                }));
              }
              read.body.next = pageNext ?? 'next-from-owner';
            }
          }
          return Response.json(page, { status: response.status });
        }
      }
      return response;
    }) as typeof fetch,
  });
}

test('a cursor view keeps both page reads and continues the selected stream on native pages.read', async () => {
  const requests: RequestRecord[] = [];
  const loaded = await loadViewPages(clientWith(requests, 30), subject, 'editions', 'en', 'opaque-next');
  expect(loaded.kind).toBe('page');
  if (loaded.kind !== 'page') return;
  const reads = requests.filter((request) => request.method === 'POST' && request.path === '/v1/pages:read');
  expect(reads).toHaveLength(3);
  expect(reads.map(({ body }) => body)).toContainEqual({ target: { subject, view: 'editions' }, languages: ['en'] });
  expect(reads.map(({ body }) => body)).toContainEqual({ target: { subject }, languages: ['en'] });
  const continued = reads.find(
    (request) =>
      request.body &&
      typeof request.body === 'object' &&
      'continuation' in request.body &&
      (request.body as { continuation?: { cursor?: string } }).continuation?.cursor === 'opaque-next',
  );
  expect(continued?.body).toMatchObject({
    target: { subject, view: 'editions' },
    continuation: { cursor: 'opaque-next' },
    languages: ['en'],
  });
  expect(typeof (continued?.body as { stream?: string }).stream).toBe('string');
  const planned = Object.values(
    planReads(platformRegistry, loaded.page.document as CompositionDocument, pageContext(loaded.page)).reads,
  ).find((read) => read.kind === 'links');
  expect(planned?.kind).toBe('links');
  if (planned?.kind !== 'links') return;
  expect((continued?.body as { continuation?: { node?: string } }).continuation?.node).toBe(loaded.node);
  expect(loaded.next).toBe('next-from-owner');
  expect(Object.values(loaded.page.reads).map((read) => read.body)).toContainEqual(
    expect.objectContaining({ next: 'next-from-owner' }),
  );
});

test('a cursor view reads its planned collections list from its owner route', async () => {
  const requests: RequestRecord[] = [];
  await loadViewPages(clientWith(requests), subject, 'lists', 'en', 'opaque-next');
  const owner = requests.find((request) => request.path.endsWith('/collections'));
  expect(owner?.search.get('cursor')).toBe('opaque-next');
  expect(owner?.search.get('limit')).toBeTruthy();
});

test('a first-page view keeps its planned read and does not make an owner cursor request', async () => {
  const requests: RequestRecord[] = [];
  const loaded = await loadViewPages(clientWith(requests, undefined, 'first-page-next'), subject, 'editions', 'en');
  expect(loaded.kind).toBe('page');
  expect(loaded.kind === 'page' ? loaded.next : undefined).toBe('first-page-next');
  expect(requests.filter((request) => request.method === 'POST' && request.path === '/v1/pages:read')).toHaveLength(2);
  expect(requests.some((request) => request.path.endsWith('/links') || request.path.endsWith('/collections'))).toBe(
    false,
  );
});

test('a cursor refused by the owner list route answers the not-found result', async () => {
  const requests: RequestRecord[] = [];
  const loaded = await loadViewPages(clientWith(requests), subject, 'editions', 'en', 'refuse');
  expect(loaded.kind).toBe('missing');
});

test('view cursors are strings of at most 2048 characters', () => {
  expect(validateViewCursor('x'.repeat(2048))).toHaveLength(2048);
  expect(() => validateViewCursor('x'.repeat(2049))).toThrow();
  expect(() => validateViewCursor(['cursor'])).toThrow();
});

test('a full view renders its next page as a plain server-rendered anchor', () => {
  const page = {
    subject,
    profile: 'platform',
    template: { scope: 'base', key: null },
    document: { root: { props: {} }, content: [] },
    reads: {},
  } as never;
  const href = `/en/subjects/${subject}/editions?cursor=next%2Bpage`;
  const html = renderToString(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(SubjectViewPage, {
        page,
        locale: 'en',
        messages: {} as never,
        frame: null,
        label: 'Editions',
        nextHref: href,
        renderJsonLd: false,
      }),
    ),
  );
  expect(html).toContain(`<a data-slot="next-page" href="${href}"`);
  expect(html).toContain(' rel="next"');
  expect(html).toContain('Continue Editions</a>');
});

test('full list components can render the page returned by the owner read while preview limits stay at twelve', () => {
  const body = {
    links: Array.from({ length: 15 }, (_, index) => ({ subject: `${index}` })),
    count: { value: 15, exact: true },
  };
  expect(holderItems(body, Number.POSITIVE_INFINITY)?.items).toHaveLength(15);
  expect(holderItems(body, 12)?.items).toHaveLength(12);
});

test('a view page with a cursor makes the same number of kernel requests at 30, 300 and 3000 items', async () => {
  const counts: number[] = [];
  for (const size of [30, 300, 3000]) {
    const requests: RequestRecord[] = [];
    await loadViewPages(clientWith(requests, size), subject, 'editions', 'en', `cursor-${size}`);
    counts.push(requests.length);
  }
  expect(counts).toEqual([3, 3, 3]);
});

const extraSubjects = [
  { id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e81', type: 'skos:Concept', labels: { en: 'Continuation genre' } },
  { id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e82', type: 'schema:Person', labels: { en: 'Continuation performer' } },
  { id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e83', type: 'wd:Q95074', labels: { en: 'Continuation character' } },
].map((entry) => ({ ...entry, descriptions: {}, aliases: {}, statements: {} }));
const fullViews: { id: string; view: View }[] = [
  { id: subject, view: 'editions' },
  { id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06', view: 'contents' },
  { id: extraSubjects[0]!.id, view: 'works' },
  { id: extraSubjects[1]!.id, view: 'characters' },
  { id: extraSubjects[2]!.id, view: 'appearances' },
  { id: subject, view: 'lists' },
  { id: subject, view: 'relations' },
];
const documentFake = createFakeKernelFetch({
  ...fixtures,
  subjects: [...fixtures.subjects, ...extraSubjects],
  types: {
    ...fixtures.types,
    'schema:TVSeries': { bases: ['schema:CreativeWorkSeries', 'schema:CreativeWork', 'schema:Thing'] },
    'skos:Concept': { bases: ['schema:Thing'] },
    'schema:Person': { bases: ['schema:Thing'] },
    'wd:Q95074': { bases: ['schema:Thing'] },
  },
} as never);
const nextCursor = 'opaque+next/=';
function listBody(kind: string, second: boolean, limit: number) {
  const items = Array.from({ length: limit }, (_, index) => ({
    subject: `0192f3a0-6c1e-7b2a-9d4e-${String(index + (second ? 100 : 1)).padStart(12, '0')}`,
    id: `0192f3a0-6c1e-7b2a-9d4e-${String(index + (second ? 100 : 1)).padStart(12, '0')}`,
    label: `${second ? 'Later' : 'First'} item ${index + 1}`,
    title: `${second ? 'Later' : 'First'} item ${index + 1}`,
    property: 'schema:exampleOfWork',
  }));
  return {
    [kind === 'collections' ? 'collections' : 'links']: items,
    count: { value: 200, exact: true },
    next: nextCursor,
  };
}

// Exercise route validation, metadata and plain document navigation through the running server.
const kernel = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && /\/(links|collections)$/.test(url.pathname)) {
      const cursor = url.searchParams.get('cursor');
      if (cursor === 'refuse') return Response.json({ code: 'invalid_cursor' }, { status: 400 });
      return Response.json(
        listBody(url.pathname.split('/').at(-1)!, cursor !== null, Number(url.searchParams.get('limit') ?? 24)),
      );
    }
    const response = await documentFake(request.clone());
    if (request.method !== 'POST' || url.pathname !== '/v1/pages:read' || response.status !== 200) return response;
    const page = await response.json();
    const plan = planReads(platformRegistry, page.document, pageContext(page));
    for (const [key, read] of Object.entries(plan.reads)) {
      if (read.kind === 'links' || read.kind === 'collections')
        page.reads[key] = { status: 200, body: listBody(read.kind, false, read.limit) };
    }
    return Response.json(page);
  },
});
let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
let started: Promise<string> | undefined;

function site(): Promise<string> {
  started ??= startDevServer({
    env: {
      KERNEL_ORIGIN: kernel.url.origin,
    },
    warmUpPaths: [],
  }).then((running) => {
    server = running;
    return running.origin;
  });
  return started;
}
afterAll(async () => {
  kernel.stop(true);
  await server?.stop();
});
async function viewAddress(id: string, view: View) {
  const body = await (await documentFake(new Request(`https://kernel.invalid/v1/subjects/${id}`))).json();
  return `/en/subjects/${id}/${slug(body.subject.labels.en)}/${view}`;
}
async function documentAt(path: string) {
  return fetch(`${await site()}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
}
function bodyMarkup(html: string) {
  return html.split('<body')[1]?.split('<script')[0] ?? '';
}

test('every full view whose list read returns next renders a next-page link to the same view address with ?cursor=<next> as a plain anchor in the server-rendered document', async () => {
  for (const { id, view } of fullViews) {
    const path = await viewAddress(id, view);
    const response = await documentAt(path);
    expect(response.status).toBe(200);
    const html = await response.text();
    const anchor = /<a[^>]*data-slot="next-page"[^>]*>/.exec(bodyMarkup(html))?.[0] ?? '';
    expect(anchor).toContain(`href="${path}?cursor=${encodeURIComponent(nextCursor)}"`);
    expect(anchor).toContain(' rel="next"');
    expect(html).not.toMatch(/<meta[^>]*name="robots"[^>]*content="noindex, follow"/);
  }
}, 300_000);

test("a view address with a cursor reads that page from the view's owner list route with the template read's property, filter, type and limit plus the cursor, and renders its items in place of the first page", async () => {
  for (const { id, view } of fullViews) {
    const path = await viewAddress(id, view);
    const response = await documentAt(`${path}?cursor=${encodeURIComponent(nextCursor)}`);
    expect(response.status).toBe(200);
    const html = bodyMarkup(await response.text());
    expect(html).toContain('Later item 1');
    // Multi-section templates keep their other sections; the primary list is replaced.
    const primary = view === 'contents' ? 'subject-list' : view === 'works' ? 'subject-list' : undefined;
    const section = primary
      ? (new RegExp(`<section[^>]*data-slot="${primary}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? '')
      : html;
    expect(section).not.toContain('First item 1<');
  }
}, 300_000);

test('a page beyond the first of any full view, relations included, carries robots noindex, follow', async () => {
  for (const { id, view } of fullViews) {
    const response = await documentAt(`${await viewAddress(id, view)}?cursor=later`);
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/<meta[^>]*name="robots"[^>]*content="noindex, follow"/);
  }
}, 300_000);

test('a cursor longer than 2048 characters, or one the owner read refuses with 400, answers the not-found page', async () => {
  for (const view of ['editions', 'lists', 'relations'] as const) {
    const path = await viewAddress(subject, view);
    for (const cursor of ['x'.repeat(2049), 'refuse']) {
      const response = await documentAt(`${path}?cursor=${cursor}`);
      expect(response.status).toBe(404);
      expect(bodyMarkup(await response.text())).not.toContain('First item 1');
    }
    expect((await documentAt(`${path}?cursor=${'x'.repeat(2048)}`)).status).toBe(200);
  }
}, 300_000);

test('a full view renders every item of its page and overview previews still show at most twelve', async () => {
  for (const view of ['editions', 'lists'] as const) {
    const path = await viewAddress(subject, view);
    const response = await documentAt(path);
    const html = bodyMarkup(await response.text());
    const limit = view === 'editions' ? 24 : 6;
    expect(html).toContain(`First item ${limit}<`);
    expect(new Set(html.match(/First item \d+</g) ?? []).size).toBe(limit);
  }
  const overview = (await viewAddress(subject, 'editions')).replace(/\/editions$/, '');
  const html = bodyMarkup(await (await documentAt(overview)).text());
  const editions = /<section[^>]*data-slot="subject-list"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  // A preview has phone and desktop copies of the same cards; count its distinct items.
  expect(new Set(editions.match(/First item \d+</g) ?? []).size).toBeLessThanOrEqual(12);
  expect(editions).not.toContain('First item 13<');
}, 300_000);

test('owner continuation preserves nonempty filter and type parameters from a template', async () => {
  const requests: RequestRecord[] = [];
  const fake = createFakeKernelFetch(fixtures as never);
  const document = {
    root: { props: {} },
    content: [
      {
        type: 'Appearances',
        props: {
          id: 'filtered',
          property: 'schema:character',
          filter: subject,
          type: 'schema:Book',
          limit: 17,
          paged: true,
        },
      },
    ],
  } as CompositionDocument;
  const reads = planReads(platformRegistry, document, { subject }).reads;
  const key = Object.keys(reads)[0]!;
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const data = request.method === 'POST' ? await request.clone().json() : undefined;
      if (data?.target?.view)
        return Response.json({
          subject,
          profile: 'platform',
          template: { scope: 'base', key: null },
          document,
          reads: { [key]: { status: 200, body: listBody('links', false, 17) } },
        });
      if (url.pathname.endsWith('/links')) {
        requests.push({ method: request.method, path: url.pathname, search: url.searchParams });
        return Response.json(listBody('links', true, 17));
      }
      return fake(request);
    }) as typeof fetch,
  });
  const loaded = await loadViewPages(client, subject, 'appearances', 'en', 'opaque');
  expect(loaded.kind).toBe('page');
  expect(Object.fromEntries(requests[0]!.search)).toEqual({
    property: 'schema:character',
    filter: subject,
    type: 'schema:Book',
    limit: '17',
    cursor: 'opaque',
  });
});

test('full CollectionList and forward fact views render every returned item while previews cap at twelve', async () => {
  for (const view of ['lists', 'characters', 'credits'] as const) {
    const loaded = await loadViewPages(clientWith([]), subject, view, 'en');
    expect(loaded.kind).toBe('page');
    if (loaded.kind !== 'page') return;
    const page = structuredClone(loaded.page);
    const node = page.document.content[0]!;
    const key = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).nodes[
      node.props.id as string
    ]!;
    if (view === 'lists') page.reads[key] = { status: 200, body: listBody('collections', false, 15) };
    else {
      const body = page.reads[key]!.body as {
        subject: { statements: Record<string, unknown> };
        related: Record<string, unknown>;
      };
      body.subject.statements[node.props.property as string] = Array.from({ length: 15 }, (_, index) => {
        const id = `0192f3a0-6c1e-7b2a-9d4e-${String(index + 1).padStart(12, '0')}`;
        body.related[id] = { labels: { en: `First item ${index + 1}` } };
        return {
          id,
          rank: 'normal',
          property: { id: node.props.property, data_type: 'wikibase-item' },
          value: { type: 'value', content: id },
          qualifiers: [],
          references: [],
        };
      });
    }
    const render = () =>
      renderToString(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(SubjectViewPage, {
            page,
            locale: 'en',
            messages: {} as never,
            frame: null,
            label: view,
            view,
            renderJsonLd: false,
          }),
        ),
      );
    expect(render()).toContain('First item 15');
    node.props.paged = false;
    expect(render()).not.toContain('First item 13');
    expect(render()).toContain('First item 1');
  }
});

test('views without a cursor-capable planned primary list keep their page read', async () => {
  for (const view of ['reviews', 'discussion', 'details'] as const) {
    const requests: RequestRecord[] = [];
    const loaded = await loadViewPages(clientWith(requests), subject, view, 'en', 'unused');
    expect(loaded.kind).toBe('page');
    expect(requests).toHaveLength(2);
    expect(loaded.kind === 'page' ? loaded.next : undefined).toBeUndefined();
  }
});
