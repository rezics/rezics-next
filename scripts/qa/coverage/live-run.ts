import type { CaseDeclarations } from './declaration.ts';

export const liveRunCases: CaseDeclarations = {
  LIVE02: [{
    tier: 'integration',
    file: 'tests/qa/integration/source-run-acquisition.test.ts',
    name: 'LIVE02: partial, malformed and failed surfaces leave no completed receipt and no omission-driven withdrawal',
  }],
};
