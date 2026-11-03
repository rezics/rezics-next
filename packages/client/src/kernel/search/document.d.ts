import { type IndexedSubject, type SubjectSnapshot } from './source.ts';
import { type AccountSnapshot } from './discovery.ts';
export declare const MISSING_NAME = "\uDBFF\uDFFF";
export declare const MAX_NAME_SORT_CHARACTERS = 512;
/** One nested fact. Qualifiers are `property=value` strings, unique and in source order. */
export type SubjectFact = {
    property: string;
    value: string;
    qualifiers: string[];
} | {
    property: string;
    year: number;
    month?: number;
    day?: number;
    time_lower?: string;
    time_upper?: string;
    qualifiers: string[];
} | {
    property: string;
    amount: number;
    unit: string;
    qualifiers: string[];
};
export type SubjectDocument = {
    id: string;
    partition: number;
    type: string;
    security_revision: number;
    names: string[];
    descriptions: string[];
    /** Native write preparation supplies null for normalized keys exceeding MAX_NAME_SORT_CHARACTERS. */
    name_sort: string | null;
    statements: string[];
    /** One entry per facet-capable statement, in source order, with exact duplicates removed. */
    facts: SubjectFact[];
    /** Declared relation facet properties whose complete value sets exceeded the source sample bound. */
    relation_facet_overflow?: string[];
    /** Active public Collections listing this subject. Omitted unless counts are supplied. */
    public_collection_count?: number;
    /** Published Global standard-question score and prior identity; absent figures omit both fields. */
    rating_score?: number | null;
    rating_prior_epoch?: number | null;
};
/** Public index allowlist. Live profile/verification/avatar data is always hydrated by Accounts. */
export type AccountDocument = {
    family: 'account';
    kind: 'account';
    identity: string;
    id: string;
    partition: number;
    account_revision: string;
    active_handle: string | null;
    names: string[];
    name_sort: string | null;
    descriptions: [];
    statements: [];
    facts: [];
    relation_facet_overflow: [];
};
export type DiscoverySubjectDocument = SubjectDocument & {
    family: 'subject';
    kind: string;
    identity: string;
};
export type SearchDocument = SubjectDocument | AccountDocument;
export type IndexAction<Document extends SearchDocument = SubjectDocument> = {
    op: 'index';
    id: string;
    version: bigint;
    document: Document;
} | {
    op: 'delete';
    id: string;
    version: bigint;
};
export declare function documentActions(snapshot: SubjectSnapshot, ids: readonly string[], counts?: ReadonlyMap<string, number>, 
/** Explicit successor projection; legacy physical writers retain their historical shape. */
calendarFormat?: 1): IndexAction[];
/** The caller admits the native snapshot before constructing these positioned replacements/deletes. */
export declare function accountDocumentActions(snapshot: AccountSnapshot, ids: readonly string[]): IndexAction<AccountDocument>[];
/** Same Subject projection and native version; only the new generation's identity envelope changes. */
export declare function discoverySubjectActions(snapshot: SubjectSnapshot, ids: readonly string[], counts?: ReadonlyMap<string, number>): IndexAction<DiscoverySubjectDocument>[];
export declare function bulkLines<Document extends SearchDocument>(index: string, actions: readonly IndexAction<Document>[]): unknown[];
/** Validate all returned evidence, including records that will produce deletes, before any projection I/O. */
export declare function validateIndexObservation(snapshot: SubjectSnapshot, partition: number, ids: readonly string[], obligation: bigint, native?: boolean): Map<string, IndexedSubject>;
