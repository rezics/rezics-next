import type { CaseDeclarations } from './declaration.ts';

const bookJourney = {
  tier: 'integration',
  file: 'tests/qa/integration/structure-book-content.test.ts',
  name: 'BOOK01/BOOK03/BOOK06/BOOK08: native Book follows published Post while a fixed release retains its revision',
} as const;

export const compCases: CaseDeclarations = {
  COMP04: [{
    tier: 'integration',
    file: 'tests/qa/integration/structure-stage.test.ts',
    name: 'COMP03/COMP04: staged pages checkpoint under a lease and activation rechecks target authority',
  }],
  BOOK01: [bookJourney],
  BOOK03: [bookJourney],
  BOOK08: [bookJourney],
};
