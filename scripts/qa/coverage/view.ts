import type { CaseDeclarations } from './declaration.ts';

export const viewCases: CaseDeclarations = {
  VIEW01: [{
    tier: 'integration',
    file: 'tests/qa/integration/work-address-api.test.ts',
    name: 'VIEW01/VIEW02: Work address claims, renames and dispositions preserve exact identities',
  }],
  VIEW02: [{
    tier: 'integration',
    file: 'tests/qa/integration/work-address-api.test.ts',
    name: 'VIEW01/VIEW02: Work address claims, renames and dispositions preserve exact identities',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/work-address-chain.test.ts',
    name: 'VIEW02: bounded redirect traversal preserves a valid last hop',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/work-address-chain.test.ts',
    name: 'VIEW02: a valid chain past the bound is unavailable, not missing',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/work-address-chain.test.ts',
    name: 'VIEW02: a cycle or missing redirect target is unavailable',
  }],
};
