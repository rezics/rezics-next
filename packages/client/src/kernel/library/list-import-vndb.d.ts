import { type AuthoritativeTime, type CommandOutcome } from '../command/command.ts';
import { type Actor } from '../request/access.ts';
import { type RatingQuestion } from '../rating/votes.ts';
import { createEntryCommands } from './entries.ts';
import { type VndbEntryReview } from './list-import-vndb-admission.ts';
import { type SourceValue, type VndbRow } from './list-import-vndb-parser.ts';
import { type ImportConsumptionDateIntent, type ImportConsumptionDateReview, type ImportDateAction, type ImportDateField, type ImportDateSessionIdentity } from './import-consumption.ts';
import { type EntryImportMetadataOutcome, type EntryImportMetadataProposals, type EntryImportMetadataReview } from './list-import-entry-metadata.ts';
type Config = Parameters<typeof createEntryCommands>[0] & {
    routeKey: Uint8Array;
};
export type VndbScoreSelection = {
    kind: 'vote';
    units: number;
} | {
    kind: 'clear';
};
export type VndbChoice = {
    ordinal: number;
    action: 'skip' | 'retain';
    targetId?: string;
} | {
    ordinal: number;
    action: 'state';
    targetId?: string;
    state: string;
    replace?: boolean;
} | {
    ordinal: number;
    action: 'score';
    targetId?: string;
    questionId: string;
    questionRevision: number;
    selection: VndbScoreSelection;
    consent: 'adopt-native-vote' | 'clear-native-vote';
};
type NativeQuestion = {
    id: string;
    revision: number;
    meaning: string | null;
    label: string;
    grain: RatingQuestion['grain'];
    scale: {
        min: number;
        max: number;
        step: number;
    };
    aggregateEffect: 'public-standard-aggregate';
};
type NativeVoteObservation = {
    state: 'unavailable';
} | {
    state: 'absent';
} | {
    state: 'cleared';
    revision: number;
    at: string;
} | {
    state: 'set';
    units: number;
    revision: number;
    at: string;
};
type ScoreDecision = {
    reviewId: string;
    status: 'reviewed' | 'unavailable' | 'applied' | 'skipped' | 'stale' | 'failed';
    targetId: string;
    action: 'vote' | 'clear';
    units: number | null;
    question: NativeQuestion;
    currentVote: NativeVoteObservation;
    consent: 'adopt-native-vote' | 'clear-native-vote';
    sourceScore: SourceValue;
    sourceReason: string;
    targetFingerprint: string;
    commandKey: string;
    guard: VndbEntryReview;
    nativeAdmission: 'unavailable';
};
export type VndbDateReviewInput = {
    ordinal: number;
    sourceReviewToken: string;
    occurrenceId: string;
    startAction?: ImportDateAction;
    finishAction?: ImportDateAction;
};
export type VndbDateApplyInput = {
    confirm: true;
    rows: {
        ordinal: number;
        version: string;
        fields: ImportDateField[];
    }[];
};
type Decision = {
    reviewId: string;
    status: 'reviewed' | 'applying' | 'applied' | 'skipped' | 'unsupported' | 'stale' | 'failed';
    stateAction?: 'state' | 'skip' | 'retain' | null;
    targetId: string | null;
    state: string | null;
    baseline: {
        state: string;
        revision: number;
        incarnationId: string | null;
    } | null;
    replace: boolean;
    commandKey: string;
    guard: VndbEntryReview | null;
    receipt?: {
        partition: number;
        epoch: number;
        position: string;
        transactionId: string;
    };
    matchDigest?: string;
    metadata?: EntryImportMetadataReview[];
    score?: ScoreDecision;
    consumptionDateReview?: ImportConsumptionDateReview;
    consumptionDateIntent?: ImportConsumptionDateIntent;
};
type NativeScoreReviewResult = {
    reviewId: string;
    status: ScoreDecision['status'];
    targetId: string;
    action: ScoreDecision['action'];
    units: number | null;
    question: NativeQuestion;
    currentVote: NativeVoteObservation;
    consent: ScoreDecision['consent'];
    sourceReason: string;
    nativeAdmission: 'unavailable';
} | {
    status: 'unavailable';
    reason: 'native-question-unavailable' | 'native-current-vote-unavailable';
};
type NativeScorePreview = {
    question: NativeQuestion | null;
    currentVote: NativeVoteObservation;
    sourceReason: string;
    exactUnits: number | null;
    admission: {
        status: 'unavailable';
        reason: 'conditional-admission-unavailable' | 'native-question-unavailable' | 'native-current-vote-unavailable' | 'source-not-vn-score';
    };
};
export declare function vndbMetadataProposals(row: VndbRow): EntryImportMetadataProposals;
type Upload = {
    upload_id: string;
    state: 'active' | 'cancelled';
    expires_at: Date;
    rows: VndbRow[];
    decisions: Record<string, Decision>;
    xml: string;
};
/** Upload-local composition of existing native Library entry commands. No provider fetch or public output. */
export declare function createVndbImport(config: Config): {
    preview: (actor: Actor, xml: string, key: string) => Promise<CommandOutcome<{
        uploadId: `${string}-${string}-${string}-${string}-${string}`;
        rows: number;
        limits: {
            readonly bytes: number;
            readonly wireBytes: number;
            readonly depth: 32;
            readonly rows: 5000;
            readonly evidenceBytes: number;
            readonly page: 8;
            readonly uploads: 4;
            readonly lifetimeMs: 86400000;
            readonly applyMs: 5000;
        };
    }>>;
    page: (actor: Actor, id: string, offset: number) => Promise<{
        uploadId: string;
        state: "active" | "cancelled";
        expiresAt: string;
        total: number;
        next: number | null;
        rows: {
            ordinal: number;
            kind: 'vn' | 'retained';
            identifier: {
                provider: 'vndb';
                kind: 'vn';
                value: string;
            } | null;
            title: string;
            labels: string[];
            suggestedRole: string | null;
            fields: Record<string, SourceValue>;
            retainedReason: string;
            evidence: unknown;
            match: {
                status: 'unsupported';
                candidates: string[];
            } | {
                status: "ambiguous" | "matched" | "unavailable" | "unmatched";
                candidates: string[];
            };
            target: {
                targetId: string;
                states: {
                    id: string;
                    labels: import("@rezics/definitions").LibraryLabels;
                    role?: 'planned' | 'active' | 'completed' | 'paused' | 'dropped';
                }[];
                baseline: {
                    state: string;
                    revision: number;
                    incarnationId: string | null;
                } | null;
            } | null;
            decision: {
                reviewId: string;
                status: "applied" | "applying" | "failed" | "reviewed" | "skipped" | "stale" | "unsupported";
                targetId: string | null;
                state: string | null;
                baseline: {
                    state: string;
                    revision: number;
                    incarnationId: string | null;
                } | null;
                replace: boolean;
                action: "retain" | "skip" | "state" | null;
            } | null;
            scoreDecision: NativeScoreReviewResult | null;
            nativeScore: NativeScorePreview;
            consumptionDateReview: {
                version: string;
                sourceReviewToken: string;
                subjectId: string;
                occurrence: ImportDateSessionIdentity;
                journalRevision: number;
                current: Readonly<{
                    startDate: import("./progress-model.ts").ProgressSessionJournalDate | null;
                    finishDate: import("./progress-model.ts").ProgressSessionJournalDate | null;
                }>;
                actions: Readonly<Partial<Record<ImportDateField, ImportDateAction>>>;
                fields: Readonly<Record<ImportDateField, import("./import-consumption.ts").ImportDateFieldReview>>;
            } | null;
            consumptionDateOutcome: Readonly<{
                version: string;
                status: 'applied' | 'skipped' | 'unsupported' | 'stale' | 'failed' | 'unattempted';
                fields: readonly import("./import-consumption.ts").ImportDateFieldOutcome[];
                receipt: import("./progress-model.ts").ProgressSessionJournalWrite | null;
            }> | null;
            fieldsTreatment: {
                state: string;
                score: string;
                other: string;
            };
        }[];
    }>;
    review: (actor: Actor, id: string, choice: VndbChoice, key: string) => Promise<CommandOutcome<{
        reviewId: string;
        status: "applied" | "applying" | "failed" | "reviewed" | "skipped" | "stale" | "unsupported";
        targetId: string | null;
        state: string | null;
        baseline: {
            state: string;
            revision: number;
            incarnationId: string | null;
        } | null;
        replace: boolean;
        action: "retain" | "skip" | "state" | null;
    }> | CommandOutcome<NativeScoreReviewResult>>;
    reviewConsumptionDates: (actor: Actor, id: string, input: VndbDateReviewInput, key: string) => Promise<CommandOutcome<{
        version: string;
        sourceReviewToken: string;
        subjectId: string;
        occurrence: ImportDateSessionIdentity;
        journalRevision: number;
        current: Readonly<{
            startDate: import("./progress-model.ts").ProgressSessionJournalDate | null;
            finishDate: import("./progress-model.ts").ProgressSessionJournalDate | null;
        }>;
        actions: Readonly<Partial<Record<ImportDateField, ImportDateAction>>>;
        fields: Readonly<Record<ImportDateField, import("./import-consumption.ts").ImportDateFieldReview>>;
    }>>;
    applyConsumptionDates: (actor: Actor, id: string, input: VndbDateApplyInput, record: (outcome: CommandOutcome<unknown>) => void, signal?: AbortSignal) => Promise<{
        uploadId: string;
        outcomes: {
            version: string;
            status: 'applied' | 'skipped' | 'unsupported' | 'stale' | 'failed' | 'unattempted';
            fields: readonly import("./import-consumption.ts").ImportDateFieldOutcome[];
            receipt: import("./progress-model.ts").ProgressSessionJournalWrite | null;
            ordinal: number;
        }[];
        complete: boolean;
        stopped: string | null;
    }>;
    reviewMetadata: (actor: Actor, id: string, ordinal: number, sourceReviewToken: string, key: string) => Promise<CommandOutcome<{
        ordinal: number;
        reviewToken: string;
    }>>;
    metadata: (actor: Actor, id: string, ordinal: number, token: string) => Promise<Readonly<{
        status: 'current' | 'stale';
        reviewToken: string;
        sourceReviewToken: string;
        subjectId: string;
        personal: import("./entry-personal-model.ts").PersonalEntry;
        proposals: EntryImportMetadataProposals;
        outcome: EntryImportMetadataOutcome | null;
    }>>;
    applyMetadata: (actor: Actor, id: string, ordinal: number, reviewToken: string, fields: unknown, recordCommand?: (outcome: CommandOutcome<unknown>) => void, signal?: AbortSignal) => Promise<Readonly<{
        reviewToken: string;
        fields: readonly import("./list-import-entry-metadata.ts").EntryImportMetadataFieldOutcome[];
    }> | {
        reviewToken: string;
        fields: {
            field: import("./list-import-entry-metadata.ts").EntryImportMetadataField;
            status: 'stale';
        }[];
    }>;
    apply: (actor: Actor, id: string, selected: {
        ordinal: number;
        reviewId?: string;
        scoreReviewId?: string;
    }[], record: (outcome: CommandOutcome<unknown>) => void, signal?: AbortSignal) => Promise<{
        uploadId: string;
        outcomes: {
            ordinal: number;
            reviewId?: string;
            scoreReviewId?: string;
            status: string;
        }[];
        stopped: "cancelled" | "deadline" | null;
    }>;
    remove: (actor: Actor, id: string, key: string, cancel: boolean) => Promise<CommandOutcome<{
        uploadId: string;
        state: string;
    }>>;
    retainedRow: (actor: Actor, id: string, ordinal: number) => Promise<{
        row: VndbRow;
        decision: Decision | null;
        state: Upload['state'];
        expires_at: Date;
        matching: {
            status: 'unsupported';
            candidates: string[];
        } | {
            status: "ambiguous" | "matched" | "unavailable" | "unmatched";
            candidates: string[];
        };
        target: {
            targetId: string;
            source: string;
            states: {
                id: string;
                labels: import("@rezics/definitions").LibraryLabels;
                role?: 'planned' | 'active' | 'completed' | 'paused' | 'dropped';
            }[];
            profileSupported: boolean;
            baseline: {
                state: string;
                revision: number;
                incarnationId: string | null;
            } | null;
        } | null;
    }>;
    authorized: (actor: Actor) => Promise<AuthoritativeTime>;
    source: (actor: Actor, id: string) => Promise<{
        xml: string;
    }>;
};
export {};
