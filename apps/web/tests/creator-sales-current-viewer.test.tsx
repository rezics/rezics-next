import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type { CreatorSalesCurrentRead } from '../src/checkout/creator-sales';
import { creatorSaleFixture } from '../src/kernel/fake/creator-sales';
// creator sales cache/DOM regressions for integration. These use the actual session QueryClient,
// viewerExposureLifetime and subject-scoped admission, without native or browser acceptance claims.
mock.module('@tanstack/react-start', () => ({
  ...start,
  createIsomorphicFn() {
    let server: (...args: unknown[]) => unknown = () => undefined;
    const chain = {
      server(handler: typeof server) {
        server = handler;
        return chain;
      },
      client(handler: typeof server) {
        return (...args: unknown[]) => (typeof window === 'undefined' ? server : handler)(...args);
      },
    };
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test/en'),
  setResponseHeader() {},
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/creator/sales' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { sessionQuery } = await import('../src/session/query');

const reads = await import('../src/checkout/creator-sales');
const { CreatorSalesCurrent } = await import('../src/checkout/creator-sales-current');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
const A = '019a2100-0000-7000-8000-000000000020';
const B = '019a2100-0000-7000-8000-000000000021';
function page(subject = A, cursor: string | null = null): CreatorSalesCurrentRead {
  return {
    sessionSubject: subject,
    requested: { cursor },
    selling: true,
    page: {
      kind: 'ready',
      sales: [{ ...creatorSaleFixture, title: `Private sale ${subject}` }],
      next: `next-${subject}+/=`,
      projectionState: 'preparing',
    },
  };
}
function deferred() {
  let resolve!: (value: CreatorSalesCurrentRead) => void;
  const promise = new Promise<CreatorSalesCurrentRead>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('sales retires late viewer, admission and address ABA results, retains accepted healthy rotation and never certifies a foreign empty page', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const lifetime = viewerExposureLifetime(client);
  const keep = lifetime.subscribe(() => {});
  const session = (subject = A, csrfToken = 'csrf-A') =>
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject, csrfToken });
  const admit = (admitted = ['selling', 'commerce_sale.list']) => {
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('Expected real viewer observation');
    client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
      subject: snapshot.observation.subject,
      admitted,
    });
  };
  session();
  admit();
  const pending: ReturnType<typeof deferred>[] = [];
  const read = spyOn(reads, 'readCreatorSalesCurrent').mockImplementation(() => {
    const work = deferred();
    pending.push(work);
    return work.promise;
  });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/creator/sales'] }),
  });
  let cursor: string | undefined;
  const tree = () => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          <CreatorSalesCurrent initial={page()} locale="en" cursor={cursor} />
        </RouterContextProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const show = () =>
    act(async () => {
      root.render(tree());
    });
  const tick = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const settle = async (work: ReturnType<typeof deferred>, value: CreatorSalesCurrentRead) => {
    await act(async () => work.resolve(value));
    await tick();
  };
  try {
    await show();
    await tick();
    expect(host.textContent).toContain(`Private sale ${A}`);
    expect(pending).toHaveLength(0);
    const oldQuery = client
      .getQueryCache()
      .findAll({ queryKey: ['creator-sales-current'] })
      .at(-1)!;
    let oldRefresh!: Promise<unknown>;
    await act(async () => {
      oldRefresh = oldQuery.fetch();
    });
    await tick();
    const stale = pending.at(-1)!;
    expect(pending).toHaveLength(1);
    await act(async () => {
      session(A, 'healthy-rotation');
      admit();
      stale.resolve(page(A));
      await Promise.resolve();
    });
    await tick();
    expect(host.textContent).toContain(`Private sale ${A}`);
    expect(pending).toHaveLength(2);
    const renewed = pending.at(-1)!;
    expect(renewed).not.toBe(stale);
    await oldRefresh;
    await settle(renewed, page(A));
    expect(host.textContent).toContain(`Private sale ${A}`);
    cursor = 'second+/=';
    await show();
    await tick();
    const oldA = pending.at(-1)!;
    await act(async () => {
      session(B, 'csrf-B');
      admit();
      session(A, 'csrf-return');
      admit();
      // Resolving before React commits the ABA cannot authorize the retired response.
      oldA.resolve(page(A, cursor!));
    });
    await tick();
    expect(host.textContent).not.toContain(`Private sale ${A}`);
    expect(pending.at(-1)).not.toBe(oldA);
    await settle(pending.at(-1)!, page(A, cursor));
    expect(host.textContent).toContain(`Private sale ${A}`);
    await act(async () => {
      session(B, 'csrf-B');
      admit();
    });
    await tick();
    expect(host.textContent).not.toContain(`Private sale ${A}`);
    await settle(pending.at(-1)!, page(B, cursor));
    expect(host.textContent).toContain(`Private sale ${B}`);
    await act(async () => {
      admit([]);
      admit();
    });
    await tick();
    expect(host.textContent).not.toContain(`Private sale ${B}`);
    const emptyForeign = page(A, cursor);
    emptyForeign.page = { kind: 'ready', sales: [], next: null, projectionState: 'ready' };
    await settle(pending.at(-1)!, emptyForeign);
    expect(host.textContent).not.toContain('No sales');
    cursor = 'third+/=';
    await show();
    await tick();
    const third = pending.at(-1)!;
    cursor = 'second+/=';
    await show();
    await tick();
    const returning = pending.at(-1)!;
    await settle(third, page(B, 'third+/='));
    expect(host.textContent).not.toContain(`Private sale ${B}`);
    await settle(returning, page(B, 'second+/='));
    expect(host.textContent).toContain(`Private sale ${B}`);
    expect(host.innerHTML).toContain(encodeURIComponent(`next-${B}+/=`));
    await act(async () =>
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null }),
    );
    await tick();
    expect(host.textContent).not.toContain(`Private sale ${B}`);
    expect(host.innerHTML).not.toContain(encodeURIComponent(`next-${B}+/=`));
  } finally {
    await act(async () => root.unmount());
    keep();
    client.clear();
    read.mockRestore();
    host.remove();
  }
});
