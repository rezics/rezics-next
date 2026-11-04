import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import * as start from '../.storybook/react-start';
import type { InboxNoticeDetailWire, InboxNoticePage } from '../src/inbox/inbox-read';
import type { InboxNoticeLoader } from '../src/inbox/inbox-query';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test/en/inbox/notice?noticeId=notice-1'),
  setResponseHeader: () => {},
}));
mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window({ url: 'https://site.test/en/inbox/notice?noticeId=notice-1' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { InboxNoticeDetailPage } = await import('../src/inbox/inbox-notice-detail');
const { decodeInboxNoticeDetail, resolveInboxItems } = await import('../src/inbox/inbox-read');
const { currentInboxViewer } = await import('../src/inbox/inbox-viewer');
const { inboxNoticeQuery, unreadCountQueryFor } = await import('../src/inbox/inbox-query');
const { sessionQuery } = await import('../src/session/query');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
setLocale('en', { reload: false });

function detailWire(unread = true, summary = 'Momo replied in a discussion'): InboxNoticeDetailWire {
  return {
    viewer: { state: 'current' },
    notice: {
      id: 'notice-1',
      kind: 'reply',
      createdAt: '2026-11-03T10:00:00.000Z',
      actorId: 'actor-1',
      threadId: 'thread-1',
      postId: 'post-1',
      decisionId: null,
      reportId: null,
      actor: {
        state: 'available',
        accountId: 'actor-1',
        displayName: 'Momo',
        handle: 'momo',
        avatarUrl: 'https://images.test/momo.png',
        automated: false,
      },
      target: {
        state: 'available',
        threadId: 'thread-1',
        postId: 'post-1',
        boardId: 'board-1',
        threadTitle: 'Current discussion',
        boardTitle: 'Current board',
      },
      summary,
      actions: {
        open: { kind: 'thread_post', threadId: 'thread-1', postId: 'post-1' },
        markSeen: { method: 'POST', path: '/v1/accounts/alice/notifications/notice-1:markSeen' },
      },
      unread,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function session(subject = 'alice', csrfToken = 'original-token') {
  return { state: 'signed-in' as const, subject, csrfToken };
}

async function page(wire: InboxNoticeDetailWire): Promise<InboxNoticePage> {
  const notice = (await resolveInboxItems({ items: [wire.notice], next: null })).items[0];
  if (!notice) throw new Error('The detail fixture did not resolve');
  return { signedIn: true, state: 'ready', notice };
}

async function screen(
  loadNotice: InboxNoticeLoader,
  acknowledgeNotice: (attempt: { accountId: string; noticeId: string; idempotencyKey: string }, token: string) => Promise<void>,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, session());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(InboxNoticeDetailPage, {
            noticeId: 'notice-1',
            cursor: 'opaque/+range==',
            view: 'unread',
            loadNotice,
            acknowledgeNotice,
          }),
        ),
      );
    });
  const click = (label: string) =>
    act(async () => {
      const button = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
      expect(button, label).toBeDefined();
      button!.click();
    });
  await render();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return {
    client,
    host,
    click,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('the exact detail decoder binds the current viewer, safe actor, current target and one supplied post destination', async () => {
  const wire = detailWire();
  expect(decodeInboxNoticeDetail(wire, 'alice', 'notice-1')).toEqual(wire.notice);
  expect(() => decodeInboxNoticeDetail(wire, 'alice', 'foreign-notice')).toThrow();
  expect(() =>
    decodeInboxNoticeDetail(
      { ...wire, notice: { ...wire.notice, actions: { ...wire.notice.actions, open: { kind: 'board', boardId: 'other-board' } } } },
      'alice',
      'notice-1',
    ),
  ).toThrow();
});

test('a failed exact read retries the same notice identity', async () => {
  let reads = 0;
  const view = await screen(
    async (viewerId, noticeId) => {
      reads++;
      expect([viewerId, noticeId]).toEqual(['alice', 'notice-1']);
      return reads === 1
        ? { signedIn: true, state: 'unavailable', failure: { status: 503, code: null, retryable: true } }
        : page(detailWire());
    },
    async () => {},
  );
  try {
    const retry = [...view.host.querySelectorAll('button')].find((node) => node.textContent === m.inbox_retry());
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(reads).toBe(2);
    expect(view.host.textContent).toContain('Momo replied in a discussion');
  } finally {
    await view.close();
    view.client.clear();
  }
});

test('a lost acknowledgement retries the same immutable key, confirms only receipt and returns to the selected current range', async () => {
  const wire = detailWire();
  let latest = await page(wire);
  const reads: Array<[string, string]> = [];
  const commands: Array<{
    attempt: { accountId: string; noticeId: string; idempotencyKey: string };
    token: string;
    work: ReturnType<typeof deferred<void>>;
  }> = [];
  const view = await screen(
    async (viewerId, noticeId) => {
      reads.push([viewerId, noticeId]);
      return latest;
    },
    (attempt, token) => {
      const work = deferred<void>();
      commands.push({ attempt, token, work });
      return work.promise;
    },
  );
  try {
    expect(view.host.textContent).toContain('Momo replied in a discussion');
    expect(view.host.textContent).toContain('@momo');
    expect(view.host.textContent).toContain('Current discussion · Current board');
    expect(view.host.querySelector('img')?.getAttribute('src')).toBe('https://images.test/momo.png');
    const back = view.host.querySelector('a');
    expect(back?.getAttribute('href')).toContain('/inbox?');
    expect(back?.getAttribute('href')).toContain('cursor=opaque%2F%2Brange%3D%3D');
    expect(back?.getAttribute('href')).toContain('view=unread');

    await view.click(m.inbox_notice_mark_seen());
    expect(commands).toHaveLength(1);
    const original = commands[0]!.attempt;
    expect(Object.isFrozen(original)).toBe(true);
    expect(original).toMatchObject({ accountId: 'alice', noticeId: 'notice-1' });
    expect(original.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(commands[0]!.token).toBe('original-token');
    commands[0]!.work.reject(new Error('response lost'));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(view.host.textContent).toContain(m.inbox_notice_seen_unknown());
    expect(view.host.textContent).not.toContain(m.inbox_notice_marked_seen());

    latest = await page(detailWire(false));
    await view.click(m.inbox_notice_seen_retry());
    expect(commands).toHaveLength(2);
    expect(commands[1]!.attempt).toBe(original);
    expect(commands[1]!.attempt.idempotencyKey).toBe(commands[0]!.attempt.idempotencyKey);
    commands[1]!.work.resolve();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(view.host.textContent).toContain(m.inbox_notice_marked_seen());
    expect(view.host.textContent).toContain(m.inbox_notice_read());
    expect(reads.every(([viewerId, noticeId]) => viewerId === 'alice' && noticeId === 'notice-1')).toBe(true);
  } finally {
    await view.close();
    view.client.clear();
  }
});

test('A to B to A retires a late private read, and unmount retires a late acknowledgement before invalidation', async () => {
  const lateRead = deferred<InboxNoticePage>();
  let readCalls = 0;
  const readView = await screen(
    async () => {
      readCalls++;
      return readCalls === 1 ? lateRead.promise : page(detailWire(true, 'Fresh current reply'));
    },
    async () => {},
  );
  const oldViewer = currentInboxViewer(readView.client)!;
  try {
    await act(async () => {
      readView.client.setQueryData(sessionQuery.queryKey, session('bob', 'bob-token'));
      readView.client.setQueryData(sessionQuery.queryKey, session('alice', 'new-token'));
    });
    const currentViewer = currentInboxViewer(readView.client)!;
    expect(currentViewer).not.toBe(oldViewer);
    await act(async () => lateRead.resolve(await page(detailWire(true, 'Stale private reply'))));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(readView.host.textContent).toContain('Fresh current reply');
    expect(readView.host.textContent).not.toContain('Stale private reply');
  } finally {
    await readView.close();
    readView.client.clear();
  }

  const lateCommand = deferred<void>();
  const commandCalls: Array<{ attempt: { accountId: string; noticeId: string; idempotencyKey: string }; token: string }> = [];
  const commandView = await screen(
    async () => page(detailWire()),
    (attempt, token) => {
      commandCalls.push({ attempt, token });
      return lateCommand.promise;
    },
  );
  const viewer = currentInboxViewer(commandView.client)!;
  const detailKey = inboxNoticeQuery(viewer, 'notice-1', async () => page(detailWire())).queryKey;
  const badgeKey = unreadCountQueryFor(viewer).queryKey;
  await commandView.click(m.inbox_notice_mark_seen());
  expect(commandCalls).toHaveLength(1);
  await commandView.close();
  lateCommand.resolve();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(commandView.client.getQueryState(detailKey)?.isInvalidated ?? false).toBe(false);
  expect(commandView.client.getQueryState(badgeKey)?.isInvalidated ?? false).toBe(false);
  commandView.client.clear();
});
