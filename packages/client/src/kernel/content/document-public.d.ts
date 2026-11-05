import type { DocumentView } from './document-read.ts';
export type PublicDocumentView = Omit<Extract<DocumentView, {
    origin: 'import';
}>, 'origin'> | Extract<DocumentView, {
    origin: 'account';
}>;
export declare function publicDocument(document: DocumentView): PublicDocumentView;
export declare const PublicDocumentViewSchema: import("typebox").TUnsafe<PublicDocumentView>;
