import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { currentCommand, runCommand } from '../../src/command/command.ts';
import { NativeCollectionWork, instrumentNativeCollectionWork } from '../../src/library/collection-source-work.ts';
import type { WorkDimensions } from '../../src/library/collection-source.ts';
import { searchIdentityWriterChanged } from '../../src/search/identity-epoch-participant-events.ts';
import { recordSemanticSourceCommit } from '../../src/semantic/erasure-producer.ts';
import {
  prepareSearchReceivingCaptures,
  searchReceivingCaptureStatements as sql,
  searchReceivingCaptureStatementCosts,
} from '../../src/semantic/identity-search-receiving-capture.ts';
import { receivingSqlKey } from '../../src/semantic/identity-search-receiving-work.ts';
import { epochFixture, home, type EpochFixture } from './support/identity-epoch.ts';
import { admittedReceivingJob } from './support/identity-receiving-effects.ts';

// Genuine command/fence/deferred-capture regression. This isolated generous
// ledger does not prove the configured Source or its original 24-point/two-seek fit.
let f: EpochFixture;
const originals = new Map<PoolClient, PoolClient['query']>();
const active = new Set<PoolClient>();
const receipts: ReturnType<NativeCollectionWork['receipt']>[] = [];
let lateCopy: readonly unknown[] | undefined;
let replacedCopy: readonly unknown[] | undefined;
const inventory = new Map(searchReceivingCaptureStatementCosts.map(({ sql, work }) => [receivingSqlKey(sql), work]));
const ceiling = (): WorkDimensions => ({
  candidateKeys: 0,
  nativeRows: 100000,
  identityMetadataRows: 0,
  nativePoints: 100000,
  witnessKeys: 0,
  statements: 100000,
  bytes: 64 * 1024 * 1024,
  emptySeeks: 100000,
});
const copySql = `INSERT INTO semantic.erasure_copy_role(partition_no,store,record_key,transaction_id,account_id,role)
  VALUES($1,'identity_epoch_effect_receipt',$2,$3,$4,'owner')`;

async function plan(client: PoolClient) {
  const work = new NativeCollectionWork({ reservationId: randomUUID(), remaining: ceiling() }, Date.now() + 30_000);
  try {
    await instrumentNativeCollectionWork(
      f.pool,
      work,
      (text) => inventory.get(receivingSqlKey(text)),
      async () => {
        await prepareSearchReceivingCaptures(client, (cost) => {
          const reservation = work.reserve(cost);
          reservation.dispatch();
          reservation.settle();
        });
      },
      client,
    );
  } finally {
    receipts.push(work.receipt());
  }
}

beforeAll(async () => {
  f = await epochFixture();
  f.pool.on('acquire', (client) => {
    if (originals.has(client)) return;
    const query = client.query;
    originals.set(client, query);
    client.query = function (this: PoolClient, ...args: unknown[]) {
      if (args[0] === sql.enable) active.add(this);
      if (args[0] === 'ROLLBACK') active.delete(this);
      if (args[0] === 'COMMIT' && active.delete(this)) {
        return plan(this).then(async () => {
          // Adversarial native mutation after the real planner, before the actual
          // COMMIT. It must invalidate the arm before the extra locator dispatch.
          if (replacedCopy)
            await Reflect.apply(query, this, [
              `DELETE FROM semantic.erasure_copy_role WHERE partition_no=$1
             AND store='identity_epoch_effect_receipt' AND record_key=$2 AND transaction_id=$3 AND account_id=$4`,
              [...replacedCopy],
            ]);
          if (lateCopy) await Reflect.apply(query, this, [copySql, [...lateCopy]]);
          return Reflect.apply(query, this, args);
        });
      }
      return Reflect.apply(query, this, args);
    } as PoolClient['query'];
  });
});

for (const origin of ['original', 'native'] as const)
  test(`replacing an armed ${origin} copy without changing its count rolls back`, async () => {
    const value = await input();
    const account = randomUUID();
    let native: string | undefined;
    let recordKey: string | undefined;
    const before = (
      await f.admin.query(
        `SELECT origin_key,record_key,role FROM semantic.erasure_source_record
    WHERE partition_no=$1 AND source_transaction_id=$2 ORDER BY origin_key,record_key,role`,
        [value.partition, value.original],
      )
    ).rows;
    try {
      await expect(
        runCommand(
          f.pool,
          {
            partition: value.partition,
            basis: {
              actorAccountId: value.actor.accountId,
              clientId: value.actor.clientId,
              requestedBy: value.actor.requestedBy,
            },
          },
          async (tx) => {
            native = currentCommand(tx).transactionId;
            await tx.query(sql.enable);
            await tx.query("SELECT set_config('semantic.erasure_native_transaction',$1,true)", [native]);
            await recordSemanticSourceCommit(tx, native);
            recordKey = (
              await tx.query<{ erasure_key: string }>(
                `INSERT INTO semantic.identity_epoch_effect_receipt(partition_no,job_id,step,effect_key,kind)
         VALUES($1,$2,'search-canonical-index',$3,'remove') RETURNING erasure_key::text`,
                [value.partition, value.job.jobId, value.effect],
              )
            ).rows[0]!.erasure_key;
            for (const transaction of [value.original, native])
              await tx.query(copySql, [value.partition, recordKey, transaction, account]);
            const transaction = origin === 'native' ? native : value.original;
            replacedCopy = [value.partition, recordKey, transaction, account];
            lateCopy = [value.partition, recordKey, transaction, randomUUID()];
            return { value: null, events: searchIdentityWriterChanged() };
          },
        ),
      ).rejects.toMatchObject({ code: '23514', message: 'identity_receiving_capture_original_identity_changed' });
    } finally {
      lateCopy = undefined;
      replacedCopy = undefined;
    }
    expect(receipts.at(-1)!.used.bytes).toBeGreaterThan(0);
    for (const table of ['erasure_source_commit', 'erasure_provenance'])
      expect(
        (
          await f.admin.query(`SELECT 1 FROM semantic.${table} WHERE partition_no=$1 AND transaction_id=$2`, [
            value.partition,
            native,
          ])
        ).rows,
      ).toEqual([]);
    expect(
      (
        await f.admin.query('SELECT 1 FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2', [
          value.partition,
          native,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await f.admin.query(
          'SELECT 1 FROM semantic.identity_epoch_effect_receipt WHERE partition_no=$1 AND effect_key=$2',
          [value.partition, value.effect],
        )
      ).rows,
    ).toEqual([]);
    for (const table of ['erasure_copy_role', 'erasure_locator', 'erasure_source_record'])
      expect(
        (
          await f.admin.query(
            `SELECT 1 FROM semantic.${table} WHERE partition_no=$1 AND store='identity_epoch_effect_receipt' AND record_key=$2`,
            [value.partition, recordKey],
          )
        ).rows,
      ).toEqual([]);
    expect(
      (
        await f.admin.query(
          `SELECT origin_key,record_key,role FROM semantic.erasure_source_record
    WHERE partition_no=$1 AND source_transaction_id=$2 ORDER BY origin_key,record_key,role`,
          [value.partition, value.original],
        )
      ).rows,
    ).toEqual(before);
  });
afterAll(async () => {
  for (const [client, query] of originals) client.query = query;
  await f?.close();
});

async function input() {
  const { job } = await admittedReceivingJob(f);
  const partition = home(job.jobId);
  const original = (
    await f.admin.query<{ recorded_transaction_id: string }>(
      'SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2',
      [partition, job.jobId],
    )
  ).rows[0]!.recorded_transaction_id;
  return { job, partition, original, effect: randomUUID(), actor: await f.actor() };
}

for (const width of [1, 10, 100])
  test(`complete native/original copy capture retains ${width} overlapping legal roles per origin`, async () => {
    lateCopy = undefined;
    const value = await input();
    const accounts = Array.from({ length: width }, () => randomUUID());
    let recordKey: string | undefined;
    const result = await runCommand(
      f.pool,
      {
        partition: value.partition,
        basis: {
          actorAccountId: value.actor.accountId,
          clientId: value.actor.clientId,
          requestedBy: value.actor.requestedBy,
        },
      },
      async (tx) => {
        const native = currentCommand(tx).transactionId;
        await tx.query(sql.enable);
        await tx.query("SELECT set_config('semantic.erasure_native_transaction',$1,true)", [native]);
        await recordSemanticSourceCommit(tx, native);
        recordKey = (
          await tx.query<{ erasure_key: string }>(
            `INSERT INTO semantic.identity_epoch_effect_receipt(partition_no,job_id,step,effect_key,kind)
       VALUES($1,$2,'search-canonical-index',$3,'remove') RETURNING erasure_key::text`,
            [value.partition, value.job.jobId, value.effect],
          )
        ).rows[0]!.erasure_key;
        for (const transaction of [value.original, native])
          for (const account of accounts) await tx.query(copySql, [value.partition, recordKey, transaction, account]);
        return { value: native, events: searchIdentityWriterChanged() };
      },
    );
    const captured = (
      await f.admin.query<{ account_id: string; source_transaction_id: string; delivery_position: string }>(
        `SELECT account_id::text,source_transaction_id::text,delivery_position::text FROM semantic.erasure_source_record
     WHERE partition_no=$1 AND store='identity_epoch_effect_receipt' AND record_key=$2 AND role='owner'`,
        [value.partition, recordKey],
      )
    ).rows;
    expect(captured).toHaveLength(2 * width);
    for (const account of accounts)
      for (const transaction of [value.original, result.value])
        expect(captured).toContainEqual({
          account_id: account,
          source_transaction_id: transaction,
          delivery_position: String(result.position),
        });
    expect(
      (
        await f.admin.query(
          `SELECT 1 FROM semantic.identity_receiving_capture_pending
    WHERE partition_no=$1 AND store='identity_epoch_effect_receipt' AND record_key=$2`,
          [value.partition, recordKey],
        )
      ).rows,
    ).toEqual([]);
    expect(receipts.at(-1)!.used.nativePoints).toBeGreaterThan(2 * width * 9);
  });

test('a late native copy invalidates complete funding and atomically rolls back the new native origin', async () => {
  const value = await input();
  let native: string | undefined;
  let xid: string | undefined;
  let recordKey: string | undefined;
  const before = (
    await f.admin.query(
      `SELECT origin_key,record_key,role FROM semantic.erasure_source_record
    WHERE partition_no=$1 AND source_transaction_id=$2 ORDER BY origin_key,record_key,role`,
      [value.partition, value.original],
    )
  ).rows;
  try {
    await expect(
      runCommand(
        f.pool,
        {
          partition: value.partition,
          basis: {
            actorAccountId: value.actor.accountId,
            clientId: value.actor.clientId,
            requestedBy: value.actor.requestedBy,
          },
        },
        async (tx) => {
          native = currentCommand(tx).transactionId;
          await tx.query(sql.enable);
          await tx.query("SELECT set_config('semantic.erasure_native_transaction',$1,true)", [native]);
          await recordSemanticSourceCommit(tx, native);
          xid = (await tx.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid;
          recordKey = (
            await tx.query<{ erasure_key: string }>(
              `INSERT INTO semantic.identity_epoch_effect_receipt(partition_no,job_id,step,effect_key,kind)
         VALUES($1,$2,'search-canonical-index',$3,'remove') RETURNING erasure_key::text`,
              [value.partition, value.job.jobId, value.effect],
            )
          ).rows[0]!.erasure_key;
          await tx.query(copySql, [value.partition, recordKey, value.original, value.actor.accountId]);
          lateCopy = [value.partition, recordKey, native, randomUUID()];
          return { value: null, events: searchIdentityWriterChanged() };
        },
      ),
    ).rejects.toMatchObject({ code: '23514', message: 'identity_receiving_capture_copy_funding_changed' });
  } finally {
    lateCopy = undefined;
  }
  expect(native).toBeDefined();
  expect(xid).toBeDefined();
  expect(recordKey).toBeDefined();
  expect(receipts.at(-1)!.used.nativePoints).toBeGreaterThan(0);
  for (const table of ['erasure_source_commit', 'erasure_provenance'])
    expect(
      (
        await f.admin.query(`SELECT 1 FROM semantic.${table} WHERE partition_no=$1 AND transaction_id=$2`, [
          value.partition,
          native,
        ])
      ).rows,
    ).toEqual([]);
  expect(
    (
      await f.admin.query('SELECT 1 FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2', [
        value.partition,
        native,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (await f.admin.query('SELECT 1 FROM semantic.identity_receiving_capture_pending WHERE transaction_xid=$1', [xid]))
      .rows,
  ).toEqual([]);
  expect(
    (
      await f.admin.query(
        'SELECT 1 FROM semantic.identity_epoch_effect_receipt WHERE partition_no=$1 AND effect_key=$2',
        [value.partition, value.effect],
      )
    ).rows,
  ).toEqual([]);
  for (const table of ['erasure_copy_role', 'erasure_locator', 'erasure_source_record'])
    expect(
      (
        await f.admin.query(
          `SELECT 1 FROM semantic.${table} WHERE partition_no=$1 AND store='identity_epoch_effect_receipt' AND record_key=$2`,
          [value.partition, recordKey],
        )
      ).rows,
    ).toEqual([]);
  expect(
    (
      await f.admin.query(
        `SELECT origin_key,record_key,role FROM semantic.erasure_source_record
    WHERE partition_no=$1 AND source_transaction_id=$2 ORDER BY origin_key,record_key,role`,
        [value.partition, value.original],
      )
    ).rows,
  ).toEqual(before);
});
