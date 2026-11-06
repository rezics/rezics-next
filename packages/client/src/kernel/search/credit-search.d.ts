import type { LanguageValue } from './source.ts';
/** Limits are passed to the native reader BEFORE it expands credits or creator labels. */
export declare const CREDIT_SEARCH_LIMITS: Readonly<{
    pages: 4;
    creditsPerPage: 32;
    namesPerCreator: 16;
    qualifiersPerCredit: 4;
    nameBytes: 256;
    documentBytes: 131072;
    pageBytes: 65536;
}>;
export type CreditSearchQualifier = Readonly<{
    property: string;
    value: string;
}>;
/** Native selection, not an inferred inverse or a source-reported literal credit. */
export type CreditSearchWitness = Readonly<{
    workId: string;
    statementId: string;
    revision: number;
    release: string;
    property: string;
    targetId: string;
    direction: 'outgoing';
    qualifiers: readonly CreditSearchQualifier[];
    /** Native creator identity/name selection; changes on merge, concealment and rename. */
    nameRevision: string;
    name: LanguageValue;
}>;
export type CreditSearchEntry = Readonly<{
    witness: Omit<CreditSearchWitness, 'name'>;
    /** Complete public labels and aliases, independently bounded for each target. */
    names: readonly LanguageValue[];
    namesComplete: boolean;
}>;
export type CreditSearchPage = Readonly<{
    state: 'preparing' | 'unsupported' | 'unavailable';
}> | Readonly<{
    state: 'current';
    workId: string;
    /** Binds the complete work selection AND all creator dependencies for this traversal. */
    observation: string;
    entries: readonly CreditSearchEntry[];
    next: string | null;
}>;
/** Minimal consumer seam. The Semantic adapter owns released credit meaning and native disclosure.
 * Implementations use native indexed seeks, never the three-entry work-context preview. They must
 * charge raw examined rows and nested label work against these bounds before performing the read.
 * Missing native support is unavailable, never a complete empty page. */
export interface CreditSearchSource {
    page(input: Readonly<{
        workId: string;
        after: string | null;
        observation: string | null;
        limits: typeof CREDIT_SEARCH_LIMITS;
    }>): Promise<CreditSearchPage>;
    /** Exact current statement, directed target, qualifiers, release, name and both disclosures.
     * The receiving page must retain this observation through its final native disclosure guard. */
    current(witness: CreditSearchWitness, observation: string): Promise<boolean | 'unavailable'>;
    /** Whole dependency cut, including removed credits and creators omitted by an earlier page. */
    unchanged(workId: string, observation: string): Promise<boolean>;
}
export type CreditSearchProjection = Readonly<{
    state: 'preparing' | 'unsupported' | 'unavailable' | 'incomplete' | 'restart';
}> | Readonly<{
    state: 'complete';
    workId: string;
    observation: string;
    names: readonly CreditSearchWitness[];
}>;
/** All-or-readiness: a prefix never becomes a definitive negative for a credited-name query. */
export declare function projectCreditSearch(source: CreditSearchSource | undefined, workId: string): Promise<CreditSearchProjection>;
/** The evidence must be one ACTUAL engine match, never the first displayed creator.
 * No phrase matching in JavaScript: the existing analyzer remains the matching authority. */
export declare function currentCreditSearchMatch(source: CreditSearchSource | undefined, projection: CreditSearchProjection, matched: CreditSearchWitness): Promise<'current' | 'restart' | 'unavailable'>;
