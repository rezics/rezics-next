import { afterAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import type { EconomyResult } from '../../src/economy/contract.ts';
import { createEconomyLedger, type EconomyDatabase } from '../../src/economy/ledger.ts';
import type { FundingIntent, FundingObservation } from '../../src/economy/settlement/funding.ts';
import { createFundingLedgerBinder } from '../../src/economy/storage/funding-ledger.ts';
import { createFundingStore } from '../../src/economy/storage/funding-store.ts';
import {
  createDeterministicFundingRail,
  runDeterministicFundingDispatch,
} from '../../src/economy/storage/funding-test-rail.ts';

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

async function fixture(credit = '0') {
  const bookId = `funding:${crypto.randomUUID()}`;
  const wallet = { accountId: crypto.randomUUID(), assetId: 'demo-usd' };
  const namespace = `deterministic:${crypto.randomUUID()}`;
  const provider = { namespace, mode: 'test', destinationRef: 'destination-1' } as const;
  const ledger = createEconomyLedger(database, bookId);
  ok(await ledger.provisionAsset({ id: wallet.assetId, scale: 2, transferable: true }));
  if (credit !== '0') ok(await ledger.issue({ ...wallet, operationId: 'credit-initial', amount: credit }));
  const native = createFundingLedgerBinder(bookId);
  const store = createFundingStore(database, bookId, native);
  const intent = (intentId: string, direction: FundingIntent['direction'], units = '100'): FundingIntent => ({
    bookId,
    intentId,
    direction,
    units,
    walletId: wallet.accountId,
    assetId: wallet.assetId,
    provider,
  });
  return { bookId, wallet, namespace, ledger, native, store, intent };
}

async function prepare(store: ReturnType<typeof createFundingStore>, intent: FundingIntent) {
  expect(ok(await store.begin(intent))).toMatchObject({ kind: 'created', state: { phase: 'ready' } });
  const result = ok(await store.prepare(intent.intentId));
  if (result.kind !== 'queued') throw new Error('Expected a durable funding attempt');
  return result.attemptId;
}

async function controlPositions(bookId: string) {
  const { rows } = await pool.query<{ role: string; accountId: string; posted: string }>(
    `SELECT control.account_role AS role, control.account_id AS "accountId", position.posted::text
     FROM economy.funding_control_account AS control
     JOIN economy.position AS position USING (book_id, asset_id, account_id)
     WHERE control.book_id = $1 ORDER BY control.account_role`,
    [bookId],
  );
  return rows;
}

async function postingProofs(bookId: string) {
  const { rows } = await pool.query<{ kind: string; legs: number; sum: string }>(
    `SELECT journal.kind, count(*)::integer AS legs, sum(entry.posted_delta)::text
     FROM economy.funding_posting AS proof JOIN economy.journal USING (book_id, asset_id, transaction_id)
     JOIN economy.entry USING (book_id, asset_id, transaction_id)
     WHERE proof.book_id = $1 GROUP BY journal.kind, journal.transaction_id ORDER BY journal.kind`,
    [bookId],
  );
  return rows;
}

function evidence(intent: FundingIntent, attemptId: string) {
  return { attemptId, provider: intent.provider, assetId: intent.assetId, units: intent.units };
}

test('deterministic deposit credits once and keeps its signed control out of the wallet', async () => {
  const { bookId, wallet, namespace, ledger, store, intent } = await fixture();
  const deposit = intent('deposit-1', 'deposit');
  const attemptId = await prepare(store, deposit);
  expect(ok(await ledger.readBalance(wallet))).toMatchObject({ posted: '0', available: '0' });
  const rail = createDeterministicFundingRail(namespace, () => 'confirmed');
  expect(await runDeterministicFundingDispatch(store, rail, deposit.intentId, crypto.randomUUID())).toEqual({
    kind: 'ok',
    value: { kind: 'acknowledged' },
  });
  const response = rail.reconcile({ attemptId, intent: deposit });
  if (response.kind !== 'observed') throw new Error('Expected a provider observation');
  expect(ok(await store.observe(deposit.intentId, response.observation))).toEqual({ kind: 'replayed' });
  expect(ok(await store.observe(deposit.intentId, { ...response.observation, units: '99' }))).toEqual({
    kind: 'conflict',
  });
  expect(ok(await ledger.readBalance(wallet))).toMatchObject({ posted: '100', held: '0', available: '100' });
  expect(ok(await ledger.readStatement({ ...wallet, limit: 5 }))).toMatchObject({
    entries: [{ kind: 'deposit', postedDelta: '100' }],
  });
  const controls = await controlPositions(bookId);
  expect(controls).toMatchObject([{ role: 'provider_clearing', posted: '-100' }]);
  expect(await ledger.readBalance({ ...wallet, accountId: controls[0]!.accountId })).toEqual({
    kind: 'invalid_operation',
  });
  expect(ok(await ledger.readStatement({ ...wallet, accountId: controls[0]!.accountId, limit: 5 })).entries).toEqual(
    [],
  );
  expect(await postingProofs(bookId)).toEqual([{ kind: 'deposit', legs: 2, sum: '0' }]);
});

test('accepted-unknown withdrawal remains protected through expiry, then captures and posts a linked return', async () => {
  const { bookId, wallet, namespace, ledger, store, intent } = await fixture('100');
  const withdrawal = intent('withdrawal-1', 'withdrawal', '70');
  const attemptId = await prepare(store, withdrawal);
  expect(ok(await ledger.readBalance(wallet))).toMatchObject({ posted: '100', held: '70', available: '30' });
  let submissions = 0;
  const rail = createDeterministicFundingRail(namespace, () => {
    submissions++;
    return 'accepted_unknown';
  });
  expect(await runDeterministicFundingDispatch(store, rail, withdrawal.intentId, crypto.randomUUID())).toMatchObject({
    kind: 'ok',
    value: { kind: 'acknowledged' },
  });
  expect(ok(await store.read(withdrawal.intentId))).toMatchObject({ phase: 'unknown' });
  const hold = { ...wallet, holdId: attemptId };
  const allocation = { ...hold, purpose: 'withdrawal', reference: attemptId } as const;
  expect(ok(await ledger.readAllocation(allocation))).toMatchObject({ status: 'protected', amount: '70' });
  await pool.query(
    `UPDATE economy.hold SET expires_at = statement_timestamp() - interval '1 second'
    WHERE book_id = $1 AND asset_id = $2 AND account_id = $3 AND hold_id = $4`,
    [bookId, wallet.assetId, wallet.accountId, attemptId],
  );
  expect(await ledger.expire({ ...hold, operationId: 'expire-unallocated' })).toEqual({ kind: 'hold_closed' });
  expect(ok(await ledger.readBalance(wallet))).toMatchObject({ posted: '100', held: '70', available: '30' });
  await pool.query(
    `UPDATE economy.funding_dispatch SET due_at = statement_timestamp() WHERE book_id = $1 AND intent_id = $2`,
    [bookId, withdrawal.intentId],
  );
  expect(await runDeterministicFundingDispatch(store, rail, withdrawal.intentId, crypto.randomUUID())).toMatchObject({
    kind: 'ok',
    value: { kind: 'acknowledged' },
  });
  expect(submissions).toBe(1);
  const providerResult = rail.reconcile({ attemptId, intent: withdrawal });
  if (providerResult.kind !== 'observed' || providerResult.observation.kind !== 'confirmed')
    throw new Error('Expected the confirmed provider movement');
  expect(ok(await ledger.readAllocation(allocation))).toMatchObject({ status: 'captured' });
  expect(ok(await ledger.readBalance(wallet))).toMatchObject({ posted: '30', held: '0', available: '30' });
  const returned: FundingObservation = {
    ...evidence(withdrawal, attemptId),
    kind: 'returned',
    movementId: 'return-1',
    originalMovementId: providerResult.observation.movementId,
    units: '30',
  };
  expect(ok(await store.observe(withdrawal.intentId, returned))).toMatchObject({
    kind: 'applied',
    state: { reversedUnits: '30' },
  });
  expect(ok(await store.observe(withdrawal.intentId, returned))).toEqual({ kind: 'replayed' });
  expect(ok(await ledger.readBalance(wallet))).toMatchObject({ posted: '60', held: '0', available: '60' });
  expect(await controlPositions(bookId)).toMatchObject([{ role: 'provider_clearing', posted: '40' }]);
  expect(await postingProofs(bookId)).toEqual([
    { kind: 'withdrawal', legs: 2, sum: '0' },
    { kind: 'withdrawal_return', legs: 2, sum: '0' },
  ]);
});

test('definitive refusal releases the allocation once without moving cash', async () => {
  const { bookId, wallet, namespace, ledger, store, intent } = await fixture('100');
  const withdrawal = intent('refused-1', 'withdrawal');
  const attemptId = await prepare(store, withdrawal);
  const rail = createDeterministicFundingRail(namespace, () => 'refused');
  expect(await runDeterministicFundingDispatch(store, rail, withdrawal.intentId, crypto.randomUUID())).toMatchObject({
    kind: 'ok',
    value: { kind: 'acknowledged' },
  });
  const response = rail.reconcile({ attemptId, intent: withdrawal });
  if (response.kind !== 'observed') throw new Error('Expected withdrawal refusal evidence');
  expect(ok(await store.observe(withdrawal.intentId, response.observation))).toEqual({ kind: 'replayed' });
  expect(ok(await ledger.readBalance(wallet))).toMatchObject({ posted: '100', held: '0', available: '100' });
  expect(
    ok(await ledger.readAllocation({ ...wallet, holdId: attemptId, purpose: 'withdrawal', reference: attemptId })),
  ).toMatchObject({ status: 'released' });
  expect(await controlPositions(bookId)).toEqual([]);
  expect(await postingProofs(bookId)).toEqual([{ kind: 'withdrawal_refusal', legs: 1, sum: '0' }]);
});

test('chargeback consumes only locked availability and records the remaining receivable separately', async () => {
  const { bookId, wallet, namespace, ledger, store, intent } = await fixture();
  const deposit = intent('deposit-spent', 'deposit');
  const attemptId = await prepare(store, deposit);
  const rail = createDeterministicFundingRail(namespace, () => 'confirmed');
  expect(await runDeterministicFundingDispatch(store, rail, deposit.intentId, crypto.randomUUID())).toMatchObject({
    kind: 'ok',
    value: { kind: 'acknowledged' },
  });
  const original = rail.reconcile({ attemptId, intent: deposit });
  if (original.kind !== 'observed' || original.observation.kind !== 'confirmed')
    throw new Error('Expected deposit evidence');
  ok(
    await ledger.reserve({
      ...wallet,
      holdId: 'unrelated',
      amount: '20',
      operationId: 'unrelated-reserve',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  ok(await ledger.transfer({ ...wallet, operationId: 'spent', recipientId: crypto.randomUUID(), amount: '70' }));
  const chargeback: FundingObservation = {
    ...evidence(deposit, attemptId),
    kind: 'chargeback',
    movementId: 'chargeback-1',
    originalMovementId: original.observation.movementId,
  };
  expect(ok(await store.observe(deposit.intentId, chargeback))).toMatchObject({
    kind: 'applied',
    state: { phase: 'reversed' },
    effect: { kind: 'post', chargebackShortfall: '90' },
  });
  expect(ok(await ledger.readBalance(wallet))).toMatchObject({ posted: '20', held: '20', available: '0' });
  expect(ok(await store.observe(deposit.intentId, chargeback))).toEqual({ kind: 'replayed' });
  expect(await controlPositions(bookId)).toMatchObject([
    { role: 'chargeback_receivable', posted: '-90' },
    { role: 'provider_clearing', posted: '0' },
  ]);
  expect(await postingProofs(bookId)).toEqual([
    { kind: 'chargeback', legs: 3, sum: '0' },
    { kind: 'deposit', legs: 2, sum: '0' },
  ]);
});

test('a fault after native posting rolls back money, evidence, journal linkage and dispatch acknowledgment', async () => {
  const { bookId, wallet, namespace, ledger, native, intent } = await fixture('100');
  let fail = true;
  const store = createFundingStore(database, bookId, {
    ...native,
    async apply(tx, posting) {
      await native.apply(tx, posting);
      if (fail) throw new Error('injected failure after native posting');
    },
  });
  const withdrawal = intent('atomic-1', 'withdrawal', '70');
  const attemptId = await prepare(store, withdrawal);
  const rail = createDeterministicFundingRail(namespace, () => 'confirmed');
  const claimId = crypto.randomUUID();
  await expect(runDeterministicFundingDispatch(store, rail, withdrawal.intentId, claimId)).rejects.toThrow(
    'injected failure after native posting',
  );
  expect(ok(await ledger.readBalance(wallet))).toMatchObject({ posted: '100', held: '70', available: '30' });
  expect(ok(await store.read(withdrawal.intentId))).toMatchObject({ phase: 'submitted', confirmedMovementId: null });
  expect(ok(await store.claim(withdrawal.intentId, claimId))).toMatchObject({
    kind: 'claimed',
    attempt: { attemptId },
  });
  expect(await controlPositions(bookId)).toEqual([]);
  expect(await postingProofs(bookId)).toEqual([]);
  const receipt = await pool.query(`SELECT source_id FROM economy.funding_evidence WHERE provider_namespace = $1`, [
    namespace,
  ]);
  expect(receipt.rowCount).toBe(0);
  fail = false;
  expect(await runDeterministicFundingDispatch(store, rail, withdrawal.intentId, claimId)).toMatchObject({
    kind: 'ok',
    value: { kind: 'acknowledged' },
  });
  expect(ok(await ledger.readBalance(wallet))).toMatchObject({ posted: '30', held: '0', available: '30' });
  expect(await postingProofs(bookId)).toEqual([{ kind: 'withdrawal', legs: 2, sum: '0' }]);
});

test('test rail rejects a live intent before claiming its persisted action', async () => {
  const { store, intent, namespace } = await fixture();
  const deposit = intent('live-1', 'deposit');
  const liveIntent = { ...deposit, provider: { ...deposit.provider, mode: 'live' } } as const;
  await prepare(store, liveIntent);
  const rail = createDeterministicFundingRail(namespace, () => {
    throw new Error('Unexpected rail call');
  });
  expect(await runDeterministicFundingDispatch(store, rail, liveIntent.intentId, crypto.randomUUID())).toEqual({
    kind: 'test_rail_ineligible',
  });
  expect(ok(await store.due())).toEqual([liveIntent.intentId]);
});
