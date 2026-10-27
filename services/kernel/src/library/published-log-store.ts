import type { PoolClient } from 'pg';
import type { ProgressState } from './progress.ts';
import deleteLog from './published-log-delete.sql';
import insertLog from './published-log-insert.sql';
import pageLogs from './published-log-page.sql';
import readLog from './published-log-read.sql';

type Client = Pick<PoolClient, 'query'>;
type LogResult = Omit<NonNullable<Awaited<ReturnType<typeof readLog.run>>>, 'sessionState'> & {
  sessionState: string;
};

const STATES = new Set<ProgressState>(['active', 'completed', 'abandoned']);
const MAX_NOTE_LENGTH = 1000;
const MAX_PAGE_LIMIT = 101;

/** One published snapshot, with a nullable source pointer for retained snapshots after source erasure. */
export type PublishedLogRecord = {
  id: string;
  accountId: string;
  sessionId: string | null;
  subjectId: string;
  sessionState: ProgressState;
  startedAt: string;
  completedAt: string | null;
  note: string | null;
  publishedAt: string;
  transactionId: string;
};

/** New publications always copy a source session, even though retained snapshots may be detached later. */
export type PublishedLogDraft = Omit<PublishedLogRecord, 'sessionId'> & { sessionId: string };

export type PublishedLogPage = {
  after: { publishedAt: string; logId: string } | null;
  limit: number;
};

function queryClient(client: Client): Client {
  return { query: client.query.bind(client) };
}

function iso(value: string): string {
  return new Date(value).toISOString();
}

function asState(value: string): ProgressState {
  if (STATES.has(value as ProgressState)) return value as ProgressState;
  throw new Error(`Unknown published log state: ${value}`);
}

function asRecord(row: LogResult): PublishedLogRecord {
  const { route: _route, ...log } = row;
  return {
    ...log,
    sessionState: asState(log.sessionState),
    startedAt: iso(log.startedAt),
    completedAt: log.completedAt === null ? null : iso(log.completedAt),
    publishedAt: iso(log.publishedAt),
  };
}

function assertState(state: string): void {
  if (!STATES.has(state as ProgressState)) throw new TypeError('Unknown published log state');
}

function assertNote(note: string | null): void {
  if (note !== null && note.length > MAX_NOTE_LENGTH)
    throw new RangeError('A published log note is at most 1000 characters');
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new RangeError('Page limit must be an integer from 1 through 101');
  }
}

export async function insertPublishedLog(
  client: Client,
  route: number,
  log: PublishedLogDraft,
): Promise<PublishedLogRecord> {
  if (typeof log.sessionId !== 'string' || log.sessionId.length === 0)
    throw new TypeError('A published log requires a source session');
  assertState(log.sessionState);
  assertNote(log.note);
  const row = await insertLog.run(queryClient(client), {
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
  });
  return asRecord(row);
}

export async function readPublishedLog(
  client: Client,
  route: number,
  logId: string,
): Promise<PublishedLogRecord | null> {
  const row = await readLog.run(queryClient(client), { route, log_id: logId });
  return row ? asRecord(row) : null;
}

export async function deletePublishedLog(
  client: Client,
  route: number,
  accountId: string,
  logId: string,
): Promise<PublishedLogRecord | null> {
  const row = await deleteLog.run(queryClient(client), { route, account_id: accountId, log_id: logId });
  return row ? asRecord(row) : null;
}

export async function pagePublishedLogs(
  client: Client,
  route: number,
  accountId: string,
  page: PublishedLogPage,
): Promise<PublishedLogRecord[]> {
  assertLimit(page.limit);
  const rows = await pageLogs.run(queryClient(client), {
    route,
    account_id: accountId,
    after_published_at: page.after?.publishedAt ?? '1970-01-01T00:00:00.000Z',
    after_log_id: page.after?.logId ?? '00000000-0000-0000-0000-000000000000',
    has_cursor: page.after !== null,
    limit: page.limit,
  });
  return rows.map((row) => asRecord(row));
}
