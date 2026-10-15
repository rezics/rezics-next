import type { CaseDeclarations } from './declaration.ts';

export const searchProjectionCases: CaseDeclarations = {
  SEARCH15: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/content-projection-crash.test.ts',
    name: 'SEARCH15/OPS16: a lost Lucene commit serves exact Content only after recovery',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/search-budgets.test.ts',
    name: 'SEARCH15/SEARCH18: each readiness proof is position and JVM-bound without a corpus scan',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/search-budgets.test.ts',
    name: 'SEARCH15: an aborted text write invalidates native qualification until repaired',
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
    name: 'SEARCH19/SEARCH20/OPS16: closed eligibility and verified rebuild adoption preserve exact source authority',
  }, {
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/content-private-projection-rebuild.test.ts',
    name: 'SEARCH19/SEARCH20/OPS16: private publication, later approval and frozen rebuild recover together',
  }],
};
