import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { authoritativeTimeValue, type CommandOutcome, type AuthoritativeTime } from '../command/command.ts';
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
import { resolveSubject } from './subject-anchor.ts';
import {
  deletePublishedLog,
  insertPublishedLog,
  lockPublishedLog,
  pagePublishedLogs,
  readPublishedLog as readStoredLog,
  restorePublishedLog,
  type PublishedLogRecord,
} from './published-log-store.ts';

const UPDATED = 'com.rezics.library.published_log.updated.v1';
const DELETED = 'com.rezics.library.published_log.deleted.v1';
const LIST = 'published_log.list';
type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; clock?: KernelClock };
type Page = { accountId: string; cursor?: string | undefined; limit?: number | undefined };
/** Explicit public snapshot. No private session values are read by Undo. */
export type PublishedLog = {
  id: string;
  accountId: string;
  subjectId: string;
  sessionState: Exclude<ProgressState, 'retired'>;
  startedAt: string;
  completedAt: string | null;
  note: string | null;
  publishedAt: string;
};
export type PublishedLogTombstone = { id: string; deleted: true };
export type PublishedLogPageResult = { publishedLogs: PublishedLog[]; next: string | null };
type Receipt = { publishedLog: PublishedLog; revision: number; deletionId?: string };
export type PublishedLogOutcome = CommandOutcome<PublishedLog> & { revision?: number; deletionId?: string };
function outcome(result: CommandOutcome<Receipt | PublishedLog>): PublishedLogOutcome {
  // Old authorized receipts retain their exact body, without invented CAS or deletion metadata.
  if (!('publishedLog' in result.value)) return { ...result, value: result.value };
  return {
    ...result,
    value: result.value.publishedLog,
    revision: result.value.revision,
    ...(result.value.deletionId === undefined ? {} : { deletionId: result.value.deletionId }),
  };
}
function view(
  row: Pick<
    PublishedLogRecord,
    'id' | 'accountId' | 'subjectId' | 'sessionState' | 'startedAt' | 'completedAt' | 'note' | 'publishedAt'
  >,
): PublishedLog {
  if (
    !row.accountId ||
    !row.subjectId ||
    !row.startedAt ||
    !row.publishedAt ||
    !['active', 'completed', 'abandoned'].includes(row.sessionState ?? '')
  )
    throw new LibraryNotFoundError();
  return {
    id: row.id,
    accountId: row.accountId,
    subjectId: row.subjectId,
    sessionState: row.sessionState as Exclude<ProgressState, 'retired'>,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    note: row.note,
    publishedAt: row.publishedAt,
  };
}
function expectedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 2147483646)
    throw new ProblemError('invalid_request');
  return value;
}
function event(type: typeof UPDATED | typeof DELETED, accountId: string, logId: string) {
  return { type, subject: accountId, data: { logId } };
}
function stale(): never {
  throw new ProblemError('published_log_restore_stale');
}

export function createPublishedLogCommands(config: Dependencies) {
  const { pool, access, tokens, clock } = config;
  const runner = createLibraryCommandRunner({ pool, ...(clock === undefined ? {} : { clock }) });
  async function source(actor: Actor, subjectId: string, at?: AuthoritativeTime) {
    if (!(await resolveSubject({ pool, access }, actor, subjectId, at))) throw new LibraryNotFoundError();
  }
  async function prepareLog(actor: Actor, logId: string, at: AuthoritativeTime) {
    if (actor.kind !== 'account') throw new GrantDeniedError();
    const route = sameAccountRoute(actor.accountId, logId);
    const row = await withConnection(pool, (client) => readStoredLog(client, route, logId));
    if (!row) throw new LibraryNotFoundError();
    if (!row.accountId && row.deleted) throw new ProblemError('published_log_restore_expired');
    if (row.accountId !== actor.accountId) throw new LibraryNotFoundError();
    if (row.subjectId) await source(actor, row.subjectId, at);
    return row;
  }
  async function publishLog(
    actor: Actor,
    input: { sessionId: string; note?: string | null },
    requestKey: string,
  ): Promise<PublishedLogOutcome> {
    if (actor.kind !== 'account') throw new GrantDeniedError();
    const accountId = actor.accountId;
    const note = input.note ?? null;
    if (
      typeof input !== 'object' ||
      Object.keys(input).some((k) => k !== 'sessionId' && k !== 'note') ||
      (note !== null && (typeof note !== 'string' || note.length > 1000))
    )
      throw new ProblemError('invalid_request');
    const sessionId = input.sessionId;
    return outcome(
      await runner.ownAccountPrepared<
        { session: NonNullable<Awaited<ReturnType<typeof readSession>>> } | { error: unknown },
        Receipt | PublishedLog
      >(
        actor,
        {
          action: 'published_log:create',
          kind: 'published_log.create',
          requestKey,
          input: { sessionId, note },
          async prepare(attempt) {
            try {
              const route = sameAccountRoute(accountId, sessionId);
              const session = await withConnection(pool, (c) => readSession(c, route, sessionId));
              if (!session || session.accountId !== accountId) throw new LibraryNotFoundError();
              await source(actor, session.subjectId, attempt.time);
              return { session };
            } catch (error) {
              return { error };
            }
          },
        },
        async (tx, command, prepared) => {
          if ('error' in prepared) throw prepared.error;
          const ownerRoute = sameAccountRoute(accountId, sessionId);
          const session = await readSession(tx, ownerRoute, sessionId);
          if (!session || session.accountId !== accountId) throw new LibraryNotFoundError();
          if (canonicalize(session) !== canonicalize(prepared.session)) stale();
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
          return {
            value: { publishedLog: view(row), revision: row.revision },
            events: [event(UPDATED, accountId, row.id)],
          };
        },
      ),
    );
  }
  async function retractLog(
    actor: Actor,
    logId: string,
    requestKey: string,
    revision?: number,
  ): Promise<PublishedLogOutcome> {
    if (actor.kind !== 'account') throw new GrantDeniedError();
    const accountId = actor.accountId;
    if (revision !== undefined) expectedRevision(revision);
    return outcome(
      await runner.ownAccount<Receipt | PublishedLog>(
        actor,
        {
          action: 'published_log:delete',
          kind: 'published_log.delete',
          requestKey,
          // Preserve pre-CAS receipt identity so exact old authorized acknowledgements remain replayable.
          input: revision === undefined ? { logId } : { logId, revision },
        },
        async (tx, command) => {
          const route = sameAccountRoute(accountId, logId);
          const row = await lockPublishedLog(tx, route, accountId, logId, authoritativeTimeValue(command.time));
          if (!row) throw new LibraryNotFoundError();
          if (revision === undefined || row.deleted || row.revision !== revision || revision > 2147483644) stale();
          const removed = await deletePublishedLog(
            tx,
            { route, accountId, logId, revision, deletionId: command.transactionId },
            { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
          );
          if (!removed) stale();
          return {
            value: { publishedLog: view(row), revision: row.revision + 1, deletionId: command.transactionId },
            events: [event(DELETED, accountId, row.id)],
          };
        },
      ),
    );
  }
  async function restoreLog(
    actor: Actor,
    logId: string,
    input: unknown,
    requestKey: string,
  ): Promise<PublishedLogOutcome> {
    if (actor.kind !== 'account') throw new GrantDeniedError();
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'deletionId,revision'
    )
      throw new ProblemError('invalid_request');
    const { deletionId, revision } = input as { deletionId: string; revision: number };
    expectedRevision(revision);
    if (
      typeof deletionId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deletionId)
    )
      throw new ProblemError('invalid_request');
    const accountId = actor.accountId;
    return outcome(
      await runner.ownAccountPrepared<{ row: PublishedLogRecord } | { error: unknown }, Receipt>(
        actor,
        {
          action: 'published_log:create',
          kind: 'published_log.restore',
          requestKey,
          input: { logId, deletionId, revision },
          async prepare(attempt) {
            try {
              return { row: await prepareLog(actor, logId, attempt.time) };
            } catch (error) {
              return { error };
            }
          },
        },
        async (tx, command, prepared) => {
          if ('error' in prepared) throw prepared.error;
          const route = sameAccountRoute(accountId, logId);
          const row = await lockPublishedLog(tx, route, accountId, logId, authoritativeTimeValue(command.time));
          if (!row) throw new LibraryNotFoundError();
          if (!row.deleted) throw new ProblemError('published_log_restore_occupied');
          if (row.revision !== revision || row.deletionId !== deletionId || row.revision !== prepared.row.revision)
            stale();
          if (row.expired) throw new ProblemError('published_log_restore_expired');
          const restored = await restorePublishedLog(
            tx,
            { route, accountId, logId, deletionId, revision },
            { transactionId: command.transactionId, time: authoritativeTimeValue(command.time) },
          );
          if (!restored) stale();
          return {
            value: { publishedLog: view(row), revision: row.revision + 1 },
            events: [event(UPDATED, accountId, logId)],
          };
        },
      ),
    );
  }
  async function readWithRevision(
    viewer: Actor,
    logId: string,
  ): Promise<{ publishedLog: PublishedLog | PublishedLogTombstone; revision?: number }> {
    const route = requireRoute(logId);
    // Release the owner checkout before native original and terminal subject checkouts.
    const result = await withConnection(pool, async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const row = await readStoredLog(client, route, logId);
        if (!row) throw new LibraryNotFoundError();
        const owner = row.accountId ? await readAccount(client, route, row.accountId) : null;
        await client.query('COMMIT');
        return { row, owner };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
    const { row, owner } = result;
    if (row.deleted || !owner || owner.state !== 'active' || owner.fenced)
      return { publishedLog: { id: logId, deleted: true } };
    const value = view(row);
    await source(viewer, value.subjectId);
    return {
      publishedLog: value,
      ...(viewer.kind === 'account' && viewer.accountId === row.accountId ? { revision: row.revision } : {}),
    };
  }
  async function readOne(viewer: Actor, logId: string) {
    return (await readWithRevision(viewer, logId)).publishedLog;
  }
  async function list(viewer: Actor, page: Page): Promise<PublishedLogPageResult> {
    const route = requireRoute(page.accountId),
      size = page.limit ?? 20;
    if (!Number.isInteger(size) || size < 1 || size > 100) throw new ProblemError('invalid_request');
    const binding: CursorBinding = { operation: LIST, parameters: { accountId: page.accountId } };
    const result = await withConnection(pool, async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const partition = await readPartition(client, partitionOf(route));
        const owner = await readAccount(client, route, page.accountId);
        let after: { publishedAt: string; logId: string } | null = null;
        if (page.cursor !== undefined) {
          const cursor = decodeCursor(tokens, binding, page.cursor);
          const publishedAt = cursor.ok ? cursor.after[0] : undefined,
            logId = cursor.ok ? cursor.after[1] : undefined;
          if (
            !cursor.ok ||
            cursor.after.length !== 2 ||
            typeof publishedAt !== 'string' ||
            !Number.isFinite(Date.parse(publishedAt)) ||
            typeof logId !== 'string' ||
            routeOf(logId) !== route
          )
            throw new ProblemError('invalid_cursor');
          if (cursor.epoch !== partition?.epoch) throw new ProblemError('stale_cursor');
          after = { publishedAt, logId };
        }
        const rows =
          owner?.state === 'active' && !owner.fenced
            ? await pagePublishedLogs(client, route, page.accountId, { after, limit: size + 1 })
            : [];
        await client.query('COMMIT');
        return { partition, rows };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
    const shown = result.rows.slice(0, size),
      publishedLogs: PublishedLog[] = [];
    for (const row of shown) {
      try {
        const value = view(row);
        await source(viewer, value.subjectId);
        publishedLogs.push(value);
      } catch (error) {
        if (!(error instanceof LibraryNotFoundError)) throw error;
      }
    }
    const last = shown.at(-1);
    return {
      publishedLogs,
      next:
        result.rows.length > size && last && result.partition
          ? encodeCursor(tokens, binding, { epoch: result.partition.epoch, after: [last.publishedAt!, last.id] })
          : null,
    };
  }
  return { publishLog, retractLog, restoreLog, readWithRevision, readPublishedLog: readOne, listPublishedLogs: list };
}
