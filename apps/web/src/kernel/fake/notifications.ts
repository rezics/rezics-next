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

const list: FakeRoute = {
  method: 'GET',
  path: accountRoute,
  story: ({ request, recordings }) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/count')) {
      const fixture = url.searchParams.get('fixture') ?? storyFixture(request);
      return fixture === 'many'
        ? { status: 200, count: 100, capped: false }
        : (recordings['notifications-count'] ?? { status: 200, count: 0, capped: false });
    }
    const fixture = url.searchParams.get('fixture') ?? storyFixture(request);
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
    return path.endsWith('/count') ? { status: 200, count: 0, capped: false } : { status: 200, items: [], next: null };
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
  story: () => ({ status: 204 }),
  fixture: () => ({ status: 204 }),
};

export const routes = [list, ...storyTargets, seen];
