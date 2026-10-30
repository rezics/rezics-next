import type { FakeRoute } from '../fake-modules.ts';

function notificationState(): string | null {
  const context = (globalThis as typeof globalThis & { __rezicsStoryContext?: { url?: string } }).__rezicsStoryContext;
  return new URL(context?.url ?? '/settings', 'http://rezics.local').searchParams.get('notification-state');
}

const failures = {
  preparing: {
    status: 503,
    type: 'https://rezics.com/problems/dependency_unavailable',
    code: 'dependency_unavailable',
    retryable: true,
    request_id: 'story-settings-preparing',
  },
  closed: {
    status: 403,
    type: 'https://rezics.com/problems/platform_closed',
    code: 'platform_closed',
    retryable: false,
    request_id: 'story-settings-closed',
  },
  unavailable: {
    status: 500,
    type: 'https://rezics.com/problems/internal_error',
    code: 'internal_error',
    retryable: true,
    request_id: 'story-settings-unavailable',
  },
} as const;

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/accounts\/[^/]+\/preferences$/,
    story: () => {
      const state = notificationState();
      return state === 'preparing' || state === 'closed' || state === 'unavailable' ? failures[state] : undefined;
    },
  },
];
