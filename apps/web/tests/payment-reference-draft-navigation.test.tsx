import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useRef, useState } from 'react';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/statement' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLAnchorElement: window.HTMLAnchorElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  matchMedia: window.matchMedia.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: () => {},
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
function installWindow() {
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
installWindow();

const { eventElement, hasUnsentPaymentReference, PaymentReferenceDraftNavigation, sameOriginDocumentDestination } =
  await import('../src/checkout/payment-reference-draft-navigation');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider } =
  await import('@tanstack/react-router');

test('ordinary same-origin document links keep native click meanings', () => {
  const destination = (href: string, options: { target?: string; download?: boolean; ctrlKey?: boolean } = {}) => {
    const anchor = window.document.createElement('a');
    anchor.href = href;
    if (options.target) anchor.target = options.target;
    if (options.download) anchor.setAttribute('download', '');
    const event = new window.MouseEvent('click', { button: 0, bubbles: true, cancelable: true, ...options });
    return sameOriginDocumentDestination(anchor, event, window.location.href);
  };

  expect(destination('/statement')).toBe('https://site.test/statement');
  expect(destination('/next')).toBe('https://site.test/next');
  expect(destination('/statement#lines')).toBeNull();
  expect(destination('/next', { target: '_blank' })).toBeNull();
  expect(destination('/next', { download: true })).toBeNull();
  expect(destination('https://other.test/next')).toBeNull();
  expect(destination('/next', { ctrlKey: true })).toBeNull();

  const text = window.document.createTextNode('Refresh');
  expect(eventElement(text)).toBeNull();
  const label = window.document.createElement('span');
  label.append(text);
  expect(eventElement(text)).toBe(label);
  expect(eventElement(label)).toBe(label);
  expect(eventElement({ nodeType: 1, closest: label.closest.bind(label) } as unknown as EventTarget)).toBeDefined();
});

test('unsent references warn on departure, Stay preserves text and focus, and discard does not submit', async () => {
  expect(hasUnsentPaymentReference('', false)).toBe(false);
  expect(hasUnsentPaymentReference(' \n ', false)).toBe(false);
  expect(hasUnsentPaymentReference('  Bank/Exact é  ', false)).toBe(true);
  expect(hasUnsentPaymentReference('  Bank/Exact é  ', true)).toBe(false);

  let current = true;
  let captured = false;
  let submissions = 0;
  let refresh!: () => void;
  let retire!: () => void;
  function Fixture() {
    const [reference, setReference] = useState('');
    const [, update] = useState(0);
    const field = useRef<HTMLInputElement>(null);
    refresh = () => update((value) => value + 1);
    retire = () => {
      current = false;
      update((value) => value + 1);
    };
    return (
      <>
        {current ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submissions++;
            }}
          >
            <input ref={field} value={reference} onChange={(event) => setReference(event.target.value)} />
            <button type="submit">Record</button>
          </form>
        ) : null}
        <button type="button" onClick={refresh}>
          Refresh evidence
        </button>
        <Link to="/next">Next page</Link>
        <PaymentReferenceDraftNavigation
          active={hasUnsentPaymentReference(reference, captured)}
          isCurrent={() => current}
          focus={() => field.current}
        />
      </>
    );
  }
  const rootRoute = createRootRoute({ component: Outlet });
  const statementRoute = createRoute({ getParentRoute: () => rootRoute, path: '/statement', component: Fixture });
  const nextRoute = createRoute({ getParentRoute: () => rootRoute, path: '/next', component: () => 'Next page' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([statementRoute, nextRoute]),
    history: createMemoryHistory({ initialEntries: ['/statement'] }),
  });
  installWindow();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const input = () => host.querySelector('input') as HTMLInputElement | null;
  const nextLink = () => host.querySelector<HTMLAnchorElement>('a[href="/next"]')!;
  const dialog = () => document.querySelector('[role="alertdialog"]');
  const settle = async (ready: () => boolean) => {
    for (let count = 0; count < 100 && !ready(); count++)
      await act(async () => {
        await window.happyDOM.waitUntilComplete();
        await Bun.sleep(10);
      });
    expect(ready()).toBe(true);
  };
  const button = (label: string, within: ParentNode = dialog() ?? window.document) =>
    [...within.querySelectorAll('button')].find((item) => item.textContent === label)!;
  const assigned: string[] = [];
  const assignDescriptor = Object.getOwnPropertyDescriptor(window.location, 'assign');
  Object.defineProperty(window.location, 'assign', {
    configurable: true,
    writable: true,
    value: (destination: string | URL) => assigned.push(String(destination)),
  });
  const unload = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const edit = async (value: string) => {
    const field = input()!;
    await act(async () => {
      field.focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  try {
    await act(async () => {
      await router.load();
      root.render(createElement(RouterProvider, { router }));
    });
    expect(unload()).toBe(false);
    await edit('  Bank/Exact é  ');
    expect(unload()).toBe(true);
    await act(async () => button('Refresh evidence', host).click());
    expect(input()!.value).toBe('  Bank/Exact é  ');
    await act(async () => void router.navigate({ href: '/next' }));
    await settle(() => !!dialog());
    expect(dialog()?.textContent).toContain(m.payment_reference_draft_navigation_title());
    await act(async () => button(m.payment_reference_draft_navigation_stay()).click());
    expect(router.state.location.pathname).toBe('/statement');
    expect(input()!.value).toBe('  Bank/Exact é  ');
    expect(window.document.activeElement).toBe(input());
    await edit('');
    expect(unload()).toBe(false);
    await edit('  Bank/Exact é  ');
    await act(async () => nextLink().click());
    await settle(() => !!dialog());
    await act(async () => button(m.payment_reference_draft_navigation_discard()).click());
    expect(assigned).toEqual(['https://site.test/next']);
    expect(router.state.location.pathname).toBe('/statement');
    expect(submissions).toBe(0);

    current = true;
    captured = false;
    await act(async () => void router.navigate({ href: '/statement' }));
    await edit('Retiring reference');
    await act(async () => void router.navigate({ href: '/next' }));
    await settle(() => !!dialog());
    await act(async () => retire());
    expect(router.state.location.pathname).toBe('/next');
    expect(dialog()).toBeNull();
    expect(input()).toBeNull();
    expect(unload()).toBe(false);
    expect(submissions).toBe(0);
  } finally {
    if (assignDescriptor) Object.defineProperty(window.location, 'assign', assignDescriptor);
    else Reflect.deleteProperty(window.location, 'assign');
    await act(async () => root.unmount());
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
