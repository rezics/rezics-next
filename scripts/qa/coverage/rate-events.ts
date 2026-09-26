import type { CaseDeclarations } from './declaration.ts';

export const rateEventCases: CaseDeclarations = {
  RATE07: [{
    tier: 'unit',
    file: 'services/main/tests/event-time.test.ts',
    name: 'RATE07: month precision overlaps a day as possible but has no definite day',
  }, {
    tier: 'unit',
    file: 'services/main/tests/event-time.test.ts',
    name: 'RATE07/RATE08/RATE09: Event query limits bound source, page, aliases and histogram fanout',
  }, {
    tier: 'model',
    file: 'model/tests/event-time.test.ts',
    name: 'RATE07/RATE08: Event time points reuse exact temporal values and keep event identity separate',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/event-time.test.ts',
    name: 'RATE07/RATE08/RATE09: event precision, shared occurrence slots and generation restart cross Main, Access and Jena',
  }],
  RATE08: [{
    tier: 'unit',
    file: 'services/main/tests/event-time.test.ts',
    name: 'RATE07/RATE08/RATE09: Event query limits bound source, page, aliases and histogram fanout',
  }, {
    tier: 'model',
    file: 'model/tests/event-time.test.ts',
    name: 'RATE07/RATE08: Event time points reuse exact temporal values and keep event identity separate',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/event-time.test.ts',
    name: 'RATE07/RATE08/RATE09: event precision, shared occurrence slots and generation restart cross Main, Access and Jena',
  }],
  RATE09: [{
    tier: 'unit',
    file: 'services/main/tests/event-time.test.ts',
    name: 'RATE09: open bounds remain absent and unsupported instant comparison stays explicit',
  }, {
    tier: 'unit',
    file: 'services/main/tests/event-time.test.ts',
    name: 'RATE07/RATE08/RATE09: Event query limits bound source, page, aliases and histogram fanout',
  }, {
    tier: 'model',
    file: 'model/tests/event-time.test.ts',
    name: 'RATE09: event revision records one available instant or a two-ended interval',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/event-time.test.ts',
    name: 'RATE07/RATE08/RATE09: event precision, shared occurrence slots and generation restart cross Main, Access and Jena',
  }, {
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/event-time.test.ts',
    name: 'RATE09: Access recovery hold and a missing event manifest fail closed, then exact repair restores the histogram read',
  }],
};
