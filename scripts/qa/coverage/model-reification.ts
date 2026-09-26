import type { CaseDeclarations } from './declaration.ts';

export const sourceReificationCases: CaseDeclarations = {
  MODEL09: [{
    tier: 'integration',
    file: 'tests/qa/integration/source-reification.test.ts',
    name: 'MODEL09: source field Statements retain exact observation provenance without native acceptance',
  }, {
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/source-projection-recovery.test.ts',
    name: 'MODEL09/OPS03/LIVE01/LIVE02/LIVE03/LIVE05/LIVE13: source Statements survive held graph restore',
  }, {
    tier: 'model',
    file: 'model/tests/source-reification.test.ts',
    name: 'MODEL09: reified source claims use stable IDs, exact provenance and no native acceptance predicates',
  }, {
    tier: 'model',
    file: 'model/tests/source-reification.test.ts',
    name: 'MODEL09: missing source description produces only the observed title Statement',
  }],
};
