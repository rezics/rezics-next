import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { routeOf } from '../../src/route/route.ts';
import { capture, checkGrowth, costOf } from '../support/growth.ts';
import { purchaseHistoryFixture, type HistoryFixture } from './support/purchase-history-fixture.ts';

setDefaultTimeout(360_000);
let f: HistoryFixture;
beforeAll(async () => {
  f = await purchaseHistoryFixture();
}, 360_000);
afterAll(async () => f?.close());
function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value as Record<string, unknown>, ...Object.values(value).flatMap(nodes)];
}

test('native buyer pages seek bounded indexed rows at increasing history, unrelated orders and cursor depth', async () => {
  // The selected page contains a real paid entitlement; every history neighbour is a native order command.
  const paid = await f.checkout();
  f.fake.pay(paid.checkoutSessionId!);
  await f.event('checkout.session.completed', paid.checkoutSessionId!);
  const buyer = await f.actor(f.people.alice),
    peer = await f.actor(f.peer),
    unrelated = await f.actor(f.people.bob);
  expect(routeOf(buyer.accountId)).toBe(routeOf(peer.accountId));
  expect(routeOf(buyer.accountId)).not.toBe(routeOf(unrelated.accountId));
  const client = f.client();
  let deep: string | undefined;
  async function read(cursor?: string) {
    const response = await client.orders.get({ query: { limit: 5, ...(cursor ? { cursor } : {}) } });
    expect(response.status).toBe(200);
    if (response.error) throw new Error(JSON.stringify(response.error));
    expect(response.data!.orders).toHaveLength(5);
    return response.data!;
  }
  const report = await checkGrowth(f.db, {
    name: 'buyer order history: native buyer, same-route peer and foreign partition histories with increasing depth',
    scales: [32, 128, 512],
    bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
    indexProbes: 18,
    async grow(_, scale, previous) {
      for (let i = previous; i < scale; i++) {
        for (const actor of [buyer, peer, unrelated])
          await f.commands.createOrder(actor, f.offer.id, Bun.randomUUIDv7());
        if (i % 8 === 0) {
          const paid = await f.checkout();
          f.fake.pay(paid.checkoutSessionId!);
          await f.event('checkout.session.completed', paid.checkoutSessionId!);
        }
      }
      // Obtain the deep key only through the public signed list, never by forging a cursor.
      let cursor: string | undefined;
      for (let offset = 0; offset < scale - 16; offset += 5) {
        const history = await read(cursor);
        expect(history.next).toBeString();
        cursor = history.next!;
      }
      deep = cursor;
    },
    async operation() {
      await read();
      await read(deep);
    },
    async warmup() {
      const measured = await capture(f.db, async () => {
        await read();
        await read(deep);
      });
      const sql = measured.capture.statements;
      const pages = sql.filter((text) => /WITH page AS MATERIALIZED/.test(text));
      expect(pages).toHaveLength(2);
      expect(sql.filter((text) => /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/i.test(text))).toHaveLength(2);
      for (const page of pages) {
        expect(page).toMatch(/buyer_account_id\s*=/);
        expect(page).toMatch(/order_id\s*</);
        expect(page).not.toMatch(/\bOFFSET\b|\bCOUNT\s*\(/i);
      }
      const plans = nodes(measured.capture.plans);
      const keysets = plans.filter((node) => node['Index Name'] === 'purchase_order_buyer_page');
      expect(keysets).toHaveLength(2);
      for (const plan of keysets) {
        expect(plan['Index Cond']).toContain('route =');
        expect(plan['Index Cond']).toContain('buyer_account_id =');
        expect(plan['Index Cond']).toContain('order_id <');
        expect(plan['Actual Rows']).toBe(6);
        expect(plan['Rows Removed by Filter'] ?? 0).toBe(0);
      }
      const cost = costOf(measured.capture);
      expect(cost.relations['commerce.purchase_order']!.sequentialScans).toBe(0);
      expect(cost.relations['commerce.purchase_order']!.rows).toBe(12);
      expect(cost.relations['commerce.entitlement']?.rows ?? 0).toBeLessThanOrEqual(12);
      expect(sql.some((text) => /FROM commerce\.offer/i.test(text))).toBe(false);
    },
  });
  console.info('buyer order page growth', JSON.stringify(report));
  for (const sample of report.samples)
    for (const cost of sample.repetitions) {
      expect(cost.relations['commerce.purchase_order']!.rows).toBe(12);
      expect(cost.relations['commerce.purchase_order']!.sequentialScans).toBe(0);
    }
});
