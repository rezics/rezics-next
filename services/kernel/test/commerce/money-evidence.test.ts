import { expect, test } from 'bun:test';
import Stripe from 'stripe';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import type { CheckoutSnapshot, Order, StripeTransaction } from '../../src/commerce/model.ts';
import { stripeEvidenceMoneyUnit } from '../../src/commerce/money.ts';
import { checkoutMoneyObservations } from '../../src/commerce/money-observation.ts';
import { MoneyInterpretationUnavailable, royaltyLines, statementTotals } from '../../src/commerce/royalty.ts';
import { MovementIntegrityError, decideCheckout, movementEconomics } from '../../src/commerce/settlement.ts';
import { createStripePort } from '../../src/commerce/stripe.ts';
import { readOrderTransactions } from '../../src/commerce/store.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture } from '../library/support/profile-entry-fixture.ts';
import { startFakeStripe } from './support/fake-stripe.ts';

const at = '2026-10-30T12:00:00.000Z';
const unit = stripeEvidenceMoneyUnit('usd', 'checkout.integration')!;
function provider(fake: ReturnType<typeof startFakeStripe>) {
  return createStripePort({
    apiKey: 'sk_test_evidence',
    managedPayments: false,
    accountNamespace: 'evidence',
    host: '127.0.0.1',
    port: fake.port,
    protocol: 'http',
    timeoutMs: 1000,
    maxNetworkRetries: 0,
    clock: () => new Date(at),
  });
}
const request = (orderId: string, buyerAccountId = 'buyer') => ({
  orderId,
  buyerAccountId,
  title: 'Book',
  currency: 'usd',
  unitAmountMinor: 1200,
  taxCode: 'txcd_10302000',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  successUrl: 'https://example.test/success',
  cancelUrl: 'https://example.test/cancel',
});
function captured(snapshot: CheckoutSnapshot): Order {
  return {
    id: snapshot.clientReferenceId!,
    buyerAccountId: 'buyer',
    creatorAccountId: 'creator',
    offerId: 'offer',
    offerRevision: 1,
    targetSubjectId: 'subject',
    title: 'Book',
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
    royaltyBasisPoints: 9000,
    amountTaxMinor: 0,
    settlement: 'paid',
    checkoutSessionId: snapshot.sessionId,
    checkoutUrl: null,
    checkoutExpiresAt: null,
    observedAt: at,
    createdAt: at,
    revision: 1,
  };
}

test('Preserve integration, presentment and settlement money with actual provenance', async () => {
  const fake = startFakeStripe(async (path, response) => {
    if (!path.startsWith('/v1/checkout/sessions/')) return response;
    const body = await response.json();
    body.presentment_details = { presentment_currency: 'cad', presentment_amount: 1647 };
    return Response.json(body, { headers: { 'stripe-version': Stripe.API_VERSION } });
  });
  try {
    const stripe = provider(fake);
    const session = await stripe.createCheckoutSession(request('order'), 'evidence');
    fake.pay(session.id);
    const snapshot = await stripe.readCheckout(session.id);
    expect(snapshot).toMatchObject({
      currency: 'usd',
      amountSubtotalMinor: 1200,
      amountTotalMinor: 1200,
      integrationMoneyUnit: unit,
      providerApiVersion: Stripe.API_VERSION,
      presentment: { currency: 'cad', amountMinor: 1647, moneyUnit: unit },
    });
    expect(snapshot.transactions[0]).toMatchObject({
      currency: 'usd',
      amountMinor: 1200,
      feeMinor: 65,
      netMinor: 1135,
      moneyUnit: unit,
      providerApiVersion: Stripe.API_VERSION,
      moneyProvenance: {
        accountNamespace: 'evidence',
        livemode: false,
        object: 'balance_transaction',
        context: 'balance_transaction',
        requestApiVersion: Stripe.API_VERSION,
      },
    });
    const observations = checkoutMoneyObservations(snapshot, captured(snapshot));
    expect(observations.map((o) => o.context).sort()).toEqual([
      'balance_transaction',
      'checkout.integration',
      'checkout.presentment',
    ]);
    expect(observations.find((o) => o.context === 'checkout.presentment')!.amounts).toEqual({
      presentment_currency: 'cad',
      presentment_amount: 1647,
    });
    expect(
      fake.requests
        .filter((r) => r.method === 'GET')
        .every((r) => r.headers.get('stripe-version') === Stripe.API_VERSION),
    ).toBe(true);
  } finally {
    fake.stop();
  }
});

test('absent actual presentment stays absent and exceptional settlement fee units remain unknown', async () => {
  const fake = startFakeStripe();
  try {
    const stripe = provider(fake);
    const session = await stripe.createCheckoutSession(request('order'), 'unknown');
    fake.pay(session.id, 'immediate', { currency: 'isk', amount: 160000, exchangeRate: 133.333333 });
    const snapshot = await stripe.readCheckout(session.id);
    expect(snapshot.presentment).toBeNull();
    const movement = snapshot.transactions[0]!;
    expect(movement).toMatchObject({
      currency: 'isk',
      amountMinor: 160000,
      feeMinor: 65,
      netMinor: 159935,
      moneyUnit: null,
    });
    expect(movement.feeDetails[0]!.amountMinor).toBe(65);
    expect(
      checkoutMoneyObservations(snapshot, captured(snapshot)).find((o) => o.context === 'balance_transaction')!.unit,
    ).toBeNull();
    expect(() => royaltyLines(captured(snapshot), 0, [movement], unit)).toThrow(MoneyInterpretationUnavailable);
  } finally {
    fake.stop();
  }
});

test('interpretation never changes raw movement identity, stale payment truth or incompatible totals', async () => {
  const fake = startFakeStripe();
  try {
    const stripe = provider(fake);
    const session = await stripe.createCheckoutSession(request('order'), 'replay');
    fake.pay(session.id);
    const snapshot = await stripe.readCheckout(session.id);
    const order = captured(snapshot);
    const known = snapshot.transactions[0]!;
    const old: StripeTransaction = { ...known, moneyUnit: null, moneyProvenance: null, providerApiVersion: null };
    expect(movementEconomics(old)).toBe(movementEconomics(known));
    const state = {
      order,
      entitlement: null,
      transactionIds: [old.id],
      retainedTransactions: [{ ...old, orderId: order.id }],
    };
    const replay = decideCheckout(state, snapshot);
    if (replay.changed) expect(replay.newTransactions).toEqual([]);
    const stale = decideCheckout(state, { ...snapshot, observedAt: '2026-10-29T12:00:00.000Z' });
    expect(stale).toEqual({ changed: false });
    expect(() =>
      decideCheckout(state, { ...snapshot, transactions: [{ ...known, amountMinor: known.amountMinor + 1 }] }),
    ).toThrow(MovementIntegrityError);
    const line = royaltyLines(order, 0, [known], unit)[0]!;
    expect(statementTotals([line], 9000)[0]).toMatchObject({ currency: 'usd', moneyUnit: unit, grossMinor: 1200 });
    expect(() =>
      statementTotals(
        [line, { ...line, balanceTransactionId: 'txn_other', moneyUnit: { ...unit, exponent: 0 } }],
        9000,
      ),
    ).toThrow(MoneyInterpretationUnavailable);
    expect(() => statementTotals([{ ...line, moneyUnit: null }], 9000)).toThrow(MoneyInterpretationUnavailable);
  } finally {
    fake.stop();
  }
});

test('native metadata-only refresh commits one interpretation, refuses superseded claims and repairs royalty input', async () => {
  const f = await createProfileEntryFixture();
  const fake = startFakeStripe();
  try {
    const buyer = await f.identity(['order:read']);
    const route = routeOf(buyer.actor.accountId)!;
    const orderId = newId(route);
    const stripe = provider(fake);
    const session = await stripe.createCheckoutSession(request(orderId, buyer.actor.accountId), `order:${orderId}`);
    const commands = createCommerceCommands({ pool: f.pool, access: f.access });
    await f.pool.query(
      `INSERT INTO commerce.purchase_order
      (route, order_id, buyer_account_id, offer_id, offer_revision, creator_account_id, title, currency,
       unit_amount_minor, tax_code, royalty_basis_points, settlement, checkout_session_id, checkout_url,
       checkout_expires_at, created_at, updated_at, revision, transaction_id, target_subject_id)
      VALUES ($1,$2,$3,$4,1,$5,'Book','usd',1200,'txcd_10302000',9000,'pending',$6,$7,$8,now(),now(),1,$2,$4)`,
      [
        route,
        orderId,
        buyer.actor.accountId,
        newId(routeOf(f.owner.actor.accountId)!),
        f.owner.actor.accountId,
        session.id,
        session.url,
        session.expiresAt,
      ],
    );
    fake.pay(session.id);
    const fresh = await stripe.readCheckout(session.id);
    // A historical raw capture lacks unit lineage. It still records the actual paid truth.
    const legacy = {
      ...fresh,
      moneyProvenance: null,
      integrationMoneyUnit: null,
      providerApiVersion: null,
      transactions: fresh.transactions.map((t) => ({
        ...t,
        moneyUnit: null,
        moneyProvenance: null,
        providerApiVersion: null,
      })),
    };
    expect((await commands.applyCheckoutSnapshot(legacy, `old:${orderId}`)).changed).toBe(true);
    const before = await readOrderTransactions(f.pool, route, orderId);
    expect(before[0]!.moneyUnit).toBeNull();
    const a = await commands.beginCheckoutRefresh({ orderId, sessionId: session.id, workflowId: `a:${orderId}` });
    const b = await commands.beginCheckoutRefresh({ orderId, sessionId: session.id, workflowId: `b:${orderId}` });
    if (a.kind !== 'claimed' || b.kind !== 'claimed') throw new Error('Expected physical admissions');
    expect(await commands.applyClaimedCheckoutSnapshot(fresh, a.command.value)).toEqual({
      changed: false,
      superseded: true,
    });
    const applied = await commands.applyClaimedCheckoutSnapshot(fresh, b.command.value);
    expect(applied.changed).toBe(true);
    if (!applied.changed) throw new Error('Expected metadata command');
    expect(applied.value).toMatchObject({
      moneyMetadataChanged: true,
      newTransactions: [],
      entitlementAction: { kind: 'none' },
    });
    await commands.applyClaimedCheckoutSnapshot(fresh, b.command.value);
    const c = await commands.beginCheckoutRefresh({ orderId, sessionId: session.id, workflowId: `c:${orderId}` });
    if (c.kind !== 'claimed') throw new Error('Expected fresh admission');
    expect((await commands.applyClaimedCheckoutSnapshot(fresh, c.command.value)).changed).toBe(false);
    const rows = await f.pool.query('SELECT context FROM commerce.money_observation WHERE route=$1 AND order_id=$2', [
      route,
      orderId,
    ]);
    expect(rows.rows.map((r) => r.context).sort()).toEqual(['balance_transaction', 'checkout.integration']);
    const after = await readOrderTransactions(f.pool, route, orderId);
    expect(after[0]!.moneyUnit).toEqual(unit);
    expect(movementEconomics(after[0]!)).toBe(movementEconomics(before[0]!));
    const stored = await commands.readOrderForAccount(buyer.actor.accountId, orderId);
    expect(stored!.settlement).toBe('paid');
    expect(royaltyLines(stored!, 0, after, unit)).toHaveLength(1);
    const events = await f.pool.query(
      "SELECT type FROM core.outbox WHERE subject=$1 AND type IN ('com.rezics.commerce.money.observed.v1','com.rezics.commerce.transactions.recorded.v1')",
      [orderId],
    );
    expect(events.rows.filter((r) => r.type === 'com.rezics.commerce.money.observed.v1')).toHaveLength(1);
    expect(events.rows.filter((r) => r.type === 'com.rezics.commerce.transactions.recorded.v1')).toHaveLength(1);
  } finally {
    fake.stop();
    await f.close();
  }
});
