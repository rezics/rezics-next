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

test('unknown command outcome permits only the identical retry and confirms native success', async () => {
  const reads: ThreadWatchReadRequest[] = [];
  const commands: ThreadWatchCommand[] = [];
  const native: ThreadWatchNative = {
    async read(request) {
      reads.push(request);
      return { kind: 'confirmed', state: { watching: false, revision: 'revision-1' } };
    },
    async set(command) {
      commands.push(command);
      if (commands.length === 1) throw new Error('lost response');
      return { kind: 'confirmed', state: { watching: true, revision: 'revision-2' } };
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
    expectedRevision: 'revision-1',
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
      return { kind: 'confirmed', state: { watching: readCount === 1, revision: `revision-${readCount}` } };
    },
    async set(command) {
      commands.push(command);
      return { kind: 'refused', reason: 'conflict' };
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
        ? { kind: 'confirmed', state: { watching: true, revision: 'revision-a' } }
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
  releaseCommand({ kind: 'confirmed', state: { watching: false, revision: 'revision-a2' } });
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

afterAll(async () => {
  await window.happyDOM.waitUntilComplete();
  await window.happyDOM.close();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
