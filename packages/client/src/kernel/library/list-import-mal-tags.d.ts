import type { MalRow } from './list-import-mal-parser.ts';
/** Adoption bounds do not change the upload or retained-document allowances. */
export declare const MAL_LABEL_LIMITS: {
    readonly rows: 20;
    readonly values: 32;
    readonly newLabels: 32;
    readonly sourceBytes: 8192;
    readonly selectionBytes: 16384;
    readonly outputBytes: 524288;
};
export declare const malDigest: (value: unknown) => string;
export type MalTagEvidence = {
    kind: 'missing' | 'empty' | 'unknown' | 'invalid' | 'unsupported' | 'supported';
    raw?: string;
    grammar: 'mal-comma-v1';
    values: {
        index: number;
        raw: string;
        value: string;
        duplicateOf: number | null;
    }[];
    reason: string | null;
};
/** Use the retained XML leaf, never the display title, MalValue rendering or comments.
 * XML entities/CDATA have already been decoded by the installed upload parser.
 * The supported subset has literal commas and no quoting or backslash escaping.
 * Ambiguous quoting/escaping is evidence only; it is never partially tokenized.
 */
export declare function malTagEvidence(row: Pick<MalRow, 'fields'>): MalTagEvidence;
export type MalLabelSelection = {
    value: number;
    target: {
        labelId: string;
        revision: number;
    } | {
        name: string;
    };
};
export type MalReviewedLabel = {
    value: number;
    sourceValue: string | null;
    target: {
        labelId: string;
        revision: number;
    } | {
        name: string;
    } | null;
    status: 'ready' | 'duplicate' | 'invalid' | 'collision' | 'unavailable' | 'unsupported';
    reason: string | null;
};
export type MalLabelReview = {
    evidence: MalTagEvidence;
    sourceDigest: string;
    selections: MalReviewedLabel[];
    selectionDigest: string;
};
export type MalLabelOutcome = {
    value: number;
    status: 'accepted' | 'unchanged' | 'stale' | 'unsupported' | 'failed';
    labelId: string | null;
    assignment: {
        id: string;
        revision: number;
    } | null;
    reason: string | null;
};
