import type { CaseDeclarations } from './declaration.ts';

export const viewCases: CaseDeclarations = {
  VIEW01: [{
    tier: 'integration',
    file: 'tests/qa/integration/work-address-api.test.ts',
    name: 'VIEW01/VIEW02: Work address claims, renames and dispositions preserve exact identities',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/work-address-slug.test.ts',
    name: 'VIEW01: claims normalize ASCII case and share one digest per normalized slug',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/work-address-slug.test.ts',
    name: 'VIEW01: a UUID-shaped slug is never assigned, since /w/{uuid} always names a Work ID',
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
