import type { Pool } from 'pg';
import { type Access, type AccessFactory, type Resource } from '../request/access.ts';
import { type SessionComponent } from '../tokens/session.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { Admission } from './admission.ts';
import { type WriteRateLimiter } from '../access/write-rate.ts';
import { type WriteRateStageOptions } from '../access/write-rate-stage.ts';
export declare const REQUEST_DEADLINE_MS = 2000;
export declare function createApp({ pool, requestDeadlineMs, admission, access, tokens, writeRate, rateAttribution, ratePeer, clock, }: {
    pool: Pool;
    requestDeadlineMs?: number;
    admission?: Admission;
    access?: Access | AccessFactory;
    tokens?: KeyRing;
    writeRate?: WriteRateLimiter;
    rateAttribution?: WriteRateStageOptions;
    /** Trusted transport attribution; never a request header resolver. */
    ratePeer?: (request: Request) => string | undefined;
    /** The kernel's single domain clock, shared by request admission and commands. */
    clock?: () => Date;
}): import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
    typebox: {};
    error: [{
        error: Error;
        response: {};
        passes: false;
        '~return': Response;
        '~catchAll': true;
    }];
}, {
    schema: {};
    schemas: {};
    macro: {};
    macroFn: {};
    parser: {};
    response: {};
}, {}, import("elysia").DefaultEphemeral, {
    derive: {
        readonly admission: Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("../request/access.ts").AccountActor | {
            kind: 'anonymous';
        };
        readonly session: {
            readonly components: SessionComponent[];
            record(component: SessionComponent): void;
        };
        readonly authorize: (resource: Resource) => Promise<import("../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
    };
    schema: {};
    schemas: {};
    response: {};
    error: [];
}, "get", "/health", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<import("elysia").InputSchema<never> & {
    beforeHandle?: unknown;
    afterHandle?: unknown;
    error?: unknown;
}, {}, "/health">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ admission: lanes, job }: {
    server: import("elysia").Server | null;
    redirect: import("elysia").redirect;
    set: {
        headers: import("elysia").HTTPHeaders;
        status?: number | keyof import("elysia").StatusMap;
        cookie?: Record<string, import("elysia").BaseCookie>;
        redirect?: never;
    };
    status: <const Code extends number | keyof import("elysia").StatusMap, const T = import("elysia").StatusResponse<Code>>(code: Code, response?: T) => import("elysia").ElysiaStatus<Code, T, import("elysia").NumericStatus<Code>>;
    problem: typeof import("elysia").problem;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<import("elysia").InputSchema<never> & {
        beforeHandle?: unknown;
        afterHandle?: unknown;
        error?: unknown;
    }, {}, "/health">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("../request/access.ts").AccountActor | {
                kind: 'anonymous';
            };
            readonly session: {
                readonly components: SessionComponent[];
                record(component: SessionComponent): void;
            };
            readonly authorize: (resource: Resource) => Promise<import("../request/access.ts").AccessCheck>;
            readonly authorizeCommand: (resource: Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
        };
    }>>) => import("elysia/types").MaybePromise<void>;
    readonly path: string;
    route?: string;
    rid?: string;
    request: Request;
    store: {};
    body: unknown;
    query: Record<string, string | undefined>;
    params: {};
    headers: Record<string, string | undefined>;
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: import("../request/access.ts").AccountActor | {
        kind: 'anonymous';
    };
    readonly session: {
        readonly components: SessionComponent[];
        record(component: SessionComponent): void;
    };
    readonly authorize: (resource: Resource) => Promise<import("../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<{
    status: 'ok';
}>, import("elysia").InputSchema<never> & {
    beforeHandle?: unknown;
    afterHandle?: unknown;
    error?: unknown;
}>;
