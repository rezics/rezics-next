import type { CaseDeclarations } from './declaration.ts';

export const pkgNixCases: CaseDeclarations = {
  PKG06: [
    { tier: 'unit', file: 'tests/qa/unit/nix-flake.test.ts',
      name: 'PKG06: pinned native Nix keeps follows, build inputs and observed runtime closure distinct' },
    { tier: 'unit', file: 'tests/qa/unit/nix-flake.test.ts',
      name: 'PKG06: evaluation-only leaves runtime closure explicitly unobserved' },
    { tier: 'unit', file: 'tests/qa/unit/nix-flake.test.ts',
      name: 'PKG06: stale lock and failed build preserve partial graph without inventing a closure' },
    { tier: 'unit', file: 'tests/qa/unit/nix-flake.test.ts',
      name: 'PKG06: cyclic input topology and follows paths stay input edges, within linear budgets' },
    { tier: 'unit', file: 'tests/qa/unit/nix-flake.test.ts',
      name: 'PKG06: original branch, locked revision and exact source hash remain separate' },
    { tier: 'integration', file: 'tests/qa/integration/nix-flake-api.test.ts',
      name: 'PKG06/IAM10: native Nix receipts cross real Account, Access, Main and Content with private replay' },
  ],
};
