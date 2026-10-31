import type { FakeRoute } from '../fake-modules';
import offer from '../recorded/offer.json';

export const shellErrorOfferId = '0192f3a0-6c1e-7b2a-a001-000000000099';
type Outcome = 'unavailable' | 'still-unavailable' | 'closed' | 'missing';
let outcome: Outcome = 'unavailable';
let reads = 0;

export function selectShellErrorStory(value: Outcome) {
  outcome = value;
  reads = 0;
}
export function shellErrorReads() {
  return reads;
}

// Interface fixtures only: the ordinary offer loader and shared route boundary own recovery.
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: `/v1/offers/${shellErrorOfferId}`,
    story: () => {
      reads++;
      if (outcome === 'closed')
        return {
          status: 403,
          headers: { 'content-type': 'application/problem+json' },
          __responseBody: {
            type: 'https://rezics.com/problems/platform_closed',
            title: 'Platform Closed',
            status: 403,
            code: 'platform_closed',
            retryable: false,
            effect_status: 'not_applicable',
            request_id: 'story-shell-closed',
          },
        };
      if (outcome === 'missing') return { status: 404, body: { code: 'not_found' } };
      if (reads === 1 || outcome === 'still-unavailable')
        return { status: 503, headers: { 'retry-after': '1' }, body: { code: 'dependency_unavailable' } };
      return { status: 200, body: { offer: { ...offer.offer, id: shellErrorOfferId, revision: 1 } } };
    },
  },
];
