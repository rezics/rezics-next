import type { KernelClient } from '@rezics/client';
import type { CoverSummary } from '@rezics/ui/cover';
import { notFound } from '@tanstack/react-router';
import { isPlatformClosedProblem, PlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { readSessionIdentity, type SessionIdentity } from '../session/state';

/** One rendered library list page. The kernel allows at most 100. */
export const LIBRARY_PAGE_LIMIT = 100;

/**
 * `typeLabel` is the type's name in the reader's language, once the page's server function has set it. `types` is the
 * subject's type chain for its cover frame, and `cover` is the cover summary the kernel embedded, or null.
 */
export type LibrarySubject = {
  id: string;
  type: string;
  types: string[];
  label: string;
  labelLanguage?: string;
  cover: CoverSummary | null;
  typeLabel?: string;
};
export type LibraryLabel = string | { value: string; language: string } | null;

/** Both subject summaries and collection/space targets present a plain display label. */
export function libraryLabel(label: LibraryLabel | undefined, fallback: string): string {
  return typeof label === 'string' ? label : (label?.value ?? fallback);
}
export type LibraryAccount = { handle: string | null; displayName: string | null };
export type CollectionVisibility = 'private' | 'public' | 'unlisted';

export type CollectionMember = {
  id: string;
  note: string | null;
  addedAt: string;
  subject: LibrarySubject | null;
};

export type CollectionPageData = {
  id: string;
  title: string;
  description: string | null;
  memberCount: number;
  updatedAt: string;
  curator: LibraryAccount | null;
  visibility: CollectionVisibility | null;
  members: CollectionMember[];
  next: string | null;
};

type LibraryResult<T> = { data?: T | null; error?: unknown; status?: number };
type RawAccount = { id?: string; handle: string | null; displayName: string | null };
type RawSubject = {
  id: string;
  type: string;
  types?: readonly string[];
  label: LibraryLabel;
  cover?: unknown;
};
type RawCollection = {
  id: string;
  curatorAccountId: string;
  title: string;
  description: string | null;
  visibility: CollectionVisibility;
  memberCount: number;
  updatedAt: string;
  curator?: RawAccount | null;
};
type RawMember = {
  id: string;
  subjectId?: string;
  note: string | null;
  addedAt: string;
  subject?: RawSubject | null;
};
type RawMemberPage = { members: RawMember[]; next: string | null };

export class StaleCursorError extends Error {
  constructor() {
    super('stale_cursor');
    this.name = 'StaleCursorError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusOf(result: LibraryResult<unknown>): number | undefined {
  if (typeof result.status === 'number') return result.status;
  if (isRecord(result.error) && typeof result.error.status === 'number') return result.error.status;
  return undefined;
}

function bodyOf(error: unknown): unknown {
  if (!isRecord(error)) return undefined;
  return isRecord(error.value) ? error.value : error;
}

/** FULL view for a single library record. */
export function libraryFullQuery(): { view: 'FULL' } {
  return { view: 'FULL' };
}

/** FULL view for one library list page, omitting a cursor the caller does not have. */
export function libraryListQuery(
  cursor?: string,
  limit = LIBRARY_PAGE_LIMIT,
): { view: 'FULL'; limit: number; cursor?: string } {
  return cursor ? { view: 'FULL', limit, cursor } : { view: 'FULL', limit };
}

/** Maps a library read: hidden and missing are not found, a reordered cursor is stale, and a closed gate stays closed. */
export function readLibraryResult<T>(result: LibraryResult<T>): T {
  const status = statusOf(result);
  const body = bodyOf(result.error);
  if (isPlatformClosedProblem(status, body)) throw new PlatformClosedError(status ?? 403, body);
  if (status === 404) throw notFound();
  if (status === 409 && isRecord(body) && body.code === 'stale_cursor') throw new StaleCursorError();
  if (result.error || status === undefined || status >= 400 || result.data == null) {
    throw new Error('Kernel library read failed');
  }
  return result.data;
}

function accountOf(account: RawAccount | null | undefined): LibraryAccount | null {
  if (!account) return null;
  return { handle: account.handle, displayName: account.displayName };
}

/** Maps an embedded subject, with the label the viewer sees or the id when there is none. */
export function subjectOf(subject: RawSubject | null | undefined): LibrarySubject | null {
  if (!subject) return null;
  return {
    id: subject.id,
    type: subject.type,
    types: subject.types?.length ? [...subject.types] : [subject.type],
    label: libraryLabel(subject.label, subject.id),
    labelLanguage: typeof subject.label === 'object' && subject.label !== null ? subject.label.language : undefined,
    cover: (subject.cover ?? null) as CoverSummary | null,
  };
}

async function readCollection(client: KernelClient, id: string): Promise<RawCollection> {
  const result = await client.collections({ collectionId: id }).get({ query: libraryFullQuery() });
  return readLibraryResult(result).collection;
}

async function readMembers(client: KernelClient, id: string, cursor?: string): Promise<RawMemberPage> {
  const result = await client.collections({ collectionId: id }).members.get({ query: libraryListQuery(cursor) });
  return readLibraryResult(result);
}

function present(identity: SessionIdentity, collection: RawCollection, members: RawMemberPage): CollectionPageData {
  const owner = identity.state === 'signed-in' && identity.subject === collection.curatorAccountId;
  return {
    id: collection.id,
    title: collection.title,
    description: collection.description,
    memberCount: collection.memberCount,
    updatedAt: collection.updatedAt,
    curator: accountOf(collection.curator),
    visibility: owner ? collection.visibility : null,
    members: members.members.map((member) => ({
      id: member.id,
      note: member.note,
      addedAt: member.addedAt,
      subject: subjectOf(member.subject),
    })),
    next: members.next,
  };
}

/** Reads one collection and one members page. A cursor the kernel no longer accepts restarts at the first page. */
export async function loadCollectionPage(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { id: string; cursor?: string },
): Promise<CollectionPageData> {
  const identityPromise = readSessionIdentity(request, sessionEnv);
  const collectionPromise = readCollection(client, input.id);
  const membersPromise = readMembers(client, input.id, input.cursor).then(
    (page) => ({ stale: false as const, page }),
    (error: unknown) => {
      if (error instanceof StaleCursorError) return { stale: true as const };
      throw error;
    },
  );
  const [identity, collection, membersResult] = await Promise.all([identityPromise, collectionPromise, membersPromise]);
  const members = membersResult.stale ? await readMembers(client, input.id) : membersResult.page;
  return present(identity, collection, members);
}
