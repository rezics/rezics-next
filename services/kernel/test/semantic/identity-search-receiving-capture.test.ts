import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { NativeCollectionWork, instrumentNativeCollectionWork } from '../../src/library/collection-source-work.ts';
import type { WorkDimensions } from '../../src/library/collection-source.ts';
import {
  prepareSearchReceivingCaptures,
  searchReceivingCaptureStatements as sql,
  searchReceivingCaptureStatementCosts,
  searchReceivingCaptureCost,
} from '../../src/semantic/identity-search-receiving-capture.ts';
import {
  receivingSqlKey,
  receivingWorkDeclaration,
  searchReceivingOperations,
  withSearchReceivingWork,
} from '../../src/semantic/identity-search-receiving-work.ts';
import {
  commonSearchReceivingStatements,
  receivingStatements,
  searchReceivingCapturedStatementCosts,
} from '../../src/semantic/identity-search-receiving-statements.ts';
import {
  withIdentitySourceConsumerMaintenance,
  identitySourceConsumerLibraryWork,
  identitySourceConsumerNativeWork,
} from '../../src/semantic/identity-source-consumer-maintenance.ts';
import { currentCommand, registerCommandCallback, runCommand } from '../../src/command/command.ts';
import { recordSemanticSourceCommit } from '../../src/semantic/erasure-producer.ts';
import { searchIdentityWriterChanged } from '../../src/search/identity-epoch-participant-events.ts';
import { epochFixture, home, type EpochFixture } from './support/identity-epoch.ts';
import { admittedReceivingJob } from './support/identity-receiving-effects.ts';

// Connected native capture regressions. No Source support, copy closure, ACK or engine proof is seeded.
// These cases are authored for the supported verifier; source-only preparation does not execute them.
let f: EpochFixture;
beforeAll(async () => {
  f = await epochFixture();
});
afterAll(async () => {
  await f?.close();
});
const roles = ['actor', 'author', 'editor', 'acting-human', 'delegate', 'owner', 'subject', 'operator'];
// Isolated physical-body accounting, not a Source invocation allowance or aggregate-fit claim.
// The separate production-composer case below must refuse under the unchanged original frame.
const ceiling = (): WorkDimensions => ({
  candidateKeys: 0,
  identityMetadataRows: 0,
  nativeRows: 10000,
  nativePoints: 10000,
  witnessKeys: 0,
  statements: 10000,
  bytes: 16 * 1024 * 1024,
  emptySeeks: 10000,
});

async function input() {
  const { job } = await admittedReceivingJob(f);
  const partition = home(job.jobId);
  const row = (
    await f.admin.query<{ recorded_transaction_id: string }>(
      'SELECT recorded_transaction_id FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2',
      [partition, job.jobId],
    )
  ).rows[0]!;
  return { partition, job, original: row.recorded_transaction_id, effect: randomUUID() };
}
async function insert(tx: PoolClient, value: Awaited<ReturnType<typeof input>>) {
  return (
    await tx.query<{ erasure_key: string }>(
      `INSERT INTO semantic.identity_epoch_effect_receipt(partition_no,job_id,step,effect_key,kind)
     VALUES($1,$2,'search-canonical-index',$3,'remove') RETURNING erasure_key`,
      [value.partition, value.job.jobId, value.effect],
    )
  ).rows[0]!.erasure_key;
}
async function plan(tx: PoolClient, remaining = ceiling()) {
  const work = new NativeCollectionWork({ reservationId: randomUUID(), remaining }, Date.now() + 5000);
  const inventory = new Map(searchReceivingCaptureStatementCosts.map(({ sql, work }) => [receivingSqlKey(sql), work]));
  await instrumentNativeCollectionWork(
    f.pool,
    work,
    (text) => inventory.get(receivingSqlKey(text)),
    async () => {
      await prepareSearchReceivingCaptures(tx, (cost) => {
        const reservation = work.reserve(cost);
        reservation.dispatch();
        reservation.settle();
      });
    },
    tx,
  );
  return work.receipt();
}

test('capture covers every original source/copy role beyond eight and preserves native transaction provenance', async () => {
  const value = await input();
  const accounts = Array.from({ length: 17 }, () => randomUUID());
  const native = randomUUID();
  const tx = await f.pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const xid = (await tx.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid;
    await tx.query(sql.enable);
    await tx.query("SELECT set_config('semantic.erasure_native_transaction',$1,true)", [native]);
    const key = await insert(tx, value);
    for (const [index, account] of accounts.entries()) {
      await tx.query(
        `INSERT INTO semantic.erasure_source_role(partition_no,transaction_id,account_id,role)
        VALUES($1,$2,$3,$4)`,
        [value.partition, value.original, account, roles[index % roles.length]],
      );
      await tx.query(
        `INSERT INTO semantic.erasure_copy_role(partition_no,store,record_key,transaction_id,account_id,role)
        VALUES($1,'identity_epoch_effect_receipt',$2,$3,$4,$5)`,
        [value.partition, key, value.original, account, roles[(index + 1) % roles.length]],
      );
    }
    const nativeAccount = randomUUID();
    await tx.query(
      `INSERT INTO semantic.erasure_source_role(partition_no,transaction_id,account_id,role)
      VALUES($1,$2,$3,'operator')`,
      [value.partition, native, nativeAccount],
    );
    const receipt = await plan(tx);
    expect(receipt.used.nativePoints).toBeGreaterThan(34 * 9);
    await tx.query('COMMIT');
    const captured = await f.admin.query<{ account_id: string; role: string; source_transaction_id: string }>(
      `SELECT account_id,role,source_transaction_id FROM semantic.erasure_locator
       WHERE partition_no=$1 AND store='identity_epoch_effect_receipt' AND record_key=$2`,
      [value.partition, key],
    );
    for (const [index, account] of accounts.entries()) {
      for (const role of [roles[index % roles.length], roles[(index + 1) % roles.length]])
        expect(captured.rows).toContainEqual({
          account_id: account,
          role: role!,
          source_transaction_id: value.original,
        });
    }
    expect(captured.rows).toContainEqual({
      account_id: nativeAccount,
      role: 'operator',
      source_transaction_id: native,
    });
    expect(
      (await f.admin.query('SELECT 1 FROM semantic.identity_receiving_capture_pending WHERE transaction_xid=$1', [xid]))
        .rowCount,
    ).toBe(0);
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});

test('unfunded complete capture refuses before deferred dispatch and rolls back the actual receipt and queue', async () => {
  const value = await input();
  const tx = await f.pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await tx.query(sql.enable);
    const key = await insert(tx, value);
    await tx.query(
      `INSERT INTO semantic.erasure_source_role(partition_no,transaction_id,account_id,role)
      VALUES($1,$2,$3,'author')`,
      [value.partition, value.original, randomUUID()],
    );
    await expect(plan(tx, { ...ceiling(), nativePoints: 3 })).rejects.toBeDefined();
    expect(
      (
        await tx.query(
          `SELECT 1 FROM semantic.erasure_locator WHERE partition_no=$1
      AND store='identity_epoch_effect_receipt' AND record_key=$2`,
          [value.partition, key],
        )
      ).rowCount,
    ).toBe(0);
    await tx.query('ROLLBACK');
    expect(
      (
        await f.admin.query(
          `SELECT 1 FROM semantic.identity_epoch_effect_receipt
      WHERE partition_no=$1 AND job_id=$2 AND effect_key=$3`,
          [value.partition, value.job.jobId, value.effect],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});

test('an unarmed or superseded capture reservation cannot dispatch at COMMIT', async () => {
  for (const superseded of [false, true]) {
    const value = await input();
    const tx = await f.pool.connect();
    try {
      await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await tx.query(sql.enable);
      const key = await insert(tx, value);
      if (superseded) {
        await plan(tx);
        await tx.query(
          `INSERT INTO semantic.erasure_copy_role(partition_no,store,record_key,transaction_id,account_id,role)
          VALUES($1,'identity_epoch_effect_receipt',$2,$3,$4,'owner')`,
          [value.partition, key, value.original, randomUUID()],
        );
      }
      await expect(tx.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
      await tx.query('ROLLBACK');
      expect(
        (
          await f.admin.query(
            `SELECT 1 FROM semantic.identity_epoch_effect_receipt
        WHERE partition_no=$1 AND job_id=$2 AND effect_key=$3`,
            [value.partition, value.job.jobId, value.effect],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
  }
});

test('repeated receipt capture retains original write-basis actor and exact sealed-role replay', async () => {
  const value = await input();
  const tx = await f.pool.connect();
  let key: string;
  let sealedAccount: string | undefined;
  try {
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await tx.query(sql.enable);
    key = await insert(tx, value);
    await plan(tx);
    await tx.query('COMMIT');
    const original = await f.admin.query<{ account_id: string; role: string; source_position: string }>(
      `SELECT account_id,role,source_position FROM semantic.erasure_locator WHERE partition_no=$1
       AND store='identity_epoch_effect_receipt' AND record_key=$2`,
      [value.partition, key],
    );
    expect(original.rows.some((row) => row.role === 'actor')).toBe(true);
    const basis = (
      await f.admin.query<{ position: string }>(
        'SELECT position FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2',
        [value.partition, value.original],
      )
    ).rows[0]!;
    expect(original.rows.find((row) => row.role === 'actor')?.source_position).toBe(basis.position);
    // The real seal is a native fact. Exact unchanged provenance is legal after sealing.
    const account = original.rows.find((row) => row.role === 'actor')!.account_id;
    sealedAccount = account;
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await tx.query(
      'INSERT INTO semantic.erasure_source_seal(partition_no,account_id,version,at) VALUES($1,$2,1,now())',
      [value.partition, account],
    );
    await tx.query(sql.enable);
    await tx.query(
      `UPDATE semantic.identity_epoch_effect_receipt SET kind=kind
      WHERE partition_no=$1 AND job_id=$2 AND effect_key=$3`,
      [value.partition, value.job.jobId, value.effect],
    );
    await plan(tx);
    await tx.query('COMMIT');
    expect(
      (
        await f.admin.query(
          `SELECT source_transaction_id FROM semantic.erasure_locator
      WHERE partition_no=$1 AND account_id=$2 AND role='actor' AND store='identity_epoch_effect_receipt' AND record_key=$3`,
          [value.partition, account, key],
        )
      ).rows[0]?.source_transaction_id,
    ).toBe(value.original);
    try {
      await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await tx.query(sql.enable);
      await tx.query(
        `INSERT INTO semantic.erasure_copy_role(partition_no,store,record_key,transaction_id,account_id,role)
        VALUES($1,'identity_epoch_effect_receipt',$2,$3,$4,'owner')`,
        [value.partition, key, value.original, account],
      );
      await tx.query(
        `UPDATE semantic.identity_epoch_effect_receipt SET kind=kind
        WHERE partition_no=$1 AND job_id=$2 AND effect_key=$3`,
        [value.partition, value.job.jobId, value.effect],
      );
      await plan(tx);
      await expect(tx.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
      await tx.query('ROLLBACK');
    } finally {
      await tx.query('ROLLBACK');
    }
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
    if (sealedAccount)
      await f.admin.query('DELETE FROM semantic.erasure_source_seal WHERE partition_no=$1 AND account_id=$2', [
        value.partition,
        sealedAccount,
      ]);
  }
});

test('capture reservation scales with complete roles and actual original requested-by bytes on all eight axes', () => {
  expect(searchReceivingCaptureCost(0, 0, null)).toEqual({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 8,
    nativePoints: 8,
    witnessKeys: 0,
    statements: 8,
    bytes: 2048,
    emptySeeks: 5,
  });
  const a = searchReceivingCaptureCost(13, 21, { bytes: 92, locators: 5 });
  const b = searchReceivingCaptureCost(14, 21, { bytes: 92, locators: 5 });
  expect(a).toEqual({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 395,
    nativePoints: 395,
    witnessKeys: 0,
    statements: 356,
    bytes: 121180,
    emptySeeks: 200,
  });
  expect(b.nativeRows - a.nativeRows).toBe(10);
  expect(b.nativePoints - a.nativePoints).toBe(10);
  expect(b.bytes - a.bytes).toBe(3072);
  expect(a.bytes).toBe(2048 + 34 * 3072 + 512 + 92 + 5 * 2816);
});

test('the actual original finite frame refuses unfunded deferred capture and atomically rolls back', async () => {
  const value = await input();
  await withIdentitySourceConsumerMaintenance(
    { pool: f.pool, env: {} },
    { deadline: Date.now() + 5000 },
    async (context) => {
      const parent = identitySourceConsumerLibraryWork(f.pool, context.identityConsumerWork, context.deadline)!;
      const allowance = identitySourceConsumerNativeWork(f.pool, context.identityConsumerWork, context.deadline)!;
      const axes = [
        'candidateKeys',
        'identityMetadataRows',
        'nativeRows',
        'nativePoints',
        'witnessKeys',
        'statements',
        'bytes',
        'emptySeeks',
      ] as const;
      const bound = Object.fromEntries(axes.map((axis) => [axis, parent.available(axis)])) as unknown as WorkDimensions;
      const declaration = receivingWorkDeclaration({
        statements: searchReceivingCapturedStatementCosts(),
        native: Object.fromEntries(
          searchReceivingOperations.map((op) => [
            op,
            {
              allowance: { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 },
              outsideSql: { ...ceiling(), nativeRows: 0, nativePoints: 0, statements: 0, bytes: 0, emptySeeks: 0 },
            },
          ]),
        ),
      });
      await expect(
        withSearchReceivingWork(
          f.pool,
          { ...context, ceiling: bound, allowance },
          declaration,
          commonSearchReceivingStatements,
          async () => {
            const tx = await f.pool.connect();
            try {
              await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
              await tx.query(receivingStatements.expectEffect, [
                value.partition,
                value.job.jobId,
                'search-canonical-index',
                value.effect,
                'remove',
              ]);
              await tx.query('COMMIT');
            } catch (error) {
              await tx.query('ROLLBACK');
              throw error;
            } finally {
              tx.release();
            }
          },
        ),
      ).rejects.toMatchObject({
        code: 'identity_epoch_unavailable',
        message: 'Search receiving capture unavailable funding: original emptySeeks requires 5, remaining 2',
      });
      expect(parent.receipt().used.nativePoints).toBeGreaterThan(0);
    },
  );
  expect(
    (
      await f.admin.query(
        `SELECT 1 FROM semantic.identity_epoch_effect_receipt
    WHERE partition_no=$1 AND job_id=$2 AND effect_key=$3`,
        [value.partition, value.job.jobId, value.effect],
      )
    ).rowCount,
  ).toBe(0);
});

test('delivery uses only the current native source commit and retains the original source position', async () => {
  const value = await input();
  const tx = await f.pool.connect();
  let key: string;
  try {
    await tx.query('BEGIN');
    key = await insert(tx, value);
    await tx.query('COMMIT');
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
  const actor = await f.actor();
  const account = randomUUID();
  const result = await runCommand(
    f.pool,
    {
      partition: value.partition,
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
    },
    async (command) => {
      const current = currentCommand(command);
      await recordSemanticSourceCommit(command, current.transactionId);
      await command.query(
        `SELECT semantic.record_erasure_locator($1,$2,'author','identity_epoch_effect_receipt',$3,$4,17)`,
        [value.partition, account, key, value.original],
      );
      registerCommandCallback(command, async () => {
        expect((await command.query('SELECT pg_current_xact_id()::text AS xid')).rows[0]?.xid).toBeDefined();
      });
      return { value: null, events: searchIdentityWriterChanged() };
    },
  );
  const row = (
    await f.admin.query(
      `SELECT source_transaction_id,source_position,delivery_position
    FROM semantic.erasure_locator WHERE partition_no=$1 AND account_id=$2 AND role='author'
    AND store='identity_epoch_effect_receipt' AND record_key=$3`,
      [value.partition, account, key],
    )
  ).rows[0]!;
  expect(row.source_transaction_id).toBe(value.original);
  expect(row.source_position).toBe('17');
  expect(row.delivery_position).toBe(String(result.position));
});

test('capture mode preserves all original legal roles for non-receiving callers', async () => {
  const value = await input();
  const tx = await f.pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await tx.query(sql.enable);
    const key = (
      await tx.query<{ erasure_key: string }>(
        'SELECT erasure_key FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2',
        [value.partition, value.job.jobId],
      )
    ).rows[0]!.erasure_key;
    const account = randomUUID();
    for (const role of roles)
      await tx.query(
        `INSERT INTO semantic.erasure_copy_role
      (partition_no,store,record_key,transaction_id,account_id,role)
      VALUES($1,'identity_epoch_job',$2,$3,$4,$5)`,
        [value.partition, key, value.original, account, role],
      );
    await tx.query("SELECT semantic.capture_erasure_roles($1,'identity_epoch_job',$2,$3)", [
      value.partition,
      key,
      value.original,
    ]);
    const captured = await tx.query<{ role: string; source_transaction_id: string }>(
      `SELECT role,source_transaction_id FROM semantic.erasure_locator WHERE partition_no=$1
       AND account_id=$2 AND store='identity_epoch_job' AND record_key=$3`,
      [value.partition, account, key],
    );
    expect(captured.rows.length).toBe(roles.length);
    for (const role of roles) expect(captured.rows).toContainEqual({ role, source_transaction_id: value.original });
    expect(
      (
        await tx.query(`SELECT 1 FROM semantic.identity_receiving_capture_pending
      WHERE transaction_xid=pg_current_xact_id()::text`)
      ).rowCount,
    ).toBe(0);
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});

test('repeated deferred events for one receipt each require and consume their own transaction reservation', async () => {
  const value = await input();
  const tx = await f.pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await tx.query(sql.enable);
    const key = await insert(tx, value);
    await tx.query(
      `UPDATE semantic.identity_epoch_effect_receipt SET kind=kind
      WHERE partition_no=$1 AND job_id=$2 AND effect_key=$3`,
      [value.partition, value.job.jobId, value.effect],
    );
    expect(
      (
        await tx.query(`SELECT ordinal FROM semantic.identity_receiving_capture_pending
      WHERE transaction_xid=pg_current_xact_id()::text ORDER BY ordinal`)
      ).rowCount,
    ).toBe(2);
    const work = await plan(tx);
    expect(work.used.nativePoints).toBeGreaterThanOrEqual(2 * 8);
    const xid = (await tx.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid;
    await tx.query('COMMIT');
    expect(
      (await f.admin.query('SELECT 1 FROM semantic.identity_receiving_capture_pending WHERE transaction_xid=$1', [xid]))
        .rowCount,
    ).toBe(0);
    expect(
      (
        await f.admin.query(
          `SELECT source_transaction_id FROM semantic.erasure_locator WHERE partition_no=$1
      AND store='identity_epoch_effect_receipt' AND record_key=$2 AND role='actor'`,
          [value.partition, key],
        )
      ).rows[0]?.source_transaction_id,
    ).toBe(value.original);
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});

test('an empty capture queue has an exact original-frame receipt and conveys no Source completion', async () => {
  await withIdentitySourceConsumerMaintenance(
    { pool: f.pool, env: {} },
    { deadline: Date.now() + 5000 },
    async (context) => {
      const parent = identitySourceConsumerLibraryWork(f.pool, context.identityConsumerWork, context.deadline)!;
      const allowance = identitySourceConsumerNativeWork(f.pool, context.identityConsumerWork, context.deadline)!;
      const axes = [
        'candidateKeys',
        'identityMetadataRows',
        'nativeRows',
        'nativePoints',
        'witnessKeys',
        'statements',
        'bytes',
        'emptySeeks',
      ] as const;
      const bound = Object.fromEntries(axes.map((axis) => [axis, parent.available(axis)])) as unknown as WorkDimensions;
      // No native method is dispatched in this SQL-only case. These zero caps authorize none.
      const declaration = receivingWorkDeclaration({
        statements: searchReceivingCapturedStatementCosts(),
        native: Object.fromEntries(
          searchReceivingOperations.map((op) => [
            op,
            {
              allowance: { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 },
              outsideSql: {
                candidateKeys: 0,
                identityMetadataRows: 0,
                nativeRows: 0,
                nativePoints: 0,
                witnessKeys: 0,
                statements: 0,
                bytes: 0,
                emptySeeks: 0,
              },
            },
          ]),
        ),
      });
      const result = await withSearchReceivingWork(
        f.pool,
        { ...context, ceiling: bound, allowance },
        declaration,
        commonSearchReceivingStatements,
        async () => {
          const tx = await f.pool.connect();
          try {
            await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
            await tx.query('COMMIT');
          } catch (error) {
            await tx.query('ROLLBACK');
            throw error;
          } finally {
            tx.release();
          }
          return 'empty funding queue';
        },
      );
      expect(result.value).toBe('empty funding queue');
      expect(result.work.used).toEqual({
        candidateKeys: 0,
        identityMetadataRows: 0,
        nativeRows: 3,
        nativePoints: 3,
        witnessKeys: 0,
        statements: 4,
        bytes: 640,
        emptySeeks: 1,
      });
    },
  );
});

test('original/native source-role union uses UUID identity rather than setting text spelling', async () => {
  const value = await input();
  const account = randomUUID();
  const tx = await f.pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await tx.query(sql.enable);
    await tx.query("SELECT set_config('semantic.erasure_native_transaction',$1,true)", [value.original.toUpperCase()]);
    const key = await insert(tx, value);
    await tx.query(
      `INSERT INTO semantic.erasure_source_role(partition_no,transaction_id,account_id,role)
      VALUES($1,$2,$3,'editor')`,
      [value.partition, value.original, account],
    );
    await plan(tx);
    await tx.query('COMMIT');
    expect(
      (
        await f.admin.query(
          `SELECT source_transaction_id FROM semantic.erasure_locator WHERE partition_no=$1
      AND account_id=$2 AND role='editor' AND store='identity_epoch_effect_receipt' AND record_key=$3`,
          [value.partition, account, key],
        )
      ).rows[0]?.source_transaction_id,
    ).toBe(value.original);
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
});
