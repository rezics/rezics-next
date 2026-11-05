import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useLayoutEffect, useRef } from 'react';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({ url: 'https://auth.test/' });
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element,
  Node: dom.Node,
  Document: dom.Document,
  DocumentFragment: dom.DocumentFragment,
  scrollTo: dom.scrollTo.bind(dom),
  MutationObserver: dom.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(
  [...Object.keys(globals)].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });

const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { Route: authRoot } = await import('../src/routes/__root');
const { RouteFailureError } = await import('../src/route-failure-view');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');

afterAll(async () => {
  overwriteGetLocale(() => 'en');
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

function makeRouter(path: string, children: unknown[] = []) {
  const history = createMemoryHistory({ initialEntries: [path] });
  const routeTree = authRoot.addChildren(children as never);
  const router = createRouter({ history, routeTree, defaultErrorComponent: RouteFailureError });
  return { history, router };
}

async function mount(router: ReturnType<typeof createRouter>) {
  const host = document;
  const root = createRoot(host, { onCaughtError: () => {} });
  await router.load();
  await act(async () => root.render(createElement(RouterProvider, { router })));
  return {
    host,
    async close() {
      await act(async () => root.unmount());
      router.history.destroy();
    },
  };
}

async function waitForText(host: Document, text: string) {
  if (host.documentElement?.textContent?.includes(text)) return;
  await new Promise<void>((resolve, reject) => {
    const observer = new dom.MutationObserver(() => {
      if (!host.documentElement?.textContent?.includes(text)) return;
      observer.disconnect();
      clearTimeout(timeout);
      resolve();
    });
    observer.observe(host, { childList: true, characterData: true, subtree: true });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timed out waiting for expected page text: ${text}`));
    }, 3000);
  });
}

function transition(type: 'pagehide' | 'pageshow') {
  window.dispatchEvent(new dom.PageTransitionEvent(type, { persisted: true }) as unknown as Event);
}

// Hold the installed invalidation's completion separately from its real read.
// This exposes callbacks after route work finishes, without a parallel controller.
function holdReads(router: ReturnType<typeof createRouter>) {
  const invalidate = router.invalidate.bind(router);
  const completions: { resolve(): void; reject(error: Error): void }[] = [];
  router.invalidate = (options) => {
    const read = invalidate(options);
    return new Promise<void>((resolve, reject) => {
      completions.push({
        resolve: () => {
          void read.then(resolve, reject);
        },
        reject,
      });
    });
  };
  return completions;
}

function recoveryFixture() {
  let broken = true;
  let reads = 0;
  let commands = 0;
  const route = createRoute({
    getParentRoute: () => authRoot,
    path: '/return',
    loader: () => {
      reads += 1;
      return null;
    },
    component: function Page() {
      const input = useRef<HTMLInputElement>(null);
      useLayoutEffect(() => {
        input.current?.focus();
      }, []);
      if (broken) throw new Error('private token, SQL and former identity');
      return (
        <main>
          <h1>Current page</h1>
          <input ref={input} aria-label="Current input" />
          <button
            onClick={() => {
              commands += 1;
            }}
          >
            Deliberate command
          </button>
        </main>
      );
    },
  });
  const replacement = createRoute({
    getParentRoute: () => authRoot,
    path: '/next',
    component: () => <h1>Next page</h1>,
  });
  const { router, history } = makeRouter('/return?token=private', [route, replacement]);
  const completions = holdReads(router);
  return {
    router,
    history,
    completions,
    repair: () => {
      broken = false;
    },
    reads: () => reads,
    commands: () => commands,
  };
}

function retry() {
  document.querySelector<HTMLButtonElement>('.auth-route-failure button')!.click();
}
function enabled() {
  expect(document.querySelector('.auth-route-failure button')?.hasAttribute('disabled')).toBe(false);
}

test('cached return retires the pending read; a late completion cannot reset or focus, and fresh Retry recovers alone', async () => {
  const f = recoveryFixture();
  const page = await mount(f.router);
  try {
    await act(async () => {
      retry();
      retry();
    });
    expect(f.completions).toHaveLength(1);
    expect(f.reads()).toBe(2);
    expect(document.querySelectorAll('.auth-route-failure [role="status"]')).toHaveLength(1);
    await act(async () => transition('pagehide'));
    enabled();
    await act(async () => transition('pageshow'));
    expect(document.documentElement.textContent).toContain(m.auth_route_failure_interrupted());
    expect(document.activeElement).toBe(document.querySelector('h1'));
    expect(f.completions).toHaveLength(1);
    const exit = document.querySelector<HTMLAnchorElement>('a[href="/security"]')!;
    exit.focus();
    f.repair();
    await act(async () => f.completions[0]!.resolve());
    expect(document.activeElement).toBe(exit);
    expect(document.documentElement.textContent).not.toContain('Current page');
    enabled();
    await act(async () => retry());
    expect(f.completions).toHaveLength(2);
    await act(async () => f.completions[1]!.resolve());
    await act(async () => waitForText(page.host, 'Current page'));
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(document.querySelector('.auth-route-failure')).toBeNull();
    expect(document.activeElement).toBe(document.querySelector('input'));
    expect(f.reads()).toBe(3);
    expect(f.commands()).toBe(0);
  } finally {
    await page.close();
  }
});

test('old rejection cannot clear a fresh read gate; failed render uses the latest mounted reset and later recovers', async () => {
  const f = recoveryFixture();
  const page = await mount(f.router);
  try {
    await act(async () => retry());
    await act(async () => {
      transition('pagehide');
      transition('pageshow');
    });
    await act(async () => retry());
    await act(async () => f.completions[0]!.reject(new Error('private old failure')));
    expect(document.querySelector('.auth-route-failure button')?.hasAttribute('disabled')).toBe(true);
    await act(async () => retry());
    expect(f.completions).toHaveLength(2);
    await act(async () => f.completions[1]!.resolve());
    await act(async () => waitForText(page.host, m.auth_route_failure_failed_title()));
    enabled();
    expect(document.documentElement.textContent).not.toContain('private');
    f.repair();
    await act(async () => retry());
    await act(async () => f.completions[2]!.resolve());
    await act(async () => waitForText(page.host, 'Current page'));
    expect(document.querySelector('.auth-route-failure')).toBeNull();
    expect(f.commands()).toBe(0);
  } finally {
    await page.close();
  }
});

test('navigation after suspension owns the page even when a retired invalidation rejects', async () => {
  const f = recoveryFixture();
  const page = await mount(f.router);
  try {
    await act(async () => retry());
    await act(async () => transition('pagehide'));
    await act(async () => {
      f.history.replace('/next');
      await f.router.load();
      transition('pageshow');
    });
    await act(async () => f.completions[0]!.reject(new Error('late private failure')));
    expect(document.querySelector('h1')?.textContent).toBe('Next page');
    expect(document.querySelector('.auth-route-failure')).toBeNull();
    expect(f.completions).toHaveLength(1);
    expect(f.commands()).toBe(0);
  } finally {
    await page.close();
  }
});

test('missing Retry stays missing, and cached return and presentation add zero automatic route reads', async () => {
  const { router } = makeRouter('/missing?return_to=https://private.test');
  const completions = holdReads(router);
  const page = await mount(router);
  try {
    await act(async () => retry());
    await act(async () => completions[0]!.resolve());
    expect(document.querySelector('h1')?.textContent).toBe(m.auth_route_missing_title());
    expect(document.documentElement.textContent).toContain(m.auth_route_failure_retry_failed());
    enabled();
    await act(async () => retry());
    await act(async () => {
      transition('pagehide');
      transition('pageshow');
    });
    await act(async () => completions[1]!.resolve());
    expect(document.querySelector('h1')?.textContent).toBe(m.auth_route_missing_title());
    expect(completions).toHaveLength(2);
    expect(document.documentElement.textContent).not.toContain('private.test');
    expect(document.querySelector('a[href="/login"]')).not.toBeNull();
    expect(document.querySelector('a[href="/security"]')).not.toBeNull();
    enabled();
  } finally {
    await page.close();
  }
});
