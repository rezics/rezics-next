import { defineCases, type PendingSubcase } from './types.ts';

export const cases = defineCases('docs/testing/relationship-graph.md', [
  {
    id: 'GRAPH01',
    scenario: 'Query performer and character roles',
    requiredResult: 'Both belong to the same credit occurrence.',
  },
  {
    id: 'GRAPH02',
    scenario: 'Display causal/background links from conflicting canons',
    requiredResult: 'Context and evidence remain explicit; reachability is not causation.',
  },
  {
    id: 'GRAPH03',
    scenario: 'Expand dense hub or unanchored closure',
    requiredResult: 'Bounded plan/admission and truthful frontier.',
  },
  {
    id: 'GRAPH04',
    scenario: 'Encounter private intermediate node',
    requiredResult: 'No path/count/existence leakage.',
  },
  {
    id: 'GRAPH05',
    scenario: 'Search text then continue relation traversal',
    requiredResult:
      'Same ARQ binding semantics within one admitted request; no cross-request snapshot assumption.',
  },
  {
    id: 'GRAPH06',
    scenario: 'Edit graph layout',
    requiredResult: 'Presentation state does not mutate relation truth.',
  },
]);

// The current bounded relation-graph profile does not qualify all related-read shapes.
export const pendingRelatedReadSubcases = [
  { caseIds: ['GRAPH01', 'GRAPH03'], scenario: 'Credits, releases, chapters, source mappings and mentions mix direction, context and repeated targets',
    requiredResult: 'Preserve each relation identity and same-occurrence role correlation; report the requested target grain, coverage and stable order without cross-joining participants.', status: 'pending' },
  { caseIds: ['GRAPH03', 'GRAPH04'], scenario: 'A high-degree inverse list contains sparse private members and requires summary or support hydration',
    requiredResult: 'Page a bounded admitted relation, batch hydration, and disclose continuation and unavailable members without suppressed titles, existence or exact global count leakage.', status: 'pending' },
  { caseIds: ['GRAPH03', 'GRAPH05'], scenario: 'A page crosses relation, projection, ranking or historical-manifest generations',
    requiredResult: 'Bind cursor to every relevant generation or restart; resolve sealed historical components and never assume that a dataset fence reopens a TDB2 transaction.', status: 'pending' },
  { caseIds: ['GRAPH03'], scenario: 'An owner event rebuild fails after a prior active inverse projection',
    requiredResult: 'Retain the active generation and exact source revision or epoch until a complete replacement is verified.', status: 'pending' },
] as const satisfies readonly PendingSubcase[];

// Semantic-context refinements; they do not inherit the base cases' recorded pass status.
export const pendingSemanticGraphSubcases = [
  { caseIds: ['GRAPH01'], scenario: 'Female-lead and red-hair traits belong to different characters, releases or canons, with repeated appearances',
    requiredResult: 'No match across participants; successful reads keep exact supporting Statement and occurrence IDs.', status: 'pending' },
  { caseIds: ['GRAPH02'], scenario: 'Personal and Realm interpretations of one relation are compared',
    requiredResult: 'Speaker, exact definition, evidence and decision scope stay separate.', status: 'pending' },
  { caseIds: ['GRAPH03', 'GRAPH05'], scenario: 'Grouped and inverse reads hydrate summaries and shared Contexts',
    requiredResult: 'Bounded reads with distinct count grain; same-label criteria stay separate absent an admitted equivalence.', status: 'pending' },
  { caseIds: ['GRAPH04'], scenario: 'A public frontier passes through private intermediates',
    requiredResult: 'Private paths, names, avatars, buckets, Context/base references and personal selections stay hidden.', status: 'pending' },
  { caseIds: ['GRAPH06'], scenario: 'An Appearance group moves or a Context preference changes',
    requiredResult: 'Accepted Statements, semantic identity and authored edge meaning are unchanged.', status: 'pending' },
] as const satisfies readonly PendingSubcase[];
