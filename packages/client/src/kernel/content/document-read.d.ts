import { type DocumentSnapshot } from '@rezics/document';
import type { Pool } from 'pg';
import { type Access } from '../request/access.ts';
import { type ImportedFieldView } from './imported-fields.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
export type DocumentReadDependencies = Readonly<{
    pool: Pool;
    access: Access;
    routeKey: Uint8Array;
}>;
export type DocumentView = Readonly<{
    id: string;
    subjectId: string;
    candidateId: string;
    revision: number;
    source: ImportedFieldView['source'];
    rights: ImportedFieldView['rights'];
    language: string;
    digest: string;
}> & (Readonly<{
    availability: 'available';
    body: DocumentSnapshot;
}> | Readonly<{
    availability: 'erased';
    body: null;
}>);
/** Exact immutable imported revision disclosure. Only stored bindings select the
 * semantic subject/candidate and original source tuple, including after merges.
 * Final passes re-read authoritative facts at their own homes; no reference read
 * holds a connection while acquiring another partition. No receipt carries bytes. */
export declare function readDocument(dependencies: DocumentReadDependencies, id: string, context: ReadContext): Promise<{
    document: DocumentView;
    anchors: readonly AnchoredPosition[];
} | null>;
