import { fromPlainText } from '@rezics/document';
import type { FakeRoute } from '../fake-modules.ts';

function storyFixture(): string | null {
  const context = (globalThis as typeof globalThis & { __rezicsStoryContext?: { url: string } }).__rezicsStoryContext;
  return context ? new URL(context.url).searchParams.get('fixture') : null;
}

const accountRoute = /^\/v1\/accounts\/[^/]+\/notifications(?:\/count)?$/;
const storyActor = '01a17a3b-0884-721b-91ef-d7ffd7bb58f0';
const storyThread = '01a17a3b-0884-721b-91ef-d7ffd7bb58f1';
const storyPost = '01a17a3b-0884-721b-91ef-d7ffd7bb58f2';
const storyReport = '01a17a3b-0884-721b-91ef-d7ffd7bb58f3';
const storyDecision = '01a17a3b-0884-721b-91ef-d7ffd7bb58f4';
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

const list: FakeRoute = {
  method: 'GET',
  path: accountRoute,
  story: ({ request, recordings }) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/count')) {
      const fixture = url.searchParams.get('fixture') ?? storyFixture();
      return fixture === 'many'
        ? { status: 200, count: 100, capped: false }
        : (recordings['notifications-count'] ?? { status: 200, count: 0, capped: false });
    }
    const fixture = url.searchParams.get('fixture') ?? storyFixture();
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
    story: () => ({ status: 200, report: { outcome: 'actioned' } }),
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
