import type { CaseDeclarations } from './declaration.ts';

export const modelCases: CaseDeclarations = {
  MODEL02: [{
    tier: 'integration',
    file: 'tests/qa/integration/work-scalar-value.test.ts',
    name: 'MODEL02: real Account/Access/Main/Jena scalar write, exact read, denial and stale guard',
  }, {
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/work-scalar-recovery.test.ts',
    name: 'MODEL02/OPS03: held graph restore replays exact scalar and title Work revisions',
  }, {
    tier: 'model',
    file: 'model/tests/native-equivalence.test.ts',
    name: 'MODEL02: Work scalar native fixture preserves recorded outcomes and digest',
  }],
};
