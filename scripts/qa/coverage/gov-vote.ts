import type { CaseDeclarations } from './declaration.ts';

const template = {
  tier: 'integration',
  file: 'tests/qa/integration/poll-template.test.ts',
  name: 'GOV11/GOV12/GOV13/GOV14/GOV15/GOV16/GOV17/GOV18/GOV21/GOV22: admitted poll, allocation, mandate and ballot template',
} as const;

export const govVoteCases: CaseDeclarations = {
  GOV11: [template],
  GOV12: [template],
  GOV13: [template],
  GOV14: [template, {
    tier: 'unit',
    file: 'services/main/tests/vote-schema-commands.test.ts',
    name: 'GOV14/GOV17: proportional conversion conserves external units with deterministic ties',
  }],
  GOV15: [template],
  GOV16: [template],
  GOV17: [template, {
    tier: 'unit',
    file: 'services/main/tests/vote-schema-commands.test.ts',
    name: 'GOV14/GOV17: proportional conversion conserves external units with deterministic ties',
  }],
};
