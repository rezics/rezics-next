import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { libraryFullQuery, libraryListQuery, readLibraryResult, StaleCursorError, type LibrarySubject } from './reads';

export const libraryEntryStates = ['planned', 'in_progress', 'completed', 'paused', 'dropped'] as const;
export type LibraryEntryState = (typeof libraryEntryStates)[number];

const stateSet = new Set<string>(libraryEntryStates);

export function libraryEntryState(value: string | undefined): LibraryEntryState | undefined {
  return value !== undefined && stateSet.has(value) ? (value as LibraryEntryState) : undefined;
}

export type PersonalLibraryEntry = {
  subjectId: string;
  state: LibraryEntryState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  subject: LibrarySubject | null;
  changeKey: string;
  removeKey: string;
};

export type PersonalLibraryView =
  | { signedIn: false }
  | {
      signedIn: true;
      state: LibraryEntryState | null;
      entries: PersonalLibraryEntry[];
      next: string | null;
    };

export type SavedLibraryEntry = {
  subjectId: string;
  state: LibraryEntryState;
  revision: number;
  updatedAt: string;
};

export type ReloadedLibraryEntry = Omit<PersonalLibraryEntry, 'changeKey' | 'removeKey'>;

export type LibraryMutationResult =
  | { ok: true; entry?: SavedLibraryEntry }
  | { ok: false; reason: 'conflict'; entry: ReloadedLibraryEntry }
  | { ok: false; reason: 'closed' | 'missing' | 'unavailable' | 'signed-out' };

export type LibraryChangeInput = {
  subjectId: string;
  state: LibraryEntryState;
  revision: number;
  idempotencyKey: string;
};

export type LibraryRemoveInput = {
  subjectId: string;
  revision: number;
  idempotencyKey: string;
};

type RawSubject = { id: string; type: string; label: string };
type RawEntry = {
  subjectId: string;
  state: LibraryEntryState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  subject?: RawSubject | null;
};

function presentSubject(subject: RawSubject | null | undefined): LibrarySubject | null {
  if (!subject) return null;
  return { id: subject.id, type: subject.type, label: subject.label };
}

function presentEntry(entry: RawEntry): ReloadedLibraryEntry {
  return {
    subjectId: entry.subjectId,
    state: entry.state,
    revision: entry.revision,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    subject: presentSubject(entry.subject),
  };
}

function statusOf(result: { status?: number; error?: { status?: number } | null }): number | undefined {
  if (typeof result.status === 'number') return result.status;
  if (result.error && typeof result.error.status === 'number') return result.error.status;
  return undefined;
}

function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('value' in error)) return undefined;
  const value = (error as { value: unknown }).value;
  if (!value || typeof value !== 'object' || !('code' in value)) return undefined;
  const code = (value as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function writeHeaders(authorization: string, idempotencyKey: string) {
  // The treaty header type names only Idempotency-Key. The bearer is still sent.
  return { authorization, 'idempotency-key': idempotencyKey } as { 'idempotency-key': string };
}

async function bearer(request: Request, sessionEnv: Partial<SessionEnv>): Promise<string | null> {
  await prepareSession(request, sessionEnv);
  return viewerCredential(request);
}

/** One FULL page of the viewer's entries, newest update first, optionally of one state and shorter than a list page. */
export async function readEntryPage(
  client: KernelClient,
  authorization: string,
  cursor: string | undefined,
  state: LibraryEntryState | undefined,
  limit?: number,
) {
  const result = await client.libraryEntries.get({
    query: { ...libraryListQuery(cursor, limit), ...(state ? { state } : {}) },
    headers: { authorization },
  });
  return readLibraryResult(result);
}

/** One session read and one library page. A cursor the kernel no longer accepts restarts at the first page. */
export async function loadPersonalLibrary(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { state?: string; cursor?: string },
): Promise<PersonalLibraryView> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  if (!authorization) return { signedIn: false };
  const state = libraryEntryState(input.state);
  let page: Awaited<ReturnType<typeof readEntryPage>>;
  try {
    page = await readEntryPage(client, authorization, input.cursor, state);
  } catch (error) {
    if (!(error instanceof StaleCursorError) || !input.cursor) throw error;
    page = await readEntryPage(client, authorization, undefined, state);
  }
  return {
    signedIn: true,
    state: state ?? null,
    entries: page.libraryEntries.map((entry) => ({
      ...presentEntry(entry),
      changeKey: crypto.randomUUID(),
      removeKey: crypto.randomUUID(),
    })),
    next: page.next,
  };
}

async function reloadEntry(
  client: KernelClient,
  authorization: string,
  subjectId: string,
): Promise<{ ok: true; entry: ReloadedLibraryEntry } | { ok: false; reason: 'missing' | 'unavailable' }> {
  const result = await client.libraryEntries({ subjectId }).get({
    query: libraryFullQuery(),
    headers: { authorization },
  });
  if (result.error || result.data == null)
    return { ok: false, reason: statusOf(result) === 404 ? 'missing' : 'unavailable' };
  return { ok: true, entry: presentEntry(result.data.libraryEntry) };
}

async function explainConflict(
  client: KernelClient,
  authorization: string,
  subjectId: string,
  result: { status?: number; error?: { status?: number; value?: unknown } | null },
): Promise<LibraryMutationResult | undefined> {
  if (statusOf(result) !== 409 || codeOf(result.error) !== 'conflict') return undefined;
  const reloaded = await reloadEntry(client, authorization, subjectId);
  if (!reloaded.ok) return reloaded;
  return { ok: false, reason: 'conflict', entry: reloaded.entry };
}

/** One session read and one revisioned state write. A stale revision reloads the entry and changes nothing. */
export async function changePersonalLibraryEntry(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: LibraryChangeInput,
): Promise<LibraryMutationResult> {
  try {
    const authorization = await bearer(request, sessionEnv);
    if (!authorization) return { ok: false, reason: 'signed-out' };
    const result = await client
      .libraryEntries({ subjectId: input.subjectId })
      .put(
        { state: input.state, revision: input.revision },
        { headers: writeHeaders(authorization, input.idempotencyKey) },
      );
    if (!result.error && result.data) {
      const saved = result.data.libraryEntry;
      return {
        ok: true,
        entry: {
          subjectId: saved.subjectId,
          state: saved.state,
          revision: saved.revision,
          updatedAt: saved.updatedAt,
        },
      };
    }
    const conflict = await explainConflict(client, authorization, input.subjectId, result);
    if (conflict) return conflict;
    if (statusOf(result) === 404) return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unavailable' };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}

/** One session read and one revisioned removal. A stale revision reloads the entry and leaves it in place. */
export async function removePersonalLibraryEntry(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: LibraryRemoveInput,
): Promise<LibraryMutationResult> {
  try {
    const authorization = await bearer(request, sessionEnv);
    if (!authorization) return { ok: false, reason: 'signed-out' };
    const result = await client.libraryEntries({ subjectId: input.subjectId }).delete(undefined, {
      query: { revision: input.revision },
      headers: writeHeaders(authorization, input.idempotencyKey),
    });
    const status = statusOf(result);
    if (!result.error && status !== undefined && status >= 200 && status < 300) return { ok: true };
    const conflict = await explainConflict(client, authorization, input.subjectId, result);
    if (conflict) return conflict;
    if (status === 404) return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unavailable' };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}
