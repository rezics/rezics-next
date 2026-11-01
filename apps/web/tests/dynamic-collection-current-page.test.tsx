import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, useLayoutEffect } from 'react';
import type { DynamicCollectionPage as Page } from '../src/library/dynamic-collection';
import type { DynamicMembersResult } from '../src/library/collection-load';
import { m } from '../src/paraglide/messages.js';

// UNRUN: mounted default-page regressions for integration, using Puck's installed DOM.
// Native preparation, disclosure and browser/visual acceptance remain controller obligations.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/collections/original' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
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
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { DynamicCollectionPage } = await import('../src/library/dynamic-collection-page');
const { libraryNavigationQuery } = await import('../src/library/pins-read');
const { sessionQuery, exposureQuery } = await import('../src/session/query');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function page(id = 'original', change: Partial<Page> = {}): Page {
  return {
    id,
    title: `Collection ${id}`,
    builtinKind: 'everything',
    description: null,
    curator: null,
    members: [],
    cursor: 'same-cursor',
    next: null,
    preparing: true,
    retryAfterMs: 1000,
    unavailable: false,
    ...change,
  };
}
const preparing = (retryAfterMs = 1000): DynamicMembersResult => ({
  members: [],
  next: null,
  preparing: true,
  retryAfterMs,
  unavailable: false,
});
const ready = (label: string, next: string | null = null): DynamicMembersResult => ({
  members: [{ subject: { id: label, type: 'book', types: ['book'], label, cover: null } }],
  next,
  preparing: false,
  retryAfterMs: 1000,
  unavailable: false,
});
const settle = (action: () => void) =>
  act(async () => {
    action();
  });
function CommitSnapshot({ observe }: { observe: () => void }) {
  // Observe the commit before passive effects could conceal a stale first render.
  useLayoutEffect(observe);
  return null;
}

async function mount() {
  const host = window.document.createElement('div') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, gcTime: Infinity } },
  });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null, subject: null });
  client.setQueryData(exposureQuery.queryKey, []);
  client.setQueryData(libraryNavigationQuery('en', 100).queryKey, { pins: { state: 'closed' }, collections: [] });
  const calls: Array<
    ReturnType<typeof deferred<DynamicMembersResult>> & {
      id: string;
      cursor: string | undefined;
      filter: string;
    }
  > = [];
  const reader = (filter: string) => (id: string, cursor?: string) => {
    const call = { ...deferred<DynamicMembersResult>(), id, cursor, filter };
    calls.push(call);
    return call.promise;
  };
  const copies: Array<ReturnType<typeof deferred<void>>> = [];
  const clipboard = spyOn(window.navigator.clipboard, 'writeText').mockImplementation(() => {
    const call = deferred<void>();
    copies.push(call);
    return call.promise;
  });
  let now = 0;
  let nextTimer = -1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((run, delay, ...args) => {
    if (typeof delay !== 'number' || delay < 1000 || delay > 30_000)
      return nativeSetTimeout(run, delay, ...args);
    const id = nextTimer--;
    timers.set(id, { at: now + delay, run: () => run(...args) });
    return id;
  }) as typeof setTimeout);
  const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((id) => {
    if (!timers.delete(Number(id))) nativeClearTimeout(id);
  }) as typeof clearTimeout);
  const commits: string[] = [];
  const render = (p: Page | null, readMembers = reader('default')) =>
    settle(() =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <RouterContextProvider router={router}>
              {p ? <DynamicCollectionPage page={p} readMembers={readMembers} search={{ type: 'schema:Book' }} /> : null}
              <CommitSnapshot
                observe={() => {
                  commits.push(host.textContent ?? '');
                }}
              />
            </RouterContextProvider>
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
  const advance = async (milliseconds = 1000) => {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      timers.delete(next[0]);
      await settle(next[1].run);
    }
    now = end;
  };
  const click = (label: string) =>
    settle(() => {
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === label,
      );
      expect(button).toBeDefined();
      button!.click();
    });
  return {
    host,
    calls,
    copies,
    reader,
    render,
    advance,
    click,
    timers,
    commits,
    async close() {
      await settle(() => root.unmount());
      client.clear();
      timerSpy.mockRestore();
      clearSpy.mockRestore();
      clipboard.mockRestore();
      host.remove();
    },
  };
}

test('An old preparing member read cannot merge into a replacement dynamic Collection page', async () => {
  for (const outcome of ['success', 'rejection'] as const) {
    const h = await mount();
    try {
      await h.render(page('A'), h.reader('filter-A'));
      await h.advance();
      const old = h.calls[0]!;
      const currentId = outcome === 'success' ? 'A' : 'B';
      await h.render(page(currentId, { title: 'Collection B' }), h.reader('filter-B'));
      expect(h.host.querySelector('h1')!.textContent).toBe('Collection B');
      // B exhausts and manually retries while A still owns its pending IO.
      for (let read = 0; read < 3; read++) {
        await h.advance();
        expect(h.calls).toHaveLength(read + 2);
        await settle(() => h.calls.at(-1)!.resolve(preparing()));
      }
      expect(h.host.textContent).toContain(m.library_dynamic_try_later());
      await h.click(m.library_collection_reload());
      await h.advance();
      const pendingB = h.calls.at(-1)!;
      await settle(() => {
        if (outcome === 'success') old.resolve({ ...ready('A member', 'A-next'), filterStatus: 'unsupported' });
        else old.reject(new Error('A failed'));
      });
      expect(h.host.textContent).not.toContain('A member');
      expect(h.host.textContent).not.toContain(m.library_dynamic_unavailable());
      expect(h.host.textContent).not.toContain(m.collection_filter_unsupported());
      expect(h.host.querySelector('a[href*="A-next"]')).toBeNull();
      await h.advance(60_000);
      expect(h.calls).toHaveLength(5); // A's finally cannot release B's pending read.
      expect(h.calls.at(-1)).toBe(pendingB);
      for (let read = 0; read < 3; read++) {
        expect(h.host.textContent).not.toContain(m.library_dynamic_try_later());
        await settle(() => h.calls.at(-1)!.resolve(preparing()));
        if (read < 2) await h.advance();
        expect(h.calls).toHaveLength(5 + Math.min(read + 1, 2));
      }
      expect(h.host.textContent).toContain(m.library_dynamic_try_later());
      await h.click(m.library_collection_reload());
      await h.advance();
      await settle(() => h.calls.at(-1)!.resolve(ready('B member', 'B-next')));
      expect(h.host.textContent).toContain('B member');
      expect(h.host.textContent).not.toContain('A member');
      expect(h.host.querySelector('a[href*="cursor=B-next"]')?.getAttribute('href')).toContain('type=schema%3ABook');
      expect(h.calls.slice(1).every((call) => call.id === currentId && call.filter === 'filter-B')).toBe(true);
    } finally {
      await h.close();
    }
  }
});

test('Same-ID loader replacement renders immediately and retires clipboard feedback', async () => {
  const h = await mount();
  try {
    const original = page('same', { ...ready('Old member'), title: 'Old title' });
    await h.render(original);
    await h.click(m.library_collection_share());
    const replacement = { ...original, ...ready('Current member'), title: 'Current title' };
    await h.render(replacement);
    expect(h.commits.at(-1)).toContain('Current member');
    expect(h.commits.at(-1)).not.toContain('Old member');
    expect(h.commits.at(-1)).not.toContain('Old title');
    await settle(() => h.copies[0]!.reject(new Error('old clipboard failure')));
    expect(h.host.textContent).not.toContain(m.error_message());
    await h.click(m.library_collection_share());
    await settle(() => h.copies[1]!.reject(new Error('current clipboard failure')));
    expect(h.host.textContent).toContain(m.error_message());
  } finally {
    await h.close();
  }
});

test('Preparation keeps its originating reader, clamps delays and bounds each manual retry cycle', async () => {
  const h = await mount();
  try {
    const original = page('timed', { cursor: 'origin-cursor', retryAfterMs: 0 });
    await h.render(original, h.reader('origin-filter'));
    await h.advance(999);
    await h.render(original, h.reader('callback-churn'));
    await h.advance(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ id: 'timed', cursor: 'origin-cursor', filter: 'origin-filter' });
    await h.advance(60_000);
    expect(h.calls).toHaveLength(1);
    await settle(() => h.calls[0]!.resolve(preparing(60_000)));
    await h.advance(29_999);
    expect(h.calls).toHaveLength(1);
    await h.advance(1);
    await settle(() => h.calls[1]!.resolve(preparing(60_000)));
    await h.advance(30_000);
    await settle(() => h.calls[2]!.resolve(preparing(60_000)));
    expect(h.host.textContent).toContain(m.library_dynamic_try_later());
    await h.advance(60_000);
    expect(h.calls).toHaveLength(3);
    await h.click(m.library_collection_reload());
    await h.advance(30_000);
    expect(h.calls).toHaveLength(4);
    await settle(() => h.calls[3]!.resolve(ready('Prepared member')));
    expect(h.host.textContent).toContain('Prepared member');
    expect(h.calls.every((call) => call.filter === 'origin-filter')).toBe(true);
    await h.advance(60_000);
    expect(h.calls).toHaveLength(4);
    await h.render(page('unavailable'));
    await h.advance();
    await settle(() => h.calls[4]!.resolve({ ...preparing(), preparing: false, unavailable: true }));
    expect(h.host.textContent).toContain(m.library_dynamic_unavailable());
    expect(h.host.textContent).not.toContain(m.library_dynamic_empty_everything());
    await h.advance(60_000);
    expect(h.calls).toHaveLength(5);
  } finally {
    await h.close();
  }
});

test('Unmount clears future preparation timers and ignores member and clipboard completions', async () => {
  const h = await mount();
  try {
    await h.render(page());
    const retiredTimer = [...h.timers.values()][0]!.run;
    await h.render(null);
    expect(h.timers.size).toBe(0);
    await settle(retiredTimer);
    await h.advance(60_000);
    expect(h.calls).toHaveLength(0);
    for (const outcome of ['success', 'rejection'] as const) {
      await h.render(page());
      await h.advance();
      const old = h.calls.at(-1)!;
      const count = h.calls.length;
      await h.click(m.library_collection_share());
      await h.render(null);
      await settle(() => {
        if (outcome === 'success') old.resolve(preparing());
        else old.reject(new Error('retired read'));
        h.copies.at(-1)!.reject(new Error('retired clipboard'));
      });
      await h.advance(60_000);
      expect(h.calls).toHaveLength(count);
      expect(h.timers.size).toBe(0);
      expect(h.host.textContent).toBe('');
    }
  } finally {
    await h.close();
  }
});
