import type { Pool } from 'pg';
import { noEffect, registerCommandCallback, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { IDENTITY_EPOCH_PROGRESS } from './events.ts';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import { IdentityEpochStoreError, recordIdentityEpochNativeCommit } from './identity-epoch-store.ts';
import installation from './identity-epoch-bootstrap-installation.sql';
import prepare from './identity-epoch-bootstrap-prepare-installation.sql';
import insert from './identity-epoch-bootstrap-insert-installation.sql';

export type IdentityEpochInstallation = Readonly<{
  mode: 'absence' | 'legacy';
  installationXid: string;
  native: IdentityNativeReceipt;
}>;
const unavailable = () =>
  new IdentityEpochStoreError('identity_epoch_unavailable', 'Native identity installation custody unavailable');

/** The only source-wide structural inspection is the locked, one-time native installation.
 * Restart uses the immutable installation receipt and installed capture/birth guards, not another scan.
 * Absence never manufactures 4096 source-home receipts or mutates the legacy topology frontier.
 */
export async function installIdentityEpochBootstrap(pool: Pool): Promise<IdentityEpochInstallation> {
  // The migration cut uses READ COMMITTED: the post-lock scan must see writers drained by
  // those locks. A SERIALIZABLE command snapshot minted before the lock is insufficient.
  // A crash after this commit leaves guarded cut custody, still unavailable until native closure.
  await withConnection(pool, async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      await tx.query(prepare.sql);
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
  await runCommand(pool, { partition: 0 }, async (tx) => {
    const existing = (await tx.query(installation.sql)).rows[0];
    if (existing) {
      if (!existing.valid) throw unavailable();
      return noEffect(null);
    }
    recordIdentityEpochNativeCommit(tx, 'bootstrap');
    registerCommandCallback(tx, async (transactionId) => {
      if ((await tx.query(insert.sql, [transactionId])).rowCount !== 1) throw unavailable();
    });
    return { value: null, events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: 0, generation: '1' } }] };
  });
  // Return only actual committed proof, after releasing the installation command's connection.
  return withConnection(pool, async (tx) => {
    const saved = (await tx.query(installation.sql)).rows[0];
    if (!saved?.valid || (saved.mode !== 'absence' && saved.mode !== 'legacy')) throw unavailable();
    return {
      mode: saved.mode,
      installationXid: saved.installation_xid,
      native: {
        partition: 0,
        transactionId: saved.transaction_id,
        epoch: saved.epoch,
        position: BigInt(saved.position),
      },
    };
  });
}
