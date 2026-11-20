import { afterAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createNativeEconomyLedger } from '../../src/composition/economy.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

async function fixture() {
  const ledger = createNativeEconomyLedger(pool, `test:${crypto.randomUUID()}`);
  const assetId = 'points';
  const accountId = crypto.randomUUID();
  const recipientId = crypto.randomUUID();
  expect(await ledger.provisionAsset({ id: assetId, scale: 0, transferable: true })).toMatchObject({ kind: 'ok' });
  const wallet = { accountId, assetId };
  expect(await ledger.issue({ ...wallet, operationId: 'initial', amount: '100' })).toMatchObject({ kind: 'ok' });
  return { ledger, wallet, recipientId };
}

test('same-book concurrent spending conserves units and exact replay retains one receipt', async () => {
  const { ledger, wallet, recipientId } = await fixture();
  const operands = { ...wallet, recipientId, amount: '80' };
  const keys = ['first-spend', 'second-spend'];
  const results = await Promise.all(keys.map((operationId) => ledger.transfer({ ...operands, operationId })));
  expect(results.map((result) => result.kind).sort()).toEqual(['insufficient_funds', 'ok']);
  const winner = results.findIndex((result) => result.kind === 'ok');
  const operationId = keys[winner]!;
  expect(await ledger.transfer({ ...operands, operationId })).toEqual(results[winner]);
  expect(await ledger.transfer({ ...operands, operationId, amount: '79' })).toEqual({ kind: 'operation_conflict' });
  expect(await ledger.readBalance(wallet)).toMatchObject({ kind: 'ok', value: { posted: '20', available: '20' } });
  expect(await ledger.readBalance({ ...wallet, accountId: recipientId })).toMatchObject({
    kind: 'ok',
    value: { posted: '80', available: '80' },
  });
  const recipientStatement = await ledger.readStatement({ ...wallet, accountId: recipientId, limit: 1 });
  expect(recipientStatement).toMatchObject({ kind: 'ok', value: { entries: [{ kind: 'transfer' }] } });
  if (recipientStatement.kind !== 'ok') throw new Error('Missing recipient statement');
  expect(recipientStatement.value.entries[0]?.operationId).not.toBe(operationId);
  const first = await ledger.readStatement({ ...wallet, limit: 1 });
  expect(first).toMatchObject({ kind: 'ok', value: { entries: [{ kind: 'transfer', operationId }] } });
  if (first.kind !== 'ok' || first.value.next === null) throw new Error('Missing statement continuation');
  expect(await ledger.readStatement({ ...wallet, limit: 1, before: first.value.next })).toMatchObject({
    kind: 'ok',
    value: { entries: [{ kind: 'issue' }], next: null },
  });
  expect(await ledger.issue({ ...wallet, operationId: 'later-funding', amount: '100' })).toMatchObject({ kind: 'ok' });
  const rejectedOperationId = keys[winner === 0 ? 1 : 0]!;
  expect(await ledger.transfer({ ...operands, operationId: rejectedOperationId })).toEqual({
    kind: 'insufficient_funds',
  });
  expect(await ledger.readBalance(wallet)).toMatchObject({ kind: 'ok', value: { available: '120' } });
});

test('partial capture keeps its residual hold until final capture releases the unused amount', async () => {
  const { ledger, wallet, recipientId } = await fixture();
  const hold = { ...wallet, holdId: 'trade-funding' };
  expect(
    await ledger.reserve({
      ...hold,
      operationId: 'reserve',
      amount: '70',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  ).toMatchObject({ kind: 'ok' });
  const partial = { ...hold, operationId: 'first-fill', recipientId, amount: '30', final: false };
  const receipt = await ledger.capture(partial);
  expect(receipt).toMatchObject({ kind: 'ok' });
  expect(await ledger.capture(partial)).toEqual(receipt);
  expect(await ledger.readBalance(wallet)).toMatchObject({
    kind: 'ok',
    value: { posted: '70', held: '40', available: '30' },
  });
  expect(await ledger.transfer({ ...wallet, recipientId, operationId: 'overspend', amount: '31' })).toEqual({
    kind: 'insufficient_funds',
  });
  expect(await ledger.capture({ ...partial, operationId: 'final-fill', amount: '10', final: true })).toMatchObject({
    kind: 'ok',
  });
  expect(await ledger.readBalance(wallet)).toMatchObject({
    kind: 'ok',
    value: { posted: '60', held: '0', available: '60' },
  });
  expect(await ledger.release({ ...hold, operationId: 'already-closed' })).toEqual({ kind: 'hold_closed' });
});
