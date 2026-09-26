import type { CaseDeclarations } from './declaration.ts';

const unit = 'tests/qa/unit/npm-registry-resolution.test.ts';
const frozenLive = { tier: 'unit', file: unit,
  name: 'PKG03/PKG04/PKG12: frozen live snapshots replay offline and keep their native npm correspondence' };
const api = { tier: 'integration', file: 'tests/qa/integration/npm-registry-api.test.ts',
  name: 'PKG03/PKG04/PKG12/IAM10: npm registry range receipts are captured once, private, replayable and revalidated' };

/** npm-family registry solving (G-074). PKG12 stays open until Cargo, Go, Nix and mod profiles explain divergence. */
export const pkgNpmCases: CaseDeclarations = {
  PKG03: [frozenLive, api, ...[
    'PKG03: node-semver ranges, prerelease tuples and npm manifest ordering',
    'PKG03: nested incompatible ranges keep distinct scoped instances and lazily fetch only reached packages',
    'PKG03: strict peer sets use the nearest host scope or fail instead of collapsing names',
    'PKG03/PKG13: unavailable, malformed, unsatisfiable, unsupported and budget outcomes stay distinct',
    'PKG03: selected tarballs are fetched from the fixed origin and checked against registry SRI',
    'PKG03/PKG19: provider requests and solver work grow with reached packages, not unrelated versions or names',
  ].map(name => ({ tier: 'unit', file: unit, name }))],
  PKG04: [frozenLive, api, { tier: 'unit', file: unit,
    name: 'PKG04: optional platform regions, aliases, workspaces, overrides and strategies keep native semantics' }],
};
