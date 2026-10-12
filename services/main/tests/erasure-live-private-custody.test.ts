import { expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { ReceiptCustodyErasureConflict, PostgresReceiptCustodyStore,
  type CustodiedReceipt, type CustodyPayloadErasure, type ReceiptCustodySession }
  from '../src/modules/outbox/receipt-custody.ts';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

async function tryReceiptLock(client: PoolClient, receipt: string): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`command-custody:${receipt}`]);
  const locked = result.rows[0]?.locked === true;
  if (locked) {
    const unlock = await client.query<{ unlocked: boolean }>(
      'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [`command-custody:${receipt}`]);
    if (unlock.rows[0]?.unlocked !== true) throw new Error('Could not release a successful custody lock probe');
  }
  return locked;
}

async function waitUntilBlocked(observer: Pool, waiterPid: number, blockerPid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const blockers = (await observer.query<{ blockers: number[] }>(
      'SELECT pg_blocking_pids($1) AS blockers', [waiterPid])).rows[0]?.blockers ?? [];
    if (blockers.includes(blockerPid)) return true;
    await new Promise(resolve => setTimeout(resolve, 15));
  } while (Date.now() < deadline);
  return false;
}

async function within<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} exceeded ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleOrDisconnect(promises: readonly Promise<unknown>[], disconnect: () => Promise<unknown>,
  description: string): Promise<void> {
  const settled = Promise.allSettled(promises);
  try { await within(settled, 5_000, description); }
  catch {
    try { await disconnect(); } catch { /* Emergency disconnect only unblocks a failed proof. */ }
    await settled;
  }
}

function lifecycleSql(calls: readonly (readonly unknown[])[]): string[] {
  return calls.map(call => String(call[0]).trim())
    .filter(sql => /^(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(sql) || /pg_advisory_unlock/i.test(sql));
}

async function clearPayload(session: ReceiptCustodySession, erasure: CustodyPayloadErasure): Promise<void> {
  const row = await session.read();
  if (row?.payload && !Object.hasOwn(row.outbox ?? {}, 'custodyObjectReferences')) {
    if (!session.persistObjectReferences) throw new Error('Receipt custody closure persistence is unavailable');
    await session.persistObjectReferences([
      { digest: erasure.payloadSha256, kind: 'command' },
      { digest: hash('fixture retained manifest'), kind: 'manifest' },
      { digest: hash('fixture retained payload'), kind: 'payload' },
      { digest: hash('fixture retained validation shape'), kind: 'shape' },
    ]);
  }
  if (!session.clearPayloadForErasure) throw new Error('PostgreSQL custody erasure is unavailable');
  await session.clearPayloadForErasure(erasure);
}

test('P2 command custody erasure preserves receipt facts and serializes exact replay', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection, max: 1, connectionTimeoutMillis: 1_000 });
  const lockPool = new Pool({ ...cluster.connection, max: 2, connectionTimeoutMillis: 1_000 });
  const observerPool = new Pool({ ...cluster.connection, max: 1, connectionTimeoutMillis: 1_000 });
  const receipt = `urn:rezics:receipt:${randomUUID()}`;
  const revision = `https://rezics.com/id/${randomUUID()}`;
  const requestDigest = hash('custody request');
  const payload = Buffer.from(JSON.stringify({ format: 'custody-erasure-fixture-v1', secret: 'raw command' }));
  const payloadSha256 = hash(payload);
  const erasure: CustodyPayloadErasure = { revision, payloadSha256,
    erasureId: randomUUID(), erasureEpoch: '12' };
  const store = new PostgresReceiptCustodyStore(pool);
  const lockStore = new PostgresReceiptCustodyStore(lockPool);
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

    // A held session lock, rather than row or pool serialization, must block a
    // second idle borrowed client on the same receipt key.
    const idleA = await lockPool.connect();
    const idleB = await lockPool.connect();
    const idleARelease = spyOn(idleA, 'release'), idleAEnd = spyOn(idleA, 'end');
    const idleBRelease = spyOn(idleB, 'release'), idleBEnd = spyOn(idleB, 'end');
    try {
      const idlePids = await Promise.all([idleA, idleB].map(async connection =>
        (await connection.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid));
      expect(idlePids[0]).not.toBe(idlePids[1]);
      expect(idleA.getTransactionStatus()).toBe('I');
      expect(idleB.getTransactionStatus()).toBe('I');
      const idleReceipt = `urn:rezics:receipt:${randomUUID()}`;
      let releaseIdleA!: () => void, signalIdleA!: () => void;
      const idleAReady = new Promise<void>(resolveReady => { signalIdleA = resolveReady; });
      const idleAHold = new Promise<void>(resolveHold => { releaseIdleA = resolveHold; });
      const idleOwner = lockStore.withReceipt(idleReceipt, async () => {
        signalIdleA();
        await idleAHold;
      }, idleA);
      let idleContender: Promise<void> | undefined;
      let idleBEntered = false;
      try {
        await within(idleAReady, 5_000, 'idle borrowed lock owner entry');
        expect(await tryReceiptLock(idleB, idleReceipt)).toBe(false);
        const waitingPid = idlePids[1]!;
        idleContender = lockStore.withReceipt(idleReceipt, async () => { idleBEntered = true; }, idleB);
        expect(await waitUntilBlocked(observerPool, waitingPid, idlePids[0]!)).toBe(true);
        expect(idleBEntered).toBe(false);
      } finally {
        releaseIdleA();
        await settleOrDisconnect([idleOwner, ...(idleContender ? [idleContender] : [])],
          () => idleA.end(), 'idle borrowed lock proof cleanup');
      }
      await idleOwner;
      await idleContender;
      expect(idleBEntered).toBe(true);
      expect(idleA.getTransactionStatus()).toBe('I');
      expect(idleB.getTransactionStatus()).toBe('I');
      expect((await idleA.query('SELECT 1')).rowCount).toBe(1);
      expect((await idleB.query('SELECT 1')).rowCount).toBe(1);
      expect(idleARelease).not.toHaveBeenCalled();
      expect(idleAEnd).not.toHaveBeenCalled();
      expect(idleBRelease).not.toHaveBeenCalled();
      expect(idleBEnd).not.toHaveBeenCalled();
    } finally {
      idleARelease.mockRestore(); idleAEnd.mockRestore();
      idleBRelease.mockRestore(); idleBEnd.mockRestore();
      idleA.release(); idleB.release();
    }

    // The same session lock must also conflict across an owned session and an
    // idle borrowed client.
    const mixedBorrower = await lockPool.connect();
    const mixedBorrowerRelease = spyOn(mixedBorrower, 'release');
    const mixedBorrowerEnd = spyOn(mixedBorrower, 'end');
    let releaseOwned!: () => void, signalOwned!: () => void;
    const ownedReady = new Promise<void>(resolveReady => { signalOwned = resolveReady; });
    const ownedHold = new Promise<void>(resolveHold => { releaseOwned = resolveHold; });
    const mixedReceipt = `urn:rezics:receipt:${randomUUID()}`;
    let ownedPid = 0, mixedEntered = false;
    let ownedClient: PoolClient | undefined;
    const ownedLock = lockStore.withReceipt(mixedReceipt, async session => {
      ownedClient = session.client!;
      ownedPid = (await ownedClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      signalOwned();
      await ownedHold;
    });
    let mixedWaiter: Promise<void> | undefined;
    try {
      const borrowerPid = (await mixedBorrower.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      expect(mixedBorrower.getTransactionStatus()).toBe('I');
      await within(ownedReady, 5_000, 'owned lock owner entry');
      expect(ownedPid).not.toBe(borrowerPid);
      expect(await tryReceiptLock(mixedBorrower, mixedReceipt)).toBe(false);
      mixedWaiter = lockStore.withReceipt(mixedReceipt, async () => { mixedEntered = true; }, mixedBorrower);
      expect(await waitUntilBlocked(observerPool, borrowerPid, ownedPid)).toBe(true);
      expect(mixedEntered).toBe(false);
      releaseOwned();
      await ownedLock;
      await mixedWaiter;
      expect(mixedEntered).toBe(true);
      expect(mixedBorrower.getTransactionStatus()).toBe('I');
      expect(mixedBorrowerRelease).not.toHaveBeenCalled();
      expect(mixedBorrowerEnd).not.toHaveBeenCalled();
    } finally {
      releaseOwned();
      await settleOrDisconnect([ownedLock, ...(mixedWaiter ? [mixedWaiter] : [])],
        async () => { if (ownedClient) await ownedClient.end(); }, 'mixed owner lock proof cleanup');
      mixedBorrowerRelease.mockRestore(); mixedBorrowerEnd.mockRestore();
      try { mixedBorrower.release(); } catch { /* Cleanup after a regression that released the borrowed client. */ }
    }

    // A begun transaction is caller-owned even before its first write assigns
    // an XID; its transaction lock survives the read-only callback.
    for (const finish of ['COMMIT', 'ROLLBACK'] as const) {
      const transactionClient = await lockPool.connect();
      const probeClient = await lockPool.connect();
      const transactionRelease = spyOn(transactionClient, 'release');
      const transactionEnd = spyOn(transactionClient, 'end');
      let statements: string[] = [];
      try {
        const transactionPids = await Promise.all([transactionClient, probeClient].map(async connection =>
          (await connection.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid));
        expect(transactionPids[0]).not.toBe(transactionPids[1]);
        await transactionClient.query('BEGIN');
        expect(transactionClient.getTransactionStatus()).toBe('T');
        expect((await transactionClient.query<{ xid: string | null }>(
          'SELECT pg_current_xact_id_if_assigned()::text AS xid')).rows[0]!.xid).toBeNull();
        const transactionReceipt = `urn:rezics:receipt:${randomUUID()}`;
        const transactionQueries = spyOn(transactionClient, 'query');
        await lockStore.withReceipt(transactionReceipt, async () => {}, transactionClient);
        statements = transactionQueries.mock.calls.map(call => String(call[0]).trim());
        transactionQueries.mockRestore();
        expect(statements).toEqual([
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        ]);
        expect(transactionClient.getTransactionStatus()).toBe('T');
        expect(await tryReceiptLock(probeClient, transactionReceipt)).toBe(false);
        expect(transactionRelease).not.toHaveBeenCalled();
        expect(transactionEnd).not.toHaveBeenCalled();
        await transactionClient.query(finish);
        expect(transactionClient.getTransactionStatus()).toBe('I');
        let probeEntered = false;
        const afterFinish = lockStore.withReceipt(transactionReceipt, async () => { probeEntered = true; }, probeClient);
        try { await within(afterFinish, 5_000, `probe after caller ${finish.toLowerCase()}`); }
        catch (error) {
          await transactionClient.end();
          await Promise.allSettled([afterFinish]);
          throw error;
        }
        expect(probeEntered).toBe(true);
      } finally {
        if (transactionClient.getTransactionStatus() === 'T' || transactionClient.getTransactionStatus() === 'E') {
          await transactionClient.query('ROLLBACK');
        }
        transactionRelease.mockRestore(); transactionEnd.mockRestore();
        transactionClient.release(); probeClient.release();
      }
    }

    const terminal: CustodiedReceipt = { receipt, outcome: 'succeeded', requestDigest, revision,
      admissionId: randomUUID(), authorityEpoch: '1', scope: 'custody-erasure',
      work: `https://rezics.com/id/${randomUUID()}`, component: `https://rezics.com/id/${randomUUID()}`,
      dataEpoch: 'custody-test-epoch', sequence: '7', streamSequence: '21' };
    const outbox = { batchId: `custody-${randomUUID()}`, graphSequence: terminal.sequence, events: [] };
    await store.withReceipt(receipt, async session => {
      await session.prepare({ receipt, requestDigest, payloadSha256, payload, revision,
        terminal: null, outbox: null, reconciled: false, retired: false });
      await session.reconcile(terminal, outbox);
    });
    const before = (await pool.query(`SELECT receipt,request_digest,payload_sha256,revision,terminal,outbox,
      reconciled_at,retired_at,data_epoch,stream_sequence::text AS stream_sequence,
      graph_sequence::text AS graph_sequence
      FROM access.command_custody WHERE receipt=$1`, [receipt])).rows[0];
    expect(before.graph_sequence).toBe(terminal.sequence);
    expect(before.outbox.custodyObjectReferences).toBeUndefined();

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
      expect(client.getTransactionStatus()).toBe('I');
      expect((await client.query('SELECT 1')).rowCount).toBe(1);
      const rolledBack = (await client.query(`SELECT payload,payload_erasure_id,payload_erasure_epoch
        FROM access.command_custody WHERE receipt=$1`, [receipt])).rows[0]!;
      expect(rolledBack.payload).toEqual(payload);
      expect(rolledBack.payload_erasure_id).toBeNull();
      expect(rolledBack.payload_erasure_epoch).toBeNull();

      const idleFailureProbe = await lockPool.connect();
      try {
        let idleFailureProbeEntered = false;
        const idleFailureAttempt = lockStore.withReceipt(receipt,
          async () => { idleFailureProbeEntered = true; }, idleFailureProbe);
        try { await within(idleFailureAttempt, 5_000, 'idle borrowed lock after failed durable clear'); }
        catch (error) {
          await client.end();
          await Promise.allSettled([idleFailureAttempt]);
          throw error;
        }
        expect(idleFailureProbeEntered).toBe(true);
      } catch (error) {
        await client.end();
        throw error;
      } finally { idleFailureProbe.release(); }

      let transactionClient: PoolClient | undefined;
      let lockProbeClient: PoolClient | undefined;
      try {
        transactionClient = await lockPool.connect();
        lockProbeClient = await lockPool.connect();
        const pids = await Promise.all([transactionClient, lockProbeClient].map(async connection =>
          (await connection.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid));
        expect(pids[0]).not.toBe(pids[1]);

        await transactionClient.query('BEGIN');
        expect(transactionClient.getTransactionStatus()).toBe('T');
        const transactionQueries = spyOn(transactionClient, 'query');
        const transactionRelease = spyOn(transactionClient, 'release');
        const transactionEnd = spyOn(transactionClient, 'end');
        try {
          await expect(lockStore.withReceipt(receipt, session => clearPayload(session, erasure), transactionClient))
            .rejects.toThrow('fixture rejects custody payload clear');
          await expect(transactionClient.query('SELECT 1')).rejects.toThrow('current transaction is aborted');
          expect(transactionClient.getTransactionStatus()).toBe('E');
          expect(lifecycleSql(transactionQueries.mock.calls)).toEqual([]);
          expect(transactionQueries.mock.calls.map(call => String(call[0]).trim()))
            .toContain('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
          expect(transactionRelease).not.toHaveBeenCalled();
          expect(transactionEnd).not.toHaveBeenCalled();
        } finally {
          transactionQueries.mockRestore();
          transactionRelease.mockRestore();
          transactionEnd.mockRestore();
        }
        await transactionClient.query('ROLLBACK');
        expect(transactionClient.getTransactionStatus()).toBe('I');
        expect((await transactionClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid)
          .toBe(pids[0]);
        await transactionClient.query('BEGIN');
        await transactionClient.query('ROLLBACK');
        const retainedPayload = (await transactionClient.query<{ payload: Buffer | null; payload_erasure_id: string | null;
          payload_erasure_epoch: string | null }>(`SELECT payload,payload_erasure_id,payload_erasure_epoch
          FROM access.command_custody WHERE receipt=$1`, [receipt])).rows[0]!;
        expect(retainedPayload.payload).toEqual(payload);
        expect(retainedPayload.payload_erasure_id).toBeNull();
        expect(retainedPayload.payload_erasure_epoch).toBeNull();

        let acquired = false;
        const lockAttempt = lockStore.withReceipt(receipt, async () => { acquired = true; }, lockProbeClient);
        try {
          await within(lockAttempt, 5_000, 'same receipt after caller rollback');
        } catch (error) {
          // Emergency cleanup only unblocks a failing lock assertion. The
          // passing path proves the caller connection survives its rollback.
          transactionClient.release(true);
          transactionClient = undefined;
          await Promise.allSettled([lockAttempt]);
          throw error;
        }
        expect(acquired).toBe(true);
      } finally {
        if (transactionClient && ['T', 'E'].includes(transactionClient.getTransactionStatus() ?? '')) {
          try { await transactionClient.query('ROLLBACK'); }
          catch { transactionClient.release(true); transactionClient = undefined; }
        }
        try { transactionClient?.release(); } catch { /* Cleanup after an erroneous owner release. */ }
        lockProbeClient?.release();
      }

      await client.query('DROP TRIGGER zz_fixture_reject_custody_clear ON access.command_custody');
      await client.query('DROP FUNCTION access.reject_fixture_custody_clear()');

      const abandonedClient = await lockPool.connect();
      const abandonedProbe = await lockPool.connect();
      const abandonedRelease = spyOn(abandonedClient, 'release');
      const abandonedEnd = spyOn(abandonedClient, 'end');
      const abandonedReceipt = `urn:rezics:receipt:${randomUUID()}`;
      try {
        await expect(lockStore.withReceipt(abandonedReceipt, async session => {
          await session.client!.query('BEGIN');
          await session.client!.query('SELECT 1 / 0');
        }, abandonedClient)).rejects.toThrow('division by zero');
        expect(abandonedClient.getTransactionStatus()).toBe('I');
        expect((await abandonedClient.query('SELECT 1')).rowCount).toBe(1);
        expect(abandonedRelease).not.toHaveBeenCalled();
        expect(abandonedEnd).not.toHaveBeenCalled();
        let recovered = false;
        const recoveryAttempt = lockStore.withReceipt(abandonedReceipt,
          async () => { recovered = true; }, abandonedProbe);
        try { await within(recoveryAttempt, 5_000, 'idle lock after abandoned callback transaction'); }
        catch (error) {
          await abandonedClient.end();
          await Promise.allSettled([recoveryAttempt]);
          throw error;
        }
        expect(recovered).toBe(true);

        const boundaryReceipt = `urn:rezics:receipt:${randomUUID()}`;
        await expect(lockStore.withReceipt(boundaryReceipt, async session => {
          await session.client!.query('BEGIN');
        }, abandonedClient)).rejects.toThrow('callback returned with an open transaction');
        expect(abandonedClient.getTransactionStatus()).toBe('I');
        expect((await abandonedClient.query('SELECT 1')).rowCount).toBe(1);
        let boundaryRecovered = false;
        const boundaryAttempt = lockStore.withReceipt(boundaryReceipt,
          async () => { boundaryRecovered = true; }, abandonedProbe);
        try { await within(boundaryAttempt, 5_000, 'idle lock after callback boundary cleanup'); }
        catch (error) {
          await abandonedClient.end();
          await Promise.allSettled([boundaryAttempt]);
          throw error;
        }
        expect(boundaryRecovered).toBe(true);
      } finally {
        abandonedRelease.mockRestore(); abandonedEnd.mockRestore();
        abandonedClient.release(); abandonedProbe.release();
      }

      const exerciseUnlockFailure = async (callbackFailure?: Error): Promise<void> => {
        const ownerClient = await lockPool.connect();
        const waiterClient = await lockPool.connect();
        const receiptForCleanup = `urn:rezics:receipt:${randomUUID()}`;
        const unlockFailure = new Error('injected custody unlock failure');
        const nativeQuery = ownerClient.query;
        const ownerQueries = spyOn(ownerClient, 'query').mockImplementation(function (
          this: PoolClient, ...args: unknown[]) {
          const sql = typeof args[0] === 'string' ? args[0] : '';
          if (sql.includes('pg_advisory_unlock')) return Promise.reject(unlockFailure) as never;
          return Reflect.apply(nativeQuery, this, args) as never;
        } as typeof nativeQuery);
        const ownerEnd = spyOn(ownerClient, 'end');
        const ownerRelease = spyOn(ownerClient, 'release');
        let waiter: Promise<void> | undefined;
        try {
          const callback = async () => {
            if (callbackFailure) throw callbackFailure;
          };
          await expect(lockStore.withReceipt(receiptForCleanup, callback, ownerClient))
            .rejects.toBe(callbackFailure ?? unlockFailure);
          expect(ownerEnd).toHaveBeenCalledTimes(1);
          expect(ownerRelease).not.toHaveBeenCalled();
          ownerClient.release();
          expect(ownerRelease).toHaveBeenCalledTimes(1);
          let waiterEntered = false;
          waiter = lockStore.withReceipt(receiptForCleanup, async () => { waiterEntered = true; }, waiterClient);
          await within(waiter, 5_000, 'lock after failed idle unlock disconnect');
          expect(waiterEntered).toBe(true);
        } catch (error) {
          if (ownerRelease.mock.calls.length === 0) {
            ownerRelease.mockRestore();
            ownerClient.release(true);
          }
          if (waiter) {
            try { await ownerClient.end(); } catch { /* Emergency disconnect only unblocks a failing proof. */ }
            await Promise.allSettled([waiter]);
          }
          throw error;
        } finally {
          ownerQueries.mockRestore(); ownerEnd.mockRestore(); ownerRelease.mockRestore();
          waiterClient.release();
        }
      };
      await exerciseUnlockFailure();
      await exerciseUnlockFailure(new Error('callback error survives cleanup failure'));

      await client.query('CREATE TEMP TABLE custody_caller_transaction_probe (marker text) ON COMMIT PRESERVE ROWS');
      const callerPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await client.query('BEGIN');
      try {
        await client.query("INSERT INTO custody_caller_transaction_probe VALUES ('caller write')");
        const custodyQueries = spyOn(client, 'query');
        try {
          await store.withReceipt(receipt, session => clearPayload(session, erasure), client);
          expect(lifecycleSql(custodyQueries.mock.calls)).toEqual([]);
          expect(custodyQueries.mock.calls.map(call => String(call[0]).trim()))
            .toContain('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
        } finally { custodyQueries.mockRestore(); }
        expect((await client.query('SELECT marker FROM custody_caller_transaction_probe')).rows)
          .toEqual([{ marker: 'caller write' }]);
        const erasedInside = (await client.query<{ payload: Buffer | null; payload_erasure_id: string | null;
          payload_erasure_epoch: string | null }>(`SELECT payload,payload_erasure_id,payload_erasure_epoch
          FROM access.command_custody WHERE receipt=$1`, [receipt])).rows[0]!;
        expect(erasedInside).toEqual({ payload: null, payload_erasure_id: erasure.erasureId,
          payload_erasure_epoch: erasure.erasureEpoch });
      } finally {
        await client.query('ROLLBACK');
      }
      expect(client.getTransactionStatus()).toBe('I');
      expect((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid).toBe(callerPid);
      expect((await client.query('SELECT marker FROM custody_caller_transaction_probe')).rows).toEqual([]);
      const callerRollback = (await client.query(`SELECT payload,payload_erasure_id,payload_erasure_epoch
        FROM access.command_custody WHERE receipt=$1`, [receipt])).rows[0]!;
      expect(callerRollback.payload).toEqual(payload);
      expect(callerRollback.payload_erasure_id).toBeNull();
      expect(callerRollback.payload_erasure_epoch).toBeNull();

      const rollbackProbe = await lockPool.connect();
      try {
        const rollbackAttempt = lockStore.withReceipt(receipt, async () => {}, rollbackProbe);
        try { await within(rollbackAttempt, 5_000, 'receipt lock after caller atomic rollback'); }
        catch (error) {
          await client.end();
          await Promise.allSettled([rollbackAttempt]);
          throw error;
        }
      } catch (error) {
        await client.end();
        throw error;
      } finally { rollbackProbe.release(); }

      const committedReceipt = `urn:rezics:receipt:${randomUUID()}`;
      const committedRevision = `https://rezics.com/id/${randomUUID()}`;
      const committedPayload = Buffer.from('separate committed custody bytes');
      const committedErasure: CustodyPayloadErasure = { revision: committedRevision, payloadSha256: hash(committedPayload),
        erasureId: randomUUID(), erasureEpoch: '13' };
      const committedTerminal = { ...terminal, receipt: committedReceipt, revision: committedRevision,
        sequence: '8', streamSequence: '22' };
      await store.withReceipt(committedReceipt, async session => {
        await session.prepare({ receipt: committedReceipt, requestDigest,
          payloadSha256: committedErasure.payloadSha256, payload: committedPayload, revision: committedRevision,
          terminal: null, outbox: null, reconciled: false, retired: false });
        await session.reconcile(committedTerminal, { batchId: `custody-${randomUUID()}`,
          graphSequence: committedTerminal.sequence, events: [] });
      }, client);
      await client.query('BEGIN');
      try {
        await client.query("INSERT INTO custody_caller_transaction_probe VALUES ('committed caller write')");
        const commitQueries = spyOn(client, 'query');
        try {
          await store.withReceipt(committedReceipt, session => clearPayload(session, committedErasure), client);
          expect(lifecycleSql(commitQueries.mock.calls)).toEqual([]);
        } finally { commitQueries.mockRestore(); }
        expect((await client.query('SELECT marker FROM custody_caller_transaction_probe WHERE marker=$1',
          ['committed caller write'])).rows).toEqual([{ marker: 'committed caller write' }]);
        const committedInside = (await client.query<{ payload: Buffer | null; payload_erasure_id: string | null;
          payload_erasure_epoch: string | null }>(`SELECT payload,payload_erasure_id,payload_erasure_epoch
          FROM access.command_custody WHERE receipt=$1`, [committedReceipt])).rows[0]!;
        expect(committedInside).toEqual({ payload: null, payload_erasure_id: committedErasure.erasureId,
          payload_erasure_epoch: committedErasure.erasureEpoch });
        await client.query('COMMIT');
      } catch (error) {
        if (client.getTransactionStatus() === 'T' || client.getTransactionStatus() === 'E') {
          await client.query('ROLLBACK');
        }
        throw error;
      }
      expect(client.getTransactionStatus()).toBe('I');
      expect((await client.query('SELECT marker FROM custody_caller_transaction_probe WHERE marker=$1',
        ['committed caller write'])).rows).toEqual([{ marker: 'committed caller write' }]);
      const committedAfter = (await client.query<{ payload: Buffer | null; payload_erasure_id: string | null;
        payload_erasure_epoch: string | null }>(`SELECT payload,payload_erasure_id,payload_erasure_epoch
        FROM access.command_custody WHERE receipt=$1`, [committedReceipt])).rows[0]!;
      expect(committedAfter).toEqual({ payload: null, payload_erasure_id: committedErasure.erasureId,
        payload_erasure_epoch: committedErasure.erasureEpoch });
      const commitProbe = await lockPool.connect();
      try {
        let commitProbeEntered = false;
        const commitAttempt = lockStore.withReceipt(committedReceipt,
          async () => { commitProbeEntered = true; }, commitProbe);
        try { await within(commitAttempt, 5_000, 'receipt lock after caller commit'); }
        catch (error) {
          await client.end();
          await Promise.allSettled([commitAttempt]);
          throw error;
        }
        expect(commitProbeEntered).toBe(true);
      } catch (error) {
        await client.end();
        throw error;
      } finally { commitProbe.release(); }

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

    const winnerClient = await lockPool.connect();
    const competitorClient = await lockPool.connect();
    let releaseRace!: () => void, signalLocked!: () => void;
    const locked = new Promise<void>(resolveLocked => { signalLocked = resolveLocked; });
    const hold = new Promise<void>(resolveHold => { releaseRace = resolveHold; });
    const racePids = await Promise.all([winnerClient, competitorClient].map(async connection =>
      (await connection.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid));
    expect(racePids[0]).not.toBe(racePids[1]);
    const winner = lockStore.withReceipt(receipt, async session => {
      signalLocked();
      await hold;
      await clearPayload(session, erasure);
    }, winnerClient);
    let competitor: Promise<void> | undefined;
    let competitorEntered = false;
    try {
      await within(locked, 5_000, 'exact replay lock owner entry');
      expect(await tryReceiptLock(competitorClient, receipt)).toBe(false);
      competitor = lockStore.withReceipt(receipt, async session => {
        competitorEntered = true;
        await clearPayload(session, { ...erasure, erasureId: randomUUID() });
      }, competitorClient);
      expect(await waitUntilBlocked(observerPool, racePids[1]!, racePids[0]!)).toBe(true);
      expect(competitorEntered).toBe(false);
    } finally {
      releaseRace();
      await settleOrDisconnect([winner, ...(competitor ? [competitor] : [])],
        () => winnerClient.end(), 'exact replay lock proof cleanup');
      try { winnerClient.release(); } catch { /* The proof may already have exposed an erroneous owner release. */ }
      try { competitorClient.release(); } catch { /* Let the pool cleanup proceed after a failed assertion. */ }
    }
    await winner;
    if (competitor === undefined) throw new Error('Exact replay competitor was not started');
    await expect(competitor).rejects.toBeInstanceOf(ReceiptCustodyErasureConflict);

    const after = (await pool.query(`SELECT receipt,request_digest,payload_sha256,payload,revision,terminal,outbox,
      reconciled_at,retired_at,data_epoch,stream_sequence::text AS stream_sequence,
      graph_sequence::text AS graph_sequence,
      payload_erasure_id,payload_erasure_epoch::text AS payload_erasure_epoch
      FROM access.command_custody WHERE receipt=$1`, [receipt])).rows[0];
    expect(after).toMatchObject({ ...before, outbox: { ...before.outbox,
      custodyObjectReferences: [
        { digest: payloadSha256, kind: 'command' },
        { digest: hash('fixture retained manifest'), kind: 'manifest' },
        { digest: hash('fixture retained payload'), kind: 'payload' },
        { digest: hash('fixture retained validation shape'), kind: 'shape' },
      ] }, payload: null, payload_erasure_id: erasure.erasureId,
      payload_erasure_epoch: erasure.erasureEpoch });
    expect(after.payload_sha256).toBe(payloadSha256);
  } finally {
    borrowedClient?.release();
    await Promise.all([pool.end(), lockPool.end(), observerPool.end()]);
    cluster.remove();
  }
}, 60_000);
