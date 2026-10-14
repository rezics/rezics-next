import { replaceModule } from '../../tests/support/module-replacement.ts';
import { afterAll, beforeEach, expect, test } from 'bun:test';
import type { Unread } from './unread.ts';

const originalReact = { ...(await import('react')) };
const originalFetch = globalThis.fetch;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const cleanup: (() => void)[] = [];
let focus: (() => void) | undefined;
let snapshot: () => Unread | null = () => null;

const restoreOriginalReact = replaceModule(import.meta.resolve('react'), originalReact, {
  useEffect: (effect: () => (() => void) | void) => { const stop = effect(); if (stop) cleanup.push(stop); },
  useSyncExternalStore: (_subscribe: unknown, read: () => Unread | null) => { snapshot = read; return read(); },
});
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  visibilityState: 'visible', addEventListener() {}, removeEventListener() {},
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  addEventListener(name: string, listener: () => void) { if (name === 'focus') focus = listener; },
  removeEventListener() { focus = undefined; },
} });
const { setUnread, setUnreadGeneration, useUnread, beginNotificationRequest, isNotificationRequestCurrent } = await import('./unread.ts');

beforeEach(() => {
  for (const stop of cleanup.splice(0)) stop();
  setUnread(null);
});
afterAll(async () => {
  for (const stop of cleanup.splice(0)) stop();
  setUnread(null);
  globalThis.fetch = originalFetch;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  restoreOriginalReact();
});

function pendingPoll() {
  let resolve!: (response: Response) => void;
  globalThis.fetch = (() => new Promise<Response>(done => { resolve = done; })) as unknown as typeof fetch;
  useUnread(true);
  return async (generation: string, count: number) => {
    resolve(Response.json({ profile: 'notification-unread-count-v1', generation, count, overflow: false }));
    await new Promise(done => setTimeout(done, 0));
  };
}

test('a poll from the old traversal cannot clear the new generation badge', async () => {
  setUnreadGeneration('1');
  const release = pendingPoll();
  setUnreadGeneration('2');
  setUnread({ generation: '2', count: 3, overflow: false });
  await release('1', 0);
  expect(snapshot()).toMatchObject({ generation: '2', count: 3 });
});

test('a count for another generation is dropped even if the traversal did not change while polling', async () => {
  setUnreadGeneration('2');
  setUnread({ generation: '2', count: 3, overflow: false });
  const release = pendingPoll();
  await release('1', 0);
  expect(snapshot()).toMatchObject({ generation: '2', count: 3 });
});

test('an older same-generation poll cannot overwrite a count just applied by a command', async () => {
  setUnreadGeneration('2');
  const release = pendingPoll();
  setUnread({ generation: '2', count: 1, overflow: false });
  await release('2', 4);
  expect(snapshot()).toMatchObject({ generation: '2', count: 1 });
});

for (const olderFirst of [true, false]) test(`overlapping polls keep the newest count (older first: ${olderFirst})`, async () => {
  setUnreadGeneration('2');
  const pending: ((response: Response) => void)[] = [];
  globalThis.fetch = (() => new Promise<Response>(resolve => pending.push(resolve))) as unknown as typeof fetch;
  useUnread(true);
  focus!();
  const release = async (index: number, count: number) => {
    pending[index]!(Response.json({ profile: 'notification-unread-count-v1', generation: '2', count, overflow: false }));
    await new Promise(done => setTimeout(done, 0));
  };
  if (olderFirst) { await release(0, 0); await release(1, 1); }
  else { await release(1, 1); await release(0, 0); }
  expect(snapshot()).toMatchObject({ generation: '2', count: 1 });
});

test('a delayed view count cannot replace a newer badge poll through the shared fence', async () => {
  setUnreadGeneration('2');
  const view = beginNotificationRequest();
  const release = pendingPoll();
  await release('2', 1);
  setUnread({ generation: '2', count: 0, overflow: false }, view);
  expect(snapshot()).toMatchObject({ generation: '2', count: 1 });
});

test('producer order is independent while count producers share their generation fence', () => {
  setUnreadGeneration('1');
  const count = beginNotificationRequest();
  const page = beginNotificationRequest('page');
  const mark = beginNotificationRequest('mark-all');
  expect(isNotificationRequestCurrent(count, '1')).toBe(true);
  expect(isNotificationRequestCurrent(page, '1')).toBe(true);
  expect(isNotificationRequestCurrent(mark, '2')).toBe(false);
  expect(isNotificationRequestCurrent(mark, '1')).toBe(true);
  beginNotificationRequest();
  expect(isNotificationRequestCurrent(count, '1')).toBe(false);
  expect(isNotificationRequestCurrent(page, '1')).toBe(true);
  setUnreadGeneration('2');
  expect(isNotificationRequestCurrent(mark, '1')).toBe(false);
});

test('a delayed reset count lands after a page producer starts', async () => {
  setUnreadGeneration('2');
  const release = pendingPoll();
  beginNotificationRequest('page');
  await release('2', 5);
  expect(snapshot()).toMatchObject({ generation: '2', count: 5 });
});
