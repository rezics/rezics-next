import { expect, mock, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient } from '@tanstack/react-query';
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

const { inboxViewerStore, forInboxViewer } = await import('../src/inbox/inbox-viewer');
const { inboxPageQuery, inboxViewerQueryKey, unreadCountQuery, unreadCountQueryFor, markInboxViewerSeen } =
  await import('../src/inbox/inbox-query');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('Changing or losing the signed-in viewer immediately removes prior inbox rows and pending seen attempts, and late old-viewer completions cannot change the next viewer badge or mark requests', async () => {
  const client = new QueryClient();
  const store = inboxViewerStore(client);
  const unsubscribe = store.subscribe(() => {});
  const session = (state: string, subject: string | null) =>
    client.setQueryData(['session'], { state, subject, csrfToken: 'shared-token' });
  try {
    session('signed-in', 'alice');
    const alice = store.snapshot()!;
    const firstKey = inboxPageQuery(alice).queryKey;
    const olderKey = inboxPageQuery(alice, 'alice-older').queryKey;
    client.setQueryData(firstKey, {
      signedIn: true,
      state: 'ready',
      items: [{ ...notice(), text: 'Alice reply', unavailable: false }],
      next: 'alice-older',
    });
    client.setQueryData(olderKey, {
      signedIn: true,
      state: 'ready',
      items: [{ ...notice({ id: 'alice-old' }), text: 'Older Alice reply', unavailable: false }],
      next: null,
    });
    client.setQueryData(unreadCountQueryFor(alice).queryKey, {
      signedIn: true,
      state: 'ready',
      count: 7,
      capped: false,
    });
    const latePage = deferred<string>();
    const lateCount = deferred<number>();
    const page = forInboxViewer(alice, () => latePage.promise).catch((error: Error) => error.name);
    const count = forInboxViewer(alice, () => lateCount.promise).catch((error: Error) => error.name);

    // A token refresh within the same immutable subject keeps its retry ownership.
    client.setQueryData(['session'], { state: 'signed-in', subject: 'alice', csrfToken: 'refreshed-token' });
    expect(store.snapshot()).toBe(alice);
    session('signed-in', 'bob');
    const bob = store.snapshot()!;
    expect(client.getQueryData(inboxPageQuery(bob).queryKey)).toBeUndefined();
    expect(client.getQueryData(unreadCountQueryFor(bob).queryKey)).toBeUndefined();
    latePage.resolve('alice rows');
    lateCount.resolve(7);
    expect(await page).toBe('AbortError');
    expect(await count).toBe('AbortError');
    let obsoleteRequests = 0;
    await expect(forInboxViewer(alice, async () => ++obsoleteRequests)).rejects.toThrow('Inbox viewer changed');
    expect(obsoleteRequests).toBe(0);

    for (const lostState of ['unknown', 'signed-out', 'unavailable']) {
      session(lostState, null);
      expect(store.snapshot()).toBeNull();
      expect(unreadCountQueryFor(store.snapshot()).enabled).toBe(false);
      session('signed-in', 'bob');
      expect(store.snapshot()).not.toBe(bob);
    }
    // Loss and recovery may be batched without an intermediate component render.
    const beforeLoss = store.snapshot()!;
    session('unknown', null);
    session('signed-in', 'bob');
    expect(beforeLoss.isCurrent()).toBe(false);
    session('signed-in', 'alice');
    expect(inboxPageQuery(store.snapshot()!).queryKey).not.toEqual(firstKey);
    expect(client.getQueryData(inboxPageQuery(store.snapshot()!).queryKey)).toBeUndefined();
    session('signed-in', null);
    expect(store.snapshot()).toBeNull();
  } finally {
    unsubscribe();
    client.clear();
  }
});

test('stale seen outcomes cannot invalidate the next viewer badge or dispatch an old marker, while a current viewer retries its original intent', async () => {
  for (const outcome of ['confirmed', 'failed'] as const) {
    const client = new QueryClient();
    const store = inboxViewerStore(client);
    const unsubscribe = store.subscribe(() => {});
    const commands: { through: string; idempotencyKey: string; token: string | null }[] = [];
    const aliceAttempt = { through: 'alice-newest', idempotencyKey: crypto.randomUUID() };
    const bobAttempt = { through: 'bob-newest', idempotencyKey: crypto.randomUUID() };
    try {
      client.setQueryData(['session'], { state: 'signed-in', subject: 'alice', csrfToken: 'same-token' });
      const alice = store.snapshot()!;
      const pending = deferred<{ signedIn: boolean }>();
      const oldMark = markInboxViewerSeen(client, alice, aliceAttempt, 'same-token', async ({ data, headers }) => {
        commands.push({ ...data, token: new Headers(headers).get('X-CSRF-Token') });
        return pending.promise;
      }).catch((error: Error) => error.name);
      client.setQueryData(['session'], { state: 'unknown', subject: null, csrfToken: null });
      client.setQueryData(['session'], { state: 'signed-in', subject: 'bob', csrfToken: 'same-token' });
      const bob = store.snapshot()!;
      const bobCountKey = unreadCountQueryFor(bob).queryKey;
      const bobPageKey = inboxPageQuery(bob).queryKey;
      const aliceCountKey = unreadCountQueryFor(alice).queryKey;
      client.setQueryData(bobCountKey, { signedIn: true, state: 'ready', count: 2, capped: false });
      client.setQueryData(bobPageKey, { signedIn: true, state: 'ready', items: [], next: null });
      client.setQueryData(aliceCountKey, { signedIn: true, state: 'ready', count: 7, capped: false });
      if (outcome === 'confirmed') pending.resolve({ signedIn: true });
      else pending.reject(new Error('Response lost'));
      await oldMark;
      expect(client.getQueryState(bobCountKey)?.isInvalidated).toBe(false);
      expect(client.getQueryState(bobPageKey)?.isInvalidated).toBe(false);
      expect(client.getQueryState(aliceCountKey)?.isInvalidated).toBe(false);
      expect(client.getQueryData(bobCountKey)).toMatchObject({ count: 2 });

      const retry = async ({ data, headers }: { data: typeof bobAttempt; headers: HeadersInit }) => {
        commands.push({ ...data, token: new Headers(headers).get('X-CSRF-Token') });
        if (commands.length === 2) throw new Error('Response lost');
        return { signedIn: true };
      };
      await expect(markInboxViewerSeen(client, alice, aliceAttempt, 'bob-token', retry)).rejects.toThrow(
        'Inbox viewer changed',
      );
      await expect(markInboxViewerSeen(client, bob, bobAttempt, 'same-token', retry)).rejects.toThrow('Response lost');
      client.setQueryData(['session'], { state: 'signed-in', subject: 'bob', csrfToken: 'bob-refreshed-token' });
      await markInboxViewerSeen(client, bob, bobAttempt, 'bob-refreshed-token', retry);
      expect(commands).toEqual([
        { ...aliceAttempt, token: 'same-token' },
        { ...bobAttempt, token: 'same-token' },
        { ...bobAttempt, token: 'bob-refreshed-token' },
      ]);
      expect(client.getQueryState(bobCountKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(bobPageKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(aliceCountKey)?.isInvalidated).toBe(false);
      expect(inboxViewerQueryKey(bob)).not.toEqual(inboxViewerQueryKey(alice));
      // Fixed badge-prefix invalidation remains compatible with viewer-qualified keys.
      await client.invalidateQueries({ queryKey: unreadCountQuery.queryKey });
      expect(client.getQueryState(aliceCountKey)?.isInvalidated).toBe(true);
    } finally {
      unsubscribe();
      client.clear();
    }
  }
});

test('native service failures never claim preparation, preserve problem details, and keep platform closure distinct', async () => {
  const { inboxReadFailure } = await import('../src/inbox/inbox-read');
  // Current notice/target routes declare no preparation problem, including a bare 503 or an unknown code.
  for (const code of [undefined, 'dependency_unavailable', 'deadline_exceeded', 'preparing', 'platform_closed']) {
    let requests = 0;
    const status = code === 'platform_closed' ? 403 : 503;
    const client = createKernelClient('http://kernel.local', {
      fetch: (async () => {
        requests += 1;
        return Response.json(
          { ...(code ? { code } : {}), status, request_id: 'native-list-request', retryable: status === 503 },
          { status },
        );
      }) as typeof fetch,
    });
    const result = await loadInboxPage(client, 'reporter-1', 'Bearer reporter').catch(inboxReadFailure);
    expect(result).toEqual({
      signedIn: true,
      state: code === 'platform_closed' ? 'closed' : 'unavailable',
      failure: {
        status,
        ...(code ? { code } : {}),
        retryable: status === 503,
        requestId: 'native-list-request',
      },
    });
    expect(requests).toBe(1);
  }
});

test('actual Retry-After survives list, target and thrown native failures; only a valid header supplies a wait', async () => {
  const { inboxReadFailure } = await import('../src/inbox/inbox-read');
  const { MediaProblem } = await import('../src/media/kernel');
  const { preferenceRetryDeadline } = await import('../src/settings/preference-failure-retry');
  const now = Date.parse('2026-10-31T00:00:00.000Z');
  for (const targetFailure of [false, true]) {
    for (const retryAfter of ['30', 'Sat, 31 Oct 2026 00:01:00 GMT', 'invalid', undefined]) {
      const paths: string[] = [];
      const client = createKernelClient('http://kernel.local', {
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          paths.push(path);
          expect(request.method).toBe('GET');
          if (targetFailure && path.endsWith('/notifications'))
            return Response.json({ items: [{ ...reporterNotice, decisionId: decision }], next: null });
          return Response.json(
            { status: 503, code: 'deadline_exceeded', retryable: true, request_id: 'native-deadline', retryAfter: '99' },
            { status: 503, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter } },
          );
        }) as typeof fetch,
      });
      const result = await loadInboxPage(client, 'reporter-1', 'Bearer reporter').catch(inboxReadFailure);
      expect(result).toEqual({
        signedIn: true,
        state: 'unavailable',
        failure: {
          status: 503,
          code: 'deadline_exceeded',
          retryable: true,
          requestId: 'native-deadline',
          ...(retryAfter === undefined ? {} : { retryAfter }),
        },
      });
      expect(paths).toEqual([
        '/v1/accounts/reporter-1/notifications',
        ...(targetFailure ? [`/v1/reports/${report}`] : []),
      ]);
      expect(preferenceRetryDeadline(retryAfter, now)).toBe(
        retryAfter === '30' ? now + 30_000 : retryAfter?.endsWith('GMT') ? now + 60_000 : 0,
      );
    }
  }
  const native = new MediaProblem(
    {
      type: 'https://rezics.com/problems/deadline_exceeded',
      title: 'Deadline Exceeded',
      status: 503,
      code: 'deadline_exceeded',
      retryable: true,
      request_id: 'thrown-target',
    } as ConstructorParameters<typeof MediaProblem>[0],
    { 'Retry-After': '30' },
  );
  const result = await resolveInboxItems(
    { items: [reporterNotice], next: null },
    {
      post: async () => null,
      decision: async () => null,
      report: async () => {
        throw native;
      },
    },
  ).catch(inboxReadFailure);
  expect(result).toEqual({
    signedIn: true,
    state: 'unavailable',
    failure: { status: 503, code: 'deadline_exceeded', retryable: true, requestId: 'thrown-target', retryAfter: '30' },
  });
});

test('malformed native notice pages refuse all target and seen IO before any row can render', async () => {
  const { inboxReadFailure } = await import('../src/inbox/inbox-read');
  const malformed = [
    { createdAt: 'not-a-timestamp' },
    { createdAt: '2026-02-30T10:00:00.000Z' },
    { id: 42 },
    { id: '' },
    { actorId: {} },
    { kind: 'report_outcome' },
    { reportId: 'report/another-route' },
    { reportId: undefined },
    { postId: post, threadId: null },
    { reportId: null, decisionId: null },
    { kind: 'mention', reportId: null, threadId: thread, postId: null },
  ].map((invalid) => ({ items: [reporterNotice, { ...reporterNotice, ...invalid }], next: null }));
  for (const payload of [null, [], 'unknown', {}, { items: [], next: 123 }, ...malformed]) {
    const requests: string[] = [];
    const client = createKernelClient('http://kernel.local', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(`${request.method} ${new URL(request.url).pathname}`);
        return Response.json(payload);
      }) as typeof fetch,
    });
    const result = await loadInboxPage(client, 'reporter-1', 'Bearer reporter').catch(inboxReadFailure);
    expect(result).toEqual({ signedIn: true, state: 'unavailable', failure: { status: 200 } });
    expect(requests).toEqual(['GET /v1/accounts/reporter-1/notifications']);
  }
});
