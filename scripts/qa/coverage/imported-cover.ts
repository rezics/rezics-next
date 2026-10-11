import type { CaseDeclarations } from './declaration.ts';

/**
 * The GOV24 and GOV25 declarations for this case merge into gov-rights.ts once
 * its current owner releases that file. Keeping them here avoids conflicting
 * edits while that ownership is still active.
 */
export const importedCoverLifecycleCoverage: CaseDeclarations = {
  GOV24: [{ tier: 'integration', file: 'tests/qa/integration/imported-cover-lifecycle.test.ts',
    name: 'GOV24/GOV25: frozen imported covers keep exact credit and lifecycle fences through notice, re-import, restore and erasure' }],
  GOV25: [{ tier: 'integration', file: 'tests/qa/integration/imported-cover-lifecycle.test.ts',
    name: 'GOV24/GOV25: frozen imported covers keep exact credit and lifecycle fences through notice, re-import, restore and erasure' }],
};
