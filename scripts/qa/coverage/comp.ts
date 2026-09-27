import type { CaseDeclarations } from './declaration.ts';

const bookJourney = {
  tier: 'integration',
  file: 'tests/qa/integration/structure-book-content.test.ts',
  name: 'BOOK01/BOOK03/BOOK08: native Book follows published Post while a fixed release retains its revision',
} as const;

const structureJourney = {
  tier: 'integration',
  file: 'tests/qa/integration/structure-composition.test.ts',
  name: 'BOOK02/COMP01/COMP02/COMP05/COMP06: admitted Book composition keeps occurrence identity and exact heads',
} as const;

const stageJourney = {
  tier: 'integration',
  file: 'tests/qa/integration/structure-stage.test.ts',
  name: 'COMP03/COMP04: staged pages checkpoint under a lease and activation rechecks target authority',
} as const;

export const compCases: CaseDeclarations = {
  COMP02: [structureJourney],
  COMP03: [stageJourney],
  COMP04: [stageJourney],
  COMP05: [structureJourney],
  COMP06: [structureJourney],
  BOOK01: [bookJourney],
  BOOK03: [bookJourney],
  BOOK08: [bookJourney],
};
