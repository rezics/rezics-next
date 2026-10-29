import type { FakeRoute } from '../fake-modules.ts';

function storyFixture(): string | null {
  const context = (globalThis as typeof globalThis & { __rezicsStoryContext?: { url: string } }).__rezicsStoryContext;
  return context ? new URL(context.url).searchParams.get('fixture') : null;
}

const accountRoute = /^\/v1\/accounts\/[^/]+\/notifications(?:\/count)?$/;
const fixtures = {
  mixed: [
    {
      id: 'notice-reply',
      kind: 'reply',
      createdAt: '2026-10-29T09:45:00.000Z',
      actorId: 'Momo',
      threadId: 'thread-1',
      postId: 'post-reply',
      unread: true,
    },
    {
      id: 'notice-report',
      kind: 'moderation_decision',
      createdAt: '2026-10-28T08:00:00.000Z',
      actorId: null,
      threadId: null,
      postId: null,
      decisionId: null,
      reportId: 'report-1',
      unread: true,
    },
    {
      id: 'notice-decision',
      kind: 'moderation_decision',
      createdAt: '2026-10-26T08:00:00.000Z',
      actorId: null,
      threadId: null,
      postId: null,
      decisionId: 'decision-1',
      reportId: null,
      unread: false,
    },
  ],
  unavailable: [
    {
      id: 'notice-unavailable',
      kind: 'moderation_decision',
      createdAt: '2026-10-29T09:45:00.000Z',
      actorId: null,
      threadId: null,
      postId: null,
      decisionId: 'missing-decision',
      reportId: null,
      unread: false,
    },
  ],
  many: [
    {
      id: 'notice-many',
      kind: 'reply',
      createdAt: '2026-10-29T09:45:00.000Z',
      actorId: 'Momo',
      threadId: 'thread-1',
      postId: 'post-reply',
      unread: true,
    },
  ],
  'row-overlay': [
    {
      id: 'notice-overlay',
      kind: 'reply',
      createdAt: '2026-10-29T09:45:00.000Z',
      actorId: 'Momo',
      threadId: 'thread-1',
      postId: 'post-reply',
      unread: true,
    },
    {
      id: 'notice-report-overlay',
      kind: 'moderation_decision',
      createdAt: '2026-10-28T08:00:00.000Z',
      actorId: null,
      threadId: null,
      postId: null,
      decisionId: null,
      reportId: 'report-1',
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
    path: /^\/v1\/posts\/post-reply$/,
    story: () => ({
      status: 200,
      post: {
        threadId: 'thread-1',
        body: { type: 'doc', content: [{ type: 'text', text: 'The last train leaves at midnight.' }] },
      },
    }),
  },
  {
    method: 'GET',
    path: /^\/v1\/reports\/report-1$/,
    story: () => ({ status: 200, report: { outcome: 'actioned' } }),
  },
  {
    method: 'GET',
    path: /^\/v1\/moderation-decisions\/decision-1$/,
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
