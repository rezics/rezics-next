import { defineCases, type PendingSubcase } from './types.ts';

// The retired page path remains the B00 inventory fingerprint until its explicit migration.
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

// Prospective combinations do not extend the qualified FACT01-06 denominator.
export const pendingVerificationSubcases = [
  { caseIds: ['FACT01'], scenario: 'Different sites repeat one origin or dependence is unknown, circular or over budget',
    requiredResult: 'Known copying is one origin; incomplete lineage yields explicit unknown or abstention, never independent support.', status: 'pending' },
  { caseIds: ['FACT02'], scenario: 'AI output citing earlier AI or source copies is imported again',
    requiredResult: 'Retain exact derivation and method inputs; a new model or URL does not create independent authority.', status: 'pending' },
  { caseIds: ['FACT03'], scenario: 'Source is reliable for identifiers but untested for plot summaries',
    requiredResult: 'Assess reliability by domain and context, separately from claim support.', status: 'pending' },
  { caseIds: ['FACT03'], scenario: 'A later announcement changes valid time or edition scope',
    requiredResult: 'Keep the earlier proposition; do not invent a contradiction.', status: 'pending' },
  { caseIds: ['FACT03'], scenario: 'Submit a challenge against a reviewed, protected value',
    requiredResult: 'Record pending challenge and exact counterevidence without submitter verdict authority; preserve review and protection.', status: 'pending' },
  { caseIds: ['FACT03', 'FACT04'], scenario: 'Last source withdraws or becomes unavailable',
    requiredResult: 'Missing support is not false; retain independent support, old assessments and explicit reassessment.', status: 'pending' },
  { caseIds: ['FACT04'], scenario: 'Content, evidence, source reliability, disposition or policy changes while invalidation delivery lags',
    requiredResult: 'Exact dependency and producer positions make old summary stale or pending before queue completion.', status: 'pending' },
  { caseIds: ['FACT04'], scenario: 'Old reassessment finishes after a newer generation activates',
    requiredResult: 'CAS rejects stale activation; one invalidation identity has one durable effect.', status: 'pending' },
  { caseIds: ['FACT04'], scenario: 'Popular source invalidates many components',
    requiredResult: 'Indexed paged work resumes idempotently; bounded reads verify freshness without corpus scan.', status: 'pending' },
  { caseIds: ['FACT01', 'FACT04'], scenario: 'Evidence or rating dependencies exceed admitted page',
    requiredResult: 'Reject or stage a complete manifest; never label a prefix complete.', status: 'pending' },
  { caseIds: ['FACT05'], scenario: 'Export reviewed, disputed or stale data with private or unavailable evidence',
    requiredResult: 'Preserve exact qualifications, context, method, policy, dependence, coverage and losses under disclosure.', status: 'pending' },
  { caseIds: ['FACT05'], scenario: 'Model emits a probability-like score without calibration',
    requiredResult: 'Retain method output and limits; do not report calibrated fact probability.', status: 'pending' },
  { caseIds: ['FACT06'], scenario: 'Funded publisher demands removal of a material correction',
    requiredResult: 'Payment does not change verdict, review authority or correction notice; respect recipient disclosure.', status: 'pending' },
] as const satisfies readonly PendingSubcase[];
