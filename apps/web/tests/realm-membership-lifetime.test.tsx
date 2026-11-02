import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { MembershipResult } from '../src/community/space';
import type { RealmViewer } from '../src/community/realm-membership-queries';
import { realmMembershipQuery } from '../src/community/realm-membership-queries';
import { useRealmMembershipCaller } from '../src/community/realm-membership-lifetime';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({ ...start, getRequest: () => start.getRequest() }));
mock.module('cloudflare:workers', () => ({ env: {} }));

type MembershipCommand = {
  data: { realmId: string; action: 'join' | 'leave'; idempotencyKey: string };
  headers: { 'X-CSRF-Token': string };
};

const standingReads: string[] = [];
const membershipCommands: MembershipCommand[] = [];
let readMembership: (realmId: string) => Promise<RealmViewer | null> = async () => viewer('member');
let sendMembership: (input: MembershipCommand) => Promise<MembershipResult> = async () => ({
  outcome: 'accepted',
  workflowId: 'lifetime-workflow',
});

mock.module('../src/community/realm-membership-actions', () => ({
  readRealmMembership: ({ data }: { data: { realmId: string } }) => {
    standingReads.push(data.realmId);
    return readMembership(data.realmId);
  },
}));
mock.module('../src/community/space-actions', () => ({
  changeRealmMembership: (input: MembershipCommand) => {
    membershipCommands.push(input);
    return sendMembership(input);
  },
}));

const sessionModule = await import('../src/session/query');
const { RealmMembership } = await import('../src/community/realm-membership');
const { BoardStartThread } = await import('../src/threads/board-community-actions');
const { m } = await import('../src/paraglide/messages.js');

const realmId = '0192f3a0-6c1e-7b2a-9d4e-000000000201';
const nextRealmId = '0192f3a0-6c1e-7b2a-9d4e-000000000202';
const boardId = '0192f3a0-6c1e-7b2a-9d4e-000000000301';
const spaceId = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
const subject = 'lifetime-person';
const replacementSubject = 'replacement-person';
const idempotencyKey = '123e4567-e89b-42d3-a456-426614174000';

function viewer(state: RealmViewer['state'], key = idempotencyKey): RealmViewer {
  return { state, idempotencyKey: key };
}

function signedIn(account = subject, csrfToken: string | null = 'csrf-original') {
  return { state: 'signed-in' as const, subject: account, csrfToken };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type SurfaceConfig = {
  realmId: string;
  boardRealmId?: string | null;
  realmAvailable?: boolean;
};

function MembershipSurface({ config }: { config: SurfaceConfig }) {
  const id = config.realmId;
  const boardRealmId = config.boardRealmId === undefined ? id : config.boardRealmId;
  const realm = { id, visibility: 'public' as const, viewer: null };
  const board = {
    id: boardId,
    realmId: boardRealmId,
    availability: 'available',
    visibility: 'published',
  } as Parameters<typeof BoardStartThread>[0]['board'];
  const boardRealm =
    config.realmAvailable === false
      ? undefined
      : boardRealmId
        ? { id: boardRealmId, title: 'Realm', visibility: 'public' as const, state: 'active' }
        : undefined;
  return createElement(
    'div',
    null,
    createElement(RealmMembership, { realm, returnTo: '/spaces/atlas', spaceId }),
    createElement(BoardStartThread, { board, realm: boardRealm, returnTo: `/boards/${boardId}` }),
  );
}

/** A real caller starts the production shared query, then publishes several authority notifications in one effect. */
function TransitionWhileImportIsQueued({ realm }: { realm: string }) {
  const client = useQueryClient();
  const caller = useRealmMembershipCaller(client, realm, subject, 'csrf-original');
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    void client.fetchQuery(realmMembershipQuery(realm, subject, caller)).catch(() => {});
    client.setQueryData(sessionModule.sessionQuery.queryKey, signedIn(replacementSubject, 'csrf-other'));
    client.setQueryData(sessionModule.sessionQuery.queryKey, signedIn());
  }, [client, realm]);
  return null;
}

async function makeSurface(
  config: SurfaceConfig = { realmId },
  suppliedClient?: QueryClient,
  options: { transitionWhileImportIsQueued?: boolean } = {},
) {
  const client = suppliedClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.example.test/en/spaces/atlas' });
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
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  client.setQueryData(sessionModule.sessionQuery.queryKey, signedIn());
  const configRef = { current: config };
  const route = createRootRoute({
    component: () =>
      createElement(
        'div',
        null,
        options.transitionWhileImportIsQueued
          ? createElement(TransitionWhileImportIsQueued, { realm: configRef.current.realmId })
          : null,
        createElement(MembershipSurface, { config: configRef.current }),
      ),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host as unknown as HTMLElement);
  let disposed = false;
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
  });

  async function settle() {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }

  async function until(predicate: () => boolean, label: string) {
    for (let turn = 0; turn < 200; turn++) {
      if (predicate()) return;
      await settle();
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  async function updateConfig(next: SurfaceConfig, nextClient = client) {
    configRef.current = next;
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client: nextClient }, createElement(RouterProvider, { router })),
      );
    });
  }

  async function setSessions(...sessions: ReturnType<typeof signedIn>[]) {
    await act(async () => {
      for (const value of sessions) client.setQueryData(sessionModule.sessionQuery.queryKey, value);
    });
  }

  function button(label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll('button')].find((item) => item.textContent === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found as HTMLButtonElement;
  }

  function hasText(text: string) {
    return host.textContent?.includes(text) ?? false;
  }

  function hasBoardEntry() {
    return [...host.querySelectorAll('a')].some((item) => item.textContent?.includes(m.board_start_thread()));
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }

  return { client, host, router, settle, until, updateConfig, setSessions, button, hasText, hasBoardEntry, dispose };
}

function resetFixtures() {
  standingReads.length = 0;
  membershipCommands.length = 0;
  readMembership = async () => viewer('member');
  sendMembership = async () => ({ outcome: 'accepted', workflowId: 'lifetime-workflow' });
}

function observeFollowThrough(surface: Awaited<ReturnType<typeof makeSurface>>) {
  const invalidations: unknown[][] = [];
  const originalInvalidateQueries = surface.client.invalidateQueries.bind(surface.client);
  surface.client.invalidateQueries = ((filters: { queryKey?: readonly unknown[] }, options?: unknown) => {
    invalidations.push([...(filters.queryKey ?? [])]);
    return originalInvalidateQueries(filters as never, options as never);
  }) as typeof surface.client.invalidateQueries;
  let routerInvalidations = 0;
  const originalRouterInvalidate = surface.router.invalidate.bind(surface.router);
  surface.router.invalidate = ((...args: Parameters<typeof surface.router.invalidate>) => {
    routerInvalidations++;
    return originalRouterInvalidate(...args);
  }) as typeof surface.router.invalidate;
  return { invalidations, routerInvalidations: () => routerInvalidations };
}

async function click(surface: Awaited<ReturnType<typeof makeSurface>>, label: string) {
  await act(async () => surface.button(label).click());
  await surface.settle();
}

test('queued standing imports and late reads retire across notification-time A-B-A and CSRF readiness changes', async () => {
  resetFixtures();
  const staleRead = deferred<RealmViewer | null>();
  const freshAbaRead = deferred<RealmViewer | null>();
  const nextCredentialRead = deferred<RealmViewer | null>();
  let readIndex = 0;
  readMembership = async () => {
    readIndex++;
    if (readIndex === 1) return viewer('member');
    if (readIndex === 2) return staleRead.promise;
    if (readIndex === 3) return freshAbaRead.promise;
    if (readIndex === 4) return nextCredentialRead.promise;
    return viewer('member');
  };
  const surface = await makeSurface({ realmId }, undefined, { transitionWhileImportIsQueued: true });
  try {
    await surface.until(
      () => standingReads.length === 1 && surface.hasBoardEntry(),
      'the current read after queued import retirement',
    );
    expect(standingReads).toEqual([realmId]);
    expect(surface.button(m.realm_leave()).disabled).toBe(false);

    const membershipKey = ['realm-membership', realmId, subject] as const;
    void surface.client.refetchQueries({ queryKey: membershipKey, exact: true });
    await surface.until(() => standingReads.length === 2, 'a deferred old standing read');
    await surface.setSessions(signedIn(replacementSubject, 'csrf-other'), signedIn());
    await surface.until(() => standingReads.length === 3, 'a fresh standing read for the returned account');
    expect(surface.hasText(m.realm_membership_loading())).toBe(true);
    expect(surface.host.textContent).not.toContain(m.realm_leave());
    expect(surface.hasBoardEntry()).toBe(false);

    staleRead.resolve(viewer('banned', 'obsolete-key'));
    await surface.settle();
    expect(surface.client.getQueryData(membershipKey)).not.toEqual(viewer('banned', 'obsolete-key'));
    expect(surface.hasBoardEntry()).toBe(false);
    freshAbaRead.resolve(viewer('member'));
    await surface.until(() => surface.hasBoardEntry(), 'the returned account standing and Board entry');

    await surface.setSessions(signedIn(subject, null));
    expect(surface.hasBoardEntry()).toBe(false);
    expect(surface.host.textContent).not.toContain(m.realm_leave());
    await surface.setSessions(signedIn(subject, 'csrf-replacement'));
    await surface.until(() => standingReads.length === 4, 'a read after CSRF readiness returns');
    expect(surface.hasBoardEntry()).toBe(false);
    nextCredentialRead.resolve(viewer('member'));
    await surface.until(() => surface.hasBoardEntry(), 'the current standing after CSRF readiness');
    expect(surface.button(m.realm_leave()).disabled).toBe(false);
  } finally {
    await surface.dispose();
  }
});

test('late accepted and failed commands cannot update a replacement CSRF lifetime or start invalidations', async () => {
  resetFixtures();
  const accepted = deferred<MembershipResult>();
  const failed = deferred<MembershipResult>();
  let commandIndex = 0;
  sendMembership = async () => (commandIndex++ === 0 ? accepted.promise : failed.promise);
  const surface = await makeSurface();
  const followThrough = observeFollowThrough(surface);
  try {
    await surface.until(() => surface.hasBoardEntry(), 'initial shared standing and Board entry');
    await click(surface, m.realm_leave());
    await surface.until(() => membershipCommands.length === 1, 'the original leave command');

    await surface.setSessions(signedIn(subject, 'csrf-rotated'));
    await surface.until(
      () => standingReads.length === 2 && surface.hasBoardEntry() && surface.hasText(m.realm_leave_uncertain()),
      'current standing and unresolved leave after CSRF rotation',
    );
    accepted.resolve({ outcome: 'accepted', workflowId: 'obsolete-accepted' });
    await surface.settle();
    expect(surface.hasText(m.realm_state_pending())).toBe(false);
    expect(surface.hasText(m.realm_leave_uncertain())).toBe(true);
    expect(followThrough.invalidations).toEqual([]);
    expect(followThrough.routerInvalidations()).toBe(0);

    await click(surface, m.realm_leave_retry_same());
    await surface.until(() => membershipCommands.length === 2, 'a current explicit retry of the retained intent');
    expect(membershipCommands[1]).toEqual({
      data: { realmId, action: 'leave', idempotencyKey },
      headers: { 'X-CSRF-Token': 'csrf-original' },
    });
    await surface.setSessions(signedIn(subject, 'csrf-next'));
    await surface.until(
      () => standingReads.length === 3 && surface.hasBoardEntry(),
      'standing after the next credential change',
    );
    failed.resolve({ outcome: 'refused', detail: 'late failure detail' });
    await surface.settle();
    expect(surface.hasText(m.realm_leave_refused())).toBe(false);
    expect(surface.hasText(m.realm_leave_uncertain())).toBe(true);
    expect(surface.hasText('late failure detail')).toBe(false);
    expect(surface.button(m.realm_leave()).disabled).toBe(false);
    expect(followThrough.invalidations).toEqual([]);
    expect(followThrough.routerInvalidations()).toBe(0);
    expect(membershipCommands.map((entry) => entry.headers['X-CSRF-Token'])).toEqual([
      'csrf-original',
      'csrf-original',
    ]);
  } finally {
    await surface.dispose();
  }
});

test('an uncertain leave check retires on transition, then exact retry and current settlement keep bounded semantics', async () => {
  resetFixtures();
  const lateCheck = deferred<RealmViewer | null>();
  let beforeRotationReads = 0;
  readMembership = async () => {
    beforeRotationReads++;
    if (beforeRotationReads === 2) return lateCheck.promise;
    return viewer('member');
  };
  let commandIndex = 0;
  sendMembership = async () =>
    commandIndex++ === 0 ? { outcome: 'refused' } : { outcome: 'accepted', workflowId: 'current-workflow' };
  const surface = await makeSurface();
  const followThrough = observeFollowThrough(surface);
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  try {
    await surface.until(() => surface.hasBoardEntry(), 'initial current standing');
    await click(surface, m.realm_leave());
    await surface.until(() => surface.hasText(m.realm_leave_uncertain()), 'uncertain leave recovery');
    expect(membershipCommands).toHaveLength(1);

    await click(surface, m.realm_membership_retry());
    await surface.until(() => standingReads.length === 2, 'the explicit uncertain leave check');
    await surface.setSessions(signedIn(subject, 'csrf-rotated'));
    await surface.until(
      () => standingReads.length === 3 && surface.hasText(m.realm_leave_uncertain()),
      'current standing and retained uncertain recovery after rotation',
    );
    lateCheck.resolve(viewer('none', 'obsolete-key'));
    await surface.settle();
    expect(surface.hasText(m.realm_leave_uncertain())).toBe(true);
    expect(followThrough.invalidations).toEqual([]);
    expect(followThrough.routerInvalidations()).toBe(0);

    const settlement = [viewer('member'), viewer('member'), viewer('member'), viewer('none')];
    readMembership = async () => settlement.shift() ?? viewer('none');
    globalThis.setTimeout = ((callback: () => void, delay = 0) => {
      delays.push(delay);
      queueMicrotask(callback);
      return 0;
    }) as typeof globalThis.setTimeout;
    await click(surface, m.realm_leave_retry_same());
    await surface.until(
      () => surface.host.textContent?.includes(m.realm_join()) ?? false,
      'current accepted leave settlement',
    );

    expect(membershipCommands).toEqual([
      { data: { realmId, action: 'leave', idempotencyKey }, headers: { 'X-CSRF-Token': 'csrf-original' } },
      { data: { realmId, action: 'leave', idempotencyKey }, headers: { 'X-CSRF-Token': 'csrf-original' } },
    ]);
    expect(standingReads.length - 3).toBe(4);
    expect(delays).toEqual([500, 1500, 3000]);
    expect(followThrough.invalidations).toEqual([['my-realms'], ['follow-state', spaceId]]);
    expect(followThrough.routerInvalidations()).toBe(1);
    expect(surface.host.textContent).not.toContain(m.realm_leave_uncertain());
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    await surface.dispose();
  }
});

test('closed joins recover only through an explicit current admission check and a separate join', async () => {
  resetFixtures();
  readMembership = async () => viewer('none');
  sendMembership = async () => ({ outcome: 'closed' });
  const surface = await makeSurface();
  try {
    await surface.until(() => surface.hasText(m.realm_join()), 'initial join admission');
    await click(surface, m.realm_join());
    for (const failure of [null, new Error('Kernel Realm participation read failed')]) {
      readMembership = async () => {
        if (failure) throw failure;
        return null;
      };
      await click(surface, m.realm_membership_retry());
      await surface.until(() => surface.hasText(m.realm_membership_unavailable()), 'unavailable admission');
      expect(surface.hasText(m.realm_change_closed())).toBe(true);
      expect(surface.button(m.realm_membership_retry()).disabled).toBe(false);
    }
    const obsolete = deferred<RealmViewer | null>();
    readMembership = () => obsolete.promise;
    await act(async () => {
      surface.button(m.realm_membership_retry()).click();
      surface.button(m.realm_membership_retry()).click();
    });
    await surface.until(() => standingReads.length === 4, 'one explicit admission read');
    expect(surface.button(m.realm_membership_retry()).disabled).toBe(true);
    expect(membershipCommands).toHaveLength(1);
    readMembership = async () => viewer('banned');
    await surface.setSessions(signedIn(subject, 'csrf-rotated'));
    await surface.until(
      () => standingReads.length === 5 && !surface.hasText(m.realm_membership_loading()),
      'new caller',
    );
    obsolete.resolve(viewer('none', 'obsolete-key'));
    await surface.settle();
    expect(surface.hasText(m.realm_change_closed())).toBe(true);
    expect(surface.hasText(m.realm_join())).toBe(false);
    readMembership = async () => viewer('none', 'reopened-key');
    await click(surface, m.realm_membership_retry());
    await surface.until(() => surface.hasText(m.realm_join()), 'observed reopening');
    expect(surface.hasText(m.realm_change_closed())).toBe(false);
    expect(membershipCommands).toHaveLength(1);
    readMembership = async () => viewer('member');
    sendMembership = async () => ({ outcome: 'accepted', workflowId: 'reopened-join' });
    await click(surface, m.realm_join());
    await surface.until(() => surface.hasText(m.realm_leave()), 'current joined membership');
    expect(membershipCommands).toHaveLength(2);
    expect(membershipCommands[1]).toEqual({
      data: { realmId, action: 'join', idempotencyKey: 'reopened-key' },
      headers: { 'X-CSRF-Token': 'csrf-rotated' },
    });
  } finally {
    await surface.dispose();
  }
});

test('refused leave recovery requires a current standing check before it releases the original intent', async () => {
  resetFixtures();
  sendMembership = async () => ({ outcome: 'refused', effect: 'not-applied' });
  const surface = await makeSurface();
  try {
    await surface.until(() => surface.hasBoardEntry(), 'initial shared standing');
    await click(surface, m.realm_leave());
    await surface.until(() => surface.hasText(m.realm_leave_refused()), 'refused leave recovery');
    const before = standingReads.length;
    await click(surface, m.realm_membership_retry());
    await surface.until(
      () => !surface.hasText(m.realm_leave_refused()) && surface.button(m.realm_leave()).disabled === false,
      'current standing after refusal',
    );
    expect(standingReads.length).toBe(before + 1);
    expect(membershipCommands).toHaveLength(1);
  } finally {
    await surface.dispose();
  }
});

test('Realm and QueryClient replacement plus unmount prevent late standing cache writes', async () => {
  resetFixtures();
  const oldRealmRead = deferred<RealmViewer | null>();
  const newRealmRead = deferred<RealmViewer | null>();
  readMembership = async (id) => (id === realmId ? oldRealmRead.promise : newRealmRead.promise);
  const surface = await makeSurface();
  const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  nextClient.setQueryData(sessionModule.sessionQuery.queryKey, signedIn());
  try {
    await surface.until(() => standingReads.length === 1, 'the original Realm standing read');
    await surface.updateConfig({ realmId: nextRealmId }, nextClient);
    await surface.until(() => standingReads.includes(nextRealmId), 'the replacement Realm QueryClient read');
    expect(surface.hasBoardEntry()).toBe(false);
    expect(surface.host.textContent).not.toContain(m.realm_leave());

    oldRealmRead.resolve(viewer('banned', 'old-realm-key'));
    await surface.settle();
    expect(surface.client.getQueryData(['realm-membership', realmId, subject])).toBeUndefined();
    expect(nextClient.getQueryData(['realm-membership', nextRealmId, subject])).toBeUndefined();

    await surface.dispose();
    newRealmRead.resolve(viewer('member', 'late-unmount-key'));
    await Promise.resolve();
    await Promise.resolve();
    expect(nextClient.getQueryData(['realm-membership', nextRealmId, subject])).toBeUndefined();
  } finally {
    nextClient.clear();
    if (surface.host.isConnected) await surface.dispose();
  }
});
