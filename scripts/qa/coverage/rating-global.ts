import type { CaseDeclarations } from './declaration.ts';

export const ratingGlobalCases: CaseDeclarations = {
  RATE06: [{
    tier: 'integration',
    file: 'tests/qa/integration/rating-global-synthesis.test.ts',
    name: 'RATE06: Realm and Global scores keep distinct populations and scales under an explicit synthesis policy',
  }, {
    tier: 'unit',
    file: 'services/main/tests/rating-global.test.ts',
    name: 'RATE06: synthesis keeps Realm and Global components separate and returns 17/24, never the pooled 5.2',
  }, {
    tier: 'unit',
    file: 'services/main/tests/rating-global.test.ts',
    name: 'RATE06: stale, unsealed, damaged or fenced evidence makes the synthesis unavailable, never smaller',
  }],
};
