import type { DocumentView } from './document-read.ts';
export type PublicDocumentView = Omit<Extract<DocumentView, {
    origin: 'import';
}>, 'origin'> | Extract<DocumentView, {
    origin: 'account';
}>;
export declare function publicDocument(document: DocumentView): PublicDocumentView;
export declare function PublicDocumentViewSchema(): import("typebox").TUnsafe<PublicDocumentView>;
