import type { CaseDeclarations } from './declaration.ts';

export const recommendationCases: CaseDeclarations = {
  REC03: [{
    tier: 'integration', file: 'tests/qa/integration/recommendation-generation.test.ts',
    name: 'REC03: a failed second generation leaves the first active and served',
  }, {
    tier: 'integration', file: 'tests/qa/integration/recommendation-generation.test.ts',
    name: 'REC03/REC04: template receipts replay, denials and recovery holds leave no effect; rebuild reproduces',
  }],
  REC04: [{
    tier: 'integration', file: 'tests/qa/integration/recommendation-generation.test.ts',
    name: 'REC04: a stale worker cannot overwrite, finish or activate over a newer generation',
  }, {
    tier: 'integration', file: 'tests/qa/integration/recommendation-generation.test.ts',
    name: 'REC04: concurrent first activations serialize the absent head into success and stale receipt',
  }, {
    tier: 'integration', file: 'tests/qa/integration/recommendation-generation.test.ts',
    name: 'REC04: a new source epoch fences an old worker and activation',
  }, {
    tier: 'integration', file: 'tests/qa/integration/recommendation-generation.test.ts',
    name: 'REC03/REC04: template receipts replay, denials and recovery holds leave no effect; rebuild reproduces',
  }],
  REC06: [{
    tier: 'integration', file: 'tests/qa/integration/recommendation-generation.test.ts',
    name: 'REC06: a cursor on an expired generation restarts explicitly; pages never mix orders',
  }, {
    tier: 'integration', file: 'tests/qa/integration/recommendation-generation.test.ts',
    name: 'REC05/REC06: page cost uses the same statements for 10 and 400 ranked candidates',
  }],
};

export const graphLayoutCases: CaseDeclarations = {
  GRAPH06: [{
    tier: 'integration', file: 'tests/qa/integration/graph-layout-api.test.ts',
    name: 'GRAPH06: moving a saved display group revises Content view state without graph effects',
  }, {
    tier: 'integration', file: 'tests/qa/integration/graph-layout-api.test.ts',
    name: 'GRAPH06: saving 1 or 200 positions uses a fixed number of owner statements',
  }],
};
