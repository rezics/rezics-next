import type { FakeRoute } from '../fake-modules.ts';

const decision = (id: string, state: 'open' | 'pending' | 'expired') => ({
  status: 200,
  id,
  targetKind: 'post',
  targetId: 'decision-post',
  action: 'takedown',
  statement: 'This post was withheld because it included personal information without consent.',
  decidedAt: '2026-10-01T09:30:00.000Z',
  appealDeadline: state === 'expired' ? '2026-10-28T09:30:00.000Z' : '2027-04-02T09:30:00.000Z',
  appeal:
    state === 'pending'
      ? { id: 'appeal-1', outcome: null, statement: 'The post does not identify another person.', resolvedAt: null }
      : null,
});

const states: Record<string, 'open' | 'pending' | 'expired'> = {
  'decision-open': 'open',
  'decision-pending': 'pending',
  'decision-expired': 'expired',
};

const readDecision: FakeRoute = {
  method: 'GET',
  path: /^\/v1\/moderation-decisions\/([^/]+)$/,
  story: ({ match }) => {
    const id = decodeURIComponent(match?.[1] ?? '');
    const state = states[id];
    return state ? decision(id, state) : { status: 404, code: 'not_found' };
  },
  fixture: ({ match }) => {
    const id = decodeURIComponent(match?.[1] ?? '');
    const state = states[id];
    return state ? decision(id, state) : { status: 404, code: 'not_found' };
  },
};

const readTarget: FakeRoute = {
  method: 'GET',
  path: /^\/v1\/posts\/decision-post$/,
  story: () => ({
    status: 200,
    post: {
      id: 'decision-post',
      threadId: 'decision-thread',
      authorId: 'decision-author',
      createdAt: '2026-10-01T09:00:00.000Z',
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A post with a decision attached.' }] }],
      },
    },
  }),
  fixture: () => ({
    status: 200,
    post: {
      id: 'decision-post',
      threadId: 'decision-thread',
      authorId: 'decision-author',
      createdAt: '2026-10-01T09:00:00.000Z',
      body: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A post with a decision attached.' }] }],
      },
    },
  }),
};

const appeal: FakeRoute = {
  method: 'POST',
  path: /^\/v1\/moderation-decisions\/[^/]+:appeal$/,
  story: () => ({ status: 201, id: 'appeal-1' }),
  fixture: () => ({ status: 201, id: 'appeal-1' }),
};

export const routes = [readDecision, readTarget, appeal];
