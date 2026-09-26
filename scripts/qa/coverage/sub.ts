import type { CaseDeclarations } from './declaration.ts';

const subscriptions = 'tests/qa/integration/subscription-api.test.ts';
const quota = 'tests/qa/integration/quota-reservation-api.test.ts';
const fence = 'SUB01/SUB02/SUB03: a held Access recovery fence changes nothing and the same key then completes once';
const growth = 'SUB01/SUB03: benefit and callback work stays fixed as unrelated commerce history grows';

// SUB05, SUB06 and SUB08 need graph-owned Realm placement; they are not declared here.
export const subCases: CaseDeclarations = {
  SUB01: [
    { tier: 'integration', file: subscriptions,
      name: 'SUB01: a higher gift and a lower purchase stay independent grants and effective benefits' },
    { tier: 'integration', file: subscriptions, name: fence },
    { tier: 'integration', file: subscriptions, name: growth },
  ],
  SUB02: [
    { tier: 'integration', file: subscriptions,
      name: 'SUB02: replaceable and parallel groups keep their semantics and exact quotes bind each change' },
    { tier: 'integration', file: subscriptions, name: fence },
  ],
  SUB03: [
    { tier: 'integration', file: subscriptions,
      name: 'SUB03: duplicate, forged, unknown and lost settlement outcomes never charge or fulfill twice' },
    { tier: 'integration', file: subscriptions, name: fence },
    { tier: 'integration', file: subscriptions, name: growth },
  ],
  SUB04: [
    { tier: 'integration', file: quota,
      name: 'SUB04: concurrent requests for the last capacity admit exactly one reservation' },
    { tier: 'integration', file: quota,
      name: 'SUB04: settlement and compensation apply once, keep consumed usage and release only the remainder' },
    { tier: 'integration', file: quota,
      name: 'SUB04: an expired lease keeps consumed usage, and renewals extend only live leases' },
    { tier: 'integration', file: quota,
      name: 'SUB04: gifted and purchased capacity keep independent ledgers and revocation closes only the gift' },
    { tier: 'integration', file: quota,
      name: 'SUB04: a held recovery fence admits nothing, and reservation work is fixed as unrelated usage grows' },
  ],
  SUB07: [
    { tier: 'integration', file: 'tests/qa/integration/pro-site-query.test.ts',
      name: 'SUB07: a fixed site with sparse Realm candidates never falls back to general content or leaks counts' },
  ],
};
