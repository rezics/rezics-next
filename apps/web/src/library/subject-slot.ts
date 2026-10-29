import type { KernelClient } from '@rezics/client';
import { m } from '../paraglide/messages.js';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { configured, type SessionEnv } from '../session/client';
import { cookie, SESSION_COOKIE, validId } from '../session/cookies';
import { libraryEntryStates, type LibraryEntryStateWrite } from './entries-read';
import { libraryFullQuery, libraryListQuery, readLibraryResult } from './reads';

export const libraryEntryStatesWrite = libraryEntryStates;
export type { LibraryEntryStateWrite };
export type LibraryEntryStateRead = string;
export type SubjectSlotEntry = {
  subjectId: string;
  state: LibraryEntryStateRead;
  revision: number;
  incarnationId?: string | null;
};

export function subjectSlotStateLabel(state: LibraryEntryStateRead): string {
  if (state === 'planned') return m.library_subject_state_planned();
  if (state === 'in_progress') return m.library_subject_state_in_progress();
  if (state === 'completed') return m.library_subject_state_completed();
  if (state === 'paused') return m.library_subject_state_paused();
  if (state === 'dropped') return m.library_subject_state_dropped();
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
  | 'unavailable';
export type SubjectLibrarySlotData = {
  session: 'signed-in' | 'signed-out' | 'unavailable';
  csrfToken: string | null;
  entryAvailable: boolean;
  entry: SubjectSlotEntry | null;
  publicCollections: SubjectPublicCollection[] | null;
  publicCollectionsNext: string | null;
  collectionsLoaded: boolean;
  collections: SubjectSlotCollection[] | null;
  result?: SubjectLibrarySlotResult;
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
};
export type SubjectSlotCollectionsResult = {
  state: 'loaded' | 'closed' | 'unavailable';
  collections: SubjectSlotCollection[] | null;
};

type EntryResult = { libraryEntry: SubjectSlotEntry };
type PublicCollectionsResult = { collections: SubjectPublicCollection[]; next: string | null };
type CollectionsResult = { collections: SubjectSlotCollection[]; next: string | null };
type SlotSession =
  | { state: 'signed-in'; subject: string; csrfToken: string; authorization: string }
  | { state: 'signed-out' | 'unavailable'; csrfToken: null };

async function readSlotSession(request: Request, sessionEnv: Partial<SessionEnv>): Promise<SlotSession> {
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
): Promise<SubjectSlotEntry | null> {
  const result = await client.libraryEntries({ subjectId }).get({
    query: libraryFullQuery(),
    headers: { authorization },
  });
  if (result.status === 404) return null;
  const entry = readLibraryResult<EntryResult>(result as never).libraryEntry as SubjectSlotEntry;
  return entry;
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
  const identity = await readSlotSession(request, sessionEnv);
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
): Promise<SubjectLibrarySlotData> {
  const identityPromise = readSlotSession(request, sessionEnv);
  const publicPromise = readPublicCollections(client, subjectId).then(
    (page) => ({ available: true as const, ...page }),
    () => ({ available: false as const, collections: null, next: null }),
  );
  const [identity, publicResult] = await Promise.all([identityPromise, publicPromise]);
  let entryAvailable = false;
  let entry: SubjectSlotEntry | null = null;
  let collections: SubjectSlotCollection[] | null = null;
  let collectionsLoaded = false;
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
    const [entryResult, collectionResult] = await Promise.all([entryPromise, collectionPromise]);
    entryAvailable = entryResult.available;
    entry = entryResult.value;
    collectionsLoaded = collectionResult.loaded;
    collections = collectionResult.value;
  }
  const result =
    resultValue === 'added' ||
    resultValue === 'saved' ||
    resultValue === 'cleared' ||
    resultValue === 'collection-full' ||
    resultValue === 'conflict' ||
    resultValue === 'closed' ||
    resultValue === 'unavailable'
      ? resultValue
      : undefined;
  return {
    session: identity.state,
    csrfToken: identity.csrfToken,
    entryAvailable,
    entry,
    publicCollections: publicResult.available ? publicResult.collections : null,
    publicCollectionsNext: publicResult.next,
    collectionsLoaded,
    collections,
    ...(result ? { result } : {}),
  };
}
