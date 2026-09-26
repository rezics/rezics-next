import type { CaseDeclarations } from './declaration.ts';

export const govReportCases: CaseDeclarations = {
  GOV01: [
    { tier: 'integration', file: 'tests/qa/integration/governance-report.test.ts',
      name: 'GOV01: reports anchor exact name, body, Structure and media use with empty and unavailable states' },
  ],
};
