import type { PoolClient } from 'pg';
import type { ProgressState } from './progress.ts';
import deleteLog from './published-log-delete.sql';
import insertLog from './published-log-insert.sql';
import pageLogs from './published-log-page.sql';
import readLog from './published-log-read.sql';
import lockLog from './published-log-lock.sql';
import restoreLog from './published-log-restore.sql';

type Client = Pick<PoolClient, 'query'>;
export type PublishedLogRecord = NonNullable<Awaited<ReturnType<typeof readLog.run>>>;
export type PublishedLogDraft = {
  id: string;
  accountId: string;
  sessionId: string;
  subjectId: string;
  sessionState: ProgressState;
  startedAt: string;
  completedAt: string | null;
  note: string | null;
  publishedAt: string;
  transactionId: string;
};
export type PublishedLogPage = { after: { publishedAt: string; logId: string } | null; limit: number };
type Context = { transactionId: string; time: string };
type Episode = { route: number; accountId: string; logId: string; revision: number; deletionId: string };

function queryClient(client: Client): Client {
  return { query: client.query.bind(client) };
}
function iso(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
function normalize<T extends { startedAt: string | null; completedAt: string | null; publishedAt: string | null }>(
  row: T,
): T {
  return {
    ...row,
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    publishedAt: iso(row.publishedAt),
  } as T;
}
export async function insertPublishedLog(
  client: Client,
  route: number,
  log: PublishedLogDraft,
): Promise<PublishedLogRecord> {
  if (typeof log.sessionId !== 'string' || log.sessionId.length === 0)
    throw new TypeError('A published log requires a source session');
  if (!['active', 'completed', 'abandoned'].includes(log.sessionState))
    throw new TypeError('Unknown published log state');
  if (log.note !== null && log.note.length > 1000)
    throw new RangeError('A published log note is at most 1000 characters');
  return normalize(
    await insertLog.run(queryClient(client), {
      route,
      log_id: log.id,
      account_id: log.accountId,
      session_id: log.sessionId,
      subject_id: log.subjectId,
      session_state: log.sessionState,
      started_at: log.startedAt,
      completed_at: log.completedAt,
      note: log.note,
      published_at: log.publishedAt,
      transaction_id: log.transactionId,
    }),
  );
}
export async function readPublishedLog(
  client: Client,
  route: number,
  logId: string,
): Promise<PublishedLogRecord | null> {
  const row = await readLog.run(queryClient(client), { route, log_id: logId });
  return row ? normalize(row) : null;
}
export async function lockPublishedLog(client: Client, route: number, accountId: string, logId: string, time: string) {
  const row = await lockLog.run(queryClient(client), { route, account_id: accountId, log_id: logId, time });
  return row ? normalize(row) : null;
}
export async function deletePublishedLog(client: Client, key: Episode, context: Context): Promise<boolean> {
  const row = await deleteLog.run(queryClient(client), {
    route: key.route,
    account_id: key.accountId,
    log_id: key.logId,
    revision: key.revision,
    deletion_id: key.deletionId,
    time: context.time,
    transaction_id: context.transactionId,
  });
  return row !== null;
}
export async function restorePublishedLog(client: Client, key: Episode, context: Context): Promise<boolean> {
  const row = await restoreLog.run(queryClient(client), {
    route: key.route,
    account_id: key.accountId,
    log_id: key.logId,
    revision: key.revision,
    deletion_id: key.deletionId,
    time: context.time,
    transaction_id: context.transactionId,
  });
  return row !== null;
}
export async function pagePublishedLogs(client: Client, route: number, accountId: string, page: PublishedLogPage) {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 101)
    throw new RangeError('Page limit must be an integer from 1 through 101');
  const rows = await pageLogs.run(queryClient(client), {
    route,
    account_id: accountId,
    after_published_at: page.after?.publishedAt ?? '1970-01-01T00:00:00.000Z',
    after_log_id: page.after?.logId ?? '00000000-0000-0000-0000-000000000000',
    has_cursor: page.after !== null,
    limit: page.limit,
  });
  return rows.map((row) => normalize(row) as PublishedLogRecord);
}
