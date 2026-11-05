import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';

test('Progress drafts share one Stay/Discard choice and preserve the exact note on Stay', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/progress' });
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

  const { PublicationNoteDraftNavigation, hasMeaningfulPublicationNote, usePublicationNoteDraftNavigation } =
    await import('../src/library/publication-note-draft-navigation');
  const { m } = await import('../src/paraglide/messages.js');
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const identities = { note: {}, progress: {} };
  const discarded: { note?: string; progress?: string } = {};

  function Page() {
    const [note, setNote] = useState('');
    const [progress, setProgress] = useState('');
    const [locked, setLocked] = useState(false);
    usePublicationNoteDraftNavigation({
      identity: identities.note,
      state: { active: true, dirty: hasMeaningfulPublicationNote(note), locked },
      getState: () => ({ active: true, dirty: hasMeaningfulPublicationNote(note), locked }),
      discard: () => {
        discarded.note = note;
        setNote('');
      },
    });
    usePublicationNoteDraftNavigation({
      identity: identities.progress,
      state: { active: true, dirty: progress.length > 0, locked: false },
      getState: () => ({ active: true, dirty: progress.length > 0, locked: false }),
      discard: () => {
        discarded.progress = progress;
        setProgress('');
      },
    });
    return createElement(
      'main',
      null,
      createElement('textarea', {
        id: 'note',
        maxLength: 1000,
        value: note,
        onChange: (event: { target: HTMLTextAreaElement }) => setNote(event.target.value),
      }),
      createElement('input', {
        id: 'progress',
        value: progress,
        onChange: (event: { target: HTMLInputElement }) => setProgress(event.target.value),
      }),
      createElement(
        'button',
        { id: 'toggle-lock', type: 'button', onClick: () => setLocked((value) => !value) },
        'Lock',
      ),
    );
  }

  const rootRoute = createRootRoute({
    component: () => createElement(PublicationNoteDraftNavigation, null, createElement(Outlet)),
  });
  const pageRoute = createRoute({ getParentRoute: () => rootRoute, path: '/progress', component: Page });
  const awayRoute = createRoute({ getParentRoute: () => rootRoute, path: '/away', component: () => 'Away' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute, awayRoute]),
    history: createMemoryHistory({ initialEntries: ['/progress'] }),
  });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const settle = async (ready: () => boolean) => {
    for (let count = 0; count < 100 && !ready(); count++)
      await act(async () => {
        await Bun.sleep(10);
      });
    expect(ready()).toBe(true);
  };
  const field = (id: string) => window.document.getElementById(id)!;
  const dialog = () => window.document.querySelector('[role="alertdialog"]');
  const clickChoice = async (label: string) => {
    await act(async () => {
      const button = [...dialog()!.querySelectorAll('button')].find((item) => item.textContent === label)!;
      button.click();
    });
  };
  const edit = async (id: string, value: string) => {
    await act(async () => {
      const input = field(id) as HTMLInputElement | HTMLTextAreaElement;
      input.focus();
      const prototype = id === 'note' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const unload = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const navigateAway = async () => {
    await act(async () => {
      void router.navigate({ href: '/away' });
    });
    await settle(() => !!dialog());
  };

  try {
    await act(async () => {
      await router.load();
      root.render(createElement(RouterProvider, { router }));
    });
    await settle(() => !!field('note'));
    expect(hasMeaningfulPublicationNote(' \n  ')).toBe(false);
    expect(unload()).toBe(false);
    await edit('note', ' \n ');
    expect(unload()).toBe(false);
    const note = ['  ', 'x'.repeat(996), ' \n'].join('');
    await edit('note', note);
    expect(unload()).toBe(true);
    await navigateAway();
    expect(window.document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    await clickChoice(m.library_publication_note_draft_navigation_stay());
    expect(router.state.location.pathname).toBe('/progress');
    expect((field('note') as HTMLTextAreaElement).value).toBe(note);
    await settle(() => window.document.activeElement === field('note'));

    await edit('note', '');
    expect(unload()).toBe(false);
    await edit('note', note);
    await act(async () => field('toggle-lock').dispatchEvent(new window.Event('click', { bubbles: true })));
    await navigateAway();
    expect(dialog()!.textContent).toContain(m.library_publication_note_draft_navigation_pending());
    expect([...dialog()!.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      m.library_publication_note_draft_navigation_stay(),
    ]);
    await clickChoice(m.library_publication_note_draft_navigation_stay());
    await act(async () => field('toggle-lock').dispatchEvent(new window.Event('click', { bubbles: true })));
    await edit('progress', 'chapter 4');
    await navigateAway();
    await clickChoice(m.library_publication_note_draft_navigation_discard());
    await settle(() => router.state.location.pathname === '/away');
    expect(discarded).toEqual({ note, progress: 'chapter 4' });
    expect(unload()).toBe(false);
  } finally {
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
