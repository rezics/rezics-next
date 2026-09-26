import type { CaseDeclarations } from './declaration.ts';

const template = {
  tier: 'integration',
  file: 'tests/qa/integration/poll-template.test.ts',
  name: 'GOV11/GOV12/GOV13/GOV14/GOV15/GOV16/GOV17/GOV18/GOV19/GOV20/GOV21/GOV22/GOV23: admitted poll, allocation, proxy, mandate and ballot template',
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
  GOV18: [template],
  GOV19: [template],
  GOV20: [template],
  GOV21: [template],
  GOV22: [template],
};
