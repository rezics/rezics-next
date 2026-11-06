import { lockRecordPurgeAuthoritySource, type RecordPurgeAuthority } from '../semantic/record-purge-authority.ts';
import { authoritativeTimeValue, currentCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf } from '../route/route.ts';
import { liveCoverage, retainCoveredPayload } from './cleanup-intent.ts';
import { compareAndSetZone, lockZoneHead, type ZoneHead } from './resource-store.ts';

type ZoneRetentionInput = Readonly<{
  route: number;
  id: string;
  deletedAt: string;
  transactionId: string;
  authority: RecordPurgeAuthority | null;
}>;
async function source(
  tx: CommandTransaction,
  input: ZoneRetentionInput,
): Promise<{
  outcome: 'eligible' | 'ineligible' | 'cancelled';
  row: ZoneHead;
}> {
  const command = currentCommand(tx);
  if (partitionOf(input.route) !== command.partition) throw new RangeError('Zone retention is in another home');
  const row = await lockZoneHead(tx, input.route, input.id);
  if (!row) throw new Error('zone_record_retention_source_missing');
  if (row.state === 'active' || row.state === 'purged') return { outcome: 'cancelled', row };
  const authority = input.authority && (await lockRecordPurgeAuthoritySource(tx, input.authority));
  if (
    !authority ||
    !('kind' in authority.reference) ||
    authority.reference.kind !== 'zone' ||
    authority.reference.zoneId !== input.id
  )
    return { outcome: 'ineligible', row };
  const eligibility = await tx.query<{ eligible: boolean }>(
    `SELECT state='deleted' AND NOT held
    AND deleted_at=$3::timestamptz AND restore_until=deleted_at+interval '720 hours'
    AND restore_until<=$4::timestamptz AND withholding='{}'::jsonb AS eligible
    FROM zones.zone WHERE route=$1 AND zone_id=$2`,
    [input.route, input.id, input.deletedAt, authoritativeTimeValue(command.time)],
  );
  return { outcome: eligibility.rows[0]?.eligible ? 'eligible' : 'ineligible', row };
}

/** Revalidate held, restored and generation-changed resources before entering shared history. */
export async function inspectDeletedZoneRetention(tx: CommandTransaction, input: ZoneRetentionInput) {
  return (await source(tx, input)).outcome;
}

/** Own native keys and the sole Zone CAS writer, never a fabricated Semantic candidate or Content authority. */
export async function minimizeDeletedZone(
  tx: CommandTransaction,
  input: ZoneRetentionInput,
): Promise<'minimized' | 'ineligible' | 'cancelled'> {
  const command = currentCommand(tx);
  const { outcome, row } = await source(tx, input);
  if (outcome !== 'eligible') return outcome;
  const changed = await compareAndSetZone(
    tx,
    row,
    {
      ...row,
      configuration: null,
      mounts: [],
      ownerId: null,
      writeFenced: true,
    },
    { at: authoritativeTimeValue(command.time), transactionId: input.transactionId },
  );
  if (!changed) throw new Error('zone_record_retention_source_changed');
  return 'minimized';
}

/** Ordinary shared-phase completion. Rechecks the parent lock, hold and restore before the purged marker. */
export async function completeDeletedZoneRetention(
  tx: CommandTransaction,
  input: { route: number; id: string },
): Promise<'purged' | 'held' | 'cancelled'> {
  const command = currentCommand(tx);
  const row = await lockZoneHead(tx, input.route, input.id);
  if (!row) throw new Error('zone_record_retention_source_missing');
  if (row.state === 'active') return 'cancelled';
  if (row.held) return 'held';
  if (row.state === 'purged') return 'purged';
  const changed = await compareAndSetZone(
    tx,
    row,
    { ...row, state: 'purged' },
    { at: authoritativeTimeValue(command.time), transactionId: command.transactionId },
  );
  if (!changed) throw new Error('zone_record_retention_source_changed');
  return 'purged';
}

/** Account-erasure payload effect. Holds defer; live decisions keep their originals; public active payload stays. */
export async function minimizeAccountErasureZone(
  tx: CommandTransaction,
  input: { route: number; id: string; accountId: string },
): Promise<'minimized' | 'held' | 'missing' | 'unchanged'> {
  const command = currentCommand(tx);
  const row = await lockZoneHead(tx, input.route, input.id);
  if (!row) return 'missing';
  if (row.held) return 'held';
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
    { at: authoritativeTimeValue(command.time), transactionId: command.transactionId },
  );
  if (!changed) throw new Error('zone_account_erasure_source_changed');
  return 'minimized';
}
