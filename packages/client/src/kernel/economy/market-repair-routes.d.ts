import type { CommandAuthorization, CommandOutcome } from '../command/command.ts';
import type { createApp } from '../http/app.ts';
import { type Actor } from '../request/access.ts';
export type MarketRepairAcceptance = Readonly<{
    reconciliation: 'queued';
}>;
export type EconomyMarketRepairPort = Readonly<{
    request(input: Readonly<{
        actor: Extract<Actor, {
            kind: 'account';
        }>;
        tradeId: string;
        key: string;
        deadline: number;
        authorization: CommandAuthorization;
    }>): Promise<CommandOutcome<MarketRepairAcceptance>>;
}>;
export declare function economyMarketRepairRoutes(app: ReturnType<typeof createApp>, port: EconomyMarketRepairPort): import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
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
}, {
    health: {
        get: {
            body: unknown;
            params: {};
            query: unknown;
            headers: unknown;
            response: {
                200: {
                    status: 'ok';
                };
            };
            error: never;
        };
    };
}, import("elysia").DefaultEphemeral, {
    derive: {
        readonly admission: import("../http/admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("../request/access.ts").AccountActor | {
            kind: 'anonymous';
        };
        readonly session: {
            readonly components: import("../tokens/session.ts").SessionComponent[];
            record(component: import("../tokens/session.ts").SessionComponent): void;
        };
        readonly authorize: (resource: import("../request/access.ts").Resource, permit?: import("../http/admission.ts").AdmissionYield) => Promise<import("../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
    };
    schema: {};
    schemas: {};
    response: {};
    error: [];
}, "post", "/v1/economy/market/trades/:tradeId/$repair", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    params: import("typebox").TObject<{
        tradeId: import("typebox").TString;
    }>;
    headers: import("typebox").TObject<{
        "idempotency-key": import("typebox").TString;
    }>;
    body: import("typebox").TObject<{}>;
    response: {
        202: import("typebox").TObject<{
            reconciliation: import("typebox").TLiteral<"queued">;
        }>;
        400: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        403: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        422: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        429: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-exposure': string;
        'x-action': string;
        'x-authority-resource-types': string[];
        'x-authority-resource-id': "00000000-0000-8000-8000-000000000000";
        'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
        security: {
            bearerAuth: never[];
        }[];
    };
}, {}, "/v1/economy/market/trades/:tradeId/$repair">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ actor, params, headers, job, admission, authorizeCommand, session, set }: {
    server: import("elysia").Server | null;
    redirect: import("elysia").redirect;
    set: {
        headers: import("elysia").HTTPHeaders;
        status?: number | keyof import("elysia").StatusMap;
        cookie?: Record<string, import("elysia").BaseCookie>;
        redirect?: never;
    };
    status: import("elysia").SelectiveStatus<{
        202: {
            reconciliation: "queued";
        };
        400: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        403: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        404: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        422: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        429: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
    }>;
    problem: import("elysia").SelectiveProblem<{
        202: {
            reconciliation: "queued";
        };
        400: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        403: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        404: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        422: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        429: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "applied" | "not_applicable" | "not_applied" | "unknown";
            request_id: string;
            detail: unknown;
            errors: unknown;
        };
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        params: import("typebox").TObject<{
            tradeId: import("typebox").TString;
        }>;
        headers: import("typebox").TObject<{
            "idempotency-key": import("typebox").TString;
        }>;
        body: import("typebox").TObject<{}>;
        response: {
            202: import("typebox").TObject<{
                reconciliation: import("typebox").TLiteral<"queued">;
            }>;
            400: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            401: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            403: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            404: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            422: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            429: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
            503: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
                request_id: import("typebox").TString;
                detail?: import("typebox").TOptional<import("typebox").TString>;
                errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
        };
        detail: {
            operationId: string;
            'x-exposure': string;
            'x-action': string;
            'x-authority-resource-types': string[];
            'x-authority-resource-id': "00000000-0000-8000-8000-000000000000";
            'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            security: {
                bearerAuth: never[];
            }[];
        };
    }, {}, "/v1/economy/market/trades/:tradeId/$repair">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("../http/admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("../request/access.ts").AccountActor | {
                kind: 'anonymous';
            };
            readonly session: {
                readonly components: import("../tokens/session.ts").SessionComponent[];
                record(component: import("../tokens/session.ts").SessionComponent): void;
            };
            readonly authorize: (resource: import("../request/access.ts").Resource, permit?: import("../http/admission.ts").AdmissionYield) => Promise<import("../request/access.ts").AccessCheck>;
            readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
        };
    }>>) => import("elysia/types").MaybePromise<void>;
    readonly path: string;
    route?: string;
    rid?: string;
    request: Request;
    store: {};
    body: object;
    query: Record<string, string | undefined>;
    params: {
        tradeId: string;
    };
    headers: {
        "idempotency-key": string;
    };
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: import("../http/admission.ts").Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: import("../request/access.ts").AccountActor | {
        kind: 'anonymous';
    };
    readonly session: {
        readonly components: import("../tokens/session.ts").SessionComponent[];
        record(component: import("../tokens/session.ts").SessionComponent): void;
    };
    readonly authorize: (resource: import("../request/access.ts").Resource, permit?: import("../http/admission.ts").AdmissionYield) => Promise<import("../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<Readonly<{
    reconciliation: 'queued';
}>>, {
    params: import("typebox").TObject<{
        tradeId: import("typebox").TString;
    }>;
    headers: import("typebox").TObject<{
        "idempotency-key": import("typebox").TString;
    }>;
    body: import("typebox").TObject<{}>;
    response: {
        202: import("typebox").TObject<{
            reconciliation: import("typebox").TLiteral<"queued">;
        }>;
        400: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        403: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        422: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        429: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TLiteral<"not_applied"> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">]> | import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">, import("typebox").TLiteral<"applied">, import("typebox").TLiteral<"unknown">]>;
            request_id: import("typebox").TString;
            detail?: import("typebox").TOptional<import("typebox").TString>;
            errors?: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-exposure': string;
        'x-action': string;
        'x-authority-resource-types': string[];
        'x-authority-resource-id': "00000000-0000-8000-8000-000000000000";
        'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
        security: {
            bearerAuth: never[];
        }[];
    };
}>;
