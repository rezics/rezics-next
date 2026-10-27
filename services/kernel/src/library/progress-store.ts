import type { PoolClient } from 'pg';
import type { ProgressMode, ProgressState, ProgressUnit } from './progress.ts';
import changeAppend from './progress-store-change-append.sql';
import changePage from './progress-store-change-page.sql';
import sessionInsert from './progress-store-session-insert.sql';
import sessionPage from './progress-store-session-page.sql';
import sessionRead from './progress-store-session-read.sql';
import sessionUpdate from './progress-store-session-update.sql';
import unitAdd from './progress-store-unit-add.sql';
import unitPage from './progress-store-unit-page.sql';
import unitRemove from './progress-store-unit-remove.sql';
import {
  MAX_PROGRESS_PAGE_SIZE,
  MAX_PROGRESS_UNIT_IDS,
  type ProgressChange,
  type ProgressChangePage,
  type ProgressSession,
  type ProgressSessionDraft,
  type ProgressSessionPage,
  type ProgressSessionUpdate,
  type ProgressUnitRecord,
  type ProgressUnitPage,
} from './progress-model.ts';

type Client = Pick<PoolClient, 'query'>;
type WriteContext = { transactionId: string; time: string };
type SessionResult = Omit<NonNullable<Awaited<ReturnType<typeof sessionRead.run>>>, 'mode' | 'unit' | 'state'> & {
  mode: string;
  unit: string;
  state: string;
};
type ChangeResult = NonNullable<Awaited<ReturnType<typeof changeAppend.run>>>;
type UnitResult = Awaited<ReturnType<typeof unitPage.run>>[number];

const MODES = new Set<ProgressMode>(['scalar_amount', 'cursor_position', 'completed_units']);
const UNITS = new Set<ProgressUnit>(['page', 'chapter', 'episode', 'volume', 'minute', 'percent']);
const STATES = new Set<ProgressState>(['active', 'completed', 'abandoned']);

function queryClient(client: Client): Client {
  return { query: client.query.bind(client) };
}

function iso(value: string): string {
  return new Date(value).toISOString();
}

function asMode(value: string): ProgressMode {
  if (MODES.has(value as ProgressMode)) return value as ProgressMode;
  throw new Error(`Unknown progress mode: ${value}`);
}

function asUnit(value: string): ProgressUnit {
  if (UNITS.has(value as ProgressUnit)) return value as ProgressUnit;
  throw new Error(`Unknown progress unit: ${value}`);
}

function asState(value: string): ProgressState {
  if (STATES.has(value as ProgressState)) return value as ProgressState;
  throw new Error(`Unknown progress state: ${value}`);
}

function asSession(row: SessionResult): ProgressSession {
  const { route: _route, ...session } = row;
  return {
    ...session,
    mode: asMode(session.mode),
    unit: asUnit(session.unit),
    state: asState(session.state),
    startedAt: iso(session.startedAt),
    completedAt: session.completedAt === null ? null : iso(session.completedAt),
  };
}

function asChange(row: ChangeResult): ProgressChange {
  const { route: _route, ...change } = row;
  return { ...change, recordedAt: iso(change.recordedAt) };
}

function asUnitRecord(row: UnitResult): ProgressUnitRecord {
  const { route: _route, ...unit } = row;
  return { ...unit, addedAt: iso(unit.addedAt) };
}

function assertMode(mode: string): void {
  if (!MODES.has(mode as ProgressMode)) throw new TypeError('Unknown progress mode');
}

function assertUnit(unit: string): void {
  if (!UNITS.has(unit as ProgressUnit)) throw new TypeError('Unknown progress unit');
}

function assertState(state: string): void {
  if (!STATES.has(state as ProgressState)) throw new TypeError('Unknown progress state');
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Page limit must be a positive integer');
}

function assertUnitIds(unitIds: readonly string[]): void {
  if (unitIds.length > MAX_PROGRESS_UNIT_IDS) throw new RangeError('A progress unit write accepts at most 100 ids');
  for (const unitId of unitIds) {
    if (unitId.length < 1 || unitId.length > 128)
      throw new RangeError('A progress unit id must be 1 to 128 characters');
  }
}

function assertCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > 20_000) {
    throw new RangeError('Completed unit count must be an integer from 0 to 20000');
  }
}

export async function insertSession(
  client: Client,
  route: number,
  session: ProgressSessionDraft,
  context: WriteContext,
): Promise<ProgressSession> {
  assertMode(session.mode);
  assertUnit(session.unit);
  const row = await sessionInsert.run(queryClient(client), {
    route,
    session_id: session.id,
    account_id: session.accountId,
    subject_id: session.subjectId,
    version_subject_id: session.versionSubjectId,
    mode: session.mode,
    unit: session.unit,
    total: session.total,
    time: context.time,
    last_changed_at: context.time,
    transaction_id: context.transactionId,
  });
  return asSession(row);
}

export async function readSession(client: Client, route: number, sessionId: string): Promise<ProgressSession | null> {
  const row = await sessionRead.run(queryClient(client), { route, session_id: sessionId });
  return row ? asSession(row) : null;
}

export async function updateSession(
  client: Client,
  route: number,
  sessionId: string,
  revision: number,
  changes: ProgressSessionUpdate,
  context: WriteContext,
): Promise<ProgressSession> {
  assertState(changes.state);
  assertCount(changes.completedUnitCount);
  const row = await sessionUpdate.run(queryClient(client), {
    route,
    session_id: sessionId,
    revision,
    amount: changes.amount,
    locator: changes.locator,
    position: changes.position,
    completed_unit_count: changes.completedUnitCount,
    state: changes.state,
    completed_at: changes.completedAt,
    time: context.time,
    transaction_id: context.transactionId,
  });
  // A missed revision returns no row. `null!` keeps that result while the declared
  // session type stays free of null, which Array.find's miss (undefined) can be compared with.
  return row ? asSession(row) : null!;
}

export async function addUnits(
  client: Client,
  route: number,
  sessionId: string,
  unitIds: readonly string[],
  context: WriteContext,
): Promise<number> {
  assertUnitIds(unitIds);
  const row = await unitAdd.run(queryClient(client), {
    route,
    session_id: sessionId,
    unit_ids: [...unitIds],
    time: context.time,
  });
  return row.added;
}

export async function removeUnits(
  client: Client,
  route: number,
  sessionId: string,
  unitIds: readonly string[],
): Promise<number> {
  assertUnitIds(unitIds);
  const row = await unitRemove.run(queryClient(client), {
    route,
    session_id: sessionId,
    unit_ids: [...unitIds],
  });
  return row.removed;
}

export async function appendChange(
  client: Client,
  route: number,
  sessionId: string,
  changeNo: number,
  intent: unknown,
  context: WriteContext,
): Promise<ProgressChange> {
  const row = await changeAppend.run(queryClient(client), {
    route,
    session_id: sessionId,
    change_no: changeNo,
    intent,
    time: context.time,
    transaction_id: context.transactionId,
  });
  return asChange(row);
}

export async function pageSessions(
  client: Client,
  route: number,
  accountId: string,
  subjectId: string,
  page: ProgressSessionPage,
): Promise<ProgressSession[]> {
  assertLimit(page.limit);
  const rows = await sessionPage.run(queryClient(client), {
    route,
    account_id: accountId,
    subject_id: subjectId,
    after_started_at: page.after?.startedAt ?? '2026-01-01T00:00:00.000Z',
    after_session_id: page.after?.sessionId ?? '00000000-0000-0000-0000-000000000000',
    has_cursor: page.after !== null,
    limit: Math.min(MAX_PROGRESS_PAGE_SIZE, page.limit),
  });
  return rows.map((row) => asSession(row));
}

export async function pageUnits(
  client: Client,
  route: number,
  sessionId: string,
  page: ProgressUnitPage,
): Promise<ProgressUnitRecord[]> {
  assertLimit(page.limit);
  const rows = await unitPage.run(queryClient(client), {
    route,
    session_id: sessionId,
    after_unit_id: page.after?.unitId ?? '',
    has_cursor: page.after !== null,
    limit: Math.min(MAX_PROGRESS_PAGE_SIZE, page.limit),
  });
  return rows.map((row) => asUnitRecord(row));
}

export async function pageChanges(
  client: Client,
  route: number,
  sessionId: string,
  page: ProgressChangePage,
): Promise<ProgressChange[]> {
  assertLimit(page.limit);
  const rows = await changePage.run(queryClient(client), {
    route,
    session_id: sessionId,
    after_change_no: page.after?.changeNo ?? 0,
    has_cursor: page.after !== null,
    limit: Math.min(MAX_PROGRESS_PAGE_SIZE, page.limit),
  });
  return rows.map((row) => asChange(row));
}
