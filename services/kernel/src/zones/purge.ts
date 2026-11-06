import { enrollResourceRecordSources } from '../semantic/record-purge-custody.ts';
import { admitZoneCleanup, advanceZoneCleanupGrants } from '../semantic/deletion/index.ts';
import type { Pool } from 'pg';
import { authoritativeTimeValue, noEffect, runCommand } from '../command/command.ts';
import { partitionOf } from '../route/route.ts';
import { liveCoverage, purgeIntent, retainCoveredPayload, withPurgeIntent } from './cleanup-intent.ts';
import { compareAndSetZone, lockZoneHead, type ZoneHead } from './resource-store.ts';

export type ZonePurgePageInput = Readonly<{
  pool: Pool;
  clock: () => Date;
  route: number;
  zoneId: string;
  cursor: string | null;
  limit: number;
}>;

const GRANT_PAGES = 32;

/** Drain Access grant stores in this command. The resource store always yields progress into the role store, so
 * a single page never means grant work is finished. Remaining keys shrink across invocations because deletes commit. */
async function drainZoneGrants(
  tx: Parameters<typeof admitZoneCleanup>[0],
  row: ZoneHead,
  at: string,
  limit: number,
): Promise<'complete' | 'progress'> {
  const admission = await admitZoneCleanup(tx, row, { at });
  if (!admission) return 'complete';
  let grantCursor: Awaited<ReturnType<typeof advanceZoneCleanupGrants>>['next'] = null;
  for (let page = 0; page < GRANT_PAGES; page += 1) {
    const grants = await advanceZoneCleanupGrants(tx, admission, grantCursor, Math.min(limit, 100));
    if (grants.disposition === 'complete') return 'complete';
    grantCursor = grants.next;
    if (grantCursor === null) return 'complete';
  }
  return 'progress';
}

/** Bounded Zone cleanup page. Held rows, live restore and uncovered-only privacy keep remaining work explicit. */
export async function purgeZonePage(input: ZonePurgePageInput): Promise<{ next: string | null }> {
  const { pool, clock, route, zoneId, cursor, limit } = input;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Zone purge page limit is 1 through 100');
  if (cursor !== null && cursor !== 'payload' && cursor !== 'grants') return { next: null };
  const deadline = Date.now() + 20_000;
  const outcome = await runCommand<{ next: string | null }>(
    pool,
    {
      partition: partitionOf(route),
      deadline,
      clock,
      principal: { kind: 'account' as const, id: '00000000-0000-8000-8000-000000000001' },
      basis: { clientId: 'internal-zone-purge', requestedBy: null },
    },
    async (tx, command) => {
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
      if (cursor !== 'payload') {
        const grants = await drainZoneGrants(tx, row, at, limit);
        if (grants === 'progress') return noEffect({ next: 'grants' });
      }
      const next: ZoneHead = { ...row, writeFenced: true };
      if (branch === 'early_privacy' && liveCoverage(row).length > 0) {
        const kept = retainCoveredPayload(row);
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
    },
  );
  return outcome.value;
}
