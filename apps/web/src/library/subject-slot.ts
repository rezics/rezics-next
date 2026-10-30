import type { LibraryRestoreInput, LibraryRestoreResult } from './entries-read';
import type { KernelClient } from '@rezics/client';
import { m } from '../paraglide/messages.js';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { configured, type SessionEnv } from '../session/client';
import { cookie, SESSION_COOKIE, validId } from '../session/cookies';
import { type LibraryEntryStateWrite } from './entries-read';
import { libraryStateLabel, libraryStateOptions, type LibraryStateChoice } from './profiles';
import { readRelease } from '../subject/definitions';
import { requestLocale } from '../kernel/client';
import { libraryFullQuery, libraryListQuery, readLibraryResult } from './reads';
import { readSubjectLabelAssignments, type SubjectLabel } from './subject-labels.ts';

export type { LibraryEntryStateWrite };
export type LibraryEntryStateRead = string;
export type SubjectSlotEntry = {
  subjectId: string;
  state: LibraryEntryStateRead;
  revision: number;
  incarnationId?: string | null;
};

export function subjectSlotStateLabel(_state: LibraryEntryStateRead): string {
  return m.library_other();
}
export type SubjectSlotCollection = {
  id: string;
  curatorAccountId: string;
  title: string;
  memberCount: number;
  curator: { id: string; handle: string | null; displayName: string | null } | null;
};
export type SubjectPublicCollection = {
  id: string;
  curatorAccountId: string;
  title: string;
  multiplicity: number;
  curator: { id: string; handle: string | null; displayName: string | null } | null;
};
export type SubjectLibrarySlotResult =
  | 'added'
  | 'saved'
  | 'cleared'
  | 'collection-full'
  | 'conflict'
  | 'closed'
  | 'unsupported_library_profile'
  | 'unavailable'
  | 'label-capacity'
  | 'label-restore-stale'
  | 'label-restore-expired'
  | 'label-restore-occupied'
  | 'label-restore-capacity'
  | 'label-removed';
export type SubjectLabelUndo = { labelId: string; assignmentId: string; revision: number };
export type SubjectLibrarySlotData = {
  session: 'signed-in' | 'signed-out' | 'unavailable';
  csrfToken: string | null;
  entryAvailable: boolean;
  entry: SubjectSlotEntry | null;
  stateOptions?: LibraryStateChoice[];
  entryStateLabel?: string;
  publicCollections: SubjectPublicCollection[] | null;
  publicCollectionsNext: string | null;
  collectionsLoaded: boolean;
  collections: SubjectSlotCollection[] | null;
  labels: SubjectLabel[] | null;
  labelUndo?: SubjectLabelUndo;
  labelResult?: SubjectLibrarySlotResult;
  result?: SubjectLibrarySlotResult;
  undo?: LibraryRestoreInput;
  restore?: LibraryRestoreResult;
};

export type SubjectLibraryMutation = {
  subjectId: string;
  intent: 'entry' | 'member';
  action?: 'save' | 'clear';
  state?: LibraryEntryStateWrite;
  revision?: number;
  incarnationId?: string | null;
  collectionId?: string;
  idempotencyKey: string;
};
export type SubjectLibraryMutationResponse = {
  result: SubjectLibrarySlotResult;
  entry?: SubjectSlotEntry | null;
  undo?: { deletionId: string; revision: number };
};
export type SubjectSlotCollectionsResult = {
  state: 'loaded' | 'closed' | 'unavailable';
  collections: SubjectSlotCollection[] | null;
};

type EntryResult = { libraryEntry: SubjectSlotEntry & { subject?: { type?: string } | null } };
type PublicCollectionsResult = { collections: SubjectPublicCollection[]; next: string | null };
type CollectionsResult = { collections: SubjectSlotCollection[]; next: string | null };
export type SubjectSlotSession =
  | { state: 'signed-in'; subject: string; csrfToken: string; authorization: string }
  | { state: 'signed-out' | 'unavailable'; csrfToken: null };

export async function readSubjectSlotSession(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<SubjectSlotSession> {
  if (!configured(sessionEnv)) return { state: 'unavailable', csrfToken: null };
  const id = cookie(request, SESSION_COOKIE);
  if (!validId(id)) return { state: 'signed-out', csrfToken: null };
  try {
    const credential = await sessionEnv.SESSIONS.get(sessionEnv.SESSIONS.idFromName(id)).credential();
    if (credential.status === 'absent') return { state: 'signed-out', csrfToken: null };
    if (credential.status !== 'active') return { state: 'unavailable', csrfToken: null };
    return {
      state: 'signed-in',
      subject: credential.subject,
      csrfToken: credential.csrfToken,
      authorization: `Bearer ${credential.accessToken}`,
    };
  } catch {
    return { state: 'unavailable', csrfToken: null };
  }
}

async function readEntry(
  client: KernelClient,
  subjectId: string,
  authorization: string,
): Promise<(SubjectSlotEntry & { subject?: { type?: string } | null }) | null> {
  const result = await client.libraryEntries({ subjectId }).get({
    query: libraryFullQuery(),
    headers: { authorization },
  });
  if (result.status === 404) return null;
  return readLibraryResult<EntryResult>(result as never).libraryEntry;
}

async function readPublicCollections(client: KernelClient, subjectId: string): Promise<PublicCollectionsResult> {
  const result = await client.subjects({ id: subjectId }).collections.get({ query: libraryListQuery() });
  return readLibraryResult<PublicCollectionsResult>(result as never);
}

async function readCollections(
  client: KernelClient,
  accountId: string,
  authorization: string,
): Promise<SubjectSlotCollection[]> {
  const result = await client.collections.get({
    query: { ...libraryListQuery(), curatorAccountId: accountId },
    headers: { authorization },
  });
  return readLibraryResult<CollectionsResult>(result as never).collections;
}

/** Reads the viewer's first collections page for the add menu. */
export async function loadSubjectLibraryCollections(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<SubjectSlotCollectionsResult> {
  const identity = await readSubjectSlotSession(request, sessionEnv);
  if (identity.state !== 'signed-in') return { state: 'unavailable', collections: null };
  try {
    return {
      state: 'loaded',
      collections: await readCollections(client, identity.subject, identity.authorization),
    };
  } catch (error) {
    return { state: isPlatformClosedError(error) ? 'closed' : 'unavailable', collections: null };
  }
}

/** Reads the entry and public collection page alongside the subject template read. */
export async function loadSubjectLibrarySlot(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  subjectId: string,
  loadCollections = false,
  resultValue?: string,
  labelResultValue?: string,
  labelUndo?: SubjectLabelUndo,
  subjectType?: string,
): Promise<SubjectLibrarySlotData> {
  const identityPromise = readSubjectSlotSession(request, sessionEnv);
  const publicPromise = readPublicCollections(client, subjectId).then(
    (page) => ({ available: true as const, ...page }),
    () => ({ available: false as const, collections: null, next: null }),
  );
  const [identity, publicResult] = await Promise.all([identityPromise, publicPromise]);
  let entryAvailable = false;
  let entry: SubjectSlotEntry | null = null;
  let entryType = subjectType;
  let stateOptions: LibraryStateChoice[] = [];
  let entryStateLabel: string | undefined;
  let collections: SubjectSlotCollection[] | null = null;
  let collectionsLoaded = false;
  let labels: SubjectLabel[] | null = null;
  if (identity.state === 'signed-in') {
    const entryPromise = readEntry(client, subjectId, identity.authorization).then(
      (value) => ({ available: true as const, value }),
      () => ({ available: false as const, value: null }),
    );
    const collectionPromise =
      loadCollections && identity.subject
        ? readCollections(client, identity.subject, identity.authorization).then(
            (value) => ({ loaded: true as const, value }),
            () => ({ loaded: false as const, value: null }),
          )
        : Promise.resolve({ loaded: false as const, value: null });
    const labelsPromise = client.platform.exposure
      .get({ headers: { authorization: identity.authorization } })
      .then((result) => result.data?.admitted?.includes('library_label.assignment_list') ?? false)
      .catch(() => false)
      .then((allowed) =>
        allowed ? readSubjectLabelAssignments(client, subjectId, identity.authorization).catch(() => null) : null,
      );
    const [entryResult, collectionResult, labelsResult] = await Promise.all([
      entryPromise,
      collectionPromise,
      labelsPromise,
    ]);
    entryAvailable = entryResult.available;
    entry = entryResult.value;
    entryType ??= entryResult.value?.subject?.type;
    if (entryType) {
      const release = await readRelease().catch(() => undefined);
      if (release) {
        const locale = requestLocale() ?? 'en';
        stateOptions = libraryStateOptions(release, entryType, locale);
        if (entry)
          entryStateLabel = libraryStateLabel(release, entryType, entry.state, locale)?.text ?? m.library_other();
      }
    }
    collectionsLoaded = collectionResult.loaded;
    collections = collectionResult.value;
    labels = labelsResult;
  }
  const result =
    resultValue === 'added' ||
    resultValue === 'saved' ||
    resultValue === 'cleared' ||
    resultValue === 'collection-full' ||
    resultValue === 'conflict' ||
    resultValue === 'closed' ||
    resultValue === 'unsupported_library_profile' ||
    resultValue === 'unavailable' ||
    resultValue === 'label-capacity' ||
    resultValue === 'label-restore-stale' ||
    resultValue === 'label-restore-expired' ||
    resultValue === 'label-restore-occupied' ||
    resultValue === 'label-restore-capacity' ||
    resultValue === 'label-removed'
      ? resultValue
      : undefined;
  const labelResult =
    labelResultValue === 'label-capacity' ||
    labelResultValue === 'label-restore-stale' ||
    labelResultValue === 'label-restore-expired' ||
    labelResultValue === 'label-restore-occupied' ||
    labelResultValue === 'label-restore-capacity' ||
    labelResultValue === 'label-removed' ||
    labelResultValue === 'closed' ||
    labelResultValue === 'unavailable'
      ? labelResultValue
      : undefined;
  return {
    session: identity.state,
    csrfToken: identity.csrfToken,
    entryAvailable,
    entry,
    stateOptions,
    ...(entryStateLabel === undefined ? {} : { entryStateLabel }),
    publicCollections: publicResult.available ? publicResult.collections : null,
    publicCollectionsNext: publicResult.next,
    collectionsLoaded,
    collections,
    labels,
    ...(labelUndo ? { labelUndo } : {}),
    ...(labelResult ? { labelResult } : {}),
    ...(result ? { result } : {}),
  };
}
