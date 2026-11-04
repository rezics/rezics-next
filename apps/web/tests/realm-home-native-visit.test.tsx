import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createContext, useContext, type ReactNode } from 'react';
import type { NativeRealmHomeOperations, NativeRealmHomePage } from '../src/community/realm-home-native';
import type { RealmJoinAdvice } from '../src/community/native-operations';
import type { SpacePageData } from '../src/community/space';
import { createKernelClient, type KernelClient } from '@rezics/client';
import type { SpacePageAdmission } from '../src/community/space-page-lifetime';
import * as start from '../.storybook/react-start';
import { available, image } from '../src/kernel/fake/community';
import { realmMembershipTestReaders } from './realm-membership-test-fixture';

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
  scrollTo: () => {},
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
let joinAdvice: RealmJoinAdvice = { state: 'current', allowed: true };
const joinAdviceReads: string[] = [];
mock.module('../src/community/realm-membership-actions', () => ({
  readRealmMembership: ({ data }: { data: { realmId: string } }) =>
    realmMembershipTestReaders.readMembership(data.realmId),
  readRealmJoinAdvice: ({ data }: { data: { realmId: string } }) => {
    joinAdviceReads.push(data.realmId);
    return realmMembershipTestReaders.readJoinAdvice(data.realmId);
  },
}));
const { bindNativeRealmHomeOperations, readNativeRealmHome, nativeRealmHomeShelves } =
  await import('../src/community/realm-home-native');
const { readRealmJoinAdvice: readInstalledRealmJoinAdvice } = await import('../src/community/native-operations');
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
type FixtureViewer = 'anonymous' | 'none' | 'member';
function fixture(
  count = 1,
  viewer: FixtureViewer = 'none',
  options: { participation?: 'allowed' | 'denied'; manage?: boolean; orphaned?: boolean } = {},
): NativeRealmHomePage {
  const metadata = {
    state: 'active' as const,
    headRevisionId: id(4),
    createdAt: '2026-10-01T00:00:00Z',
    creator: id(5),
    predecessor: null,
    revisionCreatedAt: '2026-10-01T00:00:00Z',
    author: id(5),
  };
  const orphaned = options.orphaned === true;
  const realm: NativeRealmHomePage['realm'] = {
    ...metadata,
    realmId: id(1),
    spaceId: id(2),
    contextId: id(3),
    boardSchemeId: null,
    visibility: 'public',
    title: 'Native Realm',
    summary: '',
    ownershipState: orphaned ? 'orphaned' : 'owned',
    orphanedAt: orphaned ? '2026-09-01T00:00:00Z' : null,
    claimEligibleAt: orphaned ? '2026-09-02T00:00:00Z' : null,
    governanceReadOnly: orphaned,
    votes: {},
    presentation: { avatarMediaId: null, bannerMediaId: null, rules: null },
  };
  const currentViewer: NativeRealmHomePage['viewer'] =
    viewer === 'anonymous'
      ? { state: 'anonymous' }
      : {
          readability: 'allowed',
          membership:
            viewer === 'member'
              ? { state: 'member', since: '2026-10-01T00:00:00Z', reservationId: id(6), transactionId: id(7) }
              : { state: 'none', since: null, reservationId: null, transactionId: null },
          participation: options.participation ?? 'allowed',
        };
  const actions: NativeRealmHomePage['actions'] =
    viewer === 'anonymous'
      ? { state: 'sign-in' }
      : {
          state: 'current',
          enter: {
            state: 'available',
            method: 'GET',
            path: `/v1/realms/${id(1)}`,
            body: null,
            expectedStatus: 200,
          },
          manage: orphaned
            ? { state: 'prohibited', reason: 'governance_read_only' }
            : options.manage
              ? {
                  state: 'available',
                  method: 'GET',
                  path: `/v1/realms/${id(1)}/settings`,
                  body: null,
                  expectedStatus: 200,
                }
              : { state: 'prohibited', reason: 'not_authorized' },
          leave:
            viewer === 'member'
              ? {
                  state: 'available',
                  method: 'DELETE',
                  path: `/v1/realms/${id(1)}/membership`,
                  body: null,
                  expectedStatus: 202,
                }
              : { state: 'prohibited', reason: 'not_member' },
        };
  return {
    realm,
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
    viewer: currentViewer,
    actions,
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

test('public Space reading remains available while the official Realm Home transport is absent', async () => {
  const calls: string[] = [];
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
  } as unknown as KernelClient;
  const request = new Request('https://site.test/en/spaces/realm');
  const loaded = await loadSpacePageWithOrigin(
    client,
    request,
    {},
    { address: 'realm', languages: ['en', 'ja'] },
    'anonymous',
  );
  expect(calls).toEqual(['address', 'space']);
  expect(loaded.value.space?.title).toBe('Carrying Space');
  expect(loaded.value.realmCarrier).toBe('unavailable');
});

test('Realm Home and shelves stay unavailable until the official root-derived client contract is installed', async () => {
  const requests: {
    method: string;
    path: string;
    languages: string[];
    cursor: string | null;
    authorization: string | null;
  }[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        languages: url.searchParams.getAll('languages'),
        cursor: url.searchParams.get('cursor'),
        authorization: request.headers.get('authorization'),
      });
      return Response.json(url.pathname.endsWith('/home') ? fixture(1, 'anonymous') : { items: [], next: null });
    },
  });
  const bound = bindNativeRealmHomeOperations(client, { headers: { authorization: 'Bearer prepared' } });
  const home = await bound.home({ realmId: id(1), languages: ['zh-Hant', 'en'] });
  const boards = await bound.boardShelf({ realmId: id(1), cursor: 'boards-raw' });
  const publications = await bound.publicationShelf({ realmId: id(1), languages: ['ja'], cursor: 'publications-raw' });
  expect(requests).toEqual([]);
  expect([home.status, boards.status, publications.status]).toEqual([503, 503, 503]);
  expect((home.error as Error).message).toContain('Realm Home client contract is unavailable');
});

test('Realm join advice needs both the exact action and mounted operation', async () => {
  const answers = [
    [],
    [{ action: 'realm:join', operations: ['realm.leave'] }],
    [{ action: 'realm:manage', operations: ['realm.join'] }],
    [{ action: 'realm:join', operations: ['realm.join'] }],
  ];
  const requests: { method: string; path: string; authorization: string | null; body: unknown }[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        body: await request.json(),
      });
      const viewerActions = answers.shift()!;
      return Response.json({ resources: [{ type: 'community.realm', id: id(1), viewerActions }] });
    },
  });

  const results = [];
  for (let n = 0; n < 4; n++) results.push(await readInstalledRealmJoinAdvice(client, id(1), 'Bearer personal'));

  expect(results).toEqual([
    { state: 'current', allowed: false },
    { state: 'current', allowed: false },
    { state: 'current', allowed: false },
    { state: 'current', allowed: true },
  ]);
  expect(requests).toEqual(
    Array.from({ length: 4 }, () => ({
      method: 'POST',
      path: '/v1/viewerActions',
      authorization: 'Bearer personal',
      body: { resources: [{ type: 'community.realm', id: id(1) }] },
    })),
  );
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
  client.setQueryData(sessionModule.sessionQuery.queryKey, session);
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
beforeEach(() => {
  joinAdviceReads.length = 0;
  joinAdvice = { state: 'current', allowed: true };
  realmMembershipTestReaders.readMembership = async () => null;
  realmMembershipTestReaders.readJoinAdvice = async () => joinAdvice;
});
afterEach(async () => {
  await settle(() => root.unmount());
  root = createRoot(host);
  client.clear();
  calls.length = 0;
  joinAdviceReads.length = 0;
  joinAdvice = { state: 'current', allowed: true };
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

test('one typed native page renders 0/1/6/12 works and explicit nonmember advice without per-cover reads', async () => {
  for (const count of [0, 1, 6, 12]) {
    native = fixture(count);
    native.publications.next = null;
    native.boards.next = null;
    await paint(await readNativeRealmHome(operations, input));
    expect(calls.splice(0)).toEqual(['home']);
    expect(host.textContent).toContain('Native Realm');
    expect(host.textContent).toContain(m.realm_join());
    expect(host.querySelectorAll('a[href*="?realm="]')).toHaveLength(count);
    expect(host.textContent).not.toContain(m.community_manage());
    if (!count) expect(host.textContent).toContain(m.realm_published_empty());
  }
});

test('unavailable, refused and empty Realm advice never hide public reading or invent a join control', async () => {
  native = fixture(0, 'none');
  joinAdvice = { state: 'unavailable' };
  await paint(await readNativeRealmHome(operations, input));
  expect(joinAdviceReads).toEqual([id(1)]);
  expect(host.textContent).toContain('Native Realm');
  expect(host.textContent).toContain(m.realm_membership_unavailable());
  expect(host.textContent).toContain(m.realm_membership_retry());
  expect(host.textContent).not.toContain(m.realm_join());

  joinAdvice = { state: 'refused' };
  await paint(await readNativeRealmHome(operations, input));
  expect(host.textContent).toContain(m.realm_membership_advice_refused());
  expect(host.textContent).not.toContain(m.realm_join());
  expect(host.querySelector('a[href*="auth/sign-in"]')).toBeNull();

  joinAdvice = { state: 'current', allowed: false };
  await paint(await readNativeRealmHome(operations, input));
  expect(host.textContent).toContain(m.realm_native_access_denied());
  expect(host.textContent).not.toContain(m.realm_join());
  expect(host.textContent).toContain(m.realm_published_empty());
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

test('presentation replacement and credential, account or reader retirement discard pending rows and private presentation', async () => {
  for (const replacement of ['presentation', 'credential', 'account', 'reader', 'locale']) {
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
      if (replacement === 'account') session = { ...session, subject: 'replacement-reader' };
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
      await paint(await readNativeRealmHome(operations, input));
      expect(host.textContent).toContain('Original presentation');
    }
  }
});

test('anonymous advice remains localized and a missing or replaced carrier never becomes a home', async () => {
  for (const locale of locales) {
    setLocale(locale, { reload: false });
    session = { state: 'signed-out', subject: '', csrfToken: '' };
    native = fixture(0, 'anonymous');
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

test('member actions use current native advice while denied participation and orphaned authority stay distinct', async () => {
  native = fixture(0, 'member', { manage: true });
  await paint(await readNativeRealmHome(operations, input));
  expect(host.textContent).toContain(m.realm_state_member());
  expect(host.textContent).toContain(m.realm_leave());
  expect(host.textContent).toContain(m.community_manage());
  expect(host.textContent).not.toContain(m.realm_join());

  native = fixture(0, 'none', { participation: 'denied' });
  await paint(await readNativeRealmHome(operations, input));
  expect(host.textContent).toContain(m.realm_native_access_denied());
  expect(host.textContent).not.toContain(m.realm_join());
  expect(host.textContent).not.toContain(m.realm_leave());

  native = fixture(0, 'none', { orphaned: true });
  const orphaned = await readNativeRealmHome(operations, input);
  expect(orphaned.realm?.continuity?.governanceReadOnly).toBe(true);
  expect(orphaned.realm?.nativeObservation?.actions.manage).toBe('orphaned');
});

test('route admission retires native media and pending shelves on nested source replacement', async () => {
  for (const replacement of ['presentation', 'observation', 'lifecycle', 'page', 'head', 'selection', 'advice']) {
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
    native.realm.presentation!.bannerMediaId = id(90);
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
    if (replacement === 'head') page.realm!.nativeSource!.space.headRevisionId = id(91);
    if (replacement === 'selection') page.realm!.nativeSource!.realm.presentation!.bannerMediaId = id(91);
    if (replacement === 'advice') page.realm!.nativeObservation!.actions.manage = 'admitted';
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

test('standalone visits cannot lose native advice or reuse shelves on a fresh response', async () => {
  await paint(await readNativeRealmHome(operations, input));
  expect(host.querySelectorAll('a[href*="?realm="]')).toHaveLength(1);
  native = fixture(0);
  native.boards.next = native.publications.next = null;
  const page = await readNativeRealmHome(operations, input);
  await paint(page);
  expect(host.querySelectorAll('a[href*="?realm="]')).toHaveLength(0);
  expect(host.textContent).toContain(m.realm_published_empty());
  const observation = page.realm!.nativeObservation!;
  delete page.realm!.nativeObservation;
  await paint(page);
  expect(host.textContent).toBe('');
  page.realm!.nativeObservation = observation;
  await paint(page);
  expect(host.textContent).toBe('');
  await paint(await readNativeRealmHome(operations, input));
  expect(host.querySelectorAll('a[href*="?realm="]')).toHaveLength(0);
  expect(host.textContent).toContain(m.realm_published_empty());
});

test('native presentation cannot disclose a different selected rules revision or media', async () => {
  native = fixture();
  native.presentation.avatar = {
    state: 'available',
    value: image,
  };
  await expect(readNativeRealmHome(operations, input)).rejects.toThrow('Realm home presentation changed');
  native.presentation.avatar = { state: 'none', value: null };
  native.presentation.rules = available.rules;
  native.realm.presentation!.rules = { postId: available.presentation.rules!.postId, revisionId: id(93) };
  await expect(readNativeRealmHome(operations, input)).rejects.toThrow('Realm home presentation changed');
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
