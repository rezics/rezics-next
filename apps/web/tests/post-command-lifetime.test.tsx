import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, useState } from 'react';
import * as start from '../.storybook/react-start';
import type { EditFailure, RevisedPost, WriteFailure } from '../src/threads/actions';
import type { ThreadReadingPage } from '../src/threads/thread-reading';
import type { ThreadPost } from '../src/threads/reads';

// Composed against the actual post, editor, menu, toast and QueryClient. Only native writes and
// the existing page-refresh boundary are deferred so retirement and uncertain outcomes are controllable.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const account = id(40);
const threadId = id(2);
const postId = id(52);
const revisionId = id(53);
const mediaId = id(54);
const originalSession = { state: 'signed-in' as const, subject: account, csrfToken: 'csrf-original' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('Actual ThreadReadingPost edit delete restore Undo commands retain original caller authority and uncertain intent', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({
    url: `https://site.test/en/threads/${threadId}/a-close-reading`,
    width: 1280,
    height: 900,
  });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    DOMParser: window.DOMParser,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    FormData: window.FormData,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { fromMarkdown, fromPlainText } = await import('@rezics/document');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { Toaster } = await import('@rezics/ui/shadcn/toast');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { sessionQuery } = await import('../src/session/query');
  const actions = await import('../src/threads/actions');
  const { ThreadReadingPost } = await import('../src/routes/threads/$id_.$slug');
  const storybookRequire = (await import('node:module')).createRequire(
    (await import('node:module')).createRequire(import.meta.url).resolve('storybook/test'),
  );
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  setLocale('en', { reload: false });

  const sourcePost = {
    id: postId,
    threadId,
    boardId: id(1),
    route: 0,
    visibility: 'published',
    securityRevision: '1',
    createdAt: '2026-01-01T00:00:00.000Z',
    authorId: account,
    parentId: null,
    revisionId,
    revisedAt: null,
    sha256: 'a'.repeat(64),
    licence: 'CC-BY-4.0',
    subjectIds: [],
    mediaIds: [mediaId],
    availability: 'available' as const,
    body: fromMarkdown(`Original post body. ![chart](/media/${mediaId})`, 'blocks'),
  } as unknown as ThreadPost;
  const availablePost = (nextRevision = revisionId, body = sourcePost.body) =>
    ({ ...sourcePost, availability: 'available', revisionId: nextRevision, body }) as ThreadPost;
  const erasedPost = (restorableUntil?: string) =>
    ({
      ...sourcePost,
      availability: 'erased',
      ...(restorableUntil === undefined ? {} : { restorableUntil }),
      body: null,
      sha256: null,
    }) as unknown as ThreadPost;
  const withheldPost = () =>
    ({ ...sourcePost, availability: 'withheld', body: null, sha256: null }) as unknown as ThreadPost;

  type PropsState = {
    post: ThreadPost;
    readAuthority: object;
    target: { kind: 'thread' | 'post'; id: string };
    viewerId: string | undefined;
    signedIn: boolean;
    personalReady: boolean;
    visible: boolean;
    title: string | null;
  };
  const initialAuthority = {};
  let state: PropsState = {
    post: sourcePost,
    readAuthority: initialAuthority,
    target: { kind: 'thread', id: threadId },
    viewerId: account,
    signedIn: true,
    personalReady: true,
    visible: true,
    title: 'A close reading',
  };
  let updateState!: (next: PropsState | ((current: PropsState) => PropsState)) => void;
  let applyRefreshPost = false;
  const pageReads: ReturnType<typeof deferred<ThreadReadingPage | undefined>>[] = [];
  const changes: ThreadPost[] = [];
  const openingChanges: boolean[] = [];
  let mutations = 0;
  const edits: {
    data: Parameters<typeof actions.revisePost>[0]['data'];
    csrf: string | null;
    gate: ReturnType<typeof deferred<Awaited<ReturnType<typeof actions.revisePost>>>>;
  }[] = [];
  const erasures: {
    data: Parameters<typeof actions.erasePost>[0]['data'];
    csrf: string | null;
    gate: ReturnType<typeof deferred<Awaited<ReturnType<typeof actions.erasePost>>>>;
  }[] = [];
  const restorations: {
    data: Parameters<typeof actions.restorePost>[0]['data'];
    csrf: string | null;
    gate: ReturnType<typeof deferred<Awaited<ReturnType<typeof actions.restorePost>>>>;
  }[] = [];
  const editSpy = spyOn(actions, 'revisePost').mockImplementation((input) => {
    const gate = deferred<Awaited<ReturnType<typeof actions.revisePost>>>();
    edits.push({ data: structuredClone(input.data), csrf: new Headers(input.headers).get('X-CSRF-Token'), gate });
    return gate.promise;
  });
  const eraseSpy = spyOn(actions, 'erasePost').mockImplementation((input) => {
    const gate = deferred<Awaited<ReturnType<typeof actions.erasePost>>>();
    erasures.push({ data: structuredClone(input.data), csrf: new Headers(input.headers).get('X-CSRF-Token'), gate });
    return gate.promise;
  });
  const restoreSpy = spyOn(actions, 'restorePost').mockImplementation((input) => {
    const gate = deferred<Awaited<ReturnType<typeof actions.restorePost>>>();
    restorations.push({
      data: structuredClone(input.data),
      csrf: new Headers(input.headers).get('X-CSRF-Token'),
      gate,
    });
    return gate.promise;
  });

  function pageFor(post: ThreadPost, title = 'A close reading'): ThreadReadingPage {
    return {
      thread: {
        id: threadId,
        boardId: id(1),
        authorId: account,
        title,
        availability: 'available',
        firstPost: post,
      } as ThreadReadingPage['thread'],
      posts: { posts: [post], next: null },
      authors: {},
      subjects: [],
      provenanceSubjects: [],
      mentions: null,
      verification: { sitekey: '', scriptUrl: '' },
      now: '2026-02-01T00:00:00.000Z',
      viewerId: account,
    };
  }

  function Surface() {
    const [current, setCurrent] = useState(state);
    updateState = (next) => {
      setCurrent((previous) => {
        const resolved = typeof next === 'function' ? next(previous) : next;
        state = resolved;
        return resolved;
      });
    };
    const onChange = (post: ThreadPost) => {
      changes.push(post);
      updateState((previous) => ({ ...previous, post }));
    };
    const onPageRefresh = async () => {
      const gate = deferred<ThreadReadingPage | undefined>();
      pageReads.push(gate);
      const page = await gate.promise;
      if (page && applyRefreshPost) {
        const refreshed = page.posts.posts.find((item) => item.id === current.post.id);
        updateState((previous) => ({
          ...previous,
          post: refreshed ?? previous.post,
          title: page.thread.title,
        }));
      }
      return page;
    };
    return (
      <>
        {current.visible ? (
          <ThreadReadingPost
            post={current.post}
            readAuthority={current.readAuthority}
            authors={{}}
            mentions={{}}
            now="2026-02-01T00:00:00.000Z"
            viewerId={current.viewerId}
            personalReady={current.personalReady}
            onChange={onChange}
            anchorId={`post-${postId}`}
            target={current.target}
            counts={{}}
            value={null}
            signedIn={current.signedIn}
            returnTo={`/en/threads/${threadId}/a-close-reading`}
            verification={{ sitekey: '', scriptUrl: '' }}
            onMutation={async () => {
              mutations += 1;
            }}
            onPageRefresh={onPageRefresh}
            onOpeningPostChange={(restored) => openingChanges.push(restored)}
            replyParents={new Map()}
            replyPending={false}
            onReply={() => {}}
            subjects={[]}
            currentVote={undefined}
            review={false}
          />
        ) : null}
        <output data-testid="opening-title">{current.title ?? ''}</output>
      </>
    );
  }

  const rootRoute = createRootRoute({ component: Outlet });
  const surfaceRoute = createRoute({ getParentRoute: () => rootRoute, path: '/surface', component: Surface });
  const router = createRouter({
    routeTree: rootRoute.addChildren([surfaceRoute]),
    history: createMemoryHistory({ initialEntries: ['/surface'] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, originalSession);
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const render = async () =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <StrictMode>
            <Toaster timeout={0}>
              <RouterProvider router={router} />
            </Toaster>
          </StrictMode>
        </QueryClientProvider>,
      );
    });
  const settle = async (ready: () => boolean) => {
    for (let count = 0; count < 180 && !ready(); count++)
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    expect(ready()).toBe(true);
  };
  const buttons = (label: string) =>
    [...window.document.querySelectorAll<HTMLButtonElement>('button')].filter(
      (item) => item.getAttribute('aria-label') === label || item.textContent?.trim() === label,
    );
  const button = (label: string, index = 0) => {
    const found = buttons(label)[index];
    expect(found).toBeDefined();
    return found!;
  };
  const click = async (label: string, index = 0) => act(async () => user.click(button(label, index)));
  const clickText = async (label: string) => {
    const found = [...window.document.querySelectorAll<HTMLElement>('[role="menuitem"],button')].find(
      (item) => item.textContent?.trim() === label,
    );
    expect(found).toBeDefined();
    await act(async () => user.click(found!));
  };
  const openMenu = async () => click(m.thread_content_more_actions());
  const openDelete = async () => {
    await openMenu();
    await clickText(m.thread_content_delete());
    await settle(() => buttons(m.thread_delete_confirm()).length > 0);
  };
  const confirmDeleteTwice = async () =>
    act(async () => {
      const confirm = button(m.thread_delete_confirm());
      confirm.click();
      confirm.click();
    });
  const submitEditor = async () => {
    const save = button(m.thread_edit_save());
    await act(async () => user.click(save));
  };
  const restoreAvailable = (restored = availablePost(), title = 'A close reading') => pageFor(restored, title);
  const restoreExpired = new Date(Date.now() - 60_000).toISOString();
  const restoreDeadline = new Date(Date.now() + 60_000).toISOString();

  try {
    await render();
    await settle(() => !!host.querySelector('[data-slot="content-item-frame"]'));

    // An edit keeps the exact body, revision, media and key for an uncertain retry. A caller transition
    // during the retry suppresses the late success without remounting or clearing the dirty editor.
    await openMenu();
    await clickText(m.thread_content_edit());
    await settle(() => host.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]') !== null);
    const editor = host.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]')!;
    await act(async () => {
      await user.click(editor);
      await user.keyboard(' Edited writing');
      await user.tab();
    });
    await submitEditor();
    await settle(() => edits.length === 1);
    const exactEdit = structuredClone(edits[0]!.data);
    expect(exactEdit).toMatchObject({ postId, revisionId, mediaIds: [mediaId] });
    expect(exactEdit.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.stringify(exactEdit.body)).toContain('Edited writing');
    expect(edits[0]!.csrf).toBe(originalSession.csrfToken);
    await act(async () => edits[0]!.gate.reject(new Error('Revision response was lost')));
    await settle(() => host.textContent?.includes(m.thread_edit_unavailable()) === true);
    await click(m.thread_write_retry());
    await settle(() => edits.length === 2);
    expect(edits[1]!.data).toEqual(exactEdit);
    expect(edits[1]!.csrf).toBe(originalSession.csrfToken);
    await act(async () => {
      updateState((previous) => ({
        ...previous,
        readAuthority: {},
        target: { kind: 'post', id: postId },
      }));
      await Promise.resolve();
    });
    const revised = {
      ...sourcePost,
      revisionId: id(55),
      revisedAt: '2026-02-01T00:00:00.000Z',
      body: exactEdit.body,
      mediaIds: exactEdit.mediaIds,
    } as RevisedPost;
    await act(async () => {
      edits[1]!.gate.resolve({ ok: true, post: revised });
      await Promise.resolve();
    });
    expect(changes).toHaveLength(0);
    expect(mutations).toBe(0);
    expect(host.querySelector('.ProseMirror[contenteditable="true"]')).not.toBeNull();
    const unload = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await act(async () => {
      updateState((previous) => ({
        ...previous,
        readAuthority: initialAuthority,
        target: { kind: 'thread', id: threadId },
      }));
      await Promise.resolve();
    });
    await submitEditor();
    expect(edits).toHaveLength(2); // Returning to the original values cannot revive the old edit caller.
    expect(host.querySelector('.ProseMirror[contenteditable="true"]')).not.toBeNull();

    // Cancel remains available and the real departure dialog protects the dirty draft until discard.
    await click(m.thread_edit_cancel());
    await settle(() => buttons(m.thread_authoring_discard()).length > 0);
    await click(m.thread_authoring_discard());
    await settle(() => host.querySelector('.ProseMirror[contenteditable="true"]') === null);

    // A pending confirmation belongs to the caller which opened it. A same-account credential replacement
    // closes that confirmation and the detached old confirm button cannot send with the new token.
    await openDelete();
    const staleConfirm = button(m.thread_delete_confirm());
    client.setQueryData(sessionQuery.queryKey, { ...originalSession, csrfToken: 'csrf-rotated' });
    await settle(() => buttons(m.thread_delete_confirm()).length === 0);
    await act(async () => staleConfirm.click());
    expect(erasures).toHaveLength(0);

    // The current menu remains available. Duplicate confirmation is synchronously suppressed and the original
    // caller's exact payload and credential cross the existing native action boundary once.
    await openDelete();
    await confirmDeleteTwice();
    await settle(() => erasures.length === 1);
    expect(erasures[0]!.data).toMatchObject({ postId, openingThreadId: threadId });
    expect(erasures[0]!.data.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(erasures[0]!.csrf).toBe('csrf-rotated');
    await act(async () => erasures[0]!.gate.resolve({ ok: true }));
    await settle(() => changes.length === 1 && pageReads.length === 1 && buttons(m.thread_post_undo()).length === 1);
    expect(changes[0]!.availability).toBe('erased');
    expect(openingChanges).toEqual([false]);
    expect(host.querySelector<HTMLElement>(`#post-${postId}`)?.style.minHeight).toBe('0px');
    await act(async () => pageReads[0]!.reject(new Error('Current post read failed after applied delete')));
    await settle(() => host.textContent?.includes(m.thread_post_delete_read_failure()) === true);
    expect(erasures).toHaveLength(1); // An applied delete is not repeated after its page read fails.

    // Undo uses the original delete caller. An uncertain restore first refreshes the page, then retries the same
    // exact restore key and post under the original CSRF token. The read, retry and toast are the real wiring.
    await click(m.thread_post_undo());
    await settle(() => restorations.length === 1);
    const restoreKey = restorations[0]!.data.idempotencyKey;
    expect(restorations[0]!.data).toEqual({ postId, idempotencyKey: restoreKey });
    expect(restorations[0]!.csrf).toBe('csrf-rotated');
    await act(async () => restorations[0]!.gate.resolve({ ok: false, reason: 'unavailable' }));
    await settle(() => host.textContent?.includes(m.thread_post_restore_unknown()) === true);
    const restoreButton = button(m.thread_post_restore());
    await act(async () => {
      restoreButton.click();
      restoreButton.click();
    });
    await settle(() => pageReads.length === 2);
    await act(async () => pageReads[1]!.resolve(pageFor(erasedPost(restoreDeadline))));
    await settle(() => restorations.length === 2);
    expect(restorations[1]!.data).toEqual(restorations[0]!.data);
    expect(restorations[1]!.csrf).toBe('csrf-rotated');
    expect(pageReads).toHaveLength(2); // one delete refresh and one uncertain-restore reconciliation
    applyRefreshPost = true;
    await act(async () => restorations[1]!.gate.resolve({ ok: true }));
    await settle(() => pageReads.length === 3 && state.post.availability === 'available');
    await act(async () => pageReads[2]!.resolve(restoreAvailable(availablePost(), 'A restored reading')));
    await settle(() => host.querySelector(`#post-${postId}`)?.textContent?.includes('Original post body.') === true);
    expect(state.title).toBe('A restored reading');
    expect(restorations).toHaveLength(2); // confirmed restore is not repeated by its follow-up read
    expect(window.document.activeElement?.id).toBe(`post-${postId}`);

    // A fresh delete from the restored post starts a new intent episode. A cache away/back transition retires
    // its Undo forever even though the final account and token tuple equal the original values.
    await openDelete();
    await confirmDeleteTwice();
    await settle(() => erasures.length === 2);
    await act(async () => erasures[1]!.gate.resolve({ ok: true }));
    await settle(() => changes.length === 2 && pageReads.length === 4 && buttons(m.thread_post_undo()).length === 1);
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
      client.setQueryData(sessionQuery.queryKey, { ...originalSession, csrfToken: 'csrf-rotated' });
    });
    await act(async () => pageReads[3]!.resolve(undefined));
    const beforeStaleUndoReads = pageReads.length;
    await click(m.thread_post_undo());
    await Promise.resolve();
    expect(restorations).toHaveLength(2);
    expect(pageReads).toHaveLength(beforeStaleUndoReads);

    // The next native restore window is usable for the current caller. Public, unready and expired readers
    // receive no restore control; withheld content keeps its actual state and no restore path.
    await act(async () =>
      updateState((previous) => ({
        ...previous,
        post: erasedPost(restoreDeadline),
        viewerId: account,
        signedIn: true,
        personalReady: true,
      })),
    );
    await settle(() => buttons(m.thread_post_restore()).length === 1);
    await act(async () => updateState((previous) => ({ ...previous, post: erasedPost(restoreExpired) })));
    await settle(() => buttons(m.thread_post_restore()).length === 0);
    await act(async () => updateState((previous) => ({ ...previous, post: withheldPost() })));
    await settle(() => host.querySelector('[data-slot="tombstone"]') !== null);
    expect(buttons(m.thread_post_restore())).toHaveLength(0);
    await act(async () => {
      updateState((previous) => ({
        ...previous,
        post: erasedPost(restoreDeadline),
        viewerId: undefined,
        signedIn: false,
        personalReady: true,
      }));
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    });
    await settle(() => buttons(m.thread_post_restore()).length === 0);
    await act(async () => {
      updateState((previous) => ({ ...previous, viewerId: account, signedIn: true, personalReady: false }));
      client.setQueryData(sessionQuery.queryKey, { ...originalSession, csrfToken: 'csrf-rotated' });
    });
    await settle(() => buttons(m.thread_post_restore()).length === 0);
    await act(async () => updateState((previous) => ({ ...previous, personalReady: true })));
    await settle(() => buttons(m.thread_post_restore()).length === 1);
    await click(m.thread_post_restore());
    await settle(() => restorations.length === 3);
    expect(restorations[2]!.csrf).toBe('csrf-rotated');
    await act(async () => restorations[2]!.gate.resolve({ ok: false, reason: 'conflict', existingReviewId: id(88) }));
    await settle(() => host.textContent?.includes(m.thread_post_restore_conflict()) === true);
    expect(host.querySelector(`a[href="/en/threads/${id(88)}"]`)).not.toBeNull();

    // A retained refresh callback is checked before starting another page read. A read already in flight is
    // checked again after settlement and cannot publish state under a replacement readiness/CSRF revision.
    const oldRefreshButton = button(m.thread_post_refresh());
    applyRefreshPost = false;
    await act(async () => user.click(oldRefreshButton));
    await settle(() => pageReads.length === 5);
    client.setQueryData(sessionQuery.queryKey, { ...originalSession, csrfToken: null });
    await settle(() => buttons(m.thread_post_refresh()).length === 0);
    const callbackCount = changes.length;
    await act(async () => {
      pageReads[4]!.resolve(pageFor(erasedPost(restoreDeadline)));
      await Promise.resolve();
    });
    expect(changes).toHaveLength(callbackCount);
    expect(restorations).toHaveLength(3);
    await act(async () => oldRefreshButton.click());
    expect(pageReads).toHaveLength(5);

    // A post/revision/reader transition and unmount/remount each retire captured Undo callbacks. StrictMode
    // effect reconnects are covered by the real mounted route above; no old operation is revived by remount.
    client.setQueryData(sessionQuery.queryKey, { ...originalSession, csrfToken: 'csrf-final' });
    await act(async () =>
      updateState((previous) => ({
        ...previous,
        post: availablePost(id(55)),
        readAuthority: {},
        target: { kind: 'post', id: id(55) },
        signedIn: true,
        personalReady: true,
        viewerId: account,
      })),
    );
    await settle(() => host.querySelector('[data-slot="content-item-frame"]') !== null);
    await openDelete();
    await confirmDeleteTwice();
    await settle(() => erasures.length === 3);
    await act(async () => erasures[2]!.gate.resolve({ ok: true }));
    await settle(() => pageReads.length === 6 && buttons(m.thread_post_undo()).length === 1);
    await act(async () => pageReads[5]!.resolve(undefined));
    const oldUndo = button(m.thread_post_undo());
    await act(async () => updateState((previous) => ({ ...previous, visible: false })));
    await act(async () => {
      await Promise.resolve();
      updateState((previous) => ({ ...previous, visible: true, post: sourcePost }));
    });
    await settle(() => host.querySelector(`#post-${postId}`) !== null);
    await act(async () => oldUndo.click());
    expect(restorations).toHaveLength(3);

    // Delete keeps its exact key after a lost response. A later confirmed result from that old caller cannot
    // publish the erased placeholder, update the opening post, start a refresh, or show a fresh Undo.
    const changesBeforeLateDelete = changes.length;
    const readsBeforeLateDelete = pageReads.length;
    await openDelete();
    await click(m.thread_delete_confirm());
    await settle(() => erasures.length === 4);
    const lostDelete = structuredClone(erasures[3]!.data);
    await act(async () => erasures[3]!.gate.reject(new Error('Delete response was lost')));
    await settle(() => host.textContent?.includes('Delete response was lost') === true);
    await click(m.thread_delete_confirm());
    await settle(() => erasures.length === 5);
    expect(erasures[4]!.data).toEqual(lostDelete);
    expect(erasures[4]!.csrf).toBe('csrf-final');
    client.setQueryData(sessionQuery.queryKey, { ...originalSession, csrfToken: 'csrf-replaced-after-send' });
    await act(async () => erasures[4]!.gate.resolve({ ok: true }));
    expect(changes).toHaveLength(changesBeforeLateDelete);
    expect(pageReads).toHaveLength(readsBeforeLateDelete);
    expect(openingChanges).toEqual([false, false]);
  } finally {
    await act(async () => root.unmount());
    editSpy.mockRestore();
    eraseSpy.mockRestore();
    restoreSpy.mockRestore();
    client.clear();
    host.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
