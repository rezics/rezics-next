import { SESSION_HEADER, type KernelClient } from '@rezics/client';
import type { FakeRoute } from '../fake-modules.ts';

type Decision = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['moderation-decisions']>['get']>>['data']>;
type DecisionState = 'open' | 'pending' | 'expired';

/** Illustrative composed receipts use the installed closed advice/context contract. */
function decision(id: string, state: DecisionState) {
  const body = {
    id,
    targetKind: 'post',
    targetId: 'decision-post',
    action: 'takedown',
    statement: 'This post was withheld because it included personal information without consent.',
    decidedAt: '2026-10-01T09:30:00.000Z',
    appealDeadline: state === 'expired' ? '2026-10-28T09:30:00.000Z' : '2027-04-02T09:30:00.000Z',
    appeal: state === 'pending' ? { id: 'appeal-1', outcome: null, statement: null, resolvedAt: null } : null,
    viewer: {
      affectedAuthor: true,
      observedAt: '2026-11-04T00:00:00.000Z',
      appeal:
        state === 'open'
          ? { state: 'permitted' }
          : { state: 'unavailable', reason: state === 'pending' ? 'already_appealed' : 'deadline_passed' },
    },
    targetContext: { state: 'concealed' },
  } satisfies Decision;
  return {
    status: 200,
    ...body,
    headers: { [SESSION_HEADER]: `illustrative-decision-source-${id}-${state}` },
  };
}

const states: Record<string, DecisionState> = {
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

const appeal: FakeRoute = {
  method: 'POST',
  path: /^\/v1\/moderation-decisions\/[^/]+:appeal$/,
  story: () => ({ status: 201, id: 'appeal-1' }),
  fixture: () => ({ status: 201, id: 'appeal-1' }),
};

export const routes = [readDecision, appeal];
