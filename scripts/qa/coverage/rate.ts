import type { CaseDeclarations } from './declaration.ts';

export const rateCases: CaseDeclarations = {
  RATE01: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/rating-daily.test.ts',
    name: 'RATE01/RATE02/RATE03/RATE05/OPS03: Rating identities and policy survive real API races and graph loss',
  }, {
    tier: 'unit',
    file: 'services/main/tests/rating-aggregate.test.ts',
    name: 'RATE01: separately labeled exact reductions preserve rater and observation denominators',
  }, {
    tier: 'unit',
    file: 'services/main/tests/rating-aggregate.test.ts',
    name: 'RATE01/RATE04: latest selection includes tombstones and deterministic evaluation ties',
  }, {
    tier: 'unit',
    file: 'services/main/tests/rating-aggregate.test.ts',
    name: 'RATE01: rational distributions retain noninteger rater means and empty populations',
  }],
  RATE02: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/rating-daily.test.ts',
    name: 'RATE01/RATE02/RATE03/RATE05/OPS03: Rating identities and policy survive real API races and graph loss',
  }, {
    tier: 'model',
    file: 'model/tests/experience-rating.test.ts',
    name: 'RATE02/MODEL17: experience shapes bind occasion predecessor and immutable evaluation times',
  }, {
    tier: 'unit',
    file: 'services/main/tests/rating-experience.test.ts',
    name: 'RATE02: intentional occasions and request identity are independent of private ownership',
  }],
  RATE03: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/rating-daily.test.ts',
    name: 'RATE01/RATE02/RATE03/RATE05/OPS03: Rating identities and policy survive real API races and graph loss',
  }, {
    tier: 'model',
    file: 'model/tests/daily-rating.test.ts',
    name: 'RATE03/MODEL17: daily shapes and native bindings reject missing or mismatched calendar fields',
  }, {
    tier: 'unit',
    file: 'services/main/tests/rating-calendar.test.ts',
    name: 'RATE03: server civil periods resolve DST, repeated hours and skipped midnight',
  }, {
    tier: 'unit',
    file: 'services/main/tests/rating-calendar.test.ts',
    name: 'RATE03: daily slots count the private principal and civil day independently of personas',
  }],
  RATE04: [{
    tier: 'integration',
    file: 'tests/qa/integration/rating-withdrawal.test.ts',
    name: 'RATE04: a withdrawn latest opinion keeps earlier immutable revisions without resurrecting their values',
  }],
  RATE05: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/rating-daily.test.ts',
    name: 'RATE01/RATE02/RATE03/RATE05/OPS03: Rating identities and policy survive real API races and graph loss',
  }, {
    tier: 'model',
    file: 'model/tests/experience-rating.test.ts',
    name: 'RATE05/MODEL17: native policy successor keeps the question head and rejects malformed revisions',
  }],
};
