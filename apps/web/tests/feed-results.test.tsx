import { expect, test } from 'bun:test';
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { dirname } from 'node:path';
import { act } from 'react';
import { FeedResults, type FeedResultsMessages, type FeedResultsResult } from '../src/features/feed/feed-results';
import type { MyRealmsPage } from '../src/community/space';
import { setLocale } from '../src/paraglide/runtime.js';

type MyRealmSummary = MyRealmsPage['realms'][number];

const messages: FeedResultsMessages = {
  loading: 'Loading results',
  partial: 'Some results are unavailable',
  empty: 'Nothing here yet',
  sparse: 'More results may follow',
  retry: 'Try again',
  restart: 'Restart this list',
  failure: {
    request: 'The request could not be completed',
    auth: 'Sign in to continue',
    denied: 'This list is unavailable to you',
    closed: 'This feature is closed',
    cursor: 'This page can no longer continue',
    deadline: 'The request took too long',
    unavailable: 'The list is unavailable',
  },
};

async function createSurface() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const browser = new Window({ url: 'https://rezics.example/en/realms' });
  browser.document.documentElement.lang = 'en';
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    Element: browser.Element,
    Node: browser.Node,
    Document: browser.Document,
    ShadowRoot: browser.ShadowRoot,
    DocumentFragment: browser.DocumentFragment,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = browser.document.createElement('div');
  browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  return {
    browser,
    host,
    root,
    async close() {
      await act(async () => root.unmount());
      await browser.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function realmPresentation(realm: MyRealmSummary, locale: string) {
  return {
    title: realm.name,
    href: `/${locale}/realms/${encodeURIComponent(realm.realmId)}`,
    preview: realm.description ? <p>{realm.description}</p> : undefined,
  };
}

test('generic results render genuine MyRealms summaries with the installed heading, list, destination and opaque Link', async () => {
  setLocale('en', { reload: false });
  const surface = await createSurface();
  const page: MyRealmsPage = {
    signedIn: true,
    realms: [
      { realmId: 'realm-1', name: 'Reading Room', description: 'Read and compare notes.' },
      { realmId: 'realm-2', name: 'Evening Group', description: 'A place for conversations.' },
    ],
    next: 'opaque-cursor/%2B?scope=kept',
  };
  const locale = 'en';
  const opaqueCursor = 'opaque-cursor/%2B?scope=kept';

  function RealmResultsPage() {
    return (
      <article>
        <h1>My Realms</h1>
        <FeedResults<MyRealmSummary>
          regionLabel="My Realms"
          itemHeadingLevel={2}
          listAs="ul"
          result={{
            state: 'ready',
            items: page.realms,
            hasNext: page.next !== null,
            availability: { state: 'complete' },
          }}
          messages={messages}
          getItemKey={(realm) => realm.realmId}
          itemPresentation={(realm) => realmPresentation(realm, locale)}
          nextControl={
            <nav aria-label="My Realms">
              <Link to="/realms" search={{ cursor: opaqueCursor }}>
                More Realms
              </Link>
            </nav>
          }
        />
      </article>
    );
  }

  const root = createRootRoute({ component: Outlet });
  const realms = createRoute({ getParentRoute: () => root, path: '/realms', component: RealmResultsPage });
  const router = createRouter({
    routeTree: root.addChildren([realms]),
    history: createMemoryHistory({ initialEntries: ['/realms'] }),
  });
  try {
    await act(async () => surface.root.render(<RouterProvider router={router} />));
    const region = surface.host.querySelector('section[aria-label="My Realms"]');
    const list = region?.querySelector('ul[aria-label="My Realms"]');
    const rows = [...(list?.querySelectorAll<HTMLLIElement>(':scope > li') ?? [])];
    expect(surface.host.querySelectorAll('main')).toHaveLength(0);
    expect(surface.host.querySelectorAll('h1')).toHaveLength(1);
    expect(region).not.toBeNull();
    expect(list).not.toBeNull();
    expect(surface.host.querySelectorAll('ol')).toHaveLength(0);
    expect(rows.map((row) => row.querySelector('h2')?.textContent)).toEqual(['Reading Room', 'Evening Group']);
    expect(rows.map((row) => row.querySelector('h2')?.tagName)).toEqual(['H2', 'H2']);
    expect(rows.map((row) => row.querySelector('[data-content-item-slot="preview"]')?.textContent)).toEqual([
      'Read and compare notes.',
      'A place for conversations.',
    ]);
    expect(rows.map((row) => row.querySelector('h2')?.closest('a')?.getAttribute('href'))).toEqual([
      '/en/realms/realm-1',
      '/en/realms/realm-2',
    ]);
    const next = [...surface.host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => link.textContent === 'More Realms',
    );
    expect(next).not.toBeUndefined();
    expect(next?.getAttribute('href')).toContain('/realms?cursor=');
    expect(new URL(next!.href).searchParams.get('cursor')).toBe(opaqueCursor);
  } finally {
    await surface.close();
  }
});

type ResultRow = { id: string; title: string };

function resultRegion(
  result: FeedResultsResult<ResultRow>,
  callbacks: { retry: () => void; restart: () => void; next: () => void },
  busy = false,
  suppressResultMessage = false,
) {
  return (
    <FeedResults<ResultRow>
      regionLabel="Activity"
      itemHeadingLevel={3}
      listAs="ol"
      result={result}
      busy={busy}
      messages={messages}
      getItemKey={(row) => row.id}
      itemPresentation={(row) => ({ title: row.title })}
      onRetry={callbacks.retry}
      onRestart={callbacks.restart}
      suppressResultMessage={suppressResultMessage}
      nextControl={<button onClick={callbacks.next}>Next</button>}
      emptyActions={<a href="/en/search">Search</a>}
    />
  );
}

test('shared results preserve order and occurrence keys while covering source availability, sparse pages, recovery and suppression', async () => {
  const surface = await createSurface();
  const liveFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error('FeedResults must not perform IO');
  }) as typeof fetch;
  let retryCalls = 0;
  let restartCalls = 0;
  let nextCalls = 0;
  const callbacks = {
    retry: () => retryCalls++,
    restart: () => restartCalls++,
    next: () => nextCalls++,
  };
  const ordered: readonly ResultRow[] = [
    { id: 'occurrence:a', title: 'First returned row' },
    { id: 'occurrence:b', title: 'Second returned row' },
  ];
  const ready: FeedResultsResult<ResultRow> = {
    state: 'ready',
    items: ordered,
    hasNext: true,
    availability: { state: 'complete', sources: { following: 'ready', discovery: 'ready' } },
  };
  try {
    await act(async () => surface.root.render(resultRegion(ready, callbacks)));
    const originalRows = [...surface.host.querySelectorAll<HTMLLIElement>('ol > li')];
    expect(surface.host.querySelector('section[aria-label="Activity"]')).not.toBeNull();
    expect(surface.host.querySelector('section main')).toBeNull();
    expect(originalRows.map((row) => row.querySelector('h3')?.textContent)).toEqual([
      'First returned row',
      'Second returned row',
    ]);
    expect(surface.host.querySelector('ol')?.getAttribute('aria-label')).toBe('Activity');

    const updated: FeedResultsResult<ResultRow> = {
      ...ready,
      items: ordered.map((row) => ({ ...row, title: `${row.title} updated` })),
    };
    await act(async () => surface.root.render(resultRegion(updated, callbacks)));
    const updatedRows = [...surface.host.querySelectorAll<HTMLLIElement>('ol > li')];
    expect(updatedRows).toEqual(originalRows);
    expect(updatedRows.map((row) => row.querySelector('h3')?.textContent)).toEqual([
      'First returned row updated',
      'Second returned row updated',
    ]);

    const partial: FeedResultsResult<ResultRow> = {
      state: 'ready',
      items: [],
      hasNext: true,
      availability: { state: 'partial', sources: { following: 'preparing', discovery: 'unavailable' } },
    };
    await act(async () => surface.root.render(resultRegion(partial, callbacks, true, true)));
    expect(surface.host.querySelector('[role="status"]')?.textContent).toBe('Some results are unavailable');
    expect(surface.host.querySelector('[data-feed-source-state]')?.getAttribute('data-feed-source-state')).toBe(
      'following:preparing discovery:unavailable',
    );
    expect(surface.host.textContent).not.toContain('Nothing here yet');
    expect(surface.host.textContent).not.toContain('More results may follow');
    expect(surface.host.querySelector('a[href="/en/search"]')?.textContent).toBe('Search');
    expect(surface.host.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    expect([...surface.host.querySelectorAll('button')].some((button) => button.textContent === 'Next')).toBe(true);

    const retainedPartial: FeedResultsResult<ResultRow> = {
      state: 'ready',
      items: ordered,
      hasNext: false,
      availability: { state: 'unavailable' },
    };
    await act(async () => surface.root.render(resultRegion(retainedPartial, callbacks, false, true)));
    expect(surface.host.querySelectorAll('ol > li')).toHaveLength(2);
    expect(surface.host.querySelector('[role="status"]')?.textContent).toBe('Some results are unavailable');
    expect(surface.host.textContent).not.toContain('Nothing here yet');

    const terminalEmpty: FeedResultsResult<ResultRow> = {
      state: 'ready',
      items: [],
      hasNext: false,
      availability: { state: 'complete' },
    };
    await act(async () => surface.root.render(resultRegion(terminalEmpty, callbacks)));
    expect(surface.host.querySelector('[role="status"]')?.textContent).toBe('Nothing here yet');
    expect(surface.host.textContent).not.toContain('More results may follow');
    expect(surface.host.querySelector('a[href="/en/search"]')).not.toBeNull();

    const sparse: FeedResultsResult<ResultRow> = { ...terminalEmpty, hasNext: true };
    await act(async () => surface.root.render(resultRegion(sparse, callbacks)));
    expect(surface.host.querySelector('[role="status"]')?.textContent).toBe('More results may follow');
    expect(surface.host.textContent).not.toContain('Nothing here yet');
    await act(async () => surface.host.querySelector<HTMLButtonElement>('button')!.click());
    expect(nextCalls).toBe(1);

    await act(async () => surface.root.render(resultRegion({ state: 'loading', code: 'loading' }, callbacks)));
    expect(surface.host.querySelector('[role="status"]')?.textContent).toBe('Loading results');
    expect(surface.host.querySelector('a[href="/en/search"]')).toBeNull();
    expect(surface.host.querySelector('[data-feed-source-state]')).toBeNull();

    await act(async () => surface.root.render(resultRegion({ state: 'cursor', code: 'stale_cursor' }, callbacks)));
    expect(surface.host.querySelector('[role="alert"]')?.textContent).toContain('This page can no longer continue');
    expect(
      [...surface.host.querySelectorAll('button')].some((button) => button.textContent === 'Restart this list'),
    ).toBe(true);
    expect([...surface.host.querySelectorAll('button')].some((button) => button.textContent === 'Try again')).toBe(
      false,
    );
    await act(async () =>
      [...surface.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Restart this list')!
        .click(),
    );
    expect(restartCalls).toBe(1);

    await act(async () =>
      surface.root.render(resultRegion({ state: 'request', code: 'unsupported_query' }, callbacks)),
    );
    expect(surface.host.querySelector('[role="alert"]')?.textContent).toContain('The request could not be completed');
    await act(async () =>
      [...surface.host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === 'Try again')!
        .click(),
    );
    expect(retryCalls).toBe(1);

    await act(async () => surface.root.render(resultRegion({ state: 'denied', code: 'forbidden' }, callbacks)));
    expect(surface.host.querySelector('[role="alert"]')?.textContent).toContain('This list is unavailable to you');
    expect(fetchCalls).toBe(0);
  } finally {
    globalThis.fetch = liveFetch;
    await surface.close();
  }
});
