import type { CaseDeclarations } from './declaration.ts';

export const sysRestoreCases: CaseDeclarations = {
  SYS13: [
    { tier: 'fault/recovery', file: 'tests/qa/fault-recovery/protection-restore.test.ts',
      name: 'SYS13: stopped graph cut retains old intent and delivery until protected correction reconciles' },
  ],
};
