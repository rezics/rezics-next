import type { CaseDeclarations } from './declaration.ts';

export const pkgGoRefreshCases: CaseDeclarations = {
  PKG20: [
    { tier: 'integration', file: 'tests/qa/integration/source-run-authenticated.test.ts',
      name: 'PKG20: real Account scopes and Access admission fence Go source runs' },
    { tier: 'integration', file: 'tests/qa/integration/go-refresh.test.ts',
      name: 'PKG20: the next Go source run admits new proxy versions with the same main-module intent' },
    { tier: 'integration', file: 'tests/qa/integration/go-refresh.test.ts',
      name: 'PKG20: proxy misses stay explicit and a later run recovers from refreshed source data' },
    { tier: 'integration', file: 'tests/qa/integration/go-refresh.test.ts',
      name: 'PKG20: failed proxy acquisition is recorded incomplete and a fresh run can recover' },
    { tier: 'integration', file: 'tests/qa/integration/go-refresh.test.ts',
      name: 'PKG20: oversized proxy responses fail before they enter a source run capture' },
  ],
};
