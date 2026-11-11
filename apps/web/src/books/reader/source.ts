import type { ComponentProps } from 'react';
import type { PostReadingBody } from '../../threads/post-reading-body';

/** Consumer bounds, not a claim that a generated Content operation is installed. */
export const BOOK_CONTENTS_LIMIT = 40;
export const BOOK_ANCESTOR_LIMIT = 24;
export const BOOK_CURSOR_LIMIT = 8192;

export type BookPublication = Readonly<{
  /** Native catalogue ID. */
  id: string;
  structureRevisionId: string;
  /** Native publication revision, distinct from its source structure. Required by the native adapter. */
  releaseRevisionId?: string;
}>;
export type BookBodySelection = Readonly<{ postId: string; revisionId: string; sha256: string }>;
export type BookSelection = Readonly<{ occurrenceId: string; body: BookBodySelection }>;
export type BookChapterAddress = Readonly<{
  kind: 'chapter';
  publication: BookPublication;
  selection: BookSelection;
}>;
export type BookContentsAddress = Readonly<{
  kind: 'contents';
  publication: BookPublication;
  parentOccurrenceId: string | null;
  cursor: string | null;
  selection: BookSelection | null;
}>;
export type BookAddress = BookChapterAddress | BookContentsAddress;

export type BookAncestor = Readonly<{
  occurrenceId: string;
  title: string;
  contents: BookContentsAddress;
}>;
type OccurrenceBase = Readonly<{ occurrenceId: string; parentOccurrenceId: string | null; title: string }>;
export type BookOccurrence = OccurrenceBase &
  (
    | Readonly<{ kind: 'container'; contents: BookContentsAddress }>
    | Readonly<{ kind: 'chapter'; chapter: BookChapterAddress }>
    | Readonly<{ kind: 'container-with-body'; chapter: BookChapterAddress; contents: BookContentsAddress }>
    | Readonly<{ kind: 'unavailable' }>
  );
export type BookNavigation =
  | Readonly<{ state: 'available'; title: string; address: BookChapterAddress }>
  | Readonly<{ state: 'end' | 'unavailable' }>;

/** The original document renderer owns spoilers, references and admitted media rendering. */
export type BookDocument = Pick<ComponentProps<typeof PostReadingBody>, 'document' | 'mentions' | 'renderImage'>;
type PageBase = Readonly<{
  publicationTitle: string;
  /** Current context is separately observed; it cannot rewrite the frozen publication selection. */
  currentStructureRevisionId: string;
  /** Current publication release observed by the native binding, independently of the frozen address. */
  currentReleaseRevisionId?: string;
  /** Root to immediate parent, in native order; never reconstructed from title strings. */
  ancestors: readonly BookAncestor[];
}>;
export type BookChapterPage = PageBase &
  Readonly<{
    kind: 'chapter';
    address: BookChapterAddress;
    title: string;
    language: string | null;
    direction: 'ltr' | 'rtl' | 'auto';
    body: BookDocument;
    /** Current location; a move may change it without changing the selection. */
    contents: BookContentsAddress;
    previous: BookNavigation;
    next: BookNavigation;
  }>;
export type BookContentsPage = PageBase &
  Readonly<{
    kind: 'contents';
    address: BookContentsAddress;
    title: string;
    rows: readonly BookOccurrence[];
    /** Empty/sparse rows may still have a continuation. The cursor is opaque. */
    continuation:
      | Readonly<{ state: 'more'; cursor: string }>
      | Readonly<{ state: 'end' | 'unavailable' }>;
    /** Exact selected body remains selectable when its occurrence has moved out of this level. */
    selected:
      | Readonly<{ state: 'here' | 'moved'; chapter: BookChapterAddress; contents: BookContentsAddress }>
      | Readonly<{ state: 'unavailable' }>
      | null;
  }>;
export type BookPage = BookChapterPage | BookContentsPage;
export type BookReadResult =
  | Readonly<{ state: 'ready'; page: BookPage }>
  | Readonly<{ state: 'denied' | 'not-found' | 'unavailable' | 'changed' }>;
export type BookReadRequest = Readonly<{
  address: BookAddress;
  locale: string;
  limit: typeof BOOK_CONTENTS_LIMIT;
  ancestorLimit: typeof BOOK_ANCESTOR_LIMIT;
}>;

/**
 * One incarnation of current publication/target access and the prepared viewer. Replacement,
 * even equal-value replacement or A/B/A, must create a fresh object and notify synchronously.
 * This is observation of native admission, never a browser grant of access.
 */
export type BookSourceObservation = Readonly<{
  state: 'current' | 'unavailable' | 'not-installed';
}>;
export type HostedBookSource = Readonly<{
  getSnapshot: () => BookSourceObservation;
  subscribe: (retired: () => void) => () => void;
  /** One bounded native observation, including exact body, context and neighbours. No hydration loop. */
  read: (request: BookReadRequest, signal: AbortSignal) => Promise<BookReadResult>;
}>;

const notInstalled: BookSourceObservation = { state: 'not-installed' };
/** Deliberate default until the generated native operation and prepared-viewer binding exist. */
export const uninstalledHostedBookSource: HostedBookSource = {
  getSnapshot: () => notInstalled,
  subscribe: () => () => {},
  read: async () => ({ state: 'unavailable' }),
};

export function samePublication(a: BookPublication, b: BookPublication) {
  return a.id === b.id && a.structureRevisionId === b.structureRevisionId &&
    a.releaseRevisionId === b.releaseRevisionId;
}
export function sameSelection(a: BookSelection | null, b: BookSelection | null) {
  return a === null || b === null
    ? a === b
    : a.occurrenceId === b.occurrenceId &&
        a.body.postId === b.body.postId &&
        a.body.revisionId === b.body.revisionId &&
        a.body.sha256 === b.body.sha256;
}
export function sameBookAddress(a: BookAddress, b: BookAddress): boolean {
  if (!samePublication(a.publication, b.publication) || !sameSelection(a.selection, b.selection)) return false;
  return a.kind === 'chapter'
    ? b.kind === 'chapter'
    : b.kind === 'contents' && a.parentOccurrenceId === b.parentOccurrenceId && a.cursor === b.cursor;
}

/** Keep untrusted host coordinates bounded before dispatch; native IDs retain their own grammar. */
export function bookAddressWithinBounds(address: BookAddress): boolean {
  const identity = (value: string) => value.length > 0 && value.length <= 1024;
  if (!identity(address.publication.id) || !identity(address.publication.structureRevisionId)) return false;
  if (address.publication.releaseRevisionId !== undefined && !identity(address.publication.releaseRevisionId)) return false;
  const selection = address.selection;
  if (selection && (!identity(selection.occurrenceId) || !identity(selection.body.postId) ||
    !identity(selection.body.revisionId) || !/^[a-f0-9]{64}$/i.test(selection.body.sha256))) return false;
  return address.kind === 'chapter' ||
    ((address.parentOccurrenceId === null || identity(address.parentOccurrenceId)) &&
      (address.cursor === null || (address.cursor.length > 0 && address.cursor.length <= BOOK_CURSOR_LIMIT)));
}

/** Reject cross-publication and misassociated projections without turning them into another read. */
export function bookPageMatches(request: BookReadRequest, page: BookPage): boolean {
  const address = request.address;
  if (!sameBookAddress(address, page.address) || page.ancestors.length > BOOK_ANCESTOR_LIMIT) return false;
  const validContents = (value: BookContentsAddress) =>
    samePublication(address.publication, value.publication) && bookAddressWithinBounds(value);
  const validChapter = (value: BookChapterAddress) =>
    samePublication(address.publication, value.publication) && bookAddressWithinBounds(value);
  const ancestors = new Set<string>();
  for (const ancestor of page.ancestors) {
    if (
      ancestors.has(ancestor.occurrenceId) ||
      !validContents(ancestor.contents) ||
      ancestor.contents.parentOccurrenceId !== ancestor.occurrenceId
    ) return false;
    ancestors.add(ancestor.occurrenceId);
  }
  if (page.kind === 'chapter') {
    if (
      !validContents(page.contents) ||
      !sameSelection(page.contents.selection, page.address.selection) ||
      page.contents.parentOccurrenceId !== (page.ancestors.at(-1)?.occurrenceId ?? null)
    ) return false;
    return [page.previous, page.next].every(
      (step) => step.state !== 'available' ||
        (validChapter(step.address) && step.address.selection.occurrenceId !== page.address.selection.occurrenceId),
    );
  }
  if (page.rows.length > BOOK_CONTENTS_LIMIT || !validContents(page.address)) return false;
  if (page.continuation.state === 'more' &&
    (!page.continuation.cursor || page.continuation.cursor.length > BOOK_CURSOR_LIMIT ||
      page.continuation.cursor === page.address.cursor)) return false;
  const seen = new Set<string>();
  for (const row of page.rows) {
    if (seen.has(row.occurrenceId) || ancestors.has(row.occurrenceId) ||
      row.occurrenceId === page.address.parentOccurrenceId || row.parentOccurrenceId !== page.address.parentOccurrenceId) return false;
    seen.add(row.occurrenceId);
    if ('contents' in row && (!validContents(row.contents) || row.contents.parentOccurrenceId !== row.occurrenceId))
      return false;
    if ('chapter' in row && (!validChapter(row.chapter) || row.chapter.selection.occurrenceId !== row.occurrenceId))
      return false;
  }
  if (page.selected && page.selected.state !== 'unavailable') {
    if (!validChapter(page.selected.chapter) || !validContents(page.selected.contents) ||
      !sameSelection(page.selected.chapter.selection, page.address.selection) ||
      !sameSelection(page.selected.contents.selection, page.address.selection) ||
      (page.selected.state === 'here' && !page.rows.some((row) =>
        'chapter' in row && sameSelection(row.chapter.selection, page.address.selection)))) return false;
  } else if (page.address.selection !== null && page.selected === null) return false;
  return true;
}
