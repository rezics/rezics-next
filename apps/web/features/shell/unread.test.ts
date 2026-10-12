import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import type { Unread } from './unread.ts';

const originalReact = { ...(await import('react')) };
const originalFetch = globalThis.fetch;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const cleanup: (() => void)[] = [];
let snapshot: () => Unread | null = () => null;

await mock.module('react', () => ({ ...originalReact,
  useEffect: (effect: () => (() => void) | void) => { const stop = effect(); if (stop) cleanup.push(stop); },
  useSyncExternalStore: (_subscribe: unknown, read: () => Unread | null) => { snapshot = read; return read(); },
}));
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  visibilityState: 'visible', addEventListener() {}, removeEventListener() {},
} });
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  addEventListener() {}, removeEventListener() {},
} });
const { setUnread, setUnreadGeneration, useUnread } = await import('./unread.ts');

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
  await mock.module('react', () => originalReact);
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
