import { afterAll, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fromPlainText } from '@rezics/document';
import * as start from '../.storybook/react-start';
import {
  preparedPostReading,
  readingAlt,
  readingEnding,
  readingSecret,
  readingLongLink,
} from '../src/stories/post-reading-fixtures';
import { PostReadingBody, ThreadPostReadingBody } from '../src/threads/post-reading-body';
import type { ThreadReadingPage } from '../src/threads/thread-reading';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

test('complete multilingual post, deliberate spoiler, exact revision and return retain current-reader authority', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const network = mock(async () => {
    throw new Error('Reading composition must not fetch');
  });
  globalThis.fetch = network as unknown as typeof fetch;
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createRootRoute, createRouter, createMemoryHistory, RouterProvider } = await import('@tanstack/react-router');
  const { ThreadReading, focusThreadPostLocation } = await import('../src/threads/thread-reading');
  const { ThreadReadingPost } = await import('../src/routes/threads/$id_.$slug');
  const { ExactRevisionView } = await import('../src/threads/exact-revision-view');
  const { exactRevisionHref } = await import('../src/threads/exact-revision-href');
  const { threadLocation } = await import('../src/threads/thread-href');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  setLocale('en', { reload: false });
  const supplied = preparedPostReading();
  const identity = { postId: supplied.post.id, revisionId: supplied.post.revisionId };
  type View = { page: ThreadReadingPage; current: boolean; exact?: boolean };
  let update!: (view: View) => void;
  function Journey() {
    const [view, setView] = useState<View>({ page: supplied.page, current: true });
    update = setView;
    return view.exact ? (
      <ExactRevisionView identity={identity} page={supplied.revision} />
    ) : (
      <ThreadReading
        page={view.page}
        pageCurrent={view.current}
        Post={ThreadReadingPost}
        session="signed-out"
        personal={undefined}
        returnTo="/en/"
        signedOut=""
        renderHeader={() => <h1>Prepared multilingual reading</h1>}
        onMutation={async () => {}}
        onPageRefresh={async () => view.page}
      />
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  const route = createRootRoute({ component: Journey });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    const findButton = (name: string) =>
      Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent === name || button.getAttribute('aria-label') === name,
      )!;
    const focusPost = (current = true) => {
      const list = host.querySelector('ol')!;
      const item = list.querySelector('li')!;
      const scroll = mock(() => {});
      item.scrollIntoView = scroll;
      focusThreadPostLocation(
        `#post-${supplied.post.id}`,
        supplied.post.threadId,
        supplied.page.posts.posts,
        list,
        current,
      );
      return { item, scroll };
    };
    const { item, scroll } = focusPost();
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(window.document.activeElement).toBe(item);
    expect(item.getAttribute('data-slot')).toBe('post-reading-frame');
    expect(host.textContent).toContain(readingEnding);
    expect(host.querySelector('pre code')!.textContent).toContain('  console.log(destination);');
    expect(host.querySelector('table th')!.getAttribute('scope')).toBe('col');
    expect(host.querySelector(`a[href="${readingLongLink}"]`)).not.toBeNull();
    expect(host.querySelector('[data-slot="post-reading-body"]')!.getAttribute('lang')).toBe('');
    expect(host.querySelector('p[lang="ja"]')!.textContent).toContain('星を読む');
    expect(host.querySelector('p[lang="en"]')).not.toBeNull();
    expect(host.querySelector('img')!.alt).toBe(readingAlt);
    expect(host.textContent).toContain(supplied.image.credit!.rightsHolder);
    const times = host.querySelectorAll('header time');
    expect(times.length).toBe(2);
    expect(times[0]!.getAttribute('title')).toContain('UTC');
    expect(times[1]!.textContent).toBe(m.thread_post_edited());
    const reveal = findButton(m.thread_reveal_spoiler());
    expect(reveal.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      reveal.focus();
      await user.keyboard('{Enter}');
    });
    expect(host.querySelector('.document-spoiler-revealed')!.textContent).toBe(readingSecret);
    expect(window.document.activeElement).toBe(host.querySelector('.document-spoiler-revealed'));
    await act(async () => user.click(findButton(m.thread_provenance_heading())));
    const exactHref = exactRevisionHref(identity, 'en');
    expect(host.querySelector(`a[href="${exactHref}"]`)!.textContent).toBe(m.exact_revision_heading());
    expect(host.querySelector('[data-slot="feed-action-bar"]')).not.toBeNull();
    expect(findButton(m.thread_history_show())).toBeDefined();
    await act(async () => update({ page: supplied.page, current: true, exact: true }));
    expect(host.textContent).toContain(readingEnding);
    expect(host.querySelector('.document-spoiler-revealed')).toBeNull();
    const returnHref = threadLocation('en', supplied.page.thread, undefined, supplied.post.id);
    expect(host.querySelector(`a[href="${returnHref}"]`)!.textContent).toBe(m.exact_revision_back());
    await act(async () => update({ page: supplied.page, current: true }));
    expect(focusPost().scroll).toHaveBeenCalledTimes(1);

    // Equal text in a replacement exact revision must not inherit the previous reveal visit or image disclosure.
    await act(async () => user.click(findButton(m.thread_reveal_spoiler())));
    const replacement = { ...supplied.post, revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000099' };
    const replacedPage = { ...supplied.page, posts: { ...supplied.page.posts, posts: [replacement] } };
    await act(async () => update({ page: replacedPage, current: true }));
    expect(host.querySelector('.document-spoiler-revealed')).toBeNull();
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).not.toContain(supplied.image.credit!.rightsHolder);
    expect(host.querySelector('[role="img"]')!.getAttribute('aria-label')).toContain(readingAlt);

    for (const availability of ['erased', 'withheld'] as const) {
      const removed = { ...supplied.post, availability, body: null, sha256: null };
      const page = { ...supplied.page, posts: { ...supplied.page.posts, posts: [removed] } } as ThreadReadingPage;
      await act(async () => update({ page, current: true }));
      expect(host.querySelector('[data-slot="post-reading-body"]')).toBeNull();
      expect(host.textContent).not.toContain(readingEnding);
    }
    // Growth is a display-only operation: each admitted block adds one paragraph and no read.
    for (const blocks of [1, 10, 100]) {
      const body = fromPlainText(
        Array.from({ length: blocks }, (_, index) => `Block ${index + 1} 星 é 👩🏽‍🚀`).join('\n\n'),
        'blocks',
      );
      const post = { ...supplied.post, body };
      const page = { ...supplied.page, posts: { ...supplied.page.posts, posts: [post] } };
      await act(async () => update({ page, current: true }));
      expect(host.querySelectorAll('[data-slot="document-body"] > p')).toHaveLength(blocks);
      expect(host.textContent).toContain(`Block ${blocks} 星 é 👩🏽‍🚀`);
      expect(network).not.toHaveBeenCalled();
    }
    const deletedAuthorPage = {
      ...supplied.page,
      authors: {
        [supplied.post.authorId]: { ...supplied.page.authors![supplied.post.authorId]!, state: 'deleted' as const },
      },
    };
    await act(async () => update({ page: deletedAuthorPage, current: true }));
    expect(host.textContent).toContain(m.thread_author_deleted());
    expect(host.querySelector('header a')).toBeNull();
    await act(async () => update({ page: supplied.page, current: false }));
    expect(host.querySelector('ol[inert]')).not.toBeNull();
    expect(host.textContent).not.toContain(readingEnding);
    expect(host.querySelector('img')).toBeNull();
    expect(focusPost(false).scroll).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('1, 10 and 100 admitted blocks add linear nodes and no transport, retaining all eight label locales', () => {
  const supplied = preparedPostReading(1);
  const calls = mock(() => null);
  const sizes: number[] = [];
  for (const blocks of [1, 10, 100]) {
    const body = fromPlainText(
      Array.from({ length: blocks }, (_, index) => `Block ${index + 1} 星 é 👩🏽‍🚀`).join('\n\n'),
      'blocks',
    );
    const html = renderToStaticMarkup(<PostReadingBody document={body} renderImage={calls} />);
    expect(html.match(/<p\b/g)).toHaveLength(blocks);
    expect(html).toContain(`Block ${blocks} 星 é 👩🏽‍🚀`);
    sizes.push((html.match(/<[a-z][^/]/g) ?? []).length);
    const post = { ...supplied.post, body };
    expect(
      renderToStaticMarkup(
        <ThreadPostReadingBody post={post} documentMedia={supplied.page.documentMedia} mentions={{}} />,
      ),
    ).toContain(`Block ${blocks}`);
  }
  expect((sizes[1]! - sizes[0]!) / 9).toBe((sizes[2]! - sizes[1]!) / 90);
  expect(calls).not.toHaveBeenCalled();
  const spoiler = fromPlainText('A concealed sentence', 'blocks');
  spoiler.doc.content![0]!.content![0]!.marks = [{ type: 'spoiler' }];
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    const html = renderToStaticMarkup(<PostReadingBody document={spoiler} locale={locale} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-label=""');
    expect(html).toContain('lang=""');
  }
});
