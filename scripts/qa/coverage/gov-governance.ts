import type { CaseDeclarations } from './declaration.ts';

export const governanceCases: CaseDeclarations = {
  GOV03: [{ tier: 'integration', file: 'tests/qa/integration/governance-report.test.ts',
    name: 'GOV02/GOV03: stale target or rule never applies; reversals have one effect and Realm contexts stay independent' }],
  GOV04: [{ tier: 'integration', file: 'tests/qa/integration/rights-offering.test.ts',
    name: 'GOV04: ending one offering does not change another recognition or reopen the ended slot' }],
};
