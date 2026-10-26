import type { IndexedSubject } from './source.ts';
export type HitOptions = {
    descriptions: boolean;
    languages?: readonly string[];
};
export type SearchHit = {
    id: string;
    type: string;
    labels: Record<string, string>;
    descriptions?: Record<string, string>;
};
/** Checks the opt-in hit fields; reports the first failing element only. */
export declare function validateHitOptions(request: {
    descriptions?: unknown;
    languages?: unknown;
}): HitOptions;
export declare function projectHit(subject: IndexedSubject, { descriptions, languages }: HitOptions): SearchHit;
