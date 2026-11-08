import type { DiscoveryFilterDocument, ConceptSelection, FilterQualifier, FilterRange } from '@rezics/filter';
import type { IndexedSubject } from '../source.ts';
/** Native analyzer names are vocabulary, independent of the physical adapter. */
export declare const CJK_ANALYZER = "cjk_bigram_v2";
export declare const NAME_PREFIX_ANALYZER = "name_prefix";
export type EngineToken = Readonly<{
    token: string;
    position: number;
    startOffset: number;
    endOffset: number;
}>;
/** One OpenSearch hit, including the indexed partition, security revision and matched query names. */
export type Hit = {
    id: string;
    partition: number;
    securityRevision: number;
    matched: readonly string[];
};
/** A filter leaf compiled by the route, keyed by its query name. */
export type FactClause = {
    facet: 'type';
    values: readonly string[];
} | {
    facet: 'statement';
    property: string;
    qualifiers?: readonly FilterQualifier[];
    values: readonly string[];
    concept?: ConceptSelection;
    inverse?: true;
} | {
    facet: 'statement';
    property: string;
    qualifiers?: readonly FilterQualifier[];
    range: FilterRange;
};
/** Texts by language, choosing one through the reader's chain when given. */
export declare function chooseTexts(list: IndexedSubject['labels'], languages: readonly string[] | undefined, original: string | undefined, map?: (value: string) => string): {
    [k: string]: string;
};
type SelectedConcept = Readonly<{
    property: string;
    concept: string;
    scheme: string;
}>;
export declare function conceptSelectionIdentity(selection: SelectedConcept): string;
export declare function conceptSelections(filter: DiscoveryFilterDocument): SelectedConcept[];
export {};
