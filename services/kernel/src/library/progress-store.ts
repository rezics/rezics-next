import { assertPreProfileLibraryRead } from './profile-source.ts';
import type { PoolClient } from 'pg';
import type { ProgressMode, ProgressState } from './progress.ts';
import { decodeLibraryProfilePin } from './profile-pin.ts';
import type { LibraryProfilePin } from './profile.ts';
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
  type ProgressScalarMeasure,
  type ProgressSession,
  type ProgressSessionDraft,
  type ProgressSessionPage,
  type ProgressSessionUpdate,
  type ProgressUnitRecord,
  type ProgressUnitPage,
} from './progress-model.ts';

type Client = Pick<PoolClient, 'query'>;
type WriteContext = { transactionId: string; time: string };
type SessionResult = Omit<
  NonNullable<Awaited<ReturnType<typeof sessionRead.run>>>,
  'mode' | 'unit' | 'state' | 'libraryProfilePin'
> & {
  mode: string;
  unit: string;
  state: string;
  libraryProfilePin?: unknown;
  additionalMeasures?: unknown;
};
type ChangeResult = NonNullable<Awaited<ReturnType<typeof changeAppend.run>>>;
type UnitResult = Awaited<ReturnType<typeof unitPage.run>>[number];

const MODES = new Set<ProgressMode>(['scalar_amount', 'cursor_position', 'completed_units']);
const UNITS = new Set<string>(['page', 'chapter', 'episode', 'volume', 'minute', 'percent']);
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

function asState(value: string): ProgressState {
  if (STATES.has(value as ProgressState)) return value as ProgressState;
  throw new Error(`Unknown progress state: ${value}`);
}

function asSession(row: SessionResult): ProgressSession {
  const additionalMeasures = decodeAdditionalMeasures(row.additionalMeasures);
  const measures =
    row.mode === 'scalar_amount' && additionalMeasures.length > 0
      ? [{ unit: row.unit, total: row.total, amount: row.amount }, ...additionalMeasures]
      : undefined;
  return {
    id: row.id,
    accountId: row.accountId,
    subjectId: row.subjectId,
    versionSubjectId: row.versionSubjectId,
    mode: asMode(row.mode),
    unit: row.unit,
    total: row.total,
    amount: row.amount,
    locator: row.locator,
    position: row.position,
    completedUnitCount: row.completedUnitCount,
    state: asState(row.state),
    revision: row.revision,
    startedAt: iso(row.startedAt),
    completedAt: row.completedAt === null ? null : iso(row.completedAt),
    transactionId: row.transactionId,
    ...(measures === undefined ? {} : { measures }),
  };
}

function decodeAdditionalMeasures(value: unknown): ProgressScalarMeasure[] {
  const decoded = typeof value === 'string' ? JSON.parse(value) : value;
  if (decoded === null || decoded === undefined) return [];
  if (!Array.isArray(decoded) || decoded.length >= 8) throw new TypeError('Invalid stored progress measures');
  return decoded.map((entry) => {
    const measure = entry as Record<string, unknown>;
    if (
      typeof measure !== 'object' ||
      measure === null ||
      Array.isArray(measure) ||
      typeof measure.unit !== 'string' ||
      (measure.amount !== null && typeof measure.amount !== 'string') ||
      (measure.total !== null && typeof measure.total !== 'string')
    )
      throw new TypeError('Invalid stored progress measure');
    return {
      unit: measure.unit as string,
      amount: measure.amount as string | null,
      total: measure.total as string | null,
    };
  });
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

function assertUnit(unit: string, pinned: boolean): void {
  if (typeof unit !== 'string' || (pinned ? unit.length === 0 : !UNITS.has(unit)))
    throw new TypeError('Unknown progress unit');
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
  pin?: LibraryProfilePin,
): Promise<ProgressSession> {
  assertMode(session.mode);
  const acceptedPin = pin === undefined ? null : decodeLibraryProfilePin(pin);
  assertUnit(session.unit, acceptedPin !== null);
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
    library_profile_pin: acceptedPin,
    additional_measures: JSON.stringify(
      (session.additionalMeasures ?? []).map((measure) => ({ unit: measure.unit, amount: null, total: measure.total })),
    ),
  });
  if (!row) throw new Error('Library session insert returned no row');
  return asSession(row);
}

export async function readSession(client: Client, route: number, sessionId: string): Promise<ProgressSession | null> {
  const row = await sessionRead.run(queryClient(client), { route, session_id: sessionId });
  if (row && decodeLibraryProfilePin(row.libraryProfilePin) === null) {
    await assertPreProfileLibraryRead(client, row.accountId);
    assertUnit(row.unit, false);
  }
  return row ? asSession(row) : null;
}

export async function readSessionFact(
  client: Client,
  route: number,
  sessionId: string,
): Promise<{ session: ProgressSession; pin: LibraryProfilePin | null } | null> {
  const row = await sessionRead.run(queryClient(client), { route, session_id: sessionId });
  return row ? { session: asSession(row), pin: decodeLibraryProfilePin(row.libraryProfilePin) } : null;
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
    additional_measures: JSON.stringify(
      (changes.measures?.slice(1) ?? []).map(({ unit, amount, total }) => ({ unit, amount, total })),
    ),
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
  if (rows.some((row) => row.libraryProfilePin === null)) {
    await assertPreProfileLibraryRead(client, accountId);
    for (const row of rows) if (row.libraryProfilePin === null) assertUnit(row.unit, false);
  }
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
