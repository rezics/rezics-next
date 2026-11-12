import type { DocumentSnapshot } from '@rezics/document';
import type { RichTextEditorProps } from '@rezics/ui';
import type { ComponentProps } from 'react';
import type { DocumentBody } from '../document-body';

/** View contracts, not native routes. The caller supplies current private admission on every operation. */
export type ExactDocument = Readonly<{
  postId: string;
  revisionId: string;
  sha256: string;
}>;
/** Native metadata projection. Post revisions carry no historical title. */
export type StudioRevisionHeader = Readonly<{
  exact: ExactDocument;
  savedAt: string;
}>;
export type StudioRevision = StudioRevisionHeader &
  Readonly<{
    title: string;
    body: DocumentSnapshot;
    mediaIds: readonly string[];
  }>;
export type StudioDocument = Readonly<{
  postId: string;
  title: string;
  revisionId: string;
  updatedAt: string;
  state: 'draft' | 'published' | 'protected' | 'taken_down';
  openable?: boolean;
}>;
export type StudioSelection = Readonly<{
  revision: StudioRevision;
  visibility?: 'draft' | 'published' | 'protected' | 'taken_down';
  /** Exact native authoring context for account-owned discussion drafts. */
  native?: Readonly<{
    threadId: string;
    boardId: string;
    licence: string;
    subjectIds: readonly string[];
  }>;
  permissions: Readonly<{ edit: boolean; publish: boolean }>;
}>;
export type StudioFailure = Readonly<{
  kind: 'denied' | 'unavailable' | 'stale' | 'withdrawn' | 'invalid' | 'uncertain';
  /** Safe, user-facing native explanation; never an exception or transport response. */
  message: string;
}>;
export type StudioResult<T> = { ok: true; value: T } | { ok: false; error: StudioFailure };
export type StudioPage<T> = Readonly<{ items: readonly T[]; nextCursor: string | null }>;

/** Sibling order is array order. Part occurrences have no Post and contain no duplicate body storage. */
export type BookPlacement = Readonly<{
  occurrenceId: string;
  parentOccurrenceId: string | null;
  title: string;
  target: { kind: 'part' } | { kind: 'chapter'; document: ExactDocument };
}>;
export type BookStructure = Readonly<{
  catalogueId: string;
  revision: string;
  placements: readonly BookPlacement[];
  limits: Readonly<{ maxDepth: number; maxPlacements: number }>;
  canOrganize: boolean;
}>;
export type BookStructureChange =
  | {
      kind: 'insert';
      parentOccurrenceId: string | null;
      beforeOccurrenceId: string | null;
      title: string;
      target: BookPlacement['target'];
    }
  | { kind: 'move'; occurrenceId: string; parentOccurrenceId: string | null; beforeOccurrenceId: string | null }
  | { kind: 'rename'; occurrenceId: string; title: string }
  | { kind: 'pin'; occurrenceId: string; document: ExactDocument }
  /** Remove only this occurrence subtree; never erase Posts or mutate previous manifests. */
  | { kind: 'remove'; occurrenceId: string };

export type StudioProfile =
  | Readonly<{ kind: 'book'; structure: BookStructure }>
  | Readonly<{ kind: 'articles'; seriesTitle: string | null }>;
export type PublicationTarget =
  | Readonly<{
      kind: 'book';
      catalogueId: string;
      structureRevision: string;
      /** Explicit selection only. The native review includes required ancestors in the frozen TOC. */
      chapters: readonly { occurrenceId: string; document: ExactDocument }[];
    }>
  | Readonly<{ kind: 'article'; document: ExactDocument }>;
export type PublicationRecord = Readonly<{
  publicationId: string;
  revision: string;
  /** The hosted API currently omits publication timestamps. */
  publishedAt: string | null;
  state: 'published' | 'withdrawn';
  entries: readonly { occurrenceId: string | null; title: string; document: ExactDocument }[];
  /** Present only after account article publication has been acknowledged and read back. */
  readbackSelection?: StudioSelection;
}>;
export type ArticleReviewSnapshot = Readonly<{
  boardId: string;
  licence: string;
  subjectIds: readonly string[];
  mediaIds: readonly string[];
  body: DocumentSnapshot;
}>;
export type PublicationReview = Readonly<{
  /** Opaque native review binding; never interpreted as a grant by the view. */
  reviewId: string;
  /** Article review is local acknowledgement of the exact saved revision; Books retain native hosted review. */
  authority?: 'hosted' | 'local';
  articleSnapshot?: ArticleReviewSnapshot;
  target: PublicationTarget;
  expectedPublicationRevision: string | null;
  expiresAt: string;
  /** Frozen selected book outline, including ancestor parts; articles carry no synthetic TOC. */
  bookOutline: Omit<BookStructure, 'canOrganize'> | null;
  entries: readonly { occurrenceId: string | null; title: string; document: ExactDocument }[];
  notices: readonly string[];
}>;
export type DraftSave = Readonly<{
  projectId: string;
  postId: string;
  expectedRevisionId: string;
  title: string;
  body: DocumentSnapshot;
  mediaIds: readonly string[];
  idempotencyKey: string;
  native?: Readonly<{
    boardId: string;
    licence: string;
    subjectIds: readonly string[];
    visibility: 'draft';
  }>;
}>;
export type NativeDraftCreate = Readonly<{
  boardId: string;
  title: string;
  body: DocumentSnapshot;
  licence: string;
  subjectIds: readonly string[];
  mediaIds: readonly string[];
}>;
export type StudioInput = Readonly<{
  /** Replace on account, authorization epoch, project or route visit replacement. */
  visitKey: string;
  projectId: string;
  title: string;
  profile: StudioProfile;
  documents: StudioPage<StudioDocument>;
  /** A current Post selection admitted by the owning private reader. */
  initialSelection?: StudioSelection;
  publications: StudioPage<PublicationRecord>;
  canCreateDraft: boolean;
  /** Render native account creation operands and account inventory recovery. */
  nativeDrafts?: boolean;
  canPublish: boolean;
  /** A missing native publication flow must not render an empty history as an admitted result. */
  publicationUnavailableReason?: string;
}>;

/** All methods recheck current native authority; mutations use exact preconditions and replay-safe keys.
 * Save always writes a private draft revision, including when the Post already has a published version.
 * Hosted Book publish atomically freezes the reviewed TOC and exact bodies; it never publishes unselected drafts.
 * The mounted route/generated-operation adapter is deliberately supplied by the consumer.
 */
export interface StudioPort {
  isCurrent(): boolean;
  documents(
    input: { projectId: string; cursor: string },
    signal: AbortSignal,
  ): Promise<StudioResult<StudioPage<StudioDocument>>>;
  open(input: { projectId: string; postId: string }, signal: AbortSignal): Promise<StudioResult<StudioSelection>>;
  createDraft(
    input: { projectId: string; title: string; idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<StudioResult<StudioSelection>>;
  createNativeDraft?(
    input: NativeDraftCreate & { idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<StudioResult<StudioSelection>>;
  saveDraft(input: DraftSave, signal: AbortSignal): Promise<StudioResult<StudioSelection>>;
  versions(
    input: { projectId: string; postId: string; cursor: string | null },
    signal: AbortSignal,
  ): Promise<StudioResult<StudioPage<StudioRevisionHeader>>>;
  revision(
    input: { projectId: string; document: ExactDocument },
    signal: AbortSignal,
  ): Promise<StudioResult<StudioRevision>>;
  reviewPublication(
    input: { projectId: string; target: PublicationTarget },
    signal: AbortSignal,
  ): Promise<StudioResult<PublicationReview>>;
  publish(
    input: { projectId: string; review: PublicationReview; idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<StudioResult<PublicationRecord>>;
  publications(
    input: { projectId: string; cursor: string },
    signal: AbortSignal,
  ): Promise<StudioResult<StudioPage<PublicationRecord>>>;
}
export interface BookOrganizerPort {
  /** Return a fresh complete bounded structure; reject stale structure revisions atomically. */
  change(
    input: { catalogueId: string; expectedRevision: string; change: BookStructureChange; idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<StudioResult<BookStructure>>;
}

export type StudioPresentation = Readonly<{
  /** Bind media and mention presentation to this document's current native admission. */
  editor?: (
    document: ExactDocument,
  ) => Pick<RichTextEditorProps, 'labels' | 'upload' | 'lookupMention' | 'renderUpload' | 'lang' | 'dir'>;
  reader?: (
    document: ExactDocument,
  ) => Pick<ComponentProps<typeof DocumentBody>, 'renderImage' | 'mentions' | 'labels' | 'locale'>;
}>;
export function sameExact(a: ExactDocument, b: ExactDocument): boolean {
  return a.postId === b.postId && a.revisionId === b.revisionId && a.sha256 === b.sha256;
}
