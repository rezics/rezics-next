import type { CommandTransaction } from '../command/command.ts';
import { admitZoneCleanup, advanceZoneCleanupGrants } from '../semantic/deletion/index.ts';
import { liveCoverage, retainCoveredPayload } from './cleanup-intent.ts';
import { compareAndSetZone, lockZoneHead } from './resource-head.ts';

/** Account-erasure payload effect. Holds defer; live decisions keep their originals; public active payload stays. */
export async function minimizeAccountErasureZone(
  tx: CommandTransaction,
  input: { route: number; id: string; accountId: string; at: string; transactionId: string },
): Promise<'minimized' | 'held' | 'missing' | 'unchanged'> {
  const row = await lockZoneHead(tx, input.route, input.id);
  if (!row) return 'missing';
  if (row.held) return 'held';
  if (row.ownerId === input.accountId) {
    const admission = await admitZoneCleanup(tx, row, {
      at: input.at,
      accountId: input.accountId,
      barrier: { version: '1', at: input.at },
      primaryOwner: {
        accountId: input.accountId,
        revision: row.revision,
        lifecycleRevision: row.lifecycleRevision,
        transactionId: row.transactionId,
      },
    });
    if (admission) {
      const grants = await advanceZoneCleanupGrants(tx, admission, null, 100);
      if (grants.disposition === 'progress') return 'held';
    }
  }
  const matchingOwner = row.ownerId === input.accountId;
  const keepPublicPayload = row.visibility === 'public' && row.state === 'active' && row.publicEver;
  const coverage = liveCoverage(row);
  let configuration = row.configuration;
  let mounts = row.mounts ?? [];
  let state = row.state;
  if (!keepPublicPayload) {
    if (coverage.length > 0) {
      const kept = retainCoveredPayload(row);
      configuration = kept.configuration;
      mounts = kept.mounts;
    } else {
      configuration = null;
      mounts = [];
    }
    state = 'purged';
  }
  const ownerId = matchingOwner ? null : row.ownerId;
  if (
    row.writeFenced &&
    row.ownerId === ownerId &&
    row.state === state &&
    row.deletedAt === null &&
    row.restoreUntil === null
  )
    return 'unchanged';
  const changed = await compareAndSetZone(
    tx,
    row,
    {
      ...row,
      configuration,
      mounts,
      ownerId,
      state,
      writeFenced: true,
      deletedAt: null,
      restoreUntil: null,
    },
    { at: input.at, transactionId: input.transactionId },
  );
  if (!changed) throw new Error('zone_account_erasure_source_changed');
  return 'minimized';
}
