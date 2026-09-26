import type { CaseDeclarations } from './declaration.ts';

const api = 'tests/qa/integration/package-install-api.test.ts';

export const pkgInstallCases: CaseDeclarations = {
  PKG14: [
    { tier: 'integration', file: api,
      name: 'PKG14: lock replay re-verifies exact artifacts after mutable tag and file changes, or reports them unavailable' },
    { tier: 'integration', file: 'tests/qa/integration/package-lock-go-cargo.test.ts',
      name: 'PKG14: Go signed ZIP and Cargo index archive locks replay exact bytes across mutable files' },
  ],
  PKG15: [
    { tier: 'integration', file: api,
      name: 'PKG15: staging rejects archive traversal, ownership collisions and unapproved hooks before any effect' },
    { tier: 'integration', file: api,
      name: 'PKG15: approved hook runs in the pinned production container through Main API' },
  ],
  PKG16: [
    { tier: 'integration', file: api,
      name: 'PKG16: interrupted activation, update and removal recover from the journal and preserve user data' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/package-install-process-crash.test.ts',
      name: 'PKG16: killed installer processes resume install, update and removal without losing user data' },
  ],
  PKG17: [
    { tier: 'integration', file: api,
      name: 'PKG17: rollback after artifact or authority revocation enforces current policy without resurrection' },
    { tier: 'integration', file: api,
      name: 'PKG17: Account consent withdrawal fences a staged rollback through the real Main API' },
  ],
};
