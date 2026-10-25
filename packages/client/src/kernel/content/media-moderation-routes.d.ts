import type { ModerationDependencies } from './moderation.ts';
import type { sourceFenceGovernanceRoutes } from './source-fence-governance-routes.ts';
export interface MediaTakedownResponse {
    readonly securityRevision: string;
}
/** Bounded transport into the exact native media command, O(A + log M).
 * Authorization and receipt replay belong to that command. It retains bytes for
 * appeal; imports refresh requires the separate sourceFences:takedown command.
 */
export declare function mediaModerationRoutes(app: ReturnType<typeof sourceFenceGovernanceRoutes>, deps: ModerationDependencies): import("elysia/types").AddRoute<"", "local", import("elysia").DefaultSingleton, {
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
        sourceFences: {
            $check: {
                get: {
                    body: unknown;
                    params: {};
                    query: {
                        source: string;
                        externalId: string;
                        fieldGroup: "cover" | "facts" | "summary";
                    };
                    headers: unknown;
                    response: {
                        200: {
                            fenced: boolean;
                            securityRevision: string | null;
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
                        500: {
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
        sourceFences: {
            $takedown: {
                post: {
                    body: {
                        source: string;
                        externalId: string;
                        fieldGroup: "cover" | "facts" | "summary";
                        reason: string;
                    };
                    params: {};
                    query: unknown;
                    headers: {
                        "idempotency-key": string;
                    };
                    response: {
                        200: {
                            securityRevision: string;
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
                        413: {
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
                        429: {
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
                        500: {
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
        readonly admission: import("../http/admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("./reads.ts").Actor;
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
}, "post", "/v1/media/:id/$takeDown", import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
    params: import("typebox").TObject<{
        id: import("typebox").TString;
    }>;
    parse: unknown;
    transform: unknown;
    headers: import("typebox").TObject<{
        "idempotency-key": import("typebox").TString;
    }>;
    body: {
        '~standard': {
            version: 1;
            vendor: string;
            types: {
                input: {
                    reason: string;
                };
                output: {
                    reason: string;
                };
            } | undefined;
            validate(value: unknown): {
                value: {
                    reason: string;
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
                    reason: import("typebox").TString;
                }>;
                output: () => import("typebox").TObject<{
                    reason: import("typebox").TString;
                }>;
            };
        };
    };
    response: {
        200: {
            '~standard': {
                version: 1;
                vendor: string;
                types: {
                    input: MediaTakedownResponse;
                    output: MediaTakedownResponse;
                } | undefined;
                validate(value: unknown): {
                    value: MediaTakedownResponse;
                    issues?: never;
                } | {
                    value?: never;
                    issues: {
                        message: string;
                    }[];
                };
                jsonSchema: {
                    input: () => import("typebox").TUnsafe<MediaTakedownResponse>;
                    output: () => import("typebox").TUnsafe<MediaTakedownResponse>;
                };
            };
        } & {
            headers: {
                readonly "rezics-session-token": import("typebox").TString;
                readonly 'cache-control': import("typebox").TString;
            };
        };
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
        413: import("typebox").TObject<{
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
        429: import("typebox").TObject<{
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
        500: import("typebox").TObject<{
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
        'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
        security: {
            bearerAuth: never[];
        }[];
    };
}, {}, "/v1/media/:id/$takeDown">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, {}, ({ params: { id }, actor, body, request, admission, job, session, set }: {
    server: import("elysia").Server | null;
    redirect: import("elysia").redirect;
    set: {
        headers: import("elysia").HTTPHeaders;
        status?: number | keyof import("elysia").StatusMap;
        cookie?: Record<string, import("elysia").BaseCookie>;
        redirect?: never;
    };
    status: import("elysia").SelectiveStatus<{
        200: MediaTakedownResponse;
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
        413: {
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
        429: {
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
        500: {
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
        200: MediaTakedownResponse;
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
        413: {
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
        429: {
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
        500: {
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
        parse: unknown;
        transform: unknown;
        headers: import("typebox").TObject<{
            "idempotency-key": import("typebox").TString;
        }>;
        body: {
            '~standard': {
                version: 1;
                vendor: string;
                types: {
                    input: {
                        reason: string;
                    };
                    output: {
                        reason: string;
                    };
                } | undefined;
                validate(value: unknown): {
                    value: {
                        reason: string;
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
                        reason: import("typebox").TString;
                    }>;
                    output: () => import("typebox").TObject<{
                        reason: import("typebox").TString;
                    }>;
                };
            };
        };
        response: {
            200: {
                '~standard': {
                    version: 1;
                    vendor: string;
                    types: {
                        input: MediaTakedownResponse;
                        output: MediaTakedownResponse;
                    } | undefined;
                    validate(value: unknown): {
                        value: MediaTakedownResponse;
                        issues?: never;
                    } | {
                        value?: never;
                        issues: {
                            message: string;
                        }[];
                    };
                    jsonSchema: {
                        input: () => import("typebox").TUnsafe<MediaTakedownResponse>;
                        output: () => import("typebox").TUnsafe<MediaTakedownResponse>;
                    };
                };
            } & {
                headers: {
                    readonly "rezics-session-token": import("typebox").TString;
                    readonly 'cache-control': import("typebox").TString;
                };
            };
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
            413: import("typebox").TObject<{
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
            429: import("typebox").TObject<{
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
            500: import("typebox").TObject<{
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
            'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
            security: {
                bearerAuth: never[];
            }[];
        };
    }, {}, "/v1/media/:id/$takeDown">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>>, NoInfer<import("elysia").DefaultSingleton & {
        derive: {
            readonly admission: import("../http/admission.ts").Admission;
            readonly job: {
                deadline: number;
                signal: AbortSignal;
            };
            readonly actor: import("./reads.ts").Actor;
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
        reason: string;
    };
    query: Record<string, string | undefined>;
    params: {
        id: string;
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
    readonly actor: import("./reads.ts").Actor;
    readonly session: {
        readonly components: import("../tokens/session.ts").SessionComponent[];
        record(component: import("../tokens/session.ts").SessionComponent): void;
    };
    readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
    readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
}) => Promise<{
    securityRevision: string;
}>, {
    params: import("typebox").TObject<{
        id: import("typebox").TString;
    }>;
    parse: ("json" | (({ request, contentType }: {
        server: import("elysia").Server | null;
        redirect: import("elysia").redirect;
        set: {
            headers: import("elysia").HTTPHeaders;
            status?: number | keyof import("elysia").StatusMap;
            cookie?: Record<string, import("elysia").BaseCookie>;
            redirect?: never;
        };
        status: import("elysia").SelectiveStatus<{
            200: MediaTakedownResponse;
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
            413: {
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
            429: {
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
            500: {
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
            200: MediaTakedownResponse;
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
            413: {
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
            429: {
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
            500: {
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
        defer: (fn: import("elysia/types").AfterResponseHandler<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
            params: import("typebox").TObject<{
                id: import("typebox").TString;
            }>;
            parse: unknown;
            transform: unknown;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
            }>;
            body: {
                '~standard': {
                    version: 1;
                    vendor: string;
                    types: {
                        input: {
                            reason: string;
                        };
                        output: {
                            reason: string;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            reason: string;
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
                            reason: import("typebox").TString;
                        }>;
                        output: () => import("typebox").TObject<{
                            reason: import("typebox").TString;
                        }>;
                    };
                };
            };
            response: {
                200: {
                    '~standard': {
                        version: 1;
                        vendor: string;
                        types: {
                            input: MediaTakedownResponse;
                            output: MediaTakedownResponse;
                        } | undefined;
                        validate(value: unknown): {
                            value: MediaTakedownResponse;
                            issues?: never;
                        } | {
                            value?: never;
                            issues: {
                                message: string;
                            }[];
                        };
                        jsonSchema: {
                            input: () => import("typebox").TUnsafe<MediaTakedownResponse>;
                            output: () => import("typebox").TUnsafe<MediaTakedownResponse>;
                        };
                    };
                } & {
                    headers: {
                        readonly "rezics-session-token": import("typebox").TString;
                        readonly 'cache-control': import("typebox").TString;
                    };
                };
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
                413: import("typebox").TObject<{
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
                429: import("typebox").TObject<{
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
                500: import("typebox").TObject<{
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
                'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
                security: {
                    bearerAuth: never[];
                }[];
            };
        }, {}, "/v1/media/:id/$takeDown">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, import("elysia").DefaultSingleton & {
            derive: {
                readonly admission: import("../http/admission.ts").Admission;
                readonly job: {
                    deadline: number;
                    signal: AbortSignal;
                };
                readonly actor: import("./reads.ts").Actor;
                readonly session: {
                    readonly components: import("../tokens/session.ts").SessionComponent[];
                    record(component: import("../tokens/session.ts").SessionComponent): void;
                };
                readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
                readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
            };
        } & {
            derive: unknown;
        } & {
            decorator: {
                contentType: string;
            };
        }>) => import("elysia/types").MaybePromise<void>;
        readonly path: string;
        route?: string;
        rid?: string;
        request: Request;
        store: {};
        body: {
            reason: string;
        };
        query: Record<string, string | undefined>;
        params: {
            id: string;
        };
        headers: {
            "idempotency-key": string;
        };
        cookie: Record<string, import("elysia").Cookie<unknown>>;
        contentType: string;
        readonly admission: import("../http/admission.ts").Admission;
        readonly job: {
            deadline: number;
            signal: AbortSignal;
        };
        readonly actor: import("./reads.ts").Actor;
        readonly session: {
            readonly components: import("../tokens/session.ts").SessionComponent[];
            record(component: import("../tokens/session.ts").SessionComponent): void;
        };
        readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
    }) => Promise<any>))[];
    transform: ({ request }: {
        server: import("elysia").Server | null;
        redirect: import("elysia").redirect;
        set: {
            headers: import("elysia").HTTPHeaders;
            status?: number | keyof import("elysia").StatusMap;
            cookie?: Record<string, import("elysia").BaseCookie>;
            redirect?: never;
        };
        status: import("elysia").SelectiveStatus<{
            200: MediaTakedownResponse;
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
            413: {
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
            429: {
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
            500: {
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
            200: MediaTakedownResponse;
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
            413: {
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
            429: {
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
            500: {
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
        defer: (fn: import("elysia/types").AfterResponseHandler<import("elysia/types").IntersectIfObjectSchema<import("elysia").UnwrapRoute<{
            params: import("typebox").TObject<{
                id: import("typebox").TString;
            }>;
            parse: unknown;
            transform: unknown;
            headers: import("typebox").TObject<{
                "idempotency-key": import("typebox").TString;
            }>;
            body: {
                '~standard': {
                    version: 1;
                    vendor: string;
                    types: {
                        input: {
                            reason: string;
                        };
                        output: {
                            reason: string;
                        };
                    } | undefined;
                    validate(value: unknown): {
                        value: {
                            reason: string;
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
                            reason: import("typebox").TString;
                        }>;
                        output: () => import("typebox").TObject<{
                            reason: import("typebox").TString;
                        }>;
                    };
                };
            };
            response: {
                200: {
                    '~standard': {
                        version: 1;
                        vendor: string;
                        types: {
                            input: MediaTakedownResponse;
                            output: MediaTakedownResponse;
                        } | undefined;
                        validate(value: unknown): {
                            value: MediaTakedownResponse;
                            issues?: never;
                        } | {
                            value?: never;
                            issues: {
                                message: string;
                            }[];
                        };
                        jsonSchema: {
                            input: () => import("typebox").TUnsafe<MediaTakedownResponse>;
                            output: () => import("typebox").TUnsafe<MediaTakedownResponse>;
                        };
                    };
                } & {
                    headers: {
                        readonly "rezics-session-token": import("typebox").TString;
                        readonly 'cache-control': import("typebox").TString;
                    };
                };
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
                413: import("typebox").TObject<{
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
                429: import("typebox").TObject<{
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
                500: import("typebox").TObject<{
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
                'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
                security: {
                    bearerAuth: never[];
                }[];
            };
        }, {}, "/v1/media/:id/$takeDown">, import("elysia/types").MergeScopedSchemas<{}, {}, {}>>, import("elysia").DefaultSingleton & {
            derive: {
                readonly admission: import("../http/admission.ts").Admission;
                readonly job: {
                    deadline: number;
                    signal: AbortSignal;
                };
                readonly actor: import("./reads.ts").Actor;
                readonly session: {
                    readonly components: import("../tokens/session.ts").SessionComponent[];
                    record(component: import("../tokens/session.ts").SessionComponent): void;
                };
                readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
                readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
            };
        } & {
            derive: unknown;
        }>) => import("elysia/types").MaybePromise<void>;
        readonly path: string;
        route?: string;
        rid?: string;
        request: Request;
        store: {};
        body: {
            reason: string;
        };
        query: Record<string, string | undefined>;
        params: {
            id: string;
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
        readonly actor: import("./reads.ts").Actor;
        readonly session: {
            readonly components: import("../tokens/session.ts").SessionComponent[];
            record(component: import("../tokens/session.ts").SessionComponent): void;
        };
        readonly authorize: (resource: import("../request/access.ts").Resource) => Promise<import("../request/access.ts").AccessCheck>;
        readonly authorizeCommand: (resource: import("../request/access.ts").Resource, denied: () => Error) => Promise<import("../request/access.ts").AccessCommandAuthorization>;
    }) => void;
    headers: import("typebox").TObject<{
        "idempotency-key": import("typebox").TString;
    }>;
    body: {
        '~standard': {
            version: 1;
            vendor: string;
            types: {
                input: {
                    reason: string;
                };
                output: {
                    reason: string;
                };
            } | undefined;
            validate(value: unknown): {
                value: {
                    reason: string;
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
                    reason: import("typebox").TString;
                }>;
                output: () => import("typebox").TObject<{
                    reason: import("typebox").TString;
                }>;
            };
        };
    };
    response: {
        200: {
            '~standard': {
                version: 1;
                vendor: string;
                types: {
                    input: MediaTakedownResponse;
                    output: MediaTakedownResponse;
                } | undefined;
                validate(value: unknown): {
                    value: MediaTakedownResponse;
                    issues?: never;
                } | {
                    value?: never;
                    issues: {
                        message: string;
                    }[];
                };
                jsonSchema: {
                    input: () => import("typebox").TUnsafe<MediaTakedownResponse>;
                    output: () => import("typebox").TUnsafe<MediaTakedownResponse>;
                };
            };
        } & {
            headers: {
                readonly "rezics-session-token": import("typebox").TString;
                readonly 'cache-control': import("typebox").TString;
            };
        };
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
        413: import("typebox").TObject<{
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
        429: import("typebox").TObject<{
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
        500: import("typebox").TObject<{
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
        'x-rate-limit': Readonly<import("../http/rate-limit.ts").RateLimitDeclaration>;
        security: {
            bearerAuth: never[];
        }[];
    };
}>;
