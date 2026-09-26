import type { CaseDeclarations } from './declaration.ts';

export const recipeCases: CaseDeclarations = {
  RECIPE01: [{ tier: 'integration', file: 'tests/qa/integration/recipe-structure.test.ts',
    name: 'RECIPE01/RECIPE02/RECIPE03: recipe Structure retains duplicate lines, scales exactly and imports source' }],
  RECIPE02: [
    { tier: 'integration', file: 'tests/qa/integration/recipe-structure.test.ts',
      name: 'RECIPE01/RECIPE02/RECIPE03: recipe Structure retains duplicate lines, scales exactly and imports source' },
    { tier: 'unit', file: 'tests/qa/unit/recipe-operations.test.ts',
      name: 'RECIPE02: exact fraction scaling retains ambiguous unit text and source lexical' },
    { tier: 'unit', file: 'tests/qa/unit/recipe-operations.test.ts',
      name: 'RECIPE02: non-linear and unparsed quantities keep their lexical text without conversion' },
  ],
};
