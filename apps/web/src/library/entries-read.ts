import type { KernelClient } from '@rezics/client';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import type { ProgressLabelInput } from './progress-label';
import { libraryAnyStateLabel, libraryStateLabel, libraryStateOptions, type LibraryStateChoice } from './profiles';
import type { Release } from '../subject/definitions.ts';
import { prepareSession, viewerCredential } from '../session/request';
import {
  libraryFullQuery,
  libraryListQuery,
  readLibraryResult,
  StaleCursorError,
  subjectOf,
  type LibrarySubject,
} from './reads';

export type LibraryEntryStateWrite = string;
export type LibraryEntryStateRead = string;

const entryStateId = /^[a-z][a-z0-9_.-]{0,63}$(?![\s\S])/;

export function libraryEntryStateWrite(value: string | undefined): LibraryEntryStateWrite | undefined {
  return value !== undefined && entryStateId.test(value) ? value : undefined;
}

export function libraryEntryStateLabel(state: LibraryEntryStateRead, locale?: string): string {
  return locale === undefined ? m.library_other() : m.library_other({}, { locale: locale as Locale });
}

export type PersonalLibraryEntry = {
  subjectId: string;
  state: LibraryEntryStateRead;
  revision: number;
  incarnationId?: string | null;
  createdAt: string;
  updatedAt: string;
  stateLabel?: string;
  stateOptions?: LibraryStateChoice[];
  activeProgressSession?: ProgressLabelInput | null;
  subject: LibrarySubject | null;
  changeKey: string;
  removeKey: string;
};

export type PersonalLibraryView =
  | { signedIn: false }
  | {
      signedIn: true;
      state?: LibraryEntryStateWrite;
      stateLabel?: string;
      entries: PersonalLibraryEntry[];
      next: string | null;
    };

export type SavedLibraryEntry = {
  subjectId: string;
  state: LibraryEntryStateRead;
  revision: number;
  incarnationId?: string | null;
  updatedAt: string;
};

export type ReloadedLibraryEntry = Omit<PersonalLibraryEntry, 'changeKey' | 'removeKey'>;

export type LibraryMutationResult =
  | { ok: true; entry?: SavedLibraryEntry; undo?: { deletionId: string; revision: number } }
  | { ok: false; reason: 'conflict'; entry: ReloadedLibraryEntry }
  | { ok: false; reason: 'closed' | 'missing' | 'unavailable' | 'signed-out' | 'unsupported_library_profile' };

export type LibraryChangeInput = {
  subjectId: string;
  state: LibraryEntryStateWrite;
  revision?: number;
  incarnationId?: string | null;
  idempotencyKey: string;
};

export type LibraryRemoveInput = {
  subjectId: string;
  revision: number;
  incarnationId?: string | null;
  idempotencyKey: string;
};

export type LibraryRestoreInput = { subjectId: string; deletionId: string; revision: number };
export type LibraryRestoreResult =
  | { ok: true; entry: ReloadedLibraryEntry }
  | { ok: false; reason: 'occupied'; entry?: ReloadedLibraryEntry }
  | { ok: false; reason: 'stale' | 'expired' | 'closed' | 'unavailable' | 'signed-out' };

type RawEntry = {
  subjectId: string;
  state: LibraryEntryStateRead;
  revision: number;
  incarnationId?: string | null;
  createdAt: string;
  updatedAt: string;
  activeProgressSession?: ProgressLabelInput | null;
  subject?: Parameters<typeof subjectOf>[0];
};

function presentEntry(entry: RawEntry): ReloadedLibraryEntry {
  return {
    subjectId: entry.subjectId,
    state: entry.state,
    revision: entry.revision,
    ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    activeProgressSession: entry.activeProgressSession ?? null,
    subject: subjectOf(entry.subject),
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
  return { authorization, 'idempotency-key': idempotencyKey };
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
  state: LibraryEntryStateWrite | undefined,
  limit?: number,
) {
  const result = await client.libraryEntries.get({
    query: { ...libraryListQuery(cursor, limit), ...(state ? { state } : {}) },
    headers: { authorization },
  });
  return readLibraryResult(result);
}

function presentShelfEntries(rows: RawEntry[]): PersonalLibraryEntry[] {
  return rows.map((entry) => ({
    ...presentEntry(entry),
    changeKey: crypto.randomUUID(),
    removeKey: crypto.randomUUID(),
  }));
}

/** Add profile-owned labels and ordered choices after the exact-ID kernel page has been read. */
export function presentLibraryStateLabels(
  view: PersonalLibraryView,
  release: Release | undefined,
  locale: string,
): PersonalLibraryView {
  if (!view.signedIn) return view;
  const other = libraryEntryStateLabel('', locale);
  return {
    ...view,
    ...(view.state
      ? { stateLabel: release ? (libraryAnyStateLabel(release, view.state, locale)?.text ?? other) : other }
      : {}),
    entries: view.entries.map((entry) => {
      const type = entry.subject?.type;
      const stateLabel = release && type ? libraryStateLabel(release, type, entry.state, locale)?.text : undefined;
      const stateOptions = release && type ? libraryStateOptions(release, type, locale) : [];
      return {
        ...entry,
        stateLabel: stateLabel ?? other,
        stateOptions,
      };
    }),
  };
}

/**
 * One session read and one bounded page of tracked entries, optionally filtered by an exact state. A cursor the
 * kernel no longer accepts restarts the selected view at its first page.
 */
export async function loadPersonalLibrary(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { state?: string; cursor?: string },
): Promise<PersonalLibraryView> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  if (!authorization) return { signedIn: false };
  const state = libraryEntryStateWrite(input.state);
  let page: Awaited<ReturnType<typeof readEntryPage>>;
  try {
    page = await readEntryPage(client, authorization, input.cursor, state);
  } catch (error) {
    if (!(error instanceof StaleCursorError) || !input.cursor) throw error;
    page = await readEntryPage(client, authorization, undefined, state);
  }
  return {
    signedIn: true,
    ...(state ? { state } : {}),
    entries: presentShelfEntries(page.libraryEntries),
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
  return { ok: true, entry: presentEntry((result.data as { libraryEntry: RawEntry }).libraryEntry) };
}

async function explainConflict(
  client: KernelClient,
  authorization: string,
  subjectId: string,
  result: { status?: number; error?: { status?: number; value?: unknown } | null },
): Promise<LibraryMutationResult | undefined> {
  if (statusOf(result) !== 409) return undefined;
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
    const result = await client.libraryEntries({ subjectId: input.subjectId }).put(
      {
        state: input.state,
        ...(input.revision === undefined ? {} : { revision: input.revision }),
        ...(typeof input.incarnationId === 'string' ? { incarnationId: input.incarnationId } : {}),
      },
      { headers: writeHeaders(authorization, input.idempotencyKey) },
    );
    if (!result.error && result.data) {
      const saved = (result.data as { libraryEntry: RawEntry }).libraryEntry;
      return {
        ok: true,
        entry: {
          subjectId: saved.subjectId,
          state: saved.state,
          revision: saved.revision,
          ...(saved.incarnationId === undefined ? {} : { incarnationId: saved.incarnationId }),
          updatedAt: saved.updatedAt,
        },
      };
    }
    const conflict = await explainConflict(client, authorization, input.subjectId, result);
    if (conflict) return conflict;
    if (statusOf(result) === 404) return { ok: false, reason: 'missing' };
    if (statusOf(result) === 422 && codeOf(result.error) === 'unsupported_library_profile')
      return { ok: false, reason: 'unsupported_library_profile' };
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
      query: {
        revision: input.revision,
        ...(typeof input.incarnationId === 'string' ? { incarnationId: input.incarnationId } : {}),
      },
      headers: writeHeaders(authorization, input.idempotencyKey),
    });
    const status = statusOf(result);
    if (!result.error && status !== undefined && status >= 200 && status < 300) {
      const headers = (result as typeof result & { response?: Response }).response?.headers;
      const deletionId = headers?.get('Library-Entry-Deletion-Id');
      const revision = Number(headers?.get('Library-Entry-Deletion-Revision'));
      return deletionId && Number.isSafeInteger(revision) && revision > 0
        ? { ok: true, undo: { deletionId, revision } }
        : { ok: true };
    }
    const conflict = await explainConflict(client, authorization, input.subjectId, result);
    if (conflict) return conflict;
    if (status === 404) return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unavailable' };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}

/** Restores with the exact deletion receipt and uses the response body as the rendered entry. */
export async function restorePersonalLibraryEntry(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: LibraryRestoreInput,
): Promise<LibraryRestoreResult> {
  try {
    const authorization = await bearer(request, sessionEnv);
    if (!authorization) return { ok: false, reason: 'signed-out' };
    const result = await client
      .libraryEntries({ subjectId: input.subjectId })
      .$restore.post(
        { deletionId: input.deletionId, revision: input.revision },
        { headers: writeHeaders(authorization, crypto.randomUUID()) },
      );
    if (!result.error && result.data?.libraryEntry) return { ok: true, entry: presentEntry(result.data.libraryEntry) };
    const code = codeOf(result.error);
    if (statusOf(result) === 409 && code === 'library_entry_restore_occupied') {
      try {
        const current = await reloadEntry(client, authorization, input.subjectId);
        return current.ok ? { ok: false, reason: 'occupied', entry: current.entry } : { ok: false, reason: 'occupied' };
      } catch {
        return { ok: false, reason: 'occupied' };
      }
    }
    if (statusOf(result) === 409 && code === 'library_entry_restore_stale') return { ok: false, reason: 'stale' };
    if (statusOf(result) === 409 && code === 'library_entry_restore_expired') return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'unavailable' };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}
