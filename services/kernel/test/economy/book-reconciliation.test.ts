import { afterAll, expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { bookFixtureDatabase } from './fixtures/book-reconciliation-native.ts';
import type { EconomyResult } from '../../src/economy/contract.ts';
import { createEconomyLedger } from '../../src/economy/ledger.ts';
import { reconcileBook, type BookReconciliationDatabase } from '../../src/economy/storage/book-reconciliation.ts';
import { createFundingLedgerBinder } from '../../src/economy/storage/funding-ledger.ts';
import { createFundingStore } from '../../src/economy/storage/funding-store.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const writerPool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(async () => {
  await Promise.all([pool.end(), writerPool.end()]);
});

const database = bookFixtureDatabase(pool);
const auditDatabase: BookReconciliationDatabase = database;

function ok<T>(result: EconomyResult<T>): T {
  if (result.kind !== 'ok') throw new Error(`Expected native Economy result, got ${result.kind}`);
  return result.value;
}

async function fixture() {
  const bookId = `reconcile:${crypto.randomUUID()}`;
  const accountId = crypto.randomUUID();
  const wallet = { assetId: 'demo-usd', accountId };
  const ledger = createEconomyLedger(database, bookId);
  ok(await ledger.provisionAsset({ id: wallet.assetId, scale: 2, transferable: true }));
  ok(await ledger.issue({ ...wallet, operationId: 'open', amount: '100' }));
  return { bookId, wallet, ledger };
}

async function obligations(f: Awaited<ReturnType<typeof fixture>>) {
  const hold = { ...f.wallet, holdId: 'named-hold' };
  ok(
    await f.ledger.reserve({
      ...hold,
      amount: '70',
      operationId: 'reserve',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  ok(
    await f.ledger.allocate({
      ...hold,
      amount: '30',
      operationId: 'allocate',
      purpose: 'withdrawal',
      reference: 'pledge',
    }),
  );
  const provider = { namespace: `test:${crypto.randomUUID()}`, mode: 'test', destinationRef: 'recipient' } as const;
  const fund = createFundingStore(database, f.bookId, createFundingLedgerBinder(f.bookId));
  expect(
    ok(
      await fund.begin({
        bookId: f.bookId,
        intentId: 'pending',
        walletId: f.wallet.accountId,
        assetId: f.wallet.assetId,
        units: '15',
        direction: 'deposit',
        provider,
      }),
    ),
  ).toMatchObject({ kind: 'created' });
  expect(ok(await fund.prepare('pending'))).toMatchObject({ kind: 'queued' });
  const creator = { creatorId: f.wallet.accountId, assetId: f.wallet.assetId };
  ok(
    await f.ledger.creatorClearing.accrue({
      ...creator,
      units: '40',
      expenseReference: 'approved-test',
      source: { namespace: 'test:accrual', id: f.bookId },
    }),
  );
  ok(await f.ledger.creatorClearing.reservePayout({ ...creator, payoutId: 'creator-payout', units: '10', provider }));
}

const audit = (bookId: string, pageLimit?: number) =>
  reconcileBook(auditDatabase, {
    bookId,
    deadline: Date.now() + 8_000,
    ...(pageLimit === undefined ? {} : { pageLimit }),
  });

test('one selected book reconstructs signed controls, independent holds, creator payable and pending deposits', async () => {
  const f = await fixture();
  await f.ledger.provisionAsset({ id: 'other-asset', scale: 0, transferable: true });
  await obligations(f);
  const view = await audit(f.bookId);
  expect(view).toMatchObject({ kind: 'consistent', bookId: f.bookId, findingCount: 0 });
  if (view.kind === 'incomplete') throw new Error('Expected a complete selected book');
  expect(view.snapshot.watermark).toMatch(/^[a-f0-9]{32}$/);
  expect(view.assets).toMatchObject([
    { assetId: f.wallet.assetId, journalNet: '0', pendingDeposits: { projected: '15', reconstructed: '15' } },
    { assetId: 'other-asset', journalNet: '0', components: [] },
  ]);
  const roles = Object.fromEntries(view.assets[0]!.components.map((item) => [item.role, item]));
  expect(roles.wallet).toMatchObject({
    posted: { projected: '100', reconstructed: '100' },
    held: { projected: '70', reconstructed: '70', outstanding: '70' },
    journalEntries: 2,
  });
  expect(roles.issuer).toMatchObject({ posted: { projected: '-100', reconstructed: '-100' } });
  expect(roles.creator_expense).toMatchObject({ posted: { projected: '-40', reconstructed: '-40' } });
  expect(roles.creator_payable).toMatchObject({
    posted: { projected: '40', reconstructed: '40' },
    held: { projected: '10', reconstructed: '10', outstanding: '10' },
  });
});

test('native drift produces explicit journal, position, allocation, and pending divergence evidence', async () => {
  const f = await fixture();
  await obligations(f);
  const key = [f.bookId, f.wallet.assetId, f.wallet.accountId];
  await pool.query(
    `UPDATE economy.position SET posted = posted + 1, held = held + 1, revision = revision + 1
    WHERE book_id = $1 AND asset_id = $2 AND account_id = $3`,
    key,
  );
  await pool.query(
    `UPDATE economy.hold SET allocated = allocated + 1 WHERE book_id = $1 AND asset_id = $2 AND account_id = $3`,
    key,
  );
  await pool.query(
    `UPDATE economy.pending_deposit SET units = units + 1 WHERE book_id = $1 AND asset_id = $2 AND wallet_id = $3`,
    key,
  );
  const third = crypto.randomUUID();
  await pool.query(`INSERT INTO economy.position (book_id, asset_id, account_id) VALUES ($1, $2, $3)`, [
    key[0],
    key[1],
    third,
  ]);
  await pool.query(
    `INSERT INTO economy.entry (book_id, asset_id, account_id, position, transaction_id, posted_delta, held_delta)
    SELECT $1, $2, $3, 1, j.transaction_id, 1, 0 FROM economy.journal AS j
    WHERE j.book_id = $1 AND j.asset_id = $2 AND j.kind = 'issue'`,
    [key[0], key[1], third],
  );
  const view = await audit(f.bookId);
  expect(view.kind).toBe('divergent');
  expect(view.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ check: 'position_revision', key: [f.wallet.accountId], expected: '2', observed: '3' }),
      expect.objectContaining({
        check: 'position_posted',
        key: [f.wallet.accountId],
        expected: '100',
        observed: '101',
      }),
      expect.objectContaining({
        check: 'position_held_obligations',
        key: [f.wallet.accountId],
        expected: '70',
        observed: '71',
      }),
      expect.objectContaining({ check: 'hold_allocated', expected: '30', observed: '31' }),
      expect.objectContaining({ check: 'pending_deposit', expected: '15', observed: '16' }),
      expect.objectContaining({ check: 'journal_posted_net', expected: '0', observed: '1' }),
      expect.objectContaining({ check: 'asset_journal_net', expected: '0', observed: '1' }),
    ]),
  );
});

test('keysets cross page boundaries without promoting a page-limited audit to complete', async () => {
  const f = await fixture();
  for (let i = 0; i < 65; i++) ok(await f.ledger.issue({ ...f.wallet, operationId: `issue-${i}`, amount: '1' }));
  const partial = await audit(f.bookId, 3);
  expect(partial).toMatchObject({ kind: 'incomplete', pages: 3 });
  expect(partial).not.toHaveProperty('assets');
  const complete = await audit(f.bookId);
  expect(complete.kind).toBe('consistent');
  if (complete.kind === 'incomplete') throw new Error('Expected complete keyset scan');
  expect(complete.assets[0]?.components).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'wallet',
        journalEntries: 66,
        posted: { projected: '165', reconstructed: '165' },
      }),
      expect.objectContaining({
        role: 'issuer',
        journalEntries: 66,
        posted: { projected: '-165', reconstructed: '-165' },
      }),
    ]),
  );
}, 15000);

test('a later writer commit cannot enter any page of a pinned book snapshot', async () => {
  const f = await fixture();
  const concurrent = createEconomyLedger(bookFixtureDatabase(writerPool), f.bookId);
  let committed = false;
  const intercepted: BookReconciliationDatabase = {
    snapshot: (deadline, work) =>
      database.snapshot(deadline, (client) => {
        const query = async (sql: string, operands?: readonly unknown[]) => {
          const result = await client.query(sql, [...(operands ?? [])]);
          if (!committed && sql.includes('pg_current_snapshot')) {
            ok(await concurrent.issue({ ...f.wallet, operationId: 'after-cut', amount: '50' }));
            committed = true;
          }
          return result;
        };
        return work({ query: query as PoolClient['query'] });
      }),
  };
  const pinned = await reconcileBook(intercepted, { bookId: f.bookId, deadline: Date.now() + 8000 });
  expect(committed).toBe(true);
  expect(pinned.kind).toBe('consistent');
  if (pinned.kind === 'incomplete') throw new Error('Expected complete pinned cut');
  expect(pinned.assets[0]?.components.find((row) => row.role === 'wallet')?.posted).toEqual({
    projected: '100',
    reconstructed: '100',
  });
  const after = await audit(f.bookId);
  expect(after.kind).toBe('consistent');
  if (after.kind === 'incomplete') throw new Error('Expected complete later cut');
  expect(after.assets[0]?.components.find((row) => row.role === 'wallet')?.posted).toEqual({
    projected: '150',
    reconstructed: '150',
  });
  expect(after.snapshot.watermark).not.toBe(pinned.snapshot.watermark);
  await expect(
    reconcileBook({ snapshot: (_deadline, work) => work(pool) }, { bookId: f.bookId, deadline: Date.now() + 2000 }),
  ).rejects.toThrow('read-only repeatable-read transaction');
  const unpinned = await pool.connect();
  try {
    await unpinned.query(`SET default_transaction_isolation = 'repeatable read'`);
    await unpinned.query(`SET default_transaction_read_only = 'on'`);
    await expect(
      reconcileBook(
        { snapshot: (_deadline, work) => work(unpinned) },
        { bookId: f.bookId, deadline: Date.now() + 2000 },
      ),
    ).rejects.toThrow('snapshot changed before completion');
  } finally {
    unpinned.release(true);
  }
});
