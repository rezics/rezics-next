import type { EntryImportMetadataReview } from './list-import-entry-metadata.ts';

export declare const BANGUMI_LIMITS: {
    readonly bytes: 262144;
    readonly rows: 100;
    readonly rowBytes: 8192;
    readonly page: 10;
    readonly apply: 5;
    readonly depth: 16;
};
export type BangumiRecord = Record<string, unknown>;
export type RetainedField = {
    field: string;
    value: unknown;
    meaning: 'known' | 'unknown' | 'invalid';
    reason: string;
};
export type BangumiEvidence = {
    source: BangumiRecord;
    fields: RetainedField[];
    medium: string;
    stateRole: string | null;
};
export type BangumiGuard = {
    subjectId: string;
    releaseDigest: string;
    identityEpoch: string;
};
export type BangumiReview = {
    token: string;
    match: 'matched' | 'already_matched' | 'ambiguous' | 'unmatched' | 'unavailable' | 'chosen';
    candidates: string[];
    target: string | null;
    guard: BangumiGuard | null;
    proposedState: string | null;
    current: {
        state: string;
        revision: number;
        incarnationId?: string | null;
    } | null;
    conflict: boolean;
    metadata?: EntryImportMetadataReview[];
};
export type BangumiChoice = {
    ordinal: number;
    reviewToken: string;
    state: 'preserve' | 'replace' | 'omit';
    skip: boolean;
};
export type BangumiOutcome = {
    ordinal: number;
    status: 'applied' | 'skipped' | 'stale' | 'unsupported' | 'failed';
    applied: string[];
    retained: string[];
};
export type BangumiRow = {
    ordinal: number;
    evidence: BangumiEvidence;
    review: BangumiReview | null;
    outcome: BangumiOutcome | null;
};
/** A REZICS upload wrapper, never advertised as an official Bangumi export format. */
export declare function parseBangumiUpload(upload: string): BangumiEvidence[];

