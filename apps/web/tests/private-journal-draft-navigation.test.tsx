import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState } from 'react';
import { emptyJournalDraft, type JournalDraft } from '@rezics/progress';

test('journal Stay/Leave owns links, history and unload with one Progress decision', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/journal' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    matchMedia: window.matchMedia.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { PrivateJournalDraftNavigation, usePrivateJournalDraftNavigation } =
    await import('../src/library/private-diary/draft-navigation');
  const { PublicationNoteDraftNavigation, usePublicationNoteDraftNavigation } =
    await import('../src/library/publication-note-draft-navigation');
  const { m } = await import('../src/paraglide/messages.js');
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, Link } =
    await import('@tanstack/react-router');
  let reset!: () => void;
  let replace!: () => void;
  let discarded: JournalDraft | null = null;
  let otherDiscarded = false;
  function Journal() {
    const [identity, setIdentity] = useState({});
    const [draft, setDraft] = useState(emptyJournalDraft);
    const [other, setOther] = useState(false);
    reset = () => {
      setDraft(emptyJournalDraft());
    };
    replace = () => {
      reset();
      setIdentity({});
    };
    usePrivateJournalDraftNavigation({
      identity,
      draft,
      command: null,
      isCurrent: () => true,
      discard: () => {
        discarded = draft;
        setDraft(emptyJournalDraft());
      },
    });
    usePublicationNoteDraftNavigation({
      identity,
      state: { active: true, dirty: other, locked: false },
      discard: () => {
        otherDiscarded = true;
        setOther(false);
      },
    });
    return (
      <>
        <textarea
          value={draft.reflection.kind === 'set' ? draft.reflection.text : ''}
          onChange={(event) => setDraft({ ...draft, reflection: { kind: 'set', text: event.target.value } })}
        />
        <button onClick={() => setDraft({ ...draft, assessment: { kind: 'clear' } })}>Clear only</button>
        <button onClick={() => setOther(true)}>Other draft</button>
        <Link to="/away">Elsewhere</Link>
      </>
    );
  }
  const base = createRootRoute({
    component: () => (
      <PublicationNoteDraftNavigation messages="progress">
        <Outlet />
      </PublicationNoteDraftNavigation>
    ),
  });
  const journal = createRoute({
    getParentRoute: () => base,
    path: '/journal',
    component: () => (
      <PrivateJournalDraftNavigation>
        <Journal />
      </PrivateJournalDraftNavigation>
    ),
  });
  const away = createRoute({ getParentRoute: () => base, path: '/away', component: () => 'Away' });
  const history = createMemoryHistory({ initialEntries: ['/away', '/journal'] });
  const router = createRouter({ routeTree: base.addChildren([journal, away]), history });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const dialog = () => window.document.querySelector('[role="alertdialog"]');
  const field = () => host.querySelector('textarea')!;
  const settle = async (ready: () => boolean) => {
    for (let count = 0; count < 100 && !ready(); count++)
      await act(async () => {
        await Bun.sleep(10);
      });
    expect(ready()).toBe(true);
  };
  const click = async (label: string) => {
    await act(async () => {
      [...window.document.querySelectorAll('button,a')]
        .find((item) => item.textContent === label)!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    });
  };
  const edit = async (text: string) => {
    await act(async () => {
      field().focus();
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field(), text);
      field().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const unload = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const request = async (
    go = () => {
      void router.navigate({ href: '/away' });
    },
  ) => {
    await act(async () => {
      go();
    });
    await settle(() => !!dialog());
  };
  const stay = async () => {
    await click(m.library_progress_draft_navigation_stay());
    await settle(() => !dialog());
    expect(router.state.location.pathname).toBe('/journal');
  };
  try {
    await act(async () => {
      await router.load();
      root.render(<RouterProvider router={router} />);
    });
    await settle(() => !!field());
    expect(unload()).toBe(false);
    await click('Clear only');
    expect(unload()).toBe(true);
    await request();
    expect(dialog()!.textContent).toContain(m.library_journal_draft_navigation_description());
    await stay();
    expect(unload()).toBe(true);
    const exact = '  私人日記\n<literal>  ';
    await edit(exact);
    await request(() => history.back());
    await stay();
    expect(field().value).toBe(exact);
    await settle(() => window.document.activeElement === field());

    await request();
    await act(async () => replace());
    await settle(() => !dialog());
    expect(router.state.location.pathname).toBe('/journal');
    expect(unload()).toBe(false);
    await edit('saved draft');
    await act(async () => reset());
    expect(unload()).toBe(false);
    await act(async () => {
      await router.navigate({ href: '/away' });
    });
    expect(dialog()).toBeNull();
    await act(async () => history.back());
    await settle(() => !!field());
    await edit(exact);
    await click('Other draft');
    await click('Elsewhere');
    await settle(() => !!dialog());
    expect(window.document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(dialog()!.textContent).toContain(m.library_progress_draft_navigation_description());
    await click(m.library_journal_draft_navigation_leave());
    await settle(() => router.state.location.pathname === '/away');
    expect(discarded).toEqual({ ...emptyJournalDraft(), reflection: { kind: 'set', text: exact } });
    expect(otherDiscarded).toBe(true);
    expect(unload()).toBe(false);
    await act(async () => history.back());
    await settle(() => !!field());
    expect(field().value).toBe('');
    await edit(exact);
    await request(() => history.forward());
    await stay();
    expect(field().value).toBe(exact);
    await act(async () => reset());
    await act(async () => history.forward());
    await settle(() => router.state.location.pathname === '/away');
    expect(dialog()).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.happyDOM.abort();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
