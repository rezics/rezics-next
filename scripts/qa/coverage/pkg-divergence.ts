import type { CaseDeclarations } from './declaration.ts';

const npm = 'tests/qa/unit/npm-registry-resolution.test.ts';
const packages = 'tests/qa/unit/package-divergence.test.ts';
const names = [
  'PKG12: Cargo explains matching scoped selection and feature divergence on one captured index',
  'PKG12: Cargo registry solver explains its pinned native lock and metadata observation',
  'PKG12: Go explains MVS correspondence and replacement-source divergence over captured manifests',
  'PKG12: Go live MVS explains native list and retraction annotations from the same proxy capture',
  'PKG12: Nix keeps locked inputs, derivations and runtime closure as distinct comparison stages',
  'PKG12: mod loader and provider receipts explain each admitted ecosystem without merging vocabularies',
];

/** PKG12 compares the retained native npm/Cargo/Go observations and explains Nix and mod-profile receipt grain. */
export const pkgDivergenceCases: CaseDeclarations = {
  PKG12: [
    { tier: 'unit', file: npm,
      name: 'PKG03/PKG04/PKG12: frozen live snapshots replay offline and keep their native npm correspondence' },
    { tier: 'unit', file: npm,
      name: 'PKG12: a different npm-family layout over the same snapshot is logical correspondence with explained layout' },
    { tier: 'unit', file: npm,
      name: 'PKG12: selection, source, flag, failure-class and stricter-admission divergences are explained' },
    ...names.map(name => ({ tier: 'unit' as const, file: packages, name })),
  ],
};
