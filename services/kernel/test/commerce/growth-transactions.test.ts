import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient, QueryConfig } from 'pg';
import { createPayouts } from '../../src/commerce/payouts.ts';
import type { StripeTransaction } from '../../src/commerce/model.ts';
import { readSettlementState } from '../../src/commerce/store.ts';
import { routeOf } from '../../src/route/route.ts';
import { workFixture } from './support/work-fixture.ts';

let fixture: Awaited<ReturnType<typeof workFixture>>;
const connections = new Set<PoolClient>();
beforeAll(async () => {
  fixture = await workFixture();
  fixture.pool.on('connect', (connection) => connections.add(connection));
});
afterAll(async () => {
  await fixture?.close();
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

test('settlement and royalty read only named keys with equal statements and rows at histories 1, 64 and 255', async () => {
  const measurements: { statements: number; rows: number }[][] = [];
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
    const measured: { statements: number; rows: number }[] = [];
    try {
      for (const run of [
        () => fixture.commands.applyCheckoutSnapshot(snapshot, `growth:settle:${length}`),
        () => payouts.recordTransactions(order.id, [next.id], `growth:royalty:${length}`),
      ]) {
        captured = [];
        await run();
        const queries = captured;
        captured = undefined;
        const probes = queries.filter(
          (q) =>
            /SELECT\s+1\s+AS\s+present/i.test(q.sql) &&
            /FROM commerce\.order_transaction\b/i.test(q.sql) &&
            /LIMIT\s+257\b/i.test(q.sql),
        );
        expect(probes.length).toBeLessThanOrEqual(1);
        for (const probe of probes) expect(probe.rows).toBeLessThanOrEqual(257);
        const reads = queries.filter((q) => /FROM commerce\.order_transaction\b/i.test(q.sql) && !probes.includes(q));
        expect(reads).toHaveLength(1);
        expect(reads[0]!.sql).toMatch(/balance_transaction_id\s*=\s*ANY\s*\(/i);
        expect(reads[0]!.rows).toBeLessThanOrEqual(1);
        expect(JSON.stringify(reads[0]!.values)).toContain(next.id);
        measured.push({
          statements: queries.length,
          rows: queries.filter((q) => !probes.includes(q)).reduce((sum, q) => sum + q.rows, 0),
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
    expect(await fixture.commands.applyCheckoutSnapshot(snapshot, `growth:replay:${length}`)).toMatchObject({
      changed: false,
    });
    await payouts.recordTransactions(order.id, [next.id], `growth:royalty:${length}`);
    expect(await payouts.recordTransactions(order.id, [next.id], `growth:redelivery:${length}`)).toMatchObject({
      changed: false,
    });
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
});
