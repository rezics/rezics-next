import { expect, mock, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReporterStatusView } from '../src/moderation/reporter-status-view';
import type { ReporterStatus } from '../src/moderation/reporter-status-model';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { resolveInboxItems } = await import('../src/inbox/inbox-read');
const { unreadBadgeLabel } = await import('../src/inbox/unread-badge');
type InboxNotice = import('../src/inbox/inbox-read').InboxNotice;
type InboxReads = import('../src/inbox/inbox-read').InboxReads;

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
        notice({
          id: 'appeal-outcome',
          kind: 'moderation_decision',
          decisionId: decision,
          reportId: null,
          threadId: null,
          postId: null,
        }),
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
  const source = await readFile(new URL('../src/inbox/inbox-read.ts', import.meta.url), 'utf8');
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

const { loadInboxPage, markInboxThrough } = await import('../src/inbox/inbox-read');
const { loadReporterStatus } = await import('../src/moderation/reporter-status-read');

const submittedReport: ReporterStatus = {
  id: report,
  target: { kind: 'post', id: post },
  revisionId: 'submitted-revision',
  reason: 'spam',
  evidence: 'The evidence submitted by this reporter.',
  reporterId: 'reporter-1',
  createdAt: '2026-10-28T10:00:00.000Z',
  outcome: 'actioned',
  resolvedAt: '2026-10-29T10:00:00.000Z',
  targetAvailability: 'unavailable',
};
const reporterNotice = notice({
  kind: 'moderation_decision',
  actorId: null,
  threadId: null,
  postId: null,
  reportId: report,
});

test('a reporter notice reaches its delivered own-submission status page by report ID even when the target is unavailable without leaking hidden content or losing native seen/read semantics', async () => {
  for (const targetAvailability of ['available', 'unavailable'] as const) {
    for (const outcome of ['actioned', 'dismissed'] as const) {
      const submission = { ...submittedReport, targetAvailability, outcome };
      const calls: string[] = [];
      const client = createKernelClient('http://kernel.local', {
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          calls.push(`${request.method} ${path}`);
          expect(request.headers.get('authorization')).toBe('Bearer reporter');
          if (path === '/v1/accounts/reporter-1/notifications')
            return Response.json({ items: [reporterNotice], next: 'native-continuation' });
          expect(path).toBe(`/v1/reports/${report}`);
          return Response.json({
            report: {
              ...submission,
              body: 'Hidden target text',
              moderatorNotes: 'Private note',
              otherReports: ['Other reporter'],
            },
          });
        }) as typeof fetch,
      });
      const page = await loadInboxPage(client, 'reporter-1', 'Bearer reporter');
      expect(page.next).toBe('native-continuation');
      expect(page.items).toEqual([
        {
          ...reporterNotice,
          href: `/moderation/reports/${report}`,
          text: outcome === 'actioned' ? 'Actioned' : 'Dismissed',
          unavailable: false,
        },
      ]);
      expect(calls).toEqual(['GET /v1/accounts/reporter-1/notifications', `GET /v1/reports/${report}`]);
      const destination = await loadReporterStatus(client, report, 'Bearer reporter');
      expect(destination).toEqual(submission);
      const html = renderToStaticMarkup(createElement(ReporterStatusView, { report: destination! }));
      expect(html).toContain(submission.evidence!);
      expect(html).toContain(submission.target.id);
      expect(html).toContain('Spam');
      expect(html).toContain(outcome === 'actioned' ? 'Actioned' : 'Dismissed');
      expect(html).not.toContain('href=');
      for (const secret of ['Hidden target text', 'Private note', 'Other reporter', 'transactionId', 'partition']) {
        expect(JSON.stringify(page)).not.toContain(secret);
        expect(html).not.toContain(secret);
      }
      expect(calls).toHaveLength(3);
      expect(page.items[0]?.unread).toBe(true);
    }
  }
});

test('report denial, absence and moderator inspection cannot become an own-status link, while dependency failure stays a failure', async () => {
  const { targetAvailability: _availability, ...moderator } = submittedReport;
  for (const status of [200, 403, 404, 503]) {
    const client = createKernelClient('http://kernel.local', {
      fetch: (async (input, init) => {
        const path = new URL(new Request(input, init).url).pathname;
        if (path.endsWith('/notifications')) return Response.json({ items: [reporterNotice], next: null });
        expect(path).toBe(`/v1/reports/${report}`);
        return Response.json(
          status === 200
            ? { report: { ...moderator, partition: 1, transactionId: 'private-transaction' } }
            : { code: status === 503 ? 'dependency_unavailable' : 'not_found' },
          { status },
        );
      }) as typeof fetch,
    });
    if (status === 503) {
      await expect(loadInboxPage(client, 'reporter-1', 'Bearer reporter')).rejects.toThrow();
    } else {
      const page = await loadInboxPage(client, 'reporter-1', 'Bearer reporter');
      expect(page.items).toEqual([{ ...reporterNotice, text: '', unavailable: true }]);
      if (status === 404) expect(await loadReporterStatus(client, report, 'Bearer reporter')).toBeNull();
      if (status === 403) await expect(loadReporterStatus(client, report, 'Bearer reporter')).rejects.toThrow();
    }
  }
});

test('an uncertain native seen command retries the original quoted key and marker and requires 204 confirmation', async () => {
  const commands: { path: string; key: string | null; body: unknown }[] = [];
  let status = 204;
  const client = createKernelClient('http://kernel.local', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      commands.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('idempotency-key'),
        body: await request.json(),
      });
      if (commands.length === 1) throw new Error('Response lost');
      return new Response(null, { status });
    }) as typeof fetch,
  });
  const attempt = { through: reporterNotice.id, idempotencyKey: '01a17a3b-0884-721b-91ef-d7ffd7bb58f8' };
  await expect(markInboxThrough(client, 'reporter-1', 'Bearer reporter', attempt)).rejects.toThrow();
  await markInboxThrough(client, 'reporter-1', 'Bearer reporter', attempt);
  expect(commands).toEqual(
    Array(2).fill({
      path: '/v1/accounts/reporter-1/notifications:markSeen',
      key: JSON.stringify(attempt.idempotencyKey),
      body: { through: reporterNotice.id },
    }),
  );
  status = 202;
  await expect(markInboxThrough(client, 'reporter-1', 'Bearer reporter', attempt)).rejects.toThrow();
});
