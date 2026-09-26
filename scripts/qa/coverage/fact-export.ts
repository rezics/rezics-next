import type { CaseDeclarations } from './declaration.ts';

export const factExportCases: CaseDeclarations = {
  FACT05: [{ tier: 'integration', file: 'tests/qa/integration/export-verification.test.ts',
    name: 'FACT05: exact claim and assessment export retains method output while redacting private evidence anchors' }],
  FACT06: [{ tier: 'integration', file: 'tests/qa/integration/claim-template.test.ts',
    name: 'FACT01/FACT02/FACT03/FACT04/FACT06: claim verification preserves origin, history and correction' }],
};
