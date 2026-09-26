import type { CaseDeclarations } from './declaration.ts';

export const sysRevocationCases: CaseDeclarations = {
  SYS06: [
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/sys-revocation.test.ts',
      name: 'SYS06: revocation during source acquisition withholds delivery and replays the frozen result' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/sys-revocation.test.ts',
      name: 'SYS06: export delivery revoked during source revalidation returns no private manifest' },
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/sys-revocation.test.ts',
      name: 'SYS06: package installation revoked during hook work stays staged until authority returns' },
  ],
};
