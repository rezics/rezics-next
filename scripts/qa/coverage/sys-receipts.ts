import type { CaseDeclarations } from './declaration.ts';

export const sysReceiptsCases: CaseDeclarations = {
  SYS09: [{ tier: 'fault-recovery', file: 'tests/qa/fault-recovery/sys-work-object-orphan.test.ts',
    name: 'SYS09: rejected Work graph activation removes only its staged RustFS objects' }],
};
