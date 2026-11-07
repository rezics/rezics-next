import { expect, test } from 'bun:test';
import { admitCreatorSale } from '../../src/commerce/creator-sales-work.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

test('missing delegated source roles do not leave an unindexed Commerce receipt', async () => {
  const orderId = newId(160);
  const buyer = newId(161);
  const creator = newId(162);
  const eventId = newId(160);
  const route = routeOf(orderId)!;
  const partition = partitionOf(route);
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes('FROM core.outbox'))
        return {
          rows: [
            {
              event_seq: 1,
              id: eventId,
              type: 'com.rezics.commerce.order.updated.v1',
              subject: orderId,
              data: { orderId, revision: 2 },
              epoch: '1',
              payload_state: 'present',
            },
          ],
        };
      if (sql.includes('FROM commerce.purchase_order'))
        return {
          rows: [{ buyer_account_id: buyer, creator_account_id: creator, state: 'active', authn_fenced: false }],
        };
      if (sql.includes('FROM commerce.creator_sale_receipt')) return { rows: [] };
      if (sql.includes('FROM editorial.write_basis'))
        return { rows: [{ principal_kind: 'account', principal_id: buyer, delegated: true }] };
      if (sql.includes('FROM core.history_locator')) return { rows: [] };
      return { rows: [] };
    },
  };

  await admitCreatorSale(
    client as never,
    {
      id: eventId,
      source: `urn:rezics:log:${partition}.1`,
      sequence: '0000000000000000042',
      type: 'com.rezics.commerce.order.updated.v1',
    } as never,
  );

  expect(statements.some((sql) => sql.includes('INSERT INTO access.live_copy_business_inventory'))).toBe(false);
  expect(statements.some((sql) => sql.includes('INSERT INTO commerce.creator_sale_receipt'))).toBe(false);
  expect(statements.some((sql) => sql.includes('INSERT INTO commerce.creator_sale_work'))).toBe(false);
});
