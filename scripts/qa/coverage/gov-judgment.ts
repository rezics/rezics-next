import type { CaseDeclarations } from './declaration.ts';

const realApi = {
  tier: 'integration',
  file: 'tests/qa/integration/judgment-api.test.ts',
  name: 'GOV09/GOV10: real judgment API preserves dimensions, invalidates badges and applies declared hints',
} as const;
const upgrade = {
  tier: 'integration', file: 'tests/qa/integration/judgment-schema.test.ts',
  name: 'GOV09/GOV10: Access 230 to 231 upgrade baselines an existing judgment aggregate',
} as const;

export const govJudgmentCases: CaseDeclarations = {
  GOV09: [realApi, upgrade, {
    tier: 'unit', file: 'tests/qa/unit/judgment-policy.test.ts',
    name: 'GOV09: fit and spoiler population sizes remain independent',
  }],
  GOV10: [realApi, upgrade, {
    tier: 'unit', file: 'tests/qa/unit/judgment-policy.test.ts',
    name: 'GOV10: Wilson generation keeps one major vote protected with low confidence',
  }, {
    tier: 'unit', file: 'tests/qa/unit/judgment-policy.test.ts',
    name: 'GOV10: no evidence uses the declared hint, while status remains unknown',
  }, {
    tier: 'unit', file: 'tests/qa/unit/judgment-policy.test.ts',
    name: 'GOV10: mixed unresolved votes are disputed; strong evidence has separate status',
  }],
};
