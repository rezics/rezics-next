import { expect, test } from 'bun:test';
import { StripeRejectedError, StripeUnavailableError } from '../../src/commerce/model.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { entryKey } from '../library/support/profile-entry-fixture.ts';
import { nativeAnchorFixture, type NativeAnchorFixture } from './support/checkout-anchor.ts';

const anchor = (order: { id: string; checkoutSessionId: string | null }) => ({
  kind: 'anchor',
  anchor: { orderId: order.id, sessionId: order.checkoutSessionId },
});
async function run(body: (f: NativeAnchorFixture) => Promise<void>) {
  const f = await nativeAnchorFixture();
  try {
    await body(f);
  } finally {
    await f.close();
  }
}

for (const paid of [false, true]) {
  test(`direct Session resolves exact ${paid ? 'paid' : 'open'} native anchor after actual seller revision/delisting`, () =>
    run(async (f) => {
      const order = await f.checkout(true, paid);
      await f.commands.reviseOffer(f.seller.actor, f.offer.id, { unitAmountMinor: 2400 }, entryKey());
      await f.commands.delistOffer(f.seller.actor, f.offer.id, entryKey());
      expect((await f.commands.readOrderForAccount(order.buyerAccountId, order.id))!.unitAmountMinor).toBe(1200);
      expect(f.fake.sessions.get(order.checkoutSessionId!)!.amount_subtotal).toBe(1200);
      const event = await f.event(order);
      const before = await f.state(order);
      f.reset();
      console.log(`native anchor reached: direct ${paid ? 'paid' : 'open'}, revised and delisted`);
      expect(await f.resolver().resolveEvent(event)).toEqual(anchor(order));
      f.assertWork(order, 1);
      expect(f.requests[0]!.params).toBe('');
      expect(await f.state(order)).toEqual(before);
    }));
  test(`known-order repair resolves ${paid ? 'paid' : 'pending'} by one PK with zero provider I/O`, () =>
    run(async (f) => {
      const order = await f.checkout(true, paid);
      const before = await f.state(order);
      f.reset();
      console.log(`native anchor reached: known ${paid ? 'paid' : 'pending'}`);
      expect(await f.resolver().resolveKnownOrder({ orderId: order.id })).toEqual(anchor(order));
      f.assertWork(order, 0);
      expect(await f.state(order)).toEqual(before);
    }));
}

test('PaymentIntent after charge uses one actual filtered list and one unexpanded GET before native binding', () =>
  run(async (f) => {
    const order = await f.checkout(true, true);
    const event = await f.event(order, true);
    const before = await f.state(order);
    f.reset();
    console.log('native anchor reached: PaymentIntent after real charge/native paid apply');
    expect(await f.resolver().resolveEvent(event)).toEqual(anchor(order));
    f.assertWork(order, 2);
    expect(f.requests[0]).toMatchObject({ path: '/v1/checkout/sessions' });
    expect(new URLSearchParams(f.requests[0]!.params).get('payment_intent')).toBe(event.paymentIntentId);
    expect(new URLSearchParams(f.requests[0]!.params).get('limit')).toBe('1');
    expect(f.requests[1]).toMatchObject({ path: `/v1/checkout/sessions/${order.checkoutSessionId}`, params: '' });
    expect(await f.state(order)).toEqual(before);
  }));

test('missing filtered PaymentIntent lookup is internal not-ours, then a matching key still resolves', () =>
  run(async (f) => {
    const order = await f.checkout(true, true);
    const event = await f.event(order, true);
    f.control.emptyList = true;
    f.reset();
    console.log('native anchor reached: genuine empty provider list');
    expect(await f.resolver().resolveEvent(event)).toEqual({ kind: 'not-ours' });
    f.assertWork(order, 1, 0);
    f.control.emptyList = false;
    expect(await f.resolver().resolveEvent(event)).toEqual(anchor(order));
  }));

test('known native order without recorded Session cannot authorize creation or a refresh claim', () =>
  run(async (f) => {
    const order = await f.checkout(false);
    const before = await f.state(order);
    f.reset();
    console.log('native anchor reached: unbound order');
    expect(await f.resolver().resolveKnownOrder({ orderId: order.id })).toEqual({ kind: 'mismatch' });
    f.assertWork(order, 0);
    expect(await f.state(order)).toEqual(before);
  }));

const denials = [
  'foreign-routable',
  'unknown-native',
  'client-metadata-disagree',
  'missing-client',
  'missing-metadata',
  'malformed',
  'nonroutable',
  'returned-session',
  'setup',
  'subscription',
  'event-mode',
  'configured-mode',
  'locator-mode',
  'spoofed-account-cannot-repair-correlation',
  'recorded-other-session',
  'missing-native-session',
] as const;
for (const denial of denials) {
  test(`native Session rejects ${denial} without admission/full read or state poisoning`, () =>
    run(async (f) => {
      const order = await f.checkout();
      const other = await f.checkout(denial !== 'missing-native-session');
      expect(partitionOf(routeOf(order.id)!)).toBe(partitionOf(routeOf(other.id)!));
      expect(other.targetSubjectId).toBe(order.targetSubjectId);
      expect(other.unitAmountMinor).toBe(order.unitAmountMinor);
      const event = await f.event(order, false, denial === 'event-mode');
      const provider = f.fake.sessions.get(order.checkoutSessionId!)!;
      const original = structuredClone(provider);
      let nativeOrder = order;
      let points = 0;
      if (['foreign-routable', 'recorded-other-session', 'missing-native-session', 'unknown-native'].includes(denial)) {
        const id =
          denial === 'foreign-routable'
            ? newId((routeOf(order.id)! + 16) % 65536)
            : denial === 'unknown-native'
              ? newId(routeOf(order.id)!)
              : other.id;
        provider.client_reference_id = id;
        provider.metadata = { order_id: id };
        nativeOrder = { ...other, id };
        points = 1;
      } else if (denial === 'client-metadata-disagree') provider.metadata = { order_id: other.id };
      else if (denial === 'missing-client') provider.client_reference_id = null;
      else if (denial === 'missing-metadata') provider.metadata = {};
      else if (denial === 'malformed' || denial === 'nonroutable') {
        const id = denial === 'malformed' ? 'foreign-order' : '00000000-0000-4000-8000-000000000001';
        provider.client_reference_id = id;
        provider.metadata = { order_id: id };
      } else if (denial === 'returned-session') provider.id = other.checkoutSessionId!;
      else if (denial === 'setup' || denial === 'subscription') provider.mode = denial;
      else if (denial === 'locator-mode') provider.livemode = true;
      else if (denial === 'spoofed-account-cannot-repair-correlation') {
        provider.client_reference_id = null;
        provider.metadata = { order_id: order.id, account_id: order.buyerAccountId };
      }
      const before = await f.state(order),
        beforeOther = await f.state(other);
      f.reset();
      console.log(`native anchor reached: ${denial}, two native same-partition orders ready`);
      expect(await f.resolver(denial === 'configured-mode').resolveEvent(event)).toEqual({ kind: 'mismatch' });
      // Event/config mode disagreement may reject even before retrieving the locator.
      f.assertWork(nativeOrder, denial === 'event-mode' || denial === 'configured-mode' ? 0 : 1, points);
      expect(await f.state(order)).toEqual(before);
      expect(await f.state(other)).toEqual(beforeOther);
      Object.assign(provider, original);
      expect(await f.resolver().resolveEvent(await f.event(order))).toEqual(anchor(order));
    }));
}

test('provider account_id spoof is ignored on an otherwise matching native binding', () =>
  run(async (f) => {
    const order = await f.checkout();
    f.fake.sessions.get(order.checkoutSessionId!)!.metadata!.account_id = f.seller.actor.accountId;
    const event = await f.event(order);
    const before = await f.state(order);
    f.reset();
    console.log('native anchor reached: matching order with spoofed account_id');
    expect(await f.resolver().resolveEvent(event)).toEqual(anchor(order));
    f.assertWork(order, 1);
    expect(await f.state(order)).toEqual(before);
  }));

test('PaymentIntent lookup returning another real Session must fail actual locator PI equality before native read', () =>
  run(async (f) => {
    const order = await f.checkout(true, true),
      other = await f.checkout(true, true);
    const event = await f.event(order, true);
    f.control.listSession = other.checkoutSessionId;
    const before = await f.state(order);
    f.reset();
    console.log('native anchor reached: mismatched PaymentIntent provider bytes');
    expect(await f.resolver().resolveEvent(event)).toEqual({ kind: 'mismatch' });
    f.assertWork(order, 2, 0);
    expect(await f.state(order)).toEqual(before);
    f.control.listSession = null;
    expect(await f.resolver().resolveEvent(event)).toEqual(anchor(order));
  }));

for (const failure of ['unknown-session', 'sdk-unavailable', 'list-unavailable', 'native-timeout'] as const) {
  test(`native resolver preserves ${failure} as failure rather than a successful empty anchor`, () =>
    run(async (f) => {
      const order = await f.checkout(true, true);
      const event = await f.event(order, failure === 'list-unavailable');
      const before = await f.state(order);
      const provider = f.fake.sessions.get(order.checkoutSessionId!)!;
      if (failure === 'unknown-session') f.fake.sessions.delete(order.checkoutSessionId!);
      if (failure === 'sdk-unavailable' || failure === 'list-unavailable') f.control.status = 503;
      const lock = failure === 'native-timeout' ? await f.db.admin.connect() : null;
      if (lock) {
        await lock.query('BEGIN');
        await lock.query('LOCK TABLE commerce.purchase_order IN ACCESS EXCLUSIVE MODE');
      }
      f.reset();
      console.log(`native anchor reached: ${failure}, actual provider/DB control armed`);
      try {
        const operation = f.resolver().resolveEvent(event);
        if (failure === 'native-timeout') {
          // A real timed-out point read, not an exception callback or lifecycle denial.
          await expect(operation).rejects.toMatchObject({ code: '55P03' });
          expect(f.trace.some((row) => row.error)).toBe(true);
        } else
          await expect(operation).rejects.toBeInstanceOf(
            failure === 'unknown-session' ? StripeRejectedError : StripeUnavailableError,
          );
      } finally {
        if (lock) {
          await lock.query('ROLLBACK');
          lock.release();
        }
      }
      expect(await f.state(order)).toEqual(before);
      f.control.status = 0;
      f.fake.sessions.set(order.checkoutSessionId!, provider);
      expect(await f.resolver().resolveEvent(event)).toEqual(anchor(order));
    }));
}

test('readonly resolver neither locks the order nor exports captured payload; actual begin owns the next revision', () =>
  run(async (f) => {
    const order = await f.checkout(true, true),
      event = await f.event(order);
    const before = await f.state(order);
    const lock = await f.db.admin.connect();
    await lock.query('BEGIN');
    await lock.query('SELECT order_id FROM commerce.purchase_order WHERE route=$1 AND order_id=$2 FOR UPDATE', [
      routeOf(order.id),
      order.id,
    ]);
    f.reset();
    console.log('native anchor reached: real row lock held; provider connection/closed DTO inspection');
    try {
      expect(await f.resolver().resolveEvent(event)).toEqual(anchor(order));
      f.assertWork(order, 1);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    expect(await f.state(order)).toEqual(before);
    const admitted = await f.commands.beginCheckoutRefresh({
      orderId: order.id,
      sessionId: order.checkoutSessionId!,
      workflowId: `wf:${entryKey()}`,
    });
    expect(admitted.kind).toBe('claimed');
    if (admitted.kind !== 'claimed') throw new Error('Expected actual native admission');
    expect(admitted.command.value.order.revision).toBe(order.revision + 1);
  }));

for (const invalid of ['malformed', 'nonroutable', 'unknown'] as const) {
  test(`known-order ${invalid} input supplies no authority and does not poison legitimate repair`, () =>
    run(async (f) => {
      const order = await f.checkout(true, true);
      const id =
        invalid === 'malformed'
          ? 'foreign-order'
          : invalid === 'nonroutable'
            ? '00000000-0000-4000-8000-000000000001'
            : newId(routeOf(order.id)!);
      const before = await f.state(order);
      f.reset();
      console.log(`native anchor reached: known-order ${invalid}, paid repair control ready`);
      expect(await f.resolver().resolveKnownOrder({ orderId: id })).toEqual({
        kind: invalid === 'unknown' ? 'not-ours' : 'mismatch',
      });
      f.assertWork({ ...order, id }, 0, invalid === 'unknown' ? 1 : 0);
      expect(await f.state(order)).toEqual(before);
      f.reset();
      expect(await f.resolver().resolveKnownOrder({ orderId: order.id })).toEqual(anchor(order));
      f.assertWork(order, 0);
      expect(await f.state(order)).toEqual(before);
    }));
}

test('matching trusted live mode resolves independently of provider Session prefix or key text', () =>
  run(async (f) => {
    const order = await f.checkout();
    // Provider fixture bytes are adversarial inputs; neither the test key nor Session spelling is mode authority.
    f.fake.sessions.get(order.checkoutSessionId!)!.livemode = true;
    const event = await f.event(order, false, true);
    const before = await f.state(order);
    f.reset();
    console.log('native anchor reached: verified live event/config/locator with test-spelled Session');
    expect(await f.resolver(true).resolveEvent(event)).toEqual(anchor(order));
    f.assertWork(order, 1);
    expect(await f.state(order)).toEqual(before);
  }));

test('PaymentIntent locator missing its intent refuses before native lookup and then recovers', () =>
  run(async (f) => {
    const order = await f.checkout(true, true);
    const event = await f.event(order, true);
    const provider = f.fake.sessions.get(order.checkoutSessionId!)!;
    const intent = provider.payment_intent;
    // The real filtered list still finds the Session; only the retrieved provider correlation is removed.
    provider.payment_intent = null;
    f.control.listSession = order.checkoutSessionId;
    const before = await f.state(order);
    f.reset();
    console.log('native anchor reached: paid order with missing locator PaymentIntent');
    expect(await f.resolver().resolveEvent(event)).toEqual({ kind: 'mismatch' });
    f.assertWork(order, 2, 0);
    expect(await f.state(order)).toEqual(before);
    provider.payment_intent = intent;
    f.control.listSession = null;
    f.reset();
    expect(await f.resolver().resolveEvent(event)).toEqual(anchor(order));
    f.assertWork(order, 2);
    expect(await f.state(order)).toEqual(before);
  }));
