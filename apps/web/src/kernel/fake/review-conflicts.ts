import type { FakeRoute } from '../fake-modules.ts';

const existingThreadId = '0192f3a0-6c1e-7b2a-9d4e-000000000009';

async function conflict(request: Request) {
  const body = (await request.json()) as { kind?: string };
  if (body.kind !== 'review') return;
  return {
    status: 409,
    type: 'https://rezics.com/problems/conflict',
    title: 'Conflict',
    code: 'review_exists',
    retryable: false,
    effect_status: 'not_applied',
    request_id: 'fake-review-conflict',
    ...(!request.headers.has('x-fake-omit-existing-thread-id') ? { existingThreadId } : {}),
  };
}

export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: '/v1/threads',
    story: ({ request }) => conflict(request),
    fixture: ({ request }) => conflict(request),
  },
];
