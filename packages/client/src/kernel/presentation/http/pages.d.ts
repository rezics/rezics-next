import type { Pool } from 'pg';
import type { Access, AccessFactory } from '../../request/access.ts';
import type { SearchServiceContract } from '../../search/service-contract.ts';
import type { SessionComponent } from '../../tokens/session.ts';
import type { KeyRing } from '../../tokens/seal.ts';
export { PageResponseSchema, extendPageResponseSchema } from './page-contract.ts';
declare function nativePageRoute<App, const Path extends string>(app: App, { pool, routeKey, access, tokens, clock, dispatch, bookSearch, deadlineNow, }: {
    pool: Pool;
    routeKey: Uint8Array;
    access?: Access | AccessFactory;
    tokens: KeyRing;
    clock: () => Date;
    dispatch: (request: Request) => Promise<Response>;
    bookSearch?: {
        service: Pick<SearchServiceContract, 'search'>;
        includeEligibility: boolean;
    };
    /** Real wall time for the page authority's request deadlines, supplied by composition. */
    deadlineNow: () => number;
}, path: Path, draftPreview: boolean): import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
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
        readonly admission: import("../../http/admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("../../request/access.ts").AccountActor | {
            kind: 'anonymous';
        };
        readonly session: {
            readonly components: SessionComponent[];
            record(component: SessionComponent): void;
        };
        readonly authorize: (resource: import("../../request/access.ts").Resource, permit?: import("../../http/admission.ts").AdmissionYield) => Promise<import("../../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../../request/access.ts").Resource, denied: () => Error) => Promise<import("../../request/access.ts").AccessCommandAuthorization>;
    };
    schema: {};
    schemas: {};
    response: {};
    error: [];
}, "post", Path, import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    body: import("typebox").TAny;
    query: import("typebox").TObject<{
        target: import("typebox").TOptional<import("typebox").TString>;
    }>;
    response: {
        200: import("typebox").TObject<{
            subject: import("typebox").TOptional<import("typebox").TString>;
            account: import("typebox").TOptional<import("typebox").TString>;
            context: import("typebox").TOptional<import("typebox").TObject<{
                id: import("typebox").TString;
                population: import("typebox").TUnion<[import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"global">;
                }>, import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"realm">;
                    id: import("typebox").TString;
                    title: import("typebox").TString;
                }>]>;
            }>>;
            continuation: import("typebox").TOptional<import("typebox").TObject<{
                node: import("typebox").TString;
                cursor: import("typebox").TString;
            }>>;
            streams: import("typebox").TOptional<import("typebox").TObject<{
                selected: import("typebox").TOptional<import("typebox").TString>;
                entries: import("typebox").TArray<import("typebox").TObject<{
                    node: import("typebox").TString;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                }>>;
            }>>;
            profile: import("typebox").TString;
            template: import("typebox").TObject<{
                scope: import("typebox").TUnion<[import("typebox").TLiteral<"route">, import("typebox").TLiteral<"type">, import("typebox").TLiteral<"base">, import("typebox").TLiteral<"generic">]>;
                key: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>;
            document: import("typebox").TAny;
            views: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            catalogue: import("typebox").TOptional<import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"released">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                type: import("typebox").TString;
                digest: import("typebox").TOptional<import("typebox").TString>;
                definitions: import("typebox").TOptional<import("typebox").TObject<{
                    types: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                    properties: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                }>>;
                directions: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                    state: import("typebox").TLiteral<"admitted">;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                    inverse: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    sourceTypes: import("typebox").TArray<import("typebox").TString>;
                    targetTypes: import("typebox").TArray<import("typebox").TString>;
                    viaQualifier: import("typebox").TOptional<import("typebox").TString>;
                    release: import("typebox").TString;
                    qualifiers: import("typebox").TArray<import("typebox").TObject<{
                        id: import("typebox").TString;
                        datatype: import("typebox").TString;
                        labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                    }>>;
                }>, import("typebox").TObject<{
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                    release: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    reason: import("typebox").TUnion<[import("typebox").TLiteral<"missing-release-pin">, import("typebox").TLiteral<"stale-release">, import("typebox").TLiteral<"missing-property">, import("typebox").TLiteral<"missing-inverse">, import("typebox").TLiteral<"ambiguous-inverse">, import("typebox").TLiteral<"inapplicable-type">, import("typebox").TLiteral<"stale-descriptor">]>;
                }>]>>>;
            }>>;
            viewer: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                account: import("typebox").TOptional<import("typebox").TString>;
                context: import("typebox").TString;
                actions: import("typebox").TObject<{
                    statementPropose: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">]>;
                }>;
            }>, import("typebox").TObject<{
                kind: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                account: import("typebox").TOptional<import("typebox").TString>;
            }>]>>;
            reads: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                status: import("typebox").TInteger;
                body: import("typebox").TAny;
                headers: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
            }>>;
            meanings: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                text: import("typebox").TString;
                lang: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>>>;
            unavailable: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                admitted: import("typebox").TLiteral<false>;
            }>>>;
            actions: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TArray<import("typebox").TObject<{
                action: import("typebox").TString;
                operationId: import("typebox").TString;
                state: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"absent">, import("typebox").TLiteral<"withheld">]>;
            }>>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"ready">;
                viewerActions: import("typebox").TArray<import("typebox").TObject<{
                    action: import("typebox").TString;
                    operations: import("typebox").TArray<import("typebox").TString>;
                }>>;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"withheld">;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"unavailable">;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"denied">;
            }>]>>;
        }> & {
            headers: {
                readonly 'cache-control': import("typebox").TString;
            };
        };
        202: import("typebox").TObject<{
            preparing: import("typebox").TLiteral<true>;
        }> & {
            headers: {
                readonly 'retry-after': import("typebox").TString;
            };
        };
        308: import("typebox").TObject<{
            redirect: import("typebox").TObject<{
                from: import("typebox").TString;
                to: import("typebox").TString;
            }>;
        }> & {
            headers: {
                readonly location: import("typebox").TString;
            };
        };
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-exposure': string;
        'x-action': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}, {}, import("elysia/types").JoinPath<"", Path>>, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ body: envelope, request: callerRequest, authorize, admission, job, actor: caller, session: requestSession, set, }: {
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
            subject?: string;
            account?: string;
            context?: {
                id: string;
                population: {
                    kind: "global";
                } | {
                    kind: "realm";
                    id: string;
                    title: string;
                };
            };
            continuation?: {
                node: string;
                cursor: string;
            };
            streams?: {
                selected?: string;
                entries: {
                    node: string;
                    property: string;
                    direction: "forward" | "inverse";
                }[];
            };
            profile: string;
            template: {
                scope: "base" | "generic" | "route" | "type";
                key: string | null;
            };
            document: any;
            views?: string[];
            catalogue?: {
                state: "released" | "unavailable" | "unsupported";
                type: string;
                digest?: string;
                definitions?: {
                    types: Record<string, any>;
                    properties: Record<string, any>;
                };
                directions?: ({
                    state: "admitted";
                    property: string;
                    direction: "forward" | "inverse";
                    inverse: string | null;
                    sourceTypes: string[];
                    targetTypes: string[];
                    viaQualifier?: string;
                    release: string;
                    qualifiers: {
                        id: string;
                        datatype: string;
                        labels: Record<string, string>;
                    }[];
                } | {
                    state: "unavailable" | "unsupported";
                    property: string;
                    direction: "forward" | "inverse";
                    release: string | null;
                    reason: "ambiguous-inverse" | "inapplicable-type" | "missing-inverse" | "missing-property" | "missing-release-pin" | "stale-descriptor" | "stale-release";
                })[];
            };
            viewer?: {
                state: "account" | "anonymous";
                account?: string;
                context: string;
                actions: {
                    statementPropose: "allowed" | "denied" | "unavailable";
                };
            } | {
                kind: "account" | "anonymous";
                account?: string;
            };
            reads: Record<string, {
                status: number;
                body: any;
                headers?: Record<string, string>;
            }>;
            meanings?: Record<string, {
                text: string;
                lang: string | null;
            }>;
            unavailable?: {
                id: string;
                admitted: false;
            }[];
            actions?: {
                action: string;
                operationId: string;
                state: "absent" | "allowed" | "denied" | "unavailable" | "unsupported" | "withheld";
            }[] | {
                status: "ready";
                viewerActions: {
                    action: string;
                    operations: string[];
                }[];
            } | {
                status: "withheld";
            } | {
                status: "unavailable";
            } | {
                status: "denied";
            };
        };
        202: {
            preparing: true;
        };
        308: {
            redirect: {
                from: string;
                to: string;
            };
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
        200: {
            subject?: string;
            account?: string;
            context?: {
                id: string;
                population: {
                    kind: "global";
                } | {
                    kind: "realm";
                    id: string;
                    title: string;
                };
            };
            continuation?: {
                node: string;
                cursor: string;
            };
            streams?: {
                selected?: string;
                entries: {
                    node: string;
                    property: string;
                    direction: "forward" | "inverse";
                }[];
            };
            profile: string;
            template: {
                scope: "base" | "generic" | "route" | "type";
                key: string | null;
            };
            document: any;
            views?: string[];
            catalogue?: {
                state: "released" | "unavailable" | "unsupported";
                type: string;
                digest?: string;
                definitions?: {
                    types: Record<string, any>;
                    properties: Record<string, any>;
                };
                directions?: ({
                    state: "admitted";
                    property: string;
                    direction: "forward" | "inverse";
                    inverse: string | null;
                    sourceTypes: string[];
                    targetTypes: string[];
                    viaQualifier?: string;
                    release: string;
                    qualifiers: {
                        id: string;
                        datatype: string;
                        labels: Record<string, string>;
                    }[];
                } | {
                    state: "unavailable" | "unsupported";
                    property: string;
                    direction: "forward" | "inverse";
                    release: string | null;
                    reason: "ambiguous-inverse" | "inapplicable-type" | "missing-inverse" | "missing-property" | "missing-release-pin" | "stale-descriptor" | "stale-release";
                })[];
            };
            viewer?: {
                state: "account" | "anonymous";
                account?: string;
                context: string;
                actions: {
                    statementPropose: "allowed" | "denied" | "unavailable";
                };
            } | {
                kind: "account" | "anonymous";
                account?: string;
            };
            reads: Record<string, {
                status: number;
                body: any;
                headers?: Record<string, string>;
            }>;
            meanings?: Record<string, {
                text: string;
                lang: string | null;
            }>;
            unavailable?: {
                id: string;
                admitted: false;
            }[];
            actions?: {
                action: string;
                operationId: string;
                state: "absent" | "allowed" | "denied" | "unavailable" | "unsupported" | "withheld";
            }[] | {
                status: "ready";
                viewerActions: {
                    action: string;
                    operations: string[];
                }[];
            } | {
                status: "withheld";
            } | {
                status: "unavailable";
            } | {
                status: "denied";
            };
        };
        202: {
            preparing: true;
        };
        308: {
            redirect: {
                from: string;
                to: string;
            };
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
        body: import("typebox").TAny;
        query: import("typebox").TObject<{
            target: import("typebox").TOptional<import("typebox").TString>;
        }>;
        response: {
            200: import("typebox").TObject<{
                subject: import("typebox").TOptional<import("typebox").TString>;
                account: import("typebox").TOptional<import("typebox").TString>;
                context: import("typebox").TOptional<import("typebox").TObject<{
                    id: import("typebox").TString;
                    population: import("typebox").TUnion<[import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"global">;
                    }>, import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"realm">;
                        id: import("typebox").TString;
                        title: import("typebox").TString;
                    }>]>;
                }>>;
                continuation: import("typebox").TOptional<import("typebox").TObject<{
                    node: import("typebox").TString;
                    cursor: import("typebox").TString;
                }>>;
                streams: import("typebox").TOptional<import("typebox").TObject<{
                    selected: import("typebox").TOptional<import("typebox").TString>;
                    entries: import("typebox").TArray<import("typebox").TObject<{
                        node: import("typebox").TString;
                        property: import("typebox").TString;
                        direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                    }>>;
                }>>;
                profile: import("typebox").TString;
                template: import("typebox").TObject<{
                    scope: import("typebox").TUnion<[import("typebox").TLiteral<"route">, import("typebox").TLiteral<"type">, import("typebox").TLiteral<"base">, import("typebox").TLiteral<"generic">]>;
                    key: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>;
                document: import("typebox").TAny;
                views: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
                catalogue: import("typebox").TOptional<import("typebox").TObject<{
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"released">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                    type: import("typebox").TString;
                    digest: import("typebox").TOptional<import("typebox").TString>;
                    definitions: import("typebox").TOptional<import("typebox").TObject<{
                        types: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                        properties: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                    }>>;
                    directions: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                        state: import("typebox").TLiteral<"admitted">;
                        property: import("typebox").TString;
                        direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                        inverse: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        sourceTypes: import("typebox").TArray<import("typebox").TString>;
                        targetTypes: import("typebox").TArray<import("typebox").TString>;
                        viaQualifier: import("typebox").TOptional<import("typebox").TString>;
                        release: import("typebox").TString;
                        qualifiers: import("typebox").TArray<import("typebox").TObject<{
                            id: import("typebox").TString;
                            datatype: import("typebox").TString;
                            labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                        }>>;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TUnion<[import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                        property: import("typebox").TString;
                        direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                        release: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        reason: import("typebox").TUnion<[import("typebox").TLiteral<"missing-release-pin">, import("typebox").TLiteral<"stale-release">, import("typebox").TLiteral<"missing-property">, import("typebox").TLiteral<"missing-inverse">, import("typebox").TLiteral<"ambiguous-inverse">, import("typebox").TLiteral<"inapplicable-type">, import("typebox").TLiteral<"stale-descriptor">]>;
                    }>]>>>;
                }>>;
                viewer: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                    account: import("typebox").TOptional<import("typebox").TString>;
                    context: import("typebox").TString;
                    actions: import("typebox").TObject<{
                        statementPropose: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">]>;
                    }>;
                }>, import("typebox").TObject<{
                    kind: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                    account: import("typebox").TOptional<import("typebox").TString>;
                }>]>>;
                reads: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                    status: import("typebox").TInteger;
                    body: import("typebox").TAny;
                    headers: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
                }>>;
                meanings: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                    text: import("typebox").TString;
                    lang: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>>>;
                unavailable: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    id: import("typebox").TString;
                    admitted: import("typebox").TLiteral<false>;
                }>>>;
                actions: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TArray<import("typebox").TObject<{
                    action: import("typebox").TString;
                    operationId: import("typebox").TString;
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"absent">, import("typebox").TLiteral<"withheld">]>;
                }>>, import("typebox").TObject<{
                    status: import("typebox").TLiteral<"ready">;
                    viewerActions: import("typebox").TArray<import("typebox").TObject<{
                        action: import("typebox").TString;
                        operations: import("typebox").TArray<import("typebox").TString>;
                    }>>;
                }>, import("typebox").TObject<{
                    status: import("typebox").TLiteral<"withheld">;
                }>, import("typebox").TObject<{
                    status: import("typebox").TLiteral<"unavailable">;
                }>, import("typebox").TObject<{
                    status: import("typebox").TLiteral<"denied">;
                }>]>>;
            }> & {
                headers: {
                    readonly 'cache-control': import("typebox").TString;
                };
            };
            202: import("typebox").TObject<{
                preparing: import("typebox").TLiteral<true>;
            }> & {
                headers: {
                    readonly 'retry-after': import("typebox").TString;
                };
            };
            308: import("typebox").TObject<{
                redirect: import("typebox").TObject<{
                    from: import("typebox").TString;
                    to: import("typebox").TString;
                }>;
            }> & {
                headers: {
                    readonly location: import("typebox").TString;
                };
            };
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
        };
        detail: {
            operationId: string;
            'x-exposure': string;
            'x-action': string;
            security: ({
                bearerAuth: never[];
            } | {
                bearerAuth?: never;
            })[];
        };
    }, {}, import("elysia/types").JoinPath<"", Path>>, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("../../http/admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("../../request/access.ts").AccountActor | {
                kind: 'anonymous';
            };
            readonly session: {
                readonly components: SessionComponent[];
                record(component: SessionComponent): void;
            };
            readonly authorize: (resource: import("../../request/access.ts").Resource, permit?: import("../../http/admission.ts").AdmissionYield) => Promise<import("../../request/access.ts").AccessCheck>;
            readonly authorizeCommand: (resource: import("../../request/access.ts").Resource, denied: () => Error) => Promise<import("../../request/access.ts").AccessCommandAuthorization>;
        };
    }>>) => import("elysia/types").MaybePromise<void>;
    readonly path: string;
    route?: string;
    rid?: string;
    request: Request;
    store: {};
    body: unknown;
    query: {
        target?: string;
    };
    params: undefined extends import("elysia/types").IntersectIfObject<import("elysia/types").ResolvePath<import("elysia/types").JoinPath<"", Path>>, unknown> ? Record<string, string> : import("elysia/types").IntersectIfObject<import("elysia/types").ResolvePath<import("elysia/types").JoinPath<"", Path>>, unknown> extends infer T ? T extends import("elysia/types").IntersectIfObject<import("elysia/types").ResolvePath<import("elysia/types").JoinPath<"", Path>>, unknown> ? T extends object ? { [K in keyof T]: T[K]; } : T : never : never;
    headers: Record<string, string | undefined>;
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: import("../../http/admission.ts").Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: import("../../request/access.ts").AccountActor | {
        kind: 'anonymous';
    };
    readonly session: {
        readonly components: SessionComponent[];
        record(component: SessionComponent): void;
    };
    readonly authorize: (resource: import("../../request/access.ts").Resource, permit?: import("../../http/admission.ts").AdmissionYield) => Promise<import("../../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../../request/access.ts").Resource, denied: () => Error) => Promise<import("../../request/access.ts").AccessCommandAuthorization>;
}) => Promise<Response>, {
    body: import("typebox").TAny;
    query: import("typebox").TObject<{
        target: import("typebox").TOptional<import("typebox").TString>;
    }>;
    response: {
        200: import("typebox").TObject<{
            subject: import("typebox").TOptional<import("typebox").TString>;
            account: import("typebox").TOptional<import("typebox").TString>;
            context: import("typebox").TOptional<import("typebox").TObject<{
                id: import("typebox").TString;
                population: import("typebox").TUnion<[import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"global">;
                }>, import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"realm">;
                    id: import("typebox").TString;
                    title: import("typebox").TString;
                }>]>;
            }>>;
            continuation: import("typebox").TOptional<import("typebox").TObject<{
                node: import("typebox").TString;
                cursor: import("typebox").TString;
            }>>;
            streams: import("typebox").TOptional<import("typebox").TObject<{
                selected: import("typebox").TOptional<import("typebox").TString>;
                entries: import("typebox").TArray<import("typebox").TObject<{
                    node: import("typebox").TString;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                }>>;
            }>>;
            profile: import("typebox").TString;
            template: import("typebox").TObject<{
                scope: import("typebox").TUnion<[import("typebox").TLiteral<"route">, import("typebox").TLiteral<"type">, import("typebox").TLiteral<"base">, import("typebox").TLiteral<"generic">]>;
                key: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>;
            document: import("typebox").TAny;
            views: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            catalogue: import("typebox").TOptional<import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"released">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                type: import("typebox").TString;
                digest: import("typebox").TOptional<import("typebox").TString>;
                definitions: import("typebox").TOptional<import("typebox").TObject<{
                    types: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                    properties: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                }>>;
                directions: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                    state: import("typebox").TLiteral<"admitted">;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                    inverse: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    sourceTypes: import("typebox").TArray<import("typebox").TString>;
                    targetTypes: import("typebox").TArray<import("typebox").TString>;
                    viaQualifier: import("typebox").TOptional<import("typebox").TString>;
                    release: import("typebox").TString;
                    qualifiers: import("typebox").TArray<import("typebox").TObject<{
                        id: import("typebox").TString;
                        datatype: import("typebox").TString;
                        labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                    }>>;
                }>, import("typebox").TObject<{
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                    release: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    reason: import("typebox").TUnion<[import("typebox").TLiteral<"missing-release-pin">, import("typebox").TLiteral<"stale-release">, import("typebox").TLiteral<"missing-property">, import("typebox").TLiteral<"missing-inverse">, import("typebox").TLiteral<"ambiguous-inverse">, import("typebox").TLiteral<"inapplicable-type">, import("typebox").TLiteral<"stale-descriptor">]>;
                }>]>>>;
            }>>;
            viewer: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                account: import("typebox").TOptional<import("typebox").TString>;
                context: import("typebox").TString;
                actions: import("typebox").TObject<{
                    statementPropose: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">]>;
                }>;
            }>, import("typebox").TObject<{
                kind: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                account: import("typebox").TOptional<import("typebox").TString>;
            }>]>>;
            reads: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                status: import("typebox").TInteger;
                body: import("typebox").TAny;
                headers: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
            }>>;
            meanings: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                text: import("typebox").TString;
                lang: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>>>;
            unavailable: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                admitted: import("typebox").TLiteral<false>;
            }>>>;
            actions: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TArray<import("typebox").TObject<{
                action: import("typebox").TString;
                operationId: import("typebox").TString;
                state: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"absent">, import("typebox").TLiteral<"withheld">]>;
            }>>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"ready">;
                viewerActions: import("typebox").TArray<import("typebox").TObject<{
                    action: import("typebox").TString;
                    operations: import("typebox").TArray<import("typebox").TString>;
                }>>;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"withheld">;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"unavailable">;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"denied">;
            }>]>>;
        }> & {
            headers: {
                readonly 'cache-control': import("typebox").TString;
            };
        };
        202: import("typebox").TObject<{
            preparing: import("typebox").TLiteral<true>;
        }> & {
            headers: {
                readonly 'retry-after': import("typebox").TString;
            };
        };
        308: import("typebox").TObject<{
            redirect: import("typebox").TObject<{
                from: import("typebox").TString;
                to: import("typebox").TString;
            }>;
        }> & {
            headers: {
                readonly location: import("typebox").TString;
            };
        };
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-exposure': string;
        'x-action': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}> & App;
/** Two transports select a profile; both use the same native target resolver, planner and executor. */
export declare function pageRoutes<App>(app: App, dependencies: Parameters<typeof nativePageRoute>[1]): import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
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
        readonly admission: import("../../http/admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("../../request/access.ts").AccountActor | {
            kind: 'anonymous';
        };
        readonly session: {
            readonly components: SessionComponent[];
            record(component: SessionComponent): void;
        };
        readonly authorize: (resource: import("../../request/access.ts").Resource, permit?: import("../../http/admission.ts").AdmissionYield) => Promise<import("../../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../../request/access.ts").Resource, denied: () => Error) => Promise<import("../../request/access.ts").AccessCommandAuthorization>;
    };
    schema: {};
    schemas: {};
    response: {};
    error: [];
}, "post", "/v1/pages/$previewDraft", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    body: import("typebox").TAny;
    query: import("typebox").TObject<{
        target: import("typebox").TOptional<import("typebox").TString>;
    }>;
    response: {
        200: import("typebox").TObject<{
            subject: import("typebox").TOptional<import("typebox").TString>;
            account: import("typebox").TOptional<import("typebox").TString>;
            context: import("typebox").TOptional<import("typebox").TObject<{
                id: import("typebox").TString;
                population: import("typebox").TUnion<[import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"global">;
                }>, import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"realm">;
                    id: import("typebox").TString;
                    title: import("typebox").TString;
                }>]>;
            }>>;
            continuation: import("typebox").TOptional<import("typebox").TObject<{
                node: import("typebox").TString;
                cursor: import("typebox").TString;
            }>>;
            streams: import("typebox").TOptional<import("typebox").TObject<{
                selected: import("typebox").TOptional<import("typebox").TString>;
                entries: import("typebox").TArray<import("typebox").TObject<{
                    node: import("typebox").TString;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                }>>;
            }>>;
            profile: import("typebox").TString;
            template: import("typebox").TObject<{
                scope: import("typebox").TUnion<[import("typebox").TLiteral<"route">, import("typebox").TLiteral<"type">, import("typebox").TLiteral<"base">, import("typebox").TLiteral<"generic">]>;
                key: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>;
            document: import("typebox").TAny;
            views: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            catalogue: import("typebox").TOptional<import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"released">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                type: import("typebox").TString;
                digest: import("typebox").TOptional<import("typebox").TString>;
                definitions: import("typebox").TOptional<import("typebox").TObject<{
                    types: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                    properties: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                }>>;
                directions: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                    state: import("typebox").TLiteral<"admitted">;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                    inverse: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    sourceTypes: import("typebox").TArray<import("typebox").TString>;
                    targetTypes: import("typebox").TArray<import("typebox").TString>;
                    viaQualifier: import("typebox").TOptional<import("typebox").TString>;
                    release: import("typebox").TString;
                    qualifiers: import("typebox").TArray<import("typebox").TObject<{
                        id: import("typebox").TString;
                        datatype: import("typebox").TString;
                        labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                    }>>;
                }>, import("typebox").TObject<{
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                    release: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    reason: import("typebox").TUnion<[import("typebox").TLiteral<"missing-release-pin">, import("typebox").TLiteral<"stale-release">, import("typebox").TLiteral<"missing-property">, import("typebox").TLiteral<"missing-inverse">, import("typebox").TLiteral<"ambiguous-inverse">, import("typebox").TLiteral<"inapplicable-type">, import("typebox").TLiteral<"stale-descriptor">]>;
                }>]>>>;
            }>>;
            viewer: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                account: import("typebox").TOptional<import("typebox").TString>;
                context: import("typebox").TString;
                actions: import("typebox").TObject<{
                    statementPropose: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">]>;
                }>;
            }>, import("typebox").TObject<{
                kind: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                account: import("typebox").TOptional<import("typebox").TString>;
            }>]>>;
            reads: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                status: import("typebox").TInteger;
                body: import("typebox").TAny;
                headers: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
            }>>;
            meanings: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                text: import("typebox").TString;
                lang: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>>>;
            unavailable: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                admitted: import("typebox").TLiteral<false>;
            }>>>;
            actions: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TArray<import("typebox").TObject<{
                action: import("typebox").TString;
                operationId: import("typebox").TString;
                state: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"absent">, import("typebox").TLiteral<"withheld">]>;
            }>>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"ready">;
                viewerActions: import("typebox").TArray<import("typebox").TObject<{
                    action: import("typebox").TString;
                    operations: import("typebox").TArray<import("typebox").TString>;
                }>>;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"withheld">;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"unavailable">;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"denied">;
            }>]>>;
        }> & {
            headers: {
                readonly 'cache-control': import("typebox").TString;
            };
        };
        202: import("typebox").TObject<{
            preparing: import("typebox").TLiteral<true>;
        }> & {
            headers: {
                readonly 'retry-after': import("typebox").TString;
            };
        };
        308: import("typebox").TObject<{
            redirect: import("typebox").TObject<{
                from: import("typebox").TString;
                to: import("typebox").TString;
            }>;
        }> & {
            headers: {
                readonly location: import("typebox").TString;
            };
        };
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-exposure': string;
        'x-action': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}, {}, "/v1/pages/$previewDraft">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ body: envelope, request: callerRequest, authorize, admission, job, actor: caller, session: requestSession, set, }: {
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
            subject?: string;
            account?: string;
            context?: {
                id: string;
                population: {
                    kind: "global";
                } | {
                    kind: "realm";
                    id: string;
                    title: string;
                };
            };
            continuation?: {
                node: string;
                cursor: string;
            };
            streams?: {
                selected?: string;
                entries: {
                    node: string;
                    property: string;
                    direction: "forward" | "inverse";
                }[];
            };
            profile: string;
            template: {
                scope: "base" | "generic" | "route" | "type";
                key: string | null;
            };
            document: any;
            views?: string[];
            catalogue?: {
                state: "released" | "unavailable" | "unsupported";
                type: string;
                digest?: string;
                definitions?: {
                    types: Record<string, any>;
                    properties: Record<string, any>;
                };
                directions?: ({
                    state: "admitted";
                    property: string;
                    direction: "forward" | "inverse";
                    inverse: string | null;
                    sourceTypes: string[];
                    targetTypes: string[];
                    viaQualifier?: string;
                    release: string;
                    qualifiers: {
                        id: string;
                        datatype: string;
                        labels: Record<string, string>;
                    }[];
                } | {
                    state: "unavailable" | "unsupported";
                    property: string;
                    direction: "forward" | "inverse";
                    release: string | null;
                    reason: "ambiguous-inverse" | "inapplicable-type" | "missing-inverse" | "missing-property" | "missing-release-pin" | "stale-descriptor" | "stale-release";
                })[];
            };
            viewer?: {
                state: "account" | "anonymous";
                account?: string;
                context: string;
                actions: {
                    statementPropose: "allowed" | "denied" | "unavailable";
                };
            } | {
                kind: "account" | "anonymous";
                account?: string;
            };
            reads: Record<string, {
                status: number;
                body: any;
                headers?: Record<string, string>;
            }>;
            meanings?: Record<string, {
                text: string;
                lang: string | null;
            }>;
            unavailable?: {
                id: string;
                admitted: false;
            }[];
            actions?: {
                action: string;
                operationId: string;
                state: "absent" | "allowed" | "denied" | "unavailable" | "unsupported" | "withheld";
            }[] | {
                status: "ready";
                viewerActions: {
                    action: string;
                    operations: string[];
                }[];
            } | {
                status: "withheld";
            } | {
                status: "unavailable";
            } | {
                status: "denied";
            };
        };
        202: {
            preparing: true;
        };
        308: {
            redirect: {
                from: string;
                to: string;
            };
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
        200: {
            subject?: string;
            account?: string;
            context?: {
                id: string;
                population: {
                    kind: "global";
                } | {
                    kind: "realm";
                    id: string;
                    title: string;
                };
            };
            continuation?: {
                node: string;
                cursor: string;
            };
            streams?: {
                selected?: string;
                entries: {
                    node: string;
                    property: string;
                    direction: "forward" | "inverse";
                }[];
            };
            profile: string;
            template: {
                scope: "base" | "generic" | "route" | "type";
                key: string | null;
            };
            document: any;
            views?: string[];
            catalogue?: {
                state: "released" | "unavailable" | "unsupported";
                type: string;
                digest?: string;
                definitions?: {
                    types: Record<string, any>;
                    properties: Record<string, any>;
                };
                directions?: ({
                    state: "admitted";
                    property: string;
                    direction: "forward" | "inverse";
                    inverse: string | null;
                    sourceTypes: string[];
                    targetTypes: string[];
                    viaQualifier?: string;
                    release: string;
                    qualifiers: {
                        id: string;
                        datatype: string;
                        labels: Record<string, string>;
                    }[];
                } | {
                    state: "unavailable" | "unsupported";
                    property: string;
                    direction: "forward" | "inverse";
                    release: string | null;
                    reason: "ambiguous-inverse" | "inapplicable-type" | "missing-inverse" | "missing-property" | "missing-release-pin" | "stale-descriptor" | "stale-release";
                })[];
            };
            viewer?: {
                state: "account" | "anonymous";
                account?: string;
                context: string;
                actions: {
                    statementPropose: "allowed" | "denied" | "unavailable";
                };
            } | {
                kind: "account" | "anonymous";
                account?: string;
            };
            reads: Record<string, {
                status: number;
                body: any;
                headers?: Record<string, string>;
            }>;
            meanings?: Record<string, {
                text: string;
                lang: string | null;
            }>;
            unavailable?: {
                id: string;
                admitted: false;
            }[];
            actions?: {
                action: string;
                operationId: string;
                state: "absent" | "allowed" | "denied" | "unavailable" | "unsupported" | "withheld";
            }[] | {
                status: "ready";
                viewerActions: {
                    action: string;
                    operations: string[];
                }[];
            } | {
                status: "withheld";
            } | {
                status: "unavailable";
            } | {
                status: "denied";
            };
        };
        202: {
            preparing: true;
        };
        308: {
            redirect: {
                from: string;
                to: string;
            };
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
        body: import("typebox").TAny;
        query: import("typebox").TObject<{
            target: import("typebox").TOptional<import("typebox").TString>;
        }>;
        response: {
            200: import("typebox").TObject<{
                subject: import("typebox").TOptional<import("typebox").TString>;
                account: import("typebox").TOptional<import("typebox").TString>;
                context: import("typebox").TOptional<import("typebox").TObject<{
                    id: import("typebox").TString;
                    population: import("typebox").TUnion<[import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"global">;
                    }>, import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"realm">;
                        id: import("typebox").TString;
                        title: import("typebox").TString;
                    }>]>;
                }>>;
                continuation: import("typebox").TOptional<import("typebox").TObject<{
                    node: import("typebox").TString;
                    cursor: import("typebox").TString;
                }>>;
                streams: import("typebox").TOptional<import("typebox").TObject<{
                    selected: import("typebox").TOptional<import("typebox").TString>;
                    entries: import("typebox").TArray<import("typebox").TObject<{
                        node: import("typebox").TString;
                        property: import("typebox").TString;
                        direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                    }>>;
                }>>;
                profile: import("typebox").TString;
                template: import("typebox").TObject<{
                    scope: import("typebox").TUnion<[import("typebox").TLiteral<"route">, import("typebox").TLiteral<"type">, import("typebox").TLiteral<"base">, import("typebox").TLiteral<"generic">]>;
                    key: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>;
                document: import("typebox").TAny;
                views: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
                catalogue: import("typebox").TOptional<import("typebox").TObject<{
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"released">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                    type: import("typebox").TString;
                    digest: import("typebox").TOptional<import("typebox").TString>;
                    definitions: import("typebox").TOptional<import("typebox").TObject<{
                        types: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                        properties: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                    }>>;
                    directions: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                        state: import("typebox").TLiteral<"admitted">;
                        property: import("typebox").TString;
                        direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                        inverse: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        sourceTypes: import("typebox").TArray<import("typebox").TString>;
                        targetTypes: import("typebox").TArray<import("typebox").TString>;
                        viaQualifier: import("typebox").TOptional<import("typebox").TString>;
                        release: import("typebox").TString;
                        qualifiers: import("typebox").TArray<import("typebox").TObject<{
                            id: import("typebox").TString;
                            datatype: import("typebox").TString;
                            labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                        }>>;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TUnion<[import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                        property: import("typebox").TString;
                        direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                        release: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        reason: import("typebox").TUnion<[import("typebox").TLiteral<"missing-release-pin">, import("typebox").TLiteral<"stale-release">, import("typebox").TLiteral<"missing-property">, import("typebox").TLiteral<"missing-inverse">, import("typebox").TLiteral<"ambiguous-inverse">, import("typebox").TLiteral<"inapplicable-type">, import("typebox").TLiteral<"stale-descriptor">]>;
                    }>]>>>;
                }>>;
                viewer: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                    account: import("typebox").TOptional<import("typebox").TString>;
                    context: import("typebox").TString;
                    actions: import("typebox").TObject<{
                        statementPropose: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">]>;
                    }>;
                }>, import("typebox").TObject<{
                    kind: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                    account: import("typebox").TOptional<import("typebox").TString>;
                }>]>>;
                reads: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                    status: import("typebox").TInteger;
                    body: import("typebox").TAny;
                    headers: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
                }>>;
                meanings: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                    text: import("typebox").TString;
                    lang: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>>>;
                unavailable: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    id: import("typebox").TString;
                    admitted: import("typebox").TLiteral<false>;
                }>>>;
                actions: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TArray<import("typebox").TObject<{
                    action: import("typebox").TString;
                    operationId: import("typebox").TString;
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"absent">, import("typebox").TLiteral<"withheld">]>;
                }>>, import("typebox").TObject<{
                    status: import("typebox").TLiteral<"ready">;
                    viewerActions: import("typebox").TArray<import("typebox").TObject<{
                        action: import("typebox").TString;
                        operations: import("typebox").TArray<import("typebox").TString>;
                    }>>;
                }>, import("typebox").TObject<{
                    status: import("typebox").TLiteral<"withheld">;
                }>, import("typebox").TObject<{
                    status: import("typebox").TLiteral<"unavailable">;
                }>, import("typebox").TObject<{
                    status: import("typebox").TLiteral<"denied">;
                }>]>>;
            }> & {
                headers: {
                    readonly 'cache-control': import("typebox").TString;
                };
            };
            202: import("typebox").TObject<{
                preparing: import("typebox").TLiteral<true>;
            }> & {
                headers: {
                    readonly 'retry-after': import("typebox").TString;
                };
            };
            308: import("typebox").TObject<{
                redirect: import("typebox").TObject<{
                    from: import("typebox").TString;
                    to: import("typebox").TString;
                }>;
            }> & {
                headers: {
                    readonly location: import("typebox").TString;
                };
            };
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
        };
        detail: {
            operationId: string;
            'x-exposure': string;
            'x-action': string;
            security: ({
                bearerAuth: never[];
            } | {
                bearerAuth?: never;
            })[];
        };
    }, {}, "/v1/pages/$previewDraft">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("../../http/admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("../../request/access.ts").AccountActor | {
                kind: 'anonymous';
            };
            readonly session: {
                readonly components: SessionComponent[];
                record(component: SessionComponent): void;
            };
            readonly authorize: (resource: import("../../request/access.ts").Resource, permit?: import("../../http/admission.ts").AdmissionYield) => Promise<import("../../request/access.ts").AccessCheck>;
            readonly authorizeCommand: (resource: import("../../request/access.ts").Resource, denied: () => Error) => Promise<import("../../request/access.ts").AccessCommandAuthorization>;
        };
    }>>) => import("elysia/types").MaybePromise<void>;
    readonly path: string;
    route?: string;
    rid?: string;
    request: Request;
    store: {};
    body: unknown;
    query: {
        target?: string;
    };
    params: {};
    headers: Record<string, string | undefined>;
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: import("../../http/admission.ts").Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: import("../../request/access.ts").AccountActor | {
        kind: 'anonymous';
    };
    readonly session: {
        readonly components: SessionComponent[];
        record(component: SessionComponent): void;
    };
    readonly authorize: (resource: import("../../request/access.ts").Resource, permit?: import("../../http/admission.ts").AdmissionYield) => Promise<import("../../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../../request/access.ts").Resource, denied: () => Error) => Promise<import("../../request/access.ts").AccessCommandAuthorization>;
}) => Promise<Response>, {
    body: import("typebox").TAny;
    query: import("typebox").TObject<{
        target: import("typebox").TOptional<import("typebox").TString>;
    }>;
    response: {
        200: import("typebox").TObject<{
            subject: import("typebox").TOptional<import("typebox").TString>;
            account: import("typebox").TOptional<import("typebox").TString>;
            context: import("typebox").TOptional<import("typebox").TObject<{
                id: import("typebox").TString;
                population: import("typebox").TUnion<[import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"global">;
                }>, import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"realm">;
                    id: import("typebox").TString;
                    title: import("typebox").TString;
                }>]>;
            }>>;
            continuation: import("typebox").TOptional<import("typebox").TObject<{
                node: import("typebox").TString;
                cursor: import("typebox").TString;
            }>>;
            streams: import("typebox").TOptional<import("typebox").TObject<{
                selected: import("typebox").TOptional<import("typebox").TString>;
                entries: import("typebox").TArray<import("typebox").TObject<{
                    node: import("typebox").TString;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                }>>;
            }>>;
            profile: import("typebox").TString;
            template: import("typebox").TObject<{
                scope: import("typebox").TUnion<[import("typebox").TLiteral<"route">, import("typebox").TLiteral<"type">, import("typebox").TLiteral<"base">, import("typebox").TLiteral<"generic">]>;
                key: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>;
            document: import("typebox").TAny;
            views: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            catalogue: import("typebox").TOptional<import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"released">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                type: import("typebox").TString;
                digest: import("typebox").TOptional<import("typebox").TString>;
                definitions: import("typebox").TOptional<import("typebox").TObject<{
                    types: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                    properties: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                }>>;
                directions: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                    state: import("typebox").TLiteral<"admitted">;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                    inverse: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    sourceTypes: import("typebox").TArray<import("typebox").TString>;
                    targetTypes: import("typebox").TArray<import("typebox").TString>;
                    viaQualifier: import("typebox").TOptional<import("typebox").TString>;
                    release: import("typebox").TString;
                    qualifiers: import("typebox").TArray<import("typebox").TObject<{
                        id: import("typebox").TString;
                        datatype: import("typebox").TString;
                        labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                    }>>;
                }>, import("typebox").TObject<{
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                    release: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    reason: import("typebox").TUnion<[import("typebox").TLiteral<"missing-release-pin">, import("typebox").TLiteral<"stale-release">, import("typebox").TLiteral<"missing-property">, import("typebox").TLiteral<"missing-inverse">, import("typebox").TLiteral<"ambiguous-inverse">, import("typebox").TLiteral<"inapplicable-type">, import("typebox").TLiteral<"stale-descriptor">]>;
                }>]>>>;
            }>>;
            viewer: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                account: import("typebox").TOptional<import("typebox").TString>;
                context: import("typebox").TString;
                actions: import("typebox").TObject<{
                    statementPropose: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">]>;
                }>;
            }>, import("typebox").TObject<{
                kind: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                account: import("typebox").TOptional<import("typebox").TString>;
            }>]>>;
            reads: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                status: import("typebox").TInteger;
                body: import("typebox").TAny;
                headers: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
            }>>;
            meanings: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                text: import("typebox").TString;
                lang: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>>>;
            unavailable: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                admitted: import("typebox").TLiteral<false>;
            }>>>;
            actions: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TArray<import("typebox").TObject<{
                action: import("typebox").TString;
                operationId: import("typebox").TString;
                state: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"absent">, import("typebox").TLiteral<"withheld">]>;
            }>>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"ready">;
                viewerActions: import("typebox").TArray<import("typebox").TObject<{
                    action: import("typebox").TString;
                    operations: import("typebox").TArray<import("typebox").TString>;
                }>>;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"withheld">;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"unavailable">;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"denied">;
            }>]>>;
        }> & {
            headers: {
                readonly 'cache-control': import("typebox").TString;
            };
        };
        202: import("typebox").TObject<{
            preparing: import("typebox").TLiteral<true>;
        }> & {
            headers: {
                readonly 'retry-after': import("typebox").TString;
            };
        };
        308: import("typebox").TObject<{
            redirect: import("typebox").TObject<{
                from: import("typebox").TString;
                to: import("typebox").TString;
            }>;
        }> & {
            headers: {
                readonly location: import("typebox").TString;
            };
        };
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-exposure': string;
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
}, import("elysia").DefaultEphemeral, {
    derive: {
        readonly admission: import("../../http/admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("../../request/access.ts").AccountActor | {
            kind: 'anonymous';
        };
        readonly session: {
            readonly components: SessionComponent[];
            record(component: SessionComponent): void;
        };
        readonly authorize: (resource: import("../../request/access.ts").Resource, permit?: import("../../http/admission.ts").AdmissionYield) => Promise<import("../../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../../request/access.ts").Resource, denied: () => Error) => Promise<import("../../request/access.ts").AccessCommandAuthorization>;
    };
    schema: {};
    schemas: {};
    response: {};
    error: [];
}, "post", "/v1/pages/$read", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    body: import("typebox").TAny;
    query: import("typebox").TObject<{
        target: import("typebox").TOptional<import("typebox").TString>;
    }>;
    response: {
        200: import("typebox").TObject<{
            subject: import("typebox").TOptional<import("typebox").TString>;
            account: import("typebox").TOptional<import("typebox").TString>;
            context: import("typebox").TOptional<import("typebox").TObject<{
                id: import("typebox").TString;
                population: import("typebox").TUnion<[import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"global">;
                }>, import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"realm">;
                    id: import("typebox").TString;
                    title: import("typebox").TString;
                }>]>;
            }>>;
            continuation: import("typebox").TOptional<import("typebox").TObject<{
                node: import("typebox").TString;
                cursor: import("typebox").TString;
            }>>;
            streams: import("typebox").TOptional<import("typebox").TObject<{
                selected: import("typebox").TOptional<import("typebox").TString>;
                entries: import("typebox").TArray<import("typebox").TObject<{
                    node: import("typebox").TString;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                }>>;
            }>>;
            profile: import("typebox").TString;
            template: import("typebox").TObject<{
                scope: import("typebox").TUnion<[import("typebox").TLiteral<"route">, import("typebox").TLiteral<"type">, import("typebox").TLiteral<"base">, import("typebox").TLiteral<"generic">]>;
                key: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>;
            document: import("typebox").TAny;
            views: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            catalogue: import("typebox").TOptional<import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"released">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                type: import("typebox").TString;
                digest: import("typebox").TOptional<import("typebox").TString>;
                definitions: import("typebox").TOptional<import("typebox").TObject<{
                    types: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                    properties: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                }>>;
                directions: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                    state: import("typebox").TLiteral<"admitted">;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                    inverse: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    sourceTypes: import("typebox").TArray<import("typebox").TString>;
                    targetTypes: import("typebox").TArray<import("typebox").TString>;
                    viaQualifier: import("typebox").TOptional<import("typebox").TString>;
                    release: import("typebox").TString;
                    qualifiers: import("typebox").TArray<import("typebox").TObject<{
                        id: import("typebox").TString;
                        datatype: import("typebox").TString;
                        labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                    }>>;
                }>, import("typebox").TObject<{
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                    release: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    reason: import("typebox").TUnion<[import("typebox").TLiteral<"missing-release-pin">, import("typebox").TLiteral<"stale-release">, import("typebox").TLiteral<"missing-property">, import("typebox").TLiteral<"missing-inverse">, import("typebox").TLiteral<"ambiguous-inverse">, import("typebox").TLiteral<"inapplicable-type">, import("typebox").TLiteral<"stale-descriptor">]>;
                }>]>>>;
            }>>;
            viewer: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                account: import("typebox").TOptional<import("typebox").TString>;
                context: import("typebox").TString;
                actions: import("typebox").TObject<{
                    statementPropose: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">]>;
                }>;
            }>, import("typebox").TObject<{
                kind: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                account: import("typebox").TOptional<import("typebox").TString>;
            }>]>>;
            reads: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                status: import("typebox").TInteger;
                body: import("typebox").TAny;
                headers: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
            }>>;
            meanings: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                text: import("typebox").TString;
                lang: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>>>;
            unavailable: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                admitted: import("typebox").TLiteral<false>;
            }>>>;
            actions: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TArray<import("typebox").TObject<{
                action: import("typebox").TString;
                operationId: import("typebox").TString;
                state: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"absent">, import("typebox").TLiteral<"withheld">]>;
            }>>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"ready">;
                viewerActions: import("typebox").TArray<import("typebox").TObject<{
                    action: import("typebox").TString;
                    operations: import("typebox").TArray<import("typebox").TString>;
                }>>;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"withheld">;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"unavailable">;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"denied">;
            }>]>>;
        }> & {
            headers: {
                readonly 'cache-control': import("typebox").TString;
            };
        };
        202: import("typebox").TObject<{
            preparing: import("typebox").TLiteral<true>;
        }> & {
            headers: {
                readonly 'retry-after': import("typebox").TString;
            };
        };
        308: import("typebox").TObject<{
            redirect: import("typebox").TObject<{
                from: import("typebox").TString;
                to: import("typebox").TString;
            }>;
        }> & {
            headers: {
                readonly location: import("typebox").TString;
            };
        };
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-exposure': string;
        'x-action': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}, {}, "/v1/pages/$read">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ body: envelope, request: callerRequest, authorize, admission, job, actor: caller, session: requestSession, set, }: {
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
            subject?: string;
            account?: string;
            context?: {
                id: string;
                population: {
                    kind: "global";
                } | {
                    kind: "realm";
                    id: string;
                    title: string;
                };
            };
            continuation?: {
                node: string;
                cursor: string;
            };
            streams?: {
                selected?: string;
                entries: {
                    node: string;
                    property: string;
                    direction: "forward" | "inverse";
                }[];
            };
            profile: string;
            template: {
                scope: "base" | "generic" | "route" | "type";
                key: string | null;
            };
            document: any;
            views?: string[];
            catalogue?: {
                state: "released" | "unavailable" | "unsupported";
                type: string;
                digest?: string;
                definitions?: {
                    types: Record<string, any>;
                    properties: Record<string, any>;
                };
                directions?: ({
                    state: "admitted";
                    property: string;
                    direction: "forward" | "inverse";
                    inverse: string | null;
                    sourceTypes: string[];
                    targetTypes: string[];
                    viaQualifier?: string;
                    release: string;
                    qualifiers: {
                        id: string;
                        datatype: string;
                        labels: Record<string, string>;
                    }[];
                } | {
                    state: "unavailable" | "unsupported";
                    property: string;
                    direction: "forward" | "inverse";
                    release: string | null;
                    reason: "ambiguous-inverse" | "inapplicable-type" | "missing-inverse" | "missing-property" | "missing-release-pin" | "stale-descriptor" | "stale-release";
                })[];
            };
            viewer?: {
                state: "account" | "anonymous";
                account?: string;
                context: string;
                actions: {
                    statementPropose: "allowed" | "denied" | "unavailable";
                };
            } | {
                kind: "account" | "anonymous";
                account?: string;
            };
            reads: Record<string, {
                status: number;
                body: any;
                headers?: Record<string, string>;
            }>;
            meanings?: Record<string, {
                text: string;
                lang: string | null;
            }>;
            unavailable?: {
                id: string;
                admitted: false;
            }[];
            actions?: {
                action: string;
                operationId: string;
                state: "absent" | "allowed" | "denied" | "unavailable" | "unsupported" | "withheld";
            }[] | {
                status: "ready";
                viewerActions: {
                    action: string;
                    operations: string[];
                }[];
            } | {
                status: "withheld";
            } | {
                status: "unavailable";
            } | {
                status: "denied";
            };
        };
        202: {
            preparing: true;
        };
        308: {
            redirect: {
                from: string;
                to: string;
            };
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
        200: {
            subject?: string;
            account?: string;
            context?: {
                id: string;
                population: {
                    kind: "global";
                } | {
                    kind: "realm";
                    id: string;
                    title: string;
                };
            };
            continuation?: {
                node: string;
                cursor: string;
            };
            streams?: {
                selected?: string;
                entries: {
                    node: string;
                    property: string;
                    direction: "forward" | "inverse";
                }[];
            };
            profile: string;
            template: {
                scope: "base" | "generic" | "route" | "type";
                key: string | null;
            };
            document: any;
            views?: string[];
            catalogue?: {
                state: "released" | "unavailable" | "unsupported";
                type: string;
                digest?: string;
                definitions?: {
                    types: Record<string, any>;
                    properties: Record<string, any>;
                };
                directions?: ({
                    state: "admitted";
                    property: string;
                    direction: "forward" | "inverse";
                    inverse: string | null;
                    sourceTypes: string[];
                    targetTypes: string[];
                    viaQualifier?: string;
                    release: string;
                    qualifiers: {
                        id: string;
                        datatype: string;
                        labels: Record<string, string>;
                    }[];
                } | {
                    state: "unavailable" | "unsupported";
                    property: string;
                    direction: "forward" | "inverse";
                    release: string | null;
                    reason: "ambiguous-inverse" | "inapplicable-type" | "missing-inverse" | "missing-property" | "missing-release-pin" | "stale-descriptor" | "stale-release";
                })[];
            };
            viewer?: {
                state: "account" | "anonymous";
                account?: string;
                context: string;
                actions: {
                    statementPropose: "allowed" | "denied" | "unavailable";
                };
            } | {
                kind: "account" | "anonymous";
                account?: string;
            };
            reads: Record<string, {
                status: number;
                body: any;
                headers?: Record<string, string>;
            }>;
            meanings?: Record<string, {
                text: string;
                lang: string | null;
            }>;
            unavailable?: {
                id: string;
                admitted: false;
            }[];
            actions?: {
                action: string;
                operationId: string;
                state: "absent" | "allowed" | "denied" | "unavailable" | "unsupported" | "withheld";
            }[] | {
                status: "ready";
                viewerActions: {
                    action: string;
                    operations: string[];
                }[];
            } | {
                status: "withheld";
            } | {
                status: "unavailable";
            } | {
                status: "denied";
            };
        };
        202: {
            preparing: true;
        };
        308: {
            redirect: {
                from: string;
                to: string;
            };
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
        body: import("typebox").TAny;
        query: import("typebox").TObject<{
            target: import("typebox").TOptional<import("typebox").TString>;
        }>;
        response: {
            200: import("typebox").TObject<{
                subject: import("typebox").TOptional<import("typebox").TString>;
                account: import("typebox").TOptional<import("typebox").TString>;
                context: import("typebox").TOptional<import("typebox").TObject<{
                    id: import("typebox").TString;
                    population: import("typebox").TUnion<[import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"global">;
                    }>, import("typebox").TObject<{
                        kind: import("typebox").TLiteral<"realm">;
                        id: import("typebox").TString;
                        title: import("typebox").TString;
                    }>]>;
                }>>;
                continuation: import("typebox").TOptional<import("typebox").TObject<{
                    node: import("typebox").TString;
                    cursor: import("typebox").TString;
                }>>;
                streams: import("typebox").TOptional<import("typebox").TObject<{
                    selected: import("typebox").TOptional<import("typebox").TString>;
                    entries: import("typebox").TArray<import("typebox").TObject<{
                        node: import("typebox").TString;
                        property: import("typebox").TString;
                        direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                    }>>;
                }>>;
                profile: import("typebox").TString;
                template: import("typebox").TObject<{
                    scope: import("typebox").TUnion<[import("typebox").TLiteral<"route">, import("typebox").TLiteral<"type">, import("typebox").TLiteral<"base">, import("typebox").TLiteral<"generic">]>;
                    key: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>;
                document: import("typebox").TAny;
                views: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
                catalogue: import("typebox").TOptional<import("typebox").TObject<{
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"released">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                    type: import("typebox").TString;
                    digest: import("typebox").TOptional<import("typebox").TString>;
                    definitions: import("typebox").TOptional<import("typebox").TObject<{
                        types: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                        properties: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                    }>>;
                    directions: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                        state: import("typebox").TLiteral<"admitted">;
                        property: import("typebox").TString;
                        direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                        inverse: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        sourceTypes: import("typebox").TArray<import("typebox").TString>;
                        targetTypes: import("typebox").TArray<import("typebox").TString>;
                        viaQualifier: import("typebox").TOptional<import("typebox").TString>;
                        release: import("typebox").TString;
                        qualifiers: import("typebox").TArray<import("typebox").TObject<{
                            id: import("typebox").TString;
                            datatype: import("typebox").TString;
                            labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                        }>>;
                    }>, import("typebox").TObject<{
                        state: import("typebox").TUnion<[import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                        property: import("typebox").TString;
                        direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                        release: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                        reason: import("typebox").TUnion<[import("typebox").TLiteral<"missing-release-pin">, import("typebox").TLiteral<"stale-release">, import("typebox").TLiteral<"missing-property">, import("typebox").TLiteral<"missing-inverse">, import("typebox").TLiteral<"ambiguous-inverse">, import("typebox").TLiteral<"inapplicable-type">, import("typebox").TLiteral<"stale-descriptor">]>;
                    }>]>>>;
                }>>;
                viewer: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                    account: import("typebox").TOptional<import("typebox").TString>;
                    context: import("typebox").TString;
                    actions: import("typebox").TObject<{
                        statementPropose: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">]>;
                    }>;
                }>, import("typebox").TObject<{
                    kind: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                    account: import("typebox").TOptional<import("typebox").TString>;
                }>]>>;
                reads: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                    status: import("typebox").TInteger;
                    body: import("typebox").TAny;
                    headers: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
                }>>;
                meanings: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                    text: import("typebox").TString;
                    lang: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                }>>>;
                unavailable: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    id: import("typebox").TString;
                    admitted: import("typebox").TLiteral<false>;
                }>>>;
                actions: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TArray<import("typebox").TObject<{
                    action: import("typebox").TString;
                    operationId: import("typebox").TString;
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"absent">, import("typebox").TLiteral<"withheld">]>;
                }>>, import("typebox").TObject<{
                    status: import("typebox").TLiteral<"ready">;
                    viewerActions: import("typebox").TArray<import("typebox").TObject<{
                        action: import("typebox").TString;
                        operations: import("typebox").TArray<import("typebox").TString>;
                    }>>;
                }>, import("typebox").TObject<{
                    status: import("typebox").TLiteral<"withheld">;
                }>, import("typebox").TObject<{
                    status: import("typebox").TLiteral<"unavailable">;
                }>, import("typebox").TObject<{
                    status: import("typebox").TLiteral<"denied">;
                }>]>>;
            }> & {
                headers: {
                    readonly 'cache-control': import("typebox").TString;
                };
            };
            202: import("typebox").TObject<{
                preparing: import("typebox").TLiteral<true>;
            }> & {
                headers: {
                    readonly 'retry-after': import("typebox").TString;
                };
            };
            308: import("typebox").TObject<{
                redirect: import("typebox").TObject<{
                    from: import("typebox").TString;
                    to: import("typebox").TString;
                }>;
            }> & {
                headers: {
                    readonly location: import("typebox").TString;
                };
            };
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                    code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
                }>>>;
            }>;
        };
        detail: {
            operationId: string;
            'x-exposure': string;
            'x-action': string;
            security: ({
                bearerAuth: never[];
            } | {
                bearerAuth?: never;
            })[];
        };
    }, {}, "/v1/pages/$read">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("../../http/admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("../../request/access.ts").AccountActor | {
                kind: 'anonymous';
            };
            readonly session: {
                readonly components: SessionComponent[];
                record(component: SessionComponent): void;
            };
            readonly authorize: (resource: import("../../request/access.ts").Resource, permit?: import("../../http/admission.ts").AdmissionYield) => Promise<import("../../request/access.ts").AccessCheck>;
            readonly authorizeCommand: (resource: import("../../request/access.ts").Resource, denied: () => Error) => Promise<import("../../request/access.ts").AccessCommandAuthorization>;
        };
    }>>) => import("elysia/types").MaybePromise<void>;
    readonly path: string;
    route?: string;
    rid?: string;
    request: Request;
    store: {};
    body: unknown;
    query: {
        target?: string;
    };
    params: {};
    headers: Record<string, string | undefined>;
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: import("../../http/admission.ts").Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: import("../../request/access.ts").AccountActor | {
        kind: 'anonymous';
    };
    readonly session: {
        readonly components: SessionComponent[];
        record(component: SessionComponent): void;
    };
    readonly authorize: (resource: import("../../request/access.ts").Resource, permit?: import("../../http/admission.ts").AdmissionYield) => Promise<import("../../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../../request/access.ts").Resource, denied: () => Error) => Promise<import("../../request/access.ts").AccessCommandAuthorization>;
}) => Promise<Response>, {
    body: import("typebox").TAny;
    query: import("typebox").TObject<{
        target: import("typebox").TOptional<import("typebox").TString>;
    }>;
    response: {
        200: import("typebox").TObject<{
            subject: import("typebox").TOptional<import("typebox").TString>;
            account: import("typebox").TOptional<import("typebox").TString>;
            context: import("typebox").TOptional<import("typebox").TObject<{
                id: import("typebox").TString;
                population: import("typebox").TUnion<[import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"global">;
                }>, import("typebox").TObject<{
                    kind: import("typebox").TLiteral<"realm">;
                    id: import("typebox").TString;
                    title: import("typebox").TString;
                }>]>;
            }>>;
            continuation: import("typebox").TOptional<import("typebox").TObject<{
                node: import("typebox").TString;
                cursor: import("typebox").TString;
            }>>;
            streams: import("typebox").TOptional<import("typebox").TObject<{
                selected: import("typebox").TOptional<import("typebox").TString>;
                entries: import("typebox").TArray<import("typebox").TObject<{
                    node: import("typebox").TString;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                }>>;
            }>>;
            profile: import("typebox").TString;
            template: import("typebox").TObject<{
                scope: import("typebox").TUnion<[import("typebox").TLiteral<"route">, import("typebox").TLiteral<"type">, import("typebox").TLiteral<"base">, import("typebox").TLiteral<"generic">]>;
                key: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>;
            document: import("typebox").TAny;
            views: import("typebox").TOptional<import("typebox").TArray<import("typebox").TString>>;
            catalogue: import("typebox").TOptional<import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"released">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                type: import("typebox").TString;
                digest: import("typebox").TOptional<import("typebox").TString>;
                definitions: import("typebox").TOptional<import("typebox").TObject<{
                    types: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                    properties: import("typebox").TRecord<"^.*$", import("typebox").TAny>;
                }>>;
                directions: import("typebox").TOptional<import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                    state: import("typebox").TLiteral<"admitted">;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                    inverse: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    sourceTypes: import("typebox").TArray<import("typebox").TString>;
                    targetTypes: import("typebox").TArray<import("typebox").TString>;
                    viaQualifier: import("typebox").TOptional<import("typebox").TString>;
                    release: import("typebox").TString;
                    qualifiers: import("typebox").TArray<import("typebox").TObject<{
                        id: import("typebox").TString;
                        datatype: import("typebox").TString;
                        labels: import("typebox").TRecord<"^.*$", import("typebox").TString>;
                    }>>;
                }>, import("typebox").TObject<{
                    state: import("typebox").TUnion<[import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"unavailable">]>;
                    property: import("typebox").TString;
                    direction: import("typebox").TUnion<[import("typebox").TLiteral<"forward">, import("typebox").TLiteral<"inverse">]>;
                    release: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
                    reason: import("typebox").TUnion<[import("typebox").TLiteral<"missing-release-pin">, import("typebox").TLiteral<"stale-release">, import("typebox").TLiteral<"missing-property">, import("typebox").TLiteral<"missing-inverse">, import("typebox").TLiteral<"ambiguous-inverse">, import("typebox").TLiteral<"inapplicable-type">, import("typebox").TLiteral<"stale-descriptor">]>;
                }>]>>>;
            }>>;
            viewer: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TObject<{
                state: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                account: import("typebox").TOptional<import("typebox").TString>;
                context: import("typebox").TString;
                actions: import("typebox").TObject<{
                    statementPropose: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">]>;
                }>;
            }>, import("typebox").TObject<{
                kind: import("typebox").TUnion<[import("typebox").TLiteral<"anonymous">, import("typebox").TLiteral<"account">]>;
                account: import("typebox").TOptional<import("typebox").TString>;
            }>]>>;
            reads: import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                status: import("typebox").TInteger;
                body: import("typebox").TAny;
                headers: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TString>>;
            }>>;
            meanings: import("typebox").TOptional<import("typebox").TRecord<"^.*$", import("typebox").TObject<{
                text: import("typebox").TString;
                lang: import("typebox").TUnion<[import("typebox").TString, import("typebox").TNull]>;
            }>>>;
            unavailable: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                id: import("typebox").TString;
                admitted: import("typebox").TLiteral<false>;
            }>>>;
            actions: import("typebox").TOptional<import("typebox").TUnion<[import("typebox").TArray<import("typebox").TObject<{
                action: import("typebox").TString;
                operationId: import("typebox").TString;
                state: import("typebox").TUnion<[import("typebox").TLiteral<"allowed">, import("typebox").TLiteral<"denied">, import("typebox").TLiteral<"unavailable">, import("typebox").TLiteral<"unsupported">, import("typebox").TLiteral<"absent">, import("typebox").TLiteral<"withheld">]>;
            }>>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"ready">;
                viewerActions: import("typebox").TArray<import("typebox").TObject<{
                    action: import("typebox").TString;
                    operations: import("typebox").TArray<import("typebox").TString>;
                }>>;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"withheld">;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"unavailable">;
            }>, import("typebox").TObject<{
                status: import("typebox").TLiteral<"denied">;
            }>]>>;
        }> & {
            headers: {
                readonly 'cache-control': import("typebox").TString;
            };
        };
        202: import("typebox").TObject<{
            preparing: import("typebox").TLiteral<true>;
        }> & {
            headers: {
                readonly 'retry-after': import("typebox").TString;
            };
        };
        308: import("typebox").TObject<{
            redirect: import("typebox").TObject<{
                from: import("typebox").TString;
                to: import("typebox").TString;
            }>;
        }> & {
            headers: {
                readonly location: import("typebox").TString;
            };
        };
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
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
                code: import("typebox").TUnion<import("typebox").TLiteral<import("../../http/problem-error.ts").FieldErrorCode>[]>;
            }>>>;
        }>;
    };
    detail: {
        operationId: string;
        'x-exposure': string;
        'x-action': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}> & App;
