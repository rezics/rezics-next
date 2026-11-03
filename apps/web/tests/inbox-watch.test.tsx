import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotificationEditor } from '../src/settings/notification-recovery';
import type { NotificationChange, NotificationWriteResult } from '../src/settings/preferences';
import { WatchNotificationGuide } from '../src/settings/watch-notification-guide';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';
import type { InboxWatchBinding, WatchInboxNotice } from '../src/inbox/watch-notices';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { decodeInboxPage, loadInboxPage, resolveInboxItems } = await import('../src/inbox/inbox-read');
const { InboxRows, InboxPreferencesLink } = await import('../src/inbox/inbox-page');
const base = {
  id: 'notice',
  kind: 'reply',
  createdAt: '2026-11-03T10:00:00.000Z',
  unread: true,
  actorId: 'actor',
  threadId: 'thread',
  postId: 'post',
  decisionId: null,
  reportId: null,
};
const binding: InboxWatchBinding = {
  decode: (value) => {
    const fixture = value as { example?: 'thread' | 'board' };
    return fixture?.example
      ? {
          ...base,
          id: fixture.example,
          kind: 'owner-fixture',
          watch: fixture.example,
          postId: fixture.example === 'board' ? null : 'post',
        }
      : null;
  },
  readThread: async (id) => ({ id, title: 'New discussion' }),
};
const raw = {
  items: [
    base,
    { example: 'thread' },
    { example: 'board' },
    { ...base, id: 'mention', kind: 'mention' },
    {
      ...base,
      id: 'decision',
      kind: 'moderation_decision',
      actorId: null,
      postId: null,
      threadId: null,
      decisionId: 'decision',
    },
  ],
  next: 'opaque/+cursor==',
};

test('mixed native and owner-adapted watch notices batch current targets and actors with exact destinations', async () => {
  const calls: string[] = [];
  const client = createKernelClient('http://kernel.local', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push(url.pathname);
      if (url.pathname === '/v1/accounts') {
        expect(url.searchParams.get('ids')).toBe('actor');
        return Response.json({ accounts: [{ id: 'actor', displayName: 'Momo' }] });
      }
      expect(request.headers.get('authorization')).toBe('Bearer current');
      if (url.pathname.endsWith('/notifications')) {
        expect(url.searchParams.get('cursor')).toBe('opaque-input/+==');
        return Response.json(raw);
      }
      if (url.pathname === '/v1/posts/post')
        return Response.json({
          post: {
            id: 'post',
            threadId: 'thread',
            body: { type: 'doc', content: [{ type: 'text', text: 'Current post' }] },
          },
        });
      if (url.pathname === '/v1/moderation-decisions/decision') return Response.json({ statement: 'Outcome' });
      throw new Error(`Unexpected request ${url.pathname}`);
    }) as typeof fetch,
  });
  let threads = 0;
  const page = await loadInboxPage(client, 'viewer', 'Bearer current', 'opaque-input/+==', {
    ...binding,
    readThread: async (id, context) => {
      threads++;
      expect(context.authorization).toBe('Bearer current');
      return binding.readThread(id, context);
    },
  });
  expect(page.next).toBe(raw.next);
  expect(page.items).toHaveLength(5);
  expect(page.items[1]).toMatchObject({
    watch: 'thread',
    actorName: 'Momo',
    text: 'Current post',
    href: `/${getLocale()}/threads/thread?post=post#post-post`,
  });
  expect(page.items[2]?.href).toContain('/threads/thread/new-discussion');
  expect(calls.filter((path) => path === '/v1/posts/post')).toHaveLength(1);
  expect(calls.filter((path) => path === '/v1/accounts')).toHaveLength(1);
  expect(threads).toBe(1);
});

test('unbound, unsupported and malformed rows fail the whole page without inheriting reply semantics', () => {
  expect(() => decodeInboxPage(raw)).toThrow();
  expect(
    decodeInboxPage({ items: [{ ...base, watch: 'board', actorName: 'stale', href: '/stale' }], next: null }).items[0],
  ).not.toHaveProperty('watch');
  for (const bad of [
    { ...base, kind: 'unknown' },
    { ...base, postId: null },
    { ...base, createdAt: 'yesterday' },
    { ...base, actorId: '../private' },
  ])
    expect(() => decodeInboxPage({ ...raw, items: [base, bad] }, binding)).toThrow();
  const malformed = {
    ...binding,
    decode: () => ({ ...base, kind: 'owner-fixture', watch: 'board', threadId: '../secret' }) as WatchInboxNotice,
  };
  expect(() => decodeInboxPage({ items: [{}], next: null }, malformed)).toThrow();
});

test('withheld watch targets disclose no actor, title or destination; failed and mismatched reads fail truthfully', async () => {
  const page = decodeInboxPage(raw, binding);
  const reads = {
    post: async () => null,
    decision: async () => null,
    report: async () => null,
    thread: async () => null,
  };
  const hidden = await resolveInboxItems(page, reads);
  for (const item of hidden.items) expect(item).toMatchObject({ unavailable: true, actorId: null, text: '' });
  const html = renderToStaticMarkup(createElement(InboxRows, { page: hidden }));
  expect(html).not.toContain('href=');
  expect(html).not.toContain('data-actor-id=');
  expect(html).not.toContain('Current post');
  await expect(
    resolveInboxItems(page, {
      ...reads,
      post: async () => {
        throw new Error('offline');
      },
    }),
  ).rejects.toThrow();
  await expect(
    resolveInboxItems(page, {
      ...reads,
      post: async () => ({ text: 'Wrong post', id: 'different', threadId: 'thread' }),
    }),
  ).rejects.toThrow();
  await expect(
    resolveInboxItems(page, { ...reads, thread: async () => ({ id: 'different', title: 'Secret' }) }),
  ).rejects.toThrow();
});

test('all locales explain watch categories and mandatory outcomes, link preferences and label unknown kinds neutrally', () => {
  const original = getLocale();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const item = { ...base, text: 'Title', unavailable: false };
      const html = renderToStaticMarkup(
        createElement(InboxRows, {
          page: {
            items: [
              { ...item, id: 'watch', watch: 'thread' },
              { ...item, id: 'unknown', kind: 'new-owner-kind' },
            ],
            next: null,
          },
        }),
      );
      expect(html).toContain(m.inbox_kind_thread_activity());
      expect(html).toContain(m.inbox_kind_unknown());
      expect(html).not.toContain(m.inbox_kind_reply());
      const guide = renderToStaticMarkup(createElement(WatchNotificationGuide));
      expect(guide).toContain(m.settings_watch_notifications_mandatory());
      expect(guide).toContain(m.inbox_board_activity_text());
      expect(renderToStaticMarkup(createElement(InboxPreferencesLink))).toContain(`/${locale}/settings#notifications`);
    }
  } finally {
    setLocale(original, { reload: false });
  }
});

test('native optional board activity uses original intent/key recovery and retires late writes', async () => {
  const calls: NotificationChange[] = [];
  const initial = { reply: true, mention: true, board_activity: true };
  const current = { ...initial, board_activity: false };
  const editor = new NotificationEditor(
    { notifications: initial, version: 4 },
    {
      save: async (input) => {
        calls.push(input);
        return calls.length === 1
          ? { ok: false, reason: 'unavailable' }
          : { ok: true, notifications: current, version: 5 };
      },
      read: async () => ({
        signedIn: true,
        preferences: { spoilerLevel: 0, suitability: 'blur', version: 5 },
        securityHref: null,
        notifications: current,
      }),
    },
  );
  await editor.edit('board_activity', false, 4);
  await editor.retry();
  expect(calls[0]).toBe(calls[1]);
  expect(calls[0]?.notifications).toEqual({ board_activity: false });
  expect(editor.snapshot()).toMatchObject({ phase: 'saved', draft: current });
  let settle!: (result: NotificationWriteResult) => void;
  const retired = new NotificationEditor(
    { notifications: initial, version: 4 },
    {
      save: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
      read: async () => ({ signedIn: false }),
    },
  );
  const pending = retired.edit('board_activity', false, 4);
  retired.dispose();
  const before = retired.snapshot();
  settle({ ok: true, notifications: current, version: 5 });
  await pending;
  expect(retired.snapshot()).toBe(before);
});
