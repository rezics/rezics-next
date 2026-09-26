import type { CaseDeclarations } from './declaration.ts';

const graphQueries = {
  tier: 'integration' as const,
  file: 'tests/qa/integration/graph-query-cases.test.ts',
  name: 'GRAPH01/GRAPH02/GRAPH03/GRAPH04/GRAPH05: occurrence roles, explicit canons, bounded frontier, disclosure and same-request text traversal',
};

export const graphCases: CaseDeclarations = {
  GRAPH01: [graphQueries],
  GRAPH02: [graphQueries],
  GRAPH03: [graphQueries],
  GRAPH04: [graphQueries],
  GRAPH05: [graphQueries],
};
