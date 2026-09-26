import type { CaseDeclarations } from './declaration.ts';

const file = 'tests/qa/unit/cargo-solver.test.ts';
const unit = (name: string) => ({ tier: 'unit' as const, file, name });

const go = 'tests/qa/unit/go-live-mvs.test.ts';

export const pkgCargoGoCases: CaseDeclarations = {
  PKG05: [
    { tier: 'unit', file: go,
      name: 'PKG05: provider-derived pruned MVS over the live proxy.golang.org capture equals native Go 1.27.1' },
    { tier: 'unit', file: go,
      name: 'PKG05: the go.mod reader keeps live directives and ignores dependency replace/exclude as Go does' },
    { tier: 'unit', file: go,
      name: 'PKG05: retraction comes from the latest go.mod and upgrades skip retracted versions' },
    { tier: 'unit', file: go,
      name: 'PKG05: missing go.mod or version list is incomplete, never an empty requirement set or unretracted' },
    { tier: 'unit', file: 'tests/qa/unit/go-pruned-directives.test.ts',
      name: 'PKG05/PKG12: main remote rules preserve pruned selection and exact source provenance' },
    { tier: 'unit', file: 'tests/qa/unit/go-pruned-directives.test.ts',
      name: 'PKG05/PKG13: missing replacement never falls back and exclusions suppress expansion' },
    { tier: 'integration', file: 'tests/qa/integration/go-sumdb-trust.test.ts',
      name: 'PKG05/PKG14: PostgreSQL Go trust head and private capture proof survive exact read' },
  ],
  PKG01: [
    unit('PKG01: live crates.io resolver 2 feature, target and dev instances equal native Cargo 1.98.1'),
    unit('PKG01: resolver 1 unifies features where resolver 2 separates host, target and platforms, as native Cargo does'),
  ],
  PKG02: [
    unit('PKG02: live semver backtracking, native links backtracking and yanked ranges select the native Cargo lock'),
    unit('PKG02: live compat-bucket, native-links and yanked conflicts are unsatisfiable with witnesses where native Cargo fails'),
    unit('PKG02: Cargo requirement semantics follow the semver crate'),
    { tier: 'unit', file: 'tests/qa/unit/cargo-lock-resolution.test.ts',
      name: 'PKG02/PKG12/PKG13: fresh yanked denial and exact caller lock reuse retain provenance' },
  ],
  PKG13: [
    unit('PKG13: the same live snapshot yields unsatisfiable, incomplete and budget outcomes without a false unsat proof'),
    unit('PKG13: an exponential unsatisfiable search stays budget-exhausted until the budget admits the exhaustive proof'),
    unit('PKG13: unsupported index semantics and malformed roots are neither solved nor unsatisfiable'),
  ],
  PKG19: [
    unit('PKG19: lazy loading reads only reachable index files as the unrelated universe grows'),
    unit('PKG19: long version histories are parsed lazily with constant solver work'),
    unit('PKG19: cancellation stops loading and reports cancelled without a graph'),
    unit('PKG19: file and byte budgets report the exhausted budget truthfully, never unsatisfiable'),
  ],
};
