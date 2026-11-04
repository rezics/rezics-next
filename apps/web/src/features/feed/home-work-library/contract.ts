import type { ReactNode } from 'react';
import type { FeedItem } from '../../pages/home-feed-read';
import type { SubjectOwnRating } from '../../pages/subject-ratings';
import type { SubjectSlotEntry } from '../../../library/subject-slot';

/** Commerce's admitted facts page supports 100 rows; Home admits at most two continuations. */
export const HOME_WORK_LIBRARY_PAGE_SIZE = 100;
export const HOME_WORK_LIBRARY_PAGE_LIMIT = 3;

export type HomeWorkLibraryScope = Readonly<{
  reader: string;
  credentialEpoch: string;
  source: string;
  observation: string;
  locale: string;
  route: string;
}>;

export type HomeWorkLibraryFact<T> =
  | Readonly<{ state: 'present'; value: T }>
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'unavailable' }>;

export type HomeWorkLibraryRow = Readonly<{
  subjectId: string;
  entry: HomeWorkLibraryFact<SubjectSlotEntry>;
  score: HomeWorkLibraryFact<SubjectOwnRating>;
  entryControl?: (fact: Exclude<HomeWorkLibraryFact<SubjectSlotEntry>, { state: 'unavailable' }>) => ReactNode;
  scoreControl?: (fact: Exclude<HomeWorkLibraryFact<SubjectOwnRating>, { state: 'unavailable' }>) => ReactNode;
}>;

export type HomeWorkLibraryPage = Readonly<{
  state: 'ready' | 'unavailable';
  rows: readonly HomeWorkLibraryRow[];
}>;

export type HomeWorkLibraryLease = Readonly<{
  subscribe(listener: () => void): () => void;
  snapshot(): number;
  isCurrent(): boolean;
}>;

/** This visit-local projection is deliberately separate from the anonymous Home query cache. */
export type HomeWorkLibraryProjection = Readonly<{
  scope: HomeWorkLibraryScope;
  pages: readonly HomeWorkLibraryPage[];
  lease: HomeWorkLibraryLease;
}>;

export type HomeWorkLibraryPlan = Readonly<{
  pages: readonly (readonly string[])[];
  hasMore: boolean;
}>;

export function planHomeWorkLibraryPages(identities: Iterable<string>): HomeWorkLibraryPlan {
  const limit = HOME_WORK_LIBRARY_PAGE_SIZE * HOME_WORK_LIBRARY_PAGE_LIMIT;
  const unique = new Set<string>();
  const kept: string[] = [];
  let hasMore = false;
  for (const identity of identities) {
    if (!validIdentity(identity) || unique.has(identity)) continue;
    if (unique.size === limit) {
      hasMore = true;
      continue;
    }
    unique.add(identity);
    kept.push(identity);
  }
  const pages: string[][] = [];
  for (let offset = 0; offset < kept.length; offset += HOME_WORK_LIBRARY_PAGE_SIZE)
    pages.push(kept.slice(offset, offset + HOME_WORK_LIBRARY_PAGE_SIZE));
  return { pages, hasMore };
}

/** Missing rows stay unavailable. This helper never treats an omitted ID as an absent Entry or score. */
export function homeWorkLibraryRow(
  projection: HomeWorkLibraryProjection | undefined,
  subjectId: string,
): HomeWorkLibraryRow | undefined {
  if (!projection || !isValidProjection(projection)) return;
  for (const page of projection.pages) {
    if (page.state !== 'ready') continue;
    const row = page.rows.find((candidate) => candidate.subjectId === subjectId);
    if (row) return row;
  }
}

export function sameHomeWorkLibraryScope(left: HomeWorkLibraryScope, right: HomeWorkLibraryScope): boolean {
  return (
    left.reader.length > 0 &&
    left.credentialEpoch.length > 0 &&
    left.source.length > 0 &&
    left.observation.length > 0 &&
    left.locale.length > 0 &&
    left.route.length > 0 &&
    left.reader === right.reader &&
    left.credentialEpoch === right.credentialEpoch &&
    left.source === right.source &&
    left.observation === right.observation &&
    left.locale === right.locale &&
    left.route === right.route
  );
}

export type HomeWorkLibraryAcknowledgement = Readonly<{
  state: 'acknowledged' | 'unknown' | 'rejected';
  commandId: string;
  subjectId: string;
  entry?: HomeWorkLibraryFact<SubjectSlotEntry>;
  score?: HomeWorkLibraryFact<SubjectOwnRating>;
}>;

/** Only an acknowledged owner receipt changes shared rows; unknown commands retain their original identity. */
export function reconcileHomeWorkLibraryAcknowledgement(
  projection: HomeWorkLibraryProjection,
  acknowledgement: HomeWorkLibraryAcknowledgement,
): HomeWorkLibraryProjection {
  if (
    acknowledgement.state !== 'acknowledged' ||
    !acknowledgement.commandId ||
    !validIdentity(acknowledgement.subjectId) ||
    !projection.lease.isCurrent() ||
    (!acknowledgement.entry && !acknowledgement.score)
  )
    return projection;
  let changed = false;
  const pages = projection.pages.map((page) => {
    if (page.state !== 'ready') return page;
    let pageChanged = false;
    const rows = page.rows.map((row) => {
      if (row.subjectId !== acknowledgement.subjectId) return row;
      changed = pageChanged = true;
      return {
        ...row,
        ...(acknowledgement.entry ? { entry: acknowledgement.entry } : {}),
        ...(acknowledgement.score ? { score: acknowledgement.score } : {}),
      };
    });
    return pageChanged ? { ...page, rows } : page;
  });
  const reconciled = changed ? { ...projection, pages } : projection;
  return isValidProjection(reconciled) ? reconciled : projection;
}

export function isValidProjection(projection: HomeWorkLibraryProjection): boolean {
  if (projection.pages.length > HOME_WORK_LIBRARY_PAGE_LIMIT) return false;
  const seen = new Set<string>();
  for (const page of projection.pages) {
    if (page.state === 'unavailable' && page.rows.length > 0) return false;
    if (page.rows.length > HOME_WORK_LIBRARY_PAGE_SIZE) return false;
    for (const row of page.rows) {
      if (!validIdentity(row.subjectId) || seen.has(row.subjectId)) return false;
      if (row.entry.state === 'present' && row.entry.value.subjectId !== row.subjectId) return false;
      if (
        row.score.state === 'present' &&
        (row.score.value.kind !== 'ready' || row.score.value.reader !== projection.scope.reader)
      )
        return false;
      seen.add(row.subjectId);
    }
  }
  return true;
}

/** Exact identity only: a cited review target, reply, Collection, or other subject is not promoted to a Work. */
export function admittedFeedWorkId(item: FeedItem): string | undefined {
  const summary: unknown = item.summary;
  const destination = item.destination;
  if (
    destination.kind !== 'subject' ||
    !record(summary) ||
    summary.creativeWork !== true ||
    summary.id !== destination.id ||
    !validIdentity(destination.id)
  )
    return;
  return destination.id;
}

export function admittedCatalogueWorkId(input: {
  id: string;
  summary?: { creativeWork?: boolean; id?: string } | null;
}): string | undefined {
  return input.summary?.creativeWork === true && input.summary.id === input.id && validIdentity(input.id)
    ? input.id
    : undefined;
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
