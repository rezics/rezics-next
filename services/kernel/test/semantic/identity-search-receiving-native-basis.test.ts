import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { currentCommand, registerCommandCallback, runCommand } from '../../src/command/command.ts';
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

// Native deferred-body regression, with a generous isolated physical-work ledger.
// The real executor supplies both bases, the native commit, position and TX. A
// query observer calls the production planner at the same post-fence COMMIT seam.
// This does not prove the configured Source composer or its 24-point/two-seek fit.
let f: EpochFixture;
let mode: 'after-fence' | 'before-fence' = 'after-fence';
let capturedClient: PoolClient | undefined;
const originals = new Map<PoolClient, PoolClient['query']>();
const armed = new Set<PoolClient>();
const receipts: ReturnType<NativeCollectionWork['receipt']>[] = [];
const inventory = new Map(searchReceivingCaptureStatementCosts.map(({ sql, work }) => [receivingSqlKey(sql), work]));
const ceiling = (): WorkDimensions => ({
  candidateKeys: 0,
  nativeRows: 10000,
  identityMetadataRows: 0,
  nativePoints: 10000,
  witnessKeys: 0,
  statements: 10000,
  bytes: 16 * 1024 * 1024,
  emptySeeks: 10000,
});

async function plan(client: PoolClient) {
  const work = new NativeCollectionWork({ reservationId: randomUUID(), remaining: ceiling() }, Date.now() + 5000);
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
      if (args[0] === sql.enable) {
        capturedClient = this;
        armed.add(this);
      }
      if (args[0] === 'ROLLBACK') armed.delete(this);
      if (args[0] === 'COMMIT' && armed.delete(this) && mode === 'after-fence') {
        return plan(this).then(() => Reflect.apply(query, this, args));
      }
      return Reflect.apply(query, this, args);
    } as PoolClient['query'];
  });
});
afterAll(async () => {
  for (const [client, query] of originals) client.query = query;
  await f?.close();
});

async function input() {
  const { job } = await admittedReceivingJob(f);
  const partition = home(job.jobId);
  const original = (
    await f.admin.query<{ transaction_id: string; position: string }>(
      `SELECT b.transaction_id::text,b.position::text FROM semantic.identity_epoch_job j
     JOIN editorial.write_basis b ON b.partition_no=j.partition_no AND b.transaction_id=j.recorded_transaction_id
     WHERE j.partition_no=$1 AND j.job_id=$2`,
      [partition, job.jobId],
    )
  ).rows[0]!;
  return { job, partition, original, effect: randomUUID(), actor: await f.actor() };
}

async function directory(partition: number, effect: string) {
  return (
    await f.admin.query<{ source_transaction_id: string; source_position: string; delivery_position: string }>(
      `SELECT d.source_transaction_id::text,d.source_position::text,d.delivery_position::text
     FROM semantic.erasure_source_record d JOIN semantic.identity_epoch_effect_receipt e
       ON e.partition_no=d.partition_no AND e.erasure_key=d.record_key
     WHERE d.partition_no=$1 AND e.effect_key=$2 AND d.store='identity_epoch_effect_receipt' AND d.role='actor'
     ORDER BY d.source_transaction_id,d.source_position`,
      [partition, effect],
    )
  ).rows;
}

test('actual post-fence capture preserves original and native actor write bases in one native delivery', async () => {
  mode = 'after-fence';
  const value = await input();
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
      await tx.query(
        `INSERT INTO semantic.identity_epoch_effect_receipt(partition_no,job_id,step,effect_key,kind)
      VALUES($1,$2,'search-canonical-index',$3,'remove')`,
        [value.partition, value.job.jobId, value.effect],
      );
      return { value: native, events: searchIdentityWriterChanged() };
    },
  );
  expect(
    (
      await f.admin.query<{ position: string }>(
        'SELECT position::text FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2',
        [value.partition, result.value],
      )
    ).rows,
  ).toEqual([{ position: String(result.position) }]);
  const expected = [
    {
      source_transaction_id: value.original.transaction_id,
      source_position: value.original.position,
      delivery_position: String(result.position),
    },
    {
      source_transaction_id: result.value,
      source_position: String(result.position),
      delivery_position: String(result.position),
    },
  ].sort((a, b) => a.source_transaction_id.localeCompare(b.source_transaction_id));
  expect(await directory(value.partition, value.effect)).toEqual(expected);
  expect(
    (
      await f.admin.query(
        `SELECT 1 FROM semantic.identity_receiving_capture_pending
    WHERE partition_no=$1 AND source_transaction_id=$2`,
        [value.partition, value.original.transaction_id],
      )
    ).rows,
  ).toEqual([]);
});

test('a native basis appearing after planning invalidates the reservation and rolls back every native write', async () => {
  mode = 'before-fence';
  const value = await input();
  let native: string | undefined;
  let xid: string | undefined;
  let recordKey: string | undefined;
  const before = (
    await f.admin.query(
      `SELECT origin_key FROM semantic.erasure_source_record
    WHERE partition_no=$1 AND source_transaction_id=$2 ORDER BY origin_key,record_key,role`,
      [value.partition, value.original.transaction_id],
    )
  ).rows;
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
        await tx.query(
          `INSERT INTO semantic.erasure_copy_role(partition_no,store,record_key,transaction_id,account_id,role)
      VALUES($1,'identity_epoch_effect_receipt',$2,$3,$4,'owner')`,
          [value.partition, recordKey, value.original.transaction_id, value.actor.accountId],
        );
        registerCommandCallback(tx, async () => {
          expect(capturedClient).toBeDefined();
          await plan(capturedClient!);
        });
        return { value: null, events: searchIdentityWriterChanged() };
      },
    ),
  ).rejects.toMatchObject({ code: '23514', message: 'identity_receiving_capture_basis_changed' });
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
  expect(
    (
      await f.admin.query(
        `SELECT 1 FROM semantic.erasure_copy_role WHERE partition_no=$1
    AND store='identity_epoch_effect_receipt' AND record_key=$2`,
        [value.partition, recordKey],
      )
    ).rows,
  ).toEqual([]);
  expect(
    (
      await f.admin.query(
        `SELECT 1 FROM semantic.erasure_locator WHERE partition_no=$1
    AND store='identity_epoch_effect_receipt' AND record_key=$2`,
        [value.partition, recordKey],
      )
    ).rows,
  ).toEqual([]);
  expect(await directory(value.partition, value.effect)).toEqual([]);
  expect(
    (
      await f.admin.query(
        `SELECT origin_key FROM semantic.erasure_source_record
    WHERE partition_no=$1 AND source_transaction_id=$2 ORDER BY origin_key,record_key,role`,
        [value.partition, value.original.transaction_id],
      )
    ).rows,
  ).toEqual(before);
});
