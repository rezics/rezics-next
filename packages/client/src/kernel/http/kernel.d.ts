import { type CommerceDependencies } from '../commerce/routes.ts';
import { type SearchService } from '../search/http/routes.ts';
import { createApp } from './app.ts';
export type KernelDependencies = Parameters<typeof createApp>[0] & {
    routeKey: Uint8Array;
    commerce?: CommerceDependencies;
    search?: SearchService;
};
/** The route key must stay the same across restarts, or retries lose their receipts. */
export declare function createKernel(dependencies: KernelDependencies): (import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
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
} & {
    v1: {
        subjects: {
            $search: {
                post: {
                    body: {
                        text?: string;
                        filter?: any;
                        sort?: "id" | "name" | "relevance";
                        limit?: number;
                        cursor?: string;
                    };
                    params: {};
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            subjects: {
                                id: string;
                                type: string;
                                labels: Record<string, string>;
                            }[];
                            total: {
                                value: number;
                                relation: "exact" | "lower_bound";
                            };
                            next: string | null;
                            as_of: string;
                        };
                        400: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        403: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        409: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        422: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
}, import("elysia").DefaultEphemeral, {
    derive: {
        readonly admission: import("./admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("../request/access.ts").Actor;
        readonly session: {
            readonly components: import("../tokens/session.ts").SessionComponent[];
            record(component: import("../tokens/session.ts").SessionComponent): void;
        };
        readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
    };
    schema: {};
    schemas: {};
    response: {};
    error: [];
}, "get", "/v1/subjects/$suggest", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    query: import("typebox").TObject<{
        q: import("typebox").TString;
        limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
    }>;
    response: {
        200: import("typebox").TObject<{
            subjects: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                type: import("typebox").TString;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>>;
            as_of: import("typebox").TString;
        }>;
        400: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        403: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}, {}, "/v1/subjects/$suggest">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ query, authorize, admission, job }: {
    server: import("elysia").Server | null;
    redirect: import("elysia").redirect;
    set: {
        headers: import("elysia").HTTPHeaders;
        status?: number | keyof import("elysia").StatusMap;
        cookie?: Record<string, import("elysia").BaseCookie>;
        redirect?: never;
    };
    status: import("elysia").SelectiveStatus<{
        200: {
            subjects: {
                id: string;
                type: string;
                labels: Record<string, string>;
            }[];
            as_of: string;
        };
        400: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        403: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
    }>;
    problem: import("elysia").SelectiveProblem<{
        200: {
            subjects: {
                id: string;
                type: string;
                labels: Record<string, string>;
            }[];
            as_of: string;
        };
        400: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        403: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        query: import("typebox").TObject<{
            q: import("typebox").TString;
            limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
        }>;
        response: {
            200: import("typebox").TObject<{
                subjects: import("typebox").TArray<import("typebox").TObject<{
                    id: import("typebox").TString;
                    type: import("typebox").TString;
                    labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                }>>;
                as_of: import("typebox").TString;
            }>;
            400: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            401: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            403: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            503: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
        };
        detail: {
            operationId: string;
            'x-action': string;
            security: ({
                bearerAuth: never[];
            } | {
                bearerAuth?: never;
            })[];
        };
    }, {}, "/v1/subjects/$suggest">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("./admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("../request/access.ts").Actor;
            readonly session: {
                readonly components: import("../tokens/session.ts").SessionComponent[];
                record(component: import("../tokens/session.ts").SessionComponent): void;
            };
            readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
            readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
        };
    }>>) => import("elysia/types").MaybePromise<void>;
    readonly path: string;
    route?: string;
    rid?: string;
    request: Request;
    store: {};
    body: unknown;
    query: {
        q: string;
        limit?: number;
    };
    params: {};
    headers: Record<string, string | undefined>;
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: import("./admission.ts").Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: import("../request/access.ts").Actor;
    readonly session: {
        readonly components: import("../tokens/session.ts").SessionComponent[];
        record(component: import("../tokens/session.ts").SessionComponent): void;
    };
    readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<{
    subjects: {
        id: string;
        type: string;
        labels: Record<string, string>;
    }[];
    as_of: string;
}>, {
    query: import("typebox").TObject<{
        q: import("typebox").TString;
        limit: import("typebox").TOptional<Readonly<import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TCodec<import("typebox").TRefine<import("typebox").TString>, number>]>>>;
    }>;
    response: {
        200: import("typebox").TObject<{
            subjects: import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                type: import("typebox").TString;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>>;
            as_of: import("typebox").TString;
        }>;
        400: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        403: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}> & import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
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
} & {
    v1: {
        subjects: {
            post: {
                body: {
                    type: string;
                    labels: Record<string, any>;
                    descriptions?: Record<string, any>;
                    aliases?: Record<string, any>;
                    statements?: Record<string, any>;
                };
                params: {};
                query: unknown;
                headers: {
                    "idempotency-key": string;
                };
                response: {
                    200: {
                        subject: import("../semantic/item.ts").Item;
                    };
                    201: {
                        subject: {
                            id: string;
                            type: string;
                            revision: number;
                            release: string;
                            context: string;
                            resolution: Record<string, any>;
                            labels: Record<string, string>;
                            descriptions: Record<string, string>;
                            aliases: Record<string, string[]>;
                            statements: Record<string, {
                                id: string;
                                rank: "deprecated" | "normal" | "preferred";
                                property: {
                                    id: string;
                                    data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                };
                                value: {
                                    type: "value";
                                    content: any;
                                } | {
                                    type: "somevalue";
                                } | {
                                    type: "novalue";
                                };
                                qualifiers: {
                                    property: {
                                        id: string;
                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                    };
                                    value: {
                                        type: "value";
                                        content: any;
                                    } | {
                                        type: "somevalue";
                                    } | {
                                        type: "novalue";
                                    };
                                }[];
                                references: {
                                    parts: {
                                        property: {
                                            id: string;
                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                        };
                                        value: {
                                            type: "value";
                                            content: any;
                                        } | {
                                            type: "somevalue";
                                        } | {
                                            type: "novalue";
                                        };
                                    }[];
                                    hash: string;
                                }[];
                                rezics: {
                                    release: string;
                                    revision: number;
                                };
                            }[]>;
                        };
                    };
                    400: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    401: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    403: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    422: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    503: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                };
                error: never;
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                get: {
                    body: unknown;
                    params: {
                        id: string;
                    };
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            subject: {
                                id: string;
                                type: string;
                                revision: number;
                                release: string;
                                context: string;
                                resolution: Record<string, any>;
                                labels: Record<string, string>;
                                descriptions: Record<string, string>;
                                aliases: Record<string, string[]>;
                                statements: Record<string, {
                                    id: string;
                                    rank: "deprecated" | "normal" | "preferred";
                                    property: {
                                        id: string;
                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                    };
                                    value: {
                                        type: "value";
                                        content: any;
                                    } | {
                                        type: "somevalue";
                                    } | {
                                        type: "novalue";
                                    };
                                    qualifiers: {
                                        property: {
                                            id: string;
                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                        };
                                        value: {
                                            type: "value";
                                            content: any;
                                        } | {
                                            type: "somevalue";
                                        } | {
                                            type: "novalue";
                                        };
                                    }[];
                                    references: {
                                        parts: {
                                            property: {
                                                id: string;
                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                            };
                                            value: {
                                                type: "value";
                                                content: any;
                                            } | {
                                                type: "somevalue";
                                            } | {
                                                type: "novalue";
                                            };
                                        }[];
                                        hash: string;
                                    }[];
                                    rezics: {
                                        release: string;
                                        revision: number;
                                    };
                                }[]>;
                            };
                            related: Record<string, {
                                labels: Record<string, string>;
                            }>;
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        404: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            releases: {
                post: {
                    body: {
                        release: Record<string, any>;
                    };
                    params: {};
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        200: {
                            digest: string;
                        };
                        201: {
                            digest: string;
                        };
                        400: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        403: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        422: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            releases: {
                ":digest": {
                    get: {
                        body: unknown;
                        params: {
                            digest: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                digest: string;
                                release: Record<string, any>;
                            };
                            401: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            404: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            503: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            active: {
                get: {
                    body: unknown;
                    params: {};
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            digest: string;
                            head: number;
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        404: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            releases: {
                ":digest": {
                    $activate: {
                        post: {
                            body: {
                                expected_head: number | null;
                            };
                            params: {
                                digest: string;
                            };
                            query: unknown;
                            headers: {
                                "idempotency-key": string;
                            };
                            response: {
                                200: {
                                    digest: string;
                                    head: number;
                                };
                                400: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                401: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                403: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                404: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                409: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                422: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                503: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                            };
                            error: never;
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        contexts: {
            post: {
                body: {
                    labels?: Record<string, any>;
                };
                params: {};
                query: unknown;
                headers: {
                    "idempotency-key": string;
                };
                response: {
                    200: {
                        context: {
                            id: string;
                            kind: 'community';
                            labels: Record<string, string>;
                        };
                    };
                    201: {
                        context: {
                            id: string;
                            kind: "community" | "global";
                            labels: Record<string, string>;
                        };
                    };
                    400: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    401: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    403: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    422: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    503: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                };
                error: never;
            };
        };
    };
}, import("elysia").DefaultEphemeral, {
    derive: {
        readonly admission: import("./admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("../request/access.ts").Actor;
        readonly session: {
            readonly components: import("../tokens/session.ts").SessionComponent[];
            record(component: import("../tokens/session.ts").SessionComponent): void;
        };
        readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
    };
    schema: {};
    schemas: {};
    response: {};
    error: [];
}, "get", "/v1/contexts/:id", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    params: import("typebox").TObject<{
        id: import("typebox").TString;
    }>;
    response: {
        200: import("typebox").TObject<{
            context: import("typebox").TObject<{
                id: import("typebox").TString;
                kind: import("typebox").TUnion<[import("typebox").TLiteral<"community">, import("typebox").TLiteral<"global">]>;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>;
        }> & {
            headers: {
                readonly "rezics-session-token": import("typebox").TString;
            };
        };
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}, {}, "/v1/contexts/:id">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ params, authorize, admission, job, session }: {
    server: import("elysia").Server | null;
    redirect: import("elysia").redirect;
    set: {
        headers: import("elysia").HTTPHeaders;
        status?: number | keyof import("elysia").StatusMap;
        cookie?: Record<string, import("elysia").BaseCookie>;
        redirect?: never;
    };
    status: import("elysia").SelectiveStatus<{
        200: {
            context: {
                id: string;
                kind: "community" | "global";
                labels: Record<string, string>;
            };
        };
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        404: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
    }>;
    problem: import("elysia").SelectiveProblem<{
        200: {
            context: {
                id: string;
                kind: "community" | "global";
                labels: Record<string, string>;
            };
        };
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        404: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        params: import("typebox").TObject<{
            id: import("typebox").TString;
        }>;
        response: {
            200: import("typebox").TObject<{
                context: import("typebox").TObject<{
                    id: import("typebox").TString;
                    kind: import("typebox").TUnion<[import("typebox").TLiteral<"community">, import("typebox").TLiteral<"global">]>;
                    labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                }>;
            }> & {
                headers: {
                    readonly "rezics-session-token": import("typebox").TString;
                };
            };
            401: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            404: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            503: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
        };
        detail: {
            operationId: string;
            'x-action': string;
            security: ({
                bearerAuth: never[];
            } | {
                bearerAuth?: never;
            })[];
        };
    }, {}, "/v1/contexts/:id">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("./admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("../request/access.ts").Actor;
            readonly session: {
                readonly components: import("../tokens/session.ts").SessionComponent[];
                record(component: import("../tokens/session.ts").SessionComponent): void;
            };
            readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
            readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
        };
    }>>) => import("elysia/types").MaybePromise<void>;
    readonly path: string;
    route?: string;
    rid?: string;
    request: Request;
    store: {};
    body: unknown;
    query: Record<string, string | undefined>;
    params: {
        id: string;
    };
    headers: Record<string, string | undefined>;
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: import("./admission.ts").Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: import("../request/access.ts").Actor;
    readonly session: {
        readonly components: import("../tokens/session.ts").SessionComponent[];
        record(component: import("../tokens/session.ts").SessionComponent): void;
    };
    readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<{
    context: import("../semantic/context.ts").ContextRecord;
}>, {
    params: import("typebox").TObject<{
        id: import("typebox").TString;
    }>;
    response: {
        200: import("typebox").TObject<{
            context: import("typebox").TObject<{
                id: import("typebox").TString;
                kind: import("typebox").TUnion<[import("typebox").TLiteral<"community">, import("typebox").TLiteral<"global">]>;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>;
        }> & {
            headers: {
                readonly "rezics-session-token": import("typebox").TString;
            };
        };
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}>) & import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
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
} & {
    v1: {
        subjects: {
            post: {
                body: {
                    type: string;
                    labels: Record<string, any>;
                    descriptions?: Record<string, any>;
                    aliases?: Record<string, any>;
                    statements?: Record<string, any>;
                };
                params: {};
                query: unknown;
                headers: {
                    "idempotency-key": string;
                };
                response: {
                    200: {
                        subject: import("../semantic/item.ts").Item;
                    };
                    201: {
                        subject: {
                            id: string;
                            type: string;
                            revision: number;
                            release: string;
                            context: string;
                            resolution: Record<string, any>;
                            labels: Record<string, string>;
                            descriptions: Record<string, string>;
                            aliases: Record<string, string[]>;
                            statements: Record<string, {
                                id: string;
                                rank: "deprecated" | "normal" | "preferred";
                                property: {
                                    id: string;
                                    data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                };
                                value: {
                                    type: "value";
                                    content: any;
                                } | {
                                    type: "somevalue";
                                } | {
                                    type: "novalue";
                                };
                                qualifiers: {
                                    property: {
                                        id: string;
                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                    };
                                    value: {
                                        type: "value";
                                        content: any;
                                    } | {
                                        type: "somevalue";
                                    } | {
                                        type: "novalue";
                                    };
                                }[];
                                references: {
                                    parts: {
                                        property: {
                                            id: string;
                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                        };
                                        value: {
                                            type: "value";
                                            content: any;
                                        } | {
                                            type: "somevalue";
                                        } | {
                                            type: "novalue";
                                        };
                                    }[];
                                    hash: string;
                                }[];
                                rezics: {
                                    release: string;
                                    revision: number;
                                };
                            }[]>;
                        };
                    };
                    400: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    401: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    403: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    422: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    503: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                };
                error: never;
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                get: {
                    body: unknown;
                    params: {
                        id: string;
                    };
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            subject: {
                                id: string;
                                type: string;
                                revision: number;
                                release: string;
                                context: string;
                                resolution: Record<string, any>;
                                labels: Record<string, string>;
                                descriptions: Record<string, string>;
                                aliases: Record<string, string[]>;
                                statements: Record<string, {
                                    id: string;
                                    rank: "deprecated" | "normal" | "preferred";
                                    property: {
                                        id: string;
                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                    };
                                    value: {
                                        type: "value";
                                        content: any;
                                    } | {
                                        type: "somevalue";
                                    } | {
                                        type: "novalue";
                                    };
                                    qualifiers: {
                                        property: {
                                            id: string;
                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                        };
                                        value: {
                                            type: "value";
                                            content: any;
                                        } | {
                                            type: "somevalue";
                                        } | {
                                            type: "novalue";
                                        };
                                    }[];
                                    references: {
                                        parts: {
                                            property: {
                                                id: string;
                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                            };
                                            value: {
                                                type: "value";
                                                content: any;
                                            } | {
                                                type: "somevalue";
                                            } | {
                                                type: "novalue";
                                            };
                                        }[];
                                        hash: string;
                                    }[];
                                    rezics: {
                                        release: string;
                                        revision: number;
                                    };
                                }[]>;
                            };
                            related: Record<string, {
                                labels: Record<string, string>;
                            }>;
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        404: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            releases: {
                post: {
                    body: {
                        release: Record<string, any>;
                    };
                    params: {};
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        200: {
                            digest: string;
                        };
                        201: {
                            digest: string;
                        };
                        400: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        403: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        422: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            releases: {
                ":digest": {
                    get: {
                        body: unknown;
                        params: {
                            digest: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                digest: string;
                                release: Record<string, any>;
                            };
                            401: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            404: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            503: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            active: {
                get: {
                    body: unknown;
                    params: {};
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            digest: string;
                            head: number;
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        404: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            releases: {
                ":digest": {
                    $activate: {
                        post: {
                            body: {
                                expected_head: number | null;
                            };
                            params: {
                                digest: string;
                            };
                            query: unknown;
                            headers: {
                                "idempotency-key": string;
                            };
                            response: {
                                200: {
                                    digest: string;
                                    head: number;
                                };
                                400: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                401: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                403: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                404: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                409: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                422: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                503: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                            };
                            error: never;
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        payoutStatements: {
            get: {
                body: unknown;
                params: {};
                query: {
                    cursor?: string;
                    limit?: number;
                };
                headers: unknown;
                response: {
                    200: {
                        payoutStatements: {
                            id: string;
                            creatorAccountId: string;
                            period: string;
                            currency: string;
                            grossMinor: number;
                            taxMinor: number;
                            feeMinor: number;
                            disputeFeeMinor: number;
                            refundsMinor: number;
                            chargebacksMinor: number;
                            netReceiptsMinor: number;
                            creatorShareMinor: number;
                            rezicsShareMinor: number;
                            weightedNetMinor: string;
                            state: "open" | "paid";
                            paidAt: string | null;
                            paidReference: string | null;
                            revision: number;
                        }[];
                        next: string | null;
                    };
                    400: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    401: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    404: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    409: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    422: Response | {
                        type: 'validation';
                        code: 'validation';
                        title: 'Validation Error';
                        status: 422;
                        detail?: string;
                        on: string;
                        found?: unknown;
                        property?: string;
                        expected?: string;
                    };
                    503: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                };
                error: never;
            };
        };
    };
} & {
    v1: {
        payoutStatements: {
            ":statementId": {
                get: {
                    body: unknown;
                    params: {
                        statementId: string;
                    };
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            statement: {
                                id: string;
                                creatorAccountId: string;
                                period: string;
                                currency: string;
                                grossMinor: number;
                                taxMinor: number;
                                feeMinor: number;
                                disputeFeeMinor: number;
                                refundsMinor: number;
                                chargebacksMinor: number;
                                netReceiptsMinor: number;
                                creatorShareMinor: number;
                                rezicsShareMinor: number;
                                weightedNetMinor: string;
                                state: "open" | "paid";
                                paidAt: string | null;
                                paidReference: string | null;
                                revision: number;
                            };
                        };
                        400: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        404: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        payoutStatements: {
            ":statementId": {
                lines: {
                    get: {
                        body: unknown;
                        params: {
                            statementId: string;
                        };
                        query: {
                            cursor?: string;
                            limit?: number;
                        };
                        headers: unknown;
                        response: {
                            200: {
                                lines: {
                                    balanceTransactionId: string;
                                    orderId: string;
                                    offerId: string;
                                    creatorAccountId: string;
                                    currency: string;
                                    kind: "charge" | "dispute" | "dispute_reversal" | "refund" | "refund_reversal";
                                    created: string;
                                    grossMinor: number;
                                    taxMinor: number;
                                    feeMinor: number;
                                    disputeFeeMinor: number;
                                    netReceiptsMinor: number;
                                    royaltyBasisPoints: number;
                                    period: string;
                                    statementId: string;
                                    recordedAt: string;
                                }[];
                                next: string | null;
                            };
                            400: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            401: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            404: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            409: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            422: Response | {
                                type: 'validation';
                                code: 'validation';
                                title: 'Validation Error';
                                status: 422;
                                detail?: string;
                                on: string;
                                found?: unknown;
                                property?: string;
                                expected?: string;
                            };
                            503: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
}, import("elysia").DefaultEphemeral, {
    derive: {
        readonly admission: import("./admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("../request/access.ts").Actor;
        readonly session: {
            readonly components: import("../tokens/session.ts").SessionComponent[];
            record(component: import("../tokens/session.ts").SessionComponent): void;
        };
        readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
    };
    schema: {};
    schemas: {};
    response: {};
    error: [];
}, "post", "/v1/payoutStatements/:statementId/$markPaid", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    params: import("typebox").TObject<{
        statementId: import("typebox").TString;
    }>;
    headers: import("typebox").TObject<{
        "idempotency-key": import("typebox").TString;
    }>;
    body: import("typebox").TObject<{
        paidReference: import("typebox").TString;
    }>;
    response: {
        400: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        200: import("typebox").TObject<{
            statement: import("typebox").TObject<{
                id: import("typebox").TString;
                state: import("typebox").TLiteral<"paid">;
                paidAt: import("typebox").TString;
                paidReference: import("typebox").TString;
                revision: import("typebox").TInteger;
            }>;
        }>;
        409: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        422: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        security: {
            bearerAuth: never[];
        }[];
    };
}, {}, "/v1/payoutStatements/:statementId/$markPaid">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ actor, authorizeCommand, params, body, headers, admission, job, session }: {
    server: import("elysia").Server | null;
    redirect: import("elysia").redirect;
    set: {
        headers: import("elysia").HTTPHeaders;
        status?: number | keyof import("elysia").StatusMap;
        cookie?: Record<string, import("elysia").BaseCookie>;
        redirect?: never;
    };
    status: import("elysia").SelectiveStatus<{
        400: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        404: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        200: {
            statement: {
                id: string;
                state: "paid";
                paidAt: string;
                paidReference: string;
                revision: number;
            };
        };
        409: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        422: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
    }>;
    problem: import("elysia").SelectiveProblem<{
        400: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        404: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        200: {
            statement: {
                id: string;
                state: "paid";
                paidAt: string;
                paidReference: string;
                revision: number;
            };
        };
        409: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        422: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        params: import("typebox").TObject<{
            statementId: import("typebox").TString;
        }>;
        headers: import("typebox").TObject<{
            "idempotency-key": import("typebox").TString;
        }>;
        body: import("typebox").TObject<{
            paidReference: import("typebox").TString;
        }>;
        response: {
            400: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            401: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            404: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            503: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            200: import("typebox").TObject<{
                statement: import("typebox").TObject<{
                    id: import("typebox").TString;
                    state: import("typebox").TLiteral<"paid">;
                    paidAt: import("typebox").TString;
                    paidReference: import("typebox").TString;
                    revision: import("typebox").TInteger;
                }>;
            }>;
            409: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            422: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
        };
        detail: {
            operationId: string;
            'x-action': string;
            security: {
                bearerAuth: never[];
            }[];
        };
    }, {}, "/v1/payoutStatements/:statementId/$markPaid">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("./admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("../request/access.ts").Actor;
            readonly session: {
                readonly components: import("../tokens/session.ts").SessionComponent[];
                record(component: import("../tokens/session.ts").SessionComponent): void;
            };
            readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
            readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
        };
    }>>) => import("elysia/types").MaybePromise<void>;
    readonly path: string;
    route?: string;
    rid?: string;
    request: Request;
    store: {};
    body: {
        paidReference: string;
    };
    query: Record<string, string | undefined>;
    params: {
        statementId: string;
    };
    headers: {
        "idempotency-key": string;
    };
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: import("./admission.ts").Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: import("../request/access.ts").Actor;
    readonly session: {
        readonly components: import("../tokens/session.ts").SessionComponent[];
        record(component: import("../tokens/session.ts").SessionComponent): void;
    };
    readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<{
    statement: {
        id: string;
        state: 'paid';
        paidAt: string;
        paidReference: string;
        revision: number;
    };
}>, {
    params: import("typebox").TObject<{
        statementId: import("typebox").TString;
    }>;
    headers: import("typebox").TObject<{
        "idempotency-key": import("typebox").TString;
    }>;
    body: import("typebox").TObject<{
        paidReference: import("typebox").TString;
    }>;
    response: {
        400: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        200: import("typebox").TObject<{
            statement: import("typebox").TObject<{
                id: import("typebox").TString;
                state: import("typebox").TLiteral<"paid">;
                paidAt: import("typebox").TString;
                paidReference: import("typebox").TString;
                revision: import("typebox").TInteger;
            }>;
        }>;
        409: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        422: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        security: {
            bearerAuth: never[];
        }[];
    };
}> & (import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
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
} & {
    v1: {
        subjects: {
            post: {
                body: {
                    type: string;
                    labels: Record<string, any>;
                    descriptions?: Record<string, any>;
                    aliases?: Record<string, any>;
                    statements?: Record<string, any>;
                };
                params: {};
                query: unknown;
                headers: {
                    "idempotency-key": string;
                };
                response: {
                    200: {
                        subject: import("../semantic/item.ts").Item;
                    };
                    201: {
                        subject: {
                            id: string;
                            type: string;
                            revision: number;
                            release: string;
                            context: string;
                            resolution: Record<string, any>;
                            labels: Record<string, string>;
                            descriptions: Record<string, string>;
                            aliases: Record<string, string[]>;
                            statements: Record<string, {
                                id: string;
                                rank: "deprecated" | "normal" | "preferred";
                                property: {
                                    id: string;
                                    data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                };
                                value: {
                                    type: "value";
                                    content: any;
                                } | {
                                    type: "somevalue";
                                } | {
                                    type: "novalue";
                                };
                                qualifiers: {
                                    property: {
                                        id: string;
                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                    };
                                    value: {
                                        type: "value";
                                        content: any;
                                    } | {
                                        type: "somevalue";
                                    } | {
                                        type: "novalue";
                                    };
                                }[];
                                references: {
                                    parts: {
                                        property: {
                                            id: string;
                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                        };
                                        value: {
                                            type: "value";
                                            content: any;
                                        } | {
                                            type: "somevalue";
                                        } | {
                                            type: "novalue";
                                        };
                                    }[];
                                    hash: string;
                                }[];
                                rezics: {
                                    release: string;
                                    revision: number;
                                };
                            }[]>;
                        };
                    };
                    400: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    401: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    403: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    422: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    503: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                };
                error: never;
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                get: {
                    body: unknown;
                    params: {
                        id: string;
                    };
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            subject: {
                                id: string;
                                type: string;
                                revision: number;
                                release: string;
                                context: string;
                                resolution: Record<string, any>;
                                labels: Record<string, string>;
                                descriptions: Record<string, string>;
                                aliases: Record<string, string[]>;
                                statements: Record<string, {
                                    id: string;
                                    rank: "deprecated" | "normal" | "preferred";
                                    property: {
                                        id: string;
                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                    };
                                    value: {
                                        type: "value";
                                        content: any;
                                    } | {
                                        type: "somevalue";
                                    } | {
                                        type: "novalue";
                                    };
                                    qualifiers: {
                                        property: {
                                            id: string;
                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                        };
                                        value: {
                                            type: "value";
                                            content: any;
                                        } | {
                                            type: "somevalue";
                                        } | {
                                            type: "novalue";
                                        };
                                    }[];
                                    references: {
                                        parts: {
                                            property: {
                                                id: string;
                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                            };
                                            value: {
                                                type: "value";
                                                content: any;
                                            } | {
                                                type: "somevalue";
                                            } | {
                                                type: "novalue";
                                            };
                                        }[];
                                        hash: string;
                                    }[];
                                    rezics: {
                                        release: string;
                                        revision: number;
                                    };
                                }[]>;
                            };
                            related: Record<string, {
                                labels: Record<string, string>;
                            }>;
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        404: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            releases: {
                post: {
                    body: {
                        release: Record<string, any>;
                    };
                    params: {};
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        200: {
                            digest: string;
                        };
                        201: {
                            digest: string;
                        };
                        400: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        403: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        422: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            releases: {
                ":digest": {
                    get: {
                        body: unknown;
                        params: {
                            digest: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                digest: string;
                                release: Record<string, any>;
                            };
                            401: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            404: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            503: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            active: {
                get: {
                    body: unknown;
                    params: {};
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            digest: string;
                            head: number;
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        404: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            releases: {
                ":digest": {
                    $activate: {
                        post: {
                            body: {
                                expected_head: number | null;
                            };
                            params: {
                                digest: string;
                            };
                            query: unknown;
                            headers: {
                                "idempotency-key": string;
                            };
                            response: {
                                200: {
                                    digest: string;
                                    head: number;
                                };
                                400: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                401: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                403: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                404: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                409: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                422: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                503: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                            };
                            error: never;
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        offers: {
            ":offerId": {
                get: {
                    body: unknown;
                    params: {
                        offerId: string;
                    };
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            offer: {
                                id: string;
                                targetSubjectId: string;
                                title: string;
                                currency: string;
                                unitAmountMinor: number;
                                state: "active" | "delisted";
                            };
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        404: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        offers: {
            post: {
                body: {
                    targetSubjectId: string;
                    title: string;
                    currency: string;
                    unitAmountMinor: number;
                    taxCode: string;
                };
                params: {};
                query: unknown;
                headers: {
                    "idempotency-key": string;
                };
                response: {
                    200: {
                        offer: {
                            id: string;
                            targetSubjectId: string;
                            title: string;
                            currency: string;
                            unitAmountMinor: number;
                            state: "active" | "delisted";
                        };
                    };
                    201: {
                        offer: {
                            id: string;
                            targetSubjectId: string;
                            title: string;
                            currency: string;
                            unitAmountMinor: number;
                            state: "active" | "delisted";
                        };
                    };
                    400: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    401: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    403: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    422: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    503: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                };
                error: never;
            };
        };
    };
} & {
    v1: {
        offers: {
            ":offerId": {
                $delist: {
                    post: {
                        body: unknown;
                        params: {
                            offerId: string;
                        };
                        query: unknown;
                        headers: {
                            "idempotency-key": string;
                        };
                        response: {
                            200: {
                                offer: {
                                    id: string;
                                    targetSubjectId: string;
                                    title: string;
                                    currency: string;
                                    unitAmountMinor: number;
                                    state: "active" | "delisted";
                                };
                            };
                            400: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            401: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            404: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            422: Response | {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            503: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        orders: {
            post: {
                body: {
                    offerId: string;
                };
                params: {};
                query: unknown;
                headers: {
                    "idempotency-key": string;
                };
                response: {
                    200: {
                        order: {
                            id: string;
                            offerId: string;
                            settlement: import("../commerce/model.ts").Settlement;
                            checkoutUrl: string | null;
                            checkoutExpiresAt: string | null;
                            entitlementId: string | null;
                            createdAt: string;
                        };
                    };
                    201: {
                        order: {
                            id: string;
                            offerId: string;
                            settlement: "failed" | "paid" | "pending" | "unknown";
                            checkoutUrl: string | null;
                            checkoutExpiresAt: string | null;
                            entitlementId: string | null;
                            createdAt: string;
                        };
                    };
                    400: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    401: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    404: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    409: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    422: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    503: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                };
                error: never;
            };
        };
    };
} & {
    v1: {
        orders: {
            ":orderId": {
                get: {
                    body: unknown;
                    params: {
                        orderId: string;
                    };
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            order: {
                                id: string;
                                offerId: string;
                                settlement: "failed" | "paid" | "pending" | "unknown";
                                checkoutUrl: string | null;
                                checkoutExpiresAt: string | null;
                                entitlementId: string | null;
                                createdAt: string;
                            };
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        404: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        entitlements: {
            get: {
                body: unknown;
                params: {};
                query: {
                    limit?: number;
                    cursor?: string;
                };
                headers: unknown;
                response: {
                    200: {
                        entitlements: {
                            id: string;
                            offerId: string;
                            orderId: string;
                            targetSubjectId: string;
                            grantedAt: string;
                            revokedAt: string | null;
                            revokeReason: "dispute" | "refund" | null;
                            active: boolean;
                        }[];
                        next: string | null;
                    };
                    400: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    401: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    403: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    409: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    422: Response | {
                        type: 'validation';
                        code: 'validation';
                        title: 'Validation Error';
                        status: 422;
                        detail?: string;
                        on: string;
                        found?: unknown;
                        property?: string;
                        expected?: string;
                    };
                    503: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                };
                error: never;
            };
        };
    };
}, import("elysia").DefaultEphemeral, {
    derive: {
        readonly admission: import("./admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("../request/access.ts").Actor;
        readonly session: {
            readonly components: import("../tokens/session.ts").SessionComponent[];
            record(component: import("../tokens/session.ts").SessionComponent): void;
        };
        readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
    };
    schema: {};
    schemas: {};
    response: {};
    error: [];
}, "get", "/v1/entitlements/:entitlementId", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    params: import("typebox").TObject<{
        entitlementId: import("typebox").TString;
    }>;
    response: {
        200: import("typebox").TObject<{
            entitlement: import("typebox").TObject<{
                id: import("typebox").TString;
                offerId: import("typebox").TString;
                orderId: import("typebox").TString;
                targetSubjectId: import("typebox").TString;
                grantedAt: import("typebox").TString;
                revokedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                revokeReason: import("typebox").TUnion<[import("typebox").TLiteral<"refund">, import("typebox").TLiteral<"dispute">, import("typebox").TNull]>;
                active: import("typebox").TBoolean;
            }>;
        }>;
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        security: {}[];
    };
}, {}, "/v1/entitlements/:entitlementId">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ params, actor, admission, job }: {
    server: import("elysia").Server | null;
    redirect: import("elysia").redirect;
    set: {
        headers: import("elysia").HTTPHeaders;
        status?: number | keyof import("elysia").StatusMap;
        cookie?: Record<string, import("elysia").BaseCookie>;
        redirect?: never;
    };
    status: import("elysia").SelectiveStatus<{
        200: {
            entitlement: {
                id: string;
                offerId: string;
                orderId: string;
                targetSubjectId: string;
                grantedAt: string;
                revokedAt: string | null;
                revokeReason: "dispute" | "refund" | null;
                active: boolean;
            };
        };
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        404: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
    }>;
    problem: import("elysia").SelectiveProblem<{
        200: {
            entitlement: {
                id: string;
                offerId: string;
                orderId: string;
                targetSubjectId: string;
                grantedAt: string;
                revokedAt: string | null;
                revokeReason: "dispute" | "refund" | null;
                active: boolean;
            };
        };
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        404: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        params: import("typebox").TObject<{
            entitlementId: import("typebox").TString;
        }>;
        response: {
            200: import("typebox").TObject<{
                entitlement: import("typebox").TObject<{
                    id: import("typebox").TString;
                    offerId: import("typebox").TString;
                    orderId: import("typebox").TString;
                    targetSubjectId: import("typebox").TString;
                    grantedAt: import("typebox").TString;
                    revokedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    revokeReason: import("typebox").TUnion<[import("typebox").TLiteral<"refund">, import("typebox").TLiteral<"dispute">, import("typebox").TNull]>;
                    active: import("typebox").TBoolean;
                }>;
            }>;
            401: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            404: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            503: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
        };
        detail: {
            operationId: string;
            'x-action': string;
            security: {}[];
        };
    }, {}, "/v1/entitlements/:entitlementId">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("./admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("../request/access.ts").Actor;
            readonly session: {
                readonly components: import("../tokens/session.ts").SessionComponent[];
                record(component: import("../tokens/session.ts").SessionComponent): void;
            };
            readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
            readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
        };
    }>>) => import("elysia/types").MaybePromise<void>;
    readonly path: string;
    route?: string;
    rid?: string;
    request: Request;
    store: {};
    body: unknown;
    query: Record<string, string | undefined>;
    params: {
        entitlementId: string;
    };
    headers: Record<string, string | undefined>;
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: import("./admission.ts").Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: import("../request/access.ts").Actor;
    readonly session: {
        readonly components: import("../tokens/session.ts").SessionComponent[];
        record(component: import("../tokens/session.ts").SessionComponent): void;
    };
    readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<{
    entitlement: {
        id: string;
        offerId: string;
        orderId: string;
        targetSubjectId: string;
        grantedAt: string;
        revokedAt: string | null;
        revokeReason: import("../commerce/model.ts").RevokeReason | null;
        active: boolean;
    };
}>, {
    params: import("typebox").TObject<{
        entitlementId: import("typebox").TString;
    }>;
    response: {
        200: import("typebox").TObject<{
            entitlement: import("typebox").TObject<{
                id: import("typebox").TString;
                offerId: import("typebox").TString;
                orderId: import("typebox").TString;
                targetSubjectId: import("typebox").TString;
                grantedAt: import("typebox").TString;
                revokedAt: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                revokeReason: import("typebox").TUnion<[import("typebox").TLiteral<"refund">, import("typebox").TLiteral<"dispute">, import("typebox").TNull]>;
                active: import("typebox").TBoolean;
            }>;
        }>;
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        security: {}[];
    };
}> & import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
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
        readonly admission: import("./admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("../request/access.ts").Actor;
        readonly session: {
            readonly components: import("../tokens/session.ts").SessionComponent[];
            record(component: import("../tokens/session.ts").SessionComponent): void;
        };
        readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
    };
    schema: {};
    schemas: {};
    response: {};
    error: [];
}, "post", "/v1/webhooks/stripe", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    parse: "none";
    detail: {
        hide: true;
    };
    response: {
        200: import("typebox").TObject<{
            received: import("typebox").TLiteral<true>;
        }>;
        400: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
    };
}, {}, "/v1/webhooks/stripe">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ request }: {
    server: import("elysia").Server | null;
    redirect: import("elysia").redirect;
    set: {
        headers: import("elysia").HTTPHeaders;
        status?: number | keyof import("elysia").StatusMap;
        cookie?: Record<string, import("elysia").BaseCookie>;
        redirect?: never;
    };
    status: import("elysia").SelectiveStatus<{
        200: {
            received: true;
        };
        400: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
    }>;
    problem: import("elysia").SelectiveProblem<{
        200: {
            received: true;
        };
        400: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        parse: "none";
        detail: {
            hide: true;
        };
        response: {
            200: import("typebox").TObject<{
                received: import("typebox").TLiteral<true>;
            }>;
            400: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            503: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
        };
    }, {}, "/v1/webhooks/stripe">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("./admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("../request/access.ts").Actor;
            readonly session: {
                readonly components: import("../tokens/session.ts").SessionComponent[];
                record(component: import("../tokens/session.ts").SessionComponent): void;
            };
            readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
            readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
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
    readonly admission: import("./admission.ts").Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: import("../request/access.ts").Actor;
    readonly session: {
        readonly components: import("../tokens/session.ts").SessionComponent[];
        record(component: import("../tokens/session.ts").SessionComponent): void;
    };
    readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<{
    received: true;
}>, {
    parse: "none";
    detail: {
        hide: true;
    };
    response: {
        200: import("typebox").TObject<{
            received: import("typebox").TLiteral<true>;
        }>;
        400: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
    };
}>) & import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
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
} & {
    v1: {
        subjects: {
            post: {
                body: {
                    type: string;
                    labels: Record<string, any>;
                    descriptions?: Record<string, any>;
                    aliases?: Record<string, any>;
                    statements?: Record<string, any>;
                };
                params: {};
                query: unknown;
                headers: {
                    "idempotency-key": string;
                };
                response: {
                    200: {
                        subject: import("../semantic/item.ts").Item;
                    };
                    201: {
                        subject: {
                            id: string;
                            type: string;
                            revision: number;
                            release: string;
                            context: string;
                            resolution: Record<string, any>;
                            labels: Record<string, string>;
                            descriptions: Record<string, string>;
                            aliases: Record<string, string[]>;
                            statements: Record<string, {
                                id: string;
                                rank: "deprecated" | "normal" | "preferred";
                                property: {
                                    id: string;
                                    data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                };
                                value: {
                                    type: "value";
                                    content: any;
                                } | {
                                    type: "somevalue";
                                } | {
                                    type: "novalue";
                                };
                                qualifiers: {
                                    property: {
                                        id: string;
                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                    };
                                    value: {
                                        type: "value";
                                        content: any;
                                    } | {
                                        type: "somevalue";
                                    } | {
                                        type: "novalue";
                                    };
                                }[];
                                references: {
                                    parts: {
                                        property: {
                                            id: string;
                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                        };
                                        value: {
                                            type: "value";
                                            content: any;
                                        } | {
                                            type: "somevalue";
                                        } | {
                                            type: "novalue";
                                        };
                                    }[];
                                    hash: string;
                                }[];
                                rezics: {
                                    release: string;
                                    revision: number;
                                };
                            }[]>;
                        };
                    };
                    400: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    401: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    403: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    422: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    503: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                };
                error: never;
            };
        };
    };
} & {
    v1: {
        subjects: {
            ":id": {
                get: {
                    body: unknown;
                    params: {
                        id: string;
                    };
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            subject: {
                                id: string;
                                type: string;
                                revision: number;
                                release: string;
                                context: string;
                                resolution: Record<string, any>;
                                labels: Record<string, string>;
                                descriptions: Record<string, string>;
                                aliases: Record<string, string[]>;
                                statements: Record<string, {
                                    id: string;
                                    rank: "deprecated" | "normal" | "preferred";
                                    property: {
                                        id: string;
                                        data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                    };
                                    value: {
                                        type: "value";
                                        content: any;
                                    } | {
                                        type: "somevalue";
                                    } | {
                                        type: "novalue";
                                    };
                                    qualifiers: {
                                        property: {
                                            id: string;
                                            data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                        };
                                        value: {
                                            type: "value";
                                            content: any;
                                        } | {
                                            type: "somevalue";
                                        } | {
                                            type: "novalue";
                                        };
                                    }[];
                                    references: {
                                        parts: {
                                            property: {
                                                id: string;
                                                data_type: "document" | "external-id" | "media" | "monolingualtext" | "quantity" | "string" | "time" | "url" | "wikibase-item";
                                            };
                                            value: {
                                                type: "value";
                                                content: any;
                                            } | {
                                                type: "somevalue";
                                            } | {
                                                type: "novalue";
                                            };
                                        }[];
                                        hash: string;
                                    }[];
                                    rezics: {
                                        release: string;
                                        revision: number;
                                    };
                                }[]>;
                            };
                            related: Record<string, {
                                labels: Record<string, string>;
                            }>;
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        404: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            releases: {
                post: {
                    body: {
                        release: Record<string, any>;
                    };
                    params: {};
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        200: {
                            digest: string;
                        };
                        201: {
                            digest: string;
                        };
                        400: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        403: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        422: Response | {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            releases: {
                ":digest": {
                    get: {
                        body: unknown;
                        params: {
                            digest: string;
                        };
                        query: unknown;
                        headers: unknown;
                        response: {
                            200: {
                                digest: string;
                                release: Record<string, any>;
                            };
                            401: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            404: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                            503: {
                                type: unknown;
                                title: unknown;
                                status: number;
                                code: unknown;
                                retryable: unknown;
                                effect_status: "not_applicable" | "not_applied";
                                request_id: string;
                                detail?: string;
                                errors?: {
                                    pointer: string;
                                    code: never;
                                }[];
                            };
                        };
                        error: never;
                    };
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            active: {
                get: {
                    body: unknown;
                    params: {};
                    query: unknown;
                    headers: unknown;
                    response: {
                        200: {
                            digest: string;
                            head: number;
                        };
                        401: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        404: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                        503: {
                            type: unknown;
                            title: unknown;
                            status: number;
                            code: unknown;
                            retryable: unknown;
                            effect_status: "not_applicable" | "not_applied";
                            request_id: string;
                            detail?: string;
                            errors?: {
                                pointer: string;
                                code: never;
                            }[];
                        };
                    };
                    error: never;
                };
            };
        };
    };
} & {
    v1: {
        definitions: {
            releases: {
                ":digest": {
                    $activate: {
                        post: {
                            body: {
                                expected_head: number | null;
                            };
                            params: {
                                digest: string;
                            };
                            query: unknown;
                            headers: {
                                "idempotency-key": string;
                            };
                            response: {
                                200: {
                                    digest: string;
                                    head: number;
                                };
                                400: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                401: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                403: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                404: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                409: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                422: Response | {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                                503: {
                                    type: unknown;
                                    title: unknown;
                                    status: number;
                                    code: unknown;
                                    retryable: unknown;
                                    effect_status: "not_applicable" | "not_applied";
                                    request_id: string;
                                    detail?: string;
                                    errors?: {
                                        pointer: string;
                                        code: never;
                                    }[];
                                };
                            };
                            error: never;
                        };
                    };
                };
            };
        };
    };
} & {
    v1: {
        contexts: {
            post: {
                body: {
                    labels?: Record<string, any>;
                };
                params: {};
                query: unknown;
                headers: {
                    "idempotency-key": string;
                };
                response: {
                    200: {
                        context: {
                            id: string;
                            kind: 'community';
                            labels: Record<string, string>;
                        };
                    };
                    201: {
                        context: {
                            id: string;
                            kind: "community" | "global";
                            labels: Record<string, string>;
                        };
                    };
                    400: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    401: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    403: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    422: Response | {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                    503: {
                        type: unknown;
                        title: unknown;
                        status: number;
                        code: unknown;
                        retryable: unknown;
                        effect_status: "not_applicable" | "not_applied";
                        request_id: string;
                        detail?: string;
                        errors?: {
                            pointer: string;
                            code: never;
                        }[];
                    };
                };
                error: never;
            };
        };
    };
}, import("elysia").DefaultEphemeral, {
    derive: {
        readonly admission: import("./admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("../request/access.ts").Actor;
        readonly session: {
            readonly components: import("../tokens/session.ts").SessionComponent[];
            record(component: import("../tokens/session.ts").SessionComponent): void;
        };
        readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
    };
    schema: {};
    schemas: {};
    response: {};
    error: [];
}, "get", "/v1/contexts/:id", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    params: import("typebox").TObject<{
        id: import("typebox").TString;
    }>;
    response: {
        200: import("typebox").TObject<{
            context: import("typebox").TObject<{
                id: import("typebox").TString;
                kind: import("typebox").TUnion<[import("typebox").TLiteral<"community">, import("typebox").TLiteral<"global">]>;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>;
        }> & {
            headers: {
                readonly "rezics-session-token": import("typebox").TString;
            };
        };
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}, {}, "/v1/contexts/:id">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ params, authorize, admission, job, session }: {
    server: import("elysia").Server | null;
    redirect: import("elysia").redirect;
    set: {
        headers: import("elysia").HTTPHeaders;
        status?: number | keyof import("elysia").StatusMap;
        cookie?: Record<string, import("elysia").BaseCookie>;
        redirect?: never;
    };
    status: import("elysia").SelectiveStatus<{
        200: {
            context: {
                id: string;
                kind: "community" | "global";
                labels: Record<string, string>;
            };
        };
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        404: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
    }>;
    problem: import("elysia").SelectiveProblem<{
        200: {
            context: {
                id: string;
                kind: "community" | "global";
                labels: Record<string, string>;
            };
        };
        401: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        404: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
        503: {
            type: unknown;
            title: unknown;
            status: number;
            code: unknown;
            retryable: unknown;
            effect_status: "not_applicable" | "not_applied";
            request_id: string;
            detail?: string;
            errors?: {
                pointer: string;
                code: never;
            }[];
        };
    }>;
    defer: (fn: import("elysia/types").AfterResponseHandler<NoInfer<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
        params: import("typebox").TObject<{
            id: import("typebox").TString;
        }>;
        response: {
            200: import("typebox").TObject<{
                context: import("typebox").TObject<{
                    id: import("typebox").TString;
                    kind: import("typebox").TUnion<[import("typebox").TLiteral<"community">, import("typebox").TLiteral<"global">]>;
                    labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                }>;
            }> & {
                headers: {
                    readonly "rezics-session-token": import("typebox").TString;
                };
            };
            401: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            404: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            503: import("typebox").TObject<{
                type: import("typebox").TSchema;
                title: import("typebox").TSchema;
                status: import("typebox").TLiteral<number>;
                code: import("typebox").TSchema;
                retryable: import("typebox").TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
        };
        detail: {
            operationId: string;
            'x-action': string;
            security: ({
                bearerAuth: never[];
            } | {
                bearerAuth?: never;
            })[];
        };
    }, {}, "/v1/contexts/:id">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("./admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("../request/access.ts").Actor;
            readonly session: {
                readonly components: import("../tokens/session.ts").SessionComponent[];
                record(component: import("../tokens/session.ts").SessionComponent): void;
            };
            readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
            readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
        };
    }>>) => import("elysia/types").MaybePromise<void>;
    readonly path: string;
    route?: string;
    rid?: string;
    request: Request;
    store: {};
    body: unknown;
    query: Record<string, string | undefined>;
    params: {
        id: string;
    };
    headers: Record<string, string | undefined>;
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: import("./admission.ts").Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: import("../request/access.ts").Actor;
    readonly session: {
        readonly components: import("../tokens/session.ts").SessionComponent[];
        record(component: import("../tokens/session.ts").SessionComponent): void;
    };
    readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<{
    context: import("../semantic/context.ts").ContextRecord;
}>, {
    params: import("typebox").TObject<{
        id: import("typebox").TString;
    }>;
    response: {
        200: import("typebox").TObject<{
            context: import("typebox").TObject<{
                id: import("typebox").TString;
                kind: import("typebox").TUnion<[import("typebox").TLiteral<"community">, import("typebox").TLiteral<"global">]>;
                labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
            }>;
        }> & {
            headers: {
                readonly "rezics-session-token": import("typebox").TString;
            };
        };
        401: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        404: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: import("typebox").TSchema;
            title: import("typebox").TSchema;
            status: import("typebox").TLiteral<number>;
            code: import("typebox").TSchema;
            retryable: import("typebox").TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-action': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}>;
/** The app's type is the Eden contract. */
export type Kernel = ReturnType<typeof createKernel>;
