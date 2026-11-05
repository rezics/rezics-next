import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, useLayoutEffect } from 'react';
import type { DynamicCollectionPage as Page } from '../src/library/dynamic-collection';
import type { RulePage } from '../src/library/collection-rule-read';
import type { RuleWrite } from '../src/library/collection-rule-actions';
import type { CollectionWriteResult } from '../src/library/collection-records';
import type { DynamicMembersResult } from '../src/library/collection-load';
import type { FilterDocument } from '@rezics/filter';
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
const { savedQueryResultsAddress, savedQueryRuleReturn, RuleEditLink } =
  await import('../src/library/saved-query-results');
const { CollectionRuleEditor } = await import('../src/library/collection-rule-editor');
const { CollectionRuleControls } = await import('../src/library/collection-rule-controls');
const { renderToStaticMarkup } = await import('react-dom/server');
const { libraryNavigationQuery } = await import('../src/library/pins-read');
const { sessionQuery, exposureQuery } = await import('../src/session/query');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
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
    if (typeof delay !== 'number' || delay < 1000 || delay > 30_000) return nativeSetTimeout(run, delay, ...args);
    const id = nextTimer--;
    timers.set(id, { at: now + delay, run: () => run(...args) });
    return id;
  }) as typeof setTimeout);
  const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((id) => {
    if (!timers.delete(Number(id))) nativeClearTimeout(id);
  }) as typeof clearTimeout);
  const commits: string[] = [];
  const render = (
    p: Page | null,
    readMembers = reader('default'),
    viewerId: string | null = null,
    readRule?: (id: string) => Promise<RulePage>,
  ) =>
    settle(() =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <RouterContextProvider router={router}>
              {p ? (
                <DynamicCollectionPage
                  page={p}
                  readMembers={readMembers}
                  viewerId={viewerId}
                  search={{ type: 'schema:Book' }}
                  {...(readRule ? { readRule } : {})}
                />
              ) : null}
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
  const authorize = (subject: string, admitted = ['collections']) =>
    settle(() => {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', csrfToken: `csrf-${subject}`, subject });
      const snapshot = viewerExposureLifetime(client).getSnapshot();
      expect(snapshot.state).toBe('signed-in');
      if (snapshot.state === 'signed-in')
        client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, { subject, admitted });
    });
  const signOut = () =>
    settle(() => client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null, subject: null }));
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
    client,
    authorize,
    signOut,
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

test('Saved rule edit, confirmation and member return keep independent supported choices on the same identity', () => {
  const id = '0192f3a0-6c1e-7b2a-a001-000000000001';
  const search = {
    type: 'schema:Book',
    'f.schema:keywords': ['b', 'a', 'b'],
    'r.schema:wordCount': '0,120',
    'l.schema:keywords': 'Original label',
  };
  const outer = '/en/library/collections?cursor=outer%2B%2F&layout=rows';
  const current = savedQueryResultsAddress('en', id, 'opaque /+?二', search, { layout: 'grid', returnTo: outer });
  const collection = { id, curatorAccountId: 'owner', membershipKind: 'dynamic' };
  const markup = renderToStaticMarkup(
    <RuleEditLink collection={collection} viewerId="owner" allowed resultsHref={current} />,
  );
  const host = document.createElement('div');
  host.innerHTML = markup;
  const edit = new URL(host.querySelector('a')!.href);
  expect(edit.pathname).toBe(`/en/collections/${id}/rule`);
  const returnTo = edit.searchParams.get('returnTo')!;
  expect(savedQueryRuleReturn(returnTo, id, 'en')).toBe(current);
  const confirmed = savedQueryRuleReturn(returnTo, id, 'en', true);
  expect(new URL(confirmed, window.location.origin).searchParams.has('cursor')).toBe(false);
  const before = new URL(current, window.location.origin).searchParams;
  const after = new URL(confirmed, window.location.origin).searchParams;
  for (const key of ['type', 'f.schema:keywords', 'r.schema:wordCount', 'l.schema:keywords', 'layout', 'returnTo'])
    expect(after.getAll(key)).toEqual(before.getAll(key));
  for (const savedId of [null, id]) {
    host.innerHTML = renderToStaticMarkup(
      <CollectionRuleControls
        creating={false}
        pending={false}
        conflict={false}
        hasFilter
        savedId={savedId}
        collectionId={id}
        resultsHref={returnTo}
        refresh={() => {}}
      />,
    );
    expect(host.querySelector('a')!.getAttribute('href')).toBe(savedId ? confirmed : current);
  }
  for (const value of [
    'https://foreign.test/en/collections/' + id,
    '//foreign.test/',
    '/en/collections/other?cursor=old',
    current + '&cursor=ambiguous',
  ])
    expect(savedQueryRuleReturn(value, id, 'en')).toBe(`/en/collections/${id}`);
  for (const [viewerId, allowed, builtinKind] of [
    ['reader', true, undefined],
    ['owner', false, undefined],
    ['owner', true, 'everything'],
    ['owner', true, 'liked'],
  ] as const)
    expect(
      renderToStaticMarkup(
        <RuleEditLink
          collection={{ ...collection, ...(builtinKind ? { builtinKind } : {}) }}
          viewerId={viewerId}
          allowed={allowed}
          resultsHref={current}
        />,
      ),
    ).toBe('');
});

test('Explicit recovery replaces current definition-bound results and retires unavailable, invalid and denied pages', async () => {
  const h = await mount();
  try {
    const original = page('saved', {
      builtinKind: undefined,
      preparing: false,
      unavailable: true,
      filterStatus: 'preparing',
      members: ready('Old member').members,
    });
    await h.render(original, h.reader('origin-filter'));
    await h.click(m.library_collection_share());
    await h.click(m.library_dynamic_retry_unavailable());
    expect(h.calls).toHaveLength(1);
    expect(h.host.textContent).toContain(m.library_dynamic_retry_pending());
    const replacement = page('saved', {
      ...ready('New definition member'),
      builtinKind: undefined,
      title: 'Current saved title',
      revision: 8,
      filterReleaseKey: 'new-release',
      filterStatus: undefined,
    });
    await settle(() => h.calls[0]!.resolve({ ...ready('ignored partial member'), page: replacement }));
    await settle(() => h.copies[0]!.reject(new Error('Retired source clipboard')));
    expect(h.host.textContent).not.toContain(m.error_message());
    expect(h.host.textContent).toContain('New definition member');
    expect(h.host.textContent).toContain('Current saved title');
    expect(h.host.textContent).not.toContain('Old member');
    expect(h.host.textContent).not.toContain('ignored partial member');
    expect(h.host.textContent).not.toContain(m.collection_filter_preparing());
    for (const outcome of ['empty', 'unsupported', 'stale', 'denied', 'closed'] as const) {
      await h.render({ ...original }, h.reader('origin-filter'));
      await h.click(m.library_dynamic_retry_unavailable());
      const result = {
        ...ready(''),
        members: [],
        ...(outcome === 'unsupported'
          ? { filterStatus: 'unsupported' as const }
          : outcome === 'stale'
            ? { cursorRestarted: true }
            : outcome === 'denied' || outcome === 'closed'
              ? { access: outcome }
              : {}),
      };
      await settle(() => h.calls.at(-1)!.resolve(result));
      expect(h.host.textContent).not.toContain('Old member');
      expect(h.host.textContent).not.toContain('New definition member');
      if (outcome === 'unsupported') {
        expect(h.host.textContent).toContain(m.collection_filter_unsupported());
        expect(h.host.textContent).toContain(m.collection_filter_clear());
        expect(h.host.querySelector('nav[aria-label="' + m.library_collection_members() + '"]')).toBeNull();
      } else if (outcome === 'stale') expect(h.host.textContent).toContain(m.library_collections_cursor_reset());
      else if (outcome === 'empty') expect(h.host.textContent).toContain(m.library_dynamic_page_reader_empty());
      else {
        expect(h.host.textContent).not.toContain('Collection saved');
        expect(h.host.textContent).not.toContain(m.library_dynamic_retry_unavailable());
        if (outcome === 'closed') expect(h.host.textContent).toContain(m.platform_closed_message());
      }
    }
    // Neither a late result nor an A/B/A address return can revive retired observations.
    await h.render(page('A'), h.reader('A-filter'));
    await h.advance();
    const retired = h.calls.at(-1)!;
    await h.render(page('B'), h.reader('B-filter'));
    await h.render(page('A'), h.reader('fresh-A-filter'));
    await settle(() => retired.resolve(ready('Retired A member')));
    expect(h.host.textContent).not.toContain('Retired A member');
    await h.advance();
    expect(h.calls.at(-1)!.filter).toBe('fresh-A-filter');
  } finally {
    await h.close();
  }
});

test('Owner results join a current private rule basis and retire it on sign-out', async () => {
  const h = await mount();
  const id = 'saved-results';
  const filter: FilterDocument = { owner: { label: { id: 'private-label' } } };
  const currentPage = page(id, {
    title: 'Saved reading',
    builtinKind: undefined,
    curatorAccountId: 'alice',
    cursor: undefined,
    preparing: false,
    members: [],
  });
  const basis: Extract<RulePage, { state: 'ready' }> = {
    state: 'ready',
    id,
    viewerId: 'alice',
    address: { collectionId: id },
    title: 'Saved reading',
    intent: '10000000-0000-4000-8000-000000000021',
    choices: {
      release: { state: 'ready', digest: 'current-release-52', metadata: { types: {}, properties: {} }, profiles: [] },
      labels: { state: 'ready', values: [{ id: 'private-label', name: 'Alice private label' }], next: null },
    },
    accepted: {
      state: 'ready',
      digest: 'saved-release-41',
      metadata: { types: {}, properties: {} },
      profiles: [],
    },
    rule: {
      filter,
      sort: 'id',
      revision: 17,
      collectionRevision: 22,
      releaseDigest: 'saved-release-41',
      sourceGeneration: 'generation-41',
    },
  };
  const reads: Array<ReturnType<typeof deferred<RulePage>> & { id: string }> = [];
  const readRule = (requestId: string) => {
    const request = { ...deferred<RulePage>(), id: requestId };
    reads.push(request);
    return request.promise;
  };
  try {
    await h.render(currentPage, h.reader('saved'), 'alice', readRule);
    await h.authorize('alice');
    expect(h.host.textContent).not.toContain('Alice private label');
    await h.click(m.library_rule_results_review());
    expect(reads).toHaveLength(1);
    expect(reads[0]!.id).toBe(id);
    await act(async () => {
      reads[0]!.resolve(basis);
      await reads[0]!.promise;
    });
    expect(h.host.textContent).toContain(m.library_rule_results_heading());
    expect(h.host.textContent).toContain(m.library_rule_results_response_heading());
    expect(h.host.textContent).toContain(m.library_rule_results_empty());
    expect(h.host.textContent).toContain('Alice private label');
    expect(h.host.textContent).toContain(m.library_rule_review_owner_verified());
    expect(h.host.textContent).toContain(m.library_rule_revision());
    expect(h.host.textContent).toContain('17');
    expect(h.host.textContent).toContain(m.library_rule_collection_revision());
    expect(h.host.textContent).toContain('22');
    expect(h.host.textContent).toContain('saved-release-41');
    expect(h.host.textContent).toContain('current-release-52');
    expect(h.host.textContent).toContain('generation-41');
    expect([...h.host.querySelectorAll('details')].some((node) => node.open && node.textContent?.includes('generation-41'))).toBe(true);
    await h.signOut();
    expect(h.host.textContent).not.toContain('Alice private label');
    expect(h.host.textContent).not.toContain('saved-release-41');
    expect(h.host.textContent).not.toContain(m.library_rule_results_heading());
    await h.authorize('alice');
    await h.click(m.library_rule_results_review());
    const mismatched = { ...basis, viewerId: 'bob' };
    await act(async () => {
      reads.at(-1)!.resolve(mismatched);
      await reads.at(-1)!.promise;
    });
    expect(h.host.textContent).toContain(m.library_rule_denied());
    expect(h.host.textContent).not.toContain('Alice private label');
    await h.click(m.library_rule_results_retry());
    const staleRelease = { ...basis, accepted: { ...basis.accepted!, digest: 'different-release' } };
    await act(async () => {
      reads.at(-1)!.resolve(staleRelease);
      await reads.at(-1)!.promise;
    });
    expect(h.host.textContent).toContain(m.library_rule_review_metadata_unavailable());
    expect(h.host.textContent).not.toContain(m.library_rule_results_empty());
  } finally {
    await h.close();
  }
});

test('An uncertain saved-rule update keeps its original command and confirms the same saved results address', async () => {
  const id = 'saved-rule';
  const rule: Extract<RulePage, { state: 'ready' }> = {
    state: 'ready',
    id,
    viewerId: 'owner',
    title: 'Saved reading',
    intent: '10000000-0000-4000-8000-000000000001',
    address: { collectionId: id },
    choices: {
      release: { state: 'ready', digest: 'original-release', metadata: { types: {}, properties: {} }, profiles: [] },
      labels: { state: 'ready', values: [], next: null },
    },
    accepted: {
      state: 'ready',
      digest: 'original-release',
      metadata: { types: {}, properties: {} },
      profiles: [],
    },
    rule: {
      filter: { owner: { presence: true } },
      sort: 'id',
      revision: 7,
      collectionRevision: 9,
      releaseDigest: 'original-release',
      sourceGeneration: 'original-source',
    },
  };
  const resultsHref = savedQueryResultsAddress(
    'en',
    id,
    'original-cursor',
    { 'f.schema:keywords': ['b', 'a'] },
    { layout: 'grid' },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const requests: Array<{ input: RuleWrite; csrf: string } & ReturnType<typeof deferred<CollectionWriteResult>>> = [];
  const navigations: string[] = [];
  const send = (input: RuleWrite, csrf: string) => {
    const request = { input, csrf, ...deferred<CollectionWriteResult>() };
    requests.push(request);
    return request.promise;
  };
  const foreignSend = mock(async (): Promise<CollectionWriteResult> => ({ ok: true, id: 'wrong-identity' }));
  const render = (csrfToken: string, save = send) =>
    settle(() =>
      root.render(
        <CollectionRuleEditor
          page={rule}
          viewerId="owner"
          collectionId={id}
          csrfToken={csrfToken}
          save={save}
          resultsHref={resultsHref}
          navigate={(savedId) => navigations.push(savedId)}
          isOwnerCurrent={() => true}
          admitted={['collection_rule.get', 'collection_rule.update']}
          reload={async () => ({
            ...rule,
            intent: 'new-read',
            rule: {
              ...rule.rule,
              revision: 12,
              releaseDigest: 'new-release',
              sourceGeneration: 'new-source',
            },
            accepted: { ...rule.accepted!, digest: 'new-release' },
          })}
        />,
      ),
    );
  const submit = () =>
    settle(() => {
      host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  try {
    await render('original-credential');
    expect(host.textContent).toContain('original-source');
    expect(host.textContent).toContain('original-release');
    expect(host.textContent).toContain(m.library_rule_revision());
    expect(host.textContent).toContain(m.library_rule_collection_revision());
    expect(host.textContent).toContain(m.library_rule_review_owner_verified());
    expect(host.querySelector('button[type="submit"]')!.textContent).toContain(m.library_rule_save_and_view_results());
    await submit();
    await submit();
    expect(requests).toHaveLength(1);
    await settle(() => requests[0]!.resolve({ ok: false, reason: 'unavailable' }));
    expect(host.textContent).toContain(m.library_rule_uncertain());
    await render('replacement-credential', foreignSend);
    await settle(() =>
      [...host.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === m.library_collection_reload())!
        .click(),
    );
    expect(requests).toHaveLength(1); // A read cannot replay the uncertain command.
    expect(host.textContent).toContain('original-source');
    expect(host.textContent).not.toContain('new-source');
    await submit();
    expect(requests).toHaveLength(2);
    expect(requests[1]!.input).toEqual(requests[0]!.input);
    expect(requests[1]!.input).toMatchObject({ id, revision: 7, idempotencyKey: rule.intent });
    expect(requests[1]!.csrf).toBe('original-credential');
    expect(foreignSend).not.toHaveBeenCalled();
    // A successful response for another identity is still uncertain, never a new saved destination.
    await settle(() => requests[1]!.resolve({ ok: true, id: 'wrong-identity' }));
    expect(host.textContent).toContain(m.library_rule_uncertain());
    expect(host.textContent).not.toContain(m.library_rule_saved());
    expect(navigations).toEqual([]);
    await submit();
    expect(requests).toHaveLength(3);
    expect(requests[2]!.input).toEqual(requests[0]!.input);
    await settle(() => requests[2]!.resolve({ ok: true, id }));
    expect(host.textContent).toContain(m.library_rule_saved());
    expect(navigations).toEqual([id]);
    expect(host.textContent).toContain(m.library_rule_review_confirmed_collection());
    const members = [...host.querySelectorAll('a')].find((a) => a.textContent === m.library_rule_members())!;
    expect(members.getAttribute('href')).toBe(savedQueryRuleReturn(resultsHref, id, 'en', true));
    expect(new URL(members.href).searchParams.getAll('f.schema:keywords')).toEqual(['b', 'a']);
    expect(new URL(members.href).searchParams.get('layout')).toBe('grid');
    expect(new URL(members.href).searchParams.has('cursor')).toBe(false);
    await submit();
    expect(requests).toHaveLength(3);
  } finally {
    await settle(() => root.unmount());
    host.remove();
  }
});
