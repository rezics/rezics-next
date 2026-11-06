import { expect, test } from 'bun:test';
import { withoutUnverifiedBenefit } from '../../src/commerce/benefit.ts';
import type { CheckoutDecision } from '../../src/commerce/model.ts';

const source = (path: string) => Bun.file(new URL(`../../src/${path}`, import.meta.url)).text();

// Source-composition guard only. Real native Auth/Access/DBOS execution remains an integration gate.
test('Default paid fulfilment uses real mounted worker Access and native current consent for Content seller authority without empty action maps or buyer impersonation', async () => {
  const [work, module, benefit, sale, buyerFact] = await Promise.all([
    source('commerce/work.ts'),
    source('commerce/work-module.ts'),
    source('commerce/benefit.ts'),
    source('content/edition-sale-native.ts'),
    source('commerce/content-edition-buyer-fact.ts'),
  ]);
  expect(work).toContain('access: authorizedContext.getAuthorization().access');
  expect(work).not.toContain('createAccess');
  expect(work).not.toContain('new Map(');
  expect(module).toContain('}).register(context)');
  expect(module).not.toContain('createAccess');
  expect(benefit).toContain('readContentEditionMechanicalSaleAuthority(dependencies, editionId, context)');
  expect(sale).toContain('const readConsent = deps.readConsent;');
  expect(sale).not.toContain('process.env');
  expect(sale).toContain('readConsent,');
  expect(sale).toContain("action: 'edition:sell'");
  expect(sale).toContain("action: 'post:revise'");
  for (const text of [work, benefit, sale]) {
    expect(text).not.toMatch(/\bbuyerActor\b|\bdeliveryActor\b/);
  }
  expect(buyerFact).not.toMatch(/from ['"][^'"]*content\//);
  expect(buyerFact).not.toContain('readContentEdition');
});

test('unavailable sale authority suppresses only a new grant or restore and retains the financial decision', () => {
  for (const kind of ['grant', 'restore'] as const) {
    const decision: CheckoutDecision = {
      changed: true,
      settlement: 'paid',
      paymentIntentId: null,
      observedAt: '2026-10-31T00:00:00Z',
      newTransactions: [],
      entitlement: { kind },
    };
    expect(withoutUnverifiedBenefit(decision)).toEqual({ ...decision, entitlement: { kind: 'none' } });
    expect(decision.entitlement.kind).toBe(kind);
  }
  const refund: CheckoutDecision = {
    changed: true,
    settlement: 'paid',
    paymentIntentId: null,
    observedAt: '2026-10-31T00:00:00Z',
    newTransactions: [],
    entitlement: { kind: 'revoke', reason: 'refund' },
  };
  expect(withoutUnverifiedBenefit(refund)).toBe(refund);
});
