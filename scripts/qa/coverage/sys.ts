import type { CaseDeclarations } from './declaration.ts';

export const sysCases: CaseDeclarations = {
  SYS02: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/lost-response.test.ts',
    name: 'SYS02: a real lost Fuseki response resolves to one Main Work receipt and outbox batch',
  }],
};
