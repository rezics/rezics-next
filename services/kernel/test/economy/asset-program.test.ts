import { afterAll, expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import type { AssetProgram } from '../../src/economy/contract.ts';
import { createEconomyLedger } from '../../src/economy/ledger.ts';
import { createFundingStore } from '../../src/economy/storage/funding-store.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

async function transaction<T>(work: (connection: PoolClient) => Promise<T>): Promise<T> {
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    try {
      const result = await work(connection);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    }
  } finally {
    connection.release();
  }
}

function fixture() {
  const bookId = `test:${crypto.randomUUID()}`;
  return { bookId, ledger: createEconomyLedger({ transaction, read: (work) => work(pool) }, bookId) };
}

const pointPolicy = {
  id: 'points-1',
  scale: 0,
  transferable: true,
  programId: 'reader-rewards',
  version: '1',
  issuanceSource: 'reading-awards',
  supplyCap: '10',
  redeemable: true,
  expiresAt: null,
} satisfies AssetProgram;

test('immutable versions share source identities and enforce enrollment and net supply under replay', async () => {
  const { ledger } = fixture();
  const accountId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  const wallet = { accountId, assetId: pointPolicy.id };
  const input = { ...wallet, issuanceSource: pointPolicy.issuanceSource, sourceReference: 'review-1', amount: '7' };
  expect(await ledger.provisionAssetProgram(pointPolicy)).toEqual({ kind: 'ok', value: pointPolicy });
  expect(await ledger.provisionAssetProgram(pointPolicy)).toEqual({ kind: 'ok', value: pointPolicy });
  expect(await ledger.provisionAssetProgram({ ...pointPolicy, supplyCap: '20' })).toEqual({
    kind: 'operation_conflict',
  });
  expect(await ledger.provisionAssetProgram({ ...pointPolicy, id: 'duplicate-version' })).toEqual({
    kind: 'operation_conflict',
  });
  expect(await ledger.readBalance({ ...wallet, assetId: 'duplicate-version' })).toEqual({ kind: 'asset_missing' });
  expect(await ledger.issue({ ...wallet, operationId: 'generic-issue', amount: '1' })).toEqual({
    kind: 'program_ineligible',
  });
  expect(await ledger.issueProgramUnits({ ...input, sourceReference: 'not-enrolled' })).toEqual({
    kind: 'program_ineligible',
  });
  expect(await ledger.enrollAssetProgramRecipient({ ...wallet, issuanceSource: 'other-source' })).toEqual({
    kind: 'program_ineligible',
  });
  for (const recipient of [accountId, otherId]) {
    expect(await ledger.enrollAssetProgramRecipient({ ...input, accountId: recipient })).toEqual({
      kind: 'ok',
      value: null,
    });
  }
  const awarded = await ledger.issueProgramUnits(input);
  expect(awarded.kind).toBe('ok');
  expect(await ledger.issueProgramUnits(input)).toEqual(awarded);
  expect(await ledger.issueProgramUnits({ ...input, amount: '6' })).toEqual({ kind: 'operation_conflict' });
  expect(await ledger.issueProgramUnits({ ...input, accountId: otherId })).toEqual({ kind: 'operation_conflict' });
  const second = { ...pointPolicy, id: 'points-2', version: '2' };
  expect(await ledger.provisionAssetProgram(second)).toMatchObject({ kind: 'ok' });
  await ledger.enrollAssetProgramRecipient({ ...input, assetId: second.id });
  expect(await ledger.issueProgramUnits({ ...input, assetId: second.id })).toEqual({ kind: 'operation_conflict' });
  expect(await ledger.issueProgramUnits({ ...input, sourceReference: 'another-award', amount: '4' })).toEqual({
    kind: 'program_supply_exceeded',
  });

  const redemption = { ...wallet, redemptionReference: 'benefit-1', amount: '3' };
  const redeemed = await ledger.redeemProgramUnits(redemption);
  expect(redeemed.kind).toBe('ok');
  expect(await ledger.redeemProgramUnits(redemption)).toEqual(redeemed);
  expect(await ledger.redeemProgramUnits({ ...redemption, amount: '2' })).toEqual({ kind: 'operation_conflict' });
  expect(await ledger.redeemProgramUnits({ ...redemption, accountId: otherId })).toEqual({
    kind: 'operation_conflict',
  });
  expect(await ledger.issueProgramUnits({ ...input, sourceReference: 'new-award', amount: '6' })).toMatchObject({
    kind: 'ok',
  });
  expect(await ledger.transfer({ ...wallet, operationId: 'tip', recipientId: otherId, amount: '2' })).toMatchObject({
    kind: 'ok',
  });
  expect(await ledger.readBalance(wallet)).toMatchObject({ kind: 'ok', value: { posted: '8', available: '8' } });
  expect(await ledger.readBalance({ ...wallet, accountId: otherId })).toMatchObject({
    kind: 'ok',
    value: { posted: '2' },
  });
});

test('expiring promotional credit stays non-transferable and becomes restricted before its exactly-once expiry posting', async () => {
  const { bookId, ledger } = fixture();
  const { rows } = await pool.query<{ expiresAt: Date }>(
    `SELECT statement_timestamp() + interval '1500ms' AS "expiresAt"`,
  );
  const expiresAt = rows[0]!.expiresAt.toISOString();
  const policy = { ...pointPolicy, id: 'promo', transferable: false, expiresAt };
  const wallet = { accountId: crypto.randomUUID(), assetId: policy.id };
  const recipientId = crypto.randomUUID();
  expect(await ledger.provisionAssetProgram(policy)).toMatchObject({ kind: 'ok' });
  expect(await ledger.enrollAssetProgramRecipient({ ...wallet, issuanceSource: policy.issuanceSource })).toMatchObject({
    kind: 'ok',
  });
  const mint = { ...wallet, amount: '10', issuanceSource: policy.issuanceSource, sourceReference: 'opening' };
  expect(await ledger.issueProgramUnits(mint)).toMatchObject({ kind: 'ok' });
  expect(await ledger.expireProgramCredits(wallet)).toEqual({ kind: 'invalid_operation' });
  const due = () => ledger.listExpiredProgramCredits({ assetId: policy.id, limit: 1 });
  expect(await due()).toEqual({ kind: 'ok', value: { accounts: [], next: null } });
  expect(await ledger.transfer({ ...wallet, operationId: 'attempted-transfer', recipientId, amount: '1' })).toEqual({
    kind: 'asset_not_transferable',
  });
  expect(
    await ledger.reserve({
      ...wallet,
      holdId: 'blocked-reserve',
      operationId: 'reserve-promotional',
      amount: '1',
      expiresAt,
    }),
  ).toEqual({ kind: 'asset_not_transferable' });
  expect(
    await ledger.redeemProgramUnits({ ...wallet, amount: '3', redemptionReference: 'one-eligible-use' }),
  ).toMatchObject({ kind: 'ok' });
  await pool.query('SELECT pg_sleep(GREATEST(EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())), 0) + 0.02)', [
    expiresAt,
  ]);
  expect(await ledger.readBalance(wallet)).toMatchObject({
    kind: 'ok',
    value: { posted: '7', restricted: '7', available: '0' },
  });
  expect(await ledger.issueProgramUnits({ ...mint, sourceReference: 'too-late' })).toEqual({ kind: 'program_expired' });
  expect(await ledger.redeemProgramUnits({ ...wallet, amount: '1', redemptionReference: 'late' })).toEqual({
    kind: 'program_expired',
  });
  expect(await due()).toEqual({ kind: 'ok', value: { accounts: [wallet.accountId], next: null } });
  const expired = await ledger.expireProgramCredits(wallet);
  expect(expired.kind).toBe('ok');
  expect(await ledger.expireProgramCredits(wallet)).toEqual(expired);
  expect(await due()).toEqual({ kind: 'ok', value: { accounts: [], next: null } });
  expect(await ledger.readBalance(wallet)).toMatchObject({
    kind: 'ok',
    value: { posted: '0', restricted: '0', available: '0' },
  });
  const history = await ledger.readStatement({ ...wallet, limit: 5 });
  expect(history).toMatchObject({
    kind: 'ok',
    value: {
      entries: [{ kind: 'credit_expiry', postedDelta: '-7' }, { kind: 'redeem', postedDelta: '-3' }, { kind: 'issue' }],
    },
  });
  expect(
    (await pool.query('SELECT sum(posted_delta)::text AS total FROM economy.entry WHERE book_id = $1', [bookId])).rows,
  ).toEqual([{ total: '0' }]);
});

test('an operator cannot start provider funding against a programme asset', async () => {
  const { ledger, bookId } = fixture();
  await ledger.provisionAssetProgram(pointPolicy);
  const unexpected = async () => {
    throw new Error('Provider-funded programme asset');
  };
  const store = createFundingStore({ transaction, read: (work) => work(pool) }, bookId, {
    apply: unexpected,
    reserve: unexpected,
    recoverableWalletUnits: unexpected,
  });
  expect(
    await store.begin({
      bookId,
      intentId: 'fund-programme',
      direction: 'deposit',
      walletId: crypto.randomUUID(),
      assetId: pointPolicy.id,
      units: '5',
      provider: { namespace: 'test', mode: 'test', destinationRef: 'test-token' },
    }),
  ).toEqual({ kind: 'ok', value: { kind: 'not_found' } });
});
