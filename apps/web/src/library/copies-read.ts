import { libraryCopyStatusLabel } from './profiles';
import definitions from '../kernel/recorded/definitions-release.json';
import type { Release } from '../subject/definitions';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import type { CopyProfile } from './copies-profiles';
import { deletionEvidence, type DeletionEvidence } from './copies-receipt';
import type { KernelClient } from '@rezics/client';
import { nativeCopyPresentation, nativeCopyPresentationQuery, type NativeCopy } from './copies-server';
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
  profile?: CopyProfile | undefined;
  kindLabel?: string | undefined;
  statusLabel?: string | undefined;
  kindLabelLanguage?: string | undefined;
  statusLabelLanguage?: string | undefined;
  meaning?: 'known' | 'unknown' | 'unavailable' | undefined;
  statusEditing?:
    | {
        state: 'supported' | 'unsupported' | 'unavailable';
        statuses?: { id: string; label: string; labelLanguage?: string }[];
      }
    | undefined;
};

export type CopiesPageData = {
  signedIn: boolean;
  subjectId: string | null;
  /** Original requested cursor, including when the existing invalid-cursor fallback reads page one. */
  requestedCursor?: string | null;
  cursorRestarted?: boolean;
  copies: CopyItem[];
  next: string | null;
  addKey: string;
  profile?: CopyProfile | undefined;
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
export type CopyRemoved = { ok: true; undo?: DeletionEvidence };
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
type UpdateInput = Omit<CopyFields, 'status'> & { status?: string } & {
  id: string;
  revision: number;
  idempotencyKey: string;
};
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
  const fields = fieldsOf({ ...input, status: input.status ?? 'unchanged' });
  if (!id || revision === undefined || !idempotencyKey || !fields) return undefined;
  const { status: _status, ...metadata } = fields;
  const status = Object.hasOwn(input, 'status') ? statusWriteOf(input.status) : undefined;
  if (Object.hasOwn(input, 'status') && status === undefined) return undefined;
  return { id, revision, idempotencyKey, ...metadata, ...(status === undefined ? {} : { status }) };
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
  if (status === 409) return { ok: false, reason: 'conflict' };
  if (status === 422 && isRecord(body) && body.code === 'unsupported_library_profile')
    return { ok: false, reason: 'unsupported' };
  if (status === 400 || status === 422) return { ok: false, reason: 'invalid' };
  if (status === 401 || status === 403) return { ok: false, reason: 'forbidden' };
  return { ok: false, reason: 'unavailable' };
}

function writeHeaders(authorization: string, idempotencyKey: string): { 'idempotency-key': string } {
  return { authorization, 'idempotency-key': JSON.stringify(idempotencyKey) } as { 'idempotency-key': string };
}

async function bearer(request: Request, sessionEnv: Partial<SessionEnv>): Promise<string | CopyWriteFailure> {
  if (await prepareSession(request, sessionEnv)) return { ok: false, reason: 'forbidden' };
  const authorization = viewerCredential(request);
  if (!authorization) return { ok: false, reason: 'forbidden' };
  return authorization;
}

async function readCopyPage(
  client: KernelClient,
  authorization: string,
  subjectId?: string,
  cursor?: string,
  recovered?: () => void,
) {
  const read = async (pageCursor?: string) => {
    const result = await client.copies.get({
      query: { ...libraryListQuery(pageCursor), ...(subjectId ? { subjectId } : {}) },
      headers: { authorization },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    const body = problemBody(result.error);
    if (result.status === 400 && isRecord(body) && body.code === 'invalid_cursor') throw new StaleCursorError();
    return readLibraryResult(result);
  };
  try {
    return await read(cursor);
  } catch (error) {
    if (!(error instanceof StaleCursorError) || !cursor) throw error;
    recovered?.();
    return read();
  }
}

/** One credential read, then one raw page of the viewer's copies, optionally filtered by subject. */
export async function loadCopiesPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { subjectId?: string; cursor?: string },
): Promise<CopiesPageData> {
  const refused = await prepareSession(request, sessionEnv);
  const authorization = refused ? null : viewerCredential(request);
  const subjectId = copiesSubjectId(input.subjectId) ?? null;
  const provenance = input.cursor ? { requestedCursor: input.cursor } : {};
  if (!authorization)
    return { signedIn: false, subjectId, ...provenance, copies: [], next: null, addKey: crypto.randomUUID() };
  let cursorRestarted = false;
  const page = await readCopyPage(client, authorization, subjectId ?? undefined, input.cursor, () => {
    cursorRestarted = true;
  });
  // The activated profile choice is part of every current copy create request,
  // including an empty filtered page. Do not infer producer support from rows.
  const sendKind = true;
  const copies = page.copies.map(present);
  return {
    signedIn: true,
    subjectId,
    ...provenance,
    ...(cursorRestarted ? { cursorRestarted: true } : {}),
    copies,
    next: page.next,
    addKey: crypto.randomUUID(),
    sendKind,
  };
}

export type CopyDetailResult = { ok: true; copy: CopyItem } | { ok: false; reason: 'forbidden' | 'unavailable' };

/** Explicit inspection only: one credential-bound point read, with no list/profile follow-up. */
export async function loadCopyDetail(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: unknown,
): Promise<CopyDetailResult> {
  const id = isRecord(input) ? identifier(input.id) : undefined;
  if (!id) return { ok: false, reason: 'unavailable' };
  try {
    const authorization = await bearer(request, sessionEnv);
    if (typeof authorization !== 'string') return { ok: false, reason: 'forbidden' };
    const language = request.headers.get('accept-language');
    const result = await client.copies({ copyId: id }).get({
      query: { view: 'FULL', ...nativeCopyPresentationQuery() },
      headers: { authorization, ...(language ? { 'accept-language': language } : {}) },
      fetch: { cache: 'no-store', redirect: 'manual' },
    });
    // The native point read also conceals denied rows as 404. It is no deletion evidence.
    if ([401, 403, 404].includes(result.status)) return { ok: false, reason: 'forbidden' };
    if (result.error || !result.data?.copy || result.data.copy.id !== id) return { ok: false, reason: 'unavailable' };
    const copy: NativeCopy = result.data.copy;
    return { ok: true, copy: { ...present(copy), ...nativeCopyPresentation(copy) } };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Only an explicitly changed, observed native choice may enter an enhanced status update. */
export function copyStatusChange(copy: CopyItem, status: string): { status?: string } | undefined {
  if (status === copy.status) return {};
  return copy.statusEditing?.state === 'supported' &&
    copy.statusEditing.statuses?.some((choice) => choice.id === status)
    ? { status }
    : undefined;
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
        ...(draft.status === undefined ? {} : { status: draft.status }),
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
    const undo = deletionEvidence(result.response.headers, 'Copy');
    return { ok: true, ...(undo ? { undo } : {}) };
  } catch (error) {
    if (isPlatformClosedError(error) || error instanceof PlatformClosedError) return { ok: false, reason: 'closed' };
    throw error;
  }
}

/** Restore one retained native copy; no recreation, profile substitution or follow-up read. */
export async function restoreCopy(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: unknown,
): Promise<CopyWriteResult> {
  if (!isRecord(input) || !uuid.test(String(input.deletionId))) return { ok: false, reason: 'invalid' };
  const draft = parseRemove(input);
  if (!draft) return { ok: false, reason: 'invalid' };
  try {
    const authorization = await bearer(request, sessionEnv);
    if (typeof authorization !== 'string') return authorization;
    const result = await client
      .copies({ copyId: draft.id })
      .$restore.post(
        { deletionId: String(input.deletionId), revision: draft.revision },
        { headers: writeHeaders(authorization, draft.idempotencyKey) },
      );
    if (result.error || !result.data?.copy) return writeFailure(result.status, result.error);
    return { ok: true, copy: saved(result.data.copy) };
  } catch (error) {
    return { ok: false, reason: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}
