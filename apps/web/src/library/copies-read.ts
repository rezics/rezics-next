import type { CopyProfile } from './copies-profiles';
import { libraryCopyStatusLabel } from './profiles';
import definitions from '../kernel/recorded/definitions-release.json';
import type { Release } from '../subject/definitions';
import { getLocale } from '../paraglide/runtime.js';
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

export type CopyStatusWrite = string;
export type CopyStatusRead = string;

/** A copy the page can render. Subject ids stay off this object so a hidden subject is never serialized. */
export type CopyItem = {
  id: string;
  status: CopyStatusRead;
  kind: string | null;
  revision: number;
  location: string | null;
  source: string | null;
  acquiredOn: string | null;
  disposedOn: string | null;
  note: string | null;
  subject: LibrarySubject | null;
  idempotencyKey: string;
  profile?: CopyProfile;
  kindLabel?: string;
  statusLabel?: string;
};

export type CopiesPageData = {
  signedIn: boolean;
  subjectId: string | null;
  copies: CopyItem[];
  next: string | null;
  addKey: string;
  profile?: CopyProfile;
  sendKind?: boolean;
  csrfToken?: string | null;
};

export type SavedCopy = {
  id: string;
  status: CopyStatusRead;
  kind?: string | null;
  revision: number;
  location: string | null;
  source: string | null;
  acquiredOn: string | null;
  disposedOn: string | null;
  note: string | null;
};

export type CopyWriteFailure = {
  ok: false;
  reason: 'closed' | 'conflict' | 'forbidden' | 'invalid' | 'unavailable' | 'unsupported';
};
export type CopySaved = { ok: true; copy: SavedCopy };
export type CopyRemoved = { ok: true };
export type CopyWriteResult = CopySaved | CopyWriteFailure;
export type CopyRemoveResult = CopyRemoved | CopyWriteFailure;

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
  kind?: string | null;
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
type CreateInput = CopyFields & { subjectId: string; kind?: string; idempotencyKey: string };
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
  return identifier(value);
}

export function copyStatusLabel(status: CopyStatusRead): string {
  return (
    libraryCopyStatusLabel(definitions.release as unknown as Release, '', 'legacy-unspecified', status, getLocale())
      ?.text ?? m.library_other()
  );
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
  const kind = identifier(input.kind);
  const idempotencyKey = keyOf(input.idempotencyKey);
  const fields = fieldsOf(input);
  if (!subjectId || !idempotencyKey || !fields) return undefined;
  return { subjectId, ...(kind ? { kind } : {}), idempotencyKey, ...fields };
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
    kind: typeof copy.kind === 'string' ? copy.kind : null,
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
    ...(copy.kind === undefined ? {} : { kind: copy.kind }),
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

export function writeFailure(status: number | undefined, error: unknown): CopyWriteFailure {
  const body = problemBody(error);
  if (isPlatformClosedProblem(status, body)) return { ok: false, reason: 'closed' };
  if (status === 409 && isRecord(body) && body.code === 'conflict') return { ok: false, reason: 'conflict' };
  if (status === 422 && isRecord(body) && body.code === 'unsupported_library_profile')
    return { ok: false, reason: 'unsupported' };
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
  const sendKind = page.copies.some((copy) => Object.hasOwn(copy, 'kind'));
  const copies = page.copies.map(present);
  return { signedIn: true, subjectId, copies, next: page.next, addKey: crypto.randomUUID(), sendKind };
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
    // The generated client awaits the documented immutable kind field; the spread preserves it on the wire.
    const result = await client.copies.post(
      {
        subjectId: draft.subjectId,
        ...(draft.kind ? { kind: draft.kind } : {}),
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
