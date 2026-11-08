import type { CalendarDate, FilterRelease } from '@rezics/filter';
export { chooseTexts } from './disclosure/admission.ts';
import type { IndexedSubject, SubjectSource } from './source.ts';
import type { MatchEvidence } from './match-evidence.ts';
export type HitOptions = {
    descriptions: boolean;
    languages?: readonly string[];
    properties?: readonly string[];
    matchEvidence?: MatchEvidence;
};
export type Fact = {
    kind: 'item';
    id: string;
    labels: Record<string, string>;
} | ({
    kind: 'time';
} & CalendarDate) | {
    kind: 'quantity';
    amount: number;
    unit: string;
} | {
    kind: 'code';
    value: string;
};
export type SearchHit = {
    id: string;
    type: string;
    labels: Record<string, string>;
    descriptions?: Record<string, string>;
    facts?: Record<string, Fact[]>;
    matchEvidence?: MatchEvidence;
};
/** Shared result-slot admission for the legacy and opt-in discovery representations. */
export declare function validateSearchLimit(value: unknown): number;
/** Checks the opt-in hit fields; reports the first failing element only. */
export declare function validateHitOptions(request: {
    descriptions?: unknown;
    languages?: unknown;
    properties?: unknown;
}): HitOptions;
/** Every requested property must be an item, time, quantity or code property of the active release. */
export declare function admitProperties(properties: readonly string[], release: FilterRelease): void;
export declare function projectHit(subject: IndexedSubject, options: HitOptions & {
    matchEvidence: MatchEvidence;
}): SearchHit & {
    matchEvidence: MatchEvidence;
};
export declare function projectHit(subject: IndexedSubject, options: HitOptions): SearchHit;
type Pending = Exclude<Fact, {
    kind: 'item';
}> | {
    kind: 'item';
    id: string;
};
/** The first distinct values of each requested property, in statement order. */
export declare function pendingFacts(subject: Pick<IndexedSubject, 'statements'>, properties: readonly string[]): Map<string, Pending[]>;
/**
 * Facts of every hit of a page, in the order of `subjects`. The item targets of the whole page are read once through
 * disclosure; a target that is not visible is dropped without taking a later value's place.
 */
export declare function projectFacts(source: SubjectSource, subjects: readonly IndexedSubject[], properties: readonly string[], languages: readonly string[] | undefined): Promise<Record<string, Fact[]>[]>;
export type RevalidatedHit = Readonly<{
    subject: IndexedSubject;
    hit: SearchHit;
}>;
/**
 * Final displayed fields after nested facet or label reads. Hidden, taken-down and redirected
 * subjects drop; withheld statements disappear from the current snapshot.
 *
 * Cost
 * - Touches: one grouped current Source read of accepted hit ids, then the existing fact-target
 *   disclosure for requested item properties.
 * - Bound: at most 100 hits and four properties, in 256-key Source batches. No engine read.
 * - Growth check: `test/search/query-privacy-page.test.ts` covers hydration reduction and nested
 *   label revalidation.
 */
export declare function revalidateProjectedHits(source: SubjectSource, subjects: readonly IndexedSubject[], options: HitOptions): Promise<Map<string, RevalidatedHit>>;
