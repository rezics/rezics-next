import { afterAll, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { act, createElement, StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import type { Root } from 'react-dom/client';
import type { QueryClient } from '@tanstack/react-query';
import type { MembershipResult, MyRealmsPage } from '../src/community/space';
import type { MyRealmsNativeItem } from '../src/community/my-realms-current/contract';
import { formatMyRealmsCurrent } from '../src/community/my-realms-native';
import recording from '../src/kernel/recorded/my-realms.json';
import * as start from '../.storybook/react-start';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.example.test/en/realms' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Node: window.Node,
  Element: window.Element,
  Event: window.Event,
  scrollTo: window.scrollTo.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

type ReadInput = { cursor?: string };
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void };
type MembershipCommandInput = {
  data: { realmId: string; action: 'join' | 'leave'; idempotencyKey: string };
  headers: { 'X-CSRF-Token': string };
};
const readCalls: ReadInput[] = [];
const standingReads: string[] = [];
const membershipCommands: MembershipCommandInput[] = [];
let readPage: (input: ReadInput) => Promise<MyRealmsPage> = async () => page('Current account realm');
let standingState: 'member' | 'none' | 'pending' | 'banned' = 'member';
let sendMembership: (input: MembershipCommandInput) => Promise<MembershipResult> = async () => ({
  outcome: 'accepted',
  workflowId: 'my-realms-workflow',
});
let mockReaderSession: { state: string; subject: string | null; csrfToken: string | null } = {
  state: 'signed-in',
  subject: 'realm-owner',
  csrfToken: 'csrf-original',
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function page(name: string, next: string | null = null, leaveAvailable = false): MyRealmsPage {
  const readerOrigin =
    mockReaderSession.state === 'signed-in' && mockReaderSession.subject
      ? {
          kind: 'session' as const,
          subject: mockReaderSession.subject,
          csrfFingerprint: createHash('sha256')
            .update(mockReaderSession.csrfToken === null ? 'null\u0000' : `token\u0000${mockReaderSession.csrfToken}`)
            .digest('hex'),
        }
      : { kind: 'anonymous' as const };
  return {
    signedIn: true,
    realms: [currentRow(name, leaveAvailable)],
    next,
    readerOrigin,
  };
}

function currentRow(name: string, leaveAvailable = false) {
  const source = recording.items[0];
  if (!source) throw new Error('The refreshed My Realms recording needs a current row.');
  const realmId = '0192f3a0-6c1e-7b2a-9d4e-000000000201';
  const item: MyRealmsNativeItem = {
    ...source,
    realmId,
    name,
    current: {
      ...source.current,
      description: `Private description for ${name}`,
      destination: { ...source.current.destination, realmId },
      actions: {
        state: 'current',
        enter: { state: 'prohibited', reason: 'not_authorized' },
        manage: { state: 'prohibited', reason: 'not_authorized' },
        leave: leaveAvailable
          ? {
              state: 'available',
              method: 'DELETE',
              path: `/v1/realms/${realmId}/membership`,
              body: null,
              expectedStatus: 202,
            }
          : { state: 'unavailable', reason: 'last_explicit_holder' },
      },
    },
  };
  const [row] = formatMyRealmsCurrent({ items: [item], next: null }).realms;
  if (!row) throw new Error('Expected the current My Realms row.');
  return row;
}

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => start.getRequest(),
  setResponseHeader: () => undefined,
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/community/space-actions', () => ({
  readMyRealmsPage: ({ data }: { data: ReadInput }) => {
    readCalls.push(data);
    return readPage(data);
  },
  changeRealmMembership: (input: MembershipCommandInput) => {
    membershipCommands.push(input);
    return sendMembership(input);
  },
}));
mock.module('../src/community/realm-membership-actions', () => ({
  readRealmMembership: ({ data }: { data: { realmId: string } }) => {
    standingReads.push(data.realmId);
    return { state: standingState, idempotencyKey: `standing-${standingReads.length}` };
  },
}));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRouteWithContext, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const { createRoot, hydrateRoot } = await import('react-dom/client');
const { deLocalizeUrl, localizeUrl, setLocale } = await import('../src/paraglide/runtime.js');
const { sessionQuery } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');
const { Route: MyRealmsRoute } = await import('../src/routes/realms/index');

function signedIn(subject = 'realm-owner', csrfToken: string | null = 'csrf-original') {
  return { state: 'signed-in' as const, subject, csrfToken };
}

function signedOut() {
  return { state: 'signed-out' as const, subject: null, csrfToken: null };
}

async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function until(predicate: () => boolean, label: string) {
  for (let turn = 0; turn < 120; turn++) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function activateLink(link: HTMLAnchorElement, detail: number) {
  await act(async () => {
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail }));
  });
}

type Surface = Awaited<ReturnType<typeof createSurface>>;

async function createSurface(options: { locale?: 'en' | 'zh-Hant'; cursor?: string } = {}) {
  const locale = options.locale ?? 'en';
  await setLocale(locale, { reload: false });
  window.document.head.innerHTML = '<link rel="canonical" href="https://site.example.test/en/realms">';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockReaderSession = signedIn();
  client.setQueryData(sessionQuery.queryKey, signedIn());
  const rootRoute = createRootRouteWithContext<{
    queryClient: QueryClient;
    credentialMode: 'anonymous' | 'session';
  }>()({ component: Outlet });
  const actualRoute = (
    MyRealmsRoute as unknown as {
      update(options: { id: string; path: string; getParentRoute: () => typeof rootRoute }): unknown;
    }
  ).update({ id: '/realms/', path: '/realms/', getParentRoute: () => rootRoute });
  const routeTree = rootRoute.addChildren([actualRoute as never]);
  const cursorSearch = options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : '';
  const router = createRouter({
    routeTree: routeTree as never,
    context: { queryClient: client, credentialMode: 'anonymous' },
    history: createMemoryHistory({ initialEntries: [`/${locale}/realms${cursorSearch}`] }),
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  } as never);
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  let root: Root | undefined;
  let unmountRoot: (() => void) | undefined;

  const tree = (strict = false) => {
    const routed = createElement(RouterProvider, { router: router as never });
    return createElement(QueryClientProvider, { client }, strict ? createElement(StrictMode, null, routed) : routed);
  };

  async function mount(strict = false) {
    if (root) return;
    if (!host.isConnected) window.document.body.append(host);
    root = createRoot(host);
    unmountRoot = () => root?.unmount();
    await act(async () => root!.render(tree(strict)));
  }

  async function hydrate(strict = false) {
    if (root) return;
    unmountRoot = undefined;
    await act(async () => {
      root = undefined;
      const hydrate = hydrateRoot(host, tree(strict), { onRecoverableError: (error) => hydrationErrors.push(error) });
      root = { unmount: () => hydrate.unmount() } as Root;
      unmountRoot = () => hydrate.unmount();
    });
  }

  async function dispose() {
    await unmountSurface();
    client.clear();
    host.remove();
  }

  async function unmountSurface() {
    if (unmountRoot) {
      const disposeRoot = unmountRoot;
      unmountRoot = undefined;
      await act(async () => disposeRoot());
      root = undefined;
      await settle();
    }
  }

  async function setSession(
    value:
      | ReturnType<typeof signedIn>
      | ReturnType<typeof signedOut>
      | { state: 'unknown' | 'unavailable'; subject: string | null; csrfToken: string | null },
  ) {
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, value);
      mockReaderSession = value;
    });
  }

  return {
    client,
    router,
    host,
    tree,
    mount,
    hydrate,
    dispose,
    unmount: unmountSurface,
    setSession,
    load: () => router.load(),
  };
}

const hydrationErrors: unknown[] = [];

function visiblePrivateNames(surface: Surface) {
  return surface.host.textContent ?? '';
}

async function untilMounted(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function clickButton(surface: Surface, label: string) {
  const button = [...surface.host.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}

function resetReader(
  implementation: (input: ReadInput) => Promise<MyRealmsPage> = async () => page('Current account realm'),
) {
  readCalls.length = 0;
  standingReads.length = 0;
  membershipCommands.length = 0;
  standingState = 'member';
  sendMembership = async () => ({ outcome: 'accepted', workflowId: 'my-realms-workflow' });
  hydrationErrors.length = 0;
  readPage = implementation;
}

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('the actual signed-in route hydrates its one read through the current query result and keeps SSR metadata with unavailable entry', async () => {
  resetReader(async () => page('SSR member realm', 'opaque-next-cursor'));
  const surface = await createSurface();
  try {
    await surface.load();
    // Exercise the route's loader envelope when query data is not available after hydration.
    surface.client.removeQueries({ queryKey: ['my-realms', ''], exact: true });
    const markup = renderToString(surface.tree());
    expect(markup).toContain('SSR member realm');
    expect(markup).toContain('Private description for SSR member realm');
    expect(markup).not.toContain('href="/en/realms/0192f3a0-6c1e-7b2a-9d4e-000000000201"');
    expect(readCalls).toEqual([{}]);

    surface.host.innerHTML = markup;
    await surface.hydrate();
    await settle();
    expect(hydrationErrors).toEqual([]);
    expect(visiblePrivateNames(surface)).toContain('SSR member realm');
    expect(readCalls).toHaveLength(1);
    expect(visiblePrivateNames(surface)).toContain(m.my_realms_action_prohibited({ action: m.my_realms_open() }));
    expect(visiblePrivateNames(surface)).toContain(m.my_realms_action_prohibited({ action: m.my_realms_manage() }));
    expect(visiblePrivateNames(surface)).toContain(m.realm_leave_owner_required());
    expect(standingReads).toEqual([]);
    expect([...surface.host.querySelectorAll('button')].some((button) => button.textContent === m.realm_leave())).toBe(
      false,
    );
  } finally {
    await surface.dispose();
  }
});

test('one selected leave requires review, cancels cleanly, and retries an uncertain write with its exact identity', async () => {
  resetReader(async () => page('Selected current member', null, true));
  let commandIndex = 0;
  sendMembership = async () => {
    if (commandIndex++ === 0) throw new Error('Response was lost after submission');
    return { outcome: 'accepted', workflowId: 'my-realms-workflow' };
  };
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount();
    expect(standingReads).toEqual([]); // No membership read per listed row or on initial render.

    await clickButton(surface, m.realm_leave());
    expect(surface.host.querySelector('[data-slot="my-realms-leave-review"]')?.getAttribute('data-phase')).toBe(
      'review',
    );
    await clickButton(surface, m.action_cancel());
    expect(surface.host.querySelector('[data-slot="my-realms-leave-review"]')).toBeNull();
    expect(membershipCommands).toEqual([]);
    expect(standingReads).toEqual([]);

    await clickButton(surface, m.realm_leave());
    await clickButton(surface, m.my_realms_leave_confirm_button());
    await untilMounted(
      () => membershipCommands.length === 1 && surface.host.querySelector('[data-phase="uncertain"]') !== null,
      'uncertain selected leave',
    );
    expect(standingReads).toEqual([]); // A read cannot settle an uncertain write.
    const original = membershipCommands[0];
    expect(surface.host.querySelector('[data-phase="uncertain"]')).not.toBeNull();
    await clickButton(surface, m.realm_leave_retry_same());
    await untilMounted(
      () => membershipCommands.length === 2 && surface.host.querySelector('[data-phase="pending"]') !== null,
      'accepted exact replay',
    );
    const command = membershipCommands[0];
    expect(command?.data).toMatchObject({
      realmId: '0192f3a0-6c1e-7b2a-9d4e-000000000201',
      action: 'leave',
    });
    expect(command?.data.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(membershipCommands[1]?.data.idempotencyKey).toBe(original?.data.idempotencyKey);
    expect(membershipCommands[1]?.headers['X-CSRF-Token']).toBe(original?.headers['X-CSRF-Token']);
    expect(command?.headers['X-CSRF-Token']).toBe('csrf-original');
    expect(surface.host.querySelector('[data-slot="my-realms-leave-review"]')?.getAttribute('data-workflow-id')).toBe(
      'my-realms-workflow',
    );
    await untilMounted(
      () => standingReads.length >= 4 && visiblePrivateNames(surface).includes(m.realm_members_current()),
      'current membership standing after acceptance',
    );
    expect(surface.host.querySelector('[data-phase="pending"]')).not.toBeNull();
    expect(visiblePrivateNames(surface)).toContain(m.realm_members_current());

    await clickButton(surface, m.realm_membership_retry());
    await untilMounted(
      () => standingReads.length >= 8 && visiblePrivateNames(surface).includes(m.realm_members_current()),
      'explicit current-standing refresh',
    );
    expect(standingReads).toHaveLength(8);
    expect(surface.host.querySelector('[data-phase="pending"]')).not.toBeNull();
    expect(membershipCommands).toHaveLength(2); // Refresh never retries the command.
  } finally {
    await surface.dispose();
  }
});

test('a native last-owner refusal names the owner rule and does not start a standing read', async () => {
  resetReader(async () => page('Last explicit owner', null, true));
  sendMembership = async () => ({ outcome: 'refused', effect: 'not-applied', ownerReason: 'last-owner' });
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount();
    await clickButton(surface, m.realm_leave());
    await clickButton(surface, m.my_realms_leave_confirm_button());
    await untilMounted(() => surface.host.querySelector('[data-phase="refused"]') !== null, 'native owner refusal');
    expect(visiblePrivateNames(surface)).toContain(m.realm_leave_owner_required());
    expect(standingReads).toEqual([]);
    expect(membershipCommands).toHaveLength(1);
  } finally {
    await surface.dispose();
  }
});

test('a selected review retires on Account or CSRF replacement before the command can run', async () => {
  for (const replacement of [signedIn('replacement-account', 'csrf-next'), signedIn('realm-owner', 'csrf-next')]) {
    resetReader(async () => page('Selected member', null, true));
    const surface = await createSurface();
    try {
      await surface.load();
      await surface.mount();
      await clickButton(surface, m.realm_leave());
      expect(surface.host.querySelector('[data-phase="review"]')).not.toBeNull();

      await surface.setSession(replacement);
      await untilMounted(
        () => surface.host.querySelector('[data-slot="my-realms-leave-review"]') === null,
        'retired selection after session replacement',
      );
      expect(membershipCommands).toEqual([]);
      expect(standingReads).toEqual([]);
    } finally {
      await surface.dispose();
    }
  }
});

test('the actual current route reads once under StrictMode and renders the QueryClient success with the complete ContentItem', async () => {
  resetReader(async () => page('Query-owned realm'));
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount(true);
    expect(readCalls).toEqual([{}]);
    expect(visiblePrivateNames(surface)).toContain('Query-owned realm');
    expect(visiblePrivateNames(surface)).toContain('Private description for Query-owned realm');
    expect(surface.host.querySelector('h2')?.textContent).toBe('Query-owned realm');
    expect(surface.host.querySelector('li a')).toBeNull();
  } finally {
    await surface.dispose();
  }
});

test('same-account CSRF replacement and a batched away/back session transition retire the ready loader and query views', async () => {
  for (const transition of ['csrf', 'away-back'] as const) {
    resetReader(async () => page(`Old ${transition} realm`));
    const surface = await createSurface();
    try {
      await surface.load();
      await surface.mount();
      expect(visiblePrivateNames(surface)).toContain(`Old ${transition} realm`);
      if (transition === 'csrf') await surface.setSession(signedIn('realm-owner', 'csrf-replaced'));
      else {
        await act(async () => {
          surface.client.setQueryData(sessionQuery.queryKey, signedOut());
          surface.client.setQueryData(sessionQuery.queryKey, signedIn());
        });
      }
      await settle();
      expect(visiblePrivateNames(surface)).not.toContain(`Old ${transition} realm`);
      expect(surface.client.getQueryData(['my-realms', ''])).toBeUndefined();
    } finally {
      await surface.dispose();
    }
  }
});

test('signed-out, replaced-account and unavailable readiness transitions close the original list without borrowing replacement credentials', async () => {
  for (const next of [
    signedOut(),
    signedIn('different-owner', 'csrf-replacement'),
    { state: 'unknown' as const, subject: 'realm-owner', csrfToken: 'csrf-original' },
    { state: 'unavailable' as const, subject: null, csrfToken: null },
  ]) {
    resetReader(async () => page('Original private realm'));
    const surface = await createSurface();
    try {
      await surface.load();
      await surface.mount();
      await surface.setSession(next);
      await settle();
      expect(visiblePrivateNames(surface)).not.toContain('Original private realm');
      expect(surface.client.getQueryData(['my-realms', ''])).toBeUndefined();
    } finally {
      await surface.dispose();
    }
  }
});

test('a fresh explicit visit after a same-account credential replacement uses a new caller and is usable', async () => {
  resetReader(async () => page(`Current visit ${readCalls.length}`));
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount();
    expect(visiblePrivateNames(surface)).toContain('Current visit 1');
    await surface.setSession(signedIn('realm-owner', 'csrf-next'));
    await settle();
    expect(visiblePrivateNames(surface)).not.toContain('Current visit 1');
    await surface.router.invalidate();
    await settle();
    expect(readCalls).toHaveLength(2);
    expect(visiblePrivateNames(surface)).toContain('Current visit 2');
  } finally {
    await surface.dispose();
  }
});

test('a retired keyboard continuation cannot focus or reveal its late private result', async () => {
  const response = deferred<MyRealmsPage>();
  const cursor = 'opaque-retired-continuation';
  resetReader(async (input) => (input.cursor ? response.promise : page('Current first-page realm', cursor)));
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount();
    await activateLink(surface.host.querySelector<HTMLAnchorElement>('a[href*="cursor="]')!, 0);
    await until(() => readCalls.length === 2, 'the keyboard continuation read');
    await surface.setSession(signedIn('realm-owner', 'csrf-replacement'));
    response.resolve(page('Late original realm'));
    await until(() => surface.router.state.status === 'idle', 'the retired route result');
    await settle();
    expect(surface.client.getQueryData(['my-realms', cursor])).toBeUndefined();
    expect(surface.host.textContent ?? '').not.toContain('Late original realm');
    expect(surface.host.textContent ?? '').not.toContain('Current first-page realm');
    expect(surface.host.querySelector('section[aria-labelledby] h1')).toBeNull();
    expect(surface.host.textContent).not.toContain(m.prq_previous());
  } finally {
    response.resolve(page('Settled response'));
    await surface.dispose();
  }
});

test('a session transition while the route import is queued skips the private read', async () => {
  resetReader(async () => page('Should never be read'));
  const surface = await createSurface();
  try {
    const originalFetchQuery = surface.client.fetchQuery.bind(surface.client);
    surface.client.fetchQuery = ((options: { queryKey?: readonly unknown[] }) => {
      const pending = originalFetchQuery(options as never);
      if (options.queryKey?.[0] === 'my-realms') surface.client.setQueryData(sessionQuery.queryKey, signedOut());
      return pending;
    }) as typeof surface.client.fetchQuery;
    const loading = surface.load();
    await loading;
    expect(surface.router.state.matches.some((match) => match.status === 'error')).toBe(true);
    expect(readCalls).toHaveLength(0);
    expect(surface.client.getQueryData(['my-realms', ''])).toBeUndefined();
  } finally {
    await surface.dispose();
  }
});

test('keyboard continuation focuses the admitted heading on an empty terminal page', async () => {
  const cursor = 'opaque-terminal-page';
  resetReader(async (input) =>
    input.cursor ? { ...page('Empty terminal page'), realms: [] } : page('First-page realm', cursor),
  );
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount();
    expect(window.document.activeElement).not.toBe(surface.host.querySelector('section[aria-labelledby] h1'));
    await activateLink(surface.host.querySelector<HTMLAnchorElement>('a[href*="cursor="]')!, 0);
    await until(
      () => readCalls.length === 2 && surface.router.state.status === 'idle',
      'the terminal keyboard continuation',
    );
    const heading = surface.host.querySelector<HTMLHeadingElement>('section[aria-labelledby] h1')!;
    expect(heading.id).not.toBe('');
    expect(heading.tabIndex).toBe(-1);
    expect(surface.host.querySelector('section')?.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(surface.host.textContent).toContain(m.realms_empty());
    expect(surface.host.textContent).toContain(m.prq_previous());
    expect(surface.host.textContent).toContain(m.realms_first_page());
    expect(surface.host.querySelector('a[href*="cursor="]')).toBeNull();
    expect(window.document.activeElement).toBe(heading);
  } finally {
    await surface.dispose();
  }
});

test('cursor and locale changes form a new route visit, keep native cursor order and perform one read per visit', async () => {
  const cursor = 'opaque/next?private=%25';
  resetReader(async (input) =>
    page(input.cursor ? 'Second cursor realm' : 'First cursor realm', input.cursor ? 'native-next-cursor' : cursor),
  );
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount();
    expect(visiblePrivateNames(surface)).toContain('First cursor realm');
    expect(window.document.activeElement).not.toBe(surface.host.querySelector('section[aria-labelledby] h1'));
    await activateLink(surface.host.querySelector<HTMLAnchorElement>('a[href*="cursor="]')!, 1);
    await until(() => readCalls.length === 2 && surface.router.state.status === 'idle', 'the pointer cursor visit');
    expect(readCalls).toEqual([{}, { cursor }]);
    expect(visiblePrivateNames(surface)).toContain('Second cursor realm');
    expect(surface.host.querySelector('a[href*="cursor="]')).not.toBeNull();
    expect(window.document.activeElement).not.toBe(surface.host.querySelector('section[aria-labelledby] h1'));

    await setLocale('zh-Hant', { reload: false });
    surface.router.history.push(`/zh-Hant/realms?cursor=${encodeURIComponent(cursor)}`);
    await until(() => readCalls.length === 3, 'the locale-specific route visit');
    await settle();
    expect(readCalls).toHaveLength(3);
    expect(visiblePrivateNames(surface)).toContain('Second cursor realm');
    await surface.router.invalidate();
    await settle();
    expect(window.document.activeElement).not.toBe(surface.host.querySelector('section[aria-labelledby] h1'));
  } finally {
    await surface.dispose();
  }
});

test('a failed continuation keeps same-request retry and restarts through a fresh first-page visit', async () => {
  const cursor = 'opaque/failed?private=%25';
  resetReader(async (input) => {
    if (input.cursor) throw new Error('Realm list is unavailable');
    return readCalls.length === 1 ? page('Initial first-page realm', cursor) : page('Recovered first-page realm');
  });
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount();
    await activateLink(surface.host.querySelector<HTMLAnchorElement>('a[href*="cursor="]')!, 0);
    await until(
      () => readCalls.length === 2 && surface.router.state.status === 'idle',
      'the failed keyboard continuation',
    );
    expect(surface.host.querySelector('button')).not.toBeNull();
    expect(surface.host.textContent).not.toContain('Initial first-page realm');
    expect(surface.host.querySelector('section[aria-labelledby] h1')).toBeNull();
    expect(surface.router.state.location.search).toEqual({ cursor });
    const retry = surface.host.querySelector('button')!;
    await act(async () => retry.click());
    await until(() => readCalls.length === 3 && surface.router.state.status === 'idle', 'the same cursor retry');
    expect(readCalls).toEqual([{}, { cursor }, { cursor }]);
    expect(surface.client.getQueryState(['my-realms', cursor])).toBeUndefined();

    const firstPage = surface.host.querySelector<HTMLAnchorElement>('a[href="/en/realms"]');
    expect(firstPage?.textContent).toBe(m.realms_first_page());
    await act(async () => firstPage!.click());
    await until(() => visiblePrivateNames(surface).includes('Recovered first-page realm'), 'the first-page route');
    expect(readCalls).toEqual([{}, { cursor }, { cursor }, {}]);
    expect(surface.router.state.location.search).toEqual({});
    expect(surface.client.getQueryState(['my-realms', cursor])).toBeUndefined();
  } finally {
    await surface.dispose();
  }

  resetReader(async () => {
    throw Object.assign(new Error('My Realms access is denied'), { status: 403 });
  });
  const denied = await createSurface({ cursor });
  try {
    await denied.load();
    expect(denied.router.state.matches.some((match) => match.status === 'error')).toBe(true);
    await denied.mount();
    expect(denied.host.querySelector('a[href="/en/realms"]')).toBeNull();
  } finally {
    await denied.dispose();
  }
});

test('unmount retires saved loader callbacks; a later explicit visit can load a fresh list', async () => {
  resetReader(async () => page(`Mounted visit ${readCalls.length}`));
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount();
    expect(visiblePrivateNames(surface)).toContain('Mounted visit 1');
    await surface.unmount();
    await surface.mount();
    await settle();
    expect(visiblePrivateNames(surface)).not.toContain('Mounted visit 1');
    await surface.router.invalidate();
    await settle();
    expect(readCalls).toHaveLength(2);
    expect(visiblePrivateNames(surface)).toContain('Mounted visit 2');
  } finally {
    await surface.dispose();
  }
});

function inventoryLink(surface: Surface, label: string) {
  return [...surface.host.querySelectorAll<HTMLAnchorElement>('nav a')].find((link) => link.textContent === label)!;
}

async function moveInventory(surface: Surface, label: string, keyboard = false) {
  const count = readCalls.length;
  await activateLink(inventoryLink(surface, label), keyboard ? 0 : 1);
  await until(() => readCalls.length > count && surface.router.state.status === 'idle', label);
}

test('three guarded native windows return through sparse and terminal pages, retrying exact Previous and First targets', async () => {
  const second = 'opaque/second?keep=%2F';
  const third = 'x'.repeat(4096);
  let failure: string | null | undefined;
  resetReader(async ({ cursor }) => {
    if ((cursor ?? null) === failure) throw new Error('Temporary reading failure');
    return cursor === third
      ? { ...page('Terminal'), realms: [] }
      : cursor === second
        ? { ...page('Sparse', third), realms: [] }
        : page('First', second);
  });
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount();
    await moveInventory(surface, m.realms_more());
    expect(surface.host.textContent).toContain(m.realm_list_details_sparse_page_empty());
    await moveInventory(surface, m.realms_more(), true);
    expect(surface.host.textContent).toContain(m.realms_empty());
    expect(window.document.activeElement).toBe(surface.host.querySelector('section h1'));
    failure = second;
    await moveInventory(surface, m.prq_previous(), true);
    expect(surface.router.state.location.search).toEqual({ cursor: second });
    expect(surface.host.querySelector('section[aria-labelledby] h1')).toBeNull();
    failure = undefined;
    await act(async () => surface.host.querySelector('button')!.click());
    await until(() => readCalls.length === 5 && surface.router.state.status === 'idle', 'exact Previous Retry');
    expect(inventoryLink(surface, m.prq_previous()).getAttribute('href')).toBe('/en/realms');
    failure = null;
    await moveInventory(surface, m.realms_first_page());
    expect(surface.router.state.location.search).toEqual({});
    failure = undefined;
    await act(async () => surface.host.querySelector('button')!.click());
    await until(() => readCalls.length === 7 && surface.router.state.status === 'idle', 'exact First Retry');
    expect(surface.host.textContent).toContain('First');
    expect(inventoryLink(surface, m.prq_previous())).toBeUndefined();
    expect(readCalls).toEqual([
      {},
      { cursor: second },
      { cursor: third },
      { cursor: second },
      { cursor: second },
      {},
      {},
    ]);
    expect(surface.client.getQueryCache().findAll({ queryKey: ['my-realms'] })).toHaveLength(1);
  } finally {
    await surface.dispose();
  }
});

test('eight retained predecessors bound branching; direct cursor visits invent no predecessor', async () => {
  // Coordinates are supplied by this reader, never computed by the consumer.
  const coordinates = Array.from({ length: 12 }, (_, i) => `native-coordinate-${i}`);
  let branch = false;
  resetReader(async ({ cursor }) => {
    const index = cursor ? coordinates.indexOf(cursor) + 1 : 0;
    return page(`Window ${index}`, branch ? 'native-branch' : (coordinates[index] ?? null));
  });
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount();
    for (let i = 0; i < 10; i++) await moveInventory(surface, m.realms_more());
    await moveInventory(surface, m.prq_previous());
    branch = true;
    await moveInventory(surface, m.realms_more());
    await moveInventory(surface, m.realms_more());
    for (let i = 0; i < 8; i++) await moveInventory(surface, m.prq_previous());
    expect(inventoryLink(surface, m.prq_previous())).toBeUndefined();
    expect(surface.host.textContent).toContain('Window 3');
    await moveInventory(surface, m.realms_first_page(), true);
    expect(surface.router.state.location.search).toEqual({});
    expect(window.document.activeElement).toBe(surface.host.querySelector('section h1'));
    expect(inventoryLink(surface, m.prq_previous())).toBeUndefined();
    expect(surface.client.getQueryCache().findAll({ queryKey: ['my-realms'] })).toHaveLength(1);
  } finally {
    await surface.dispose();
  }
  const direct = await createSurface({ cursor: coordinates[5] });
  try {
    await direct.load();
    await direct.mount();
    expect(inventoryLink(direct, m.prq_previous())).toBeUndefined();
    expect(inventoryLink(direct, m.realms_first_page())).toBeDefined();
    await moveInventory(direct, m.realms_first_page());
    expect(direct.router.state.location.search).toEqual({});
  } finally {
    await direct.dispose();
  }
});

test('rapid navigation is serialized and focus follows Previous only while the reader stays with its trigger', async () => {
  const response = deferred<MyRealmsPage>();
  let returning = false;
  resetReader(async ({ cursor }) => (cursor ? page('Second') : returning ? response.promise : page('First', 'second')));
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount();
    await moveInventory(surface, m.realms_more());
    returning = true;
    const previous = inventoryLink(surface, m.prq_previous());
    previous.focus();
    await act(async () => {
      previous.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
      previous.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
    });
    await until(() => readCalls.length === 3, 'one Previous read');
    const elsewhere = window.document.createElement('button');
    window.document.body.append(elsewhere);
    elsewhere.focus();
    response.resolve(page('First reread', 'second'));
    await until(() => surface.router.state.status === 'idle', 'Previous admission');
    expect(readCalls).toEqual([{}, { cursor: 'second' }, {}]);
    expect(window.document.activeElement).toBe(elsewhere);
    elsewhere.remove();
    await moveInventory(surface, m.realms_more());
    await moveInventory(surface, m.prq_previous(), true);
    expect(window.document.activeElement).toBe(surface.host.querySelector('section h1'));
  } finally {
    response.resolve(page('Settled'));
    await surface.dispose();
  }
});

test('equal source replacement and A/B/A retire staged return coordinates despite ignored cancellation', async () => {
  for (const replace of ['equal', 'aba'] as const) {
    const response = deferred<MyRealmsPage>();
    let returning = false;
    resetReader(async ({ cursor }) =>
      cursor ? page('Second') : returning ? response.promise : page('First', 'second'),
    );
    const surface = await createSurface();
    try {
      await surface.load();
      await surface.mount();
      await moveInventory(surface, m.realms_more());
      returning = true;
      await activateLink(inventoryLink(surface, m.prq_previous()), 0);
      await until(() => readCalls.length === 3, 'pending return');
      if (replace === 'aba') await surface.setSession(signedIn('other-account'));
      await surface.setSession(signedIn());
      const replacement = surface.client.getQueryCache().build(surface.client, { queryKey: ['my-realms', ''] });
      replacement.setData(page('Replacement query'));
      response.resolve(page('Retired return'));
      await until(() => surface.router.state.status === 'idle', 'retired return');
      expect(surface.host.textContent).not.toContain('Retired return');
      expect(inventoryLink(surface, m.prq_previous())).toBeUndefined();
      expect(surface.client.getQueryCache().find({ queryKey: ['my-realms', ''], exact: true })).toBe(replacement);
      await surface.router.invalidate();
      await until(() => surface.host.textContent?.includes('Retired return') ?? false, 'fresh return');
      expect(inventoryLink(surface, m.prq_previous())).toBeUndefined();
      expect(window.document.activeElement).not.toBe(surface.host.querySelector('section h1'));
    } finally {
      response.resolve(page('Settled'));
      await surface.dispose();
    }
  }
});
