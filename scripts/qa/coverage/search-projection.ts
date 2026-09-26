import type { CaseDeclarations } from './declaration.ts';

export const searchProjectionCases: CaseDeclarations = {
  SEARCH15: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/content-projection-crash.test.ts',
    name: 'SEARCH15/OPS16: a crash between the TDB2 and Lucene commits suspends search until rebuild',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/search-budgets.test.ts',
    name: 'SEARCH15/SEARCH18: readiness singleflight is position and JVM-bound',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/search-budgets.test.ts',
    name: 'SEARCH15: an intervening aborted text write prevents delta replay',
  }],
  SEARCH19: [{
    tier: 'integration',
    file: 'tests/qa/integration/content-publication-native.test.ts',
    name: 'WORK09/WORK10/SEARCH03/SEARCH19: Content CAS, private drafts and exact public search',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/content-variant-order.test.ts',
    name: 'SEARCH19: same-language variants survive reversed owner settlement, replay and sparse Realms',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/content-eligibility-order.test.ts',
    name: 'SEARCH19: lagging eligibility stays unavailable and a stale worker cannot replace newer text',
  }],
};
