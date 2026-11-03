import type { BangumiEvidence } from './list-import-bangumi-model.ts';
/** Selection limits constrain effects without rejecting previously admitted source evidence. */
export declare const BANGUMI_LABEL_LIMITS: {
    readonly selections: 16;
    readonly page: 32;
    readonly reviewBytes: 32768;
};
export type BangumiTagMapping = {
    index: number;
    target: {
        labelId: string;
    } | {
        name: string;
    };
};
export type BangumiTag = {
    index: number;
    value: unknown;
    status: 'supported' | 'invalid' | 'unknown';
    proposedName: string | null;
};
export type BangumiTagEvidence = 'missing' | 'empty' | 'known' | 'invalid' | 'unknown';
export type BangumiLabelItem = {
    index: number;
    source: unknown;
    status: 'ready' | 'invalid' | 'duplicate';
    duplicateOf: number | null;
    target: {
        labelId: string;
        revision: number;
    } | {
        name: string;
    };
};
export type BangumiLabelSubject = {
    subjectId: string;
    identityEpoch: string;
    acceptingType: string;
    releaseDigest: string | null;
};
export type BangumiLabelReview = {
    token: string;
    /** The retained row is immutable; its current Subject review is its revision operand. */
    rowRevision: string;
    subject: BangumiLabelSubject | null;
    evidence: BangumiTagEvidence;
    items: BangumiLabelItem[];
};
export type BangumiLabelOutcome = {
    index: number;
    status: 'assigned' | 'unchanged' | 'duplicate' | 'invalid' | 'stale' | 'capacity' | 'conflict' | 'limit' | 'failed';
    label: {
        id: string;
        revision: number;
    } | null;
    assignment: {
        id: string;
        revision: number;
    } | null;
    created: boolean;
};
export type BangumiLabelState = {
    review: BangumiLabelReview;
    confirmed: boolean;
    outcomes: BangumiLabelOutcome[];
};
/** The installed field's validity is authoritative; mixed arrays never gain partial admission. */
export declare function bangumiTagEvidence(e: BangumiEvidence): BangumiTagEvidence;
export declare function bangumiTag(e: BangumiEvidence, index: number): BangumiTag | null;
export type BangumiTagPage = {
    ordinal: number;
    rowRevision: string | null;
    evidence: BangumiTagEvidence;
    tags: BangumiTag[];
    next: number | null;
    labels: BangumiLabelState | null;
};
