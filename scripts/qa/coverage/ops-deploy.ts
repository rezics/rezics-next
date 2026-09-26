import type { CaseDeclarations } from './declaration.ts';

/** The two-host local outage drill exercises a fenced, manual promotion. */
export const opsDeployCases: CaseDeclarations = {
  OPS02: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/second-host-format-upgrade.test.ts',
    name: 'OPS02/OPS04: principal crash requires manual second-host restore; failed format switch restores v1',
  }],
};
