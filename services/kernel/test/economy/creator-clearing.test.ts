import { afterAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import type { EconomyResult } from '../../src/economy/contract.ts';
import { createEconomyLedger, type EconomyDatabase } from '../../src/economy/ledger.ts';
import type { CreatorAccrual, CreatorPayoutReservation } from '../../src/economy/storage/creator-contract.ts';
import { createFundingLedgerBinder } from '../../src/economy/storage/funding-ledger.ts';
import { createFundingStore } from '../../src/economy/storage/funding-store.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const database: EconomyDatabase = {
  async transaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(`SET LOCAL statement_timeout = '4000ms'`);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  read: (work) => work(pool),
};

function ok<T>(result: EconomyResult<T>): T {
  if (result.kind !== 'ok') throw new Error(`Expected an Economy result, received ${result.kind}`);
  return result.value;
}

async function fixture() {
  const bookId = `creator:${crypto.randomUUID()}`;
  const creator = { creatorId: crypto.randomUUID(), assetId: 'demo-usd' };
  const provider = {
    namespace: `creator-test:${crypto.randomUUID()}`,
    mode: 'test',
    destinationRef: 'payee-1',
  } as const;
  const ledger = createEconomyLedger(database, bookId);
  ok(await ledger.provisionAsset({ id: creator.assetId, scale: 2, transferable: true }));
  const accrual: CreatorAccrual = {
    ...creator,
    units: '100',
    expenseReference: 'approved-revenue-share',
    source: { namespace: 'commerce:verified-earnings:test', id: crypto.randomUUID() },
  };
  const reservation = (payoutId: string, units = '80'): CreatorPayoutReservation => ({
    ...creator,
    provider,
    payoutId,
    units,
  });
  return { bookId, creator, provider, ledger, clearing: ledger.creatorClearing, accrual, reservation };
}

async function proofs(bookId: string) {
  const { rows } = await pool.query<{ kind: string; legs: number; total: string }>(
    `SELECT journal.kind, count(*)::integer AS legs, sum(entry.posted_delta)::text AS total
     FROM economy.journal JOIN economy.entry USING (book_id, asset_id, transaction_id)
     WHERE journal.book_id = $1 AND journal.kind LIKE 'creator_%'
     GROUP BY journal.kind, journal.transaction_id ORDER BY journal.kind`,
    [bookId],
  );
  return rows;
}

async function controlBalances(bookId: string) {
  const { rows } = await pool.query<{ role: string; posted: string; held: string }>(
    `SELECT account_role AS role, posted::text, held::text FROM economy.position
      WHERE book_id = $1 ORDER BY account_role`,
    [bookId],
  );
  return rows;
}

test('creator accrual is balanced, exact on replay and distinct from wallet credit', async () => {
  const { bookId, creator, ledger, clearing, accrual } = await fixture();
  const largest = { ...accrual, units: '9007199254740993' };
  const receipt = await clearing.accrue(largest);
  expect(receipt).toEqual({ kind: 'ok', value: { operationId: accrual.source.id } });
  expect(await clearing.accrue(largest)).toEqual(receipt);
  expect(await clearing.accrue({ ...largest, units: '9007199254740994' })).toEqual({ kind: 'operation_conflict' });
  expect(ok(await clearing.readPayable(creator))).toEqual({
    posted: largest.units,
    reserved: '0',
    available: largest.units,
  });
  const wallet = { assetId: creator.assetId, accountId: creator.creatorId };
  expect(ok(await ledger.readBalance(wallet))).toMatchObject({ posted: '0', available: '0' });
  expect(ok(await ledger.readStatement({ ...wallet, limit: 5 })).entries).toEqual([]);
  expect(await controlBalances(bookId)).toEqual([
    { role: 'creator_expense', posted: '-9007199254740993', held: '0' },
    { role: 'creator_payable', posted: '9007199254740993', held: '0' },
  ]);
  expect(await proofs(bookId)).toEqual([{ kind: 'creator_accrual', legs: 2, total: '0' }]);
});

test('a verified accrual component can belong to only one book under concurrent duplicate delivery', async () => {
  const first = await fixture();
  const second = await fixture();
  const results = await Promise.all([
    first.clearing.accrue(first.accrual),
    second.clearing.accrue({ ...second.accrual, source: first.accrual.source }),
  ]);
  expect(results.map(({ kind }) => kind).sort()).toEqual(['ok', 'operation_conflict']);
  const payable = await Promise.all([
    first.clearing.readPayable(first.creator),
    second.clearing.readPayable(second.creator),
  ]);
  expect(payable.map((entry) => ok(entry).posted).sort()).toEqual(['0', '100']);
});

test('competing reservations fence overspending, and observed payment and partial returns are independently bound', async () => {
  const { bookId, creator, clearing, accrual, reservation, provider } = await fixture();
  ok(await clearing.accrue(accrual));
  const proposals = [reservation('payout-1'), reservation('payout-2')];
  const results = await Promise.all(proposals.map((request) => clearing.reservePayout(request)));
  expect(results.map(({ kind }) => kind).sort()).toEqual(['insufficient_funds', 'ok']);
  const winnerIndex = results.findIndex(({ kind }) => kind === 'ok');
  const winner = proposals[winnerIndex]!;
  const loser = proposals[1 - winnerIndex]!;
  expect(await clearing.reservePayout(winner)).toEqual(results[winnerIndex]!);
  expect(await clearing.reservePayout({ ...winner, units: '79' })).toEqual({ kind: 'operation_conflict' });
  expect(ok(await clearing.readPayable(creator))).toEqual({ posted: '100', reserved: '80', available: '20' });
  const paid = {
    payoutId: winner.payoutId,
    assetId: creator.assetId,
    provider,
    units: '80',
    kind: 'paid',
    movementId: 'provider-payout-1',
  } as const;
  const returned = {
    ...paid,
    kind: 'returned',
    movementId: 'provider-return-1',
    originalMovementId: paid.movementId,
    units: '30',
  } as const;
  expect(await clearing.observePayout(returned)).toEqual({ kind: 'operation_conflict' });
  expect(await clearing.observePayout({ ...paid, provider: { ...provider, destinationRef: 'not-the-payee' } })).toEqual(
    { kind: 'operation_conflict' },
  );
  expect(await clearing.observePayout({ ...paid, units: '70' })).toEqual({ kind: 'operation_conflict' });
  expect(await clearing.observePayout({ ...paid, assetId: 'another-asset' })).toEqual({ kind: 'operation_conflict' });
  const paidReceipt = await clearing.observePayout(paid);
  expect(paidReceipt.kind).toBe('ok');
  expect(await clearing.observePayout(paid)).toEqual(paidReceipt);
  expect(ok(await clearing.readPayable(creator))).toEqual({ posted: '20', reserved: '0', available: '20' });
  expect(await clearing.observePayout({ ...returned, originalMovementId: 'unrelated' })).toEqual({
    kind: 'operation_conflict',
  });
  const returnReceipt = await clearing.observePayout(returned);
  expect(returnReceipt.kind).toBe('ok');
  expect(await clearing.observePayout(returned)).toEqual(returnReceipt);
  expect(await clearing.observePayout({ ...returned, movementId: 'provider-return-2', units: '51' })).toEqual({
    kind: 'operation_conflict',
  });
  const finalReturn = { ...returned, movementId: 'provider-return-2', units: '50' };
  expect((await clearing.observePayout(finalReturn)).kind).toBe('ok');
  expect(ok(await clearing.readPayout(winner.payoutId))).toMatchObject({ status: 'paid', returnedUnits: '80' });
  expect(ok(await clearing.readPayable(creator))).toEqual({ posted: '100', reserved: '0', available: '100' });
  expect(await clearing.reservePayout(loser)).toEqual({ kind: 'insufficient_funds' });
  expect(await proofs(bookId)).toEqual([
    { kind: 'creator_accrual', legs: 2, total: '0' },
    { kind: 'creator_payout', legs: 2, total: '0' },
    { kind: 'creator_payout_reserve', legs: 1, total: '0' },
    { kind: 'creator_payout_return', legs: 2, total: '0' },
    { kind: 'creator_payout_return', legs: 2, total: '0' },
  ]);
});

test('definitive evidence releases only its own reservation even with another payout protected', async () => {
  const { bookId, creator, clearing, accrual, reservation, provider } = await fixture();
  ok(await clearing.accrue(accrual));
  const first = reservation('first', '30');
  const second = reservation('second', '50');
  ok(await clearing.reservePayout(first));
  ok(await clearing.reservePayout(second));
  const refused = {
    kind: 'refused',
    units: first.units,
    payoutId: first.payoutId,
    assetId: creator.assetId,
    provider,
    evidenceId: 'refusal-1',
  } as const;
  const receipt = await clearing.observePayout(refused);
  expect(receipt.kind).toBe('ok');
  expect(await clearing.observePayout(refused)).toEqual(receipt);
  expect(await clearing.observePayout({ ...refused, kind: 'paid', movementId: 'late' })).toEqual({
    kind: 'operation_conflict',
  });
  expect(ok(await clearing.readPayable(creator))).toEqual({ posted: '100', reserved: '50', available: '50' });
  expect(ok(await clearing.readPayout(first.payoutId))).toMatchObject({ status: 'released' });
  expect(ok(await clearing.readPayout(second.payoutId))).toMatchObject({ status: 'reserved' });
  expect(await controlBalances(bookId)).toEqual([
    { role: 'creator_expense', posted: '-100', held: '0' },
    { role: 'creator_payable', posted: '100', held: '50' },
  ]);
});

test('failure after a native confirmation rolls back movement, liability and provider key together', async () => {
  const { bookId, creator, clearing, accrual, reservation, provider } = await fixture();
  ok(await clearing.accrue(accrual));
  ok(await clearing.reservePayout(reservation('rollback')));
  const failing = createEconomyLedger(
    {
      ...database,
      transaction: (work) =>
        database.transaction(async (client) => {
          const result = await work(client);
          if (result.kind === 'ok') throw new Error('injected failure after creator settlement');
          return result;
        }),
    },
    bookId,
  ).creatorClearing;
  const paid = {
    payoutId: 'rollback',
    assetId: creator.assetId,
    kind: 'paid',
    provider,
    units: '80',
    movementId: 'rollback-movement',
  } as const;
  await expect(failing.observePayout(paid)).rejects.toThrow('injected failure after creator settlement');
  expect(ok(await clearing.readPayout('rollback'))).toMatchObject({ status: 'reserved', paidMovementId: null });
  expect(ok(await clearing.readPayable(creator))).toEqual({ posted: '100', reserved: '80', available: '20' });
  const keys = await pool.query('SELECT source_id FROM economy.provider_posting_key WHERE provider_namespace = $1', [
    provider.namespace,
  ]);
  expect(keys.rowCount).toBe(0);
  expect(await proofs(bookId)).toEqual([
    { kind: 'creator_accrual', legs: 2, total: '0' },
    { kind: 'creator_payout_reserve', legs: 1, total: '0' },
  ]);
  expect((await clearing.observePayout(paid)).kind).toBe('ok');
  expect(ok(await clearing.readPayable(creator))).toEqual({ posted: '20', reserved: '0', available: '20' });
});

test('wallet and creator clearing cannot post the same verified provider movement', async () => {
  const { bookId, creator, ledger, clearing, accrual, reservation, provider } = await fixture();
  ok(await clearing.accrue(accrual));
  ok(await clearing.reservePayout(reservation('wallet-first')));
  ok(await clearing.reservePayout(reservation('creator-first', '20')));
  const fund = createFundingStore(database, bookId, createFundingLedgerBinder(bookId));
  const wallet = { accountId: creator.creatorId, assetId: creator.assetId };
  async function deposit(intentId: string, movementId: string) {
    ok(
      await fund.begin({
        bookId,
        intentId,
        walletId: wallet.accountId,
        assetId: wallet.assetId,
        units: '100',
        direction: 'deposit',
        provider,
      }),
    );
    const attempt = ok(await fund.prepare(intentId));
    if (attempt.kind !== 'queued') throw new Error('Expected prepared wallet deposit');
    return fund.observe(intentId, {
      attemptId: attempt.attemptId,
      kind: 'confirmed',
      movementId,
      provider,
      assetId: wallet.assetId,
      units: '100',
    });
  }
  expect(ok(await deposit('wallet-deposit', 'wallet-source'))).toMatchObject({ kind: 'applied' });
  expect(
    await clearing.observePayout({
      payoutId: 'wallet-first',
      assetId: creator.assetId,
      kind: 'paid',
      provider,
      units: '80',
      movementId: 'wallet-source',
    }),
  ).toEqual({ kind: 'operation_conflict' });
  expect(
    (
      await clearing.observePayout({
        payoutId: 'creator-first',
        assetId: creator.assetId,
        kind: 'paid',
        provider,
        units: '20',
        movementId: 'creator-source',
      })
    ).kind,
  ).toBe('ok');
  await expect(deposit('blocked-deposit', 'creator-source')).rejects.toMatchObject({ code: '23505' });
  expect(ok(await fund.read('blocked-deposit'))).toMatchObject({ phase: 'submitted' });
  expect(ok(await ledger.readBalance(wallet))).toMatchObject({ posted: '100', available: '100' });
  expect(ok(await clearing.readPayable(creator))).toEqual({ posted: '80', reserved: '80', available: '0' });
});
