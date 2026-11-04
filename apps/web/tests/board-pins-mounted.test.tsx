import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { setLocale } from '../src/paraglide/runtime.js';
import { createKernelClient } from '@rezics/client';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { continuationBoardId, continuationCursor } from '../src/kernel/fake/board-continuation';
import type { BoardPinAdviceQuery, BoardPinAdviceResult } from '../src/threads/board-pins/advice';
import type {
  BoardPinBoardRead,
  BoardPinCommand,
  BoardPinProducer,
  BoardPinSender,
} from '../src/threads/board-pins/contract';
import type { BoardFeedThread, CommunityBoardPage } from '../src/threads/board-feed-data';
import { loadBoardPageWithAuthors } from '../src/identity/page-loaders';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/boards/current', width: 390, height: 844 });
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
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  KeyboardEvent: window.KeyboardEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: () => {},
  IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { m } = await import('../src/paraglide/messages.js');
const { BoardFeed } = await import('../src/threads/board-feed');

afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const sender: BoardPinSender = { subject: 'moderator-subject', csrfToken: 'current-csrf' };
function sourceRevision(thread: CommunityBoardPage['threads']['threads'][number]): string {
  if (thread.firstPost.availability !== 'available') throw new Error('Expected a disclosed opening revision.');
  return thread.firstPost.revisionId;
}
const pinnedAdvice = (page: CommunityBoardPage, full = false): BoardPinAdviceResult => {
  const pinned = page.threads.pinnedThreads[0];
  const ordinary = page.threads.threads[0];
  const thread = pinned ?? ordinary!;
  return {
    state: 'ready',
    viewer: { kind: 'account', id: sender.subject },
    boardId: page.board.id,
    pinRevision: '12',
    management: 'allowed',
    threads: [
      {
        threadId: thread.id,
        pinned: !!pinned,
        actions: pinned ? ['unpin'] : full ? [] : ['pin'],
      },
    ],
  };
};

async function pageFixture(): Promise<CommunityBoardPage> {
  const loaded = await loadBoardPageWithAuthors(
    createKernelClient('https://kernel.test', { fetch: createStoryRecordedKernelFetch() }),
    { id: continuationBoardId, cursor: continuationCursor },
  );
  const ordinary = loaded.threads.threads[0]!;
  if (ordinary.firstPost.availability !== 'available')
    throw new Error('The recorded Board source needs a disclosed opening revision.');
  return {
    ...loaded,
    threads: {
      ...loaded.threads,
      threads: [ordinary],
      next: null,
      pinRevision: '12',
    },
  };
}

async function mount(
  page: CommunityBoardPage,
  inspect: (query: BoardPinAdviceQuery) => Promise<BoardPinAdviceResult>,
  work: { change?: BoardPinProducer['change']; readBoard?: BoardPinProducer['readBoard'] } = {},
) {
  const queries: BoardPinAdviceQuery[] = [];
  const producer: BoardPinProducer = {
    async inspectSelected(query) {
      queries.push(query);
      return inspect(query);
    },
    async readPage() {
      return { state: 'unavailable' };
    },
    change: work.change ?? (async () => ({ state: 'unavailable' })),
    ...(work.readBoard ? { readBoard: work.readBoard } : {}),
  };
  const route = createRootRoute({
    component: () =>
      createElement(BoardFeed, {
        boardId: page.board.id,
        sort: 'active',
        page: page.threads,
        authors: page.authors,
        now: page.now,
        pinProducer: producer,
        pinSender: sender,
      }),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const client = new QueryClient();
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    host,
    queries,
    async close() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('mounted Board pin controls use only exact current selected advice and preserve unavailable, capacity, and stale outcomes', async () => {
  setLocale('en', { reload: false });
  const page = await pageFixture();
  const ordinary = page.threads.threads[0]!;
  const allowed = await mount(page, async () => pinnedAdvice(page));
  expect(allowed.queries).toHaveLength(1);
  expect(allowed.queries[0]?.selected).toEqual([
    { threadId: ordinary.id, placeId: page.board.id, sourceRevisionId: sourceRevision(ordinary) },
  ]);
  expect([...allowed.host.querySelectorAll('[data-board-pin-focus="toggle"]')].map((node) => node.textContent)).toEqual(
    [m.board_pin_pin()],
  );
  await allowed.close();

  const missingGeneration = { ...page, threads: { ...page.threads, pinRevision: undefined } };
  const unavailable = await mount(missingGeneration, async () => pinnedAdvice(page));
  expect(unavailable.queries).toHaveLength(0);
  expect(unavailable.host.textContent).toContain(m.board_pin_unavailable());
  expect(unavailable.host.querySelector('[data-board-pin-focus="toggle"]')).toBeNull();
  await unavailable.close();

  const sourcePost = ordinary.firstPost;
  if (sourcePost.availability !== 'available') throw new Error('Expected an available opening post.');
  const missingSourceThread: BoardFeedThread = {
    ...ordinary,
    firstPost: {
      id: sourcePost.id,
      threadId: sourcePost.threadId,
      route: sourcePost.route,
      parentId: sourcePost.parentId,
      removed: true,
      availability: 'erased',
      body: null,
      sha256: null,
    },
  };
  const missingSourcePage = {
    ...page,
    threads: { ...page.threads, threads: [missingSourceThread] },
  };
  const sourceUnavailable = await mount(missingSourcePage, async () => pinnedAdvice(page));
  expect(sourceUnavailable.queries).toHaveLength(0);
  expect(sourceUnavailable.host.textContent).toContain(m.board_pin_unavailable());
  expect(sourceUnavailable.host.querySelector('[data-board-pin-focus="toggle"]')).toBeNull();
  await sourceUnavailable.close();

  const full = await mount(page, async () => pinnedAdvice(page, true));
  expect(full.host.textContent).toContain(m.board_pin_full());
  expect(full.host.querySelector('[data-board-pin-focus="toggle"]')).toBeNull();
  await full.close();

  const pinnedPage = { ...page, threads: { ...page.threads, pinnedThreads: [ordinary], threads: [] } };
  const pinnedControl = await mount(pinnedPage, async () => pinnedAdvice(pinnedPage));
  expect(pinnedControl.host.querySelector('[data-board-pin-focus="toggle"]')?.textContent).toBe(m.board_pin_unpin());
  await pinnedControl.close();

  const readOnly = await mount(page, async () => {
    const result = pinnedAdvice(page);
    return result.state === 'ready'
      ? { ...result, management: 'denied' as const, threads: result.threads.map((row) => ({ ...row, actions: [] })) }
      : result;
  });
  expect(readOnly.host.textContent).toContain(m.board_pin_read_only());
  expect(readOnly.host.querySelector('[data-board-pin-focus="toggle"]')).toBeNull();
  await readOnly.close();

  const denied = await mount(page, async () => ({ state: 'denied' }));
  expect(denied.host.textContent).toContain(m.board_pin_read_denied());
  expect(denied.host.querySelector('[data-board-pin-focus="toggle"]')).toBeNull();
  await denied.close();

  const stale = await mount(page, async () => ({ state: 'stale' }));
  expect(stale.host.textContent).toContain(m.board_reading_restart_help());
  expect(stale.host.textContent).toContain(m.board_reading_restart());
  expect(stale.host.querySelector('[data-board-pin-focus="toggle"]')).toBeNull();
  expect(stale.host.querySelector('a[href*="cursor="]')).toBeNull();
  await stale.close();
});

test('unknown retry keeps its original command and missing rows move focus to the announced recovery region', async () => {
  setLocale('en', { reload: false });
  const page = await pageFixture();
  const ordinary = page.threads.threads[0]!;
  const commands: BoardPinCommand[] = [];
  const inspections: BoardPinAdviceQuery[] = [];
  const advice = async (query: BoardPinAdviceQuery): Promise<BoardPinAdviceResult> => {
    inspections.push(query);
    return {
      state: 'ready',
      viewer: { kind: 'account', id: sender.subject },
      boardId: page.board.id,
      pinRevision: query.pinRevision ?? '12',
      management: 'allowed',
      threads: query.selected.map(({ threadId }) => ({
        threadId,
        pinned: false,
        actions: ['pin'] as const,
      })),
    };
  };
  const currentBoard: BoardPinBoardRead = {
    state: 'ready',
    boardId: page.board.id,
    management: 'allowed',
    pinRevision: '13',
    pinnedThreads: [],
    threads: [],
    next: null,
    rankRefreshedAt: null,
    authors: null,
  };
  const feed = await mount(page, advice, {
    async change(command) {
      commands.push(command);
      return commands.length === 1
        ? { state: 'unknown' }
        : {
            state: 'applied',
            boardId: page.board.id,
            thread: { threadId: ordinary.id, pinned: true, actions: ['unpin'] },
          };
    },
    async readBoard() {
      return currentBoard;
    },
  });
  const toggles = feed.host.querySelectorAll<HTMLButtonElement>('[data-board-pin-focus="toggle"]');
  expect(toggles).toHaveLength(1);
  await act(async () => {
    toggles[0]!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const dialog = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
  expect(dialog?.textContent).toContain(m.board_pin_confirm_title_pin());
  const confirm = dialog?.querySelectorAll<HTMLButtonElement>('button').item(1);
  expect(confirm).toBeDefined();
  await act(async () => {
    confirm!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(feed.host.textContent).toContain(m.board_pin_unknown());
  const retry = feed.host.querySelector<HTMLButtonElement>('[data-board-pin-focus="retry"]');
  expect(retry).toBeDefined();
  await act(async () => {
    retry!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(commands).toHaveLength(2);
  expect(commands[1]).toBe(commands[0]);
  expect(commands[0]).toMatchObject({ boardId: page.board.id, threadId: ordinary.id, action: 'pin', sender });
  expect(inspections).toHaveLength(1);
  expect(inspections[0]?.selected).toEqual([
    { threadId: ordinary.id, placeId: page.board.id, sourceRevisionId: sourceRevision(ordinary) },
  ]);
  const recovery = feed.host.querySelector<HTMLElement>('[data-slot="board-pin-focus-recovery"]');
  expect(recovery?.textContent).toBe(m.board_pin_focus_recovery());
  expect(document.activeElement).toBe(recovery);
  await feed.close();
});
