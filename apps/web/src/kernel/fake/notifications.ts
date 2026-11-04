import { fromPlainText } from '@rezics/document';
import type { FakeRoute } from '../fake-modules.ts';
import type { ReporterStatus } from '../../moderation/reporter-status-model';

function storyFixture(request: Request): string | null {
  const context = (globalThis as typeof globalThis & { __rezicsStoryContext?: { url: string } }).__rezicsStoryContext;
  return context ? new URL(context.url, request.url).searchParams.get('fixture') : null;
}

const accountRoute = /^\/v1\/accounts\/[^/]+\/notifications(?:\/count)?$/;
const storyActor = '01a17a3b-0884-721b-91ef-d7ffd7bb58f0';
const storyThread = '01a17a3b-0884-721b-91ef-d7ffd7bb58f1';
const storyPost = '01a17a3b-0884-721b-91ef-d7ffd7bb58f2';
const storyReport = '01a17a3b-0884-721b-91ef-d7ffd7bb58f3';
const storyDecision = '01a17a3b-0884-721b-91ef-d7ffd7bb58f4';
const ownReport: ReporterStatus = {
  id: storyReport,
  target: { kind: 'post', id: storyPost },
  revisionId: '01a17a3b-0884-721b-91ef-d7ffd7bb58f6',
  reason: 'spam',
  evidence: 'Repeated advertising in this discussion.',
  reporterId: storyActor,
  createdAt: '2026-10-27T08:00:00.000Z',
  outcome: 'actioned',
  resolvedAt: '2026-10-28T08:00:00.000Z',
  targetAvailability: 'available',
};
const fixtures = {
  mixed: [
    {
      id: '01a17a3b-0884-721b-91ef-d7ffd7bb5801',
      kind: 'reply',
      createdAt: '2026-10-29T09:45:00.000Z',
      actorId: storyActor,
      threadId: storyThread,
      postId: storyPost,
      decisionId: null,
      reportId: null,
      unread: true,
    },
    {
      id: '01a17a3b-0884-721b-91ef-d7ffd7bb5802',
      kind: 'moderation_decision',
      createdAt: '2026-10-28T08:00:00.000Z',
      actorId: null,
      threadId: null,
      postId: null,
      decisionId: null,
      reportId: storyReport,
      unread: true,
    },
    {
      id: '01a17a3b-0884-721b-91ef-d7ffd7bb5803',
      kind: 'moderation_decision',
      createdAt: '2026-10-26T08:00:00.000Z',
      actorId: null,
      threadId: null,
      postId: null,
      decisionId: storyDecision,
      reportId: null,
      unread: false,
    },
  ],
  unavailable: [
    {
      id: '01a17a3b-0884-721b-91ef-d7ffd7bb5804',
      kind: 'moderation_decision',
      createdAt: '2026-10-29T09:45:00.000Z',
      actorId: null,
      threadId: null,
      postId: null,
      decisionId: '01a17a3b-0884-721b-91ef-d7ffd7bb58f5',
      reportId: null,
      unread: false,
    },
  ],
  many: [
    {
      id: '01a17a3b-0884-721b-91ef-d7ffd7bb5805',
      kind: 'reply',
      createdAt: '2026-10-29T09:45:00.000Z',
      actorId: storyActor,
      threadId: storyThread,
      postId: storyPost,
      decisionId: null,
      reportId: null,
      unread: true,
    },
  ],
  'row-overlay': [
    {
      id: '01a17a3b-0884-721b-91ef-d7ffd7bb5806',
      kind: 'reply',
      createdAt: '2026-10-29T09:45:00.000Z',
      actorId: storyActor,
      threadId: storyThread,
      postId: storyPost,
      decisionId: null,
      reportId: null,
      unread: true,
    },
    {
      id: '01a17a3b-0884-721b-91ef-d7ffd7bb5807',
      kind: 'moderation_decision',
      createdAt: '2026-10-28T08:00:00.000Z',
      actorId: null,
      threadId: null,
      postId: null,
      decisionId: null,
      reportId: storyReport,
      unread: false,
    },
  ],
} as const;

export const inboxReadRecoveryStory = { reads: 0 };
export const inboxSeenRecoveryStory = { commands: [] as { through: unknown; key: string | null }[] };
export const inboxSeenAccessStory = { pageReads: 0, sessionReads: 0 };
export const inboxTriageStory = {
  pageReads: 0,
  writes: [] as { through: unknown; key: string | null; body: unknown }[],
  denyNextRead: false,
};

export function resetInboxTriageStory() {
  inboxTriageStory.pageReads = 0;
  inboxTriageStory.writes = [];
  inboxTriageStory.denyNextRead = false;
}

const list: FakeRoute = {
  method: 'GET',
  path: accountRoute,
  story: ({ request, recordings }) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/count')) {
      const fixture = url.searchParams.get('fixture') ?? storyFixture(request);
      return fixture === 'many'
        ? {
            status: 200,
            count: 100,
            capped: false,
            basis: 'current-visible-unread',
            witness: { kind: 'current-disclosure', at: '2026-11-04T00:00:00.000Z' },
          }
        : (recordings['notifications-count'] ?? {
            status: 200,
            count: 0,
            capped: false,
            basis: 'current-visible-unread',
            witness: { kind: 'current-disclosure', at: '2026-11-04T00:00:00.000Z' },
          });
    }
    const fixture = url.searchParams.get('fixture') ?? storyFixture(request);
    if (fixture === 'seen-access-recovery') {
      inboxSeenAccessStory.pageReads++;
      if (inboxSeenAccessStory.pageReads === 2)
        return { status: 403, code: 'forbidden', retryable: false, request_id: 'story-inbox-read-denied' };
      return {
        status: 200,
        items: inboxSeenAccessStory.pageReads === 1 ? fixtures.mixed : [fixtures.many[0], ...fixtures.mixed],
        next: null,
      };
    }
    if (fixture === 'triage-journey') {
      inboxTriageStory.pageReads++;
      if (inboxTriageStory.denyNextRead) {
        inboxTriageStory.denyNextRead = false;
        return { status: 403, code: 'forbidden', retryable: false, request_id: 'story-inbox-triage-read-denied' };
      }
      if (url.searchParams.get('cursor') === 'story-triage-older')
        return { status: 200, items: [fixtures.mixed[1], fixtures.mixed[2]], next: null };
      return {
        status: 200,
        items: [{ ...fixtures.mixed[0], unread: false }],
        next: 'story-triage-older',
      };
    }
    if (fixture?.startsWith('seen-'))
      return url.searchParams.has('cursor')
        ? { status: 200, items: fixtures.unavailable, next: null }
        : { status: 200, items: fixtures.mixed, next: fixture === 'seen-wait' ? 'story-seen-next' : null };
    if (fixture === 'retry-after') {
      inboxReadRecoveryStory.reads += 1;
      if (inboxReadRecoveryStory.reads > 1)
        return recordings['notifications-inbox-empty'] ?? { status: 200, items: [], next: null };
      return {
        status: 503,
        headers: { 'Retry-After': '2' },
        type: 'https://rezics.com/problems/deadline_exceeded',
        code: 'deadline_exceeded',
        retryable: true,
        request_id: 'story-inbox-deadline',
      };
    }
    if (fixture === 'preparing')
      return {
        status: 503,
        type: 'https://rezics.com/problems/dependency_unavailable',
        code: 'dependency_unavailable',
        retryable: true,
        request_id: 'story-inbox-preparing',
      };
    if (fixture === 'closed')
      return {
        status: 403,
        type: 'https://rezics.com/problems/platform_closed',
        code: 'platform_closed',
        retryable: false,
        request_id: 'story-inbox-closed',
      };
    if (fixture === 'unavailable-operation')
      return {
        status: 500,
        type: 'https://rezics.com/problems/internal_error',
        code: 'internal_error',
        retryable: true,
        request_id: 'story-inbox-unavailable',
      };
    if (fixture?.startsWith('report-')) return { status: 200, items: [fixtures.mixed[1]], next: null };
    return fixture === 'empty' || !fixture
      ? (recordings['notifications-inbox-empty'] ?? { status: 200, items: [], next: null })
      : { status: 200, items: fixtures[fixture as keyof typeof fixtures] ?? [], next: null };
  },
  fixture: ({ request }) => {
    const path = new URL(request.url).pathname;
    return path.endsWith('/count')
      ? {
          status: 200,
          count: 0,
          capped: false,
          basis: 'current-visible-unread',
          witness: { kind: 'current-disclosure', at: '2026-11-04T00:00:00.000Z' },
        }
      : { status: 200, items: [], next: null };
  },
};

const storyTargets: FakeRoute[] = [
  {
    method: 'GET',
    path: new RegExp(`^/v1/posts/${storyPost}$`),
    story: () => ({
      status: 200,
      post: {
        threadId: storyThread,
        body: fromPlainText('The last train leaves at midnight.'),
      },
    }),
  },
  {
    method: 'GET',
    path: new RegExp(`^/v1/reports/${storyReport}$`),
    story: ({ request }) => {
      const fixture = storyFixture(request);
      if (fixture === 'report-moderator') {
        const { targetAvailability: _availability, ...report } = ownReport;
        return { status: 200, report: { ...report, partition: 1, transactionId: storyDecision } };
      }
      return {
        status: 200,
        report: {
          ...ownReport,
          ...(fixture === 'report-unavailable' ? { targetAvailability: 'unavailable', outcome: 'dismissed' } : {}),
        },
      };
    },
  },
  {
    method: 'GET',
    path: new RegExp(`^/v1/moderation-decisions/${storyDecision}$`),
    story: () => ({ status: 200, statement: 'A moderation decision is ready to read.' }),
  },
];

const seen: FakeRoute = {
  method: 'POST',
  path: /^\/v1\/accounts\/[^/]+\/notifications:markSeen$/,
  story: async ({ request }) => {
    const fixture = storyFixture(request);
    if (fixture === 'triage-journey') {
      const body = (await request.json()) as { through?: unknown };
      inboxTriageStory.writes.push({
        through: body.through,
        key: request.headers.get('idempotency-key'),
        body,
      });
      return inboxTriageStory.writes.length === 1
        ? {
            status: 503,
            code: 'deadline_exceeded',
            retryable: true,
            request_id: 'story-inbox-triage-marker-unknown',
          }
        : { status: 204 };
    }
    if (!fixture?.startsWith('seen-')) return { status: 204 };
    const body = (await request.json()) as { through?: unknown };
    inboxSeenRecoveryStory.commands.push({ through: body.through, key: request.headers.get('idempotency-key') });
    if (fixture === 'seen-access-recovery')
      return {
        status: inboxSeenRecoveryStory.commands.length === 1 ? 403 : 429,
        code: inboxSeenRecoveryStory.commands.length === 1 ? 'forbidden' : 'rate_limited',
        retryable: inboxSeenRecoveryStory.commands.length !== 1,
        headers: { 'Retry-After': '2' },
        request_id: 'story-inbox-seen-access',
      };
    if (fixture === 'seen-wait' && inboxSeenRecoveryStory.commands.length > 1) return { status: 204 };
    const status = fixture === 'seen-wait' ? 429 : fixture === 'seen-closed' || fixture === 'seen-denied' ? 403 : 503;
    const code =
      fixture === 'seen-closed'
        ? 'platform_closed'
        : fixture === 'seen-denied'
          ? 'forbidden'
          : status === 429
            ? 'rate_limited'
            : 'deadline_exceeded';
    return {
      status,
      code,
      retryable: status !== 403,
      request_id: 'story-inbox-seen',
      ...(fixture === 'seen-wait' ? { headers: { 'Retry-After': '2' } } : {}),
    };
  },
  fixture: () => ({ status: 204 }),
};

export const routes = [list, ...storyTargets, seen];
