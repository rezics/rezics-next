import { afterEach, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { cachedBrowserSession, sessionQueryKey } from '../src/session/browser-state';

// Public catalogue inspect and credit inspection read the prepared session cache; the read never starts a fetch.
const clients: QueryClient[] = [];
const client = () => {
  const created = new QueryClient();
  clients.push(created);
  return created;
};
afterEach(() => {
  for (const created of clients.splice(0)) created.clear();
});

test('an empty session cache is unknown and never starts a session fetch', () => {
  const cache = client();
  expect(cachedBrowserSession(cache)).toEqual({ state: 'unknown', csrfToken: null });
  expect(cache.getQueryState(sessionQueryKey)).toBeUndefined();
});

test('a same-cache replacement is the next read and issues no session fetch', () => {
  const cache = client();
  const original = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (input: Request | URL | string) => {
    fetched.push(String(input));
    throw new Error('the prepared session cache must not fetch');
  }) as typeof fetch;
  try {
    cache.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'alice', csrfToken: 'csrf-a' });
    expect(cachedBrowserSession(cache)).toEqual({ state: 'signed-in', subject: 'alice', csrfToken: 'csrf-a' });
    // A replacement in the same cache is visible to the next read, with no retained copy of the previous subject.
    cache.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'bob', csrfToken: 'csrf-b' });
    expect(cachedBrowserSession(cache)).toEqual({ state: 'signed-in', subject: 'bob', csrfToken: 'csrf-b' });
    expect(cache.isFetching()).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
  expect(fetched).toEqual([]);
});

test('malformed and signed-out cached data never admits a subject', () => {
  const cache = client();
  cache.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'alice' });
  expect(cachedBrowserSession(cache)).toEqual({ state: 'unavailable', csrfToken: null, subject: null });
  cache.setQueryData(sessionQueryKey, { state: 'signed-out', csrfToken: null, subject: 'alice' });
  expect(cachedBrowserSession(cache)).toEqual({ state: 'signed-out', csrfToken: null, subject: null });
});
