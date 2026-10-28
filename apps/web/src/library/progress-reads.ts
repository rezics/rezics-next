import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import {
  libraryFullQuery,
  libraryListQuery,
  readLibraryResult,
  StaleCursorError,
  subjectOf as presentSubject,
  type LibraryLabel,
  type LibrarySubject,
} from './reads';

export const PROGRESS_BATCH_LIMIT = 100;

const routeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const idempotencyKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const decimal = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
const unitIdPattern = /^[A-Za-z0-9._:~-]{1,128}$/;
const modes = new Set(['scalar_amount', 'cursor_position', 'completed_units']);
const writableProgressUnits = new Set(['page', 'chapter', 'episode', 'volume', 'minute', 'percent']);

export type ProgressMode = 'scalar_amount' | 'cursor_position' | 'completed_units';
export type ProgressUnitWrite = 'page' | 'chapter' | 'episode' | 'volume' | 'minute' | 'percent';
export type ProgressUnitRead = string;
export type ProgressState = 'active' | 'completed' | 'abandoned';

export type ProgressChange = {
  id: string;
  revision: number;
  createdAt: string;
  action: 'complete' | 'abandon' | null;
  amount: string | null;
  locator: string | null;
  position: string | null;
  add: string[];
  remove: string[];
};

export type ProgressSessionCore = {
  id: string;
  subjectId: string;
  versionSubjectId: string | null;
  mode: ProgressMode;
  unit: ProgressUnitRead;
  total: string | null;
  amount: string | null;
  locator: string | null;
  position: string | null;
  completedUnitCount: number;
  state: ProgressState;
  revision: number;
  startedAt: string;
  completedAt: string | null;
  subject: LibrarySubject | null;
  versionSubject: LibrarySubject | null;
};

export type ProgressIndex = {
  signedIn: boolean;
  subjectId: string;
  sessions: ProgressSessionCore[];
  next: string | null;
  idempotencyKey: string;
};

export type ProgressSessionView = ProgressSessionCore & {
  changes: ProgressChange[];
  changesNext: string | null;
  units: string[];
  unitsNext: string | null;
};

export type ProgressSessionPage =
  | { signedIn: false; idempotencyKey: string }
  | {
      signedIn: true;
      idempotencyKey: string;
      changesCursor?: string;
      unitsCursor?: string;
      session: ProgressSessionView;
    };

export type ProgressFailure = {
  ok: false;
  reason: 'conflict' | 'invalid' | 'closed' | 'forbidden' | 'unavailable';
};

export type ProgressSnapshot = {
  id: string;
  revision: number;
  amount: string | null;
  locator: string | null;
  position: string | null;
  completedUnitCount: number;
  state: ProgressState;
  completedAt: string | null;
  total: string | null;
};

export type ProgressStarted = { ok: true; id: string };
export type ProgressRecorded = { ok: true; session: ProgressSnapshot };

type RawSubject = {
  id: string;
  type: string;
  types?: readonly string[];
  label: LibraryLabel;
  cover?: unknown;
} | null;
type RawIntent =
  | { amount: string }
  | { locator: string; position: string }
  | { add: string[]; remove?: string[] }
  | { remove: string[]; add?: string[] }
  | { action: 'complete' | 'abandon' };
type RawSession = Omit<ProgressSessionCore, 'subject' | 'versionSubject'> & {
  subject?: RawSubject;
  versionSubject?: RawSubject;
};
type RawChange = { id: string; revision: number; intent: RawIntent; createdAt: string };
type LibraryCall = { data?: unknown; error?: unknown; status?: number };

function isMode(value: string): value is ProgressMode {
  return modes.has(value);
}

function isWritableUnit(value: string): value is ProgressUnitWrite {
  return writableProgressUnits.has(value);
}

function subjectOf(subject: RawSubject | undefined): LibrarySubject | null {
  return presentSubject(subject);
}

function presentSession(session: RawSession): ProgressSessionCore {
  return {
    id: session.id,
    subjectId: session.subjectId,
    versionSubjectId: session.versionSubjectId,
    mode: session.mode,
    unit: session.unit,
    total: session.total,
    amount: session.amount,
    locator: session.locator,
    position: session.position,
    completedUnitCount: session.completedUnitCount,
    state: session.state,
    revision: session.revision,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    subject: subjectOf(session.subject),
    versionSubject: subjectOf(session.versionSubject),
  };
}

function presentChange(change: RawChange): ProgressChange {
  const intent = change.intent;
  return {
    id: change.id,
    revision: change.revision,
    createdAt: change.createdAt,
    action: 'action' in intent ? intent.action : null,
    amount: 'amount' in intent ? intent.amount : null,
    locator: 'locator' in intent ? intent.locator : null,
    position: 'position' in intent ? intent.position : null,
    add: 'add' in intent && intent.add ? [...intent.add] : [],
    remove: 'remove' in intent && intent.remove ? [...intent.remove] : [],
  };
}

function snapshotOf(session: RawSession): ProgressSnapshot {
  return {
    id: session.id,
    revision: session.revision,
    amount: session.amount,
    locator: session.locator,
    position: session.position,
    completedUnitCount: session.completedUnitCount,
    state: session.state,
    completedAt: session.completedAt,
    total: session.total,
  };
}

function callStatus(result: { status?: number; error?: unknown }): number {
  if (typeof result.status === 'number') return result.status;
  if (typeof result.error === 'object' && result.error !== null && 'status' in result.error) {
    const status = result.error.status;
    if (typeof status === 'number') return status;
  }
  return 0;
}

function callBody(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('value' in error)) return error;
  return error.value;
}

function failure(status: number, body: unknown): ProgressFailure {
  if (isPlatformClosedProblem(status, body)) return { ok: false, reason: 'closed' };
  if (status === 409) return { ok: false, reason: 'conflict' };
  if (status === 400 || status === 422) return { ok: false, reason: 'invalid' };
  if (status === 401 || status === 403 || status === 404) return { ok: false, reason: 'forbidden' };
  return { ok: false, reason: 'unavailable' };
}

function writeHeaders(authorization: string, key: string): { 'idempotency-key': string } {
  return { authorization, 'idempotency-key': key } as { 'idempotency-key': string };
}

function readData<T>(result: LibraryCall): T {
  return readLibraryResult(result as { data?: T | null; error?: unknown; status?: number });
}

/** One batch of opaque unit ids, in the order given. More than one hundred is refused before a write. */
export function parseUnitBatch(
  value: string,
): { ok: true; ids: string[] } | { ok: false; reason: 'limit' | 'invalid' } {
  const ids = value.split(/[\s,]+/).filter((part) => part.length > 0);
  if (ids.length > PROGRESS_BATCH_LIMIT) return { ok: false, reason: 'limit' };
  if (ids.length === 0) return { ok: false, reason: 'invalid' };
  const seen = new Set<string>();
  for (const id of ids) {
    if (!unitIdPattern.test(id) || seen.has(id)) return { ok: false, reason: 'invalid' };
    seen.add(id);
  }
  return { ok: true, ids };
}

async function bearer(request: Request, env: Partial<SessionEnv>): Promise<string | null> {
  await prepareSession(request, env);
  return viewerCredential(request);
}

async function readList(client: KernelClient, subjectId: string, authorization: string, cursor?: string) {
  const result = await client.progressSessions.get({
    query: { ...libraryListQuery(cursor), subjectId },
    headers: { authorization },
  });
  return readData<{ progressSessions: RawSession[]; next: string | null }>(result);
}

async function readOne(client: KernelClient, sessionId: string, authorization: string) {
  const result = await client.progressSessions({ sessionId }).get({
    query: libraryFullQuery(),
    headers: { authorization },
  });
  return readData<{ progressSession: RawSession }>(result).progressSession;
}

async function readChanges(client: KernelClient, sessionId: string, authorization: string, cursor?: string) {
  const result = await client.progressSessions({ sessionId }).changes.get({
    query: libraryListQuery(cursor),
    headers: { authorization },
  });
  return readData<{ changes: RawChange[]; next: string | null }>(result);
}

async function readUnits(client: KernelClient, sessionId: string, authorization: string, cursor?: string) {
  const result = await client.progressSessions({ sessionId }).completedUnits.get({
    query: libraryListQuery(cursor),
    headers: { authorization },
  });
  return readData<{ completedUnits: string[]; next: string | null }>(result);
}

/** The person's sessions for one subject. A missing subject id reads nothing; a closed gate stays closed. */
export async function loadProgressIndex(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: { subjectId?: string; cursor?: string },
): Promise<ProgressIndex> {
  const authorization = await bearer(request, env);
  const idempotencyKey = crypto.randomUUID();
  const subjectId = input.subjectId ?? '';
  if (!authorization || !routeId.test(subjectId)) {
    return { signedIn: authorization !== null, subjectId, sessions: [], next: null, idempotencyKey };
  }
  const load = (cursor?: string) => readList(client, subjectId, authorization, cursor);
  let page: { progressSessions: RawSession[]; next: string | null };
  try {
    page = await load(input.cursor);
  } catch (error) {
    if (!(error instanceof StaleCursorError) || !input.cursor) throw error;
    page = await load();
  }
  return {
    signedIn: true,
    subjectId,
    sessions: page.progressSessions.map(presentSession),
    next: page.next,
    idempotencyKey,
  };
}

/** One session, one changes page and one completed-units page, started together after the credential read. */
export async function loadProgressSession(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: { id: string; changes?: string; units?: string },
): Promise<ProgressSessionPage> {
  const authorization = await bearer(request, env);
  const idempotencyKey = crypto.randomUUID();
  if (!authorization) return { signedIn: false, idempotencyKey };
  const [session, changesResult, unitsResult] = await Promise.all([
    readOne(client, input.id, authorization),
    readChanges(client, input.id, authorization, input.changes).then(
      (page) => ({ stale: false as const, page }),
      (error: unknown) => {
        if (error instanceof StaleCursorError) return { stale: true as const };
        throw error;
      },
    ),
    readUnits(client, input.id, authorization, input.units).then(
      (page) => ({ stale: false as const, page }),
      (error: unknown) => {
        if (error instanceof StaleCursorError) return { stale: true as const };
        throw error;
      },
    ),
  ]);
  const changes = changesResult.stale ? await readChanges(client, input.id, authorization) : changesResult.page;
  const units = unitsResult.stale ? await readUnits(client, input.id, authorization) : unitsResult.page;
  return {
    signedIn: true,
    idempotencyKey,
    ...(input.changes && !changesResult.stale ? { changesCursor: input.changes } : {}),
    ...(input.units && !unitsResult.stale ? { unitsCursor: input.units } : {}),
    session: {
      ...presentSession(session),
      changes: changes.changes.map(presentChange),
      changesNext: changes.next,
      units: units.completedUnits,
      unitsNext: units.next,
    },
  };
}

export type ProgressStartInput = {
  subjectId: string;
  mode: string;
  unit: string;
  total?: string;
  idempotencyKey: string;
};

/** Starts one session. Total belongs only to an amount, and only when the person gave one. */
export async function startProgress(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: ProgressStartInput,
): Promise<ProgressStarted | ProgressFailure> {
  const authorization = await bearer(request, env);
  if (!authorization) return { ok: false, reason: 'forbidden' };
  const total = input.total?.trim() ?? '';
  if (
    !routeId.test(input.subjectId) ||
    !isMode(input.mode) ||
    !isWritableUnit(input.unit) ||
    !idempotencyKeyPattern.test(input.idempotencyKey) ||
    (total !== '' && (input.mode !== 'scalar_amount' || !decimal.test(total)))
  )
    return { ok: false, reason: 'invalid' };
  try {
    const result = await client.progressSessions.post(
      { subjectId: input.subjectId, mode: input.mode, unit: input.unit, ...(total ? { total } : {}) },
      { headers: writeHeaders(authorization, input.idempotencyKey) },
    );
    const status = callStatus(result);
    if (status >= 400 || result.error || !result.data?.progressSession) return failure(status, callBody(result.error));
    return { ok: true, id: result.data.progressSession.id };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}

export type ProgressRecordInput = {
  sessionId: string;
  revision: number;
  idempotencyKey: string;
  amount?: string;
  locator?: string;
  position?: string;
  add?: string[];
  remove?: string[];
};

type RecordBody =
  | { revision: number; amount: string }
  | { revision: number; locator: string; position: string }
  | { revision: number; add: string[] }
  | { revision: number; remove: string[] };

function recordBody(input: ProgressRecordInput): RecordBody | null {
  if (!routeId.test(input.sessionId) || !Number.isSafeInteger(input.revision) || input.revision < 0) return null;
  if (!idempotencyKeyPattern.test(input.idempotencyKey)) return null;
  const amount = input.amount !== undefined;
  const cursor = input.locator !== undefined || input.position !== undefined;
  const batch = input.add !== undefined || input.remove !== undefined;
  if ([amount, cursor, batch].filter(Boolean).length !== 1 || (input.add !== undefined && input.remove !== undefined))
    return null;
  if (input.amount !== undefined) {
    if (!decimal.test(input.amount)) return null;
    return { revision: input.revision, amount: input.amount };
  }
  if (cursor) {
    if (
      typeof input.locator !== 'string' ||
      input.locator.length === 0 ||
      input.locator.length > 256 ||
      typeof input.position !== 'string' ||
      !decimal.test(input.position)
    )
      return null;
    return { revision: input.revision, locator: input.locator, position: input.position };
  }
  const ids = input.add ?? input.remove;
  if (!ids || ids.length === 0 || ids.length > PROGRESS_BATCH_LIMIT) return null;
  const seen = new Set<string>();
  for (const id of ids) {
    if (!unitIdPattern.test(id) || seen.has(id)) return null;
    seen.add(id);
  }
  if (input.add) return { revision: input.revision, add: input.add };
  if (input.remove) return { revision: input.revision, remove: input.remove };
  return null;
}

async function recorded(result: {
  data?: { progressSession?: RawSession } | null;
  error?: unknown;
  status?: number;
}): Promise<ProgressRecorded | ProgressFailure> {
  const status = callStatus(result);
  const session = result.data?.progressSession;
  if (status >= 400 || result.error || !session) return failure(status, callBody(result.error));
  return { ok: true, session: snapshotOf(session) };
}

/** Records the mode's one intent. A stale revision is a conflict and does not change the session. */
export async function recordProgress(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: ProgressRecordInput,
): Promise<ProgressRecorded | ProgressFailure> {
  const authorization = await bearer(request, env);
  if (!authorization) return { ok: false, reason: 'forbidden' };
  const body = recordBody(input);
  if (!body) return { ok: false, reason: 'invalid' };
  try {
    const result = await client.progressSessions({ sessionId: input.sessionId }).$record.post(body, {
      headers: writeHeaders(authorization, input.idempotencyKey),
    });
    return recorded(result);
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}

export type ProgressFinishInput = {
  sessionId: string;
  action: 'complete' | 'abandon';
  revision: number;
  idempotencyKey: string;
};

/** Completes or abandons the session the person confirmed, using the revision they read. */
export async function finishProgress(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: ProgressFinishInput,
): Promise<ProgressRecorded | ProgressFailure> {
  const authorization = await bearer(request, env);
  if (!authorization) return { ok: false, reason: 'forbidden' };
  if (
    !routeId.test(input.sessionId) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 0 ||
    !idempotencyKeyPattern.test(input.idempotencyKey) ||
    (input.action !== 'complete' && input.action !== 'abandon')
  )
    return { ok: false, reason: 'invalid' };
  const headers = writeHeaders(authorization, input.idempotencyKey);
  const body = { revision: input.revision };
  try {
    const result =
      input.action === 'complete'
        ? await client.progressSessions({ sessionId: input.sessionId }).$complete.post(body, { headers })
        : await client.progressSessions({ sessionId: input.sessionId }).$abandon.post(body, { headers });
    return recorded(result);
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}
