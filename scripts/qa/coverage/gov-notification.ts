import type { CaseDeclarations } from './declaration.ts';

export const notificationCases: CaseDeclarations = {
  GOV05: [{ tier: 'integration', file: 'tests/qa/integration/notification-delivery.test.ts',
    name: 'GOV05: unsubscribe, subject access loss, deactivation and rotation are applied at delivery time' }],
  GOV06: [
    { tier: 'integration', file: 'tests/qa/integration/notification-delivery.test.ts',
      name: 'GOV06: lost acknowledgements reconcile by stable delivery id and repeated callbacks have one effect' },
    { tier: 'integration', file: 'tests/qa/integration/notification-delivery.test.ts',
      name: 'GOV06: the configured HTTP provider sends with a stable idempotency key and reconciles lookup' },
  ],
  GOV07: [{ tier: 'fault/recovery', file: 'tests/qa/fault-recovery/notification-erasure.test.ts',
    name: 'GOV07/OPS11: erased subjects and recipients stay erased across history pins and a restored Access backup' }],
  GOV08: [{ tier: 'integration', file: 'tests/qa/integration/notification-delivery.test.ts',
    name: 'GOV08: monotonic read watermarks and a real realtime reconnect reconcile every stream gap' }],
};
