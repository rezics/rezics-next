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
