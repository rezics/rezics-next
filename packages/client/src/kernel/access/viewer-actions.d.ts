import type { Pool } from 'pg';
import type { Static, TSchema } from 'typebox';
import { type Exposure } from './gates/declaration.ts';
import type { createApp } from '../http/app.ts';
import { type MountedRoute } from '../http/request.ts';
import { type Access, type AccessClient, type Actor } from '../request/access.ts';
/** Trusted owner read, shared with its ordinary resource reader. Absence and the
 * public floor are separate: a private resource may still have an explicit grant. */
export type ViewerActionResource = Readonly<{
    readAction: string;
    read(client: AccessClient, ids: readonly string[], at: string): Promise<Readonly<Record<string, boolean>>>;
}>;
export type ViewerActionResources = ReadonlyMap<string, ViewerActionResource>;
export type ViewerActionBinding = Readonly<{
    action: string;
    operationId: string;
    exposure: Exposure;
}>;
export type ViewerActionBindings = ReadonlyMap<string, readonly ViewerActionBinding[]>;
/** No module-maintained operation list: only mounted direct declarations and
 * explicit different authority anchors participate in this catalogue. */
export declare function compileViewerActionBindings(routes: readonly MountedRoute[]): ViewerActionBindings;
declare const reference: import("typebox").TObject<{
    type: import("typebox").TString;
    id: import("typebox").TString;
}>;
type Reference = Static<typeof reference>;
export declare function readViewerActions(deps: {
    pool: Pool;
    access: Access;
    resources: ViewerActionResources;
    bindings: ViewerActionBindings;
    clock: () => Date;
}, actor: Actor, refs: readonly Reference[], deadline: number): Promise<{
    resources: ({
        type: string;
        id: string;
        error: 'not_found';
    } | {
        type: string;
        id: string;
        viewerActions: {
            action: string;
            operations: string[];
        }[];
    })[];
}>;
export declare function viewerActionsRoutes(app: ReturnType<typeof createApp>, deps: {
    pool: Pool;
    access: () => Access;
    resources: ViewerActionResources;
    bindings: () => ViewerActionBindings;
    clock: () => Date;
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
        readonly actor: Actor;
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
}, "post", "/v1/viewerActions", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    body: {
        '~standard': {
            version: 1;
            vendor: string;
            types: {
                input: {
                    resources: {
                        type: string;
                        id: string;
                    }[];
                };
                output: {
                    resources: {
                        type: string;
                        id: string;
                    }[];
                };
            } | undefined;
            validate(value: unknown): {
                value: {
                    resources: {
                        type: string;
                        id: string;
                    }[];
                };
                issues?: never;
            } | {
                value?: never;
                issues: {
                    message: string;
                }[];
            };
            jsonSchema: {
                input: () => import("typebox").TObject<{
                    resources: import("typebox").TArray<import("typebox").TObject<{
                        type: import("typebox").TString;
                        id: import("typebox").TString;
                    }>>;
                }>;
                output: () => import("typebox").TObject<{
                    resources: import("typebox").TArray<import("typebox").TObject<{
                        type: import("typebox").TString;
                        id: import("typebox").TString;
                    }>>;
                }>;
            };
        };
    };
    response: {
        200: import("typebox").TObject<{
            resources: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                type: import("typebox").TString;
                id: import("typebox").TString;
                viewerActions: import("typebox").TArray<import("typebox").TObject<{
                    action: import("typebox").TString;
                    operations: import("typebox").TArray<import("typebox").TString>;
                }>>;
            }>, import("typebox").TObject<{
                type: import("typebox").TString;
                id: import("typebox").TString;
                error: import("typebox").TLiteral<"not_found">;
            }>]>>;
        }>;
        400: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        401: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
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
        'x-exposure': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}, {}, "/v1/viewerActions">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ actor, body, job, set }: {
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
            resources: ({
                type: string;
                id: string;
                viewerActions: {
                    action: string;
                    operations: string[];
                }[];
            } | {
                type: string;
                id: string;
                error: "not_found";
            })[];
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
            resources: ({
                type: string;
                id: string;
                viewerActions: {
                    action: string;
                    operations: string[];
                }[];
            } | {
                type: string;
                id: string;
                error: "not_found";
            })[];
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
        body: {
            '~standard': {
                version: 1;
                vendor: string;
                types: {
                    input: {
                        resources: {
                            type: string;
                            id: string;
                        }[];
                    };
                    output: {
                        resources: {
                            type: string;
                            id: string;
                        }[];
                    };
                } | undefined;
                validate(value: unknown): {
                    value: {
                        resources: {
                            type: string;
                            id: string;
                        }[];
                    };
                    issues?: never;
                } | {
                    value?: never;
                    issues: {
                        message: string;
                    }[];
                };
                jsonSchema: {
                    input: () => import("typebox").TObject<{
                        resources: import("typebox").TArray<import("typebox").TObject<{
                            type: import("typebox").TString;
                            id: import("typebox").TString;
                        }>>;
                    }>;
                    output: () => import("typebox").TObject<{
                        resources: import("typebox").TArray<import("typebox").TObject<{
                            type: import("typebox").TString;
                            id: import("typebox").TString;
                        }>>;
                    }>;
                };
            };
        };
        response: {
            200: import("typebox").TObject<{
                resources: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                    type: import("typebox").TString;
                    id: import("typebox").TString;
                    viewerActions: import("typebox").TArray<import("typebox").TObject<{
                        action: import("typebox").TString;
                        operations: import("typebox").TArray<import("typebox").TString>;
                    }>>;
                }>, import("typebox").TObject<{
                    type: import("typebox").TString;
                    id: import("typebox").TString;
                    error: import("typebox").TLiteral<"not_found">;
                }>]>>;
            }>;
            400: import("typebox").TObject<{
                type: TSchema;
                title: TSchema;
                status: import("typebox").TLiteral<number>;
                code: TSchema;
                retryable: TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            401: import("typebox").TObject<{
                type: TSchema;
                title: TSchema;
                status: import("typebox").TLiteral<number>;
                code: TSchema;
                retryable: TSchema;
                effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
                request_id: import("typebox").TString;
                detail: import("typebox").TOptional<import("typebox").TString>;
                errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                    pointer: import("typebox").TString;
                    code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
                }>>>;
            }>;
            503: import("typebox").TObject<{
                type: TSchema;
                title: TSchema;
                status: import("typebox").TLiteral<number>;
                code: TSchema;
                retryable: TSchema;
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
            'x-exposure': string;
            security: ({
                bearerAuth: never[];
            } | {
                bearerAuth?: never;
            })[];
        };
    }, {}, "/v1/viewerActions">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("../http/admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: Actor;
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
        resources: {
            type: string;
            id: string;
        }[];
    };
    query: Record<string, string | undefined>;
    params: {};
    headers: Record<string, string | undefined>;
    cookie: Record<string, import("elysia").Cookie<unknown>>;
    readonly admission: import("../http/admission.ts").Admission;
    readonly job: {
        deadline: number;
        signal: AbortSignal;
    };
    readonly actor: Actor;
    readonly session: {
        readonly components: import("../tokens/session.ts").SessionComponent[];
        record(component: import("../tokens/session.ts").SessionComponent): void;
    };
    readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<{
    resources: ({
        type: string;
        id: string;
        error: 'not_found';
    } | {
        type: string;
        id: string;
        viewerActions: {
            action: string;
            operations: string[];
        }[];
    })[];
}>, {
    body: {
        '~standard': {
            version: 1;
            vendor: string;
            types: {
                input: {
                    resources: {
                        type: string;
                        id: string;
                    }[];
                };
                output: {
                    resources: {
                        type: string;
                        id: string;
                    }[];
                };
            } | undefined;
            validate(value: unknown): {
                value: {
                    resources: {
                        type: string;
                        id: string;
                    }[];
                };
                issues?: never;
            } | {
                value?: never;
                issues: {
                    message: string;
                }[];
            };
            jsonSchema: {
                input: () => import("typebox").TObject<{
                    resources: import("typebox").TArray<import("typebox").TObject<{
                        type: import("typebox").TString;
                        id: import("typebox").TString;
                    }>>;
                }>;
                output: () => import("typebox").TObject<{
                    resources: import("typebox").TArray<import("typebox").TObject<{
                        type: import("typebox").TString;
                        id: import("typebox").TString;
                    }>>;
                }>;
            };
        };
    };
    response: {
        200: import("typebox").TObject<{
            resources: import("typebox").TArray<import("typebox").TUnion<[import("typebox").TObject<{
                type: import("typebox").TString;
                id: import("typebox").TString;
                viewerActions: import("typebox").TArray<import("typebox").TObject<{
                    action: import("typebox").TString;
                    operations: import("typebox").TArray<import("typebox").TString>;
                }>>;
            }>, import("typebox").TObject<{
                type: import("typebox").TString;
                id: import("typebox").TString;
                error: import("typebox").TLiteral<"not_found">;
            }>]>>;
        }>;
        400: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        401: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
            effect_status: import("typebox").TUnion<[import("typebox").TLiteral<"not_applicable">, import("typebox").TLiteral<"not_applied">]>;
            request_id: import("typebox").TString;
            detail: import("typebox").TOptional<import("typebox").TString>;
            errors: import("typebox").TOptional<import("typebox").TArray<import("typebox").TObject<{
                pointer: import("typebox").TString;
                code: import("typebox").TUnion<import("typebox").TLiteral<string>[]>;
            }>>>;
        }>;
        503: import("typebox").TObject<{
            type: TSchema;
            title: TSchema;
            status: import("typebox").TLiteral<number>;
            code: TSchema;
            retryable: TSchema;
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
        'x-exposure': string;
        security: ({
            bearerAuth: never[];
        } | {
            bearerAuth?: never;
        })[];
    };
}>;
export {};
