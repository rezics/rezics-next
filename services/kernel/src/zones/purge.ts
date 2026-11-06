import { createHash, randomUUID } from 'node:crypto';
import { enrollResourceRecordSources } from '../semantic/record-purge-custody.ts';
import { admitZoneCleanup, advanceZoneCleanupGrants } from '../semantic/deletion/index.ts';
import type { Pool } from 'pg';
import { authoritativeTimeValue, noEffect, runCommand, type CommandTransaction } from '../command/command.ts';
import { declareCommandHistory } from '../history/application/index.ts';
import { bindCommandHistoryEvidence } from '../history/command-evidence.ts';
import { ACCOUNT_ROLE_BITS } from '../history/contract/index.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { liveCoverage, purgeIntent, retainCoveredPayload, withPurgeIntent } from './cleanup-intent.ts';
import { compareAndSetZone, lockZoneHead, type ZoneHead } from './resource-head.ts';

export type ZonePurgePageInput = Readonly<{
  pool: Pool;
  clock: () => Date;
  route: number;
  zoneId: string;
  cursor: string | null;
  limit: number;
}>;

const GRANT_PAGES = 32;
const INTERNAL_ZONE_PURGE_PRINCIPAL = '00000000-0000-8000-8000-000000000001';
const PURGE_KIND = 'zone.purge';

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

/** Mechanical Zone cleanup has a native episode principal, never an active Actor. Bind the owner when present. */
function bindZonePurgeHistoryEvidence(tx: CommandTransaction, ownerId: string | null): void {
  const accountId = ownerId ?? INTERNAL_ZONE_PURGE_PRINCIPAL;
  const accountRoute = routeOf(accountId);
  if (accountRoute === null) throw new TypeError('Zone purge history account has no route');
  bindCommandHistoryEvidence(tx, [
    {
      accountRoute,
      accountId,
      roles: ACCOUNT_ROLE_BITS.principal | ACCOUNT_ROLE_BITS.subject,
    },
  ]);
}

/** Receipt kind `zone.purge` is on every page, including idle ones, so COMMIT can match the declaration. */
async function declareIdlePurgeHistory(tx: CommandTransaction, ownerId: string | null): Promise<void> {
  bindZonePurgeHistoryEvidence(tx, ownerId);
  await declareCommandHistory(tx, PURGE_KIND, {
    response: { artifactType: 'command-receipt/v1', accounts: [] },
    events: [],
  });
}

/** Bounded Zone cleanup page. Held rows, live restore and uncovered-only privacy keep remaining work explicit. */
export async function purgeZonePage(input: ZonePurgePageInput): Promise<{ next: string | null }> {
  const { pool, clock, route, zoneId, cursor, limit } = input;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Zone purge page limit is 1 through 100');
  if (cursor !== null && cursor !== 'payload' && cursor !== 'grants') return { next: null };
  const deadline = Date.now() + 20_000;
  const key = randomUUID();
  const outcome = await runCommand<{ next: string | null }>(
    pool,
    {
      partition: partitionOf(route),
      deadline,
      clock,
      principal: { kind: 'account' as const, id: INTERNAL_ZONE_PURGE_PRINCIPAL },
      basis: { clientId: 'internal-zone-purge', requestedBy: null },
      receipt: {
        kind: PURGE_KIND,
        key,
        digest: Uint8Array.from(
          createHash('sha256')
            .update(`${PURGE_KIND}:${route}:${zoneId}:${cursor ?? ''}:${key}`)
            .digest(),
        ),
      },
    },
    async (tx, command) => {
      const row = await lockZoneHead(tx, route, zoneId);
      if (!row || row.state === 'purged') {
        await declareIdlePurgeHistory(tx, row?.ownerId ?? null);
        return noEffect({ next: null });
      }
      if (row.held) {
        await declareIdlePurgeHistory(tx, row.ownerId);
        return noEffect({ next: null });
      }
      const at = authoritativeTimeValue(command.time);
      const intent = purgeIntent(row);
      const expired =
        row.state === 'deleted' && row.restoreUntil !== null && Date.parse(at) >= Date.parse(row.restoreUntil);
      const branch = intent?.branch ?? (expired ? 'ordinary' : null);
      if (!branch) {
        await declareIdlePurgeHistory(tx, row.ownerId);
        return noEffect({ next: null });
      }
      if (branch === 'ordinary' && liveCoverage(row).length > 0) {
        await declareIdlePurgeHistory(tx, row.ownerId);
        return noEffect({ next: null });
      }
      if (cursor !== 'payload') {
        const grants = await drainZoneGrants(tx, row, at, limit);
        if (grants === 'progress') {
          await declareIdlePurgeHistory(tx, row.ownerId);
          return noEffect({ next: 'grants' });
        }
      }
      bindZonePurgeHistoryEvidence(tx, row.ownerId);
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
          events: [
            { type: 'com.rezics.zone.purged.v1', subject: zoneId, data: { id: zoneId, revision: row.revision } },
          ],
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
