import { expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import type { RealmDiscoveryCard, RealmDiscoveryState } from '../src/community/realm-discovery';
import type { RealmDiscoveryPage, RealmDiscoveryReader } from '../src/search/realm-discovery-loader';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const anonymousReads: Array<ReturnType<typeof deferred<RealmDiscoveryPage>>> = [];
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn() {
    const chain = {
      validator() {
        return chain;
      },
      handler() {
        return async () => {
          const work = deferred<RealmDiscoveryPage>();
          anonymousReads.push(work);
          return work.promise;
        };
      },
    };
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const { SearchRealmDiscovery } = await import('../src/search/realm-discovery');
const { realmDiscoveryQueryOptions } = await import('../src/search/realm-discovery-loader');
const { m } = await import('../src/paraglide/messages.js');

const card = (name: string, id: string): RealmDiscoveryCard => ({
  realmId: id,
  spaceId: '01a1a000-0000-7000-8000-000000000001',
  name,
  description: '',
  avatar: null,
});
const ready = (name: string, id: string, next: string | null): RealmDiscoveryPage => ({
  kind: 'ready',
  realms: [card(name, id)],
  next,
});

test('replacing an injected Realm reader at the same locale/sort hides its window, ignores late results and leaves another anonymous consumer running', async () => {
  const injected = async (): Promise<RealmDiscoveryPage> => ({ kind: 'unavailable' });
  expect(realmDiscoveryQueryOptions('en').queryKey).toEqual([
    'search',
    'realm-discovery-v1',
    'anonymous',
    'public-global',
    'en',
    'popular',
    20,
    null,
  ]);
  const injectedKey = realmDiscoveryQueryOptions('en', 'popular', undefined, injected).queryKey;
  expect(injectedKey[2]).toMatch(/^injected:\d+$/);
  expect(typeof injectedKey[2]).toBe('string');
  expect(injectedKey).not.toEqual(realmDiscoveryQueryOptions('en').queryKey);
  expect(realmDiscoveryQueryOptions('en', 'popular', 'cursor', injected).queryKey[2]).toBe(injectedKey[2]);

  const window = new Window({ url: 'https://site.test/en/search' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient();
  const cancelQueries = spyOn(client, 'cancelQueries');
  const first = deferred<RealmDiscoveryPage>();
  const second = deferred<RealmDiscoveryPage>();
  const firstRead: RealmDiscoveryReader = async ({ data }) =>
    data.cursor ? first.promise : ready('Old Realm', '01a1a000-0000-7000-8000-000000000002', 'next');
  const secondRead: RealmDiscoveryReader = async () => second.promise;
  const initial: RealmDiscoveryState = ready('Old Realm', '01a1a000-0000-7000-8000-000000000002', 'next');
  function Fixture({ showFirstAnonymous = true }: { showFirstAnonymous?: boolean }) {
    const [read, setRead] = useState<RealmDiscoveryReader>(() => firstRead);
    return createElement(QueryClientProvider, { client }, [
      createElement(SearchRealmDiscovery, {
        key: 'owned',
        initial,
        locale: 'en',
        sort: 'popular',
        read,
      }),
      createElement(
        'button',
        { key: 'replace', type: 'button', onClick: () => setRead(() => secondRead) },
        'Replace reader',
      ),
      showFirstAnonymous
        ? createElement(
            'div',
            { key: 'first-anonymous', 'data-consumer': 'first' },
            createElement(SearchRealmDiscovery, { initial: { kind: 'loading' }, locale: 'en' }),
          )
        : null,
      createElement(
        'div',
        { key: 'second-anonymous', 'data-consumer': 'second' },
        createElement(SearchRealmDiscovery, { initial: { kind: 'loading' }, locale: 'en' }),
      ),
    ]);
  }
  try {
    await act(async () => root.render(createElement(Fixture)));
    expect(host.textContent).toContain('Old Realm');
    const more = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.realm_discovery_continue({}, { locale: 'en' }),
    )!;
    await act(async () => more.click());
    expect(host.textContent).toContain('Old Realm');
    await act(async () =>
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Replace reader')!.click(),
    );
    expect(host.textContent).not.toContain('Old Realm');
    await act(async () => first.resolve(ready('Late Realm', '01a1a000-0000-7000-8000-000000000003', null)));
    expect(host.textContent).not.toContain('Late Realm');
    expect(host.textContent).not.toContain('Old Realm');
    await act(async () => second.resolve(ready('New Realm', '01a1a000-0000-7000-8000-000000000004', 'kept')));
    expect(host.textContent).toContain('New Realm');
    await act(async () => root.render(createElement(Fixture, { showFirstAnonymous: false })));
    expect(cancelQueries).not.toHaveBeenCalled();
    expect(host.querySelector('[data-consumer="second"]')!.textContent).not.toContain('Shared Realm');
    expect(anonymousReads.length).toBeGreaterThan(0);
    await act(async () =>
      anonymousReads.forEach((read) => read.resolve(ready('Shared Realm', '01a1a000-0000-7000-8000-000000000005', null))),
    );
    expect(host.querySelector('[data-consumer="second"]')!.textContent).toContain('Shared Realm');
    expect(cancelQueries).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    await window.happyDOM.abort();
    cancelQueries.mockRestore();
    client.clear();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
