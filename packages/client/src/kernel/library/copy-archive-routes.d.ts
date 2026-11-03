import type { Elysia, DefaultMetadata, DefaultSingleton } from 'elysia';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import type { EpisodeProgressView } from './episode-progress-wire.ts';
import type { ProgressSession } from './progress-model.ts';
import type { LibraryProgressUnitDescriptor } from './profile.ts';

export type CopyArchiveProgressMeasureMapping = { sourceUnit: string; unit: string };
export type CopyArchiveProgressReviewRequest = {
    sessionId: string;
    subjectId: string;
    mode: 'scalar_amount' | 'cursor_position' | 'completed_units';
    unit: string;
    additionalMeasures: CopyArchiveProgressMeasureMapping[];
    unitIds: string[];
};
export type CopyArchiveArchivedProgressMeasure = { unit: string; amount: string | null; total: string | null };
export type CopyArchiveArchivedProgressSession = {
    section: 'sessions';
    session_id: string;
    subject_id: string;
    subject_id_reference: { id: string; href: string };
    version_subject_id: string | null;
    version_subject_id_reference?: { id: string; href: string };
    mode: string;
    unit: string;
    total: string | null;
    amount: string | null;
    additional_measures?: CopyArchiveArchivedProgressMeasure[];
    locator: string | null;
    position: string | null;
    completed_unit_count: number;
    state: string;
    revision: number;
    library_profile_pin: unknown;
    started_at: string;
    completed_at: string | null;
    last_changed_at: string;
};
export type CopyArchiveArchivedProgressUnit = {
    section: 'units';
    session_id: string;
    unit_id: string;
    added_at: string;
};
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
        additionalMeasures: CopyArchiveArchivedProgressMeasure[];
        completedUnitCount: number;
        state: string;
        sourceRevision: number;
        versionSubjectId: string | null;
        profilePin: unknown;
        sourceTimes: { startedAt: string; completedAt: string | null; lastChangedAt: string };
    };
    current: {
        profile: {
            kind: 'supported' | 'unsupported';
            subjectId: string;
            acceptingType: string;
            profileId?: string;
            releaseDigest?: string;
        };
        mode: 'scalar_amount' | 'cursor_position' | 'completed_units';
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
    completedUnits: { unitId: string; admission: 'member' | 'detached' | 'unavailable' }[];
    unsupportedHistoricalDates: string[];
    unsupported: string[];
    applicable: boolean;
    recovery: 'complete' | 'partial' | 'unsupported';
    expiresAt: string;
};
export type CopyArchiveProgressState = 'applying' | 'partial' | 'applied' | 'stale' | 'failed';
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
    manifest: {
        format: 'https://rezics.com/formats/library-export';
        version: 1;
        exportId: string;
        capturedAt: string;
        expiresAt: string;
        privacy: 'private';
        completeness: 'supported-native-facts';
        sections: string[];
        omissions: Record<string, string>;
        fullExport: false;
        rows: number;
        recordBytes: number;
    };
    coverage: { section: string; records: number; support: 'evidence-only' | 'unsupported' }[];
    occurrences: { ordinal: number; evidence: CopyArchiveArchivedProgressSession }[];
    next: number | null;
};
export type CopyArchiveProgressUnitPage = {
    uploadId: string;
    sourceSessionId: string;
    state: 'cancelled' | 'inspecting';
    units: { ordinal: number; evidence: CopyArchiveArchivedProgressUnit }[];
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
export type CopyArchiveProblem = Response | {
    type: unknown;
    title: unknown;
    status: number;
    code: unknown;
    retryable: unknown;
    effect_status: 'not_applicable' | 'not_applied';
    request_id: string;
    detail: unknown;
    errors: unknown;
};
type CopyArchiveFailures = {
    400: CopyArchiveProblem;
    401: CopyArchiveProblem;
    403: CopyArchiveProblem;
    404: CopyArchiveProblem;
    409: CopyArchiveProblem;
    413: CopyArchiveProblem;
    422: CopyArchiveProblem;
    503: CopyArchiveProblem;
};
type Route<Body, Params, Query, Headers, Success> = {
    body: Body;
    params: Params;
    query: Query;
    headers: Headers;
    response: { 200: Success } & CopyArchiveFailures;
    error: never;
};
type KeyHeader = { 'idempotency-key': string };
type ArchivePage = {
    uploadId: string;
    state: 'cancelled' | 'inspecting';
    expiresAt: string;
    fullRestoration: false;
    effectsSupported: false;
    manifest: CopyArchiveProgressPage['manifest'];
    coverage: CopyArchiveProgressPage['coverage'];
    holdings: number;
    rows: {
        ordinal: number;
        evidence: Record<string, unknown>;
        resolution: 'unresolved';
        reason: string;
    }[];
    next: number | null;
};
export type CopyArchiveRoutes = {
    v1: {
        libraryCopyArchives: {
            post: Route<unknown, {}, unknown, KeyHeader, { uploadId: string; holdings: number; progressRecords: number; expiresAt: string }>;
            ':id': {
                get: Route<unknown, { id: string }, { after?: string | number }, unknown, ArchivePage>;
                $cancel: { post: Route<unknown, { id: string }, unknown, unknown, { uploadId: string; cancelled: true }> };
                delete: Route<unknown, { id: string }, unknown, unknown, { uploadId: string; removed: number; complete: boolean }>;
                progress: {
                    get: Route<unknown, { id: string }, { after?: string | number }, unknown, CopyArchiveProgressPage>;
                    ':sessionId': {
                        units: {
                            get: Route<unknown, { id: string; sessionId: string }, { after?: string | number }, unknown, CopyArchiveProgressUnitPage>;
                        };
                    };
                };
                progressReviews: {
                    post: Route<CopyArchiveProgressReviewRequest, { id: string }, unknown, KeyHeader, CopyArchiveProgressReview>;
                    ':reviewId': {
                        $apply: {
                            post: Route<unknown, { id: string; reviewId: string }, unknown, KeyHeader, CopyArchiveProgressApplication>;
                        };
                        get: Route<unknown, { id: string; reviewId: string }, unknown, unknown, CopyArchiveProgressResult>;
                    };
                };
            };
        };
    };
};
export type CopyArchiveRouteModule = Elysia<'', 'local', DefaultSingleton, {
    typebox: {};
    error: [];
}, DefaultMetadata, CopyArchiveRoutes>;
export declare function copyArchiveRoutes(app: ReturnType<typeof definitionRoutes>, deps: {
    pool: Pool;
    access: () => Access;
    workClient: WorkClient | (() => Promise<WorkClient>);
    tokens: KeyRing;
    routeKey: Uint8Array;
    clock?: KernelClock;
}): CopyArchiveRouteModule;
