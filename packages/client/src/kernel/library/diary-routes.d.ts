import type { Elysia, DefaultMetadata, DefaultSingleton } from 'elysia';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { type DiaryPage } from './diary-model.ts';
/** Explicit wire contract keeps the client independent of database and private reader implementations. */
export type DiaryProblem<Status extends number, Code extends string> = {
    type: string;
    title: string;
    status: Status;
    code: Code;
    request_id: string;
    detail?: string;
};
export type DiaryFailures = {
    400: DiaryProblem<400, 'invalid_request' | 'invalid_cursor'>;
    401: DiaryProblem<401, 'authentication_required' | 'invalid_credentials'>;
    403: DiaryProblem<403, 'forbidden' | 'platform_closed'>;
    409: DiaryProblem<409, 'stale_cursor' | 'conflict'>;
    503: DiaryProblem<503, 'semantic_not_ready' | 'dependency_unavailable' | 'overloaded' | 'partition_unavailable' | 'transaction_retry_exhausted' | 'deadline_exceeded'>;
};
export type DiaryRoutes = {
    v1: {
        libraryDiary: {
            get: {
                body: unknown;
                headers: unknown;
                params: {};
                query: {
                    limit?: number;
                    cursor?: string;
                };
                response: {
                    200: DiaryPage;
                } & DiaryFailures;
            };
            $cancel: {
                post: {
                    body: {
                        continuation: string;
                    };
                    headers: unknown;
                    params: {};
                    query: unknown;
                    response: {
                        200: {
                            cancelled: true;
                        };
                    } & DiaryFailures;
                };
            };
        };
    };
};
export type DiaryRouteModule = Elysia<'', 'local', DefaultSingleton, {
    typebox: {};
    error: [];
}, DefaultMetadata, DiaryRoutes>;
/** Web's existing cross-subject diary consumes these methods and the existing presented session detail. */
export declare function diaryRoutes(app: ReturnType<typeof definitionRoutes>, deps: {
    pool: Pool;
    access: () => Access;
    tokens: KeyRing;
    clock: KernelClock;
    routeKey: Uint8Array;
}): DiaryRouteModule;
