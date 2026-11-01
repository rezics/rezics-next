import { expect, test, mock } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, createElement, useEffect, useState } from 'react';

test('default thread composers preserve drafts on Stay, allow Leave and success navigation, protect unknown results, and bypass sign-out', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/compose', width: 1280, height: 900 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
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
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useRouter } =
    await import('@tanstack/react-router');
  const { AuthoringDepartureProvider } = await import('../src/threads/authoring-departure');
  const { PostComposer, InlinePostEditor } = await import('../src/threads/composer');
  const { ThreadReplyComposer } = await import('../src/threads/reply-context-composer');
  const { fromPlainText } = await import('@rezics/document');
  const { m } = await import('../src/paraglide/messages.js');
  const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const openingCalls: unknown[] = [];
  const replyCalls: unknown[] = [];
  let arrivals = 0;
  let openingOutcome: 'unknown' | 'success' = 'unknown';

  function OpeningPage() {
    const router = useRouter();
    const [outcome, setOutcome] = useState(openingOutcome);
    openingOutcome = outcome;
    return (
      <AuthoringDepartureProvider>
        <PostComposer
          initialKey="0192f3a0-6c1e-7b2a-9d4e-000000000081"
          titleRequired
          boardId="board-1"
          onSubmit={async (command) => {
            openingCalls.push(structuredClone(command));
            return outcome === 'success'
              ? { ok: true as const, value: { id: 'created-thread' } }
              : { ok: false as const, reason: 'unavailable' as const };
          }}
          onSuccess={() => void router.navigate({ href: '/inbox' })}
        />
        <button type="button" onClick={() => void setOutcome('success')}>
          Use successful result
        </button>
        <button type="button" onClick={() => void router.navigate({ href: '/inbox' })}>
          Leave conversation
        </button>
        <form action="/auth/sign-out" method="post">
          <button type="submit">Sign out</button>
        </form>
      </AuthoringDepartureProvider>
    );
  }

  function ReplyPage() {
    const router = useRouter();
    const [parentId, setParentId] = useState<string | null>(null);
    return (
      <AuthoringDepartureProvider>
        <ThreadReplyComposer
          initialKey="0192f3a0-6c1e-7b2a-9d4e-000000000082"
          containerId="0192f3a0-6c1e-7b2a-9d4e-000000000083"
          parentId={parentId}
          parents={new Map()}
          pending={false}
          focusRequest={0}
          onPendingChange={() => undefined}
          onCancel={() => undefined}
          onSubmit={async (command) => {
            replyCalls.push(structuredClone(command));
            return { ok: false as const, reason: 'unavailable' as const };
          }}
          onSuccess={() => undefined}
        />
        <button type="button" onClick={() => void router.navigate({ href: '/inbox' })}>
          Leave conversation
        </button>
        <button type="button" onClick={() => setParentId('0192f3a0-6c1e-7b2a-9d4e-000000000084')}>
          Choose reply parent
        </button>
      </AuthoringDepartureProvider>
    );
  }

  function EditPage() {
    const [editing, setEditing] = useState(true);
    return (
      <AuthoringDepartureProvider>
        {editing ? (
          <InlinePostEditor
            initialBody={fromPlainText('Saved paragraph.', 'blocks')}
            revisionId="revision-1"
            idempotencyKey="0192f3a0-6c1e-7b2a-9d4e-000000000085"
            containerId="0192f3a0-6c1e-7b2a-9d4e-000000000083"
            onSubmit={async () => ({ ok: false as const, reason: 'unavailable' as const })}
            onCancel={() => setEditing(false)}
            onSuccess={() => setEditing(false)}
          />
        ) : (
          <p>Editor closed</p>
        )}
      </AuthoringDepartureProvider>
    );
  }

  function InboxPage() {
    useEffect(() => {
      arrivals++;
    }, []);
    return createElement('h1', null, 'Inbox destination');
  }

  const rootRoute = createRootRoute({ component: Outlet });
  const composeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/compose', component: OpeningPage });
  const replyRoute = createRoute({ getParentRoute: () => rootRoute, path: '/reply', component: ReplyPage });
  const editRoute = createRoute({ getParentRoute: () => rootRoute, path: '/edit', component: EditPage });
  const inboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/inbox',
    component: InboxPage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([composeRoute, replyRoute, editRoute, inboxRoute]),
    history: createMemoryHistory({ initialEntries: ['/compose'] }),
  });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const settle = async (ready: () => boolean) => {
    for (let count = 0; count < 180 && !ready(); count++)
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    expect(ready()).toBe(true);
  };
  const button = (label: string) => {
    const match = [...window.document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
    expect(match).toBeDefined();
    return match!;
  };
  const click = async (label: string) => act(async () => user.click(button(label)));
  const textbox = (label: string) =>
    [...window.document.querySelectorAll<HTMLElement>('[role="textbox"]')].find(
      (item) => item.getAttribute('aria-label') === label,
    );
  const typeBody = async (label: string, content: string) => {
    await settle(() => textbox(label)?.classList.contains('ProseMirror') === true);
    await act(async () => {
      await user.click(textbox(label)!);
      await user.keyboard(content);
      await user.tab();
    });
  };
  const titleInput = () => window.document.querySelector<HTMLInputElement>('#thread-title');
  const beforeUnloadIsBlocked = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const dialog = () => window.document.querySelector('[role="alertdialog"]');

  try {
    await router.load();
    await act(async () => root.render(createElement(RouterProvider, { router })));
    await settle(
      () => titleInput() !== null && textbox(m.thread_new_body_label())?.classList.contains('ProseMirror') === true,
    );
    expect(beforeUnloadIsBlocked()).toBe(false);
    await act(async () => user.type(titleInput()!, 'An unsaved opening'));
    await typeBody(m.thread_new_body_label(), 'A structured opening paragraph.');
    expect(beforeUnloadIsBlocked()).toBe(true);
    await click('Leave conversation');
    await settle(() => dialog() !== null);
    expect(dialog()?.textContent).toContain(m.thread_authoring_leave_unsaved());
    await click(m.thread_authoring_stay());
    await settle(() => dialog() === null);
    expect(titleInput()?.value).toBe('An unsaved opening');
    expect(textbox(m.thread_new_body_label())?.textContent).toContain('A structured opening paragraph.');

    await click(m.thread_write_send());
    await settle(() => openingCalls.length === 1 && host.textContent?.includes(m.thread_write_unavailable()) === true);
    const originalCommand = structuredClone(openingCalls[0]);
    await click('Leave conversation');
    await settle(() => dialog() !== null);
    expect(dialog()?.textContent).toContain(m.thread_authoring_leave_pending());
    await click(m.thread_authoring_stay());
    await settle(() => dialog() === null);
    expect(titleInput()?.value).toBe('An unsaved opening');
    expect(textbox(m.thread_new_body_label())?.textContent).toContain('A structured opening paragraph.');
    expect(openingCalls).toEqual([originalCommand]);
    await click(m.thread_write_retry());
    await settle(() => openingCalls.length === 2 && host.textContent?.includes(m.thread_write_unavailable()) === true);
    expect(openingCalls[1]).toEqual(originalCommand);
    await click('Leave conversation');
    await settle(() => dialog() !== null);
    await click(m.thread_authoring_leave());
    await settle(() => router.state.location.pathname === '/inbox');
    expect(arrivals).toBe(1);

    await act(async () => router.navigate({ href: '/compose' }));
    await settle(() => titleInput() !== null);
    await click('Use successful result');
    await act(async () => user.type(titleInput()!, 'A successful opening'));
    await typeBody(m.thread_new_body_label(), 'This opening is submitted successfully.');
    await click(m.thread_write_send());
    await settle(() => router.state.location.pathname === '/inbox' && arrivals === 2);
    expect(openingCalls).toHaveLength(2);
    expect(dialog()).toBeNull();

    await act(async () => router.navigate({ href: '/compose' }));
    await settle(() => titleInput() !== null);
    await act(async () => user.type(titleInput()!, 'A local opening before sign-out'));
    const signOut = host.querySelector('form[action="/auth/sign-out"]')!;
    await act(async () => signOut.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    expect(beforeUnloadIsBlocked()).toBe(false);
    expect(dialog()).toBeNull();

    await act(async () => router.navigate({ href: '/reply' }));
    await settle(() => textbox(m.thread_reply_label())?.classList.contains('ProseMirror') === true);
    expect(beforeUnloadIsBlocked()).toBe(false);
    await click('Leave conversation');
    await settle(() => router.state.location.pathname === '/inbox');
    expect(dialog()).toBeNull();
    await act(async () => router.navigate({ href: '/reply' }));
    await click('Choose reply parent');
    expect(beforeUnloadIsBlocked()).toBe(true);
    await click('Leave conversation');
    await settle(() => dialog() !== null);
    await click(m.thread_authoring_stay());
    await settle(() => dialog() === null);
    expect(host.textContent).toContain(m.thread_reply_cancel_target());
    await typeBody(m.thread_reply_label(), 'A reply with a selected parent.');
    expect(beforeUnloadIsBlocked()).toBe(true);
    await click('Leave conversation');
    await settle(() => dialog() !== null);
    await click(m.thread_authoring_stay());
    await settle(() => dialog() === null);
    expect(textbox(m.thread_reply_label())?.textContent).toContain('A reply with a selected parent.');
    await click('Leave conversation');
    await settle(() => dialog() !== null);
    await click(m.thread_authoring_leave());
    await settle(() => router.state.location.pathname === '/inbox');
    expect(replyCalls).toHaveLength(0);

    await act(async () => router.navigate({ href: '/edit' }));
    await typeBody(m.thread_reply_body_label(), ' changed locally.');
    await click(m.thread_edit_cancel());
    await settle(() => dialog() !== null);
    expect(dialog()?.textContent).toContain(m.thread_authoring_discard_unsaved());
    await click(m.thread_authoring_stay());
    await settle(() => dialog() === null);
    expect(textbox(m.thread_reply_body_label())?.textContent).toContain('Saved paragraph.');
    expect(textbox(m.thread_reply_body_label())?.textContent).toContain('changed locally.');
    await act(async () => user.keyboard('{Escape}'));
    await settle(() => dialog() !== null);
    await click(m.thread_authoring_discard());
    await settle(() => host.textContent?.includes('Editor closed') === true);
    expect(host.textContent).not.toContain('changed locally.');
  } finally {
    await act(async () => root.unmount());
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
