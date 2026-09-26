import type { CaseDeclarations } from './declaration.ts';

export const ownerCases: CaseDeclarations = {
  MODEL11: [{ tier: 'integration',
    file: 'tests/qa/integration/owner-operations.test.ts',
    name: 'MODEL11/MODEL26: restarted resolver retains old anchors and typed object recovery' }],
  MODEL25: [{ tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/tdb2-compact-history.test.ts',
    name: 'MODEL25: offline TDB2 compaction preserves exact old Work revision and identity' }],
  MODEL26: [{ tier: 'integration',
    file: 'tests/qa/integration/owner-operations.test.ts',
    name: 'MODEL11/MODEL26: restarted resolver retains old anchors and typed object recovery' }],
  SYS04: [{ tier: 'integration',
    file: 'tests/qa/integration/owner-outbox-recovery.test.ts',
    name: 'SYS04/SYS12: replay after delivery crash has one effect; empty and missing batches keep coverage honest' }],
  SYS12: [{ tier: 'integration',
    file: 'tests/qa/integration/owner-outbox-recovery.test.ts',
    name: 'SYS04/SYS12: replay after delivery crash has one effect; empty and missing batches keep coverage honest' },
  { tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/coordinated-owner-cut.test.ts',
    name: 'OPS03/PKG14/SYS12: signed owner cut restores Content and exact Go checksum proof' }],
};
