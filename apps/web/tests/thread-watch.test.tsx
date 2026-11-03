import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { m } from '../src/paraglide/messages.js';
import { ThreadWatch, type ThreadWatchProps } from '../src/threads/thread-watch';
import type { ThreadWatchCommand, ThreadWatchNative, ThreadWatchReadRequest } from '../src/threads/thread-watch-native';

const window = new Window({ url: 'https://site.test/en/threads/thread-a/readable' });
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  MouseEvent: window.MouseEvent,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

let host: HTMLDivElement;
let root: Root;
const baseline: ThreadWatchProps = {
  threadId: 'thread-a',
  session: 'signed-in',
  sessionKnown: true,
  viewerId: 'reader-a',
  sessionStamp: 'admission-a:session-1',
  admitted: true,
  returnTo: '/threads/thread-a/readable',
};

function render(props: ThreadWatchProps) {
  act(() => root.render(<ThreadWatch {...props} />));
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
    target!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test('unknown command outcome offers the identical retry and confirms native 204', async () => {
  const reads: ThreadWatchReadRequest[] = [];
  const commands: ThreadWatchCommand[] = [];
  const native: ThreadWatchNative = {
    async read(request) {
      reads.push(request);
      return { kind: 'confirmed', state: { watching: false } };
    },
    async set(command) {
      commands.push(command);
      if (commands.length === 1) throw new Error('lost response');
      return { kind: 'confirmed' };
    },
  };
  render({ ...baseline, native });
  await settle();
  expect(button(m.thread_watch_watch())).toBeDefined();
  expect(reads[0]?.fetch.cache).toBe('no-store');
  expect(host.querySelector('a[href="/settings#notifications"]')).not.toBeNull();
  await click(m.thread_watch_watch());
  expect(button(m.thread_watch_retry_exact())).toBeDefined();
  expect(host.textContent).toContain(m.thread_watch_outcome_unknown());
  expect(Object.isFrozen(commands[0])).toBe(true);
  expect(commands[0]).toMatchObject({
    threadId: 'thread-a',
    viewerId: 'reader-a',
    sessionStamp: 'admission-a:session-1',
    watching: true,
  });
  await click(m.thread_watch_retry_exact());
  expect(commands).toHaveLength(2);
  expect(commands[0]).toBe(commands[1]);
  expect(reads).toHaveLength(1);
  expect(button(m.thread_watch_stop())).toBeDefined();
  expect(host.textContent).toContain(m.thread_watch_confirm_started());
});

test('refusal requires a fresh read and never reports an unwatched state', async () => {
  let readCount = 0;
  const commands: ThreadWatchCommand[] = [];
  const native: ThreadWatchNative = {
    async read() {
      readCount++;
      return { kind: 'confirmed', state: { watching: readCount === 1 } };
    },
    async set(command) {
      commands.push(command);
      return { kind: 'refused', reason: 'refused' };
    },
  };
  render({ ...baseline, native });
  await settle();
  await click(m.thread_watch_stop());
  expect(commands).toHaveLength(1);
  expect(host.textContent).toContain(m.thread_watch_refused());
  expect(button(m.thread_watch_check_again())).toBeDefined();
  expect(button(m.thread_watch_watch())).toBeUndefined();
  await click(m.thread_watch_check_again());
  expect(readCount).toBe(2);
  expect(button(m.thread_watch_watch())).toBeDefined();
  expect(host.textContent).not.toContain(m.thread_watch_confirm_stopped());
});

test('viewer replacement and access loss retire private state; anonymous reading makes no private read', async () => {
  const reads: ThreadWatchReadRequest[] = [];
  const commands: ThreadWatchCommand[] = [];
  let releaseCommand!: (value: Awaited<ReturnType<ThreadWatchNative['set']>>) => void;
  const lateCommand = new Promise<Awaited<ReturnType<ThreadWatchNative['set']>>>((resolve) => {
    releaseCommand = resolve;
  });
  const native: ThreadWatchNative = {
    async read(request) {
      reads.push(request);
      return request.viewerId === 'reader-a'
        ? { kind: 'confirmed', state: { watching: true } }
        : { kind: 'access-lost' };
    },
    async set(command) {
      commands.push(command);
      return lateCommand;
    },
  };
  render({ ...baseline, native });
  await settle();
  expect(host.textContent).toContain(m.thread_watch_watching());
  await click(m.thread_watch_stop());
  render({ ...baseline, threadId: 'thread-b', viewerId: 'reader-b', sessionStamp: 'admission-b:session-1', native });
  await settle();
  releaseCommand({ kind: 'confirmed' });
  await settle();
  expect(reads.map((request) => request.viewerId)).toEqual(['reader-a', 'reader-b']);
  expect(reads.map((request) => request.threadId)).toEqual(['thread-a', 'thread-b']);
  expect(commands).toHaveLength(1);
  expect(host.textContent).toContain(m.thread_watch_access_lost());
  expect(host.textContent).not.toContain(m.thread_watch_watching());
  expect(host.textContent).not.toContain(m.thread_watch_not_watching());
  render({
    ...baseline,
    session: 'signed-out',
    viewerId: undefined,
    sessionStamp: 'anonymous',
    native,
  });
  await settle();
  expect(reads).toHaveLength(2);
  expect(host.textContent).toContain(m.thread_watch_anonymous());
});

test('explicit status recovery preserves an unknown requested state on failure, then establishes current status', async () => {
  const commands: ThreadWatchCommand[] = [];
  let reads = 0;
  const native: ThreadWatchNative = {
    async read() {
      reads++;
      if (reads === 2) return { kind: 'unknown' };
      return { kind: 'confirmed', state: { watching: false } };
    },
    async set(command) {
      commands.push(command);
      return { kind: 'unknown' };
    },
  };
  render({ ...baseline, native });
  await settle();
  await click(m.thread_watch_watch());
  expect(button(m.thread_watch_check_again())).toBeDefined();
  await click(m.thread_watch_check_again());
  expect(host.textContent).toContain(m.thread_watch_read_failed());
  await click(m.thread_watch_retry_exact());
  expect(commands[1]).toBe(commands[0]);
  await click(m.thread_watch_check_again());
  expect(reads).toBe(3);
  expect(button(m.thread_watch_watch())).toBeDefined();
  expect(button(m.thread_watch_retry_exact())).toBeUndefined();
  expect(host.textContent).not.toContain(m.thread_watch_confirm_started());
});

test('initial read failure recovers deliberately; synchronous double clicks use one request slot', async () => {
  let reads = 0;
  let commands = 0;
  let finish!: (value: Awaited<ReturnType<ThreadWatchNative['set']>>) => void;
  const native: ThreadWatchNative = {
    async read() {
      return ++reads === 1 ? { kind: 'unknown' } : { kind: 'confirmed', state: { watching: false } };
    },
    async set() {
      commands++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  render({ ...baseline, native });
  await settle();
  expect(host.textContent).toContain(m.thread_watch_read_failed());
  await click(m.thread_watch_check_again());
  const watch = button(m.thread_watch_watch())!;
  act(() => {
    watch.focus();
    watch.click();
    watch.click();
  });
  expect(commands).toBe(1);
  expect(host.getAttribute('aria-busy') ?? host.firstElementChild?.getAttribute('aria-busy')).toBe('true');
  expect(button(m.thread_watch_check_again())).toBeUndefined();
  finish({ kind: 'confirmed' });
  await settle();
  expect(document.activeElement?.textContent).toBe(m.thread_watch_stop());
  expect(reads).toBe(2);
});

test('response-before-retirement clears confirmation; readiness, target and source changes retire old actions', async () => {
  const commands: ThreadWatchCommand[] = [];
  const native: ThreadWatchNative = {
    async read() {
      return { kind: 'confirmed', state: { watching: false } };
    },
    async set(command) {
      commands.push(command);
      return { kind: 'confirmed' };
    },
  };
  let current = true;
  const authority = {};
  render({ ...baseline, native, readAuthority: authority, isCurrent: () => current });
  await settle();
  await click(m.thread_watch_watch());
  expect(host.textContent).toContain(m.thread_watch_confirm_started());
  const staleStop = button(m.thread_watch_stop())!;
  current = false;
  act(() => staleStop.click());
  await settle();
  expect(commands).toHaveLength(1);
  expect(host.textContent).not.toContain(m.thread_watch_confirm_started());
  render({ ...baseline, sessionKnown: false, native });
  await settle();
  expect(button(m.thread_watch_stop())).toBeUndefined();
  render({ ...baseline, native, threadId: 'thread-b', readAuthority: {} });
  await settle();
  await click(m.thread_watch_watch());
  expect(commands[1]?.threadId).toBe('thread-b');
  render({ ...baseline, native, admitted: false });
  await settle();
  expect(host.textContent).toContain(m.thread_watch_access_lost());
  expect(host.textContent).not.toContain(m.thread_watch_confirm_started());
});

afterAll(async () => {
  await window.happyDOM.waitUntilComplete();
  await window.happyDOM.close();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
