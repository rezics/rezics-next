import type { CaseDeclarations } from './declaration.ts';

export const rightsCases: CaseDeclarations = {
  GOV24: [{ tier: 'integration', file: 'tests/qa/integration/rights-complaint.test.ts',
    name: 'GOV24/GOV25/LIVE18: a source synopsis restriction stays exact through decision replay and refresh' }],
  GOV25: [
    { tier: 'integration', file: 'tests/qa/integration/rights-complaint.test.ts',
      name: 'GOV24/GOV25/LIVE18: a source synopsis restriction stays exact through decision replay and refresh' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/rights-restriction-replay.test.ts',
      name: 'GOV25: replaying an Access backup preserves its restriction fence through counter-notice and decision replay' },
  ],
  LIVE13: [{ tier: 'integration', file: 'tests/qa/integration/rights-use-assessment.test.ts',
    name: 'LIVE13/LIVE14/LIVE15/LIVE16: unknown rights, scoped reassessment, retention limits and export obligations stay exact' }],
  LIVE14: [{ tier: 'integration', file: 'tests/qa/integration/rights-use-assessment.test.ts',
    name: 'LIVE13/LIVE14/LIVE15/LIVE16: unknown rights, scoped reassessment, retention limits and export obligations stay exact' }],
  LIVE15: [{ tier: 'integration', file: 'tests/qa/integration/rights-use-assessment.test.ts',
    name: 'LIVE13/LIVE14/LIVE15/LIVE16: unknown rights, scoped reassessment, retention limits and export obligations stay exact' }],
  LIVE16: [{ tier: 'integration', file: 'tests/qa/integration/rights-use-assessment.test.ts',
    name: 'LIVE13/LIVE14/LIVE15/LIVE16: unknown rights, scoped reassessment, retention limits and export obligations stay exact' }],
};
