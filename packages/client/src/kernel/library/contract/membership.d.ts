/** Membership and ordered-occurrence vocabulary. Application results alias these types. */
import type { CollectionSourceObservation } from './source.ts';
import type { WorkReceipt } from './work-dimensions.ts';
export type { CollectionSubjectMembership } from './source.ts';
/** One stored occurrence, including repeats. Order is native, never canonical uniqueness. */
export type OrderedOccurrence = Readonly<{
    occurrenceId: string;
    subjectId: string;
    ordinal: number;
    note: string | null;
    duplicateOf: string | null;
}>;
/** Capture input. Core fills missing note and duplicateOf. */
export type OccurrenceDraft = Readonly<{
    occurrenceId: string;
    subjectId: string;
    ordinal: number;
    note?: string | null;
    duplicateOf?: string | null;
}>;
export type MembershipPage = Readonly<{
    occurrences: readonly OrderedOccurrence[];
    exhausted: boolean;
    observation: CollectionSourceObservation;
    work: WorkReceipt;
}>;
export type NestedAdmissionTerm = Readonly<{
    name: string;
    candidateKeys: number;
    nativeRows: number;
    identityMetadataRows: number;
    emptySeeks: number;
    nativePoints: number;
    witnessKeys: number;
    statements: number;
    bytes: number;
}>;
export type NestedAdmissionAccount = Readonly<{
    terms: readonly NestedAdmissionTerm[];
    complete: boolean;
}>;
