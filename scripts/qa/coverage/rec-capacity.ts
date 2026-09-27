import type { CaseDeclarations } from './declaration.ts';

export const recCapacityCases: CaseDeclarations = {
  REC02: [{
    tier: 'integration',
    file: 'tests/qa/integration/recommendation-generation.test.ts',
    name: 'REC02: production runner advances a registered generation in bounded ticks',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/recommendation-generation.test.ts',
    name: 'REC02: a hot target folds into bounded coalesced batches without a global counter',
  }, {
    tier: 'load',
    file: 'tests/qa/load/recommendation-skew.test.ts',
    name: 'REC02: hot target and sparse ranking keep bounded batch and page costs',
  }],
};
