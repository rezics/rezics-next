import type { Pool } from 'pg';
import { type CommandOutcome } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { type Access, type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { SessionComponent } from '../tokens/session.ts';
import type { ProgressSessionJournalDate } from './progress-model.ts';
import type { createSessionCommands } from './sessions.ts';
import type { Entry } from './entry-model.ts';
import { type MalRow } from './list-import-mal-parser.ts';
import { type RatingQuestion, type VoteReviewGuard } from '../rating/votes.ts';
import { type MalLabelReview, type MalLabelSelection, type MalLabelOutcome } from './list-import-mal-tags.ts';
import { type EntryImportMetadataOutcome, type EntryImportMetadataProposals } from './list-import-entry-metadata.ts';
import { progressResults, type ProgressAdoptionCheckpoint, type ProgressAdoptionInput, type ProgressAdoptionPlan } from './list-import-progress-adoption.ts';
export type MalReviewInput = {
    row: number;
    target: string | null;
    skip: boolean;
    replace: boolean;
    labels?: MalLabelSelection[];
    progress?: ProgressAdoptionInput;
    score?: MalScoreReviewInput;
};
export type MalScoreReviewInput = {
    action: 'adopt';
    questionId: string;
    questionRevision: number;
    units: number;
    replaceCurrent?: boolean;
} | {
    action: 'clear';
    questionId: string;
    questionRevision: number;
};
export type MalScoreReview = {
    action: 'adopt' | 'clear';
    source: MalRow['score'];
    sourceSupport: {
        status: 'owner-selection-required' | 'no-source-vote';
        reason: 'native-units-require-explicit-selection' | 'source-score-outside-integer-1-through-10' | 'source-zero-means-no-rating' | 'source-score-absent';
    };
    conversion: 'owner-selected-not-exact';
    question: Pick<RatingQuestion, 'id' | 'revision' | 'label' | 'meaning' | 'grain' | 'lifecycleState'> & {
        scale: Pick<RatingQuestion, 'minimumUnits' | 'maximumUnits' | 'stepUnits'>;
    };
    units: number | null;
    replaceCurrent: boolean;
    support: {
        status: 'supported' | 'unsupported';
        reason: string | null;
    };
    baseline: {
        state: 'present' | 'cleared' | 'absent';
        units: number | null;
        revision: number | null;
        at: string | null;
    };
    guard?: VoteReviewGuard;
    admission: {
        status: 'conditional';
        reason: null;
    } | {
        status: 'unavailable';
        reason: 'conditional-vote-admission-unavailable';
        missingGuard: 'question-revision-and-target-identity-and-current-vote-revision';
    };
};
export type MalScoreOutcome = {
    action: 'adopt' | 'clear' | null;
    status: 'applied' | 'unavailable' | 'stale' | 'skipped' | 'unsupported' | 'failed';
    reason: string | null;
    vote: {
        units: number | null;
        revision: number;
        at: string;
    } | null;
};
export type MalDateField = 'startDate' | 'finishDate';
export type MalDateAction = 'adopt' | 'clear';
export type MalDateReviewInput = {
    row: number;
    occurrenceId: string;
    startAction?: MalDateAction;
    finishAction?: MalDateAction;
};
export type MalDateReviewField = {
    action: MalDateAction | null;
    status: 'already-equal' | 'ready' | 'conflict' | 'unsupported' | 'unknown' | 'not-selected' | 'clear';
    sourceKind: MalRow['dates'][string]['kind'];
    current: ProgressSessionJournalDate | null;
    proposed: ProgressSessionJournalDate | null;
    comparison: 'same' | 'different' | null;
};
export type MalDateReview = {
    version: string;
    importReviewVersion: string;
    target: string;
    occurrence: {
        sessionId: string;
        versionSubjectId: string | null;
        profilePinDigest: string;
    };
    journalRevision: number;
    profileCurrent: boolean;
    startDate: MalDateReviewField;
    finishDate: MalDateReviewField;
};
export type MalDateApplyInput = {
    confirm: true;
    rows: {
        row: number;
        version: string;
        fields: MalDateField[];
    }[];
};
export type MalDateFieldOutcome = {
    field: MalDateField;
    status: 'applied' | 'already-equal' | 'unknown' | 'unsupported' | 'not-selected' | 'stale' | 'failed';
};
export type MalDateOutcome = {
    row: number;
    version: string;
    status: 'applied' | 'skipped' | 'stale' | 'unsupported' | 'failed';
    fields: MalDateFieldOutcome[];
    receipt: {
        sessionId: string;
        revision: number;
        changed: boolean;
    } | null;
    reason: string | null;
};
export declare const MAL_DATE_LIMITS: {
    readonly rows: 20;
    readonly fields: 2;
    readonly requestBytes: 16384;
    readonly resultBytes: 524288;
};
export type MalApplyInput = {
    confirm: true;
    rows: {
        row: number;
        version: string;
        fields: string[];
    }[];
};
export type MalOutcome = {
    row: number;
    status: 'applied' | 'skipped' | 'stale' | 'unsupported' | 'unavailable' | 'failed';
    applied: string[];
    retained: string[];
    reason: string | null;
    score?: MalScoreOutcome;
    labels?: MalLabelOutcome[];
    remainingLabels?: number[];
    progress?: {
        occurrence: ProgressAdoptionCheckpoint['occurrence'];
        complete: boolean;
        measures: ReturnType<typeof progressResults>;
    };
};
type Binding = {
    subject: string;
    route: number;
    source: string;
    externalId: string;
};
export type MalReview = {
    version: string;
    target: string | null;
    skip: boolean;
    replace: boolean;
    state: string | null;
    current: Pick<Entry, 'state' | 'revision' | 'incarnationId'> | null;
    binding: Binding | null;
    source: {
        release: string;
        epoch: string;
        acceptingType: string;
    } | null;
    conflict: boolean;
    unsupported: string | null;
    score?: MalScoreReview;
    labels?: MalLabelReview;
    fingerprint: string;
    progress?: ProgressAdoptionPlan;
};
export type MalMetadataReviewInput = {
    row: number;
    sourceReviewToken: string;
};
type Dependencies = {
    pool: Pool;
    access: Access;
    tokens: KeyRing;
    routeKey: Uint8Array;
    journal: ReturnType<typeof createSessionCommands>;
    clock?: KernelClock;
};
export declare function malMetadataProposals(row: MalRow): EntryImportMetadataProposals;
/** One source's bounded composition of current Semantic observations and native Library commands. */
export declare function createMalImport(deps: Dependencies): {
    preview: (actor: Actor, xml: string, key: string, deadline: number) => Promise<CommandOutcome<{
        id: `${string}-${string}-${string}-${string}-${string}`;
    }>>;
    page: (actor: Actor, id: string, after: number, deadline: number) => Promise<{
        id: string;
        canceled: boolean;
        total: number;
        rows: ({
            index: number;
            kind: 'anime' | 'manga';
            title: string;
            identifier: {
                namespace: string;
                source: string;
                value: string;
            };
            status: import("./list-import-mal-parser.ts").MalValue;
            role: string | null;
            score: import("./list-import-mal-parser.ts").MalValue & {
                scale: {
                    min: 1;
                    max: 10;
                    step: 1;
                };
            };
            dates: Record<string, import("./list-import-mal-parser.ts").MalValue>;
            notes: import("./list-import-mal-parser.ts").MalValue;
            tags: import("./list-import-mal-parser.ts").MalValue;
            repeats: import("./list-import-mal-parser.ts").MalValue;
            privacy: import("./list-import-mal-parser.ts").MalValue;
            timestamps: Record<string, import("./list-import-mal-parser.ts").MalValue>;
            fields: Record<string, string>;
            retained: {
                field: string;
                reason: string;
            }[];
            target: null;
            binding: Binding | null;
            source: null;
            current: null;
            state: null;
            match: 'unmatched';
            tagEvidence: import("./list-import-mal-tags.ts").MalTagEvidence;
            candidates: {
                subjectId: string;
            }[];
            review: MalReview | null;
            scoreReviewState: "observations-match" | "stale" | "unavailable" | null;
            currentScoreVote: {
                units: number | null;
                revision: number;
                at: string;
            } | null;
            outcome: MalOutcome | null;
            dateReview: MalDateReview | null;
            dateOutcome: MalDateOutcome | null;
            labelOutcomes: MalLabelOutcome[];
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
        } | {
            index: number;
            kind: 'anime' | 'manga';
            title: string;
            identifier: {
                namespace: string;
                source: string;
                value: string;
            };
            status: import("./list-import-mal-parser.ts").MalValue;
            role: string | null;
            score: import("./list-import-mal-parser.ts").MalValue & {
                scale: {
                    min: 1;
                    max: 10;
                    step: 1;
                };
            };
            dates: Record<string, import("./list-import-mal-parser.ts").MalValue>;
            notes: import("./list-import-mal-parser.ts").MalValue;
            tags: import("./list-import-mal-parser.ts").MalValue;
            repeats: import("./list-import-mal-parser.ts").MalValue;
            privacy: import("./list-import-mal-parser.ts").MalValue;
            timestamps: Record<string, import("./list-import-mal-parser.ts").MalValue>;
            fields: Record<string, string>;
            retained: {
                field: string;
                reason: string;
            }[];
            target: null;
            binding: null;
            source: null;
            current: null;
            state: null;
            match: 'unavailable';
            tagEvidence: import("./list-import-mal-tags.ts").MalTagEvidence;
            candidates: {
                subjectId: string;
            }[];
            review: MalReview | null;
            scoreReviewState: "observations-match" | "stale" | "unavailable" | null;
            currentScoreVote: {
                units: number | null;
                revision: number;
                at: string;
            } | null;
            outcome: MalOutcome | null;
            dateReview: MalDateReview | null;
            dateOutcome: MalDateOutcome | null;
            labelOutcomes: MalLabelOutcome[];
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
        } | {
            index: number;
            kind: 'anime' | 'manga';
            title: string;
            identifier: {
                namespace: string;
                source: string;
                value: string;
            };
            status: import("./list-import-mal-parser.ts").MalValue;
            role: string | null;
            score: import("./list-import-mal-parser.ts").MalValue & {
                scale: {
                    min: 1;
                    max: 10;
                    step: 1;
                };
            };
            dates: Record<string, import("./list-import-mal-parser.ts").MalValue>;
            notes: import("./list-import-mal-parser.ts").MalValue;
            tags: import("./list-import-mal-parser.ts").MalValue;
            repeats: import("./list-import-mal-parser.ts").MalValue;
            privacy: import("./list-import-mal-parser.ts").MalValue;
            timestamps: Record<string, import("./list-import-mal-parser.ts").MalValue>;
            fields: Record<string, string>;
            retained: {
                field: string;
                reason: string;
            }[];
            target: string;
            binding: Binding | null;
            source: {
                release: string;
                epoch: string;
                acceptingType: string;
            };
            current: {
                state: string;
                revision: number;
                incarnationId: string | null;
            } | null;
            state: string | null;
            match: "already-matched" | "matched";
            tagEvidence: import("./list-import-mal-tags.ts").MalTagEvidence;
            candidates: {
                subjectId: string;
            }[];
            review: MalReview | null;
            scoreReviewState: "observations-match" | "stale" | "unavailable" | null;
            currentScoreVote: {
                units: number | null;
                revision: number;
                at: string;
            } | null;
            outcome: MalOutcome | null;
            dateReview: MalDateReview | null;
            dateOutcome: MalDateOutcome | null;
            labelOutcomes: MalLabelOutcome[];
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
        })[];
        sourcePath: string;
        next: number | null;
        limits: {
            readonly bytes: 2097152;
            readonly wireBytes: 4194304;
            readonly evidenceBytes: 50331648;
            readonly rows: 500;
            readonly page: 20;
            readonly depth: 16;
            readonly uploads: 3;
        };
        labelLimits: {
            readonly rows: 20;
            readonly values: 32;
            readonly newLabels: 32;
            readonly sourceBytes: 8192;
            readonly selectionBytes: 16384;
            readonly outputBytes: 524288;
        };
    }>;
    review: (actor: Actor, id: string, input: MalReviewInput, key: string, deadline: number) => Promise<CommandOutcome<{
        id: string;
    }>>;
    reviewMetadata: (actor: Actor, id: string, input: MalMetadataReviewInput, key: string, deadline: number) => Promise<{
        value: {
            id: string;
            reviewToken: string;
        };
        partition: number;
        epoch: number;
        position: bigint;
        transactionId: string;
        replayed: boolean;
    }>;
    metadata: (actor: Actor, id: string, ordinal: number, token: string, deadline: number) => Promise<Readonly<{
        status: 'current' | 'stale';
        reviewToken: string;
        sourceReviewToken: string;
        subjectId: string;
        personal: import("./entry-personal-model.ts").PersonalEntry;
        proposals: EntryImportMetadataProposals;
        outcome: EntryImportMetadataOutcome | null;
    }>>;
    applyMetadata: (actor: Actor, id: string, ordinal: number, reviewToken: string, fields: unknown, deadline: number, signal?: AbortSignal, recordCommand?: (command: CommandOutcome<unknown>) => void) => Promise<EntryImportMetadataOutcome>;
    reviewDates: (actor: Actor, id: string, input: MalDateReviewInput, key: string, deadline: number) => Promise<CommandOutcome<{
        id: string;
    }>>;
    apply: (actor: Actor, id: string, input: MalApplyInput, deadline: number, signal: AbortSignal, record: (value: CommandOutcome<unknown> | SessionComponent) => void) => Promise<{
        id: string;
        outcomes: MalOutcome[];
        remaining: number[];
        stopped: boolean;
    }>;
    applyDates: (actor: Actor, id: string, input: MalDateApplyInput, deadline: number, signal: AbortSignal, record: (value: CommandOutcome<unknown>) => void) => Promise<{
        id: string;
        outcomes: MalDateOutcome[];
        remaining: number[];
        stopped: boolean;
    }>;
    source: (actor: Actor, id: string, deadline: number) => Promise<{
        xml: string;
    }>;
    cancel: (actor: Actor, id: string, key: string) => Promise<CommandOutcome<{
        id: string;
    }>>;
    delete: (actor: Actor, id: string, key: string) => Promise<CommandOutcome<{
        id: string;
    }>>;
};
export type MalPreview = Awaited<ReturnType<ReturnType<typeof createMalImport>['page']>>;
export type MalPreviewRow = MalPreview['rows'][number];
export {};
