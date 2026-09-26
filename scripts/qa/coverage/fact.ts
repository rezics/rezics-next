import type { CaseDeclarations } from './declaration.ts';

const ownerJourney = {
  tier: 'integration', file: 'tests/qa/integration/claim-template.test.ts',
  name: 'FACT01/FACT02/FACT03/FACT04/FACT06: claim verification preserves origin, history and correction',
} as const;

export const factCases: CaseDeclarations = {
  FACT01: [ownerJourney, {
    tier: 'unit', file: 'model/tests/claim-analysis.test.ts',
    name: 'FACT01: unknown or circular dependence and over-budget closure never count as corroboration',
  }],
  FACT02: [ownerJourney, {
    tier: 'unit', file: 'model/tests/claim-analysis.test.ts',
    name: 'FACT01/FACT02: copied sites and AI re-ingestion keep one established origin',
  }],
  FACT03: [ownerJourney, {
    tier: 'unit', file: 'model/tests/claim-analysis.test.ts',
    name: 'FACT03: scoped reliability, later edition, withdrawn support and counterevidence stay distinct',
  }],
};
