import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { settingsPreferencePage } from '../src/kernel/fake/settings-notifications';
import { NotificationEditor } from '../src/settings/notification-recovery';
import type { NotificationChange, NotificationWriteResult } from '../src/settings/preferences';
import { WatchNotificationGuide } from '../src/settings/watch-notification-guide';
import { threadLocation } from '../src/threads/thread-href';
import { getLocale, locales, overwriteGetLocale, setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { decodeInboxPage, loadInboxPage, nativeInboxEnvelope, resolveInboxItems } =
  await import('../src/inbox/inbox-read');
const { InboxRows, InboxPreferencesLink } = await import('../src/inbox/inbox-page');
type InboxNotice = import('../src/inbox/inbox-read').InboxNotice;
type ResolvedNotice = import('../src/inbox/inbox-read').ResolvedInboxPage['items'][number];

function wireNotice(overrides: Partial<InboxNotice> = {}, accountId = 'viewer'): InboxNotice {
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
    ...overrides,
  };
  const target = overrides.target ?? {
    state: base.kind === 'moderation_decision' ? ('withheld' as const) : ('available' as const),
    threadId: base.kind === 'moderation_decision' ? null : base.threadId,
    postId: base.kind === 'moderation_decision' ? null : base.postId,
    boardId: base.kind === 'board_activity' ? 'board' : null,
    threadTitle: base.kind === 'moderation_decision' ? null : 'A current thread',
    boardTitle: base.kind === 'board_activity' ? 'Books' : null,
  };
  const actor =
    overrides.actor ??
    (base.kind === 'moderation_decision'
      ? { state: 'system' as const, displayName: 'Moderation team' as const, handle: null, avatarUrl: null }
      : {
          state: 'available' as const,
          accountId: base.actorId ?? 'actor',
          displayName: 'Momo',
          handle: 'momo',
          avatarUrl: null,
          automated: false,
        });
  const open =
    overrides.actions?.open ??
    (base.kind === 'moderation_decision'
      ? base.reportId
        ? { kind: 'report_outcome' as const, reportId: base.reportId }
        : base.decisionId
          ? { kind: 'moderation_decision' as const, decisionId: base.decisionId }
          : null
      : { kind: 'thread_post' as const, threadId: base.threadId!, postId: base.postId! });
  return {
    ...base,
    threadId: target.state === 'withheld' ? null : target.threadId,
    postId: target.state === 'withheld' ? null : target.postId,
    actorId: actor.state === 'available' ? actor.accountId : null,
    actor,
    target,
    summary: 'A current owner summary',
    actions: overrides.actions ?? {
      open,
      markSeen: { method: 'POST', path: `/v1/accounts/${accountId}/notifications/${base.id}:markSeen` },
    },
  };
}

const base: ResolvedNotice = { ...wireNotice(), text: 'Title', unavailable: false };

test('an uncertain chosen acknowledgement keeps its exact retry visible after a fresh read', () => {
  const item = { ...base, unread: false };
  const html = renderToStaticMarkup(
    createElement(InboxRows, {
      page: { items: [item], next: null },
      onMarkSeen: () => {},
      onRetrySeen: () => {},
      uncertainNoticeId: item.id,
    }),
  );
  expect(html).toContain(m.inbox_notice_seen_retry());
});

test('the composed Inbox page includes installed watch kinds and does not hydrate actors or targets', async () => {
  const raw = {
    items: [
      wireNotice({ id: 'reply' }),
      wireNotice({ id: 'mention', kind: 'mention' }),
      wireNotice({ id: 'thread-watch', kind: 'thread_watch' }),
      wireNotice({ id: 'board-activity', kind: 'board_activity' }),
      wireNotice({
        id: 'decision',
        kind: 'moderation_decision',
        actorId: null,
        threadId: null,
        postId: null,
        decisionId: 'decision',
      }),
    ],
    next: 'opaque/+cursor==',
  };
  const calls: string[] = [];
  const client = createKernelClient('http://kernel.local', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push(url.pathname);
      expect(request.headers.get('authorization')).toBe('Bearer current');
      if (url.pathname.endsWith('/notifications')) {
        expect(url.searchParams.get('cursor')).toBe('opaque-input/+==');
        return Response.json(nativeInboxEnvelope(raw.items, raw.next, 'viewer'));
      }
      throw new Error(`Unexpected request ${url.pathname}`);
    }) as typeof fetch,
  });
  const page = await loadInboxPage(client, 'viewer', 'Bearer current', 'opaque-input/+==');
  expect(page.next).toBe(raw.next);
  expect(page.items).toHaveLength(5);
  expect(page.items.map((item) => item.kind)).toEqual([
    'reply',
    'mention',
    'thread_watch',
    'board_activity',
    'moderation_decision',
  ]);
  expect(page.items[1]).toMatchObject({ actorName: 'Momo', text: 'A current owner summary' });
  const currentPost = threadLocation(getLocale(), { id: 'thread', title: 'A current thread' }, undefined, 'post');
  expect(page.items[2]?.href).toBe(currentPost);
  expect(page.items[3]?.href).toBe(currentPost);
  expect(page.items[4]?.href).toBe(`/${getLocale()}/moderation/decisions/decision`);
  expect(calls).toEqual(['/v1/accounts/viewer/notifications']);
});

test('malformed and unknown native kinds fail the whole page', () => {
  const valid = wireNotice();
  for (const bad of [
    { ...valid, kind: 'unknown' },
    { ...valid, postId: null },
    { ...valid, createdAt: 'yesterday' },
    { ...valid, actorId: '../private' },
    { ...valid, actions: { ...valid.actions!, open: { kind: 'external', url: 'https://evil.test' } } },
  ])
    expect(() => decodeInboxPage(nativeInboxEnvelope([valid, bad], null, 'viewer'), 'viewer')).toThrow();
});

test('withheld actors and report targets conceal private context while the admitted report link remains usable', async () => {
  const hiddenNotice = wireNotice({
    id: 'hidden-report',
    kind: 'moderation_decision',
    actorId: null,
    threadId: null,
    postId: null,
    reportId: 'report',
    decisionId: null,
    target: { state: 'withheld', threadId: null, postId: null, boardId: null, threadTitle: null, boardTitle: null },
    actions: {
      open: { kind: 'report_outcome', reportId: 'report' },
      markSeen: { method: 'POST', path: '/v1/accounts/viewer/notifications/hidden-report:markSeen' },
    },
  });
  const page = await resolveInboxItems(
    nativeInboxEnvelope(
      decodeInboxPage(nativeInboxEnvelope([hiddenNotice], null, 'viewer'), 'viewer').items,
      null,
      'viewer',
    ),
  );
  expect(page.items[0]).toMatchObject({
    unavailable: true,
    actorId: null,
    href: `/${getLocale()}/moderation/reports/report`,
  });
  const html = renderToStaticMarkup(createElement(InboxRows, { page }));
  expect(html).toContain(`href="/${getLocale()}/moderation/reports/report"`);
  expect(html).not.toContain('data-actor-id=');
  expect(html).not.toContain('boardTitle');
  expect(html).not.toContain('threadTitle');
});

test('all locales explain watch categories and mandatory outcomes, link preferences and label unknown kinds neutrally', () => {
  const original = getLocale();
  try {
    for (const locale of locales) {
      overwriteGetLocale(() => locale);
      setLocale(locale, { reload: false });
      const item = base;
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
      expect(guide).toContain(m.settings_notifications_watches_destination());
      expect(guide).toContain(m.inbox_board_activity_text());
      expect(renderToStaticMarkup(createElement(InboxPreferencesLink))).toContain(`/${locale}/settings#notifications`);
    }
  } finally {
    overwriteGetLocale(() => original);
    setLocale(original, { reload: false });
  }
});

test('native optional board activity uses original intent/key recovery and retires late writes', async () => {
  const calls: NotificationChange[] = [];
  const initial = { reply: true, mention: true, thread_watch: true, board_activity: true };
  const current = { ...initial, board_activity: false };
  const editor = new NotificationEditor(settingsPreferencePage(initial, 4), {
    save: async (input) => {
      calls.push(input);
      return calls.length === 1
        ? { ok: false, reason: 'unavailable' }
        : { ok: true, notifications: current, version: 5, page: settingsPreferencePage(current, 5) };
    },
    read: async () => ({
      signedIn: true,
      preferences: { spoilerLevel: 0, suitability: 'blur', version: 5 },
      securityHref: null,
      notifications: current,
      page: settingsPreferencePage(current, 5),
    }),
  });
  await editor.edit('board_activity', false, 4);
  await editor.retry();
  expect(calls[0]).toBe(calls[1]);
  expect(calls[0]?.notifications).toEqual({ board_activity: false });
  expect(editor.snapshot()).toMatchObject({ phase: 'saved', draft: current });
  let settle!: (result: NotificationWriteResult) => void;
  const retired = new NotificationEditor(settingsPreferencePage(initial, 4), {
    save: () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
    read: async () => ({ signedIn: false }),
  });
  const pending = retired.edit('board_activity', false, 4);
  retired.dispose();
  const before = retired.snapshot();
  settle({ ok: true, notifications: current, version: 5, page: settingsPreferencePage(current, 5) });
  await pending;
  expect(retired.snapshot()).toBe(before);
});
