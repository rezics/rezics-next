import type { FakeRoute } from '../fake-modules';

/** The saved-rule execution producer is unavailable on this source stage; no success or ready-empty fixture. */
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/collections/saved-rule-unavailable/rule',
    story: () => ({ status: 503, code: 'dependency_unavailable' }),
  },
  {
    method: 'PUT',
    path: '/v1/collections/saved-rule-unavailable/rule',
    story: () => ({ status: 503, code: 'dependency_unavailable' }),
  },
];
