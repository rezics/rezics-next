import type { Release } from '@rezics/definitions';
/** Raw identities, including duplicates, before any source deduplication. */
export declare const COPY_WORK_DISCLOSURE_MAX_RAW = 100;
/** Disclosed canonical works per source; a fourth current member is overflow. */
export declare const COPY_WORK_DISCLOSURE_MAX_WORKS = 3;
/** Current-head locators per source: three disclosed members plus one lookahead. */
export declare const COPY_WORK_DISCLOSURE_LOOKAHEAD: number;
/** Released copy/release-to-work property. Same UUID, digest or label is never membership. */
export declare const COPY_WORK_PROPERTY = "schema:exampleOfWork";
export type CopyWorkAdmission = 'admitted' | 'scope' | 'unsupported';
/** One released policy shared by the native prefilter and Semantic result classification. */
export declare function admittedCopyWork(release: Release, type: string, isRelationProperty: (release: Release, property: string) => boolean): CopyWorkAdmission;
export type CopyWorkDisclosureRequest = Readonly<{
    identities: readonly string[];
    languages?: readonly string[];
}>;
/** Selected labels only; never every stored language or a locally truncated string. */
export type CopyWorkReference = Readonly<{
    id: string;
    labels: Readonly<Record<string, string>>;
}>;
export type CopyWorkDisclosureState = Readonly<{
    state: 'available';
    works: readonly CopyWorkReference[];
}> | Readonly<{
    state: 'scope';
}> | Readonly<{
    state: 'withheld';
}> | Readonly<{
    state: 'missing';
}> | Readonly<{
    state: 'unsupported';
}> | Readonly<{
    state: 'unavailable';
}> | Readonly<{
    state: 'denied';
}>;
/** One original-keyed batch. `current` re-observes native homes; it is not a future-commit lock. */
export type CopyWorkDisclosureObservation = Readonly<{
    results: ReadonlyMap<string, CopyWorkDisclosureState>;
    current: () => Promise<boolean>;
}>;
