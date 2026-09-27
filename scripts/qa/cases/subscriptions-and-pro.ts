import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/subscriptions-and-pro.md', [
  {
    id: 'SUB01',
    scenario: 'Higher gifted benefit plus lower paid plan',
    requiredResult: 'Purchase/gift state and effective benefits remain independent.',
  },
  {
    id: 'SUB02',
    scenario: 'Parallel/replaceable plan changes',
    requiredResult: 'Declared group semantics and exact quotes preserved.',
  },
  {
    id: 'SUB03',
    scenario: 'Duplicate/unknown settlement callback',
    requiredResult: 'No double charge/fulfillment; reconciliation remains explicit.',
  },
  {
    id: 'SUB04',
    scenario: 'Quota reservation races for last capacity',
    requiredResult: 'One admissible result; settlement/compensation idempotent.',
  },
  {
    id: 'SUB05',
    scenario: 'Review changes during content edit',
    requiredResult: 'Exact version approval cannot publish unreviewed content.',
  },
  {
    id: 'SUB06',
    scenario: 'Reply published into two Realms',
    requiredResult: 'Independent accepted versions, permissions and local counts.',
  },
  {
    id: 'SUB07',
    scenario: 'Fixed Pro site has sparse candidates',
    requiredResult: 'No fallback to general content or private-count leakage.',
  },
  {
    id: 'SUB08',
    scenario: 'Restore after benefit/review revocation',
    requiredResult: 'No revived entitlement/publication.',
  },
]);
