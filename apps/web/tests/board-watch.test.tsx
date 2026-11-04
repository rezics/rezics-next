import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';
import { BoardWatchControl, type BoardWatchControlProps } from '../src/threads/board-watch/control';
import type { BoardWatchCommand, BoardWatchNative, BoardWatchPage, BoardWatchReadRequest } from '../src/threads/board-watch/contract';

const browser = new Window({ url: 'https://site.test/en/boards/board-a?sort=new' });
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  MouseEvent: browser.MouseEvent,
  Node: browser.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const page = (boardId: string, watching: boolean, revision: number, advice: 'available' | 'denied' = 'available'): BoardWatchPage => ({
  boardId,
  accountId: 'reader-a',
  viewer: { state: 'current', watching, revision },
  actions: { watch: watching ? 'not-applicable' : advice, unwatch: watching ? advice : 'not-applicable' },
  source: { epoch: 1, position: String(revision + 10) },
});

const baseline: BoardWatchControlProps = {
  boardId: 'board-a',
  returnTo: '/en/boards/board-a?sort=new&cursor=return-here',
  session: { state: 'signed-in', subject: 'reader-a', csrfToken: 'csrf-original' },
  authority: { key: 'board-visit-a', isCurrent: () => true },
};

let host: HTMLDivElement;
let root: Root;

function render(props: BoardWatchControlProps) {
  act(() => root.render(<BoardWatchControl {...props} />));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string) {
  return [...host.querySelectorAll('button')].find((item) => item.textContent === label);
}

async function click(label: string) {
  const target = button(label);
  expect(target).toBeDefined();
  await act(async () => {
    target!.dispatchEvent(new browser.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

beforeEach(() => {
  setLocale('en', { reload: false });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

afterAll(() => {
  browser.happyDOM.abort();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('Board page watch uses the admitted revision and separates the original acknowledgement from current state', async () => {
  const reads: BoardWatchReadRequest[] = [];
  const commands: BoardWatchCommand[] = [];
  let readNumber = 0;
  const native: BoardWatchNative = {
    async read(request) {
      reads.push(request);
      readNumber++;
      if (readNumber === 1) return { kind: 'current', page: page('board-a', false, 7) };
      if (readNumber === 2) return { kind: 'current', page: page('board-a', true, 8) };
      return { kind: 'current', page: page('board-a', false, 9) };
    },
    async set(command) {
      commands.push(command);
      if (commands.length === 1) return { kind: 'unknown' };
      return { kind: 'acknowledged', watching: command.watching, revision: command.expectedRevision + 1 };
    },
  };
  render({ ...baseline, native });
  await settle();
  const start = button(m.board_watch_start());
  expect(start).toBeDefined();
  start!.focus();
  expect(document.activeElement).toBe(start);
  await click(m.board_watch_start());
  expect(commands).toHaveLength(1);
  expect(Object.isFrozen(commands[0])).toBe(true);
  expect(commands[0]).toMatchObject({
    boardId: 'board-a',
    accountId: 'reader-a',
    csrfToken: 'csrf-original',
    watching: true,
    expectedRevision: 7,
  });
  expect(commands[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
  expect(button(m.board_watch_retry_exact())).toBeDefined();

  await click(m.board_watch_check_again());
  expect(reads).toHaveLength(2);
  expect(host.textContent).toContain(m.board_watch_current_watching());
  expect(button(m.board_watch_start())).toBeUndefined();
  expect(button(m.board_watch_retry_exact())).toBeDefined();

  await click(m.board_watch_retry_exact());
  expect(commands).toHaveLength(2);
  expect(commands[1]).toBe(commands[0]);
  expect(reads).toHaveLength(3);
  expect(host.textContent).toContain(m.board_watch_current_not_watching());
  expect(host.textContent).toContain(m.board_watch_command_acknowledged());
  expect(host.textContent).not.toContain(m.board_watch_current_watching());
});

test('denied advice and unavailable reads preserve read-only Board content with a separate state retry', async () => {
  for (const result of [
    { kind: 'current' as const, page: page('board-a', false, 2, 'denied') },
    { kind: 'unavailable' as const },
  ]) {
    const native: BoardWatchNative = {
      async read() {
        return result;
      },
      async set() {
        throw new Error('denied and unavailable reads must not expose a command');
      },
    };
    render({ ...baseline, native });
    await settle();
    expect(button(m.board_watch_start())).toBeUndefined();
    expect(button(m.board_watch_check_again())).toBeDefined();
    if (result.kind === 'current') expect(host.textContent).toContain(m.board_watch_read_only());
    else expect(host.textContent).toContain(m.board_watch_unavailable());
    await act(async () => root.render(<div />));
  }
});

test('a revision conflict requires explicit current-state inspection', async () => {
  let reads = 0;
  const native: BoardWatchNative = {
    async read() {
      reads++;
      return reads === 1 ? { kind: 'conflict' } : { kind: 'current', page: page('board-a', false, 4) };
    },
    async set() {
      throw new Error('a conflicted state must not start a command');
    },
  };
  render({ ...baseline, native });
  await settle();
  expect(reads).toBe(1);
  expect(host.textContent).toContain(m.board_watch_conflict());
  expect(button(m.board_watch_start())).toBeUndefined();
  await click(m.board_watch_check_again());
  expect(reads).toBe(2);
  expect(button(m.board_watch_start())).toBeDefined();
});

test('signed-out readers get a safe Board return and make no private request', async () => {
  let reads = 0;
  const native: BoardWatchNative = {
    async read() {
      reads++;
      return { kind: 'unknown' };
    },
    async set() {
      return { kind: 'unknown' };
    },
  };
  render({ ...baseline, session: { state: 'signed-out', subject: null, csrfToken: null }, native });
  await settle();
  expect(reads).toBe(0);
  const link = [...host.querySelectorAll('a')].find((item) => item.textContent === m.board_watch_sign_in());
  expect(link?.getAttribute('href')).toBe(
    `/auth/sign-in?return_to=${encodeURIComponent(baseline.returnTo)}`,
  );
});

test('retiring a Board page visit rejects its late watch receipt and keeps the replacement authority', async () => {
  let release!: (result: Awaited<ReturnType<BoardWatchNative['set']>>) => void;
  const late = new Promise<Awaited<ReturnType<BoardWatchNative['set']>>>((resolve) => (release = resolve));
  const commands: BoardWatchCommand[] = [];
  const native: BoardWatchNative = {
    async read(request) {
      return { kind: 'current', page: page(request.boardId, request.boardId === 'board-b', 5) };
    },
    async set(command) {
      commands.push(command);
      return late;
    },
  };
  render({ ...baseline, native });
  await settle();
  await click(m.board_watch_start());
  render({
    ...baseline,
    boardId: 'board-b',
    authority: { key: 'board-visit-b', isCurrent: () => true },
    native,
  });
  await settle();
  release({ kind: 'acknowledged', watching: true, revision: 6 });
  await settle();
  expect(commands).toHaveLength(1);
  expect(commands[0]?.boardId).toBe('board-a');
  expect(host.textContent).toContain(m.board_watch_current_watching());
  expect(host.textContent).not.toContain(m.board_watch_command_acknowledged());
});
