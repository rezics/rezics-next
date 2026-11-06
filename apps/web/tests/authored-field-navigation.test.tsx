import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useEffect, useState } from 'react';
import * as routerApi from '@tanstack/react-router';
import { fromPlainText } from '@rezics/document';
import type { AuthoredDraft } from '../src/features/catalogue/authored-field-state';
import { authoredFieldNavigationState } from '../src/features/catalogue/authored-field-navigation';

function draft(change: Partial<AuthoredDraft> = {}): AuthoredDraft {
  return { document: fromPlainText('').snapshot, language: '', licence: '', citation: '', original: false, ...change };
}

test('retained fields, reversions, confirmed proposals and pending commands set the correct protection', () => {
  const clean = draft();
  const retained = draft({ document: fromPlainText('Original text').snapshot, citation: 'source' });
  expect(authoredFieldNavigationState({ active: clean, retained }, false, false).protect).toBe(true);
  for (const field of [{ language: 'en' }, { licence: 'CC0-1.0' }, { citation: 'source' }, { original: true }])
    expect(authoredFieldNavigationState({ active: draft(field) }, false, false).protect).toBe(true);
  expect(authoredFieldNavigationState({ active: draft({ citation: '  ' }) }, false, false).protect).toBe(false);
  expect(authoredFieldNavigationState({ active: retained }, false, true).protect).toBe(false);
  expect(authoredFieldNavigationState({ active: clean }, true, false).protect).toBe(true);
});

test('same-tab and browser-back departures can stay with every retained field or proceed once', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/authored', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    // Router scroll restoration calls the bare global; these assertions do not depend on scroll position.
    scrollTo: () => undefined,
    Text: window.Text,
    NodeFilter: window.NodeFilter,
    DocumentFragment: window.DocumentFragment,
    DOMParser: window.DOMParser,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Range: window.Range,
    DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const storybook = dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const { AuthoredFieldNavigation } = await import('../src/features/catalogue/authored-field-navigation');
  const { m } = await import('../src/paraglide/messages.js');
  const drafts = {
    first: draft({
      document: fromPlainText('First original').snapshot,
      language: 'en',
      licence: 'CC0-1.0',
      citation: 'source 1',
      original: true,
    }),
    second: draft({
      document: fromPlainText('Second original').snapshot,
      language: 'ja',
      licence: 'CC-BY-4.0',
      citation: 'source 2',
      original: true,
    }),
  };
  let visits = 0;
  function Editor() {
    const navigate = routerApi.useNavigate();
    const [pending, setPending] = useState(false);
    const [active, setActive] = useState('first');
    const [internal, setInternal] = useState('');
    return (
      <>
        <AuthoredFieldNavigation drafts={drafts} pending={pending} confirmed={false} />
        <output aria-label="drafts">{JSON.stringify(drafts)}</output>
        <output aria-label="active field">{active}</output>
        <output>{internal}</output>
        <button onClick={() => setActive('second')}>Switch property</button>
        <button onClick={() => setInternal('refreshed')}>Refresh current text</button>
        <button onClick={() => setInternal('comparison')}>Open comparison</button>
        <button onClick={() => setPending(true)}>Start proposal</button>
        <button onClick={() => navigate({ to: '/away' })}>Leave</button>
      </>
    );
  }
  function Away() {
    useEffect(() => {
      visits++;
    }, []);
    return <p>Destination</p>;
  }
  const rootRoute = routerApi.createRootRoute();
  const editorRoute = routerApi.createRoute({ getParentRoute: () => rootRoute, path: '/', component: Editor });
  const awayRoute = routerApi.createRoute({ getParentRoute: () => rootRoute, path: 'away', component: Away });
  const router = routerApi.createRouter({
    routeTree: rootRoute.addChildren([editorRoute, awayRoute]),
    history: routerApi.createMemoryHistory({ initialEntries: ['/away', '/'] }),
  });
  const host = window.document.createElement('div') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const user = userEvent.setup({ document: window.document });
  const click = async (name: string) => act(async () => user.click(within(host).getByRole('button', { name })));
  try {
    await act(async () => root.render(<routerApi.RouterProvider router={router} />));
    await click('Switch property');
    await click('Refresh current text');
    await click('Open comparison');
    expect(within(host).queryByRole('alertdialog')).toBeNull();
    await act(async () => router.history.back());
    expect(within(host).getByRole('alertdialog').textContent).toContain(m.thread_authoring_discard_unsaved());
    await click(m.thread_authoring_stay());
    expect(within(host).getByLabelText('drafts').textContent).toBe(JSON.stringify(drafts));
    expect(within(host).getByLabelText('active field').textContent).toBe('second');
    await click('Start proposal');
    await click('Leave');
    expect(within(host).getByRole('alertdialog').textContent).toContain(m.thread_authoring_discard_pending());
    const leave = within(host).getByRole('button', { name: m.thread_authoring_discard() });
    await act(async () => {
      leave.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      leave.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(within(host).getByText('Destination')).toBeTruthy();
    expect(visits).toBe(1);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
