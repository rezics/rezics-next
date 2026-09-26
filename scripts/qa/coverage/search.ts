import type { CaseDeclarations } from './declaration.ts';

export const searchCases: CaseDeclarations = {
  SEARCH02: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-search-scale.test.ts',
    name: 'IAM18/SEARCH01/SEARCH02/SEARCH04/SEARCH07/SEARCH08/SEARCH16/SEARCH18: rated Realm join, bounded paging, Access mute and author switch',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/search-budgets.test.ts',
    name: 'SEARCH02/SEARCH10: a 513th raw hit cannot become a false complete empty result',
  }, {
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/search-candidate-overflow.test.ts',
    name: 'SEARCH02/SEARCH10: 513 real text hits with no eligible relation return a budget outcome',
  }],
  SEARCH05: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-search-unsupported.test.ts',
    name: 'SEARCH05: every public phrase lane rejects declared multi-dataset policy before native index access',
  }],
  SEARCH06: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-search-cjk.test.ts',
    name: 'SEARCH06: versioned CJK Main and Realm phrases bind exact selected bodies and languages',
  }],
  SEARCH09: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-search-unsupported.test.ts',
    name: 'SEARCH09: every current-only public phrase lane rejects an as-of source position',
  }],
  SEARCH13: [{
    tier: 'integration',
    file: 'tests/qa/integration/search-graph-sentinel.test.ts',
    name: 'SEARCH13: a retained named graph exposes deletion of its last indexed literal',
  }],
  SEARCH17: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/search-raw-import.test.ts',
    name: 'SEARCH17: quarantined bare-TDB2 import stays unavailable until exact offline rebuild',
  }],
};
