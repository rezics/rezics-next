import { afterAll, expect, test } from 'bun:test';
import { createAccess } from '../../src/access/index.ts';
import { createCommerceCommands } from '../../src/commerce/commands.ts';
import { readCreatorFinancialSource } from '../../src/commerce/financial-evidence.ts';
import type { CheckoutSnapshot, Order, StripeTransaction } from '../../src/commerce/model.ts';
import { createPayouts } from '../../src/commerce/payouts.ts';
import { MovementIntegrityError } from '../../src/commerce/settlement.ts';
import { insertOrder, readOrder } from '../../src/commerce/store.ts';
import { createNativeEconomyCommerceEvidence } from '../../src/composition/economy-commerce-evidence.ts';
import { createNativeEconomyDatabase } from '../../src/composition/economy.ts';
import { createPool } from '../../src/database/pool.ts';
import { createEconomyLedger } from '../../src/economy/ledger.ts';
import { registerCommerceEvidence } from '../../src/economy/storage/commerce-evidence.ts';
import { initializeEventTypes } from '../../src/events/catalogue.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
configureTestReceiptKeys(pool);
afterAll(() => pool.end());

const creator = newId(0x2200);
const buyer = newId(0x3300);
const unit = { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' } as const;
const key = () => Bun.randomUUIDv7();
const access = createAccess({ actions: new Map() });
const commands = createCommerceCommands({ pool, access, clock: () => new Date() });
const payouts = createPayouts({ pool });

async function order() {
  const route = routeOf(buyer)!;
  const result = await insertOrder(
    pool,
    route,
    {
      id: newId(route),
      buyerAccountId: buyer,
      offer: {
        id: newId(routeOf(creator)!),
        creatorAccountId: creator,
        targetSubjectId: newId(0x5500),
        title: 'Captured test order',
        currency: 'usd',
        unitAmountMinor: 1000,
        moneyUnit: unit,
        taxBehavior: 'exclusive',
        taxCode: 'txcd_10302000',
        royaltyBasisPoints: 9000,
        state: 'active',
        revision: 1,
        contentEdition: null,
      },
    },
    { transactionId: key(), time: new Date().toISOString() },
  );
  await commands.recordCheckout(result.id, {
    session: {
      id: `cs_test_${key().replaceAll('-', '')}`,
      url: 'https://checkout.test',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const retained = await readOrder(pool, route, result.id);
  if (!retained?.checkoutSessionId) throw new Error('Native Checkout was not recorded');
  return retained;
}

function transaction(kind: StripeTransaction['kind'], amountMinor: number, feeMinor = 0): StripeTransaction {
  return {
    id: `txn_${key().replaceAll('-', '')}`,
    kind,
    sourceId: kind === 'charge' ? 'ch_sale' : kind === 'refund' ? 're_refund' : 'du_dispute',
    currency: 'usd',
    amountMinor,
    feeMinor,
    netMinor: amountMinor - feeMinor,
    feeDetails: feeMinor ? [{ type: 'stripe_fee', amountMinor: feeMinor, description: null }] : [],
    exchangeRate: null,
    created: '2025-12-01T00:00:00.000Z',
  };
}

function snapshot(order: Order, transactions: StripeTransaction[]): CheckoutSnapshot {
  return {
    sessionId: order.checkoutSessionId!,
    clientReferenceId: order.id,
    metadataOrderId: order.id,
    livemode: false,
    status: 'complete',
    paymentStatus: 'paid',
    currency: 'usd',
    amountSubtotalMinor: order.unitAmountMinor,
    amountTaxMinor: 0,
    amountTotalMinor: order.unitAmountMinor,
    paymentIntentId: 'pi_sale',
    paymentIntentStatus: 'succeeded',
    chargeId: 'ch_sale',
    chargeAmountMinor: order.unitAmountMinor,
    refunds: [],
    disputes: [],
    transactions,
    observedAt: new Date().toISOString(),
  };
}

test('native Commerce evidence registration links scoped signed movements once without posting or reserving funds', async () => {
  const bookId = `commerce-evidence:${crypto.randomUUID()}`;
  const namespace = `test_${crypto.randomUUID()}`;
  initializeEventTypes();
  for (const id of [buyer, creator]) {
    await pool.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
  }
  const config = { bookId, namespace, currency: 'usd', mode: 'test', unit } as const;
  const port = createNativeEconomyCommerceEvidence(pool, config);
  const ledger = createEconomyLedger(createNativeEconomyDatabase(pool), bookId);
  const assetId = 'demo-usd';
  const creatorAsset = { creatorId: creator, assetId };
  const wallet = { accountId: buyer, assetId };
  expect(await ledger.provisionAsset({ id: assetId, scale: 2, transferable: true })).toMatchObject({ kind: 'ok' });
  expect(await ledger.issue({ ...wallet, operationId: 'fixture-wallet', amount: '100' })).toMatchObject({ kind: 'ok' });
  expect(
    await ledger.reserve({
      ...wallet,
      operationId: 'fixture-hold',
      holdId: 'fixture-hold',
      amount: '10',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  ).toMatchObject({ kind: 'ok' });
  expect(
    await ledger.creatorClearing.accrue({
      ...creatorAsset,
      units: '80',
      source: { namespace: 'fixture', id: bookId },
      expenseReference: 'fixture-expense',
    }),
  ).toMatchObject({ kind: 'ok' });
  expect(
    await ledger.creatorClearing.reservePayout({
      ...creatorAsset,
      units: '25',
      payoutId: 'fixture-payout',
      provider: { namespace, mode: 'test', destinationRef: 'fixture' },
    }),
  ).toMatchObject({ kind: 'ok' });

  async function economyState() {
    const counts = await pool.query(
      `SELECT (SELECT count(*) FROM economy.journal WHERE book_id=$1) AS journal,
              (SELECT count(*) FROM economy.entry WHERE book_id=$1) AS entries,
              (SELECT count(*) FROM economy.hold WHERE book_id=$1) AS holds,
              (SELECT count(*) FROM economy.hold_allocation WHERE book_id=$1) AS allocations,
              (SELECT count(*) FROM economy.creator_posting WHERE book_id=$1) AS creator,
              (SELECT count(*) FROM economy.provider_posting_key WHERE provider_namespace=$2 AND provider_mode='test') AS provider,
              (SELECT count(*) FROM economy.funding_posting WHERE book_id=$1) AS funding`,
      [bookId, namespace],
    );
    return {
      counts: counts.rows[0],
      wallet: await ledger.readBalance(wallet),
      payable: await ledger.creatorClearing.readPayable(creatorAsset),
      payout: await ledger.creatorClearing.readPayout('fixture-payout'),
    };
  }
  const before = await economyState();
  const existingEnvironment = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    expect(() => createNativeEconomyCommerceEvidence(pool, config)).toThrow(
      'Invalid Economy Commerce test evidence bindings',
    );
    delete process.env.NODE_ENV;
    expect(() => createNativeEconomyCommerceEvidence(pool, config)).toThrow(
      'Invalid Economy Commerce test evidence bindings',
    );
  } finally {
    if (existingEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = existingEnvironment;
  }

  async function recordMovements(nativeOrder: Order, movements: StripeTransaction[], live = false, known = true) {
    const state = snapshot(nativeOrder, movements);
    const lineage = {
      accountNamespace: namespace,
      livemode: live,
      requestApiVersion: '2026-02-25.clover',
      responseApiVersion: null,
    };
    await commands.applyCheckoutSnapshot(
      {
        ...state,
        livemode: live,
        integrationMoneyUnit: unit,
        moneyProvenance: {
          ...lineage,
          objectId: state.sessionId,
          object: 'checkout.session',
          context: 'checkout.integration',
        },
        transactions: movements.map((movement) => ({
          ...movement,
          moneyUnit: known ? unit : null,
          moneyProvenance: {
            ...lineage,
            objectId: movement.id,
            object: 'balance_transaction',
            context: 'balance_transaction',
          },
        })),
      },
      key(),
    );
  }
  const input = (orderId: string, movementId: string) => ({ orderId, movementId, deadline: Date.now() + 10_000 });
  const sale = await order();
  const charge = transaction('charge', 1000, 31);
  const refund = transaction('refund', -125, -4);
  const refundReversal = { ...transaction('refund_reversal', 125, 4), sourceId: refund.sourceId };
  const dispute = transaction('dispute', -200, 13);
  const disputeReversal = { ...transaction('dispute_reversal', 200, -13), sourceId: dispute.sourceId };
  const movements = [charge, refund, refundReversal, dispute, disputeReversal];
  await recordMovements(sale, movements);
  expect(await port.register(input(sale.id, charge.id))).toEqual({ kind: 'unresolved' });
  const attributed = await payouts.recordTransactions(
    sale.id,
    movements.map((movement) => movement.id),
    key(),
  );
  expect(attributed).toMatchObject({ value: [expect.objectContaining({ creatorAccountId: creator })] });
  const accepted = (movementId: string) => ({ kind: 'ok', value: { namespace, mode: 'test', movementId } }) as const;
  // Redeliver concurrently, then recreate the owner port and retry without either result.
  expect(
    await Promise.all([port.register(input(sale.id, charge.id)), port.register(input(sale.id, charge.id))]),
  ).toEqual([accepted(charge.id), accepted(charge.id)]);
  expect(await createNativeEconomyCommerceEvidence(pool, config).register(input(sale.id, charge.id))).toEqual(
    accepted(charge.id),
  );
  for (const movement of movements.slice(1)) {
    expect(await port.register(input(sale.id, movement.id))).toEqual(accepted(movement.id));
  }

  const other = await order();
  expect(await port.register(input(other.id, charge.id))).toEqual({ kind: 'operation_conflict' });
  const otherBook = `other:${crypto.randomUUID()}`;
  expect(
    await createEconomyLedger(createNativeEconomyDatabase(pool), otherBook).provisionAsset({
      id: assetId,
      scale: 2,
      transferable: true,
    }),
  ).toMatchObject({ kind: 'ok' });
  const foreignBook = createNativeEconomyCommerceEvidence(pool, { ...config, bookId: otherBook });
  expect(await foreignBook.register(input(sale.id, charge.id))).toEqual({ kind: 'operation_conflict' });
  const otherProvider = createNativeEconomyCommerceEvidence(pool, { ...config, namespace: 'other_provider' });
  expect(await otherProvider.register(input(sale.id, charge.id))).toEqual({ kind: 'unresolved' });

  const source = await readCreatorFinancialSource(pool, config, input(sale.id, charge.id));
  if (source.kind !== 'ok') throw new Error('Expected named provider and creator evidence');
  expect(
    await registerCommerceEvidence(createNativeEconomyDatabase(pool), bookId, namespace, {
      ...source.value,
      economicDigest: 'f'.repeat(64),
    }),
  ).toEqual({ kind: 'operation_conflict' });
  await expect(recordMovements(sale, [{ ...charge, feeMinor: 32, netMinor: 968 }])).rejects.toBeInstanceOf(
    MovementIntegrityError,
  );

  for (const [live, known] of [
    [true, true],
    [false, false],
  ] as const) {
    const separate = await order();
    const charge = transaction('charge', 1000, 31);
    await recordMovements(separate, [charge], live, known);
    if (known)
      expect(await payouts.recordTransactions(separate.id, [charge.id], key())).toMatchObject({
        value: [expect.objectContaining({ creatorAccountId: creator })],
      });
    expect(await port.register(input(separate.id, charge.id))).toEqual({ kind: 'unresolved' });
  }

  // A historical bigint can round to the same JavaScript number used by an old observation.
  const legacy = await order();
  const legacyMovement = transaction('charge', Number.MAX_SAFE_INTEGER + 1);
  const legacyAmount = '9007199254740993';
  await pool.query(
    `INSERT INTO commerce.order_transaction
      (route, order_id, balance_transaction_id, kind, source_id, currency, amount_minor, fee_minor, net_minor,
       fee_details, stripe_created, recorded_at, transaction_id)
     VALUES ($1,$2,$3,'charge',$4,'usd',$5,0,$5,'[]',$6,statement_timestamp(),$7)`,
    [
      routeOf(legacy.id),
      legacy.id,
      legacyMovement.id,
      legacyMovement.sourceId,
      legacyAmount,
      legacyMovement.created,
      key(),
    ],
  );
  await recordMovements(legacy, [legacyMovement]);
  await pool.query(
    `INSERT INTO commerce.royalty_line
       (route, balance_transaction_id, creator_account_id, order_id, offer_id, kind, currency, money_unit,
        gross_minor, tax_minor, fee_minor, dispute_fee_minor, net_receipts_minor, royalty_basis_points,
        period, statement_id, stripe_created, recorded_at)
     SELECT route, $1, creator_account_id, $2, $3, kind, currency, money_unit, $4, 0, 0, 0, $4,
            royalty_basis_points, period, statement_id, stripe_created, recorded_at
     FROM commerce.royalty_line WHERE route=$5 AND balance_transaction_id=$6`,
    [legacyMovement.id, legacy.id, legacy.offerId, legacyAmount, routeOf(creator), charge.id],
  );
  expect(await port.register(input(legacy.id, legacyMovement.id))).toEqual({ kind: 'unresolved' });

  const { rows } = await pool.query(
    `SELECT movement_id AS id, movement_kind AS kind, order_id AS "orderId", creator_id AS "creatorId",
            offer_id AS "offerId", source_id AS "sourceId", amount_minor::text AS amount, fee_minor::text AS fee,
            net_minor::text AS net, currency, unit
     FROM economy.commerce_evidence_receipt WHERE provider_namespace=$1 ORDER BY movement_id`,
    [namespace],
  );
  expect(rows).toEqual(
    movements
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((movement) => ({
        id: movement.id,
        kind: movement.kind,
        orderId: sale.id,
        creatorId: creator,
        offerId: sale.offerId,
        sourceId: movement.sourceId,
        amount: String(movement.amountMinor),
        fee: String(movement.feeMinor),
        net: String(movement.netMinor),
        currency: 'usd',
        unit,
      })),
  );
  await expect(
    pool.query('UPDATE economy.commerce_evidence_receipt SET fee_minor = fee_minor WHERE provider_namespace = $1', [
      namespace,
    ]),
  ).rejects.toMatchObject({ code: '23514' });
  expect(await economyState()).toEqual(before);
}, 90_000);
