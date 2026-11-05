import type { Pool } from 'pg';
import { type OperationalTransaction } from '../command/operational.ts';
import { type KernelClock } from '../clock.ts';
import { type Access, type Actor } from '../request/access.ts';
import type { WorkClient } from '../work/client.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type EpisodeProgressView } from './episode-progress.ts';
import { type LibraryProgressUnitDescriptor } from './profile.ts';
import { type ProgressMode } from './progress.ts';
import type { ProgressSession } from './progress-model.ts';
import type { ArchivedProgressMeasure, ArchivedProgressSession, ArchivedProgressUnit } from './copy-archive-format.ts';
import { type ArchivedHolding, type ArchiveSectionCoverage, type CopyArchiveManifest } from './copy-archive-format.ts';
export type CopyArchiveDependencies = {
    pool: Pool;
    access: Access;
    workClient: WorkClient | (() => Promise<WorkClient>);
    tokens: KeyRing;
    routeKey: Uint8Array;
    clock?: KernelClock;
};
export declare const copyArchiveAuthorityTypes: string[];
export type CopyArchiveProgressMeasureMapping = {
    sourceUnit: string;
    unit: string;
};
export type CopyArchiveProgressReviewRequest = {
    sessionId: string;
    subjectId: string;
    mode: ProgressMode;
    unit: string;
    additionalMeasures: CopyArchiveProgressMeasureMapping[];
    unitIds: string[];
};
export type CopyArchiveProgressState = 'applying' | 'recoverable' | 'partial' | 'applied' | 'stale' | 'failed';
export type CopyArchiveProgressReview = {
    uploadId: string;
    reviewId: string;
    sourceSessionId: string;
    sourceSubjectId: string;
    subjectId: string;
    historical: {
        mode: string;
        unit: string;
        total: string | null;
        amount: string | null;
        additionalMeasures: ArchivedProgressMeasure[];
        completedUnitCount: number;
        state: string;
        sourceRevision: number;
        versionSubjectId: string | null;
        profilePin: unknown;
        sourceTimes: {
            startedAt: string;
            completedAt: string | null;
            lastChangedAt: string;
        };
    };
    current: {
        profile: {
            kind: 'supported' | 'unsupported';
            subjectId: string;
            acceptingType: string;
            profileId?: string;
            releaseDigest?: string;
        };
        mode: ProgressMode;
        unit: string;
    };
    measures: {
        sourceUnit: string;
        sourceAmount: string | null;
        sourceTotal: string | null;
        currentUnit: string | null;
        currentMeaning: LibraryProgressUnitDescriptor | null;
        amount: 'absent' | 'supported' | 'unsupported';
        total: 'supported' | 'unsupported';
    }[];
    completedUnits: {
        unitId: string;
        admission: 'member' | 'detached' | 'unavailable';
    }[];
    unsupportedHistoricalDates: string[];
    unsupported: string[];
    applicable: boolean;
    recovery: 'complete' | 'partial' | 'unsupported';
    expiresAt: string;
};
export type CopyArchiveProgressApplication = {
    uploadId: string;
    reviewId: string;
    state: CopyArchiveProgressState;
    sessionId: string | null;
    acceptedSteps: number;
    totalSteps: number;
    error: string | null;
};
export type CopyArchiveProgressPage = {
    uploadId: string;
    state: 'cancelled' | 'inspecting';
    expiresAt: string;
    manifest: CopyArchiveManifest;
    coverage: ArchiveSectionCoverage[];
    occurrences: {
        ordinal: number;
        evidence: ArchivedProgressSession;
    }[];
    next: number | null;
};
export type CopyArchiveProgressUnitPage = {
    uploadId: string;
    sourceSessionId: string;
    state: 'cancelled' | 'inspecting';
    units: {
        ordinal: number;
        evidence: ArchivedProgressUnit;
    }[];
    next: number | null;
};
export type CopyArchiveProgressResult = {
    uploadId: string;
    review: CopyArchiveProgressReview;
    application: Pick<CopyArchiveProgressApplication, 'state' | 'sessionId' | 'acceptedSteps' | 'error'> | null;
    progressSession: ProgressSession | null;
    completedEpisodes: EpisodeProgressView | null;
    expiresAt: string;
};
/** Private evidence only. This service has no native copy, entry or catalogue writer. */
export declare function createCopyArchive(deps: CopyArchiveDependencies): {
    upload: (actor: Actor, bytes: Uint8Array, requestKey: string, signal?: AbortSignal) => Promise<import("../command/command.ts").CommandOutcome<{
        uploadId: string;
        holdings: number;
        progressRecords: number;
        expiresAt: string;
    }>>;
    page: (actor: Actor, id: string, after?: number, signal?: AbortSignal) => Promise<{
        uploadId: string;
        state: "cancelled" | "inspecting";
        expiresAt: string;
        fullRestoration: false;
        effectsSupported: false;
        manifest: CopyArchiveManifest;
        coverage: ArchiveSectionCoverage[];
        holdings: number;
        rows: {
            ordinal: number;
            evidence: ArchivedHolding;
            resolution: 'unresolved';
            reason: string;
        }[];
        next: number | null;
    }>;
    progressPage: (actor: Actor, id: string, after?: number, signal?: AbortSignal) => Promise<CopyArchiveProgressPage>;
    progressUnitPage: (actor: Actor, id: string, sessionId: string, after?: number, signal?: AbortSignal) => Promise<CopyArchiveProgressUnitPage>;
    reviewProgress: (actor: Actor, id: string, requestKey: string, input: unknown, signal?: AbortSignal) => Promise<CopyArchiveProgressReview>;
    applyProgress: (actor: Actor, id: string, reviewId: string, requestKey: string, signal?: AbortSignal, onCommand?: (receipt: {
        partition: number;
        epoch: number;
        position: bigint;
    }) => void) => Promise<CopyArchiveProgressApplication>;
    progressResult: (actor: Actor, id: string, reviewId: string, signal?: AbortSignal) => Promise<CopyArchiveProgressResult>;
    cancel: (actor: Actor, id: string, signal?: AbortSignal) => Promise<{
        uploadId: string;
        cancelled: true;
    }>;
    remove: (actor: Actor, id: string, signal?: AbortSignal) => Promise<{
        uploadId: string;
        removed: number;
        complete: boolean;
    }>;
};
/** Caller holds the root lock and owns account/terminal admission. Never cascade an unbounded child set. */
export declare function removeCopyArchivePage(tx: Pick<OperationalTransaction, 'query'>, route: number, accountId: string, id: string): Promise<{
    removed: number;
    complete: boolean;
}>;
