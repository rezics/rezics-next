import { afterEach, expect, mock, test } from 'bun:test';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { copyThreadPostLink } = await import('../src/routes/threads/$id_.$slug');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const priorLocale = getLocale();
const globals = ['window', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);

afterEach(() => {
  setLocale(priorLocale);
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('copies a later-page post locator with canonical identity, locale, and encoded IDs', async () => {
  const copied: string[] = [];
  setLocale('zh-Hant');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: new URL('https://site.test/zh-Hant/threads/old-title?cursor=after-first-page') },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: (href: string) => {
          copied.push(href);
          return Promise.resolve();
        },
      },
    },
  });
  await copyThreadPostLink({ id: 'later/post + exact', threadId: 'thread/id + opaque' });
  expect(copied).toEqual([
    'https://site.test/zh-Hant/threads/thread%2Fid%20%2B%20opaque?post=later%2Fpost%20%2B%20exact#post-later%2Fpost%20%2B%20exact',
  ]);
});
