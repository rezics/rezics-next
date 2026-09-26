import type { CaseDeclarations } from './declaration.ts';

export const factInvalidationCases: CaseDeclarations = {
  FACT04: [
    { tier: 'integration', file: 'tests/qa/integration/claim-template.test.ts',
      name: 'FACT01/FACT02/FACT03/FACT04/FACT06: claim verification preserves origin, history and correction' },
    { tier: 'integration', file: 'tests/qa/integration/verification-invalidation.test.ts',
      name: 'FACT04: a popular source invalidation pages, resumes and records one effect per target' },
  ],
};
