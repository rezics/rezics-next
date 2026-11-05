import type { Actor } from '../request/access.ts';
import type { Static } from 'typebox';
import type { MediaDependencies } from './media.ts';
import { type DocumentImagePresentation } from './media-presentation.ts';
import type { PostEntry } from './reads.ts';
export declare const READING_PAGE_DOCUMENT_MEDIA_LIMIT = 32;
export declare const READING_PAGE_DOCUMENT_LIMIT = 21;
export type ReadingPageDocumentImage = Readonly<{
    id: string;
    state: 'available';
    presentation: DocumentImagePresentation;
}> | Readonly<{
    id: string;
    state: 'unavailable';
}>;
export type ReadingPageDocument = Readonly<{
    postId: string;
    threadId: string;
    revisionId: string;
    sha256: string;
    state: 'available' | 'unavailable' | 'overflow';
    images: readonly ReadingPageDocumentImage[];
}>;
export type ReadingPageDocumentMedia = Readonly<{
    state: 'available' | 'unavailable' | 'overflow';
    documents: readonly ReadingPageDocument[];
}>;
export declare const ReadingPageDocumentMediaSchema: import("typebox").TUnsafe<Readonly<{
    state: 'available' | 'unavailable' | 'overflow';
    documents: readonly ReadingPageDocument[];
}>>;
export type SelectedReadingPageDocument = Readonly<{
    postId: string;
    threadId: string;
    revisionId: string;
    sha256: string;
    mediaIds: readonly string[];
}>;
export type ReadingPageDocumentSelection = Readonly<{
    state: 'selected';
    documents: readonly SelectedReadingPageDocument[];
    mediaIds: readonly string[];
}> | Readonly<{
    state: 'overflow';
    documents: readonly SelectedReadingPageDocument[];
}>;
/** Select only declared image IDs in the current readable documents of one native page. */
export declare function selectReadingPageDocumentMedia(threadId: string, posts: readonly PostEntry[]): ReadingPageDocumentSelection;
/** Native optional composition runs before ReadingPage's final source admission. */
export declare function readReadingPageDocumentMedia(dependencies: MediaDependencies & Readonly<{
    routeKey: Uint8Array;
}>, actor: Actor, threadId: string, posts: readonly PostEntry[], deadline: number): Promise<ReadingPageDocumentMedia>;
export type ReadingPageDocumentMediaResponse = Static<typeof ReadingPageDocumentMediaSchema>;
