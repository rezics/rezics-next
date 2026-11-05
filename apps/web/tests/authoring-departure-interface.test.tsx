import { expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, useEffect, useState } from 'react';

// Mounted behavior is authored UNRUN for integration. Happy DOM cannot measure CSS geometry.
// The canonical stories own the UNRUN 44px, wrapping, viewport, RTL and visible-focus observations.
test('real authoring departure preserves drafts and focus, confirms only the chosen action, and retires private writing', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/de/compose', width: 390, height: 844 });
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
  const previous = new Map(
    [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { AuthoringDepartureProvider } = await import('../src/threads/authoring-departure');
  const { EditionPublication } = await import('../src/content-editions/edition-create-view');
  const { EditionPublicationController, editionCreateNavigationContext } =
    await import('../src/content-editions/edition-create');
  const { PostComposer, InlinePostEditor } = await import('../src/threads/composer');
  const { ThreadReplyComposer } = await import('../src/threads/reply-context-composer');
  const { sessionQuery } = await import('../src/session/query');
  const { fromPlainText } = await import('@rezics/document');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const originalLocale = getLocale();
  setLocale('de', { reload: false });
  document.documentElement.dir = 'rtl';
  const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const requests: string[] = [];
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    requests.push(String(input));
    throw new Error(`Unexpected departure request: ${input}`);
  };
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: Object.assign(fetcher, { preconnect() {} }),
  });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
  const owner = { state: 'signed-in' as const, subject: id(1), csrfToken: 'original-session' };
  const longBody =
    'A long opening post with enough words to demonstrate how the editor grows as the author writes.\n\nIt continues in another paragraph to show the writing surface at a useful height.';
  const localTitle = 'An opening that is not saved yet';
  const addition = ' An edit that has not been saved.';
  const settle = async (ready: () => boolean) => {
    for (let n = 0; n < 180 && !ready(); n++)
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    expect(ready()).toBe(true);
  };
  const button = (scope: ParentNode, label: string) => {
    const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent?.trim() === label.trim(),
    );
    expect(result).toBeDefined();
    return result!;
  };
  const click = async (node: HTMLElement) => act(async () => user.click(node));
  const blocked = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const openDialog = async (
    origin: HTMLElement,
    message: string,
    discard = false,
    title = m.thread_authoring_leave_title(),
  ) => {
    await act(async () => {
      origin.focus();
      await user.keyboard('{Enter}');
    });
    await settle(() => dialog() !== null);
    const popup = dialog()!;
    const description = document.getElementById(popup.getAttribute('aria-describedby')!);
    expect(description?.textContent).toBe(message);
    expect(description?.closest('details')).toBeNull();
    expect(popup.querySelector('h2')?.textContent).toBe(discard ? m.thread_authoring_discard_title() : title);
    expect(popup.querySelectorAll('button')).toHaveLength(2);
    const stay = button(popup, m.thread_authoring_stay());
    const leave = button(popup, discard ? m.thread_authoring_discard() : m.thread_authoring_leave());
    await settle(() => document.activeElement === stay);
    await act(async () => user.tab());
    expect(document.activeElement).toBe(leave);
    await act(async () => user.tab());
    expect(document.activeElement).toBe(stay);
    return { stay, leave };
  };
  const stayAndRestore = async (stay: HTMLElement, origin: HTMLElement) => {
    await click(stay);
    await settle(() => dialog() === null && document.activeElement === origin);
  };
  const editText = async (scope: ParentNode, label: string) => {
    await settle(() => !!scope.querySelector('.ProseMirror[contenteditable="true"]'));
    const editor = [...scope.querySelectorAll<HTMLElement>('[role="textbox"]')].find(
      (node) => node.getAttribute('aria-label') === label,
    )!;
    await act(async () => {
      await user.click(editor);
      await user.keyboard(addition);
      await user.tab();
    });
    return editor;
  };

  const mount = async (
    kind: 'opening' | 'reply' | 'edit' | 'edition',
    hold = false,
    publication?: { controller: InstanceType<typeof EditionPublicationController>; events: string[] },
  ) => {
    await act(async () => root.render(null));
    client.clear();
    client.setQueryData(sessionQuery.queryKey, owner);
    const commands: unknown[] = [];
    const cancels: number[] = [];
    let arrivals = 0;
    let successes = 0;
    let resolve!: (result: { ok: false; reason: 'unavailable' }) => void;
    const outcome = new Promise<{ ok: false; reason: 'unavailable' }>((yes) => {
      resolve = yes;
    });
    const submit = async (command: unknown) => {
      commands.push(structuredClone(command));
      return hold ? outcome : { ok: false as const, reason: 'unavailable' as const };
    };
    function Page() {
      const [shown, setShown] = useState(true);
      const [closed, setClosed] = useState<number[]>([]);
      return (
        <>
          {shown ? (
            <AuthoringDepartureProvider
              navigationContext={kind === 'edition' ? editionCreateNavigationContext : undefined}
              navigationMessages={
                kind === 'edition'
                  ? {
                      title: m.edition_publication_leave_title(),
                      unsaved: m.edition_publication_leave_unsaved(),
                      pending: m.edition_publication_leave_pending(),
                    }
                  : undefined
              }
              sessionBound={kind === 'edition' ? 'subject' : true}
            >
              {kind === 'edit' ? (
                [0, 1].map((index) => (
                  <section key={index} data-editor={index}>
                    {closed.includes(index) ? (
                      <p>Editor closed</p>
                    ) : (
                      <InlinePostEditor
                        initialBody={fromPlainText(longBody, 'blocks')}
                        revisionId="revision-1"
                        idempotencyKey={id(10 + index)}
                        containerId={id(2)}
                        onSubmit={submit}
                        onCancel={() => {
                          cancels.push(index);
                          setClosed((current) => [...current, index]);
                        }}
                        onSuccess={() => {
                          successes++;
                        }}
                      />
                    )}
                  </section>
                ))
              ) : kind === 'reply' ? (
                <ThreadReplyComposer
                  initialKey={id(10)}
                  containerId={id(2)}
                  parentId={id(3)}
                  parents={new Map()}
                  pending={false}
                  focusRequest={0}
                  onPendingChange={() => undefined}
                  onCancel={() => undefined}
                  onSubmit={submit}
                  onSuccess={() => {
                    successes++;
                  }}
                />
              ) : kind === 'edition' ? (
                <EditionPublication controller={publication!.controller} />
              ) : (
                <PostComposer
                  initialKey={id(10)}
                  initialBody={fromPlainText(longBody, 'blocks')}
                  titleRequired
                  boardId={id(2)}
                  onSubmit={submit}
                  onSuccess={() => {
                    successes++;
                  }}
                />
              )}
              <button type="button" onClick={() => void router.navigate({ href: '/inbox' })}>
                {kind === 'edition' ? 'Leave publication' : 'Leave conversation'}
              </button>
              <form method="post" action="/auth/sign-out">
                <button type="submit">Sign out</button>
              </form>
            </AuthoringDepartureProvider>
          ) : (
            <p>Authoring unmounted</p>
          )}
          <button type="button" onClick={() => setShown(false)}>
            Hide authoring page
          </button>
        </>
      );
    }
    function Destination() {
      useEffect(() => {
        arrivals++;
      }, []);
      return <h1>Inbox destination</h1>;
    }
    const parent = createRootRoute({ component: Outlet });
    const router = createRouter({
      routeTree: parent.addChildren([
        createRoute({ getParentRoute: () => parent, path: '/compose', component: Page }),
        createRoute({
          getParentRoute: () => parent,
          path: '/inbox',
          loader: () => {
            if (publication) publication.events.push('read');
          },
          component: Destination,
        }),
      ]),
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
    await settle(() =>
      kind === 'edition'
        ? host.textContent?.includes(m.edition_publication_draft_heading()) === true
        : !!host.querySelector('.ProseMirror'),
    );
    expect(blocked()).toBe(false);
    if (kind === 'opening') {
      await act(async () => user.type(host.querySelector('#thread-title')!, localTitle));
    } else {
      const panels = kind === 'edit' ? [...host.querySelectorAll<HTMLElement>('[data-editor]')] : [host];
      for (const panel of panels)
        await editText(panel, kind === 'edit' ? m.thread_reply_body_label() : m.thread_reply_label());
    }
    expect(blocked()).toBe(true);
    return {
      router,
      commands,
      cancels,
      resolve,
      origin: button(host, kind === 'edition' ? 'Leave publication' : 'Leave conversation'),
      counts: () => ({ arrivals, successes }),
    };
  };

  try {
    // Dirty opening, reply parent/body and two independently dirty inline edits share the real owner.
    for (const kind of ['opening', 'reply', 'edit'] as const) {
      const page = await mount(kind);
      const before = [...host.querySelectorAll<HTMLElement>('.ProseMirror')].map((node) => node.innerHTML);
      const { stay } = await openDialog(page.origin, m.thread_authoring_leave_unsaved());
      expect(page.counts()).toEqual({ arrivals: 0, successes: 0 });
      expect(page.commands).toEqual([]);
      expect(page.cancels).toEqual([]);
      await stayAndRestore(stay, page.origin);
      expect([...host.querySelectorAll<HTMLElement>('.ProseMirror')].map((node) => node.innerHTML)).toEqual(before);
      if (kind === 'opening') expect(host.querySelector<HTMLInputElement>('#thread-title')?.value).toBe(localTitle);
      await openDialog(page.origin, m.thread_authoring_leave_unsaved());
      await act(async () => user.keyboard('{Escape}'));
      await settle(() => dialog() === null && document.activeElement === page.origin);
      expect([...host.querySelectorAll<HTMLElement>('.ProseMirror')].map((node) => node.innerHTML)).toEqual(before);
      expect(blocked()).toBe(true);
      expect(page.router.state.location.pathname).toBe('/compose');
      const { leave } = await openDialog(page.origin, m.thread_authoring_leave_unsaved());
      expect(page.counts().arrivals).toBe(0);
      await act(async () => {
        leave.focus();
        await user.keyboard('{Enter}');
      });
      await settle(() => page.router.state.location.pathname === '/inbox');
      expect(page.counts()).toEqual({ arrivals: 1, successes: 0 });
      expect(page.cancels).toEqual([]);
      expect(host.querySelector('[role="textbox"]')).toBeNull();
      expect(blocked()).toBe(false);
    }

    const edits = await mount('edit');
    const panels = [...host.querySelectorAll<HTMLElement>('[data-editor]')];
    const firstCancel = button(panels[0]!, m.thread_edit_cancel());
    const { stay } = await openDialog(firstCancel, m.thread_authoring_discard_unsaved(), true);
    await stayAndRestore(stay, firstCancel);
    expect(edits.cancels).toEqual([]);
    for (const panel of panels) expect(panel.textContent).toContain(addition.trim());
    const { leave: discard } = await openDialog(firstCancel, m.thread_authoring_discard_unsaved(), true);
    expect(edits.cancels).toEqual([]);
    await click(discard);
    await settle(() => panels[0]!.textContent === 'Editor closed');
    expect(edits.cancels).toEqual([0]);
    expect(panels[1]!.textContent).toContain(addition.trim());
    expect(edits.counts()).toEqual({ arrivals: 0, successes: 0 });
    expect(edits.commands).toEqual([]);
    expect(blocked()).toBe(true);

    // Pending then unknown result: prompts never submit, replay, cancel or navigate by themselves.
    const pending = await mount('opening', true);
    await click(button(host, m.thread_write_send()));
    await settle(() => pending.commands.length === 1);
    const command = structuredClone(pending.commands[0]);
    const pendingDialog = await openDialog(pending.origin, m.thread_authoring_leave_pending());
    await stayAndRestore(pendingDialog.stay, pending.origin);
    expect(host.querySelector<HTMLInputElement>('#thread-title')?.value).toBe(localTitle);
    await act(async () => pending.resolve({ ok: false, reason: 'unavailable' }));
    await settle(() => host.textContent?.includes(m.thread_write_unavailable()) === true);
    const unknown = await openDialog(pending.origin, m.thread_authoring_leave_pending());
    await stayAndRestore(unknown.stay, pending.origin);
    expect(pending.commands).toEqual([command]);
    await click(button(host, m.thread_write_retry()));
    await settle(() => pending.commands.length === 2);
    expect(pending.commands).toEqual([command, command]);
    const confirmed = await openDialog(pending.origin, m.thread_authoring_leave_pending());
    expect(pending.counts()).toEqual({ arrivals: 0, successes: 0 });
    await click(confirmed.leave);
    await settle(() => pending.router.state.location.pathname === '/inbox');
    expect(pending.counts()).toEqual({ arrivals: 1, successes: 0 });
    expect(pending.cancels).toEqual([]);

    const active = await mount('reply', true);
    await click(button(host, m.thread_write_send()));
    await settle(() => active.commands.length === 1);
    const activePrompt = await openDialog(active.origin, m.thread_authoring_leave_pending());
    expect(active.counts()).toEqual({ arrivals: 0, successes: 0 });
    await click(activePrompt.leave);
    await settle(() => active.router.state.location.pathname === '/inbox');
    await act(async () => active.resolve({ ok: false, reason: 'unavailable' }));
    expect(active.counts()).toEqual({ arrivals: 1, successes: 0 });
    expect(active.commands).toHaveLength(1);
    expect(host.querySelector('[role="textbox"]')).toBeNull();

    // A pending inline edit retains its own recovery and exact revision until deliberate discard.
    const uncertainEdit = await mount('edit');
    const currentPanel = host.querySelector<HTMLElement>('[data-editor="0"]')!;
    await click(button(currentPanel, m.thread_edit_save()));
    await settle(
      () =>
        uncertainEdit.commands.length === 1 && currentPanel.textContent?.includes(m.thread_edit_unavailable()) === true,
    );
    const editCancel = button(currentPanel, m.thread_edit_cancel());
    const editPrompt = await openDialog(editCancel, m.thread_authoring_discard_pending(), true);
    await stayAndRestore(editPrompt.stay, editCancel);
    expect(uncertainEdit.commands[0]).toEqual(expect.objectContaining({ revisionId: 'revision-1', mediaIds: [] }));
    expect(uncertainEdit.cancels).toEqual([]);
    expect(currentPanel.textContent).toContain(addition.trim());
    const confirmedEdit = await openDialog(editCancel, m.thread_authoring_discard_pending(), true);
    await click(confirmedEdit.leave);
    await settle(() => currentPanel.textContent === 'Editor closed');
    expect(uncertainEdit.cancels).toEqual([0]);
    expect(uncertainEdit.commands).toHaveLength(1);
    expect(uncertainEdit.counts()).toEqual({ arrivals: 0, successes: 0 });
    expect(host.querySelector('[data-editor="1"]')?.textContent).toContain(addition.trim());

    // Cancel the route request first; session retirement must not initiate a new navigation.
    // Private title, body, recovery and native guard all retire with the pending submission.
    const expired = await mount('opening', true);
    await click(button(host, m.thread_write_send()));
    await settle(() => expired.commands.length === 1);
    const expiryPrompt = await openDialog(expired.origin, m.thread_authoring_leave_pending());
    await stayAndRestore(expiryPrompt.stay, expired.origin);
    await act(async () => client.setQueryData(sessionQuery.queryKey, { ...owner, csrfToken: 'replacement-session' }));
    await settle(() => host.textContent?.includes(m.thread_authoring_session_changed()) === true && dialog() === null);
    expect(host.innerHTML).not.toContain(localTitle);
    expect(host.innerHTML).not.toContain('A long opening post');
    expect(host.querySelector('[role="textbox"]')).toBeNull();
    expect(blocked()).toBe(false);
    const reload = spyOn(window.location, 'reload').mockImplementation(() => undefined);
    try {
      await click(button(host, m.settings_reload()));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      reload.mockRestore();
    }
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, owner);
      expired.resolve({ ok: false, reason: 'unavailable' });
    });
    expect(host.innerHTML).not.toContain(localTitle);
    expect(expired.counts()).toEqual({ arrivals: 0, successes: 0 });
    expect(expired.commands).toHaveLength(1);

    const unmounted = await mount('reply');
    await click(button(host, 'Hide authoring page'));
    expect(blocked()).toBe(false);
    expect(dialog()).toBeNull();
    expect(unmounted.counts()).toEqual({ arrivals: 0, successes: 0 });
    expect(unmounted.commands).toEqual([]);
    const signingOut = await mount('opening');
    await act(async () =>
      host
        .querySelector('form[action="/auth/sign-out"]')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(blocked()).toBe(false);
    expect(dialog()).toBeNull();
    expect(signingOut.counts()).toEqual({ arrivals: 0, successes: 0 });
    expect(requests).toEqual([]);

    const story = await import('../src/stories/patterns/edition-publication/edition-publication-fixtures');
    const fixture = await story.publicationFixture('draft');
    const events: string[] = [];
    const retire = fixture.controller.retire;
    fixture.controller.retire = () => {
      events.push('retire');
      retire();
    };
    const command = fixture.api.command;
    let resolvePublish!: (result: Awaited<ReturnType<typeof fixture.api.command>>) => void;
    const pendingPublish = new Promise<Awaited<ReturnType<typeof fixture.api.command>>>((resolve) => {
      resolvePublish = resolve;
    });
    fixture.api.command = (intent) => {
      if (intent.kind === 'publish') return pendingPublish;
      return command(intent);
    };
    const page = await mount('edition', false, { controller: fixture.controller, events });
    const controller = fixture.controller;
    const draft = controller.snapshot().edition!;
    const openPublicationLeave = (origin: HTMLElement) =>
      openDialog(origin, m.edition_publication_leave_pending(), false, m.edition_publication_leave_title());
    expect(blocked()).toBe(false); // A persisted draft alone is browsing state.
    await click(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    await click(button(host, m.edition_publication_publish()));
    await settle(() => !!controller.snapshot().intent);
    const intent = structuredClone(controller.snapshot().intent);
    const stay = await openPublicationLeave(page.origin);
    await stayAndRestore(stay.stay, page.origin);
    expect(controller.snapshot()).toMatchObject({
      identity: story.identity,
      targetSubjectId: story.subjectId,
      edition: { editionRevision: draft.editionRevision },
      intent,
    });
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
    const leave = await openPublicationLeave(page.origin);
    await click(leave.leave);
    await settle(() => page.router.state.location.pathname === '/inbox');
    expect(events.indexOf('retire')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('read')).toBeGreaterThan(events.indexOf('retire'));
    const retired = controller.snapshot();
    await act(async () => {
      resolvePublish({
        kind: 'confirmed',
        edition: { ...draft, state: 'published', editionRevision: '2' },
      });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(controller.snapshot()).toEqual(retired);
    expect(page.router.state.location.pathname).toBe('/inbox');
    expect(host.textContent).toContain('Inbox destination');
    expect(host.textContent).not.toContain(m.edition_publication_published_heading());
  } finally {
    await act(async () => root.unmount());
    client.clear();
    setLocale(originalLocale, { reload: false });
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 60_000);
