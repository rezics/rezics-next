import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { PoolClient, QueryConfig } from 'pg';
import { createPayouts } from '../../src/commerce/payouts.ts';
import type { Order, StripeTransaction } from '../../src/commerce/model.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { readSettlementState } from '../../src/commerce/store.ts';
import { capture, checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { classifySeries, type GrowthModelBound } from '../support/growth-model.ts';
import { nativeAnchorFixture } from './support/checkout-anchor.ts';
import {
  observeTransactionGrowth,
  type TransactionGrowthFrame,
  type TransactionGrowthObservation,
} from './support/transaction-growth-observation.ts';
import { workFixture } from './support/work-fixture.ts';

setDefaultTimeout(360_000);

let fixture: Awaited<ReturnType<typeof workFixture>>;
let growthDatabase: Awaited<ReturnType<typeof openGrowthDatabase>>;
const connections = new Set<PoolClient>();
beforeAll(async () => {
  growthDatabase = await openGrowthDatabase(process.env.DATABASE_URL);
  fixture = await workFixture({ pool: growthDatabase.pool });
  fixture.pool.on('connect', (connection) => connections.add(connection));
});
afterAll(async () => {
  try {
    await fixture?.close();
  } finally {
    await growthDatabase?.close();
  }
});

const transaction = (id: string): StripeTransaction => ({
  id,
  kind: 'refund_reversal',
  sourceId: 're_growth',
  currency: 'usd',
  amountMinor: 1,
  feeMinor: 0,
  netMinor: 1,
  feeDetails: [],
  exchangeRate: null,
  created: '2026-01-01T00:00:00.000Z',
});

const namedScales = [64, 512, 4096] as const;
const perOrderHistoryLimit = 255;
type HistoryAxis = 'transactions' | 'orders' | 'receipts';
type NamedOperation = 'settlement-first-apply' | 'settlement-replay' | 'royalty-first-apply';

async function insertOrderRows(database: GrowthDatabase, anchor: Order, count: number) {
  if (!count) return [] as string[];
  const route = routeOf(anchor.id);
  if (route === null) throw new Error('Growth anchor order has no route');
  const now = new Date().toISOString();
  const rows = Array.from({ length: count }, () => ({
    route,
    order_id: newId(route),
    buyer_account_id: anchor.buyerAccountId,
    offer_id: anchor.offerId,
    offer_revision: anchor.offerRevision,
    creator_account_id: anchor.creatorAccountId,
    title: anchor.title,
    currency: anchor.currency,
    unit_amount_minor: anchor.unitAmountMinor,
    tax_code: anchor.taxCode,
    royalty_basis_points: anchor.royaltyBasisPoints,
    settlement: 'pending',
    checkout_session_id: null,
    checkout_url: null,
    checkout_expires_at: null,
    payment_intent_id: null,
    observed_at: null,
    created_at: now,
    updated_at: now,
    revision: 1,
    transaction_id: newId(route),
    amount_tax_minor: null,
    target_subject_id: anchor.targetSubjectId,
  }));
  await database.admin.query(
    `INSERT INTO commerce.purchase_order (
       route, order_id, buyer_account_id, offer_id, offer_revision, creator_account_id, title,
       currency, unit_amount_minor, tax_code, royalty_basis_points, settlement, checkout_session_id,
       checkout_url, checkout_expires_at, payment_intent_id, observed_at, created_at, updated_at,
       revision, transaction_id, amount_tax_minor, target_subject_id
     )
     SELECT route, order_id, buyer_account_id, offer_id, offer_revision, creator_account_id, title,
       currency, unit_amount_minor, tax_code, royalty_basis_points, settlement, checkout_session_id,
       checkout_url, checkout_expires_at, payment_intent_id, observed_at, created_at, updated_at,
       revision, transaction_id, amount_tax_minor, target_subject_id
     FROM jsonb_to_recordset($1::jsonb) AS x(
       route int, order_id uuid, buyer_account_id uuid, offer_id uuid, offer_revision int,
       creator_account_id uuid, title text, currency text, unit_amount_minor bigint, tax_code text,
       royalty_basis_points int, settlement text, checkout_session_id text, checkout_url text,
       checkout_expires_at timestamptz, payment_intent_id text, observed_at timestamptz,
       created_at timestamptz, updated_at timestamptz, revision int, transaction_id uuid,
       amount_tax_minor bigint, target_subject_id uuid
     )`,
    [JSON.stringify(rows)],
  );
  return rows.map(({ order_id }) => order_id);
}

async function growTransactionRows(
  database: GrowthDatabase,
  route: number,
  parentIds: readonly string[],
  from: number,
  to: number,
) {
  if (from === to) return;
  if (!parentIds.length) throw new Error('Transaction growth needs fixed unrelated order anchors');
  const rows = Array.from({ length: to - from }, (_, offset) => {
    const ordinal = from + offset;
    return {
      route,
      order_id: parentIds[ordinal % parentIds.length],
      balance_transaction_id: `txn_growthn${ordinal}`,
      kind: 'refund_reversal',
      source_id: 're_growth',
      currency: 'usd',
      amount_minor: 1,
      fee_minor: 0,
      net_minor: 1,
      fee_details: [],
      exchange_rate: null,
      stripe_created: '2026-01-01T00:00:00.000Z',
      recorded_at: '2026-01-01T00:00:00.000Z',
      transaction_id: newId(route),
    };
  });
  await database.admin.query(
    `INSERT INTO commerce.order_transaction (
       route, order_id, balance_transaction_id, kind, source_id, currency, amount_minor, fee_minor,
       net_minor, fee_details, exchange_rate, stripe_created, recorded_at, transaction_id
     )
     SELECT route, order_id, balance_transaction_id, kind, source_id, currency, amount_minor, fee_minor,
       net_minor, fee_details, exchange_rate, stripe_created, recorded_at, transaction_id
     FROM jsonb_to_recordset($1::jsonb) AS x(
       route int, order_id uuid, balance_transaction_id text, kind text, source_id text, currency text,
       amount_minor bigint, fee_minor bigint, net_minor bigint, fee_details jsonb, exchange_rate numeric,
       stripe_created timestamptz, recorded_at timestamptz, transaction_id uuid
     )`,
    [JSON.stringify(rows)],
  );
}

async function growReceiptRows(
  database: GrowthDatabase,
  partition: number,
  principalId: string,
  commandKind: string,
  from: number,
  to: number,
) {
  if (from === to) return;
  const rows = Array.from({ length: to - from }, (_, offset) => ({
    idempotency_key: `growth_history_${from + offset}`,
    transaction_id: crypto.randomUUID(),
    position: 1_000_000 + from + offset,
  }));
  await database.admin.query(
    `INSERT INTO core.receipt (
       partition_no, principal_kind, principal_id, command_kind, idempotency_key,
       request_digest, epoch, position, transaction_id, response
     )
     SELECT $2, 'account', $3, $4, idempotency_key, decode(repeat('00', 32), 'hex'),
       1, position, transaction_id, '{}'::jsonb
     FROM jsonb_to_recordset($1::jsonb) AS x(idempotency_key text, transaction_id uuid, position bigint)`,
    [JSON.stringify(rows), partition, principalId, commandKind],
  );
}

function indexProbeBudget(axis: HistoryAxis, operation: NamedOperation) {
  // Count only anchored descents into the independently growing relation: order identity reads/locks,
  // named transaction/probe keys, and the command receipt key plus its unique insert.
  if (operation === 'settlement-replay') return axis === 'receipts' ? 1 : 0;
  if (axis === 'transactions') return operation === 'settlement-first-apply' ? 4 : 1;
  if (axis === 'orders')
    return operation === 'settlement-first-apply' ? 4 : operation === 'royalty-first-apply' ? 1 : 0;
  return 2;
}

function isHistoryProbe(statement: string): boolean {
  return (
    /SELECT\s+1\s+AS\s+present/i.test(statement) &&
    /FROM commerce\.order_transaction\b/i.test(statement) &&
    /LIMIT\s+257\b/i.test(statement)
  );
}

function classify(values: readonly { readonly scale: number; readonly value: number }[], bound: GrowthModelBound) {
  return classifySeries(
    values.map(({ scale, value }) => ({ scale, repetitions: [value], uncertainty: 0 })),
    bound,
  );
}

// One method seeds both the buyer history and the creator's already recorded lines at every scale.
async function seed(length: number) {
  const { order, session } = await fixture.checkout();
  fixture.transport.fake.pay(session.id);
  const snapshot = await fixture.stripe.readCheckout(session.id);
  snapshot.transactions = [
    snapshot.transactions[0]!,
    ...Array.from({ length: length - 1 }, (_, n) => transaction(`txn_seed${length}n${n}`)),
  ];
  await fixture.commands.applyCheckoutSnapshot(snapshot, `growth:seed:${length}`);
  const payouts = createPayouts({ pool: fixture.pool });
  await payouts.recordTransactions(
    order.id,
    snapshot.transactions.map((t) => t.id),
    `growth:royalty:seed:${length}`,
  );
  return { order, snapshot, payouts };
}

test('settlement and royalty read only named keys with equal statements and returned rows at histories 1, 64 and 255', async () => {
  const observations: TransactionGrowthObservation[] = [];
  const measurements: { statements: number; returnedRows: number }[][] = [];
  async function record<T>(
    frame: TransactionGrowthFrame,
    operation: () => Promise<T>,
  ): Promise<{ readonly value: T; readonly observation: TransactionGrowthObservation<T> }> {
    const observation = await observeTransactionGrowth(growthDatabase, frame, operation);
    observations.push(observation);
    const captured = observation.capture;
    expect(observation.outcome.kind).toBe('completed');
    expect(observation.attemptLedgerError).toBeUndefined();
    expect(captured.plans.length).toBeGreaterThan(0);
    expect(captured.statementBackends).toHaveLength(captured.statements.length);
    expect(captured.statementBackends!.every((backend) => Number.isSafeInteger(backend))).toBe(true);
    expect(captured.planStatements).toHaveLength(captured.plans.length);
    expect(captured.planBackends).toHaveLength(captured.plans.length);
    expect(
      captured.planStatements!.every(
        (owner) => owner !== undefined && owner >= 0 && owner < captured.statements.length,
      ),
    ).toBe(true);
    expect(captured.planBackends!.every((backend) => Number.isSafeInteger(backend))).toBe(true);
    expect(captured.statementErrors).toHaveLength(captured.statements.length);
    expect(observation.occurrences.statements).toHaveLength(captured.statements.length);
    expect(observation.statementAttributions.length).toBeGreaterThan(0);
    for (const attempt of observation.attempts ?? []) {
      expect(attempt.occurrences.length).toBeGreaterThan(0);
      expect(attempt.occurrences.every((index) => index >= 0 && index < captured.statements.length)).toBe(true);
    }
    if (captured.requestBytes !== undefined)
      expect(observation.cost.requestBytes).toBe(captured.requestBytes.reduce((sum, bytes) => sum + bytes, 0));
    if (captured.responseBytes !== undefined)
      expect(observation.cost.responseBytes).toBe(captured.responseBytes.reduce((sum, bytes) => sum + bytes, 0));
    if (
      (captured.backgroundStatements?.length ?? 0) > 0 ||
      (captured.backgroundRequestBytes?.length ?? 0) > 0 ||
      (captured.backgroundResponseBytes?.length ?? 0) > 0
    ) {
      if (captured.backgroundRequestBytes !== undefined)
        expect(observation.cost.backgroundRequestBytes).toBe(
          captured.backgroundRequestBytes.reduce((sum, bytes) => sum + bytes, 0),
        );
      if (captured.backgroundResponseBytes !== undefined)
        expect(observation.cost.backgroundResponseBytes).toBe(
          captured.backgroundResponseBytes.reduce((sum, bytes) => sum + bytes, 0),
        );
    }
    if (observation.outcome.kind === 'failed')
      throw new Error(`${observation.outcome.name}: ${observation.outcome.message}`);
    return { value: observation.outcome.value, observation };
  }
  for (const length of [1, 64, 255]) {
    const { order, snapshot, payouts } = await seed(length);
    const next = transaction(`txn_change${length}`);
    snapshot.transactions = [next];
    snapshot.observedAt = new Date(Date.parse(snapshot.observedAt) + 1000).toISOString();
    let captured: { sql: string; rows: number; values: unknown }[] | undefined;
    const originals = new Map<PoolClient, PoolClient['query']>();
    function instrument(connection: PoolClient) {
      if (originals.has(connection)) return;
      const original = connection.query;
      originals.set(connection, original);
      connection.query = ((sql: string | QueryConfig, ...args: unknown[]) => {
        const text = typeof sql === 'string' ? sql : sql.text;
        function record(result: { rowCount: number | null }) {
          if (/commerce\.|INSERT INTO access\.resource_role_grant/.test(text))
            captured?.push({
              sql: text,
              rows: result.rowCount ?? 0,
              values: typeof sql === 'string' ? args[0] : sql.values,
            });
        }
        // Pool.query uses callbacks; the SQL adapters also call promise-style Client.query.
        const callback = args.at(-1);
        if (typeof callback === 'function') {
          args[args.length - 1] = (error: Error | null, result: { rowCount: number | null }) => {
            if (!error) record(result);
            callback(error, result);
          };
          return Reflect.apply(original, connection, [sql, ...args]);
        }
        return Reflect.apply(original, connection, [sql, ...args]).then((result: { rowCount: number | null }) => {
          record(result);
          return result;
        });
      }) as typeof original;
    }
    // Include idle clients established before instrumentation was registered.
    const client = await fixture.pool.connect();
    connections.add(client);
    client.release();
    for (const connection of connections) instrument(connection);
    fixture.pool.on('connect', instrument);
    const measured: { statements: number; returnedRows: number }[] = [];
    try {
      for (const { phase, attemptId, run } of [
        {
          phase: 'settlement' as const,
          attemptId: `growth:settle:${length}`,
          run: () => fixture.commands.applyCheckoutSnapshot(snapshot, `growth:settle:${length}`),
        },
        {
          phase: 'royalty' as const,
          attemptId: `growth:royalty:${length}`,
          run: () => payouts.recordTransactions(order.id, [next.id], `growth:royalty:${length}`),
        },
      ]) {
        captured = [];
        const { observation } = await record({ attemptId, phase, scale: length, repetition: 0 }, run);
        const queries = captured ?? [];
        captured = undefined;
        const probes = queries.filter((query) => isHistoryProbe(query.sql));
        expect(probes.length).toBeLessThanOrEqual(1);
        for (const probe of probes) expect(probe.rows).toBeLessThanOrEqual(257);
        const physicalProbes = observation.occurrences.statements.filter(({ statement }) => isHistoryProbe(statement));
        expect(physicalProbes).toHaveLength(probes.length);
        for (const probe of physicalProbes) {
          expect(probe.plans.length).toBeGreaterThan(0);
          expect(probe.rows).toBeLessThanOrEqual(257);
        }
        const reads = queries.filter(
          (query) => /FROM commerce\.order_transaction\b/i.test(query.sql) && !probes.includes(query),
        );
        expect(reads).toHaveLength(1);
        expect(reads[0]!.sql).toMatch(/balance_transaction_id\s*=\s*ANY\s*\(/i);
        expect(reads[0]!.rows).toBeLessThanOrEqual(1);
        expect(JSON.stringify(reads[0]!.values)).toContain(next.id);
        const physicalReads = observation.occurrences.statements.filter(
          ({ statement }) => /FROM commerce\.order_transaction\b/i.test(statement) && !isHistoryProbe(statement),
        );
        expect(physicalReads).toHaveLength(1);
        expect(physicalReads[0]!.statement).toMatch(/balance_transaction_id\s*=\s*ANY\s*\(/i);
        expect(physicalReads[0]!.plans.length).toBeGreaterThan(0);
        expect(physicalReads[0]!.rows).toBeLessThanOrEqual(1);
        // Keep the original returned-row comparison separate from the physical plan measurements below.
        measured.push({
          statements: queries.length,
          returnedRows: queries
            .filter((query) => !isHistoryProbe(query.sql))
            .reduce((sum, query) => sum + query.rows, 0),
        });
        expect(queries.some((q) => /FROM commerce.offer\b/.test(q.sql))).toBe(false);
        const recording = queries.find((q) => /INSERT INTO commerce.royalty_line/.test(q.sql));
        if (recording) {
          expect(JSON.stringify(recording.values)).toContain(next.id);
          expect(JSON.stringify(recording.values)).not.toContain('txn_seed');
          // Order, named transactions, statement upsert, and the in-transaction Access port.
          expect(queries).toHaveLength(4);
          expect(queries.filter((q) => /INSERT INTO access\.resource_role_grant/.test(q.sql))).toHaveLength(1);
        }
      }
    } finally {
      captured = undefined;
      fixture.pool.off('connect', instrument);
      for (const [connection, original] of originals) connection.query = original;
    }
    measurements.push(measured);
    const state = await readSettlementState(fixture.pool, routeOf(order.id)!, order.id, [next.id, 'txn_absent']);
    expect(state!.transactionIds).toEqual([next.id]);
    const before = (
      await fixture.pool.query('SELECT * FROM commerce.payout_statement WHERE route=$1', [
        routeOf(order.creatorAccountId),
      ])
    ).rows;
    const replay = await record(
      { attemptId: `growth:replay:${length}`, phase: 'settlement', scale: length, repetition: 1 },
      () => fixture.commands.applyCheckoutSnapshot(snapshot, `growth:replay:${length}`),
    );
    expect(replay.value).toMatchObject({ changed: false });
    await record({ attemptId: `growth:royalty:${length}`, phase: 'royalty', scale: length, repetition: 1 }, () =>
      payouts.recordTransactions(order.id, [next.id], `growth:royalty:${length}`),
    );
    const redelivery = await record(
      { attemptId: `growth:redelivery:${length}`, phase: 'royalty', scale: length, repetition: 2 },
      () => payouts.recordTransactions(order.id, [next.id], `growth:redelivery:${length}`),
    );
    expect(redelivery.value).toMatchObject({ changed: false });
    expect(
      (
        await fixture.pool.query('SELECT * FROM commerce.payout_statement WHERE route=$1', [
          routeOf(order.creatorAccountId),
        ])
      ).rows,
    ).toEqual(before);
    expect(
      (
        await fixture.pool.query('SELECT count(*)::int n FROM commerce.royalty_line WHERE route=$1 AND order_id=$2', [
          routeOf(order.creatorAccountId),
          order.id,
        ])
      ).rows,
    ).toEqual([{ n: length + 1 }]);
  }
  expect(measurements[1]).toEqual(measurements[0]);
  expect(measurements[2]).toEqual(measurements[0]);

  expect(observations.map(({ frame }) => [frame.attemptId, frame.phase, frame.scale, frame.repetition])).toEqual(
    [1, 64, 255].flatMap((scale) => [
      [`growth:settle:${scale}`, 'settlement', scale, 0],
      [`growth:royalty:${scale}`, 'royalty', scale, 0],
      [`growth:replay:${scale}`, 'settlement', scale, 1],
      [`growth:royalty:${scale}`, 'royalty', scale, 1],
      [`growth:redelivery:${scale}`, 'royalty', scale, 2],
    ]),
  );

  for (const phase of ['settlement', 'royalty'] as const) {
    const series = observations
      .filter(({ frame }) => frame.phase === phase && frame.repetition === 0)
      .sort((left, right) => left.frame.scale - right.frame.scale);
    expect(series.map(({ frame }) => frame.scale)).toEqual([1, 64, 255]);
    const broadRows = series.map(({ frame, cost, occurrences }) => {
      const probeRows = occurrences.statements
        .filter(({ statement }) => isHistoryProbe(statement))
        .reduce((sum, occurrence) => sum + occurrence.rows, 0);
      expect(probeRows).toBeLessThanOrEqual(257);
      expect(cost.rows).toBeGreaterThanOrEqual(probeRows);
      // Keep the probe in complete cost; isolate its measured prefix only for broad-scan growth classification.
      return { scale: frame.scale, value: cost.rows - probeRows };
    });
    expect(
      classify(
        series.map(({ frame, cost }) => ({ scale: frame.scale, value: cost.statements })),
        'constant',
      ).outcome,
    ).toBe('compatible');
    expect(classify(broadRows, 'constant').outcome).toBe('compatible');
    expect(
      classify(
        series.map(({ frame, cost }) => ({ scale: frame.scale, value: cost.blocks })),
        'logarithmic',
      ).outcome,
    ).toBe('compatible');
  }
});

for (const axis of ['transactions', 'orders', 'receipts'] as const) {
  for (const operation of ['settlement-first-apply', 'settlement-replay', 'royalty-first-apply'] as const) {
    test(`Commerce ${operation} keeps native work bounded across unrelated ${axis}`, async () => {
      const native = await nativeAnchorFixture();
      try {
        const anchor = await native.checkout(true, false);
        const orderRoute = routeOf(anchor.id);
        if (orderRoute === null) throw new Error('Commerce growth anchor has no route');
        const payouts = createPayouts({ pool: native.db.pool });
        // Seventeen fixed parents keep all 4096 unrelated movements within the 255-row order cap.
        const parentOrders =
          axis === 'transactions'
            ? await insertOrderRows(native.db, anchor, Math.ceil(namedScales[2] / perOrderHistoryLimit))
            : [];
        const royaltyCase = operation === 'royalty-first-apply';
        const principalId = royaltyCase ? anchor.creatorAccountId : anchor.buyerAccountId;
        const receiptRoute = royaltyCase ? routeOf(principalId) : orderRoute;
        if (receiptRoute === null) throw new Error('Commerce receipt actor has no route');
        const receiptPartition = partitionOf(receiptRoute);
        const commandKind = royaltyCase ? 'commerce.royalty.record' : 'commerce.checkout.apply';

        async function prepareScenario() {
          const order = await native.checkout(true, false);
          const sessionId = order.checkoutSessionId;
          if (!sessionId) throw new Error('Commerce growth order has no Checkout Session');
          native.fake.pay(sessionId);
          const snapshot = await native.stripe.readCheckout(sessionId);
          const tag = crypto.randomUUID().replaceAll('-', '');
          snapshot.transactions = [
            snapshot.transactions[0]!,
            ...Array.from({ length: perOrderHistoryLimit - 1 }, (_, index) => transaction(`txn_seed${tag}n${index}`)),
          ];
          const seedIds = snapshot.transactions.map(({ id }) => id);
          expect(await native.commands.applyCheckoutSnapshot(snapshot, `growth:seed:${tag}`)).toMatchObject({
            changed: true,
          });
          expect(await payouts.recordTransactions(order.id, seedIds, `growth:royalty:seed:${tag}`)).toMatchObject({
            changed: true,
          });

          const next = transaction(`txn_change${tag}`);
          const delta = structuredClone(snapshot);
          delta.transactions = [next];
          delta.observedAt = new Date(Date.parse(snapshot.observedAt) + 1000).toISOString();
          const applyKey = `growth:settle:${tag}`;
          const royaltyKey = `growth:royalty:${tag}`;
          if (operation !== 'settlement-first-apply')
            expect(await native.commands.applyCheckoutSnapshot(delta, applyKey)).toMatchObject({
              changed: true,
            });
          return { order, delta, next, applyKey, royaltyKey };
        }

        async function runScenario(scenario: Awaited<ReturnType<typeof prepareScenario>>) {
          if (operation === 'royalty-first-apply') {
            const result = await payouts.recordTransactions(scenario.order.id, [scenario.next.id], scenario.royaltyKey);
            expect(result).toMatchObject({ changed: true });
            return result;
          }
          const result = await native.commands.applyCheckoutSnapshot(scenario.delta, scenario.applyKey);
          expect(result).toMatchObject({ changed: operation === 'settlement-first-apply' });
          return result;
        }

        // Prepare one fresh order for each warmup and measured sample before growth starts. Each
        // order carries the owner's maximum 255-row preexisting history; fixed setup rows therefore
        // do not co-grow with the unrelated history selected below.
        const scenarios = new Map<
          number,
          {
            warmup: Awaited<ReturnType<typeof prepareScenario>>;
            measured: Awaited<ReturnType<typeof prepareScenario>>;
          }
        >();
        for (const scale of namedScales)
          scenarios.set(scale, { warmup: await prepareScenario(), measured: await prepareScenario() });

        const report = await checkGrowth(native.db, {
          name: `Commerce ${operation} / unrelated ${axis}`,
          scales: namedScales,
          bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
          indexProbes: indexProbeBudget(axis, operation),
          includeBackends: true,
          repetitions: 1,
          warmups: 1,
          async grow(database, scale, previous) {
            if (axis === 'transactions') await growTransactionRows(database, orderRoute, parentOrders, previous, scale);
            else if (axis === 'orders') await insertOrderRows(database, anchor, scale - previous);
            else await growReceiptRows(database, receiptPartition, principalId, commandKind, previous, scale);
          },
          async warmup(_database, scale) {
            const scenario = scenarios.get(scale)?.warmup;
            if (!scenario) throw new Error(`Missing Commerce ${operation} warmup at ${scale}`);
            const measured = await capture(native.db, () => runScenario(scenario), { includeBackends: true });
            const safetyProbes = measured.capture.statements.filter(
              (sql) =>
                /SELECT\s+1\s+AS\s+present/i.test(sql) &&
                /FROM commerce\.order_transaction\b/i.test(sql) &&
                /LIMIT\s+257\b/i.test(sql),
            );
            expect(safetyProbes).toHaveLength(operation === 'settlement-first-apply' ? 1 : 0);
            expect(measured.capture.plans.length).toBeGreaterThan(0);
            expect(measured.capture.statements.some((sql) => /FROM core\.receipt\b/i.test(sql))).toBe(true);
            console.log(JSON.stringify({ axis, operation, scale, native: measured.capture }));
          },
          async operation(_database, scale) {
            const scenario = scenarios.get(scale)?.measured;
            if (!scenario) throw new Error(`Missing Commerce ${operation} measurement at ${scale}`);
            return runScenario(scenario);
          },
        });

        expect(report.samples.map(({ scale }) => scale)).toEqual([...namedScales]);
        for (const sample of report.samples) {
          const statements = sample.statementRepetitions.flat().map(({ statement }) => statement);
          const safetyProbes = statements.filter(
            (sql) =>
              /SELECT\s+1\s+AS\s+present/i.test(sql) &&
              /FROM commerce\.order_transaction\b/i.test(sql) &&
              /LIMIT\s+257\b/i.test(sql),
          );
          expect(safetyProbes).toHaveLength(operation === 'settlement-first-apply' ? 1 : 0);
          expect(sample.cost.statements).toBeGreaterThan(0);
          expect(sample.cost.plans).toBeGreaterThan(0);
          expect(sample.cost.rows).toBeGreaterThan(0);
          expect(sample.cost.blocks).toBeGreaterThan(0);
          expect(sample.cost.sharedHit + sample.cost.sharedRead).toBe(sample.cost.blocks);
        }
        console.log(JSON.stringify({ axis, operation, report }));
      } finally {
        await native.close();
      }
    });
  }
}
