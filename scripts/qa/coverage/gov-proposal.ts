import type { CaseDeclarations } from './declaration.ts';

export const govProposalCases: CaseDeclarations = {
  GOV02: [
    { tier: 'integration', file: 'tests/qa/integration/governance-report.test.ts',
      name: 'GOV02: a published rule has an exact scoped head, immutable revisions and an API CAS receipt' },
    { tier: 'integration', file: 'tests/qa/integration/governance-report.test.ts',
      name: 'GOV02/GOV03: stale target or rule never applies; reversals have one effect and Realm contexts stay independent' },
    { tier: 'integration', file: 'tests/qa/integration/governance-report.test.ts',
      name: 'GOV02: a Content head changing after preflight makes the decision stale' },
    { tier: 'integration', file: 'tests/qa/integration/governance-report.test.ts',
      name: 'GOV02: partial Content acceptance preserves its receipt and fence after stale graph CAS' },
  ],
  GOV23: [
    { tier: 'integration', file: 'tests/qa/integration/poll-template.test.ts',
      name: 'GOV11/GOV12/GOV13/GOV14/GOV15/GOV16/GOV17/GOV18/GOV19/GOV20/GOV21/GOV22/GOV23: admitted poll, allocation, proxy, mandate and ballot template' },
    { tier: 'integration', file: 'tests/qa/integration/proposal-execution.test.ts',
      name: 'GOV23: adopted proposal executes one scoped roster effect and recovers the same operation ID' },
  ],
};
