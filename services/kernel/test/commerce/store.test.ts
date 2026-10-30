import { afterAll, expect, test } from 'bun:test';
import pg, { type PoolClient } from 'pg';
import * as store from '../../src/commerce/store.ts';
import { decideCheckout, MovementIntegrityError } from '../../src/commerce/settlement.ts';
import type { CheckoutDecision, CheckoutSnapshot, Offer, StripeTransaction } from '../../src/commerce/model.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x1234;
const id = (n: number, r = route) =>
  `00000000-0000-7000-8000-${r.toString(16).padStart(4, '0')}${n.toString(16).padStart(8, '0')}`;
const time = '2026-10-25T12:00:00.000Z';
const context = { transactionId: id(99), time };
const offer: Offer = {
  id: id(1, 0xabcd),
  creatorAccountId: id(2, 0xabcd),
  targetSubjectId: id(3),
  title: 'Book',
  currency: 'usd',
  unitAmountMinor: 1200,
  taxCode: 'txcd_10302000',
  royaltyBasisPoints: 9000,
  state: 'active',
  revision: 1,
};
const transaction: StripeTransaction = {
  id: 'txn_paid',
  kind: 'charge',
  sourceId: 'ch_paid',
  currency: 'usd',
  amountMinor: 1200,
  feeMinor: 100,
  netMinor: 1100,
  feeDetails: [{ type: 'stripe_fee', amountMinor: 100, description: null }],
  exchangeRate: null,
  created: time,
};
const grant: CheckoutDecision = {
  changed: true,
  settlement: 'paid',
  paymentIntentId: 'pi_paid',
  observedAt: time,
  entitlement: { kind: 'grant' },
  newTransactions: [transaction],
};
const options = { ...context, newEntitlementId: id(5) };

async function fixture(body: (c: PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await store.insertOffer(c, 0xabcd, offer, context);
    await store.insertOrder(c, route, { id: id(4), buyerAccountId: id(2), offer }, context);
    await body(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

test('the store applies a checkout decision to order transactions and entitlement in one transaction', async () => {
  await fixture(async (c) => {
    expect(await store.readOffer(c, 0xabcd, offer.id)).toEqual(offer);
    expect(await store.readOffer(c, route, offer.id)).toBeNull();
    expect(await store.setOfferState(c, 0xabcd, offer.id, 'delisted', context)).toMatchObject({
      state: 'delisted',
      revision: 2,
    });
    expect(await store.readOrder(c, route + 1, id(4))).toBeNull();
    await store.setOrderSettlement(c, route, id(4), 'unknown', context);
    await store.setOrderSettlement(c, route, id(4), 'failed', context);
    await store.recordCheckoutSession(
      c,
      route,
      id(4),
      { id: 'cs_test_paid', url: 'https://example.test/checkout', expiresAt: time },
      context,
    );
    expect(await store.readOrderBySession(c, route, 'cs_test_paid')).toMatchObject({
      id: id(4),
      settlement: 'failed',
      checkoutExpiresAt: time,
    });
    expect(await store.readOrderBySession(c, route + 1, 'cs_test_paid')).toBeNull();
    const before = (await store.readSettlementState(c, route, id(4), [transaction.id]))!;
    const unchanged = await store.applyCheckoutDecision(c, route, before, { changed: false }, options);
    expect(unchanged).toEqual({ changed: false });
    expect(await store.readSettlementState(c, route, id(4), [transaction.id])).toEqual(before);
    const result = await store.applyCheckoutDecision(c, route, before, grant, options);
    expect(result).toMatchObject({
      changed: true,
      order: { settlement: 'paid', observedAt: time, revision: before.order.revision + 1 },
      entitlement: { id: id(5), targetSubjectId: offer.targetSubjectId, revision: 1 },
      newTransactions: [transaction],
    });
    const paid = (await store.readSettlementState(c, route, id(4), [transaction.id]))!;
    expect(paid.transactionIds).toEqual(['txn_paid']);
    expect(await store.readOrderTransactions(c, route, id(4))).toEqual([transaction]);
    expect(
      (
        await c.query('SELECT payment_intent_id FROM commerce.purchase_order WHERE route = $1 AND order_id = $2', [
          route,
          id(4),
        ])
      ).rows,
    ).toEqual([{ payment_intent_id: 'pi_paid' }]);
    await expect(
      store.applyCheckoutDecision(c, route, before, grant, { ...options, newEntitlementId: id(6) }),
    ).rejects.toThrow();
    expect(await store.readSettlementState(c, route, id(4), [transaction.id])).toEqual(paid);
    // Even a writer incorrectly requesting a second grant cannot defeat the fulfilment index.
    await c.query('SAVEPOINT duplicate');
    await expect(
      store.applyCheckoutDecision(c, route, paid, grant, { ...options, newEntitlementId: id(6) }),
    ).rejects.toThrow();
    await c.query('ROLLBACK TO SAVEPOINT duplicate');
    expect(await store.readSettlementState(c, route, id(4), [transaction.id])).toEqual(paid);
    for (const action of [
      { kind: 'revoke', reason: 'refund' },
      { kind: 'reason', reason: 'dispute' },
      { kind: 'restore' },
    ] as const) {
      const state = (await store.readSettlementState(c, route, id(4), []))!;
      await store.applyCheckoutDecision(
        c,
        route,
        state,
        { ...grant, entitlement: action, newTransactions: [] },
        options,
      );
      expect(await store.readEntitlement(c, route, id(5))).toMatchObject({
        revision: state.entitlement!.revision + 1,
        revokedAt: action.kind === 'restore' ? null : time,
        revokeReason: action.kind === 'restore' ? null : action.reason,
      });
    }
    const state = (await store.readSettlementState(c, route, id(4), []))!;
    await c.query('UPDATE commerce.entitlement SET revision = revision + 1 WHERE route = $1 AND entitlement_id = $2', [
      route,
      id(5),
    ]);
    const stale = (await store.readSettlementState(c, route, id(4), []))!;
    await expect(
      store.applyCheckoutDecision(
        c,
        route,
        state,
        { ...grant, entitlement: { kind: 'revoke', reason: 'refund' }, newTransactions: [] },
        options,
      ),
    ).rejects.toThrow();
    expect(await store.readSettlementState(c, route, id(4), [])).toEqual(stale);
    expect(await store.readEntitlement(c, route + 1, id(5))).toBeNull();
    expect(await store.listEntitlements(c, route, id(2), { after: null, limit: 1000 })).toHaveLength(1);
    expect(await store.listEntitlements(c, route, id(2), { after: id(5), limit: 1 })).toEqual([]);
    // The caller owns rollback of the complete command.
    await c.query('ROLLBACK');
    expect(await store.readOrder(c, route, id(4))).toBeNull();
    expect(await store.readEntitlement(c, route, id(5))).toBeNull();
    expect(await store.readOrderTransactions(c, route, id(4))).toEqual([]);
  });
});

async function seed(c: PoolClient, count: number) {
  // The same bulk seed covers every table at every scale, both on this route and on another partition.
  for (const r of [route, 0x5678]) {
    await c.query(
      `WITH ids AS (SELECT ('10000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid AS id FROM generate_series(1, $2::int) n),
      offers AS (INSERT INTO commerce.offer SELECT $1, id, id, id, 'Other', 'usd', 100, 'txcd_10302000', 9000, 'active', 1, $3::timestamptz, $3::timestamptz, id FROM ids),
      orders AS (INSERT INTO commerce.purchase_order (route, order_id, buyer_account_id, offer_id, offer_revision, target_subject_id, creator_account_id, title, currency, unit_amount_minor, tax_code, royalty_basis_points, settlement, created_at, updated_at, revision, transaction_id) SELECT $1, id, id, id, 1, id, id, 'Other', 'usd', 100, 'txcd_10302000', 9000, 'pending', $3::timestamptz, $3::timestamptz, 1, id FROM ids),
      transactions AS (INSERT INTO commerce.order_transaction SELECT $1, id, 'txn_' || replace(id::text, '-', ''), 'charge', 'ch_other', 'usd', 100, 1, 99, '[]', NULL, $3::timestamptz, $3::timestamptz, id FROM ids)
      INSERT INTO commerce.entitlement SELECT $1, id, id, id, id, id, $3::timestamptz, NULL, NULL, 1, id FROM ids`,
      [r, count, time],
    );
  }
  for (const table of ['offer', 'purchase_order', 'order_transaction', 'entitlement'])
    await c.query(`ANALYZE commerce.${table}`);
}

type Plan = {
  'Node Type': string;
  'Relation Name'?: string;
  'Shared Hit Blocks': number;
  'Shared Read Blocks': number;
  Plans?: Plan[];
};
const nodes = (p: Plan): Plan[] => [p, ...(p.Plans ?? []).flatMap(nodes)];

test('store statement counts do not grow with unrelated rows', async () => {
  const counts: number[][] = [];
  const buffers: number[][] = [];
  for (const scale of [0, 2000, 8000]) {
    await fixture(async (c) => {
      await seed(c, scale);
      // Keep a real page and transaction in the measured reads.
      await store.applyCheckoutDecision(
        c,
        route,
        (await store.readSettlementState(c, route, id(4), [transaction.id]))!,
        grant,
        options,
      );
      const captured: { sql: string; values: unknown[] }[] = [];
      const tracked = new Proxy(c, {
        get(target, key) {
          if (key === 'query')
            return (sql: string, values: unknown[]) => {
              captured.push({ sql, values });
              return target.query(sql, values);
            };
          return Reflect.get(target, key);
        },
      });
      const measured: number[] = [];
      const state = (await store.readSettlementState(tracked, route, id(4), ['txn_refund']))!;
      measured.push(captured.length);
      await c.query('SAVEPOINT measure');
      const start = captured.length;
      await store.applyCheckoutDecision(
        tracked,
        route,
        state,
        {
          ...grant,
          entitlement: { kind: 'revoke', reason: 'refund' },
          newTransactions: [
            { ...transaction, id: 'txn_refund', kind: 'refund', amountMinor: -1200, feeMinor: 0, netMinor: -1200 },
          ],
        },
        options,
      );
      measured.push(captured.length - start);
      await c.query('ROLLBACK TO SAVEPOINT measure');
      const pageStart = captured.length;
      expect(await store.listEntitlements(tracked, route, id(2), { after: null, limit: 1 })).toHaveLength(1);
      measured.push(captured.length - pageStart);
      counts.push(measured);
      const used: number[] = [];
      for (const statement of captured) {
        await c.query('SAVEPOINT explain');
        const result = await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.sql}`, statement.values);
        const plan: Plan = result.rows[0]['QUERY PLAN'][0].Plan;
        const scans = nodes(plan).filter((n) => n['Relation Name']);
        if (scale > 0) {
          expect(scans.length).toBeGreaterThan(0);
          expect(scans.every((n) => /Index|Bitmap|ModifyTable/.test(n['Node Type']))).toBe(true);
        }
        used.push(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']);
        await c.query('ROLLBACK TO SAVEPOINT explain');
      }
      buffers.push(used);
    });
  }
  expect(counts[1]).toEqual(counts[0]);
  expect(counts[2]).toEqual(counts[0]);
  // Near-empty tables can use sequential scans. Compare the populated scales:
  // a B-tree can add a level; unrelated heap pages must never be visited.
  for (let i = 0; i < buffers[1]!.length; i++) {
    expect(buffers[2]![i]!).toBeLessThanOrEqual(buffers[1]![i]! + 12);
  }
});

test('named movement reads retain economics and detect a collision with another order on the buyer route', async () => {
  await fixture(async (c) => {
    await store.recordCheckoutSession(
      c,
      route,
      id(4),
      { id: 'cs_test_integrity', url: 'https://example.test/checkout', expiresAt: time },
      context,
    );
    await store.applyCheckoutDecision(
      c,
      route,
      (await store.readSettlementState(c, route, id(4), [transaction.id]))!,
      grant,
      options,
    );
    const retained = (await store.readSettlementState(c, route, id(4), [transaction.id]))!;
    expect(retained.retainedTransactions).toEqual([{ ...transaction, orderId: id(4) }]);
    const snapshot: CheckoutSnapshot = {
      sessionId: 'cs_test_integrity',
      clientReferenceId: id(4),
      metadataOrderId: id(4),
      livemode: false,
      status: 'complete',
      paymentStatus: 'paid',
      currency: 'usd',
      amountSubtotalMinor: 1200,
      amountTaxMinor: 0,
      amountTotalMinor: 1200,
      paymentIntentId: 'pi_paid',
      paymentIntentStatus: 'succeeded',
      chargeId: 'ch_paid',
      chargeAmountMinor: 1200,
      refunds: [],
      disputes: [],
      transactions: [transaction],
      observedAt: time,
    };
    expect(decideCheckout(retained, snapshot)).toEqual({ changed: false });
    for (const change of [{ amountMinor: 1201, netMinor: 1101 }, { currency: 'eur' }, { sourceId: 'ch_other' }]) {
      expect(() => decideCheckout(retained, { ...snapshot, transactions: [{ ...transaction, ...change }] })).toThrow(
        MovementIntegrityError,
      );
      expect(await store.readSettlementState(c, route, id(4), [transaction.id])).toEqual(retained);
    }
    await store.insertOrder(c, route, { id: id(7), buyerAccountId: id(2), offer }, context);
    await store.recordCheckoutSession(
      c,
      route,
      id(7),
      { id: 'cs_test_other', url: 'https://example.test/checkout', expiresAt: time },
      context,
    );
    const other = (await store.readSettlementState(c, route, id(7), [transaction.id]))!;
    expect(other.transactionIds).toEqual([]);
    expect(other.retainedTransactions).toEqual(retained.retainedTransactions);
    expect(() =>
      decideCheckout(other, {
        ...snapshot,
        sessionId: 'cs_test_other',
        clientReferenceId: id(7),
        metadataOrderId: id(7),
      }),
    ).toThrow(MovementIntegrityError);
    await expect(store.readNamedOrderTransactions(c, route, id(7), [transaction.id])).rejects.toBeInstanceOf(
      MovementIntegrityError,
    );
    expect(await store.readOrderTransactions(c, route, id(4))).toEqual([transaction]);
    expect(await store.readOrderTransactions(c, route, id(7))).toEqual([]);
  });
});
