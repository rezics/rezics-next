import type { Json } from 'reylo';
import type { ZoneGrantCleanupCursor } from '../access/zone-grant-cleanup.ts';
import type { CommandTransaction } from '../command/command.ts';
import { jsonParameter } from '../database/json.ts';
import { admitZoneCleanup, advanceZoneCleanupGrants } from '../semantic/deletion/index.ts';
import { liveCoverage, retainCoveredPayload } from './cleanup-intent.ts';
import { compareAndSetZone, lockZoneHead, type ZoneHead } from './resource-head.ts';

/** Non-pointer withholding key. Live takedown filters never match it. */
export const ACCOUNT_ERASURE_GRANTS = 'grants';
const GRANT_PAGES = 32;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Independent read of durable Access grant-page progress on the Zone head. */
export function accountErasureGrantProgress(row: ZoneHead): ZoneGrantCleanupCursor | null {
  const stored = record(row.withholding) ? row.withholding[ACCOUNT_ERASURE_GRANTS] : undefined;
  if (!record(stored) || (stored.store !== 'resource_grant' && stored.store !== 'resource_role_grant')) return null;
  if (!text(stored.afterKey) || !record(stored.scope)) return null;
  const scope = stored.scope;
  if (
    (scope.kind !== 'zone-disposition' && scope.kind !== 'terminal-account-subject') ||
    (scope.branch !== 'ordinary-expiry' &&
      scope.branch !== 'early-privacy' &&
      scope.branch !== 'legal-order' &&
      scope.branch !== 'terminal-account') ||
    !record(scope.zone) ||
    typeof scope.zone.route !== 'number' ||
    !text(scope.zone.zoneId) ||
    !record(scope.zone.home) ||
    typeof scope.zone.home.partition !== 'number' ||
    !text(scope.zone.home.epoch) ||
    !text(scope.revision) ||
    !text(scope.lifecycleRevision) ||
    !text(scope.generation) ||
    !text(scope.progress) ||
    !text(scope.protectionRevision)
  )
    return null;
  const terminal = scope.terminal;
  if (scope.kind === 'terminal-account-subject') {
    if (
      !record(terminal) ||
      !text(terminal.accountId) ||
      !text(terminal.barrierVersion) ||
      !text(terminal.barrierAt) ||
      !record(terminal.primaryOwner) ||
      !text(terminal.primaryOwner.accountId) ||
      !text(terminal.primaryOwner.revision) ||
      !text(terminal.primaryOwner.lifecycleRevision) ||
      !text(terminal.primaryOwner.transactionId)
    )
      return null;
  } else if (terminal !== undefined) return null;
  return stored as ZoneGrantCleanupCursor;
}

function withGrantProgress(row: ZoneHead, cursor: ZoneGrantCleanupCursor | null): Json {
  const next = record(row.withholding) ? { ...row.withholding } : {};
  if (cursor) next[ACCOUNT_ERASURE_GRANTS] = cursor;
  else delete next[ACCOUNT_ERASURE_GRANTS];
  return jsonParameter(next);
}

async function drainGrants(
  tx: CommandTransaction,
  admission: NonNullable<Awaited<ReturnType<typeof admitZoneCleanup>>>,
  cursor: ZoneGrantCleanupCursor | null,
  limit: number,
  pages: number,
) {
  let next = cursor;
  for (let page = 0; page < pages; page += 1) {
    const grants = await advanceZoneCleanupGrants(tx, admission, next, limit);
    if (grants.disposition === 'complete') return { disposition: 'complete' as const, next: null };
    next = grants.next;
    if (next === null) return { disposition: 'complete' as const, next: null };
  }
  return { disposition: 'progress' as const, next };
}

/** Account-erasure payload effect. Holds defer; live decisions keep their originals; public active payload stays. */
export async function minimizeAccountErasureZone(
  tx: CommandTransaction,
  input: {
    route: number;
    id: string;
    accountId: string;
    at: string;
    transactionId: string;
    limit?: number;
    pages?: number;
  },
): Promise<'minimized' | 'held' | 'missing' | 'unchanged'> {
  const row = await lockZoneHead(tx, input.route, input.id);
  if (!row) return 'missing';
  if (row.held) return 'held';
  const limit = input.limit ?? 100;
  const pages = input.pages ?? GRANT_PAGES;
  const resume = accountErasureGrantProgress(row);
  const admission = await admitZoneCleanup(tx, row, {
    at: input.at,
    accountId: input.accountId,
    primaryOwner: {
      accountId: row.ownerId ?? input.accountId,
      revision: row.revision,
      lifecycleRevision: row.lifecycleRevision,
      transactionId: row.transactionId,
    },
    ...(resume ? { resume } : {}),
  });
  if (admission) {
    const grants = await drainGrants(tx, admission, resume, limit, pages);
    if (grants.disposition === 'progress') {
      const changed = await compareAndSetZone(
        tx,
        row,
        {
          ...row,
          writeFenced: true,
          withholding: withGrantProgress(row, grants.next),
        },
        { at: input.at, transactionId: input.transactionId },
      );
      if (!changed) throw new Error('zone_account_erasure_source_changed');
      return 'held';
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
  const withholding = withGrantProgress(row, null);
  if (
    row.writeFenced &&
    row.ownerId === ownerId &&
    row.state === state &&
    row.deletedAt === null &&
    row.restoreUntil === null &&
    JSON.stringify(row.withholding) === JSON.stringify(withholding)
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
      withholding,
    },
    { at: input.at, transactionId: input.transactionId },
  );
  if (!changed) throw new Error('zone_account_erasure_source_changed');
  return 'minimized';
}
