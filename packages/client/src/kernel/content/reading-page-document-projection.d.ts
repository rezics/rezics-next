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
type BoundPresentation = Readonly<{
    id: string;
    containerId: string;
}>;
export type ProjectedReadingPageImage<T extends BoundPresentation = BoundPresentation> = Readonly<{
    id: string;
    state: 'available';
    presentation: T;
}> | Readonly<{
    id: string;
    state: 'unavailable';
}>;
export type ProjectedReadingPageDocument<T extends BoundPresentation = BoundPresentation> = Readonly<{
    postId: string;
    threadId: string;
    revisionId: string;
    sha256: string;
    state: 'available' | 'unavailable';
    images: readonly ProjectedReadingPageImage<T>[];
}>;
export type ProjectedReadingPageDocumentMedia<T extends BoundPresentation = BoundPresentation> = Readonly<{
    state: 'available';
    documents: readonly ProjectedReadingPageDocument<T>[];
}>;
/** First matching presentation wins; missing or foreign images stay per-image unavailable. */
export declare function projectReadingPageDocumentMedia<T extends BoundPresentation>(selection: SelectedReadingPageMedia, presentations: readonly T[]): ProjectedReadingPageDocumentMedia<T>;
export {};
