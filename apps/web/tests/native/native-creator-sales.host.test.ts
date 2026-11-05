import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import {
  deliveredSale,
  salesPage,
  startNativeCreatorSalesFixture,
  type NativeCreatorSalesFixture,
  type SalesRecording,
} from './native-creator-sales-fixture.ts';

setDefaultTimeout(900_000);
let fixture: NativeCreatorSalesFixture | undefined;
afterAll(async () => {
  await fixture?.close();
}, 180_000);

function privateRecording(record: SalesRecording) {
  expect(record.document.address).toBe(record.requested.address);
  expect([200, 302, 303, 307]).toContain(record.document.status);
  expect(record.document.headers['cache-control']).toContain('no-store');
  expect(record.api.headers['cache-control']).toContain('no-store');
  const creatorWire = [record.api.body, record.document.body, ...record.serverFunctions.map((r) => r.body)].join('\n');
  expect(creatorWire).not.toContain(fixture!.accountIds.buyer);
  for (const key of [
    'buyerAccountId',
    'checkoutUrl',
    'checkoutSessionId',
    'paymentIntentId',
    'entitlementId',
    'royaltyBasisPoints',
  ])
    expect(creatorWire).not.toContain(`"${key}"`);
  for (const read of record.nativeReads) {
    expect(read.accountId).toBe(record.accountId);
    expect(read.cursor).toBe(record.requested.cursor);
    expect(new URL(read.address).searchParams.get('limit')).toBe('20');
  }
}

function positivePage(record: SalesRecording) {
  privateRecording(record);
  expect(record.current).toBe(record.requested.address);
  expect(record.document.status).toBe(200);
  expect(record.api.status, record.api.body).toBe(200);
  expect(record.api.headers['cache-control']).toBe('private, no-store');
  const page = salesPage(record.api);
  expect(page).not.toBeNull();
  expect(page!.sales.length).toBeGreaterThan(0);
  expect(page!.sales.length).toBeLessThanOrEqual(20);
  expect(record.nativeReads.length).toBeGreaterThan(0);
  expect(record.rendered.rows).toHaveLength(page!.sales.length);
  for (const sale of page!.sales) {
    expect(Object.keys(sale).sort()).toEqual(
      [
        'orderId',
        'offerId',
        'title',
        'targetSubjectId',
        'currency',
        'unitAmountMinor',
        'moneyUnit',
        'taxBehavior',
        'settlement',
        'createdAt',
      ].sort(),
    );
    expect(record.rendered.rows.some((row) => row.includes(sale.orderId))).toBe(true);
    expect(sale.settlement).toBe('paid');
    const source = fixture!.payments.find((payment) => payment.orderId === sale.orderId);
    expect(source).toBeDefined();
    expect(source!.creator).toBe(record.viewer);
    expect(source!.delivery!.creatorAccountId).toBe(record.accountId!);
    expect(deliveredSale(source!.delivery)).toBe(true);
  }
  expect(record.rendered.text).toContain('does not mean royalties were paid');
  // Global coverage remains explicitly incomplete even when individual rows have receiving results.
  if (page!.projectionState === 'preparing') expect(record.rendered.text).toContain('still being prepared');
  return page!;
}

test('signed native payments and delivered sale sources bind the current creator, original cursor and served Sales route', async () => {
  fixture = await startNativeCreatorSalesFixture();
  const prepared = await fixture.prepare();
  const first = await fixture.record('alice');
  expect(
    prepared.state,
    JSON.stringify({ stage: prepared.stage, response: prepared.response, payments: prepared.payments, sales: first }),
  ).toBe('available');
  expect(fixture.payments).toHaveLength(22);
  const firstPage = positivePage(first);
  expect(firstPage.sales).toHaveLength(20);
  expect(first.next).not.toBeNull();
  const originalCursor = first.next!.cursor;
  expect(first.rendered.next).not.toBeNull();
  expect(new URL(first.rendered.next!, fixture.stack.web).href).toBe(first.next!.address);
  expect(new URL(first.next!.address).searchParams.get('cursor')).toBe(originalCursor);

  const second = await fixture.record('alice', originalCursor);
  const secondPage = positivePage(second);
  expect(second.requested.cursor).toBe(originalCursor);
  expect(secondPage.sales).toHaveLength(1);
  expect(second.next).toBeNull();
  expect(second.rendered.next).toBeNull();
  const allIds = [...firstPage.sales, ...secondPage.sales].map((row) => row.orderId);
  expect(new Set(allIds).size).toBe(21);
  expect(allIds).toEqual(
    fixture.payments
      .filter((p) => p.creator === 'alice')
      .map((p) => p.orderId)
      .sort()
      .reverse(),
  );

  const bob = await fixture.record('bob');
  const bobPage = positivePage(bob);
  expect(bob.current).toBe(first.current);
  expect(bobPage.sales).toHaveLength(1);
  expect(bobPage.sales.every((row) => !allIds.includes(row.orderId))).toBe(true);
  const wrongViewerCursor = await fixture.record('bob', originalCursor);
  privateRecording(wrongViewerCursor);
  expect([400, 409]).toContain(wrongViewerCursor.api.status);
  expect(wrongViewerCursor.rendered.rows).toEqual([]);

  const payment = fixture.payments.find((p) => p.creator === 'alice')!;
  const refund = await fixture.refund(payment);
  expect(refund.webhook.status, refund.webhook.body).toBe(200);
  expect(JSON.parse(refund.order.body).order.settlement).toBe('paid');
  expect(refund.entitlement?.status).toBe(200);
  expect(JSON.parse(refund.entitlement!.body).entitlement).toMatchObject({ active: false, revokeReason: 'refund' });
  expect(deliveredSale(refund.delivery)).toBe(true);
  const refundCursor = firstPage.sales.some((row) => row.orderId === payment.orderId) ? undefined : originalCursor;
  const afterRefund = await fixture.record('alice', refundCursor);
  positivePage(afterRefund);
  expect(salesPage(afterRefund.api)!.sales.find((row) => row.orderId === payment.orderId)?.settlement).toBe('paid');

  const operator = await fixture.record('moderator');
  privateRecording(operator);
  expect(salesPage(operator.api)?.sales).toEqual([]);
  expect(operator.rendered.rows).toEqual([]);
  const repair = await fixture.payoutRepairAttempt(payment.orderId);
  expect([403, 404]).toContain(repair.status);

  const anonymous = await fixture.record('anonymous');
  privateRecording(anonymous);
  expect([401, 403]).toContain(anonymous.api.status);
  expect(anonymous.rendered.rows).toEqual([]);
  expect(
    anonymous.current === anonymous.requested.address
      ? anonymous.rendered.text.includes('cannot read sales history')
      : new URL(anonymous.current).pathname.includes('sign-in') ||
          new URL(anonymous.current).pathname.includes('login'),
  ).toBe(true);
  const retired = await fixture.retireAlice();
  expect(retired.status).toBeGreaterThanOrEqual(300);
  expect(retired.status).toBeLessThan(400);
  const replay = await fixture.record('alice', originalCursor);
  privateRecording(replay);
  expect([401, 403]).toContain(replay.api.status);
  expect(replay.rendered.rows).toEqual([]);
  for (const id of allIds) expect(replay.document.body).not.toContain(id);
});
