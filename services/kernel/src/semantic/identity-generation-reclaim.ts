import type { Pool } from 'pg';
import { noEffect, registerCommandCallback, runCommand, type CommandTransaction } from '../command/command.ts';
import { IdentityEpochStoreError } from './contract/identity-errors.ts';
import { recordSemanticSourceDisposition } from './erasure-producer.ts';
import { IDENTITY_EPOCH_ADMITTED, IDENTITY_EPOCH_PROGRESS } from './events.ts';
import { identityJobPartition, identityHomeAvailable } from './identity-adapters/identity-epoch-contract.ts';
import { recordIdentityEpochNativeCommit } from './identity-adapters/native-commit.ts';
import { identityEpochStore } from './identity-adapters/index.ts';
import type { IdentityJobRef } from './identity-epoch-contract.ts';
import { withReadTransaction } from './read.ts';

const purpose = 'identity-generation-reclaim';
const unavailable = () =>
  new IdentityEpochStoreError(
    'identity_epoch_unavailable',
    'Retired generation lacks native release or empty-range custody',
  );

type Input = {
  control_partition: number;
  terminal: string;
  generation: string;
  owner_epoch: number;
  basis_version: string;
  scope_digest: string;
};
type Progress = 'complete' | 'more' | 'blocked';

export async function stepIdentityGenerationReclaim(
  pool: Pool,
  job: IdentityJobRef,
  wakeCoordinator = false,
): Promise<'complete' | 'more'> {
  const inputs = await withReadTransaction(pool, async (tx) => {
    const saved = await identityEpochStore().readJob(tx, job);
    if (
      saved?.state !== 'published' ||
      saved.mapping?.state !== 'complete' ||
      saved.participants['search-canonical-index']?.state !== 'complete' ||
      saved.participants['library-private-follow-counts']?.state !== 'complete'
    )
      throw unavailable();
    const result = await tx.query<Input & { released: boolean }>(
      `SELECT i.control_partition,i.terminal,i.generation,i.owner_epoch,i.basis_version,j.scope_digest,
        coalesce(p.released,false) AS released
      FROM semantic.identity_epoch_input i
      JOIN semantic.identity_epoch_job j USING(partition_no,job_id)
      JOIN semantic.identity_epoch_native_commit a
        ON (a.partition_no,a.transaction_id)=(j.partition_no,j.recorded_transaction_id) AND a.purpose='admission'
      JOIN core.partition owner ON owner.partition_no=j.partition_no AND owner.epoch=a.epoch
        AND owner.position>=a.position AND owner.write_state='active' AND owner.moved_to IS NULL
      LEFT JOIN semantic.identity_epoch_admission_plan p
        ON (p.partition_no,p.job_id,p.resource_home)=(i.partition_no,i.job_id,i.control_partition)
      WHERE (i.partition_no,i.job_id)=($1,$2)
      ORDER BY i.terminal LIMIT 3`,
      [identityJobPartition(job), job.jobId],
    );
    if (result.rows.length < 1 || result.rows.length > 2 || result.rows.some((i) => !i.released)) throw unavailable();
    return result.rows;
  });

  let blocked = false;
  for (const input of inputs) {
    const result = await reclaimInputPage(pool, job, input, wakeCoordinator);
    if (result === 'more') return result;
    if (result === 'blocked') blocked = true;
  }
  if (blocked) throw unavailable();
  return 'complete';
}

async function reclaimInputPage(
  pool: Pool,
  job: IdentityJobRef,
  input: Input,
  wakeCoordinator: boolean,
): Promise<Progress> {
  const { control_partition: home, generation, terminal, owner_epoch: owner, basis_version: version } = input;
  const key = [home, job.jobId, generation];
  const range = [home, generation];
  return (
    await runCommand<Progress>(pool, { partition: home }, async (tx) => {
      // Take the same control -> group -> generation locks used for acquisition.
      const control = await tx.query('SELECT 1 FROM semantic.identity_epoch_control WHERE partition_no=$1 FOR UPDATE', [
        home,
      ]);
      if (!control.rowCount) return noEffect('blocked');
      const group = await tx.query(
        'SELECT 1 FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=$2 AND owner_epoch=$3 FOR UPDATE',
        [home, terminal, owner],
      );
      if (!group.rowCount) return noEffect('blocked');
      const bridge = (
        await tx.query<{ reclaim_transaction_id: string | null }>(
          `SELECT reclaim_transaction_id FROM semantic.identity_epoch_prearm_bridge
          WHERE (partition_no,generation,terminal,owner_epoch,basis_version)=($1,$2,$3,$4,$5)
            AND job_id IS NULL FOR UPDATE`,
          [...range, terminal, owner, version],
        )
      ).rows[0];
      if (!bridge) return noEffect('blocked');
      const directory = (
        await tx.query<{ reclaim_after: string | null; reclaim_transaction_id: string | null; reclaimed: boolean }>(
          `SELECT d.reclaim_after,d.reclaim_transaction_id,d.reclaimed
          FROM semantic.identity_epoch_prearm_directory d
          JOIN core.partition p ON p.partition_no=d.partition_no AND p.epoch=d.owner_epoch
            AND p.write_state='active' AND p.moved_to IS NULL
          JOIN semantic.identity_epoch_native_commit n
            ON (n.partition_no,n.transaction_id)=(d.partition_no,d.release_transaction_id)
            AND n.purpose='identity-prearm-release' AND n.epoch=p.epoch AND n.position<=p.position
          LEFT JOIN semantic.identity_epoch_native_commit r
            ON (r.partition_no,r.transaction_id)=(d.partition_no,d.reclaim_transaction_id)
            AND r.purpose='identity-generation-reclaim' AND r.epoch=p.epoch AND r.position<=p.position AND r.xmin=d.xmin
          WHERE (d.partition_no,d.job_id,d.generation)=($1,$2,$3)
            AND (d.job_epoch,d.terminal,d.owner_epoch,d.basis_version,d.scope_digest)=($4,$5,$6,$7,$8)
            AND d.released AND d.exhausted AND d.sealed_transaction_id IS NOT NULL
            AND CASE WHEN d.reclaim_transaction_id IS NULL THEN n.xmin=d.xmin ELSE r.transaction_id IS NOT NULL END
          FOR UPDATE OF d`,
          [...key, job.epoch.toString(), terminal, owner, version, input.scope_digest],
        )
      ).rows[0];
      if (!directory || Boolean(directory.reclaim_transaction_id) !== Boolean(bridge.reclaim_transaction_id))
        return noEffect('blocked');
      const slot = (
        await tx.query<{ erasure_key: string; ours: boolean }>(
          `SELECT erasure_key::text,
            ((job_id,terminal)=($3,$4) AND closure_copies=0 AND NOT closure_source_pool) AS ours
          FROM semantic.identity_epoch_mapping_generation
          WHERE (partition_no,generation)=($1,$2) FOR UPDATE`,
          [...range, job.jobId, terminal],
        )
      ).rows[0];
      if (directory.reclaimed && !slot) return noEffect('complete');
      if (directory.reclaimed || !slot?.ours) return noEffect('blocked');
      const refs = (
        await tx.query<{ held: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM semantic.identity_epoch_group WHERE (partition_no,generation)=($1,$2))
            OR EXISTS(SELECT 1 FROM semantic.identity_scope_bridge
              WHERE (partition_no,generation)=($1,$2) AND closed_job IS NOT NULL)
            OR EXISTS(SELECT 1 FROM semantic.identity_epoch_original WHERE (partition_no,generation)=($1,$2)
              AND (closure_reservation IS NOT NULL OR closure_claim IS NOT NULL OR closure_state IN ('preparing','withdrawn')))
            AS held`,
          range,
        )
      ).rows[0];
      if (!refs || refs.held) return noEffect('blocked');

      // Publication and release retire the flat readers. Exact undo, effect, source and
      // scoped-registration receipts remain usable by their owners without membership.
      let after = directory.reclaim_after;
      let reclaimed = false;
      if (directory.reclaim_transaction_id) {
        const page = (
          await tx.query<{ original: string }>(
            `SELECT original::text FROM semantic.identity_epoch_original
            WHERE (partition_no,generation)=($1,$2)
              AND original>coalesce($3::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
            ORDER BY identity_epoch_original.original LIMIT 8`,
            [...range, after],
          )
        ).rows;
        if (page.length) {
          // Point deletes keep the planner from joining this keyset against the full generation.
          for (const { original } of page) {
            const deleted = await tx.query(
              'DELETE FROM semantic.identity_epoch_original WHERE (partition_no,generation,original)=($1,$2,$3)',
              [...range, original],
            );
            if (deleted.rowCount !== 1) throw unavailable();
          }
          after = page.at(-1)!.original;
        } else {
          // A separate full-prefix seek also detects a key behind the saved cursor.
          const remaining = await tx.query(
            `SELECT 1 FROM semantic.identity_epoch_original
            WHERE (partition_no,generation)=($1,$2) ORDER BY original LIMIT 1`,
            range,
          );
          if (remaining.rowCount) return noEffect('blocked');
          const removed = await tx.query(
            'DELETE FROM semantic.identity_epoch_mapping_generation WHERE (partition_no,job_id,generation)=($1,$2,$3)',
            key,
          );
          if (removed.rowCount !== 1) throw unavailable();
          reclaimed = true;
        }
      }

      recordIdentityEpochNativeCommit(tx, purpose);
      registerCommandCallback(tx, async (id) => {
        if (!bridge.reclaim_transaction_id) {
          // Update the lock row so a serializable writer with an older snapshot cannot miss the fence.
          const fenced = await tx.query(
            `UPDATE semantic.identity_epoch_prearm_bridge SET reclaim_transaction_id=$3
            WHERE (partition_no,generation)=($1,$2) AND reclaim_transaction_id IS NULL AND job_id IS NULL`,
            [...range, id],
          );
          if (fenced.rowCount !== 1) throw unavailable();
        }
        const saved = await tx.query(
          `UPDATE semantic.identity_epoch_prearm_directory
          SET reclaim_after=$4,reclaim_transaction_id=$5,reclaimed=$6
          WHERE (partition_no,job_id,generation)=($1,$2,$3) AND NOT reclaimed`,
          [...key, after, id, reclaimed],
        );
        if (saved.rowCount !== 1) throw unavailable();
      });
      if (reclaimed)
        recordSemanticSourceDisposition(tx, 'identity_epoch_mapping_generation', slot.erasure_key, 'removed');
      return {
        value: 'more',
        events: [
          { type: IDENTITY_EPOCH_PROGRESS, data: { partition: home, generation: job.epoch.toString() } },
          ...(reclaimed ? [identityHomeAvailable(home)] : []),
          ...(wakeCoordinator
            ? [
                {
                  type: IDENTITY_EPOCH_ADMITTED,
                  data: { partition: identityJobPartition(job), jobId: job.jobId, epoch: job.epoch.toString() },
                },
              ]
            : []),
        ],
      };
    })
  ).value;
}

/** The four-slot ledger locates resumable published work on older attempts too. */
export async function retainedIdentityReclaimJob(pool: Pool, home: number): Promise<IdentityJobRef | null> {
  const row = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query<{ job_id: string; job_epoch: string }>(
          `SELECT s.job_id,d.job_epoch
      FROM semantic.identity_epoch_mapping_generation s
      JOIN semantic.identity_epoch_prearm_directory d USING(partition_no,job_id,generation)
      WHERE s.partition_no=$1 AND d.released AND NOT d.reclaimed
      ORDER BY s.slot LIMIT 1`,
          [home],
        )
      ).rows[0],
  );
  return row ? { jobId: row.job_id, epoch: BigInt(row.job_epoch) } : null;
}

export async function hasIdentityGenerationToReclaim(pool: Pool, job: IdentityJobRef): Promise<boolean> {
  return withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query(
          `SELECT 1 FROM semantic.identity_epoch_input i
        JOIN semantic.identity_epoch_mapping_generation s
          ON (s.partition_no,s.job_id,s.generation)=(i.control_partition,i.job_id,i.generation)
        WHERE (i.partition_no,i.job_id)=($1,$2) LIMIT 1`,
          [identityJobPartition(job), job.jobId],
        )
      ).rowCount === 1,
  );
}

export const identityGenerationCapacitySql = `SELECT slot FROM semantic.identity_epoch_mapping_generation
    WHERE partition_no=$1 AND job_id IS DISTINCT FROM $2::uuid ORDER BY slot LIMIT 1`;

export async function assertIdentityGenerationCapacity(
  tx: CommandTransaction,
  home: number,
  jobId: string | null = null,
): Promise<void> {
  if ((await tx.query(identityGenerationCapacitySql, [home, jobId])).rowCount)
    throw new IdentityEpochStoreError(
      'identity_epoch_unavailable',
      'Prior native generation awaits minimizer and empty-range custody',
    );
}
