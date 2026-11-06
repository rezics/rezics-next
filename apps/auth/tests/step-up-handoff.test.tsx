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

const loginQuery =
  'response_type=code&client_id=rezics-website&redirect_uri=https%3A%2F%2Fweb.rezics.test%2Fauth%2Fcallback' +
  '&scope=openid&state=opaque&nonce=n&code_challenge=c&code_challenge_method=S256';
const pages = [
  { path: `/login?${loginQuery}`, module: '../src/routes/login', id: '/login', heading: 'Sign in' },
  { path: '/security', module: '../src/routes/security', id: '/security', heading: 'Account security' },
  {
    path: '/step-up?return_to=%2Fsecurity',
    module: '../src/routes/step-up',
    id: '/step-up',
    heading: 'Verify your identity',
  },
];

type DocumentElementState = { attributes: [string, string][]; html: string };
function documentElementState(element: Element): DocumentElementState {
  return {
    attributes: [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
    html: element.innerHTML,
  };
}
// Replaces the shared happy-dom <html> element, so each handoff starts from the document it received.
function installDocumentElement(state: DocumentElementState) {
  const root = document.documentElement;
  for (const attribute of [...root.attributes]) root.removeAttribute(attribute.name);
  for (const [name, value] of state.attributes) root.setAttribute(name, value);
  root.innerHTML = state.html;
}
// The shared happy-dom document is restored after each handoff, so later files see the fixture's original page.
const original = documentElementState(document.documentElement);
afterEach(() => installDocumentElement(original));
afterAll(() => {
  if (previousScrollTo) Object.defineProperty(globalThis, 'scrollTo', previousScrollTo);
  else Reflect.deleteProperty(globalThis, 'scrollTo');
});

// Only the step-up advice read matters here; other reads fail closed so their presentation stays out of the way.
function advice(gate?: Promise<void>) {
  return spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'https://auth.test').pathname;
    if (path === '/recovery/page') {
      await gate;
      return Response.json(
        recoveryPage(JSON.parse(String(init?.body)).stage, { minPasswordLength: 8, maxPasswordLength: 128 }),
      );
    }
    return new Response('unavailable', { status: 503 });
  }) as typeof fetch);
}

// Installs the server document as the browser receives it, then hydrates the whole document through the real root.
async function handoff(page: (typeof pages)[number]) {
  window.history.replaceState(null, '', page.path);
  const { Route } = await import(page.module);
  const route = Route.update({ id: page.id, path: page.id, getParentRoute: () => rootRoute } as never);
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
    hydrated: document.documentElement.hasAttribute('data-hydrated'),
    heading: document.querySelector('h1')?.textContent ?? null,
    async close() {
      await flush(() => root?.unmount());
      history.destroy();
    },
  };
}

for (const page of pages) {
  test(`${page.id} hydrates from its server document without recoverable errors`, async () => {
    const fetches = advice();
    const mounted = await handoff(page);
    try {
      expect(mounted.errors).toEqual([]);
      expect(mounted.hydrated).toBe(true);
      expect(mounted.heading).toBe(page.heading);
    } finally {
      await mounted.close();
      fetches.mockRestore();
    }
  });
}

test('step-up confirmation stays unusable until the server advice is read after hydration', async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fetches = advice(gate);
  const mounted = await handoff(pages[2]!);
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
