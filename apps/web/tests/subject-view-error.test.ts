import { afterAll, expect, test } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createSubjectViewRecovery, SubjectViewError } from '../src/subject/view-error';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';

const originalLocale = getLocale();
afterAll(() => setLocale(originalLocale, { reload: false }));

async function render(entry: string, message = 'unavailable', reset = () => {}) {
  const root = createRootRoute({
    component: () => createElement(SubjectViewError, { error: new Error(message), reset }),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [entry] }) });
  await router.load();
  return { html: renderToString(createElement(RouterProvider, { router })), router };
}

test('shared subject recovery actions remain distinct accessible touch targets while preserving exact retry and restart destinations', async () => {
  setLocale('en', { reload: false });
  const entry =
    '/en/subjects/example/%E6%9C%AC%20%26%20book/relations?cursor=refused%2Bcursor&realm=reading&node=related&context=review%2Fnotes#selection';
  const { html, router } = await render(entry);
  const button = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
  const link = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/)?.[0] ?? '';
  expect(button).toContain('type="button"');
  expect(button).toContain('Try again');
  expect(link).toContain('Start again');
  for (const action of [button, link]) {
    expect(action).toContain('min-h-11');
    expect(action).toContain('min-w-11');
    expect(action).toContain('whitespace-normal');
    expect(action).toContain('focus-visible:ring-3');
  }
  expect(html).toContain('flex-wrap');
  expect(html).toContain('gap-3');
  expect(html).toMatch(/<article aria-labelledby="([^"]+)"[\s\S]*?<h1 id="\1"/);
  expect(html).not.toContain('<main');
  const href = link.match(/href="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  expect(href).toBe(
    '/en/subjects/example/%E6%9C%AC%20%26%20book/relations?realm=reading&node=related&context=review%2Fnotes#selection',
  );
  expect(router.state.location.href).toBe(entry);
});

test('restart also preserves repeated query values and works without a cursor or remaining query', async () => {
  for (const entry of [
    '/en/subjects/example/book/relations?tag=one&cursor=old&tag=two&context=notes',
    '/en/subjects/example/book/relations?realm=reading',
    '/en/subjects/example/book/relations?cursor=old',
  ]) {
    const { html, router } = await render(entry);
    const href = html.match(/<a\b[^>]*href="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
    const destination = new URL(href!, 'https://rezics.test');
    const original = new URL(entry, 'https://rezics.test');
    expect(destination.pathname).toBe(original.pathname);
    expect(destination.searchParams.has('cursor')).toBe(false);
    original.searchParams.delete('cursor');
    // Compare parsed values because the router owns query serialization.
    expect(router.options.parseSearch!(destination.search)).toEqual(router.options.parseSearch!(original.search));
  }
});

test('all eight current locales report dependency failures as unavailable and conceal raw error causes', async () => {
  for (const locale of locales) {
    setLocale(locale, { reload: false });
    const messages = await Bun.file(new URL(`../messages/${locale}.json`, import.meta.url)).json();
    const { html: unavailable } = await render(`/${locale}/subjects/example/book/relations`, 'private upstream cause');
    const { html: dependency } = await render(`/${locale}/subjects/example/book/relations`, 'dependency_unavailable');
    for (const html of [unavailable, dependency]) {
      expect(html).toContain(messages.subject_view_retry);
      expect(html).toContain(messages.subject_view_restart);
      expect(html).not.toContain('private upstream cause');
      expect(html).not.toContain('dependency_unavailable');
    }
    expect(unavailable).toContain(messages.subject_view_unavailable);
    expect(dependency).toContain(messages.subject_view_unavailable);
    expect(dependency).not.toContain(messages.subject_view_changed);
  }
});

test('retry invalidates failed view data, coalesces clicks, and stays available after another failure', async () => {
  let reads = 0;
  const root = createRootRoute();
  const view = createRoute({
    getParentRoute: () => root,
    path: '/subjects/$subjectId/$view',
    loader: async () => (++reads < 3 ? Promise.reject(new Error('private cause')) : 'fresh page'),
  });
  const router = createRouter({
    routeTree: root.addChildren([view]),
    history: createMemoryHistory({ initialEntries: ['/subjects/book/relations?cursor=failed'] }),
  });
  await router.load().catch(() => {});
  const recover = createSubjectViewRecovery();
  const visit = router.state.location.key;
  let resets = 0;
  const first = recover(router, visit, () => resets++);
  expect(recover(router, visit, () => resets++)).toBe(first);
  await first.catch(() => {});
  expect([reads, resets]).toEqual([2, 0]);
  await recover(router, visit, () => resets++);
  expect([reads, router.state.matches.at(-1)?.loaderData, resets]).toEqual([3, 'fresh page', 1]);
});

test('a completed recovery cannot reset a different subject visit', async () => {
  const state = { location: {}, matches: [{ status: 'success' }] };
  let finish!: () => void;
  let resets = 0;
  const router = { state, invalidate: () => new Promise<void>((resolve) => (finish = resolve)) };
  const visit = state.location;
  const pending = createSubjectViewRecovery()(router, visit, () => resets++);
  state.location = {};
  finish();
  await pending;
  expect(resets).toBe(0);
});
