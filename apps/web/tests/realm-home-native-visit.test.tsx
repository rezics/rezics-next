import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createContext, useContext, type ReactNode } from 'react';
import type { NativeRealmHomeOperations, NativeRealmHomePage } from '../src/community/realm-home-native';
import type { SpacePageData } from '../src/community/space';
import type { KernelClient } from '@rezics/client';
import type { SpacePageAdmission } from '../src/community/space-page-lifetime';
import * as start from '../.storybook/react-start';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/spaces/realm' });
const globals = {
  window,
  ...Object.fromEntries(
    'document navigator location HTMLElement Element Node Document DocumentFragment HTMLButtonElement MutationObserver ResizeObserver'
      .split(' ')
      .map((key) => [key, window[key as keyof typeof window]]),
  ),
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const sessionModule = await import('../src/session/query');
let session = { state: 'signed-in' as 'signed-in' | 'signed-out', subject: 'reader', csrfToken: 'one' };
mock.module('../src/session/query', () => ({ ...sessionModule, useSession: () => session }));
const { bindNativeRealmHomeOperations, readNativeRealmHome, nativeRealmHomeShelves } = await import(
  '../src/community/realm-home-native'
);
const { loadSpacePageWithOrigin } = await import('../src/community/space');
const { SpacePage } = await import('../src/community/space-page');
const { bindSpacePageResult, captureSpacePageAdmission, SpacePageLifetimeHost } =
  await import('../src/community/space-page-lifetime');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale, locales } = await import('../src/paraglide/runtime.js');
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const input = { realmId: id(1), spaceId: id(2), languages: ['en'], credentialMode: 'session' as const };
function fixture(count = 1): NativeRealmHomePage {
  const metadata = {
    state: 'active' as const,
    headRevisionId: id(4),
    createdAt: '2026-10-01T00:00:00Z',
    creator: id(5),
    predecessor: null,
    revisionCreatedAt: '2026-10-01T00:00:00Z',
    author: id(5),
  };
  return {
    realm: {
      ...metadata,
      realmId: id(1),
      spaceId: id(2),
      contextId: id(3),
      boardSchemeId: null,
      visibility: 'public',
      title: 'Native Realm',
      summary: '',
      ownershipState: 'owned',
      orphanedAt: null,
      claimEligibleAt: null,
      governanceReadOnly: false,
      votes: {},
      presentation: { avatarMediaId: null, bannerMediaId: null, rules: null },
    },
    space: { ...metadata, spaceId: id(2), realmId: id(1), address: 'realm', title: 'Carrying Space', summary: '' },
    presentation: {
      realmId: id(1),
      spaceId: id(2),
      contextId: id(3),
      name: 'Native Realm',
      description: '',
      avatar: { state: 'none', value: null },
      banner: { state: 'none', value: null },
      rules: { state: 'none', value: null },
      members: { state: 'unknown', count: null, version: null },
    },
    boards: { items: [], next: 'boards-one' },
    publications: {
      items: Array.from({ length: count }, (_, n) => ({
        publication: { realmId: id(1), subjectId: id(20 + n), publicationId: id(40 + n) },
        summary: {
          id: id(20 + n),
          type: 'schema:Book',
          types: ['schema:Book'],
          label: { value: `Work ${n}`, language: 'en' },
          cover: null,
        },
      })),
      next: 'publications-one',
    },
    viewer: { state: 'unavailable' },
    actions: {
      participate: 'unavailable',
      join: 'unavailable',
      leave: 'unavailable',
      claim: 'unavailable',
      manage: 'unavailable',
    },
  };
}
const calls: string[] = [];
let native = fixture();
let boardRead: NativeRealmHomeOperations['boardShelf'] = async () => ({ status: 200, data: { items: [], next: null } });
const operations: NativeRealmHomeOperations = {
  home: async () => {
    calls.push('home');
    return { status: 200, data: native };
  },
  boardShelf: (input) => {
    calls.push(`boards:${input.cursor}`);
    return boardRead(input);
  },
  publicationShelf: async (input) => {
    calls.push(`publications:${input.cursor}`);
    return { status: 200, data: { items: [], next: null } };
  },
};

test('default Space reads bind the composed home after address resolution and preserve concealed versus failed carriers', async () => {
  const calls: string[] = [];
  let homeStatus = 200;
  const client = {
    spaceAddresses: () => ({
      get: async () => {
        calls.push('address');
        return { status: 200, data: { spaceId: id(2) } };
      },
    }),
    spaces: () => ({
      get: async () => {
        calls.push('space');
        return {
          status: 200,
          data: {
            space: {
              spaceId: id(2),
              realmId: id(1),
              headRevisionId: id(4),
              title: 'Carrying Space',
              summary: '',
            },
          },
        };
      },
    }),
    realms: () => ({
      home: {
        get: async ({ query }: { query: { languages: string[] } }) => {
          calls.push(`home:${query.languages.join(',')}`);
          return homeStatus === 200 ? { status: 200, data: fixture() } : { status: homeStatus, error: { status: homeStatus } };
        },
      },
    }),
  } as unknown as KernelClient;
  const request = new Request('https://site.test/en/spaces/realm');
  const loaded = await loadSpacePageWithOrigin(
    client,
    request,
    {},
    { address: 'realm', languages: ['en', 'ja'] },
    'anonymous',
  );
  expect(calls).toEqual(['address', 'space', 'home:en,ja']);
  expect(loaded.value.realmCarrier).toBe('available');
  expect(loaded.value.realm?.nativeObservation?.viewer.state).toBe('unavailable');

  homeStatus = 404;
  expect(
    (await loadSpacePageWithOrigin(client, request, {}, { address: 'realm' }, 'anonymous')).value.realmCarrier,
  ).toBe('concealed');
  homeStatus = 503;
  expect(
    (await loadSpacePageWithOrigin(client, request, {}, { address: 'realm' }, 'anonymous')).value.realmCarrier,
  ).toBe('unavailable');
});

test('Client operation seam binds home, raw shelf cursors and selected languages to one prepared reader', async () => {
  const requests: unknown[] = [];
  const client = {
    realms: ({ realmId }: { realmId: string }) => ({
      home: { get: async (input: unknown) => (requests.push(['home', realmId, input]), { status: 200, data: fixture() }) },
      boardShelf: {
        get: async (input: unknown) =>
          (requests.push(['boardShelf', realmId, input]), { status: 200, data: { items: [], next: null } }),
      },
      publicationShelf: {
        get: async (input: unknown) =>
          (requests.push(['publicationShelf', realmId, input]), { status: 200, data: { items: [], next: null } }),
      },
    }),
  } as unknown as KernelClient;
  const bound = bindNativeRealmHomeOperations(client, { headers: { authorization: 'Bearer prepared' } });
  await bound.home({ realmId: id(1), languages: ['zh-Hant', 'en'] });
  await bound.boardShelf({ realmId: id(1), cursor: 'boards-raw' });
  await bound.publicationShelf({ realmId: id(1), languages: ['ja'], cursor: 'publications-raw' });
  expect(requests).toEqual([
    ['home', id(1), { query: { languages: ['zh-Hant', 'en'] }, headers: { authorization: 'Bearer prepared' } }],
    ['boardShelf', id(1), { query: { cursor: 'boards-raw' }, headers: { authorization: 'Bearer prepared' } }],
    [
      'publicationShelf',
      id(1),
      { query: { languages: ['ja'], cursor: 'publications-raw' }, headers: { authorization: 'Bearer prepared' } },
    ],
  ]);
});
const Frame = createContext<ReactNode>(null);
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const host = document.createElement('main');
document.body.append(host);
let root = createRoot(host);
const router = createRouter({
  routeTree: createRootRoute({ component: () => useContext(Frame) }),
  history: createMemoryHistory({ initialEntries: ['/en/spaces/realm'] }),
});
await router.load();
async function settle(action: () => void) {
  await act(async () => {
    action();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
const target = { kind: 'space' as const, address: 'realm' };
function capture() {
  return captureSpacePageAdmission(client, { target, locale: 'en', credentialMode: 'session' });
}
async function paint(page: SpacePageData, source = operations, admission?: SpacePageAdmission) {
  const content = <SpacePage page={page} nativeOperations={source} />;
  await settle(() =>
    root.render(
      <Frame.Provider
        value={
          admission ? (
            <SpacePageLifetimeHost
              page={page}
              admission={admission}
              target={target}
              locale="en"
              credentialMode="session"
            >
              {content}
            </SpacePageLifetimeHost>
          ) : (
            content
          )
        }
      >
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </Frame.Provider>,
    ),
  );
}
afterEach(async () => {
  await settle(() => root.unmount());
  root = createRoot(host);
  client.clear();
  calls.length = 0;
  session = { state: 'signed-in', subject: 'reader', csrfToken: 'one' };
  setLocale('en', { reload: false });
});
afterAll(async () => {
  await settle(() => root.unmount());
  host.remove();
  mock.restore();
  for (const [key, value] of previous) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('one native page renders 0/1/6/12 works and unavailable standing without per-cover or personal reads', async () => {
  for (const count of [0, 1, 6, 12]) {
    native = fixture(count);
    native.publications.next = null;
    native.boards.next = null;
    await paint(await readNativeRealmHome(operations, input));
    expect(calls.splice(0)).toEqual(['home']);
    expect(host.textContent).toContain('Native Realm');
    expect(host.textContent).toContain(m.realm_membership_unavailable());
    expect(host.querySelectorAll('a[href*="?realm="]')).toHaveLength(count);
    expect(host.textContent).not.toContain(m.community_manage());
    expect(host.textContent).not.toContain(m.realm_join());
    if (!count) expect(host.textContent).toContain(m.realm_published_empty());
  }
});

test('native sparse continuation retries the same board cursor and leaves publication continuation independent', async () => {
  native = fixture(0);
  const page = await readNativeRealmHome(operations, input);
  let attempt = 0;
  boardRead = async () =>
    ++attempt === 1 ? { status: 503 } : { status: 200, data: { items: [], next: 'boards-two' } };
  await paint(page);
  const button = () =>
    host.querySelector('#realm-boards-heading')!.closest('section')!.querySelector<HTMLButtonElement>('button')!;
  await settle(() => {
    button().focus();
    button().click();
  });
  expect(button().textContent).toBe(m.realm_shelf_retry());
  await settle(() => button().click());
  expect(document.activeElement?.id).toBe('realm-boards-heading');
  expect(calls).toEqual(['home', 'boards:boards-one', 'boards:boards-one']);
  const shelf = nativeRealmHomeShelves(operations, input);
  expect(await shelf.publications({ cursor: 'publications-one' })).toEqual({
    kind: 'page',
    items: [],
    next: null,
    unavailable: 0,
  });
  expect(calls.at(-1)).toBe('publications:publications-one');
});

test('presentation replacement and credential or reader retirement discard pending rows and private presentation', async () => {
  for (const replacement of ['presentation', 'credential', 'reader', 'locale']) {
    native = fixture();
    native.presentation.description = native.realm.summary = 'Original presentation';
    const page = await readNativeRealmHome(operations, input);
    const late = Promise.withResolvers<Awaited<ReturnType<NativeRealmHomeOperations['boardShelf']>>>();
    boardRead = () => late.promise;
    await paint(page);
    await settle(() =>
      host
        .querySelector('#realm-boards-heading')!
        .closest('section')!
        .querySelector<HTMLButtonElement>('button')!
        .click(),
    );
    if (replacement === 'presentation') {
      native = fixture(0);
      native.presentation.description = native.realm.summary = 'Replacement presentation';
      await paint(await readNativeRealmHome(operations, input));
    } else {
      if (replacement === 'credential') session = { ...session, csrfToken: 'two' };
      if (replacement === 'locale') setLocale('ja', { reload: false });
      await paint(page, replacement === 'reader' ? { ...operations } : operations);
    }
    await settle(() =>
      late.resolve({
        status: 200,
        data: {
          items: [
            {
              id: id(80),
              realmId: id(1),
              title: 'Late board',
              purpose: 'discussion',
              visibility: 'published',
              availability: 'available',
            },
          ],
          next: null,
        },
      }),
    );
    expect(host.textContent).not.toContain('Late board');
    expect(host.textContent).not.toContain('Original presentation');
    if (replacement !== 'presentation') {
      session = { state: 'signed-in', subject: 'reader', csrfToken: 'one' };
      setLocale('en', { reload: false });
      await paint(page);
      expect(host.textContent).toBe('');
    }
  }
});

test('anonymous advice remains localized and a missing or replaced carrier never becomes a home', async () => {
  for (const locale of locales) {
    setLocale(locale, { reload: false });
    session = { state: 'signed-out', subject: '', csrfToken: '' };
    native = fixture(0);
    native.viewer.state = 'anonymous';
    native.actions = { participate: 'sign-in', join: 'sign-in', leave: 'sign-in', claim: 'sign-in', manage: 'sign-in' };
    await paint(await readNativeRealmHome(operations, input));
    expect(host.textContent).toContain(m.realm_sign_in_to_join());
    expect(host.querySelector('a[href*="auth/sign-in"]')?.className).toContain('min-h-11');
  }
  native = fixture();
  native.space.realmId = null;
  await expect(readNativeRealmHome(operations, input)).rejects.toThrow('Realm home source changed');
  await expect(
    readNativeRealmHome({ ...operations, home: async () => ({ status: 404 }) }, input),
  ).rejects.toBeDefined();
});

test('member actions render only from admitted native advice and denied, banned and orphaned viewers stay distinct', async () => {
  native = fixture(0);
  native.viewer = { state: 'member', membership: 'member' };
  native.actions = {
    participate: 'admitted',
    join: 'unavailable',
    leave: 'admitted',
    claim: 'unavailable',
    manage: 'admitted',
  };
  await paint(await readNativeRealmHome(operations, input));
  expect(host.textContent).toContain(m.realm_state_member());
  expect(host.textContent).toContain(m.realm_leave());
  expect(host.textContent).toContain(m.community_manage());
  expect(host.textContent).not.toContain(m.realm_join());

  for (const state of ['denied', 'banned', 'orphaned'] as const) {
    native = fixture(0);
    native.viewer = { state };
    native.actions = {
      participate: state,
      join: state,
      leave: state,
      claim: state,
      manage: state,
    };
    await paint(await readNativeRealmHome(operations, input));
    const message =
      state === 'denied'
        ? m.realm_native_access_denied()
        : state === 'banned'
          ? m.realm_banned()
          : m.realm_claim_orphaned();
    expect(host.textContent).toContain(message);
    expect(host.textContent).not.toContain(m.realm_join());
    expect(host.textContent).not.toContain(m.realm_leave());
    expect(host.textContent).not.toContain(m.community_manage());
    expect(host.querySelector(`[data-member-state="${state}"]`)).not.toBeNull();
  }
});

test('route admission retires native media and pending shelves on nested source replacement', async () => {
  for (const replacement of ['presentation', 'observation', 'lifecycle', 'page']) {
    client.setQueryData(sessionModule.sessionQuery.queryKey, session);
    const original = capture();
    native = fixture();
    native.presentation.banner = {
      state: 'available',
      value: {
        id: id(90),
        containerId: id(1),
        digest: 'a'.repeat(64),
        width: 1200,
        height: 200,
        variants: [{ format: 'webp', width: 1200, height: 200 }],
        placeholder: null,
        focalPoint: null,
        credit: null,
      },
    };
    const page = await readNativeRealmHome(operations, input);
    const admission = bindSpacePageResult(page, original, { kind: 'signed-in', subject: session.subject })!;
    const late = Promise.withResolvers<Awaited<ReturnType<NativeRealmHomeOperations['boardShelf']>>>();
    boardRead = () => late.promise;
    await paint(page, operations, admission);
    expect(host.querySelector('[data-slot="community-banner-image"]')).not.toBeNull();
    await settle(() =>
      host.querySelector('#realm-boards-heading')!.closest('section')!.querySelector('button')!.click(),
    );
    const realm = { ...page.realm! };
    if (replacement === 'presentation') page.realm!.presentation = { state: 'unavailable', value: null };
    if (replacement === 'observation') page.realm!.nativeObservation = { ...page.realm!.nativeObservation! };
    if (replacement === 'lifecycle') page.realm!.continuity = { ...page.realm!.continuity!, governanceReadOnly: true };
    await paint(replacement === 'page' ? { ...page } : page, operations, admission);
    await settle(() => late.resolve({ status: 200, data: { items: [], next: 'late-cursor' } }));
    expect(host.textContent).toBe('');
    expect(host.querySelector('img')).toBeNull();
    Object.assign(page.realm!, realm);
    await paint(page, operations, admission);
    expect(host.textContent).toBe('');
    await settle(() => root.unmount());
    root = createRoot(host);
  }
});

test('late initial native home cannot bind to a retired route observation', async () => {
  client.setQueryData(sessionModule.sessionQuery.queryKey, session);
  const original = capture();
  const late = Promise.withResolvers<Awaited<ReturnType<NativeRealmHomeOperations['home']>>>();
  const pending = readNativeRealmHome({ ...operations, home: () => late.promise }, input);
  client.setQueryData(sessionModule.sessionQuery.queryKey, { ...session, csrfToken: 'replacement' });
  late.resolve({ status: 200, data: fixture() });
  const page = await pending;
  expect(bindSpacePageResult(page, original, { kind: 'signed-in', subject: session.subject })).toBeNull();
  expect(host.textContent).toBe('');
});
