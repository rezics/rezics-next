import type { CaseDeclarations } from './declaration.ts';

/** The two-host local outage drill exercises a fenced, manual promotion. */
export const opsDeployCases: CaseDeclarations = {
  OPS01: [{
    tier: 'integration',
    file: 'tests/qa/integration/fresh-install.test.ts',
    name: 'OPS01: pinned release provisions four owners and re-provisions without changing their data',
  }],
  OPS02: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/second-host-format-upgrade.test.ts',
    name: 'OPS02/OPS04: principal crash requires manual second-host restore; failed bytea format switch restores v1',
  }],
  OPS04: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/second-host-format-upgrade.test.ts',
    name: 'OPS02/OPS04: principal crash requires manual second-host restore; failed bytea format switch restores v1',
  }],
};
