import type { CaseDeclarations } from './declaration.ts';

export const workGrainCases: CaseDeclarations = {
  WORK08: [{ tier: 'integration', file: 'tests/qa/integration/source-grain.test.ts',
    name: 'WORK08: live Work and Edition plus an authored equal-ID collision stay at separate grains without a parent' }],
};
