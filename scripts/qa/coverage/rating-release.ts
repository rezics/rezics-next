import type { CaseDeclarations } from './declaration.ts';

export const releaseRatingCases: CaseDeclarations = {
  WORK06: [{
    tier: 'integration',
    file: 'tests/qa/integration/rating-release-target.test.ts',
    name: 'WORK06: exact fixed releases and Main Version keep separate Access-backed rating populations',
  }, {
    tier: 'unit',
    file: 'model/tests/release-rating.test.ts',
    name: 'WORK06: release Context and observation definitions bind the exact release grain',
  }, {
    tier: 'unit',
    file: 'model/tests/release-rating.test.ts',
    name: 'WORK06: one principal and Context have distinct opaque slots for sibling releases',
  }],
};
