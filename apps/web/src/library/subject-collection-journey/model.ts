import { libraryListQuery } from '../reads';

/** Installed `pageQuery` default; native cap is 100. */
export const SUBJECT_COLLECTION_PAGE_LIMIT = 20;
/** Installed Collection and subject-collection cursor cap. */
export const SUBJECT_COLLECTION_CURSOR_MAX_LENGTH = 4_096;

export type ExactPublicCount = { kind: 'exact'; value: number } | { kind: 'unknown' };

export type PublicCollectionRow = {
  id: string;
  curatorAccountId: string;
  title: string;
  multiplicity: number;
  curator: { id: string; handle: string | null; displayName: string | null } | null;
};

export type ChooserCollectionRow = {
  id: string;
  curatorAccountId: string;
  title: string;
  memberCount: number;
  curator: { id: string; handle: string | null; displayName: string | null } | null;
  membershipKind?: 'curated' | 'dynamic';
  builtinKind?: string;
  visibility?: 'private' | 'public' | 'unlisted';
};

export type SubjectCollectionVisit = Readonly<{
  cursor: string | undefined;
  previousCursor: string | undefined;
  page: number;
  canGoPrevious: boolean;
}>;

export type BoundCollectionPage<T> = Readonly<{
  rows: readonly T[];
  next: string | null;
  count?: ExactPublicCount;
  visit: SubjectCollectionVisit;
  generation: number;
}>;

export type CapturedChooserTarget = Readonly<{ id: string; title: string }>;

export function firstCollectionVisit(): SubjectCollectionVisit {
  return { cursor: undefined, previousCursor: undefined, page: 1, canGoPrevious: false };
}

export function nextCollectionVisit(visit: SubjectCollectionVisit, frontier: string | null): SubjectCollectionVisit {
  const cursor = collectionCursor(frontier);
  if (!cursor) throw new Error('Invalid subject collection frontier');
  return { cursor, previousCursor: visit.cursor, page: visit.page + 1, canGoPrevious: true };
}

export function previousCollectionVisit(visit: SubjectCollectionVisit): SubjectCollectionVisit | null {
  if (!visit.canGoPrevious) return null;
  const page = visit.page - 1;
  return page === 1
    ? firstCollectionVisit()
    : { cursor: visit.previousCursor, previousCursor: undefined, page, canGoPrevious: false };
}

export function collectionCursor(input: unknown): string | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input !== 'string' || input.length > SUBJECT_COLLECTION_CURSOR_MAX_LENGTH)
    throw new Error('Invalid subject collection cursor');
  return input;
}

export function collectionFrontier(input: unknown): string | null {
  if (input === null || input === undefined || input === '') return null;
  return collectionCursor(input) ?? null;
}

export function publicCountOf(input: unknown): ExactPublicCount {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { kind: 'unknown' };
  const value = input as { value?: unknown; exact?: unknown };
  if (value.exact !== true || !Number.isSafeInteger(value.value) || (value.value as number) < 0)
    return { kind: 'unknown' };
  return { kind: 'exact', value: value.value as number };
}

export function subjectCollectionListQuery(cursor?: string) {
  return libraryListQuery(cursor, SUBJECT_COLLECTION_PAGE_LIMIT);
}

export function isCuratedWriteDestination(row: {
  membershipKind?: string;
  builtinKind?: unknown;
  memberCount?: unknown;
}): boolean {
  if (row.membershipKind === 'dynamic' || typeof row.builtinKind === 'string') return false;
  if (row.membershipKind === 'curated') return true;
  return row.membershipKind === undefined && typeof row.memberCount === 'number';
}

export function emptyCollectionPage<T>(generation = 0): BoundCollectionPage<T> {
  return { rows: [], next: null, visit: firstCollectionVisit(), generation };
}

export function replaceCollectionPage<T>(
  current: BoundCollectionPage<T> | undefined,
  rows: readonly T[],
  next: string | null,
  visit: SubjectCollectionVisit,
  count?: ExactPublicCount,
): BoundCollectionPage<T> {
  return {
    rows,
    next,
    visit,
    generation: (current?.generation ?? 0) + 1,
    ...(count ? { count } : {}),
  };
}

export function curatorOf(input: unknown): PublicCollectionRow['curator'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as { id?: unknown; handle?: unknown; displayName?: unknown };
  if (typeof value.id !== 'string' || !value.id) return null;
  return {
    id: value.id,
    handle: typeof value.handle === 'string' ? value.handle : null,
    displayName: typeof value.displayName === 'string' ? value.displayName : null,
  };
}

export function projectPublicCollection(row: unknown): PublicCollectionRow | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const value = row as Record<string, unknown>;
  if (typeof value.id !== 'string' || !value.id || typeof value.title !== 'string') return null;
  if (!Number.isSafeInteger(value.multiplicity) || (value.multiplicity as number) < 1) return null;
  return {
    id: value.id,
    curatorAccountId: typeof value.curatorAccountId === 'string' ? value.curatorAccountId : '',
    title: value.title,
    multiplicity: value.multiplicity as number,
    curator: curatorOf(value.curator),
  };
}

export function projectChooserCollection(row: unknown): ChooserCollectionRow | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const value = row as Record<string, unknown>;
  if (typeof value.id !== 'string' || !value.id) return null;
  const title = typeof value.title === 'string' ? value.title : value.id;
  const membershipKind =
    value.membershipKind === 'curated' || value.membershipKind === 'dynamic' ? value.membershipKind : undefined;
  const visibility =
    value.visibility === 'private' || value.visibility === 'public' || value.visibility === 'unlisted'
      ? value.visibility
      : undefined;
  return {
    id: value.id,
    curatorAccountId: typeof value.curatorAccountId === 'string' ? value.curatorAccountId : '',
    title,
    memberCount:
      typeof value.memberCount === 'number' && Number.isSafeInteger(value.memberCount) ? value.memberCount : 0,
    curator: curatorOf(value.curator),
    ...(membershipKind ? { membershipKind } : {}),
    ...(typeof value.builtinKind === 'string' ? { builtinKind: value.builtinKind } : {}),
    ...(visibility ? { visibility } : {}),
  };
}

export function projectPublicPage(page: unknown): {
  collections: PublicCollectionRow[];
  next: string | null;
  count: ExactPublicCount;
} {
  if (!page || typeof page !== 'object' || Array.isArray(page))
    throw new Error('Kernel library read failed');
  const value = page as { collections?: unknown; next?: unknown; count?: unknown };
  if (!Array.isArray(value.collections)) throw new Error('Kernel library read failed');
  return {
    collections: value.collections.flatMap((row) => {
      const projected = projectPublicCollection(row);
      return projected ? [projected] : [];
    }),
    next: collectionFrontier(value.next),
    count: publicCountOf(value.count),
  };
}

export function projectChooserPage(page: unknown): { collections: ChooserCollectionRow[]; next: string | null } {
  if (!page || typeof page !== 'object' || Array.isArray(page))
    throw new Error('Kernel library read failed');
  const value = page as { collections?: unknown; next?: unknown };
  if (!Array.isArray(value.collections)) throw new Error('Kernel library read failed');
  return {
    collections: value.collections.flatMap((row) => {
      const projected = projectChooserCollection(row);
      return projected ? [projected] : [];
    }),
    next: collectionFrontier(value.next),
  };
}

export function collectionReadFailure(error: unknown): 'expired' | 'closed' | 'unavailable' {
  const value = error as { name?: unknown; message?: unknown } | null;
  if (value?.name === 'StaleCursorError' || (typeof value?.message === 'string' && value.message.includes('stale_cursor')))
    return 'expired';
  if (typeof value?.message === 'string' && (value.message.includes('closed') || value.message.includes('PlatformClosed')))
    return 'closed';
  return 'unavailable';
}
