import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { type Access, type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { LibraryProfileDescriptor } from './profile.ts';
import { type AniListLabelReview, type AniListLabelWork } from './list-import-anilist-labels.ts';
import { type AniListRow } from './list-import-anilist-parser.ts';
import { type ImportConsumptionDateIntent, type ImportConsumptionDateReview, type ImportDateAction, type ImportDateField, type ImportDateSessionIdentity } from './import-consumption.ts';
import { type RatingQuestion, type VoteReviewGuard, type VoteReviewCurrentVote } from '../rating/votes.ts';
import { type EntryImportMetadataOutcome, type EntryImportMetadataProposals, type EntryImportMetadataReview, type EntryImportMetadataView } from './list-import-entry-metadata.ts';
import { progressResults, type ProgressAdoptionCheckpoint, type ProgressAdoptionInput, type ProgressAdoptionPlan, type ProgressProfileBinding } from './list-import-progress-adoption.ts';
type Dependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    routeKey: Uint8Array;
    clock?: KernelClock;
};
export type AniListMatch = {
    state: 'matched' | 'ambiguous' | 'unmatched' | 'unavailable';
    candidates: string[];
    fingerprint: string;
};
export type AniListObservation = {
    subjectId: string;
    epoch: string;
    pin: unknown;
    proposedState: string | null;
    current: {
        state: string;
        revision: number;
        incarnationId: string | null;
    } | null;
    states: {
        id: string;
        role?: string;
    }[];
    profile?: LibraryProfileDescriptor | null;
    profileBinding?: ProgressProfileBinding | null;
};
export type AniListReviewInput = {
    subjectId?: string;
    skip?: boolean;
    fields: string[];
    replace?: boolean;
    progress?: ProgressAdoptionInput;
    score?: {
        action: 'vote';
        questionId: string;
        questionRevision: number;
        units: number;
    } | {
        action: 'clear';
        questionId: string;
        questionRevision: number;
    };
};
export type AniListNativeQuestion = Pick<RatingQuestion, 'id' | 'revision' | 'meaning' | 'label' | 'grain' | 'minimumUnits' | 'maximumUnits' | 'stepUnits' | 'lifecycleState' | 'lifecycleRevision'>;
export type AniListScoreReview = {
    source: {
        present: true;
        value: unknown;
        lexeme: string | null;
        scale: string | null;
        validity: 'valid' | 'unknown' | 'invalid';
        reason: string;
    };
    action: 'vote' | 'clear';
    units: number | null;
    conversion: 'owner-selected-native-units';
    native: {
        availability: 'available' | 'unavailable';
        reason?: string;
        guard?: VoteReviewGuard;
        question: AniListNativeQuestion;
        target: {
            subjectId: string;
            identityEpoch: string;
            matchFingerprint: string;
        };
        currentVote: {
            status: 'current';
            vote: VoteReviewCurrentVote;
        } | {
            status: 'unavailable';
            reason: string;
        };
        commandKey: string;
        consentKey: string;
        consented: boolean;
    };
};
export type AniListScoreOutcome = {
    status: 'skipped' | 'stale' | 'unsupported' | 'failed' | 'unavailable' | 'applied';
    reason?: string;
};
export type AniListDateReviewInput = {
    ordinal: number;
    sourceReviewToken: string;
    occurrenceId: string;
    startAction?: ImportDateAction;
    finishAction?: ImportDateAction;
};
export type AniListDateApplyInput = {
    confirm: true;
    rows: {
        ordinal: number;
        version: string;
        fields: ImportDateField[];
    }[];
};
type Review = {
    id: string;
    match: AniListMatch;
    observation: AniListObservation | null;
    input: AniListReviewInput;
    commandKey: string;
    clientId: string;
    requestedBy: string | null;
    sourceFingerprint: string;
    progress?: ProgressAdoptionPlan;
    score?: AniListScoreReview;
};
export type AniListOutcome = {
    ordinal: number;
    status: 'applied' | 'skipped' | 'stale' | 'unsupported' | 'failed' | 'unavailable';
    retained: string[];
    score?: AniListScoreOutcome;
    progress?: {
        occurrence: ProgressAdoptionCheckpoint['occurrence'];
        complete: boolean;
        measures: ReturnType<typeof progressResults>;
    };
};
export type AniListStored = {
    source: AniListRow;
    review?: Review;
    consumptionDateReview?: ImportConsumptionDateReview;
    consumptionDateIntent?: ImportConsumptionDateIntent;
    metadataReviews?: EntryImportMetadataReview[];
    started?: boolean;
    progress?: ProgressAdoptionCheckpoint;
    outcome?: AniListOutcome;
    labelReview?: AniListLabelReview;
    labelWork?: Record<number, AniListLabelWork>;
};
type Header = {
    document: unknown;
    rawUpload: string;
    scoreFormat: string | null;
    count: number;
    cancelled: boolean;
};
export declare function anilistMetadataProposals(row: AniListRow): EntryImportMetadataProposals;
/** This source composes existing account, identifier, profile and entry commands; it has no scheduler. */
export declare function createAniListImport(deps: Dependencies): {
    reviewLabels: (actor: Actor, id: string, ordinal: number, input: import("./list-import-anilist-labels.ts").AniListLabelReviewInput, key: string) => Promise<{
        ordinal: number;
        review: AniListLabelReview;
    }>;
    applyLabels: (actor: Actor, id: string, confirmations: {
        ordinal: number;
        reviewId: string;
    }[], signal?: AbortSignal) => Promise<{
        outcomes: {
            ordinal: number;
            reviewId: string;
            items: import("./list-import-anilist-labels.ts").AniListLabelItemOutcome[];
            complete: boolean;
        }[];
        complete: boolean;
    }>;
    preview: (actor: Actor, upload: string, scoreFormat: string | undefined, key: string) => Promise<{
        id: string;
        count: number;
    }>;
    page: (actor: Actor, id: string, after: number) => Promise<{
        header: Header;
        rows: {
            source: AniListRow;
            review?: Review;
            consumptionDateIntent?: ImportConsumptionDateIntent;
            metadataReviews?: EntryImportMetadataReview[];
            started?: boolean;
            outcome?: AniListOutcome;
            labelReview?: AniListLabelReview;
            labelWork?: Record<number, AniListLabelWork>;
            ordinal: number;
            currentScore: {
                status: 'current';
                question: AniListNativeQuestion;
                vote: VoteReviewCurrentVote;
                reason?: never;
            } | {
                question?: never;
                vote?: never;
                status: 'unavailable';
                reason: "atomic_guard_unavailable" | "identity_observation_unavailable" | "identity_pending" | "own_vote_observation_unavailable" | "question_observation_unavailable";
            } | null;
            labelEvidence: {
                membership: "available" | "empty" | "invalid" | "missing" | "oversized" | "unknown" | "unsupported";
                grouping: string;
                values: import("./list-import-anilist-label-evidence.ts").AniListLabelValue[];
                selectable: import("./list-import-anilist-label-evidence.ts").AniListLabelValue[];
                tagEvidence: {
                    entry: "available" | "empty" | "invalid" | "missing" | "oversized" | "unknown" | "unsupported";
                    media: "available" | "empty" | "invalid" | "missing" | "oversized" | "unknown" | "unsupported";
                    membership: 'unavailable';
                };
                tags: "available" | "empty" | "invalid" | "missing" | "oversized" | "unknown" | "unsupported";
                reason: string;
            };
            match: AniListMatch;
            proposal: AniListObservation | null;
            progressMeasures: {
                readonly field: string;
                readonly unit: string | null;
                readonly state: "invalid" | "missing" | "unknown" | "value" | "zero";
                readonly unitSupported: boolean;
                readonly amount?: string;
                readonly eligibility: "invalid" | "missing" | "ready" | "unknown" | "unsupported" | "value" | "zero";
                readonly reason: "current-profile-does-not-admit-scalar-unit" | "source-field-has-no-unit-mapping" | "source-value-is-outside-current-profile-rules" | null;
            }[];
            progress: {
                occurrence: {
                    sessionId: string;
                    startedAt: string;
                    transactionId: string;
                    revision: number;
                } | null;
                complete: boolean;
                measures: import("./list-import-progress-adoption.ts").ProgressAdoptionMeasureResult[];
            } | null;
            consumptionDateReview: {
                version: string;
                sourceReviewToken: string;
                subjectId: string;
                occurrence: ImportDateSessionIdentity;
                journalRevision: number;
                current: Readonly<{
                    startDate: import("@rezics/progress").ProgressSessionJournalDate | null;
                    finishDate: import("@rezics/progress").ProgressSessionJournalDate | null;
                }>;
                actions: Readonly<Partial<Record<ImportDateField, ImportDateAction>>>;
                fields: Readonly<Record<ImportDateField, import("./import-consumption.ts").ImportDateFieldReview>>;
            } | null;
            consumptionDateOutcome: Readonly<{
                version: string;
                status: 'applied' | 'skipped' | 'unsupported' | 'stale' | 'failed' | 'unattempted';
                fields: readonly import("./import-consumption.ts").ImportDateFieldOutcome[];
                receipt: import("@rezics/progress").ProgressSessionJournalWrite | null;
            }> | null;
        }[];
        next: number | null;
    }>;
    review: (actor: Actor, id: string, ordinal: number, input: AniListReviewInput, key: string) => Promise<{
        ordinal: number;
        review: Review;
    }>;
    reviewMetadata: (actor: Actor, id: string, ordinal: number, sourceReviewToken: string, key: string) => Promise<{
        ordinal: number;
        reviewToken: string;
    }>;
    reviewConsumptionDates: (actor: Actor, id: string, input: AniListDateReviewInput, key: string) => Promise<Readonly<{
        version: string;
        sourceReviewToken: string;
        sourceFingerprint: string;
        matchFingerprint: string;
        subjectId: string;
        profileDigest: string;
        profileBinding: unknown;
        occurrenceProfileBinding: unknown;
        occurrence: ImportDateSessionIdentity;
        journalRevision: number;
        current: Readonly<{
            startDate: import("@rezics/progress").ProgressSessionJournalDate | null;
            finishDate: import("@rezics/progress").ProgressSessionJournalDate | null;
        }>;
        actions: Readonly<Partial<Record<ImportDateField, ImportDateAction>>>;
        fields: Readonly<Record<ImportDateField, import("./import-consumption.ts").ImportDateFieldReview>>;
    }>>;
    applyConsumptionDates: (actor: Actor, id: string, input: AniListDateApplyInput, signal?: AbortSignal, record?: (value: unknown) => void) => Promise<{
        importId: string;
        outcomes: {
            version: string;
            status: 'applied' | 'skipped' | 'unsupported' | 'stale' | 'failed' | 'unattempted';
            fields: readonly import("./import-consumption.ts").ImportDateFieldOutcome[];
            receipt: import("@rezics/progress").ProgressSessionJournalWrite | null;
            ordinal: number;
        }[];
        complete: boolean;
    }>;
    metadata: (actor: Actor, id: string, ordinal: number, reviewToken: string) => Promise<EntryImportMetadataView>;
    applyMetadata: (actor: Actor, id: string, ordinal: number, reviewToken: string, fields: unknown, signal?: AbortSignal) => Promise<EntryImportMetadataOutcome>;
    apply: (actor: Actor, id: string, confirmations: {
        ordinal: number;
        reviewId: string;
        confirmNativeVoteEffects?: true;
    }[], signal?: AbortSignal) => Promise<{
        outcomes: AniListOutcome[];
        complete: boolean;
    }>;
    cancel: (actor: Actor, id: string, key: string, remove?: boolean) => Promise<{
        cancelled: boolean;
    }>;
};
export {};
