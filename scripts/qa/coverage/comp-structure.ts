import type { CaseDeclarations } from './declaration.ts';

export const compStructureCases: CaseDeclarations = {
  BOOK02: [{ tier: 'integration', file: 'tests/qa/integration/structure-composition.test.ts',
    name: 'BOOK02/COMP01/COMP02/COMP05/COMP06: admitted Book composition keeps occurrence identity and exact heads' }],
  BOOK07: [{ tier: 'integration', file: 'tests/qa/integration/structure-refresh.test.ts',
    name: 'BOOK07: exact source import and three-way refresh preserve local edits or report conflict' }],
  COMP01: [{ tier: 'integration', file: 'tests/qa/integration/structure-composition.test.ts',
    name: 'BOOK02/COMP01/COMP02/COMP05/COMP06: admitted Book composition keeps occurrence identity and exact heads' }],
  COMP07: [{ tier: 'fault/recovery', file: 'tests/qa/fault-recovery/partition-relocation.test.ts',
    name: 'MODEL07/MODEL12/SYS08/COMP07: verified move retains Work and Structure history' }],
};
