import { defineCases } from './types.ts';

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
