import { type DocumentSnapshot } from '@rezics/document';
import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import { type ImportedFieldView } from './imported-fields.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
/** `now` is the wall-clock budget source supplied by the composition; deadlines are compared against it. */
export type DocumentReadDependencies = Readonly<{
    pool: Pool;
    access: Access;
    routeKey: Uint8Array;
    now: () => number;
}>;
type DocumentMetadata = Readonly<{
    id: string;
    subjectId: string;
    candidateId: string;
    revision: number;
    language: string;
    digest: string;
}>;
type AvailableDocument = Readonly<{
    availability: 'available';
    body: DocumentSnapshot;
}>;
type ErasedDocument = Readonly<{
    availability: 'erased';
    body: null;
}>;
export type DocumentView = (DocumentMetadata & Readonly<{
    origin: 'import';
    source: ImportedFieldView['source'];
    rights: ImportedFieldView['rights'];
}> & (AvailableDocument | ErasedDocument)) | (DocumentMetadata & Readonly<{
    origin: 'account';
    author: string;
    licence: string;
}> & AvailableDocument);
/** Exact document disclosure. Stored bindings select the semantic subject and
 * candidate; imported documents also retain their original source tuple, including
 * after merges. Final passes re-read authoritative facts at their own homes; no
 * reference read holds a connection while acquiring another partition. */
export declare function readDocument(dependencies: DocumentReadDependencies, id: string, context: ReadContext, maxSourceBytes?: number): Promise<{
    document: DocumentView;
    anchors: readonly AnchoredPosition[];
} | null>;
export {};
