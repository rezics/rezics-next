import type { CalendarDate, FilterRelease } from '@rezics/filter';
import type { IndexedSubject, SubjectSource } from './source.ts';
export type HitOptions = {
    descriptions: boolean;
    languages?: readonly string[];
    properties?: readonly string[];
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
/** Texts by language, choosing one through the reader's chain when given. */
export declare function chooseTexts(list: IndexedSubject['labels'], languages: readonly string[] | undefined, original: string | undefined, map?: (value: string) => string): {
    [k: string]: string;
};
export declare function projectHit(subject: IndexedSubject, { descriptions, languages }: HitOptions): SearchHit;
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
export {};
