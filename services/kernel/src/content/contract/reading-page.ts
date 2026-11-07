/** Reading composition consumes selected values; native authority stays in its readers. */
export type ReadingPageOptional<T> = Readonly<{ state: 'current'; value: T }> | Readonly<{ state: 'unavailable' }>;

export class ReadingPageChangedError extends Error {
  constructor() {
    super('The reading page changed during hydration');
    this.name = 'ReadingPageChangedError';
  }
}

export type ReadingPagePlace = Readonly<{
  threadId: string;
  boardId: string;
  threadSecurityRevision: string;
  boardSecurityRevision: string;
  realmId: string | null;
}>;
export type ReadingPageActivitySelection<Anchor> =
  | Readonly<{
      threadId: string;
      status: 'current';
      cohort: 'public';
      replyCount: Readonly<{ kind: 'exact' | 'lower-bound'; value: number }>;
      lastContributionAt: string | null;
      witness: ReadingPagePlace & Readonly<{ source: Anchor }>;
    }>
  | Readonly<{
      threadId: string;
      status: 'withheld';
      reason: 'missing' | 'coverage' | 'unsupported-cohort' | 'stale';
    }>;
export type ReadingPageActivity =
  | Readonly<{
      state: 'current';
      cohort: 'public';
      count: Readonly<{ kind: 'exact' | 'lower-bound'; value: number }>;
      lastActivityAt: string | null;
    }>
  | Readonly<{ state: 'withheld' }>
  | Readonly<{ state: 'unavailable'; retryable: true }>;
export type ReadingPageActivityPort<Anchor, Selection extends ReadingPageActivitySelection<Anchor>> = Readonly<{
  select(ids: readonly string[], deadline: number): Promise<ReadingPageOptional<readonly Selection[]>>;
  confirm(selected: readonly Selection[], deadline: number): Promise<ReadingPageOptional<readonly Selection[]>>;
}>;

/** The normalized document's structural subset needed for bounded related-key selection. */
export type ReadingPageNode = Readonly<{
  type: string;
  attrs?: Readonly<Record<string, unknown>>;
  content?: readonly ReadingPageNode[];
}>;
export type ReadingPagePost = Readonly<{
  id: string;
  threadId: string;
  availability: 'available' | 'erased' | 'withheld';
  revisionId?: string;
  sha256: string | null;
  body: Readonly<{ doc: ReadingPageNode }> | null;
  mediaIds?: readonly string[];
}>;
export type ReadingPageMentionIdentity =
  | Readonly<{ id: string; state: 'active'; handle: string | null }>
  | Readonly<{ id: string; state: 'deleted' | 'unknown' }>;
export type ReadingPageMentionSource = {
  postId: string;
  threadId: string;
  revisionId: string;
  sha256: string;
  pageIndex: number;
  references: string[];
  overflow: boolean;
};
export type SelectedReadingPageMentionInventory = Readonly<{
  identities: readonly string[];
  sources: readonly ReadingPageMentionSource[];
  overflow: boolean;
}>;
export type ReadingPageMentions = {
  state: 'current' | 'unavailable';
  retryable: boolean;
  overflow: boolean;
  sources: ReadingPageMentionSource[];
  identities: (
    | { id: string; state: 'active'; handle: string | null }
    | { id: string; state: 'concealed' | 'erased' }
  )[];
};
export type ReadingPageMentionPort = Readonly<{
  read(ids: readonly string[]): Promise<ReadingPageOptional<readonly ReadingPageMentionIdentity[]>>;
}>;

export const READING_PAGE_CITATION_LIMIT = 21;
export const READING_PAGE_DOCUMENT_LIMIT = 21;
export const READING_PAGE_DOCUMENT_MEDIA_LIMIT = 32;
export const READING_PAGE_MENTION_LIMIT = 100;
export type ReadingPageCitationPost = Readonly<{
  id: string;
  threadId: string;
  route: number;
  availability: 'available' | 'erased' | 'withheld';
  revisionId?: string;
  disclosure: 'absent' | 'visible' | 'withheld';
  voteCitation?: Readonly<{ questionId: string; units: number; revision: number }> | null;
}>;
export type ReadingPageCitationThread = Readonly<{
  id: string;
  route: number;
  kind: string;
  firstPost: ReadingPageCitationPost;
}>;
export type ReadingPageReviewTarget =
  | { state: 'available'; subject: { id: string; kind: string; label: { value: string; language: string } | null } }
  | { state: 'absent' | 'withheld' | 'unavailable' };
export type ReadingPagePublishedCitation =
  | { state: 'available'; questionId: string; units: number; voteRevision: number; metadata: { state: 'unavailable' } }
  | { state: 'absent' | 'withheld' };
export type ReadingPageReviewContext = {
  source: { threadId: string; postId: string; revisionId: string | null };
  target: ReadingPageReviewTarget;
  citations: {
    state: 'current';
    items: { postId: string; sourceRevisionId: string | null; citation: ReadingPagePublishedCitation }[];
  };
};
export type ReadingPageReviewTargetPort = Readonly<{
  prepare(): Promise<
    ReadingPageOptional<
      Readonly<{
        finish(): Promise<ReadingPageOptional<ReadingPageReviewTarget>>;
      }>
    >
  >;
}>;

export type SelectedReadingPageDocument = Readonly<{
  postId: string;
  threadId: string;
  revisionId: string;
  sha256: string;
  mediaIds: readonly string[];
}>;
export type SelectedReadingPageMedia = Readonly<{
  state: 'selected';
  documents: readonly SelectedReadingPageDocument[];
  mediaIds: readonly string[];
}>;
export type ReadingPageDocumentSelection =
  | SelectedReadingPageMedia
  | Readonly<{ state: 'overflow'; documents: readonly SelectedReadingPageDocument[] }>;
export type ReadingPageBoundPresentation = Readonly<{ id: string; containerId: string }>;
export type ProjectedReadingPageImage<T extends ReadingPageBoundPresentation = ReadingPageBoundPresentation> =
  | Readonly<{ id: string; state: 'available'; presentation: T }>
  | Readonly<{ id: string; state: 'unavailable' }>;
export type ProjectedReadingPageDocument<T extends ReadingPageBoundPresentation = ReadingPageBoundPresentation> =
  Readonly<{
    postId: string;
    threadId: string;
    revisionId: string;
    sha256: string;
    state: 'available' | 'unavailable';
    images: readonly ProjectedReadingPageImage<T>[];
  }>;
export type ReadingPageDocument<T extends ReadingPageBoundPresentation = ReadingPageBoundPresentation> = Omit<
  ProjectedReadingPageDocument<T>,
  'state'
> &
  Readonly<{ state: 'available' | 'unavailable' | 'overflow' }>;
export type ProjectedReadingPageDocumentMedia<T extends ReadingPageBoundPresentation = ReadingPageBoundPresentation> =
  Readonly<{
    state: 'available';
    documents: readonly ProjectedReadingPageDocument<T>[];
  }>;
export type ReadingPageDocumentMedia<T extends ReadingPageBoundPresentation = ReadingPageBoundPresentation> = Readonly<{
  state: 'available' | 'unavailable' | 'overflow';
  documents: readonly ReadingPageDocument<T>[];
}>;
export type ReadingPageDocumentPort<T extends ReadingPageBoundPresentation> = Readonly<{
  read(ids: readonly string[]): Promise<ReadingPageOptional<readonly T[]>>;
}>;
