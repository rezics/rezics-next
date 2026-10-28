import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import type { KernelClock } from '../clock.ts';
import {
  normalizeCommandKey,
  runCommand,
  type CommandAuthorization,
  type CommandEvent,
  type CommandOutcome,
} from '../command/command.ts';
import { partitionOf } from '../route/route.ts';
import { requireRoute, workStepDeadline } from './command-support.ts';
import purgeCopy from './account-fact-purge-copy.sql';
import purgeEntry from './account-fact-purge-entry.sql';
import purgeFollow from './account-fact-purge-follow.sql';

type FactKind = 'entry' | 'copy' | 'follow';
type Cursor = { id: string; createdAt?: string };
type Page = { examined: number; removed: number; after: Cursor | null; exhausted: boolean };
type Input = { accountId: string; kind: FactKind; after: Cursor | null; limit: number; stepKey: string };

export class AccountFactPurgeDeniedError extends Error {
  constructor() {
    super('Account fact purge requires an existing deleted and fenced account');
    this.name = 'AccountFactPurgeDeniedError';
  }
}

function cursorFor(kind: FactKind, after: Cursor | null): Cursor | null {
  if (after === null) return null;
  if (typeof after !== 'object' || Array.isArray(after)) throw new TypeError('Invalid account fact cursor');
  requireRoute(after.id);
  const keys = Object.keys(after).sort().join(',');
  if (kind !== 'copy') {
    if (keys !== 'id') throw new TypeError('Entry and follow cursors contain only id');
    return { id: after.id };
  }
  // Internal UTC cursor, preserving PostgreSQL microseconds instead of rounding through Date.
  const timestamp = after.createdAt;
  if (
    keys !== 'createdAt,id' ||
    typeof timestamp !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(timestamp) ||
    timestamp.startsWith('0000-') ||
    !Number.isFinite(Date.parse(timestamp)) ||
    new Date(timestamp).toISOString().slice(0, 19) !== timestamp.slice(0, 19)
  )
    throw new TypeError('Copy cursor requires a valid UTC createdAt timestamp');
  return { id: after.id, createdAt: timestamp };
}

/** One native terminal-owner source page, not completion of account erasure.
 * The terminal Access barrier has drained normal writers; this guard is not an Access grant.
 * Delivery custody and minimization of receipts/outbox identifiers belong to future orchestration.
 */
export async function purgeAccountFactsPage(
  { pool, clock }: { pool: Pool; clock?: KernelClock },
  input: Input,
): Promise<CommandOutcome<Page>> {
  const { accountId, kind, limit, stepKey } = input;
  const route = requireRoute(accountId);
  if (kind !== 'entry' && kind !== 'copy' && kind !== 'follow') throw new TypeError('Invalid account fact kind');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Page limit must be an integer from 1 through 100');
  const after = cursorFor(kind, input.after);
  const key = normalizeCommandKey({ kind: 'account', id: accountId }, stepKey);
  const receiptKind = 'library.account-facts.purge';
  const authorization: CommandAuthorization = {
    action: 'library:account-command',
    resource: Object.freeze({ route, id: accountId }),
    denied: () => new AccountFactPurgeDeniedError(),
    async authorize(tx) {
      const account = await readAccount(tx, route, accountId);
      if (!account || account.state !== 'deleted' || !account.fenced) throw new AccountFactPurgeDeniedError();
      return 'execute';
    },
  };
  return runCommand(
    pool,
    {
      partition: partitionOf(route),
      deadline: workStepDeadline(),
      clock,
      authorization,
      // Only an internal receipt namespace: no request actor or write basis.
      receipt: {
        actorAccountId: accountId,
        kind: receiptKind,
        key,
        digest: createHash('sha256')
          .update(JSON.stringify([receiptKind, accountId, kind, after, limit]))
          .digest(),
      },
    },
    async (tx) => {
      const args = { route, account_id: accountId, after_id: after?.id ?? null, limit };
      const rows =
        kind === 'copy'
          ? await purgeCopy.run(tx, { ...args, after_created_at: after?.createdAt ?? null })
          : kind === 'entry'
            ? await purgeEntry.run(tx, args)
            : await purgeFollow.run(tx, args);
      const events: CommandEvent[] = [];
      let lastExamined: Cursor | null = null;
      for (const row of rows) {
        if (typeof row.id !== 'string') throw new TypeError('Missing native account fact key');
        lastExamined = { id: row.id };
        if (kind === 'copy') {
          if (!('createdAt' in row) || typeof row.createdAt !== 'string')
            throw new TypeError('Missing native copy timestamp');
          lastExamined.createdAt = row.createdAt;
        }
        if (!row.removed) continue;
        events.push({
          type: `com.rezics.library.${kind === 'follow' ? 'follow.updated' : `${kind}.deleted`}.v1`,
          subject: accountId,
          data: kind === 'copy' ? { copyId: row.id } : kind === 'entry' ? { subjectId: row.id } : { targetId: row.id },
        });
      }
      const value: Page = {
        examined: rows.length,
        removed: events.length,
        after: lastExamined,
        exhausted: rows.length < limit,
      };
      events.push({
        type: 'com.rezics.library.account-facts.purged.v1',
        subject: accountId,
        data: { accountId, kind, examined: value.examined, removed: value.removed },
      });
      return { value, events };
    },
  );
}
