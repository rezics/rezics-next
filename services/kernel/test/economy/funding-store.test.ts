import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import type { EconomyResult } from '../../src/economy/contract.ts';
import type { EconomyDatabase } from '../../src/economy/ledger.ts';
import type { FundingIntent, FundingObservation } from '../../src/economy/settlement/funding.ts';
import { createFundingStore, type FundingLedgerBinder } from '../../src/economy/storage/funding-store.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const database: EconomyDatabase = {
  async transaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(`SET LOCAL statement_timeout = '3000ms'`);
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

beforeAll(async () => {
  await pool.query(`CREATE TABLE funding_store_test_effect (
    book_id text NOT NULL, effect_id text NOT NULL, kind text NOT NULL,
    PRIMARY KEY (book_id, effect_id)
  )`);
});
afterAll(async () => {
  try {
    await pool.query('DROP TABLE IF EXISTS funding_store_test_effect');
  } finally {
    await pool.end();
  }
});

function ok<T>(result: EconomyResult<T>): T {
  if (result.kind !== 'ok') throw new Error(`Expected a native result, received ${result.kind}`);
  return result.value;
}

async function fixture(direction: FundingIntent['direction'] = 'deposit', providerNamespace = crypto.randomUUID()) {
  const failure = { reserve: false, posting: false };
  const binder: FundingLedgerBinder = {
    async reserve(tx, reservation) {
      await tx.query('INSERT INTO funding_store_test_effect VALUES ($1, $2, $3)', [
        reservation.bookId,
        reservation.holdId,
        'reserve',
      ]);
      return { ...reservation, protected: !failure.reserve };
    },
    async recoverableWalletUnits(tx, intent) {
      const result = await tx.query<{ kind: string }>(
        `SELECT kind FROM funding_store_test_effect WHERE book_id = $1 AND kind = 'locked_available' FOR UPDATE`,
        [intent.bookId],
      );
      if (!result.rows[0]) throw new Error('Test balance missing');
      return '30';
    },
    async apply(tx, { intent, receipt, effect }) {
      await tx.query('INSERT INTO funding_store_test_effect VALUES ($1, $2, $3)', [
        intent.bookId,
        receipt.key.id,
        effect.kind,
      ]);
      if (failure.posting) throw new Error('book posting failed');
    },
  };
  const bookId = `test:${crypto.randomUUID()}`;
  const intent: FundingIntent = {
    bookId,
    intentId: 'intent-1',
    walletId: crypto.randomUUID(),
    assetId: 'demo-usd',
    units: '100',
    direction,
    provider: { namespace: providerNamespace, mode: 'test', destinationRef: 'destination-1' },
  };
  await pool.query('INSERT INTO economy.asset VALUES ($1, $2, 2, TRUE)', [bookId, intent.assetId]);
  return { intent, failure, store: createFundingStore(database, bookId, binder) };
}

function confirmed(intent: FundingIntent, movementId = 'movement-1'): FundingObservation {
  return {
    kind: 'confirmed',
    attemptId: `funding/${intent.bookId}/${intent.intentId}`,
    provider: intent.provider,
    assetId: intent.assetId,
    units: intent.units,
    movementId,
  };
}

async function effects(bookId: string): Promise<string[]> {
  const { rows } = await pool.query<{ kind: string }>(
    'SELECT kind FROM funding_store_test_effect WHERE book_id = $1 ORDER BY kind',
    [bookId],
  );
  return rows.map(({ kind }) => kind);
}

async function expireLease(bookId: string, intentId: string) {
  await pool.query(
    'UPDATE economy.funding_dispatch SET due_at = statement_timestamp() WHERE book_id = $1 AND intent_id = $2',
    [bookId, intentId],
  );
  await pool.query(
    `UPDATE economy.funding_dispatch_claim SET lease_until = statement_timestamp() - interval '1 second'
    WHERE book_id = $1 AND intent_id = $2`,
    [bookId, intentId],
  );
}

test('withdrawal preparation protects one hold and replays one named dispatch and claim after response loss', async () => {
  const { intent, store } = await fixture('withdrawal');
  const begun = ok(await store.begin(intent));
  expect(begun).toMatchObject({ kind: 'created', state: { phase: 'ready' } });
  expect(ok(await store.begin(intent))).toMatchObject({ kind: 'replayed', state: { phase: 'ready' } });
  expect(ok(await store.begin({ ...intent, provider: { ...intent.provider, destinationRef: 'changed' } }))).toEqual({
    kind: 'conflict',
  });
  expect(await effects(intent.bookId)).toEqual(['reserve']);
  const queue = ok(await store.prepare(intent.intentId));
  expect(queue).toMatchObject({ kind: 'queued', action: 'submit' });
  expect(ok(await store.prepare(intent.intentId))).toEqual(queue);
  expect(ok(await store.due())).toEqual([intent.intentId]);
  const claimId = crypto.randomUUID();
  const claim = ok(await store.claim(intent.intentId, claimId));
  expect(claim).toMatchObject({ kind: 'claimed', action: 'submit', claimId });
  expect(ok(await store.claim(intent.intentId, claimId))).toEqual(claim);
  expect(ok(await store.claim(intent.intentId, crypto.randomUUID()))).toEqual({ kind: 'idle' });
  expect(ok(await store.due())).toEqual([]);
  const ack = ok(await store.acknowledge(intent.intentId, claimId, { kind: 'unknown' }));
  expect(ack).toEqual({ kind: 'acknowledged' });
  expect(ok(await store.acknowledge(intent.intentId, claimId, { kind: 'unknown' }))).toEqual(ack);
  expect(ok(await store.read(intent.intentId))).toMatchObject({ phase: 'unknown' });
  expect(await effects(intent.bookId)).toEqual(['reserve']);
  const reconcile = ok(await store.prepare(intent.intentId));
  expect(reconcile).toMatchObject({
    kind: 'queued',
    action: 'reconcile',
    attemptId: queue.kind === 'queued' ? queue.attemptId : '',
  });
});

test('expiry fences an abandoned submit claim and resumes evidence lookup under the same attempt', async () => {
  const { intent, store } = await fixture('withdrawal');
  expect(ok(await store.begin(intent))).toMatchObject({ kind: 'created' });
  expect(ok(await store.prepare(intent.intentId))).toMatchObject({ kind: 'queued' });
  const firstToken = crypto.randomUUID();
  const first = ok(await store.claim(intent.intentId, firstToken));
  if (first.kind !== 'claimed') throw new Error('Expected initial provider claim');
  await expireLease(intent.bookId, intent.intentId);
  const secondToken = crypto.randomUUID();
  const second = ok(await store.claim(intent.intentId, secondToken));
  expect(second).toMatchObject({ kind: 'claimed', action: 'reconcile', attempt: first.attempt });
  const acknowledgment = { kind: 'observed', observation: confirmed(intent) } as const;
  expect(ok(await store.acknowledge(intent.intentId, firstToken, acknowledgment))).toEqual({ kind: 'stale' });
  expect(await effects(intent.bookId)).toEqual(['reserve']);
  const accepted = ok(await store.acknowledge(intent.intentId, secondToken, acknowledgment));
  expect(accepted).toEqual({ kind: 'acknowledged' });
  expect(ok(await store.acknowledge(intent.intentId, secondToken, acknowledgment))).toEqual(accepted);
  expect(ok(await store.acknowledge(intent.intentId, secondToken, { kind: 'unknown' }))).toEqual({ kind: 'conflict' });
  expect(ok(await store.read(intent.intentId))).toMatchObject({ phase: 'confirmed' });
  expect(ok(await store.due())).toEqual([]);
  expect(await effects(intent.bookId)).toEqual(['post', 'reserve']);
});

test('concurrent observations across books claim the global provider movement only once', async () => {
  const namespace = crypto.randomUUID();
  const candidates = await Promise.all([fixture('deposit', namespace), fixture('deposit', namespace)]);
  for (const { intent, store } of candidates) {
    expect(ok(await store.begin(intent))).toMatchObject({ kind: 'created' });
    expect(ok(await store.prepare(intent.intentId))).toMatchObject({ kind: 'queued' });
  }
  const observations = await Promise.all(
    candidates.map(async ({ intent, store }) => ok(await store.observe(intent.intentId, confirmed(intent)))),
  );
  expect(observations.map(({ kind }) => kind).sort()).toEqual(['applied', 'conflict']);
  const [winner, loser] = observations[0]?.kind === 'applied' ? candidates : candidates.toReversed();
  const count = await pool.query(
    `SELECT provider_namespace FROM economy.funding_evidence WHERE provider_namespace = $1`,
    [namespace],
  );
  expect(count.rowCount).toBe(1);
  expect(await effects(winner!.intent.bookId)).toEqual(['post']);
  expect(await effects(loser!.intent.bookId)).toEqual([]);
  expect(ok(await winner!.store.observe(winner!.intent.intentId, confirmed(winner!.intent)))).toEqual({
    kind: 'replayed',
  });
  const altered = { ...confirmed(winner!.intent), units: '90' };
  expect(ok(await winner!.store.observe(winner!.intent.intentId, altered))).toEqual({ kind: 'conflict' });
});

test('binder failures roll back withdrawal preparation and the combined evidence, book posting and dispatch update', async () => {
  const { intent, store, failure } = await fixture('withdrawal');
  failure.reserve = true;
  await expect(store.begin(intent)).rejects.toThrow('did not protect the exact withdrawal hold');
  expect(ok(await store.read(intent.intentId))).toBeNull();
  expect(await effects(intent.bookId)).toEqual([]);
  failure.reserve = false;
  expect(ok(await store.begin(intent))).toMatchObject({ kind: 'created' });
  expect(ok(await store.prepare(intent.intentId))).toMatchObject({ kind: 'queued' });
  const token = crypto.randomUUID();
  const claimed = ok(await store.claim(intent.intentId, token));
  const ack = { kind: 'observed', observation: confirmed(intent) } as const;
  failure.posting = true;
  await expect(store.acknowledge(intent.intentId, token, ack)).rejects.toThrow('book posting failed');
  expect(ok(await store.claim(intent.intentId, token))).toEqual(claimed);
  expect(ok(await store.read(intent.intentId))).toMatchObject({ phase: 'submitted' });
  const count = await pool.query(`SELECT source_id FROM economy.funding_evidence WHERE provider_namespace = $1`, [
    intent.provider.namespace,
  ]);
  expect(count.rowCount).toBe(0);
  expect(await effects(intent.bookId)).toEqual(['reserve']);
  failure.posting = false;
  expect(ok(await store.acknowledge(intent.intentId, token, ack))).toEqual({ kind: 'acknowledged' });
  expect(await effects(intent.bookId)).toEqual(['post', 'reserve']);
});

test('native chargeback plan reads the locked wallet only after claiming the provider movement', async () => {
  const { intent, store } = await fixture();
  expect(ok(await store.begin(intent))).toMatchObject({ kind: 'created' });
  expect(ok(await store.prepare(intent.intentId))).toMatchObject({ kind: 'queued' });
  const deposit = confirmed(intent);
  expect(ok(await store.observe(intent.intentId, deposit))).toMatchObject({ kind: 'applied' });
  const chargeback: FundingObservation = {
    ...deposit,
    kind: 'chargeback',
    movementId: 'chargeback-1',
    originalMovementId: 'movement-1',
  };
  await expect(store.observe(intent.intentId, chargeback)).rejects.toThrow('Test balance missing');
  await pool.query('INSERT INTO funding_store_test_effect VALUES ($1, $2, $3)', [
    intent.bookId,
    'available',
    'locked_available',
  ]);
  expect(ok(await store.observe(intent.intentId, chargeback))).toMatchObject({
    kind: 'applied',
    state: { phase: 'reversed' },
    effect: { kind: 'post', chargebackShortfall: '70' },
  });
  await pool.query(`DELETE FROM funding_store_test_effect WHERE book_id = $1 AND kind = 'locked_available'`, [
    intent.bookId,
  ]);
  expect(ok(await store.observe(intent.intentId, chargeback))).toEqual({ kind: 'replayed' });
  expect(await effects(intent.bookId)).toEqual(['post', 'post']);
});
