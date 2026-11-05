import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { currentCommand, runCommand, type CommandTransaction } from '../../src/command/command.ts';
import { searchIdentityWriterChanged } from '../../src/search/identity-epoch-participant-events.ts';
import { recordSemanticSourceCommit } from '../../src/semantic/erasure-producer.ts';
import { epochFixture, home, type EpochFixture } from './support/identity-epoch.ts';
import { admittedReceivingJob } from './support/identity-receiving-effects.ts';

// Native regression for the representation required by complete original/native capture.
// Both write bases and delivery positions come from actual commands. This is not a
// configured capture-composer, funding, engine, acknowledgement or deletion proof.
let f: EpochFixture;
beforeAll(async () => {
  f = await epochFixture();
});
afterAll(async () => {
  await f?.close();
});

type Origin = { source_transaction_id: string; source_position: string };
type Input = Awaited<ReturnType<typeof input>>;

async function input() {
  const { job } = await admittedReceivingJob(f);
  const partition = home(job.jobId);
  const original = (
    await f.admin.query<Origin & { account_id: string }>(
      `SELECT j.recorded_transaction_id::text AS source_transaction_id,
       b.position::text AS source_position,b.principal_id::text AS account_id
     FROM semantic.identity_epoch_job j JOIN editorial.write_basis b
       ON b.partition_no=j.partition_no AND b.transaction_id=j.recorded_transaction_id
     WHERE j.partition_no=$1 AND j.job_id=$2 AND b.principal_kind='account'`,
      [partition, job.jobId],
    )
  ).rows[0]!;
  const actor = await f.actor();
  expect(original.account_id).toBe(actor.accountId);
  // Use a real admitted receipt; no role, source-commit, write-basis or directory
  // rows are fixture-written to stand in for either command's provenance.
  const key = (
    await f.pool.query<{ erasure_key: string }>(
      `INSERT INTO semantic.identity_epoch_effect_receipt(partition_no,job_id,step,effect_key,kind)
     VALUES($1,$2,'search-canonical-index',$3,'remove') RETURNING erasure_key::text`,
      [partition, job.jobId, randomUUID()],
    )
  ).rows[0]!.erasure_key;
  return { partition, original, actor, key };
}

async function captureOrigins(tx: CommandTransaction, value: Input, nativeFirst: boolean) {
  const current = currentCommand(tx);
  await recordSemanticSourceCommit(tx, current.transactionId);
  const native = (
    await tx.query<Origin>(
      `SELECT transaction_id::text AS source_transaction_id,position::text AS source_position
     FROM semantic.erasure_source_commit
     WHERE partition_no=$1 AND transaction_id=$2 AND xmin::text=pg_current_xact_id()::text`,
      [value.partition, current.transactionId],
    )
  ).rows[0]!;
  expect(native.source_transaction_id).not.toBe(value.original.source_transaction_id);
  const origins = nativeFirst ? [native, value.original] : [value.original, native];
  for (const origin of origins)
    await tx.query(`SELECT semantic.record_erasure_locator($1,$2,'actor','identity_epoch_effect_receipt',$3,$4,$5)`, [
      value.partition,
      value.actor.accountId,
      value.key,
      origin.source_transaction_id,
      origin.source_position,
    ]);
  return native;
}

async function directory(value: Input) {
  return (
    await f.admin.query<Origin & { delivery_position: string }>(
      `SELECT source_transaction_id::text,source_position::text,delivery_position::text
     FROM semantic.erasure_source_record WHERE partition_no=$1 AND account_id=$2
       AND role='actor' AND store='identity_epoch_effect_receipt' AND record_key=$3
     ORDER BY delivery_position,source_transaction_id`,
      [value.partition, value.actor.accountId, value.key],
    )
  ).rows;
}

async function locator(value: Input) {
  return (
    await f.admin.query<Origin & { delivery_position: string }>(
      `SELECT source_transaction_id::text,source_position::text,delivery_position::text
     FROM semantic.erasure_locator WHERE partition_no=$1 AND account_id=$2
       AND role='actor' AND store='identity_epoch_effect_receipt' AND record_key=$3
     ORDER BY delivery_position,source_transaction_id`,
      [value.partition, value.actor.accountId, value.key],
    )
  ).rows;
}

test('same-account original and native actor origins survive one genuine delivery in either capture order', async () => {
  for (const nativeFirst of [false, true]) {
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
      async (tx) => ({ value: await captureOrigins(tx, value, nativeFirst), events: searchIdentityWriterChanged() }),
    );
    const native = result.value;
    // The deferred source-commit constraint must have resolved the actual native
    // write basis. A setting, caller position or second payer cannot establish it.
    expect(
      (
        await f.admin.query<Origin>(
          `SELECT transaction_id::text AS source_transaction_id,position::text AS source_position
       FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2`,
          [value.partition, native.source_transaction_id],
        )
      ).rows,
    ).toEqual([native]);
    expect(native.source_position).toBe(String(result.position));
    const expected = [value.original, native]
      .map(({ source_transaction_id, source_position }) => ({
        source_transaction_id,
        source_position,
        delivery_position: String(result.position),
      }))
      .sort((a, b) => a.source_transaction_id.localeCompare(b.source_transaction_id));
    expect((await directory(value)).filter((row) => row.delivery_position === String(result.position))).toEqual(
      expected,
    );
  }
});

test('rollback retains the original actor origin and removes every attempted native origin', async () => {
  const value = await input();
  const before = await directory(value);
  const beforeLocator = await locator(value);
  expect(before.some((row) => row.source_transaction_id === value.original.source_transaction_id)).toBe(true);
  expect(beforeLocator.some((row) => row.source_transaction_id === value.original.source_transaction_id)).toBe(true);
  const failure = new Error('Abort the real receiving command after both provenance writes');
  let native: Origin | undefined;
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
        native = await captureOrigins(tx, value, false);
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
  expect(native).toBeDefined();
  expect(await directory(value)).toEqual(before);
  expect(await locator(value)).toEqual(beforeLocator);
  expect(
    (
      await f.admin.query(`SELECT 1 FROM semantic.erasure_source_commit WHERE partition_no=$1 AND transaction_id=$2`, [
        value.partition,
        native!.source_transaction_id,
      ])
    ).rowCount,
  ).toBe(0);
  expect(
    (
      await f.admin.query(`SELECT 1 FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2`, [
        value.partition,
        native!.source_transaction_id,
      ])
    ).rowCount,
  ).toBe(0);
});
