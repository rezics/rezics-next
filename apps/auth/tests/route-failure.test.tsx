import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';

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

test('missing pages keep the document shell, focus recovery, use fixed exits and stay localized in all launch locales', async () => {
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    overwriteGetLocale(() => locale);
    const { router } = makeRouter('/missing?authorization_code=private-code&email=private@example.test');
    const page = await mount(router);
    try {
      const heading = page.host.querySelector('h1');
      expect(heading?.textContent).toBe(m.auth_route_missing_title());
      expect(heading?.getAttribute('tabindex')).toBe('-1');
      expect(document.documentElement.getAttribute('lang')).toBe(locale);
      expect(page.host.querySelector('a[href="/login"]')?.textContent).toBe(m.auth_route_failure_exit_login());
      expect(page.host.querySelector('a[href="/security"]')?.textContent).toBe(m.auth_route_failure_exit_security());
      expect(page.host.textContent).not.toContain('private-code');
      expect(page.host.textContent).not.toContain('private@example.test');
      if (locale === 'en') expect(document.activeElement).toBe(heading);
    } finally {
      await page.close();
    }
  }
});

test('a read loader can recover, fail again visibly, then recover on a deliberate retry', async () => {
  let reads = 0;
  const read = createRoute({
    getParentRoute: () => authRoot,
    path: '/read',
    loader: () => {
      reads += 1;
      if (reads < 3) throw new Error('authorization_code=private-code');
      return 'ready';
    },
    component: () => <p>Fresh page</p>,
  });
  const { router } = makeRouter('/read?return_to=https%3A%2F%2Fprivate.test', [read]);
  const page = await mount(router);
  try {
    expect(page.host.querySelector('h1')?.textContent).toBe(m.auth_route_failure_title());
    expect(page.host.documentElement?.textContent).not.toContain('private-code');
    expect(page.host.documentElement?.textContent).not.toContain('private.test');
    await act(async () => page.host.querySelector('button')!.click());
    await act(async () => waitForText(page.host, m.auth_route_failure_failed_title()));
    expect(reads).toBe(2);
    expect(page.host.documentElement?.textContent).toContain(m.auth_route_failure_retry_failed());
    await act(async () => page.host.querySelector('button')!.click());
    await act(async () => waitForText(page.host, 'Fresh page'));
    expect(reads).toBe(3);
  } finally {
    await page.close();
  }
});

test('a render failure can recover without invoking a command', async () => {
  const pageRoute = createRoute({
    getParentRoute: () => authRoot,
    path: '/render',
    component: function RenderPage() {
      const [failed, setFailed] = useState(false);
      if (failed) throw new Error('private render failure');
      return <button onClick={() => setFailed(true)}>Trigger render failure</button>;
    },
  });
  const { router } = makeRouter('/render', [pageRoute]);
  const page = await mount(router);
  try {
    await act(async () => page.host.querySelector('button')!.click());
    expect(page.host.querySelector('h1')?.textContent).toBe(m.auth_route_failure_title());
    await act(async () => page.host.querySelector('button')!.click());
    await act(async () => waitForText(page.host, 'Trigger render failure'));
  } finally {
    await page.close();
  }
});

test('Retry never repeats a command already dispatched by the failed page', async () => {
  let commands = 0;
  const command = createRoute({
    getParentRoute: () => authRoot,
    path: '/command',
    component: function CommandPage() {
      const [sent, setSent] = useState(false);
      if (sent) throw new Error('private authorization result');
      return (
        <button
          onClick={() => {
            commands += 1;
            setSent(true);
          }}
        >
          Approve once
        </button>
      );
    },
  });
  const { router } = makeRouter('/command', [command]);
  const page = await mount(router);
  try {
    await act(async () => page.host.querySelector('button')!.click());
    expect(page.host.querySelector('h1')?.textContent).toBe(m.auth_route_failure_title());
    await act(async () => page.host.querySelector('button')!.click());
    await act(async () => waitForText(page.host, 'Approve once'));
    expect(commands).toBe(1);
    expect(page.host.documentElement?.textContent).not.toContain('private authorization result');
    expect(page.host.documentElement?.textContent).not.toContain('refused');
    expect(page.host.documentElement?.textContent).not.toContain('signed out');
  } finally {
    await page.close();
  }
});

test('pending retries are single-flight and stale route results do not replace the next page', async () => {
  let reads = 0;
  let release!: () => void;
  const read = createRoute({
    getParentRoute: () => authRoot,
    path: '/pending',
    loader: async () => {
      reads += 1;
      if (reads === 1) throw new Error('private read failure');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'done';
    },
    component: () => <p>Old page</p>,
  });
  const replacement = createRoute({
    getParentRoute: () => authRoot,
    path: '/replacement',
    component: () => <p>Replacement page</p>,
  });
  const { router, history } = makeRouter('/pending', [read, replacement]);
  const page = await mount(router);
  try {
    await act(async () => page.host.querySelector('button')!.click());
    expect(page.host.querySelector('button')?.hasAttribute('disabled')).toBe(true);
    expect(page.host.documentElement?.textContent).toContain(m.auth_route_failure_retrying());
    await act(async () => page.host.querySelector('button')!.click());
    expect(reads).toBe(2);
    await act(async () => {
      history.push('/replacement?account=replaced');
      await router.load();
    });
    release();
    await act(async () => waitForText(page.host, 'Replacement page'));
    expect(page.host.textContent).not.toContain(m.auth_route_failure_retry_failed());
  } finally {
    await page.close();
  }
});

test('back and forward restore the current matched page around a missing route', async () => {
  const known = createRoute({
    getParentRoute: () => authRoot,
    path: '/known',
    component: () => <p>Known page</p>,
  });
  const { router, history } = makeRouter('/unknown', [known]);
  const page = await mount(router);
  try {
    expect(page.host.querySelector('h1')?.textContent).toBe(m.auth_route_missing_title());
    await act(async () => router.navigate({ to: '/known' } as never));
    await act(async () => waitForText(page.host, 'Known page'));
    await act(async () => {
      history.back();
      await waitForText(page.host, m.auth_route_missing_title());
    });
    await act(async () => {
      history.forward();
      await waitForText(page.host, 'Known page');
    });
  } finally {
    await page.close();
  }
});

test('unmount fences a pending recovery result', async () => {
  let reads = 0;
  let release!: () => void;
  const read = createRoute({
    getParentRoute: () => authRoot,
    path: '/unmount',
    loader: async () => {
      reads += 1;
      if (reads === 1) throw new Error('read failed');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return 'done';
    },
    component: () => <p>Recovered</p>,
  });
  const { router } = makeRouter('/unmount', [read]);
  const page = await mount(router);
  await act(async () => page.host.querySelector('button')!.click());
  expect(reads).toBe(2);
  await page.close();
  release();
});
