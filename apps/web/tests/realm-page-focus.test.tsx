import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import type { RealmDiscoveryCard, RealmDiscoveryState } from '../src/community/realm-discovery';
import type { RealmDiscoveryPage, RealmDiscoveryReader } from '../src/search/realm-discovery-loader';
import type { SearchRealmDiscoveryLoader } from '../src/search/realm-discovery-section';

mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn() {
    const chain = {
      validator() {
        return chain;
      },
      handler() {
        return async () => ({ kind: 'unavailable' as const });
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
const window = new Window({ url: 'https://search.test/en/search' });
const globals = {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { SearchRealmDiscovery } = await import('../src/search/realm-discovery');
const { SearchRealmDiscoverySection } = await import('../src/search/realm-discovery-section');
const { m } = await import('../src/paraglide/messages.js');
const require = createRequire(import.meta.url);
const storybook = createRequire(require.resolve('storybook/test'));
const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
const user = userEvent.setup({ document: window.document });
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot>;
let generation = 0;
const options = { locale: 'en' as const };
type Page = Exclude<RealmDiscoveryState, { kind: 'loading' }>;
type Surface = 'search' | 'header';
const card = (name: string): RealmDiscoveryCard => ({
  realmId: '01a1a000-0000-7000-8000-000000000002',
  spaceId: '01a1a000-0000-7000-8000-000000000001',
  name,
  description: '',
  avatar: null,
});
const ready = (name: string, next: string | null): Page => ({ kind: 'ready', realms: [card(name)], next });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pages() {
  const queue: Array<ReturnType<typeof deferred<Page>>> = [];
  const take = async (): Promise<Page> => {
    const work = deferred<Page>();
    queue.push(work);
    return work.promise;
  };
  return { queue, take };
}

async function show(
  surface: Surface,
  input: {
    initial?: RealmDiscoveryState;
    read?: RealmDiscoveryReader;
    load?: SearchRealmDiscoveryLoader;
    locale?: string;
    client?: QueryClient;
  },
) {
  root ??= createRoot(host);
  const locale = input.locale ?? 'en';
  const key = `${surface}-${++generation}`;
  await act(async () =>
    root.render(
      createElement(
        'div',
        null,
        createElement('button', { type: 'button', 'data-move-focus': '' }, 'Other control'),
        surface === 'search'
          ? createElement(
              QueryClientProvider,
              { client: input.client ?? new QueryClient() },
              createElement(SearchRealmDiscovery, {
                key,
                initial: input.initial ?? { kind: 'loading' },
                locale,
                ...(input.read ? { read: input.read } : {}),
              }),
            )
          : createElement(SearchRealmDiscoverySection, {
              key,
              locale,
              ...(input.load ? { load: input.load } : {}),
            }),
      ),
    ),
  );
}

const labelled = (key: 'realm_discovery_continue' | 'realm_discovery_retry') =>
  [...host.querySelectorAll('button')].find((button) => button.textContent === m[key]({}, options));
const region = () => host.querySelector<HTMLElement>('[data-slot="realm-discovery"]');
const elsewhere = () => host.querySelector<HTMLButtonElement>('[data-move-focus]')!;

async function activate(button: HTMLButtonElement) {
  button.focus();
  expect(document.activeElement).toBe(button);
  await act(async () => user.keyboard('{Enter}'));
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = undefined!;
  host.replaceChildren();
  generation = 0;
});
afterAll(() => {
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function present(surface: Surface, first: Page) {
  const work = pages();
  if (surface === 'search') await show(surface, { initial: first, read: async () => work.take() });
  else {
    await show(surface, { load: async () => work.take() });
    await act(async () => Promise.resolve());
    await act(async () => work.queue.shift()!.resolve(first));
  }
  return work;
}

test('activated Realm Retry or terminal More recovers only for the current owner while focus has not moved', async () => {
  for (const surface of ['search', 'header'] as const) {
    let work = await present(surface, ready('Alpha', 'next'));
    await activate(labelled('realm_discovery_continue')!);
    await act(async () => work.queue.shift()!.resolve(ready('Beta', null)));
    expect(document.activeElement).toBe(region());

    work = await present(surface, { kind: 'unavailable' });
    await activate(labelled('realm_discovery_retry')!);
    await act(async () => work.queue.shift()!.resolve({ kind: 'unavailable' }));
    expect(document.activeElement).toBe(labelled('realm_discovery_retry'));

    await activate(labelled('realm_discovery_retry')!);
    await act(async () => work.queue.shift()!.resolve(ready('Gamma', 'kept')));
    expect(document.activeElement).toBe(region());

    await activate(labelled('realm_discovery_continue')!);
    await act(async () => work.queue.shift()!.resolve(ready('Delta', 'more')));
    expect(document.activeElement).toBe(labelled('realm_discovery_continue'));

    await activate(labelled('realm_discovery_continue')!);
    elsewhere().focus();
    await act(async () => work.queue.shift()!.resolve(ready('Epsilon', null)));
    expect(document.activeElement).toBe(elsewhere());

    elsewhere().focus();
    work = await present(surface, ready('Zeta', null));
    expect(document.activeElement).toBe(elsewhere());
  }
});

test('replaced owners and unmount drop a pending Realm page recovery', async () => {
  const first = pages();
  const second = pages();
  function Owned({ read }: { read: RealmDiscoveryReader }) {
    const [client] = useState(() => new QueryClient());
    return createElement(
      QueryClientProvider,
      { client },
      createElement(SearchRealmDiscovery, { initial: { kind: 'unavailable' }, locale: 'en', read }),
    );
  }
  root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        'div',
        null,
        createElement('button', { type: 'button', 'data-move-focus': '' }, 'Other control'),
        createElement(Owned, { read: async () => first.take() }),
      ),
    ),
  );
  await activate(labelled('realm_discovery_retry')!);
  await act(async () =>
    root.render(
      createElement(
        'div',
        null,
        createElement('button', { type: 'button', 'data-move-focus': '' }, 'Other control'),
        createElement(Owned, { read: async () => second.take() }),
      ),
    ),
  );
  await act(async () => first.queue.shift()?.resolve(ready('Late', null)));
  await act(async () => Promise.resolve());
  if (second.queue.length) await act(async () => second.queue.shift()!.resolve(ready('New', null)));
  expect(document.activeElement).not.toBe(region());
  expect(document.activeElement).not.toBe(labelled('realm_discovery_retry'));

  const header = pages();
  await show('header', { load: async () => header.take() });
  await act(async () => Promise.resolve());
  await act(async () => header.queue.shift()!.resolve({ kind: 'unavailable' }));
  await activate(labelled('realm_discovery_retry')!);
  await act(async () => root.unmount());
  root = undefined!;
  expect(region()).toBeNull();
});
