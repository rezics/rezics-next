import type { CaseDeclarations } from './declaration.ts';

export const governanceCases: CaseDeclarations = {
  GOV04: [{ tier: 'integration', file: 'tests/qa/integration/rights-offering.test.ts',
    name: 'GOV04: ending one offering does not change another recognition or reopen the ended slot' }],
};
