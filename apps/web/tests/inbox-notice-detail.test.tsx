import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import type { NoticeInboxItem } from '@rezics/client';
import * as start from '../.storybook/react-start';
import { performanceAmbientTree } from './performance-ambient';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test/en/inbox'),
  setResponseHeader: () => {},
}));
mock.module('cloudflare:workers', () => ({
  env: {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'inbox-detail',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({ signedIn: async () => ({ signedIn: true, subject: 'alice', csrfToken: 'token' }) }),
    },
  },
}));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/inbox' });
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
const { InboxNoticeDetailView } = await import('../src/inbox/inbox-notice-detail');
const { inboxContent } = await import('../src/inbox/adapters/presentation');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
setLocale('en', { reload: false });

afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function notice(overrides: Partial<NoticeInboxItem> = {}): NoticeInboxItem {
  return Object.assign(
    {
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
        displayName: 'Momo Lin',
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
      summary: 'Momo replied in a discussion',
      actions: {
        open: { kind: 'thread_post', threadId: 'thread-1', postId: 'post-1' },
        markSeen: { method: 'POST', path: '/v1/accounts/alice/notifications/notice-1:markSeen' },
      },
      unread: true,
    },
    overrides,
  );
}

async function mount(item: NoticeInboxItem, selection: 'all' | 'unread', cursor?: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(InboxNoticeDetailView, {
        notice: item,
        selection,
        content: inboxContent,
        ...(cursor ? { cursor } : {}),
      }),
    ),
  );
  return {
    host,
    unmount: () =>
      act(async () => {
        root.unmount();
        host.remove();
      }),
  };
}

test('shows the current actor, full event time and exact native post location while preserving the unread frontier', async () => {
  const view = await mount(notice(), 'unread', 'opaque/+range==');
  try {
    expect(view.host.textContent).toContain('Momo Lin');
    expect(view.host.textContent).toContain('@momo');
    expect(view.host.textContent).toContain('Current discussion · Current board');
    expect(view.host.querySelector('time')?.textContent).toMatch(/Tuesday, November 3, 2026/);
    const links = [...view.host.querySelectorAll('a')];
    expect(links[0]?.getAttribute('href')).toContain('selection=unread&cursor=opaque%2F%2Brange%3D%3D');
    expect(links[1]?.getAttribute('href')).toContain('#post-post-1');
  } finally {
    await view.unmount();
  }
});

test('conceals withheld actor and target data and offers no destination', async () => {
  const view = await mount(
    notice({
      actorId: null,
      threadId: null,
      postId: null,
      actor: {
        state: 'withheld',
        displayName: 'Former or unavailable account',
        handle: null,
        avatarUrl: null,
      },
      target: {
        state: 'withheld',
        threadId: null,
        postId: null,
        boardId: null,
        threadTitle: null,
        boardTitle: null,
      },
      actions: {
        open: null,
        markSeen: { method: 'POST', path: '/v1/accounts/alice/notifications/notice-1:markSeen' },
      },
      summary: 'A private event',
    }),
    'all',
  );
  try {
    expect(view.host.textContent).toContain(m.inbox_actor_unknown());
    expect(view.host.textContent).toContain(m.inbox_notice_target_unavailable());
    expect(view.host.textContent).toContain(m.inbox_notice_destination_unavailable());
    expect(view.host.textContent).not.toContain('Former or unavailable account');
    expect(view.host.textContent).not.toContain('actor-1');
    expect(view.host.textContent).not.toContain('thread-1');
    expect(view.host.querySelectorAll('a')).toHaveLength(1);
  } finally {
    await view.unmount();
  }
});
