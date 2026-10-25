import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { authoritativeTimeValue, type CommandOutcome } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access, Actor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, requireRoute, sameAccountRoute } from './command-support.ts';
import type { ProgressState } from './progress.ts';
import { readSession } from './progress-store.ts';
import {
  deletePublishedLog,
  insertPublishedLog,
  pagePublishedLogs,
  readPublishedLog as readStoredLog,
  type PublishedLogRecord,
} from './published-log-store.ts';

const UPDATED = 'com.rezics.library.published_log.updated.v1';
const DELETED = 'com.rezics.library.published_log.deleted.v1';
const LIST = 'published_log.list';
const MAX_NOTE_LENGTH = 1000;

type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; clock?: KernelClock };
type Page = { accountId: string; cursor?: string | undefined; limit?: number | undefined };

/** Public snapshot of one progress session. Later session edits do not change it. */
export type PublishedLog = {
  id: string;
  accountId: string;
  subjectId: string;
  sessionState: ProgressState;
  startedAt: string;
  completedAt: string | null;
  note: string | null;
  publishedAt: string;
};

export type PublishedLogPageResult = { publishedLogs: PublishedLog[]; next: string | null };

function view(row: PublishedLogRecord): PublishedLog {
  return {
    id: row.id,
    accountId: row.accountId,
    subjectId: row.subjectId,
    sessionState: row.sessionState,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    note: row.note,
    publishedAt: row.publishedAt,
  };
}

function publishedNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null;
  if (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH) throw new ProblemError('invalid_request');
  return note;
}

function event(type: typeof UPDATED | typeof DELETED, accountId: string, logId: string) {
  return { type, subject: accountId, data: { logId } };
}

/**
 * Publish and retract one account's session snapshots. Reads are public, including for anonymous
 * viewers, and stay in the owner's partition. Nothing is written on the subject's partition.
 */
export function createPublishedLogCommands(config: Dependencies) {
  const { pool, access: _access, tokens, clock } = config;
  const runner = createLibraryCommandRunner({ pool, ...(clock === undefined ? {} : { clock }) });

  async function publishLog(
    actor: Actor,
    input: { sessionId: string; note?: string | null },
    requestKey: string,
  ): Promise<CommandOutcome<PublishedLog>> {
    if (actor.kind !== 'account') throw new GrantDeniedError();
    const accountId = actor.accountId;
    const note = publishedNote(input.note);
    const sessionId = input.sessionId;
    return runner.ownAccount(
      actor,
      { action: 'published_log:create', kind: 'published_log.create', requestKey, input: { sessionId, note } },
      async (tx, command) => {
        const ownerRoute = sameAccountRoute(accountId, sessionId);
        const session = await readSession(tx, ownerRoute, sessionId);
        if (!session || session.accountId !== accountId) throw new LibraryNotFoundError();
        const row = await insertPublishedLog(tx, ownerRoute, {
          id: newId(ownerRoute),
          accountId,
          sessionId: session.id,
          subjectId: session.subjectId,
          sessionState: session.state,
          startedAt: session.startedAt,
          completedAt: session.completedAt,
          note,
          publishedAt: authoritativeTimeValue(command.time),
          transactionId: command.transactionId,
        });
        return { value: view(row), events: [event(UPDATED, accountId, row.id)] };
      },
    );
  }

  async function retractLog(actor: Actor, logId: string, requestKey: string): Promise<CommandOutcome<PublishedLog>> {
    if (actor.kind !== 'account') throw new GrantDeniedError();
    const accountId = actor.accountId;
    return runner.ownAccount(
      actor,
      { action: 'published_log:delete', kind: 'published_log.delete', requestKey, input: { logId } },
      async (tx) => {
        const ownerRoute = sameAccountRoute(accountId, logId);
        const row = await deletePublishedLog(tx, ownerRoute, accountId, logId);
        if (!row || row.accountId !== accountId) throw new LibraryNotFoundError();
        return { value: view(row), events: [event(DELETED, accountId, row.id)] };
      },
    );
  }

  async function readOne(_viewer: Actor, logId: string): Promise<PublishedLog> {
    const route = requireRoute(logId);
    return withConnection(pool, async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const row = await readStoredLog(client, route, logId);
        if (!row) throw new LibraryNotFoundError();
        await client.query('COMMIT');
        return view(row);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async function list(_viewer: Actor, page: Page): Promise<PublishedLogPageResult> {
    const route = requireRoute(page.accountId);
    const size = page.limit ?? 20;
    if (!Number.isInteger(size) || size < 1 || size > 100) throw new ProblemError('invalid_request');
    const binding: CursorBinding = { operation: LIST, parameters: { accountId: page.accountId } };
    return withConnection(pool, async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const partition = await readPartition(client, partitionOf(route));
        let after: { publishedAt: string; logId: string } | null = null;
        if (page.cursor !== undefined) {
          const cursor = decodeCursor(tokens, binding, page.cursor);
          const publishedAt = cursor.ok ? cursor.after[0] : undefined;
          const logId = cursor.ok ? cursor.after[1] : undefined;
          if (
            !cursor.ok ||
            cursor.after.length !== 2 ||
            typeof publishedAt !== 'string' ||
            !Number.isFinite(Date.parse(publishedAt)) ||
            typeof logId !== 'string' ||
            routeOf(logId) !== route
          ) {
            throw new ProblemError('invalid_cursor');
          }
          if (cursor.epoch !== partition?.epoch) throw new ProblemError('stale_cursor');
          after = { publishedAt, logId };
        }
        const rows = await pagePublishedLogs(client, route, page.accountId, { after, limit: size + 1 });
        const shown = rows.slice(0, size);
        const last = shown.at(-1);
        const next =
          rows.length > size && last !== undefined && partition
            ? encodeCursor(tokens, binding, { epoch: partition.epoch, after: [last.publishedAt, last.id] })
            : null;
        await client.query('COMMIT');
        return { publishedLogs: shown.map(view), next };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  return { publishLog, retractLog, readPublishedLog: readOne, listPublishedLogs: list };
}
