import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolveInboxItems, type InboxNotice, type InboxReads } from '../src/inbox/inbox-read';
import { unreadBadgeLabel } from '../src/inbox/unread-badge';

const thread = 'thread-1';
const post = 'post-1';
const decision = 'decision-1';
const report = 'report-1';

function notice(overrides: Partial<InboxNotice> = {}): InboxNotice {
  return {
    id: 'notice-1',
    kind: 'reply',
    createdAt: '2026-10-29T10:00:00.000Z',
    actorId: 'actor-1',
    threadId: thread,
    postId: post,
    decisionId: null,
    reportId: null,
    unread: true,
    ...overrides,
  };
}

test('inbox lists the kernel notification page newest first and renders each item from its named existing read', async () => {
  const newest = notice({ id: 'newest', postId: 'post-2' });
  const oldest = notice({ id: 'oldest', kind: 'mention', createdAt: '2026-10-28T10:00:00.000Z' });
  const moderation = notice({
    id: 'moderation',
    kind: 'moderation_decision',
    threadId: null,
    postId: null,
    decisionId: decision,
    reportId: null,
  });
  const calls: string[] = [];
  const reads: InboxReads = {
    post: async (threadId, postId) => {
      calls.push(`post:${threadId}:${postId}`);
      return { title: 'A readable reply', href: `/threads/${threadId}#${postId}` };
    },
    decision: async (id) => {
      calls.push(`decision:${id}`);
      return { statement: 'A moderation statement', href: `/moderation/decisions/${id}` };
    },
    report: async (id) => {
      calls.push(`report:${id}`);
      return { outcome: 'actioned', href: `/reports/${id}` };
    },
  };

  const page = await resolveInboxItems({ items: [newest, moderation, oldest], next: 'cursor-2' }, reads);

  expect(page.items.map((item) => item.id)).toEqual(['newest', 'moderation', 'oldest']);
  expect(page.items[0]?.href).toBe(`/threads/${thread}#post-2`);
  expect(page.items[1]?.href).toBe(`/moderation/decisions/${decision}`);
  expect(page.items[1]?.text).toBe('A moderation statement');
  expect(page.next).toBe('cursor-2');
  expect(calls).toEqual([`post:${thread}:post-2`, `decision:${decision}`, `post:${thread}:${post}`]);
});

test('items the reader can no longer see render as neutral unavailable rows', async () => {
  const reads: InboxReads = {
    post: async () => null,
    decision: async () => null,
    report: async () => null,
  };
  const page = await resolveInboxItems({ items: [notice()], next: null }, reads);

  expect(page.items[0]?.unavailable).toBe(true);
  expect(page.items[0]?.href).toBeUndefined();
  expect(page.items[0]?.text).not.toMatch(/error|failed|forbidden|not found/i);
});

test('report outcomes use the reporter-readable report and appeal or takedown decisions link to the decision', async () => {
  const calls: string[] = [];
  const reads: InboxReads = {
    post: async () => null,
    decision: async (id) => {
      calls.push(`decision:${id}`);
      return { statement: 'Decision statement', href: `/moderation/decisions/${id}` };
    },
    report: async (id) => {
      calls.push(`report:${id}`);
      return { outcome: 'dismissed', href: `/reports/${id}` };
    },
  };
  const page = await resolveInboxItems(
    {
      items: [
        notice({ id: 'report-outcome', decisionId: null, reportId: report, threadId: null, postId: null }),
        notice({ id: 'appeal-outcome', decisionId: decision, reportId: null, threadId: null, postId: null }),
      ],
      next: null,
    },
    reads,
  );

  expect(page.items.map((item) => item.href)).toEqual([`/reports/${report}`, `/moderation/decisions/${decision}`]);
  expect(page.items[0]?.text).toBe('dismissed');
  expect(calls).toEqual([`report:${report}`, `decision:${decision}`]);
});

test('page and badge use private browser reads, open marks only the newest notice once, and the inbox is noindex', async () => {
  const source = await readFile(new URL('../src/inbox/inbox-page.tsx', import.meta.url), 'utf8');
  const route = await readFile(new URL('../src/routes/inbox.tsx', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/shell/shell.tsx', import.meta.url), 'utf8');

  expect(source).toContain('private, no-store');
  expect(route).toMatch(/noindex/);
  expect(source).toMatch(/markSeen/);
  expect(shell).toMatch(/unreadBadgeLabel|UnreadBadge/);
  expect(unreadBadgeLabel({ count: 99, capped: false })).toBe('99');
  expect(unreadBadgeLabel({ count: 100, capped: false })).toBe('99+');
  expect(unreadBadgeLabel({ count: 4, capped: true })).toBe('99+');
});

test('inbox resolves repeated records once and stays within one list read plus one read per distinct record', async () => {
  for (const pageSize of [5, 20]) {
    const records = Array.from({ length: pageSize }, (_, index) =>
      notice({ id: `notice-${index}`, postId: `post-${index % 3}` }),
    );
    let postReads = 0;
    const reads: InboxReads = {
      post: async () => {
        postReads += 1;
        return { title: 'Reply', href: '/threads/thread-1#post' };
      },
      decision: async () => null,
      report: async () => null,
    };
    await resolveInboxItems({ items: records, next: null }, reads);
    expect(postReads).toBe(3);
    expect(1 + postReads + 1).toBeLessThanOrEqual(1 + 3 + 1);
  }
});

