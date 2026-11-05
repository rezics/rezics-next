import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { ContinueEntry, ContinueView } from '../src/library/continue-source';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { PersonalLibraryPage } = await import('../src/library/entries-page');
const { ContinueSection } = await import('../src/library/continue');
const { continueProgress } = await import('../src/library/continue-read');
const { recordedContinueSessions } = await import('../src/kernel/fake/library-continue');

async function personalLibrary(continueState?: ContinueView, continueEntries?: ContinueEntry[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['exposure', 'anonymous'], ['personal_library', 'reading_progress']);
  const route = createRootRoute({
    component: () =>
      createElement(PersonalLibraryPage, {
        page: { signedIn: true, entries: [], next: null },
        locale: 'en',
        display: { layout: 'grid', size: 'm' },
        ...(continueState ? { continueState } : {}),
        ...(continueEntries ? { continueEntries } : {}),
      }),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/en/library'] }) });
  await router.load();
  try {
    return renderToStaticMarkup(
      createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
    );
  } finally {
    client.clear();
  }
}

const continueHeading = /<h2\b[^>]*>Continue<\/h2>/;

test('Personal Library omits Continue when the actual source explicitly has no continue content while preserving preparing unknown and unavailable states', async () => {
  const absent = await personalLibrary({ state: 'loaded', entries: [], next: null });
  expect(absent).not.toMatch(continueHeading);
  expect(absent).not.toContain('data-continue-state=');
  expect(absent).toContain('id="tracked-entries-heading"');
  // Navigation remains a destination even when the optional content section is absent.
  expect(absent).toMatch(/<a\b[^>]*href="\/en\/library\/continue"[^>]*>Continue<\/a>/);

  for (const state of [
    { state: 'preparing', retryAfter: 2 },
    { state: 'unknown' },
    { state: 'unavailable', status: 503 },
    { state: 'unavailable', reason: 'missing-binding' },
    { state: 'denied', status: 403 },
    // An empty partial page is not source exhaustion.
    { state: 'loaded', entries: [], next: 'more' },
  ] satisfies ContinueView[]) {
    const html = await personalLibrary(state);
    expect(html).toMatch(continueHeading);
    expect(html).toContain(`data-continue-state="${state.state}"`);
    if (state.state !== 'loaded') expect(html).not.toContain(m.library_continue_empty());
    if (state.state === 'preparing') expect(html).toContain(m.library_continue_preparing());
    if (state.state === 'unknown') expect(html).toContain(m.library_continue_loading());
    if (state.state === 'unavailable') expect(html).toContain(m.library_continue_unavailable());
  }
  expect(await personalLibrary()).toContain('data-continue-state="unknown"');
  expect(await personalLibrary(undefined, [])).toMatch(continueHeading);
});

test('Personal Library preserves session-only progress and rows with unavailable summaries', async () => {
  const session = recordedContinueSessions('en')[0]!;
  const entries: ContinueEntry[] = [
    {
      subjectId: session.subjectId,
      label: session.subject.label.value,
      summary: null,
      progress: continueProgress(session),
    },
    { subjectId: 'unavailable-summary', label: 'Retained activity', summary: null, progress: null },
  ];
  const before = structuredClone(entries);
  const html = await personalLibrary({ state: 'loaded', entries, next: null });
  expect(html).toMatch(continueHeading);
  expect(html).toContain(`href="/en/library/progress/${encodeURIComponent(session.id)}"`);
  expect(html).toContain('Retained activity');
  expect(html.match(/data-slot="cover-card"/g)).toHaveLength(2);
  expect(entries).toEqual(before);
});

test('the full Continue destination retains its exhausted message and continuation', () => {
  const empty = renderToStaticMarkup(
    createElement(ContinueSection, {
      destination: true,
      state: { state: 'loaded', entries: [], next: null },
      locale: 'en',
    }),
  );
  expect(empty).toContain('data-continue-state="loaded"');
  expect(empty).toContain('role="status"');
  expect(empty).toContain(m.library_continue_empty());
  const next = renderToStaticMarkup(
    createElement(ContinueSection, {
      destination: true,
      state: { state: 'loaded', entries: [], next: 'opaque:next' },
      locale: 'en',
    }),
  );
  expect(next).toContain('href="/en/library/continue?cursor=opaque%3Anext"');
});

test('chronological Library addresses retain exact profile states and effective order while label shelves keep assignment order', async () => {
  const { validateShelfSearch, shelfSort, shelfHref } = await import('../src/library/shelf-params');
  const selected = validateShelfSearch({
    state: 'reading.arc-1',
    orderBy: 'finishedAt',
    direction: 'asc',
    cursor: 'signed:page',
    layout: 'table',
    size: 'l',
  });
  expect(selected).toEqual({
    state: 'reading.arc-1',
    orderBy: 'finishedAt',
    direction: 'asc',
    cursor: 'signed:page',
    layout: 'table',
    size: 'l',
  });
  expect(shelfSort({ state: 'planned' })).toEqual({ orderBy: 'createdAt', direction: 'desc' });
  expect(shelfSort({ state: 'completed' })).toEqual({ orderBy: 'finishedAt', direction: 'desc' });
  expect(shelfSort({ state: 'reading.arc-1' })).toEqual({ orderBy: 'lastActivity', direction: 'desc' });
  const next = new URL(shelfHref('en', { ...selected, cursor: 'signed:next' }), 'http://site.test');
  expect(Object.fromEntries(next.searchParams)).toEqual({ ...selected, cursor: 'signed:next' });
  const layout = new URL(shelfHref('en', { ...selected, layout: 'list' }), 'http://site.test');
  expect(layout.searchParams.get('orderBy')).toBe('finishedAt');
  expect(layout.searchParams.get('cursor')).toBe('signed:page');
  const label = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
  const labelSearch = validateShelfSearch({ ...selected, label });
  expect(labelSearch).not.toHaveProperty('orderBy');
  expect(labelSearch).not.toHaveProperty('direction');
  const labelHref = shelfHref('en', { ...selected, label });
  expect(labelHref).not.toContain('orderBy=');
  expect(labelHref).not.toContain('direction=');
  expect(validateShelfSearch({ state: 'Invented State', orderBy: 'title', direction: 'random' })).toEqual({});
});

test('personal chronological reads send native sort and preserve the historical shared list query', async () => {
  const { readEntryPage } = await import('../src/library/entries-read');
  const { libraryListQuery, StaleCursorError } = await import('../src/library/reads');
  const calls: unknown[] = [];
  let response: unknown = { status: 200, data: { libraryEntries: [], next: null }, error: null };
  const client = {
    libraryEntries: {
      get: async (input: unknown) => {
        calls.push(input);
        return response;
      },
    },
  } as unknown as import('@rezics/client').KernelClient;
  const sort = { orderBy: 'finishedAt', direction: 'asc' } as const;
  await readEntryPage(client, 'Bearer owner', 'signed:next', 'reading.arc-1', 20, sort);
  expect(calls[0]).toEqual({
    query: { view: 'FULL', limit: 20, cursor: 'signed:next', state: 'reading.arc-1', ...sort },
    headers: { authorization: 'Bearer owner' },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  await readEntryPage(client, 'Bearer owner', undefined, undefined);
  expect(calls[1]).toEqual({
    query: libraryListQuery(),
    headers: { authorization: 'Bearer owner' },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  expect(libraryListQuery()).toEqual({ view: 'FULL', limit: 100 });
  response = { status: 200, data: { libraryEntries: [], next: 'x'.repeat(2049) }, error: null };
  await expect(readEntryPage(client, 'Bearer owner', undefined, undefined, 20, sort)).rejects.toThrow(
    'Native Library cursor exceeds',
  );
  response = { status: 400, error: { value: { code: 'invalid_cursor' } } };
  await expect(readEntryPage(client, 'Bearer owner', 'old', undefined, 20, sort)).rejects.toBeInstanceOf(
    StaleCursorError,
  );
  response = { status: 403, error: { value: { code: 'forbidden' } } };
  await expect(readEntryPage(client, 'Bearer owner', undefined, undefined, 20, sort)).rejects.toMatchObject({
    state: 'denied',
  });
  response = { status: 503, error: { value: { code: 'dependency_unavailable' } } };
  await expect(readEntryPage(client, 'Bearer owner', undefined, undefined, 20, sort)).rejects.toMatchObject({
    state: 'preparing',
  });
});

test('tracked window coordinates cap predecessors, reset predicates, and preserve opaque address bytes', async () => {
  const { EntriesWindowNavigation, entriesWindowHref } = await import('../src/library/entries-window-navigation');
  const { personalLibraryAddress } = await import('../src/library/personal-library-server');
  const windows = new EntriesWindowNavigation();
  const first = personalLibraryAddress({}, 'en');
  windows.bind('viewer', first);
  windows.admit(null, false);
  for (let i = 0; i < 12; i++) {
    expect(windows.stage('next', String(i), false)).toBe(true);
    expect(windows.stage('next', 'duplicate', false)).toBe(false);
    windows.admit(String(i), false);
  }
  for (let i = 10; i >= 3; i--) {
    expect(windows.previous).toBe(String(i));
    windows.stage('previous', String(i), false);
    windows.admit(String(i), false);
  }
  expect(windows.previous).toBeUndefined();
  windows.stage('next', 'stale', true);
  windows.admit('stale', true);
  expect(windows.pending).toBeUndefined();
  expect(windows.previous).toBeUndefined();
  windows.stage('next', 'later', false);
  windows.admit('later', false);
  windows.bind('viewer', { ...first, state: 'completed' });
  expect(windows.previous).toBeUndefined();
  expect(entriesWindowHref('/en/library?x=a%20b&cursor=old&size=m#heading', 'raw+/==')).toBe(
    '/en/library?x=a%20b&size=m&cursor=raw%2B%2F%3D%3D#heading',
  );
  expect(entriesWindowHref('/en/library?x=a%20b&cursor=old#heading', null)).toBe('/en/library?x=a%20b#heading');
});
