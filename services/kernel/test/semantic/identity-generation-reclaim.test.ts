import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { newId } from '../../src/route/route.ts';
import { readPublishedIdentityMoveScopes } from '../../src/semantic/identity-epoch-published-move.ts';
import { identityEpochStore } from '../../src/semantic/identity-adapters/index.ts';
import {
  assertIdentityGenerationCapacity,
  stepIdentityGenerationReclaim,
} from '../../src/semantic/identity-generation-reclaim.ts';

test('released input retains its slot until a separate indexed empty-range proof commits', async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 2 });
  const job = { jobId: newId(0), epoch: 2n };
  const [retired, current, admission, release, terminal, successor] = Array.from({ length: 6 }, () => newId(0));
  const originals = Array.from({ length: 10 }, () => newId(0)).sort();
  const scope = 'a'.repeat(64);
  const state = async () =>
    (
      await pool.query(
        `SELECT d.reclaimed,d.reclaim_after,d.reclaim_transaction_id,d.release_transaction_id,
        (SELECT count(*)::int FROM semantic.identity_epoch_original WHERE partition_no=0 AND generation=$2) AS members,
        (SELECT count(*)::int FROM semantic.identity_epoch_original WHERE partition_no=0 AND generation=$3) AS current,
        (SELECT count(*)::int FROM semantic.identity_epoch_mapping_generation WHERE partition_no=0 AND generation=$2) AS slots,
        (SELECT revision FROM semantic.title_input_home_revision WHERE partition_no=0) AS title_revision
      FROM semantic.identity_epoch_prearm_directory d WHERE (d.partition_no,d.job_id,d.generation)=(0,$1,$2)`,
        [job.jobId, retired, current],
      )
    ).rows[0];
  const allow = () =>
    runCommand(pool, { partition: 0 }, async (tx) => {
      await assertIdentityGenerationCapacity(tx, 0, successor);
      return noEffect(null);
    });
  try {
    const tx = await pool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query(
        `INSERT INTO semantic.identity_epoch_native_commit(partition_no,transaction_id,epoch,position,purpose)
        SELECT partition_no,$1::uuid,epoch,position,'admission' FROM core.partition WHERE partition_no=0
        UNION ALL
        SELECT partition_no,$2::uuid,epoch,position,'identity-prearm-release' FROM core.partition WHERE partition_no=0`,
        [admission, release],
      );
      await tx.query("SELECT set_config('semantic.erasure_native_transaction',$1,true)", [admission]);
      await tx.query(
        `INSERT INTO semantic.identity_epoch_job
        (partition_no,job_id,epoch,intent,receipt_key,receipt,scope_digest,state,recorded_transaction_id)
        VALUES(0,$1,2,$2,'reclaim-fixture','{}',$3,'published',$4)`,
        [job.jobId, { kind: 'merge', survivor: terminal, redirected: originals[0] }, scope, admission],
      );
      for (const step of ['mapping', 'search-canonical-index', 'library-private-follow-counts']) {
        const ref = { jobId: job.jobId, epoch: '2' };
        await tx.query(
          `INSERT INTO semantic.identity_epoch_ack
          (partition_no,job_id,step,version,scope_digest,progress,native_partition,native_epoch,native_position,native_transaction_id)
          VALUES(0,$1,$2,1,$3,$4,0,1,0,$5)`,
          [
            job.jobId,
            step,
            scope,
            { state: 'complete', job: ref, receipt: { job: ref, native: { position: '0' } } },
            admission,
          ],
        );
      }
      await tx.query(
        `INSERT INTO semantic.identity_epoch_input
        (partition_no,job_id,terminal,generation,basis_version,original_count,control_partition,owner_epoch)
        VALUES(0,$1,$2,$3,1,10,0,1)`,
        [job.jobId, terminal, retired],
      );
      await tx.query(
        'INSERT INTO semantic.identity_epoch_admission_plan(partition_no,job_id,resource_home,released) VALUES(0,$1,0,true)',
        [job.jobId],
      );
      await tx.query(
        `INSERT INTO semantic.identity_epoch_group(partition_no,terminal,observed_count,generation,owner_epoch,version,ready,published_epoch)
        VALUES(0,$1,10,$2,1,2,true,2)`,
        [terminal, current],
      );
      await tx.query(
        `INSERT INTO semantic.identity_epoch_prearm_bridge(partition_no,generation,terminal,owner_epoch,basis_version)
        VALUES(0,$1,$2,1,1)`,
        [retired, terminal],
      );
      await tx.query(
        `INSERT INTO semantic.identity_epoch_prearm_directory
        (partition_no,job_id,job_epoch,generation,terminal,basis_version,owner_epoch,scope_digest,attempt_transaction_id,
         exhausted,sealed_transaction_id,released,release_transaction_id)
        VALUES(0,$1,2,$2,$3,1,1,$4,$5,true,$5,true,$6)`,
        [job.jobId, retired, terminal, scope, admission, release],
      );
      await tx.query(
        'INSERT INTO semantic.identity_epoch_mapping_generation(partition_no,slot,job_id,generation,terminal) VALUES(0,0,$1,$2,$3)',
        [job.jobId, retired, terminal],
      );
      await tx.query(
        `INSERT INTO semantic.identity_epoch_original(partition_no,generation,original,terminal,source_partition,source_generation,present)
        SELECT 0,g,original,$3,0,1,true FROM unnest($1::uuid[]) g CROSS JOIN unnest($2::uuid[]) original`,
        [[retired, current], originals, terminal],
      );
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    } finally {
      tx.release();
    }

    await expect(allow()).rejects.toMatchObject({ code: 'identity_epoch_unavailable' });
    await expect(identityEpochStore().pageChanges(pool, job, null)).rejects.toMatchObject({
      code: 'identity_epoch_unavailable',
    });
    // A different current header using this exact generation still vetoes the old slot's reclaim.
    await pool.query(
      `INSERT INTO semantic.identity_epoch_group(partition_no,terminal,observed_count,generation,owner_epoch)
      VALUES(0,$1,10,$2,1)`,
      [successor, retired],
    );
    await expect(stepIdentityGenerationReclaim(pool, job)).rejects.toMatchObject({
      code: 'identity_epoch_unavailable',
    });
    await pool.query('DELETE FROM semantic.identity_epoch_group WHERE partition_no=0 AND terminal=$1', [successor]);
    const titleRevision = (await state()).title_revision;
    const previousSnapshot = await pool.connect();
    try {
      await previousSnapshot.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await previousSnapshot.query(
        'SELECT generation FROM semantic.identity_epoch_prearm_bridge WHERE (partition_no,generation)=(0,$1)',
        [retired],
      );
      expect(await stepIdentityGenerationReclaim(pool, job)).toBe('more');
      await expect(
        previousSnapshot.query(
          `INSERT INTO semantic.identity_epoch_original(partition_no,generation,original,terminal,source_partition,source_generation,present)
        VALUES(0,$1,$2,$3,0,1,true)`,
          [retired, newId(0), terminal],
        ),
      ).rejects.toMatchObject({ code: '40001' });
    } finally {
      await previousSnapshot.query('ROLLBACK');
      previousSnapshot.release();
    }
    expect(await state()).toMatchObject({ members: 10, current: 10, slots: 1, reclaim_after: null, reclaimed: false });
    await expect(
      pool.query(
        `INSERT INTO semantic.identity_epoch_original(partition_no,generation,original,terminal,source_partition,source_generation,present)
      VALUES(0,$1,$2,$3,0,1,true)`,
        [retired, randomUUID(), terminal],
      ),
    ).rejects.toThrow('identity_effect_stale');

    expect(await stepIdentityGenerationReclaim(pool, job)).toBe('more');
    expect(await state()).toMatchObject({ members: 2, current: 10, slots: 1, reclaim_after: originals[7] });
    expect(await stepIdentityGenerationReclaim(pool, job)).toBe('more');
    expect(await state()).toMatchObject({ members: 0, current: 10, slots: 1, reclaim_after: originals[9] });
    await expect(allow()).rejects.toMatchObject({ code: 'identity_epoch_unavailable' });

    expect(await stepIdentityGenerationReclaim(pool, job)).toBe('more');
    const final = await state();
    expect(final).toMatchObject({
      members: 0,
      current: 10,
      slots: 0,
      reclaimed: true,
      release_transaction_id: release,
      title_revision: titleRevision,
    });
    expect(await readPublishedIdentityMoveScopes(pool, job)).toEqual([terminal]);
    expect(
      (
        await pool.query(
          `SELECT 1 FROM semantic.identity_epoch_native_commit n
      JOIN semantic.erasure_source_disposition d USING(partition_no,transaction_id)
      WHERE n.partition_no=0 AND n.transaction_id=$1 AND n.purpose='identity-generation-reclaim'
        AND d.store='identity_epoch_mapping_generation' AND d.disposition='removed' AND d.xmin=n.xmin`,
          [final.reclaim_transaction_id],
        )
      ).rowCount,
    ).toBe(1);
    await allow();
    expect(await stepIdentityGenerationReclaim(pool, job)).toBe('complete');
    expect(await state()).toEqual(final);
  } finally {
    await pool.end();
  }
});
