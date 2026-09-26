import type { CaseDeclarations } from './declaration.ts';

export const workDerivationCases: CaseDeclarations = {
  WORK04: [{
    tier: 'integration',
    file: 'tests/qa/integration/work-derivation.test.ts',
    name: 'WORK04: admitted exact Work derivations retain kind, source and target revisions',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/work-derivation.test.ts',
    name: 'WORK04: multi-source and corrected continuity stay exact per retained revision',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/work-derivation.test.ts',
    name: 'WORK04: an unresolved source version stays distinct and resolves later without rewriting history',
  }, {
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/work-derivation-recovery.test.ts',
    name: 'WORK04/OPS03: graph loss replays only the original admitted multi-source, corrected and unresolved Work derivations',
  }],
};
