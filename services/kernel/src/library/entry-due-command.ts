import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  CommandUnavailableError,
  noEffect,
  normalizeCommandKey,
  runCommand,
  type CommandAuthorization,
  type CommandOutcome,
} from '../command/command.ts';
import { partitionOf } from '../route/route.ts';
import { requireRoute, workStepDeadline } from './command-support.ts';
import { purgeDueEntryDeletion, type DueEntryDeletionKey } from './entry-due-store.ts';
import eligibility from './entry-due-eligibility.sql';

export class EntryPurgeNotDueError extends Error {
  constructor() {
    super('The original entry deletion deadline has not elapsed');
    this.name = 'EntryPurgeNotDueError';
  }
}

export class EntryPurgeStaleError extends Error {
  constructor() {
    super('The addressed entry deletion has a different original deadline');
    this.name = 'EntryPurgeStaleError';
  }
}

/** Internal ordinary archive maintenance. A locator supplies identity, never authority. */
export async function purgeExpiredEntryDeletion(
  { pool, clock, deadline = workStepDeadline() }: { pool: Pool; clock?: KernelClock; deadline?: number },
  key: DueEntryDeletionKey,
): Promise<CommandOutcome<{ purged: boolean }>> {
  const { route, accountId, deletionId, restoreUntil } = key;
  if (requireRoute(accountId) !== route) throw new TypeError('Account does not carry the deletion route');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deletionId))
    throw new TypeError('Invalid deletion id');
  // Validate syntax without replacing the original microsecond-bearing native string.
  if (
    typeof restoreUntil !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/.test(restoreUntil) ||
    restoreUntil.startsWith('0000-') ||
    !Number.isFinite(Date.parse(restoreUntil))
  )
    throw new TypeError('Invalid original deletion deadline');
  const exact = Object.freeze({ route, accountId, deletionId, restoreUntil });
  const partition = partitionOf(route);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new CommandUnavailableError('deadline', partition);
  const kind = 'library.entry.retention.purge';
  let present = false;
  const authorization: CommandAuthorization = {
    action: 'library:entry-retention-maintenance',
    resource: Object.freeze({ route, id: accountId }),
    denied: () => new EntryPurgeStaleError(),
    async authorize(tx, attempt) {
      const state = await eligibility.run(tx, {
        route,
        account_id: accountId,
        deletion_id: deletionId,
        expected_original_deadline: restoreUntil,
        time: authoritativeTimeValue(attempt.time),
      });
      if (!state) throw new TypeError('Missing native entry purge eligibility');
      if (!state.due) throw new EntryPurgeNotDueError();
      if (state.present && !state.matches) throw new EntryPurgeStaleError();
      present = state.present;
      return 'execute';
    },
  };
  return runCommand<{ purged: boolean }>(
    pool,
    {
      partition,
      deadline,
      clock,
      authorization,
      receipt: {
        actorAccountId: accountId,
        kind,
        key: normalizeCommandKey({ kind: 'account', id: accountId }, deletionId),
        digest: createHash('sha256')
          .update(JSON.stringify([kind, route, accountId, deletionId, restoreUntil]))
          .digest(),
      },
    },
    async (tx, command) => {
      // Authorization holds the addressed archive lock through this exact native CAS.
      const purged = await purgeDueEntryDeletion(tx, exact, { time: authoritativeTimeValue(command.time) });
      if (!purged && present) throw new Error('Locked due entry deletion failed its exact native CAS');
      if (!purged) return noEffect({ purged: false });
      return {
        value: { purged: true },
        events: [{ type: 'com.rezics.library.entry.purged.v1', subject: accountId, data: { deletionId } }],
      };
    },
  );
}
