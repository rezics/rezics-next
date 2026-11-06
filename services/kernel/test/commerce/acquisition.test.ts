import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createCurrentConsentReader } from '@rezics/auth/current-consent';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { createKernel, type Kernel } from '../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import { BenefitAcquisitionError, verifiedAcquisitionRelease } from '../../src/commerce/acquisition.ts';
import { checkout } from '../../src/commerce/checkout.ts';
import {
  StripeRejectedError,
  StripeUnavailableError,
  type CheckoutSnapshot,
  type Order,
  type StripePort,
} from '../../src/commerce/model.ts';
import * as store from '../../src/commerce/store.ts';
import { createNativeContentSystem, type NativeContentSystem } from '../content/support/native-system.ts';
import { seedGovernanceAuthority, seedResourceDenial } from '../content/support/disclosure-fixtures.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

// Reuse Content's ordinary native composition and edition publication fixture surface.
// These focused scenarios add no worker, custody harness, native substitute or live provider.
let native: NativeContentSystem;
let app: Kernel;
let commands: ReturnType<typeof createCommerceCommands>;
let subjectId: string;
let post: { id: string; revisionId: string; sha256: string };
const requestKey = () => crypto.randomUUID();
async function wire(path: string, body: unknown, version?: string, bearer = native.actors.author.bearer) {
  return app.handle(
    new Request(`https://content.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(requestKey()),
        ...(version ? { 'if-match': JSON.stringify(version) } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}
async function value<T>(response: Promise<Response>, status = 201): Promise<T> {
  const result = await response;
  const body = await result.text();
  expect({ status: result.status, error: result.status === status ? null : body }).toEqual({ status, error: null });
  return JSON.parse(body) as T;
}
beforeAll(async () => {
  native = await createNativeContentSystem({ databaseUrl: process.env.DATABASE_URL! });
  const pool = native.database.pool;
  await bootstrapRelease(pool, bundledRelease);
  const consent = createCurrentConsentReader({ database: native.database.authPool });
  app = createKernel({
    pool,
    routeKey: native.routeKey,
    tokens: native.tokenKeys,
    receiptKeys: testReceiptKeys(),
    access: native.access,
    content: {
      readConsent: ({ actorAccountId, clientId }) => consent.readCurrentConsent({ actorAccountId, clientId }),
    },
  });
  commands = createCommerceCommands({ clock: () => new Date(), pool, access: native.access });
  const scheme = await value<{ subject: { id: string } }>(
    wire('/v1/subjects', {
      type: 'skos:ConceptScheme',
      labels: { en: 'Acquisition topics' },
    }),
  );
  const concept = await value<{ subject: { id: string } }>(
    wire('/v1/subjects', {
      type: 'skos:Concept',
      labels: { en: 'Exact acquisition source' },
      statements: {
        'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.subject.id } }],
      },
    }),
  );
  subjectId = concept.subject.id;
  const space = await value<{ space: { spaceId: string } }>(wire('/v1/spaces', { title: 'Acquisition home' }));
  const realm = await value<{ realm: { realmId: string; headRevisionId: string } }>(
    wire('/v1/realms', {
      spaceId: space.space.spaceId,
      title: 'Acquisition realm',
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    }),
  );
  const boardScheme = await app.handle(
    new Request(`https://content.test/v1/realms/${realm.realm.realmId}/boardScheme`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${native.actors.author.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(requestKey()),
        'if-match': JSON.stringify(realm.realm.headRevisionId),
      },
      body: JSON.stringify({ schemeId: scheme.subject.id }),
    }),
  );
  expect(boardScheme.status).toBe(200);
  const board = await value<{ board: { id: string } }>(
    wire(`/v1/realms/${realm.realm.realmId}/boards`, {
      conceptId: subjectId,
      title: 'Acquisition board',
      visibility: 'published',
    }),
  );
  const thread = await value<{ thread: { id: string; firstPost: typeof post } }>(
    wire('/v1/threads', {
      title: 'Exact protected source',
      body: fromPlainText('Fixed version'),
      licence: 'CC0-1.0',
      subjectIds: [subjectId],
      boardId: board.board.id,
      visibility: 'protected',
    }),
  );
  post = thread.thread.firstPost;
  await seedGovernanceAuthority(pool, routeOf(post.id)!, thread.thread.id, native.actors.other.actor.accountId, [
    'thread:read',
  ]);
  await seedGovernanceAuthority(pool, 0, GLOBAL_CONTEXT, native.actors.author.actor.accountId, ['offer:create']);
});
afterAll(async () => {
  await native?.close();
});
async function offerPair() {
  const draft = await value<{ editionId: string }>(
    wire('/v1/contentEditions', {
      postId: post.id,
      revisionId: post.revisionId,
      targetSubjectId: subjectId,
    }),
  );
  await value(wire(`/v1/contentEditions/${draft.editionId}:publish`, {}, '1'), 200);
  const terms = {
    contentEditionId: draft.editionId,
    title: 'Fixed edition',
    currency: 'usd',
    unitAmountMinor: 1200,
    taxCode: 'txcd_10302000',
  };
  const a = (await commands.createOffer(native.actors.author.actor, terms, requestKey())).value;
  const b = (
    await commands.createOffer(
      native.actors.author.actor,
      { ...terms, title: 'Another offer', unitAmountMinor: 1800 },
      requestKey(),
    )
  ).value;
  for (const offer of [a, b])
    await seedGovernanceAuthority(
      native.database.pool,
      routeOf(offer.id)!,
      offer.id,
      native.actors.other.actor.accountId,
      ['order:create'],
    );
  return { a, b };
}
async function footprint() {
  return (
    await native.database.pool.query(`SELECT
    (SELECT count(*)::int FROM commerce.purchase_order) AS orders,
    (SELECT count(*)::int FROM commerce.checkout_creation_attempt) AS attempts,
    (SELECT count(*)::int FROM commerce.entitlement) AS entitlements,
    (SELECT count(*)::int FROM commerce.order_transaction) AS movements,
    (SELECT count(*)::int FROM core.receipt) AS receipts,
    (SELECT count(*)::int FROM core.outbox) AS events`)
  ).rows[0];
}
function processor(reject?: 'definitive' | 'unknown') {
  let calls = 0;
  const stripe: StripePort = {
    async createCheckoutSession() {
      calls++;
      if (reject === 'definitive') throw new StripeRejectedError('No creation');
      if (reject === 'unknown') throw new StripeUnavailableError('Unknown creation');
      return {
        id: `cs_test_${requestKey()}`,
        url: 'https://checkout.test/session',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
    },
    async readCheckout() {
      throw new Error('Use the verified fixture snapshot');
    },
    async findCheckoutSession() {
      return null;
    },
  };
  return {
    get calls() {
      return calls;
    },
    buy: (offer: { id: string; revision: number }, key = requestKey()) =>
      checkout(
        {
          pool: native.database.pool,
          commands,
          stripe,
          successUrl: 'https://web.test/orders/{ORDER_ID}',
          cancelUrl: 'https://web.test/orders/{ORDER_ID}',
        },
        native.actors.other.actor,
        offer.id,
        offer.revision,
        key,
      ),
  };
}
function paid(order: Order): CheckoutSnapshot {
  return {
    sessionId: order.checkoutSessionId!,
    clientReferenceId: order.id,
    metadataOrderId: order.id,
    livemode: false,
    status: 'complete',
    paymentStatus: 'paid',
    currency: order.currency,
    amountSubtotalMinor: order.unitAmountMinor,
    amountTaxMinor: 0,
    amountTotalMinor: order.unitAmountMinor,
    paymentIntentId: `pi_${order.id}`,
    paymentIntentStatus: 'succeeded',
    chargeId: `ch_${order.id}`,
    chargeAmountMinor: order.unitAmountMinor,
    refunds: [],
    disputes: [],
    observedAt: new Date().toISOString(),
    transactions: [
      {
        id: `txn_${order.id}`,
        kind: 'charge',
        sourceId: `ch_${order.id}`,
        currency: order.currency,
        amountMinor: order.unitAmountMinor,
        feeMinor: 0,
        netMinor: order.unitAmountMinor,
        feeDetails: [],
        exchangeRate: null,
        created: new Date().toISOString(),
      },
    ],
  };
}

test('Different request keys cannot start a second unresolved or already-owned exact fixed benefit acquisition while exact replay and verified financial truth stay intact', async () => {
  const { a, b } = await offerPair();
  const provider = processor();
  const keys = [requestKey(), requestKey()];
  const results = await Promise.allSettled(keys.map((key) => provider.buy(a, key)));
  const success = results.findIndex((r) => r.status === 'fulfilled');
  expect(success).toBeGreaterThanOrEqual(0);
  const winner = (results[success] as PromiseFulfilledResult<Order>).value;
  const denied = results[1 - success] as PromiseRejectedResult;
  expect(denied.reason).toMatchObject({ code: 'acquisition_pending', locators: { orderId: winner.id } });
  expect(provider.calls).toBe(1);
  const before = await footprint();
  expect((await provider.buy(a, keys[success])).id).toBe(winner.id);
  await expect(provider.buy(b)).rejects.toMatchObject({
    code: 'acquisition_pending',
    locators: { orderId: winner.id },
  });
  expect(await footprint()).toEqual(before);
  expect(provider.calls).toBe(1);
  await commands.applyCheckoutSnapshot(paid(winner), requestKey());
  const entitlement = await store.readOrderEntitlement(native.database.pool, routeOf(winner.id)!, winner.id);
  expect(entitlement?.revokedAt).toBeNull();
  const paidBefore = await footprint();
  await expect(provider.buy(b)).rejects.toMatchObject({
    code: 'benefit_already_owned',
    locators: { orderId: winner.id, entitlementId: entitlement!.id },
  });
  expect(await footprint()).toEqual(paidBefore);
  expect(provider.calls).toBe(1);
});

test('unknown creation and old mapped history without proved release block a different offer without another provider effect', async () => {
  const { a, b } = await offerPair();
  const provider = processor('unknown');
  await expect(provider.buy(a)).rejects.toBeInstanceOf(StripeUnavailableError);
  const rows = await native.database.pool.query('SELECT order_id FROM commerce.purchase_order WHERE offer_id=$1', [
    a.id,
  ]);
  const orderId = rows.rows[0].order_id as string;
  // Pre-slot mapped history remains authoritative through the exact-benefit partial index.
  await native.database.pool.query('DELETE FROM commerce.benefit_acquisition WHERE order_id=$1', [orderId]);
  const before = await footprint();
  await expect(provider.buy(b)).rejects.toMatchObject({ code: 'acquisition_pending', locators: { orderId } });
  expect(await footprint()).toEqual(before);
  expect(provider.calls).toBe(1);
});

test('native first no-creation evidence releases but a failed settlement string alone does not', async () => {
  const { a, b } = await offerPair();
  const rejected = processor('definitive');
  const first = await rejected.buy(a);
  expect(first.settlement).toBe('failed');
  const provider = processor();
  const next = await provider.buy(b);
  expect(next.id).not.toBe(first.id);
  expect(provider.calls).toBe(1);
  const distinct = await offerPair();
  const failed = (
    await commands.createOrder(native.actors.other.actor, distinct.a.id, distinct.a.revision, requestKey())
  ).value;
  await commands.recordCheckout(failed.id, { kind: 'failed' });
  const before = await footprint();
  await expect(provider.buy(distinct.b)).rejects.toMatchObject({
    code: 'acquisition_pending',
    locators: { orderId: failed.id },
  });
  expect(await footprint()).toEqual(before);
  expect(provider.calls).toBe(1);
});

test('verified full refund releases only after pending obligations finish and late old payment keeps money without a duplicate benefit', async () => {
  const { a, b } = await offerPair();
  const provider = processor();
  const old = await provider.buy(a);
  const snapshot = paid(old);
  await commands.applyCheckoutSnapshot(snapshot, requestKey());
  const refund = { id: `re_${old.id}`, status: 'pending', amountMinor: old.unitAmountMinor };
  await commands.applyCheckoutSnapshot(
    { ...snapshot, observedAt: new Date().toISOString(), refunds: [refund] },
    requestKey(),
  );
  await expect(provider.buy(b)).rejects.toMatchObject({ code: 'acquisition_pending' });
  const final = {
    ...snapshot,
    observedAt: new Date().toISOString(),
    refunds: [{ ...refund, status: 'succeeded' }],
    transactions: [
      ...snapshot.transactions,
      {
        ...snapshot.transactions[0]!,
        id: `txn_refund_${old.id}`,
        kind: 'refund' as const,
        sourceId: refund.id,
        amountMinor: -old.unitAmountMinor,
        netMinor: -old.unitAmountMinor,
      },
    ],
  };
  await commands.applyCheckoutSnapshot(final, requestKey());
  const next = await provider.buy(b);
  await commands.applyCheckoutSnapshot(paid(next), requestKey());
  // A current reversal can restore old money truth, never a second active exact benefit.
  await commands.applyCheckoutSnapshot(
    {
      ...final,
      observedAt: new Date().toISOString(),
      refunds: [],
      transactions: [
        ...final.transactions,
        { ...snapshot.transactions[0]!, id: `txn_reversal_${old.id}`, kind: 'refund_reversal', sourceId: refund.id },
      ],
    },
    requestKey(),
  );
  const oldEntitlement = await store.readOrderEntitlement(native.database.pool, routeOf(old.id)!, old.id);
  const newEntitlement = await store.readOrderEntitlement(native.database.pool, routeOf(next.id)!, next.id);
  expect(oldEntitlement?.revokedAt).not.toBeNull();
  expect(newEntitlement?.revokedAt).toBeNull();
  expect(
    (await store.readOrderTransactions(native.database.pool, routeOf(old.id)!, old.id)).map((t) => t.id),
  ).toContain(`txn_reversal_${old.id}`);
  expect((await commands.readOrderForAccount(old.buyerAccountId, old.id))?.settlement).toBe('paid');
  expect(provider.calls).toBe(2);
});

test('exact authorized replay survives source loss but parent revocation conceals both replay and guard locators', async () => {
  const { a } = await offerPair();
  const key = requestKey();
  const first = await commands.createOrder(native.actors.other.actor, a.id, a.revision, key);
  await seedResourceDenial(native.database.pool, routeOf(post.id)!, post.id, native.actors.author.actor.accountId, [
    'post:read',
  ]);
  try {
    expect((await commands.createOrder(native.actors.other.actor, a.id, a.revision, key)).value.id).toBe(
      first.value.id,
    );
    const before = await footprint();
    await expect(
      commands.createOrder(native.actors.other.actor, a.id, a.revision, requestKey()),
    ).rejects.not.toBeInstanceOf(BenefitAcquisitionError);
    expect(await footprint()).toEqual(before);
    await seedResourceDenial(native.database.pool, routeOf(a.id)!, a.id, native.actors.other.actor.accountId, [
      'order:create',
    ]);
    await expect(commands.createOrder(native.actors.other.actor, a.id, a.revision, key)).rejects.toMatchObject({
      name: 'GrantDeniedError',
    });
  } finally {
    await native.database.pool.query(
      "DELETE FROM access.resource_denial WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='post:read'",
      [routeOf(post.id), post.id, native.actors.author.actor.accountId],
    );
  }
});

test('only current verified terminal or final adverse disposition proves release; elapsed/failed/unknown associations do not', () => {
  const order = { id: newId(0x3300), checkoutSessionId: 'cs_test_terminal', settlement: 'failed' } as Order;
  const empty = {
    ...paid({ ...order, currency: 'usd', unitAmountMinor: 1200 }),
    status: 'expired' as const,
    paymentStatus: 'unpaid' as const,
    paymentIntentStatus: 'requires_payment_method',
    chargeId: null,
    chargeAmountMinor: null,
    transactions: [],
    refunds: [],
    disputes: [],
  };
  expect(verifiedAcquisitionRelease(order, empty)).toBeNull();
  expect(verifiedAcquisitionRelease(order, { ...empty, paymentIntentStatus: 'canceled' })).toBe('cancelled-no-charge');
  expect(
    verifiedAcquisitionRelease(order, { ...empty, paymentIntentStatus: 'canceled', paymentIntentId: null }),
  ).toBeNull();
});

test('different exact native benefits remain independently purchasable and read scopes control private conflict locators', async () => {
  const one = await offerPair();
  const two = await offerPair(); // Same subject/source version, genuinely different native edition resource.
  const provider = processor();
  const first = await provider.buy(one.a);
  const second = await provider.buy(two.a);
  expect(second.id).not.toBe(first.id);
  expect(provider.calls).toBe(2);
  const restricted = await native.auth.issue({
    accountId: native.actors.other.actor.accountId,
    clientId: native.auth.ordinaryClient.id,
    scopes: native.auth.ordinaryScopes.filter((s) => s !== 'order:read' && s !== 'entitlement:read'),
  });
  await expect(commands.createOrder(restricted.actor, one.b.id, one.b.revision, requestKey())).rejects.toMatchObject({
    code: 'acquisition_pending',
    locators: {},
  });
  await commands.applyCheckoutSnapshot(paid(first), requestKey());
  await expect(commands.createOrder(restricted.actor, one.b.id, one.b.revision, requestKey())).rejects.toMatchObject({
    code: 'benefit_already_owned',
    locators: {},
  });
});

test('current cancelled no-charge native refresh releases while mere expired failure remains pending', async () => {
  const { a, b } = await offerPair();
  const provider = processor();
  const old = await provider.buy(a);
  const terminal: CheckoutSnapshot = {
    ...paid(old),
    status: 'expired',
    paymentStatus: 'unpaid',
    paymentIntentStatus: 'requires_payment_method',
    chargeId: null,
    chargeAmountMinor: null,
    transactions: [],
  };
  await commands.applyCheckoutSnapshot(terminal, requestKey());
  expect((await commands.readOrderForAccount(old.buyerAccountId, old.id))?.settlement).toBe('failed');
  await expect(provider.buy(b)).rejects.toMatchObject({ code: 'acquisition_pending' });
  await commands.applyCheckoutSnapshot(
    { ...terminal, paymentIntentStatus: 'canceled', observedAt: new Date().toISOString() },
    requestKey(),
  );
  expect((await provider.buy(b)).id).not.toBe(old.id);
  expect(provider.calls).toBe(2);
});

test('lost final adverse native evidence releases only after the pending dispute finishes', async () => {
  const { a, b } = await offerPair();
  const provider = processor();
  const old = await provider.buy(a);
  const snapshot = paid(old);
  await commands.applyCheckoutSnapshot(snapshot, requestKey());
  const dispute = { id: `du_${old.id}`, status: 'under_review', amountMinor: old.unitAmountMinor };
  const adverse: CheckoutSnapshot = {
    ...snapshot,
    observedAt: new Date().toISOString(),
    disputes: [dispute],
    transactions: [
      ...snapshot.transactions,
      {
        ...snapshot.transactions[0]!,
        id: `txn_dispute_${old.id}`,
        kind: 'dispute',
        sourceId: dispute.id,
        amountMinor: -old.unitAmountMinor,
        netMinor: -old.unitAmountMinor,
      },
    ],
  };
  await commands.applyCheckoutSnapshot(adverse, requestKey());
  await expect(provider.buy(b)).rejects.toMatchObject({ code: 'acquisition_pending' });
  await commands.applyCheckoutSnapshot(
    { ...adverse, disputes: [{ ...dispute, status: 'lost' }], observedAt: new Date().toISOString() },
    requestKey(),
  );
  expect((await provider.buy(b)).id).not.toBe(old.id);
  expect(provider.calls).toBe(2);
});

test('retained native cash prevents a later no-charge snapshot from releasing an unresolved acquisition', async () => {
  const { a, b } = await offerPair();
  const provider = processor();
  const old = await provider.buy(a);
  const snapshot = paid(old);
  const amount = old.unitAmountMinor + 600;
  await commands.applyCheckoutSnapshot(
    {
      ...snapshot,
      amountSubtotalMinor: amount,
      amountTotalMinor: amount,
      chargeAmountMinor: amount,
      transactions: [{ ...snapshot.transactions[0]!, amountMinor: amount, netMinor: amount }],
    },
    requestKey(),
  );
  expect((await commands.readOrderForAccount(old.buyerAccountId, old.id))?.settlement).toBe('unknown');
  await commands.applyCheckoutSnapshot(
    {
      ...snapshot,
      observedAt: new Date().toISOString(),
      status: 'expired',
      paymentStatus: 'unpaid',
      paymentIntentStatus: 'canceled',
      chargeId: null,
      chargeAmountMinor: null,
      transactions: [],
    },
    requestKey(),
  );
  await expect(provider.buy(b)).rejects.toMatchObject({ code: 'acquisition_pending', locators: { orderId: old.id } });
  expect((await store.readOrderTransactions(native.database.pool, routeOf(old.id)!, old.id))[0]?.amountMinor).toBe(
    amount,
  );
  expect(provider.calls).toBe(1);
});
