import type { CaseDeclarations } from './declaration.ts';

export const workInstallCases: CaseDeclarations = {
  WORK07: [{ tier: 'integration', file: 'tests/qa/integration/package-install-request.test.ts',
    name: 'WORK07: Main Version recommendations resolve eligible npm and Cargo artifacts, and refuse an ineligible release without a lock' }],
};
