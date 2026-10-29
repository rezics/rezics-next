import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed.ts';
import { DynamicCollectionPage } from '../src/library/dynamic-collection-page.tsx';
import { m } from '../src/paraglide/messages.js';
import { dynamicCollectionTitle } from '../src/library/dynamic-collection.ts';
import { loadDynamicMembers, loadEditableCollectionPage } from '../src/library/collection-load.ts';

const stamp = '2026-10-29T00:00:00.000Z';
const locales = ['en', 'ja', 'zh-Hans'] as const;

test('dynamic Collections use localized built-in titles, owner renames, and a neutral fallback', () => {
  for (const locale of locales) {
    expect(dynamicCollectionTitle({ builtinKind: 'everything', title: null }, locale)).toBe(
      m.library_dynamic_everything({}, { locale }),
    );
    expect(dynamicCollectionTitle({ builtinKind: 'liked', title: null }, locale)).toBe(
      m.library_dynamic_liked({}, { locale }),
    );
    expect(dynamicCollectionTitle({ builtinKind: 'everything', title: 'My Everything' }, locale)).toBe('My Everything');
    expect(dynamicCollectionTitle({ builtinKind: 'liked', title: 'My Likes' }, locale)).toBe('My Likes');
    expect(dynamicCollectionTitle({ builtinKind: 'state', title: null, builtinLabels: {} }, locale)).toBe(
      m.library_other({}, { locale }),
    );
    expect(
      dynamicCollectionTitle(
        { builtinKind: 'state', title: null, builtinLabels: { en: 'Reading', ja: '読書', 'zh-Hans': '在读' } },
        locale,
      ),
    ).toBe(locale === 'en' ? 'Reading' : locale === 'ja' ? '読書' : '在读');
    expect(dynamicCollectionTitle({ builtinKind: 'new-kind', title: null }, locale)).toBe(
      m.library_other({}, { locale }),
    );
    expect(dynamicCollectionTitle({ builtinKind: 'new-kind', title: 'Renamed other' }, locale)).toBe('Renamed other');
  }
});

test('a dynamic page renders cover tiles without count, time, or membership controls', () => {
  const html = renderToStaticMarkup(
    createElement(DynamicCollectionPage, {
      page: {
        id: 'everything',
        title: 'Everything',
        builtinKind: 'everything',
        description: null,
        curator: null,
        members: [{ subject: { id: 'book-1', type: 'book', types: ['book'], label: 'A book', cover: null } }],
        next: null,
        preparing: false,
        unavailable: false,
      },
    }),
  );
  expect(html).toContain('Everything');
  expect(html).toContain('A book');
  expect(html).not.toContain('Updated');
  expect(html).not.toContain('items');
  expect(html).not.toContain('Add');
  expect(html).not.toContain('Remove');
  expect(html).not.toContain('Move');
  expect(html).not.toContain('Note');
});

test('one Collection read and one members read per document for dynamic and curated Collections with 0, 20 and 100 members; a preparing answer adds at most 3 rereads', async () => {
  for (const kind of ['dynamic', 'curated'] as const)
    for (const size of [0, 20, 100]) {
      const paths: string[] = [];
      const id = `${kind}-${size}`;
      const client = withPlatformClosedRecognition(
        createKernelClient('https://kernel.test', {
          fetch: (async (input, init) => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            paths.push(url.pathname);
            if (url.pathname === `/v1/collections/${id}`)
              return Response.json({
                collection:
                  kind === 'dynamic'
                    ? {
                        id,
                        curatorAccountId: 'owner',
                        title: null,
                        description: null,
                        visibility: 'private',
                        revision: 1,
                        membershipKind: 'dynamic',
                        builtinKind: 'everything',
                      }
                    : {
                        id,
                        curatorAccountId: 'owner',
                        title: 'Curated',
                        description: null,
                        visibility: 'private',
                        revision: 1,
                        memberCount: size,
                        createdAt: stamp,
                        updatedAt: stamp,
                        membershipKind: 'curated',
                      },
              });
            if (url.pathname === `/v1/collections/${id}/members`)
              return Response.json({
                members: Array.from({ length: size }, (_, n) =>
                  kind === 'dynamic'
                    ? {
                        kind: 'dynamic',
                        subjectId: `s-${n}`,
                        subject: { id: `s-${n}`, type: 'book', label: `Book ${n}` },
                      }
                    : {
                        id: `m-${n}`,
                        subjectId: `s-${n}`,
                        note: null,
                        addedAt: stamp,
                        subject: { id: `s-${n}`, type: 'book', label: `Book ${n}` },
                      },
                ),
                next: null,
              });
            throw new Error(`unexpected ${request.method} ${url.pathname}`);
          }) as typeof fetch,
        }),
      );
      const page = await loadEditableCollectionPage(
        client,
        new Request('https://site.test/collection'),
        {},
        { id },
        'anonymous',
      );
      expect(page.members).toHaveLength(size);
      if (kind === 'dynamic') {
        expect('memberCount' in page).toBe(false);
        expect('updatedAt' in page).toBe(false);
        expect('createdAt' in page).toBe(false);
      } else {
        expect(page.memberCount).toBe(size);
        expect(page.updatedAt).toBe(stamp);
      }
      expect(paths.sort()).toEqual([`/v1/collections/${id}`, `/v1/collections/${id}/members`].sort());
    }
});

test('preparing rereads the same cursor no more than three times and unavailable is distinct from empty', async () => {
  const paths: string[] = [];
  const id = 'preparing';
  const client = withPlatformClosedRecognition(
    createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        paths.push(`${url.pathname}${url.search}`);
        if (url.pathname === `/v1/collections/${id}`)
          return Response.json({
            collection: {
              id,
              curatorAccountId: 'owner',
              title: null,
              description: null,
              visibility: 'private',
              revision: 1,
              membershipKind: 'dynamic',
              builtinKind: 'everything',
            },
          });
        if (url.pathname.endsWith('/members'))
          return Response.json({ preparing: true }, { status: 202, headers: { 'retry-after': '1' } });
        throw new Error(`unexpected ${url.pathname}`);
      }) as typeof fetch,
    }),
  );
  const page = await loadEditableCollectionPage(
    client,
    new Request('https://site.test/collection'),
    {},
    { id, cursor: 'next-cursor' },
    'anonymous',
  );
  expect('preparing' in page && page.preparing).toBe(true);
  for (let retry = 0; retry < 3; retry++) await loadDynamicMembers(client, id, 'next-cursor');
  expect(paths.filter((path) => path.includes('/members'))).toEqual(
    Array(4).fill(`/v1/collections/${id}/members?view=FULL&limit=100&cursor=next-cursor`),
  );
  expect(paths.filter((path) => path === `/v1/collections/${id}`)).toHaveLength(1);
});

test('an empty Everything and Liked page have their own empty messages', () => {
  const page = (builtinKind: 'everything' | 'liked') =>
    createElement(DynamicCollectionPage, {
      page: {
        id: builtinKind,
        title: builtinKind,
        builtinKind,
        description: null,
        curator: null,
        members: [],
        next: null,
        preparing: false,
        retryAfterMs: 1000,
        unavailable: false,
      },
    });
  expect(renderToStaticMarkup(page('everything'))).toContain(m.library_dynamic_empty_everything());
  expect(renderToStaticMarkup(page('liked'))).toContain(m.library_dynamic_empty_liked());
  expect(m.library_dynamic_empty_everything()).not.toBe(m.library_dynamic_empty_liked());
});

test('a dynamic members page keeps its next cursor for the shared Collection page continuation', async () => {
  const id = 'paged';
  const client = withPlatformClosedRecognition(
    createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === `/v1/collections/${id}`)
          return Response.json({
            collection: {
              id,
              curatorAccountId: 'owner',
              title: null,
              description: null,
              visibility: 'private',
              revision: 1,
              membershipKind: 'dynamic',
              builtinKind: 'everything',
            },
          });
        if (url.pathname.endsWith('/members')) return Response.json({ members: [], next: 'next-cursor' });
        throw new Error(`unexpected ${request.method} ${url.pathname}`);
      }) as typeof fetch,
    }),
  );
  const page = await loadEditableCollectionPage(
    client,
    new Request('https://site.test/collection'),
    {},
    { id },
    'anonymous',
  );
  expect(page.next).toBe('next-cursor');
});

test('a 503 dynamic members response renders unavailable rather than an empty page', async () => {
  const id = 'unavailable';
  const client = withPlatformClosedRecognition(
    createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.pathname === `/v1/collections/${id}`)
          return Response.json({
            collection: {
              id,
              curatorAccountId: 'owner',
              title: null,
              description: null,
              visibility: 'private',
              revision: 1,
              membershipKind: 'dynamic',
              builtinKind: 'everything',
            },
          });
        if (url.pathname.endsWith('/members')) return Response.json({ error: 'unavailable' }, { status: 503 });
        throw new Error(`unexpected ${request.method} ${url.pathname}`);
      }) as typeof fetch,
    }),
  );
  const page = await loadEditableCollectionPage(
    client,
    new Request('https://site.test/collection'),
    {},
    { id },
    'anonymous',
  );
  expect(page).toMatchObject({ preparing: false, unavailable: true, members: [] });
  if ('preparing' in page) {
    const html = renderToStaticMarkup(createElement(DynamicCollectionPage, { page }));
    expect(html).toContain(m.library_dynamic_unavailable());
    expect(html).not.toContain(m.library_dynamic_empty_everything());
  }
});
