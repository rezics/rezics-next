import { type DocumentSnapshot } from '@rezics/document';
export declare const MAX_DOCUMENT_BYTES: number;
export declare class InvalidDocumentError extends Error {
    constructor(message?: string);
}
export declare class DocumentTooLargeError extends Error {
    constructor();
}
/** Accept a current SPDX license identifier or a syntactically valid local LicenseRef. */
export declare function isSpdxLicense(value: unknown): value is string;
/** Accept UUIDs that carry a routable REZICS route; existence is intentionally not checked. */
export declare function isRoutableSubjectId(value: unknown): value is string;
export interface ValidatedContentDocument {
    snapshot: DocumentSnapshot;
    canonicalBytes: Uint8Array;
    sha256: string;
    searchText: string;
    licence: string;
    subjectIds: string[];
}
/** Validate untrusted content metadata and prepare its immutable storage projections. */
export declare function validateContentDocument(input: unknown): ValidatedContentDocument;
