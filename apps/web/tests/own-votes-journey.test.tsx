import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createContext, useContext, useRef, useState } from 'react';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import type { OwnVoteEntry, OwnVotesPage } from '../../../services/kernel/src/rating/own-votes-page.ts';
import type { OwnVoteIntent } from '../src/ratings/own-votes/intent';
import type { OwnVoteCommandResult } from '../src/ratings/own-votes/actions';
import type { OwnVoteReadback } from '../src/ratings/own-votes/readback';
import { OwnVotesWorkspace } from '../src/ratings/own-votes/page';
import { useOwnVotesReturn } from '../src/ratings/own-votes/return';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

const viewer = 'f6f6f6f6-f6f6-46f6-86f6-f6f6f6f6f6f6';
const terminal = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
const target = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
const question = 'd4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4';
const secondTarget = 'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3';
function row(retired = false, sourceTarget = target): OwnVoteEntry {
  const path = `/v1/subjects/${sourceTarget}/ratings/${question}/vote`;
  return {
    targetId: sourceTarget, questionId: question,
    subject: { id: terminal, type: 'work', types: ['work'], label: { value: 'Kokoro', language: 'en' }, creativeWork: true, cover: null },
    subjectHref: `/v1/subjects/${target}`, question: { id: question, revision: 1, label: 'How much does this work stay with you?', grain: 'work', scale: { min: 0, max: 20, displayStep: 2 } },
    own: { units: 0, revision: 1, at: '2026-10-01T00:00:00.000Z' },
    actions: retired ? { state: 'retired', reason: 'question_retired', clear: path, readback: path } : { state: 'editable', put: path, clear: path, readback: path },
  };
}

type Harness = {
  page: OwnVotesPage;
  setPage: (page: OwnVotesPage) => void;
  execute: (input: { data: OwnVoteIntent }) => Promise<OwnVoteCommandResult>;
  review: (input: { data: { intent: OwnVoteIntent; after: 'REVIEW' } }) => Promise<OwnVoteReadback>;
  refresh: () => Promise<unknown>;
};
const Context = createContext<Harness | null>(null);
function RatingsScreen() {
  const value = useContext(Context)!;
  const heading = useRef<HTMLHeadingElement>(null);
  useOwnVotesReturn('journey', () => true, value.refresh, () => heading.current?.focus());
  return (
    <OwnVotesWorkspace
      state="ready" page={value.page} cursor={null} locale="en" isCurrent={() => true}
      onRefresh={value.refresh} onUpdatePage={(update) => value.setPage(update(value.page))}
      headingRef={heading} execute={value.execute} review={value.review}
    />
  );
}

const rootRoute = createRootRoute({ component: Outlet });
const ratingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/library/ratings', component: RatingsScreen });
const subjectRoute = createRoute({ getParentRoute: () => rootRoute, path: '/subjects/$id/$slug', component: () => <p>Subject reader</p> });
const routeTree = rootRoute.addChildren([ratingsRoute, subjectRoute]);
// Route context is supplied outside the router so a return remount reads the current page value.
async function setup(initial: OwnVotesPage, execute: Harness['execute']) {
  const history = createMemoryHistory({ initialEntries: ['/library/ratings'] });
  const router = createRouter({ routeTree, history });
  await router.load();
  const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
  const window = new Window({ url: 'https://site.test/library/ratings' });
  const globals = {
    window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement, Element: window.Element, Node: window.Node,
    Document: window.Document, DocumentFragment: window.DocumentFragment, ShadowRoot: window.ShadowRoot,
    MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver, Event: window.Event,
    MouseEvent: window.MouseEvent, KeyboardEvent: window.KeyboardEvent, FocusEvent: window.FocusEvent,
    getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const calls: OwnVoteIntent[] = [];
  const refreshCount = { value: 0 };
  const review = async (): Promise<OwnVoteReadback> => ({ kind: 'unavailable' });
  function Provider() {
    const [page, setPage] = useState(initial);
    const value: Harness = {
      page, setPage, execute: async ({ data }) => { calls.push(data); return execute({ data }); }, review,
      refresh: async () => { refreshCount.value += 1; },
    };
    return <Context.Provider value={value}><RouterProvider router={router} /></Context.Provider>;
  }
  const previousLocale = getLocale();
  await setLocale('en', { reload: false });
  await act(async () => root.render(<Provider />));
  return {
    host, window, router, calls, refreshCount,
    close: async () => {
      await act(async () => root.unmount());
      await setLocale(previousLocale, { reload: false });
      await window.happyDOM.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

async function click(view: Awaited<ReturnType<typeof setup>>, button: Element) {
  await act(async () => button.dispatchEvent(new view.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
}

test('mounted journey keeps zero and original key, confirms exact readback, opens Subject and rereads on return', async () => {
  const original = row();
  const page: OwnVotesPage = { viewer: { accountId: viewer }, votes: [original, row(false, secondTarget)], next: null };
  const view = await setup(page, async ({ data }) => ({ kind: 'acknowledged', readback: { kind: 'current', units: data.body?.units ?? -1, revision: 2, at: '2026-11-01T00:00:00.000Z' } }));
  try {
    expect(view.host.textContent).toContain('0 / 20');
    expect(view.host.querySelectorAll('[data-own-vote-pair]')).toHaveLength(2);
    const inspect = [...view.host.querySelectorAll('button')].find((button) => button.textContent === m.library_my_ratings_inspect())!;
    await click(view, inspect);
    await click(view, [...view.host.querySelectorAll('button')].find((button) => button.textContent === m.library_my_ratings_edit())!);
    await click(view, [...view.host.querySelectorAll('button')].find((button) => button.textContent === m.library_my_ratings_save())!);
    await act(async () => Promise.resolve());
    expect(view.calls).toHaveLength(1);
    expect(view.calls[0]).toMatchObject({ targetId: target, questionId: question, path: `/v1/subjects/${target}/ratings/${question}/vote`, body: { units: 0 } });
    expect(view.host.textContent).toContain(m.library_my_ratings_saved());
    await click(view, [...view.host.querySelectorAll('a')].find((link) => link.textContent === 'Kokoro')!);
    expect(view.host.textContent).toContain('Subject reader');
    await act(async () => view.router.navigate({ to: '/library/ratings' }));
    await act(async () => new Promise((resolve) => view.window.requestAnimationFrame(() => resolve(undefined))));
    expect(view.refreshCount.value).toBe(1);
    expect(document.activeElement).toBe(view.host.querySelector('h1'));
  } finally {
    await view.close();
  }
});

test('retired journey confirms Clear, treats readback 404 as cleared and preserves continuation', async () => {
  const page: OwnVotesPage = { viewer: { accountId: viewer }, votes: [row(true)], next: 'opaque-next' };
  const view = await setup(page, async () => ({ kind: 'acknowledged', readback: { kind: 'cleared' } }));
  try {
    await click(view, [...view.host.querySelectorAll('button')].find((button) => button.textContent === m.library_my_ratings_inspect())!);
    await click(view, [...view.host.querySelectorAll('button')].find((button) => button.textContent === m.library_my_ratings_clear())!);
    const confirm = [...view.window.document.body.querySelectorAll('button')].find((button) => button.textContent === m.library_my_ratings_confirm_clear())!;
    await click(view, confirm);
    await act(async () => Promise.resolve());
    expect(view.calls[0]).toMatchObject({ method: 'DELETE', targetId: target, questionId: question });
    expect(view.host.textContent).toContain(m.library_my_ratings_cleared());
    expect(view.host.textContent).not.toContain(m.library_my_ratings_sparse());
    expect(view.host.querySelector('a[href*="cursor"]')?.getAttribute('href')).toContain(encodeURIComponent('opaque-next'));
  } finally {
    await view.close();
  }
});
