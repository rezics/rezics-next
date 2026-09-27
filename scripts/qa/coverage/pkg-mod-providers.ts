import type { CaseDeclarations } from './declaration.ts';

export const pkgModProvidersCases: CaseDeclarations = {
  PKG10: [
    { tier: 'integration', file: 'tests/qa/integration/mod-capture-api.test.ts',
      name: 'PKG07/PKG08/PKG09/PKG10/PKG11/IAM10: real Account, Access, Main and Content protect mod capture receipts' },
    { tier: 'unit', file: 'tests/qa/unit/mod-profiles.test.ts',
      name: 'PKG10: inaccessible Nexus range is recorded as incomplete, never empty' },
    { tier: 'unit', file: 'tests/qa/unit/mod-profiles.test.ts',
      name: 'PKG09/PKG10: unsupported provider clauses do not become empty dependencies' },
    { tier: 'unit', file: 'tests/qa/unit/mod-profiles.test.ts',
      name: 'PKG10/PKG11: provider coverage and Collection work stay bounded by captures and children' },
  ],
};
