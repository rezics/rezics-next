/** Owner-private hosted Book checkpoint vocabulary. Library stores exact addresses;
 * Content supplies current disclosure without transferring document bytes to list pages. */
export type HostedReadingDocumentPosition = Readonly<{
    blockId: string;
    offset: number;
}>;
export type HostedReadingAddress = Readonly<{
    catalogueId: string;
    publicationRevisionId: string;
    occurrenceId: string;
    targetRevisionId: string;
    targetSha256: string;
    documentPosition: HostedReadingDocumentPosition | null;
}>;
export type HostedReadingSelection = HostedReadingAddress;
export type HostedReadingChapterTarget = Readonly<{
    threadId: string;
    postId: string;
    revisionId: string;
    sha256: string;
}>;
export type HostedReadingDocument = Readonly<{
    encoding: 'base64';
    canonicalBytes: string;
    sha256: string;
    authorId: string;
    licence: string;
}>;
export type HostedReadingMetadata = Readonly<{
    availability: 'available';
    occurrenceId: string;
    parentId: string | null;
    position: number;
    kind: 'chapter';
    title: string;
    target: HostedReadingChapterTarget;
}> | Readonly<{
    availability: 'unavailable';
    occurrenceId: string;
    kind: 'chapter' | 'part' | 'unknown';
}>;
export type HostedReadingResume = (Extract<HostedReadingMetadata, {
    availability: 'available';
}> & Readonly<{
    document: HostedReadingDocument;
}>) | Extract<HostedReadingMetadata, {
    availability: 'unavailable';
}>;
export type HostedReadingValidation = Readonly<{
    ok: true;
    address: HostedReadingAddress;
}> | Readonly<{
    ok: false;
    reason: 'not_found' | 'invalid_selection' | 'unavailable';
}>;
/** Content validates save selections, projects exact current metadata for owner pages,
 * and rechecks current Access before exact resume. Private facts grant no read access. */
export type HostedReadingPort = Readonly<{
    validateSelection(actor: unknown, selection: HostedReadingSelection, deadline: number): Promise<HostedReadingValidation>;
    readMetadata(actor: unknown, address: HostedReadingAddress, deadline: number): Promise<HostedReadingMetadata>;
    resolveExact(actor: unknown, address: HostedReadingAddress, deadline: number): Promise<HostedReadingResume>;
}>;
export type HostedReadingSavedView = Readonly<{
    state: 'saved';
    subjectId: string;
    revision: string;
    address: HostedReadingAddress;
    resume: HostedReadingResume;
}>;
export type HostedReadingNoneView = Readonly<{
    state: 'none';
    subjectId: string;
}>;
export type HostedReadingView = HostedReadingSavedView | HostedReadingNoneView;
export type HostedReadingListQuery = Readonly<{
    limit?: number;
    cursor?: string;
}>;
export type HostedReadingCheckpoint = Readonly<{
    subjectId: string;
    revision: string;
    address: HostedReadingAddress;
    activityAt: string;
    metadata: HostedReadingMetadata;
}>;
export type HostedReadingListView = Readonly<{
    items: readonly HostedReadingCheckpoint[];
    nextCursor: string | null;
}>;
export type HostedReadingSaveInput = HostedReadingSelection & Readonly<{
    subjectId: string;
    expectedRevision: string | null;
}>;
export type HostedReadingClearInput = Readonly<{
    subjectId: string;
    expectedRevision: string;
}>;
export type HostedReadingSaveResult = Readonly<{
    subjectId: string;
    revision: string;
    address: HostedReadingAddress;
}>;
export type HostedReadingClearResult = Readonly<{
    subjectId: string;
    cleared: true;
}>;
export declare const HOSTED_READING_LIST_LIMIT = 20;
export declare const HOSTED_READING_POSITION_BLOCK_MAX = 128;
export declare const HOSTED_READING_POSITION_OFFSET_MAX: number;
export declare const HOSTED_READING_CHANGED_EVENT = "com.rezics.library.hosted-reading.changed.v1";
