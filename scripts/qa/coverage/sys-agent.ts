import type { CaseDeclarations } from './declaration.ts';

export const sysAgentCases: CaseDeclarations = {
  SYS01: [
    { tier: 'integration', file: 'tests/qa/integration/agent-provision.test.ts',
      name: 'SYS01: Account OAuth, Access receipt and Main graph create one public Agent without private mapping' },
    { tier: 'integration', file: 'tests/qa/integration/agent-provision.test.ts',
      name: 'SYS01: a stale Access principal compensates the committed graph Agent and retains receipts' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/agent-provision.test.ts',
      name: 'SYS01: lost graph response and Account pause retain pending state then recover one Agent' },
  ],
};
