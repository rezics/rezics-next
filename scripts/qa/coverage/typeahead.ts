import type { CaseDeclarations } from './declaration.ts';

// The capacity owner registers this evidence alongside the existing SEARCH18 tests.
export const typeaheadGrowthTests = {
  SEARCH18: [{ tier: 'integration', file: 'tests/qa/integration/typeahead-growth.test.ts',
    name: 'SEARCH18: public typeahead native work follows population before prefix cutover and the page after it' }],
} satisfies CaseDeclarations;
