import { expect, test } from 'bun:test';
import {
  rememberSearchDestination,
  restoreSearchDestination,
  retireSearchDestination,
} from '../src/search/search-destination-return';
import { narrowSearchRetryAt, searchRetryAt } from '../src/search/search-recovery-retry';

const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  },
});

test('opening a result remembers the executed page and restores it on return', () => {
  memory.clear();
  const visit = rememberSearchDestination({
    href: '/en/search?q=lantern&cursor=opaque',
    locale: 'en',
    reader: 'account:reader',
    cursor: 'opaque',
  });
  expect(
    restoreSearchDestination({
      href: '/en/search?q=lantern&cursor=opaque',
      locale: 'en',
      reader: 'account:reader',
    }),
  ).toEqual(visit);
});

test('reader or locale replacement retires the remembered destination and late restore', () => {
  memory.clear();
  rememberSearchDestination({ href: '/en/search', locale: 'en', reader: 'account:a' });
  expect(restoreSearchDestination({ href: '/en/search', locale: 'ja', reader: 'account:a' })).toBeNull();
  expect(restoreSearchDestination({ href: '/en/search', locale: 'en', reader: 'account:a' })).toBeNull();
  rememberSearchDestination({ href: '/en/search', locale: 'en', reader: null });
  retireSearchDestination();
  expect(restoreSearchDestination({ href: '/en/search', locale: 'en', reader: null })).toBeNull();
});

test('narrowed Retry-After keeps the later deadline so train conflict cannot schedule an earlier retry', () => {
  expect(narrowSearchRetryAt(2000, 5000)).toBe(5000);
  expect(narrowSearchRetryAt(5000, 2000)).toBe(5000);
  expect(narrowSearchRetryAt(undefined, 2000)).toBe(2000);
  expect(searchRetryAt('2', 1000)).toBe(3000);
});
