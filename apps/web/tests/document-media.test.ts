import { describe, expect, mock, test } from 'bun:test';
import { createKernelClient, type KernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { loadDocumentMedia, type DocumentImagePresentation } from '../src/threads/document-media';
import { documentImageForPost, readThreadDocumentMedia } from '../src/threads/document-media-read';
import { loadThreadPage, type ThreadPost } from '../src/threads/thread-page';
import type { ThreadReadingPage } from '../src/threads/thread-reading';
import { m } from '../src/paraglide/messages.js';
import thread from '../src/kernel/recorded/thread.json';
import recordedPosts from '../src/kernel/recorded/thread-posts.json';
import { authoredReadingPage } from '../src/kernel/fake/thread-reading-page';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { ThreadReading } = await import('../src/threads/thread-reading');
const { ThreadReadingHeader, ThreadReadingPost } = await import('../src/routes/threads/$id_.$slug');

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const image: DocumentImagePresentation = {
  id: id(1),
  containerId: thread.thread.id,
  digest: 'a'.repeat(64),
  width: 457,
  height: 271,
  variants: [
    { format: 'avif', width: 457, height: 271 },
    { format: 'webp', width: 113, height: 67 },
  ],
  placeholder: null,
  focalPoint: null,
  credit: {
    rightsHolder: 'A. Reader',
    via: { name: 'Image source', url: 'https://example.com/credit' },
    license: 'CC-BY-4.0',
    obligations: ['cc:Attribution'],
  },
};

function postWithImages(ids: string[]): Extract<ThreadPost, { availability: 'available' }> {
  const opening = recordedPosts.posts[0] as Extract<ThreadPost, { availability: 'available' }>;
  const body = fromPlainText('The current document remains readable.', 'blocks');
  return {
    ...opening,
    mediaIds: ids,
    body: {
      ...body,
      doc: {
        ...body.doc,
        content: [
          ...body.doc.content!,
          ...ids.map((src) => ({ type: 'image', attrs: { src, alt: `Image ${src}`, id: `block-${src}` } })),
        ],
      },
    },
  };
}

function client(handler: (request: Request) => Response | Promise<Response>) {
  return createKernelClient('https://kernel.test', {
    fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect() {},
    }),
  });
}

async function render(page: ThreadReadingPage) {
  const region = createElement(ThreadReading, {
    page,
    Post: ThreadReadingPost,
    personal: undefined,
    session: 'signed-out',
    returnTo: '/',
    signedOut: 'Sign in',
    renderHeader: (title) => createElement(ThreadReadingHeader, { page, title }),
    onMutation: async () => {},
    onPageRefresh: async () => page,
  });
  const route = createRootRoute({ component: () => region });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, createElement(RouterProvider, { router })),
  );
}

describe('Sole document image adapter and native media in ordinary thread bodies', () => {
  test('one strict native batch carries current authorization and omission never causes a refill', async () => {
    const calls: Request[] = [];
    const kernel = client((request) => {
      calls.push(request);
      return Response.json({ images: [image] });
    });
    const result = await loadDocumentMedia(kernel, [image.id, id(2)], 'Bearer current-reader');
    expect(result).toEqual({ kind: 'ready', images: new Map([[image.id, image]]) });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/media/presentations');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer current-reader');
    expect(await calls[0]!.json()).toEqual({ ids: [image.id, id(2)] });
    expect(await loadDocumentMedia(kernel, [])).toEqual({ kind: 'ready', images: new Map() });
    expect(
      await loadDocumentMedia(
        kernel,
        Array.from({ length: 33 }, (_, index) => id(index + 1)),
      ),
    ).toEqual({ kind: 'unavailable' });
    expect(await loadDocumentMedia(kernel, [image.id, image.id])).toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(1);
    expect(await loadDocumentMedia({} as KernelClient, [image.id])).toEqual({ kind: 'unavailable' });
    for (const payload of [
      { images: [{ ...image, id: id(3) }] },
      { images: [{ ...image, objectKey: 'private/original' }] },
      { images: [{ ...image, variants: [{ format: 'original', width: 457, height: 271 }] }] },
      { images: [image, image] },
    ]) {
      let count = 0;
      expect(
        await loadDocumentMedia(
          client(() => {
            count++;
            return Response.json(payload);
          }),
          [image.id],
        ),
      ).toEqual({ kind: 'unavailable' });
      expect(count).toBe(1);
    }
    for (const status of [403, 404, 503]) {
      let count = 0;
      expect(
        await loadDocumentMedia(
          client(() => {
            count++;
            return new Response(null, { status });
          }),
          [image.id],
        ),
      ).toEqual({ kind: 'unavailable' });
      expect(count).toBe(1);
    }
    expect(
      await loadDocumentMedia(
        client(() => {
          throw new Error('Source unavailable');
        }),
        [image.id],
      ),
    ).toEqual({ kind: 'unavailable' });
  });

  test('available current bodies alone select original declared references, with an explicit whole-page overflow', async () => {
    const opening = postWithImages([image.id, image.id]);
    // A declared attachment without a document reference and a document image without a declaration stay out.
    const post = {
      ...opening,
      mediaIds: [image.id, id(2)],
      body: {
        ...opening.body,
        doc: {
          ...opening.body.doc,
          content: [...opening.body.doc.content!, { type: 'image', attrs: { src: id(3), alt: 'Undeclared' } }],
        },
      },
    };
    const erased: ThreadPost = {
      id: id(4),
      threadId: post.threadId,
      route: post.route,
      parentId: null,
      removed: true,
      availability: 'erased',
      body: null,
      sha256: null,
    };
    const withheld: ThreadPost = { ...erased, id: id(5), availability: 'withheld' };
    const calls: Request[] = [];
    const kernel = client((request) => {
      calls.push(request);
      return Response.json({ images: [image] });
    });
    const result = await readThreadDocumentMedia(kernel, [post, erased, withheld], 'Bearer reader');
    expect(await calls[0]!.json()).toEqual({ ids: [image.id] });
    expect(documentImageForPost(result, post, image.id)).toEqual(image);
    expect(documentImageForPost(result, post, id(2))).toBeNull();
    expect(documentImageForPost(result, { ...post, revisionId: id(9) }, image.id)).toBeNull();
    expect(documentImageForPost(result, { ...post, sha256: 'b'.repeat(64) }, image.id)).toBeNull();
    expect(documentImageForPost(result, erased, image.id)).toBeNull();
    expect(documentImageForPost(result, { ...post, id: id(8) }, image.id)).toBeNull();
    const wrongContainer = await readThreadDocumentMedia(
      client(() => Response.json({ images: [{ ...image, containerId: id(8) }] })),
      [post],
    );
    expect(documentImageForPost(wrongContainer, post, image.id)).toBeNull();
    expect(
      await readThreadDocumentMedia(kernel, [
        postWithImages(Array.from({ length: 32 }, (_, index) => id(index + 1))),
        { ...postWithImages([id(33)]), id: id(100) },
      ]),
    ).toEqual({ kind: 'unavailable', reason: 'overflow' });
    expect(calls).toHaveLength(1);
  });

  test('the ordinary authorized thread read renders its actual image callback without rendering-time reads or body grants', async () => {
    const opening = postWithImages([image.id, id(2)]);
    const calls: Request[] = [];
    let mediaAvailable = true;
    let bodyAvailable = true;
    const kernel = client((request) => {
      calls.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith('/reading-page')) {
        const page = authoredReadingPage({
          ...thread.thread,
          firstPost: bodyAvailable
            ? opening
            : {
                id: opening.id,
                threadId: opening.threadId,
                route: opening.route,
                parentId: null,
                availability: 'withheld',
                removed: true,
                body: null,
                sha256: null,
              },
        } as Parameters<typeof authoredReadingPage>[0]);
        page.documentMedia = mediaAvailable
          ? {
              state: 'available',
              documents: bodyAvailable
                ? [
                    {
                      postId: opening.id,
                      threadId: opening.threadId,
                      revisionId: opening.revisionId,
                      sha256: opening.sha256,
                      state: 'available',
                      images: [{ id: image.id, state: 'available', presentation: image }],
                    },
                  ]
                : [],
            }
          : { state: 'unavailable', documents: [] };
        return Response.json(page);
      }
      if (path.includes('/boards/')) return new Response(null, { status: 404 });
      return Response.json(thread);
    });
    const read = async () => {
      const loaded = await loadThreadPage(
        kernel,
        new Request('https://site.test/', { headers: { authorization: 'Bearer current-reader' } }),
        {},
        { id: thread.thread.id },
        { sitekey: '', scriptUrl: '' },
      );
      return {
        ...loaded,
        authors: {},
        subjects: [],
        provenanceSubjects: [],
        now: '2026-10-31T12:00:00Z',
      } satisfies ThreadReadingPage;
    };
    const ready = await read();
    const beforeRender = calls.length;
    const html = await render(ready);
    expect(calls).toHaveLength(beforeRender);
    expect(calls.every((request) => request.headers.get('authorization') === 'Bearer current-reader')).toBe(true);
    expect(calls.filter((request) => request.url.endsWith('/media/presentations'))).toHaveLength(0);
    expect(html).toContain('data-slot="thread-reading"');
    expect(html).toContain('data-slot="document-body"');
    expect(html).toContain(`<picture><source type="image/avif"`);
    expect(html).toContain(`/media/${image.id}/avif-457 457w`);
    expect(html).toContain(`/media/${image.id}/webp-113`);
    expect(html).toContain('width="113" height="67"');
    expect(html).toContain(`alt="Image ${image.id}"`);
    expect(html).toContain(`data-media-id="${image.id}"`);
    expect(html).toContain(image.credit!.rightsHolder);
    expect(html).toContain(`Image ${id(2)}`);
    expect(html).toContain(m.content_edition_image_unavailable());
    expect(html).not.toContain('/webp-640');
    expect(html).not.toContain('Bearer current-reader');
    mediaAvailable = false;
    const unavailable = await render(await read());
    expect(unavailable).toContain('The current document remains readable.');
    expect(unavailable).not.toContain('<picture>');
    expect(unavailable).toContain(`Image ${image.id}`);
    expect(unavailable).toContain(`data-media-id="${image.id}"`);
    const batches = calls.filter((request) => request.url.endsWith('/media/presentations')).length;
    bodyAvailable = false;
    mediaAvailable = true;
    const withheld = await render(await read());
    expect(withheld).not.toContain('The current document remains readable.');
    expect(withheld).not.toContain(image.id);
    expect(calls.filter((request) => request.url.endsWith('/media/presentations'))).toHaveLength(batches);
  });
});
