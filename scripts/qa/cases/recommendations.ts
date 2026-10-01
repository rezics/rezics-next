import { defineCases, type PendingSubcase } from './types.ts';

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

// Semantic-context refinements; they do not inherit the base cases' recorded pass status.
export const pendingSemanticRankingSubcases = [
  { caseIds: ['REC01'], scenario: 'A reader likes or prioritizes a Concept while personal and Realm populations rank',
    requiredResult: 'Exact semantic criteria and independent populations hold as preferences change; a preference never asserts an interpretation or rewrites a Statement.', status: 'pending' },
  { caseIds: ['REC05'], scenario: 'A ranked candidate depends on a private definition or selection',
    requiredResult: 'Private definition and selection dependencies gate delivery like other disclosure inputs.', status: 'pending' },
  { caseIds: ['REC06'], scenario: 'A semantic selection and a preference ordering change separately under one cursor',
    requiredResult: 'The cursor binds both revisions independently and restarts when either changes.', status: 'pending' },
  { caseIds: ['REC02', 'REC03'], scenario: 'An additional ranking profile is admitted',
    requiredResult: 'Repeated snapshots, stale leases, sparse or private candidates and recovery are exercised for that profile; skew/load stays a separate tier.', status: 'pending' },
] as const satisfies readonly PendingSubcase[];
