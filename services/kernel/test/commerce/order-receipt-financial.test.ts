import { expect, test } from 'bun:test';
import { orderReceiptMoney } from '../../src/commerce/order-read.ts';
import { readBuyerOrder } from '../../src/commerce/store.ts';
import { routeOf } from '../../src/route/route.ts';
import { costOf } from '../support/growth-cost.ts';
import { workFixture } from './support/work-fixture.ts';

test('receipt retains separate customer currency and bounds unrelated financial history', async () => {
  const f = await workFixture();
  try {
    const { order, session } = await f.checkout();
    const route = routeOf(order.id)!;
    expect((await readBuyerOrder(f.pool, route, order.id))?.recordedPresentment).toBeNull();
    f.transport.fake.pay(session.id);
    const snapshot = await f.providerStripe.readCheckout(session.id);
    const unit = {
      system: 'stripe-api',
      exponent: 2,
      factsVersion: 'stripe-money-v1',
    } as const;
    await f.commands.applyCheckoutSnapshot(
      {
        ...snapshot,
        presentment: { currency: 'cad', amountMinor: 1647, moneyUnit: unit },
      },
      `receipt:${order.id}`,
    );
    const expected = await readBuyerOrder(f.pool, route, order.id);
    expect(expected?.recordedCharge).toMatchObject({
      currency: 'usd',
      amountTotalMinor: snapshot.amountTotalMinor,
    });
    expect(expected?.recordedPresentment).toEqual({
      currency: 'cad',
      moneyUnit: unit,
      amountTotalMinor: 1647,
    });
    expect(orderReceiptMoney({ ...expected!.order, settlement: 'failed' }, null, null).recordedPresentment).toBeNull();
    expect(
      orderReceiptMoney(
        expected!.order,
        null,
        JSON.stringify({
          moneyUnit: null,
          amounts: { presentment_currency: 'cad', presentment_amount: 1647 },
        }),
      ).recordedPresentment,
    ).toBeNull();
    for (const count of [1, 8, 64]) {
      await f.pool.query(
        `INSERT INTO commerce.money_observation
         (route,order_id,buyer_account_id,provider_object_id,context,account_namespace,livemode,
          provider_api_version,request_api_version,response_api_version,money_unit,economics_hash,
          amounts,observed_at,recorded_at,transaction_id)
         SELECT route,order_id,buyer_account_id,'cs_unrelated_'||n,context,account_namespace,livemode,
          provider_api_version,request_api_version,response_api_version,money_unit,economics_hash,
          amounts,observed_at,recorded_at,transaction_id
         FROM commerce.money_observation CROSS JOIN generate_series(1,$3::int * 128) n
         WHERE route=$1 AND order_id=$2 AND provider_object_id=$4 ON CONFLICT DO NOTHING`,
        [route, order.id, count, session.id],
      );
      const plans: unknown[] = [];
      const statements: string[] = [];
      const client = {
        query: (async (sql: string, values: unknown[]) => {
          statements.push(sql);
          plans.push(
            (await f.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, values)).rows[0]['QUERY PLAN'],
          );
          return f.pool.query(sql, values);
        }) as typeof f.pool.query,
      };
      expect(await readBuyerOrder(client, route, order.id)).toEqual(expected);
      const cost = costOf({ plans, statements });
      expect(cost.statements).toBe(1);
      expect(cost.rows).toBeLessThanOrEqual(3);
      expect(cost.relations['commerce.money_observation']?.sequentialScans ?? 0).toBe(0);
    }
  } finally {
    await f.close();
  }
}, 30_000);
