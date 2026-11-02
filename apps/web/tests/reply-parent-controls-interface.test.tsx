import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import { fromPlainText } from '@rezics/document';
import * as start from '../.storybook/react-start';
import type { WriteFailure } from '../src/threads/actions';
import type { ReplyParentResult } from '../src/threads/reply-parent-read';
import type { ThreadReadingPage } from '../src/threads/thread-reading';
import thread from '../src/kernel/recorded/thread.json';
import accounts from '../src/kernel/recorded/accounts.json';

// Authored UNRUN for integration. Prepared boundary results assert no native admission.
// The real reader, route Post, personal query, ThreadReading and sole PostComposer are used.
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test('reply parent controls keep independent associations, private failures and the real editor through personal refetch, pending retry and cancellation', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/compose', width: 390, height: 900 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  const originalActions = await import('../src/threads/actions');
  const originalReads = await import('../src/threads/reads');
  const pendingWrite = deferred<WriteFailure>();
  const commands: unknown[] = [];
  const viewerId = thread.thread.firstPost.authorId;
  let personalReads = 0;
  mock.module('../src/threads/actions', () => ({
    ...originalActions,
    replyToThread: async ({ data }: { data: unknown }) => {
      commands.push(structuredClone(data));
      return commands.length === 1 ? pendingWrite.promise : { ok: false, reason: 'forbidden' };
    },
  }));
  mock.module('../src/threads/reads', () => ({
    ...originalReads,
    readThreadPersonal: async () => {
      personalReads++;
      return { viewerId, reactions: {}, reviewVotes: {} };
    },
  }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider, useQuery } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { ReplyContext, ReplyParentReader } = await import('../src/threads/reply-context');
  const { ThreadReading } = await import('../src/threads/thread-reading');
  const { ThreadReadingPost } = await import('../src/routes/threads/$id_.$slug');
  const { AuthoringDepartureProvider } = await import('../src/threads/authoring-departure');
  const { threadPersonalQuery } = await import('../src/threads/thread-queries');
  const { sessionQuery } = await import('../src/session/query');
  const { exactRevisionHref } = await import('../src/threads/exact-revision-href');
  const { replyParentExcerpt } = await import('../src/threads/reply-parent-read');
  const { getLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const settle = async (ready: () => boolean) => {
    for (let n = 0; n < 180 && !ready(); n++)
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    expect(ready()).toBe(true);
  };
  const button = (scope: ParentNode, name: string) => {
    const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === name);
    expect(found).toBeDefined();
    return found!;
  };
  const click = async (node: HTMLElement) => act(async () => user.click(node));
  const author = {
    ...accounts.accounts[0]!,
    kind: 'actor' as const,
    state: 'active' as const,
    displayName: 'A very long visible author name '.repeat(8),
    handle: 'long_unbroken_handle_'.repeat(12),
  };
  const licence = `LicenseRef-${'long-unbroken-visible-licence-'.repeat(10)}`;
  const excerpt = `${'The admitted teaser is complete. '.repeat(12)}ADMITTED FINAL WORDS`;
  const reads: string[] = [];
  const reader = new ReplyParentReader(thread.thread.id, async (parentId): Promise<ReplyParentResult> => {
    reads.push(parentId);
    if (parentId === id(2) && reads.filter((value) => value === parentId).length === 1) return { state: 'unavailable' };
    return {
      state: 'available',
      id: parentId,
      threadId: thread.thread.id,
      revisionId: id(3),
      author,
      licence,
      excerpt,
    };
  });
  try {
    await act(async () =>
      root.render(
        <>
          {[id(1), id(2), id(1)].map((parentId, index) => (
            <div key={index} data-example={index}>
              <ReplyContext parentId={parentId} parents={new Map()} reader={reader} />
            </div>
          ))}
        </>,
      ),
    );
    const panels = [...host.querySelectorAll<HTMLElement>('[data-example]')];
    const toggles = panels.map((panel) => button(panel, m.thread_reply_parent_view()));
    const controls = toggles.map((toggle) => toggle.getAttribute('aria-controls'));
    expect(new Set(controls).size).toBe(3);
    for (const control of controls) {
      expect(control).toBeTruthy();
      expect(control).not.toContain(id(1));
      expect(control).not.toContain(id(2));
    }
    expect(reads).toEqual([]);
    await act(async () => {
      toggles[0]!.focus();
      await user.keyboard('{Enter}');
    });
    await settle(() => panels[0]!.textContent!.includes('ADMITTED FINAL WORDS'));
    expect(reads).toEqual([id(1)]);
    expect(toggles[2]!.getAttribute('aria-expanded')).toBe('true');
    expect(toggles[1]!.getAttribute('aria-expanded')).toBe('false');
    await click(toggles[1]!);
    await settle(() => !!panels[1]!.querySelector('[role="status"]'));
    await settle(() => panels[1]!.textContent!.includes(m.thread_reply_parent_unavailable()));
    expect(panels[1]!.querySelector('a')).toBeNull();
    expect(panels[1]!.textContent).not.toContain(author.displayName);
    const retry = button(panels[1]!, m.exact_revision_retry());
    await act(async () => {
      retry.focus();
      await user.keyboard(' ');
    });
    await settle(() => panels[1]!.textContent!.includes('ADMITTED FINAL WORDS'));
    expect(reads).toEqual([id(1), id(2), id(2)]);
    for (let index = 0; index < panels.length; index++) {
      const panel = panels[index]!;
      expect(panel.querySelector('section')!.id).toBe(controls[index]!);
      expect(panel.textContent).toContain(excerpt);
      expect(panel.textContent).toContain(author.displayName);
      expect(panel.textContent).toContain(`${m.thread_history_licence()}: ${licence}`);
      const exact = [...panel.querySelectorAll('a')].find((link) => link.textContent === m.exact_revision_heading());
      expect(exact!.getAttribute('href')).toBe(
        exactRevisionHref({ postId: index === 1 ? id(2) : id(1), revisionId: id(3) }, getLocale()),
      );
    }
    await click(toggles[0]!);
    expect(toggles[2]!.getAttribute('aria-expanded')).toBe('false');
    expect(toggles[1]!.getAttribute('aria-expanded')).toBe('true');
    await click(toggles[0]!);
    expect(reads).toHaveLength(3);
    const privateBody = fromPlainText('PRIVATE BODY NEVER DISCLOSED', 'blocks');
    const longBody = fromPlainText('The intentionally bounded in-page teaser. '.repeat(30), 'blocks');
    await act(async () =>
      root.render(
        <>
          <div data-disclosed>
            <ReplyContext
              parentId={id(10)}
              parents={
                new Map([[id(10), { id: id(10), availability: 'available', body: longBody, authorId: author.id }]])
              }
              authors={{ [author.id]: author }}
            />
          </div>
          {(['erased', 'withheld'] as const).map((availability, index) => (
            <div key={availability} data-private>
              <ReplyContext
                parentId={id(11 + index)}
                parents={
                  new Map([
                    [id(11 + index), { id: id(11 + index), availability, body: privateBody, authorId: author.id }],
                  ])
                }
                authors={{ [author.id]: author }}
              />
            </div>
          ))}
          <div data-unloaded>
            <ReplyContext parentId={id(13)} parents={new Map()} />
          </div>
        </>,
      ),
    );
    expect(host.querySelector('[data-disclosed] .line-clamp-2')!.textContent).toBe(replyParentExcerpt(longBody));
    for (const hidden of host.querySelectorAll('[data-private]')) {
      expect(hidden.textContent).not.toContain('PRIVATE BODY');
      expect(hidden.textContent).not.toContain(author.displayName);
      expect(hidden.querySelectorAll('a')).toHaveLength(1); // The existing in-page tombstone anchor is retained.
      expect(hidden.querySelector('a')!.getAttribute('href')).toMatch(/^#post-/);
    }
    expect(host.querySelector('[data-unloaded] a')).toBeNull();
    expect(reads).toHaveLength(3);

    const first = { ...thread.thread.firstPost, availability: 'available' as const, body: longBody };
    const page: ThreadReadingPage = {
      thread: { ...thread.thread, firstPost: first } as ThreadReadingPage['thread'],
      posts: { posts: [first], next: null },
      authors: { [first.authorId]: { ...author, id: first.authorId } },
      subjects: [],
      provenanceSubjects: [],
      mentions: {},
      verification: { sitekey: '', scriptUrl: '' },
      now: first.createdAt,
    };
    const personalQuery = threadPersonalQuery(thread.thread.id, undefined, [first.id]);
    const authority = {};
    let refresh!: () => Promise<unknown>;
    function Reading() {
      const personal = useQuery(personalQuery);
      refresh = personal.refetch;
      return (
        <AuthoringDepartureProvider>
          <ThreadReading
            page={page}
            personal={personal.data}
            session="signed-in"
            readerSubject={viewerId}
            readAuthority={authority}
            Post={ThreadReadingPost}
            signedOut={null}
            returnTo="/"
            renderHeader={() => null}
            onMutation={async () => {}}
            onPageRefresh={async () => undefined}
          />
        </AuthoringDepartureProvider>
      );
    }
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: viewerId,
      csrfToken: 'prepared-session',
    });
    const route = createRootRoute({ component: Outlet });
    const { createRoute } = await import('@tanstack/react-router');
    const compose = createRoute({ getParentRoute: () => route, path: '/compose', component: Reading });
    const router = createRouter({
      routeTree: route.addChildren([compose]),
      history: createMemoryHistory({ initialEntries: ['/compose'] }),
    });
    await router.load();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    const editor = () => host.querySelector<HTMLElement>(`.ProseMirror[aria-label="${m.thread_reply_label()}"]`);
    await settle(() => !!editor());
    expect(personalReads).toBe(1);
    const node = editor()!;
    const region = node.closest('section')!;
    const form = region.querySelector('form');
    expect(form).not.toBeNull();
    const view = () =>
      (node as HTMLElement & { pmViewDesc: { view: unknown; node: { toJSON: () => unknown } } }).pmViewDesc;
    const mountedEditor = view().view;
    expect(mountedEditor).toBeDefined();
    await act(async () => {
      await user.click(node);
      await user.keyboard('The exact draft survives selecting my own post and refreshing personal data.');
      await user.tab();
    });
    const draft = view().node.toJSON();
    const ownPost = host.querySelector<HTMLElement>(`#post-${first.id}`)!;
    const reply = button(ownPost, m.thread_reply_to_post());
    await act(async () => {
      reply.focus();
      await user.keyboard('{Enter}');
    });
    await settle(() => window.document.activeElement === node);
    const cancel = button(region, m.thread_reply_cancel_target());
    const exactParent = () =>
      [...region.querySelectorAll('a')].find((link) => link.textContent === m.thread_reply_parent());
    const unchanged = () => {
      expect(editor()).toBe(node);
      expect(view().view).toBe(mountedEditor);
      expect(region.querySelector('form')).toBe(form);
      expect(view().node.toJSON()).toEqual(draft);
      expect(host.querySelectorAll(`.ProseMirror[aria-label="${m.thread_reply_label()}"]`)).toHaveLength(1);
    };
    expect(exactParent()!.getAttribute('href')).toBe(`#post-${first.id}`);
    unchanged();
    const initialKey = client.getQueryData(personalQuery.queryKey)!.idempotencyKey;
    await act(async () => {
      await refresh();
    });
    expect(personalReads).toBe(2);
    expect(client.getQueryData(personalQuery.queryKey)!.idempotencyKey).not.toBe(initialKey);
    expect(exactParent()!.getAttribute('href')).toBe(`#post-${first.id}`);
    unchanged();
    await click(button(region, m.thread_write_send()));
    await settle(() => cancel.disabled);
    expect(reply.disabled).toBe(true);
    await act(async () => cancel.click()); // Disabled native buttons cannot dispatch cancellation.
    expect(exactParent()!.getAttribute('href')).toBe(`#post-${first.id}`);
    unchanged();
    await act(async () => pendingWrite.resolve({ ok: false, reason: 'unavailable' }));
    await settle(() => !!region.querySelector('[role="alert"]'));
    await click(button(region, m.thread_write_retry()));
    await settle(() => commands.length === 2 && !cancel.disabled);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]).toMatchObject({ parentId: first.id });
    unchanged();
    await act(async () => {
      cancel.focus();
      await user.keyboard(' ');
    });
    await settle(() => window.document.activeElement === node);
    expect(exactParent()).toBeUndefined();
    expect(
      [...region.querySelectorAll('button')].some((item) => item.textContent === m.thread_reply_cancel_target()),
    ).toBe(false);
    unchanged();
  } finally {
    reader.dispose();
    await act(async () => root.unmount());
    client.clear();
    mock.module('../src/threads/actions', () => originalActions);
    mock.module('../src/threads/reads', () => originalReads);
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
