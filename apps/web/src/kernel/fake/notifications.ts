import type { FakeRoute } from '../fake-modules.ts';

const accountRoute = /^\/v1\/accounts\/[^/]+\/notifications(?:\/count)?$/;
const list: FakeRoute = {
  method: 'GET',
  path: accountRoute,
  story: ({ request, recordings }) => {
    const path = new URL(request.url).pathname;
    return path.endsWith('/count') ? recordings['notifications-count'] : recordings['notifications-inbox-empty'];
  },
  fixture: ({ request }) => {
    const path = new URL(request.url).pathname;
    return path.endsWith('/count') ? { status: 200, count: 0, capped: false } : { status: 200, items: [], next: null };
  },
};

const seen: FakeRoute = {
  method: 'POST',
  path: /^\/v1\/accounts\/[^/]+\/notifications:markSeen$/,
  story: () => ({ status: 204 }),
  fixture: () => ({ status: 204 }),
};

export const routes = [list, seen];
