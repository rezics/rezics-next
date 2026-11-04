import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createContext, useContext, useRef, useState } from 'react';
import type { OwnVoteEntry, OwnVotesPage } from '../../../services/kernel/src/rating/own-votes-page.ts';
import type { OwnVoteIntent } from '../src/ratings/own-votes/intent';
import type { OwnVoteCommandResult, OwnVotesRead } from '../src/ratings/own-votes/actions';
import type { OwnVoteReadback } from '../src/ratings/own-votes/readback';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

mock.module('cloudflare:workers', () => ({ env: {} }));

const viewer = 'f6f6f6f6-f6f6-46f6-86f6-f6f6f6f6f6f6';
const terminal = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
const target = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
const question = 'd4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4';
const secondTarget = 'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3';
const receiptTrace: string[] = [];
const callbackTrace: string[] = [];
let nextScreenInstance = 0;
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/library/ratings' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  ShadowRoot: window.ShadowRoot,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  FocusEvent: window.FocusEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: () => undefined,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const savedGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const start = await import('../.storybook/react-start');
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('../src/kernel/client', () => ({ configured: () => false }));
mock.module('../src/ratings/own-votes/actions', () => ({
  readOwnVotesForViewer: async () => ({ state: 'unavailable', page: null, subject: null, cursor: null, locale: 'en', source: null }),
  executeOwnVoteIntent: async () => ({ kind: 'rejected' }),
  voteReadbackForIntent: async () => ({ kind: 'unavailable' }),
}));
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouterState,
} = await import('@tanstack/react-router');
const { OwnVotesReturnProvider, useOwnVotesReturn, useOwnVotesReturnReceipt } = await import(
  '../src/ratings/own-votes/return'
);
const { OwnVotesWorkspace } = await import('../src/ratings/own-votes/page');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}
function row(retired = false, sourceTarget = target): OwnVoteEntry {
  const path = `/v1/subjects/${sourceTarget}/ratings/${question}/vote`;
  return {
    targetId: sourceTarget,
    questionId: question,
    subject: {
      id: terminal,
      type: 'work',
      types: ['work'],
      label: { value: 'Kokoro', language: 'en' },
      creativeWork: true,
      cover: null,
    },
    subjectHref: `/v1/subjects/${target}`,
    question: {
      id: question,
      revision: 1,
      label: 'How much does this work stay with you?',
      grain: 'work',
      scale: { min: 0, max: 20, displayStep: 2 },
    },
    own: { units: 0, revision: 1, at: '2026-10-01T00:00:00.000Z' },
    actions: retired
      ? { state: 'retired', reason: 'question_retired', clear: path, readback: path }
      : { state: 'editable', put: path, clear: path, readback: path },
  };
}

type Harness = {
  page: OwnVotesPage;
  state: OwnVotesRead['state'];
  cursor: string | null;
  setPage: (page: OwnVotesPage) => void;
  execute: (input: { data: OwnVoteIntent }) => Promise<OwnVoteCommandResult>;
  review: (input: { data: { intent: OwnVoteIntent; after: 'REVIEW' } }) => Promise<OwnVoteReadback>;
  refresh: () => Promise<unknown>;
};
type RefreshPlan = (input: {
  page: OwnVotesPage;
  replace: (page: OwnVotesPage, state?: OwnVotesRead['state']) => void;
}) => Promise<unknown>;
const Context = createContext<Harness | null>(null);
function RatingsScreen() {
  const instance = useRef(++nextScreenInstance);
  const value = useContext(Context)!;
  const heading = useRef<HTMLHeadingElement>(null);
  const historyKey = useRouterState({ select: (state) => state.location.state.key ?? '' });
  const receipt = useOwnVotesReturnReceipt(historyKey, value.cursor, 'en');
  const [outcome, setOutcome] = useState<OwnVotesReturnOutcome | null>(null);
  receiptTrace.push(`${instance.current}:${historyKey}:${receipt?.phase ?? 'none'}:${outcome?.kind ?? 'none'}`);
  const owner = (): OwnVotesReturnOwner => ({
    visitKey: 'journey',
    responseVersion: 0,
    subject: viewer,
    cursor: value.cursor,
    locale: 'en',
    source: 'rating.own_votes_page/v1',
    eligible: () => true,
    canRead: () => {
      callbackTrace.push('canRead');
      return true;
    },
    validateResult: (result) => {
      callbackTrace.push('validate');
      if (!result || typeof result !== 'object' || !('data' in result) || !('isSuccess' in result) || result.isSuccess !== true)
        return null;
      const read = result.data as OwnVotesRead;
      const valid = read.state === 'ready' && read.subject === viewer && read.cursor === value.cursor;
      callbackTrace.push(`valid:${valid}`);
      return valid ? read : null;
    },
  });
  const returnVisit = useOwnVotesReturn({
    visitKey: 'journey',
    cursor: value.cursor,
    locale: 'en',
    owner,
    isCurrent: () => true,
    refresh: value.refresh,
    receipt,
    onResolved: (next) => {
      callbackTrace.push(`resolved:${next.kind}`);
      setOutcome(next);
    },
    onFocus: (next) => {
      if (next.kind === 'found') {
        const row = Array.from(document.querySelectorAll<HTMLElement>('[data-own-vote-target]')).find(
          (candidate) =>
            candidate.dataset.ownVoteTarget === next.pair.targetId &&
            candidate.dataset.ownVoteQuestion === next.pair.questionId,
        );
        row?.querySelector<HTMLButtonElement>('button')?.focus();
      } else heading.current?.focus();
    },
  });
  const returnState = returnVisit.pending ? (returnVisit.failed ? 'unavailable' : 'preparing') : value.state;
  return (
    <OwnVotesWorkspace
      state={returnState}
      page={returnVisit.pending || value.state !== 'ready' ? null : value.page}
      cursor={value.cursor}
      locale="en"
      isCurrent={() => true}
      onRefresh={returnVisit.refresh}
      onUpdatePage={(update) => value.setPage(update(value.page))}
      headingRef={heading}
      execute={value.execute}
      review={value.review}
      returnPending={returnVisit.pending && !returnVisit.failed}
      returnOutcome={outcome}
      onDeparturePair={returnVisit.inspect}
    />
  );
}

const rootRoute = createRootRoute({ component: () => <OwnVotesReturnProvider><Outlet /></OwnVotesReturnProvider> });
const ratingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library/ratings',
  component: RatingsScreen,
});
const subjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/subjects/$id/$slug',
  component: () => <p>Subject reader</p>,
});
const routeTree = rootRoute.addChildren([ratingsRoute, subjectRoute]);
// Route context is supplied outside the router so a return remount reads the current page value.
async function setup(
  initial: OwnVotesPage,
  execute: Harness['execute'],
  options: {
    state?: OwnVotesRead['state'];
    cursor?: string;
    review?: Harness['review'];
    recovered?: OwnVotesPage;
    refresh?: RefreshPlan;
  } = {},
) {
  const history = createMemoryHistory({ initialEntries: ['/library/ratings'] });
  const router = createRouter({ routeTree, history });
  const routeTrace: string[] = [];
  router.subscribe('onBeforeNavigate', ({ fromLocation, toLocation }) => {
    const key = (location: typeof toLocation | undefined) =>
      location && typeof location.state.key === 'string' ? location.state.key : 'none';
    routeTrace.push(`${fromLocation?.pathname ?? 'none'}:${key(fromLocation)}>${toLocation.pathname}:${key(toLocation)}`);
  });
  await router.load();
  const outside = window.document.createElement('button');
  outside.textContent = 'Other page control';
  window.document.body.append(outside);
  const { hydrateRoot } = await import('react-dom/client');
  const { renderToString } = await import('react-dom/server');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const calls: OwnVoteIntent[] = [];
  const refreshCount = { value: 0 };
  const reviewCalls: OwnVoteIntent[] = [];
  let replace: (page: OwnVotesPage, state?: OwnVotesRead['state']) => void;
  const refreshCursors: Array<string | null> = [];
  function Provider() {
    const [page, setPage] = useState(initial);
    const [state, setState] = useState(options.state ?? 'ready');
    replace = (next, nextState = 'ready') => {
      setPage(next);
      setState(nextState);
    };
    const value: Harness = {
      page,
      state,
      cursor: options.cursor ?? null,
      setPage,
      execute: async ({ data }) => {
        calls.push(data);
        return execute({ data });
      },
      review: async (input) => {
        reviewCalls.push(input.data.intent);
        return options.review ? options.review(input) : { kind: 'unavailable' };
      },
      refresh: async () => {
        refreshCount.value += 1;
        refreshCursors.push(options.cursor ?? null);
        if (options.refresh) return options.refresh({ page, replace });
        const refreshed = options.recovered ?? page;
        replace(refreshed);
        return {
          isSuccess: true,
          data: {
            state: 'ready',
            page: refreshed,
            subject: viewer,
            cursor: options.cursor ?? null,
            locale: 'en',
            source: 'rating.own_votes_page/v1',
          } satisfies OwnVotesRead,
        };
      },
    };
    return (
      <Context.Provider value={value}>
        <RouterProvider router={router} />
      </Context.Provider>
    );
  }
  const previousLocale = getLocale();
  await setLocale('en', { reload: false });
  const tree = <Provider />;
  host.innerHTML = renderToString(tree);
  const root = hydrateRoot(host, tree);
  await act(async () => new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined))));
  return {
    host,
    outside,
    window,
    router,
    routeTrace,
    calls,
    refreshCount,
    refreshCursors,
    reviewCalls,
    replace: async (page: OwnVotesPage, state?: OwnVotesRead['state']) => {
      await act(async () => replace(page, state));
    },
    close: async () => {
      await act(async () => root.unmount());
      outside.remove();
      await setLocale(previousLocale, { reload: false });
    },
  };
}

async function click(view: Awaited<ReturnType<typeof setup>>, button: Element) {
  await act(async () =>
    button.dispatchEvent(new view.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })),
  );
}

async function back(view: Awaited<ReturnType<typeof setup>>) {
  await act(async () => {
    view.router.history.back();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => new Promise((resolve) => view.window.requestAnimationFrame(() => resolve(undefined))));
}

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('mounted journey keeps zero and original key, confirms exact readback, opens Subject and rereads on return', async () => {
  const original = row();
  const page: OwnVotesPage = { viewer: { accountId: viewer }, votes: [original, row(false, secondTarget)], next: null };
  const view = await setup(page, async ({ data }) => ({
    kind: 'acknowledged',
    readback: { kind: 'current', units: data.body?.units ?? -1, revision: 2, at: '2026-11-01T00:00:00.000Z' },
  }));
  try {
    expect(view.host.textContent).toContain('0 / 20');
    expect(view.host.querySelectorAll('[data-own-vote-pair]')).toHaveLength(2);
    const inspect = [...view.host.querySelectorAll('button')].find(
      (button) => button.textContent === m.library_my_ratings_inspect(),
    )!;
    await click(view, inspect);
    await click(
      view,
      [...view.host.querySelectorAll('button')].find((button) => button.textContent === m.library_my_ratings_edit())!,
    );
    await click(
      view,
      [...view.host.querySelectorAll('button')].find((button) => button.textContent === m.library_my_ratings_save())!,
    );
    await act(async () => Promise.resolve());
    expect(view.calls).toHaveLength(1);
    expect(view.calls[0]).toMatchObject({
      targetId: target,
      questionId: question,
      path: `/v1/subjects/${target}/ratings/${question}/vote`,
      body: { units: 0 },
    });
    expect(view.host.textContent).toContain(m.library_my_ratings_saved());
    await click(
      view,
      [...view.host.querySelectorAll('a')].find((link) => link.textContent === 'Kokoro')!,
    );
    expect(view.host.textContent).toContain('Subject reader');
    await back(view);
    if (view.refreshCount.value !== 1)
      throw new Error(JSON.stringify({ routeTrace: view.routeTrace, receiptTrace, location: view.router.state.location }));
    expect(view.refreshCount.value).toBe(1);
    if (!view.host.querySelector('[data-own-vote-return-status]'))
      throw new Error(JSON.stringify({ routeTrace: view.routeTrace, receiptTrace, callbackTrace, text: view.host.textContent }));
    expect(view.host.textContent).toContain(m.library_my_ratings_return_found());
    expect(view.window.document.activeElement).toBe(
      view.host.querySelector(`[data-own-vote-target="${target}"][data-own-vote-question="${question}"] button`),
    );
    expect(view.calls).toHaveLength(1);
    await click(view, button(view, m.library_my_ratings_inspect()));
    await click(view, [...view.host.querySelectorAll('a')].find((link) => link.textContent === 'Kokoro')!);
    await back(view);
    expect(view.refreshCount.value).toBe(2);
    expect(view.host.textContent).toContain(m.library_my_ratings_return_found());
  } finally {
    await view.close();
  }
});

test('failed return stays unavailable until the user retries the same page', async () => {
  const page = pageOf(row());
  let attempts = 0;
  const view = await setup(page, async () => ({ kind: 'uncertain' }), {
    refresh: async ({ replace }) => {
      attempts += 1;
      if (attempts === 1) return { isSuccess: false };
      replace(page);
      return {
        isSuccess: true,
        data: { state: 'ready', page, subject: viewer, cursor: null, locale: 'en', source: 'rating.own_votes_page/v1' },
      };
    },
  });
  try {
    await click(view, button(view, m.library_my_ratings_inspect()));
    await click(view, [...view.host.querySelectorAll('a')].find((link) => link.textContent === 'Kokoro')!);
    await back(view);
    await act(async () => new Promise((resolve) => view.window.requestAnimationFrame(() => resolve(undefined))));
    expect(view.refreshCount.value).toBe(1);
    if (!view.host.textContent?.includes(m.library_my_ratings_unavailable()))
      throw new Error(JSON.stringify({ attempts, routeTrace: view.routeTrace, receiptTrace, callbackTrace, text: view.host.textContent }));
    expect(view.host.textContent).toContain(m.library_my_ratings_unavailable());
    expect(view.host.textContent).not.toContain(m.library_my_ratings_sparse());
    await click(view, button(view, m.library_my_ratings_retry_page()));
    await act(async () => new Promise((resolve) => view.window.requestAnimationFrame(() => resolve(undefined))));
    expect(view.refreshCount.value).toBe(2);
    expect(view.host.textContent).toContain(m.library_my_ratings_return_found());
    expect(view.calls).toHaveLength(0);
  } finally {
    await view.close();
  }
});

test('a missing original pair is reported on the admitted sparse page without scanning its continuation', async () => {
  const first = pageOf(row());
  const sparse: OwnVotesPage = { viewer: { accountId: viewer }, votes: [], next: 'opaque-next/+sealed=' };
  const pending = deferred<unknown>();
  const view = await setup(first, async () => ({ kind: 'uncertain' }), {
    refresh: async ({ replace }) => {
      const result = await pending.promise;
      replace(sparse);
      return result;
    },
  });
  try {
    await click(view, button(view, m.library_my_ratings_inspect()));
    await click(view, [...view.host.querySelectorAll('a')].find((link) => link.textContent === 'Kokoro')!);
    await back(view);
    view.outside.focus();
    pending.resolve({
      isSuccess: true,
      data: { state: 'ready', page: sparse, subject: viewer, cursor: null, locale: 'en', source: 'rating.own_votes_page/v1' },
    });
    await act(async () => pending.promise);
    await act(async () => new Promise((resolve) => view.window.requestAnimationFrame(() => resolve(undefined))));
    expect(view.host.textContent).toContain(m.library_my_ratings_return_missing());
    expect(view.host.textContent).toContain(m.library_my_ratings_sparse());
    expect(view.host.querySelector('a[href*="cursor"]')?.getAttribute('href')).toContain(encodeURIComponent(sparse.next!));
    expect(view.refreshCount.value).toBe(1);
    expect(view.window.document.activeElement).toBe(view.outside);
  } finally {
    await view.close();
  }
});

test('retired journey confirms Clear, treats readback 404 as cleared and preserves continuation', async () => {
  const page: OwnVotesPage = { viewer: { accountId: viewer }, votes: [row(true)], next: 'opaque-next' };
  const view = await setup(page, async () => ({ kind: 'acknowledged', readback: { kind: 'cleared' } }));
  try {
    await click(
      view,
      [...view.host.querySelectorAll('button')].find(
        (button) => button.textContent === m.library_my_ratings_inspect(),
      )!,
    );
    await click(
      view,
      [...view.host.querySelectorAll('button')].find((button) => button.textContent === m.library_my_ratings_clear())!,
    );
    const confirm = [...view.window.document.body.querySelectorAll('button')].find(
      (button) => button.textContent === m.library_my_ratings_confirm_clear(),
    )!;
    await click(view, confirm);
    await act(async () => Promise.resolve());
    expect(view.calls[0]).toMatchObject({ method: 'DELETE', targetId: target, questionId: question });
    expect(view.host.textContent).toContain(m.library_my_ratings_cleared());
    expect(view.host.textContent).not.toContain(m.library_my_ratings_sparse());
    expect(view.host.querySelector('a[href*="cursor"]')?.getAttribute('href')).toContain(
      encodeURIComponent('opaque-next'),
    );
  } finally {
    await view.close();
  }
});

const button = (view: Awaited<ReturnType<typeof setup>>, label: string) =>
  [...view.host.querySelectorAll('button')].find((item) => item.textContent === label)!;
const pageOf = (entry: OwnVoteEntry): OwnVotesPage => ({ viewer: { accountId: viewer }, votes: [entry], next: null });
const readOnly = (entry = row()): OwnVoteEntry => ({
  ...entry,
  actions: { state: 'unavailable', reason: 'read_only' },
});

test('read-only zero and nonzero answers keep their original meaning and Subject navigation without command actions', async () => {
  for (const units of [0, 6]) {
    const original = readOnly({ ...row(), own: { ...row().own, units } });
    const view = await setup(pageOf(original), async () => {
      throw new Error('No command admitted');
    });
    try {
      await click(view, button(view, m.library_my_ratings_inspect()));
      expect(view.host.textContent).toContain(m.library_my_ratings_read_only());
      expect(view.host.textContent).toContain(`${units} / 20`);
      expect(view.host.textContent).toContain(original.question.label);
      expect(view.host.textContent).toContain(`${target} · ${question}`);
      expect(view.host.querySelector('time')?.getAttribute('datetime')).toBe(original.own.at);
      expect(view.host.querySelector('a')?.getAttribute('href')).toContain(terminal);
      expect(view.host.querySelector('section button')).toBeNull();
      expect(view.calls).toHaveLength(0);
    } finally {
      await view.close();
    }
  }
});

test('replacement advice retires drafts, delayed commands and delayed exact readback; fresh edit requires selection', async () => {
  for (const delayed of ['draft', 'command', 'review']) {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const current: OwnVoteReadback = { kind: 'current', units: 8, revision: 2, at: row().own.at };
    const view = await setup(
      pageOf(row()),
      async () => {
        if (delayed === 'command') {
          await pending;
          return { kind: 'acknowledged', readback: current };
        }
        return { kind: 'uncertain' };
      },
      {
        review: async () => {
          await pending;
          return current;
        },
      },
    );
    try {
      await click(view, button(view, m.library_my_ratings_inspect()));
      await click(view, button(view, m.library_my_ratings_edit()));
      if (delayed !== 'draft') await click(view, button(view, m.library_my_ratings_save()));
      if (delayed === 'review') await click(view, button(view, m.library_my_ratings_review_original()));
      await view.replace(pageOf(readOnly()));
      expect(view.host.querySelector('input')).toBeNull();
      await click(view, button(view, m.library_my_ratings_inspect()));
      expect(view.host.textContent).toContain(m.library_my_ratings_read_only());
      await act(async () => resolve());
      expect(view.host.textContent).not.toContain('8 / 20');
      expect(view.host.textContent).not.toContain(m.library_my_ratings_saved());
      await view.replace(pageOf(row()));
      expect(button(view, m.library_my_ratings_edit())).toBeUndefined();
      await click(view, button(view, m.library_my_ratings_inspect()));
      expect(button(view, m.library_my_ratings_edit())).toBeDefined();
      expect(view.calls).toHaveLength(delayed === 'draft' ? 0 : 1);
    } finally {
      await view.close();
    }
  }
});

test('a matching newer exact read leaves an uncertain original intent available for explicit identical replay', async () => {
  const view = await setup(pageOf(row()), async () => ({ kind: 'uncertain' }), {
    review: async () => ({ kind: 'current', units: 0, revision: 9, at: row().own.at }),
  });
  try {
    await click(view, button(view, m.library_my_ratings_inspect()));
    await click(view, button(view, m.library_my_ratings_edit()));
    await click(view, button(view, m.library_my_ratings_save()));
    await click(view, button(view, m.library_my_ratings_review_original()));
    expect(view.host.textContent).toContain(m.library_my_ratings_uncertain_text());
    await click(view, button(view, m.library_my_ratings_retry_original()));
    expect(view.calls).toHaveLength(2);
    expect(view.calls[1]).toBe(view.calls[0]);
    expect(view.reviewCalls[0]).toBe(view.calls[0]);
  } finally {
    await view.close();
  }
});

test('dependency recovery retries the identical cursor and keeps concealed continuation, empty and revoked outcomes distinct', async () => {
  const cursor = 'sealed/+opaque=';
  const sparse: OwnVotesPage = { viewer: { accountId: viewer }, votes: [], next: 'next/+sealed=' };
  const view = await setup(pageOf(row()), async () => ({ kind: 'uncertain' }), {
    state: 'unavailable',
    cursor,
    recovered: sparse,
  });
  try {
    expect(view.host.textContent).toContain(m.library_my_ratings_unavailable());
    expect(view.host.querySelectorAll('[data-own-vote-pair]')).toHaveLength(0);
    await click(view, button(view, m.library_my_ratings_retry_page()));
    expect(view.refreshCursors).toEqual([cursor]);
    expect(view.host.textContent).toContain(m.library_my_ratings_sparse());
    expect(view.host.querySelector('a[href*="cursor"]')?.getAttribute('href')).toContain(
      encodeURIComponent(sparse.next!),
    );
    await view.replace({ ...sparse, next: null });
    expect(view.host.textContent).toContain(m.library_my_ratings_empty());
    await view.replace(pageOf(row()), 'denied');
    expect(view.host.textContent).toContain(m.library_my_ratings_denied());
    expect(view.host.textContent).not.toContain(m.library_my_ratings_empty());
    expect(view.host.querySelectorAll('a')).toHaveLength(0);
    await view.replace(pageOf(row()), 'signed-out');
    expect(view.host.textContent).toContain(m.library_my_ratings_signed_out());
  } finally {
    await view.close();
  }
});
