import {
  libraryEntryStateWrite,
  libraryShelfType,
  shelfAddressIssues,
  shelfSort,
  type LibraryEntryStateWrite,
  type ShelfAddressField,
  type ShelfSort,
} from './shelf-params';
export { libraryEntryStateWrite, type LibraryEntryStateWrite } from './shelf-params';
import { captureEntryRestoreCredential, originalEntryRestoreCredential } from './entry-restore-credential';
import type { KernelClient } from '@rezics/client';
import { m } from '../paraglide/messages.js';
import type { Locale } from '../paraglide/runtime.js';
import { MediaProblem } from '../media/kernel';
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

export type LibraryEntryStateRead = string;

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
  lastActivityAt?: string;
  finishedAt?: string | null;
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
      type?: string;
      typeLabel?: string;
      state?: LibraryEntryStateWrite;
      stateLabel?: string;
      sort?: ShelfSort;
      sortExplicit?: boolean;
      cursorReset?: boolean;
      addressIssues?: ShelfAddressField[];
      readState?: 'closed' | 'denied' | 'preparing' | 'unavailable';
      entries: PersonalLibraryEntry[];
      next: string | null;
    };

export type SavedLibraryEntry = {
  subjectId: string;
  state: LibraryEntryStateRead;
  revision: number;
  incarnationId?: string | null;
  updatedAt: string;
  lastActivityAt?: string;
  finishedAt?: string | null;
};

export type ReloadedLibraryEntry = Omit<PersonalLibraryEntry, 'changeKey' | 'removeKey'>;

export type LibraryMutationResult =
  | {
      ok: true;
      entry?: SavedLibraryEntry;
      undo?: { deletionId: string; revision: number; idempotencyKey?: string; credential?: string };
    }
  | { ok: false; reason: 'conflict'; entry: ReloadedLibraryEntry }
  | {
      ok: false;
      reason: 'closed' | 'denied' | 'missing' | 'unavailable' | 'signed-out' | 'unsupported_library_profile';
    };

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

export type LibraryRestoreReceipt = {
  subjectId: string;
  deletionId: string;
  revision: number;
  idempotencyKey?: string;
  credential?: string;
};
export type LibraryRestoreInput = LibraryRestoreReceipt & { idempotencyKey: string };
const restoreKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateLibraryRestoreInput(input: unknown): LibraryRestoreInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid library restore');
  const value = input as Record<string, unknown>;
  if (
    typeof value.subjectId !== 'string' ||
    !value.subjectId ||
    value.subjectId.length > 128 ||
    typeof value.deletionId !== 'string' ||
    !value.deletionId ||
    value.deletionId.length > 128 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    typeof value.idempotencyKey !== 'string' ||
    !restoreKeyPattern.test(value.idempotencyKey) ||
    (value.credential !== undefined &&
      (typeof value.credential !== 'string' || !/^[A-Za-z0-9_-]{1,3200}$/.test(value.credential)))
  )
    throw new Error('Invalid library restore');
  return {
    subjectId: value.subjectId,
    deletionId: value.deletionId,
    revision: value.revision as number,
    idempotencyKey: value.idempotencyKey,
    ...(value.credential ? { credential: value.credential as string } : {}),
  };
}
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
  lastActivityAt?: string;
  finishedAt?: string | null;
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
    ...(entry.lastActivityAt === undefined ? {} : { lastActivityAt: entry.lastActivityAt }),
    ...(entry.finishedAt === undefined ? {} : { finishedAt: entry.finishedAt }),
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
  if (await prepareSession(request, sessionEnv)) return null;
  return viewerCredential(request);
}

class ShelfPageUnavailableError extends Error {
  constructor(readonly state: 'denied' | 'preparing' | 'unavailable') {
    super('Library shelf unavailable');
  }
}

export class InvalidShelfAddressError extends Error {
  constructor(readonly fields: ShelfAddressField[]) {
    super('Invalid library shelf address');
  }
}

/** One FULL bounded page. Omitting sort retains the historical update-order query for other callers. */
export async function readEntryPage(
  client: KernelClient,
  authorization: string,
  cursor: string | undefined,
  state: LibraryEntryStateWrite | undefined,
  limit?: number,
  sort?: ShelfSort,
  type?: string,
) {
  const addressIssues = shelfAddressIssues({ type, state, cursor });
  if (addressIssues.length) throw new InvalidShelfAddressError(addressIssues);
  const result = await client.libraryEntries.get({
    query: { ...libraryListQuery(cursor, limit), ...(state ? { state } : {}), ...sort, ...(type ? { type } : {}) },
    headers: { authorization },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  if (sort) {
    const status = statusOf(result);
    const code = codeOf(result.error);
    if (status === 400 && code === 'invalid_cursor') throw new StaleCursorError();
    if (status === 403 && code !== 'platform_closed') throw new ShelfPageUnavailableError('denied');
    if (status === 503)
      throw new ShelfPageUnavailableError(code === 'dependency_unavailable' ? 'preparing' : 'unavailable');
  }
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
 * kernel no longer accepts restarts the selected view at its first page and marks that recovery for the route.
 */
export async function loadPersonalLibrary(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: {
    type?: string;
    state?: string;
    cursor?: string;
    orderBy?: ShelfSort['orderBy'];
    direction?: ShelfSort['direction'];
  },
): Promise<PersonalLibraryView> {
  if (await prepareSession(request, sessionEnv)) return { signedIn: false };
  const authorization = viewerCredential(request);
  if (!authorization) return { signedIn: false };
  const addressIssues = shelfAddressIssues(input);
  const state = libraryEntryStateWrite(input.state);
  const type = libraryShelfType(input.type);
  const sort = shelfSort({
    ...(state ? { state } : {}),
    ...(input.orderBy ? { orderBy: input.orderBy } : {}),
    ...(input.direction ? { direction: input.direction } : {}),
  });
  const sortExplicit = input.orderBy !== undefined || input.direction !== undefined;
  if (addressIssues.length) {
    return {
      signedIn: true,
      ...(type ? { type } : {}),
      ...(state ? { state } : {}),
      sort,
      sortExplicit,
      addressIssues,
      entries: [],
      next: null,
    };
  }
  let cursorReset = false;
  let page: Awaited<ReturnType<typeof readEntryPage>>;
  try {
    try {
      page = await readEntryPage(client, authorization, input.cursor, state, 20, sort, type);
    } catch (error) {
      if (!(error instanceof StaleCursorError) || !input.cursor) throw error;
      cursorReset = true;
      page = await readEntryPage(client, authorization, undefined, state, 20, sort, type);
    }
  } catch (error) {
    const readState = isPlatformClosedError(error)
      ? 'closed'
      : error instanceof ShelfPageUnavailableError
        ? error.state
        : undefined;
    if (!readState) throw error;
    return {
      signedIn: true,
      ...(type ? { type } : {}),
      ...(state ? { state } : {}),
      sort,
      sortExplicit,
      readState,
      entries: [],
      next: null,
    };
  }
  return {
    signedIn: true,
    ...(type ? { type } : {}),
    ...(state ? { state } : {}),
    sort,
    sortExplicit,
    ...(cursorReset ? { cursorReset: true } : {}),
    entries: presentShelfEntries(page.libraryEntries),
    next: page.next,
  };
}

async function reloadEntry(
  client: KernelClient,
  authorization: string,
  subjectId: string,
): Promise<
  | { ok: true; entry: ReloadedLibraryEntry }
  | { ok: false; reason: 'missing' | 'unavailable' | 'signed-out' | 'closed' | 'denied' }
> {
  const result = await client.libraryEntries({ subjectId }).get({
    query: libraryFullQuery(),
    headers: { authorization },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  if (result.error || result.data == null) {
    const status = statusOf(result);
    return {
      ok: false,
      reason:
        status === 404
          ? 'missing'
          : status === 401
            ? 'signed-out'
            : status === 403
              ? codeOf(result.error) === 'platform_closed'
                ? 'closed'
                : 'denied'
              : 'unavailable',
    };
  }
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
      if (
        !saved ||
        saved.subjectId !== input.subjectId ||
        saved.state !== input.state ||
        !Number.isSafeInteger(saved.revision) ||
        saved.revision < 1 ||
        typeof saved.updatedAt !== 'string'
      )
        return { ok: false, reason: 'unavailable' };
      return {
        ok: true,
        entry: {
          subjectId: saved.subjectId,
          state: saved.state,
          revision: saved.revision,
          ...(saved.incarnationId === undefined ? {} : { incarnationId: saved.incarnationId }),
          updatedAt: saved.updatedAt,
          ...(saved.lastActivityAt === undefined ? {} : { lastActivityAt: saved.lastActivityAt }),
          ...(saved.finishedAt === undefined ? {} : { finishedAt: saved.finishedAt }),
        },
      };
    }
    const conflict = await explainConflict(client, authorization, input.subjectId, result);
    if (conflict) return conflict;
    if (statusOf(result) === 404) return { ok: false, reason: 'missing' };
    if (statusOf(result) === 401) return { ok: false, reason: 'signed-out' };
    if (statusOf(result) === 403)
      return { ok: false, reason: codeOf(result.error) === 'platform_closed' ? 'closed' : 'denied' };
    if (statusOf(result) === 422 && codeOf(result.error) === 'unsupported_library_profile')
      return { ok: false, reason: 'unsupported_library_profile' };
    return { ok: false, reason: 'unavailable' };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    if (error instanceof MediaProblem && error.problem.status === 403) return { ok: false, reason: 'denied' };
    if (error instanceof MediaProblem && error.problem.status === 401) return { ok: false, reason: 'signed-out' };
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
      if (!deletionId || !Number.isSafeInteger(revision) || revision < 1) return { ok: true };
      const credential = await captureEntryRestoreCredential(request, sessionEnv);
      return {
        ok: true,
        undo: { deletionId, revision, idempotencyKey: crypto.randomUUID(), ...(credential ? { credential } : {}) },
      };
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
  input = validateLibraryRestoreInput(input);
  try {
    if (!(await bearer(request, sessionEnv))) return { ok: false, reason: 'signed-out' };
    const authorization = await originalEntryRestoreCredential(request, sessionEnv, input.credential);
    if (!authorization) return { ok: false, reason: 'signed-out' };
    const result = await client
      .libraryEntries({ subjectId: input.subjectId })
      .$restore.post(
        { deletionId: input.deletionId, revision: input.revision },
        { headers: writeHeaders(authorization, input.idempotencyKey) },
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
