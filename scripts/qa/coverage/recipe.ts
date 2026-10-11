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
  RECIPE03: [
    { tier: 'integration', file: 'tests/qa/integration/recipe-structure.test.ts',
      name: 'RECIPE01/RECIPE02/RECIPE03: recipe Structure retains duplicate lines, scales exactly and imports source' },
    { tier: 'unit', file: 'tests/qa/unit/recipe-importer.test.ts',
      name: 'RECIPE03: duplicate ingredient occurrences and grouped multilingual instructions retain order' },
    { tier: 'unit', file: 'tests/qa/unit/recipe-importer.test.ts',
      name: 'RECIPE03: structured PropertyValue quantities retain exact values and unresolved unit codes' },
    { tier: 'unit', file: 'tests/qa/unit/recipe-export.test.ts',
      name: 'RECIPE03: exact Schema.org export preserves grouped step order and unparsed source residuals' },
    { tier: 'unit', file: 'tests/qa/unit/recipe-export.test.ts',
      name: 'RECIPE03: export rejects work beyond its declared occurrence bound' },
  ],
  RECIPE04: [{ tier: 'integration', file: 'tests/qa/integration/recipe-realm-variants.test.ts',
    name: 'RECIPE04: two Realms independently adopt published Recipe variants of one Main Version' }],
  RECIPE05: [{ tier: 'integration', file: 'tests/qa/integration/recipe-measures.test.ts',
    name: 'RECIPE05: receipt-backed nutrition and yield retain coverage, basis and exact revisions' }],
  RECIPE06: [
    { tier: 'integration', file: 'tests/qa/integration/recipe-withdrawal.test.ts',
      name: 'RECIPE06: confirmed source withdrawal leaves independent support on imported Recipe occurrence' },
    { tier: 'unit', file: 'tests/qa/unit/recipe-importer.test.ts',
      name: 'RECIPE06: only exact retained source text becomes a Recipe child support candidate' },
  ],
};
