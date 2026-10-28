import type { KernelClient } from '@rezics/client';
import { m } from '../paraglide/messages.js';
import { isPlatformClosedError, isPlatformClosedProblem, PlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { copiesSubjectId } from './copies-query';
import {
  type LibraryLabel,
  libraryListQuery,
  readLibraryResult,
  StaleCursorError,
  subjectOf as presentSubject,
  type LibrarySubject,
} from './reads';

export type CopyStatusWrite = 'ordered' | 'owned' | 'lent' | 'disposed';
export type CopyStatusRead = string;

/** A copy the page can render. Subject ids stay off this object so a hidden subject is never serialized. */
export type CopyItem = {
  id: string;
  status: CopyStatusRead;
  revision: number;
  location: string | null;
  source: string | null;
  acquiredOn: string | null;
  disposedOn: string | null;
  note: string | null;
  subject: LibrarySubject | null;
  idempotencyKey: string;
};

export type CopiesPageData = {
  signedIn: boolean;
  subjectId: string | null;
  copies: CopyItem[];
  next: string | null;
  addKey: string;
};

export type SavedCopy = {
  id: string;
  status: CopyStatusRead;
  revision: number;
  location: string | null;
  source: string | null;
  acquiredOn: string | null;
  disposedOn: string | null;
  note: string | null;
};

export type CopyWriteFailure = {
  ok: false;
  reason: 'closed' | 'conflict' | 'forbidden' | 'invalid' | 'unavailable';
};
export type CopySaved = { ok: true; copy: SavedCopy };
export type CopyRemoved = { ok: true };
export type CopyWriteResult = CopySaved | CopyWriteFailure;
export type CopyRemoveResult = CopyRemoved | CopyWriteFailure;

const writableCopyStatuses = new Set<CopyStatusWrite>(['ordered', 'owned', 'lent', 'disposed']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const textLimit = { location: 200, source: 200, note: 1000 } as const;

type RawSubject = {
  id?: string;
  type?: string;
  types?: readonly string[];
  label?: LibraryLabel;
  cover?: unknown;
} | null;
type RawCopy = {
  id: string;
  subjectId: string;
  status: CopyStatusRead;
  revision: number;
  location: string | null;
  source: string | null;
  acquiredOn: string | null;
  disposedOn: string | null;
  note: string | null;
  subject?: RawSubject;
};
type CopyFields = {
  status: CopyStatusWrite;
  location: string | null;
  source: string | null;
  acquiredOn: string | null;
  disposedOn: string | null;
  note: string | null;
};
type CreateInput = CopyFields & { subjectId: string; idempotencyKey: string };
type UpdateInput = CopyFields & { id: string; revision: number; idempotencyKey: string };
type RemoveInput = { id: string; revision: number; idempotencyKey: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function within(value: string, max: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > max) return false;
  }
  return true;
}

function isoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[\s/]/.test(value)) return undefined;
  return value;
}

function keyOf(value: unknown): string | undefined {
  return typeof value === 'string' && uuid.test(value) ? value : undefined;
}

function statusWriteOf(value: unknown): CopyStatusWrite | undefined {
  return typeof value === 'string' && writableCopyStatuses.has(value as CopyStatusWrite)
    ? (value as CopyStatusWrite)
    : undefined;
}

export function copyStatusLabel(status: CopyStatusRead): string {
  if (status === 'ordered') return m.library_copy_status_ordered();
  if (status === 'owned') return m.library_copy_status_owned();
  if (status === 'lent') return m.library_copy_status_lent();
  if (status === 'disposed') return m.library_copy_status_disposed();
  return m.library_other();
}

function textOf(value: unknown, max: number): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !within(value, max)) return undefined;
  return value;
}

function dateOf(value: unknown): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !isoDate(value)) return undefined;
  return value;
}

function revisionOf(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value >= 2_147_483_647)
    return undefined;
  return value;
}

function fieldsOf(record: Record<string, unknown>): CopyFields | undefined {
  const status = statusWriteOf(record.status);
  const location = textOf(record.location, textLimit.location);
  const source = textOf(record.source, textLimit.source);
  const acquiredOn = dateOf(record.acquiredOn);
  const disposedOn = dateOf(record.disposedOn);
  const note = textOf(record.note, textLimit.note);
  if (
    status === undefined ||
    location === undefined ||
    source === undefined ||
    acquiredOn === undefined ||
    disposedOn === undefined ||
    note === undefined
  )
    return undefined;
  return { status, location, source, acquiredOn, disposedOn, note };
}

function parseCreate(input: unknown): CreateInput | undefined {
  if (!isRecord(input)) return undefined;
  const subjectId = identifier(input.subjectId);
  const idempotencyKey = keyOf(input.idempotencyKey);
  const fields = fieldsOf(input);
  if (!subjectId || !idempotencyKey || !fields) return undefined;
  return { subjectId, idempotencyKey, ...fields };
}

function parseUpdate(input: unknown): UpdateInput | undefined {
  if (!isRecord(input)) return undefined;
  const id = identifier(input.id);
  const revision = revisionOf(input.revision);
  const idempotencyKey = keyOf(input.idempotencyKey);
  const fields = fieldsOf(input);
  if (!id || revision === undefined || !idempotencyKey || !fields) return undefined;
  return { id, revision, idempotencyKey, ...fields };
}

function parseRemove(input: unknown): RemoveInput | undefined {
  if (!isRecord(input)) return undefined;
  const id = identifier(input.id);
  const revision = revisionOf(input.revision);
  const idempotencyKey = keyOf(input.idempotencyKey);
  if (!id || revision === undefined || !idempotencyKey) return undefined;
  return { id, revision, idempotencyKey };
}

function subjectOf(subject: RawSubject | undefined): LibrarySubject | null {
  if (!subject || typeof subject.id !== 'string' || typeof subject.type !== 'string') return null;
  return presentSubject({ ...subject, id: subject.id, type: subject.type, label: subject.label ?? null });
}

function present(copy: RawCopy): CopyItem {
  return {
    id: copy.id,
    status: copy.status,
    revision: copy.revision,
    location: copy.location,
    source: copy.source,
    acquiredOn: copy.acquiredOn,
    disposedOn: copy.disposedOn,
    note: copy.note,
    subject: subjectOf(copy.subject),
    idempotencyKey: crypto.randomUUID(),
  };
}

function saved(copy: SavedCopy): SavedCopy {
  return {
    id: copy.id,
    status: copy.status,
    revision: copy.revision,
    location: copy.location,
    source: copy.source,
    acquiredOn: copy.acquiredOn,
    disposedOn: copy.disposedOn,
    note: copy.note,
  };
}

function problemBody(error: unknown): unknown {
  return isRecord(error) && 'value' in error ? error.value : undefined;
}

function writeFailure(status: number | undefined, error: unknown): CopyWriteFailure {
  const body = problemBody(error);
  if (isPlatformClosedProblem(status, body)) return { ok: false, reason: 'closed' };
  if (status === 409 && isRecord(body) && body.code === 'conflict') return { ok: false, reason: 'conflict' };
  if (status === 400 || status === 422) return { ok: false, reason: 'invalid' };
  if (status === 401 || status === 403) return { ok: false, reason: 'forbidden' };
  return { ok: false, reason: 'unavailable' };
}

function writeHeaders(authorization: string, idempotencyKey: string): { 'idempotency-key': string } {
  return { authorization, 'idempotency-key': idempotencyKey } as { 'idempotency-key': string };
}

async function bearer(request: Request, sessionEnv: Partial<SessionEnv>): Promise<string | CopyWriteFailure> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  if (!authorization) return { ok: false, reason: 'forbidden' };
  return authorization;
}

async function readCopyPage(client: KernelClient, authorization: string, subjectId?: string, cursor?: string) {
  const read = async (pageCursor?: string) => {
    const result = await client.copies.get({
      query: { ...libraryListQuery(pageCursor), ...(subjectId ? { subjectId } : {}) },
      headers: { authorization },
    });
    const body = problemBody(result.error);
    if (result.status === 400 && isRecord(body) && body.code === 'invalid_cursor') throw new StaleCursorError();
    return readLibraryResult(result);
  };
  try {
    return await read(cursor);
  } catch (error) {
    if (!(error instanceof StaleCursorError) || !cursor) throw error;
    return read();
  }
}

/** One credential read, then one FULL page of the viewer's copies, optionally filtered by subject. */
export async function loadCopiesPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { subjectId?: string; cursor?: string },
): Promise<CopiesPageData> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  const subjectId = copiesSubjectId(input.subjectId) ?? null;
  if (!authorization) return { signedIn: false, subjectId, copies: [], next: null, addKey: crypto.randomUUID() };
  const page = await readCopyPage(client, authorization, subjectId ?? undefined, input.cursor);
  const copies = page.copies.map(present);
  return { signedIn: true, subjectId, copies, next: page.next, addKey: crypto.randomUUID() };
}

/** One create write. The returned copy omits the subject id; the page keeps a label only when it already has one. */
export async function submitCopy(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: unknown,
): Promise<CopyWriteResult> {
  const draft = parseCreate(input);
  if (!draft) return { ok: false, reason: 'invalid' };
  try {
    const authorization = await bearer(request, sessionEnv);
    if (typeof authorization !== 'string') return authorization;
    const result = await client.copies.post(
      {
        subjectId: draft.subjectId,
        status: draft.status,
        location: draft.location,
        source: draft.source,
        acquiredOn: draft.acquiredOn,
        disposedOn: draft.disposedOn,
        note: draft.note,
      },
      { headers: writeHeaders(authorization, draft.idempotencyKey) },
    );
    if (result.error || !result.data?.copy) return writeFailure(result.status, result.error);
    return { ok: true, copy: saved(result.data.copy) };
  } catch (error) {
    if (isPlatformClosedError(error) || error instanceof PlatformClosedError) return { ok: false, reason: 'closed' };
    throw error;
  }
}

/** One revisioned update. A conflict leaves the stored copy untouched. */
export async function saveCopy(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: unknown,
): Promise<CopyWriteResult> {
  const draft = parseUpdate(input);
  if (!draft) return { ok: false, reason: 'invalid' };
  try {
    const authorization = await bearer(request, sessionEnv);
    if (typeof authorization !== 'string') return authorization;
    const result = await client.copies({ copyId: draft.id }).patch(
      {
        revision: draft.revision,
        status: draft.status,
        location: draft.location,
        source: draft.source,
        acquiredOn: draft.acquiredOn,
        disposedOn: draft.disposedOn,
        note: draft.note,
      },
      { headers: writeHeaders(authorization, draft.idempotencyKey) },
    );
    if (result.error || !result.data?.copy) return writeFailure(result.status, result.error);
    return { ok: true, copy: saved(result.data.copy) };
  } catch (error) {
    if (isPlatformClosedError(error) || error instanceof PlatformClosedError) return { ok: false, reason: 'closed' };
    throw error;
  }
}

/** One deletion. The revision the page read is sent as `?revision=`. */
export async function removeCopy(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: unknown,
): Promise<CopyRemoveResult> {
  const draft = parseRemove(input);
  if (!draft) return { ok: false, reason: 'invalid' };
  try {
    const authorization = await bearer(request, sessionEnv);
    if (typeof authorization !== 'string') return authorization;
    const result = await client.copies({ copyId: draft.id }).delete(undefined, {
      query: { revision: draft.revision },
      headers: writeHeaders(authorization, draft.idempotencyKey),
    });
    if (result.error) return writeFailure(result.status, result.error);
    return { ok: true };
  } catch (error) {
    if (isPlatformClosedError(error) || error instanceof PlatformClosedError) return { ok: false, reason: 'closed' };
    throw error;
  }
}
