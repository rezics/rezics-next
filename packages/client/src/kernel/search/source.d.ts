import type { PublicRatingFigure } from './rating-source.ts';
export type LanguageValue = {
    language: string;
    value: string;
};
export declare const MAX_RELATION_FACET_VALUES = 128;
export declare const MAX_RELATION_FACET_PROBES = 256;
/** Unqualified adopted Global relation membership for one subject, property and value. */
export type RelationFacetProbe = {
    subject: string;
    property: string;
    value: string;
};
/** `true` and `false` are definitive; `not_proven` is bounded witness uncertainty and never `false`. */
export type RelationFacetMatch = boolean | 'not_proven';
/**
 * Filterable form of a statement value.
 * Time keeps its astronomical year and only the month/day represented by native precision.
 * `amount` is the decimal amount of a quantity.
 * A code value is the statement `value`.
 */
export type FacetValue = {
    kind: 'item';
} | {
    kind: 'code';
} | {
    kind: 'time';
    year: number;
    month?: number;
    day?: number;
} | {
    kind: 'quantity';
    amount: number;
    unit: string;
};
/** One adopted statement value. The semantic source fills `facet` and `qualifiers`. */
export type IndexedStatement = {
    property: string;
    /** Stored statement value. An item value is the target subject id; a code value is the code. */
    value: string;
    /** Present when the value's datatype can be a facet. */
    facet?: FacetValue;
    /** Concrete adopted item (target subject id) or string qualifiers, preserved exactly on this statement.
     * Unknown snaks are omitted; absence here is not complete negative evidence. */
    qualifiers?: {
        property: string;
        value: string;
    }[];
};
export type IndexedSubject = {
    id: string;
    /** Current native standard-question Global figure, when one is published. */
    publicRating?: PublicRatingFigure;
    type: string;
    /** Only visible subjects are indexed. */
    visibility: 'visible' | 'hidden' | 'taken_down';
    /** The survivor when this subject was merged away; a redirected subject is not indexed. */
    redirect: string | null;
    /** Advanced, never reused, by every change that hides or takes down the subject or one of its facts. */
    securityRevision: number;
    labels: LanguageValue[];
    aliases: LanguageValue[];
    descriptions: LanguageValue[];
    /**
     * Adopted Global statement values visible at snapshot build time; an item value is the target subject id.
     * Descriptive statements are unchanged. Outgoing relations include at most MAX_RELATION_FACET_VALUES
     * sampled entries per declared facet property, retaining facet and qualifier metadata.
     * Undeclared relation properties and inbound edges are omitted.
     */
    statements: IndexedStatement[];
    /**
     * Relation facet properties exceeding the sample bound. Production emits [] when none overflow;
     * absence also means no overflow, for historical fixtures.
     */
    relationFacetOverflow?: string[];
};
/** The partition's `core.partition.position` and the listed subjects' state, read in one snapshot. */
export type SubjectSnapshot = {
    partition: number;
    position: bigint;
    subjects: IndexedSubject[];
};
export interface SubjectSource {
    /** Unknown ids are omitted. Every id must route to `partition`. */
    read(partition: number, ids: readonly string[]): Promise<SubjectSnapshot>;
    /** Visible, non-redirected subjects of the partition and its position, in one snapshot. */
    count(partition: number): Promise<{
        position: bigint;
        count: number;
    }>;
    /**
     * Match unqualified membership in full adopted Global relations, applying current source fences and moderation.
     * Accept at most MAX_RELATION_FACET_PROBES probes, with every subject anchored to `partition`;
     * invalid input, including a qualifiers field, rejects. The aligned boolean array preserves probe order
     * and duplicates; each result matches only the probe's subject, property and value.
     * Missing, hidden, taken-down and redirected subjects return false.
     * `true` and `false` are definitive current truth and absence. `not_proven` is bounded witness
     * uncertainty: the source could not prove membership within its bound, and it is never `false`.
     * Optional for historical mocks. Search must fail closed
     * when an overflow probe is needed and this method is absent.
     */
    matchRelationFacets?(partition: number, probes: readonly RelationFacetProbe[]): Promise<RelationFacetMatch[]>;
}
/** Active public Collection counts for subjects in one partition. Only the count is read. */
export interface SubjectListingSource {
    /**
     * Counts by subject id. An id without a row is absent (count 0).
     * An id that routes to another partition throws `RangeError`.
     */
    read(partition: number, ids: readonly string[]): Promise<Map<string, number>>;
}
/** Returns the partition selected by the route in UUID bytes 10–11. */
export declare function subjectPartition(id: string): number;
