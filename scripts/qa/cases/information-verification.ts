import { defineCases } from './types.ts';

export const cases = defineCases('docs/testing/information-verification.md', [
  {
    id: 'FACT01',
    scenario: 'Two sources repeat one original claim',
    requiredResult: 'Dependency lineage prevents false independent corroboration.',
  },
  {
    id: 'FACT02',
    scenario: 'AI output is re-ingested',
    requiredResult: 'Not treated as an independent authoritative source.',
  },
  {
    id: 'FACT03',
    scenario: 'Counterevidence or missing source',
    requiredResult: 'Preserve disagreement/unknown; not automatic false.',
  },
  {
    id: 'FACT04',
    scenario: 'Source corrected after assessment',
    requiredResult: 'Bounded invalidation and exact old assessment history.',
  },
  {
    id: 'FACT05',
    scenario: 'Export to an independent evaluator',
    requiredResult: 'Claims/evidence/method/policy and losses remain inspectable.',
  },
  {
    id: 'FACT06',
    scenario: 'Paid index result challenged',
    requiredResult: 'Funding cannot change verdict or suppress material correction.',
  },
]);
