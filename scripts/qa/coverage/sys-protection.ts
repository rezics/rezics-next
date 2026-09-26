import type { CaseDeclarations } from './declaration.ts';

const workApi = { tier: 'integration', file: 'tests/qa/integration/protection-work-api.test.ts',
  name: 'SYS02/SYS03/SYS10/SYS11/SYS14: protected Work correction uses one reviewed owner commit' } as const;
const receipts = { tier: 'integration', file: 'tests/qa/integration/protection-receipts.test.ts',
  name: 'SYS02/SYS03/SYS10/SYS11/SYS14: Jena title receipts decide outcomes, not transport, sequence or zero-match updates' } as const;
const contentApi = { tier: 'integration', file: 'tests/qa/integration/protection-content-api.test.ts',
  name: 'SYS02/SYS11/SYS14: admitted Content protection and review through Account, Access and the Content owner' } as const;

export const sysProtectionCases: CaseDeclarations = {
  SYS03: [workApi, receipts],
  SYS10: [workApi, receipts],
  SYS11: [workApi, receipts, contentApi],
  SYS14: [workApi, receipts, contentApi],
};
