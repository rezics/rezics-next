import type { CaseDeclarations } from './declaration.ts';

/**
 * GOV24 and GOV25 already have complete-case owners in gov-rights.ts (G-1868).
 * coverage.ts rejects duplicate case keys, so the manager must merge these
 * identities into that declaration after the sibling claim is complete.
 */
export const importedCoverLifecycleCoverage: CaseDeclarations = {
  GOV24: [{ tier: 'integration', file: 'tests/qa/integration/imported-cover-lifecycle.test.ts',
    name: 'GOV24/GOV25: frozen imported covers keep exact credit and lifecycle fences through notice, re-import, restore and erasure' }],
  GOV25: [{ tier: 'integration', file: 'tests/qa/integration/imported-cover-lifecycle.test.ts',
    name: 'GOV24/GOV25: frozen imported covers keep exact credit and lifecycle fences through notice, re-import, restore and erasure' }],
};
