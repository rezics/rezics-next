import type { DefaultMetadata, DefaultSingleton, Elysia } from 'elysia';
import type { KernelClock } from '../clock.ts';
import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';

type Problem = Record<string, unknown>;
type Failures = {
    400: Problem;
    401: Problem;
    403: Problem;
    404: Problem;
    409: Problem;
    413: Problem;
    422: Problem;
    503: Problem;
};
type Route<Body, Params, Query, Headers, Success> = {
    body: Body;
    params: Params;
    query: Query;
    headers: Headers;
    response: { 200: Success } & Failures;
    error: never;
};
type ArchiveFieldChoice = 'preserve' | 'set' | 'clear';
export type ArchiveMergeReviewInput =
    | { ordinal: number; kind: 'entry'; subjectId: string; action: 'preserve'; stateId?: never }
    | { ordinal: number; kind: 'entry'; subjectId: string; action: 'create' | 'update'; stateId: string }
    | { ordinal: number; kind: 'label'; target: { mode: 'existing'; labelId: string } | { mode: 'create' } }
    | { ordinal: number; kind: 'assignment'; subjectId: string; action: 'assign' | 'preserve' }
    | { ordinal: number; kind: 'annotation'; subjectId: string; incarnationId: string; fields: { note?: ArchiveFieldChoice; priority?: ArchiveFieldChoice } }
    | { ordinal: number; kind: 'journal'; subjectId: string; sessionId: string; fields: { startDate?: ArchiveFieldChoice; finishDate?: ArchiveFieldChoice } };
type Coverage = {
    section: string;
    capture: 'present' | 'empty';
    treatment: 'requires-explicit-mapping' | 'retained-unsupported';
    rows: number;
};
type UploadState = 'ready' | 'cancelled' | 'expired';
type Status = {
    uploadId: string;
    createdAt: string;
    expiresAt: string;
    state: UploadState;
    rows: number;
    recordBytes: number;
    coverage: Coverage[];
};
type PageQuery = { after?: number; limit?: number };
type IdParams = { id: string };
type LibraryArchiveMergeRoutes = {
    v1: {
        libraryArchiveMerges: {
            post: Route<unknown, {}, unknown, { 'idempotency-key': string }, Status>;
            ':id': {
                get: Route<unknown, IdParams, unknown, unknown, Status>;
                preview: {
                    get: Route<unknown, IdParams, PageQuery, unknown, {
                        uploadId: string;
                        state: UploadState;
                        coverage: Coverage[];
                        records: { ordinal: number; section: string; evidence: Record<string, unknown>; status: string; review: Record<string, unknown> | null }[];
                        next: number | null;
                    }>;
                };
                review: {
                    patch: Route<{ items: ArchiveMergeReviewInput[] }, IdParams, unknown, unknown, { uploadId: string; reviewed: { ordinal: number; status: string }[] }>;
                };
                apply: {
                    post: Route<{ ordinals: number[] }, IdParams, unknown, unknown, { uploadId: string; applied: { ordinal: number; status: string; result: Record<string, unknown> | null }[] }>;
                };
                results: {
                    get: Route<unknown, IdParams, PageQuery, unknown, {
                        uploadId: string;
                        state: UploadState;
                        results: { ordinal: number; section: string; status: string; result: Record<string, unknown> | null }[];
                        next: number | null;
                    }>;
                };
                delete: Route<unknown, IdParams, unknown, unknown, Status>;
                prune: {
                    post: Route<unknown, IdParams, unknown, unknown, { uploadId: string; removed: number; complete: boolean }>;
                };
            };
        };
    };
};
export type LibraryArchiveMergeRouteModule = Elysia<'', 'local', DefaultSingleton, {
    typebox: {};
    error: [];
}, DefaultMetadata, LibraryArchiveMergeRoutes>;
export declare function libraryArchiveMergeRoutes(app: ReturnType<typeof definitionRoutes>, deps: {
    pool: Pool;
    access: () => Access;
    tokens: KeyRing;
    workClient: WorkClient | (() => Promise<WorkClient>);
    journalCommands?: unknown;
    clock?: KernelClock;
}): LibraryArchiveMergeRouteModule;
