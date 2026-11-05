import type { BuyerOrder } from '../../src/checkout/orders';
import paid from '../../src/kernel/recorded/order-paid.json';

// Synthetic consumer fixtures: recorded identity plus deterministic current list fields.
// These inputs do not establish native recorded financial evidence.
export const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
export function order(viewer: string, n = viewer === 'A' ? 1 : 2): BuyerOrder {
  return {
    ...paid.order,
    id: id(n),
    entitlementId: id(n + 1000),
    title: `Captured purchase ${viewer}`,
    settlement: 'paid',
    offerRevision: 1,
    currency: 'usd',
    unitAmountMinor: viewer === 'A' ? 123456 : 78901,
    moneyUnit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' },
    taxBehavior: 'exclusive',
    taxCode: 'txcd_10302000',
    amountTaxMinor: null,
    contentEdition: null,
  };
}
