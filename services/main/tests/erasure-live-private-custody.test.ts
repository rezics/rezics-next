import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ReceiptCustodyErasureConflict, PostgresReceiptCustodyStore,
  type CustodyPayloadErasure, type ReceiptCustodySession } from '../src/modules/outbox/receipt-custody.ts';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

async function clearPayload(session: ReceiptCustodySession, erasure: CustodyPayloadErasure): Promise<void> {
  if (!session.clearPayloadForErasure) throw new Error('PostgreSQL custody erasure is unavailable');
  await session.clearPayloadForErasure(erasure);
}

test('P2 command custody erasure preserves receipt facts and serializes exact replay', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 1, connectionTimeoutMillis: 1_000 });
  const receipt = `urn:rezics:receipt:${randomUUID()}`;
  const revision = `https://rezics.com/id/${randomUUID()}`;
  const requestDigest = hash('custody request');
  const payload = Buffer.from(JSON.stringify({ format: 'custody-erasure-fixture-v1', secret: 'raw command' }));
  const payloadSha256 = hash(payload);
  const erasure: CustodyPayloadErasure = { revision, payloadSha256,
    erasureId: randomUUID(), erasureEpoch: '12' };
  const store = new PostgresReceiptCustodyStore(pool);
  let borrowedClient: PoolClient | undefined;
  try {
    const migrationClient = await pool.connect();
    borrowedClient = migrationClient;
    await migrationClient.query('BEGIN');
    try {
      for (const file of schemaFiles(root, 'access')) {
        await migrationClient.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
      }
      await migrationClient.query('COMMIT');
    } catch (error) {
      await migrationClient.query('ROLLBACK');
      throw error;
    } finally {
      migrationClient.release();
      borrowedClient = undefined;
    }

    const terminal = { receipt, outcome: 'succeeded', requestDigest, revision,
      dataEpoch: 'custody-test-epoch', sequence: '7', streamSequence: '21' };
    const outbox = { batchId: `custody-${randomUUID()}`, events: [] };
    await pool.query(`INSERT INTO access.command_custody
      (receipt, request_digest, payload_sha256, payload, revision, terminal, outbox,
       reconciled_at, data_epoch, stream_sequence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp(),'custody-test-epoch',21)`,
    [receipt, requestDigest, payloadSha256, payload, revision, terminal, outbox]);
    const before = (await pool.query(`SELECT receipt,request_digest,payload_sha256,revision,terminal,outbox,
      reconciled_at,retired_at,data_epoch,stream_sequence::text AS stream_sequence
      FROM access.command_custody WHERE receipt=$1`, [receipt])).rows[0];

    const client = await pool.connect();
    borrowedClient = client;
    try {
      await client.query(`CREATE FUNCTION access.reject_fixture_custody_clear() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rejects custody payload clear'; END $$`);
      await client.query(`CREATE TRIGGER zz_fixture_reject_custody_clear
        AFTER UPDATE OF payload ON access.command_custody FOR EACH ROW
        WHEN (OLD.payload IS NOT NULL AND NEW.payload IS NULL)
        EXECUTE FUNCTION access.reject_fixture_custody_clear()`);
      await expect(store.withReceipt(receipt, async session => {
        expect(session.client).toBe(client);
        await clearPayload(session, erasure);
      }, client)).rejects.toThrow('fixture rejects custody payload clear');
      const rolledBack = (await client.query(`SELECT payload,payload_erasure_id,payload_erasure_epoch
        FROM access.command_custody WHERE receipt=$1`, [receipt])).rows[0]!;
      expect(rolledBack.payload).toEqual(payload);
      expect(rolledBack.payload_erasure_id).toBeNull();
      expect(rolledBack.payload_erasure_epoch).toBeNull();
      await client.query('DROP TRIGGER zz_fixture_reject_custody_clear ON access.command_custody');
      await client.query('DROP FUNCTION access.reject_fixture_custody_clear()');

      await store.withReceipt(receipt, async session => {
        expect(session.client).toBe(client);
        await clearPayload(session, erasure);
        const row = await session.read();
        expect(row).toMatchObject({ payload: null, payloadErasure: {
          erasureId: erasure.erasureId, erasureEpoch: erasure.erasureEpoch } });
      }, client);
      expect(pool.totalCount).toBe(1);
    } finally {
      try {
        await client.query('DROP TRIGGER IF EXISTS zz_fixture_reject_custody_clear ON access.command_custody');
        await client.query('DROP FUNCTION IF EXISTS access.reject_fixture_custody_clear()');
      } finally {
        client.release();
        borrowedClient = undefined;
      }
    }

    await store.withReceipt(receipt, session => clearPayload(session, erasure));
    for (const foreign of [
      { ...erasure, erasureId: randomUUID() },
      { ...erasure, erasureEpoch: '13' },
      { ...erasure, revision: `https://rezics.com/id/${randomUUID()}` },
      { ...erasure, payloadSha256: 'f'.repeat(64) },
    ]) {
      await expect(store.withReceipt(receipt, session => clearPayload(session, foreign)))
        .rejects.toBeInstanceOf(ReceiptCustodyErasureConflict);
    }

    await expect(pool.query('UPDATE access.command_custody SET revision=$2 WHERE receipt=$1',
      [receipt, `https://rezics.com/id/${randomUUID()}`])).rejects.toThrow('identity is immutable');
    await expect(pool.query('UPDATE access.command_custody SET request_digest=$2 WHERE receipt=$1',
      [receipt, 'a'.repeat(64)])).rejects.toThrow('identity is immutable');
    await expect(pool.query('UPDATE access.command_custody SET payload_sha256=$2 WHERE receipt=$1',
      [receipt, 'b'.repeat(64)])).rejects.toThrow('identity is immutable');
    await expect(pool.query('UPDATE access.command_custody SET payload=$2 WHERE receipt=$1', [receipt, payload]))
      .rejects.toThrow('terminal');
    await expect(pool.query('UPDATE access.command_custody SET payload_erasure_epoch=13 WHERE receipt=$1', [receipt]))
      .rejects.toThrow('terminal');
    await expect(pool.query("UPDATE access.command_custody SET terminal='{}'::jsonb WHERE receipt=$1", [receipt]))
      .rejects.toThrow('terminal');
    await expect(pool.query('DELETE FROM access.command_custody WHERE receipt=$1', [receipt]))
      .rejects.toThrow('receipts are retained');
    await expect(store.withReceipt(receipt, session => session.retire()))
      .rejects.toThrow('Receipt custody is not reconciled');

    let releaseRace!: () => void;
    let signalLocked!: () => void;
    const locked = new Promise<void>(resolveLocked => { signalLocked = resolveLocked; });
    const hold = new Promise<void>(resolveHold => { releaseRace = resolveHold; });
    const winner = store.withReceipt(receipt, async session => {
      signalLocked();
      await hold;
      await clearPayload(session, erasure);
    });
    await locked;
    const competitor = store.withReceipt(receipt, session => clearPayload(session,
      { ...erasure, erasureId: randomUUID() }));
    try {
      await Promise.resolve();
      expect(pool.options.max).toBe(1);
      expect(pool.totalCount).toBe(1);
      expect(pool.waitingCount).toBe(1);
    } finally {
      releaseRace();
    }
    await winner;
    await expect(competitor).rejects.toBeInstanceOf(ReceiptCustodyErasureConflict);

    const after = (await pool.query(`SELECT receipt,request_digest,payload_sha256,payload,revision,terminal,outbox,
      reconciled_at,retired_at,data_epoch,stream_sequence::text AS stream_sequence,
      payload_erasure_id,payload_erasure_epoch::text AS payload_erasure_epoch
      FROM access.command_custody WHERE receipt=$1`, [receipt])).rows[0];
    expect(after).toMatchObject({ ...before, payload: null, payload_erasure_id: erasure.erasureId,
      payload_erasure_epoch: erasure.erasureEpoch });
    expect(after.payload_sha256).toBe(payloadSha256);
  } finally {
    borrowedClient?.release();
    await pool.end();
    cluster.remove();
  }
}, 60_000);
