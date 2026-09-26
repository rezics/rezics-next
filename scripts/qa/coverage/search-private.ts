import type { CaseDeclarations } from './declaration.ts';

export const privateSearchCases: CaseDeclarations = {
  SEARCH12: [
    {
      tier: 'integration',
      file: 'tests/qa/integration/private-search-native.test.ts',
      name: 'SEARCH11/SEARCH12: native private field, exact source and durable read receipt',
    },
    {
      tier: 'integration',
      file: 'tests/qa/integration/private-search-native.test.ts',
      name: 'SEARCH12: a closure on another replica after the arm stays pending until the offer settles',
    },
    {
      tier: 'integration',
      file: 'tests/qa/integration/private-search-native.test.ts',
      name: 'SEARCH12: rows abandoned by a lost replica are swept after the send window, releasing closure and recovery',
    },
    {
      tier: 'integration',
      file: 'tests/qa/integration/private-search-native.test.ts',
      name: 'SEARCH12: migration 160 keeps historical outcomes and in-flight arms across the upgrade',
    },
  ],
};
