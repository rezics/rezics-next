import type { CaseDeclarations } from './declaration.ts';

/** Operational bounds and backpressure (G-070). OPS05 stays partial: the named
 * host capacity profile is retained for G6. */
export const opsBoundsCases: CaseDeclarations = {
  IAM35: [{
    tier: 'integration',
    file: 'tests/qa/integration/backpressure-operational-bounds.test.ts',
    name: 'IAM35: high branching, negative checks, bulk work and a reduced operational limit stay bounded and typed',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/operational-bounds.test.ts',
    name: 'IAM35: Access owners read the persisted profile and the migration seeds the declared one',
  }],
  OPS06: [{
    tier: 'integration',
    file: 'tests/qa/integration/backpressure-api.test.ts',
    name: 'OPS06: worker and broker saturation refuse new intents and lose no admitted work',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/operational-bounds.test.ts',
    name: 'OPS06: saturated object uploads are refused at the Main boundary and none is lost',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/operational-bounds.test.ts',
    name: 'OPS06: in-flight admission never exceeds its budget and accounts every lease',
  }],
};
