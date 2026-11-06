import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { recoveryPage } from '../../../services/auth/src/recovery-page';
import { creationFixture, dom, flush } from './creation-page-fixture';

creationFixture();
// TanStack restores scroll after each load; the happy-dom fixture has no scroll implementation.
const previousScrollTo = Object.getOwnPropertyDescriptor(globalThis, 'scrollTo');
Object.defineProperty(globalThis, 'scrollTo', { value: () => {}, configurable: true, writable: true });
const { createBrowserHistory, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { hydrateRoot } = await import('react-dom/client');
const { Route: rootRoute } = await import('../src/routes/__root');
const { Route } = await import('../src/routes/step-up');

type DocumentElementState = { attributes: [string, string][]; html: string };
function documentElementState(element: Element): DocumentElementState {
  return {
    attributes: [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
    html: element.innerHTML,
  };
}
// Replaces the shared happy-dom <html> element, so each test starts from the document it received.
function installDocumentElement(state: DocumentElementState) {
  const root = document.documentElement;
  for (const attribute of [...root.attributes]) root.removeAttribute(attribute.name);
  for (const [name, value] of state.attributes) root.setAttribute(name, value);
  root.innerHTML = state.html;
}
const original = documentElementState(document.documentElement);
afterEach(() => installDocumentElement(original));
afterAll(() => {
  if (previousScrollTo) Object.defineProperty(globalThis, 'scrollTo', previousScrollTo);
  else Reflect.deleteProperty(globalThis, 'scrollTo');
});

// Only the step-up advice read matters here; other reads fail closed so their presentation stays out of the way.
function advice(gate: Promise<void>) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'https://auth.test').pathname;
    if (path !== '/recovery/page') return new Response('unavailable', { status: 503 });
    await gate;
    return Response.json(
      recoveryPage(JSON.parse(String(init?.body)).stage, { minPasswordLength: 8, maxPasswordLength: 128 }),
    );
  }) as typeof fetch);
}

// Installs the server document as the browser receives it, then hydrates the whole document through the real root.
async function handoff() {
  window.history.replaceState(null, '', '/step-up?return_to=%2Fsecurity');
  const route = Route.update({ id: '/step-up', path: '/step-up', getParentRoute: () => rootRoute } as never);
  const history = createBrowserHistory({ window: dom as unknown as Window });
  const router = createRouter({ routeTree: rootRoute.addChildren([route]), history });
  await flush(() => router.load());
  const serverDocument = new dom.DOMParser().parseFromString(
    renderToString(createElement(RouterProvider, { router })),
    'text/html',
  ).documentElement;
  installDocumentElement(documentElementState(serverDocument));
  const errors: string[] = [];
  let root: { unmount(): void } | undefined;
  await flush(() => {
    root = hydrateRoot(document, createElement(RouterProvider, { router }), {
      onRecoverableError: (error: unknown) => errors.push(String((error as Error)?.message ?? error)),
    });
  });
  return {
    errors,
    async close() {
      await flush(() => root?.unmount());
      history.destroy();
    },
  };
}

test('step-up confirmation stays unusable until the server advice is read after hydration', async () => {
  let release = () => {};
  const fetches = advice(new Promise<void>((resolve) => (release = resolve)));
  const mounted = await handoff();
  try {
    const submit = () => document.querySelector<HTMLButtonElement>('button[type=submit]');
    expect(submit()?.disabled).toBe(true);
    await flush(() => release());
    for (let attempt = 0; attempt < 20 && submit()?.disabled; attempt++)
      await flush(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    expect(submit()?.disabled).toBe(false);
    expect(mounted.errors).toEqual([]);
  } finally {
    await mounted.close();
    fetches.mockRestore();
  }
});
