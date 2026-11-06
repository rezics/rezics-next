import type { EntryImportMetadataReview } from './list-import-entry-metadata.ts';
export declare const BANGUMI_LIMITS: {
    readonly bytes: 262144;
    readonly rows: 100;
    readonly rowBytes: 8192;
    readonly evidenceBytes: 32768;
    readonly reviewBytes: 71680;
    readonly choiceBytes: 8192;
    readonly outcomeBytes: 16384;
    readonly page: 10;
    readonly pageResponseBytes: number;
    readonly apply: 5;
    readonly applyRequestBytes: 4096;
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
    claim: {
        route: number;
        externalId: string;
        subjectId: string | null;
    } | null;
    upload: {
        uploadId: string;
        ordinal: number;
        reviewToken: string;
    };
};
export type BangumiScoreSource = {
    state: 'score' | 'unrated' | 'absent' | 'unsupported';
    value?: number | string | boolean | null;
    scale: {
        minimum: 1;
        maximum: 10;
    };
    reason: string;
};
export type BangumiScoreCurrentVote = {
    state: 'absent';
} | {
    state: 'cleared';
} | {
    state: 'set';
    units: number;
    revision: number;
    at: string;
};
export type BangumiScoreQuestion = {
    id: string;
    revision: number;
    meaning: string | null;
    label: string;
    grain: 'work' | 'release' | 'episode' | 'character';
    lifecycleState: 'active' | 'retired';
    scale: {
        minimum: number;
        maximum: number;
        step: number;
    };
};
export type BangumiScoreSelection = {
    action: 'preserve';
} | {
    action: 'set';
    units: number;
} | {
    action: 'clear';
};
export type BangumiScoreReview = {
    source: BangumiScoreSource;
    native: {
        questionId: string;
        question: BangumiScoreQuestion | null;
        currentVote: BangumiScoreCurrentVote | null;
        selection: BangumiScoreSelection;
        admission: {
            status: 'unavailable';
            reason: 'native_vote_scope_required' | 'target_not_selected' | 'question_unavailable' | 'question_revision_unsupported' | 'question_scale_unsupported' | 'conditional_admission_unavailable' | 'question_observation_unavailable' | 'identity_pending' | 'identity_observation_unavailable' | 'own_vote_observation_unavailable' | 'atomic_guard_unavailable';
        } | {
            status: 'reviewed';
            reason: 'native_review_observed';
        };
    };
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
    score?: BangumiScoreReview;
    metadata?: EntryImportMetadataReview[];
};
export type BangumiScoreChoice = {
    action: 'preserve';
} | {
    action: 'set';
    units: number;
    consent: true;
} | {
    action: 'clear';
    consent: true;
};
export type BangumiScoreOutcome = {
    action: 'preserve' | 'set' | 'clear';
    status: 'applied' | 'skipped' | 'stale' | 'unsupported' | 'failed' | 'unavailable';
    reason?: string;
    vote?: {
        units: number;
        revision: number;
        at: string;
    };
};
export type BangumiChoice = {
    ordinal: number;
    reviewToken: string;
    state: 'preserve' | 'replace' | 'omit';
    skip: boolean;
    score?: BangumiScoreChoice;
};
export type BangumiOutcome = {
    ordinal: number;
    status: 'applied' | 'skipped' | 'stale' | 'unsupported' | 'failed';
    applied: string[];
    retained: string[];
    score?: BangumiScoreOutcome;
};
export type BangumiRow = {
    ordinal: number;
    evidence: BangumiEvidence;
    review: BangumiReview | null;
    outcome: BangumiOutcome | null;
};
/** A REZICS upload wrapper, never advertised as an official Bangumi export format. */
export declare function parseBangumiUpload(upload: string): BangumiEvidence[];
