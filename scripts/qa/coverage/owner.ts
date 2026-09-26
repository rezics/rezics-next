import type { CaseDeclarations } from './declaration.ts';

export const ownerCases: CaseDeclarations = {
  MODEL25: [{ tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/tdb2-compact-history.test.ts',
    name: 'MODEL25: offline TDB2 compaction preserves exact old Work revision and identity' }],
};
