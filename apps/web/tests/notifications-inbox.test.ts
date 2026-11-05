import { expect, mock, spyOn, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient } from '@tanstack/react-query';
import { ReporterStatusView } from '../src/moderation/reporter-status-view';
import type { ReporterStatus } from '../src/moderation/reporter-status-model';
import { getLocale } from '../src/paraglide/runtime.js';
import type { InboxPage } from '../src/inbox/inbox-read';
import {
  emptyInboxPagination,
  nextInboxPage,
  readableInboxPage,
  receiveInboxPage,
  restartInboxPage,
} from '../src/inbox/inbox-pagination';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { decodeInboxPage, nativeInboxEnvelope, readyInboxPage, resolveInboxItems } =
  await import('../src/inbox/inbox-read');
const { unreadBadgeLabel } = await import('../src/inbox/unread-badge');
type InboxNotice = import('../src/inbox/inbox-read').InboxNotice;

const thread = 'thread-1';
const post = 'post-1';
const decision = 'decision-1';
const report = 'report-1';

function notice(overrides: Partial<InboxNotice> = {}, accountId = 'reporter-1'): InboxNotice {
  const base: InboxNotice = {
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
  const target = overrides.target ?? {
    state: base.kind === 'moderation_decision' ? ('withheld' as const) : ('available' as const),
    threadId: base.kind === 'moderation_decision' ? null : base.threadId,
    postId: base.kind === 'moderation_decision' ? null : base.postId,
    boardId: base.kind === 'board_activity' ? 'board-1' : null,
    threadTitle: base.kind === 'moderation_decision' ? null : 'A current thread',
    boardTitle: base.kind === 'board_activity' ? 'A current board' : null,
  };
  const actor =
    overrides.actor ??
    (base.kind === 'moderation_decision'
      ? { state: 'system' as const, displayName: 'Moderation team' as const, handle: null, avatarUrl: null }
      : base.actorId
        ? {
            state: 'available' as const,
            accountId: base.actorId,
            displayName: 'Momo',
            handle: 'momo',
            avatarUrl: null,
            automated: false,
          }
        : {
            state: 'withheld' as const,
            displayName: 'Former or unavailable account' as const,
            handle: null,
            avatarUrl: null,
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
    summary: overrides.summary ?? 'A useful update summary',
    actions: overrides.actions ?? {
      open,
      markSeen: {
        method: 'POST',
        path: `/v1/accounts/${encodeURIComponent(accountId)}/notifications/${encodeURIComponent(base.id)}:markSeen`,
      },
    },
  };
}

test('the composed notice supplies current summaries and exact localized destinations without hydration IO', async () => {
  const page = await resolveInboxItems(
    nativeInboxEnvelope(
      [
        notice({ id: 'reply-雪', threadId: 'thread-雪', postId: 'post-雪' }),
        notice({ id: 'mention', kind: 'mention', threadId: thread, postId: 'mentioned-post' }),
        notice({ id: 'report', kind: 'moderation_decision', reportId: report, decisionId: null }),
        notice({ id: 'decision', kind: 'moderation_decision', reportId: null, decisionId: decision }),
      ],
      'opaque/+cursor==',
      'reporter-1',
    ),
  );
  expect(page.items.map((item) => item.href)).toEqual([
    `/${getLocale()}/threads/thread-%E9%9B%AA/a-current-thread?post=post-%E9%9B%AA#post-post-%E9%9B%AA`,
    `/${getLocale()}/threads/${thread}/a-current-thread?post=mentioned-post#post-mentioned-post`,
    `/${getLocale()}/moderation/reports/${report}`,
    `/${getLocale()}/moderation/decisions/${decision}`,
  ]);
  expect(page.items.map((item) => item.text)).toEqual(Array(4).fill('A useful update summary'));
  expect(page.items[0]).toMatchObject({ actorName: 'Momo', context: 'A current thread', unavailable: false });
  expect(page.next).toBe('opaque/+cursor==');
});

test('unreadable ordinary notices fail the page while reporter outcomes remain openable', async () => {
  const withheld = notice({
    id: 'withheld',
    actorId: null,
    threadId: null,
    postId: null,
    target: { state: 'withheld', threadId: null, postId: null, boardId: null, threadTitle: null, boardTitle: null },
    actions: {
      open: null,
      markSeen: { method: 'POST', path: '/v1/accounts/reporter-1/notifications/withheld:markSeen' },
    },
  });
  expect(() => decodeInboxPage(nativeInboxEnvelope([withheld], null, 'reporter-1'), 'reporter-1')).toThrow();
  const reportNotice = notice({ id: 'report', kind: 'moderation_decision', reportId: report, decisionId: null });
  const page = await resolveInboxItems(
    decodeInboxPage(nativeInboxEnvelope([reportNotice], null, 'reporter-1'), 'reporter-1'),
  );
  expect(page.items[0]).toMatchObject({ href: `/${getLocale()}/moderation/reports/${report}`, unavailable: true });
  expect(JSON.stringify(page.items[0])).not.toContain('Hidden target text');
});

test('page and badge use private reads, require deliberate acknowledgement, and preserve honest lower bounds', async () => {
  const source = await readFile(new URL('../src/inbox/inbox-read.ts', import.meta.url), 'utf8');
  const route = await readFile(new URL('../src/routes/inbox.tsx', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../src/shell/shell.tsx', import.meta.url), 'utf8');

  expect(source).toContain('private, no-store');
  expect(route).toMatch(/noindex/);
  expect(source).toMatch(/markSeen/);
  expect(source).toMatch(/markInboxNoticeSeen/);
  expect(source).toMatch(/markInboxThrough/);
  expect(shell).toMatch(/unreadBadgeLabel|UnreadBadge/);
  expect(unreadBadgeLabel({ count: 99, capped: false })).toBe('99');
  expect(unreadBadgeLabel({ count: 100, capped: false })).toBe('99+');
  expect(unreadBadgeLabel({ count: 4, capped: true })).toBe('≥4');
  expect(unreadBadgeLabel({ count: 0, capped: true, basis: 'current-visible-lower-bound' })).toBe('≥0');
  expect(unreadBadgeLabel({ count: 4, capped: false, basis: 'current-visible-lower-bound' })).toBe('≥4');
});

const { loadInboxPage, markInboxThrough } = await import('../src/inbox/inbox-read');
const { loadReporterStatus } = await import('../src/moderation/reporter-status-read');

test('the composed native post action gets its exact Thread post anchor without point reads', async () => {
  const readableNotice = notice({ id: 'native-post-notice', actorId: null, postId: 'native-post' });
  const requests: string[] = [];
  const client = createKernelClient('http://kernel.local', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path === '/v1/accounts/reporter-1/notifications')
        return Response.json(nativeInboxEnvelope([readableNotice], null, 'reporter-1'));
      throw new Error(`Unexpected point read ${path}`);
    }) as typeof fetch,
  });

  const page = await loadInboxPage(client, 'reporter-1', 'Bearer reporter');

  expect(page.items[0]).toMatchObject({
    href: `/${getLocale()}/threads/${thread}/a-current-thread?post=native-post#post-native-post`,
    text: 'A useful update summary',
    unavailable: false,
  });
  expect(requests).toEqual(['GET /v1/accounts/reporter-1/notifications']);
});

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

test('a reporter notice keeps its admitted status destination with withheld target context', async () => {
  for (const targetAvailability of ['available', 'unavailable'] as const) {
    for (const outcome of ['actioned', 'dismissed'] as const) {
      const submission = { ...submittedReport, targetAvailability, outcome };
      const currentReporterNotice = notice({
        ...reporterNotice,
        summary: outcome === 'actioned' ? 'Actioned' : 'Dismissed',
      });
      const calls: string[] = [];
      const client = createKernelClient('http://kernel.local', {
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          calls.push(`${request.method} ${path}`);
          expect(request.headers.get('authorization')).toBe('Bearer reporter');
          if (path === '/v1/accounts/reporter-1/notifications')
            return Response.json(nativeInboxEnvelope([currentReporterNotice], 'native-continuation', 'reporter-1'));
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
      expect(page.items[0]).toMatchObject({
        href: `/${getLocale()}/moderation/reports/${report}`,
        text: outcome === 'actioned' ? 'Actioned' : 'Dismissed',
        unavailable: true,
        target: { state: 'withheld', threadId: null, postId: null, boardId: null },
      });
      expect(calls).toEqual(['GET /v1/accounts/reporter-1/notifications']);
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
      expect(calls).toHaveLength(2);
      expect(page.items[0]?.unread).toBe(true);
      expect(JSON.stringify(page.items[0])).not.toMatch(/Hidden target text|Private note|Other reporter/);
    }
  }
});

test('report destination reads remain reporter-scoped after the Inbox admits the status route', async () => {
  const { targetAvailability: _availability, ...moderator } = submittedReport;
  for (const status of [200, 403, 404, 503]) {
    const client = createKernelClient('http://kernel.local', {
      fetch: (async (input, init) => {
        const path = new URL(new Request(input, init).url).pathname;
        if (path.endsWith('/notifications'))
          return Response.json(nativeInboxEnvelope([reporterNotice], null, 'reporter-1'));
        expect(path).toBe(`/v1/reports/${report}`);
        return Response.json(
          status === 200
            ? {
                report: {
                  ...moderator,
                  targetAvailability: 'unavailable',
                  partition: 1,
                  transactionId: 'private-transaction',
                },
              }
            : { code: status === 503 ? 'dependency_unavailable' : 'not_found' },
          { status },
        );
      }) as typeof fetch,
    });
    const page = await loadInboxPage(client, 'reporter-1', 'Bearer reporter');
    expect(page.items[0]?.href).toBe(`/${getLocale()}/moderation/reports/${report}`);
    if (status === 200)
      expect(await loadReporterStatus(client, report, 'Bearer reporter')).toMatchObject(submittedReport);
    else if (status === 404) expect(await loadReporterStatus(client, report, 'Bearer reporter')).toBeNull();
    else await expect(loadReporterStatus(client, report, 'Bearer reporter')).rejects.toThrow();
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
const {
  inboxPageQuery,
  inboxViewerQueryKey,
  unreadCountQuery,
  unreadCountQueryFor,
  markInboxViewerNoticeSeen,
  markInboxViewerSeen,
} = await import('../src/inbox/inbox-query');

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
      client.setQueryData(bobCountKey, {
        signedIn: true,
        state: 'ready',
        count: 2,
        capped: false,
        basis: 'current-visible-unread',
        witness: { kind: 'current-disclosure', at: '2026-11-04T00:00:00.000Z' },
      });
      client.setQueryData(bobPageKey, { signedIn: true, state: 'ready', items: [], next: null });
      client.setQueryData(aliceCountKey, {
        signedIn: true,
        state: 'ready',
        count: 7,
        capped: false,
        basis: 'current-visible-unread',
        witness: { kind: 'current-disclosure', at: '2026-11-04T00:00:00.000Z' },
      });
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

test('actual Retry-After survives the composed list failure; only a valid header supplies a wait', async () => {
  const { inboxReadFailure } = await import('../src/inbox/inbox-read');
  const { MediaProblem } = await import('../src/media/kernel');
  const { preferenceRetryDeadline } = await import('../src/settings/preference-failure-retry');
  const now = Date.parse('2026-10-31T00:00:00.000Z');
  for (const retryAfter of ['30', 'Sat, 31 Oct 2026 00:01:00 GMT', 'invalid', undefined]) {
    const paths: string[] = [];
    const client = createKernelClient('http://kernel.local', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        paths.push(path);
        expect(request.method).toBe('GET');
        return Response.json(
          {
            status: 503,
            code: 'deadline_exceeded',
            retryable: true,
            request_id: 'native-deadline',
            retryAfter: '99',
          },
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
    expect(paths).toEqual(['/v1/accounts/reporter-1/notifications']);
    expect(preferenceRetryDeadline(retryAfter, now)).toBe(
      retryAfter === '30' ? now + 30_000 : retryAfter?.endsWith('GMT') ? now + 60_000 : 0,
    );
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
  const result = inboxReadFailure(native);
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

test('rejected native cursors retry the identical GET and only an explicit restart omits the cursor, with unchanged page and distinct-target bounds', async () => {
  const { inboxReadFailure } = await import('../src/inbox/inbox-read');
  const cursor = 'opaque.signed+rejected/cursor==';
  for (const status of [400, 409, 410]) {
    const requests: Request[] = [];
    let firstPages = 0;
    const client = createKernelClient('http://kernel.local', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname.endsWith('/notifications')) {
          expect(request.headers.get('authorization')).toBe('Bearer reader');
          expect(url.searchParams.get('limit')).toBe('20');
          if (url.searchParams.has('cursor')) {
            expect(url.searchParams.get('cursor')).toBe(cursor);
            return Response.json(
              { status, request_id: 'cursor-rejected' },
              { status, headers: { 'Retry-After': '2' } },
            );
          }
          firstPages++;
          return Response.json(
            nativeInboxEnvelope(
              [0, 1].map((index) => notice({ id: `${firstPages === 1 ? 'old' : 'current'}-${index}` }, 'reader')),
              firstPages === 1 ? cursor : null,
              'reader',
            ),
          );
        }
        throw new Error(`Unexpected point read ${url.pathname}`);
      }) as typeof fetch,
    });
    const read = async (value?: string): Promise<InboxPage> =>
      loadInboxPage(client, 'reader', 'Bearer reader', value)
        .then((page): InboxPage => ({ signedIn: true, state: 'ready', ...page }))
        .catch(inboxReadFailure);
    let state = receiveInboxPage(emptyInboxPagination, await read());
    state = nextInboxPage(state);
    for (let attempt = 0; attempt < 2; attempt++) {
      state = receiveInboxPage(state, await read(state.cursor));
      expect(state.cursor).toBe(cursor);
      expect(state.result).toEqual({
        signedIn: true,
        state: 'unavailable',
        failure: { status, requestId: 'cursor-rejected', retryAfter: '2' },
      });
      expect(readableInboxPage(state)).toBeNull();
      expect(firstPages).toBe(1);
    }
    state = restartInboxPage(state);
    state = receiveInboxPage(state, await read(state.cursor));
    expect(readableInboxPage(state)?.items.map(({ id }) => id)).toEqual(['current-0', 'current-1']);
    expect(readableInboxPage(state)?.next).toBeNull();
    const urls = requests.map((request) => new URL(request.url));
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
    expect(
      urls.filter((url) => url.pathname.endsWith('/notifications')).map((url) => url.searchParams.get('cursor')),
    ).toEqual([null, cursor, cursor, null]);
    expect(urls.filter((url) => url.pathname.startsWith('/v1/posts/'))).toHaveLength(0);
    expect(urls.filter((url) => url.pathname === '/v1/accounts')).toHaveLength(0);
    expect(requests).toHaveLength(4);
  }
});

test('discarded page responses cannot repopulate a restarted chain or outlive a viewer denial, and resetting pages leaves the badge alone', async () => {
  for (const loseViewer of [false, true]) {
    const client = new QueryClient();
    const store = inboxViewerStore(client);
    const unsubscribe = store.subscribe(() => {});
    try {
      client.setQueryData(['session'], { state: 'signed-in', subject: 'alice', csrfToken: 'same-token' });
      const viewer = store.snapshot()!;
      const countKey = unreadCountQueryFor(viewer).queryKey;
      client.setQueryData(countKey, {
        signedIn: true,
        state: 'ready',
        count: 7,
        capped: false,
        basis: 'current-visible-unread',
        witness: { kind: 'current-disclosure', at: '2026-11-04T00:00:00.000Z' },
      });
      const oldPage = deferred<InboxPage>();
      const old = client.fetchQuery(inboxPageQuery(viewer, undefined, () => oldPage.promise)).catch(() => null);
      const loaded = receiveInboxPage(emptyInboxPagination, readyInboxPage([], 'rejected-cursor', 'alice'));
      const rejected = receiveInboxPage(nextInboxPage(loaded), {
        signedIn: true,
        state: 'unavailable',
        failure: { status: 409 },
      });
      const reset = restartInboxPage(rejected);
      client.removeQueries({ queryKey: inboxViewerQueryKey(viewer) });
      const currentPage = deferred<InboxPage>();
      let reads = 0;
      const query = inboxPageQuery(viewer, reset.cursor, () => {
        reads++;
        return currentPage.promise;
      });
      const fresh = client.fetchQuery(query).catch(() => undefined);
      const coalesced = client.fetchQuery(query).catch(() => undefined);
      expect(reads).toBe(1);
      if (loseViewer) {
        client.setQueryData(['session'], { state: 'unavailable', subject: null, csrfToken: null });
        client.setQueryData(['session'], { state: 'signed-in', subject: 'bob', csrfToken: 'same-token' });
      }
      const current: InboxPage = readyInboxPage([], null, 'alice');
      currentPage.resolve(current);
      const result = await fresh;
      expect(await coalesced).toBe(result);
      const obsolete: InboxPage = readyInboxPage(
        [{ ...notice(), text: 'Old private content', unavailable: false }],
        'old-continuation',
        'alice',
      );
      oldPage.resolve(obsolete);
      await old;
      expect(client.getQueryData(query.queryKey)).toEqual(loseViewer ? undefined : current);
      expect(readableInboxPage(receiveInboxPage(reset, result))).toEqual(
        loseViewer
          ? null
          : { items: [], next: null, viewer: { accountId: 'alice' }, selection: 'all', actions: { markSeen: null } },
      );
      expect(client.getQueryData(countKey)).toMatchObject({ count: 7 });
      expect(client.getQueryState(countKey)?.isInvalidated).toBe(false);
      if (loseViewer) expect(client.getQueryData(inboxPageQuery(store.snapshot()!).queryKey)).toBeUndefined();
    } finally {
      unsubscribe();
      client.clear();
    }
  }
});

test('Retain native failure metadata when marking Inbox notices seen with original request/privacy/recovery bounds intact', async () => {
  const { InboxSeenError, loadInboxSeen } = await import('../src/inbox/inbox-read');
  const { preferenceRetryDeadline } = await import('../src/settings/preference-failure-retry');
  const token = 'A'.repeat(22);
  const sessionEnv = {
    SITE_ORIGINS: 'https://site.example.test',
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.rezics.test',
    WEBSITE_SCOPES: 'openid account:read account:update',
    WEBSITE_CLIENT_ID: 'inbox',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => ({
          status: 'active',
          subject: 'alice',
          accessToken: 'private-token',
          csrfToken: token,
        }),
      }),
    },
  } as Partial<import('../src/session/client').SessionEnv>;
  const request = (csrf = token, signedIn = true) =>
    new Request('https://site.example.test/en/inbox', {
      method: 'POST',
      headers: {
        ...(signedIn ? { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } : {}),
        origin: 'https://site.example.test',
        'X-CSRF-Token': csrf,
      },
    });
  const attempt = { through: 'original-newest', idempotencyKey: '01a17a3b-0884-721b-91ef-d7ffd7bb58f8' };
  const now = Date.parse('2026-10-31T00:00:00.000Z');
  for (const status of [429, 503]) {
    for (const retryAfter of ['30', 'Sat, 31 Oct 2026 00:01:00 GMT', undefined, 'invalid']) {
      const calls: { key: string | null; body: unknown }[] = [];
      let nativeStatus = status;
      const native = createKernelClient('https://kernel.example.test', {
        fetch: (async (input, init) => {
          const sent = new Request(input, init);
          expect(sent.method).toBe('POST');
          expect(new URL(sent.url).pathname).toBe('/v1/accounts/alice/notifications:markSeen');
          expect(sent.headers.get('authorization')).toBe('Bearer private-token');
          calls.push({ key: sent.headers.get('idempotency-key'), body: await sent.json() });
          return nativeStatus === 204
            ? new Response(null, { status: 204 })
            : Response.json(
                {
                  status: nativeStatus,
                  code: status === 429 ? 'rate_limited' : 'deadline_exceeded',
                  retryable: true,
                  request_id: 'native-seen-request',
                  retryAfter: '999',
                  detail: 'private native body',
                  accessToken: 'private-token',
                },
                { status: nativeStatus, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter } },
              );
        }) as typeof fetch,
      });
      const client = new QueryClient();
      client.setQueryData(['session'], { state: 'signed-in', subject: 'alice', csrfToken: token });
      const viewer = inboxViewerStore(client).snapshot()!;
      const countKey = unreadCountQueryFor(viewer).queryKey;
      client.setQueryData(countKey, {
        signedIn: true,
        state: 'ready',
        count: 7,
        capped: false,
        basis: 'current-visible-unread',
        witness: { kind: 'current-disclosure', at: '2026-11-04T00:00:00.000Z' },
      });
      try {
        const send = async ({ data, headers }: { data: typeof attempt; headers: HeadersInit }) => {
          const result = await loadInboxSeen(
            native,
            request(new Headers(headers).get('X-CSRF-Token')!),
            sessionEnv,
            data,
          );
          // Server functions need only serialize plain data: no Error prototype/custom-property support.
          return JSON.parse(JSON.stringify(result)) as typeof result;
        };
        const failure = await markInboxViewerSeen(client, viewer, attempt, token, send).catch(
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(InboxSeenError);
        expect((failure as InstanceType<typeof InboxSeenError>).failure).toEqual({
          status,
          code: status === 429 ? 'rate_limited' : 'deadline_exceeded',
          retryable: true,
          requestId: 'native-seen-request',
          ...(retryAfter === undefined ? {} : { retryAfter }),
        });
        expect(JSON.stringify(failure)).not.toContain('private');
        expect(preferenceRetryDeadline(retryAfter, now)).toBe(
          retryAfter === '30' ? now + 30_000 : retryAfter?.endsWith('GMT') ? now + 60_000 : 0,
        );
        expect(client.getQueryState(countKey)?.isInvalidated).toBe(false);
        expect(client.getQueryData(countKey)).toMatchObject({ count: 7 });
        // Only an explicit retry with the original intent can confirm and invalidate.
        nativeStatus = 204;
        await markInboxViewerSeen(client, viewer, attempt, token, send);
        expect(client.getQueryState(countKey)?.isInvalidated).toBe(true);
        expect(calls).toEqual(
          Array(2).fill({ key: JSON.stringify(attempt.idempotencyKey), body: { through: attempt.through } }),
        );
        expect(await loadInboxSeen(native, request('wrong-token'), sessionEnv, attempt)).toMatchObject({
          signedIn: true,
          failure: { status: 403, code: 'forbidden' },
        });
        expect(await loadInboxSeen(native, request(token, false), sessionEnv, attempt)).toEqual({ signedIn: false });
        expect(calls).toHaveLength(2);
      } finally {
        client.clear();
      }
    }
  }
});

test('seen failure envelopes bound diagnostics, preserve non-204 uncertainty, and cannot cross a viewer epoch', async () => {
  const { inboxSeenFailure, InboxSeenError } = await import('../src/inbox/inbox-read');
  const { withPlatformClosedRecognition } = await import('../src/kernel/platform-closed');
  for (const status of [200, 202, 401, 403, 503]) {
    const native = withPlatformClosedRecognition(
      createKernelClient('https://kernel.example.test', {
        fetch: (async () =>
          Response.json(
            {
              code: status === 403 ? 'platform_closed' : 'native_failure',
              request_id: 'x'.repeat(129),
              retryAfter: '999',
              detail: 'private raw body',
            },
            { status },
          )) as typeof fetch,
      }),
    );
    const result = await markInboxThrough(native, 'alice', 'Bearer secret', {
      through: 'original',
      idempotencyKey: 'original-key',
    }).then(() => null, inboxSeenFailure);
    expect(result).toMatchObject({ signedIn: true, failure: { status } });
    expect(JSON.stringify(result)).not.toMatch(/requestId|retryAfter|private|secret/);
    if (status === 403) expect(result).toMatchObject({ failure: { code: 'platform_closed' } });
  }
  expect(inboxSeenFailure(new Error('private lost response'))).toEqual({ signedIn: true, failure: { status: null } });
  expect(
    inboxSeenFailure(new InboxSeenError({ status: 429, code: 'x'.repeat(129), retryAfter: '9'.repeat(129) })),
  ).toEqual({ signedIn: true, failure: { status: 429 } });

  const client = new QueryClient();
  const store = inboxViewerStore(client);
  const unsubscribe = store.subscribe(() => {});
  try {
    client.setQueryData(['session'], { state: 'signed-in', subject: 'alice' });
    const alice = store.snapshot()!;
    const late = deferred<import('../src/inbox/inbox-read').InboxSeenResult>();
    let sends = 0;
    const send = async () => {
      sends++;
      return late.promise;
    };
    const attempt = { through: 'alice-original', idempotencyKey: 'alice-key' };
    const pending = markInboxViewerSeen(client, alice, attempt, 'alice-token', send).catch(
      (error: Error) => error.name,
    );
    client.setQueryData(['session'], { state: 'signed-in', subject: 'bob' });
    const bob = store.snapshot()!;
    client.setQueryData(unreadCountQueryFor(bob).queryKey, {
      signedIn: true,
      state: 'ready',
      count: 2,
      capped: false,
      basis: 'current-visible-unread',
      witness: { kind: 'current-disclosure', at: '2026-11-04T00:00:00.000Z' },
    });
    late.resolve({ signedIn: true, failure: { status: 429, code: 'rate_limited', retryAfter: '30' } });
    expect(await pending).toBe('AbortError');
    await expect(markInboxViewerSeen(client, alice, attempt, 'bob-token', send)).rejects.toThrow(
      'Inbox viewer changed',
    );
    expect(sends).toBe(1);
    expect(client.getQueryState(unreadCountQueryFor(bob).queryKey)?.isInvalidated).toBe(false);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test('validated acknowledgement stays consumed when later current reads fail, and a native send rejection keeps the original', async () => {
  const { InboxSeenError } = await import('../src/inbox/inbox-read');
  for (const kind of ['loaded', 'notice'] as const) {
    const client = new QueryClient();
    const store = inboxViewerStore(client);
    const unsubscribe = store.subscribe(() => {});
    const sends: unknown[] = [];
    try {
      client.setQueryData(['session'], { state: 'signed-in', subject: 'alice', csrfToken: 'alice-token' });
      const viewer = store.snapshot()!;
      const invalidation = spyOn(client, 'invalidateQueries').mockImplementation(async () => {
        throw new Error('current page refresh failed');
      });
      const send = async ({ data, headers }: { data: unknown; headers: HeadersInit }) => {
        sends.push({ data, token: new Headers(headers).get('X-CSRF-Token') });
        return { signedIn: true };
      };
      if (kind === 'loaded') {
        const attempt = { through: 'displayed', idempotencyKey: crypto.randomUUID() };
        await expect(markInboxViewerSeen(client, viewer, attempt, 'alice-token', send)).resolves.toMatchObject({
          page: true,
          count: true,
        });
        await expect(
          markInboxViewerSeen(client, viewer, attempt, 'alice-token', async () => {
            sends.push('rejected');
            return { signedIn: true, failure: { status: 503, retryable: true, code: 'deadline_exceeded' } };
          }),
        ).rejects.toBeInstanceOf(InboxSeenError);
      } else {
        const attempt = Object.freeze({
          accountId: 'alice',
          noticeId: 'chosen',
          idempotencyKey: crypto.randomUUID(),
        });
        await expect(markInboxViewerNoticeSeen(client, viewer, attempt, 'alice-token', send)).resolves.toMatchObject({
          page: true,
          count: true,
        });
        await expect(
          markInboxViewerNoticeSeen(client, viewer, attempt, 'alice-token', async () => {
            sends.push('rejected');
            return { signedIn: true, failure: { status: 503, retryable: true, code: 'deadline_exceeded' } };
          }),
        ).rejects.toBeInstanceOf(InboxSeenError);
      }
      expect(sends).toHaveLength(2);
      expect(sends[1]).toBe('rejected');
      expect(invalidation).toHaveBeenCalled();
      invalidation.mockRestore();
    } finally {
      unsubscribe();
      client.clear();
    }
  }
});
