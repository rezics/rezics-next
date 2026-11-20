import { afterAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createNativeEconomyLedger } from '../../src/composition/economy.ts';
import type { EconomyLedger, HoldAllocationKey } from '../../src/economy/contract.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

async function fixture(keepMs = 60_000) {
  const bookId = `test:${crypto.randomUUID()}`;
  const ledger = createNativeEconomyLedger(pool, bookId);
  const assetId = 'points';
  const accountId = crypto.randomUUID();
  const recipientId = crypto.randomUUID();
  const hold = { assetId, accountId, holdId: 'hold' };
  expect(await ledger.provisionAsset({ id: assetId, scale: 0, transferable: true })).toMatchObject({ kind: 'ok' });
  expect(await ledger.issue({ ...hold, operationId: 'issue', amount: '100' })).toMatchObject({ kind: 'ok' });
  const expiresAt = new Date(Date.now() + keepMs);
  expect(
    await ledger.reserve({ ...hold, operationId: 'reserve', amount: '70', expiresAt: expiresAt.toISOString() }),
  ).toMatchObject({ kind: 'ok' });
  return { ledger, bookId, hold, recipientId, expiresAt };
}

async function expectBalance(
  ledger: EconomyLedger,
  account: { accountId: string; assetId: string },
  posted: string,
  held: string,
  available: string,
) {
  expect(await ledger.readBalance(account)).toMatchObject({ kind: 'ok', value: { posted, held, available } });
}

test('exact partial release and final ordinary capture leave each named allocation protected', async () => {
  const { ledger, bookId, hold, recipientId } = await fixture();
  const spot = { ...hold, purpose: 'spot_fill', reference: 'match:42' } satisfies HoldAllocationKey;
  const market = { ...spot, purpose: 'market_trade' } satisfies HoldAllocationKey;

  const allocate = { ...spot, operationId: 'protect-fill', amount: '25' };
  const receipt = await ledger.allocate(allocate);
  expect(receipt).toMatchObject({ kind: 'ok' });
  expect(await ledger.allocate(allocate)).toEqual(receipt);
  expect(await ledger.allocate({ ...allocate, amount: '26' })).toEqual({ kind: 'operation_conflict' });
  expect(await ledger.allocate({ ...allocate, operationId: 'duplicate-ref' })).toEqual({ kind: 'operation_conflict' });
  expect(await ledger.allocate({ ...market, operationId: 'protect-market', amount: '10' })).toMatchObject({
    kind: 'ok',
  });
  expect(await ledger.readAllocation(spot)).toMatchObject({ kind: 'ok', value: { amount: '25', status: 'protected' } });
  expect(await ledger.readAllocation({ ...spot, accountId: recipientId })).toEqual({ kind: 'allocation_missing' });
  await expectBalance(ledger, hold, '100', '70', '30');

  const ordinary = { ...hold, recipientId, final: true };
  expect(await ledger.capture({ ...ordinary, operationId: 'over-capture', amount: '36' })).toEqual({
    kind: 'insufficient_funds',
  });
  expect(await ledger.releaseAmount({ ...hold, operationId: 'over-release', amount: '36' })).toEqual({
    kind: 'insufficient_funds',
  });
  const priceImprovement = { ...hold, operationId: 'price-improvement', amount: '7' };
  const releaseReceipt = await ledger.releaseAmount(priceImprovement);
  expect(releaseReceipt).toMatchObject({ kind: 'ok' });
  expect(await ledger.releaseAmount(priceImprovement)).toEqual(releaseReceipt);
  await expectBalance(ledger, hold, '100', '63', '37');
  expect(await ledger.capture({ ...ordinary, operationId: 'ordinary-final', amount: '8' })).toMatchObject({
    kind: 'ok',
  });
  expect(await ledger.release({ ...hold, operationId: 'no-ordinary-remainder' })).toEqual({ kind: 'hold_closed' });
  await expectBalance(ledger, hold, '92', '35', '57');

  expect(await ledger.captureAllocation({ ...spot, operationId: 'settle-fill', recipientId })).toMatchObject({
    kind: 'ok',
  });
  await expectBalance(ledger, hold, '67', '10', '57');
  expect(await ledger.releaseAllocation({ ...market, operationId: 'abort-market' })).toMatchObject({ kind: 'ok' });
  await expectBalance(ledger, hold, '67', '0', '67');
  await expectBalance(ledger, { ...hold, accountId: recipientId }, '33', '0', '33');
  expect(await ledger.readAllocation(spot)).toMatchObject({
    kind: 'ok',
    value: { amount: '25', status: 'captured', recipientId, resolvedAt: expect.any(String) },
  });
  expect(await ledger.readAllocation(market)).toMatchObject({
    kind: 'ok',
    value: { amount: '10', status: 'released', recipientId: null, resolvedAt: expect.any(String) },
  });
  const { rows } = await pool.query(
    `SELECT remaining::text, allocated::text, captured::text, released::text
     FROM economy.hold WHERE book_id = $1 AND asset_id = $2 AND account_id = $3 AND hold_id = $4`,
    [bookId, hold.assetId, hold.accountId, hold.holdId],
  );
  expect(rows).toEqual([{ remaining: '0', allocated: '0', captured: '33', released: '37' }]);
});

test('a dispatched withdrawal allocation remains capturable after parent expiry', async () => {
  const { ledger, hold, recipientId, expiresAt } = await fixture(900);
  const payout = { ...hold, purpose: 'withdrawal', reference: 'payout:17' } satisfies HoldAllocationKey;
  expect(await ledger.allocate({ ...payout, operationId: 'prepare-payout', amount: '40' })).toMatchObject({
    kind: 'ok',
  });

  await Bun.sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 25);
  expect(await ledger.allocate({ ...payout, reference: 'late', operationId: 'late', amount: '1' })).toEqual({
    kind: 'hold_closed',
  });
  expect(await ledger.expire({ ...hold, operationId: 'expire-unallocated' })).toMatchObject({ kind: 'ok' });
  await expectBalance(ledger, hold, '100', '40', '60');
  expect(await ledger.readAllocation(payout)).toMatchObject({ kind: 'ok', value: { status: 'protected' } });
  const capture = { ...payout, operationId: 'settle-payout', recipientId };
  const receipt = await ledger.captureAllocation(capture);
  expect(receipt).toMatchObject({ kind: 'ok' });
  expect(await ledger.captureAllocation(capture)).toEqual(receipt);
  expect(await ledger.releaseAllocation({ ...payout, operationId: 'late-abort' })).toEqual({
    kind: 'allocation_closed',
  });
  await expectBalance(ledger, hold, '60', '0', '60');
});

test('concurrent allocations and competing terminal commands consume the protected amount once', async () => {
  const { ledger, hold, recipientId } = await fixture();
  const first = { ...hold, purpose: 'spot_fill', reference: 'fill:1', operationId: 'match:1', amount: '50' } as const;
  const second = { ...first, reference: 'fill:2', operationId: 'match:2' };
  const outcomes = await Promise.all([ledger.allocate(first), ledger.allocate(second)]);
  expect(outcomes.map((result) => result.kind).sort()).toEqual(['insufficient_funds', 'ok']);
  const winner = outcomes[0]?.kind === 'ok' ? first : second;
  const [capture, release] = await Promise.all([
    ledger.captureAllocation({ ...winner, operationId: 'concurrent-capture', recipientId }),
    ledger.releaseAllocation({ ...winner, operationId: 'concurrent-release' }),
  ]);
  expect([capture.kind, release.kind].sort()).toEqual(['allocation_closed', 'ok']);
  await expectBalance(ledger, hold, capture.kind === 'ok' ? '50' : '100', '20', capture.kind === 'ok' ? '30' : '80');
  expect(await ledger.readAllocation(winner)).toMatchObject({
    kind: 'ok',
    value: { status: capture.kind === 'ok' ? 'captured' : 'released' },
  });
});
