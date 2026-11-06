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
import { boardSearch, admittedBoardReturn } from '../src/threads/board-navigation';
import { threadLocation } from '../src/threads/thread-href';

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
const spaceActions = await import('../src/community/space-actions');
let session = { state: 'signed-in' as 'signed-in' | 'signed-out', subject: 'reader', csrfToken: 'one' };
let joinAdvice: RealmJoinAdvice = { state: 'current', allowed: true };
const joinAdviceReads: string[] = [];
let membershipAction: () => Promise<unknown> = async () => ({ outcome: 'accepted', workflowId: 'membership-visit' });
const membershipActionCalls: string[] = [];
mock.module('../src/community/realm-membership-actions', () => ({
  readRealmMembership: ({ data }: { data: { realmId: string } }) =>
    realmMembershipTestReaders.readMembership(data.realmId),
  readRealmJoinAdvice: ({ data }: { data: { realmId: string } }) => {
    joinAdviceReads.push(data.realmId);
    return realmMembershipTestReaders.readJoinAdvice(data.realmId);
  },
}));
mock.module('../src/community/space-actions', () => ({
  ...spaceActions,
  changeRealmMembership: (input: { data: { realmId: string; action: string } }) => {
    membershipActionCalls.push(`${input.data.realmId}:${input.data.action}`);
    return membershipAction();
  },
}));
const { bindNativeRealmHomeOperations, readNativeRealmHome, nativeRealmHomeShelves } =
  await import('../src/community/realm-home-native');
const { readRealmJoinAdvice: readInstalledRealmJoinAdvice } = await import('../src/community/native-operations');
const { loadSpacePageWithOrigin } = await import('../src/community/space');
const { SpacePage, RealmShelf } = await import('../src/community/space-page');
const { bindSpacePageResult, captureSpacePageAdmission, SpacePageLifetimeHost } =
  await import('../src/community/space-page-lifetime');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, overwriteGetLocale, locales } = await import('../src/paraglide/runtime.js');
const originalGetLocale = getLocale;
let visitLocale: (typeof locales)[number] = 'en';
overwriteGetLocale(() => visitLocale);
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
        publication: {
          realmId: id(1),
          subjectId: id(20 + n),
          publicationId: id(40 + n),
          verdict: 'adopt',
          subjectRevisionId: null,
          publishedAt: '2026-10-01T00:00:00.000Z',
        },
        summary: {
          id: id(20 + n),
          type: 'schema:Book',
          types: ['schema:Book'],
          creativeWork: false,
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

test('public Space reading remains available when the mounted Realm Home endpoint is unavailable', async () => {
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
    realms: ({ realmId }: { realmId: string }) => ({
      home: {
        get: async () => {
          calls.push(`home:${realmId}`);
          return { status: 503 };
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
  expect(calls).toEqual(['address', 'space', `home:${id(1)}`]);
  expect(loaded.value.space?.title).toBe('Carrying Space');
  expect(loaded.value.realmCarrier).toBe('unavailable');
});

test('Realm Home and shelves use the installed root-derived client transport with the prepared viewer', async () => {
  const requests: {
    method: string;
    path: string;
    languages: string[];
    cursor: string | null;
    authorization: string | null;
    cache: RequestCache;
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
        cache: request.cache,
      });
      return Response.json(url.pathname.endsWith('/home') ? fixture(1, 'anonymous') : { items: [], next: null });
    },
  });
  const bound = bindNativeRealmHomeOperations(client, { headers: { authorization: 'Bearer prepared' } });
  const home = await bound.home({ realmId: id(1), languages: ['zh-Hant', 'en'] });
  const boards = await bound.boardShelf({ realmId: id(1), cursor: 'boards-raw' });
  const publications = await bound.publicationShelf({ realmId: id(1), languages: ['ja'], cursor: 'publications-raw' });
  expect([home.status, boards.status, publications.status]).toEqual([200, 200, 200]);
  expect(home.data?.realm.realmId).toBe(id(1));
  expect(requests).toEqual([
    {
      method: 'GET',
      path: `/v1/realms/${id(1)}/home`,
      languages: ['zh-Hant', 'en'],
      cursor: null,
      authorization: 'Bearer prepared',
      cache: 'no-store',
    },
    {
      method: 'GET',
      path: `/v1/realms/${id(1)}/boardShelf`,
      languages: [],
      cursor: 'boards-raw',
      authorization: 'Bearer prepared',
      cache: 'no-store',
    },
    {
      method: 'GET',
      path: `/v1/realms/${id(1)}/publicationShelf`,
      languages: ['ja'],
      cursor: 'publications-raw',
      authorization: 'Bearer prepared',
      cache: 'no-store',
    },
  ]);
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
function controls() {
  return [...host.querySelectorAll('button, a')].map((control) => control.textContent);
}
const target = { kind: 'space' as const, address: 'realm' };
function capture() {
  return captureSpacePageAdmission(client, { target, locale: 'en', credentialMode: 'session' });
}
async function paint(page: SpacePageData, source = operations, admission?: SpacePageAdmission) {
  const content = <SpacePage page={page} nativeOperations={source} />;
  await settle(() => {
    if (!admission) client.setQueryData(sessionModule.sessionQuery.queryKey, session);
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
    );
  });
  await settle(() => {});
}
beforeEach(() => {
  joinAdviceReads.length = 0;
  membershipActionCalls.length = 0;
  membershipAction = async () => ({ outcome: 'accepted', workflowId: 'membership-visit' });
  joinAdvice = { state: 'current', allowed: true };
  realmMembershipTestReaders.readMembership = async () => null;
  realmMembershipTestReaders.readJoinAdvice = async () => joinAdvice;
});
afterEach(async () => {
  await settle(() => root.unmount());
  root = createRoot(host);
  client.clear();
  router.history.push('/en/spaces/realm');
  await router.load();
  calls.length = 0;
  joinAdviceReads.length = 0;
  membershipActionCalls.length = 0;
  membershipAction = async () => ({ outcome: 'accepted', workflowId: 'membership-visit' });
  boardRead = async () => ({ status: 200, data: { items: [], next: null } });
  joinAdvice = { state: 'current', allowed: true };
  session = { state: 'signed-in', subject: 'reader', csrfToken: 'one' };
  visitLocale = 'en';
});
afterAll(async () => {
  await settle(() => root.unmount());
  host.remove();
  overwriteGetLocale(originalGetLocale);
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
    expect(
      [...host.querySelectorAll('h2')].filter((heading) => heading.textContent === m.realm_catalogue_heading()),
    ).toHaveLength(1);
    expect(host.textContent).toContain(m.realm_catalogue_works_heading());
    expect(host.querySelector('[data-slot="realm-membership"]')).not.toBeNull();
    expect(host.querySelectorAll('a[href*="?realm="]')).toHaveLength(count);
    expect(host.textContent).not.toContain(m.community_manage());
    if (!count) expect(host.textContent).toContain(m.realm_published_empty());
  }
});

test('unavailable, refused and empty Realm advice never hide public reading or invent a join control', async () => {
  native = fixture(0, 'none');
  native.publications.next = null;
  joinAdvice = { state: 'unavailable' };
  await paint(await readNativeRealmHome(operations, input));
  expect(joinAdviceReads).toEqual([id(1)]);
  expect(host.textContent).toContain('Native Realm');
  expect(host.textContent).toContain(m.realm_membership_unavailable());
  expect(host.textContent).toContain(m.realm_membership_retry());
  expect(controls()).not.toContain(m.realm_join());

  joinAdvice = { state: 'refused' };
  await paint(await readNativeRealmHome(operations, input));
  expect(host.textContent).toContain(m.realm_membership_advice_refused());
  expect(controls()).not.toContain(m.realm_join());
  expect(host.querySelector('a[href*="auth/sign-in"]')).toBeNull();

  joinAdvice = { state: 'current', allowed: false };
  await paint(await readNativeRealmHome(operations, input));
  expect(host.textContent).toContain(m.realm_native_access_denied());
  expect(controls()).not.toContain(m.realm_join());
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
      if (replacement === 'locale') visitLocale = 'ja';
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
    expect(host.textContent, replacement).not.toContain('Late board');
    expect(host.textContent).not.toContain('Original presentation');
    if (replacement !== 'presentation') {
      session = { state: 'signed-in', subject: 'reader', csrfToken: 'one' };
      visitLocale = 'en';
      await paint(page);
      expect(host.textContent).toBe('');
      await paint(await readNativeRealmHome(operations, input));
      expect(host.textContent).toContain('Original presentation');
    }
  }
});

test('anonymous advice remains localized and a missing or replaced carrier never becomes a home', async () => {
  for (const locale of locales) {
    visitLocale = locale;
    session = { state: 'signed-out', subject: '', csrfToken: '' };
    native = fixture(0, 'anonymous');
    await paint(await readNativeRealmHome(operations, input));
    expect(host.textContent).toContain(m.realm_sign_in_to_join());
    expect(host.querySelector('[data-native-advice] a[href*="auth/sign-in"]')?.className).toContain('min-h-11');
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
  expect(controls()).not.toContain(m.realm_join());

  native = fixture(0, 'none', { participation: 'denied' });
  await paint(await readNativeRealmHome(operations, input));
  expect(host.textContent).toContain(m.realm_native_access_denied());
  expect(controls()).not.toContain(m.realm_join());
  expect(controls()).not.toContain(m.realm_leave());

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

test.each(['en', 'zh-Hant', 'ja'] as const)(
  'the mounted Board seam preserves the %s supplying shelf through thread return',
  async (locale) => {
    visitLocale = locale;
    native = fixture(0);
    client.setQueryData(sessionModule.sessionQuery.queryKey, session);
    const page = await readNativeRealmHome(operations, input);
    const realm = page.realm!;
    const restored: (string | undefined)[] = [];
    const returnTo = `/${locale}/spaces/realm?node=boards&cursor=selected-window`;
    await settle(() =>
      root.render(
        <Frame.Provider
          value={
            <RealmShelf
              realm={realm}
              returnTo={returnTo}
              transport={{
                publications: async () => ({ kind: 'page', items: [], next: null, unavailable: 0 }),
                change: async () => ({ kind: 'denied' }),
                boards: async ({ cursor }) => {
                  restored.push(cursor);
                  return {
                    kind: 'page',
                    items: [
                      {
                        id: id(80),
                        title: 'Supplied Board',
                        description: 'Independent description',
                        purpose: 'discussion',
                        visibility: 'published',
                        recent: {
                          state: 'current',
                          complete: true,
                          threads: [
                            {
                              id: id(81),
                              title: 'Ordinary thread',
                              comments: { state: 'current', kind: 'exact', value: 1 },
                            },
                            {
                              id: id(84),
                              title: 'Popular thread',
                              comments: { state: 'current', kind: 'lower-bound', value: 5 },
                            },
                            {
                              id: id(85),
                              title: 'Unknown replies thread',
                              comments: { state: 'unavailable' },
                            },
                            {
                              id: id(86),
                              title: 'Beyond recent prefix',
                              comments: { state: 'current', kind: 'exact', value: 99 },
                            },
                          ],
                        },
                      },
                      {
                        id: id(82),
                        title: 'Quiet Board',
                        purpose: 'discussion',
                        visibility: 'protected',
                        recent: { state: 'current', complete: true, threads: [] },
                      },
                      {
                        id: id(83),
                        title: 'Unavailable Board',
                        purpose: 'discussion',
                        visibility: 'draft',
                        recent: { state: 'unavailable' },
                      },
                    ],
                    next: null,
                    unavailable: 0,
                  };
                },
              }}
            />
          }
        >
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </Frame.Provider>,
      ),
    );
    await settle(() => {});
    expect(restored).toEqual(['selected-window']);
    const section = host.querySelector('[data-slot="realm-community-boards"]')!;
    const boardLinks = [...section.querySelectorAll<HTMLAnchorElement>('[data-slot="realm-board-link"]')];
    expect(boardLinks.map((item) => item.textContent)).toEqual(['Supplied Board', 'Quiet Board', 'Unavailable Board']);
    const link = boardLinks[0]!;
    expect(link.textContent).toBe('Supplied Board');
    expect(link.closest('h3')).not.toBeNull();
    expect(link.textContent).not.toContain('Independent description');
    expect(link.className).not.toContain('absolute');
    expect(section.querySelectorAll('a')).toHaveLength(6);
    const recent = section.querySelector<HTMLAnchorElement>('[data-slot="realm-board-recent-link"]')!;
    expect(recent.textContent).toBe('Ordinary thread');
    expect(section.textContent).toContain(m.realm_board_recent_replies({ count: '1' }));
    expect(section.textContent).toContain(m.realm_board_recent_replies_more({ count: '5' }));
    expect(section.textContent).toContain(m.realm_board_recent_replies_unavailable());
    expect(section.querySelectorAll('[data-slot="realm-board-recent-link"]')).toHaveLength(3);
    expect(section.textContent).not.toContain('Beyond recent prefix');
    expect(section.querySelector('[data-slot="realm-board-recent-empty"]')?.textContent).toBe(
      m.realm_board_recent_empty(),
    );
    expect(section.querySelector('[data-slot="realm-board-recent-unavailable"]')?.textContent).toBe(
      m.realm_board_recent_unavailable(),
    );
    const destination = new URL(link.href, 'https://site.test');
    expect(destination.pathname).toBe(`/${locale}/boards/${id(80)}`);
    expect(destination.searchParams.get('returnTo')).toBe(`${returnTo}#realm-board-${id(80)}`);
    const thread = new URL(
      threadLocation(
        locale,
        { id: id(81), title: 'Ordinary thread' },
        undefined,
        undefined,
        undefined,
        link.getAttribute('href')!,
      ),
      'https://site.test',
    );
    expect(new URL(recent.href, 'https://site.test').href).toBe(thread.href);
    const backToBoard = admittedBoardReturn(thread.searchParams.get('boardReturn'))!;
    expect(backToBoard).toBe(link.getAttribute('href')!);
    expect(
      boardSearch(Object.fromEntries(new URL(backToBoard, 'https://site.test').searchParams), locale).returnTo,
    ).toBe(`${returnTo}#realm-board-${id(80)}`);
    expect(document.activeElement?.id).toBe('realm-boards-heading');
  },
);

test('acknowledged native membership refresh keeps the selected Board visit current through thread return', async () => {
  visitLocale = 'en';
  router.history.push('/en/spaces/realm?node=boards&cursor=selected-window');
  await router.load();
  native = fixture(0, 'none');
  native.presentation.members = { state: 'current', count: 7, version: 'members-7' };
  const shelfCursorReads: string[] = [];
  boardRead = async ({ cursor }) => {
    shelfCursorReads.push(cursor ?? '');
    return {
      status: 200,
      data: {
        items: [
          {
            id: id(80),
            realmId: id(1),
            route: 1,
            visibility: 'published',
            securityRevision: '1',
            createdAt: '2026-10-01T00:00:00Z',
            title: 'Supplied Board',
            purpose: 'discussion',
            availability: 'available',
            recent: {
              state: 'current',
              complete: true,
              threads: [
                {
                  thread: { id: id(81), title: 'Ordinary thread' },
                  target: { kind: 'thread', id: id(81), boardId: id(80) },
                  comments: {
                    state: 'current',
                    cohort: 'public',
                    count: { kind: 'exact', value: 1 },
                    lastActivityAt: '2026-11-01T00:00:00Z',
                    source: { epoch: 1, position: '16' },
                  },
                },
              ],
            },
          },
        ],
        next: null,
      },
    };
  };
  client.setQueryData(sessionModule.sessionQuery.queryKey, session);
  const initialRead = capture();
  const initialPage = await readNativeRealmHome(operations, input);
  const initialAdmission = bindSpacePageResult(initialPage, initialRead, {
    kind: 'signed-in',
    subject: session.subject,
  })!;
  await paint(initialPage, operations, initialAdmission);
  await settle(() => {});
  expect(shelfCursorReads).toEqual(['selected-window']);
  expect(host.querySelector('[data-slot="realm-community-boards"]')).not.toBeNull();

  const join = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === m.realm_join())!;
  await settle(() => {
    join.focus();
    join.click();
  });
  await settle(() => {});
  expect(membershipActionCalls).toEqual([`${id(1)}:join`]);
  expect(host.textContent).toContain(m.realm_membership_command_uncertain());

  native = fixture(0, 'member');
  native.presentation.members = { state: 'current', count: 7, version: 'members-7' };
  const refreshedRead = capture();
  const refreshedPage = await readNativeRealmHome(operations, input);
  const refreshedAdmission = bindSpacePageResult(refreshedPage, refreshedRead, {
    kind: 'signed-in',
    subject: session.subject,
  })!;
  await paint(refreshedPage, operations, refreshedAdmission);
  await settle(() => {});
  await settle(() => {});

  expect(host.querySelector('[data-slot="realm-membership"]')?.getAttribute('data-member-state')).toBe('member');
  expect(host.querySelector('[data-slot="community-members"]')?.textContent).toBe(m.board_community_members({ count: 7 }));
  expect(document.activeElement?.id).toBe('realm-boards-heading');
  expect(shelfCursorReads).toEqual(['selected-window', 'selected-window']);
  const section = host.querySelector('[data-slot="realm-community-boards"]')!;
  const boardLink = section.querySelector<HTMLAnchorElement>('[data-slot="realm-board-link"]')!;
  const realmReturn = new URL(boardLink.href, 'https://site.test').searchParams.get('returnTo');
  expect(realmReturn).toBe(`/en/spaces/realm?node=boards&cursor=selected-window#realm-board-${id(80)}`);
  const threadLink = section.querySelector<HTMLAnchorElement>('[data-slot="realm-board-recent-link"]')!;
  const thread = new URL(threadLink.href, 'https://site.test');
  const boardReturn = admittedBoardReturn(thread.searchParams.get('boardReturn'))!;
  expect(boardReturn).toBe(boardLink.getAttribute('href'));
  expect(boardSearch(Object.fromEntries(new URL(boardReturn, 'https://site.test').searchParams), 'en').returnTo).toBe(
    realmReturn,
  );
});

test('installed Home and Board shelf mappings retain native recent and Board visibility fields', async () => {
  native = fixture(0);
  native.boards = {
    items: [
      {
        id: id(80),
        realmId: id(1),
        route: 1,
        securityRevision: '1',
        createdAt: '2026-10-01T00:00:00Z',
        title: 'Supplied Board',
        purpose: 'discussion',
        visibility: 'protected',
        availability: 'available',
        recent: {
          state: 'current',
          complete: true,
          threads: [
            {
              thread: { id: id(81), title: 'Ordinary thread' },
              target: { kind: 'thread', id: id(81), boardId: id(80) },
              comments: {
                state: 'current',
                cohort: 'public',
                count: { kind: 'exact', value: 1 },
                lastActivityAt: '2026-11-01T00:00:00Z',
                source: { epoch: 1, position: '16' },
              },
            },
          ],
        },
      },
    ],
    next: null,
  };
  const page = await readNativeRealmHome(operations, input);
  expect(page.realm!.boards).toEqual([
    {
      id: id(80),
      title: 'Supplied Board',
      purpose: 'discussion',
      visibility: 'protected',
      recent: {
        state: 'current',
        complete: true,
        threads: [{ id: id(81), title: 'Ordinary thread', comments: { state: 'current', kind: 'exact', value: 1 } }],
      },
    },
  ]);

  const shelf = nativeRealmHomeShelves(
    {
      ...operations,
      boardShelf: async ({ cursor }) => {
        expect(cursor).toBe('boards-next');
        return {
          status: 200,
          data: {
            items: [
              {
                id: id(82),
                realmId: id(1),
                route: 1,
                visibility: 'draft',
                securityRevision: '1',
                createdAt: '2026-10-02T00:00:00Z',
                title: 'Continued Board',
                purpose: 'discussion',
                availability: 'available',
                recent: { state: 'unavailable' },
              },
            ],
            next: null,
          },
        };
      },
    },
    input,
  );
  expect(await shelf.boards({ cursor: 'boards-next' })).toEqual({
    kind: 'page',
    items: [
      {
        id: id(82),
        title: 'Continued Board',
        purpose: 'discussion',
        visibility: 'draft',
        recent: { state: 'unavailable' },
      },
    ],
    next: null,
    unavailable: 0,
  });
});
