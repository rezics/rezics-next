import type { CaseDeclarations } from './declaration.ts';

export const sysErasureReplayCases: CaseDeclarations = {
  SYS07: [{ tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/sys-erasure-replay.test.ts',
    name: 'SYS07: older Account, Access, Content, graph and object copies replay without resurrection' }],
};
