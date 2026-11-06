import { enrollResourceRecordSources } from '../semantic/record-purge-custody.ts';
import type { Pool } from 'pg';
import { authoritativeTimeValue, noEffect, runCommand, type LegacyCommandOptions } from '../command/command.ts';
import { partitionOf } from '../route/route.ts';
import { liveCoverage, purgeIntent, withPurgeIntent } from './cleanup-intent.ts';
import { compareAndSetZone, lockZoneHead, type ZoneHead } from './resource-store.ts';

export type ZonePurgePageInput = Readonly<{
  pool: Pool;
  clock: () => Date;
  route: number;
  zoneId: string;
  cursor: string | null;
  limit: number;
}>;

function covered(row: ZoneHead, pointer: string): boolean {
  for (const live of liveCoverage(row)) {
    if (pointer === live || pointer.startsWith(`${live}/`) || live.startsWith(`${pointer}/`)) return true;
  }
  return false;
}

function redactUncovered(row: ZoneHead): { configuration: ZoneHead['configuration']; mounts: string[] } {
  const configuration = row.configuration;
  const mounts = row.mounts ?? [];
  if (!configuration) return { configuration: null, mounts: [] };
  const labels = { ...configuration.labels };
  for (const locale of Object.keys(labels) as (keyof typeof labels)[]) {
    if (!covered(row, `/labels/${locale}`)) delete labels[locale];
  }
  const pages = configuration.pages.filter((_, index) => covered(row, `/pages/${index}/document`));
  const scope = configuration.scope.filter((_, index) => covered(row, `/scope/${index}`));
  const keptMounts = mounts.filter((_, index) => covered(row, `/mounts/${index}`));
  return {
    configuration: { ...configuration, labels, pages, scope },
    mounts: keptMounts,
  };
}

/** Bounded Zone cleanup page. Held rows, live restore and uncovered-only privacy keep remaining work explicit. */
export async function purgeZonePage(input: ZonePurgePageInput): Promise<{ next: string | null }> {
  const { pool, clock, route, zoneId, cursor, limit } = input;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Zone purge page limit is 1 through 100');
  if (cursor !== null && cursor !== 'payload') return { next: null };
  const deadline = Date.now() + 20_000;
  const options: LegacyCommandOptions = { partition: partitionOf(route), deadline, clock };
  const outcome = await runCommand(pool, options, async (tx, command) => {
    const row = await lockZoneHead(tx, route, zoneId);
    if (!row || row.state === 'purged') return noEffect({ next: null });
    if (row.held) return noEffect({ next: null });
    const at = authoritativeTimeValue(command.time);
    const intent = purgeIntent(row);
    const expired =
      row.state === 'deleted' && row.restoreUntil !== null && Date.parse(at) >= Date.parse(row.restoreUntil);
    const branch = intent?.branch ?? (expired ? 'ordinary' : null);
    if (!branch) return noEffect({ next: null });
    if (branch === 'ordinary' && liveCoverage(row).length > 0) return noEffect({ next: null });
    const next: ZoneHead = { ...row, writeFenced: true };
    if (branch === 'early_privacy' && liveCoverage(row).length > 0) {
      const kept = redactUncovered(row);
      next.configuration = kept.configuration;
      next.mounts = kept.mounts;
      next.state = row.state === 'active' ? 'active' : 'purge_pending';
      next.withholding = withPurgeIntent(row, null);
    } else if (row.publicEver) {
      next.state = 'purged';
      next.configuration = null;
      next.mounts = [];
      next.ownerId = null;
      next.withholding = withPurgeIntent({ ...row, withholding: {} }, null);
    } else {
      await enrollResourceRecordSources(tx, [{ kind: 'zone', zoneId }], { kind: 'zone.purge', events: 1 });
      await tx.query('DELETE FROM zones.zone WHERE route=$1 AND zone_id=$2', [route, zoneId]);
      return {
        value: { next: null },
        events: [{ type: 'com.rezics.zone.purged.v1', subject: zoneId, data: { id: zoneId, revision: row.revision } }],
      };
    }
    await enrollResourceRecordSources(tx, [{ kind: 'zone', zoneId }], { kind: 'zone.purge' });
    const updated = await compareAndSetZone(tx, row, next, { at, transactionId: command.transactionId });
    if (!updated) throw new Error('zone_cleanup_source_changed');
    return {
      value: { next: null },
      events: [
        {
          type: 'com.rezics.zone.purged.v1',
          subject: zoneId,
          data: { id: zoneId, revision: updated.revision },
        },
      ],
    };
  });
  return outcome.value;
}
