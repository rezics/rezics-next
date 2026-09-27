import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/recommendations.md', [
  {
    id: 'REC01',
    scenario: 'Build candidate ranking from private/source signals',
    requiredResult: 'Only admitted data and declared population participate.',
  },
  {
    id: 'REC02',
    scenario: 'One target receives extreme activity',
    requiredResult: 'No global exact-counter bottleneck or unbounded per-event fan-out.',
  },
  {
    id: 'REC03',
    scenario: 'Fail second ranking generation',
    requiredResult: 'First valid active generation remains.',
  },
  {
    id: 'REC04',
    scenario: 'Stale worker resumes',
    requiredResult: 'Cannot activate or overwrite newer generation.',
  },
  {
    id: 'REC05',
    scenario: 'Candidate becomes private/erased after ranking',
    requiredResult: 'Delivery excludes it without leaking counts/reasons.',
  },
  {
    id: 'REC06',
    scenario: 'Cursor references expired generation',
    requiredResult: 'Explicit restart; no mixed-order pagination.',
  },
]);
